/**
 * The per-task memory block that gets injected into an expert's prompt.
 *
 * Why a cache instead of reading on demand: `systemPrompt.context({ text })` is SYNCHRONOUS —
 * it runs before every model step and cannot await. So the memories are read here (async, off
 * the assembly path) and the assembly-time lookup is a plain Map get.
 *
 * Scope: one entry per TASK SESSION (`task.json.sessionId`), holding that expert's newest
 * entries for THAT task only — the "按任务筛选" rule. Nothing is injected for a session whose
 * task has no recorded session id, and a session with no memories injects nothing at all.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { readRecentMemories } from './task-registry.js';

/** Hard cap on the injected block, so a chatty task cannot crowd out the real prompt. */
export const MAX_BLOCK_CHARS = 1200;

/** One memory entry, flattened to a single line the model can scan. */
export function compactEntry(entry) {
  return String(entry ?? '')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join(' ｜ ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Render the block injected for one task session, or '' when there is nothing to say. */
export function renderMemoryBlock({ expertName, taskName, tier, entries, maxChars = MAX_BLOCK_CHARS }) {
  const lines = (entries ?? []).map(compactEntry).filter(line => line.length > 0);
  if (lines.length === 0) return '';
  const header = `## 本任务既有记忆（${expertName} · 任务「${taskName}」· 第 ${tier} 层 · 最近 ${lines.length} 条）`;
  const body = lines.map(line => `- ${line}`).join('\n');
  const block = `${header}\n${body}`;
  return block.length <= maxChars ? block : `${block.slice(0, maxChars - 1)}…`;
}

/** Every task folder an expert keeps, newest activity first is not guaranteed here. */
async function taskNames(roleDir) {
  try {
    const entries = await readdir(join(roleDir, 'log', '_tasks'), { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    return [];
  }
}

/**
 * Build the sessionId -> injected block map for the whole roster.
 *
 * @param roster - scan entries carrying `rolePath`, `presetId` and `displayName`.
 * @param options.recent - how many newest entries per task (the agreed default is 3).
 * @returns a Map; sessions without memories or without a recorded id are absent.
 */
export async function buildMemoryCache(roster, { recent = 3, maxChars = MAX_BLOCK_CHARS } = {}) {
  const cache = new Map();
  for (const role of roster ?? []) {
    if (typeof role?.rolePath !== 'string' || role.rolePath.length === 0) continue;
    for (const taskName of await taskNames(role.rolePath)) {
      let task;
      try {
        task = JSON.parse(await readFile(join(role.rolePath, 'log', '_tasks', taskName, 'task.json'), 'utf8'));
      } catch {
        continue; // a half-written registration is skipped, never fatal
      }
      const sessionId = task?.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
      let entries;
      try {
        entries = await readRecentMemories(role.rolePath, taskName, recent);
      } catch {
        entries = [];
      }
      const block = renderMemoryBlock({
        expertName: role.displayName ?? task?.expertName ?? role.roleId ?? '专家',
        taskName,
        tier: task?.tier ?? '?',
        entries,
        maxChars,
      });
      if (block.length > 0) cache.set(sessionId, block);
    }
  }
  return cache;
}
