// ② 恢复演练补充测试（溯，2026-08-13）
//
// 主实现已覆盖②验收 1-4（backup-restore.test.js，8 条）。本文件补未覆盖的边角：
//   - 密钥自检：源库文件名含 token 字样 → 备份必须中止
//   - 备份命名：同秒连续备份 → 名称不同（-N 后缀），都有效
//   - 空库备份：0 条目 → 备份 + 演练通过
//   - 演练不留残渣：rehearsal 后 outDir 只有 db + manifest
//   - --live 边界：缺 --db 拒绝；目标不存在 → 直接落位可回滚；WAL 残留清理
//   - 编码体检：分散的单个问号（不连续）不误报
//
// 全程只用临时测试库，不碰任何真库。
// 跑：node --test test/recovery-supplement.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'hearth-recovery-supp-'));
process.env.HEARTH_DB_PATH = join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { handleWrite } = await import('../src/routes/write.js');
const { runBackup } = await import('../scripts/backup.mjs');
const { runRestore, RestoreRefused } = await import('../scripts/restore.mjs');
const { checkDatabase } = await import('../scripts/encoding-check.mjs');

const outDir = join(dir, 'backups');

before(() => {
  // 给真库播种两条，供备份/恢复计数断言使用
  handleWrite({ op: 'create', entry: { type: 'event', keys: ['恢复探针一'], hook: '钩子一', body: '正文一' } });
  handleWrite({ op: 'create', entry: { type: 'event', keys: ['恢复探针二'], hook: '钩子二', body: '正文二' } });
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedOne(dbPath) {
  const d = new DatabaseSync(dbPath);
  d.exec('CREATE TABLE IF NOT EXISTS hearth_entries (id TEXT, hook TEXT, body TEXT); CREATE TABLE IF NOT EXISTS hearth_meta (key TEXT, content TEXT); CREATE TABLE IF NOT EXISTS hearth_history (history_id INTEGER); CREATE TABLE IF NOT EXISTS hearth_touch_log (log_id INTEGER); CREATE TABLE IF NOT EXISTS hearth_write_audit (revision INTEGER); CREATE TABLE IF NOT EXISTS hearth_sources (source_id TEXT); CREATE TABLE IF NOT EXISTS entry_sources (entry_id TEXT);');
  d.prepare('INSERT INTO hearth_entries VALUES (?, ?, ?)').run('e1', 'h', 'b');
  d.close();
}

test('密钥自检：源库文件名含 token 字样 → 备份中止（outDir 不得多出任何文件）', () => {
  const secretDb = join(dir, 'token-backup-2026.db');
  seedOne(secretDb);
  mkdirSync(outDir, { recursive: true }); // runBackup 内部才建 outDir，先确保存在再快照
  const before = readdirSync(outDir).sort();
  assert.throws(
    () => runBackup({ dbPath: secretDb, outDir }),
    /疑似含密钥字样/,
    'manifest.source_db 会暴露文件名中的 token，必须中止',
  );
  // 二审抓过：孤儿备份实际叫 hearth-*.db，不是 token-backup——按文件集合全量比对，别按名字猜
  assert.deepEqual(readdirSync(outDir).sort(), before, '中止后 outDir 不得多出任何文件（含 hearth-*.db 孤儿）');
});

test('备份命名：同秒连续两次备份 → 名称不同且都有效', () => {
  const first = runBackup({ dbPath: process.env.HEARTH_DB_PATH, outDir });
  const second = runBackup({ dbPath: process.env.HEARTH_DB_PATH, outDir });
  assert.notEqual(first.backupPath, second.backupPath, '同秒备份必须用 -N 后缀区分');
  assert.equal(runRestore({ backupPath: first.backupPath }).ok, true);
  assert.equal(runRestore({ backupPath: second.backupPath }).ok, true);
});

test('空库备份：0 条目 → 备份 + 演练通过，计数为 0', () => {
  const emptyDb = join(dir, 'empty.db');
  const d = new DatabaseSync(emptyDb);
  d.exec('CREATE TABLE hearth_entries (id TEXT); CREATE TABLE hearth_meta (key TEXT); CREATE TABLE hearth_history (history_id INTEGER); CREATE TABLE hearth_touch_log (log_id INTEGER); CREATE TABLE hearth_write_audit (revision INTEGER); CREATE TABLE hearth_sources (source_id TEXT); CREATE TABLE entry_sources (entry_id TEXT);');
  d.close();
  const { backupPath, manifest } = runBackup({ dbPath: emptyDb, outDir });
  assert.equal(manifest.counts.entries, 0);
  assert.equal(runRestore({ backupPath }).ok, true);
});

test('演练不留残渣：rehearsal 后 outDir 只有 db + manifest，无临时文件', () => {
  const { backupPath } = runBackup({ dbPath: process.env.HEARTH_DB_PATH, outDir });
  runRestore({ backupPath }); // 演练
  const base = backupPath.split(/[\\/]/).pop().replace(/\.db$/, '');
  const files = readdirSync(outDir).filter((f) => f.startsWith(base)).sort();
  assert.deepEqual(files, [`${base}.db`, `${base}.db.manifest.json`].sort(), '演练不得在 outDir 留下临时副本');
});

test('--live 缺 --db → 拒绝；目标不存在 → 直接落位，回滚为 null', () => {
  const { backupPath } = runBackup({ dbPath: process.env.HEARTH_DB_PATH, outDir });
  assert.throws(() => runRestore({ backupPath, live: true }), RestoreRefused, '--live 必须指定 --db');

  const freshTarget = join(dir, 'fresh-target.db');
  const result = runRestore({ backupPath, targetPath: freshTarget, live: true });
  assert.equal(result.mode, 'live');
  assert.equal(result.rollback, null, '目标不存在时无旧库可回滚');
  const fresh = new DatabaseSync(freshTarget, { readOnly: true });
  const freshCount = fresh.prepare('SELECT COUNT(*) AS c FROM hearth_entries').get().c;
  fresh.close();
  assert.equal(freshCount, 2, '落位后计数应等于备份');
});

test('live 切换：目标库 WAL 残留被 checkpoint 清理，无 -wal/-shm 遗留，回滚保留旧内容', () => {
  const { backupPath } = runBackup({ dbPath: process.env.HEARTH_DB_PATH, outDir });

  const liveDir = mkdtempSync(join(tmpdir(), 'hearth-livewal-'));
  try {
    const targetPath = join(liveDir, 'prod.db');
    const target = new DatabaseSync(targetPath);
    target.exec('PRAGMA journal_mode = WAL; CREATE TABLE hearth_entries (id TEXT, hook TEXT, body TEXT); CREATE TABLE placeholder (x INT); INSERT INTO placeholder VALUES (42)');
    target.close();
    // 制造 WAL 残留：再开一次写入后不干净关闭
    const writer = new DatabaseSync(targetPath);
    writer.exec('INSERT INTO placeholder VALUES (7)');
    writer.close();

    const result = runRestore({ backupPath, targetPath, live: true });
    assert.equal(result.mode, 'live');
    assert.ok(result.rollback && existsSync(result.rollback), '旧库必须保留');
    // 回滚文件里是旧内容（placeholder 表还在，entries 表是占位的空表）
    const rollbackDb = new DatabaseSync(result.rollback, { readOnly: true });
    const placeholderCount = rollbackDb.prepare('SELECT COUNT(*) AS c FROM placeholder').get().c;
    rollbackDb.close();
    assert.equal(placeholderCount, 2, '回滚文件应保留旧库内容');
    // 目标库落位为备份内容，且无 WAL/SHM 残留
    assert.ok(!existsSync(`${targetPath}-wal`), '切换后不得留 -wal 残留');
    assert.ok(!existsSync(`${targetPath}-shm`), '切换后不得留 -shm 残留');
    const restored = new DatabaseSync(targetPath, { readOnly: true });
    const entries = restored.prepare('SELECT COUNT(*) AS c FROM hearth_entries').get().c;
    restored.close();
    assert.equal(entries, 2, '目标库应是备份内容');
  } finally {
    rmSync(liveDir, { recursive: true, force: true });
  }
});

test('liveSwap：目标损坏（非 SQLite）→ 抛错、目标原样、.incoming 被 finally 清理', () => {
  const { backupPath } = runBackup({ dbPath: process.env.HEARTH_DB_PATH, outDir });
  const swapDir = mkdtempSync(join(tmpdir(), 'hearth-corrupt-'));
  try {
    const targetPath = join(swapDir, 'prod.db');
    writeFileSync(targetPath, 'PRETEND-DB-CONTENT-NOT-SQLITE');
    const before = readFileSync(targetPath);
    assert.throws(() => runRestore({ backupPath, targetPath, live: true }));
    assert.deepEqual(readFileSync(targetPath), before, '损坏目标不得被改动');
    const residue = readdirSync(swapDir).filter((f) => f.includes('.incoming'));
    assert.deepEqual(residue, [], '损坏目标路径必须由 finally 清理 .incoming（三审观察，同 finally 已堵）');
  } finally {
    rmSync(swapDir, { recursive: true, force: true });
  }
});

test('编码体检：中文字段里分散的单个问号（不连续）不误报', () => {
  const probeDir = mkdtempSync(join(tmpdir(), 'hearth-encsupp-'));
  try {
    const probeDb = join(probeDir, 'probe.db');
    const pdb = new DatabaseSync(probeDb);
    pdb.exec('CREATE TABLE hearth_entries (id TEXT, hook TEXT, body TEXT); CREATE TABLE hearth_meta (key TEXT, content TEXT);');
    pdb.prepare('INSERT INTO hearth_entries VALUES (?, ?, ?)').run(
      'scattered',
      '钩子',
      '你今天吃了吗? 我去? 他也? 反正都正常',
    );
    pdb.prepare('INSERT INTO hearth_entries VALUES (?, ?, ?)').run(
      'run3',
      '钩子',
      '???这里连续三个',
    );
    pdb.close();
    const findings = checkDatabase(probeDb);
    const wheres = findings.map((f) => f.where).join('|');
    assert.ok(!wheres.includes('scattered'), '分散单问号不得误报（终审护栏2）');
    assert.ok(wheres.includes('run3'), '连续问号必须报');
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
});
