/**
 * Runtime self-check for the bundle's Client half.
 *
 * The browser module cannot run in a real browser here, but its factory and `apply`
 * are ordinary JavaScript: this test loads the module through a stubbed module
 * loader, evaluates the factory with a minimal React stub, and drives `apply` with a
 * stubbed slot service. That exercises the real registration paths — a throw anywhere
 * in them fails the test, which static string checks cannot catch.
 *
 * Run: node --test D:\DSH_desktop\dsh-ext\task-agent-kit\test\client-runtime.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(HERE, '..', 'package.json'), 'utf8'));

/** Minimal React surface: `createElement` builds inert nodes, hooks are inert. */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: factory => factory(),
  useCallback: factory => factory,
};

// ESM caches module instances, so the registration side effect runs exactly once:
// capture it here and reuse the spec across tests.
let captured;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
    },
  },
};
await import(pathToFileURL(join(HERE, '..', 'client.js')).href);
assert.ok(captured !== undefined, 'the module did not call window.__ModuleLoader__.load');

const ROLE_ID = 'taskagent-role-aa2d8f39';

function stubContext() {
  const registered = [];
  const injected = [];
  const effectCleanups = [];
  const remoteCalls = [];
  const formsRequested = [];
  let mirrorNamespaces = ['task-agent-kit'];
  let formSnapshot = {
    status: 'ready',
    writable: true,
    revision: 3,
    value: { sourceAgentPath: 'D:\\Agents' },
  };
  const ctx = {
    slots: {
      inject(key, factory) {
        injected.push(key);
        // Simulate a declared slot: the factory runs immediately and claims a cell.
        factory();
        return () => {};
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
    },
    layout: { selectPanel: id => remoteCalls.push(['selectPanel', id]) },
    remote: {
      agentPresets: {
        list: async () => {
          remoteCalls.push(['presets.list']);
          // Client remotes answer with a result envelope; the stub must too, or it would
          // hide exactly the bug that made the shipped role list come back empty.
          return { ok: true, value: { presets: [{ id: ROLE_ID, name: 'Backend Dev', description: 'owns the API' }] } };
        },
      },
      session: {
        create: async payload => {
          remoteCalls.push(['session.create', payload]);
          return { ok: true, value: { sessionId: 'session-1' } };
        },
      },
    },
    // The Client mirror of the Host settings document. The row must read its value from
    // here: `remote.settings.describe()` answers an empty namespace list in this build.
    configForms: {
      list: () => mirrorNamespaces,
      describe: () => ({ getSnapshot: () => ({ view: { namespaces: mirrorNamespaces.map(ns => ({ ns })) } }) }),
      get: entryId => {
        formsRequested.push(entryId);
        return {
          getSnapshot: () => formSnapshot,
          subscribe: () => () => {},
          set: async (field, value) => {
            remoteCalls.push(['form.set', entryId, field, value]);
            return true;
          },
          unset: async field => {
            remoteCalls.push(['form.unset', entryId, field]);
            return true;
          },
        };
      },
    },
    uiWorkspace: { openSession: id => remoteCalls.push(['openSession', id]), pickDirectory: async () => null },
    effect: fn => {
      effectCleanups.push(fn);
    },
  };
  return {
    ctx,
    registered,
    injected,
    effectCleanups,
    remoteCalls,
    formsRequested,
    setMirrorNamespaces: next => { mirrorNamespaces = next; },
    setFormSnapshot: next => { formSnapshot = next; },
  };
}

/** Find the first button whose text content includes `label`. */
function findButton(node, label) {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const children = node.props?.children ?? node.children;
  const text = typeof children === 'string'
    ? children
    : Array.isArray(children) && children.length === 1 && typeof children[0] === 'string'
      ? children[0]
      : undefined;
  if (node.type === 'button' && text !== undefined && text.includes(label)) return node;
  return findButton(children, label);
}

test('the client module declares itself under the package name', () => {
  assert.equal(captured.id, manifest.name);
  assert.equal(typeof captured.factory, 'function');
});

test('the factory resolves React from the module table and returns apply + inject', () => {
  const mod = captured.factory(specifier => {
    if (specifier === 'react') return ReactStub;
    throw new Error(`unexpected require("${specifier}")`);
  });
  assert.equal(typeof mod.apply, 'function');
  // `remote` must be declared alongside its namespaces: reading `ctx.remote` without
  // it throws `cannot get property "remote" without inject`.
  assert.deepEqual(mod.inject.slice().sort(), ['layout', 'remote', 'remote.agentPresets', 'remote.session', 'configForms', 'slots', 'uiWorkspace'].sort());
});

test('apply claims every declared cell without throwing', () => {
  const mod = captured.factory(() => ReactStub);
  const { ctx, registered, injected, effectCleanups } = stubContext();
  mod.apply(ctx);

  assert.deepEqual(injected.slice().sort(), [
    'conversation.hero.modeActions',
    'conversation.session.header.utilities',
    'main',
    'settings.models.footer',
    'shell.overlay',
    'sidebar.panellist',
  ]);
  assert.equal(registered.length, 6, 'one cell per declared slot');

  const byName = new Map(registered.map(entry => [entry.options.name, entry.options]));
  assert.equal(byName.get('main').key, 'agentDeck', 'the panel must use its own main key');
  // The sidebar seat is dispatched by the HOST as `selectPanel(<panellist id>)`, so the
  // two ids must be identical; a mismatch switches to a panel that does not exist and
  // the click looks like it did nothing at all.
  assert.equal(byName.get('sidebar.panellist').id, byName.get('main').key, 'the panellist id must equal the main key');
  assert.equal(byName.get('sidebar.panellist').id, 'agentDeck');
  assert.equal(byName.get('conversation.hero.modeActions').id, 'task-agent-plan');
  // `conversation.hero.dock` only renders while the Conversation has no session, so the
  // picker is a frame-wide overlay instead.
  assert.equal(byName.get('shell.overlay').id, 'task-agent-plan-panel');
  assert.equal(byName.get('settings.models.footer').id, 'task-agent-source-path');

  for (const entry of registered) {
    assert.equal(typeof entry.component, 'function', `${entry.options.name} must register a component`);
  }
  assert.equal(effectCleanups.length, 1, 'resources must be released through ctx.effect');
});

test('the hero button renders and the closed picker renders nothing', () => {
  const mod = captured.factory(() => ReactStub);
  const { ctx, registered } = stubContext();
  mod.apply(ctx);

  const picker = registered.find(entry => entry.options.name === 'shell.overlay').component;
  assert.equal(picker({}), null, 'the panel stays closed until the button is pressed');

  const button = registered.find(entry => entry.options.name === 'conversation.hero.modeActions').component;
  const tree = button({});
  assert.equal(tree.type, 'button');
  assert.equal(typeof tree.props.onClick, 'function');
});

test('the deck panel renders its header, density control and paging indicator', () => {
  const mod = captured.factory(() => ReactStub);
  const { ctx, registered } = stubContext();
  mod.apply(ctx);
  const deck = registered.find(entry => entry.options.name === 'main').component;
  const serialized = JSON.stringify(deck({}));
  assert.ok(serialized.includes('Agent'), 'header present');
  assert.ok(serialized.includes('3') && serialized.includes('5'), 'densities offered');
  assert.ok(serialized.includes('1 / 1'), 'paging indicator present');
  assert.ok(serialized.includes('仅活动'), 'the active-only toggle is offered (defaults to showing every role)');
  assert.ok(!serialized.includes('仅活动 ✓'), 'it starts unfiltered');
});

test('the settings row reads and writes the source path through the configForms mirror', async () => {
  const mod = captured.factory(() => ReactStub);
  const { ctx, registered, remoteCalls, formsRequested } = stubContext();
  mod.apply(ctx);

  const row = registered.find(entry => entry.options.name === 'settings.models.footer').component;
  const tree = row({});
  const serialized = JSON.stringify(tree);
  assert.ok(serialized.includes('源 agent 路径'), 'the row is labelled');
  assert.ok(serialized.includes('D:\\\\Agents'), 'the value comes from the mirror snapshot, not a remote describe');
  assert.deepEqual(formsRequested, ['task-agent-kit'], 'the form is requested for the served namespace');
  assert.ok(serialized.includes('修订 3'), 'the mirror state stays visible for diagnosis');

  // 清除 writes through the form controller, which owns the revision bookkeeping.
  findButton(tree, '清除').props.onClick();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(remoteCalls.at(-1), ['form.unset', 'task-agent-kit', 'sourceAgentPath']);
});

test('the settings row follows a namespace the bundle include prefixed', () => {
  const mod = captured.factory(() => ReactStub);
  const { ctx, registered, formsRequested, setMirrorNamespaces } = stubContext();
  setMirrorNamespaces(['llm-deepseek', 'include:task-agent-kit']);
  mod.apply(ctx);
  registered.find(entry => entry.options.name === 'settings.models.footer').component({});
  assert.deepEqual(formsRequested, ['include:task-agent-kit'], 'the prefixed entry id is the served namespace');
});

test('the settings row names the namespaces it was offered when ours is absent', () => {
  const mod = captured.factory(() => ReactStub);
  const { ctx, registered, setMirrorNamespaces, formsRequested } = stubContext();
  setMirrorNamespaces(['llm-deepseek']);
  mod.apply(ctx);
  const serialized = JSON.stringify(registered.find(e => e.options.name === 'settings.models.footer').component({}));
  assert.deepEqual(formsRequested, ['task-agent-kit'], 'falls back to the row id so the controller still exists');
  assert.ok(serialized.includes('llm-deepseek'), 'the served list is shown instead of a silent failure');
});
test('the sidebar seat is a non-interactive glyph the host wraps in its own button', () => {
  const mod = captured.factory(() => ReactStub);
  const { ctx, registered, remoteCalls } = stubContext();
  mod.apply(ctx);
  const entry = registered.find(e => e.options.name === 'sidebar.panellist').component;
  // The host draws the panel row, its tooltip, its active state and the selectPanel call;
  // a nested button here would swallow the click and never reach the shell.
  const tree = entry({ size: 18, active: true });
  assert.equal(tree.type, 'span');
  assert.equal(tree.props.onClick, undefined, 'the glyph must not handle clicks itself');
  assert.equal(tree.props['aria-hidden'], true, 'the host owns the accessible name');
  assert.equal(remoteCalls.length, 0, 'rendering the glyph must not touch the shell');
});
