// ② 备份恢复/编码体检 验收测试
//
// 对应《方案_地基定稿_溯_20260813.md》②的验收清单：
//   1. 备份 manifest 被覆盖/篡改 → 该备份被识别为无效
//   2. restore 旁路演练通过（临时库）；生产切换有停写窗口且可回滚
//   3. 备份内无任何密钥（扫描确认无 token/seal 字样）
//   4. 体检能检出：CRLF 混用、多余 BOM、数据中的"?"/U+FFFD
// 护栏 2：正常问句的单个"?"不误报。
//
// 全程只用临时测试库——生产演练是另一回事，这里不碰任何真库。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'hearth-backup-'));
process.env.HEARTH_DB_PATH = join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { handleWrite } = await import('../src/routes/write.js');
const { runBackup } = await import('../scripts/backup.mjs');
const { runRestore, RestoreRefused } = await import('../scripts/restore.mjs');
const { checkDatabase, checkRepo } = await import('../scripts/encoding-check.mjs');

const outDir = join(dir, 'backups');

before(() => {
  handleWrite({ op: 'create', entry: { type: 'event', keys: ['备份探针一'], hook: '钩子一', body: '正文一' } });
  handleWrite({ op: 'create', entry: { type: 'event', keys: ['备份探针二'], hook: '钩子二', body: '正文二' } });
  handleWrite({ op: 'meta_set', key: 'now', content: '当前状态' });
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('备份产出 db + 不可变 manifest，计数与 sha256 相符', () => {
  const { backupPath, manifestPath, manifest } = runBackup({ dbPath: process.env.HEARTH_DB_PATH, outDir });
  assert.ok(existsSync(backupPath));
  assert.ok(existsSync(manifestPath));
  assert.equal(manifest.counts.entries, 2);
  assert.equal(manifest.counts.meta, 1);
  assert.ok(manifest.counts.audit >= 3, '三次写入至少三条审计行');
  assert.equal(manifest.integrity_check, 'ok');
  // 演练走一遍完整校验链
  const result = runRestore({ backupPath });
  assert.equal(result.mode, 'rehearsal');
  assert.equal(result.ok, true);
});

test('验收3：manifest 内无任何密钥字样', () => {
  const files = readdirSync(outDir).filter((f) => f.endsWith('.manifest.json'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = readFileSync(join(outDir, f), 'utf8');
    for (const bad of [/token/i, /secret/i, /password/i, /HEARTH_SEAL/i]) {
      assert.ok(!bad.test(text), `manifest ${f} 含疑似密钥: ${bad}`);
    }
  }
});

test('验收1：篡改备份文件 → 拒绝恢复', () => {
  const { backupPath } = runBackup({ dbPath: process.env.HEARTH_DB_PATH, outDir });
  chmodSync(backupPath, 0o644);
  const buf = readFileSync(backupPath);
  buf[buf.length - 100] ^= 0xFF; // 翻转库文件里的一个字节
  writeFileSync(backupPath, buf);
  assert.throws(() => runRestore({ backupPath }), RestoreRefused, '被改过的备份必须被拒');
});

test('验收1：篡改/覆盖 manifest → 拒绝恢复', () => {
  const { backupPath, manifestPath } = runBackup({ dbPath: process.env.HEARTH_DB_PATH, outDir });
  chmodSync(manifestPath, 0o644);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.counts.entries = 999; // 假装另一份备份的清单盖了过来
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => runRestore({ backupPath }), RestoreRefused);

  writeFileSync(manifestPath, '不是 JSON 的东西');
  assert.throws(() => runRestore({ backupPath }), RestoreRefused);
});

test('manifest 缺失 → 拒绝恢复（没有清单的备份不可信）', () => {
  const { backupPath, manifestPath } = runBackup({ dbPath: process.env.HEARTH_DB_PATH, outDir });
  chmodSync(manifestPath, 0o644);
  rmSync(manifestPath);
  assert.throws(() => runRestore({ backupPath }), RestoreRefused);
});

test('验收2：旁路演练不触碰目标库；--live 切换可回滚', () => {
  const { backupPath } = runBackup({ dbPath: process.env.HEARTH_DB_PATH, outDir });

  // 造一个"生产"临时目标库（内容与备份不同）
  const liveDir = mkdtempSync(join(tmpdir(), 'hearth-live-'));
  try {
    const targetPath = join(liveDir, 'prod.db');
    const target = new DatabaseSync(targetPath);
    target.exec('CREATE TABLE hearth_entries (id TEXT); CREATE TABLE placeholder (x INT)');
    target.close();

    // 演练模式不碰目标
    const beforeBytes = readFileSync(targetPath);
    runRestore({ backupPath, targetPath });
    assert.deepEqual(readFileSync(targetPath), beforeBytes, '演练模式改了目标库——旁路泄漏');

    // live 切换：落位 + 旧库保留可回滚
    const result = runRestore({ backupPath, targetPath, live: true });
    assert.equal(result.mode, 'live');
    assert.ok(result.rollback && existsSync(result.rollback), '旧库必须保留为回滚文件');
    const restored = new DatabaseSync(targetPath, { readOnly: true });
    const count = restored.prepare('SELECT COUNT(*) AS c FROM hearth_entries').get().c;
    restored.close();
    assert.equal(count, 2, '切换后的库应是备份内容');
  } finally {
    rmSync(liveDir, { recursive: true, force: true });
  }
});

test('二审1：备份失败路径清理——密钥自检中止后 outDir 不留孤儿 .db', () => {
  const failDir = mkdtempSync(join(tmpdir(), 'hearth-fail-'));
  try {
    // 源库文件名含 token → manifest.source_db 触发密钥自检 → VACUUM 已产出的 .db 必须被清掉
    const secretDb = join(failDir, 'my-token-store.db');
    const sdb = new DatabaseSync(secretDb);
    sdb.exec(`
      CREATE TABLE hearth_entries (id TEXT); CREATE TABLE hearth_meta (key TEXT);
      CREATE TABLE hearth_history (h INTEGER); CREATE TABLE hearth_touch_log (l INTEGER);
      CREATE TABLE hearth_write_audit (r INTEGER);
      CREATE TABLE hearth_sources (source_id TEXT); CREATE TABLE entry_sources (entry_id TEXT);
    `);
    sdb.close();
    const failOut = join(failDir, 'backups');
    assert.throws(() => runBackup({ dbPath: secretDb, outDir: failOut }), /疑似含密钥字样/);
    const leftovers = existsSync(failOut) ? readdirSync(failOut) : [];
    assert.deepEqual(leftovers, [], `失败后 outDir 必须干净，实际残留: ${leftovers.join(',')}`);
  } finally {
    rmSync(failDir, { recursive: true, force: true });
  }
});

test('二审2：liveSwap 副本缺失 → 抛错且目标丝毫未动、无 .incoming 残留', async () => {
  const { liveSwap } = await import('../scripts/restore.mjs');
  const swapDir = mkdtempSync(join(tmpdir(), 'hearth-swapfail-'));
  try {
    const targetPath = join(swapDir, 'prod.db');
    writeFileSync(targetPath, 'PRETEND-DB-CONTENT');
    const before = readFileSync(targetPath);
    assert.throws(() => liveSwap(join(swapDir, '不存在的副本.db'), targetPath));
    assert.deepEqual(readFileSync(targetPath), before, '复制失败时目标库必须原样');
    const incoming = readdirSync(swapDir).filter((f) => f.includes('.incoming'));
    assert.deepEqual(incoming, [], '不得留下 .incoming 残留');
  } finally {
    rmSync(swapDir, { recursive: true, force: true });
  }
});

test('二审2：切换后复验失败 → 自动回滚旧库，不留未验过的新库', () => {
  const { backupPath } = runBackup({ dbPath: process.env.HEARTH_DB_PATH, outDir });
  const rbDir = mkdtempSync(join(tmpdir(), 'hearth-rollback-'));
  try {
    const targetPath = join(rbDir, 'prod.db');
    const target = new DatabaseSync(targetPath);
    target.exec("CREATE TABLE old_marker (x TEXT)");
    target.prepare('INSERT INTO old_marker VALUES (?)').run('旧库标记');
    target.close();

    assert.throws(
      () => runRestore({
        backupPath, targetPath, live: true,
        _verifyAfterSwap: () => { throw new Error('注入的复验失败'); },
      }),
      /已自动回滚/,
    );
    // 目标位必须是旧库（回滚成功），不是那个没验过的新库
    const restored = new DatabaseSync(targetPath, { readOnly: true });
    const marker = restored.prepare('SELECT x FROM old_marker').get();
    restored.close();
    assert.equal(marker.x, '旧库标记', '复验失败后目标位必须回到旧库');
  } finally {
    rmSync(rbDir, { recursive: true, force: true });
  }
});

test('三审1：VACUUM 自身抛错且已产出残骸 → 残骸被清理，outDir 前后一致', () => {
  const failDir = mkdtempSync(join(tmpdir(), 'hearth-vacfail-'));
  try {
    const srcDb = join(failDir, 'src.db');
    const sdb = new DatabaseSync(srcDb);
    sdb.exec(`
      CREATE TABLE hearth_entries (id TEXT); CREATE TABLE hearth_meta (key TEXT);
      CREATE TABLE hearth_history (h INTEGER); CREATE TABLE hearth_touch_log (l INTEGER);
      CREATE TABLE hearth_write_audit (r INTEGER);
      CREATE TABLE hearth_sources (source_id TEXT); CREATE TABLE entry_sources (entry_id TEXT);
    `);
    sdb.close();
    const failOut = join(failDir, 'backups');
    assert.throws(
      () => runBackup({
        dbPath: srcDb, outDir: failOut,
        _vacuum: (conn, backupPath) => {
          writeFileSync(backupPath, '磁盘满前写了一半的残骸'); // 模拟 VACUUM 中断留下部分文件
          throw new Error('模拟 SQLITE_FULL');
        },
      }),
      /SQLITE_FULL/,
    );
    const leftovers = existsSync(failOut) ? readdirSync(failOut) : [];
    assert.deepEqual(leftovers, [], 'VACUUM 抛错后的残骸必须被清理');
  } finally {
    rmSync(failDir, { recursive: true, force: true });
  }
});

test('三审1：清理自身失败 → 显式上报孤儿，不静默吞掉', () => {
  const failDir = mkdtempSync(join(tmpdir(), 'hearth-rmfail-'));
  try {
    const srcDb = join(failDir, 'src.db');
    const sdb = new DatabaseSync(srcDb);
    sdb.exec(`
      CREATE TABLE hearth_entries (id TEXT); CREATE TABLE hearth_meta (key TEXT);
      CREATE TABLE hearth_history (h INTEGER); CREATE TABLE hearth_touch_log (l INTEGER);
      CREATE TABLE hearth_write_audit (r INTEGER);
      CREATE TABLE hearth_sources (source_id TEXT); CREATE TABLE entry_sources (entry_id TEXT);
    `);
    sdb.close();
    assert.throws(
      () => runBackup({
        dbPath: srcDb, outDir: join(failDir, 'backups'),
        _vacuum: (conn, backupPath) => {
          writeFileSync(backupPath, '残骸');
          throw new Error('模拟 VACUUM 失败');
        },
        _rm: () => { throw new Error('模拟 EPERM'); },
      }),
      /清理失败留有孤儿产物.*模拟 EPERM/,
      '清理失败必须连同原始错误一起显式上报',
    );
  } finally {
    rmSync(failDir, { recursive: true, force: true });
  }
});

test('三审2：checkpoint 失败 → 目标原样、无 .incoming 残留', async () => {
  const { liveSwap } = await import('../scripts/restore.mjs');
  const { backupPath } = runBackup({ dbPath: process.env.HEARTH_DB_PATH, outDir });
  const swapDir = mkdtempSync(join(tmpdir(), 'hearth-ckptfail-'));
  try {
    const targetPath = join(swapDir, 'prod.db');
    const target = new DatabaseSync(targetPath);
    target.exec('CREATE TABLE marker (x TEXT)');
    target.close();
    const before = readFileSync(targetPath);

    assert.throws(
      () => liveSwap(backupPath, targetPath, { beforeCheckpoint: () => { throw new Error('模拟 checkpoint 失败'); } }),
      /checkpoint 失败/,
    );
    assert.deepEqual(readFileSync(targetPath), before, 'checkpoint 失败时目标库必须原样');
    assert.deepEqual(readdirSync(swapDir).filter((f) => f.includes('.incoming')), [], '不得留下 .incoming');
  } finally {
    rmSync(swapDir, { recursive: true, force: true });
  }
});

test('三审2：旧库改名失败 → 目标原样、无 .incoming 残留', async () => {
  const { liveSwap } = await import('../scripts/restore.mjs');
  const { backupPath } = runBackup({ dbPath: process.env.HEARTH_DB_PATH, outDir });
  const swapDir = mkdtempSync(join(tmpdir(), 'hearth-renfail-'));
  try {
    const targetPath = join(swapDir, 'prod.db');
    const target = new DatabaseSync(targetPath);
    target.exec('CREATE TABLE marker (x TEXT)');
    target.close();
    const before = readFileSync(targetPath);

    assert.throws(
      () => liveSwap(backupPath, targetPath, { beforeOldRename: () => { throw new Error('模拟改名失败'); } }),
      /改名失败/,
    );
    assert.deepEqual(readFileSync(targetPath), before, '旧库改名失败时目标库必须原样');
    assert.deepEqual(readdirSync(swapDir).filter((f) => f.includes('.incoming')), [], '不得留下 .incoming');
  } finally {
    rmSync(swapDir, { recursive: true, force: true });
  }
});

test('验收4：体检检出数据中的 U+FFFD、成片问号、mojibake；正常问句不误报', () => {
  const probeDir = mkdtempSync(join(tmpdir(), 'hearth-enc-'));
  try {
    const probeDb = join(probeDir, 'probe.db');
    const pdb = new DatabaseSync(probeDb);
    pdb.exec(`
      CREATE TABLE hearth_entries (id TEXT, hook TEXT, body TEXT);
      CREATE TABLE hearth_meta (key TEXT, content TEXT);
    `);
    const ins = pdb.prepare('INSERT INTO hearth_entries VALUES (?, ?, ?)');
    ins.run('ok1', '正常钩子', '这是一段正常的中文正文，带一个正常的问号：今天吃了吗?');
    ins.run('bad_fffd', '钩子', '这段有替换符�在里面');
    ins.run('bad_run', '钩子', '主线变成了??????这样一片');
    ins.run('bad_moji', '钩子', '绡濈伀鈥旇繖鏄贡鐮?');
    pdb.prepare('INSERT INTO hearth_meta VALUES (?, ?)').run('timeline', '相遇????????失去????????');
    pdb.close();

    const findings = checkDatabase(probeDb);
    const wheres = findings.map((f) => f.where).join('|');
    assert.ok(wheres.includes('bad_fffd'), 'U+FFFD 必须被检出');
    assert.ok(wheres.includes('bad_run'), '成片问号必须被检出');
    assert.ok(wheres.includes('bad_moji'), 'mojibake 串必须被检出');
    assert.ok(wheres.includes('meta timeline'), 'meta 数据线必须被覆盖——今天坏的就是 timeline');
    assert.ok(!wheres.includes('ok1'), '正常问句的单个"?"不得误报（终审护栏2）');
    assert.ok(findings.every((f) => f.level === 'must'), '数据线发现都是必报级');
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
});

test('验收4：仓库卫生线检出 CRLF 混用与多余 BOM（警告级）', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'hearth-repo-'));
  try {
    writeFileSync(join(repoDir, 'clean.js'), 'const a = 1;\nconst b = 2;\n');
    writeFileSync(join(repoDir, 'mixed.js'), 'const a = 1;\r\nconst b = 2;\n');
    writeFileSync(join(repoDir, 'bom.js'), '﻿const a = 1;\n');
    writeFileSync(join(repoDir, 'script.ps1'), 'Write-Host "no bom"\n'); // ps1 缺 BOM
    const findings = checkRepo(repoDir);
    const kinds = findings.map((f) => `${f.kind}:${f.where.includes('mixed') ? 'mixed' : f.where.includes('bom.js') ? 'bomjs' : f.where.includes('ps1') ? 'ps1' : '?'}`);
    assert.ok(kinds.includes('mixed_eol:mixed'), 'CRLF 混用必须被检出');
    assert.ok(kinds.includes('bom_extra:bomjs'), '多余 BOM 必须被检出');
    assert.ok(kinds.includes('bom_missing:ps1'), 'ps1 缺 BOM 必须被检出');
    assert.ok(!findings.some((f) => f.where.includes('clean.js')), '干净文件不得误报');
    assert.ok(findings.every((f) => f.level === 'warn'), '仓库卫生线是警告级，不算记忆完整性');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
