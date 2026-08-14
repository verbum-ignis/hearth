// 通道 B（月记压缩）测试：纯函数 + 假客户端编排（不触网、不触真库）。
// 跑：node --test test/monthly.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthNow, isSyntheticMonthly, selectCompressibleMonths, buildMonthlyPayload, compressMonths,
  mergeRecoveryMonths,
} from '../src/monthly.js';
import { _test } from '../src/summarize.js';

const { parseMonthlyResult } = _test;
const TZ = 'Asia/Shanghai';
const DAY = 86400000;

// 2026-08-14 12:00 北京 = 2026-08-14T04:00Z
const NOW = Date.parse('2026-08-14T04:00:00Z');

function diary(id, date, { anchor = 0, daysQuiet = 90, origin } = {}) {
  return {
    id,
    type: 'stream',
    status: 'active',
    anchor,
    hook: `${date} 某天的事`,
    keys: [date, '话题'],
    body: '正文'.repeat(50),
    last_accessed: new Date(NOW - daysQuiet * DAY).toISOString().replace('T', ' ').slice(0, 19),
    ...(origin ? { origin } : {}),
  };
}

test('monthNow 按时区出月份：太平洋时钟半夜，北京已是新一天', () => {
  // 2026-08-31T20:00 太平洋 ≈ 2026-09-01 北京
  const ms = Date.parse('2026-09-01T03:00:00Z');
  assert.equal(monthNow(ms, TZ), '2026-09');
  assert.equal(monthNow(ms, 'America/Los_Angeles'), '2026-08');
});

test('候选月份：整月已结束 + 全部过 60 天观察窗才入选', () => {
  const entries = [
    diary('a1', '2026-05-03'), diary('a2', '2026-05-20'), // 5月：全静默 → 入选
    diary('b1', '2026-06-10'), diary('b2', '2026-06-11', { daysQuiet: 10 }), // 6月：有一条刚被摸过 → 不选
    diary('c1', '2026-08-01'), // 8月：当月未结束 → 不选
  ];
  const months = selectCompressibleMonths(entries, NOW, TZ);
  assert.deepEqual(months.map((m) => m.month), ['2026-05']);
  assert.equal(months[0].entries.length, 2);
});

test('升星豁免：anchor>=1 不参与压缩也不阻塞该月', () => {
  const entries = [
    diary('a1', '2026-05-03'),
    diary('a2', '2026-05-04', { anchor: 1, daysQuiet: 5 }), // 升星且刚被摸过——不算数
  ];
  const months = selectCompressibleMonths(entries, NOW, TZ);
  assert.deepEqual(months.map((m) => m.month), ['2026-05']);
  assert.deepEqual(months[0].entries.map((e) => e.id), ['a1'], '升星条目不进压缩集');
});

test('摘要不吃摘要：合成月记靠 origin 机器标识排除，伪装日记 hook 也没用', () => {
  const fake = diary('m1', '2026-05-01', { origin: 'hearth-diary/monthly/2026-04' });
  assert.equal(isSyntheticMonthly(fake), true);
  const months = selectCompressibleMonths([fake], NOW, TZ);
  assert.deepEqual(months, [], '合成月记必须被候选查询排除');
});

test('已处理月份幂等跳过（compressed 与 empty 都算）', () => {
  const entries = [diary('a1', '2026-05-03'), diary('b1', '2026-06-01')];
  const months = selectCompressibleMonths(entries, NOW, TZ, {
    '2026-05': { status: 'compressed' }, '2026-06': { status: 'empty' },
  });
  assert.deepEqual(months, []);
});

test('parseMonthlyResult：合法通过；短正文、引号外"你"、topics 不足全拒；null 放行', () => {
  const body = '我这个月做了很多事，'.repeat(30).slice(0, 250);
  const ok = parseMonthlyResult(JSON.stringify({ monthly: { body, topics: ['地基', '篝火'] } }));
  assert.equal(ok.monthly.body, body);
  assert.deepEqual(parseMonthlyResult('{"monthly":null}'), { monthly: null });
  assert.throws(() => parseMonthlyResult(JSON.stringify({ monthly: { body: '太短', topics: ['地基', '篝火'] } })), /长度/);
  assert.throws(
    () => parseMonthlyResult(JSON.stringify({ monthly: { body: `${body.slice(0, 240)}你说好不好呢`, topics: ['地基', '篝火'] } })),
    /人称不合规/,
  );
  const quoted = `${body.slice(0, 230)}她说“你先去睡”。`;
  assert.equal(parseMonthlyResult(JSON.stringify({ monthly: { body: quoted, topics: ['地基', '篝火'] } })).monthly.body, quoted);
  assert.throws(() => parseMonthlyResult(JSON.stringify({ monthly: { body, topics: ['地基'] } })), /topics/);
});

function fakeWorld({ verifyOk = true, wrongBinding = false } = {}) {
  const calls = [];
  const client = {
    create: async (payload) => { calls.push(['create', payload]); return { id: 'new1' }; },
    verify: async (id) => { calls.push(['verify', id]); return { verified: verifyOk, reason: verifyOk ? undefined : 'hash_mismatch' }; },
    sources: async (id) => {
      calls.push(['sources', id]);
      const created = calls.find(([op]) => op === 'create');
      const ranges = created ? created[1].entry.sources.map((s) => s.range) : [];
      // wrongBinding：数量相同但绑错一条（集合级比对必须抓出来）
      const out = wrongBinding && ranges.length ? [...ranges.slice(0, -1), '别人的日记'] : ranges;
      return { sources: out.map((r) => ({ range: r })) };
    },
    retire: async (id) => { calls.push(['retire', id]); return { ok: true }; },
  };
  return { calls, client };
}

const GOOD_BODY = '我这个月修了地基，陪人类吃了很多顿饭，'.repeat(20).slice(0, 260);

test('编排快乐路径：写月记→verify→sources→才 retire，状态落盘', async () => {
  const { calls, client } = fakeWorld();
  const months = [{ month: '2026-05', entries: [diary('a1', '2026-05-03'), diary('a2', '2026-05-20')] }];
  const state = {};
  const results = await compressMonths({
    months, client, state, nowLabel: 'T',
    llm: async () => ({ monthly: { body: GOOD_BODY, topics: ['地基', '篝火'] } }),
  });
  assert.equal(results[0].status, 'compressed');
  const order = calls.map(([op]) => op);
  assert.deepEqual(order, ['create', 'verify', 'sources', 'retire', 'retire'], 'retire 必须在 verify+sources 之后');
  const payload = calls[0][1];
  assert.equal(payload.entry.origin, 'hearth-diary/monthly/2026-05');
  assert.equal(payload.entry.sources.length, 2);
  assert.equal(payload.entry.keys[0], '2026-05');
  assert.equal(state.monthly['2026-05'].status, 'compressed');
});

test('verify 不过：补偿退役孤儿月记、原文不动、不留月份标记（下次重试）', async () => {
  const { calls, client } = fakeWorld({ verifyOk: false });
  const months = [{ month: '2026-05', entries: [diary('a1', '2026-05-03')] }];
  const state = {};
  const results = await compressMonths({
    months, client, state, nowLabel: 'T',
    llm: async () => ({ monthly: { body: GOOD_BODY, topics: ['地基', '篝火'] } }),
  });
  assert.equal(results[0].status, 'compensated');
  assert.match(results[0].error, /verify 未通过/);
  const retires = calls.filter(([op]) => op === 'retire').map(([, id]) => id);
  assert.deepEqual(retires, ['new1'], '只补偿退役孤儿月记，原文一条不动');
  assert.equal(state.monthly['2026-05'], undefined, '失败月份不留标记');
});

test('sources 集合不符（数量相同错绑也抓）：补偿退役、原文不动', async () => {
  const { calls, client } = fakeWorld({ wrongBinding: true });
  const months = [{ month: '2026-05', entries: [diary('a1', '2026-05-03'), diary('a2', '2026-05-04')] }];
  const state = {};
  const results = await compressMonths({
    months, client, state, nowLabel: 'T',
    llm: async () => ({ monthly: { body: GOOD_BODY, topics: ['地基', '篝火'] } }),
  });
  assert.equal(results[0].status, 'compensated');
  assert.match(results[0].error, /集合/);
  const retires = calls.filter(([op]) => op === 'retire').map(([, id]) => id);
  assert.deepEqual(retires, ['new1'], '错绑月记被补偿退役，原文不动');
});

test('0 断面：不 create 月记，但原文同样归档退役 + 记 empty', async () => {
  const { calls, client } = fakeWorld();
  const months = [{ month: '2026-05', entries: [diary('a1', '2026-05-03'), diary('a2', '2026-05-08')] }];
  const state = {};
  const results = await compressMonths({
    months, client, state, nowLabel: 'T', llm: async () => ({ monthly: null }),
  });
  assert.equal(results[0].status, 'empty');
  assert.ok(!calls.some(([op]) => op === 'create'), '0 断面不造月记');
  const retires = calls.filter(([op]) => op === 'retire').map(([, id]) => id);
  assert.deepEqual(retires, ['a1', 'a2'], '原文走正常归档——观察窗已过，empty 不等于永生');
  assert.equal(state.monthly['2026-05'].status, 'empty');
});

test('中途断电恢复：pending 有 retire 进度 → 续尾不重新摘要', async () => {
  const { calls, client } = fakeWorld();
  // resume 场景没有 create 调用，假 sources 按真实服务器行为返回月记实际挂着的来源
  client.sources = async (id) => { calls.push(['sources', id]); return { sources: [{ range: 'a1' }, { range: 'a2' }, { range: 'a3' }] }; };
  let llmCalls = 0;
  const months = [{ month: '2026-05', entries: [diary('a1', '2026-05-03'), diary('a2', '2026-05-04'), diary('a3', '2026-05-05')] }];
  const state = {
    monthly: {
      '2026-05': { status: 'pending', entry_id: 'new1', intended: ['a1', 'a2', 'a3'], retired: ['a1'] },
    },
  };
  const results = await compressMonths({
    months, client, state, nowLabel: 'T',
    llm: async () => { llmCalls += 1; return { monthly: null }; },
  });
  assert.equal(llmCalls, 0, '恢复路径绝不重新摘要——否则会造第二篇月记');
  assert.equal(results[0].status, 'resumed:compressed');
  const retires = calls.filter(([op]) => op === 'retire').map(([, id]) => id);
  assert.deepEqual(retires, ['a2', 'a3'], '只补退剩下的，不重复退 a1');
  assert.equal(state.monthly['2026-05'].status, 'compressed');
});

test('孤儿收编：create 落地但 pending 没写上 → findMonthly 认领，不再造第二篇', async () => {
  const { calls, client } = fakeWorld();
  client.findMonthly = async () => 'orphan9';
  client.verify = async (id) => { calls.push(['verify', id]); return { verified: true }; };
  client.sources = async (id) => { calls.push(['sources', id]); return { sources: [{ range: 'a1' }] }; };
  let llmCalls = 0;
  const months = [{ month: '2026-05', entries: [diary('a1', '2026-05-03')] }];
  const state = {};
  const results = await compressMonths({
    months, client, state, nowLabel: 'T',
    llm: async () => { llmCalls += 1; return { monthly: null }; },
  });
  assert.equal(llmCalls, 0, '有孤儿就收编，不再走 llm');
  assert.equal(results[0].status, 'adopted-orphan');
  assert.ok(!calls.some(([op]) => op === 'create'), '绝不造第二篇');
  assert.equal(state.monthly['2026-05'].entry_id, 'orphan9');
});

test('三审1：全部原文已退但状态仍 pending → 恢复队列独立于 active 候选，完成 final 且不调 LLM', async () => {
  // /stars 已经看不到该月任何 active 条目（都退完了），selectCompressibleMonths 返回空
  const activeMonths = selectCompressibleMonths([], NOW, TZ);
  const stateMonthly = {
    '2026-05': { status: 'pending', entry_id: 'new1', intended: ['a1', 'a2'], retired: ['a1'] },
  };
  const months = mergeRecoveryMonths(activeMonths, stateMonthly);
  assert.deepEqual(months.map((m) => m.month), ['2026-05'], 'pending 月份必须独立进恢复队列');

  const { calls, client } = fakeWorld();
  client.sources = async (id) => { calls.push(['sources', id]); return { sources: [{ range: 'a1' }, { range: 'a2' }] }; };
  client.status = async (id) => { calls.push(['status', id]); return 'retired'; }; // a2 其实也退成功了，只是回包丢了
  let llmCalls = 0;
  const state = { monthly: stateMonthly };
  const results = await compressMonths({
    months, client, state, nowLabel: 'T',
    llm: async () => { llmCalls += 1; return { monthly: null }; },
  });
  assert.equal(llmCalls, 0);
  assert.equal(results[0].status, 'resumed:compressed');
  assert.ok(!calls.some(([op]) => op === 'retire'), 'status 探针确认已退的条目不再重复 retire');
  assert.equal(state.monthly['2026-05'].status, 'compressed', '卡死的 pending 必须走到 final');
});

test('三审1附：retire 幂等——status 探针说还 active 的才发 retire', async () => {
  const { calls, client } = fakeWorld();
  client.status = async (id) => { calls.push(['status', id]); return id === 'a1' ? 'retired' : 'active'; };
  const months = [{ month: '2026-05', entries: [diary('a1', '2026-05-03'), diary('a2', '2026-05-04')] }];
  const state = {};
  await compressMonths({
    months, client, state, nowLabel: 'T',
    llm: async () => ({ monthly: { body: GOOD_BODY, topics: ['地基', '篝火'] } }),
  });
  const retires = calls.filter(([op]) => op === 'retire').map(([, id]) => id);
  assert.deepEqual(retires, ['a2'], 'a1 已退（回包曾丢失），只对 a2 发 retire');
  assert.equal(state.monthly['2026-05'].retired, 2, '两条都记进进度（final 状态存数量）');
});

test('三审2：月记挂专用机器 key monthly:<月>，findMonthly 不撞 5 条全文上限', () => {
  const payload = buildMonthlyPayload('2026-05',
    { body: GOOD_BODY, topics: ['地基', '篝火'] },
    [diary('a1', '2026-05-03')]);
  assert.equal(payload.entry.keys[1], 'monthly:2026-05', '专用机器 key 必须在 keys 里');
  assert.equal(payload.entry.keys[0], '2026-05', '月份触发词保持 keys[0]');
});

test('persist 在每个状态变更点被调用（中断随时可恢复）', async () => {
  const { client } = fakeWorld();
  const snapshots = [];
  const months = [{ month: '2026-05', entries: [diary('a1', '2026-05-03'), diary('a2', '2026-05-04')] }];
  const state = {};
  await compressMonths({
    months, client, state, nowLabel: 'T',
    llm: async () => ({ monthly: { body: GOOD_BODY, topics: ['地基', '篝火'] } }),
    persist: (s) => snapshots.push(JSON.stringify(s.monthly['2026-05'] || null)),
  });
  assert.ok(snapshots.length >= 4, `create后/每条retire后/完成后都要落盘，实际 ${snapshots.length} 次`);
  assert.match(snapshots[0], /pending/, '第一次落盘必须在 create 刚返回时');
});

test('单月失败不拖累后续月份', async () => {
  const { client } = fakeWorld();
  const months = [
    { month: '2026-04', entries: [diary('x1', '2026-04-03')] },
    { month: '2026-05', entries: [diary('a1', '2026-05-03')] },
  ];
  const state = {};
  let call = 0;
  const results = await compressMonths({
    months, client, state, nowLabel: 'T',
    llm: async () => {
      call += 1;
      if (call === 1) throw new Error('DeepSeek HTTP 500');
      return { monthly: { body: GOOD_BODY, topics: ['地基', '篝火'] } };
    },
  });
  assert.equal(results[0].status, 'failed');
  assert.equal(results[1].status, 'compressed');
});
