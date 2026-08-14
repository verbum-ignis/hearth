import { db, now, transaction } from '../db.js';
import { TOUCHABLE_FILTER, starBand } from '../lib/decay.js';
import { recordTouchAndMaybeTierUp } from '../lib/touchDensity.js';

// touch = 一次复习：返回全文的条目 last_accessed 重置，星星飞回篝火边。
// tags 模式走 keys 触发通道（沉底档 keys 失效）；id 模式是显式按名取，任何 status 都给。
// 幂等，去重靠上下文。
//
// ④ 弃用标注：tags 通道即将废弃——查看走 /search（只读），复习才走 touch 且只认显式 id。
// 本轮保留 tags 兼容（老调用不破），迁移完成后删除 tags 分支。

const FULL_LIMIT = 5;

class TouchError extends Error {
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
    band: starBand(row), // touch 前它在哪——从黑暗里捞回来这件事本身有信息量
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// 关联浮现：body 里 [[x]]，先按 id 精确匹配，再当 key 词匹配。
// 只浮现 active 未封存条目（sealed 的 hook 出现即泄漏），只给钩子不展开。
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

function matchByTags(tags) {
  const wanted = new Set(tags);
  const rows = db.prepare(`
    SELECT * FROM hearth_entries WHERE ${TOUCHABLE_FILTER}
    ORDER BY last_accessed DESC
  `).all();
  return rows.filter((row) => parseKeys(row.keys).some((k) => wanted.has(k)));
}

export function handleTouch(payload) {
  const { tags, id } = payload || {};

  let hits;
  if (typeof id === 'string' && id) {
    const row = db.prepare('SELECT * FROM hearth_entries WHERE id = ?').get(id);
    if (!row) throw new TouchError(404, `条目 ${id} 不存在`);
    hits = [row];
  } else if (Array.isArray(tags) && tags.length > 0) {
    hits = matchByTags(tags.filter((t) => typeof t === 'string' && t));
  } else {
    throw new TouchError(400, 'tags（非空数组）或 id 必须给一个');
  }

  const full = hits.slice(0, FULL_LIMIT);
  const overflow = hits.slice(FULL_LIMIT).map((r) => ({ id: r.id, hook: r.hook }));

  // 先算 band（touch 前的位置），再在事务内重置衰退时钟。
  // 只动 last_accessed 不动 updated_at——复习不是改写。
  const entries = full.map(rowToEntry);
  if (full.length > 0) {
    transaction(() => {
      const t = now();
      const stmt = db.prepare('UPDATE hearth_entries SET last_accessed = ? WHERE id = ?');
      for (let i = 0; i < full.length; i += 1) {
        const row = full[i];
        stmt.run(t, row.id);
        const tierUp = recordTouchAndMaybeTierUp(row.id, t);
        if (tierUp) {
          entries[i].anchor = tierUp.to;
          entries[i].tier_since = t;
          entries[i].tier_up = tierUp;
        }
      }
    });
  }

  const related = resolveLinks(full, new Set(full.map((r) => r.id)));
  return { entries, overflow, related };
}

export function touchErrorStatus(err) {
  return err instanceof TouchError ? err.status : null;
}

// keys 索引：输入扫描 hook 的本地缓存 + 小机直接查词表。范围与 tags 触发同口径。
export function handleKeysIndex() {
  const rows = db.prepare(`
    SELECT id, hook, keys, weight FROM hearth_entries WHERE ${TOUCHABLE_FILTER}
    ORDER BY last_accessed DESC
  `).all();
  return {
    keys_index: rows.map((r) => ({ id: r.id, hook: r.hook, keys: parseKeys(r.keys), weight: r.weight })),
  };
}
