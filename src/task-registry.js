/**
 * Task participation registry, daily logs and per-task context memory.
 *
 * Every expert keeps its own records under its role folder, so an expert's history is
 * readable without the plugin and survives any reinstall:
 *
 *   <role>\log\<YYYY>\<MM>\<DD>\<task>.md      daily log (date first, task as a file)
 *   <role>\log\_tasks\<task>\task.json         task registration (tier, parent, session,
 *                                              deliverable, acceptance)
 *   <role>\log\_tasks\<task>\context.md        this expert's context memory for that task
 *
 * The two shapes coexist because they answer different questions: the dated log answers
 * "what happened on this day", the task folder answers "what is this expert's standing in
 * this task". `_tasks` is underscore-prefixed so it can never be mistaken for a year folder.
 *
 * Everything here is plain Node so it is testable without the harness.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Sections every daily log must carry; the last one is the iteration input. */
export const DAILY_LOG_SECTIONS = ['交付物', '完成效果', '可反哺 skills / 知识库的优化项'];

/** Fold a task name into something a path can hold, on every platform. */
export function safeTaskName(name) {
  const value = String(name ?? '').trim();
  if (value.length === 0) throw new Error('task name must not be empty');
  return value
    .replace(/[\\/:*?"<>|]/gu, '-')
    .replace(/\s+/gu, ' ')
    .replace(/[. ]+$/gu, '')
    .slice(0, 80);
}

/** Zero-padded date parts for the dated log folders. */
export function dateParts(date = new Date()) {
  const iso = date.toISOString();
  return { year: iso.slice(0, 4), month: iso.slice(5, 7), day: iso.slice(8, 10), iso };
}

/**
 * Every path one expert needs for one task.
 * @param roleDir - the expert's role folder (absolute).
 * @param taskName - human task name; the folder/file uses its safe form.
 * @param date - the day the log belongs to.
 */
export function taskPaths(roleDir, taskName, date = new Date()) {
  const safe = safeTaskName(taskName);
  const { year, month, day, iso } = dateParts(date);
  const logRoot = join(roleDir, 'log');
  const taskDir = join(logRoot, '_tasks', safe);
  return {
    taskName: safe,
    created: iso,
    logRoot,
    dailyDir: join(logRoot, year, month, day),
    dailyLog: join(logRoot, year, month, day, `${safe}.md`),
    taskDir,
    taskFile: join(taskDir, 'task.json'),
    contextFile: join(taskDir, 'context.md'),
  };
}

/** The daily log skeleton: written once, then only appended to. */
export function dailyLogSkeleton({ expertName, taskName, tier, date = new Date(), parentTaskId, taskId }) {
  const { iso } = dateParts(date);
  return [
    `# ${taskName}（${expertName} · 第 ${tier} 层）`,
    '',
    `- 日期：${iso.slice(0, 10)}`,
    `- 任务 id：${taskId ?? '（待登记）'}`,
    `- 上级任务：${parentTaskId ?? '（无，本任务为根）'}`,
    '',
    '## 交付物',
    '',
    '（待补：交付了什么，路径与形态）',
    '',
    '## 完成效果',
    '',
    '（待补：完成到什么程度、是否通过上级验收、遗留什么）',
    '',
    '## 可反哺 skills / 知识库的优化项',
    '',
    '- [ ] （待补：这次经验里哪一条应当写回本专家的 .skills 或 markdown 知识库）',
    '',
    '## 变更记录',
    '',
    `- ${iso} 创建任务记录（插件写入）`,
    '',
  ].join('\n');
}

/** Context memory file skeleton: one per (expert, task). */
export function contextSkeleton({ expertName, taskName, tier }) {
  return [
    `# 上下文记忆：${expertName} 在「${taskName}」中的第 ${tier} 层`,
    '',
    '> 本文件由插件建骨架、由该专家在任务过程中补充。',
    '> 用途：下一次这位专家被派活或用户进入它的常驻页时，**按任务筛选、取最近 3 条**注入它的上下文。',
    '',
    '## 记忆条目',
    '',
  ].join('\n');
}

/** One memory entry appended to the context file. */
export function memoryEntry({ at = new Date(), actor = 'plugin', text }) {
  const { iso } = dateParts(at);
  const body = String(text ?? '').trim() || '（占位：待补充）';
  return `### ${iso}　[${actor}]\n\n${body}\n`;
}

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Create the daily log, or append a change line when it already exists.
 * @returns the daily log path.
 */
export async function writeDailyLog(options) {
  const paths = taskPaths(options.roleDir, options.taskName, options.date);
  await mkdir(paths.dailyDir, { recursive: true });
  const existing = await readIfExists(paths.dailyLog);
  if (existing === undefined) {
    await writeFile(paths.dailyLog, dailyLogSkeleton(options), 'utf8');
    return paths.dailyLog;
  }
  const line = `- ${dateParts(options.date ?? new Date()).iso} ${options.note ?? '更新任务记录'}（插件写入）\n`;
  await writeFile(paths.dailyLog, `${existing.replace(/\s+$/u, '')}\n${line}`, 'utf8');
  return paths.dailyLog;
}

/**
 * Create or update the task registration.
 *
 * `taskId` comes from the upstream task board; the fields the upstream board does not carry
 * (tier, parentTaskId, sessionId, deliverable, acceptance) are held here, keyed by that id,
 * so the upstream task structure is never modified.
 */
export async function writeTaskRegistration(options) {
  const paths = taskPaths(options.roleDir, options.taskName, options.date);
  await mkdir(paths.taskDir, { recursive: true });
  const existingText = await readIfExists(paths.taskFile);
  const existing = existingText === undefined ? undefined : JSON.parse(existingText);
  const now = dateParts().iso;
  const next = {
    version: 1,
    taskName: paths.taskName,
    taskId: options.taskId ?? existing?.taskId ?? null,
    title: options.title ?? existing?.title ?? paths.taskName,
    expertName: options.expertName ?? existing?.expertName,
    // A later write (a delivery note, an acceptance) must never erase the tier this expert
    // holds in the task, so a missing value falls back to what is already recorded.
    tier: options.tier ?? existing?.tier ?? null,
    parentTaskId: options.parentTaskId ?? existing?.parentTaskId ?? null,
    sessionId: options.sessionId ?? existing?.sessionId ?? null,
    deliverable: options.deliverable ?? existing?.deliverable ?? null,
    acceptance: existing?.acceptance ?? { status: 'pending', by: null, note: null, at: null },
    // The upstream team-board task this expert's side table mirrors (Q6: reuse `team_task_*`
    // for "who is doing what", and keep 交付物/验收 here). The revision is needed for the
    // board's compare-and-set transitions.
    //
    // `undefined` means "leave what is recorded"; an explicit value — including `null` —
    // overwrites. `?? existing` made a stale revision permanently unhealable, which is how a
    // board transitioned elsewhere left every later CAS stale with no way back.
    upstreamTaskId: options.upstreamTaskId !== undefined ? options.upstreamTaskId : (existing?.upstreamTaskId ?? null),
    upstreamRevision: options.upstreamRevision !== undefined ? options.upstreamRevision : (existing?.upstreamRevision ?? null),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await writeFile(paths.taskFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { path: paths.taskFile, record: next };
}

/** Create the context memory file if absent, then append one entry. */
export async function appendContextMemory(options) {
  const paths = taskPaths(options.roleDir, options.taskName, options.date);
  await mkdir(paths.taskDir, { recursive: true });
  const existing = await readIfExists(paths.contextFile);
  const head = existing ?? contextSkeleton(options);
  await writeFile(paths.contextFile, `${head.replace(/\s+$/u, '')}\n\n${memoryEntry(options)}\n`, 'utf8');
  return paths.contextFile;
}

/**
 * The most recent memory entries for one (expert, task) pair — the injection source.
 * Entries are `### <iso>　[actor]` blocks, so they are split on that heading.
 */
export async function readRecentMemories(roleDir, taskName, limit = 3) {
  const paths = taskPaths(roleDir, taskName);
  const text = await readIfExists(paths.contextFile);
  if (text === undefined) return [];
  const parts = text.split(/\n(?=### )/u).filter(part => part.startsWith('### '));
  return parts.slice(-Math.max(0, limit)).map(part => part.trim());
}

/** Every task this expert is registered in, newest first — the observer room's per-expert view. */
export async function listExpertTasks(roleDir) {
  const tasksRoot = join(roleDir, 'log', '_tasks');
  let names = [];
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(tasksRoot, { withFileTypes: true });
    names = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(await readFile(join(tasksRoot, name, 'task.json'), 'utf8')));
    } catch {
      /* a half-written registration is skipped rather than failing the whole listing */
    }
  }
  return out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}
