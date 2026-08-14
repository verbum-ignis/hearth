// ① 写入审计/verify 验收测试
//
// 每一条断言对应《方案_地基定稿_溯_20260813.md》①的验收清单：
//   1. 同一内容两种写法（keys 顺序不同）→ hash 一致
//   2. body 空串 vs 缺失 → hash 不同（语义未合并）
//   3. 手改 DB 一行 → verify 失败（审计行与落盘不符）
//   4. audit 表只增不改；verify 不影响 last_accessed
// 附加护栏：trigger_date 空串直接拒绝；升星（tier_up）后 verify 仍通过。
//
// 跑：node --test test/audit.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hearth-audit-'));
process.env.HEARTH_DB_PATH = join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { contentSha256 } = await import('../src/lib/canonical.js');
const { handleWrite } = await import('../src/routes/write.js');
const { handleVerify } = await import('../src/routes/verify.js');

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function auditRows(entryId) {
  return db.prepare('SELECT * FROM hearth_write_audit WHERE entry_id = ? ORDER BY revision').all(entryId);
}

test('验收1：keys 顺序不同、重复项 → canonical hash 一致', () => {
  const a = contentSha256({ type: 'event', keys: ['b', 'a'], hook: 'h', body: 'x', sealed: 0, anchor: 0, weight: 3, status: 'active' });
  const b = contentSha256({ type: 'event', keys: ['a', 'b', 'a'], hook: 'h', body: 'x', sealed: 0, anchor: 0, weight: 3, status: 'active' });
  assert.equal(a, b, 'keys 排序去重后应产生相同指纹');
});

test('验收1附：keys 缺失 = 空数组（定稿明说的合并）', () => {
  const a = contentSha256({ type: 'event', hook: 'h', body: 'x' });
  const b = contentSha256({ type: 'event', keys: [], hook: 'h', body: 'x' });
  assert.equal(a, b);
});

test('验收2：body 空串 vs 缺失 → hash 不同', () => {
  const emptyBody = contentSha256({ type: 'event', hook: 'h', body: '' });
  const missingBody = contentSha256({ type: 'event', hook: 'h' });
  assert.notEqual(emptyBody, missingBody, '空正文和没提供正文是两种状态');
});

test('验收2附：trigger_date null 与缺失 → hash 不同；空串直接抛错', () => {
  const withNull = contentSha256({ type: 'event', hook: 'h', body: 'x', trigger_date: null });
  const missing = contentSha256({ type: 'event', hook: 'h', body: 'x' });
  assert.notEqual(withNull, missing);
  assert.throws(() => contentSha256({ type: 'event', hook: 'h', body: 'x', trigger_date: '' }), /空串非法/);
});

test('写入响应携带 content_sha256，且与审计行一致', () => {
  const res = handleWrite({ op: 'create', entry: { type: 'event', keys: ['审计探针'], hook: '钩子', body: '正文' } });
  assert.equal(res.status, 200);
  assert.ok(res.body.content_sha256, '写入响应必须带 content_sha256');
  const rows = auditRows(res.body.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].op, 'create');
  assert.equal(rows[0].content_sha256, res.body.content_sha256);
});

test('验收3：手改 DB 一行 → verify 失败（hash_mismatch）', () => {
  const res = handleWrite({ op: 'create', entry: { type: 'event', keys: ['篡改探针'], hook: '钩子', body: '原始正文' } });
  const id = res.body.id;
  assert.equal(handleVerify(id).body.verified, true, '刚写完应当校验通过');

  db.prepare('UPDATE hearth_entries SET body = ? WHERE id = ?').run('被手改过的正文', id);
  const after = handleVerify(id);
  assert.equal(after.body.verified, false, '绕过写入路径的修改必须被 verify 抓出来');
  assert.equal(after.body.reason, 'hash_mismatch');
});

test('验收4：verify 不影响 last_accessed，也不追加审计行', () => {
  const res = handleWrite({ op: 'create', entry: { type: 'event', keys: ['只读探针'], hook: '钩子', body: '正文' } });
  const id = res.body.id;
  const before = db.prepare('SELECT last_accessed FROM hearth_entries WHERE id = ?').get(id);
  const auditCountBefore = auditRows(id).length;
  for (let i = 0; i < 10; i += 1) handleVerify(id);
  const afterRow = db.prepare('SELECT last_accessed FROM hearth_entries WHERE id = ?').get(id);
  assert.equal(afterRow.last_accessed, before.last_accessed, 'verify 是只读的，不得重置衰退时钟');
  assert.equal(auditRows(id).length, auditCountBefore, 'verify 不得追加审计行');
});

test('验收4附：update/retire 各追加一行，当前写路径只追加（revision 严格递增；防改写靠②备份 manifest）', () => {
  const res = handleWrite({ op: 'create', entry: { type: 'event', keys: ['生命周期探针'], hook: '钩子', body: 'v1' } });
  const id = res.body.id;
  handleWrite({ op: 'update', id, patch: { body: 'v2' } });
  handleWrite({ op: 'retire', id });
  const rows = auditRows(id);
  const ops = rows.map((r) => r.op);
  assert.deepEqual(ops.slice(0, 2), ['create', 'update']);
  assert.equal(ops[ops.length - 1], 'retire');
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i].revision > rows[i - 1].revision, 'revision 必须严格递增');
  }
  // retire 后 status 变化进入指纹，verify 仍与最新审计行一致
  assert.equal(handleVerify(id).body.verified, true);
});

test('supersede：旧条目留 supersede 审计行，新条目 create 行，双双可校验', () => {
  const created = handleWrite({ op: 'create', entry: { type: 'event', keys: ['盖章探针'], hook: '钩子', body: '旧' } });
  const oldId = created.body.id;
  const superseded = handleWrite({ op: 'supersede', id: oldId, entry: { type: 'event', keys: ['盖章探针'], hook: '钩子', body: '新' } });
  const newId = superseded.body.id;
  assert.equal(auditRows(oldId).map((r) => r.op).join(','), 'create,supersede');
  assert.equal(auditRows(newId).map((r) => r.op).join(','), 'create');
  assert.equal(handleVerify(oldId).body.verified, true, '旧条目状态变更后仍可校验');
  assert.equal(handleVerify(newId).body.verified, true);
});

test('meta_set 走 meta:<key> 命名空间，指纹随内容变化', () => {
  const first = handleWrite({ op: 'meta_set', key: 'now', content: '第一版' });
  const second = handleWrite({ op: 'meta_set', key: 'now', content: '第二版' });
  assert.ok(first.body.content_sha256 && second.body.content_sha256);
  assert.notEqual(first.body.content_sha256, second.body.content_sha256);
  const rows = auditRows('meta:now');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].content_sha256, second.body.content_sha256);
});

test('trigger_date 空串在写入口被拒（不再悄悄转 null）', () => {
  const res = handleWrite({ op: 'create', entry: { type: 'event', keys: ['k'], hook: 'h', body: 'b', trigger_date: '' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /空串非法/);
});

test('trigger_done 是受审计的控制字段：write 修改后 hash 改变', () => {
  const res = handleWrite({ op: 'create', entry: { type: 'event', keys: ['提醒探针'], hook: '钩子', body: '正文', trigger_date: '2026-09-01' } });
  const id = res.body.id;
  const hashBefore = res.body.content_sha256;
  const updated = handleWrite({ op: 'update', id, patch: { trigger_done: 1 } });
  assert.equal(updated.status, 200);
  assert.notEqual(updated.body.content_sha256, hashBefore, 'trigger_done 变化必须改变指纹');
  assert.equal(handleVerify(id).body.verified, true);
});

test('trigger_done 绕过 write 手改 → verify 失败（hash_mismatch）', () => {
  const res = handleWrite({ op: 'create', entry: { type: 'event', keys: ['提醒篡改探针'], hook: '钩子', body: '正文', trigger_date: '2026-09-02' } });
  const id = res.body.id;
  db.prepare('UPDATE hearth_entries SET trigger_done = 1 WHERE id = ?').run(id);
  const after = handleVerify(id);
  assert.equal(after.body.verified, false, '手改 trigger_done 必须被 verify 抓出来');
  assert.equal(after.body.reason, 'hash_mismatch');
});

test('meta verify：正常通过；手改 meta 后 mismatch；只读不追加审计', () => {
  handleWrite({ op: 'meta_set', key: 'timeline', content: '主线第一版' });
  assert.equal(handleVerify('meta:timeline').body.verified, true, '刚写完的 meta 应当校验通过');

  const auditCountBefore = auditRows('meta:timeline').length;
  for (let i = 0; i < 5; i += 1) handleVerify('meta:timeline');
  assert.equal(auditRows('meta:timeline').length, auditCountBefore, 'meta verify 不得追加审计行');

  db.prepare('UPDATE hearth_meta SET content = ? WHERE key = ?').run('被手改的主线', 'timeline');
  const after = handleVerify('meta:timeline');
  assert.equal(after.body.verified, false, '手改 meta 必须被 verify 抓出来——今天坏的就是 timeline');
  assert.equal(after.body.reason, 'hash_mismatch');
});

test('meta verify：不存在的 key → 404；审计链上线前的 meta → no_audit', () => {
  assert.equal(handleVerify('meta:不存在的key').status, 404);
  const t = db.prepare(`SELECT datetime('now') AS t`).get().t;
  db.prepare('INSERT INTO hearth_meta (key, content, updated_at) VALUES (?, ?, ?)').run('window_letter', '旧信', t);
  const res = handleVerify('meta:window_letter');
  assert.equal(res.body.verified, null);
  assert.equal(res.body.reason, 'no_audit');
});

test('旧条目（审计链上线前）verify 返回 no_audit，不误报失败', () => {
  // 直接注入一条没有审计行的条目，模拟历史数据
  const t = db.prepare(`SELECT datetime('now') AS t`).get().t;
  db.prepare(`
    INSERT INTO hearth_entries (id, type, keys, hook, body, sealed, anchor, last_accessed, status, created_at, updated_at)
    VALUES ('legacy_probe', 'event', '["旧"]', 'h', 'b', 0, 0, ?, 'active', ?, ?)
  `).run(t, t, t);
  const res = handleVerify('legacy_probe');
  assert.equal(res.body.verified, null);
  assert.equal(res.body.reason, 'no_audit');
});
