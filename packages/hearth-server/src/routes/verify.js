// ① verify 端点（方案_地基定稿_溯_20260813）：只读校验。
//
// 取条目当前 revision 的审计行指纹，与落盘 canonical hash 比对。
// 不改任何状态：不 touch、不动 last_accessed、不写日志。
// seal 只证明"响应来自哪一座 Hearth"，内容证明 = canonical hash + 审计链 + 备份 manifest。
// meta 命名空间（meta:<key>）：meta_set 已留审计，今天坏掉的正是 timeline——verify 必须能读。
import { db } from '../db.js';
import { contentSha256, entryRowToPayload, metaSha256 } from '../lib/canonical.js';
import { latestEntryAudit, linkedSources } from '../lib/audit.js';

function verifyBody(current, audit) {
  const verified = current === audit.content_sha256;
  return {
    ok: true,
    verified,
    current_sha256: current,
    audit: {
      revision: audit.revision,
      op: audit.op,
      content_sha256: audit.content_sha256,
      created_at: audit.created_at,
    },
    ...(verified ? {} : { reason: 'hash_mismatch' }),
  };
}

export function handleVerify(id) {
  // meta 命名空间：meta:<key> → hearth_meta + metaSha256
  if (typeof id === 'string' && id.startsWith('meta:')) {
    const key = id.slice(5);
    const meta = db.prepare('SELECT content FROM hearth_meta WHERE key = ?').get(key);
    if (!meta) return { status: 404, body: { error: `meta ${key} 不存在` } };
    const audit = latestEntryAudit(id); // 审计行 entry_id = `meta:${key}`
    if (!audit) {
      return {
        status: 200,
        body: { ok: true, verified: null, reason: 'no_audit', message: '该 meta 早于审计链上线，无审计行可比对' },
      };
    }
    return { status: 200, body: verifyBody(metaSha256(key, meta.content), audit) };
  }

  const row = db.prepare('SELECT * FROM hearth_entries WHERE id = ?').get(id);
  if (!row) return { status: 404, body: { error: `条目 ${id} 不存在` } };

  const audit = latestEntryAudit(id);
  if (!audit) {
    // 审计链晚于旧条目：无法校验 ≠ 校验失败，语义分开
    return {
      status: 200,
      body: { ok: true, verified: null, reason: 'no_audit', message: '该条目早于审计链上线，无审计行可比对' },
    };
  }

  const current = contentSha256(entryRowToPayload(row, linkedSources(id)));
  return { status: 200, body: verifyBody(current, audit) };
}
