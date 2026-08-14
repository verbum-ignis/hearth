// 通道 B：月记压缩（方案_日记遗忘分层 §八定稿，修订 2/3/4）。
//
// 规则：
// - 只压「整月已结束 && 该月全部 anchor=0 日记的 last_accessed 已过 60 天」的月份（修订2）；
// - 月份与 60 天边界按 config.timezone（Asia/Shanghai）划，不继承电脑太平洋时区（修订4）；
// - 月记必须带 origin（机器标识 hearth-diary/monthly/<YYYY-MM>）+ 原日记入 entry_sources；
//   月记写入成功且 verify+sources 验证通过后才 retire 原文，验证不过原文不动、下月重试（修订3）；
// - 0 断面不造月记，只记「该月已扫描、无输出」幂等标记（修订3）；
// - 合成月记自身显式排除出候选（origin 前缀判定，不靠 hook 文案猜），防摘要吃摘要（修订4）；
// - anchor>=1 的日记（升星豁免）不参与压缩，也不阻塞该月：它们留在火边，是通道 A 的战利品。
//
// 用法：node src/monthly.js [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { listDiaryEntries, hearthRequest, diaryDate } from './hearth.js';
import { readState, writeState } from './state.js';
import { summarizeMonth } from './summarize.js';

const MONTHLY_ORIGIN_PREFIX = 'hearth-diary/monthly/';
const LOG_PATH = process.env.H8_LOG_PATH || path.resolve('data', 'diary.log');

function log(line) {
  const msg = `[monthly] ${line}`;
  console.log(msg);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch {}
}

// 当前时刻在指定时区的 YYYY-MM（月份口径唯一来源，修订4）
export function monthNow(nowMs, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' })
    .format(new Date(nowMs)).slice(0, 7);
}

// 是否合成月记：只认稳定机器标识，不猜 hook 文案（修订4）
export function isSyntheticMonthly(entry) {
  return typeof entry.origin === 'string' && entry.origin.startsWith(MONTHLY_ORIGIN_PREFIX);
}

// 候选月份：{ month: [entries...] }，全部满足修订2 的观察窗口径。
// 输入 entries 应为 listDiaryEntries 的输出（active stream 日记）；此处再显式排除合成月记。
export function selectCompressibleMonths(entries, nowMs, timezone, doneMonths = {}) {
  const cutoff = nowMs - 60 * 86400000;
  const current = monthNow(nowMs, timezone);
  const byMonth = new Map();
  for (const entry of entries) {
    if (isSyntheticMonthly(entry)) continue; // 摘要不吃摘要
    if (Number(entry.anchor) !== 0) continue; // 升星豁免
    const date = diaryDate(entry);
    if (!date) continue;
    const month = date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(entry);
  }
  const result = [];
  for (const [month, list] of byMonth) {
    if (month >= current) continue; // 整月未结束
    if (doneMonths[month]?.status === 'compressed' || doneMonths[month]?.status === 'empty') continue;
    const allQuiet = list.every((e) => Date.parse(`${e.last_accessed}Z`) < cutoff);
    if (!allQuiet) continue; // 观察窗未过：还有可能被 touch 复活
    result.push({ month, entries: [...list].sort((a, b) => (a.hook < b.hook ? -1 : 1)) });
  }
  return result.sort((a, b) => (a.month < b.month ? -1 : 1));
}

// 恢复队列独立于 active 候选（Lumen 通道B二审第1条）：
// 最后一条原文已退、状态却没走到 final 的月份，在 /stars 里已经没有 active 条目，
// selectCompressibleMonths 看不见它——必须把 state 里的 pending/emptying 单独并入队列。
// 恢复路径只用 prior 里的 intended/retired，不需要 entries。
export function mergeRecoveryMonths(months, stateMonthly = {}) {
  const seen = new Set(months.map((m) => m.month));
  const merged = [...months];
  for (const [month, record] of Object.entries(stateMonthly)) {
    if ((record?.status === 'pending' || record?.status === 'emptying') && !seen.has(month)) {
      merged.push({ month, entries: [] });
    }
  }
  return merged.sort((a, b) => (a.month < b.month ? -1 : 1));
}

export function buildMonthlyPayload(month, monthly, sourceEntries) {
  return {
    op: 'create',
    entry: {
      type: 'stream',
      hook: `${month} 月记`,
      // keys[1] 是专用机器 key（二审第2条，溯的方案）：唯一、无人会打、
      // findMonthly 按它查一击必中，不撞 search 的 5 条全文上限
      keys: [month, `monthly:${month}`, ...monthly.topics.slice(0, 3)],
      body: monthly.body,
      origin: `${MONTHLY_ORIGIN_PREFIX}${month}`,
      sources: sourceEntries.map((e) => ({ kind: 'diary', summary: e.hook, range: e.id })),
    },
  };
}

// 压缩一批月份（Lumen 通道B一审后重写：可恢复、可补偿、集合级验证）。
//
// client = { create, verify, sources, retire, findMonthly? }，llm = (month, text) => {monthly}，
// persist = (state) => void（每次状态变更后立即落盘——中途崩溃是常态不是例外）。
//
// 顺序铁律（修订3）：写月记 → verify 通过 + sources 集合逐条对上 → 才 retire 原文。
// - pending 持久化：created id + intended ids + retire 进度，重跑续尾不重新摘要（一审第3条）；
// - 孤儿补偿：create 后验证不过 → retire 掉刚建的月记，不留 active 孤儿（一审第2条）；
// - fresh 前先 findMonthly 查同月遗留孤儿（create 成功但 pending 没落盘的窗口），有就收编（一审第2条）；
// - sources 集合级比对：逐条 range（=原日记 id）对集合，数量相同错绑也过不去（一审第4条）；
// - empty 月：原文同样走 retire 归档（观察窗已过、无值得保留 = 旧生命周期的自然终点），
//   只是不造月记；同样可恢复（一审第5条，拍板：empty ≠ 原文永生）。
function sourceSetMatches(src, intendedIds) {
  const got = (Array.isArray(src.sources) ? src.sources : []).map((s) => s.range).sort();
  const want = [...intendedIds].sort();
  return got.length === want.length && got.every((v, i) => v === want[i]);
}

// retire 幂等确认（二审第1条附）：retire 回包丢失会导致重跑重复 retire、多写审计。
// 有 status 探针（④ 的只读 search 按 id 查，零副作用）就先确认：已非 active 的只记进度不再发。
async function retireRemaining(client, pending, state, persist) {
  for (const id of pending.intended) {
    if (pending.retired.includes(id)) continue;
    const alreadyGone = client.status ? (await client.status(id)) !== 'active' : false;
    if (!alreadyGone) await client.retire(id);
    pending.retired.push(id);
    persist(state);
  }
}

// 验证月记；不过则补偿退役孤儿并清掉 pending。返回是否通过。
async function verifyOrCompensate(client, month, pending, state, persist, results) {
  const verdict = await client.verify(pending.entry_id);
  const src = verdict.verified === true ? await client.sources(pending.entry_id) : null;
  if (verdict.verified === true && sourceSetMatches(src, pending.intended)) return true;
  const reason = verdict.verified !== true
    ? `verify 未通过（${verdict.reason || 'unknown'}）`
    : 'sources 集合与原日记不符（数量或绑定错误）';
  await client.retire(pending.entry_id); // 补偿：不留 active 孤儿月记
  delete state.monthly[month];
  persist(state);
  results.push({ month, status: 'compensated', error: `月记 ${pending.entry_id} ${reason}，已补偿退役，下次重跑` });
  return false;
}

export async function compressMonths({ months, client, llm, state, nowLabel, persist = () => {} }) {
  const results = [];
  if (!state.monthly || typeof state.monthly !== 'object') state.monthly = {};
  for (const { month, entries } of months) {
    try {
      const prior = state.monthly[month];

      // ── 恢复路径：上次中断的月份续尾，不重新摘要 ──
      if (prior?.status === 'pending' || prior?.status === 'emptying') {
        if (prior.status === 'pending' && !(await verifyOrCompensate(client, month, prior, state, persist, results))) continue;
        await retireRemaining(client, prior, state, persist);
        state.monthly[month] = prior.status === 'pending'
          ? { status: 'compressed', entry_id: prior.entry_id, retired: prior.retired.length, at: nowLabel }
          : { status: 'empty', retired: prior.retired.length, at: nowLabel };
        persist(state);
        results.push({ month, status: `resumed:${state.monthly[month].status}` });
        continue;
      }

      const intended = entries.map((e) => e.id);

      // ── fresh：先查同月遗留孤儿（create 落地但 pending 没写上的窗口）──
      let orphanId = null;
      if (client.findMonthly) orphanId = await client.findMonthly(month);
      if (orphanId) {
        const pending = { status: 'pending', entry_id: orphanId, intended, retired: [] };
        state.monthly[month] = pending;
        persist(state);
        if (!(await verifyOrCompensate(client, month, pending, state, persist, results))) continue;
        await retireRemaining(client, pending, state, persist);
        state.monthly[month] = { status: 'compressed', entry_id: orphanId, retired: intended.length, at: nowLabel };
        persist(state);
        results.push({ month, status: 'adopted-orphan', entry_id: orphanId });
        continue;
      }

      const text = entries.map((e) => `${e.hook}\n${e.body}`).join('\n\n');
      const { monthly } = await llm(month, text);

      if (!monthly) {
        // empty 月：不造月记，但原文同样归档——观察窗已过，无断面 = 自然终点
        const pending = { status: 'emptying', intended, retired: [] };
        state.monthly[month] = pending;
        persist(state);
        await retireRemaining(client, pending, state, persist);
        state.monthly[month] = { status: 'empty', retired: intended.length, at: nowLabel };
        persist(state);
        results.push({ month, status: 'empty', retired: intended.length });
        continue;
      }

      const created = await client.create(buildMonthlyPayload(month, monthly, entries));
      const pending = { status: 'pending', entry_id: created.id, intended, retired: [] };
      state.monthly[month] = pending; // create 一落地立刻持久化，中断也找得回
      persist(state);
      if (!(await verifyOrCompensate(client, month, pending, state, persist, results))) continue;
      await retireRemaining(client, pending, state, persist);
      state.monthly[month] = { status: 'compressed', entry_id: created.id, retired: intended.length, at: nowLabel };
      persist(state);
      results.push({ month, status: 'compressed', entry_id: created.id, retired: intended.length });
    } catch (error) {
      results.push({ month, status: 'failed', error: error.message });
    }
  }
  state.last_monthly_compression = nowLabel;
  persist(state);
  return results;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig();
  const state = readState(config.statePath);
  const nowMs = Date.now();
  const entries = await listDiaryEntries(config);
  const months = mergeRecoveryMonths(
    selectCompressibleMonths(entries, nowMs, config.timezone, state.monthly || {}),
    state.monthly || {},
  );

  if (months.length === 0) {
    log('无可压缩月份（观察窗内或已处理）');
    return;
  }
  log(`候选月份：${months.map((m) => `${m.month}(${m.entries.length}条)`).join('、')}`);
  if (dryRun) {
    log('dry-run，不执行');
    return;
  }

  const client = {
    create: (payload) => hearthRequest(config, '/write', payload),
    verify: (id) => hearthRequest(config, `/verify/${id}`),
    sources: (id) => hearthRequest(config, `/sources/${id}`),
    retire: (id) => hearthRequest(config, '/write', { op: 'retire', id }),
    // 孤儿探测：create 成功但 pending 没落盘的窗口。按专用机器 key 查（唯一命中，
    // 不撞 5 条全文上限），origin 再精确确认，查看零副作用。
    findMonthly: async (month) => {
      const res = await hearthRequest(config, '/search', { keys: [`monthly:${month}`] });
      const hit = (res.entries || []).find((e) => e.origin === `${MONTHLY_ORIGIN_PREFIX}${month}`);
      return hit ? hit.id : null;
    },
    // retire 幂等探针：只读查状态，回包丢过的条目不再重复 retire
    status: async (id) => {
      const res = await hearthRequest(config, '/search', { id });
      return res.entries?.[0]?.status ?? 'unknown';
    },
  };
  const llm = (month, text) => summarizeMonth(config, month, text);
  const nowLabel = new Date(nowMs).toISOString();

  const results = await compressMonths({
    months, client, llm, state, nowLabel,
    persist: (s) => writeState(config.statePath, s),
  });
  for (const r of results) {
    log(`${r.month}: ${r.status}${r.entry_id ? ` → ${r.entry_id}（退役 ${r.retired} 条）` : ''}${r.error ? ` | ${r.error}` : ''}`);
  }
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) process.exitCode = 1;
}

// fileURLToPath 而不是手搓 pathname：Windows 中文路径会被 URL 编码，手搓比不上（今晚踩的）
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    log(`FAILED: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
