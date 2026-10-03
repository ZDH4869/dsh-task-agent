/**
 * Offline self-check for the task-agent kit's pure modules.
 *
 * Run:  node --test D:\DSH_desktop\dsh-ext\task-agent-kit\test
 *
 * No Cordis runtime is involved: the scanner and the preset composer are pure, so
 * this test is the "one runnable check" that must fail if their logic breaks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  presetIdForRole,
  parseMcpConfigText,
  scanSourceRoot,
  scanRole,
} from '../src/source-agent-registry.js';
import { composeRolePreset, summarizeRolePreset } from '../src/role-preset.js';

test('presetIdForRole is filesystem-safe for CJK and ASCII role names', () => {
  assert.equal(presetIdForRole('Backend Dev'), 'taskagent-backend-dev');
  const cjk = presetIdForRole('编程开发');
  assert.match(cjk, /^taskagent-role-[0-9a-f]{8}$/u);
  assert.equal(cjk, presetIdForRole('编程开发'), 'must be stable across calls');
  assert.notEqual(cjk, presetIdForRole('前端开发'), 'different CJK names must not collide');
});

test('parseMcpConfigText accepts MCP JSON with servers and a bare map', () => {
  const wrapped = parseMcpConfigText(JSON.stringify({ mcpServers: { ponytail: { command: 'node', args: ['i.js'] } } }), 'json');
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].serverName, 'ponytail');
  assert.equal(wrapped[0].transport, 'stdio');

  const bare = parseMcpConfigText(JSON.stringify({ web: { url: 'http://localhost:3000/mcp' } }), 'json');
  assert.equal(bare[0].transport, 'streamable-http', 'a url implies streamable-http');
});

test('parseMcpConfigText accepts the supported YAML subset', () => {
  const yaml = [
    'mcpServers:',
    '  ponytail:',
    '    transport: stdio',
    '    command: node',
    '    args:',
    '      - index.js',
  ].join('\n');
  const servers = parseMcpConfigText(yaml, 'yaml');
  assert.equal(servers.length, 1);
  assert.equal(servers[0].serverName, 'ponytail');
  assert.equal(servers[0].command, 'node');
  assert.deepEqual(servers[0].args, ['index.js']);
});

test('scanSourceRoot treats each marked first-level folder as a role and skips the rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-agent-kit-'));
  try {
    await mkdir(join(root, 'Backend Dev'), { recursive: true });
    await writeFile(join(root, 'Backend Dev', 'Agent.md'), '# Backend Dev\n\nOwns the API surface.\n', 'utf8');
    await mkdir(join(root, 'Backend Dev', '.skills', 'demo'), { recursive: true });
    await writeFile(join(root, 'Backend Dev', '.skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n', 'utf8');
    await writeFile(join(root, 'Backend Dev', 'mcp.json'), JSON.stringify({ mcpServers: { demo: { command: 'node' } } }), 'utf8');
    await mkdir(join(root, '编程开发', 'nested'), { recursive: true });
    await writeFile(join(root, '编程开发', 'Agent.md'), '# 编程开发\n', 'utf8');
    await mkdir(join(root, '.hidden'), { recursive: true });
    await writeFile(join(root, 'README.md'), 'not a role', 'utf8');
    // Resource folders of a role: no role marker, so they must never be offered.
    for (const name of ['log', 'markdown', 'open_project']) {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, 'note.md'), 'resource', 'utf8');
    }

    const { roles, skipped } = await scanSourceRoot(root);
    const ids = roles.map(role => role.roleId).sort();
    assert.deepEqual(ids, ['Backend Dev', '编程开发'], 'only marked folders are roles');
    const skippedNames = skipped.map(entry => entry.path.split(/[\\/]/u).pop()).sort();
    assert.deepEqual(skippedNames, ['log', 'markdown', 'open_project'], 'resource folders are reported as skipped');

    const backend = roles.find(role => role.roleId === 'Backend Dev');
    assert.equal(backend.skillsDir, join(root, 'Backend Dev', '.skills'));
    assert.equal(backend.mcpServers.length, 1, `mcpServers=${JSON.stringify(backend.mcpServers)}`);
    assert.equal(backend.description, 'Backend Dev');
    assert.deepEqual(backend.diagnostics, []);

    const cjk = roles.find(role => role.roleId === '编程开发');
    assert.match(cjk.presetId, /^taskagent-role-[0-9a-f]{8}$/u, 'CJK role still gets a stable preset id');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanSourceRoot honours agent.json as a role marker without a prompt file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-agent-kit-'));
  try {
    await mkdir(join(root, 'Data Ops'), { recursive: true });
    await writeFile(join(root, 'Data Ops', 'agent.json'), JSON.stringify({ displayName: '数据运维', description: 'owns pipelines' }), 'utf8');
    const { roles, skipped } = await scanSourceRoot(root);
    assert.deepEqual(roles.map(role => role.roleId), ['Data Ops']);
    assert.equal(roles[0].displayName, '数据运维');
    assert.equal(skipped.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanRole reports a missing role prompt instead of throwing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-agent-kit-'));
  try {
    await mkdir(join(root, 'NoPrompt'), { recursive: true });
    const role = await scanRole(join(root, 'NoPrompt'));
    assert.equal(role.promptPath, undefined);
    assert.match(role.diagnostics.join(' '), /missing role prompt/u);
    assert.equal(role.promptBytes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('composeRolePreset clones the base and injects the role rows', () => {
  const basePlugins = [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'base persona', suffix: 'cwd is {{cwd}}' } },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent' } },
  ];
  const role = {
    roleId: 'Backend Dev',
    presetId: 'taskagent-backend-dev',
    skillsDir: 'C:\\agents\\Backend Dev\\.skills',
    mcpServers: [{ serverName: 'demo', transport: 'stdio', command: 'node' }],
    agentOptions: { model: 'deepseek-flash' },
  };
  const result = composeRolePreset(basePlugins, role, 'You are the backend role.');

  assert.notEqual(result.plugins, basePlugins, 'must not mutate the caller list');
  assert.equal(basePlugins[0].config.prefix, 'base persona', 'base list must stay untouched');

  const persona = result.plugins.find(row => row.name === '@deepseek-ai/dsh-persona');
  assert.equal(persona.config.prefix, 'You are the backend role.');
  assert.equal(persona.config.suffix, 'cwd is {{cwd}}', 'unrelated persona fields survive');

  const skills = result.plugins.find(row => row.name === '@deepseek-ai/dsh-skill-filesystem');
  assert.deepEqual(skills.config.customSkillDirs, ['C:\\agents\\Backend Dev\\.skills']);

  const mcp = result.plugins.filter(row => row.name === '@deepseek-ai/dsh-mcp-client');
  assert.equal(mcp.length, 1);
  assert.equal(mcp[0].config.serverName, 'demo');

  const subagent = result.plugins.find(row => row.name === '@deepseek-ai/dsh-tool-subagent');
  assert.equal(subagent.config.agentOptions.model, 'deepseek-flash');
  assert.equal(subagent.config.toolName, 'subagent', 'unrelated row config survives');

  assert.equal(result.plugins.filter(row => row.name === '@deepseek-ai/dsh-tool-fs').length, 1, 'no tool row duplication');

  const summary = summarizeRolePreset(basePlugins, result);
  assert.equal(summary.baseRows, 4);
  assert.equal(summary.totalRows, 5, 'base 4 rows kept + one appended MCP row');
  assert.equal(summary.personaRows, 1);
  assert.equal(summary.mcpRows, 1);
});

test('composeRolePreset appends multiple skill roots instead of replacing them', () => {
  const basePlugins = [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'p' } },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: { customSkillDirs: ['C:\\shared'] } },
  ];
  const result = composeRolePreset(basePlugins, { roleId: 'R', skillsDir: 'C:\\r\\skills', mcpServers: [] }, 'x');
  const skills = result.plugins.find(row => row.name === '@deepseek-ai/dsh-skill-filesystem');
  assert.deepEqual(skills.config.customSkillDirs, ['C:\\shared', 'C:\\r\\skills']);
});

test('composeRolePreset adds one MCP row per declared server and none otherwise', () => {
  const basePlugins = [{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }];
  const withServers = composeRolePreset(
    basePlugins,
    { roleId: 'R', mcpServers: [{ serverName: 'a', transport: 'stdio', command: 'x' }, { serverName: 'b', transport: 'stdio', command: 'y' }] },
    'p',
  );
  assert.equal(withServers.plugins.filter(row => row.name === '@deepseek-ai/dsh-mcp-client').length, 2);

  const withoutServers = composeRolePreset(basePlugins, { roleId: 'R', mcpServers: [] }, 'p');
  assert.equal(withoutServers.plugins.filter(row => row.name === '@deepseek-ai/dsh-mcp-client').length, 0);
});

test('composeRolePreset inserts a persona row when the base has none', () => {
  const basePlugins = [{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }];
  const result = composeRolePreset(basePlugins, { roleId: 'R', mcpServers: [] }, 'role text');
  assert.equal(result.plugins[0].name, '@deepseek-ai/dsh-persona');
  assert.equal(result.plugins[0].config.prefix, 'role text');
  assert.match(result.warnings.join(' '), /no persona row/u);
});

test('composeRolePreset refuses an empty base', () => {
  assert.throws(() => composeRolePreset([], { roleId: 'R', mcpServers: [] }, 'x'), /no plugins to clone/u);
});
