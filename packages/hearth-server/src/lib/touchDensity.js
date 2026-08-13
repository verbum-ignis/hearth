import { db } from '../db.js';
import { TIER_RULES } from './decay.js';
import { snapshotEntry } from './snapshot.js';

// 调用方负责事务：记一次真正读到全文/主动改写，并在同一事务内检查是否升一级。
export function recordTouchAndMaybeTierUp(entryId, touchedAt) {
  db.prepare(`
    INSERT INTO hearth_touch_log (entry_id, touched_at) VALUES (?, ?)
  `).run(entryId, touchedAt);

  const entry = db.prepare('SELECT * FROM hearth_entries WHERE id = ?').get(entryId);
  if (!entry) return null;
  const rule = TIER_RULES.find((candidate) => candidate.from === entry.anchor);
  if (!rule) return null;

  if (entry.tier_since && rule.minGapDays > 0) {
    const gap = db.prepare(`
      SELECT julianday(?) - julianday(?) >= ? AS eligible
    `).get(touchedAt, entry.tier_since, rule.minGapDays);
    if (!gap.eligible) return null;
  }

  const density = db.prepare(`
    SELECT COUNT(DISTINCT date(touched_at)) AS c
    FROM hearth_touch_log
    WHERE entry_id = ?
      AND touched_at >= datetime(?, '-' || ? || ' days')
      AND (? IS NULL OR touched_at > ?)
  `).get(entryId, touchedAt, rule.windowDays, entry.tier_since, entry.tier_since).c;

  if (density < rule.distinctDays) return null;

  snapshotEntry(entry, 'tier_up');
  db.prepare(`
    UPDATE hearth_entries SET anchor = ?, tier_since = ?, updated_at = ? WHERE id = ?
  `).run(rule.to, touchedAt, touchedAt, entryId);
  return { from: rule.from, to: rule.to };
}
