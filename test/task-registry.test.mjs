/**
 * Self-check for the task registry, the dated daily log and the context memory.
 *
 * Run: node --test D:\DSH_desktop\dsh-ext\task-agent-kit\test\task-registry.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  safeTaskName,
  taskPaths,
  writeDailyLog,
  writeTaskRegistration,
  appendContextMemory,
  readRecentMemories,
  listExpertTasks,
} from '../src/task-registry.js';

const DAY = new Date('2026-10-04T08:30:00.000Z');

async function roleDir() {
  return mkdtemp(join(tmpdir(), 'kit-task-'));
}
const exists = async path => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

test('safeTaskName keeps a path-safe name and refuses to invent one', () => {
  assert.equal(safeTaskName('重构 API/网关'), '重构 API-网关');
  assert.equal(safeTaskName('  trailing.  '), 'trailing');
  assert.throws(() => safeTaskName('   '), /must not be empty/u);
});

test('the approved layout: date first for the log, task folder for the registry', () => {
  const paths = taskPaths('D:\\role', '登录重构', DAY);
  assert.equal(paths.dailyLog, join('D:\\role', 'log', '2026', '10', '04', '登录重构.md'));
  assert.equal(paths.taskFile, join('D:\\role', 'log', '_tasks', '登录重构', 'task.json'));
  assert.equal(paths.contextFile, join('D:\\role', 'log', '_tasks', '登录重构', 'context.md'));
  // `_tasks` is underscore-prefixed so it can never be read as a year folder.
  assert.ok(!paths.taskDir.includes(join('log', '2026')));
});

test('the daily log is written once and then appended to', async () => {
  const dir = await roleDir();
  try {
    const first = await writeDailyLog({ roleDir: dir, taskName: '登录重构', expertName: '编程开发', tier: 2, date: DAY });
    const initial = await readFile(first, 'utf8');
    assert.match(initial, /# 登录重构（编程开发 · 第 2 层）/u);
    // The iteration input is mandatory, not optional.
    assert.match(initial, /## 可反哺 skills \/ 知识库的优化项/u);
    assert.match(initial, /## 交付物/u);
    assert.match(initial, /## 完成效果/u);

    await writeDailyLog({ roleDir: dir, taskName: '登录重构', expertName: '编程开发', tier: 2, date: DAY, note: '上级验收通过' });
    const appended = await readFile(first, 'utf8');
    assert.equal((appended.match(/# 登录重构/g) ?? []).length, 1, 'the skeleton is not duplicated');
    assert.match(appended, /上级验收通过/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the task registration carries what the upstream board cannot', async () => {
  const dir = await roleDir();
  try {
    const { record } = await writeTaskRegistration({
      roleDir: dir, taskName: '登录重构', expertName: '编程开发', tier: 3,
      taskId: 'task-1', parentTaskId: 'task-0', sessionId: 'session-9', date: DAY,
    });
    assert.equal(record.taskId, 'task-1');
    assert.equal(record.tier, 3, 'the tier this expert holds in this task');
    assert.equal(record.parentTaskId, 'task-0', 'the task it was split from');
    assert.equal(record.sessionId, 'session-9', 'the session that executes it');
    assert.equal(record.acceptance.status, 'pending');

    // A second write updates in place and keeps the identity fields.
    const { record: again } = await writeTaskRegistration({
      roleDir: dir, taskName: '登录重构', expertName: '编程开发', tier: 3,
      deliverable: 'docs\\login.md', date: DAY,
    });
    assert.equal(again.taskId, 'task-1');
    assert.equal(again.deliverable, 'docs\\login.md');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('context memory is created from a skeleton and keeps the newest three', async () => {
  const dir = await roleDir();
  try {
    for (let i = 1; i <= 5; i += 1) {
      await appendContextMemory({
        roleDir: dir, taskName: '登录重构', expertName: '编程开发', tier: 2,
        date: new Date(`2026-10-0${i}T00:00:00.000Z`), actor: i % 2 === 0 ? 'agent' : 'plugin',
        text: `第 ${i} 条记忆`,
      });
    }
    const recent = await readRecentMemories(dir, '登录重构', 3);
    assert.equal(recent.length, 3, 'only the newest three are injected');
    assert.match(recent[0], /第 3 条记忆/u);
    assert.match(recent[2], /第 5 条记忆/u);
    assert.ok(!recent.join('\n').includes('第 2 条记忆'), 'older entries stay out of the injection');

    const text = await readFile(taskPaths(dir, '登录重构').contextFile, 'utf8');
    assert.match(text, /本文件由插件建骨架/u, 'the skeleton is the head of the file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('one expert lists every task it took part in', async () => {
  const dir = await roleDir();
  try {
    await writeTaskRegistration({ roleDir: dir, taskName: '任务A', expertName: '编程开发', tier: 1, date: DAY });
    await writeTaskRegistration({ roleDir: dir, taskName: '任务B', expertName: '编程开发', tier: 3, date: DAY });
    await writeTaskRegistration({ roleDir: dir, taskName: '任务C', expertName: '编程开发', tier: 2, date: DAY });
    const tasks = await listExpertTasks(dir);
    assert.equal(tasks.length, 3, 'the expert has three task participations');
    assert.deepEqual(tasks.map(t => t.tier).sort(), [1, 2, 3], 'each keeps the tier it held');
    assert.deepEqual(tasks.map(t => t.taskName).sort(), ['任务A', '任务B', '任务C']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('nothing is written outside the expert folder and both trees appear', async () => {
  const dir = await roleDir();
  try {
    await writeDailyLog({ roleDir: dir, taskName: '登录重构', expertName: '编程开发', tier: 1, date: DAY });
    // A daily log alone creates the dated tree; the task tree appears with the registration.
    assert.deepEqual((await readdir(join(dir, 'log'))).sort(), ['2026']);
    assert.ok(await exists(join(dir, 'log', '2026', '10', '04', '登录重构.md')));

    await writeTaskRegistration({ roleDir: dir, taskName: '登录重构', expertName: '编程开发', tier: 1, date: DAY });
    assert.deepEqual((await readdir(join(dir, 'log'))).sort(), ['2026', '_tasks'].sort(),
      'the dated tree and the task tree are the only entries');
    assert.ok(await exists(join(dir, 'log', '_tasks', '登录重构', 'task.json')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
