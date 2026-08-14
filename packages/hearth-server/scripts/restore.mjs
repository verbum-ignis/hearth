// ② 恢复（方案_地基定稿_溯_20260813）：旁路校验 → 可回滚原子切换。
//
// 默认是旁路演练（rehearsal）：解包 + 校验，全通过只报告，不碰目标库——全程无写中断。
// --live 才做生产切换：明确、短暂的停写窗口内执行（操作者先停服务），
// checkpoint WAL/SHM → 旧库改名保留（可回滚）→ 验证过的副本落位。
// 任何一项校验不过 → 拒绝恢复，目标库分毫不动。
//
// 用法：
//   演练  node scripts/restore.mjs <backup.db>
//   切换  node scripts/restore.mjs <backup.db> --db <target> --live
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, copyFileSync, mkdtempSync, rmSync, existsSync, renameSync, chmodSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { sha256File, collectCounts } from './backup.mjs';

class RestoreRefused extends Error {}

// 旁路校验：manifest 完整 + sha256 相符 + integrity_check + 计数一致，全过才放行
export function verifyBackup(backupPath) {
  if (!existsSync(backupPath)) throw new RestoreRefused(`备份不存在: ${backupPath}`);
  const manifestPath = `${backupPath}.manifest.json`;
  if (!existsSync(manifestPath)) throw new RestoreRefused(`manifest 缺失: ${manifestPath}——没有清单的备份不可信`);

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new RestoreRefused('manifest 不是合法 JSON——疑似被篡改或覆盖');
  }
  if (!manifest.sha256 || !manifest.counts) throw new RestoreRefused('manifest 缺关键字段（sha256/counts）');

  const actualSha = sha256File(backupPath);
  if (actualSha !== manifest.sha256) {
    throw new RestoreRefused(`sha256 不符: manifest=${manifest.sha256} 实际=${actualSha}——备份或清单被改过`);
  }

  // 旁路临时目录里做 integrity_check，绝不直接在原备份上开写连接
  const tempDir = mkdtempSync(join(tmpdir(), 'hearth-restore-'));
  const tempCopy = join(tempDir, basename(backupPath));
  try {
    copyFileSync(backupPath, tempCopy);
    chmodSync(tempCopy, 0o644); // 备份文件是只读的，副本要可开

    const db = new DatabaseSync(tempCopy, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').get();
    db.close();
    const integrityValue = Object.values(integrity)[0];
    if (integrityValue !== 'ok') throw new RestoreRefused(`integrity_check 失败: ${integrityValue}`);

    const counts = collectCounts(tempCopy);
    for (const [table, n] of Object.entries(manifest.counts)) {
      if (counts[table] !== n) {
        throw new RestoreRefused(`计数不符: ${table} manifest=${n} 实际=${counts[table]}`);
      }
    }
    return { manifest, tempDir, tempCopy };
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

// 生产切换：调用方保证已在停写窗口内（服务已停）。
// Windows 铁律：交换文件前先 checkpoint 并随连接关闭处理 WAL/SHM。
// 原子落位（Lumen 二审+三审）：整个 staged swap 在同一清理边界内——
// 先把已验证副本复制到目标同目录的 .incoming（同卷才能原子 rename），fsync 后 rename 落位。
// copy 之后任何一步失败（fsync/checkpoint/sidecar 清理/旧库改名/落位 rename）：
// finally 统一清掉 .incoming；旧库一旦让位由 catch 负责放回。
// _hooks 是测试注入缝：beforeCheckpoint/beforeOldRename，用于证明中段失败不留残骸。
export function liveSwap(verifiedTempCopy, targetPath, _hooks = {}) {
  const incoming = `${targetPath}.incoming-${Date.now()}`;
  let rollback = null;
  let placed = false;
  try {
    copyFileSync(verifiedTempCopy, incoming);
    chmodSync(incoming, 0o644); // Windows copyFileSync 会带走源文件的只读属性，落位副本必须可写
    const fd = openSync(incoming, 'r+');
    try {
      fsyncSync(fd); // 确保副本落盘后再动旧库
    } finally {
      closeSync(fd);
    }

    if (existsSync(targetPath)) {
      const target = new DatabaseSync(targetPath); // 旧库损坏/非 SQLite 时这里抛错→finally 清 incoming
      try {
        if (_hooks.beforeCheckpoint) _hooks.beforeCheckpoint();
        target.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        target.close(); // 关闭连接，WAL/SHM 随之落盘清理
      }
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${targetPath}${suffix}`;
        if (existsSync(sidecar)) rmSync(sidecar);
      }
      rollback = `${targetPath}.rollback-${Date.now()}`;
      if (_hooks.beforeOldRename) _hooks.beforeOldRename();
      renameSync(targetPath, rollback); // 旧库保留，失败可退回
    }

    renameSync(incoming, targetPath); // 同卷 rename，原子落位
    placed = true;
    return { rollback };
  } catch (err) {
    // 旧库已让位但新库没落上——立刻把旧库放回去
    if (rollback && existsSync(rollback) && !existsSync(targetPath)) {
      renameSync(rollback, targetPath);
    }
    throw err;
  } finally {
    if (!placed && existsSync(incoming)) rmSync(incoming, { force: true });
  }
}

// _verifyAfterSwap 是测试注入缝：默认走真实复验，测试用它证明复验失败会自动回滚
export function runRestore({ backupPath, targetPath, live = false, _verifyAfterSwap = null }) {
  const { manifest, tempDir, tempCopy } = verifyBackup(backupPath);
  try {
    if (!live) {
      return { mode: 'rehearsal', ok: true, manifest, message: '旁路演练通过：备份可恢复。未触碰任何目标库。' };
    }
    if (!targetPath) throw new RestoreRefused('--live 必须指定 --db 目标库');
    const { rollback } = liveSwap(tempCopy, targetPath);
    // 落位后再验一次，确认切换本身没把库弄坏；失败不留未验过的新库，自动回滚
    try {
      if (_verifyAfterSwap) {
        _verifyAfterSwap(targetPath, manifest);
      } else {
        const finalCounts = collectCounts(targetPath);
        for (const [table, n] of Object.entries(manifest.counts)) {
          if (finalCounts[table] !== n) throw new Error(`计数异常: ${table} manifest=${n} 实际=${finalCounts[table]}`);
        }
      }
    } catch (err) {
      rmSync(targetPath, { force: true }); // 未通过复验的新库不许留在目标位
      if (rollback && existsSync(rollback)) renameSync(rollback, targetPath);
      throw new Error(`切换后复验失败，已自动回滚旧库: ${err.message}`);
    }
    return { mode: 'live', ok: true, manifest, rollback, message: `切换完成，旧库保留于 ${rollback}` };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export { RestoreRefused };

function main() {
  const args = process.argv.slice(2);
  const backupPath = resolve(args[0] || '');
  const live = args.includes('--live');
  const dbIdx = args.indexOf('--db');
  const targetPath = dbIdx >= 0 ? resolve(args[dbIdx + 1]) : null;
  if (!args[0]) {
    console.error('用法: node scripts/restore.mjs <backup.db> [--db <target> --live]');
    process.exit(2);
  }
  try {
    const result = runRestore({ backupPath, targetPath, live });
    console.log(result.message);
  } catch (err) {
    if (err instanceof RestoreRefused) {
      console.error(`拒绝恢复: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
