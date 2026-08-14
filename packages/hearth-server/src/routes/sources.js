// ③ 来源读取（方案_地基定稿_溯_20260813 + Lumen ③一审/二审）：只读。
//
// sealed 铁律：sealed 条目的来源摘录与正文同级保密——search/load/本端点一律不外泄。
// 可追溯要走 API：每条当前来源附完整 revisions 链（沿 revision_of 逐级回溯），
// 旧 revision 不许只活在 DB 里。断裂标 missing，环显式标 cycle，不静默。
// 链构造与 canonical/audit 共用 sourceChain.js——读到的链和验到的链是同一条。
// 注：hearth_sources 无 DB trigger 禁改，"不可变"只是当前写路径不原地改。
import { db } from '../db.js';
import { revisionChain, SOURCE_COLUMNS } from '../lib/sourceChain.js';

export function handleSources(entryId) {
  const entry = db.prepare('SELECT id, sealed, origin FROM hearth_entries WHERE id = ?').get(entryId);
  if (!entry) return { status: 404, body: { error: `条目 ${entryId} 不存在` } };
  if (entry.sealed) {
    return { status: 403, body: { error: 'sealed 条目的来源与正文同级保密，不外泄' } };
  }
  const sources = db.prepare(`
    SELECT ${SOURCE_COLUMNS.split(', ').map((c) => `s.${c}`).join(', ')}
    FROM entry_sources es JOIN hearth_sources s ON s.source_id = es.source_id
    WHERE es.entry_id = ?
    ORDER BY s.source_id
  `).all(entryId).map((s) => {
    const { chain, cycle } = revisionChain(s);
    return { ...s, revisions: chain, ...(cycle ? { cycle: true } : {}) };
  });
  return {
    status: 200,
    body: {
      ok: true,
      entry_id: entryId,
      origin: entry.origin ?? 'unknown', // NULL 显式呈现为 unknown，不许悄悄当 manual
      sources,
    },
  };
}
