/**
 * Role scaffolding: create one selectable task-agent role folder.
 *
 * A role is a first-level folder under the configured source-agent root that carries
 * a role marker (`Agent.md` here). The scaffold produces that marker plus the
 * conventional resource folders, so a new role can be created from the UI or by an
 * agent instead of by hand-copying a template.
 *
 * Everything here is plain Node so it can be exercised without the harness.
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve, isAbsolute, basename } from 'node:path';

/** Folders every role gets, matching the convention this kit documents. */
/**
 * Folders every role gets, matching the convention the existing roles already use
 * (`.mcp`, `.skills`, `log`, `markdown`, `open_project` beside `Agent.md`). The scaffold
 * used to create `knowledge` and omit `.mcp`, so a freshly created role did not resemble
 * the roles sitting beside it.
 */
export const ROLE_FOLDERS = ['.mcp', '.skills', 'log', 'markdown', 'open_project'];

/** Tier templates shipped beside the agent folders. */
export const TIER_TEMPLATES = {
  1: '01-一级-总Agent.md',
  2: '02-中间层-编排Agent.md',
  3: '02-中间层-编排Agent.md',
  4: '02-中间层-编排Agent.md',
  5: '03-末级-执行Agent.md',
};

/**
 * Validate a role name.
 *
 * The name becomes a folder name, so it must not contain a path separator or a
 * character Windows refuses, and it must not be a traversal token.
 */
export function validateRoleName(name) {
  const value = String(name ?? '').trim();
  if (value.length === 0) throw new Error('role name must not be empty');
  if (value.length > 64) throw new Error('role name must be at most 64 characters');
  if (value === '.' || value === '..') throw new Error('role name must not be "." or ".."');
  if (/[\\/\u0000-\u001f]|[*?"<>|:]/u.test(value)) {
    throw new Error(`role name contains a character a folder name cannot hold: ${JSON.stringify(value)}`);
  }
  if (/[. ]$/u.test(value)) throw new Error('role name must not end with a dot or a space');
  return value;
}

/** Compose the role prompt: the tier template (when available) plus a role header. */
export function composeRolePrompt({ roleName, tier, description, templateText }) {
  const header = [
    `# ${roleName}`,
    '',
    `> 层级：第 ${tier} 层${tier === 1 ? '（一级 · 总 Agent）' : tier === 5 ? '（末级 · 执行 Agent）' : '（中间层 · 编排 Agent）'}`,
    description ? `> 职责：${description}` : undefined,
    '',
  ].filter(line => line !== undefined).join('\n');
  const body = typeof templateText === 'string' && templateText.trim().length > 0
    ? templateText
    : ['## 你的职责', '', '（在此写明这个角色负责什么、不负责什么。）', '', '## 交付标准', '', '（在此写明验收判据。）', ''].join('\n');
  return `${header}\n${body}`;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create one role folder.
 *
 * @param options - root path, role name, tier, description and template source.
 * @returns what was created, or what would be created under `dryRun`.
 */
export async function createRoleSkeleton(options) {
  const {
    rootPath,
    roleName,
    tier = 5,
    description = '',
    templateDir = '',
    overwrite = false,
    dryRun = false,
  } = options ?? {};

  if (typeof rootPath !== 'string' || rootPath.trim().length === 0) {
    throw new Error('source-agent path is not configured, so there is nowhere to create the role');
  }
  if (!isAbsolute(rootPath)) throw new Error(`source-agent path must be absolute: ${rootPath}`);
  const root = resolve(rootPath);
  if (!(await exists(root))) throw new Error(`source-agent path does not exist: ${root}`);

  const name = validateRoleName(roleName);
  const tierNumber = Number(tier);
  if (!Number.isInteger(tierNumber) || tierNumber < 1 || tierNumber > 5) {
    throw new Error(`tier must be an integer from 1 to 5, got ${JSON.stringify(tier)}`);
  }

  const rolePath = join(root, name);
  if (await exists(rolePath)) {
    if (!overwrite) throw new Error(`a folder named "${name}" already exists at ${rolePath}; nothing was changed`);
  }

  // A tier template is optional: without one the role still gets a usable skeleton.
  let templateText = '';
  let templatePath;
  let templateWarning;
  if (typeof templateDir === 'string' && templateDir.trim().length > 0) {
    const candidate = join(templateDir, TIER_TEMPLATES[tierNumber]);
    try {
      templateText = await readFile(candidate, 'utf8');
      templatePath = candidate;
    } catch {
      templateWarning = `tier template not found at ${candidate}; wrote a placeholder body instead`;
    }
  } else {
    templateWarning = 'no role template directory is configured; wrote a placeholder body instead';
  }

  const prompt = composeRolePrompt({ roleName: name, tier: tierNumber, description, templateText });
  const agentJson = {
    displayName: name,
    description: description || `${name}（第 ${tierNumber} 层）`,
    tier: tierNumber,
  };

  const planned = [
    { path: rolePath, kind: 'directory' },
    ...ROLE_FOLDERS.map(folder => ({ path: join(rolePath, folder), kind: 'directory' })),
    { path: join(rolePath, 'Agent.md'), kind: 'file', bytes: Buffer.byteLength(prompt, 'utf8') },
    { path: join(rolePath, 'agent.json'), kind: 'file', bytes: Buffer.byteLength(`${JSON.stringify(agentJson, null, 2)}\n`, 'utf8') },
  ];

  if (dryRun) {
    return { rolePath, roleName: name, tier: tierNumber, dryRun: true, planned, templatePath, templateWarning };
  }

  await mkdir(rolePath, { recursive: true });
  for (const folder of ROLE_FOLDERS) await mkdir(join(rolePath, folder), { recursive: true });
  await writeFile(join(rolePath, 'Agent.md'), prompt, 'utf8');
  await writeFile(join(rolePath, 'agent.json'), `${JSON.stringify(agentJson, null, 2)}\n`, 'utf8');

  return {
    rolePath,
    roleName: name,
    tier: tierNumber,
    dryRun: false,
    planned,
    templatePath,
    templateWarning,
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    marker: basename(join(rolePath, 'Agent.md')),
  };
}
