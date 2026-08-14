// ① 写入审计（方案_地基定稿_溯_20260813）：canonical payload 的唯一实现。
//
// 规则（定稿逐条对应）：
// - 字段固定顺序（type/keys/hook/body/trigger_date/trigger_done/sealed/anchor/weight/origin/status）
// - keys：排序 + 去重；缺失 = 空数组（这两态合并是定稿明说的）
// - body：空串与缺失是两种状态，分别编码，禁止合并
// - trigger_date：null 与缺失分别编码；空串非法，直接抛错
// - trigger_done：受审计的控制字段（决定日期提醒还浮不浮现），0/1 入指纹
// - origin：缺失/null 归一为 'unknown'——③ 加列后 null→unknown 与现在同哈希，不漂移
// - 序列化：JSON 无空白，字段顺序固定
//
// 边界（诚实标注，不宣称覆盖全部生命周期）：
// - 受审计的是「内容/控制字段」：type/keys/hook/body/trigger_date/trigger_done/
//   sealed/anchor/weight/origin/status。
// - operational state（last_accessed/tier_since）被排除：last_accessed 是纯访问时钟；
//   tier_since 是升星时间戳，同 anchor 下重置它不改变条目的含义与生命周期决策——
//   若将来需要审计 tier_since 的变动，把它加入 FIELD_ORDER 并重算历史指纹基线。
//
// 编码：每个字段一个 [名, 态标签, 值?] 三元组。
//   ['m']       = 缺失
//   ['n']       = 显式 null
//   ['v', 值]   = 有值（空串是值，不是缺失）
import { createHash } from 'node:crypto';

const FIELD_ORDER = ['type', 'keys', 'hook', 'body', 'trigger_date', 'trigger_done', 'sealed', 'anchor', 'weight', 'origin', 'status'];

function encodeField(name, input) {
  const present = Object.prototype.hasOwnProperty.call(input, name) && input[name] !== undefined;

  switch (name) {
    case 'keys': {
      if (!present) return ['v', []];
      if (!Array.isArray(input.keys)) throw new Error('canonical: keys 必须是数组');
      const normalized = [...new Set(input.keys.map(String))].sort();
      return ['v', normalized];
    }
    case 'trigger_date': {
      if (!present) return ['m'];
      if (input.trigger_date === null) return ['n'];
      if (input.trigger_date === '') throw new Error('canonical: trigger_date 空串非法（无日期用 null）');
      return ['v', String(input.trigger_date)];
    }
    case 'origin': {
      if (!present || input.origin === null) return ['v', 'unknown'];
      return ['v', String(input.origin)];
    }
    case 'trigger_done': {
      if (!present) return ['m'];
      return ['v', input.trigger_done ? 1 : 0];
    }
    case 'sealed': {
      if (!present) return ['m'];
      return ['v', input.sealed ? 1 : 0];
    }
    case 'anchor':
    case 'weight': {
      if (!present) return ['m'];
      return ['v', Number(input[name])];
    }
    default: { // type / hook / body / status：字符串，空串是值
      if (!present) return ['m'];
      if (input[name] === null) return ['n'];
      return ['v', String(input[name])];
    }
  }
}

// ③ sources 进指纹（Lumen ③一审）：全字段入串，缺一个都算绕过——
// source_id/kind/summary/range/revision_of/checksum(落盘值)/excerpt_sha(由摘录重算)。
// excerpt_sha 用重算值：手改摘录本体（不动 checksum 列）也会立刻改变指纹；
// checksum 落盘值另行入串：单独篡改 checksum 列同样暴露。
// 字段按名字母序（稳定键排序），来源间按 source_id 排序（终审护栏1，防插入顺序漂移）。
// 兼容决定（Lumen 已批准）：sources 为空/缺失时【完全不编码】该字段——
// ①已落盘的审计指纹按 11 字段序列化，追加空字段会让它们全部误报 mismatch。
const SOURCE_FIELD_ORDER = ['checksum', 'excerpt_sha', 'kind', 'range', 'revision_of', 'source_id', 'summary'];

function normalizeSources(sources) {
  if (sources === undefined || sources === null) return [];
  if (!Array.isArray(sources)) throw new Error('canonical: sources 必须是数组');
  return sources
    .map((s) => SOURCE_FIELD_ORDER.map((key) => {
      const v = s[key];
      return [key, v === undefined || v === null ? null : String(v)];
    }))
    .sort((a, b) => {
      const idA = a.find(([k]) => k === 'source_id')[1] ?? '';
      const idB = b.find(([k]) => k === 'source_id')[1] ?? '';
      return idA < idB ? -1 : idA > idB ? 1 : 0;
    });
}

export function canonicalPayload(input) {
  if (!input || typeof input !== 'object') throw new Error('canonical: 输入必须是对象');
  const fields = FIELD_ORDER.map((name) => [name, encodeField(name, input)]);
  const sources = normalizeSources(input.sources);
  if (sources.length > 0) fields.push(['sources', ['v', sources]]);
  return fields;
}

export function contentSha256(input) {
  return createHash('sha256').update(JSON.stringify(canonicalPayload(input)), 'utf8').digest('hex');
}

// DB 行 → canonical 输入：keys 反序列化；origin NULL = unknown；
// sources 由调用方从 entry_sources JOIN hearth_sources 取来传入（canonical 不碰 db）
export function entryRowToPayload(row, sources = []) {
  const payload = {
    type: row.type,
    keys: JSON.parse(row.keys),
    hook: row.hook,
    body: row.body,
    trigger_date: row.trigger_date === undefined ? null : row.trigger_date,
    trigger_done: row.trigger_done,
    sealed: row.sealed,
    anchor: row.anchor,
    weight: row.weight,
    status: row.status,
  };
  if (row.origin !== undefined && row.origin !== null) payload.origin = row.origin;
  if (sources.length > 0) payload.sources = sources;
  return payload;
}

// meta 走独立命名空间，内容即指纹对象
export function metaSha256(key, content) {
  return createHash('sha256').update(JSON.stringify(['meta', key, content]), 'utf8').digest('hex');
}
