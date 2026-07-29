import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataDir = resolve(repoRoot, 'data');
const digestPath = resolve(dataDir, 'codex-daily-digest.json');
const statusPath = resolve(dataDir, 'codex-daily-digest-status.json');
const forceSend = process.env.FORCE_SEND === 'true';

function hongKongDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

async function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, 'utf8'));
}

function compactText(value, maxLength = 420) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function digestHash(digest) {
  const payload = JSON.stringify({
    date: digest?.date,
    sourceThread: digest?.sourceThread,
    items: digest?.items ?? [],
  });
  return createHash('sha256').update(payload).digest('hex');
}

function buildMessage(digest) {
  const lines = [
    'Codex 今日问答摘要',
    '',
    `日期：${digest.date}`,
    `来源：${digest.sourceThread?.title ?? digest.sourceThread?.id ?? 'Codex task'}`,
    `条目：${digest.items.length}`,
    '',
  ];

  digest.items.forEach((item, index) => {
    lines.push(`${index + 1}. 问：${compactText(item.question, 180)}`);
    lines.push(`答：${compactText(item.answer, 520)}`);
    if (item.answeredAt) lines.push(`时间：${item.answeredAt}`);
    lines.push('');
  });

  lines.push('说明：只发送已筛选条目；完整上下文仍保留在 Codex 任务内。');
  return lines.join('\n').trim();
}

async function sendWeComWithAibot(message) {
  const botId = process.env.WECOM_BOT_ID;
  const secret = process.env.WECOM_BOT_SECRET;
  const targetChatId = process.env.WECOM_TARGET_CHAT_ID;
  if (!botId || !secret || !targetChatId) return null;

  const { WSClient } = await import('@wecom/aibot-node-sdk');
  const client = new WSClient({
    botId,
    secret,
    maxReconnectAttempts: 3,
    maxAuthFailureAttempts: 1,
  });

  return await new Promise((resolvePromise, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.disconnect();
      reject(new Error('WeCom AI Bot send timed out.'));
    }, 25000);

    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.disconnect();
      if (error) reject(error);
      else resolvePromise(result);
    };

    client.on('authenticated', async () => {
      try {
        await client.sendMessage(targetChatId, {
          msgtype: 'markdown',
          markdown: { content: message },
        });
        finish({ channel: 'aibot', sent: true });
      } catch (error) {
        finish(null, error);
      }
    });

    client.on('error', (error) => finish(null, error));
    client.connect();
  });
}

async function sendWeComWithWebhook(webhookUrl, message) {
  if (!webhookUrl) {
    throw new Error('Missing WeCom notification secret. Set WECOM_BOT_ID/WECOM_BOT_SECRET/WECOM_TARGET_CHAT_ID or WECOM_WEBHOOK_URL.');
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      msgtype: 'text',
      text: { content: message },
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || Number(body.errcode) !== 0) {
    throw new Error(`WeCom rejected message: HTTP ${response.status}, errcode ${body.errcode}, errmsg ${body.errmsg}`);
  }

  return { channel: 'webhook', sent: true, body };
}

async function sendWeCom(message) {
  const aibotResult = await sendWeComWithAibot(message);
  if (aibotResult) return aibotResult;
  return await sendWeComWithWebhook(process.env.WECOM_WEBHOOK_URL, message);
}

await mkdir(dataDir, { recursive: true });

const digest = await readJson(digestPath);
const previousStatus = await readJson(statusPath, {});
const today = hongKongDateString();
let status = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  today,
  digestDate: digest?.date ?? null,
  itemCount: Array.isArray(digest?.items) ? digest.items.length : 0,
  sent: false,
  skipped: false,
  reason: '',
};

if (!digest) {
  status.skipped = true;
  status.reason = 'No digest file found.';
} else if (digest.date !== today && !forceSend) {
  status.skipped = true;
  status.reason = `Digest date ${digest.date} does not match today ${today}.`;
} else if (!Array.isArray(digest.items) || digest.items.length === 0) {
  status.skipped = true;
  status.reason = 'Digest has no selected items.';
} else {
  const currentHash = digestHash(digest);
  status.digestHash = currentHash;
  if (previousStatus.lastSentDigestHash === currentHash && !forceSend) {
    status.skipped = true;
    status.reason = 'Digest already sent.';
  } else {
    const message = buildMessage(digest);
    const sendResult = await sendWeCom(message);
    status.sent = true;
    status.channel = sendResult.channel;
    status.lastSentDigestHash = currentHash;
    status.sentAt = new Date().toISOString();
  }
}

await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(status, null, 2));
