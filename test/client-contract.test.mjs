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
  assert.deepEqual(claimed.sort(), ['conversation.hero.modeActions', 'conversation.session.header.utilities', 'main', 'settings.models.footer', 'shell.overlay', 'sidebar.panellist']);
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
  // The fallback creation still carries the workspace when one is discoverable.
  const creates = [...client.matchAll(/session\.create\(\{[\s\S]{0,220}?\}\)/gu)].map(match => match[0]);
  assert.equal(creates.length, 2, 'both creation paths are covered');
  for (const call of creates) assert.match(call, /agentPreset/u, 'the preset still selects the role');
});
test('client remotes are read through their result envelope', () => {
  // Client remotes answer `{ ok, value, error }`. Reading the envelope AS the value is
  // what made the shipped role list come back empty and left every created conversation
  // unopened, so both call sites are pinned here.
  assert.equal([...client.matchAll(/unwrapRemote\('agentPresets\.list'/gu)].length, 2, 'both roster reads unwrap');
  assert.equal([...client.matchAll(/unwrapRemote\('session\.create'/gu)].length, 2, 'both creations unwrap');
  assert.match(client, /result\.ok !== true/u, 'a failed answer must surface as an error');
  assert.match(client, /return result\.value/u, 'the value comes out of the envelope');
});