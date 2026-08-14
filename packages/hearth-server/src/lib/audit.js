// ① 写入审计（方案_地基定稿_溯_20260813）：追加式审计链。
//
// 定位：完整性校验 / 可追踪写入（事故检测链）。不是防篡改——
// 审计与数据同库，能被一起改；跨库证据由 ② 的独立备份 manifest 提供。
// 铁律（诚实版）：**当前写路径只追加**——本表只 INSERT，代码中不得出现对它的
// UPDATE/DELETE。注意：这只是应用层约束，数据库本身并不阻止修改；
// 防改写靠②的独立备份 manifest，不靠这张表。
// 调用方负责把 append 放在写入同一事务内。
import { createHash } from 'node:crypto';
import { db, now } from '../db.js';
import { contentSha256, entryRowToPayload, metaSha256 } from './canonical.js';
import { revisionChain } from './sourceChain.js';

const insertAudit = db.prepare(`
  INSERT INTO hearth_write_audit (entry_id, op, content_sha256, created_at)
  VALUES (?, ?, ?, ?)
`);

// ③ 条目的来源证据全集（当前挂载行 + 每条的完整 revision 链，Lumen ③二审：
// 可追溯历史不能是未受保护的历史——旧 revision 也在指纹里，改/删历史行都会暴露）。
// excerpt_sha 现场重算：摘录被手改（不动 checksum 列）指纹立变；
// checksum 列的落盘值另行入串，单独篡改它同样暴露。
// 链构造与 /sources 读取端共用 sourceChain.js，口径不分叉。
function normalizeSourceRow(s) {
  return {
    source_id: s.source_id,
    kind: s.kind ?? null,
    summary: s.summary ?? null,
    range: s.range ?? null,
    revision_of: s.revision_of ?? null,
    checksum: s.checksum ?? null,
    excerpt_sha: s.excerpt === null || s.excerpt === undefined ? null
      : createHash('sha256').update(s.excerpt, 'utf8').digest('hex'),
  };
}

export function linkedSources(entryId) {
  const current = db.prepare(`
    SELECT s.source_id, s.kind, s.summary, s.excerpt, s.range, s.checksum, s.revision_of
    FROM entry_sources es JOIN hearth_sources s ON s.source_id = es.source_id
    WHERE es.entry_id = ?
    ORDER BY s.source_id
  `).all(entryId);
  const flattened = [];
  for (const row of current) {
    flattened.push(normalizeSourceRow(row));
    const { chain } = revisionChain(row);
    for (const rev of chain) flattened.push(normalizeSourceRow(rev)); // missing 行编码为 kind/summary 全 null，与真实行可区分（kind NOT NULL）
  }
  return flattened;
}

// 写后调用：以落盘后的行状态（含挂载的来源）计算指纹并追加审计行，返回指纹
export function appendEntryAudit(entryId, op) {
  const row = db.prepare('SELECT * FROM hearth_entries WHERE id = ?').get(entryId);
  if (!row) return null;
  const hash = contentSha256(entryRowToPayload(row, linkedSources(entryId)));
  insertAudit.run(entryId, op, hash, now());
  return hash;
}

export function appendMetaAudit(key, content, op) {
  const hash = metaSha256(key, content);
  insertAudit.run(`meta:${key}`, op, hash, now());
  return hash;
}

export function latestEntryAudit(entryId) {
  return db.prepare(`
    SELECT revision, entry_id, op, content_sha256, created_at
    FROM hearth_write_audit WHERE entry_id = ?
    ORDER BY revision DESC LIMIT 1
  `).get(entryId);
}
