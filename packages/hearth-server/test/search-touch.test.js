// ④ search / touch 分离 验收测试
//
// 对应《方案_地基定稿_溯_20260813.md》④的验收清单：
//   1. search 读 100 次 → last_accessed/touch_log/升星零变化
//   2. touch(id) 正常复习（重置衰减 + 审计）
//   3. touch(tags) 兼容运行但标记弃用
//   4. 读全文走 search、复习才走 touch（scan-input 语义）
// 附加：search 零副作用（不写审计、不动 canonical、verify 仍通过）；
//       archived 默认不含、显式 archived=true 才含。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hearth-search-'));
process.env.HEARTH_DB_PATH = join(dir, 'test.db');

const { db, now } = await import('../src/db.js');
const { handleWrite } = await import('../src/routes/write.js');
const { handleSearch } = await import('../src/routes/search.js');
const { handleTouch } = await import('../src/routes/touch.js');
const { handleVerify } = await import('../src/routes/verify.js');
const { handleLoad } = await import('../src/routes/load.js');

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function create(opts = {}) {
  return handleWrite({
    op: 'create',
    entry: { type: 'event', keys: ['探针'], hook: 'h', body: '正文 [[关联词]]', ...opts },
  });
}

function touchLogCount(id) {
  return db.prepare('SELECT COUNT(*) AS c FROM hearth_touch_log WHERE entry_id = ?').get(id).c;
}

function auditCount(id) {
  return db.prepare('SELECT COUNT(*) AS c FROM hearth_write_audit WHERE entry_id = ?').get(id).c;
}

// ── A. search 零副作用 ──

test('A1：search(keys) 命中返回全文 + band，last_accessed 不变', () => {
  const res = create({ keys: ['只读探针'] });
  const id = res.body.id;
  const before = db.prepare('SELECT last_accessed FROM hearth_entries WHERE id = ?').get(id).last_accessed;

  const hit = handleSearch({ keys: ['只读探针'] });
  assert.equal(hit.entries.length, 1);
  assert.equal(hit.entries[0].id, id);
  assert.ok(hit.entries[0].body, 'search 应返回全文');
  assert.ok(hit.entries[0].band, 'search 应返回 band');

  const afterRow = db.prepare('SELECT last_accessed FROM hearth_entries WHERE id = ?').get(id).last_accessed;
  assert.equal(afterRow, before, 'search 不得重置衰退时钟');
});

test('A2：search(id) 显式按名取返回全文，last_accessed 不变', () => {
  const res = create({ keys: ['按名探针'] });
  const id = res.body.id;
  const before = db.prepare('SELECT last_accessed FROM hearth_entries WHERE id = ?').get(id).last_accessed;

  const hit = handleSearch({ id });
  assert.equal(hit.entries.length, 1);
  assert.equal(hit.entries[0].id, id);
  assert.equal(db.prepare('SELECT last_accessed FROM hearth_entries WHERE id = ?').get(id).last_accessed, before);
});

test('A3：search 读 100 次 → touch_log 零新增、anchor 零变化', () => {
  const res = create({ keys: ['百次探针'] });
  const id = res.body.id;
  const beforeLog = touchLogCount(id);
  const beforeAnchor = db.prepare('SELECT anchor FROM hearth_entries WHERE id = ?').get(id).anchor;

  for (let i = 0; i < 100; i += 1) {
    handleSearch({ keys: ['百次探针'] });
  }
  assert.equal(touchLogCount(id), beforeLog, 'search 100 次不得写 touch_log');
  assert.equal(db.prepare('SELECT anchor FROM hearth_entries WHERE id = ?').get(id).anchor, beforeAnchor, 'search 不得触发升星');
});

test('A4：search 不追加写入审计行', () => {
  const res = create({ keys: ['审计探针'] });
  const id = res.body.id;
  const before = auditCount(id);
  handleSearch({ id });
  assert.equal(auditCount(id), before, 'search 是只读的，不得追加审计');
});

test('A5：search 前后 verify 仍 verified=true', () => {
  const res = create({ keys: ['verify探针'] });
  const id = res.body.id;
  assert.equal(handleVerify(id).body.verified, true);
  handleSearch({ id });
  assert.equal(handleVerify(id).body.verified, true, 'search 不碰 canonical 字段');
});

// ── B. 参数与返回形状 ──

test('B0：search/touch 返回 origin（③：origin 随读取端返回，NULL 显式 unknown）', () => {
  const withOrigin = create({ keys: ['来源探针'], origin: '篝火群聊里的一句话' });
  const hit = handleSearch({ id: withOrigin.body.id });
  assert.equal(hit.entries[0].origin, '篝火群聊里的一句话', 'search 返回 origin');
  const touched = handleTouch({ id: withOrigin.body.id });
  assert.equal(touched.entries[0].origin, '篝火群聊里的一句话', 'touch 返回 origin');

  const noOrigin = create({ keys: ['无源探针'] });
  assert.equal(handleSearch({ id: noOrigin.body.id }).entries[0].origin, 'unknown', '缺 origin 显式 unknown');
  assert.equal(handleTouch({ id: noOrigin.body.id }).entries[0].origin, 'unknown');
});

test('B0b：load 的 rule/核心记忆返回 origin', () => {
  // rule 常驻全文 + weight=5 核心记忆随 load 返回，origin 不能丢
  const rule = handleWrite({ op: 'create', entry: { type: 'rule', keys: ['规'], hook: '规', body: '规文', origin: '手册' } });
  const core = handleWrite({ op: 'create', entry: { type: 'event', keys: ['核'], hook: '核', body: '核文', weight: 5, origin: '里程碑' } });
  const loaded = handleLoad('start');
  const rulesById = Object.fromEntries(loaded.rules.map((r) => [r.id, r]));
  assert.equal(rulesById[rule.body.id].origin, '手册', 'load 的 rule 带 origin');
  const coresById = Object.fromEntries(loaded.core_memories.map((r) => [r.id, r]));
  assert.equal(coresById[core.body.id].origin, '里程碑', 'load 的核心记忆带 origin');
});

test('B2：archived 默认不含；archived=true 才含', () => {
  // 造一条 archived 条目（绕过写路径，直接置状态）
  const t = now();
  db.prepare(`
    INSERT INTO hearth_entries (id, type, keys, hook, body, sealed, anchor, last_accessed, status, created_at, updated_at)
    VALUES ('arch_probe', 'event', '["星云探针"]', 'h', 'b', 0, 0, ?, 'archived', ?, ?)
  `).run(t, t, t);

  const def = handleSearch({ keys: ['星云探针'] });
  assert.equal(def.entries.length, 0, '默认不含 archived');

  const withArch = handleSearch({ keys: ['星云探针'], archived: true });
  assert.equal(withArch.entries.length, 1, 'archived=true 才含');
  assert.equal(withArch.entries[0].id, 'arch_probe');
  assert.equal(withArch.entries[0].band, 'nebula', 'archived 条目 band 应为 nebula');
});

test('B3：limit/overflow 与 touch 同构——≤5 全文 + 溢出只给钩子', () => {
  for (let i = 0; i < 7; i += 1) {
    create({ keys: ['溢出探针'], hook: `hook-${i}`, body: `body-${i}` });
  }
  const hit = handleSearch({ keys: ['溢出探针'] });
  assert.equal(hit.entries.length, 5, '全文上限 5');
  assert.equal(hit.overflow.length, 2, '溢出 2 条给钩子');
  for (const o of hit.overflow) {
    assert.ok(o.id && o.hook, '溢出只给 id+hook');
    assert.equal(o.body, undefined, '溢出不得带全文');
  }
});

test('B5：sealed 不通过 keys 检索外泄', () => {
  create({ keys: ['密探针'], sealed: true, body: '密文' });
  const hit = handleSearch({ keys: ['密探针'] });
  assert.equal(hit.entries.length, 0, 'sealed 条目不得被 keys 检索到');
});

test('B6：空入参 → 400', () => {
  assert.throws(() => handleSearch({}), (err) => err.status === 400);
  assert.throws(() => handleSearch({ keys: [] }), (err) => err.status === 400);
});

test('B6b：未知 id → 404', () => {
  assert.throws(() => handleSearch({ id: '不存在的条目' }), (err) => err.status === 404);
});

// ── C. touch 收窄 + 分离语义 ──

test('C1：touch(id) 正常复习——重置 last_accessed + 记 touch_log', () => {
  const res = create({ keys: ['复习探针'] });
  const id = res.body.id;
  // 把 last_accessed 挪到过去，确认 touch 把它拉回现在
  db.prepare(`UPDATE hearth_entries SET last_accessed = datetime('now', '-10 days') WHERE id = ?`).run(id);
  const before = db.prepare('SELECT last_accessed FROM hearth_entries WHERE id = ?').get(id).last_accessed;
  const beforeLog = touchLogCount(id);

  const touched = handleTouch({ id });
  assert.equal(touched.entries.length, 1);
  const afterRow = db.prepare('SELECT last_accessed FROM hearth_entries WHERE id = ?').get(id).last_accessed;
  assert.notEqual(afterRow, before, 'touch 必须重置衰退时钟');
  assert.equal(touchLogCount(id), beforeLog + 1, 'touch 必须记一行 touch_log');
});

test('C2：touch(tags) 兼容运行不破', () => {
  create({ keys: ['兼容探针'] });
  const touched = handleTouch({ tags: ['兼容探针'] });
  assert.ok(touched.entries.length >= 1, 'tags 通道本轮仍可用');
});

test('C3：分离语义——search 不动 last_accessed，touch 前进它', () => {
  const res = create({ keys: ['分离探针'] });
  const id = res.body.id;
  const a = db.prepare('SELECT last_accessed FROM hearth_entries WHERE id = ?').get(id).last_accessed;
  handleSearch({ id });
  const b = db.prepare('SELECT last_accessed FROM hearth_entries WHERE id = ?').get(id).last_accessed;
  assert.equal(b, a, 'search 后不动');
  // 让 touch 能产生可观察变化：把时钟拨回过去
  db.prepare(`UPDATE hearth_entries SET last_accessed = datetime('now', '-5 days') WHERE id = ?`).run(id);
  const beforeTouch = db.prepare('SELECT last_accessed FROM hearth_entries WHERE id = ?').get(id).last_accessed;
  assert.notEqual(beforeTouch, b, '拨回后应早于现在');
  handleTouch({ id });
  const c = db.prepare('SELECT last_accessed FROM hearth_entries WHERE id = ?').get(id).last_accessed;
  assert.notEqual(c, beforeTouch, 'touch 后前进');
});
