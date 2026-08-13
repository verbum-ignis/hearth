import { db, transaction } from '../src/db.js';

const before = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN anchor = 1 THEN 1 ELSE 0 END) AS anchor_one,
    SUM(CASE WHEN anchor = 3 THEN 1 ELSE 0 END) AS anchor_three
  FROM hearth_entries
`).get();

const changed = transaction(() => db.prepare(`
  UPDATE hearth_entries
  SET anchor = 3, tier_since = updated_at
  WHERE anchor = 1
`).run().changes);

const after = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN anchor = 1 THEN 1 ELSE 0 END) AS anchor_one,
    SUM(CASE WHEN anchor = 3 THEN 1 ELSE 0 END) AS anchor_three
  FROM hearth_entries
`).get();

console.log(JSON.stringify({ before, changed, after }, null, 2));
db.close();
