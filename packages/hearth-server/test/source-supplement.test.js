// ③ source 证据补充测试（溯，2026-08-13）
//
// 按《测试清单_③source证据_溯_20260813.md》18 条写，主实现已覆盖的（7 条验收：
// 手改链接被 verify 抓出、插入顺序无关、origin 空串拒收等）不重复。
// 本文件补：origin 语义、一对多+校验值、不可变 revision、sealed 继承、
// source 进 canonical（含空 sources 兼容）、legacy no_audit、备份回归。
//
// 跑：node --test test/source-supplement.test.js

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hearth-source-supp-'));
process.env.HEARTH_DB_PATH = join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { handleWrite } = await import('../src/routes/write.js');
const { handleSources } = await import('../src/routes/sources.js');
const { handleVerify } = await import('../src/routes/verify.js');
const { contentSha256, entryRowToPayload } = await import('../src/lib/canonical.js');
const { runBackup } = await import('../scripts/backup.mjs');
const { runRestore } = await import('../scripts/restore.mjs');

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ── A. origin 摘要列 ──

test('A1/A2：create 带 origin → handleSources 返回它；不带 → 显式 unknown（不是 manual）', () => {
  const withOrigin = handleWrite({ op: 'create', entry: { type: 'event', keys: ['k'], hook: 'h', body: 'b', origin: 'campfire-chat/message/abc' } });
  assert.equal(handleSources(withOrigin.body.id).body.origin, 'campfire-chat/message/abc');
  const noOrigin = handleWrite({ op: 'create', entry: { type: 'event', keys: ['k'], hook: 'h', body: 'b' } });
  assert.equal(handleSources(noOrigin.body.id).body.origin, 'unknown', 'NULL 显式呈现为 unknown');
});

test('A3：origin 空串拒绝；超长 origin 当前可入（校验边界如实记录）', () => {
  const empty = handleWrite({ op: 'create', entry: { type: 'event', keys: ['k'], hook: 'h', body: 'b', origin: '' } });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /origin 必须是非空字符串/);
  // 当前实现只校验非空字符串，无长度上限——记录此边界，不假设不存在的行为
  const long = handleWrite({ op: 'create', entry: { type: 'event', keys: ['k'], hook: 'h', body: 'b', origin: 'x'.repeat(300) } });
  assert.equal(long.status, 200, '超长 origin 当前未被拒（长度校验未实现，已知边界）');
});

// ── B. 一对多来源 + 校验值 + 不可变 revision ──

test('B1/B2：一条记忆挂两条来源，checksum = sha256(excerpt)，无摘录为 null', () => {
  const excerptA = '群里的原话：这个参数不对';
  const created = handleWrite({
    op: 'create',
    entry: {
      type: 'event', keys: ['k'], hook: 'h', body: 'b',
      sources: [
        { kind: 'campfire-chat', summary: '群消息 msg_1', excerpt: excerptA, range: 'L12-L14' },
        { kind: 'manual', summary: '手动记录' }, // 无摘录 = 不传该字段（null 会被校验拒绝）
      ],
    },
  });
  const id = created.body.id;
  const res = handleSources(id);
  assert.equal(res.status, 200);
  assert.equal(res.body.sources.length, 2, '一对多：两条来源');
  const byKind = Object.fromEntries(res.body.sources.map((s) => [s.kind, s]));
  assert.equal(byKind['campfire-chat'].checksum, sha256(excerptA), 'checksum 必须是摘录的 sha256');
  assert.equal(byKind['campfire-chat'].range, 'L12-L14');
  assert.equal(byKind['manual'].checksum, null, '无摘录 → checksum null');
});

test('B3：source_revise → 旧行原样保留（不可变），新行 revision_of 指回，链接已切换', () => {
  const created = handleWrite({
    op: 'create',
    entry: { type: 'event', keys: ['k'], hook: 'h', body: 'b', sources: [{ kind: 'campfire-chat', summary: '旧摘要', excerpt: '旧原文' }] },
  });
  const id = created.body.id;
  const oldSourceId = handleSources(id).body.sources[0].source_id;

  const revised = handleWrite({ op: 'source_revise', id, source_id: oldSourceId, source: { kind: 'campfire-chat', summary: '新摘要', excerpt: '新原文' } });
  assert.equal(revised.status, 200);
  assert.equal(revised.body.revision_of, oldSourceId, '新行 revision_of 指回旧行');
  assert.equal(revised.body.content_sha256, handleVerify(id).body.current_sha256, '审计指纹含新链接');

  // 旧行不可变：仍在 hearth_sources，内容原样
  const oldRow = db.prepare('SELECT * FROM hearth_sources WHERE source_id = ?').get(oldSourceId);
  assert.equal(oldRow.summary, '旧摘要', '旧行必须原样保留');
  assert.equal(oldRow.excerpt, '旧原文');
  // 链接已切到新 revision
  const current = handleSources(id);
  assert.equal(current.body.sources.length, 1, '当前只挂新 revision');
  assert.equal(current.body.sources[0].source_id, revised.body.source_id);
  assert.equal(current.body.sources[0].revision_of, oldSourceId);
  // 追溯链：新行 checksum 可复算
  assert.equal(current.body.sources[0].checksum, sha256('新原文'));
});

test('B4：修订另一条来源后旧链仍在（多来源独立 revision）', () => {
  const created = handleWrite({
    op: 'create',
    entry: {
      type: 'event', keys: ['k'], hook: 'h', body: 'b',
      sources: [
        { kind: 'campfire-chat', summary: '甲', excerpt: '甲原文' },
        { kind: 'diary', summary: '乙', excerpt: '乙原文' },
      ],
    },
  });
  const id = created.body.id;
  const before = handleSources(id).body.sources;
  const bSource = before.find((s) => s.kind === 'diary');
  handleWrite({ op: 'source_revise', id, source_id: bSource.source_id, source: { kind: 'diary', summary: '乙修订', excerpt: '乙新原文' } });
  const after = handleSources(id).body.sources;
  assert.equal(after.length, 2, '修订一条不影响另一条');
  const aAfter = after.find((s) => s.kind === 'campfire-chat');
  assert.equal(aAfter.source_id, before.find((s) => s.kind === 'campfire-chat').source_id, '未修订的来源保持原链接');
  assert.equal(after.find((s) => s.kind === 'diary').revision_of, bSource.source_id);
});

// ── C. sealed 继承 ──

test('C1/C2：sealed 条目来源 403 且零摘录；非 sealed 正常可见', () => {
  const sealed = handleWrite({
    op: 'create',
    entry: { type: 'event', keys: ['k'], hook: 'h', body: 'b', sealed: true, sources: [{ kind: 'campfire-chat', summary: '秘密来源', excerpt: '不该外泄' }] },
  });
  const sealedRes = handleSources(sealed.body.id);
  assert.equal(sealedRes.status, 403);
  const text = JSON.stringify(sealedRes.body);
  assert.ok(!text.includes('不该外泄') && !text.includes('秘密来源'), 'sealed 响应必须零摘录零摘要');

  const open = handleWrite({
    op: 'create',
    entry: { type: 'event', keys: ['k'], hook: 'h', body: 'b', sources: [{ kind: 'campfire-chat', summary: '公开来源', excerpt: '可看' }] },
  });
  assert.equal(handleSources(open.body.id).status, 200);
});

// ── D. source 进 canonical / 审计 ──

test('D1：origin 进指纹——带与不带 hash 不同', () => {
  const base = { type: 'event', keys: ['k'], hook: 'h', body: 'b', status: 'active' };
  assert.notEqual(contentSha256(base), contentSha256({ ...base, origin: 'campfire-chat/message/x' }));
});

test('D2：不同 origin 的 create → 审计指纹不同，verify 都通过', () => {
  const a = handleWrite({ op: 'create', entry: { type: 'event', keys: ['k'], hook: 'h', body: 'b', origin: '来源甲' } });
  const b = handleWrite({ op: 'create', entry: { type: 'event', keys: ['k'], hook: 'h', body: 'b', origin: '来源乙' } });
  assert.notEqual(a.body.content_sha256, b.body.content_sha256, 'origin 是受审计字段');
  assert.equal(handleVerify(a.body.id).body.verified, true);
  assert.equal(handleVerify(b.body.id).body.verified, true);
});

test('D3：绕过写路径手改 origin → verify = hash_mismatch', () => {
  const created = handleWrite({ op: 'create', entry: { type: 'event', keys: ['k'], hook: 'h', body: 'b', origin: '真来源' } });
  const id = created.body.id;
  assert.equal(handleVerify(id).body.verified, true);
  db.prepare('UPDATE hearth_entries SET origin = ? WHERE id = ?').run('被手改的来源', id);
  const after = handleVerify(id);
  assert.equal(after.body.verified, false);
  assert.equal(after.body.reason, 'hash_mismatch');
});

test('D4：sources 入指纹按 source_id 稳定排序（终审护栏1），空 sources 不编码（兼容决定）', () => {
  const s1 = { source_id: 'b', checksum: 'hash-b' };
  const s2 = { source_id: 'a', checksum: 'hash-a' };
  const base = { type: 'event', keys: ['k'], hook: 'h', body: 'b', status: 'active' };
  const ab = contentSha256({ ...base, sources: [s1, s2] });
  const ba = contentSha256({ ...base, sources: [s2, s1] });
  assert.equal(ab, ba, '插入顺序无关（按 source_id 稳定排序）');
  // 兼容：空 sources 不编码，与不带 sources 的旧指纹一致
  assert.equal(contentSha256(base), contentSha256({ ...base, sources: [] }), '空 sources 必须与旧指纹连续');
});

test('D5：legacy 条目（无 origin/无 sources/无审计）→ verify no_audit，不误报', () => {
  const t = db.prepare(`SELECT datetime('now') AS t`).get().t;
  db.prepare(`
    INSERT INTO hearth_entries (id, type, keys, hook, body, sealed, anchor, last_accessed, status, created_at, updated_at)
    VALUES ('legacy_source_probe', 'event', '["旧"]', 'h', 'b', 0, 0, ?, 'active', ?, ?)
  `).run(t, t, t);
  const res = handleVerify('legacy_source_probe');
  assert.equal(res.body.verified, null);
  assert.equal(res.body.reason, 'no_audit');
  assert.equal(handleSources('legacy_source_probe').body.origin, 'unknown', 'legacy origin 呈现为 unknown');
});

// ── E. 回归 ──

test('E2：③ 之后备份+演练仍通过（新表随 VACUUM 进快照，计数核对不受影响）', () => {
  const outDir = join(dir, 'backups');
  const { backupPath } = runBackup({ dbPath: process.env.HEARTH_DB_PATH, outDir });
  const result = runRestore({ backupPath });
  assert.equal(result.mode, 'rehearsal');
  assert.equal(result.ok, true);
});
