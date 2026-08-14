// ③ revision 链构造（Lumen ③二审）：读取端（/sources）与校验端（canonical/audit）
// 共用这一份实现——读到的链和验到的链必须是同一条，不许口径分叉。
//
// 语义：沿 revision_of 逐级回溯（不含起点行）；
// - 断裂（指向的行不存在）→ 链尾补 { source_id, missing: true }
// - 环（revision_of 指回已见过的 id）→ 停止并置 cycle=true，不静默
import { db } from '../db.js';

export const SOURCE_COLUMNS = 'source_id, kind, summary, excerpt, range, checksum, revision_of, created_at';

export function revisionChain(sourceRow) {
  const chain = [];
  const seen = new Set([sourceRow.source_id]);
  let cursor = sourceRow.revision_of;
  let cycle = false;
  while (cursor) {
    if (seen.has(cursor)) {
      cycle = true;
      break;
    }
    seen.add(cursor);
    const prev = db.prepare(`SELECT ${SOURCE_COLUMNS} FROM hearth_sources WHERE source_id = ?`).get(cursor);
    if (!prev) {
      chain.push({ source_id: cursor, missing: true });
      break;
    }
    chain.push(prev);
    cursor = prev.revision_of;
  }
  return { chain, cycle };
}
