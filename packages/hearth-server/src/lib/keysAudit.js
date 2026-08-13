import { db } from '../db.js';

// keys 对账：新/改条目的 keys 与既有 active 未封存条目求交集，
// 命中的返回 hook 列表，由小机当场人工裁决。不做自动事实比对。
export function auditKeys(keys, excludeId = null) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const rows = db.prepare(`
    SELECT id, hook, keys FROM hearth_entries
    WHERE status = 'active' AND sealed = 0
  `).all();
  const mine = new Set(keys);
  const collisions = [];
  for (const row of rows) {
    if (row.id === excludeId) continue;
    let theirs;
    try { theirs = JSON.parse(row.keys); } catch { continue; }
    const overlap = theirs.filter((k) => mine.has(k));
    if (overlap.length > 0) {
      collisions.push({ id: row.id, hook: row.hook, keys_overlap: overlap });
    }
  }
  return collisions;
}
