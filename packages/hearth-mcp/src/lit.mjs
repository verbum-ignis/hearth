// 亮度标记（Hook 亮度衰减方案）：load/touch/search 后刚进上下文的条目
// 标记 "max"（=刚点亮，具体轮次由 scan-input 下轮换算）——15 轮内 hook 不再提示。
// 只动 entries，不碰 session/turn（那是 scan-input 的地盘）。失败静默。
// ④ 起 search 也计入：查看取回的全文同样该点亮，否则 scan-input 会继续提醒刚读过的条目。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// 从某条读取端响应里提取该点亮的条目 ids：touch/search 返回 entries 全文。
// 纯函数，独立可测。
export function litIdsFor(urlPath, text) {
  if (urlPath !== '/touch' && urlPath !== '/search') return [];
  try {
    const data = JSON.parse(text);
    return (data.entries || []).map((e) => e.id).filter(Boolean);
  } catch {
    return [];
  }
}

export async function markLit(litStatePath, ids) {
  if (!ids.length) return;
  try {
    let state = {};
    try {
      state = JSON.parse(await readFile(litStatePath, 'utf8'));
    } catch {
      // 没有就新建
    }
    if (!state.entries || typeof state.entries !== 'object') state.entries = {};
    for (const id of ids) state.entries[id] = { lit_at_turn: 'max' };
    await mkdir(path.dirname(litStatePath), { recursive: true });
    await writeFile(litStatePath, JSON.stringify(state), 'utf8');
  } catch {
    // 静默：亮度是降噪优化，不影响主流程
  }
}

export function markWriteEvent(litStatePath) {
  return (async () => {
    try {
      let state = {};
      try {
        state = JSON.parse(await readFile(litStatePath, 'utf8'));
      } catch {}
      state.last_write_turn = 'max';
      delete state.last_write_nudge_turn;
      delete state.last_review_nudge_turn;
      await mkdir(path.dirname(litStatePath), { recursive: true });
      await writeFile(litStatePath, JSON.stringify(state), 'utf8');
    } catch {}
  })();
}
