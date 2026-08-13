import { db } from '../db.js';
import { activeDirectoryRows } from '../lib/decay.js';

const TIMELINE_MAX_CHARS = 5000;
const TIMELINE_STALE_DAYS = 30;
const ECHO_MIN_AGE_DAYS = 30;

function getMeta(key) {
  return db.prepare('SELECT content, updated_at FROM hearth_meta WHERE key = ?').get(key) || null;
}

export function handleLoad(mode) {
  const identitySelf = getMeta('identity_self');
  const identityHuman = getMeta('identity_human');
  const timeline = getMeta('timeline');
  const nowMeta = getMeta('now');
  const windowLetter = getMeta('window_letter');

  // rule 常驻例外：等触发就晚了，全文随身份卡返回，不衰退
  const rules = db.prepare(`
    SELECT id, hook, body FROM hearth_entries
    WHERE type = 'rule' AND status = 'active' AND sealed = 0
    ORDER BY created_at ASC
  `).all();

  const directory = activeDirectoryRows().map((r) => `[${r.type}] ${r.hook}`);

  // 权重5 = 新窗口必读：不等触发，load 时全文带出（rule 已常驻，不重复取）
  const coreMemories = db.prepare(`
    SELECT id, hook, body, weight FROM hearth_entries
    WHERE weight = 5 AND status = 'active' AND sealed = 0 AND type != 'rule'
    ORDER BY created_at ASC
  `).all();

  // 今日浮现：到期未处理的时间触发（含错过的日子——那天没开窗口不该静默丢失）
  const todaySurfacing = db.prepare(`
    SELECT id, hook, trigger_date FROM hearth_entries
    WHERE trigger_date IS NOT NULL AND trigger_done = 0 AND status = 'active'
      AND trigger_date <= date('now')
    ORDER BY trigger_date ASC
  `).all();

  // 感受回声：存在超 30 天的经历体条目随机一条，不去重——旧日记被风翻到某一页。
  // 只算浮现不算复习，不更新 last_accessed。
  const echo = db.prepare(`
    SELECT id, hook, body, created_at FROM hearth_entries
    WHERE type IN ('event','project','stream') AND status = 'active' AND sealed = 0
      AND created_at <= datetime('now', '-${ECHO_MIN_AGE_DAYS} days')
    ORDER BY RANDOM() LIMIT 1
  `).get() || null;

  // 最近日记只浮现摘要，不算复习；小机显式 touch 展开时才重置衰退并记触发。
  // 按 created_at 取——"最近"指最近写下的，不是最近被翻到的；
  // 用 last_accessed 会让刚 touch 过的老日记冒充新日记。
  const recentDiary = db.prepare(`
    SELECT id, hook, substr(body, 1, 100) AS excerpt
    FROM hearth_entries
    WHERE type = 'stream' AND status = 'active' AND sealed = 0
      AND created_at >= datetime('now', '-2 days')
    ORDER BY created_at DESC
    LIMIT 6
  `).all();

  let timelineHint = null;
  if (timeline) {
    if (timeline.content.length > TIMELINE_MAX_CHARS) {
      timelineHint = `主线超 ${TIMELINE_MAX_CHARS} 字，请在对话里压缩后 meta_set 写回`;
    } else {
      const stale = db.prepare(
        `SELECT updated_at < datetime('now', '-${TIMELINE_STALE_DAYS} days') AS s
         FROM hearth_meta WHERE key = 'timeline'`
      ).get();
      if (stale && stale.s) timelineHint = `主线 ${TIMELINE_STALE_DAYS} 天未更新，看看有没有该记的里程碑`;
    }
  }

  const payload = {
    identity: {
      self: identitySelf ? identitySelf.content : null,
      human: identityHuman ? identityHuman.content : null,
    },
    rules,
    timeline: timeline ? timeline.content : null,
    now: nowMeta ? nowMeta.content : null,
    window_letter: windowLetter
      ? { content: windowLetter.content, updated_at: windowLetter.updated_at }
      : null,
    directory,
    core_memories: coreMemories,
    today_surfacing: todaySurfacing,
    echo,
    recent_diary: recentDiary,
    timeline_hint: timelineHint,
  };

  return payload;
}
