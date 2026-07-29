import { spawnSync } from 'node:child_process';

const requiredEnv = [
  'FEISHU_MIRROR_ROOTS_JSON',
  'ONEDRIVE_REFRESH_TOKEN',
  'ONEDRIVE_OAUTH_CLIENT_ID',
  'ONEDRIVE_OAUTH_CLIENT_SECRET',
  'ONEDRIVE_DRIVE_ID'
];

for (const name of requiredEnv) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const roots = JSON.parse(process.env.FEISHU_MIRROR_ROOTS_JSON);
const driveId = process.env.ONEDRIVE_DRIVE_ID;
const basePath = process.env.ONEDRIVE_BASE_PATH || 'Typora/MyVault';
const dryRun = String(process.env.DRY_RUN || '').toLowerCase() === 'true';
const larkCli = process.env.LARK_CLI_BIN || 'lark-cli';
const maxDocumentBytes = 3.5 * 1024 * 1024;

function runLarkJson(args) {
  const result = spawnSync(larkCli, args, {
    encoding: 'utf8',
    maxBuffer: 24 * 1024 * 1024,
    env: {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1'
    }
  });

  if (result.status !== 0) {
    const error = result.stderr || result.stdout || `exit code ${result.status}`;
    throw new Error(`Feishu CLI call failed: ${args.slice(0, 3).join(' ')}: ${error.trim()}`);
  }

  return JSON.parse(result.stdout);
}

function assertMirrorRoots(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('FEISHU_MIRROR_ROOTS_JSON must be a JSON object');
  }

  for (const [name, token] of Object.entries(value)) {
    if (!String(name).trim() || !String(token).trim()) {
      throw new Error('Each Feishu mirror root requires a non-empty name and folder token');
    }
  }
}

function sanitizeSegment(value) {
  let segment = String(value)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '＿')
    .replace(/^~/, '～')
    .replace(/[ .]+$/g, '')
    .trim();

  if (!segment) segment = '未命名';
  return segment;
}

function encodePath(path) {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function collectFeishuFolder(folderToken, relativeDirectory, state) {
  const response = runLarkJson([
    'drive', 'files', 'list',
    '--as', 'bot',
    '--folder-token', folderToken,
    '--page-all',
    '--page-limit', '50',
    '--json'
  ]);
  const files = response?.data?.files || [];

  for (const file of files) {
    const name = sanitizeSegment(file.name);

    if (file.type === 'folder') {
      const childDirectory = `${relativeDirectory}/${name}`;
      state.directories.add(childDirectory);
      await collectFeishuFolder(file.token, childDirectory, state);
      continue;
    }

    if (file.type !== 'docx') {
      state.skippedTypes[file.type || 'unknown'] =
        (state.skippedTypes[file.type || 'unknown'] || 0) + 1;
      continue;
    }

    const fetched = runLarkJson([
      'docs', '+fetch',
      '--as', 'bot',
      '--doc', file.token,
      '--doc-format', 'markdown',
      '--json'
    ]);
    const content = String(fetched?.data?.document?.content || '').replace(/\r\n/g, '\n');
    const relativePath = `${relativeDirectory}/${name}.md`;

    if (state.documents.has(relativePath)) {
      throw new Error('Duplicate Feishu mirror path detected');
    }

    const body = content.endsWith('\n') ? content : `${content}\n`;
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > maxDocumentBytes) {
      throw new Error('A document exceeds the simple Graph upload limit');
    }

    state.documents.set(relativePath, body);
  }
}

async function refreshOneDriveToken() {
  const body = new URLSearchParams({
    client_id: process.env.ONEDRIVE_OAUTH_CLIENT_ID,
    client_secret: process.env.ONEDRIVE_OAUTH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: process.env.ONEDRIVE_REFRESH_TOKEN,
    scope: 'Files.Read Files.ReadWrite Files.Read.All Files.ReadWrite.All Sites.Read.All offline_access'
  });
  const response = await fetch(
    'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    }
  );
  const result = await response.json();

  if (!response.ok || !result.access_token) {
    throw new Error(`OneDrive token refresh failed: HTTP ${response.status}, ${result.error || 'unknown_error'}`);
  }

  return result.access_token;
}

function createGraphClient(accessToken) {
  const baseUrl = 'https://graph.microsoft.com/v1.0';

  return async function graph(pathOrUrl, options = {}) {
    let lastResponse;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(
        pathOrUrl.startsWith('https://') ? pathOrUrl : `${baseUrl}${pathOrUrl}`,
        {
          ...options,
          headers: {
            authorization: `Bearer ${accessToken}`,
            ...(options.headers || {})
          }
        }
      );
      lastResponse = response;

      if (response.status !== 429 && response.status < 500) return response;

      const retryAfter = Number(response.headers.get('retry-after') || 0);
      const delay = Math.max(retryAfter * 1000, 750 * (2 ** attempt));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    return lastResponse;
  };
}

async function readGraphJson(response, operation) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${operation} failed: HTTP ${response.status}, ${body?.error?.code || 'unknown_error'}`);
  }
  return body;
}

async function ensureFolderPath(graph, folderPath, cache) {
  const normalized = folderPath.split('/').filter(Boolean).join('/');
  if (!normalized) {
    const response = await graph(`/drives/${encodeURIComponent(driveId)}/root`);
    const root = await readGraphJson(response, 'Read OneDrive root');
    cache.set('', root.id);
    return root.id;
  }

  if (cache.has(normalized)) return cache.get(normalized);

  const response = await graph(`/drives/${encodeURIComponent(driveId)}/root:/${encodePath(normalized)}`);
  if (response.ok) {
    const folder = await response.json();
    if (!folder.folder) throw new Error('A required OneDrive path is not a folder');
    cache.set(normalized, folder.id);
    return folder.id;
  }

  if (response.status !== 404) {
    await readGraphJson(response, 'Read OneDrive folder');
  }

  const segments = normalized.split('/');
  const name = segments.pop();
  const parentPath = segments.join('/');
  const parentId = await ensureFolderPath(graph, parentPath, cache);
  const createResponse = await graph(
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentId)}/children`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail'
      })
    }
  );
  const created = await readGraphJson(createResponse, 'Create OneDrive folder');
  cache.set(normalized, created.id);
  return created.id;
}

async function uploadDocument(graph, relativePath, content, folderCache) {
  const segments = relativePath.split('/');
  segments.pop();
  await ensureFolderPath(graph, `${basePath}/${segments.join('/')}`, folderCache);

  const response = await graph(
    `/drives/${encodeURIComponent(driveId)}/root:/${encodePath(`${basePath}/${relativePath}`)}:/content`,
    {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
      body: Buffer.from(content, 'utf8')
    }
  );
  await readGraphJson(response, 'Upload OneDrive Markdown');
}

async function listChildren(graph, itemId) {
  const items = [];
  let nextUrl =
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children?$top=200`;

  while (nextUrl) {
    const response = await graph(nextUrl);
    const page = await readGraphJson(response, 'List OneDrive mirror folder');
    items.push(...(page.value || []));
    nextUrl = page['@odata.nextLink'] || '';
  }

  return items;
}

async function collectOneDriveMarkdown(graph, itemId, relativeDirectory, results) {
  const children = await listChildren(graph, itemId);
  for (const item of children) {
    const relativePath = `${relativeDirectory}/${item.name}`;
    if (item.folder) {
      await collectOneDriveMarkdown(graph, item.id, relativePath, results);
    } else if (item.file && item.name.toLowerCase().endsWith('.md')) {
      results.push({ id: item.id, relativePath });
    }
  }
}

async function deleteOneDriveItem(graph, itemId) {
  const response = await graph(
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`,
    { method: 'DELETE' }
  );
  if (!response.ok && response.status !== 404) {
    await readGraphJson(response, 'Delete stale OneDrive Markdown');
  }
}

const state = {
  documents: new Map(),
  directories: new Set(),
  skippedTypes: {}
};

assertMirrorRoots(roots);

for (const [rootName, folderToken] of Object.entries(roots)) {
  const safeRootName = sanitizeSegment(rootName);
  state.directories.add(safeRootName);
  await collectFeishuFolder(folderToken, safeRootName, state);
}

if (dryRun) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    rootCount: Object.keys(roots).length,
    documentCount: state.documents.size,
    directoryCount: state.directories.size,
    skippedTypes: state.skippedTypes
  }));
  process.exit(0);
}

const accessToken = await refreshOneDriveToken();
const graph = createGraphClient(accessToken);
const folderCache = new Map();
await ensureFolderPath(graph, basePath, folderCache);

let uploadedCount = 0;
for (const [relativePath, content] of state.documents) {
  await uploadDocument(graph, relativePath, content, folderCache);
  uploadedCount += 1;
}

const desiredPaths = new Set(state.documents.keys());
let deletedCount = 0;

for (const rootName of Object.keys(roots).map(sanitizeSegment)) {
  const rootPath = `${basePath}/${rootName}`;
  const rootId = await ensureFolderPath(graph, rootPath, folderCache);
  const existing = [];
  await collectOneDriveMarkdown(graph, rootId, rootName, existing);

  for (const item of existing) {
    if (!desiredPaths.has(item.relativePath)) {
      await deleteOneDriveItem(graph, item.id);
      deletedCount += 1;
    }
  }
}

console.log(JSON.stringify({
  ok: true,
  dryRun: false,
  rootCount: Object.keys(roots).length,
  documentCount: state.documents.size,
  uploadedCount,
  deletedCount,
  skippedTypes: state.skippedTypes
}));
