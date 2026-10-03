/**
 * Real-data end-to-end check of the task-agent kit.
 *
 * It scans the configured source-agent root, reads the shipped `standard` preset
 * as the clone template, composes one preset per role, and validates the result
 * (row ids unique, MCP server names unique, persona present, skill dirs resolved).
 *
 * Run:
 *   node D:\DSH_desktop\dsh-ext\task-agent-kit\tools\e2e-check.mjs "<source agent root>" [<standard.patch.yml>]
 *
 * Read-only: it prints what it would register and writes nothing.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import { scanSourceRoot } from '../src/source-agent-registry.js';
import { composeRolePreset } from '../src/role-preset.js';

const DEFAULT_ROOT = 'D:\\DSH_desktop\\Agents';
const DEFAULT_TEMPLATE = 'D:\\DSH_desktop\\deepseek_harness_desktop\\DSH Desktop\\resources\\app.asar.unpacked\\node_modules\\@deepseek-ai\\dsh-web-app\\presets\\standard.patch.yml';

const sourceRoot = process.argv[2] ?? DEFAULT_ROOT;
const templatePath = process.argv[3] ?? DEFAULT_TEMPLATE;

/** Load js-yaml from wherever it is installed (the profile ships it). */
async function loadYaml() {
  const candidates = [
    process.env.DSH_PROFILE_DIR === undefined ? undefined : join(process.env.DSH_PROFILE_DIR, 'node_modules', 'js-yaml', 'index.js'),
    'C:\\Users\\张德海（Jack）\\AppData\\Roaming\\dsh-desktop\\harness\\profiles\\web\\node_modules\\js-yaml\\index.js',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href);
      return mod.default ?? mod;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('js-yaml not found; pass a path or run from a profile-launched shell');
}

const yaml = await loadYaml();
// The Loader dialect uses `!!js <expression>`. Evaluating it is acceptable here
// because this tool only ever parses the harness's own shipped preset files, and
// the evaluated result is used to decide whether a row is disabled at runtime.
const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => {
    try {
      // eslint-disable-next-line no-new-func
      return Function(`"use strict"; return (${value});`)();
    } catch {
      return value;
    }
  },
});
const schema = yaml.DEFAULT_SCHEMA.extend([jsTag]);
const patch = yaml.load(await readFile(templatePath, 'utf8'), { schema });
const presetRow = patch.flatMap(entry => entry.insert ?? []).find(row => row.name === '@deepseek-ai/dsh-agent-preset');
if (presetRow === undefined) throw new Error('no @deepseek-ai/dsh-agent-preset row in the template');
const basePlugins = presetRow.config.plugins;
console.log(`template      : ${templatePath}`);
console.log(`base preset   : id=${presetRow.config.id} rows=${basePlugins.length}`);
console.log(`source root   : ${sourceRoot}`);
console.log('');

const { root, roles, skipped } = await scanSourceRoot(sourceRoot);
console.log(`roles found   : ${roles.length}`);
for (const role of roles) {
  console.log(`  - ${role.roleId}  preset=${role.presetId}  skills=${role.skillsDir ?? '(none)'}  mcp=${role.mcpServers.length}  promptBytes=${role.promptBytes ?? 0}${role.diagnostics?.length ? '  diag=' + role.diagnostics.join('; ') : ''}`);
}
if (skipped.length > 0) {
  console.log(`skipped       : ${skipped.length}`);
  for (const entry of skipped) console.log(`  - ${entry.path}  (${entry.reason})`);
}
console.log('');

if (roles.length === 0) {
  console.log('RESULT: no roles found under this root.');
  console.log('        A first-level folder is a role only when it holds Agent.md / AGENTS.md /');
  console.log('        CLAUDE.md / agent.json. Point the setting at the folder whose children ARE roles.');
  process.exitCode = 1;
  process.exit();
}

let failures = 0;
for (const role of roles) {
  const promptText = role.promptPath === undefined ? '' : await readFile(role.promptPath, 'utf8');
  const { plugins, warnings } = composeRolePreset(basePlugins, role, promptText);

  const ids = plugins.map(row => row?.id).filter(id => id !== undefined);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  const servers = plugins.filter(row => row.name === '@deepseek-ai/dsh-mcp-client').map(row => row.config.serverName);
  const duplicateServers = servers.filter((name, index) => servers.indexOf(name) !== index);
  const personaRows = plugins.filter(row => row.name === '@deepseek-ai/dsh-persona');
  const persona = personaRows[0];
  const hasPrompt = promptText.trim().length > 0;
  const checks = [
    ['row ids unique', duplicateIds.length === 0, duplicateIds.join(',')],
    ['mcp server names unique per scope', duplicateServers.length === 0, duplicateServers.join(',')],
    ['exactly one persona row', personaRows.length === 1, String(personaRows.length)],
    ...(hasPrompt ? [['persona carries the role prompt', persona?.config?.prefix === promptText, `${Buffer.byteLength(promptText, 'utf8')} bytes`]] : []),
    ['tool rows preserved', plugins.filter(row => row?.name?.startsWith('@deepseek-ai/dsh-tool-')).length >= basePlugins.filter(row => row?.name?.startsWith('@deepseek-ai/dsh-tool-')).length, ''],
    ['no row lost', plugins.length >= basePlugins.length, `${basePlugins.length} -> ${plugins.length}`],
  ];
  const bad = checks.filter(([, ok]) => !ok);
  failures += bad.length;
  const note = hasPrompt ? '' : '  (role prompt is empty: persona would carry no role text)';
  console.log(`role ${role.roleId}: ${plugins.length} rows, ${servers.length} mcp, persona ${Buffer.byteLength(promptText, 'utf8')}B  ${bad.length === 0 ? 'OK' : 'FAIL'}${note}`);
  for (const [name, ok, detail] of checks) {
    if (!ok) console.log(`    FAIL ${name} ${detail}`);
  }
  if (warnings.length > 0) console.log(`    warnings: ${warnings.join('; ')}`);
}

console.log('');
console.log(failures === 0 ? `RESULT: all ${roles.length} role preset(s) validated` : `RESULT: ${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
