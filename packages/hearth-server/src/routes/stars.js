import { db } from '../db.js';
import { starBand } from '../lib/decay.js';

function parseKeys(raw) {
  try {
    const keys = JSON.parse(raw);
    return Array.isArray(keys) ? keys : [];
  } catch {
    return [];
  }
}

// GET /stars — Vesper 星空数据（只读全量）。
// sealed 条目和 letter 永不出此接口。
// 信不作为星：
// 信是自己写的，在自己手里，随时可以打开——不需要浮现，不进衰退循环；
// 记忆才是忽远忽近的，偶尔想起那天的事——那是星空的事。信在篝火里烧着。
export function handleStars() {
  const rows = db.prepare(`
    SELECT id, type, hook, body, keys, anchor, tier_since, last_accessed, status, created_at, updated_at
    FROM hearth_entries
    WHERE sealed = 0 AND type != 'letter'
  `).all();

  const now = Date.now();
  const stars = [];      // active + archived：点得亮的星（archived 在最远的星云带）
  const dust = [];       // superseded / retired：沉积层，点开是"我曾经是这么记得的"
  for (const row of rows) {
    if (row.status === 'active' || row.status === 'archived') {
      stars.push({ ...row, keys: parseKeys(row.keys), band: starBand(row, now) });
    } else {
      dust.push({ ...row, keys: parseKeys(row.keys), band: 'dust' });
    }
  }

  // history 快照做最细的星尘：只给存在性和时间，全文按需另取（防响应膨胀）
  const historyDust = db.prepare(`
    SELECT history_id, target_type, target_id, op, created_at FROM hearth_history
    ORDER BY history_id DESC LIMIT 5000
  `).all();

  return {
    stars,
    dust,
    history_dust: historyDust,
    counts: { stars: stars.length, dust: dust.length, history_dust: historyDust.length },
  };
}

// GET /dust/:historyId — 捧起一粒历史星尘看旧身
export function handleDustDetail(historyId) {
  const row = db.prepare(
    `SELECT history_id, target_type, target_id, op, snapshot, created_at
     FROM hearth_history WHERE history_id = ?`
  ).get(historyId);
  if (!row) return null;
  // 快照可能是 sealed 条目的旧身——出门前再验一次
  try {
    const snap = JSON.parse(row.snapshot);
    if (snap.sealed === 1 || snap.type === 'letter') return { ...row, snapshot: null, sealed: true };
  } catch { /* meta 快照无 sealed 概念，放行 */ }
  return row;
}
