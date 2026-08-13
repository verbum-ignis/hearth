// Hearth 行为契约测试
//
// 每一条断言对应核心行为约定。
// 存在的理由：2026-07-28 发现「文档说 stream 14 天沉底，代码给了 120 天」，
// 而这个偏差没有任何东西能发现——文档说有、代码没有、中间没人验。
// 从此设计意图必须可执行：改完跑一遍，红了说明代码和设计已经分家。
//
// 跑：node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hearth-contract-'));
process.env.HEARTH_DB_PATH = join(dir, 'test.db');

const { db, now } = await import('../src/db.js');
const { starBand, TOUCHABLE_FILTER, activeDirectoryRows } = await import('../src/lib/decay.js');

// 造一条条目，last_accessed 定在 N 天前
function seed({ id, type, days, anchor = 0, sealed = 0, status = 'active', keys = ['probe'] }) {
  const t = now();
  db.prepare(`
    INSERT INTO hearth_entries
      (id, type, keys, hook, body, sealed, anchor, last_accessed, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-' || ? || ' days'), ?, ?, ?)
  `).run(id, type, JSON.stringify(keys), `hook ${id}`, `body ${id}`, sealed, anchor, days, status, t, t);
}

function touchableIds() {
  return db.prepare(`SELECT id FROM hearth_entries WHERE ${TOUCHABLE_FILTER}`)
    .all().map((r) => r.id);
}

function bandOf(id) {
  return starBand(db.prepare('SELECT * FROM hearth_entries WHERE id = ?').get(id));
}

before(() => {
  db.exec('DELETE FROM hearth_entries');
  // stream：设计说 7 天活跃 / 14 天沉底
  seed({ id: 's_fresh', type: 'stream', days: 2 });
  seed({ id: 's_half', type: 'stream', days: 10 });
  seed({ id: 's_deep', type: 'stream', days: 20 });
  // event：设计说 60 天活跃 / 120 天沉底
  seed({ id: 'e_fresh', type: 'event', days: 20 });
  seed({ id: 'e_half', type: 'event', days: 80 });
  seed({ id: 'e_deep', type: 'event', days: 200 });
  // anchor=3 豁免一切衰退
  seed({ id: 'e_anchor', type: 'event', days: 500, anchor: 3 });
  seed({ id: 's_anchor', type: 'stream', days: 500, anchor: 3 });
  // sealed 零泄漏
  seed({ id: 'x_sealed', type: 'letter', days: 1, sealed: 1 });
  // rule 常驻，不进目录不进触发
  seed({ id: 'r_rule', type: 'rule', days: 1 });
  // letter 不进目录，但可被 keys 触发
  seed({ id: 'l_letter', type: 'letter', days: 5 });
  // 生命周期已终止的不该被触发
  seed({ id: 'e_retired', type: 'event', days: 3, status: 'retired' });
  seed({ id: 'e_superseded', type: 'event', days: 3, status: 'superseded' });
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('stream 衰退窗口比 event 短：10 天的日记已半沉，20 天的已沉底', () => {
  assert.equal(bandOf('s_fresh'), 'active');
  assert.equal(bandOf('s_half'), 'half_sunk');
  assert.equal(bandOf('s_deep'), 'deep');
});

test('event 用 60/120 天：20 天仍活跃，80 天半沉，200 天沉底', () => {
  assert.equal(bandOf('e_fresh'), 'active');
  assert.equal(bandOf('e_half'), 'half_sunk');
  assert.equal(bandOf('e_deep'), 'deep');
});

// 这条就是 07-28 那个 bug：starBand 说 deep，TOUCHABLE_FILTER 却还让它触发
test('沉底即 keys 失效——星空口径与触发口径必须是同一条线', () => {
  const ids = touchableIds();
  for (const id of ['s_deep', 'e_deep']) {
    assert.equal(bandOf(id), 'deep');
    assert.ok(!ids.includes(id), `${id} 已沉底(deep)却仍能被 keys 触发——两套口径分家了`);
  }
  // 半沉仍可触发，别误伤
  assert.ok(touchableIds().includes('s_half'), 's_half 半沉，应当仍可触发');
  assert.ok(touchableIds().includes('e_half'), 'e_half 半沉，应当仍可触发');
});

test('anchor=3 豁免一切衰退：500 天没碰仍是 anchor，仍可触发，仍在目录', () => {
  assert.equal(bandOf('e_anchor'), 'anchor');
  assert.equal(bandOf('s_anchor'), 'anchor');
  const ids = touchableIds();
  assert.ok(ids.includes('e_anchor'));
  assert.ok(ids.includes('s_anchor'));
  assert.ok(activeDirectoryRows().some((r) => r.id === 'e_anchor'));
});

test('sealed 零泄漏：不进目录、不进 keys 触发范围', () => {
  assert.ok(!touchableIds().includes('x_sealed'), 'sealed 条目泄漏到了 keys 触发');
  assert.ok(!activeDirectoryRows().some((r) => r.id === 'x_sealed'), 'sealed 条目泄漏到了目录');
});

test('rule 常驻：不进目录，也不参与 keys 触发（load 里全文随身份卡返回）', () => {
  assert.ok(!activeDirectoryRows().some((r) => r.id === 'r_rule'));
  assert.ok(!touchableIds().includes('r_rule'));
});

test('letter 不进目录，但可被 keys 触发', () => {
  assert.ok(!activeDirectoryRows().some((r) => r.id === 'l_letter'), 'letter 不该进目录');
  assert.ok(touchableIds().includes('l_letter'), 'letter 应当能被话题触发');
});

test('retired / superseded 不可被触发，也不进目录', () => {
  const ids = touchableIds();
  for (const id of ['e_retired', 'e_superseded']) {
    assert.ok(!ids.includes(id), `${id} 生命周期已终止却仍能被触发`);
    assert.ok(!activeDirectoryRows().some((r) => r.id === id));
  }
});

test('目录只装 event/project', () => {
  const types = new Set(activeDirectoryRows().map((r) => r.type));
  for (const t of types) assert.ok(['event', 'project'].includes(t), `目录里混进了 ${t}`);
});
