// 日记遗忘分层 · 通道 A（stream 升格）验收测试
//
// 对应《测试清单_日记升格通道A_溯_20260814.md》：
//   A1 stream 0→1 走 7 天窗 2 日快车道（比通用 14/4 轻）
//   A2 只 touch 1 个不同日 → 不升
//   A3 升到 anchor=1 后 1→2 走通用规则
//   A4 event 的 0→1 仍走通用 14/4，不受 stream 快车道影响
//   B1 升格留 tier_up 审计 + verify 仍通过
//   B2 search 不触发升格（④ 语义）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hearth-tier-'));
process.env.HEARTH_DB_PATH = join(dir, 'test.db');

const { db, now } = await import('../src/db.js');
const { handleWrite } = await import('../src/routes/write.js');
const { handleTouch } = await import('../src/routes/touch.js');
const { handleSearch } = await import('../src/routes/search.js');
const { handleVerify } = await import('../src/routes/verify.js');
const { tierRulesFor } = await import('../src/lib/decay.js');

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function create(type, keys) {
  return handleWrite({ op: 'create', entry: { type, keys, hook: 'h', body: 'b' } });
}

// 注入 N 个不同日的历史 touch_log（模拟过去已被 touch），再实际 touch 一次触发检查
function injectTouches(id, offsets) {
  for (const o of offsets) {
    db.prepare(`INSERT INTO hearth_touch_log (entry_id, touched_at) VALUES (?, datetime('now', ?))`).run(id, o);
  }
}

function anchorOf(id) {
  return db.prepare('SELECT anchor FROM hearth_entries WHERE id = ?').get(id).anchor;
}

test('tierRulesFor：stream 0→1 用 7 天窗 2 日，其余 fallback 通用', () => {
  const s = tierRulesFor('stream');
  assert.deepEqual(s[0], { from: 0, to: 1, minGapDays: 0, windowDays: 7, distinctDays: 2 }, 'stream 快车道');
  // 1→2、2→3 与通用一致
  const g = tierRulesFor('event');
  assert.equal(s[1].windowDays, g[1].windowDays);
  assert.equal(s[2].distinctDays, g[2].distinctDays);
});

test('A1：stream 跨 2 个不同日 touch → 0→1 升格', () => {
  const res = create('stream', ['日记探针']);
  const id = res.body.id;
  // 过去 7 天窗内已 touch 过 1 个不同日，今天再 touch 1 日 → 2 日，够升
  injectTouches(id, ['-3 days']);
  const touched = handleTouch({ id });
  assert.ok(touched.entries[0].anchor === 1 || anchorOf(id) === 1, 'stream 跨 2 日应升到 anchor=1');
});

test('A2：stream 只 touch 1 个不同日 → 不升', () => {
  const res = create('stream', ['日记单日']);
  const id = res.body.id;
  // 不注入历史，只今天 touch 一次 = 1 个不同日，不足 2 日
  handleTouch({ id });
  assert.equal(anchorOf(id), 0, '只 1 日不升');
});

test('A4：event 0→1 仍走通用 14 天 4 日，不受 stream 快车道影响', () => {
  const res = create('event', ['事件探针']);
  const id = res.body.id;
  // 注入 2 个不同日（stream 快车道的门槛），event 不应升
  injectTouches(id, ['-3 days']);
  handleTouch({ id });
  assert.equal(anchorOf(id), 0, 'event 2 日不够，仍要 4 日');
  // 再补到 4 日 → 升
  injectTouches(id, ['-5 days', '-7 days']);
  handleTouch({ id });
  assert.equal(anchorOf(id), 1, 'event 4 日才升');
});

test('B1：stream 升格留 tier_up 审计行，verify 仍通过', () => {
  const res = create('stream', ['审计日记']);
  const id = res.body.id;
  injectTouches(id, ['-2 days']);
  handleTouch({ id });
  assert.equal(anchorOf(id), 1);
  const ops = db.prepare('SELECT op FROM hearth_write_audit WHERE entry_id = ? ORDER BY revision').all(id).map((r) => r.op);
  assert.ok(ops.includes('tier_up'), '升格必须留审计');
  assert.equal(handleVerify(id).body.verified, true, '升格后 verify 仍一致');
});

test('B2：search 读 stream 不触发升格', () => {
  const res = create('stream', ['只读日记']);
  const id = res.body.id;
  injectTouches(id, ['-2 days']); // 已 touch 过 1 日
  for (let i = 0; i < 10; i += 1) handleSearch({ id }); // search 不写 touch_log
  assert.equal(anchorOf(id), 0, 'search 不升格');
  // search 之后 touch 才升（2 日凑齐）
  handleTouch({ id });
  assert.equal(anchorOf(id), 1);
});
