/**
 * Static self-check for the bundle's Client half.
 *
 * The browser module cannot run under plain Node, so the contract is verified
 * statically: the manifest wiring, the module-loader id, the slots it claims, the
 * services it injects, and the theme-token rule (no hard-coded colors).
 *
 * Run: node --test D:\DSH_desktop\dsh-ext\task-agent-kit\test\client-contract.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const client = await readFile(join(ROOT, 'client.js'), 'utf8');

test('manifest declares the web client half and exports it', () => {
  assert.equal(manifest.exports['./client'], './client.js');
  assert.ok(manifest.files.includes('client.js'), 'client.js must ship in the package');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  // Package-level inject is a load-order list of the packages that own the slots this
  // plugin claims and that provide the remotes it calls, matching the shipped plugins.
  const injected = manifest.dsh.client.inject;
  assert.ok(Array.isArray(injected) && injected.length > 0);
  for (const required of [
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-settings-models',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-workspace',
  ]) {
    assert.ok(injected.includes(required), `client deps must list ${required}`);
  }
  assert.ok(manifest.files.includes('preset-base.json'), 'the Host half needs its base template');
});

test('client module registers under the package name', () => {
  assert.match(client, /window\.__ModuleLoader__\.load\(/u);
  const idMatch = /id:\s*'([^']+)'/u.exec(client);
  assert.ok(idMatch !== null, 'the loader call must carry an id');
  assert.equal(idMatch[1], manifest.name, 'the loader id must equal the package name');
});

test('client module claims exactly the intended slots and nothing shipped', () => {
  const claimed = [...client.matchAll(/name:\s*'([a-z][a-zA-Z.]*)'/gu)].map(match => match[1]);
  // Literal source occurrences. The two footer rows come from one loop, so this list counts
  // the slot once; `client-runtime.test.mjs` asserts that two cells are actually registered.
  assert.deepEqual(claimed.sort(), ['conversation.hero.modeActions', 'conversation.session.header.utilities', 'conversation.session.header.utilities', 'main', 'settings.models.footer', 'shell.overlay', 'sidebar.panellist']);
  // Guard against the shadowing mistakes: these single-occupancy slots are taken.
  for (const forbidden of ['sidebar', 'sidebar.workspaces', 'conversation.hero.workspace', 'main.conversation']) {
    assert.ok(!claimed.includes(forbidden), `must not register into the occupied slot "${forbidden}"`);
  }
  assert.match(client, /key:\s*PANEL_KEY/u, 'the main panel cell must be keyed');
  assert.ok(!/'conversation'/u.test(client), 'must not reuse the reserved conversation key');
  // List cells must carry our own ids, otherwise they replace a shipped entry. The
  // panellist id is the `main` key itself: the host dispatches `selectPanel(<that id>)`.
  for (const id of ['task-agent-plan', 'task-agent-plan-panel', 'task-agent-source-path']) {
    assert.ok(client.includes(`id: '${id}'`), `expected our own cell id "${id}"`);
  }
  assert.match(client, /id:\s*PANEL_KEY/u, 'the panellist seat must reuse the main panel key');
});

test('client module injects the services it uses', () => {
  const injectMatch = /inject:\s*\[([^\]]+)\]/u.exec(client);
  assert.ok(injectMatch !== null, 'the factory result must declare inject');
  const injected = injectMatch[1].split(',').map(part => part.trim().replace(/^'|'$/gu, ''));
  for (const required of ['slots', 'layout', 'remote', 'remote.agentPresets', 'remote.session', 'configForms', 'uiWorkspace']) {
    assert.ok(injected.includes(required), `missing injected service "${required}"`);
  }
});

test('factory helpers take ctx as a parameter, never a free variable', () => {
  // `ctx` only exists inside `apply(ctx)`; a factory-level helper that reads it without a
  // parameter throws "ctx is not defined" at runtime. These signatures are the guard.
  assert.match(client, /function configForm\(ctx\)/u, 'configForm must receive ctx');
  assert.match(client, /function readPermanentPages\(ctx\)/u, 'readPermanentPages must receive ctx');
  assert.match(client, /function writePermanentPages\(ctx, map\)/u, 'writePermanentPages must receive ctx');
  // And the deck must pass ctx through, otherwise the reference resolves to nothing.
  assert.match(client, /readPermanentPages\(ctx\)/u);
  assert.match(client, /writePermanentPages\(ctx, \{/u);
});

test('the permanent page is created inside a workspace so its preset survives', () => {
  // A session born without a workspace makes the shell prompt for one, and that re-target
  // drops the preset. The deck must derive the current workspace from the held session and
  // pass it on create (dsh-client-ui-workspace:890 semantics).
  assert.match(client, /function currentWorkspaceId\(workspaces, sessions\)/u);
  assert.match(client, /\(item\?\.sessionIds \?\? \[\]\)\.includes\(currentId\)/u);
  assert.match(client, /const workspaceId = currentWorkspaceId\(workspacesSnapshot, sessionsSnapshot\)/u);
  // The page must be a FRESH Session: `connectWorkspace` reuses a blank Session and has no
  // `fresh` argument, so two experts would share one conversation. Creating through the
  // client Session store is what the shell's own `reuseOrCreateBlank` does for a new one.
  assert.match(client, /async function createFreshSession\(ctx, workspaceId\)/u);
  assert.match(client, /sessions\.create\(\{ workspaceId \}\)/u);
  assert.match(client, /ctx\.uiWorkspace\.connectWorkspace\(targetWorkspaceId\)/u);
  assert.match(client, /agentPresets\.select\(sessionId, preset\.id\)/u);
  // The expert's own folder is its Workspace, so the page lands there instead of in whatever
  // workspace happened to be used last.
  assert.match(client, /async function readExpertFolders\(ctx\)/u);
  assert.match(client, /async function ensureWorkspace\(ctx, workspaces, path\)/u);
  assert.match(client, /ctx\.remote\.workspace\.create\(\{ path \}\)/u);
  // A remembered mapping can be rotten three ways — a ghost Session (opening it throws
  // `sessions.retain: unknown session`), an archived Session, or a Session bound to another
  // expert — and every one of them strands the shell on the new-conversation page.
  assert.match(client, /function knownSessionIds\(sessions\)/u);
  assert.match(client, /function mappingUsable\(sessions, workspaces, sessionId, presetId\)/u);
  assert.match(client, /mappingUsable\(sessionsSnapshot, workspacesSnapshot, existing, preset\.id\)/u);
  // A just-created id is briefly unknown while the client catalog refreshes, so opening retries.
  assert.match(client, /async function openWhenKnown\(ctx, sessionId/u);
  assert.match(client, /openWhenKnown\(ctx, sessionId\)/u);
  // The map needs a one-click reset: rotten entries otherwise keep answering every click.
  assert.match(client, /writePermanentPages\(ctx, \{\}\)/u);
  // The selector must be a stable module constant, not a rebuilt arrow, or the workspace
  // snapshot turns unstable and blanks the panel.
  assert.match(client, /const identity = value => value/u);
});

test('the deck error boundary forwards the slot props it receives', () => {
  // The wrapper that renders the deck (and catches its throw) must pass its own props on;
  // dropping them made useSessions/useWorkspaces undefined, so no workspace was ever
  // resolved and every card re-triggered the "choose a workspace" prompt.
  assert.match(client, /function AgentDeck\(props\)/u);
  assert.match(client, /return AgentDeckView\(props\)/u);
});

test('both session and workspace snapshot hooks are called with a selector', () => {
  // `useSessions` and `useWorkspaces` are SnapshotSelectorHook<...>: they take a selector,
  // and a no-argument call makes the hook invoke `undefined` and throw "l is not a function".
  assert.match(client, /props\.useSessions\(identity\)/u);
  assert.match(client, /props\.useWorkspaces\(identity\)/u);
});

test('route A and route B share one finish path', () => {
  // Route A: create the expert through the Settings-document request, then hand the new
  // preset to the same opener the cards use.
  assert.match(client, /async function requestNewExpert\(ctx, spec, timeoutMs = 30000\)/u);
  assert.match(client, /configForm\(ctx\)\.set\('roleRequest'/u);
  assert.match(client, /roleRequestResult/u);
  assert.match(client, /await startWithRole\(\{ id: answer\.presetId, name: answer\.roleName \}\)/u);
  // Route B: bind THIS conversation as an expert's page — select the preset, then record it.
  assert.match(client, /function createExpertPageBinder\(ctx\)/u);
  assert.match(client, /id: 'task-agent-page-binder'/u);
  // Both write the same mapping the card path writes.
  assert.match(client, /writePermanentPages\(ctx, \{ \.\.\.map, \[presetId\]: sessionId \}\)/u);
});

test('the room renders each expert task history', () => {
  // The Client cannot read the task files: the history it draws must come from the published
  // `expertTasks` mirror (asserted on the Host side in host-apply.test.mjs).
  assert.match(client, /async function readExpertTasks\(ctx\)/u);
  assert.match(client, /state\.history\?\.\[preset\.id\]/u);
  assert.match(client, /个任务 · 最近/u);
  // The whole history goes in the tooltip so a 5×5 card stays readable.
  assert.match(client, /history\.map\(task =>/u);
});

test('no control is filled with the brand colour', () => {
  // In the dark theme `--dsw-alias-brand-primary` IS near-white (the boot stylesheet sets
  // `body[data-ds-dark-theme] { --dsh-boot-brand: #f9fafb }`), so a brand-filled button renders
  // as a white slab on a dark UI. The host's own Button.module.css pairs a dedicated fill
  // token with a dedicated foreground token, and so must this plugin.
  assert.ok(!/background:\s*C\.accent/u.test(client), 'never fill a control with brand-primary');
  assert.ok(!/color:\s*C\.bg\b/u.test(client), 'never paint a fill text with the page background');
  assert.match(client, /buttonPrimary: 'var\(--dsw-alias-button-primary-fill\)'/u);
  assert.match(client, /onPrimary: 'var\(--dsw-alias-label-primary-foreground\)'/u);
  // Secondary controls match the host's outlined ghost: transparent over an l3 hairline.
  assert.ok(!/background:\s*C\.layer2/u.test(client), 'secondary controls use the outlined style');
});

test('client module uses only theme tokens for colour', () => {
  const themeTokens = [...client.matchAll(/var\((--dsw-[a-z0-9-]+)\)/gu)].map(match => match[1]);
  assert.ok(themeTokens.length > 0, 'expected theme token usage');
  assert.ok(themeTokens.every(token => token.startsWith('--dsw-')), 'tokens must come from the theme');
  const hardCoded = [...client.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/gu)].map(match => match[0]);
  assert.deepEqual(hardCoded, [], `hard-coded colours found: ${hardCoded.join(', ')}`);
});

test('client module does not import harness client packages', () => {
  assert.ok(!/\bimport\s.*from\s+['"]@deepseek-ai\/dsh-client/u.test(client), 'client code must not import harness client packages');
  assert.ok(!/dsh-client-ui-primitives/u.test(client), 'must not depend on the harness primitives package');
  assert.match(client, /require\('react'\)/u, 'React comes from the browser module table');
});

test('client module releases what it claims', () => {
  assert.match(client, /ctx\.effect\(/u, 'slot registrations must be released through ctx.effect');
  assert.match(client, /slots\.inject\(/u, 'registration must wait for the slot declaration');
});

test('the overlay modal is clickable and roles bind to the page the user is on', () => {
  // `shell.overlay` is click-through by design: entries opt back in themselves, so a
  // modal that forgets this renders correctly but cannot be clicked at all.
  assert.match(client, /pointerEvents:\s*'auto'/u, 'the overlay entry must claim pointer events');
  // The new-conversation page already owns a blank session for the chosen workspace, so a
  // role is bound to THAT session. Creating a fresh one loses the workspace, because the
  // workspace snapshot exposes no "currently selected" field at all.
  assert.match(client, /agentPresets\.select\(state\.sessionId, role\.id\)/u, 'the picker binds the role to the current session');
  assert.match(client, /useCurrentSession\(props\)/u, 'the current session comes from the slot standard prop');
  // The picker's fallback creation still binds the role and the workspace; the deck's own
  // creation path (blank via connectWorkspace, then agentPresets.select) is asserted in the
  // permanent-page test above.
  assert.match(client, /agentPreset: role\.id/u, 'the picker fallback still binds the role');
  assert.match(client, /state\.workspaceId === undefined \? \{\} : \{ workspaceId: state\.workspaceId \}/u, 'the picker fallback still carries the workspace');
});
test('client remotes are read through their result envelope', () => {
  // Client remotes answer `{ ok, value, error }`. Reading the envelope AS the value is
  // what made the shipped role list come back empty and left every created conversation
  // unopened, so both call sites are pinned here.
  assert.equal([...client.matchAll(/unwrapRemote\('agentPresets\.list'/gu)].length, 3, 'every roster read unwraps');
  // Only the tier picker creates a Session on the remote now: the deck creates through the
  // client store so the session lands inside a workspace (a workspace-less remote create is
  // what made the conversation hero ask the user to choose one).
  assert.equal([...client.matchAll(/unwrapRemote\('session\.create'/gu)].length, 1, 'the picker creation unwraps');
  assert.match(client, /result\.ok !== true/u, 'a failed answer must surface as an error');
  assert.match(client, /return result\.value/u, 'the value comes out of the envelope');
});