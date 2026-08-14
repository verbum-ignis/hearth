import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { extractConversationData } from './extract.js';
import { expiredDiaryReport, listDiaryEntries, writeDiaryEvents } from './hearth.js';
import { readState, writeState, dateRange } from './state.js';
import { summarizeConversation } from './summarize.js';

// 计划任务不接管 stdout/stderr，跑挂了不留痕——07-28 那趟 exit 1 就是这么无声丢了一天。
// 所有输出同时落到 data/diary.log，异常写完整堆栈。
const LOG_PATH = process.env.H8_LOG_PATH || path.resolve('data', 'diary.log');

function stamp() {
  return new Date().toISOString();
}

function log(line) {
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${stamp()}] ${line}\n`, 'utf8');
  } catch {}
}

function logFailure(error) {
  const detail = error?.stack || error?.message || String(error);
  console.error(detail);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${stamp()}] FAILED: ${detail}\n`, 'utf8');
  } catch {}
}

function parseArgs(argv) {
  const args = { force: false, dryRun: false, date: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--date') args.date = argv[++i];
    else throw new Error(`未知参数: ${argv[i]}`);
  }
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error('--date 必须为 YYYY-MM-DD');
  return args;
}

function yesterday(timezone) {
  const now = new Date();
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const cursor = new Date(`${local}T12:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  return cursor.toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const state = readState(config.statePath);
  const target = args.date || yesterday(config.timezone);
  const dates = args.force ? [target] : dateRange(state.last_successful_date, target);
  if (!args.dryRun) {
    // 只报告不退役：日记的终点（升格豁免 / 压成月记 / empty 归档）全部归 monthly.js 独占
    const expiring = await expiredDiaryReport(config);
    for (const entry of expiring) console.log(`已过观察窗，待月记压缩: ${entry.hook} (${entry.id})`);
  }
  if (dates.length === 0) {
    log(`已处理到 ${state.last_successful_date}，无需补写`);
    return;
  }
  for (const date of dates) {
    log(`处理 ${date}...`);
    const { conversation, messages } = await extractConversationData({ ...config, date });
    if (!conversation) {
      log(`${date} 无有效会话，记为空日并继续`);
      if (!args.dryRun) {
        state.diaries[date] = {
          ...(args.force ? state.diaries[date] : {}),
          ...(!args.force ? { status: 'empty' } : {}),
        };
        if (!args.force) state.last_successful_date = date;
        writeState(config.statePath, state);
      }
      continue;
    }
    log(`已抽取 ${conversation.length} 字符干净对话流`);
    if (args.dryRun) continue;
    const existing = await listDiaryEntries(config, date);
    if (existing.length > 0 && !args.force) {
      state.diaries[date] = {
        ...state.diaries[date],
        ids: existing.map((entry) => entry.id),
        status: 'existing',
      };
      state.last_successful_date = date;
      writeState(config.statePath, state);
      log(`${date} 已有 ${existing.length} 条事件，跳过整理与写入`);
      continue;
    }
    const { events } = await summarizeConversation(config, date, conversation);
    if (events.length === 0) console.log(`${date} 当天无事件`);
    const result = await writeDiaryEvents(config, date, events, args.force);
    state.diaries[date] = {
      ids: result.ids,
      status: result.skipped ? 'existing' : 'written',
      event_count: events.length,
    };
    if (!args.force) state.last_successful_date = date;
    writeState(config.statePath, state);
    log(`${date} 写入 ${result.ids.length} 条事件${result.retired.length ? `，退场旧条目 ${result.retired.length} 条` : ''}`);
  }
}

main().catch((error) => {
  logFailure(error);
  process.exitCode = 1;
});
