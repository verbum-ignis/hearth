// ② 备份（方案_地基定稿_溯_20260813）：VACUUM INTO 快照 + 每备份独立 manifest。
//
// - VACUUM INTO：事务一致快照，零 CLI 依赖，Windows/Linux 通用
// - 每个备份配同名 <name>.manifest.json（计数 + 全文件 sha256 + 时间），写完置只读
//   （只读 = 误改护栏，防手滑不防篡改；无签名/外部锚定，只能检出非协同篡改）
// - 密钥红线：不收 .env/token/seal 等任何密钥；manifest 落盘前扫描自检
// - 备份范围：hearth.db（now/meta 随库在内，manifest 里显式核对计数）
//   ③落地后 entry_sources 引用的原文证据快照也进清单——不整库吞外部系统
//
// 用法：node scripts/backup.mjs [--db <path>] [--out <dir>]
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// manifest 落盘前的密钥自检：出现任何一个即中止（宁可备份失败，不可密钥入包）
const SECRET_PATTERNS = [/token/i, /secret/i, /password/i, /api[_-]?key/i, /HEARTH_SEAL/i, /\.env\b/];

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function collectCounts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    return {
      entries: count('hearth_entries'),
      meta: count('hearth_meta'),
      history: count('hearth_history'),
      touch_log: count('hearth_touch_log'),
      audit: count('hearth_write_audit'),
      sources: count('hearth_sources'),
      source_links: count('entry_sources'),
    };
  } finally {
    db.close();
  }
}

// _vacuum/_rm 是测试注入缝：默认真实执行；测试用它们证明
// VACUUM 抛错后的残骸会被清理、清理失败会显式上报而不是静默吞掉。
export function runBackup({ dbPath, outDir, _vacuum = null, _rm = rmSync }) {
  if (!existsSync(dbPath)) throw new Error(`源库不存在: ${dbPath}`);
  mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  let name = `hearth-${stamp}.db`;
  let seq = 0;
  while (existsSync(join(outDir, name))) {
    seq += 1;
    name = `hearth-${stamp}-${seq}.db`;
  }
  const backupPath = join(outDir, name);
  const manifestPath = `${backupPath}.manifest.json`;

  // 失败路径铁律（Lumen 二审+三审）：VACUUM 自身在内，任何一步失败，本次产物必须清理干净——
  // 名字像正式备份的孤儿 .db 比没有备份更危险（人工会误拿）。
  // 清理失败不许静默：连同原始错误一起显式上报，孤儿必须被人看见。
  const cleanup = () => {
    const failures = [];
    for (const p of [backupPath, manifestPath]) {
      try {
        if (existsSync(p)) {
          chmodSync(p, 0o644);
          _rm(p);
        }
      } catch (e) {
        failures.push(`${p}: ${e.message}`);
      }
    }
    return failures;
  };

  // 快照前先数源库，快照后再数备份——两边一致才可信
  const sourceCounts = collectCounts(dbPath);

  try {
    // VACUUM 因磁盘满/中断抛错时可能已创建目标文件——必须在清理边界之内（三审1）
    const src = new DatabaseSync(dbPath);
    try {
      if (_vacuum) {
        _vacuum(src, backupPath);
      } else {
        src.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      }
    } finally {
      src.close();
    }

    const backupCounts = collectCounts(backupPath);
    for (const [table, n] of Object.entries(sourceCounts)) {
      if (backupCounts[table] !== n) {
        throw new Error(`快照计数不一致: ${table} 源=${n} 备份=${backupCounts[table]}`);
      }
    }

    const check = new DatabaseSync(backupPath, { readOnly: true });
    const integrity = check.prepare('PRAGMA integrity_check').get();
    check.close();
    const integrityValue = Object.values(integrity)[0];
    if (integrityValue !== 'ok') throw new Error(`备份 integrity_check 失败: ${integrityValue}`);

    const manifest = {
      manifest_version: 1,
      backup_file: name,
      created_at: new Date().toISOString(),
      source_db: basename(dbPath), // 只记文件名，不泄露完整路径结构
      sha256: sha256File(backupPath),
      integrity_check: 'ok',
      counts: backupCounts,
    };

    const manifestJson = JSON.stringify(manifest, null, 2);
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(manifestJson)) {
        throw new Error(`manifest 疑似含密钥字样（${pattern}），中止备份`);
      }
    }

    writeFileSync(manifestPath, manifestJson, 'utf8');
    // 误改护栏：置只读只防手滑覆盖，不是不可变、更不是防篡改——
    // manifest 与 db 同目录且无签名/外部锚定，只能检出非协同篡改，不能证明真实性。
    chmodSync(backupPath, 0o444);
    chmodSync(manifestPath, 0o444);

    return { backupPath, manifestPath, manifest };
  } catch (err) {
    const failures = cleanup();
    if (failures.length > 0) {
      throw new Error(`${err.message}｜且清理失败留有孤儿产物，必须人工处理: ${failures.join('; ')}`);
    }
    throw err;
  }
}

function main() {
  const args = process.argv.slice(2);
  const opt = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const dbPath = resolve(opt('--db', process.env.HEARTH_DB_PATH || 'hearth.db'));
  const outDir = resolve(opt('--out', 'backups'));
  const { backupPath, manifest } = runBackup({ dbPath, outDir });
  console.log(`备份完成: ${backupPath}`);
  console.log(`  sha256: ${manifest.sha256}`);
  console.log(`  counts: ${JSON.stringify(manifest.counts)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
