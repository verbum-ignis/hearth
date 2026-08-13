#!/usr/bin/env node

import { buildNowReminder } from './now-mirror.mjs';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const historyDir = argValue('--history-dir') || process.env.HEARTH_NOW_MIRROR_DIR;
  const workroom = argValue('--workroom');
  if (historyDir) {
    const reminder = await buildNowReminder(historyDir, { workroom });
    if (reminder) process.stdout.write(`${reminder}\n`);
  }
} catch {
  // SessionStart 铁律：任何异常静默放行，绝不挡住会话。
}
