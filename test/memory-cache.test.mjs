/**
 * Self-check for the injected-memory cache.
 *
 * The cache exists because `systemPrompt.context({ text })` is synchronous: whatever is
 * injected must already be in memory when the prompt is assembled.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildMemoryCache, renderMemoryBlock, compactEntry, MAX_BLOCK_CHARS } from '../src/memory-cache.js';

/** One expert folder holding one task with `count` memory entries. */
async function fixture({ count = 5, sessionId = 'session-x', taskName = '登录重构', tier = 2 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kit-mem-'));
  const dir = join(root, '编程开发', 'log', '_tasks', taskName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'task.json'), JSON.stringify({ taskName, tier, sessionId }), 'utf8');
  const entries = [];
  for (let index = 1; index <= count; index += 1) {
    entries.push(`### 2026-10-0${index}T00:00:00.000Z　[agent]\n\n第 ${index} 条记忆`);
  }
  await writeFile(join(dir, 'context.md'), `# 上下文记忆\n\n## 记忆条目\n\n${entries.join('\n\n')}\n`, 'utf8');
  return { root, rolePath: join(root, '编程开发') };
}

test('compactEntry flattens one entry into a single scannable line', () => {
  const line = compactEntry('### 2026-10-04T00:00:00.000Z　[agent]\n\n交付物：docs\\login.md\n完成效果：可用');
  assert.ok(!line.includes('\n'), 'no newlines survive');
  assert.match(line, /交付物：docs\\login\.md/u);
  assert.match(line, /完成效果：可用/u);
  assert.equal(compactEntry(''), '');
});

test('renderMemoryBlock says nothing when there is nothing to say', () => {
  assert.equal(renderMemoryBlock({ expertName: 'A', taskName: 'T', tier: 1, entries: [] }), '');
  assert.equal(renderMemoryBlock({ expertName: 'A', taskName: 'T', tier: 1, entries: ['   ', ''] }), '');
});

test('the cache keeps only the newest three entries, per task session', async () => {
  const { root, rolePath } = await fixture();
  try {
    const cache = await buildMemoryCache([{ rolePath, presetId: 'taskagent-x', displayName: '编程开发' }]);
    assert.equal(cache.size, 1, 'one task session is cached');
    const block = cache.get('session-x');
    assert.match(block, /本任务既有记忆（编程开发 · 任务「登录重构」· 第 2 层 · 最近 3 条）/u);
    assert.match(block, /第 5 条记忆/u);
    assert.match(block, /第 3 条记忆/u);
    assert.ok(!block.includes('第 2 条记忆'), 'older entries stay out of the injection');
    assert.ok(!block.includes('第 1 条记忆'), 'older entries stay out of the injection');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a task with no recorded session id is never injected', async () => {
  // `null` rather than `undefined`: an omitted key would fall back to the fixture's default.
  const { root, rolePath } = await fixture({ sessionId: null });
  try {
    const cache = await buildMemoryCache([{ rolePath, presetId: 'taskagent-x', displayName: '编程开发' }]);
    assert.equal(cache.size, 0, 'without a session id there is no session to inject into');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a task with no memories is not injected at all', async () => {
  const { root, rolePath } = await fixture({ count: 0 });
  try {
    const cache = await buildMemoryCache([{ rolePath, presetId: 'taskagent-x', displayName: '编程开发' }]);
    assert.equal(cache.size, 0, 'an empty block is no injection');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the injected block is capped so it cannot crowd out the prompt', async () => {
  const { root, rolePath } = await fixture({ count: 3 });
  try {
    const cache = await buildMemoryCache([{ rolePath, presetId: 'taskagent-x', displayName: '编程开发' }], { maxChars: 120 });
    const block = cache.get('session-x');
    assert.ok(block.length <= 120, `block must fit the cap, got ${block.length}`);
    assert.ok(block.endsWith('…'), 'a truncated block is visibly truncated');
    assert.ok(MAX_BLOCK_CHARS >= 200, 'the default cap leaves room for a few entries');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unreadable roster entry is skipped, never fatal', async () => {
  const cache = await buildMemoryCache([
    { rolePath: 'D:\\this\\does\\not\\exist', presetId: 'a', displayName: 'ghost' },
    { rolePath: undefined, presetId: 'b', displayName: 'no path' },
  ]);
  assert.equal(cache.size, 0);
});
