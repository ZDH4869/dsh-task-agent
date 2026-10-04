/**
 * Self-check for the Host task tools: registration, delivery, acceptance and memory.
 *
 * These run against a temporary expert folder, so the whole lifecycle is exercised without
 * a harness. The tools are the only writer into an expert's own `log\`, which is why every
 * step asserts the file it touched rather than a return value alone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTaskTools } from '../src/task-tools.js';
import { listExpertTasks, taskPaths } from '../src/task-registry.js';

/** Minimal defineTool stand-in that keeps the declared contract checkable. */
const defineTool = definition => {
  assert.equal(typeof definition.name, 'string');
  assert.equal(typeof definition.execute, 'function');
  assert.ok(definition.parameters !== undefined, `${definition.name} must declare parameters`);
  assert.ok(definition.output?.schema !== undefined, `${definition.name} must declare output.schema`);
  assert.equal(typeof definition.output?.render, 'function', `${definition.name} must declare output.render`);
  return definition;
};

async function toolsFor(root) {
  const dir = await mkdtemp(join(tmpdir(), 'kit-tools-'));
  const tools = createTaskTools({ sourcePath: () => dir, defineTool });
  return { dir, byName: new Map(tools.map(tool => [tool.name, tool])), root };
}

test('the host exposes exactly the five task-record tools', async () => {
  const { dir, byName } = await toolsFor();
  try {
    assert.deepEqual([...byName.keys()].sort(), [
      'read_task_context',
      'record_acceptance',
      'record_delivery',
      'register_task_participation',
      'write_context_memory',
    ]);
    for (const tool of byName.values()) assert.equal(tool.output.schema.type, 'string');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('registration records the tier and the parent task, and writes the daily log', async () => {
  const { dir, byName } = await toolsFor();
  try {
    const answer = await byName.get('register_task_participation').execute({
      expert_name: '编程开发', task_name: '登录重构', tier: 3, task_id: 'task-7', parent_task_id: 'task-3',
    });
    assert.match(answer, /第 3 层/u);
    assert.match(answer, /上级任务 task-3/u);
    const tasks = await listExpertTasks(join(dir, '编程开发'));
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].tier, 3);
    assert.equal(tasks[0].parentTaskId, 'task-3');
    const log = await readFile(taskPaths(join(dir, '编程开发'), '登录重构').dailyLog, 'utf8');
    assert.match(log, /可反哺 skills \/ 知识库的优化项/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('delivery keeps the tier, then acceptance overwrites the status', async () => {
  const { dir, byName } = await toolsFor();
  try {
    await byName.get('register_task_participation').execute({
      expert_name: '编程开发', task_name: '登录重构', tier: 2,
    });
    await byName.get('record_delivery').execute({
      expert_name: '编程开发', task_name: '登录重构',
      deliverable: 'docs\\login.md', effect: '可用', feedback_improvements: '把登录校验写进 .skills',
    });
    let [task] = await listExpertTasks(join(dir, '编程开发'));
    assert.equal(task.tier, 2, 'a delivery must not erase the tier');
    assert.equal(task.deliverable, 'docs\\login.md');
    assert.equal(task.acceptance.status, 'pending', 'a delivery is not an acceptance');

    await byName.get('record_acceptance').execute({
      expert_name: '编程开发', task_name: '登录重构', passed: true, reviewer: '总架构师',
    });
    [task] = await listExpertTasks(join(dir, '编程开发'));
    assert.equal(task.acceptance.status, 'passed');
    assert.equal(task.acceptance.by, '总架构师');
    assert.equal(task.tier, 2, 'acceptance must not erase the tier either');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rejection must carry its reason', async () => {
  const { dir, byName } = await toolsFor();
  try {
    await byName.get('register_task_participation').execute({ expert_name: '编程开发', task_name: '登录重构', tier: 2 });
    await assert.rejects(
      () => byName.get('record_acceptance').execute({ expert_name: '编程开发', task_name: '登录重构', passed: false }),
      /驳回必须写明理由/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('memory tools append and read back the newest entries, per task', async () => {
  const { dir, byName } = await toolsFor();
  try {
    for (const text of ['第一条', '第二条', '第三条', '第四条']) {
      await byName.get('write_context_memory').execute({ expert_name: '编程开发', task_name: '任务A', text });
    }
    await byName.get('write_context_memory').execute({ expert_name: '编程开发', task_name: '任务B', text: '别的任务' });

    const answer = await byName.get('read_task_context').execute({ expert_name: '编程开发', task_name: '任务A' });
    assert.match(answer, /第二条/u);
    assert.match(answer, /第四条/u);
    assert.ok(!answer.includes('第一条'), 'only the newest three are returned');
    assert.ok(!answer.includes('别的任务'), 'memories stay separated by task');

    const single = await byName.get('read_task_context').execute({ expert_name: '编程开发', task_name: '任务A', limit: 1 });
    assert.match(single, /第四条/u);
    assert.ok(!single.includes('第三条'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing source path is refused with an actionable message', async () => {
  const tools = createTaskTools({ sourcePath: () => '', defineTool });
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  await assert.rejects(
    () => byName.get('register_task_participation').execute({ expert_name: '编程开发', task_name: '任务A', tier: 1 }),
    /源 agent 路径未配置/u,
  );
});

test('an expert name that tries to escape the source path is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kit-escape-'));
  try {
    const tools = createTaskTools({ sourcePath: () => dir, defineTool });
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    for (const name of ['..\\..\\Windows', 'a/b', '..']) {
      await assert.rejects(
        () => byName.get('register_task_participation').execute({ expert_name: name, task_name: '任务A', tier: 1 }),
        /不能含路径分隔符/u,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
