import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataDir = resolve(repoRoot, 'data');
const snapshotPath = resolve(dataDir, 'workbench-mobile-snapshot.json');
const feishuEntryPath = resolve(dataDir, 'workbench-feishu-entry.json');
const statusPath = resolve(dataDir, 'cloud-run-status.json');

function nowIso() {
  return new Date().toISOString();
}

async function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, 'utf8'));
}

function hoursBetween(a, b) {
  return Math.abs(b.getTime() - a.getTime()) / 36e5;
}

function compactText(value, maxLength = 120) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function buildAssessment(snapshot) {
  if (!snapshot) {
    return {
      level: 'archived',
      title: '个人工作台云端快照：未发布',
      reason: '日常工作台已迁移到飞书发展地图；云端快照不再用于健康告警。'
    };
  }

  return {
    level: 'archived',
    title: '个人工作台云端快照：仅供存档',
    reason: '健康告警改由本地同步包装脚本产生；不再以旧 GitHub 快照判断本地同步。'
  };
}

function shouldNotify(assessment, notifyMode) {
  if (notifyMode === 'always') return true;
  return false;
}

function buildMessage({ assessment, snapshot, feishuEntryUrl, eventName }) {
  const sync = snapshot?.sync ?? {};
  const focus = snapshot?.focus?.[0];
  const english = snapshot?.english;
  const feishuUrl = feishuEntryUrl || snapshot?.feishuEntryUrl || '';

  const lines = [
    assessment.title,
    '',
    `状态：${assessment.level}`,
    `原因：${assessment.reason}`,
    `触发：${eventName || 'unknown'}`,
    `生成时间：${snapshot?.generatedAt ?? '无'}`,
    `本地笔记：${sync.localNoteCount ?? '未知'}｜Codex任务：${sync.codexTaskCount ?? '未知'}｜冲突：${sync.conflictCount ?? 0}`
  ];

  if (focus) {
    lines.push(`重点：${compactText(focus.name)}｜${compactText(focus.next)}`);
  }

  if (english) {
    lines.push(`每日英语：${compactText(english.title)}`);
  }

  if (feishuUrl) {
    lines.push(`飞书入口：${feishuUrl}`);
  }

  return lines.join('\n');
}

async function sendWeComWithAibot(message) {
  const botId = process.env.WECOM_BOT_ID;
  const secret = process.env.WECOM_BOT_SECRET;
  const targetChatId = process.env.WECOM_TARGET_CHAT_ID;
  if (!botId || !secret || !targetChatId) {
    return null;
  }

  const { WSClient } = await import('@wecom/aibot-node-sdk');
  const client = new WSClient({
    botId,
    secret,
    maxReconnectAttempts: 3,
    maxAuthFailureAttempts: 1
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
          markdown: { content: message }
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
      text: { content: message }
    })
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

const snapshot = await readJson(snapshotPath);
const feishuEntry = await readJson(feishuEntryPath, {});
const notifyMode = process.env.NOTIFY_MODE || 'on_issue';
const feishuEntryUrl = process.env.FEISHU_ENTRY_URL || feishuEntry?.url || '';
const eventName = process.env.GITHUB_EVENT_NAME || '';
const assessment = buildAssessment(snapshot);
const message = buildMessage({ assessment, snapshot, feishuEntryUrl, eventName });
let notification = { attempted: false, sent: false };

if (shouldNotify(assessment, notifyMode)) {
  notification.attempted = true;
  const sendResult = await sendWeCom(message);
  notification.sent = true;
  notification.channel = sendResult.channel;
}

const status = {
  schemaVersion: 1,
  checkedAt: nowIso(),
  eventName,
  notifyMode,
  assessment,
  notification,
  feishuEntryUrl,
  snapshotGeneratedAt: snapshot?.generatedAt ?? null
};

await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(status, null, 2));
