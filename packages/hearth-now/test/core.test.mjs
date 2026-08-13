import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendSegment,
  clipCompleteSentence,
  defaultPolicy,
  defaultReminderState,
  decideNowReminder,
  externalExportAllowed,
  extractCodexCompleteTurns,
  extractCompleteTurns,
  findSegmentBySource,
  formatNowReminder,
  latestSegmentDate,
  listAllSegments,
  pruneOldBuckets,
  renderNowView,
  releaseLock,
  selectVisibleSegments,
  setExternalExportPolicy,
  splitBatches,
  splitPromptBatches,
  tryAcquireLock,
  triggerReason,
  unreadNowSegments,
} from '../src/core.mjs';

test('只提取完整的人类 user→assistant 轮并过滤 meta', () => {
  const rows = [
    { type: 'user', uuid: 'u1', timestamp: '2026-07-29T01:00:00Z', origin: { kind: 'human' }, message: { content: '第一问' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-07-29T01:01:00Z', message: { content: [{ type: 'text', text: '第一答' }] } },
    { type: 'user', uuid: 'u2', timestamp: '2026-07-29T01:02:00Z', origin: { kind: 'human' }, message: { content: '没答完' } },
    { type: 'assistant', uuid: 'a2', timestamp: '2026-07-29T01:03:00Z', isMeta: true, message: { content: '隐藏' } },
  ];
  const turns = extractCompleteTurns(rows.map((row) => JSON.stringify(row)).join('\n'));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].user, '第一问');
  assert.equal(turns[0].assistant, '第一答');
});

test('50轮、3小时和压缩触发，没有新轮则不触发', () => {
  assert.equal(triggerReason({ totalTurns: 50, committedTurns: 0 }), '50-turns');
  assert.equal(triggerReason({
    totalTurns: 2,
    committedTurns: 0,
    firstPendingAt: '2026-07-29T00:00:00Z',
    now: new Date('2026-07-29T03:00:01Z'),
  }), '3-hours');
  assert.equal(triggerReason({ totalTurns: 2, committedTurns: 0, eventName: 'PreCompact' }), 'pre-compact');
  assert.equal(triggerReason({ totalTurns: 2, committedTurns: 1, dayChanged: true }), 'new-day');
  assert.equal(triggerReason({ totalTurns: 2, committedTurns: 2, eventName: 'PreCompact' }), null);
});

test('读取当天优先，不足五段时由昨天最新段补位', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-now-'));
  const add = (date, number) => appendSegment(root, {
    id: `${date}-${number}`,
    date,
    local_time: `0${number}:00:00`,
    created_at: `${date}T0${number}:00:00Z`,
    trigger: 'test',
    content: `${date} 第${number}段`,
  });
  for (let i = 1; i <= 5; i += 1) add('2026-07-28', i);
  add('2026-07-29', 1);
  add('2026-07-29', 2);
  const selected = selectVisibleSegments(root, { today: '2026-07-29', limit: 5 });
  assert.deepEqual(selected.map((item) => item.content), [
    '2026-07-28 第3段',
    '2026-07-28 第4段',
    '2026-07-28 第5段',
    '2026-07-29 第1段',
    '2026-07-29 第2段',
  ]);
  const view = renderNowView(selected, { profile: '测试', generatedAt: '现在' });
  assert.match(view, /2026-07-28 第3段/);
  assert.match(view, /2026-07-29 第2段/);
});

test('第三天清除派生桶，但不涉及原始逐字稿或日记', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-now-'));
  for (const date of ['2026-07-27', '2026-07-28', '2026-07-29']) {
    appendSegment(root, {
      id: date,
      date,
      local_time: '01:00:00',
      created_at: `${date}T01:00:00Z`,
      trigger: 'test',
      content: date,
    });
  }
  assert.deepEqual(pruneOldBuckets(root, '2026-07-29', 2), ['2026-07-27']);
  assert.equal(fs.existsSync(path.join(root, '2026-07-28')), true);
  assert.equal(fs.existsSync(path.join(root, '2026-07-29')), true);
});

test('同一组段渲染结果稳定，不因普通 Stop 改变', () => {
  const segments = [{
    date: '2026-07-29',
    local_time: '12:00:00',
    trigger: '50-turns',
    content: '仍在推进同一件事。',
  }];
  const first = renderNowView(segments, {
    profile: '测试',
    generatedAt: '2026-07-29 12:00:00 Asia/Shanghai',
  });
  const second = renderNowView(segments, {
    profile: '测试',
    generatedAt: '2026-07-29 12:00:00 Asia/Shanghai',
  });
  assert.equal(first, second);
});

test('PreCompact 可将超过 50 个 pending 轮完整切批，不留静默尾巴', () => {
  const pending = Array.from({ length: 120 }, (_, index) => ({ turn: index + 1 }));
  const batches = splitBatches(pending, 50);
  assert.deepEqual(batches.map((batch) => batch.length), [50, 50, 20]);
  assert.deepEqual(batches.flat().map((item) => item.turn), pending.map((item) => item.turn));
});

test('同一 profile 的第二个 hook 不能同时取得锁，过期锁可回收', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-now-lock-'));
  const lockPath = path.join(root, 'recorder.lock');
  const first = tryAcquireLock(lockPath, { staleMs: 50 });
  assert.ok(first);
  assert.equal(tryAcquireLock(lockPath, { staleMs: 50 }), null);
  releaseLock(first);

  fs.writeFileSync(lockPath, 'stale');
  const old = new Date(Date.now() - 1000);
  fs.utimesSync(lockPath, old, old);
  const recovered = tryAcquireLock(lockPath, { staleMs: 50 });
  assert.ok(recovered);
  releaseLock(recovered);
});

test('外部导出按 session 默认拒绝，显式允许不影响其他 session', () => {
  const policy = defaultPolicy();
  assert.equal(externalExportAllowed(policy, 'a'), false);
  setExternalExportPolicy(policy, 'a', true);
  assert.equal(externalExportAllowed(policy, 'a'), true);
  assert.equal(externalExportAllowed(policy, 'b'), false);
});

test('稳定 source range 可找回已落盘段，profile 最近日期不依赖当前 session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-now-recovery-'));
  appendSegment(root, {
    id: 'stable', date: '2026-07-29', local_time: '23:59:00', created_at: '2026-07-29T15:59:00Z',
    content: '第一段', source: { session_id: 'old', from_turn: 1, to_turn: 50 },
  });
  assert.equal(latestSegmentDate(root), '2026-07-29');
  assert.equal(findSegmentBySource(root, { sessionId: 'old', fromTurn: 1, toTurn: 50 })?.id, 'stable');
});

test('提示词按完整轮次受字符预算约束，不丢掉尾部轮次', () => {
  const turns = Array.from({ length: 8 }, (_, index) => ({ text: `${index}`.repeat(10) }));
  const batches = splitPromptBatches(turns, {
    maxTurns: 50,
    maxChars: 25,
    renderTurn: (turn) => turn.text,
  });
  assert.deepEqual(batches.map((batch) => batch.length), [2, 2, 2, 2]);
  assert.deepEqual(batches.flat(), turns);
});

test('Codex Desktop 只取 user→final_answer，过滤 commentary 与工具事件', () => {
  const rows = [
    { timestamp: '2026-07-30T01:00:00Z', type: 'response_item', payload: {
      type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: '第一问' }],
    } },
    { timestamp: '2026-07-30T01:00:10Z', type: 'response_item', payload: {
      type: 'message', id: 'c1', role: 'assistant', phase: 'commentary',
      content: [{ type: 'output_text', text: '施工播报' }],
    } },
    { timestamp: '2026-07-30T01:00:20Z', type: 'response_item', payload: {
      type: 'custom_tool_call_output', id: 'tool1', output: '隐藏工具输出',
    } },
    { timestamp: '2026-07-30T01:01:00Z', type: 'response_item', payload: {
      type: 'message', id: 'a1', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: '第一答' }],
    } },
    { timestamp: '2026-07-30T01:02:00Z', type: 'response_item', payload: {
      type: 'message', id: 'u2', role: 'user', content: [{ type: 'input_text', text: '还没回答' }],
    } },
  ];
  const turns = extractCodexCompleteTurns(rows.map((row) => JSON.stringify(row)).join('\n'));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].user, '第一问');
  assert.equal(turns[0].assistant, '第一答');
});

test('超长摘要只在完整句子处收口，不切半句话', () => {
  const content = `${'甲'.repeat(90)}。${'乙'.repeat(170)}。`;
  const clipped = clipCompleteSentence(content, 240, 80);
  assert.equal(clipped, `${'甲'.repeat(90)}。`);
  assert.equal(clipCompleteSentence('甲'.repeat(300), 240, 80), '');
});

test('now 抽屉按已读游标区分未读段，不因旧桶仍在而反复提醒', () => {
  const segments = [
    { id: 'a', created_at: '2026-07-30T01:00:00Z' },
    { id: 'b', created_at: '2026-07-30T02:00:00Z' },
    { id: 'c', created_at: '2026-07-30T03:00:00Z' },
  ];
  const state = defaultReminderState();
  assert.deepEqual(unreadNowSegments(segments, state).map((item) => item.id), ['a', 'b', 'c']);
  state.read_through = { id: 'b', created_at: segments[1].created_at };
  assert.deepEqual(unreadNowSegments(segments, state).map((item) => item.id), ['c']);
});

test('新段不立刻催；50 轮后轻提醒；新窗口则立即提醒一次', () => {
  const segments = [{
    id: 'latest',
    created_at: '2026-07-30T03:00:00Z',
    source: { session_id: 's1', to_turn: 50 },
  }];
  const state = defaultReminderState();
  state.sessions.s1 = { first_unread_seen_turns: 50 };
  assert.equal(decideNowReminder({
    segments, reminderState: state, sessionId: 's1', currentTurns: 51,
    eventName: 'turn', today: '2026-07-30',
  }), null);
  assert.equal(decideNowReminder({
    segments, reminderState: state, sessionId: 's1', currentTurns: 100,
    eventName: 'turn', today: '2026-07-30',
  })?.reason, 'unread');
  assert.equal(decideNowReminder({
    segments, reminderState: state, sessionId: 's2', currentTurns: 0,
    eventName: 'session-start', today: '2026-07-30',
  })?.reason, 'session-start');
});

test('未读段即将被五段视图挤出时提前敲门，今日静音后保持安静', () => {
  const segments = Array.from({ length: 5 }, (_, index) => ({
    id: `s${index}`,
    created_at: `2026-07-30T0${index}:00:00Z`,
    source: { session_id: 'same', to_turn: (index + 1) * 10 },
  }));
  const state = defaultReminderState();
  state.sessions.same = { first_unread_seen_turns: 0 };
  const decision = decideNowReminder({
    segments, reminderState: state, sessionId: 'same', currentTurns: 41,
    eventName: 'turn', today: '2026-07-30', visibleSegments: 5,
  });
  assert.equal(decision?.reason, 'before-eviction');
  assert.match(formatNowReminder(decision, { viewPath: 'F:\\now\\当前.md' }), /是否打开由你决定/);
  state.muted_date = '2026-07-30';
  assert.equal(decideNowReminder({
    segments, reminderState: state, sessionId: 'same', currentTurns: 100,
    eventName: 'turn', today: '2026-07-30',
  }), null);
});

test('跨日期列出全部段时保持 created_at 和 id 的稳定顺序', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-now-all-'));
  appendSegment(root, {
    id: 'b', date: '2026-07-30', local_time: '01:00:00',
    created_at: '2026-07-29T17:00:00Z', content: 'b',
  });
  appendSegment(root, {
    id: 'a', date: '2026-07-29', local_time: '23:59:00',
    created_at: '2026-07-29T15:59:00Z', content: 'a',
  });
  assert.deepEqual(listAllSegments(root).map((item) => item.id), ['a', 'b']);
});
