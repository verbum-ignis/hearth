// ④ MCP 侧：lit 亮度标记 + /search 转发行为
//
// 对应 Lumen ④一审三项阻塞的测试补丁：
//   1) hearth_search 注册与 /search 转发（转发层 smoke）
//   2) search/touch 返回 origin（origin 测试在 server 侧 search-touch.test.js）
//   3) search 取回全文后 markLit（litIdsFor 提取 + markLit 落盘）
// 本文件覆盖 1（转发路径）与 3（lit 行为），origin 返回测试在 hearth-server 侧。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { litIdsFor, markLit, markWriteEvent } from '../src/lit.mjs';

async function withTempDir(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hearth-lit-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('litIdsFor：/search 与 /touch 响应提取 entries.ids，其他路径返回空', () => {
  const body = JSON.stringify({ entries: [{ id: 'a' }, { id: 'b' }], overflow: [] });
  assert.deepEqual(litIdsFor('/search', body), ['a', 'b']);
  assert.deepEqual(litIdsFor('/touch', body), ['a', 'b']);
  assert.deepEqual(litIdsFor('/load', body), [], 'load 走缓存路径，不走 entries 提取');
  assert.deepEqual(litIdsFor('/write', body), []);
  assert.deepEqual(litIdsFor('/search', '不是 json'), [], '非 JSON 响应不抛错');
  assert.deepEqual(litIdsFor('/search', JSON.stringify({ entries: [{ id: '' }, { id: null }, { id: 'c' }] })), ['c'], '过滤空 id');
});

test('markLit：search 返回的 ids 落盘为 lit_at_turn=max', async () => {
  await withTempDir(async (root) => {
    const statePath = path.join(root, 'lit-state.json');
    await markLit(statePath, ['e1', 'e2']);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(state.entries.e1, { lit_at_turn: 'max' });
    assert.deepEqual(state.entries.e2, { lit_at_turn: 'max' });
  });
});

test('markLit：追加不覆盖已有标记', async () => {
  await withTempDir(async (root) => {
    const statePath = path.join(root, 'lit-state.json');
    await markLit(statePath, ['e1']);
    await markLit(statePath, ['e2']);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.ok(state.entries.e1, '旧标记保留');
    assert.ok(state.entries.e2, '新标记追加');
  });
});

test('markLit：空 ids 不写文件', async () => {
  await withTempDir(async (root) => {
    const statePath = path.join(root, 'lit-state.json');
    await markLit(statePath, []);
    let exists = true;
    try { await readFile(statePath, 'utf8'); } catch { exists = false; }
    assert.equal(exists, false, '空 ids 不落盘');
  });
});

test('markWriteEvent：写事件清掉 review nudge 并置 last_write_turn', async () => {
  await withTempDir(async (root) => {
    const statePath = path.join(root, 'lit-state.json');
    await markLit(statePath, ['e1']);
    // 先制造一个 review nudge 状态
    const before = JSON.parse(await readFile(statePath, 'utf8'));
    before.last_review_nudge_turn = 'max';
    await (await import('node:fs/promises')).writeFile(statePath, JSON.stringify(before), 'utf8');

    await markWriteEvent(statePath);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.last_write_turn, 'max');
    assert.equal(state.last_review_nudge_turn, undefined, '写事件清掉 review nudge');
    assert.equal(state.last_write_nudge_turn, undefined);
    assert.ok(state.entries.e1, '条目亮度标记不受写事件影响');
  });
});
