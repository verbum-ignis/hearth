import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function cleanText(value) {
  return String(value || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, '')
    .replace(/<command-(?:name|message|args)>[\s\S]*?<\/command-(?:name|message|args)>/gi, '')
    .replace(/\[hearth\][^\n]*(?:\n|$)/gi, '')
    .trim();
}

export function clipCompleteSentence(value, limit = 240, minimum = 80) {
  const content = String(value || '').trim();
  if (content.length <= limit) return content;
  const head = content.slice(0, limit);
  const stop = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('.'),
    head.lastIndexOf('!'),
    head.lastIndexOf('?'),
  );
  return stop + 1 >= minimum ? head.slice(0, stop + 1).trim() : '';
}

function rowText(row) {
  const content = row?.message?.content;
  if (typeof content === 'string') return cleanText(content);
  if (!Array.isArray(content)) return '';
  return cleanText(content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('\n'));
}

export function extractCompleteTurns(text) {
  const turns = [];
  const seen = new Set();
  let active = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!['user', 'assistant'].includes(row.type)
        || !row.timestamp
        || row.isSidechain
        || row.isMeta
        || row.isCompactSummary
        || row.isVisibleInTranscriptOnly) continue;
    if (row.uuid && seen.has(row.uuid)) continue;
    const content = rowText(row);
    if (!content) continue;
    if (row.uuid) seen.add(row.uuid);
    if (row.type === 'user') {
      if (row.origin?.kind !== 'human') continue;
      active = {
        user: content,
        assistant: [],
        user_uuid: row.uuid || '',
        started_at: row.timestamp,
        completed_at: '',
      };
      turns.push(active);
    } else if (active) {
      active.assistant.push(content);
      active.completed_at = row.timestamp;
    }
  }
  return turns
    .filter((turn) => turn.assistant.length > 0)
    .map((turn) => ({ ...turn, assistant: cleanText(turn.assistant.join('\n')) }));
}

export function extractCodexCompleteTurns(text) {
  const turns = [];
  const seen = new Set();
  let active = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const payload = row?.payload;
    if (row?.type !== 'response_item' || payload?.type !== 'message') continue;
    if (!['user', 'assistant'].includes(payload.role)) continue;
    if (payload.role === 'assistant' && payload.phase !== 'final_answer') continue;
    if (payload.id && seen.has(payload.id)) continue;
    const wantedType = payload.role === 'user' ? 'input_text' : 'output_text';
    const content = cleanText((payload.content || [])
      .filter((block) => block?.type === wantedType)
      .map((block) => block.text || '')
      .join('\n'));
    if (!content) continue;
    if (payload.id) seen.add(payload.id);
    if (payload.role === 'user') {
      active = {
        user: content,
        assistant: '',
        user_uuid: payload.id || '',
        started_at: row.timestamp,
        completed_at: '',
      };
      turns.push(active);
    } else if (active && !active.assistant) {
      active.assistant = content;
      active.completed_at = row.timestamp;
    }
  }
  return turns.filter((turn) => turn.assistant);
}

export function localParts(instant, timezone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant instanceof Date ? instant : new Date(instant));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}:${get('second')}`,
  };
}

export function previousDate(dateText) {
  const cursor = new Date(`${dateText}T12:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  return cursor.toISOString().slice(0, 10);
}

export function triggerReason({
  totalTurns,
  committedTurns = 0,
  lastSegmentAt = null,
  firstPendingAt = null,
  eventName = 'Stop',
  now = new Date(),
  intervalTurns = 50,
  intervalHours = 3,
  dayChanged = false,
  force = false,
}) {
  const pending = Math.max(0, totalTurns - committedTurns);
  if (!pending) return null;
  if (force) return 'manual';
  if (/precompact/i.test(eventName)) return 'pre-compact';
  if (dayChanged) return 'new-day';
  if (pending >= intervalTurns) return `${intervalTurns}-turns`;
  const baseline = lastSegmentAt || firstPendingAt;
  if (baseline && now.getTime() - new Date(baseline).getTime() >= intervalHours * 3600000) {
    return `${intervalHours}-hours`;
  }
  return null;
}

export function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, filePath);
}

export function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

export function writeJson(filePath, value) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendSegment(root, segment) {
  const bucket = path.join(root, segment.date);
  fs.mkdirSync(bucket, { recursive: true });
  const safeTime = segment.local_time.replaceAll(':', '');
  const filePath = path.join(bucket, `${safeTime}-${segment.id}.json`);
  writeJson(filePath, segment);
  return filePath;
}

export function listSegments(root, dateText) {
  const bucket = path.join(root, dateText);
  if (!fs.existsSync(bucket)) return [];
  return fs.readdirSync(bucket)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(bucket, name), null))
    .filter(Boolean)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

export function listAllSegments(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort()
    .flatMap((date) => listSegments(root, date))
    .sort((a, b) => {
      const byTime = String(a.created_at).localeCompare(String(b.created_at));
      return byTime || String(a.id).localeCompare(String(b.id));
    });
}

export function defaultReminderState() {
  return {
    version: 1,
    read_through: null,
    muted_date: null,
    sessions: {},
  };
}

function segmentCursor(segment) {
  return `${String(segment?.created_at || '')}\u0000${String(segment?.id || '')}`;
}

export function unreadNowSegments(segments, reminderState) {
  const readThrough = reminderState?.read_through;
  if (!readThrough?.created_at) return [...segments];
  const cursor = `${String(readThrough.created_at)}\u0000${String(readThrough.id || '')}`;
  return segments.filter((segment) => segmentCursor(segment) > cursor);
}

export function decideNowReminder({
  segments,
  reminderState,
  sessionId,
  currentTurns = 0,
  eventName = 'turn',
  today,
  repeatTurns = 50,
  visibleSegments = 5,
  now = new Date(),
}) {
  const unread = unreadNowSegments(segments, reminderState);
  if (!unread.length || reminderState?.muted_date === today) return null;

  const latest = unread.at(-1);
  const session = reminderState?.sessions?.[sessionId] || {};
  if (Number.isFinite(session.snoozed_until_turns)
      && currentTurns < session.snoozed_until_turns) return null;

  const startEvent = /^(?:session-start|startup|resume|clear|compact|fork)$/i.test(eventName);
  if (startEvent) {
    const lastNoticeAt = new Date(session.last_notice_at || 0).getTime();
    const duplicateWithinOneMinute = session.last_notice_segment_id === latest.id
      && now.getTime() - lastNoticeAt < 60000;
    if (!duplicateWithinOneMinute) {
      return { reason: 'session-start', unread, latest };
    }
    return null;
  }

  if (unread.length >= visibleSegments
      && session.last_notice_segment_id !== latest.id) {
    return { reason: 'before-eviction', unread, latest };
  }

  const latestSourceTurn = latest?.source?.session_id === sessionId
    ? Number(latest?.source?.to_turn || 0)
    : Number(session.first_unread_seen_turns ?? currentTurns);
  const noticeTurn = Number(session.last_notice_turns ?? 0);
  const baseline = Math.max(latestSourceTurn, noticeTurn);
  if (currentTurns - baseline >= repeatTurns) {
    return {
      reason: noticeTurn ? 'still-unread' : 'unread',
      unread,
      latest,
    };
  }
  return null;
}

export function formatNowReminder(decision, {
  viewPath,
  repeatTurns = 50,
} = {}) {
  if (!decision) return '';
  const reason = decision.reason === 'before-eviction'
    ? '其中较早的段即将退出近期视图'
    : decision.reason === 'session-start'
      ? '刚进入新窗口或完成压缩'
      : `已经又走过约 ${repeatTurns} 个完整轮次`;
  return `[now] 抽屉里有 ${decision.unread.length} 段未读；${reason}。`
    + `是否打开由你决定：${viewPath}。若读取了正文，请把抽屉标记为已读；也可以选择稍后或今日静音。`;
}

export function selectVisibleSegments(root, {
  today,
  limit = 5,
}) {
  const yesterday = previousDate(today);
  const current = listSegments(root, today);
  const previous = listSegments(root, yesterday);
  const selectedCurrent = current.slice(-limit);
  const remaining = Math.max(0, limit - selectedCurrent.length);
  const selectedPrevious = remaining ? previous.slice(-remaining) : [];
  return [...selectedPrevious, ...selectedCurrent];
}

export function renderNowView(segments, { profile, generatedAt }) {
  if (!segments.length) return '';
  const lines = [
    `# ${profile} · now`,
    '',
    '> 这是记录员生成的短期状态投影：当天优先，不足时由昨天补位；原始对话与日记另行保存。',
    '',
  ];
  let lastDate = null;
  for (const segment of segments) {
    if (segment.date !== lastDate) {
      lines.push(`## ${segment.date}`, '');
      lastDate = segment.date;
    }
    lines.push(`### ${segment.local_time.slice(0, 5)} · ${segment.trigger}`, '', segment.content.trim(), '');
  }
  lines.push(`_更新于 ${generatedAt}_`, '');
  return lines.join('\n');
}

export function pruneOldBuckets(root, today, retentionDays = 2) {
  if (!fs.existsSync(root)) return [];
  const cutoff = new Date(`${today}T12:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - (retentionDays - 1));
  const cutoffText = cutoff.toISOString().slice(0, 10);
  const removed = [];
  for (const name of fs.readdirSync(root)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name) || name >= cutoffText) continue;
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export function contentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function segmentId(sessionId, fromTurn, toTurn, firstUserUuid = '', lastUserUuid = '') {
  return crypto.createHash('sha256')
    .update(`${sessionId}:${fromTurn}:${toTurn}:${firstUserUuid}:${lastUserUuid}`)
    .digest('hex')
    .slice(0, 12);
}

export function splitBatches(items, batchSize) {
  const batches = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

export function splitPromptBatches(turns, { maxTurns = 50, maxChars = 24000, renderTurn }) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const turn of turns) {
    const size = renderTurn(turn).length;
    const wouldOverflow = current.length > 0
      && (current.length >= maxTurns || currentChars + size > maxChars);
    if (wouldOverflow) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(turn);
    currentChars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

// Hook 会重叠运行；用独占创建而非“先检查再创建”，避免两个进程同时看见旧 state。
export function tryAcquireLock(lockPath, { staleMs = 90000 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const attempt = () => {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
      return { fd, lockPath };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return null;
    }
  };

  let lock = attempt();
  if (lock) return lock;
  try {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age > staleMs) fs.rmSync(lockPath, { force: true });
  } catch {}
  return attempt();
}

export function releaseLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch {}
  try { fs.rmSync(lock.lockPath, { force: true }); } catch {}
}

export function defaultPolicy() {
  return { version: 1, default: { external_export: false }, sessions: {} };
}

export function externalExportAllowed(policy, sessionId) {
  const base = policy?.default || {};
  const override = policy?.sessions?.[sessionId] || {};
  return (override.external_export ?? base.external_export) === true;
}

export function setExternalExportPolicy(policy, sessionId, allowed) {
  const next = policy && typeof policy === 'object' ? policy : defaultPolicy();
  next.version ||= 1;
  next.default ||= { external_export: false };
  next.sessions ||= {};
  next.sessions[sessionId] = {
    ...(next.sessions[sessionId] || {}),
    external_export: Boolean(allowed),
    updated_at: new Date().toISOString(),
  };
  return next;
}

export function latestSegmentDate(root) {
  if (!fs.existsSync(root)) return null;
  return fs.readdirSync(root)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort()
    .at(-1) || null;
}

export function findSegmentBySource(root, { sessionId, fromTurn, toTurn }) {
  if (!fs.existsSync(root)) return null;
  for (const date of fs.readdirSync(root).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))) {
    const found = listSegments(root, date).find((segment) => (
      segment?.source?.session_id === sessionId
      && segment?.source?.from_turn === fromTurn
      && segment?.source?.to_turn === toTurn
    ));
    if (found) return found;
  }
  return null;
}
