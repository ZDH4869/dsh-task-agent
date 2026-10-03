/**
 * Self-check for role scaffolding and the model-facing tool that exposes it.
 *
 * Run: node --test D:\DSH_desktop\dsh-ext\task-agent-kit\test\role-scaffold.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateRoleName, composeRolePrompt, createRoleSkeleton, ROLE_FOLDERS } from '../src/role-scaffold.js';

const { apply } = await import('../index.js');

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'kit-scaffold-'));
}

function stubContext() {
  const tools = [];
  const registered = [];
  const logs = [];
  const cleanups = [];
  const ctx = {
    agentPresets: {
      resolve: async id => (id === 'standard' || id === undefined || id === '' ? { id: 'standard' } : { id }),
      list: async () => [],
      compositionInventory: async () => [{ id: 'standard', isDefault: true, rows: [] }],
      register: async definition => {
        registered.push(definition.id);
        return async () => {};
      },
    },
    tools: {
      register: definition => {
        tools.push(definition);
        return () => {};
      },
    },
    logger: { info: message => logs.push(`info:${message}`), warn: message => logs.push(`warn:${message}`) },
    effect: fn => {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    on: () => () => {},
  };
  return { ctx, tools, registered, logs, cleanups };
}

test('validateRoleName accepts real folder names and refuses unusable ones', () => {
  assert.equal(validateRoleName('  Backend Dev  '), 'Backend Dev');
  assert.equal(validateRoleName('编程开发'), '编程开发');
  // Surrounding whitespace is trimmed first, so a trailing space is not a defect…
  assert.equal(validateRoleName('trailing '), 'trailing');
  // …but a name that still ends with a dot would be refused by the filesystem.
  for (const bad of ['', '   ', 'a/b', 'a\\b', '..', '.', 'trailing.', 'bad:name', 'q?', 'x'.repeat(65)]) {
    assert.throws(() => validateRoleName(bad), /role name/u, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('composeRolePrompt carries the tier meaning and the description', () => {
  const first = composeRolePrompt({ roleName: 'Lead', tier: 1, description: 'owns delivery' });
  assert.match(first, /# Lead/u);
  assert.match(first, /第 1 层（一级 · 总 Agent）/u);
  assert.match(first, /职责：owns delivery/u);
  assert.match(first, /## 你的职责/u, 'a placeholder body is written when no template is available');

  const last = composeRolePrompt({ roleName: 'Worker', tier: 5, templateText: 'TEMPLATE BODY' });
  assert.match(last, /第 5 层（末级 · 执行 Agent）/u);
  assert.match(last, /TEMPLATE BODY/u, 'the supplied template body is used verbatim');

  const middle = composeRolePrompt({ roleName: 'Mid', tier: 3 });
  assert.match(middle, /中间层/u);
});

test('createRoleSkeleton writes the role and its conventional folders', async () => {
  const root = await tempRoot();
  try {
    const result = await createRoleSkeleton({ rootPath: root, roleName: 'Backend Dev', tier: 2, description: 'owns the API' });
    assert.equal(result.dryRun, false);
    assert.equal(result.roleName, 'Backend Dev');
    assert.equal(result.marker, 'Agent.md');

    const entries = (await readdir(join(root, 'Backend Dev'))).sort();
    for (const folder of ROLE_FOLDERS) assert.ok(entries.includes(folder), `missing ${folder}`);
    assert.ok(entries.includes('Agent.md'));
    assert.ok(entries.includes('agent.json'));

    const meta = JSON.parse(await readFile(join(root, 'Backend Dev', 'agent.json'), 'utf8'));
    assert.equal(meta.displayName, 'Backend Dev');
    assert.equal(meta.tier, 2);
    assert.match(meta.description, /owns the API/u);
    assert.ok(result.promptBytes > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a dry run plans everything and writes nothing', async () => {
  const root = await tempRoot();
  try {
    const result = await createRoleSkeleton({ rootPath: root, roleName: 'Planned', dryRun: true });
    assert.equal(result.dryRun, true);
    assert.ok(result.planned.some(entry => entry.path.endsWith('Agent.md')));
    assert.deepEqual(await readdir(root), [], 'dry run must not touch the filesystem');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createRoleSkeleton refuses to reuse an existing folder unless allowed', async () => {
  const root = await tempRoot();
  try {
    await mkdir(join(root, 'Taken'), { recursive: true });
    await assert.rejects(
      () => createRoleSkeleton({ rootPath: root, roleName: 'Taken' }),
      /already exists/u,
    );
    const forced = await createRoleSkeleton({ rootPath: root, roleName: 'Taken', overwrite: true });
    assert.equal(forced.dryRun, false);
    assert.ok((await readdir(join(root, 'Taken'))).includes('Agent.md'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createRoleSkeleton validates its inputs', async () => {
  const root = await tempRoot();
  try {
    await assert.rejects(() => createRoleSkeleton({ rootPath: '', roleName: 'X' }), /not configured/u);
    await assert.rejects(() => createRoleSkeleton({ rootPath: 'relative/path', roleName: 'X' }), /must be absolute/u);
    await assert.rejects(() => createRoleSkeleton({ rootPath: join(root, 'missing'), roleName: 'X' }), /does not exist/u);
    await assert.rejects(() => createRoleSkeleton({ rootPath: root, roleName: 'X', tier: 9 }), /tier must be an integer/u);
    await assert.rejects(() => createRoleSkeleton({ rootPath: root, roleName: 'X', tier: 0 }), /tier must be an integer/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a configured template directory supplies the role body', async () => {
  const root = await tempRoot();
  const templates = await tempRoot();
  try {
    await writeFile(join(templates, '02-中间层-编排Agent.md'), 'ORCHESTRATOR TEMPLATE', 'utf8');
    const result = await createRoleSkeleton({ rootPath: root, roleName: 'Mid', tier: 3, templateDir: templates });
    assert.equal(result.templateWarning, undefined);
    assert.match(await readFile(join(root, 'Mid', 'Agent.md'), 'utf8'), /ORCHESTRATOR TEMPLATE/u);

    const missing = await createRoleSkeleton({ rootPath: root, roleName: 'Other', tier: 1, templateDir: templates });
    assert.match(missing.templateWarning, /tier template not found/u, 'a missing template is reported, not fatal');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(templates, { recursive: true, force: true });
  }
});

test('apply exposes the scaffolding tool and registers the role it creates', async () => {
  const root = await tempRoot();
  try {
    const { ctx, tools, registered, cleanups } = stubContext();
    await apply(ctx, { sourceAgentPath: root, presetIdPrefix: 'taskagent' });

    assert.deepEqual(tools.map(tool => tool.name), ['create_task_agent_role']);
    const tool = tools[0];
    assert.ok(tool.parameters.role_name.required, 'role_name is required');
    assert.equal(typeof tool.execute, 'function');
    // `defineTool` reads `output.render` and validates `output.schema`; a tool shipped
    // without them crashed harness startup and pushed the app into safe mode.
    assert.ok(tool.output !== undefined, 'output is mandatory for defineTool');
    assert.equal(typeof tool.output.render, 'function', 'output.render must be a function');
    assert.ok(tool.output.schema !== undefined, 'output.schema must be declared');
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/u, 'tool names use the wire naming convention');

    const planned = await tool.execute({ role_name: 'Data Ops', dry_run: true });
    assert.match(planned, /^would create role "Data Ops"/u);
    assert.equal((await readdir(root)).length, 0, 'dry run leaves the root untouched');

    const created = await tool.execute({ role_name: 'Data Ops', tier: 6 });
    assert.match(created, /^could not create the role:/u, 'an out-of-range tier is refused by the tool');
    assert.match(created, /tier must be an integer/u);

    const ok = await tool.execute({ role_name: 'Data Ops', tier: 4, description: 'owns pipelines' });
    assert.match(ok, /^created role "Data Ops"/u);
    assert.ok(registered.includes('taskagent-data-ops'), `registered: ${registered.join(',')}`);
    assert.match(ok, /registered now/u);

    const again = await tool.execute({ role_name: 'Data Ops' });
    assert.match(again, /^could not create the role:/u);
    assert.match(again, /already exists/u);

    for (const cleanup of cleanups) await cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the scaffolding tool reports a clear reason when no path is configured', async () => {
  const { ctx, tools } = stubContext();
  await apply(ctx, { sourceAgentPath: '' });
  const result = await tools[0].execute({ role_name: 'Nowhere' });
  assert.match(result, /^could not create the role:/u);
  assert.match(result, /not configured/u);
});
