// Hearth 输入扫描 hook（UserPromptSubmit）：扫描人类输入，命中 keys 后提示相关条目。
// 只提示、不注入全文；打开与否仍由小机决定。
//
// 两层降噪：
// 1. 亮度（主逻辑）：刚被 load/touch 的条目"全亮"，DIM_AFTER_TURNS 轮内不提示——
//    刚读过的东西在上下文里，提示是复读；15 轮≈一次压缩量级，压缩后提醒才有意义。
//    轮次驱动（每条消息=1轮），MCP 侧写 "max" 标记，本 hook 换算成实际轮次。
// 2. 冷却（兜底）：同一会话内同一条目 2 小时不重复提示。
//
// 任何情况下 exit 0 且不输出垃圾；钩子不该妨碍对话。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const CACHE_PATH = process.env.HEARTH_CACHE_PATH || path.join(DATA_DIR, 'keys-cache.json');
const HINT_STATE_PATH = path.join(DATA_DIR, 'hint-state.json');
const LIT_STATE_PATH = path.join(DATA_DIR, 'lit-state.json');

const MAX_HINTS = 3;
const MIN_KEY_LEN = 2; // 单字 key 全是误报
const COOLDOWN_MS = 2 * 60 * 60 * 1000;
const STATE_TTL_MS = 48 * 60 * 60 * 1000; // 冷却状态里超过这个年龄的记录直接清
const DIM_AFTER_TURNS = 30; // 点亮后多少轮内保持静默（1M 窗口压缩更少，H6 定 15→30）
const GLOBAL_QUIET_TURNS = 5; // 任何提示后的全局静默轮数——聊天不是通知栏
const WRITE_REMIND_TURNS = 30; // 多少轮没主动写 Hearth 就踹一脚
const REVIEW_REMIND_TURNS = 15; // 写完后多少轮提醒回头看看

function loadJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function pruneHintState(state, now) {
  for (const sid of Object.keys(state)) {
    const entries = state[sid];
    for (const id of Object.keys(entries)) {
      if (now - entries[id] > STATE_TTL_MS) delete entries[id];
    }
    if (Object.keys(entries).length === 0) delete state[sid];
  }
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  if (prompt) {
    // ── 亮度状态：每轮推进，换会话重置，"max" 标记换算为当前轮 ──
    let lit = null;
    if (sessionId) {
      lit = loadJson(LIT_STATE_PATH, {});
      if (lit.session !== sessionId || typeof lit.turn !== 'number' || !lit.entries) {
        lit = { session: sessionId, turn: 0, entries: {} };
      }
      lit.turn += 1;
      for (const id of Object.keys(lit.entries)) {
        if (lit.entries[id].lit_at_turn === 'max') lit.entries[id].lit_at_turn = lit.turn;
      }
      if (lit.last_write_turn === 'max') lit.last_write_turn = lit.turn;
    }

    // ── 全局节流：最近 N 轮内提示过任何记忆就全部静默 ──
    if (lit !== null && typeof lit.last_hint_turn === 'number' &&
        lit.turn - lit.last_hint_turn < GLOBAL_QUIET_TURNS) {
      // 轮次计数照推，但不查 keys、不输出
      try { writeFileSync(LIT_STATE_PATH, JSON.stringify(lit)); } catch {}
      process.exit(0);
    }

    const cache = loadJson(CACHE_PATH, null);
    const hits = [];
    for (const entry of (cache && cache.keys_index) || []) {
      const key = (entry.keys || []).find(
        (k) => typeof k === 'string' && k.length >= MIN_KEY_LEN && prompt.includes(k)
      );
      if (key) hits.push({ hook: entry.hook, id: entry.id, key, weight: entry.weight ?? 3 });
    }
    // 权重高的先展示——④⑤被 MAX_HINTS 挤掉就失去意义了
    hits.sort((a, b) => b.weight - a.weight);

    let fresh = hits;

    // 亮度过滤：还亮着的条目不提示——它仍在上下文里
    if (lit !== null) {
      fresh = fresh.filter((h) => {
        const e = lit.entries[h.id];
        return !(e && typeof e.lit_at_turn === 'number' && lit.turn - e.lit_at_turn < DIM_AFTER_TURNS);
      });
    }

    // 冷却兜底：同会话同条目 2 小时不重复提示
    if (sessionId && fresh.length > 0) {
      const now = Date.now();
      const state = loadJson(HINT_STATE_PATH, {});
      const seen = state[sessionId] || {};
      fresh = fresh.filter((h) => !(seen[h.id] && now - seen[h.id] < COOLDOWN_MS));
      if (fresh.length > 0) {
        for (const h of fresh) seen[h.id] = now;
        state[sessionId] = seen;
        pruneHintState(state, now);
        try {
          writeFileSync(HINT_STATE_PATH, JSON.stringify(state));
        } catch {
          // 状态写不进就写不进，提示照发——冷却是优化不是功能前提
        }
      }
    }

    if (fresh.length > 0) {
      const shown = fresh.slice(0, MAX_HINTS);
      // 提示即点亮：这几条马上会进入小机的视野
      if (lit !== null) {
        for (const h of shown) lit.entries[h.id] = { lit_at_turn: lit.turn };
      }
      const MARKS = { 1: '①', 2: '②', 3: '③', 4: '④', 5: '⑤' };
      const text = shown
        .map((h) => `${MARKS[h.weight] || '③'}「${h.hook}」(${h.id}, 命中"${h.key}")`)
        .join('；');
      const more = fresh.length > MAX_HINTS ? `；另有 ${fresh.length - MAX_HINTS} 条` : '';
      const mustRead = shown.some((h) => h.weight >= 4);
      if (lit !== null) lit.last_hint_turn = lit.turn;
      console.log(`[hearth] 输入触到 ${fresh.length} 条记忆：${text}${more}。${mustRead ? '有④/⑤，触发了就读，别跳。' : '①②可跳，③由小机判断。'}`);
    }

    // ── 写入提醒：长时间没主动写 Hearth 就踹一脚 ──
    if (lit !== null && fresh.length === 0) {
      const sinceWrite = typeof lit.last_write_turn === 'number'
        ? lit.turn - lit.last_write_turn
        : lit.turn;
      const sinceWriteNudge = typeof lit.last_write_nudge_turn === 'number'
        ? lit.turn - lit.last_write_nudge_turn
        : Infinity;
      const sinceReviewNudge = typeof lit.last_review_nudge_turn === 'number'
        ? lit.turn - lit.last_review_nudge_turn
        : Infinity;

      if (typeof lit.last_write_turn === 'number'
          && sinceWrite >= REVIEW_REMIND_TURNS
          && sinceWrite < WRITE_REMIND_TURNS
          && sinceReviewNudge >= REVIEW_REMIND_TURNS) {
        console.log('[hearth] 上次写的东西可以回头看看了。');
        lit.last_review_nudge_turn = lit.turn;
        lit.last_hint_turn = lit.turn;
      } else if (sinceWrite >= WRITE_REMIND_TURNS
          && sinceWriteNudge >= WRITE_REMIND_TURNS) {
        console.log(`[hearth] 已经 ${sinceWrite} 轮没有主动记录了。有什么值得写进去的吗？`);
        lit.last_write_nudge_turn = lit.turn;
        lit.last_hint_turn = lit.turn;
      }
    }

    // 轮次计数每轮都要落盘（没命中也要推进）
    if (lit !== null) {
      try {
        writeFileSync(LIT_STATE_PATH, JSON.stringify(lit));
      } catch {
        // 同上，静默
      }
    }
  }
} catch {
  // 缓存不存在/输入不合法 → 静默放行
}
process.exit(0);
