import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function loadConfig(overrides = {}) {
  const config = {
    projectsDir: process.env.H8_PROJECTS_DIR,
    statePath: process.env.H8_STATE_PATH || path.resolve('data', 'diary-state.json'),
    timezone: process.env.H8_TIMEZONE || 'Asia/Shanghai',
    deepseekApiKey: process.env.H8_LLM_API_KEY,
    deepseekBaseUrl: process.env.H8_LLM_BASE_URL || 'https://api.deepseek.com/v1',
    deepseekModel: process.env.H8_LLM_MODEL || 'deepseek-chat',
    apiUrl: process.env.HEARTH_API_URL || 'http://127.0.0.1:3002',
    hearthToken: process.env.HEARTH_TOKEN,
    ...overrides,
  };
  for (const [name, value] of Object.entries({ H8_PROJECTS_DIR: config.projectsDir, HEARTH_TOKEN: config.hearthToken })) {
    if (!value) throw new Error(`缺少 ${name}`);
  }
  return config;
}
