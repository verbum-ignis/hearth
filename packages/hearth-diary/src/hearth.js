async function request(config, path, payload = null) {
  const response = await fetch(`${config.apiUrl.replace(/\/$/, '')}${path}`, {
    method: payload === null ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${config.hearthToken}`, ...(payload === null ? {} : { 'Content-Type': 'application/json' }) },
    body: payload === null ? undefined : JSON.stringify(payload),
  });
  const parsed = await response.json();
  if (!response.ok) throw new Error(`Hearth HTTP ${response.status}`);
  if (parsed.error) throw new Error(`Hearth: ${parsed.error}`);
  return parsed;
}

function parsedKeys(entry) {
  if (Array.isArray(entry.keys)) return entry.keys;
  try {
    const keys = JSON.parse(entry.keys);
    return Array.isArray(keys) ? keys : [];
  } catch { return []; }
}

function diaryDate(entry) {
  const match = typeof entry.hook === 'string' && entry.hook.match(/^(\d{4}-\d{2}-\d{2}) /);
  if (!match || parsedKeys(entry)[0] !== match[1]) return null;
  return match[1];
}

export async function listDiaryEntries(config, date = null) {
  const data = await request(config, '/stars');
  return (data.stars || []).filter((entry) => entry.type === 'stream'
    && entry.status === 'active'
    && diaryDate(entry)
    && (!date || diaryDate(entry) === date));
}

export async function findExistingDiary(config, date) {
  return (await listDiaryEntries(config, date))[0] || null;
}

function createPayload(date, event) {
  return {
    op: 'create',
    entry: {
      type: 'stream',
      hook: `${date} ${event.title}`,
      keys: [date, ...event.topics.slice(0, 3)],
      body: event.body,
    },
  };
}

export async function replaceDiaryEvents(transport, oldEntries, date, events) {
  const ids = [];
  for (const event of events) {
    const result = await transport.create(createPayload(date, event));
    ids.push(result.id);
  }
  for (const old of oldEntries) await transport.retire(old.id);
  return ids;
}

export async function writeDiaryEvents(config, date, events, force = false) {
  const oldEntries = await listDiaryEntries(config, date);
  if (oldEntries.length > 0 && !force) {
    return { ids: oldEntries.map((entry) => entry.id), skipped: true, retired: [] };
  }
  const retired = [];
  const ids = await replaceDiaryEvents({
    create: (payload) => request(config, '/write', payload),
    retire: async (id) => {
      await request(config, '/write', { op: 'retire', id });
      retired.push(id);
    },
  }, force ? oldEntries : [], date, events);
  return { ids, skipped: false, retired };
}

function expiredDiaryEntries(entries, nowMs = Date.now()) {
  const cutoff = nowMs - 60 * 86400000;
  return entries.filter((entry) => diaryDate(entry)
    && entry.type === 'stream'
    && entry.status === 'active'
    && Number(entry.anchor) === 0
    && Date.parse(`${entry.last_accessed}Z`) < cutoff);
}

export async function cleanupExpiredDiaries(config, nowMs = Date.now()) {
  const entries = await listDiaryEntries(config);
  const expired = expiredDiaryEntries(entries, nowMs);
  for (const entry of expired) await request(config, '/write', { op: 'retire', id: entry.id });
  return expired.map((entry) => ({ id: entry.id, hook: entry.hook }));
}

export const _test = { parsedKeys, diaryDate, createPayload, expiredDiaryEntries };
