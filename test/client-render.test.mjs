/**
 * Render every claimed cell with the REAL React the application ships, and drive the
 * interactive flows through a real DOM.
 *
 * The sibling `client-runtime.test.mjs` uses a hand-written React stub; a stub cannot
 * fail the way the browser does. The documented failure mode for a plugin slot is
 * "a throwing component blanks your slot entry" (console: `slot entry crashed in
 * '<slot>'`), and only a real renderer exercises hook order, prop validation and the
 * actual element tree. `react-dom/server` covers rendering; `jsdom` + `react-dom/client`
 * cover clicks, state updates and Escape handling.
 *
 * Run: node --test D:\DSH_desktop\dsh-ext\task-agent-kit\test\client-render.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const APP_MODULES = 'D:/DSH_desktop/deepseek_harness_desktop/DSH Desktop/resources/app.asar.unpacked/node_modules/';
const requireApp = createRequire(`file:///${APP_MODULES}`);
const React = requireApp('react');
const { renderToStaticMarkup } = requireApp('react-dom/server');

const BUNDLE = 'D:\\DSH_desktop\\dsh-ext\\task-agent-kit\\client.js';

/**
 * A DOM before React DOM is loaded: react-dom/client captures `document` and friends at
 * require time, so the environment must exist first.
 */
const { JSDOM } = requireApp('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 24 defines `navigator` as a getter-only global, so it needs a descriptor.
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = requireApp('react-dom/client');
const { act } = requireApp('react-dom/test-utils');

/** Load the client bundle and capture the module it registers. */
async function loadClient() {
  const source = await readFile(BUNDLE, 'utf8');
  let captured;
  // The bundle must run against a REAL window: it registers a `keydown` listener on it,
  // and a bare object standing in for `window` would fail where the browser does not.
  dom.window.__ModuleLoader__ = {
    load(entry) {
      captured = entry;
    },
  };
  new Function('window', source)(dom.window);
  assert.ok(captured !== undefined, 'the bundle must register itself');
  return captured;
}

const ROLE_ID = 'taskagent-role-aa2d8f39';

function stubContext() {
  const registered = [];
  const calls = [];
  const ctx = {
    slots: {
      inject(key, factory) {
        factory();
        return () => {};
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
    },
    layout: { selectPanel: id => calls.push(['selectPanel', id]) },
    remote: {
      agentPresets: {
        list: async () => ({ ok: true, value: { presets: [{ id: ROLE_ID, name: 'Backend Dev', description: 'owns the API', rows: 19 }] } }),
      },
      session: {
        create: async payload => {
          calls.push(['session.create', payload]);
          // The envelope, exactly as the transport delivers it.
          return { ok: true, value: { sessionId: 'session-1' } };
        },
      },
    },
    configForms: {
      list: () => ['task-agent-kit'],
      describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'task-agent-kit' }] } }) }),
      get: () => ({
        getSnapshot: () => ({ status: 'ready', writable: true, revision: 7, value: { sourceAgentPath: 'D:\\DSH_desktop\\Agents' } }),
        subscribe: () => () => {},
        set: async () => true,
        unset: async () => true,
      }),
    },
    uiWorkspace: { openSession: id => calls.push(['openSession', id]), pickDirectory: async () => null },
    effect: fn => {
      fn();
    },
  };
  return { ctx, registered, calls };
}

/** The workspace snapshot shape the shell hands a slot with `useWorkspaces`. */
const WORKSPACES = { ids: ['ws-1'], byId: { 'ws-1': { id: 'ws-1', workspaceId: 'ws-1', active: true, path: 'D:\\proj' } } };
const slotProps = { useWorkspaces: selector => selector(WORKSPACES) };

async function mount() {
  const captured = await loadClient();
  const mod = captured.factory(specifier => {
    if (specifier === 'react') return React;
    throw new Error(`unexpected require("${specifier}")`);
  });
  const stub = stubContext();
  mod.apply(stub.ctx);
  const cell = name => {
    const entry = stub.registered.find(item => item.options.name === name);
    assert.ok(entry !== undefined, `no cell registered for ${name}`);
    return entry.component;
  };
  return { ...stub, cell };
}

test('every claimed cell renders under the real React without throwing', async () => {
  const { cell } = await mount();
  // A throwing component is exactly how a slot entry goes blank in the browser, so a
  // render that returns markup at all is the assertion that matters most here.
  for (const name of ['main', 'sidebar.panellist', 'conversation.hero.modeActions', 'settings.models.footer']) {
    const markup = renderToStaticMarkup(React.createElement(cell(name), slotProps));
    assert.equal(typeof markup, 'string');
    assert.ok(markup.length > 0, `${name} rendered nothing`);
  }
  assert.equal(renderToStaticMarkup(React.createElement(cell('shell.overlay'), slotProps)), '', 'the modal stays closed');
});

test('the deck renders its controls and role cards under the real React', async () => {
  const { cell } = await mount();
  const markup = renderToStaticMarkup(React.createElement(cell('main'), slotProps));
  assert.match(markup, /Agent 观察室/u);
  assert.match(markup, /仅活动/u);
  assert.match(markup, /3 × 3/u, 'densities are offered');
});

test('the settings row renders the mirrored value and its diagnostic state', async () => {
  const { cell } = await mount();
  const markup = renderToStaticMarkup(React.createElement(cell('settings.models.footer'), {}));
  assert.match(markup, /源 agent 路径/u);
  assert.match(markup, /D:\\DSH_desktop\\Agents/u);
  assert.match(markup, /命名空间 task-agent-kit/u);
  assert.match(markup, /修订 7/u);
});

test('the sidebar seat renders a glyph, never an interactive control', async () => {
  const { cell } = await mount();
  const markup = renderToStaticMarkup(React.createElement(cell('sidebar.panellist'), { size: 18, active: true }));
  assert.match(markup, /▦/u);
  assert.ok(!markup.includes('<button'), 'the host owns the button');
});

/** Render the hero trigger and the overlay modal into one live tree, as the shell does. */
async function mountInteractive() {
  const mounted = await mount();
  // A fresh container per test: React refuses a second createRoot on a used container.
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const Tree = () => React.createElement(React.Fragment, null,
    React.createElement(mounted.cell('conversation.hero.modeActions'), slotProps),
    React.createElement(mounted.cell('shell.overlay'), slotProps));
  await act(async () => {
    root.render(React.createElement(Tree));
  });
  const clickable = (text) => [...container.querySelectorAll('button')]
    .find(button => button.textContent.includes(text));
  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };
  return { ...mounted, container, root, clickable, unmount };
}

test('the hero trigger opens the tier modal, and the modal binds the selected workspace', async () => {
  const { container, clickable, calls, unmount } = await mountInteractive();
  try {
    assert.equal(container.textContent.includes('设定 agent 层级'), false, 'the modal starts closed');
    const trigger = clickable('添加任务 agent');
    assert.ok(trigger !== undefined, 'the trigger renders');
    await act(async () => {
      trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    assert.ok(container.textContent.includes('设定 agent 层级'), 'the modal opens on click');
    const dialog = container.querySelector('[role="dialog"]');
    assert.ok(dialog !== null, 'the modal is a dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    // `shell.overlay` is click-through by design, so the entry must claim pointer events.
    assert.match(dialog.parentElement.getAttribute('style') ?? '', /pointer-events:\s*auto/u);
    assert.ok(container.textContent.includes('Backend Dev'), 'the tier rows list the registered roles');

    await act(async () => {
      clickable('Backend Dev').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      clickable('完成').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    const created = calls.find(call => call[0] === 'session.create');
    assert.ok(created !== undefined, '完成 creates the task conversation');
    assert.equal(created[1].agentPreset, ROLE_ID, 'the picked role selects the preset');
    assert.equal(created[1].workspaceId, 'ws-1', 'the conversation binds to the selected workspace');
    assert.deepEqual(calls.find(call => call[0] === 'openSession'), ['openSession', 'session-1']);
  } finally {
    await unmount();
  }
});

test('Escape closes the modal', async () => {
  const { container, clickable, unmount } = await mountInteractive();
  try {
    await act(async () => {
      clickable('添加任务 agent').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert.ok(container.textContent.includes('设定 agent 层级'));

    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(container.textContent.includes('设定 agent 层级'), false, 'Escape closes it');
  } finally {
    await unmount();
  }
});

test('the observer room narrows to roles with work in flight', async () => {
  const { cell } = await mount();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(cell('main'), slotProps));
    });
    assert.ok(container.textContent.includes('共 1 个角色'), 'every role is listed by default');

    const toggle = [...container.querySelectorAll('button')].find(button => button.textContent === '仅活动');
    assert.ok(toggle !== undefined, 'the active-only toggle renders');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    await act(async () => {
      toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    // No role has work in flight for a fresh registration, so the filtered room is empty
    // and says so instead of inventing a status.
    assert.ok(container.textContent.includes('工作中 0 / 共 1 个角色'), container.textContent.slice(0, 200));
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});
