#!/usr/bin/env node
/**
 * Rewrite the machine-owned inventory block in every agent's `Agent.md`.
 *
 * Why a generator: the user requires that a resource deployed once (into a role folder or
 * into the shared `common_project` tree) shows up in EVERY agent's document, including
 * agents created later. Keeping seven-plus hand-written inventories in sync is exactly the
 * kind of bookkeeping that silently rots, so the inventory lives between two markers and is
 * regenerated from what is actually on disk.
 *
 * Safety contract:
 *   - the block is delimited by markers; only that region is ever replaced;
 *   - when the markers are absent the block is APPENDED, so a hand-written Agent.md keeps
 *     its body untouched;
 *   - the previous contents are copied to `.state/agent-doc-backups/` before the first
 *     write of each run.
 *
 * Usage: node tools/sync-agent-docs.mjs [agentsRoot] [sharedRoot]
 */

import { readdir, readFile, writeFile, stat, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const ROOT = process.argv[2] ?? 'D:\\DSH_desktop\\Agents';
const SHARED = process.argv[3] ?? 'D:\\DSH_desktop\\common_project';
const BACKUP = join(HERE, '.state', 'agent-doc-backups');
const START = '<!-- task-agent-kit:inventory:start -->';
const END = '<!-- task-agent-kit:inventory:end -->';
const MARKERS = ['Agent.md', 'AGENTS.md', 'CLAUDE.md', 'agent.json'];

const listDirs = async dir => {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch {
    return [];
  }
};
const exists = async path => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};
const skillsIn = async dir => {
  const out = [];
  for (const name of await listDirs(dir)) if (await exists(join(dir, name, 'SKILL.md'))) out.push(name);
  return out.sort();
};
const filesIn = async dir => {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name).sort();
  } catch {
    return [];
  }
};
const mcpServers = async file => {
  try {
    return Object.keys(JSON.parse(await readFile(file, 'utf8'))?.mcpServers ?? {}).sort();
  } catch {
    return [];
  }
};
const bullets = (items, empty = '（暂无）') => (items.length === 0 ? empty : items.map(x => `- \`${x}\``).join('\n'));

/** One line describing what a role is for: its metadata first, then its own prompt. */
async function purposeOf(dir, name) {
  try {
    const meta = JSON.parse(await readFile(join(dir, 'agent.json'), 'utf8'));
    if (typeof meta?.description === 'string' && meta.description.length > 0) return meta.description;
  } catch {
    /* no metadata file: fall through to the prompt */
  }
  try {
    const text = await readFile(join(dir, 'Agent.md'), 'utf8');
    const line = text.split(/\r?\n/u).find(l => l.trim().startsWith('我是'));
    if (line !== undefined) {
      const cleaned = line.replace(/^[^我]*我是/u, '').replace(/^[「『]/u, '').split(/[」』]/u)[0].trim();
      if (cleaned.length > 0 && cleaned.length < 120) return cleaned;
    }
  } catch {
    /* no prompt to read */
  }
  return `「${name}」角色（描述待补：请在 agent.json 的 description 里写明用途）`;
}

const sharedSkills = await skillsIn(join(SHARED, '.skills'));
const sharedServers = await mcpServers(join(SHARED, '.mcp', 'mcp.json'));
const sharedMcpProjects = await listDirs(join(SHARED, 'open_project', 'mcp'));
const sharedApps = await listDirs(join(SHARED, 'open_project', 'project'));

await mkdir(BACKUP, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const report = [];

for (const name of await listDirs(ROOT)) {
  const dir = join(ROOT, name);
  const promptFile = ['Agent.md', 'AGENTS.md', 'CLAUDE.md'].map(f => join(dir, f));
  let marker;
  for (const candidate of promptFile) if (await exists(candidate)) marker = candidate;
  if (marker === undefined) {
    const hasMeta = await exists(join(dir, 'agent.json'));
    if (!hasMeta) continue; // not a role folder (for example `_templates`)
  }
  const target = marker ?? join(dir, 'Agent.md');

  const ownSkills = await skillsIn(join(dir, '.skills'));
  const ownServers = await mcpServers(join(dir, '.mcp', 'mcp.json'));
  const ownMcpProjects = await listDirs(join(dir, 'open_project', 'mcp'));
  const ownApps = await listDirs(join(dir, 'open_project', 'project'));
  const imported = await listDirs(join(dir, 'markdown', 'imported'));
  const knowledge = await filesIn(join(dir, 'markdown'));
  const purpose = await purposeOf(dir, name);

  const block = [
    START,
    `## 资源清单（机器生成，请勿手改本段；改动会被 sync-agent-docs 覆盖）`,
    '',
    `> 生成时间：${new Date().toISOString()}　生成器：\`dsh-ext\\task-agent-kit\\tools\\sync-agent-docs.mjs\``,
    '',
    '### 这个 agent 是做什么的',
    '',
    purpose,
    '',
    `### 技能 skills`,
    '',
    `**本角色专属**（\`${join(dir, '.skills').replace(ROOT, 'Agents')}\`）：`,
    '',
    bullets(ownSkills),
    '',
    `**公共资源**（\`${join(SHARED, '.skills')}\`，所有 agent 共享）：`,
    '',
    bullets(sharedSkills),
    '',
    '> 只有 `.skills\\<技能名>\\SKILL.md` 会出现在会话技能列表；下面 MCP 与项目是按路径使用/启动的资源。',
    '',
    '### MCP',
    '',
    '本角色自定义服务（`.mcp\\mcp.json`）：',
    '',
    bullets(ownServers),
    '',
    '公共 MCP 服务（`common_project\\.mcp\\mcp.json`，所有 agent 共享）：',
    '',
    bullets(sharedServers),
    '',
    '本地 MCP 项目源码：',
    '',
    bullets([...ownMcpProjects.map(x => `本角色 open_project\\mcp\\${x}`), ...sharedMcpProjects.map(x => `公共 common_project\\open_project\\mcp\\${x}`)]),
    '',
    '### 应用项目',
    '',
    '本角色自有（`open_project\\project`）：',
    '',
    bullets(ownApps),
    '',
    '公共应用项目（`common_project\\open_project\\project`，所有 agent 共享）：',
    '',
    bullets(sharedApps),
    '',
    '### 导入的资料',
    '',
    '`markdown\\imported`：',
    '',
    bullets(imported),
    '',
    '`markdown` 根下的文件：',
    '',
    bullets(knowledge),
    '',
    '### 日志保存位置',
    '',
    `- 本角色日志：\`${join(dir, 'log')}\\YYYY-MM-DD-任务简称.md\``,
    '- 必填五类字段：任务说明 / 交付物与文件变更 / 验证证据 / 遗留未决 / 起止时间。',
    '',
    '### DSH 插件（源码统一放在 `D:\\DSH_desktop\\dsh_plugin`）',
    '',
    '- `dsh-ego-browser` 0.8.3 —— 结构化浏览器自动化（30+ `ego_*` 工具）+ 实时观看面板。**已安装启用。**',
    '- `dsh-approval-gate` 0.5.2 —— 自动审批门控（安全自动批准、危险转人工）。**已安装启用。**',
    '',
    '### 公共资源约定',
    '',
    `- 公共资源根：\`${SHARED}\`（\`.skills\` / \`.mcp\` / \`open_project\\mcp\` / \`open_project\\project\` / \`markdown\`）。`,
    '- 每个角色预设都会自动挂载公共 `.skills` 与公共 MCP，**无需在本文件里逐个声明**。',
    '- **新增公共资源后必须运行一次生成器**，本段才会同步：',
    '  `node "D:\\DSH_desktop\\dsh-ext\\task-agent-kit\\tools\\sync-agent-docs.mjs"`',
    END,
  ].join('\n');

  let text = '';
  try {
    text = await readFile(target, 'utf8');
  } catch {
    text = `# ${name}\n`;
  }
  await copyFile(target, join(BACKUP, `${name}-${stamp}.md`)).catch(() => {});

  const start = text.indexOf(START);
  const end = text.indexOf(END);
  let next;
  if (start !== -1 && end !== -1 && end > start) {
    next = text.slice(0, start) + block + text.slice(end + END.length);
  } else {
    next = `${text.replace(/\s+$/u, '')}\n\n---\n\n${block}\n`;
  }
  await writeFile(target, next, 'utf8');
  report.push({ name, file: target, skills: ownSkills.length, servers: ownServers.length, apps: ownApps.length, replaced: start !== -1 });
}

console.log(`公共资源根: ${SHARED}  (技能 ${sharedSkills.length} / MCP 服务 ${sharedServers.length} / MCP 项目 ${sharedMcpProjects.length} / 应用 ${sharedApps.length})`);
for (const row of report) {
  console.log(`  ${row.name.padEnd(12)} 专属技能=${String(row.skills).padEnd(4)} MCP=${String(row.servers).padEnd(3)} 应用=${String(row.apps).padEnd(3)} ${row.replaced ? '替换标记段' : '追加标记段'}  ${row.file}`);
}
console.log(`共 ${report.length} 个 agent 文档已同步；原文备份在 ${BACKUP}`);
