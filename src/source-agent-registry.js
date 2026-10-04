/**
 * Source-agent scanning and role-preset composition for the multi-tier task-agent tree.
 *
 * This module is deliberately free of Cordis dependencies so it can be unit-tested
 * with plain Node: every function here is a pure transformation of the filesystem
 * and the configured source-agent root.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, basename, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';

/** Directory names a role folder may use for its private skill packages. */
export const SKILL_DIR_CANDIDATES = ['.skills', '.agents/skills', 'skills'];

/** Filenames a role folder may use for its role prompt, in priority order. */
export const ROLE_PROMPT_CANDIDATES = ['Agent.md', 'AGENTS.md', 'CLAUDE.md'];

/** Filenames a role folder may use for its private MCP server list. */
export const MCP_FILE_CANDIDATES = ['mcp.json', '.mcp.json', '.mcp/mcp.json', '.mcp/servers.json', 'mcp.yml', 'mcp.yaml'];

/**
 * A role is one first-level folder under the configured source-agent root.
 * Folder names are user-authored, so any name a filesystem accepts is allowed
 * except path separators and control characters; the preset id is normalized
 * separately by presetIdForRole.
 */
export function roleIdFromPath(rolePath) {
  const id = basename(rolePath);
  if (id.length === 0 || id.length > 128 || /[\\/\u0000-\u001f]/u.test(id) || id === '.' || id === '..') {
    throw new Error(`role folder name is not usable as an id: ${JSON.stringify(id)}`);
  }
  return id;
}

/** Stable, filesystem-safe preset id for one role. */
export function presetIdForRole(roleId, prefix = 'taskagent') {
  const normalized = roleId.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '');
  // A Chinese role name normalizes to an empty slug, so fall back to a hash suffix.
  const digest = createHash('sha1').update(roleId, 'utf8').digest('hex').slice(0, 8);
  const slug = normalized.length > 0 ? normalized : `role-${digest}`;
  return `${prefix}-${slug}`;
}

async function firstExisting(dir, candidates) {
  for (const candidate of candidates) {
    const full = join(dir, ...candidate.split('/'));
    try {
      const info = await stat(full);
      if (info.isDirectory() || info.isFile()) return { path: full, relative: candidate };
    } catch {
      /* absent candidate: keep looking */
    }
  }
  return undefined;
}

/** Parse the small MCP JSON/YAML subset this kit supports, without a YAML dependency. */
export function parseMcpConfigText(text, format) {
  if (format === 'json') {
    const parsed = JSON.parse(text);
    const servers = parsed.mcpServers ?? parsed.servers ?? parsed;
    return normalizeMcpServers(servers);
  }
  // Minimal YAML support: a mapping of server name -> properties, optionally under
  // an `mcpServers:` wrapper. Server properties sit at one deeper indent than the
  // server key; nested maps (`env:`, `headers:`) are ignored, and `args:` is the
  // one key whose block sequence is collected.
  const servers = {};
  /** Active server name and the indent of its own key. */
  let server;
  let serverIndent = -1;
  /** When set, every deeper line belongs to a nested map that this parser ignores. */
  let skipDeeperThan = -1;
  for (const rawLine of text.split(/\r?\n/u)) {
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    if (skipDeeperThan >= 0 && indent > skipDeeperThan) continue;
    skipDeeperThan = -1;

    if (line === 'mcpServers:' || line === 'servers:') {
      server = undefined;
      serverIndent = -1;
      continue;
    }
    if (line.startsWith('- ')) {
      if (server !== undefined && indent > serverIndent) {
        servers[server].args = [...(servers[server].args ?? []), stripQuotes(line.slice(2).trim())];
      }
      continue;
    }
    const match = /^([^:]+):\s*(.*)$/u.exec(line);
    if (match === null) continue;
    const key = match[1].trim();
    const value = match[2];

    if (value.length === 0) {
      if (server === undefined || indent <= serverIndent) {
        // This key names a server, either under a wrapper or as a bare mapping.
        server = key;
        serverIndent = indent;
        servers[key] = servers[key] ?? {};
      } else if (key !== 'args') {
        // A nested mapping inside the current server (`env:`, `headers:`, …).
        skipDeeperThan = indent;
      }
      // `args:` with no inline value is followed by a block sequence; the item
      // branch above collects it because its indent stays deeper than the server.
      continue;
    }
    if (server === undefined) {
      server = key;
      serverIndent = indent;
      servers[key] = servers[key] ?? {};
      continue;
    }
    servers[server][key] = stripQuotes(value);
  }
  return normalizeMcpServers(servers);
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/u.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map(part => stripQuotes(part))
      .filter(part => String(part).length > 0);
  }
  return trimmed;
}

function normalizeMcpServers(servers) {
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('MCP config must be an object of server definitions');
  }
  const out = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (raw === null || typeof raw !== 'object') throw new Error(`MCP server "${name}" must be an object`);
    const server = { serverName: name, ...raw };
    if (server.transport === undefined) {
      server.transport = server.url !== undefined ? 'streamable-http' : 'stdio';
    }
    out.push(server);
  }
  return out;
}

/**
 * Scan one role folder.
 * @param rolePath - absolute path of a first-level folder under the source-agent root.
 * @returns the role descriptor, including what the preset composer needs.
 */
export async function scanRole(rolePath) {
  const absolute = resolve(rolePath);
  const roleId = roleIdFromPath(absolute);
  const prompt = await firstExisting(absolute, ROLE_PROMPT_CANDIDATES);
  const skills = await firstExisting(absolute, SKILL_DIR_CANDIDATES);
  const mcp = await firstExisting(absolute, MCP_FILE_CANDIDATES);
  let agent = undefined;
  let hasAgentJson = false;
  try {
    agent = JSON.parse(await readFile(join(absolute, 'agent.json'), 'utf8'));
    hasAgentJson = true;
  } catch {
    /* optional */
  }
  let mcpServers = [];
  if (mcp !== undefined) {
    const format = mcp.relative.endsWith('.json') ? 'json' : 'yaml';
    try {
      mcpServers = parseMcpConfigText(await readFile(mcp.path, 'utf8'), format);
    } catch (error) {
      mcpServers = [];
      agent = { ...(agent ?? {}), mcpError: String(error?.message ?? error) };
    }
  }
  const promptText = prompt === undefined ? '' : await readFile(prompt.path, 'utf8');
  return {
    roleId,
    rolePath: absolute,
    presetId: presetIdForRole(roleId),
    hasAgentJson,
    promptPath: prompt?.path,
    promptBytes: Buffer.byteLength(promptText, 'utf8'),
    skillsDir: skills?.path,
    mcpServers,
    displayName: agent?.displayName ?? roleId,
    description: agent?.description ?? firstParagraph(promptText),
    // A role opts out of the shared roots with `mountShared: false`; absent means opt in,
    // which keeps every hand-made folder on the default (shared resources are available).
    mountShared: agent?.mountShared !== false,
    diagnostics: [
      ...(prompt === undefined ? ['missing role prompt (Agent.md / AGENTS.md / CLAUDE.md)'] : []),
      ...(agent?.mcpError === undefined ? [] : [`MCP config ignored: ${agent.mcpError}`]),
    ],
  };
}

function firstParagraph(text) {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.replace(/^#+\s*/u, '').trim();
    if (trimmed.length > 0 && !trimmed.startsWith('---') && !trimmed.startsWith('>')) return trimmed.slice(0, 200);
  }
  return '';
}

/**
 * List every role under the configured source-agent root.
 *
 * A first-level folder is only a role when it carries a role marker. Without that
 * rule a folder that merely *holds* agent resources (a `log`, `markdown`, or
 * `open_project` subdirectory of one role) would be offered as a selectable agent.
 *
 * @param rootPath - the "source agent path" setting.
 * @returns sorted role descriptors plus the folders that were skipped and why.
 */
export async function scanSourceRoot(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.trim().length === 0) {
    throw new Error('source-agent path is not configured');
  }
  if (!isAbsolute(rootPath)) throw new Error(`source-agent path must be absolute: ${rootPath}`);
  const root = resolve(rootPath);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`source-agent path is not readable: ${root} (${String(error?.message ?? error)})`);
  }
  const directories = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => join(root, entry.name))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const roles = [];
  const skipped = [];

  /**
   * Consider one candidate folder as a role.
   *
   * `prefix` is set for a nested candidate (`<一级文件夹>\<专家>`, the home the "create an
   * expert" form can target): its id is namespaced by the parent so two experts with the
   * same folder name under different parents stay distinct. Depth-2 candidates that carry no
   * role marker are silently ignored — a role folder's own `log`, `markdown` and
   * `open_project` are not interesting enough to report.
   */
  const consider = async (dir, prefix, report) => {
    let role;
    try {
      role = await scanRole(dir);
    } catch (error) {
      if (report) skipped.push({ path: dir, reason: `scan failed: ${String(error?.message ?? error)}` });
      return false;
    }
    // `agent.json` may promote a folder explicitly when its prompt lives elsewhere.
    if (role.promptPath === undefined && role.hasAgentJson !== true) {
      if (report) skipped.push({ path: dir, reason: 'no role marker (Agent.md / AGENTS.md / CLAUDE.md / agent.json)' });
      return false;
    }
    if (prefix !== undefined) {
      role.roleId = `${prefix}-${role.roleId}`;
      role.presetId = presetIdForRole(role.roleId);
    }
    roles.push(role);
    return true;
  };

  for (const dir of directories) {
    await consider(dir, undefined, true);
    // Always look one level deeper, including inside a role folder: that is where the
    // "create an expert" form puts a new expert when the user names a home for it.
    let subs = [];
    try {
      subs = (await readdir(dir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => join(dir, entry.name))
        .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    } catch {
      subs = [];
    }
    for (const sub of subs) await consider(sub, basename(dir), false);
  }
  return { root, roles, skipped };
}

/** Folders currently under the root that would be offered as roles. */
export function roleCandidates(scanResult) {
  return scanResult.roles.map(role => ({ roleId: role.roleId, presetId: role.presetId, displayName: role.displayName }));
}
