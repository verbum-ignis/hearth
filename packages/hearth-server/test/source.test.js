// ③ source 证据 验收测试
//
// 对应《方案_地基定稿_溯_20260813.md》③的验收清单：
//   1. 一条记忆挂两条群消息来源 → entry_sources 两条引用，可分别读到原文摘要与校验值
//   2. 修正来源 → 新 revision，旧记录保留
//   3. sealed 条目 source 摘录不外泄（search/load 无旁路）
//   4. 旧条目 origin=unknown，不显示为 manual
// 附加：sources 进 canonical/审计（①联动 + 终审护栏1 稳定键排序）；
//       空 sources 不编码，①的旧指纹保持连续。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'hearth-source-'));
process.env.HEARTH_DB_PATH = join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { handleWrite } = await import('../src/routes/write.js');
const { handleVerify } = await import('../src/routes/verify.js');
const { handleSources } = await import('../src/routes/sources.js');
const { contentSha256 } = await import('../src/lib/canonical.js');

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const CAMPFIRE_MSG_A = '溯: 方案写好了，在输出物目录。';
const CAMPFIRE_MSG_B = 'Lumen: 终审通过，可以交言实现。';

function createWithSources() {
  return handleWrite({
    op: 'create',
    entry: {
      type: 'event',
      keys: ['来源探针'],
      hook: '带来源的条目',
      body: '正文',
      origin: '篝火群聊 2026-08-13 的两条消息',
      sources: [
        { kind: 'campfire-chat', summary: '溯交方案的消息', excerpt: CAMPFIRE_MSG_A, range: 'msg_aaa' },
        { kind: 'campfire-chat', summary: 'Lumen 终审通过的消息', excerpt: CAMPFIRE_MSG_B, range: 'msg_bbb' },
      ],
    },
  });
}

test('验收1：一条记忆挂两条来源 → 两条引用各有摘要与校验值', () => {
  const res = createWithSources();
  assert.equal(res.status, 200);
  const read = handleSources(res.body.id);
  assert.equal(read.status, 200);
  assert.equal(read.body.sources.length, 2);
  const byRange = Object.fromEntries(read.body.sources.map((s) => [s.range, s]));
  assert.equal(byRange.msg_aaa.excerpt, CAMPFIRE_MSG_A);
  assert.equal(byRange.msg_aaa.checksum, createHash('sha256').update(CAMPFIRE_MSG_A, 'utf8').digest('hex'), 'checksum 必须是摘录的 sha256');
  assert.equal(byRange.msg_bbb.summary, 'Lumen 终审通过的消息');
  assert.equal(read.body.origin, '篝火群聊 2026-08-13 的两条消息');
  assert.equal(handleVerify(res.body.id).body.verified, true, '带来源的条目写完即可校验');
});

test('验收2：source_revise → 新 revision 挂上、旧记录原样保留、审计留痕', () => {
  const res = createWithSources();
  const entryId = res.body.id;
  const oldSource = handleSources(entryId).body.sources.find((s) => s.range === 'msg_aaa');

  const revised = handleWrite({
    op: 'source_revise',
    id: entryId,
    source_id: oldSource.source_id,
    source: { kind: 'campfire-chat', summary: '修正：溯交的是定稿不是初稿', excerpt: CAMPFIRE_MSG_A, range: 'msg_aaa' },
  });
  assert.equal(revised.status, 200);
  assert.equal(revised.body.revision_of, oldSource.source_id);

  // 旧行还在 hearth_sources 里，一字未动
  const oldRow = db.prepare('SELECT * FROM hearth_sources WHERE source_id = ?').get(oldSource.source_id);
  assert.equal(oldRow.summary, '溯交方案的消息', '旧 revision 必须原样保留');
  // 新行 revision_of 指回旧行，链接已切换
  const current = handleSources(entryId).body.sources.find((s) => s.range === 'msg_aaa');
  assert.equal(current.source_id, revised.body.source_id);
  assert.equal(current.revision_of, oldSource.source_id, '追溯链必须能走回旧 revision');
  // 指纹随链接变化，verify 仍一致
  assert.notEqual(revised.body.content_sha256, res.body.content_sha256);
  assert.equal(handleVerify(entryId).body.verified, true);
  const auditOps = db.prepare('SELECT op FROM hearth_write_audit WHERE entry_id = ? ORDER BY revision').all(entryId).map((r) => r.op);
  assert.ok(auditOps.includes('source_revise'));
});

test('验收3：sealed 条目来源不外泄——/sources 拒绝', () => {
  const res = handleWrite({
    op: 'create',
    entry: {
      type: 'letter',
      keys: ['密信探针'],
      hook: '密信',
      body: '不该被看到的内容',
      sealed: true,
      sources: [{ kind: 'manual', summary: '私下写的', excerpt: '密信原文摘录' }],
    },
  });
  const read = handleSources(res.body.id);
  assert.equal(read.status, 403, 'sealed 条目的来源必须被拒绝');
  assert.ok(!JSON.stringify(read.body).includes('密信原文摘录'), '响应里不得出现摘录内容');
});

test('验收4：旧条目 origin=unknown，不显示为 manual', () => {
  const t = db.prepare(`SELECT datetime('now') AS t`).get().t;
  db.prepare(`
    INSERT INTO hearth_entries (id, type, keys, hook, body, sealed, anchor, last_accessed, status, created_at, updated_at)
    VALUES ('legacy_src', 'event', '["旧"]', 'h', 'b', 0, 0, ?, 'active', ?, ?)
  `).run(t, t, t);
  const read = handleSources('legacy_src');
  assert.equal(read.body.origin, 'unknown');
  assert.notEqual(read.body.origin, 'manual');
  assert.deepEqual(read.body.sources, []);
});

test('①联动：sources 为空不编码——旧指纹连续；非空入串且插入顺序无关（护栏1）', () => {
  // 空 sources 的 payload 与完全不传 sources 的 payload 指纹一致
  const base = { type: 'event', hook: 'h', body: 'x' };
  assert.equal(contentSha256(base), contentSha256({ ...base, sources: [] }));
  // 同一组来源不同插入顺序 → 指纹一致（按 source_id 稳定排序）
  const s1 = { source_id: 'aaa', checksum: 'c1' };
  const s2 = { source_id: 'bbb', checksum: 'c2' };
  assert.equal(
    contentSha256({ ...base, sources: [s1, s2] }),
    contentSha256({ ...base, sources: [s2, s1] }),
  );
  // 有来源和没来源指纹不同
  assert.notEqual(contentSha256(base), contentSha256({ ...base, sources: [s1] }));
});

test('手改来源链接（绕过写路径）→ verify 抓出 hash_mismatch', () => {
  const res = createWithSources();
  const entryId = res.body.id;
  const link = db.prepare('SELECT source_id FROM entry_sources WHERE entry_id = ? LIMIT 1').get(entryId);
  db.prepare('DELETE FROM entry_sources WHERE entry_id = ? AND source_id = ?').run(entryId, link.source_id);
  const after = handleVerify(entryId);
  assert.equal(after.body.verified, false, '偷偷摘掉来源必须被 verify 抓出来');
  assert.equal(after.body.reason, 'hash_mismatch');
});

test('③一审1：来源逐字段手改 → verify 全部抓出 hash_mismatch', () => {
  for (const [field, value] of [
    ['kind', '被改成别的类型'],
    ['summary', '被改过的摘要'],
    ['range', 'msg_zzz'],
    ['revision_of', 'fake_rev_id'],
    ['checksum', 'deadbeef'.repeat(8)],
    ['excerpt', '被偷偷换掉的摘录正文'],
  ]) {
    const res = createWithSources();
    const entryId = res.body.id;
    assert.equal(handleVerify(entryId).body.verified, true);
    const link = db.prepare('SELECT source_id FROM entry_sources WHERE entry_id = ? LIMIT 1').get(entryId);
    db.prepare(`UPDATE hearth_sources SET ${field} = ? WHERE source_id = ?`).run(value, link.source_id);
    const after = handleVerify(entryId);
    assert.equal(after.body.verified, false, `手改 source.${field} 必须被 verify 抓出来`);
  }
});

test('③一审3：revision 链走 API 可完整回溯，两次修正后链长为 2', () => {
  const res = createWithSources();
  const entryId = res.body.id;
  const first = handleSources(entryId).body.sources.find((s) => s.range === 'msg_aaa');
  const rev1 = handleWrite({
    op: 'source_revise', id: entryId, source_id: first.source_id,
    source: { kind: 'campfire-chat', summary: '第一次修正', excerpt: CAMPFIRE_MSG_A, range: 'msg_aaa' },
  });
  handleWrite({
    op: 'source_revise', id: entryId, source_id: rev1.body.source_id,
    source: { kind: 'campfire-chat', summary: '第二次修正', excerpt: CAMPFIRE_MSG_A, range: 'msg_aaa' },
  });
  const current = handleSources(entryId).body.sources.find((s) => s.range === 'msg_aaa');
  assert.equal(current.summary, '第二次修正');
  assert.equal(current.revisions.length, 2, 'API 必须能读到完整历史链');
  assert.equal(current.revisions[0].summary, '第一次修正');
  assert.equal(current.revisions[1].summary, '溯交方案的消息', '链尾是最初的原始来源');
});

test('③二审：两次修订后手改最旧 revision 的 excerpt → verify mismatch', () => {
  const res = createWithSources();
  const entryId = res.body.id;
  const first = handleSources(entryId).body.sources.find((s) => s.range === 'msg_aaa');
  const rev1 = handleWrite({
    op: 'source_revise', id: entryId, source_id: first.source_id,
    source: { kind: 'campfire-chat', summary: '修一', excerpt: CAMPFIRE_MSG_A, range: 'msg_aaa' },
  });
  handleWrite({
    op: 'source_revise', id: entryId, source_id: rev1.body.source_id,
    source: { kind: 'campfire-chat', summary: '修二', excerpt: CAMPFIRE_MSG_A, range: 'msg_aaa' },
  });
  assert.equal(handleVerify(entryId).body.verified, true);
  // 手改链尾（最初的原始来源）的摘录——历史也是受保护的证据
  db.prepare('UPDATE hearth_sources SET excerpt = ? WHERE source_id = ?').run('被篡改的历史', first.source_id);
  const after = handleVerify(entryId);
  assert.equal(after.body.verified, false, '改最旧 revision 的摘录必须被 verify 抓出来');
});

test('③二审：删除中间 revision → verify mismatch，/sources 标 missing', () => {
  const res = createWithSources();
  const entryId = res.body.id;
  const first = handleSources(entryId).body.sources.find((s) => s.range === 'msg_aaa');
  const rev1 = handleWrite({
    op: 'source_revise', id: entryId, source_id: first.source_id,
    source: { kind: 'campfire-chat', summary: '中间修订', excerpt: CAMPFIRE_MSG_A, range: 'msg_aaa' },
  });
  handleWrite({
    op: 'source_revise', id: entryId, source_id: rev1.body.source_id,
    source: { kind: 'campfire-chat', summary: '最终修订', excerpt: CAMPFIRE_MSG_A, range: 'msg_aaa' },
  });
  assert.equal(handleVerify(entryId).body.verified, true);
  db.prepare('DELETE FROM hearth_sources WHERE source_id = ?').run(rev1.body.source_id);
  const after = handleVerify(entryId);
  assert.equal(after.body.verified, false, '删掉中间 revision 必须被 verify 抓出来');
  const current = handleSources(entryId).body.sources.find((s) => s.range === 'msg_aaa');
  assert.ok(current.revisions.some((r) => r.missing), '断裂必须在读取端标 missing');
});

test('③二审：revision_of 被改成环 → /sources 显式标 cycle，verify mismatch', () => {
  const res = createWithSources();
  const entryId = res.body.id;
  const first = handleSources(entryId).body.sources.find((s) => s.range === 'msg_aaa');
  const rev1 = handleWrite({
    op: 'source_revise', id: entryId, source_id: first.source_id,
    source: { kind: 'campfire-chat', summary: '将成环', excerpt: CAMPFIRE_MSG_A, range: 'msg_aaa' },
  });
  // 手改旧行的 revision_of 指回新行，制造环
  db.prepare('UPDATE hearth_sources SET revision_of = ? WHERE source_id = ?').run(rev1.body.source_id, first.source_id);
  const current = handleSources(entryId).body.sources.find((s) => s.range === 'msg_aaa');
  assert.equal(current.cycle, true, '环必须显式标注，不静默');
  assert.equal(handleVerify(entryId).body.verified, false, '手改 revision_of 制环必须被 verify 抓出来');
});

test('③一审2：manifest counts 覆盖 sources/source_links', async () => {
  const { collectCounts } = await import('../scripts/backup.mjs');
  const counts = collectCounts(process.env.HEARTH_DB_PATH);
  assert.ok(counts.sources > 0, 'manifest 必须数 hearth_sources');
  assert.ok(counts.source_links > 0, 'manifest 必须数 entry_sources');
});

test('origin 空串在入口被拒；sources 缺 kind/summary 被拒', () => {
  assert.equal(handleWrite({ op: 'create', entry: { type: 'event', keys: ['k'], hook: 'h', body: 'b', origin: '' } }).status, 400);
  assert.equal(handleWrite({ op: 'create', entry: { type: 'event', keys: ['k'], hook: 'h', body: 'b', sources: [{ summary: '没 kind' }] } }).status, 400);
  assert.equal(handleWrite({ op: 'create', entry: { type: 'event', keys: ['k'], hook: 'h', body: 'b', sources: [{ kind: 'manual' }] } }).status, 400);
});
