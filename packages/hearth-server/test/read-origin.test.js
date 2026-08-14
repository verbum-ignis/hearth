// ④二审补测：origin 必须随读取端返回（Lumen ④一审阻塞2）。
// ③测试清单已定：load/touch/search 三个读取端都不许丢 origin；NULL 显式呈现为 unknown。
// 跑：node --test test/read-origin.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir;
let handleWrite;
let handleSearch;
let handleTouch;
let db;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hearth-origin-'));
  process.env.HEARTH_DB_PATH = join(dir, 'test.db');
  ({ handleWrite } = await import('../src/routes/write.js'));
  ({ handleSearch } = await import('../src/routes/search.js'));
  ({ handleTouch } = await import('../src/routes/touch.js'));
  ({ db } = await import('../src/db.js'));
});

after(() => {
  db.close(); // Windows：先关连接再删临时库，否则 WAL 还开着 → rmSync EPERM
  rmSync(dir, { recursive: true, force: true });
});

test('search：带 origin 的条目原样返回，无 origin 的显式 unknown', () => {
  const withOrigin = handleWrite({
    op: 'create',
    entry: { type: 'event', keys: ['origin探针甲'], hook: '有来源', body: '正文', origin: '篝火群聊 msg_xxx' },
  });
  const without = handleWrite({
    op: 'create',
    entry: { type: 'event', keys: ['origin探针乙'], hook: '无来源', body: '正文' },
  });

  const a = handleSearch({ id: withOrigin.body.id });
  assert.equal(a.entries[0].origin, '篝火群聊 msg_xxx', 'search 必须原样返回 origin');

  const b = handleSearch({ id: without.body.id });
  assert.equal(b.entries[0].origin, 'unknown', 'NULL origin 必须显式呈现为 unknown，不许省略字段');
});

test('search keys 命中路径同样带 origin', () => {
  const hits = handleSearch({ keys: ['origin探针甲'] });
  assert.ok(hits.entries.length >= 1);
  for (const e of hits.entries) {
    assert.ok(typeof e.origin === 'string' && e.origin.length > 0, 'keys 路径的每个条目都必须带 origin');
  }
});

test('touch：读取端同样返回 origin（顺手核对项）', () => {
  const res = handleWrite({
    op: 'create',
    entry: { type: 'event', keys: ['origin探针丙'], hook: 'touch来源', body: '正文', origin: '手动记录' },
  });
  const touched = handleTouch({ id: res.body.id });
  assert.equal(touched.entries[0].origin, '手动记录', 'touch 返回必须带 origin');
});
