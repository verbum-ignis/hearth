import { db } from '../db.js';
import { TOUCHABLE_FILTER, starBand } from '../lib/decay.js';

// search = 一次查看（只读）：与 touch 同构返回全文，但零副作用——
// 不更新 last_accessed、不写 touch_log、不触发升星、不追加审计。
// 复习是 touch 的职责，查看是 search 的职责；访问次数不再混进衰减（④定稿）。

const FULL_LIMIT = 5;

class SearchError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseKeys(raw) {
  try {
    const keys = JSON.parse(raw);
    return Array.isArray(keys) ? keys : [];
  } catch {
    return [];
  }
}

function rowToEntry(row) {
  return {
    id: row.id,
    type: row.type,
    hook: row.hook,
    body: row.body,
    keys: parseKeys(row.keys),
    anchor: row.anchor,
    weight: row.weight,
    tier_since: row.tier_since,
    trigger_date: row.trigger_date,
    status: row.status,
    origin: row.origin ?? 'unknown', // ③：来源摘要随读取端返回，NULL 显式呈现为 unknown
    band: starBand(row), // 读取时它在哪——查看不改状态，band 只是位置快照
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// 关联浮现：与 touch 同口径——body 里 [[x]]，先按 id 再当 key。
// 只浮现 active 未封存条目，只给钩子不展开。搜索不改状态，关联浮现也不改。
function resolveLinks(rows, excludeIds) {
  const words = new Set();
  for (const row of rows) {
    for (const m of row.body.matchAll(/\[\[([^\]\n]+)\]\]/g)) words.add(m[1].trim());
  }
  if (words.size === 0) return [];

  const candidates = db.prepare(`
    SELECT id, hook, keys FROM hearth_entries WHERE status = 'active' AND sealed = 0
  `).all();
  const related = new Map();
  for (const w of words) {
    for (const c of candidates) {
      if (excludeIds.has(c.id) || related.has(c.id)) continue;
      if (c.id === w || parseKeys(c.keys).includes(w)) related.set(c.id, { id: c.id, hook: c.hook });
    }
  }
  return [...related.values()];
}

// keys 命中：默认走 TOUCHABLE_FILTER（active + 未封存 + keys 可触发范围）。
// archived=true 才把 archived（星云）条目纳入；纳入后仍尊重 sealed 与 keys 触发口径。
function matchByKeys(keys, archived) {
  const wanted = new Set(keys);
  const statusFilter = archived
    ? `status IN ('active','archived') AND sealed = 0 AND type IN ('event','project','letter','stream')`
    : TOUCHABLE_FILTER;
  const rows = db.prepare(`
    SELECT * FROM hearth_entries WHERE ${statusFilter}
    ORDER BY last_accessed DESC
  `).all();
  return rows.filter((row) => parseKeys(row.keys).some((k) => wanted.has(k)));
}

export function handleSearch(payload) {
  const { id, keys } = payload || {};
  const archived = (payload || {}).archived === true;

  let hits;
  if (typeof id === 'string' && id) {
    const row = db.prepare('SELECT * FROM hearth_entries WHERE id = ?').get(id);
    if (!row) throw new SearchError(404, `条目 ${id} 不存在`);
    hits = [row];
  } else if (Array.isArray(keys) && keys.length > 0) {
    hits = matchByKeys(keys.filter((k) => typeof k === 'string' && k), archived);
  } else {
    throw new SearchError(400, 'keys（非空数组）或 id 必须给一个');
  }

  const full = hits.slice(0, FULL_LIMIT);
  const overflow = hits.slice(FULL_LIMIT).map((r) => ({ id: r.id, hook: r.hook }));

  // 零副作用：不写库、不动状态，只读返回。
  const entries = full.map(rowToEntry);
  const related = resolveLinks(full, new Set(full.map((r) => r.id)));
  return { entries, overflow, related };
}

export function searchErrorStatus(err) {
  return err instanceof SearchError ? err.status : null;
}
