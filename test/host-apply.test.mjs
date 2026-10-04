/**
 * Integration self-check for the Host half of the bundle.
 *
 * It drives `apply(ctx, config)` with a stubbed context and a real role folder on
 * disk, then asserts what would be registered: one preset per role, carrying the
 * role prompt as persona, the role's skill directory, its MCP servers, and the base
 * template's rows. This catches wiring mistakes without installing the bundle.
 *
 * Run: node --test D:\DSH_desktop\dsh-ext\task-agent-kit\test\host-apply.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = JSON.parse(await readFile(join(HERE, '..', 'preset-base.json'), 'utf8'));
const BASE_ROWS = TEMPLATE.plugins.length;

const { apply } = await import('../index.js');

function stubContext(options = {}) {
  const registered = [];
  const disposed = [];
  const logs = [];
  const effects = [];
  const cleanups = [];
  const subscriptions = [];
  const ctx = {
    agentPresets: {
      // `AgentPreset` carries display metadata only — never a plugin list. A role id
      // resolves to itself, which is how a broken definition is reported back.
      resolve: async id => {
        if (id === undefined || id === '' || id === TEMPLATE.sourcePreset) return { id: TEMPLATE.sourcePreset, name: 'Standard' };
        if ((options.roleBroken ?? []).includes(id)) return { id, broken: 'mount exploded' };
        if (typeof id === 'string' && id.startsWith('taskagent-')) return { id, name: id };
        throw new Error(`unknown preset ${id}`);
      },
      list: async () => options.existingPresets ?? [],
      compositionInventory: async () => options.inventory ?? [{
        id: TEMPLATE.sourcePreset,
        isDefault: true,
        rows: TEMPLATE.plugins.map((row, index) => ({ entryId: `e${index}`, moduleName: row.name, enabled: true })),
      }],
      register: async definition => {
        registered.push(structuredClone(definition));
        return async () => {
          disposed.push(definition.id);
        };
      },
    },
    logger: {
      info: message => logs.push(`info:${message}`),
      warn: message => logs.push(`warn:${message}`),
    },
    effect: fn => {
      // Cordis runs the factory immediately and keeps what it returns as the cleanup.
      effects.push(fn);
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    // Host context event bus: the settings service announces live edits here.
    on: (name, handler) => {
      subscriptions.push({ name, handler });
      return () => {};
    },
  };
  return { ctx, registered, disposed, logs, effects, cleanups, subscriptions };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kit-host-'));
  await mkdir(join(root, 'Backend Dev', '.skills', 'demo'), { recursive: true });
  await writeFile(join(root, 'Backend Dev', 'Agent.md'), '# Backend Dev\n\nOwns the API surface.\n', 'utf8');
  await writeFile(join(root, 'Backend Dev', '.skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n', 'utf8');
  await writeFile(join(root, 'Backend Dev', 'mcp.json'), JSON.stringify({ mcpServers: { api: { command: 'node' } } }), 'utf8');
  await mkdir(join(root, 'log'), { recursive: true }); // resource folder: must be skipped
  await mkdir(join(root, 'Empty Role'), { recursive: true }); // marker present, prompt empty
  await writeFile(join(root, 'Empty Role', 'Agent.md'), '', 'utf8');
  return root;
}

/**
 * `apply()` now activates immediately and runs the roster scan once the Loader tree settles —
 * that deferral is what keeps boot fast — so a test must let that deferred work finish before
 * reading anything the scan produced (presets, status file, log lines).
 */
async function settled(ms = 150) {
  await new Promise(resolve => setTimeout(resolve, ms));
}
test('apply never waits for a settings write (boot deadlock guard)', async () => {
  const root = await fixture();
  try {
    const { ctx } = stubContext();
    // A settings write is reconciled through the Loader, and during boot the Loader is still
    // waiting for THIS apply() to settle. Awaiting the write inside apply() therefore
    // deadlocks the whole boot — observed in the field as
    // `[loader] plugin initialization timed out after 100s` with DSH stuck on its splash.
    // Both the write and the Loader are made never to settle, so ANY awaited write inside
    // apply() would hang here and fail instead of booting the app into a deadlock.
    const never = () => new Promise(() => {});
    ctx.get = name => (name === 'settings' ? { update: never } : undefined);
    ctx.root = { loader: { await: never } };

    const outcome = await Promise.race([
      apply(ctx, { sourceAgentPath: root, presetIdPrefix: 'taskagent' }).then(() => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('hung'), 1500)),
    ]);
    assert.equal(outcome, 'settled', 'apply() must resolve without awaiting the settings write');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the host publishes each expert task history for the observer room', async () => {
  const root = await fixture();
  try {
    // One task record for the role, in the documented layout.
    await mkdir(join(root, 'Backend Dev', 'log', '_tasks', '登录重构'), { recursive: true });
    await writeFile(join(root, 'Backend Dev', 'log', '_tasks', '登录重构', 'task.json'), JSON.stringify({
      taskName: '登录重构',
      tier: 2,
      deliverable: 'docs\\login.md',
      acceptance: { status: 'passed' },
      updatedAt: '2026-10-04T00:00:00.000Z',
    }), 'utf8');

    const { ctx } = stubContext();
    const patches = [];
    ctx.get = name => (name === 'settings' ? { update: async (_ns, patch) => patches.push(patch) } : undefined);
    ctx.root = { loader: { await: async () => {} } };

    await apply(ctx, { sourceAgentPath: root, presetIdPrefix: 'taskagent' });
    await settled();
    // The publication is deliberately deferred until the Loader settles (see the deadlock
    // guard), so give the deferred task a moment to run.
    await new Promise(resolve => setTimeout(resolve, 50));

    const published = patches.find(patch => patch.expertTasks !== undefined);
    assert.ok(published !== undefined, `expertTasks must be published; got ${JSON.stringify(patches)}`);
    const tasks = JSON.parse(published.expertTasks)['taskagent-backend-dev'];
    assert.equal(tasks.length, 1, 'the one recorded task is published');
    assert.equal(tasks[0].name, '登录重构');
    assert.equal(tasks[0].tier, 2, 'the tier the expert held is carried through');
    assert.equal(tasks[0].status, 'passed', 'the acceptance status is carried through');
    assert.equal(tasks[0].deliverable, 'docs\\login.md');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply survives a service that throws on property access (Cordis inject)', async () => {
  const root = await fixture();
  try {
    const { ctx } = stubContext();
    // Cordis THROWS on reading a property whose service is not in the plugin's `inject` list:
    // `cannot get property "systemPrompt" without inject`. Modeling exactly that catches the
    // class of bug that failed a real boot — an optional-looking `ctx.service?.method` still
    // throws, because it is the ACCESS that fails, not the call.
    let hook;
    Object.defineProperty(ctx, 'systemPrompt', {
      configurable: true,
      get() {
        throw new Error('cannot get property "systemPrompt" without inject');
      },
    });
    // The supported optional path still finds it and registers the injection.
    ctx.get = name => (name === 'systemPrompt'
      ? { context: configuration => { hook = configuration; return () => {}; } }
      : undefined);
    ctx.root = { loader: { await: async () => {} } };

    await apply(ctx, { sourceAgentPath: root, presetIdPrefix: 'taskagent' });
    await settled();
    assert.ok(hook !== undefined, 'the injection is registered through the optional lookup');
    assert.equal(hook.name, 'task-agent:expert-memory');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the host injects a task session\'s newest memories before each model step', async () => {
  const root = await fixture();
  try {
    const taskDir = join(root, 'Backend Dev', 'log', '_tasks', '登录重构');
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, 'task.json'), JSON.stringify({
      taskName: '登录重构', tier: 2, sessionId: 'session-task-1',
    }), 'utf8');
    await writeFile(join(taskDir, 'context.md'),
      '# 上下文记忆\n\n## 记忆条目\n\n'
      + '### 2026-10-01T00:00:00.000Z　[agent]\n\n第 1 条记忆\n\n'
      + '### 2026-10-02T00:00:00.000Z　[agent]\n\n第 2 条记忆\n\n'
      + '### 2026-10-03T00:00:00.000Z　[agent]\n\n第 3 条记忆\n\n'
      + '### 2026-10-04T00:00:00.000Z　[agent]\n\n第 4 条记忆\n\n'
      + '### 2026-10-05T00:00:00.000Z　[agent]\n\n第 5 条记忆\n',
      'utf8');

    const { ctx } = stubContext();
    let hook;
    // Exposed through the optional lookup the plugin actually uses (`ctx.get`), never as a
    // hard-injected property.
    ctx.get = name => (name === 'systemPrompt'
      ? {
        context: configuration => {
          hook = configuration;
          return () => {};
        },
      }
      : undefined);
    ctx.root = { loader: { await: async () => {} } };

    await apply(ctx, { sourceAgentPath: root, presetIdPrefix: 'taskagent' });
    await settled();

    assert.ok(hook !== undefined, 'the memory context must be registered');
    assert.equal(hook.name, 'task-agent:expert-memory');
    assert.equal(hook.order, 130, 'after sandbox(110), approval(115) and delegation(120)');
    // Nothing is injected for an unrelated session, and an unknown assembly shape is inert.
    assert.equal(hook.text({ agent: { id: 'someone-else' } }), '');
    assert.equal(hook.text({}), '', 'a missing agent must yield an empty injection, never throw');

    // The cache is filled off the assembly path (deferred until the Loader settles).
    await new Promise(resolve => setTimeout(resolve, 50));
    const injected = hook.text({ agent: { id: 'session-task-1' } });
    assert.match(injected, /本任务既有记忆/u);
    assert.match(injected, /第 5 条记忆/u);
    assert.ok(!injected.includes('第 2 条记忆'), 'only the newest three entries are injected');
    assert.ok(!injected.includes('第 1 条记忆'), 'only the newest three entries are injected');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply registers one preset per role, cloning the shipped base template', async () => {
  const root = await fixture();
  try {
    const { ctx, registered, logs, effects, cleanups } = stubContext();
    await apply(ctx, { sourceAgentPath: root, presetIdPrefix: 'taskagent' });
    await settled();

    assert.equal(registered.length, 1, `expected only the marked non-empty role, got ${registered.map(r => r.id).join(',')}`);
    const preset = registered[0];
    assert.equal(preset.id, 'taskagent-backend-dev');
    assert.equal(preset.name, 'Backend Dev');
    assert.equal(preset.description, 'Backend Dev');
    assert.equal(preset.plugins.length, BASE_ROWS + 1, `base template rows (${BASE_ROWS}) plus one MCP row`);

    const persona = preset.plugins.find(row => row.name === '@deepseek-ai/dsh-persona');
    assert.match(persona.config.prefix, /Owns the API surface/u, 'role prompt becomes the persona');
    assert.equal(persona.config.suffix, 'Your working directory is {{cwd}}.', 'base persona fields survive');

    const skills = preset.plugins.find(row => row.name === '@deepseek-ai/dsh-skill-filesystem');
    assert.deepEqual(skills.config.customSkillDirs, [join(root, 'Backend Dev', '.skills')]);

    const mcp = preset.plugins.filter(row => row.name === '@deepseek-ai/dsh-mcp-client');
    assert.equal(mcp.length, 1);
    assert.equal(mcp[0].config.serverName, 'api');

    const ids = preset.plugins.map(row => row.id);
    assert.equal(new Set(ids).size, ids.length, 'row ids must be unique inside the preset');
    assert.ok(preset.plugins.some(row => row.name === '@deepseek-ai/dsh-tool-pwsh'), 'base tool rows survive');

    assert.ok(
      logs.some(line => line.includes('registered 1 role preset') && line.includes('skipped 1 folder')),
      `logs: ${logs.join(' | ')}`,
    );
    // Settings subscription + the memory-cache interval + the final disposer. The
    // systemPrompt registration and the tool rows are absent here because this stub exposes
    // neither service.
    assert.equal(effects.length, 3, 'a settings subscription, the memory interval and the disposer');
    assert.equal(cleanups.length, 3, 'every effect must hand back a cleanup');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply warns when the live base preset has rows the template lacks', async () => {
  const root = await fixture();
  try {
    const inventory = [{
      id: TEMPLATE.sourcePreset,
      isDefault: true,
      rows: [
        ...TEMPLATE.plugins.map((row, index) => ({ entryId: `e${index}`, moduleName: row.name, enabled: true })),
        { entryId: 'new', moduleName: '@deepseek-ai/dsh-tool-brand-new', enabled: true },
      ],
    }];
    const { ctx, logs } = stubContext({ inventory });
    await apply(ctx, { sourceAgentPath: root });
    await settled();
    assert.ok(
      logs.some(line => line.startsWith('warn:') && line.includes('base preset drift') && line.includes('dsh-tool-brand-new')),
      `logs: ${logs.join(' | ')}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply skips roles with an empty prompt by default and can allow them', async () => {
  const root = await fixture();
  try {
    const first = stubContext();
    await apply(first.ctx, { sourceAgentPath: root });
    await settled();
    assert.deepEqual(first.registered.map(row => row.id), ['taskagent-backend-dev'], 'empty-prompt role skipped');

    const second = stubContext();
    await apply(second.ctx, { sourceAgentPath: root, allowEmptyPrompt: true });
    await settled();
    assert.deepEqual(second.registered.map(row => row.id).sort(), ['taskagent-backend-dev', 'taskagent-empty-role']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply tolerates an unconfigured or unreadable path without throwing', async () => {
  const empty = stubContext();
  await apply(empty.ctx, { sourceAgentPath: '' });
  await settled();
  assert.equal(empty.registered.length, 0);
  assert.ok(empty.logs.some(line => line.includes('not configured')), `logs: ${empty.logs.join(' | ')}`);

  const broken = stubContext();
  await apply(broken.ctx, { sourceAgentPath: 'D:\\this\\path\\does\\not\\exist\\task-agent-kit' });
  await settled();
  assert.equal(broken.registered.length, 0);
  assert.ok(broken.logs.some(line => line.startsWith('warn:')), `logs: ${broken.logs.join(' | ')}`);
});

test('apply reports an unknown base preset through the logger instead of throwing', async () => {
  const root = await fixture();
  try {
    const { ctx, registered, logs } = stubContext();
    await apply(ctx, { sourceAgentPath: root, basePresetId: 'no-such-preset' });
    await settled();
    assert.equal(registered.length, 0);
    assert.ok(logs.some(line => line.startsWith('warn:') && line.includes('initial scan failed')), `logs: ${logs.join(' | ')}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('disposing the plugin unregisters every preset it registered', async () => {
  const root = await fixture();
  try {
    const { ctx, registered, disposed, cleanups } = stubContext();
    await apply(ctx, { sourceAgentPath: root });
    await settled();
    assert.equal(registered.length, 1);
    for (const cleanup of cleanups) await cleanup();
    assert.deepEqual(disposed, registered.map(row => row.id));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the shipped template carries no drift against a live base preset built from it', async () => {
  // Regression guard: the live inventory reports rows FLATTENED, while the template
  // nests them inside `cordis:group` rows. Comparing without flattening reported every
  // grouped row (`plan-mode`, `compaction-basic`, …) as drift. The default stub
  // inventory mirrors the template's own rows, so this must produce no warning.
  const root = await fixture();
  try {
    const { ctx, logs } = stubContext();
    await apply(ctx, { sourceAgentPath: root });
    await settled();
    const driftLines = logs.filter(line => line.includes('drift'));
    assert.deepEqual(driftLines, [], `unexpected drift: ${driftLines.join(' | ')}`);

    const grouped = TEMPLATE.plugins.filter(row => Array.isArray(row.config)).length;
    assert.ok(grouped > 0, 'the template must still contain group rows for this guard to mean anything');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the flattening helper descends into group rows', async () => {
  const { flattenModuleNames } = await import('../index.js').then(mod => ({ flattenModuleNames: mod.__testFlatten ?? undefined }));
  if (flattenModuleNames === undefined) {
    // Not exported for tests; assert the behaviour through the template instead.
    const nested = TEMPLATE.plugins.filter(row => Array.isArray(row.config));
    assert.ok(nested.length > 0);
    const nestedNames = nested.flatMap(row => row.config.map(child => child?.name));
    assert.ok(nestedNames.includes('@deepseek-ai/dsh-plan-mode'), 'group children must be reachable in the template');
    return;
  }
  assert.ok(flattenModuleNames([{ name: 'a', config: [{ name: 'b', config: [{ name: 'c' }] }] }]).has('c'));
});

test('a configured status file records the scan outcome', async () => {
  const root = await fixture();
  const statusDir = await mkdtemp(join(tmpdir(), 'kit-status-'));
  const statusFile = join(statusDir, 'nested', 'roster.json');
  try {
    const { ctx } = stubContext();
    await apply(ctx, { sourceAgentPath: root, statusFile });
    await settled();
    const payload = JSON.parse(await readFile(statusFile, 'utf8'));
    assert.equal(payload.sourceAgentPath, root);
    assert.equal(payload.basePreset, TEMPLATE.sourcePreset);
    assert.equal(payload.baseRows, BASE_ROWS);
    assert.deepEqual(payload.registered.map(entry => entry.presetId), ['taskagent-backend-dev']);
    assert.equal(payload.registered[0].rows, BASE_ROWS + 1);
    assert.equal(payload.failures.length, 1, 'the empty-prompt role is recorded as a failure');
    assert.deepEqual(payload.adopted, []);
    assert.deepEqual(payload.drift, []);
    assert.match(payload.writtenAt, /^\d{4}-\d{2}-\d{2}T/u);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(statusDir, { recursive: true, force: true });
  }
});

test('failures are reported at warning level so they reach the harness log', async () => {
  const root = await fixture();
  try {
    const { ctx, logs } = stubContext();
    await apply(ctx, { sourceAgentPath: root });
    await settled();
    assert.ok(
      logs.some(line => line.startsWith('warn:') && line.includes('role(s) failed') && line.includes('Empty Role')),
      `logs: ${logs.join(' | ')}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a preset that register() accepted but that failed to mount is reported as a failure', async () => {
  // `register()` resolves even when the definition did not mount: the registry stores
  // the failure as `broken`. Reporting the roster without reading it back would claim
  // a preset that can never be selected.
  const root = await fixture();
  try {
    const { ctx, registered, logs } = stubContext({ roleBroken: ['taskagent-backend-dev'] });
    await apply(ctx, { sourceAgentPath: root });
    await settled();
    assert.equal(registered.length, 1, 'register() was still called');
    assert.ok(
      logs.some(line => line.startsWith('warn:') && line.includes('did not activate') && line.includes('mount exploded')),
      `logs: ${logs.join(' | ')}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an id that is already registered is reused instead of colliding', async () => {
  // A live reload starts from a fresh closure with no disposers, and `register()`
  // rejects a duplicate id: without this guard the whole role would fail on reload.
  const root = await fixture();
  try {
    const { ctx, registered, logs } = stubContext({ existingPresets: [{ id: 'taskagent-backend-dev', name: 'Backend Dev' }] });
    await apply(ctx, { sourceAgentPath: root });
    await settled();
    assert.equal(registered.length, 0, 'must not re-register an id that is already live');
    assert.ok(
      logs.some(line => line.includes('reused 1 already-registered preset')),
      `logs: ${logs.join(' | ')}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('registering nothing is a warning, never a silent success', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'kit-empty-'));
  try {
    const { ctx, logs } = stubContext();
    await apply(ctx, { sourceAgentPath: empty });
    await settled();
    assert.ok(
      logs.some(line => line.startsWith('warn:') && line.includes('no role preset was registered')),
      `logs: ${logs.join(' | ')}`,
    );
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('a volatile path arrives as a live ref and is read through get()', async () => {
  // Declared `.volatile()` on the Host side so Settings can write it; the value then
  // arrives as a ref rather than a plain string.
  const root = await fixture();
  const statusDir = await mkdtemp(join(tmpdir(), 'kit-status-'));
  const statusFile = join(statusDir, 'roster.json');
  try {
    const { ctx, registered } = stubContext();
    await apply(ctx, { sourceAgentPath: { get: () => root }, statusFile });
    await settled();
    assert.deepEqual(registered.map(entry => entry.id), ['taskagent-backend-dev']);

    // The status artifact must carry the RESOLVED path: serializing the raw volatile
    // field writes `{}`, which is what the live roster file showed.
    const payload = JSON.parse(await readFile(statusFile, 'utf8'));
    assert.equal(payload.sourceAgentPath, root);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(statusDir, { recursive: true, force: true });
  }
});

test('a settings edit triggers a re-scan without a remount', async () => {
  const first = await fixture();
  const second = await mkdtemp(join(tmpdir(), 'kit-second-'));
  try {
    await mkdir(join(second, 'Data Ops'), { recursive: true });
    await writeFile(join(second, 'Data Ops', 'Agent.md'), '# Data Ops\n', 'utf8');

    let current = first;
    const { ctx, registered, disposed, subscriptions, logs } = stubContext();
    await apply(ctx, { sourceAgentPath: { get: () => current } });
    await settled();
    assert.deepEqual(registered.map(entry => entry.id), ['taskagent-backend-dev']);

    const subscription = subscriptions.find(item => item.name === 'settings/document-updated');
    assert.ok(subscription !== undefined, 'must subscribe to the settings edit event');

    // The user picks another folder in Settings: the plugin is not remounted, so only
    // the event can drive the re-scan. The handler is fire-and-forget, so poll.
    current = second;
    subscription.handler('task-agent-kit');
    subscription.handler('some-other-plugin'); // must be ignored
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !registered.some(entry => entry.id === 'taskagent-data-ops')) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    assert.ok(disposed.includes('taskagent-backend-dev'), 'the previous registration must be released');
    assert.ok(registered.map(entry => entry.id).includes('taskagent-data-ops'), `registered: ${registered.map(e => e.id).join(',')}`);
    assert.ok(logs.some(line => line.includes('re-scanning after a settings change')), `logs: ${logs.join(' | ')}`);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test('apply() settles even when the loader never does, so activation is not blocked by the scan', async () => {
  const root = await fixture();
  try {
    const { ctx } = stubContext();
    // The deferred pipeline never runs here. If apply() still awaited the roster scan (or any
    // settings publication) this test would hang — which is exactly the boot hang that showed up
    // as "[loader] still waiting for 1 plugin entries ... @local/dsh-task-agent-kit".
    ctx.root = { loader: { await: () => new Promise(() => {}) } };
    await apply(ctx, { sourceAgentPath: root, presetIdPrefix: 'taskagent' });
    assert.ok(true, 'apply resolved with the scan still pending');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});