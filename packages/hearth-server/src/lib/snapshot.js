import { db, now } from '../db.js';

const insertHistory = db.prepare(`
  INSERT INTO hearth_history (target_type, target_id, op, snapshot, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

// 写前快照：任何 update/supersede/retire/meta_set 之前，先把当前完整版本存入历史表。
// 调用方负责把本函数放在同一事务内。
export function snapshotEntry(entryRow, op) {
  insertHistory.run('entry', entryRow.id, op, JSON.stringify(entryRow), now());
}

export function snapshotMeta(metaRow, op) {
  insertHistory.run('meta', metaRow.key, op, JSON.stringify(metaRow), now());
}
