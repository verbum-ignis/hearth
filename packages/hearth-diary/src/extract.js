import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

function localDate(isoTimestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(isoTimestamp));
  const value = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function cleanText(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, '')
    .replace(/\[hearth\][^\n]*(?:\n|$)/gi, '')
    .trim();
}

function messageText(row) {
  const content = row.message?.content;
  if (typeof content === 'string') return cleanText(content);
  if (!Array.isArray(content)) return '';
  return cleanText(content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('\n'));
}

function listJsonlFiles(root) {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...listJsonlFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(fullPath);
  }
  return found;
}

export async function extractConversationData({ projectsDir, date, timezone }) {
  const rows = [];
  const seen = new Set();
  for (const filePath of listJsonlFiles(projectsDir)) {
    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!['user', 'assistant'].includes(row.type) || !row.timestamp) continue;
      if (row.isSidechain || row.isMeta || row.isCompactSummary || row.isVisibleInTranscriptOnly) continue;
      if (localDate(row.timestamp, timezone) !== date) continue;
      if (row.uuid && seen.has(row.uuid)) continue;
      const text = messageText(row);
      if (!text) continue;
      if (row.uuid) seen.add(row.uuid);
      rows.push({ timestamp: row.timestamp, role: row.type, text });
    }
  }
  rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const conversation = rows.map((row) => {
    const time = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(row.timestamp));
    return `[${time}] ${row.role === 'user' ? '人类' : '小机'}：${row.text}`;
  }).join('\n');
  return { conversation, messages: rows };
}

export async function extractConversation(options) {
  return (await extractConversationData(options)).conversation;
}

export const _test = { cleanText, messageText, localDate };
