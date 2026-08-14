import { db } from '../db.js';

// 衰退是读取时算出来的，零后台任务。
// 目录只装"触发条目"：event/project。
//   - rule 常驻例外（load 全文返回，不衰退、不占目录限额）
//   - letter 不进目录，但可被 keys 触发（话题浮现）
//   - stream 不进目录，但可被 keys 触发（衰退窗口较短：7/14 天）
// 四态（H2 定稿）：活跃 <60 天（目录+keys）→ 半沉 60-120 天（退目录，keys 仍触发）
// → 沉底 >120 天（keys 失效，仅显式按 id 取）→ 星云 status='archived'。anchor 豁免一切。

const ACTIVE_WINDOW_DAYS = 60;
const SUNK_DAYS = 120;
const STREAM_ACTIVE_DAYS = 7;
const STREAM_SUNK_DAYS = 14;

export const TIER_RULES = [
  { from: 0, to: 1, minGapDays: 0, windowDays: 14, distinctDays: 4 },
  { from: 1, to: 2, minGapDays: 7, windowDays: 30, distinctDays: 3 },
  { from: 2, to: 3, minGapDays: 21, windowDays: 60, distinctDays: 2 },
];

// 日记遗忘分层（通道 A）：stream 的 0→1 走快车道——流水 7 天就沉，通用 14 天窗够不着。
// 一本日记被跨两天翻过，说明它值得留下（anchor=1 进目录、豁免月记压缩）。
// 1→2、2→3 仍走通用 TIER_RULES（继续熬），不继续用快车道。
const STREAM_FIRST_STEP = { from: 0, to: 1, minGapDays: 0, windowDays: 7, distinctDays: 2 };

export function tierRulesFor(type) {
  if (type === 'stream') return [STREAM_FIRST_STEP, ...TIER_RULES.slice(1)];
  return TIER_RULES;
}

const TIER_BANDS = { 1: 'glimmer', 2: 'beacon', 3: 'anchor' };
const TIER_DECAY_MULTIPLIER = { 0: 1, 1: 2, 2: 4 };

function windowsFor(type) {
  return type === 'stream'
    ? { active: STREAM_ACTIVE_DAYS, sunk: STREAM_SUNK_DAYS }
    : { active: ACTIVE_WINDOW_DAYS, sunk: SUNK_DAYS };
}

const DIRECTORY_FILTER = `
  status = 'active' AND sealed = 0 AND type IN ('event','project')
  AND (anchor = 3 OR last_accessed >= datetime('now', '-' ||
       (CASE anchor WHEN 2 THEN ${ACTIVE_WINDOW_DAYS * 4} WHEN 1 THEN ${ACTIVE_WINDOW_DAYS * 2}
                    ELSE ${ACTIVE_WINDOW_DAYS} END) || ' days'))
`;

// keys 可触发范围（tags 匹配 / keys 索引 / 输入扫描 hook 共用一个口径）
// 沉底线按类型分档，与 starBand() 的 windowsFor(type) * multiplier 同口径：
// 日记是流水，14 天沉底就该 keys 失效，不能跟经历一样赖到 120 天。
export const TOUCHABLE_FILTER = `
  status = 'active' AND sealed = 0 AND type IN ('event','project','letter','stream')
  AND (anchor = 3 OR last_accessed >= datetime('now', '-' ||
       ((CASE type WHEN 'stream' THEN ${STREAM_SUNK_DAYS} ELSE ${SUNK_DAYS} END)
        * (CASE anchor WHEN 2 THEN 4 WHEN 1 THEN 2 ELSE 1 END)) || ' days'))
`;

export function activeDirectoryRows() {
  return db.prepare(`
    SELECT id, type, hook FROM hearth_entries
    WHERE ${DIRECTORY_FILTER}
    ORDER BY last_accessed DESC
  `).all();
}

export function activeDirectoryCount() {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM hearth_entries WHERE ${DIRECTORY_FILTER}
  `).get().c;
}

// 星空距离带（Vesper 消费）：衰退口径统一在服务端算，客户端不重复实现。
// half_sunk 上限 = SUNK_DAYS，与 keys 触发失效是同一条线。
export function starBand(row, nowUnixMs = Date.now()) {
  if (row.status === 'archived') return 'nebula';
  const tier = Number(row.anchor) || 0;
  if (tier === 3) return 'anchor';
  const windows = windowsFor(row.type);
  const multiplier = TIER_DECAY_MULTIPLIER[tier] || 1;
  const days = (nowUnixMs - Date.parse(row.last_accessed + 'Z')) / 86400000;
  if (days < windows.active * multiplier) return TIER_BANDS[tier] || 'active';
  if (days <= windows.sunk * multiplier) return 'half_sunk';
  return 'deep';
}
