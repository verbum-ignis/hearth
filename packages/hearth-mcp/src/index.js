// Hearth 本地 MCP：stdio 轻客户端，纯转发不做业务。
import 'dotenv/config';
// 不缓存、不重试写操作；网络抖动时让小机看见错误，人工重发以防重复写入。
// 传输两种：http（默认，直连 fetch）/ ssh（本机到服务器 443 不通时，
// 走持久 SSH 隧道本地端口转发——一条连接复用所有请求，未就绪时回退直连）。
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mirrorSuccessfulNowWrite } from './now-mirror.mjs';

const API_URL = process.env.HEARTH_API_URL;
const TOKEN = process.env.HEARTH_TOKEN
  || (process.env.HEARTH_TOKEN_ENV
    ? process.env[process.env.HEARTH_TOKEN_ENV]
    : undefined);
const TRANSPORT = process.env.HEARTH_TRANSPORT || 'http';
const SSH_HOST = process.env.HEARTH_SSH_HOST;
const CACHE_PATH = process.env.HEARTH_CACHE_PATH
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'keys-cache.json');
const NOW_MIRROR_DIR = process.env.HEARTH_NOW_MIRROR_DIR;

if (!API_URL || !TOKEN || (TRANSPORT === 'ssh' && !SSH_HOST)) {
  console.error('缺少 HEARTH_API_URL / HEARTH_TOKEN（ssh 模式还需 HEARTH_SSH_HOST）');
  process.exit(1);
}

// ── SSH 隧道（连接复用） ──
// Windows OpenSSH 不支持 ControlMaster，用本地端口转发代替：
// 一条持久 SSH 连接把本地端口映射到服务器 hearth 端口，后续请求走本地 HTTP。
const TUNNEL_PORT = parseInt(process.env.HEARTH_TUNNEL_PORT || '13002', 10);
let tunnelProc = null;

function spawnTunnel() {
  if (tunnelProc) return;
  const remote = new URL(API_URL);
  tunnelProc = spawn('ssh', [
    '-N', '-T',
    '-L', `${TUNNEL_PORT}:${remote.hostname}:${remote.port}`,
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'BatchMode=yes',
    SSH_HOST,
  ], { stdio: 'ignore' });
  tunnelProc.on('exit', () => { tunnelProc = null; });
  tunnelProc.unref();
}

if (TRANSPORT === 'ssh') spawnTunnel();
process.on('exit', () => { tunnelProc?.kill(); });

function sshRequest(urlPath, payload = null) {
  return new Promise((resolve, reject) => {
    const post = payload !== null
      ? ` -X POST -H "Content-Type: application/json" -d @-`
      : '';
    const cmd = `curl -s -m 30${post} ${API_URL}${urlPath} -H "Authorization: Bearer ${TOKEN}"`;
    const child = execFile('ssh', [SSH_HOST, cmd], { timeout: 45000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ssh transport: ${err.message}${stderr ? ' | ' + stderr : ''}`));
      resolve(stdout);
    });
    if (payload !== null) child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function request(urlPath, payload = null) {
  if (TRANSPORT === 'ssh') {
    try {
      spawnTunnel();
      const res = await fetch(`http://127.0.0.1:${TUNNEL_PORT}${urlPath}`, {
        method: payload !== null ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...(payload !== null ? { 'Content-Type': 'application/json' } : {}),
        },
        body: payload !== null ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      return res.text();
    } catch {
      return sshRequest(urlPath, payload);
    }
  }
  const res = await fetch(`${API_URL}${urlPath}`, {
    method: payload !== null ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(payload !== null ? { 'Content-Type': 'application/json' } : {}),
    },
    body: payload !== null ? JSON.stringify(payload) : undefined,
  });
  return res.text();
}

// keys 本地缓存：喂给输入扫描 hook（scan-input.mjs）。失败静默——缓存 stale 无害，
// 提示只是半自动通道，主动浏览目录也可兜底。seal 绝不落盘。
async function refreshKeysCache() {
  try {
    const data = JSON.parse(await request('/keys'));
    if (!Array.isArray(data.keys_index)) return;
    await mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await writeFile(
      CACHE_PATH,
      JSON.stringify({ fetched_at: new Date().toISOString(), keys_index: data.keys_index }),
      'utf8'
    );
  } catch {
    // 静默：hook 通道的缓存而已，不影响主流程
  }
}

// 亮度标记：load/touch 后刚进上下文的条目
// 标记 "max"（=刚点亮，具体轮次由 scan-input 下轮换算）——15 轮内 hook 不再提示。
// 只动 entries，不碰 session/turn（那是 scan-input 的地盘）。失败静默。
const LIT_STATE_PATH = path.join(path.dirname(CACHE_PATH), 'lit-state.json');

async function markLit(ids) {
  if (!ids.length) return;
  try {
    let state = {};
    try {
      state = JSON.parse(await readFile(LIT_STATE_PATH, 'utf8'));
    } catch {
      // 没有就新建
    }
    if (!state.entries || typeof state.entries !== 'object') state.entries = {};
    for (const id of ids) state.entries[id] = { lit_at_turn: 'max' };
    await mkdir(path.dirname(LIT_STATE_PATH), { recursive: true });
    await writeFile(LIT_STATE_PATH, JSON.stringify(state), 'utf8');
  } catch {
    // 静默：亮度是降噪优化，不影响主流程
  }
}

async function markWriteEvent() {
  try {
    let state = {};
    try {
      state = JSON.parse(await readFile(LIT_STATE_PATH, 'utf8'));
    } catch {}
    state.last_write_turn = 'max';
    delete state.last_write_nudge_turn;
    delete state.last_review_nudge_turn;
    await mkdir(path.dirname(LIT_STATE_PATH), { recursive: true });
    await writeFile(LIT_STATE_PATH, JSON.stringify(state), 'utf8');
  } catch {}
}

// load 后：keys 缓存里全部可触发条目都算"在上下文里"（目录钩子已展示）
async function markLitFromCache() {
  try {
    const cache = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
    await markLit((cache.keys_index || []).map((e) => e.id).filter(Boolean));
  } catch {
    // 静默
  }
}

async function call(urlPath, payload) {
  const text = await request(urlPath, payload);
  if (
    NOW_MIRROR_DIR &&
    urlPath === '/write' &&
    payload?.op === 'meta_set' &&
    payload?.key === 'now'
  ) {
    await mirrorSuccessfulNowWrite(payload, text, NOW_MIRROR_DIR);
  }
  if (urlPath === '/load' || urlPath === '/write') await refreshKeysCache();
  if (urlPath === '/write' && ['create', 'supersede', 'update'].includes(payload?.op)) {
    void markWriteEvent();
  }
  if (urlPath === '/load') {
    void markLitFromCache();
  } else if (urlPath === '/touch') {
    try {
      const data = JSON.parse(text);
      void markLit((data.entries || []).map((e) => e.id).filter(Boolean));
    } catch {
      // 响应不是 JSON 就算了
    }
  }
  return { content: [{ type: 'text', text }] };
}

const server = new McpServer({ name: 'hearth', version: '0.1.0' });

server.tool(
  'hearth_load',
  '读档。start=新窗口或压缩后（身份卡、规则、主线、now、目录、核心记忆、窗口留言、今日浮现与回声）；full 在小机主动要求完整回顾时使用。',
  { mode: z.enum(['start', 'full']).default('start') },
  async ({ mode }) => call('/load', { mode })
);

server.tool(
  'hearth_touch',
  '触发：取条目全文，touch=一次复习（衰退时钟重置，星星飞回篝火边）。tags=触发词命中（半沉仍可触发，沉底>120天失效）；id=显式按名取（任何状态都给）。返回 entries 全文（≤5条）+ overflow 钩子 + related 关联浮现（body 里 [[链接]] 指向的条目，只给钩子）。幂等，去重靠上下文。',
  {
    tags: z.array(z.string()).optional(),
    id: z.string().optional(),
  },
  async ({ tags, id }) => call('/touch', { tags, id })
);

server.tool(
  'hearth_write',
  '写入。op=create（新条目，需 entry）/ supersede（新盖旧，需 id+entry）/ update（原地改，需 id+patch）/ retire（归档退目录，需 id）/ meta_set（身份卡/主线/now/窗口留言，需 key+content）。anchor:3=手动锚定为恒星；1/2 是自动台阶的中间级，手动一般不用。weight:1-5 阅读优先级（管"该不该读"，与 anchor 的衰退豁免无关）——1/2 琐碎可跳、3 默认、4 触发了就读、5 新窗口必读（load 时全文带出）。event/project 的 body 用经历体：我经历了什么+当时什么感受+以后怎么做更好，织在一段第一人称叙述里。',
  {
    op: z.enum(['create', 'supersede', 'update', 'retire', 'meta_set']),
    entry: z
      .object({
        type: z.enum(['rule', 'letter', 'event', 'project', 'stream']),
        keys: z.array(z.string()).optional(),
        hook: z.string(),
        body: z.string(),
        trigger_date: z.string().optional(),
        sealed: z.boolean().optional(),
        anchor: z.number().int().min(0).max(3).optional(),
        weight: z.number().int().min(1).max(5).optional(),
      })
      .optional(),
    id: z.string().optional(),
    patch: z
      .object({
        keys: z.array(z.string()).optional(),
        hook: z.string().optional(),
        body: z.string().optional(),
        trigger_date: z.string().nullable().optional(),
        trigger_done: z.number().optional(),
        anchor: z.number().int().min(0).max(3).optional(),
        weight: z.number().int().min(1).max(5).optional(),
      })
      .optional(),
    key: z
      .enum(['identity_self', 'identity_human', 'timeline', 'now', 'window_letter'])
      .optional(),
    content: z.string().optional(),
  },
  async (args) => call('/write', args)
);

const transport = new StdioServerTransport();
await server.connect(transport);
