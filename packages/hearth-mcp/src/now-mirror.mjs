import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export const NOW_MIRROR_TIMEZONE = 'Asia/Shanghai';
export const NOW_MIRROR_RETENTION_DAYS = 3;

const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const SNAPSHOT_RE = /^(\d{2})-(\d{2})-(\d{2})-(\d{3})_[0-9a-f]{10}_[0-9a-f-]+\.md$/i;

function zonedParts(value, timeZone = NOW_MIRROR_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
  }).formatToParts(value);
  return Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
}

export function beijingStamp(value = new Date()) {
  const p = zonedParts(value);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}:${p.second}`,
    filenameTime: `${p.hour}-${p.minute}-${p.second}-${p.fractionalSecond}`,
  };
}

function beijingDateOffset(value, offsetDays) {
  const shifted = new Date(value.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  return beijingStamp(shifted).date;
}

export function validateMirrorRoot(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('now mirror directory is not configured');
  }
  if (!path.isAbsolute(value)) {
    throw new Error('now mirror directory must be absolute');
  }
  return path.resolve(value);
}

async function pruneOldDateDirs(root, value, retentionDays) {
  const keepFrom = beijingDateOffset(value, -(retentionDays - 1));
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !DATE_DIR_RE.test(entry.name) || entry.name >= keepFrom) continue;
    const target = path.resolve(root, entry.name);
    if (path.dirname(target) !== root || path.basename(target) !== entry.name) continue;
    await rm(target, { recursive: true, force: true });
  }
}

export async function mirrorNow(content, mirrorRoot, {
  now = new Date(),
  retentionDays = NOW_MIRROR_RETENTION_DAYS,
} = {}) {
  if (typeof content !== 'string') throw new Error('now content must be a string');
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error('retentionDays must be a positive integer');
  }

  const root = validateMirrorRoot(mirrorRoot);
  const stamp = beijingStamp(now);
  const dateDir = path.join(root, stamp.date);
  const hash = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 10);
  const filename = `${stamp.filenameTime}_${hash}_${randomUUID()}.md`;
  const target = path.join(dateDir, filename);

  await mkdir(dateDir, { recursive: true });
  await writeFile(target, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

  // 清理失败不撤销刚写成的镜像；调用方仍会把整个镜像通道视为 best-effort。
  try {
    await pruneOldDateDirs(root, now, retentionDays);
  } catch {
    // 静默：保留多几天比影响主写入安全。
  }
  return target;
}

export async function mirrorSuccessfulNowWrite(payload, responseText, mirrorRoot, options) {
  if (
    !mirrorRoot ||
    payload?.op !== 'meta_set' ||
    payload?.key !== 'now'
  ) {
    return false;
  }

  try {
    const response = JSON.parse(responseText);
    if (response?.ok !== true || response?.id !== 'now') return false;
    await mirrorNow(payload.content, mirrorRoot, options);
    return true;
  } catch {
    // 远端结果已经确定；本地热缓存永远不能改变主写入的成败。
    return false;
  }
}

export function summarizeNow(content, maxChars = 40) {
  if (typeof content !== 'string') return '';
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const paragraphs = [];
  let current = [];

  const flush = () => {
    if (current.length > 0) paragraphs.push(current.join(' '));
    current = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) continue;
    current.push(line.replace(/^(?:[-*+]|\d+[.)])\s+/, '').trim());
  }
  flush();

  const first = (paragraphs.find(Boolean) || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(first);
  return chars.length <= maxChars ? first : `${chars.slice(0, maxChars).join('')}…`;
}

export async function findRecentSnapshots(mirrorRoot, {
  now = new Date(),
  retentionDays = NOW_MIRROR_RETENTION_DAYS,
} = {}) {
  const root = validateMirrorRoot(mirrorRoot);
  const allowedDates = new Set(
    Array.from({ length: retentionDays }, (_, i) => beijingDateOffset(now, -i)),
  );
  const snapshots = [];

  let dateEntries;
  try {
    dateEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const dateEntry of dateEntries) {
    if (!dateEntry.isDirectory() || !allowedDates.has(dateEntry.name)) continue;
    const dateDir = path.join(root, dateEntry.name);
    let files;
    try {
      files = await readdir(dateDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      const match = file.isFile() && file.name.match(SNAPSHOT_RE);
      if (!match) continue;
      snapshots.push({
        date: dateEntry.name,
        time: `${match[1]}:${match[2]}:${match[3]}`,
        path: path.join(dateDir, file.name),
        filename: file.name,
      });
    }
  }

  snapshots.sort((a, b) =>
    `${a.date}/${a.filename}`.localeCompare(`${b.date}/${b.filename}`),
  );
  return snapshots;
}

export async function buildNowReminder(mirrorRoot, {
  now = new Date(),
  workroom,
} = {}) {
  const snapshots = await findRecentSnapshots(mirrorRoot, { now });
  if (snapshots.length === 0) return '';

  const latest = snapshots.at(-1);
  const content = await readFile(latest.path, 'utf8');
  const summary = summarizeNow(content);
  const root = validateMirrorRoot(mirrorRoot);
  const base = workroom && path.isAbsolute(workroom)
    ? path.resolve(workroom)
    : path.dirname(root);
  const today = beijingStamp(now).date;
  const flowPath = path.join(base, '流水', `${today}.md`);
  const excerpt = summary ? `「${summary}」` : '';

  return `[now] 近3日写入 ${snapshots.length} 次；最新 ${latest.date} ${latest.time}${excerpt}。近期镜像：${latest.path}；今日流水：${flowPath}`;
}
