// hearth-diary: config 行为契约测试
//
// 覆盖配置装载：关键环境变量缺失即抛错、默认值、overrides 覆盖。
// 注意：本文件会临时改写 process.env，node --test 各文件独立进程，互不影响。

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('loadConfig：缺关键环境变量直接抛错', () => {
  const saved = { ...process.env };
  try {
    delete process.env.H8_PROJECTS_DIR;
    delete process.env.HEARTH_TOKEN;
    assert.throws(() => loadConfig(), /缺少 H8_PROJECTS_DIR/);

    process.env.H8_PROJECTS_DIR = '/tmp/projects';
    delete process.env.HEARTH_TOKEN;
    assert.throws(() => loadConfig(), /缺少 HEARTH_TOKEN/);
  } finally {
    Object.assign(process.env, saved);
  }
});

test('loadConfig：默认值与 overrides 覆盖', () => {
  const saved = { ...process.env };
  try {
    process.env.H8_PROJECTS_DIR = '/tmp/projects';
    process.env.HEARTH_TOKEN = 'test-token';
    for (const key of ['H8_STATE_PATH', 'H8_TIMEZONE', 'H8_LLM_BASE_URL', 'H8_LLM_MODEL', 'HEARTH_API_URL']) {
      delete process.env[key];
    }
    const cfg = loadConfig();
    assert.equal(cfg.projectsDir, '/tmp/projects');
    assert.equal(cfg.hearthToken, 'test-token');
    assert.equal(cfg.timezone, 'Asia/Shanghai');
    assert.equal(cfg.deepseekBaseUrl, 'https://api.deepseek.com/v1');
    assert.equal(cfg.deepseekModel, 'deepseek-chat');
    assert.equal(cfg.apiUrl, 'http://127.0.0.1:3002');
    assert.equal(cfg.statePath, path.resolve('data', 'diary-state.json'));

    const overridden = loadConfig({ timezone: 'UTC', deepseekModel: 'deepseek-reasoner' });
    assert.equal(overridden.timezone, 'UTC');
    assert.equal(overridden.deepseekModel, 'deepseek-reasoner');
    assert.equal(overridden.projectsDir, '/tmp/projects');
  } finally {
    Object.assign(process.env, saved);
  }
});
