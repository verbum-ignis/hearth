import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const entry = path.resolve(import.meta.dirname, '../src/index.mjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function transcript(turnCount) {
  const rows = [];
  for (let index = 1; index <= turnCount; index += 1) {
    rows.push({
      type: 'user',
      uuid: `u-${index}`,
      timestamp: `2026-07-30T00:${String(index).padStart(2, '0')}:00Z`,
      origin: { kind: 'human' },
      message: { content: `问题 ${index}` },
    });
    rows.push({
      type: 'assistant',
      uuid: `a-${index}`,
      timestamp: `2026-07-30T00:${String(index).padStart(2, '0')}:30Z`,
      message: { content: `回答 ${index}` },
    });
  }
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function run(args, { input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { ...process.env, TEST_DEEPSEEK_KEY: 'fake', TEST_HEARTH_TOKEN: 'fake', ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function fixture(handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-now-int-'));
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const configPath = path.join(root, 'config.json');
  const transcriptPath = path.join(root, 'transcript.jsonl');
  writeJson(configPath, {
    profile: '测试',
    agent_name: '测试机',
    human_name: '测试人',
    data_dir: './data',
    view_path: './now.md',
    timezone: 'Asia/Shanghai',
    interval_turns: 50,
    interval_hours: 3,
    max_source_chars: 24000,
    deepseek: {
      key_name: 'TEST_DEEPSEEK_KEY',
      base_url: baseUrl,
      model: 'fake',
      timeout_ms: 2000,
    },
    hearth: {
      publish: true,
      api_url: baseUrl,
      token_env: 'TEST_HEARTH_TOKEN',
      timeout_ms: 2000,
    },
  });
  writeJson(path.join(root, 'data', 'policy.json'), {
    version: 1,
    default: { external_export: false },
    sessions: { test: { external_export: true } },
  });
  return {
    root, server, configPath, transcriptPath,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('DeepSeek 429 时不写段、不推进游标', async () => {
  const fx = await fixture((request, response) => {
    response.writeHead(request.url === '/chat/completions' ? 429 : 404).end();
  });
  try {
    fs.writeFileSync(fx.transcriptPath, transcript(1), 'utf8');
    const result = await run(['hook', '--config', fx.configPath, '--force'], {
      input: JSON.stringify({
        transcript_path: fx.transcriptPath,
        session_id: 'test',
        hook_event_name: 'Stop',
      }),
    });
    assert.equal(result.code, 1);
    assert.equal(fs.existsSync(path.join(fx.root, 'data', 'segments')), false);
    const statePath = path.join(fx.root, 'data', 'state.json');
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    await fx.close();
  }
});

test('PreCompact 中间批失败时只推进已完成批次', async () => {
  let calls = 0;
  const fx = await fixture((request, response) => {
    if (request.url !== '/chat/completions') return response.writeHead(404).end();
    calls += 1;
    if (calls === 2) return response.writeHead(429).end();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      choices: [{ message: { content: '我正在处理一批完全虚构的测试对话，第一批已经安全落盘，后续批次仍需等待重试。' } }],
    }));
  });
  try {
    fs.writeFileSync(fx.transcriptPath, transcript(60), 'utf8');
    writeJson(path.join(fx.root, 'data', 'state.json'), {
      version: 1,
      sessions: { test: { committed_turns: 0, last_segment_at: null } },
      published_hash: '',
    });
    const result = await run(['hook', '--config', fx.configPath], {
      input: JSON.stringify({
        transcript_path: fx.transcriptPath,
        session_id: 'test',
        hook_event_name: 'PreCompact',
      }),
    });
    assert.equal(result.code, 1);
    const state = JSON.parse(fs.readFileSync(path.join(fx.root, 'data', 'state.json'), 'utf8'));
    assert.equal(state.sessions.test.committed_turns, 50);
    const segmentRoot = path.join(fx.root, 'data', 'segments');
    const buckets = fs.readdirSync(segmentRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    const files = buckets.flatMap((bucket) => fs.readdirSync(path.join(segmentRoot, bucket.name)));
    assert.equal(files.length, 1);
  } finally {
    await fx.close();
  }
});

test('Hearth 500 后 outbox 保留，retry-publish 只补发布不重新摘要', async () => {
  let summaryCalls = 0;
  let publishCalls = 0;
  const fx = await fixture((request, response) => {
    if (request.url === '/chat/completions') {
      summaryCalls += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({
        choices: [{ message: { content: '我正在验证发布补偿链路；摘要只生成一次，服务器恢复后直接补发同一份 now 投影。' } }],
      }));
    }
    if (request.url === '/write') {
      publishCalls += 1;
      if (publishCalls === 1) return response.writeHead(500).end();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ ok: true, id: 'now' }));
    }
    response.writeHead(404).end();
  });
  try {
    fs.writeFileSync(fx.transcriptPath, transcript(1), 'utf8');
    const hook = await run(['hook', '--config', fx.configPath, '--force'], {
      input: JSON.stringify({
        transcript_path: fx.transcriptPath,
        session_id: 'test',
        hook_event_name: 'Stop',
      }),
    });
    assert.equal(hook.code, 0);
    const outboxPath = path.join(fx.root, 'data', 'publish-outbox.json');
    assert.equal(fs.existsSync(outboxPath), true);

    const retry = await run(['retry-publish', '--config', fx.configPath]);
    assert.equal(retry.code, 0);
    assert.equal(fs.existsSync(outboxPath), false);
    assert.equal(summaryCalls, 1);
    assert.equal(publishCalls, 2);
    const state = JSON.parse(fs.readFileSync(path.join(fx.root, 'data', 'state.json'), 'utf8'));
    assert.ok(state.published_hash);
  } finally {
    await fx.close();
  }
});

test('抽屉提醒到期后只输出存在性提示，mark-read 清掉 pending 并停止提醒', async () => {
  const fx = await fixture((_request, response) => response.writeHead(404).end());
  try {
    const config = JSON.parse(fs.readFileSync(fx.configPath, 'utf8'));
    config.reminder = {
      enabled: true,
      repeat_turns: 50,
      pending_path: './pending-reminder.txt',
    };
    writeJson(fx.configPath, config);
    writeJson(path.join(fx.root, 'data', 'segments', '2026-07-30', '010000-seg-1.json'), {
      version: 1,
      id: 'seg-1',
      date: '2026-07-30',
      local_time: '01:00:00',
      created_at: '2026-07-29T17:00:00Z',
      trigger: '50-turns',
      content: '这段正文不应出现在提醒输出里。',
      source: { session_id: 'test', from_turn: 1, to_turn: 1 },
    });

    const reminder = await run([
      'reminder', '--config', fx.configPath, '--event', 'turn',
      '--session-id', 'test', '--current-turns', '51', '--no-stdin',
    ]);
    assert.equal(reminder.code, 0);
    assert.match(reminder.stdout, /抽屉里有 1 段未读/);
    assert.equal(reminder.stdout.includes('这段正文'), false);
    assert.equal(fs.existsSync(path.join(fx.root, 'pending-reminder.txt')), true);

    const read = await run(['mark-read', '--config', fx.configPath]);
    assert.equal(read.code, 0);
    assert.equal(fs.existsSync(path.join(fx.root, 'pending-reminder.txt')), false);

    const afterRead = await run([
      'reminder', '--config', fx.configPath, '--event', 'session-start',
      '--session-id', 'test', '--current-turns', '52', '--no-stdin',
    ]);
    assert.equal(afterRead.stdout, '');
  } finally {
    await fx.close();
  }
});
