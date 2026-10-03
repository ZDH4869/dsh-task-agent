/**
 * Generate `preset-base.json` from a shipped preset declaration.
 *
 * `AgentPreset` (what `agentPresets.resolve()` returns) carries no plugin list, so
 * the kit cannot read a base preset's rows from the registry. The supported read API
 * is `readDocument()`, which returns the declaration as YAML — parsing YAML inside
 * the Host is a dependency this bundle should not take. Instead the base row list is
 * materialised here, once, into a plain JSON file the kit reads at runtime; the kit
 * then cross-checks it against `compositionInventory()` and warns on drift.
 *
 * `!!js` scalars are evaluated at generation time, so the emitted template is a
 * concrete snapshot for the platform it was generated on.
 *
 * Run: node D:\DSH_desktop\dsh-ext\task-agent-kit\tools\gen-preset-base.mjs [--check]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'preset-base.json');
const APP = 'D:\\DSH_desktop\\deepseek_harness_desktop\\DSH Desktop\\resources\\app.asar.unpacked\\node_modules\\@deepseek-ai';
const SOURCE_PRESET = 'standard';

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
  throw new Error('js-yaml not found; run from a profile-launched shell or install it');
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
const patchPath = join(APP, 'dsh-web-app', 'presets', `${SOURCE_PRESET}.patch.yml`);
const patch = yaml.load(await readFile(patchPath, 'utf8'), { schema });
const row = patch.flatMap(entry => entry.insert ?? []).find(candidate => candidate.name === '@deepseek-ai/dsh-agent-preset');
if (row === undefined) throw new Error(`no agent-preset row in ${patchPath}`);

const document = {
  $comment: `Generated from ${SOURCE_PRESET}.patch.yml of @deepseek-ai/dsh-web-app. AgentPreset exposes no plugin list at runtime, so this is the kit's base-row template. Regenerate with tools/gen-preset-base.mjs after a harness upgrade.`,
  sourcePreset: row.config.id,
  generatedFrom: patchPath,
  plugins: row.config.plugins,
};

const serialized = `${JSON.stringify(document, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = await readFile(OUT, 'utf8');
  if (current !== serialized) {
    console.error('preset-base.json is STALE relative to the shipped preset.');
    process.exitCode = 1;
  } else {
    console.log('preset-base.json is up to date.');
  }
} else {
  await writeFile(OUT, serialized, 'utf8');
  const moduleNames = document.plugins.map(plugin => plugin.name);
  console.log(`wrote ${OUT}`);
  console.log(`source preset : ${document.sourcePreset}`);
  console.log(`rows          : ${document.plugins.length}`);
  console.log(`module names  : ${moduleNames.length} (${new Set(moduleNames).size} unique)`);
  console.log(`sample        : ${moduleNames.slice(0, 5).join(', ')} ...`);
}
