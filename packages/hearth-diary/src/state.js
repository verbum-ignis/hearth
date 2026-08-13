import fs from 'node:fs';
import path from 'node:path';

export function readState(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { last_successful_date: null, diaries: {} };
    throw error;
  }
}

export function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temp = `${statePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, statePath);
}

export function dateRange(lastSuccessful, targetDate) {
  if (!lastSuccessful) return [targetDate];
  const dates = [];
  const cursor = new Date(`${lastSuccessful}T12:00:00Z`);
  const end = new Date(`${targetDate}T12:00:00Z`);
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}
