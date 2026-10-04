/**
 * Self-check for wiring the expert task records onto the upstream team board (#8).
 *
 * The board is upstream (`agentTeams`, from the Agent Teams packages) and OPTIONAL: this
 * plugin must keep working — and keep saying so — when the board is absent, the caller is
 * not a Team member, or the board itself fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTaskTools } from '../src/task-tools.js';

const defineTool = definition => definition;
/** The invoking Agent a scoped tool discovery would supply. */
const CALLER = { id: 'session-lead-1' };

/**
 * A stand-in for `agentTeams` that records every call it receives.
 *
 * `known` is the set of task ids THIS caller's board can see. A teammate's board is its own
 * Team log, so an id the Lead created throws here — which is exactly the isolation the
 * visibility guard exists for.
 */
function stubBoard({ member = true, fail = undefined, known = ['task-1'], role = 'lead' } = {}) {
  const calls = [];
  const revisions = new Map(known.map(id => [id, 1]));
  const statuses = new Map(known.map(id => [id, 'pending']));
  let created = 0;
  return {
    calls,
    revisions,
    statuses,
    /** Simulate a transition made elsewhere: the side table's cached revision goes stale. */
    bumpOutside(id) {
      revisions.set(id, (revisions.get(id) ?? 0) + 1);
    },
    tryMembership: () => (member ? { root: CALLER, id: 'team-1', role, name: role === 'lead' ? 'lead' : 'member' } : undefined),
    getTask(_caller, id) {
      if (!revisions.has(id)) throw new Error(`unknown team task "${id}"`);
      return { id, revision: revisions.get(id), status: statuses.get(id) };
    },
    async createTask(caller, request) {
      calls.push(['createTask', caller?.id, request]);
      if (fail === 'createTask') throw new Error('board exploded');
      created += 1;
      const id = `task-new-${created}`;
      revisions.set(id, 1);
      statuses.set(id, 'pending');
      return { id, revision: 1, status: 'pending', subject: request.subject };
    },
    async updateTask(caller, request) {
      calls.push(['updateTask', caller?.id, request]);
      if (fail === 'updateTask') throw new Error('board exploded');
      const status = statuses.get(request.taskId);
      if (request.expectedRevision !== revisions.get(request.taskId)) {
        throw new Error(`stale team task "${request.taskId}" revision ${request.expectedRevision}; current revision is ${revisions.get(request.taskId)}`);
      }
      // The upstream invariants this stub must honour, or the tests would pass on a fiction.
      if (request.action === 'claim' && status !== 'pending') throw new Error('team task is not ready to claim');
      if (request.action === 'complete' && status !== 'in_progress') throw new Error('only an in-progress task can complete');
      if (request.action === 'reopen' && status !== 'completed') throw new Error('only a completed task can be reopened');
      if (request.action === 'release' && status !== 'in_progress') throw new Error('only an in-progress task can be released');
      const next = (revisions.get(request.taskId) ?? 0) + 1;
      revisions.set(request.taskId, next);
      statuses.set(request.taskId,
        request.action === 'claim' ? 'in_progress'
          : request.action === 'complete' ? 'completed'
            : request.action === 'reopen' || request.action === 'release' ? 'pending'
              : status);
      return { id: request.taskId, revision: next, status: statuses.get(request.taskId) };
    },
  };
}

async function toolsFor({ board, withCaller = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'kit-board-'));
  const tools = createTaskTools({
    sourcePath: () => dir,
    defineTool,
    getTeamBoard: () => board,
  });
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const exec = withCaller ? { agent: CALLER, signal: new AbortController().signal } : { signal: new AbortController().signal };
  return { dir, byName, exec };
}

async function taskRecord(dir) {
  return JSON.parse(await readFile(
    join(dir, '编程开发', 'log', '_tasks', '登录重构', 'task.json'), 'utf8',
  ));
}

test('registration creates and claims an upstream task, and remembers its revision', async () => {
  const board = stubBoard();
  const { dir, byName, exec } = await toolsFor({ board });
  try {
    const answer = await byName.get('register_task_participation').execute(
      { expert_name: '编程开发', task_name: '登录重构', tier: 3 }, exec,
    );
    assert.deepEqual(board.calls[0].slice(0, 2), ['createTask', 'session-lead-1']);
    assert.equal(board.calls[0][2].subject, '登录重构');
    // The claim is what puts the entry in progress. NOTE: the board's `claim` sets the owner
    // to the CALLER, so the request carries no `owner` — the expert's name is in the subject
    // and description instead.
    assert.equal(board.calls[1][2].action, 'claim');
    assert.equal(board.calls[1][2].owner, undefined, 'claim ignores a requested owner');
    assert.equal(board.calls[1][2].expectedRevision, 1, 'the claim is compare-and-set on revision 1');

    const record = await taskRecord(dir);
    assert.equal(record.upstreamTaskId, 'task-new-1');
    assert.equal(record.upstreamRevision, 2, 'the claimed revision is stored for later transitions');
    assert.match(answer, /任务板：已创建并认领 task-new-1（修订 2；板主是 Lead/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a delivery edits the board task with what was produced', async () => {
  const board = stubBoard();
  const { dir, byName, exec } = await toolsFor({ board });
  try {
    await byName.get('register_task_participation').execute({ expert_name: '编程开发', task_name: '登录重构', tier: 2 }, exec);
    await byName.get('record_delivery').execute(
      { expert_name: '编程开发', task_name: '登录重构', deliverable: 'docs\\login.md', effect: '可用' }, exec,
    );
    const edit = board.calls.find(call => call[0] === 'updateTask' && call[2].action === 'edit');
    assert.ok(edit !== undefined, 'the delivery edits the board task');
    assert.match(edit[2].description, /docs\\login\.md/u);
    assert.match(edit[2].description, /待上级验收/u);
    // The acceptance side table is untouched by a delivery.
    assert.equal((await taskRecord(dir)).acceptance.status, 'pending');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('acceptance closes the board task; a rejection reopens it (驳回回退)', async () => {
  const board = stubBoard();
  const { dir, byName, exec } = await toolsFor({ board });
  try {
    await byName.get('register_task_participation').execute({ expert_name: '编程开发', task_name: '登录重构', tier: 2 }, exec);
    await byName.get('record_acceptance').execute(
      { expert_name: '编程开发', task_name: '登录重构', passed: false, note: '缺少回归测试' }, exec,
    );
    // Registration claimed the entry, so it is in_progress: a rejection RELEASES it back to
    // pending and clears the owner, so the lower tier can redo it.
    const rejection = board.calls.at(-1);
    assert.equal(rejection[2].action, 'release', 'an in-progress task is released, not left owned');
    assert.equal(board.statuses.get('task-new-1'), 'pending', 'the entry is back to an open state');
    assert.match(board.calls.find(call => call[2]?.action === 'edit')[2].description, /缺少回归测试/u);
    assert.equal((await taskRecord(dir)).acceptance.status, 'rejected');

    await byName.get('record_acceptance').execute(
      { expert_name: '编程开发', task_name: '登录重构', passed: true, reviewer: '总架构师' }, exec,
    );
    // The board only completes an in-progress task, so a pending one is claimed first.
    const actions = board.calls.map(call => call[2]?.action);
    assert.ok(actions.includes('complete'), 'an accepted delivery closes the board task');
    assert.equal(board.statuses.get('task-new-1'), 'completed');
    assert.equal((await taskRecord(dir)).acceptance.status, 'passed');

    // Rejecting something already completed must REOPEN it: "completed + rejected" is exactly
    // the self-contradictory state the lower tier could never act on.
    await byName.get('record_acceptance').execute(
      { expert_name: '编程开发', task_name: '登录重构', passed: false, note: '再补一项' }, exec,
    );
    assert.equal(board.calls.at(-1)[2].action, 'reopen', 'a completed task is reopened');
    assert.equal(board.statuses.get('task-new-1'), 'pending', 'and it is open again');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('without a board the record still works and says so', async () => {
  const { dir, byName, exec } = await toolsFor({ board: undefined });
  try {
    const answer = await byName.get('register_task_participation').execute(
      { expert_name: '编程开发', task_name: '登录重构', tier: 1 }, exec,
    );
    assert.match(answer, /上游 Agent Teams 不可用/u);
    assert.equal((await taskRecord(dir)).upstreamTaskId, null, 'no board entry is invented');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a caller outside the team roster does not touch the board', async () => {
  const board = stubBoard({ member: false });
  const { dir, byName, exec } = await toolsFor({ board });
  try {
    const answer = await byName.get('register_task_participation').execute(
      { expert_name: '编程开发', task_name: '登录重构', tier: 1 }, exec,
    );
    assert.equal(board.calls.length, 0, 'a non-member writes nothing');
    assert.match(answer, /不在 Team 名单/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing invoking agent degrades instead of failing', async () => {
  const board = stubBoard();
  const { dir, byName, exec } = await toolsFor({ board, withCaller: false });
  try {
    const answer = await byName.get('register_task_participation').execute(
      { expert_name: '编程开发', task_name: '登录重构', tier: 1 }, exec,
    );
    assert.equal(board.calls.length, 0);
    assert.match(answer, /不是 Team 成员/u);
    assert.equal((await taskRecord(dir)).tier, 1, 'the side table is still written');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failing board is reported, never fatal', async () => {
  const board = stubBoard({ fail: 'createTask' });
  const { dir, byName, exec } = await toolsFor({ board });
  try {
    const answer = await byName.get('register_task_participation').execute(
      { expert_name: '编程开发', task_name: '登录重构', tier: 2 }, exec,
    );
    assert.match(answer, /任务板写入失败：board exploded/u);
    assert.equal((await taskRecord(dir)).tier, 2, 'the record survives a board outage');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('re-registering adopts the recorded entry instead of creating another one (idempotent)', async () => {
  const board = stubBoard();
  const { dir, byName, exec } = await toolsFor({ board });
  try {
    await byName.get('register_task_participation').execute({ expert_name: '编程开发', task_name: '登录重构', tier: 1 }, exec);
    const created = board.calls.filter(call => call[0] === 'createTask').length;
    await byName.get('register_task_participation').execute({ expert_name: '编程开发', task_name: '登录重构', tier: 1 }, exec);
    assert.equal(board.calls.filter(call => call[0] === 'createTask').length, created,
      'a second registration must NOT create a second board entry');
    const record = await taskRecord(dir);
    assert.equal(record.upstreamTaskId, 'task-new-1', 'the original entry is kept');
    assert.equal(record.upstreamRevision, board.revisions.get('task-new-1'), 'the revision is refreshed from the board');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an explicit upstream_task_id is adopted without creating anything', async () => {
  const board = stubBoard({ known: ['task-2'] });
  const { dir, byName, exec } = await toolsFor({ board });
  try {
    const answer = await byName.get('register_task_participation').execute(
      { expert_name: '编程开发', task_name: '登录重构', tier: 2, upstream_task_id: 'task-2' }, exec,
    );
    assert.equal(board.calls.filter(call => call[0] === 'createTask').length, 0, 'nothing is created');
    assert.match(answer, /已挂到任务板条目 task-2/u);
    assert.equal((await taskRecord(dir)).upstreamTaskId, 'task-2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a teammate does not create board entries of its own', async () => {
  const board = stubBoard({ role: 'teammate' });
  const { dir, byName, exec } = await toolsFor({ board });
  try {
    const answer = await byName.get('register_task_participation').execute(
      { expert_name: '编程开发', task_name: '登录重构', tier: 2 }, exec,
    );
    assert.equal(board.calls.length, 0, 'a teammate writes nothing on a board it does not own');
    assert.match(answer, /下级不新建任务板条目/u);
    assert.equal((await taskRecord(dir)).upstreamTaskId, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an id from the Lead board is not written by a teammate (名册隔离)', async () => {
  // The teammate's own board does not hold `task-2`; writing by id anyway is what produced
  // "档案成功、板子没变" plus a stale-revision error on every later transition.
  const board = stubBoard({ role: 'teammate', known: ['task-teammate-1'] });
  const { dir, byName, exec } = await toolsFor({ board });
  try {
    const answer = await byName.get('register_task_participation').execute(
      { expert_name: '编程开发', task_name: '登录重构', tier: 2, upstream_task_id: 'task-2' }, exec,
    );
    assert.equal(board.calls.filter(call => call[0] === 'createTask').length, 0);
    assert.equal(board.calls.filter(call => call[0] === 'updateTask').length, 0, 'no write reaches the unseen entry');
    assert.match(answer, /不在你的名册里/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a delivery reports whether a path-shaped deliverable actually exists', async () => {
  const board = stubBoard();
  const { dir, byName, exec } = await toolsFor({ board });
  try {
    await byName.get('register_task_participation').execute({ expert_name: '编程开发', task_name: '登录重构', tier: 1 }, exec);

    // Missing artefact: a registered string must not read as a produced file.
    const missing = await byName.get('record_delivery').execute(
      { expert_name: '编程开发', task_name: '登录重构', deliverable: 'reports/absent.md' }, exec,
    );
    assert.match(missing, /未找到实体文件/u);

    // Free text is not a path: nothing is claimed either way.
    const freeText = await byName.get('record_delivery').execute(
      { expert_name: '编程开发', task_name: '登录重构', deliverable: 'QPS 1200，P99 80ms' }, exec,
    );
    assert.ok(!freeText.includes('实体文件'), 'free text carries no existence claim');

    // Present artefact: reported as found.
    await mkdir(join(dir, '编程开发', 'reports'), { recursive: true });
    await writeFile(join(dir, '编程开发', 'reports', 'perf.md'), 'ok', 'utf8');
    const found = await byName.get('record_delivery').execute(
      { expert_name: '编程开发', task_name: '登录重构', deliverable: 'reports/perf.md' }, exec,
    );
    assert.match(found, /实体文件存在/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('a revision changed elsewhere heals instead of failing (重读而非信任缓存)', async () => {
  // This is the failure the field test hit: three board transitions were made by other calls,
  // the side table still cached the old revision, and every later compare-and-set failed with
  // `stale team task ... current revision is N` — with no way to recover.
  const board = stubBoard();
  const { dir, byName, exec } = await toolsFor({ board });
  try {
    await byName.get('register_task_participation').execute({ expert_name: '编程开发', task_name: '登录重构', tier: 1 }, exec);
    assert.equal((await taskRecord(dir)).upstreamRevision, 2);

    // Somebody else moves the entry along, twice.
    board.bumpOutside('task-new-1');
    board.bumpOutside('task-new-1');

    const answer = await byName.get('record_delivery').execute(
      { expert_name: '编程开发', task_name: '登录重构', deliverable: 'docs/x.md' }, exec,
    );
    assert.match(answer, /任务板：已更新交付说明/u, 'the write re-reads the revision instead of trusting the cache');
    assert.equal((await taskRecord(dir)).upstreamRevision, board.revisions.get('task-new-1'),
      'the side table adopts the revision it just read');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});