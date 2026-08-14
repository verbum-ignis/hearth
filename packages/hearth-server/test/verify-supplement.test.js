// verify 补充测试（溯，2026-08-13）
//
// 主实现已覆盖定稿验收 1-4（audit.test.js，12 条）。本文件补未覆盖的边角：
//   - verify 端点：未知 id、touch 后、升星后、sealed 条目、meta 边界
//   - canonical：sealed/anchor 缺失 vs 显式值、字段字面顺序、非法输入、数字 keys
//   - metaSha256 确定性、appendEntryAudit 空 id、entryRowToPayload 往返
//
// 跑：node --test test/verify-supplement.test.js

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hearth-verify-supp-'));
process.env.HEARTH_DB_PATH = join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { contentSha256, metaSha256, entryRowToPayload } = await import('../src/lib/canonical.js');
const { appendEntryAudit } = await import('../src/lib/audit.js');
const { handleWrite } = await import('../src/routes/write.js');
const { handleTouch } = await import('../src/routes/touch.js');
const { handleVerify } = await import('../src/routes/verify.js');

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function auditRows(entryId) {
  return db.prepare('SELECT * FROM hearth_write_audit WHERE entry_id = ? ORDER BY revision').all(entryId);
}

// ── verify 端点边角 ──

test('verify 未知 id → 404，不误报 no_audit/hash_mismatch', () => {
  const res = handleVerify('no-such-entry');
  assert.equal(res.status, 404);
  assert.match(res.body.error, /不存在/);
});

test('touch（复习）后 verify 仍通过——touch 不改 canonical 字段，也不追加审计', () => {
  const created = handleWrite({ op: 'create', entry: { type: 'event', keys: ['touch探针'], hook: 'h', body: 'b' } });
  const id = created.body.id;
  const auditsBefore = auditRows(id).length;
  const touched = handleTouch({ id });
  assert.ok(Array.isArray(touched.entries) && touched.entries.length === 1, 'touch 应命中该条目');
  assert.equal(auditRows(id).length, auditsBefore, '普通 touch 不追加审计行');
  assert.equal(handleVerify(id).body.verified, true, 'touch 只动 last_accessed，指纹不变');
});

test('升星（tier_up）后：留 tier_up 审计行，verify 仍通过', () => {
  const created = handleWrite({ op: 'create', entry: { type: 'event', keys: ['升星探针'], hook: 'h', body: 'b' } });
  const id = created.body.id;
  // 0→1：14 天窗内 4 个不同日。注入 4 个历史 touch_log，再实际 touch 一次触发
  for (const offset of ['-3 days', '-6 days', '-9 days', '-12 days']) {
    db.prepare(`INSERT INTO hearth_touch_log (entry_id, touched_at) VALUES (?, datetime('now', ?))`).run(id, offset);
  }
  const touched = handleTouch({ id });
  assert.ok(Array.isArray(touched.entries), 'touch 应返回 entries');
  const ops = auditRows(id).map((r) => r.op);
  assert.ok(ops.includes('tier_up'), `应留 tier_up 审计行，实际 ${ops.join(',')}`);
  assert.equal(handleVerify(id).body.verified, true, 'anchor 变化已入新指纹，verify 仍应通过');
});

test('verify 对 sealed 条目正常（sealed=1 入指纹）', () => {
  const created = handleWrite({ op: 'create', entry: { type: 'event', keys: ['sealed探针'], hook: 'h', body: 'b', sealed: true } });
  const id = created.body.id;
  const res = handleVerify(id);
  assert.equal(res.body.verified, true);
  // sealed 是真值 → 指纹含 sealed=1；与 sealed=0 的同一内容指纹不同
  const sealedRow = db.prepare('SELECT * FROM hearth_entries WHERE id = ?').get(id);
  const unsealed = contentSha256({ ...entryRowToPayload(sealedRow), sealed: 0 });
  const kept = contentSha256(entryRowToPayload(sealedRow));
  assert.notEqual(kept, unsealed, 'sealed 是 canonical 字段，改它必须改指纹');
});

test('meta verify：正常通过、手改 mismatch、只读不追加审计', () => {
  const first = handleWrite({ op: 'meta_set', key: 'timeline', content: '原始主线' });
  assert.equal(handleVerify('meta:timeline').body.verified, true, '刚写入的 meta 应校验通过');

  // 手改 meta（模拟今天的 timeline 乱码事故路径）
  db.prepare('UPDATE hearth_meta SET content = ? WHERE key = ?').run('被手改的主线', 'timeline');
  const after = handleVerify('meta:timeline');
  assert.equal(after.body.verified, false, '绕过写入路径的 meta 修改必须被 verify 抓出来');
  assert.equal(after.body.reason, 'hash_mismatch');

  // 只读：verify 不追加审计行
  const auditsBefore = auditRows('meta:timeline').length;
  handleVerify('meta:timeline');
  assert.equal(auditRows('meta:timeline').length, auditsBefore, 'verify 不得追加 meta 审计行');
});

test('meta verify：未知 meta 返回 404；no_audit 语义保留', () => {
  assert.equal(handleVerify('meta:no-such-key').status, 404);
  // 直接注入无审计的 meta，模拟旧数据
  db.prepare('INSERT INTO hearth_meta (key, content, updated_at) VALUES (?, ?, datetime(\'now\'))').run('legacy_meta', '旧值');
  const res = handleVerify('meta:legacy_meta');
  assert.equal(res.body.verified, null);
  assert.equal(res.body.reason, 'no_audit');
});

// ── canonical 边角 ──

test('canonical：sealed 缺失 vs false vs true 各自独立', () => {
  const base = { type: 'event', hook: 'h', body: 'x' };
  assert.notEqual(contentSha256(base), contentSha256({ ...base, sealed: false }), '缺失与 false 不许合并');
  assert.notEqual(contentSha256({ ...base, sealed: false }), contentSha256({ ...base, sealed: true }));
});

test('canonical：anchor 缺失 vs 0 各自独立', () => {
  const base = { type: 'event', hook: 'h', body: 'x' };
  assert.notEqual(contentSha256(base), contentSha256({ ...base, anchor: 0 }), '缺失与 0 不许合并');
  assert.notEqual(contentSha256({ ...base, anchor: 0 }), contentSha256({ ...base, anchor: 1 }));
});

test('canonical：输入对象字段字面顺序无关（FIELD_ORDER 固定）', () => {
  const a = contentSha256({ type: 'event', keys: ['k'], hook: 'h', body: 'b', status: 'active' });
  const b = contentSha256({ status: 'active', body: 'b', hook: 'h', keys: ['k'], type: 'event' });
  assert.equal(a, b, '字段顺序由 FIELD_ORDER 决定，与字面书写顺序无关');
});

test('canonical：非法输入抛错；数字 keys 归一为字符串', () => {
  assert.throws(() => contentSha256('not-an-object'), /输入必须是对象/);
  assert.throws(() => contentSha256(null), /输入必须是对象/);
  assert.throws(() => contentSha256({ type: 'event', keys: 'x', hook: 'h' }), /keys 必须是数组/);
  const numeric = contentSha256({ type: 'event', keys: [2, 1], hook: 'h', body: 'b' });
  const stringified = contentSha256({ type: 'event', keys: ['1', '2'], hook: 'h', body: 'b' });
  assert.equal(numeric, stringified, '数字 keys 经 String() 归一后应一致');
});

test('trigger_done 入 canonical：update 改它 → hash 改变；绕过写路径手改 → mismatch', () => {
  const created = handleWrite({ op: 'create', entry: { type: 'event', keys: ['提醒探针'], hook: 'h', body: 'b', trigger_date: '2026-09-01' } });
  const id = created.body.id;
  const createHash = created.body.content_sha256;

  // 正常 update 只改 trigger_done：新审计行的指纹必须与旧的不同
  const updated = handleWrite({ op: 'update', id, patch: { trigger_done: 1 } });
  assert.equal(updated.status, 200);
  const rows = auditRows(id);
  assert.notEqual(rows[rows.length - 1].content_sha256, createHash, 'trigger_done 0→1 必须改变指纹');
  assert.equal(handleVerify(id).body.verified, true, '正常 update 后 verify 仍通过');

  // 绕过写路径手改 trigger_done：verify 必须抓出来
  db.prepare('UPDATE hearth_entries SET trigger_done = 0 WHERE id = ?').run(id);
  const after = handleVerify(id);
  assert.equal(after.body.verified, false, '手改 trigger_done 必须 hash_mismatch');
  assert.equal(after.body.reason, 'hash_mismatch');
});

test('canonical 边界诚实：last_accessed/tier_since 不在 FIELD_ORDER（operational state 排除）', () => {
  const base = { type: 'event', hook: 'h', body: 'b' };
  // 输入里多带 operational 字段，不影响指纹（不参与 canonical）
  const withOperational = contentSha256({ ...base, last_accessed: 'x', tier_since: 'y' });
  const clean = contentSha256(base);
  assert.equal(withOperational, clean, 'operational 字段不得进入指纹');
});

test('metaSha256 确定性；不同 key / 不同内容 → 不同指纹', () => {
  const a = metaSha256('now', '同一段');
  const b = metaSha256('now', '同一段');
  assert.equal(a, b, '同 key 同内容必须幂等');
  assert.notEqual(metaSha256('now', 'x'), metaSha256('now', 'y'));
  assert.notEqual(metaSha256('a', 'x'), metaSha256('b', 'x'));
});

test('appendEntryAudit 对不存在的 id 返回 null（不抛错）', () => {
  assert.equal(appendEntryAudit('no-such-id', 'create'), null);
});

test('entryRowToPayload 往返：按落盘行构造 payload → 指纹与写入响应一致', () => {
  const created = handleWrite({ op: 'create', entry: { type: 'event', keys: ['b', 'a'], hook: 'h', body: 'b', weight: 4 } });
  const id = created.body.id;
  const row = db.prepare('SELECT * FROM hearth_entries WHERE id = ?').get(id);
  const rebuilt = contentSha256(entryRowToPayload(row));
  assert.equal(rebuilt, created.body.content_sha256, 'DB 行重建的指纹必须等于写入时的指纹');
});
