import { nanoid } from 'nanoid';
import { db, now, transaction } from '../db.js';
import { snapshotEntry, snapshotMeta } from '../lib/snapshot.js';
import { auditKeys } from '../lib/keysAudit.js';
import { activeDirectoryCount } from '../lib/decay.js';
import { recordTouchAndMaybeTierUp } from '../lib/touchDensity.js';
import { appendEntryAudit, appendMetaAudit, latestEntryAudit } from '../lib/audit.js';
import { createHash } from 'node:crypto';

const DIRECTORY_LIMIT = 100;
const TIMELINE_MAX_CHARS = 5000;
const ENTRY_TYPES = ['rule', 'letter', 'event', 'project', 'stream'];
const META_KEYS = ['identity_self', 'identity_tang', 'timeline', 'now', 'window_letter'];
const PATCH_FIELDS = ['keys', 'hook', 'body', 'trigger_date', 'trigger_done', 'anchor', 'weight'];

class WriteError extends Error {}

function getEntry(id) {
  return db.prepare('SELECT * FROM hearth_entries WHERE id = ?').get(id);
}

// 目录限额只挡"将进目录"的条目；rule/letter/stream/sealed 不进目录，不受限
function willEnterDirectory(entry) {
  return ['event', 'project'].includes(entry.type) && !entry.sealed;
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new WriteError('entry 缺失');
  if (!ENTRY_TYPES.includes(entry.type)) throw new WriteError(`type 必须是 ${ENTRY_TYPES.join('/')}`);
  if (!entry.hook || typeof entry.hook !== 'string') throw new WriteError('hook 必填（一句话钩子）');
  if (!entry.body || typeof entry.body !== 'string') throw new WriteError('body 必填');
  if (entry.keys !== undefined && !Array.isArray(entry.keys)) throw new WriteError('keys 必须是数组');
  if (entry.anchor !== undefined
      && (!Number.isInteger(entry.anchor) || entry.anchor < 0 || entry.anchor > 3)) {
    throw new WriteError('anchor 必须是 0-3 的整数');
  }
  if (entry.weight !== undefined
      && (!Number.isInteger(entry.weight) || entry.weight < 1 || entry.weight > 5)) {
    throw new WriteError('weight 必须是 1-5 的整数');
  }
  // canonical 语义：空串不是"没有日期"，禁止悄悄转 null
  if (entry.trigger_date === '') throw new WriteError('trigger_date 空串非法（无日期用 null 或不传）');
  // ③ origin 摘要：可选；空串非法（没有来源就不传，unknown 是显式语义不是空串）
  if (entry.origin !== undefined && entry.origin !== null
      && (typeof entry.origin !== 'string' || entry.origin === '')) {
    throw new WriteError('origin 必须是非空字符串（没有来源就不传）');
  }
  return {
    type: entry.type,
    keys: entry.keys || [],
    hook: entry.hook,
    body: entry.body,
    trigger_date: entry.trigger_date ?? null,
    sealed: entry.sealed ? 1 : 0,
    anchor: entry.anchor === undefined ? 0 : entry.anchor,
    weight: entry.weight === undefined ? 3 : entry.weight,
    origin: entry.origin ?? null,
    sources: validateSources(entry.sources),
  };
}

// ③ 来源记录校验：kind/summary 必填，excerpt/range 可选
function validateSources(sources) {
  if (sources === undefined || sources === null) return [];
  if (!Array.isArray(sources)) throw new WriteError('sources 必须是数组');
  return sources.map((s, i) => {
    if (!s || typeof s !== 'object') throw new WriteError(`sources[${i}] 必须是对象`);
    if (!s.kind || typeof s.kind !== 'string') throw new WriteError(`sources[${i}].kind 必填（如 campfire-chat/manual/diary）`);
    if (!s.summary || typeof s.summary !== 'string') throw new WriteError(`sources[${i}].summary 必填（一句话来源说明）`);
    if (s.excerpt !== undefined && typeof s.excerpt !== 'string') throw new WriteError(`sources[${i}].excerpt 必须是字符串`);
    if (s.range !== undefined && typeof s.range !== 'string') throw new WriteError(`sources[${i}].range 必须是字符串`);
    return { kind: s.kind, summary: s.summary, excerpt: s.excerpt ?? null, range: s.range ?? null };
  });
}

// ③ 落库：hearth_sources 行不可变；checksum = sha256(excerpt)，无摘录则 null
function insertSources(entryId, sources, revisionOf = null) {
  const t = now();
  const ids = [];
  for (const s of sources) {
    const sourceId = nanoid(12);
    const checksum = s.excerpt === null ? null
      : createHash('sha256').update(s.excerpt, 'utf8').digest('hex');
    db.prepare(`
      INSERT INTO hearth_sources (source_id, kind, summary, excerpt, range, checksum, revision_of, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sourceId, s.kind, s.summary, s.excerpt, s.range, checksum, revisionOf, t);
    db.prepare('INSERT INTO entry_sources (entry_id, source_id, created_at) VALUES (?, ?, ?)')
      .run(entryId, sourceId, t);
    ids.push(sourceId);
  }
  return ids;
}

function insertEntry(e, supersedes = null) {
  const id = nanoid(12);
  const t = now();
  db.prepare(`
    INSERT INTO hearth_entries
      (id, type, keys, hook, body, trigger_date, sealed, anchor, weight, tier_since,
       last_accessed, status, supersedes, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(id, e.type, JSON.stringify(e.keys), e.hook, e.body, e.trigger_date,
         e.sealed, e.anchor, e.weight, e.anchor > 0 ? t : null, t, supersedes, e.origin, t, t);
  insertSources(id, e.sources); // 来源先挂上，审计指纹才能把它们算进去
  return id;
}

function checkDirectoryLimit(entry) {
  if (willEnterDirectory(entry) && activeDirectoryCount() >= DIRECTORY_LIMIT) {
    throw new WriteError(`目录满 ${DIRECTORY_LIMIT} 条，拒绝写入，先清理（合并或沉流水）`);
  }
}

const ops = {
  create({ entry }) {
    const e = validateEntry(entry);
    checkDirectoryLimit(e);
    const id = insertEntry(e);
    const contentSha = appendEntryAudit(id, 'create');
    return { id, content_sha256: contentSha, keys_collision: auditKeys(e.keys, id) };
  },

  supersede({ id, entry }) {
    const old = getEntry(id);
    if (!old) throw new WriteError(`条目 ${id} 不存在`);
    if (old.status !== 'active') throw new WriteError(`条目 ${id} 状态为 ${old.status}，只能盖活跃条目`);
    const e = validateEntry(entry);
    snapshotEntry(old, 'supersede');
    db.prepare(`UPDATE hearth_entries SET status = 'superseded', updated_at = ? WHERE id = ?`)
      .run(now(), id);
    appendEntryAudit(id, 'supersede'); // 旧条的状态变更也是一次写入
    checkDirectoryLimit(e); // 旧条已退场再数，一换一不会被误挡
    const newId = insertEntry(e, id);
    const contentSha = appendEntryAudit(newId, 'create');
    return { id: newId, content_sha256: contentSha, keys_collision: auditKeys(e.keys, newId) };
  },

  update({ id, patch }) {
    const old = getEntry(id);
    if (!old) throw new WriteError(`条目 ${id} 不存在`);
    if (!patch || typeof patch !== 'object') throw new WriteError('patch 缺失');
    const fields = Object.keys(patch).filter((k) => PATCH_FIELDS.includes(k));
    if (fields.length === 0) throw new WriteError(`patch 只允许改 ${PATCH_FIELDS.join('/')}`);
    if (patch.keys !== undefined && !Array.isArray(patch.keys)) throw new WriteError('keys 必须是数组');
    if (patch.anchor !== undefined
        && (!Number.isInteger(patch.anchor) || patch.anchor < 0 || patch.anchor > 3)) {
      throw new WriteError('anchor 必须是 0-3 的整数');
    }
    if (patch.weight !== undefined
        && (!Number.isInteger(patch.weight) || patch.weight < 1 || patch.weight > 5)) {
      throw new WriteError('weight 必须是 1-5 的整数');
    }
    if (patch.trigger_date === '') throw new WriteError('trigger_date 空串非法（无日期用 null）');
    snapshotEntry(old, 'update');
    const t = now();
    const sets = fields.map((f) => `${f} = ?`);
    const values = fields.map((f) => (f === 'keys' ? JSON.stringify(patch.keys) : patch[f]));
    if (patch.anchor !== undefined) {
      sets.push('tier_since = ?');
      values.push(t);
    }
    // 原地改 = 又想起它了，衰退时钟重置
    db.prepare(`UPDATE hearth_entries SET ${sets.join(', ')}, last_accessed = ?, updated_at = ? WHERE id = ?`)
      .run(...values, t, t, id);
    appendEntryAudit(id, 'update');
    // 升星改 anchor（canonical 字段），tier_up 审计行由 touchDensity 自己追加，
    // 顺序保证最新 revision 始终等于落盘终态
    const tierUp = recordTouchAndMaybeTierUp(id, t);
    const keys = patch.keys !== undefined ? patch.keys : JSON.parse(old.keys);
    return {
      id,
      content_sha256: latestEntryAudit(id).content_sha256,
      tier_up: tierUp || undefined,
      keys_collision: auditKeys(keys, id),
    };
  },

  retire({ id }) {
    const old = getEntry(id);
    if (!old) throw new WriteError(`条目 ${id} 不存在`);
    snapshotEntry(old, 'retire');
    db.prepare(`UPDATE hearth_entries SET status = 'retired', updated_at = ? WHERE id = ?`)
      .run(now(), id);
    const contentSha = appendEntryAudit(id, 'retire');
    return { id, content_sha256: contentSha, keys_collision: [] };
  },

  // ③ 修正来源：旧 hearth_sources 行原样保留（写路径不原地改，非 DB 级不可变），新行 revision_of 指回去，
  // entry_sources 链接换到新 revision。指纹随链接变化，审计留 source_revise 行。
  source_revise({ id, source_id, source }) {
    const entry = getEntry(id);
    if (!entry) throw new WriteError(`条目 ${id} 不存在`);
    const link = db.prepare('SELECT * FROM entry_sources WHERE entry_id = ? AND source_id = ?')
      .get(id, source_id);
    if (!link) throw new WriteError(`条目 ${id} 没有挂载来源 ${source_id}`);
    const validated = validateSources([source]);
    if (validated.length !== 1) throw new WriteError('source_revise 一次修正一条来源');
    db.prepare('DELETE FROM entry_sources WHERE entry_id = ? AND source_id = ?').run(id, source_id);
    const [newSourceId] = insertSources(id, validated, source_id);
    const contentSha = appendEntryAudit(id, 'source_revise');
    return { id, source_id: newSourceId, revision_of: source_id, content_sha256: contentSha, keys_collision: [] };
  },

  meta_set({ key, content }) {
    if (!META_KEYS.includes(key)) throw new WriteError(`meta key 必须是 ${META_KEYS.join('/')}`);
    if (typeof content !== 'string') throw new WriteError('content 必须是字符串');
    const old = db.prepare('SELECT * FROM hearth_meta WHERE key = ?').get(key);
    const t = now();
    if (old) {
      snapshotMeta(old, 'meta_set');
      db.prepare('UPDATE hearth_meta SET content = ?, updated_at = ? WHERE key = ?')
        .run(content, t, key);
    } else {
      db.prepare('INSERT INTO hearth_meta (key, content, updated_at) VALUES (?, ?, ?)')
        .run(key, content, t);
    }
    const contentSha = appendMetaAudit(key, content, 'meta_set');
    return { id: key, content_sha256: contentSha, keys_collision: [] };
  },
};

export function handleWrite(payload) {
  const { op } = payload || {};
  if (!ops[op]) {
    return { status: 400, body: { error: `op 必须是 ${Object.keys(ops).join('/')}` } };
  }
  try {
    const result = transaction(() => ops[op](payload));
    const count = activeDirectoryCount();
    const timeline = db.prepare(`SELECT content FROM hearth_meta WHERE key = 'timeline'`).get();
    return {
      status: 200,
      body: {
        ok: true,
        ...result,
        directory_count: count,
        directory_warning: count >= DIRECTORY_LIMIT ? `目录已满 ${DIRECTORY_LIMIT} 条` : null,
        timeline_hint: timeline && timeline.content.length > TIMELINE_MAX_CHARS
          ? `主线超 ${TIMELINE_MAX_CHARS} 字，请压缩后 meta_set 写回` : null,
      },
    };
  } catch (err) {
    if (err instanceof WriteError) return { status: 400, body: { error: err.message } };
    throw err;
  }
}
