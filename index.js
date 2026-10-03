/**
 * Task Agent Kit — Host half.
 *
 * Turns every role folder under the configured source-agent path into one Agent
 * preset, so a session created with `agentPreset: <role preset id>` runs as that
 * role: its `Agent.md` becomes the session persona, its `.skills/` is mounted on
 * top of the shared skill roots, and its MCP servers are connected.
 *
 * The preset is composed by cloning a known-good base preset and injecting the
 * role rows, because a preset must carry its own complete plugin list.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { scanSourceRoot, SKILL_DIR_CANDIDATES, ROLE_PROMPT_CANDIDATES, MCP_FILE_CANDIDATES } from './src/source-agent-registry.js';
import { composeRolePreset } from './src/role-preset.js';
import { createRoleSkeleton, ROLE_FOLDERS } from './src/role-scaffold.js';

export const name = 'task-agent-kit';

export const inject = ['agentPresets', 'tools'];

/**
 * `@deepseek-ai/dsh-tools` ships with the harness, so it resolves inside a profile but
 * not when these modules are exercised from a plain workspace.
 *
 * The fallback deliberately **re-validates the contract the real `defineTool` enforces**
 * instead of passing the definition through. A permissive stub once let a tool ship
 * without its required `output { schema, render }`, which crashed harness startup with
 * `Cannot read properties of undefined (reading 'render')` and pushed the desktop app
 * into safe mode. Offline runs must be able to catch exactly that.
 */
const toolsModule = await import('@deepseek-ai/dsh-tools').then(mod => mod).catch(() => undefined);
const defineTool = toolsModule?.defineTool ?? (definition => {
  if (definition === null || typeof definition !== 'object') {
    throw new TypeError('defineTool: options must be an object');
  }
  const label = typeof definition.name === 'string' && definition.name.length > 0 ? definition.name : undefined;
  if (label === undefined) throw new TypeError('defineTool: name is required');
  if (typeof definition.description !== 'string' || definition.description.length === 0) {
    throw new TypeError(`defineTool(${label}): description is required`);
  }
  if (definition.parameters === undefined) throw new TypeError(`defineTool(${label}): parameters is required`);
  if (typeof definition.execute !== 'function') throw new TypeError(`defineTool(${label}): execute is required`);
  const output = definition.output;
  if (output === null || typeof output !== 'object' || output.schema === undefined || typeof output.render !== 'function') {
    throw new TypeError(`tool "${label}" must declare output { schema, render, presentationMeta? }`);
  }
  return definition;
});

/**
 * `@deepseek-ai/schemastery` ships with the harness, so it resolves when the bundle
 * runs inside a profile but not when these modules are exercised from a plain
 * workspace. Loading it lazily keeps the plugin code testable; inside dsh the real
 * schema is always used.
 */
const schemastery = await import('@deepseek-ai/schemastery').then(mod => mod.default ?? mod).catch(() => undefined);
const z = schemastery ?? (() => {
  // Offline fallback: a chainable no-op node so schema declarations read the same
  // whether or not the harness-provided schemastery resolved.
  const chainable = () => {
    const node = {
      default: () => node,
      volatile: () => node,
      required: () => node,
      min: () => node,
      max: () => node,
      step: () => node,
      description: () => node,
    };
    return node;
  };
  return { string: chainable, number: chainable, boolean: chainable, array: chainable, object: shape => shape };
})();

/**
 * Read one Config field.
 *
 * A field declared `.volatile()` is delivered as a live ref (its current value comes
 * from `get()`), while an ordinary field is a plain value. Both shapes are accepted so
 * the plugin behaves the same whether or not a field is live-editable.
 */
export function readConfigValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value.get === 'function') {
    const current = value.get();
    return current === undefined || current === null ? fallback : current;
  }
  return value;
}

/** The Loader row id, which is also this plugin's settings namespace. */
const ROW_ID = 'task-agent-kit';

export const Config = z.object({
  /**
   * Absolute path whose first-level folders are the selectable roles.
   *
   * Marked volatile so the Settings page can write it through
   * `settings.mutate('task-agent-kit', …)`: the settings service refuses to edit any
   * path that is not beneath a volatile node. A volatile field arrives as a live ref
   * (read it through `readConfigValue`), which is also why this plugin subscribes to
   * `settings/document-updated` instead of relying on a remount to notice the change.
   */
  sourceAgentPath: z.string().default('').volatile(),
  /** Preset whose plugin list is cloned for each role; empty = the default preset. */
  basePresetId: z.string().default(''),
  /** Skill folder names a role may use, in priority order. */
  skillDirCandidates: z.array(z.string()).default(SKILL_DIR_CANDIDATES),
  /** Role prompt file names, in priority order. */
  rolePromptCandidates: z.array(z.string()).default(ROLE_PROMPT_CANDIDATES),
  /** MCP config file names, in priority order. */
  mcpFileCandidates: z.array(z.string()).default(MCP_FILE_CANDIDATES),
  /** Preset id prefix; each role becomes `<prefix>-<slug>`. */
  presetIdPrefix: z.string().default('taskagent'),
  /** Register presets for roles whose prompt file is empty. */
  allowEmptyPrompt: z.boolean().default(false),
  /** Remove previously registered role presets whose role folder disappeared. */
  pruneStaleRoles: z.boolean().default(true),
  /**
   * Absolute path of a JSON status file. When set, every scan writes its outcome
   * there: the harness log only carries warnings and errors, so without this artifact
   * a successful registration is invisible to anyone inspecting the deployment.
   */
  statusFile: z.string().default(''),
  /** Folder holding the tier role templates used by the scaffolding tool. */
  roleTemplateDir: z.string().default(''),
  /** Allow the scaffolding tool to reuse an existing role folder. */
  allowOverwrite: z.boolean().default(false),
  /**
   * Resource roots every role shares, each shaped like a role folder
   * (`.skills`, `.mcp\mcp.json`, and any application folders).
   *
   * Their `.skills` directories are appended to EVERY role preset's `customSkillDirs` and
   * their `.mcp\mcp.json` servers are merged into every role preset, so a resource added
   * to a shared root becomes available to every agent without touching each role folder.
   */
  sharedRoots: z.array(z.string()).default([]),
});

/** Row ids must stay unique inside a preset, so fold any character that is not safe. */
function safeRowId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '') || 'row';
}

/**
 * Collect every module name a declared row list uses, descending into group rows.
 *
 * A preset's rows nest: `cordis:group` rows carry their own child list. The live
 * `compositionInventory()` reports rows **flattened**, so a drift comparison must
 * flatten the template the same way or every grouped row reads as a false alarm.
 */
function flattenModuleNames(plugins, found = new Set()) {
  for (const row of plugins ?? []) {
    if (typeof row?.name === 'string') found.add(row.name);
    if (Array.isArray(row?.config)) flattenModuleNames(row.config, found);
  }
  return found;
}

/**
 * The base row template.
 *
 * `agentPresets.resolve()` returns an `AgentPreset`, which carries only display
 * metadata — **no plugin list** — so a preset cannot be cloned straight from the
 * registry. The one supported read API, `readDocument()`, returns the declaration
 * as YAML, which this bundle deliberately will not parse. The base rows therefore
 * ship materialised as `preset-base.json` (regenerate with
 * `tools/gen-preset-base.mjs` after a harness upgrade), and `compositionInventory()`
 * is consulted below so upstream drift is reported instead of breaking silently.
 */
const TEMPLATE_URL = new URL('./preset-base.json', import.meta.url);

/**
 * Host entry point.
 * @param ctx - plugin context with the `agentPresets` service.
 * @param config - validated row config.
 */
export async function apply(ctx, config = {}) {
  const prefix = config.presetIdPrefix ?? 'taskagent';
  const registered = new Map();

  const presetIdFor = role => `${prefix}-${role.presetId.replace(new RegExp(`^${prefix}-`), '')}`;

  /** Compare the shipped template with the live base preset; report live rows we lack. */
  async function baseDrift(baseId, templateNames) {
    if (typeof ctx.agentPresets.compositionInventory !== 'function') return [];
    try {
      const inventory = await ctx.agentPresets.compositionInventory();
      const entry = inventory.find(item => item.id === baseId);
      if (entry === undefined) return [`base preset "${baseId}" is not in the composition inventory`];
      return entry.rows
        .map(row => row.moduleName)
        .filter(name => typeof name === 'string' && !templateNames.has(name))
        .map(name => `live base preset has row "${name}" that preset-base.json lacks`);
    } catch (error) {
      return [`composition inventory unavailable: ${error?.message ?? error}`];
    }
  }

  /** Load the base row template and confirm the requested base preset exists. */
  async function loadBase() {
    let template;
    try {
      template = JSON.parse(await readFile(TEMPLATE_URL, 'utf8'));
    } catch (error) {
      throw new Error(`preset-base.json is unreadable: ${error?.message ?? error}`);
    }
    if (!Array.isArray(template.plugins) || template.plugins.length === 0) {
      throw new Error('preset-base.json carries no plugin rows');
    }
    const requested = (config.basePresetId ?? '').trim();
    const baseId = requested.length > 0 ? requested : (template.sourcePreset ?? 'standard');
    // `resolve()` proves the id exists and is loadable; the rows come from the template.
    const live = await ctx.agentPresets.resolve(baseId);
    const templateNames = flattenModuleNames(template.plugins);
    return {
      id: live.id,
      plugins: structuredClone(template.plugins),
      rowCount: template.plugins.length,
      templateSource: template.sourcePreset,
      drift: await baseDrift(live.id, templateNames),
    };
  }

  /** Register every role preset; returns the roster for logging and diagnostics. */
  async function sync(sourcePath) {
    const { roles, skipped } = await scanSourceRoot(sourcePath);
    const base = await loadBase();
    if (base.drift.length > 0) {
      ctx.logger?.warn?.(`task-agent-kit: base preset drift detected — ${base.drift.join('; ')}`);
    }
    const roster = [];
    const failures = [];
    const adopted = [];

    // Preset ids already present before this run. `register()` refuses duplicates, and a
    // live reload starts from a fresh closure with no disposers, so this is the only way
    // to tell "ours from an earlier run" apart from "not registered yet".
    const preExisting = new Set();
    try {
      for (const preset of (await ctx.agentPresets.list()) ?? []) {
        if (typeof preset?.id === 'string') preExisting.add(preset.id);
      }
    } catch (error) {
      ctx.logger?.warn?.(`task-agent-kit: could not list existing presets: ${error?.message ?? error}`);
    }

    // Shared resource roots. Every role preset gains their `.skills` directories and their
    // merged MCP servers, so a resource deployed once into a shared root reaches every
    // agent — including roles created later, which is the point of the shared tree.
    const sharedSkillsDirs = [];
    const sharedMcpServers = [];
    const sharedRoots = [];
    for (const entry of Array.isArray(config.sharedRoots) ? config.sharedRoots : []) {
      const root = String(entry ?? '').trim();
      if (root.length === 0) continue;
      sharedRoots.push(root);
      const skillsDir = join(root, '.skills');
      try {
        await readdir(skillsDir);
        sharedSkillsDirs.push(skillsDir);
      } catch {
        /* a shared root without a .skills directory contributes no skill root */
      }
      try {
        const parsed = JSON.parse(await readFile(join(root, '.mcp', 'mcp.json'), 'utf8'));
        for (const [serverName, spec] of Object.entries(parsed?.mcpServers ?? {})) {
          sharedMcpServers.push({ serverName, ...(spec ?? {}) });
        }
      } catch {
        /* a shared root without mcp.json contributes no servers */
      }
    }
    state.sharedRoots = sharedRoots;
    state.sharedSkillsDirs = sharedSkillsDirs;
    state.sharedMcpServerNames = sharedMcpServers.map(server => server.serverName);

    for (const role of roles) {
      const presetId = presetIdFor(role);
      let promptText = '';
      if (role.promptPath !== undefined) promptText = await readFile(role.promptPath, 'utf8');
      if (promptText.trim().length === 0 && config.allowEmptyPrompt !== true) {
        failures.push({ roleId: role.roleId, reason: 'role prompt is empty', promptPath: role.promptPath });
        continue;
      }
      let plugins;
      try {
        ({ plugins } = composeRolePreset(base.plugins, { ...role, sharedSkillsDirs, sharedMcpServers }, promptText));
      } catch (error) {
        failures.push({ roleId: role.roleId, reason: `compose failed: ${error?.message ?? error}` });
        continue;
      }
      // Row ids inside a preset must be unique.
      const seen = new Set();
      for (const row of plugins) {
        row.id = safeRowId(row.id ?? `${prefix}-${role.roleId}`);
        let candidate = row.id;
        let suffix = 2;
        while (seen.has(candidate)) candidate = `${row.id}-${suffix++}`;
        row.id = candidate;
        seen.add(candidate);
      }

      const definition = {
        id: presetId,
        name: role.displayName ?? role.roleId,
        description: (role.description ?? '').slice(0, 200),
        order: 100 + roster.length,
        plugins,
      };

      const previous = registered.get(presetId);
      if (previous !== undefined) await previous();
      // `register()` rejects an id that is already registered. A live reload re-runs
      // `apply` with a fresh closure, so a registration whose disposer we no longer
      // hold would collide with itself and fail the whole role.
      if (preExisting.has(presetId)) {
        adopted.push({
          roleId: role.roleId,
          presetId,
          rolePath: role.rolePath,
          reason: 'already registered by an earlier run of this plugin; reused as-is (its disposer belongs to that run)',
        });
        continue;
      }
      try {
        const dispose = await ctx.agentPresets.register(definition);
        registered.set(presetId, dispose);
        // `register()` resolves even when the definition failed to mount: the registry
        // records the failure as `broken` instead of throwing. Reporting success here
        // without reading it back would hide a preset that can never be selected.
        const live = await ctx.agentPresets.resolve(presetId).catch(() => undefined);
        if (typeof live?.broken === 'string' && live.broken.length > 0) {
          failures.push({ roleId: role.roleId, reason: `preset did not activate: ${live.broken}` });
          continue;
        }
        roster.push({
          roleId: role.roleId,
          presetId,
          rolePath: role.rolePath,
          promptBytes: Buffer.byteLength(promptText, 'utf8'),
          skillsDir: role.skillsDir,
          mcpServers: (role.mcpServers ?? []).map(server => server.serverName),
          rows: plugins.length,
          warnings: role.diagnostics ?? [],
        });
      } catch (error) {
        failures.push({ roleId: role.roleId, reason: `register failed: ${error?.message ?? error}` });
      }
    }

    if (config.pruneStaleRoles === true) {
      const live = new Set(roster.map(entry => entry.presetId));
      for (const [presetId, dispose] of [...registered.entries()]) {
        if (live.has(presetId)) continue;
        await dispose();
        registered.delete(presetId);
      }
    }
    return { base: base.id, baseRows: base.rowCount, drift: base.drift, roster, adopted, skipped, failures };
  }

  /** Remove every preset this plugin registered. */
  async function disposeAll() {
    for (const [presetId, dispose] of [...registered.entries()]) {
      registered.delete(presetId);
      try {
        await dispose();
      } catch (error) {
        ctx.logger?.warn?.(`task-agent-kit: disposing preset "${presetId}" failed: ${error?.message ?? error}`);
      }
    }
  }

  /** Persist the scan outcome so a successful registration is inspectable. */
  async function writeStatus() {
    const target = (config.statusFile ?? '').trim();
    if (target.length === 0) return;
    const payload = {
      writtenAt: new Date().toISOString(),
      // The resolved value, not the raw config field: `sourceAgentPath` is volatile, so
      // the raw field is a ref object that serializes as `{}`.
      sourceAgentPath: sourcePath(),
      basePreset: state.base,
      baseRows: state.baseRows,
      // Shared resources every role preset received, so a document generator can name them
      // without re-deriving the configuration.
      sharedRoots: state.sharedRoots ?? [],
      sharedSkillsDirs: state.sharedSkillsDirs ?? [],
      sharedMcpServers: state.sharedMcpServerNames ?? [],
      registered: state.roster.map(entry => ({ roleId: entry.roleId, presetId: entry.presetId, promptBytes: entry.promptBytes, skillsDir: entry.skillsDir, mcpServers: entry.mcpServers, rows: entry.rows })),
      adopted: state.adopted ?? [],
      skipped: state.skipped,
      failures: state.failures,
      drift: state.drift ?? [],
      lastError: state.lastError,
    };
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (error) {
      ctx.logger?.warn?.(`task-agent-kit: status file "${target}" is unwritable: ${error?.message ?? error}`);
    }
  }

  const state = { base: undefined, baseRows: undefined, roster: [], skipped: [], failures: [], drift: [], lastError: undefined };

  /** The configured path, read live so a volatile edit is honoured without a remount. */
  const sourcePath = () => String(readConfigValue(config.sourceAgentPath, '') ?? '');

  /** Drop every preset this plugin registered, so a re-scan starts from a clean slate. */
  async function releaseAll() {
    const ids = [...registered.keys()];
    await disposeAll();
    return ids;
  }

  /** Re-scan after a live settings edit; failures are reported, never thrown. */
  async function resync(reason) {
    const path = sourcePath();
    ctx.logger?.info?.(`task-agent-kit: re-scanning after ${reason} (path "${path}")`);
    try {
      await releaseAll();
      if (path.trim().length === 0) {
        state.roster = [];
        state.failures = [{ roleId: '(none)', reason: 'sourceAgentPath is not configured' }];
      } else {
        const result = await sync(path);
        Object.assign(state, result);
        state.lastError = undefined;
      }
    } catch (error) {
      state.lastError = String(error?.message ?? error);
      state.failures = [{ roleId: '(rescan)', reason: state.lastError }];
      ctx.logger?.warn?.(`task-agent-kit: re-scan failed: ${state.lastError}`);
    }
    await writeStatus();
  }

  if (sourcePath().trim().length === 0) {
    state.failures = [{ roleId: '(none)', reason: 'sourceAgentPath is not configured' }];
    ctx.logger?.info?.('task-agent-kit: sourceAgentPath is not configured; no role preset registered');
  } else {
    try {
      const result = await sync(sourcePath());
      Object.assign(state, result);
      state.lastError = undefined;
      // The harness log bridge records warnings and errors only: a successful run would
      // otherwise leave no trace, so the outcome is reported at warning level when it
      // needs attention and persisted through `statusFile` in every case.
      const summary = `task-agent-kit: registered ${result.roster.length} role preset(s) from "${sourcePath()}" (base "${result.base}", ${result.baseRows} rows)`
        + (result.adopted.length > 0 ? `; reused ${result.adopted.length} already-registered preset(s)` : '')
        + (result.skipped.length > 0 ? `; skipped ${result.skipped.length} folder(s)` : '')
        + (result.failures.length > 0 ? `; ${result.failures.length} role(s) failed` : '');
      if (result.failures.length > 0) {
        ctx.logger?.warn?.(`${summary} — ${result.failures.map(item => `${item.roleId}: ${item.reason}`).join(' | ')}`);
      } else if (result.roster.length === 0) {
        // Nothing registered is never a silent success.
        ctx.logger?.warn?.(`${summary} — no role preset was registered; check sourceAgentPath and role markers`);
      } else {
        ctx.logger?.info?.(summary);
      }
    } catch (error) {
      // A bad path must not take down the harness: record it and keep the plugin mounted.
      state.lastError = String(error?.message ?? error);
      state.failures = [{ roleId: '(scan)', reason: state.lastError }];
      ctx.logger?.warn?.(`task-agent-kit: initial scan failed: ${state.lastError}`);
    }
  }
  await writeStatus();

  // Live settings edits do not remount this plugin (the field is volatile), so the
  // registration is refreshed from the settings event instead of from a restart.
  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('settings/document-updated', ns => {
      if (ns !== ROW_ID) return;
      void resync('a settings change');
    }));
  }

  // Role scaffolding as a model-facing tool: creating a role is the one part of the
  // flow that cannot be expressed by choosing an existing folder.
  if (typeof ctx.tools?.register === 'function') {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'create_task_agent_role',
      description:
        'Create one task-agent role: a first-level folder under the configured source-agent path holding '
        + `Agent.md (the role prompt), agent.json (display metadata) and the conventional folders ${ROLE_FOLDERS.join(', ')}. `
        + 'The role becomes selectable immediately. Use it when the user asks for a new kind of agent that no existing role covers. '
        + 'It never overwrites an existing role folder unless the plugin is configured to allow that.',
      parameters: {
        role_name: {
          type: 'string',
          required: true,
          description: 'Folder name for the role, e.g. "后端开发" or "Backend Dev". No path separators.',
        },
        tier: {
          type: 'number',
          description: 'Tier the role is meant to sit at, 1–5. Defaults to 5 (an executing role).',
        },
        description: {
          type: 'string',
          description: 'One line describing what this role owns. Stored in agent.json and shown on the deck card.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Report what would be created without writing anything. Use it to confirm the name first.',
        },
      },
      // `output` is mandatory for defineTool: it reads `output.render` and validates
      // `output.schema`. The tool answers with a short human-readable line, which keeps
      // the declared value schema as simple as possible.
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
      },
      execute: async args => {
        const root = sourcePath();
        try {
          const result = await createRoleSkeleton({
            rootPath: root,
            roleName: args?.role_name,
            tier: args?.tier ?? 5,
            description: args?.description ?? '',
            templateDir: String(readConfigValue(config.roleTemplateDir, '') ?? ''),
            overwrite: readConfigValue(config.allowOverwrite, false) === true,
            dryRun: args?.dry_run === true,
          });
          if (result.dryRun !== true) await resync(`the new role "${result.roleName}"`);
          const note = result.templateWarning === undefined ? '' : ` (${result.templateWarning})`;
          return result.dryRun === true
            ? `would create role "${result.roleName}" at ${result.rolePath} (tier ${result.tier})${note}; re-run without dry_run to create it`
            : `created role "${result.roleName}" at ${result.rolePath} (tier ${result.tier})${note}; it is registered now`;
        } catch (error) {
          // A refused name or an existing folder is a normal answer, not a crash.
          return `could not create the role: ${String(error?.message ?? error)}`;
        }
      },
    })));
  }

  ctx.effect(() => () => disposeAll());
}
