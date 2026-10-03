/**
 * What would the kit register, for real?
 *
 * Drives the actual Host `apply()` against a stubbed context and the *live* source
 * root, using the shipped standard preset as the clone base. Read-only: it registers
 * nothing and writes nothing.
 *
 * Run: node D:\DSH_desktop\dsh-ext\task-agent-kit\tools\dry-run.mjs ["<source root>"]
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP = 'D:\\DSH_desktop\\deepseek_harness_desktop\\DSH Desktop\\resources\\app.asar.unpacked\\node_modules\\@deepseek-ai';
const sourceRoot = process.argv[2] ?? 'D:\\DSH_desktop\\Agents';

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
      /* next */
    }
  }
  throw new Error('js-yaml not found');
}

const yaml = await loadYaml();
const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => {
    try {
      return Function(`"use strict"; return (${value});`)();
    } catch {
      return value;
    }
  },
});
const schema = yaml.DEFAULT_SCHEMA.extend([jsTag]);
const patch = yaml.load(await readFile(join(APP, 'dsh-web-app', 'presets', 'standard.patch.yml'), 'utf8'), { schema });
const baseRow = patch.flatMap(entry => entry.insert ?? []).find(row => row.name === '@deepseek-ai/dsh-agent-preset');
const BASE_PLUGINS = baseRow.config.plugins;

// The real `AgentPreset` carries display metadata only — never a plugin list.
// `compositionInventory()` is the live row source, and only exposes module names.
const liveModules = new Set(BASE_PLUGINS.map(row => row.name));
const registered = [];
const logs = [];
const ctx = {
  agentPresets: {
    resolve: async id => {
      if (id === undefined || id === '' || id === baseRow.config.id) return { id: baseRow.config.id, name: 'Standard' };
      if (typeof id === 'string' && id.startsWith('taskagent-')) return { id, name: id };
      throw new Error(`unknown preset "${id}"`);
    },
    list: async () => [],
    compositionInventory: async () => [{
      id: baseRow.config.id,
      isDefault: true,
      rows: BASE_PLUGINS.map((row, index) => ({ entryId: `e${index}`, moduleName: row.name, enabled: true })),
    }],
    register: async definition => {
      registered.push(structuredClone(definition));
      return async () => {};
    },
  },
  logger: {
    info: message => logs.push(`info ${message}`),
    warn: message => logs.push(`warn ${message}`),
  },
  effect: () => {},
};

const { apply } = await import('../index.js');
await apply(ctx, {
  sourceAgentPath: sourceRoot,
  basePresetId: '',
  presetIdPrefix: 'taskagent',
  allowEmptyPrompt: false,
  pruneStaleRoles: true,
});

console.log(`source root   : ${sourceRoot}`);
console.log(`base preset   : ${baseRow.config.id} (${BASE_PLUGINS.length} rows)`);
console.log(`log           : ${logs.join(' | ') || '(none)'}`);
console.log(`registered    : ${registered.length}`);
for (const preset of registered) {
  const persona = preset.plugins.find(row => row.name === '@deepseek-ai/dsh-persona');
  const skills = preset.plugins.find(row => row.name === '@deepseek-ai/dsh-skill-filesystem');
  const mcp = preset.plugins.filter(row => row.name === '@deepseek-ai/dsh-mcp-client');
  const dupes = preset.plugins.map(r => r.id).filter((id, i, all) => all.indexOf(id) !== i);
  console.log('');
  console.log(`  preset id   : ${preset.id}`);
  console.log(`  name        : ${preset.name}`);
  console.log(`  description : ${preset.description}`);
  console.log(`  rows        : ${preset.plugins.length} (base ${BASE_PLUGINS.length} + ${preset.plugins.length - BASE_PLUGINS.length})`);
  console.log(`  persona     : ${persona?.config?.prefix ? persona.config.prefix.length + ' chars' : '(MISSING)'}${persona?.config?.suffix ? ' + suffix kept' : ''}`);
  console.log(`  skill dirs  : ${JSON.stringify(skills?.config?.customSkillDirs ?? [])}`);
  console.log(`  mcp servers : ${mcp.length === 0 ? '(none)' : mcp.map(row => row.config.serverName).join(', ')}`);
  console.log(`  row id dupes: ${dupes.length === 0 ? 'none' : dupes.join(', ')}`);
}
console.log('');
console.log(registered.length > 0 ? 'OK: the kit would register the presets above.' : 'NOTHING TO REGISTER for this root.');
