// hearth-diary: hearth（Hearth API 客户端）行为契约测试
//
// 覆盖与 server 交互的纯逻辑：keys 解析、日记日期识别、写入载荷构造、
// 过期判定；listDiaryEntries / findExistingDiary 用 fetch 桩验证按日过滤。

import assert from 'node:assert/strict';
import test from 'node:test';
import { listDiaryEntries, findExistingDiary, _test } from '../src/hearth.js';

const { parsedKeys, diaryDate, createPayload, expiredDiaryEntries } = _test;

test('parsedKeys：数组直通、JSON 字符串解析、非法回退空数组', () => {
  assert.deepEqual(parsedKeys({ keys: ['a'] }), ['a']);
  assert.deepEqual(parsedKeys({ keys: '["a","b"]' }), ['a', 'b']);
  assert.deepEqual(parsedKeys({ keys: 'not-json' }), []);
  assert.deepEqual(parsedKeys({ keys: null }), []);
  assert.deepEqual(parsedKeys({}), []);
});

test('diaryDate：hook 日期与 keys 首项一致才算日记条目', () => {
  assert.equal(
    diaryDate({ hook: '2026-07-29 她指出了问题', keys: ['2026-07-29', '关系'] }),
    '2026-07-29',
  );
  assert.equal(diaryDate({ hook: '没有日期的标题', keys: ['2026-07-29'] }), null);
  assert.equal(diaryDate({ hook: '2026-07-29 日期对不上', keys: ['2026-07-28'] }), null);
  assert.equal(diaryDate({ hook: '2026-07-29 x', keys: [] }), null);
});

test('createPayload：stream 条目，hook 带日期，keys 为日期+前三个话题', () => {
  const payload = createPayload('2026-07-29', {
    title: '她指出了问题',
    body: '正文',
    topics: ['关系', '自我认知', '深夜', '多余'],
  });
  assert.equal(payload.op, 'create');
  assert.equal(payload.entry.type, 'stream');
  assert.equal(payload.entry.hook, '2026-07-29 她指出了问题');
  assert.deepEqual(payload.entry.keys, ['2026-07-29', '关系', '自我认知', '深夜']);
  assert.equal(payload.entry.body, '正文');
});

test('expiredDiaryEntries：60 天未碰、anchor=0 的日记过期；其余情形保留', () => {
  const nowMs = Date.parse('2026-07-29T00:00:00Z');
  const past = (days) => new Date(nowMs - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const mk = (overrides) => ({
    type: 'stream',
    status: 'active',
    anchor: 0,
    keys: ['2026-01-01'],
    hook: '2026-01-01 旧日记',
    last_accessed: past(70),
    ...overrides,
  });
  const expired = expiredDiaryEntries([
    mk({}),                                // 70 天未碰 → 过期
    mk({ anchor: 2 }),                     // 已锚定 → 保留
    mk({ status: 'retired' }),             // 已退场 → 保留
    mk({ type: 'event' }),                 // 非日记 → 保留
    mk({ last_accessed: past(10) }),       // 近期 → 保留
    mk({ hook: '无日期标题', keys: [] }),  // 不是日记格式 → 保留
  ], nowMs);
  assert.deepEqual(expired.map((e) => e.hook), ['2026-01-01 旧日记']);
});

test('listDiaryEntries 只返回匹配日期的活跃 stream 日记；findExistingDiary 取第一条', async () => {
  const originalFetch = globalThis.fetch;
  const stars = [
    { id: 'a', type: 'stream', status: 'active', hook: '2026-07-29 事件A', keys: ['2026-07-29'] },
    { id: 'b', type: 'stream', status: 'active', hook: '2026-07-28 事件B', keys: ['2026-07-28'] },
    { id: 'c', type: 'stream', status: 'retired', hook: '2026-07-29 旧版', keys: ['2026-07-29'] },
    { id: 'd', type: 'event', status: 'active', hook: '2026-07-29 非日记', keys: ['2026-07-29'] },
    { id: 'e', type: 'stream', status: 'active', hook: '2026-07-29 日期不符', keys: ['2026-07-28'] },
  ];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ stars }),
  });
  const config = { apiUrl: 'http://127.0.0.1:3002', hearthToken: 'test-token' };
  try {
    const hits = await listDiaryEntries(config, '2026-07-29');
    assert.deepEqual(hits.map((e) => e.id), ['a']);
    const found = await findExistingDiary(config, '2026-07-29');
    assert.equal(found.id, 'a');
    assert.equal(await findExistingDiary(config, '2026-07-30'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
