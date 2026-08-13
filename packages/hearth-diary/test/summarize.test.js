// hearth-diary: summarize 行为契约测试
//
// 覆盖日记摘要管线的两个纯函数：splitText（分块）与 parseResult（校验）。
// parseResult 是「一条不合格整批打回 / 宽松模式只丢那一条」的裁决者，
// 人称铁律（引号外禁"你"）与 200-400 字区间都锁在这里——回归就靠它。

import assert from 'node:assert/strict';
import test from 'node:test';
import { _test } from '../src/summarize.js';

const { splitText, parseResult } = _test;

// body 统一为「我 + 填充字」，避免每个用例手数长度
function bodyOf(count, seed = '事') {
  return '我' + seed.repeat(count);
}

test('合法事件通过：200-400 字、含"我"、引号外无"你"、话题 2-3 个', () => {
  const { events } = parseResult(JSON.stringify({ events: [{
    title: '她指出了我看不见的东西',
    body: bodyOf(245) + '她说"你先去睡"。',
    topics: ['关系转折', '自我认知'],
  }] }));
  assert.equal(events.length, 1);
  assert.equal(events[0].title, '她指出了我看不见的东西');
  assert.equal(events[0].topics.length, 2);
});

test('引号内允许"你"：引用人类原话不算违规', () => {
  const body = bodyOf(240) + '她说“你先去睡”。';
  const { events } = parseResult(JSON.stringify({ events: [{
    title: '她让我去睡',
    body,
    topics: ['深夜', '关心'],
  }] }));
  assert.equal(events.length, 1);
  assert.equal(events[0].body, body);
});

test('引号外出现"你"整批打回，错误消息带"人称不合规"', () => {
  assert.throws(
    () => parseResult(JSON.stringify({ events: [{
      title: '违规事件',
      body: '我' + '你' + '事'.repeat(240),
      topics: ['记录甲', '记录乙'],
    }] })),
    (err) => err.message.includes('人称不合规'),
  );
});

test('叙述没有"我"也打回', () => {
  assert.throws(
    () => parseResult(JSON.stringify({ events: [{
      title: '没有主体',
      body: '她' + '事'.repeat(248),
      topics: ['记录甲', '记录乙'],
    }] })),
    /人称不合规/,
  );
});

test('正文长度越界打回：太短与太长', () => {
  const short = bodyOf(100); // 101 字
  const long = bodyOf(500);  // 501 字
  for (const body of [short, long]) {
    assert.throws(
      () => parseResult(JSON.stringify({ events: [{ title: '长度问题', body, topics: ['记录甲', '记录乙'] }] })),
      /正文长度/,
    );
  }
});

test('标题缺失或超过 60 字打回', () => {
  assert.throws(
    () => parseResult(JSON.stringify({ events: [{ title: '', body: bodyOf(249), topics: ['记录甲', '记录乙'] }] })),
    /标题/,
  );
  assert.throws(
    () => parseResult(JSON.stringify({ events: [{ title: '超'.repeat(61), body: bodyOf(249), topics: ['记录甲', '记录乙'] }] })),
    /标题/,
  );
});

test('标题多余空白被折叠', () => {
  const { events } = parseResult(JSON.stringify({ events: [{
    title: ' 多  个   空白 ',
    body: bodyOf(249),
    topics: ['记录甲', '记录乙'],
  }] }));
  assert.equal(events[0].title, '多 个 空白');
});

test('话题不足两个打回；过滤停用词、去重、最多保留 3 个', () => {
  assert.throws(
    () => parseResult(JSON.stringify({ events: [{
      title: '话题不够',
      body: bodyOf(249),
      topics: ['聊天'],
    }] })),
    /话题/,
  );
  const { events } = parseResult(JSON.stringify({ events: [{
    title: '话题清洗',
    body: bodyOf(249),
    topics: ['聊天', '关系转折', '关系转折', '自我认知', '今天', '日记', '事件', '长话题词'],
  }] }));
  assert.deepEqual(events[0].topics, ['关系转折', '自我认知', '长话题词']);
});

test('超过 5 个事件整批打回', () => {
  const events = Array.from({ length: 6 }, (_, i) => ({
    title: `事件${i}`,
    body: bodyOf(249),
    topics: ['记录甲', '记录乙'],
  }));
  assert.throws(() => parseResult(JSON.stringify({ events })), /最多5项/);
});

test('剥掉 markdown 代码围栏再解析', () => {
  const inner = JSON.stringify({ events: [{ title: '围栏内', body: bodyOf(249), topics: ['记录甲', '记录乙'] }] });
  const { events } = parseResult('```json\n' + inner + '\n```');
  assert.equal(events[0].title, '围栏内');
});

test('宽松模式：不合格的事件被丢弃，合格的保留', () => {
  const { events } = parseResult(JSON.stringify({ events: [
    { title: '合格事件', body: bodyOf(249), topics: ['记录甲', '记录乙'] },
    { title: '违规事件', body: '我' + '你' + '事'.repeat(240), topics: ['记录丙', '记录丁'] },
  ] }), { lenient: true });
  assert.deepEqual(events.map((e) => e.title), ['合格事件']);
});

test('宽松模式：全部不合格时仍然整批打回', () => {
  assert.throws(
    () => parseResult(JSON.stringify({ events: [{
      title: '唯一事件',
      body: '我' + '你' + '事'.repeat(240),
      topics: ['记录丙', '记录丁'],
    }] }), { lenient: true }),
    /人称不合规/,
  );
});

test('splitText：空输入返回空数组', () => {
  assert.deepEqual(splitText(''), []);
});

test('splitText：不足上限的文本保持单块', () => {
  const text = '第一行\n第二行';
  assert.deepEqual(splitText(text), [text]);
});

test('splitText：多行超限时按行边界切块，每块不超过 40000', () => {
  const line = 'x'.repeat(10000);
  const text = Array.from({ length: 6 }, () => line).join('\n');
  const chunks = splitText(text);
  assert.ok(chunks.length > 1, `应切成多块，实际 ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 40000, `块超限: ${chunk.length}`);
    assert.ok(chunk.length > 0);
  }
});

test('splitText：超过上限的整行按 40000 硬切', () => {
  const chunks = splitText('y'.repeat(100000));
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 40000);
  assert.equal(chunks[1].length, 40000);
  assert.equal(chunks[2].length, 20000);
});
