// hearth-diary: state 行为契约测试
//
// 覆盖状态文件的读写（原子写、缺省态、损坏抛错）与补写日期范围计算。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readState, writeState, dateRange } from '../src/state.js';

test('readState：文件不存在回默认态，损坏则抛错', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h8-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readState(path.join(root, 'nope.json')), { last_successful_date: null, diaries: {} });
  const bad = path.join(root, 'bad.json');
  fs.writeFileSync(bad, '{oops', 'utf8');
  assert.throws(() => readState(bad));
});

test('writeState 原子写：内容正确、父目录自动创建、不留 .tmp', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h8-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, 'sub', 'state.json');
  writeState(statePath, {
    last_successful_date: '2026-07-29',
    diaries: { '2026-07-29': { ids: ['a'], status: 'written', event_count: 2 } },
  });
  assert.deepEqual(readState(statePath), {
    last_successful_date: '2026-07-29',
    diaries: { '2026-07-29': { ids: ['a'], status: 'written', event_count: 2 } },
  });
  assert.ok(!fs.existsSync(`${statePath}.tmp`));
});

test('dateRange：从上次成功日期的次日补到目标日，含目标日', () => {
  assert.deepEqual(dateRange(null, '2026-07-29'), ['2026-07-29']);
  assert.deepEqual(dateRange('2026-07-27', '2026-07-29'), ['2026-07-28', '2026-07-29']);
  assert.deepEqual(dateRange('2026-07-29', '2026-07-29'), []);
  assert.deepEqual(dateRange('2026-07-30', '2026-07-29'), []);
});
