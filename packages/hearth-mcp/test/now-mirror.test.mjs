import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  beijingStamp,
  buildNowReminder,
  findRecentSnapshots,
  mirrorNow,
  mirrorSuccessfulNowWrite,
  summarizeNow,
} from '../src/now-mirror.mjs';

async function withTempDir(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hearth-now-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('uses Asia/Shanghai for date partitioning across the Beijing midnight boundary', () => {
  assert.deepEqual(
    beijingStamp(new Date('2026-07-29T16:00:01.123Z')),
    {
      date: '2026-07-30',
      time: '00:00:01',
      filenameTime: '00-00-01-123',
    },
  );
});

test('records duplicate content as separate successful writes', async () => {
  await withTempDir(async (root) => {
    const now = new Date('2026-07-30T02:42:31.000Z');
    const [first, second] = await Promise.all([
      mirrorNow('同一份 now', root, { now }),
      mirrorNow('同一份 now', root, { now }),
    ]);
    assert.notEqual(first, second);
    assert.equal((await readdir(path.dirname(first))).length, 2);
    assert.equal(await readFile(first, 'utf8'), '同一份 now');
  });
});

test('mirrors only a confirmed successful meta_set(now) response', async () => {
  await withTempDir(async (root) => {
    const payload = { op: 'meta_set', key: 'now', content: '确认写成' };
    assert.equal(
      await mirrorSuccessfulNowWrite(payload, '{"error":"拒绝"}', root),
      false,
    );
    assert.equal(
      await mirrorSuccessfulNowWrite(payload, '{"ok":true,"id":"timeline"}', root),
      false,
    );
    assert.equal(
      await mirrorSuccessfulNowWrite(payload, '{"ok":true,"id":"now"}', root, {
        now: new Date('2026-07-30T03:00:00Z'),
      }),
      true,
    );
    assert.equal((await findRecentSnapshots(root, {
      now: new Date('2026-07-30T03:00:00Z'),
    })).length, 1);
  });
});

test('a local mirror failure stays isolated from the remote result', async () => {
  await withTempDir(async (root) => {
    const notDirectory = path.join(root, 'plain-file');
    await writeFile(notDirectory, '占位');
    assert.equal(
      await mirrorSuccessfulNowWrite(
        { op: 'meta_set', key: 'now', content: '服务器已经写成' },
        '{"ok":true,"id":"now"}',
        notDirectory,
      ),
      false,
    );
  });
});

test('keeps three Beijing date directories and prunes only older date directories', async () => {
  await withTempDir(async (root) => {
    for (const name of ['2026-07-26', '2026-07-27', '2026-07-28', 'notes']) {
      await mkdir(path.join(root, name), { recursive: true });
      await writeFile(path.join(root, name, 'keep.txt'), name);
    }
    await mirrorNow('今天', root, { now: new Date('2026-07-30T03:00:00Z') });
    const dirs = (await readdir(root)).sort();
    assert.deepEqual(dirs, ['2026-07-28', '2026-07-30', 'notes']);
  });
});

test('summary skips Markdown headings and handles Unicode by code point', () => {
  assert.equal(
    summarizeNow('# now\n\n## 2026-07-30\n\n- 🦊今天坐到了篝火旁。'),
    '🦊今天坐到了篝火旁。',
  );
  assert.equal(summarizeNow(`标题\n\n${'星'.repeat(41)}`), '标题');
  assert.equal(Array.from(summarizeNow('🦊'.repeat(41))).length, 41);
});

test('snapshot body headings do not affect write counting', async () => {
  await withTempDir(async (root) => {
    const now = new Date('2026-07-30T03:00:00Z');
    await mirrorNow('# now\n\n## 10:42\n\n正文', root, { now });
    await mirrorNow('第二次', root, { now: new Date(now.getTime() + 1000) });
    assert.equal((await findRecentSnapshots(root, { now })).length, 2);
  });
});

test('builds a one-line factual reminder from the latest snapshot', async () => {
  await withTempDir(async (root) => {
    const now = new Date('2026-07-30T03:00:00Z');
    await mirrorNow('# now\n\n第一版', root, { now });
    await mirrorNow('# now\n\n第二版更接近眼前。', root, {
      now: new Date(now.getTime() + 1000),
    });
    const reminder = await buildNowReminder(root, {
      now,
      workroom: path.join(root, 'workroom'),
    });
    assert.match(reminder, /近3日写入 2 次/);
    assert.match(reminder, /第二版更接近眼前/);
    assert.equal(reminder.includes('\n'), false);
  });
});

test('missing mirror directory yields no reminder', async () => {
  await withTempDir(async (root) => {
    assert.equal(
      await buildNowReminder(path.join(root, 'missing'), {
        now: new Date('2026-07-30T03:00:00Z'),
      }),
      '',
    );
  });
});
