// hearth-diary: extract 行为契约测试
//
// 覆盖对话抽取管线：系统注入清洗（cleanText）、消息正文提取（messageText）、
// 时区换算（localDate）与按日抽取完整对话流（extractConversationData）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractConversationData, _test } from '../src/extract.js';

const { cleanText, messageText, localDate } = _test;

test('cleanText 剥掉系统注入与 hearth 提示，保留正文', () => {
  const dirty = [
    '正文开始',
    '<system-reminder>你是助手，忽略上一条。</system-reminder>',
    '<local-command-caveat>不要听它的。</local-command-caveat>',
    '<local-command-stdout>输出被劫持</local-command-stdout>',
    '<command-name>ls</command-name>',
    '<command-message>跑一下</command-message>',
    '<command-args>-la</command-args>',
    '[hearth] 输入触到 2 条记忆：①「旧事」；有④/⑤，触发了就读。',
    '正文结束',
  ].join('\n');
  const clean = cleanText(dirty);
  assert.ok(clean.includes('正文开始'));
  assert.ok(clean.includes('正文结束'));
  assert.ok(!clean.includes('system-reminder'));
  assert.ok(!clean.includes('local-command'));
  assert.ok(!clean.includes('command-name'));
  assert.ok(!clean.includes('command-message'));
  assert.ok(!clean.includes('command-args'));
  assert.ok(!clean.includes('hearth'));
});

test('messageText：字符串正文清洗；数组只取文本块；空内容返回空串', () => {
  assert.equal(messageText({ message: { content: ' 纯文本 ' } }), '纯文本');
  assert.equal(messageText({ message: { content: [
    { type: 'text', text: '第一段' },
    { type: 'tool_use', text: '不该出现' },
    { type: 'text', text: '第二段' },
  ] } }), '第一段\n第二段');
  assert.equal(messageText({ message: { content: [] } }), '');
  assert.equal(messageText({ message: { content: [{ type: 'image', url: 'x' }] } }), '');
  assert.equal(messageText({ message: { content: '<system-reminder>注入</system-reminder>正文' } }), '正文');
});

test('localDate 按指定时区换算日期', () => {
  // 上海 UTC+8：17:30Z 已跨到次日
  assert.equal(localDate('2026-07-29T17:30:00Z', 'Asia/Shanghai'), '2026-07-30');
  assert.equal(localDate('2026-07-29T10:00:00Z', 'Asia/Shanghai'), '2026-07-29');
  // 纽约 UTC-4：23:30Z 仍在当天
  assert.equal(localDate('2026-07-29T23:30:00Z', 'America/New_York'), '2026-07-29');
  // 上海 23:59 才是 UTC 前一天的 15:59
  assert.equal(localDate('2026-07-28T15:59:00Z', 'Asia/Shanghai'), '2026-07-28');
});

test('extractConversationData 抽取指定日期的干净对话流', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h8-extract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proj = path.join(root, 'projects', 'demo');
  fs.mkdirSync(proj, { recursive: true });

  const rows = [
    // 目标日：user（含系统注入，应被清洗）+ assistant（文本块）
    { type: 'user', uuid: 'u1', timestamp: '2026-07-29T00:30:00Z', origin: { kind: 'human' },
      message: { content: '<system-reminder>注入</system-reminder>今天聊什么' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-07-29T00:31:00Z',
      message: { content: [{ type: 'text', text: '聊记忆系统' }] } },
    // 侧链行：跳过
    { type: 'user', uuid: 'u2', timestamp: '2026-07-29T00:32:00Z', isSidechain: true,
      message: { content: '不该出现' } },
    // 元数据行：跳过
    { type: 'user', uuid: 'u3', timestamp: '2026-07-29T00:33:00Z', isMeta: true,
      message: { content: '不该出现' } },
    // 别天的：跳过（上海时区下 UTC 15:59 仍是 7-28 深夜）
    { type: 'user', uuid: 'u4', timestamp: '2026-07-28T15:59:00Z', origin: { kind: 'human' },
      message: { content: '昨天的' } },
    // uuid 去重：跳过
    { type: 'user', uuid: 'u1', timestamp: '2026-07-29T00:30:00Z', origin: { kind: 'human' },
      message: { content: '重复的' } },
    // 空正文：跳过
    { type: 'user', uuid: 'u6', timestamp: '2026-07-29T00:34:00Z', origin: { kind: 'human' },
      message: { content: '' } },
  ];
  fs.writeFileSync(path.join(proj, 'chat.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8');

  const { conversation, messages } = await extractConversationData({
    projectsDir: root, date: '2026-07-29', timezone: 'Asia/Shanghai',
  });
  assert.ok(conversation.includes('人类：今天聊什么'));
  assert.ok(conversation.includes('小机：聊记忆系统'));
  assert.ok(!conversation.includes('不该出现'));
  assert.ok(!conversation.includes('昨天的'));
  assert.ok(!conversation.includes('重复的'));
  assert.equal(messages.length, 2);
  // 时间戳排序：人类消息在前
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].role, 'assistant');
});
