// ② 编码体检（方案_地基定稿_溯_20260813）：只报不修。
//
// 两条线，分级告警（Lumen 终审护栏 2）：
// - 数据线（记忆完整性，必报级）：hearth.db 的 hook/body/meta content 扫
//   U+FFFD、成片问号（≥3 连续）、已知 mojibake 串、中文字段异常占比。
//   今天 timeline 的成片"?"就是这一类——源码检查检不到，必须查运行数据。
//   正常问句里的单个"?"不报（护栏明令禁止误报）。
// - 仓库卫生线（警告级，不算记忆完整性）：源码行尾混用（同文件 CRLF+LF）、
//   BOM 白名单（.ps1 必须带 BOM，其余源码不带）、源码里的 mojibake。
//
// 用法：node scripts/encoding-check.mjs [--db <path>] [--repo <dir>] [--json]
// 退出码：有必报级发现 → 1；只有警告级 → 0（打印警告）；全净 → 0
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

// GBK↔UTF-8 互相误读的高频残片 + 通用替换符
const MOJIBAKE_PATTERNS = ['锟斤拷', '�', 'ï¿½', 'â€™', 'â€œ', 'â€', 'Ã¢â‚¬', '鈥', '娄鈥'];
const RUN_OF_QUESTIONS = /\?{3,}/; // 成片问号必报；单个问号是正常语言
const CJK = /[一-鿿]/g;
const SUSPECT = /[�?]/g;

function scanText(text, where, findings) {
  if (typeof text !== 'string' || text.length === 0) return;
  for (const pattern of MOJIBAKE_PATTERNS) {
    if (text.includes(pattern)) {
      findings.push({ level: 'must', where, kind: 'mojibake', detail: `含 ${JSON.stringify(pattern)}` });
      break;
    }
  }
  const runMatch = text.match(RUN_OF_QUESTIONS);
  if (runMatch) {
    findings.push({ level: 'must', where, kind: 'question_run', detail: `成片问号 ${JSON.stringify(runMatch[0].slice(0, 10))}...共${runMatch[0].length}个` });
  }
  // 中文字段异常占比：文本够长、可疑字符占比过高才报，避免误伤短英文
  if (text.length > 20) {
    const cjkCount = (text.match(CJK) || []).length;
    const suspectCount = (text.match(SUSPECT) || []).length;
    if (cjkCount === 0 && suspectCount / text.length > 0.3) {
      findings.push({ level: 'must', where, kind: 'suspect_ratio', detail: `可疑字符占比 ${(suspectCount / text.length * 100).toFixed(0)}% 且无中文` });
    }
  }
}

export function checkDatabase(dbPath) {
  const findings = [];
  if (!existsSync(dbPath)) {
    findings.push({ level: 'must', where: dbPath, kind: 'missing', detail: '数据库不存在' });
    return findings;
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    for (const row of db.prepare('SELECT id, hook, body FROM hearth_entries').all()) {
      scanText(row.hook, `entry ${row.id} hook`, findings);
      scanText(row.body, `entry ${row.id} body`, findings);
    }
    for (const row of db.prepare('SELECT key, content FROM hearth_meta').all()) {
      scanText(row.content, `meta ${row.key}`, findings);
    }
  } finally {
    db.close();
  }
  return findings;
}

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.ps1', '.sh', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'backups', 'data']);

function* walkFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walkFiles(full);
    else if (SOURCE_EXTS.has(extname(name))) yield full;
  }
}

export function checkRepo(repoDir) {
  const findings = [];
  for (const file of walkFiles(repoDir)) {
    const buf = readFileSync(file);
    const hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    const isPs1 = extname(file) === '.ps1';
    if (isPs1 && !hasBom) {
      findings.push({ level: 'warn', where: file, kind: 'bom_missing', detail: 'PowerShell 5.1 脚本必须带 BOM' });
    }
    if (!isPs1 && hasBom) {
      findings.push({ level: 'warn', where: file, kind: 'bom_extra', detail: '多余 BOM' });
    }
    const text = buf.toString('utf8');
    const crlf = (text.match(/\r\n/g) || []).length;
    const bareLf = (text.match(/(?<!\r)\n/g) || []).length;
    if (crlf > 0 && bareLf > 0) {
      findings.push({ level: 'warn', where: file, kind: 'mixed_eol', detail: `行尾混用 CRLF×${crlf} + LF×${bareLf}` });
    }
    for (const pattern of MOJIBAKE_PATTERNS) {
      if (text.includes(pattern)) {
        findings.push({ level: 'warn', where: file, kind: 'mojibake', detail: `源码含 ${JSON.stringify(pattern)}` });
        break;
      }
    }
  }
  return findings;
}

export function runCheck({ dbPath, repoDir }) {
  const findings = [];
  if (dbPath) findings.push(...checkDatabase(dbPath));
  if (repoDir) findings.push(...checkRepo(repoDir));
  return findings;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const dbPath = opt('--db', process.env.HEARTH_DB_PATH || null);
  const repoDir = opt('--repo', null);
  if (!dbPath && !repoDir) {
    console.error('用法: node scripts/encoding-check.mjs [--db <path>] [--repo <dir>] [--json]');
    process.exit(2);
  }
  const findings = runCheck({ dbPath: dbPath && resolve(dbPath), repoDir: repoDir && resolve(repoDir) });
  if (args.includes('--json')) {
    console.log(JSON.stringify(findings, null, 2));
  } else if (findings.length === 0) {
    console.log('体检通过：未发现编码异常');
  } else {
    for (const f of findings) {
      console.log(`[${f.level === 'must' ? '必报' : '警告'}] ${f.kind} @ ${f.where}: ${f.detail}`);
    }
  }
  process.exit(findings.some((f) => f.level === 'must') ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
