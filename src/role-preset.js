/**
 * Compose one role preset from an existing (working) preset plugin list.
 *
 * Why clone instead of hand-author: a preset must carry its own complete plugin
 * list (see the shipped `standard.patch.yml`). Cloning the active preset keeps
 * tools, delegation, planning, compaction, and the shared subagent rows exactly as
 * they are, so a role preset cannot silently lose capability when the base changes.
 */

/** Find the first row with the given plugin name, or undefined. */
export function findRow(plugins, name) {
  return plugins.find(row => row?.name === name);
}

/** Find every row with the given plugin name. */
export function findRows(plugins, name) {
  return plugins.filter(row => row?.name === name);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/**
 * Build the plugin list for one role.
 * @param basePlugins - the working preset's plugin rows (cloned, never mutated).
 * @param role - descriptor produced by scanRole.
 * @param rolePromptText - contents of the role's prompt file.
 * @returns a new plugin row list.
 */
export function composeRolePreset(basePlugins, role, rolePromptText) {
  if (!Array.isArray(basePlugins) || basePlugins.length === 0) {
    throw new Error('base preset has no plugins to clone');
  }
  const plugins = clone(basePlugins);
  const warnings = [];

  // 1. Role prompt -> persona prefix. Without this the role would inherit the
  //    deployment persona and its Agent.md would never reach the model.
  const persona = findRow(plugins, '@deepseek-ai/dsh-persona');
  if (persona === undefined) {
    plugins.unshift({
      id: `persona-${role.roleId}`,
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: rolePromptText },
    });
    warnings.push('base preset had no persona row; inserted one at the head');
  } else {
    persona.config = { ...(persona.config ?? {}), prefix: rolePromptText };
    persona.id = persona.id ?? 'persona';
  }

  // 2. Role-private skills, plus every SHARED skills root. `customSkillDirs` is additive
  //    on top of the default roots, so a role keeps the deployment skills and gains its
  //    own and the shared ones. Shared roots live outside the role folder (for example a
  //    common_project tree), which is why they are passed in rather than discovered here.
  const skillDirs = [];
  if (typeof role.skillsDir === 'string' && role.skillsDir.length > 0) skillDirs.push(role.skillsDir);
  for (const dir of role.sharedSkillsDirs ?? []) {
    if (typeof dir === 'string' && dir.length > 0 && !skillDirs.includes(dir)) skillDirs.push(dir);
  }
  if (skillDirs.length > 0) {
    const row = findRow(plugins, '@deepseek-ai/dsh-skill-filesystem');
    if (row === undefined) {
      plugins.push({
        id: `skill-filesystem-${role.roleId}`,
        name: '@deepseek-ai/dsh-skill-filesystem',
        config: { customSkillDirs: skillDirs },
      });
    } else {
      const existing = Array.isArray(row.config?.customSkillDirs) ? row.config.customSkillDirs : [];
      row.config = { ...(row.config ?? {}), customSkillDirs: [...existing, ...skillDirs] };
    }
  }

  // 3. Role-private MCP servers, then the shared ones.
  for (const server of [...(role.mcpServers ?? []), ...(role.sharedMcpServers ?? [])]) {
    plugins.push({
      id: `mcp-${role.roleId}-${server.serverName}`,
      name: '@deepseek-ai/dsh-mcp-client',
      config: clone(server),
    });
  }

  // 4. Role-declared model / reasoning overrides, applied to the delegation rows
  //    so that children spawned by this role inherit the role's own model choice.
  const agentOptions = pickAgentOptions(role.agentOptions);
  if (agentOptions !== undefined) {
    for (const row of findRows(plugins, '@deepseek-ai/dsh-tool-subagent')) {
      row.config = { ...(row.config ?? {}), agentOptions: { ...(row.config?.agentOptions ?? {}), ...agentOptions } };
    }
  }

  return { plugins, warnings };
}

function pickAgentOptions(source) {
  if (source === null || typeof source !== 'object') return undefined;
  const out = {};
  for (const key of ['provider', 'model', 'reasoningEffort', 'maxTokens']) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Human-readable summary of what a composed role preset changes. */
export function summarizeRolePreset(basePlugins, roleResult) {
  const { plugins, warnings } = roleResult;
  const count = name => findRows(plugins, name).length;
  return {
    totalRows: plugins.length,
    baseRows: basePlugins.length,
    personaRows: count('@deepseek-ai/dsh-persona'),
    skillProviderRows: count('@deepseek-ai/dsh-skill-filesystem'),
    mcpRows: count('@deepseek-ai/dsh-mcp-client'),
    toolRows: plugins.filter(row => typeof row?.name === 'string' && row.name.startsWith('@deepseek-ai/dsh-tool-')).length,
    warnings,
  };
}
