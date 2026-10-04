/**
 * The Host tools that connect a running task to an expert's own records.
 *
 * These are the only way a delegated agent can write into its expert folder, so each one
 * does exactly one thing and reports the path it touched:
 *
 *   register_task_participation  open the task record (tier, parent task, session)
 *   record_delivery              what was produced, plus the iteration input
 *   record_acceptance            the tier above passes or rejects it
 *   write_context_memory         append one memory entry for this (expert, task)
 *   read_task_context            the newest memories — the injection source
 *
 * Kept free of harness imports so the whole set is testable with a stub context.
 */

import { appendContextMemory, readRecentMemories, writeDailyLog, writeTaskRegistration } from './task-registry.js';

/** One line summary of a task record, used as the tool's rendered answer. */
function describe(record) {
  const acceptance = record.acceptance?.status ?? 'pending';
  return `${record.expertName} · 第 ${record.tier} 层 · 任务「${record.taskName}」`
    + `　上级任务 ${record.parentTaskId ?? '（无）'}　验收 ${acceptance}`;
}

/**
 * @param options.sourcePath - resolves the configured source-agent path at call time.
 * @param options.defineTool - the harness `defineTool` (or the plugin's validating fallback).
 * @param options.getTeamBoard - resolves the upstream `agentTeams` service, or undefined when
 *   this deployment has no Agent Teams packages. Reached lazily so the plugin never hard-depends
 *   on a service it does not inject.
 * @returns an array of tool definitions ready for `ctx.tools.register`.
 */
export function createTaskTools({ sourcePath, defineTool, getTeamBoard }) {
  /**
   * Resolve the caller's board and membership, or the reason it cannot be used.
   *
   * The board is optional by design: without the Agent Teams packages, or when the caller is
   * not a Team member (a plain single-agent conversation), the side table in the expert's own
   * `log\` remains the authoritative record. Any failure is reported, never thrown.
   */
  function boardFor(caller) {
    if (caller === undefined) return { ok: false, note: '调用方不是 Team 成员，未写入上游任务板' };
    let board;
    try {
      board = getTeamBoard?.();
    } catch {
      board = undefined;
    }
    if (board === undefined) return { ok: false, note: '上游 Agent Teams 不可用，未写入任务板' };
    let membership;
    try {
      membership = typeof board.tryMembership === 'function' ? board.tryMembership(caller) : undefined;
    } catch {
      membership = undefined;
    }
    if (membership === undefined) return { ok: false, note: '调用方不在 Team 名单里，未写入任务板' };
    return { ok: true, board, membership };
  }

  /**
   * Is this board task visible to the caller's OWN board?
   *
   * This is the guard that keeps a subordinate honest. The cascade patch makes every member
   * its own Team root, so a teammate's board is NOT the Lead's board: a `createTask` from a
   * teammate lands in the teammate's own log and reuses the same `task-1`-style ids, while the
   * Lead's board never changes. Writing by id without this check is what produced "档案成功、
   * 板子没变" plus a stale-revision error on every later transition.
   */
  function visibleTo(board, caller, id) {
    if (id === null || id === undefined) return false;
    try {
      board.getTask(caller, id);
      return true;
    } catch {
      return false;
    }
  }

  /** Read the side table as it stands, so a registration can be made idempotent. */
  async function readTaskRecord(dir, taskName) {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    try {
      return JSON.parse(await readFile(join(dir, 'log', '_tasks', taskName, 'task.json'), 'utf8'));
    } catch {
      return undefined;
    }
  }

  /**
   * Perform one board transition with a FRESHLY read revision.
   *
   * The side table caches the revision, but any transition made elsewhere (another member, an
   * upstream tool, a retry after a partial failure) invalidates that cache, and a cached value
   * cannot heal itself. Re-reading immediately before the write keeps compare-and-set intact —
   * the window shrinks from "since we last wrote" to "one call" — and recovers from any
   * external change. `plan` receives the fresh view and returns the action fields, or
   * `undefined` to skip the write.
   */
  async function transition(board, caller, id, plan) {
    const current = board.getTask(caller, id);
    const fields = plan(current);
    if (fields === undefined) return { skipped: true, view: current };
    const view = await board.updateTask(caller, {
      taskId: id,
      expectedRevision: current.revision,
      ...fields,
    });
    return { view: view ?? current };
  }

  /** A bare word like "可用" is free text; something path-shaped can be verified. */
  function looksLikePath(value) {
    const text = String(value ?? '').trim();
    if (text.length === 0) return false;
    return /[\\/]/u.test(text) || /\.[A-Za-z0-9]{1,8}$/u.test(text);
  }

  /**
   * Verify a path-shaped deliverable actually exists.
   *
   * `deliverable` is free text, so "QPS 1200" can be typed without anything being produced.
   * Returning the truth here keeps a registered string from being mistaken for a real artefact.
   * @returns the found path, `null` when path-shaped but missing, `undefined` for free text.
   */
  async function findDeliverable(dir, value) {
    if (!looksLikePath(value)) return undefined;
    const { join, isAbsolute } = await import('node:path');
    const { access } = await import('node:fs/promises');
    const raw = String(value).trim();
    const relative = raw.replace(/^[./\\]+/u, '');
    const candidates = [
      isAbsolute(raw) ? raw : undefined,
      join(dir, relative),
      join(sourcePath(), relative),
    ].filter(candidate => typeof candidate === 'string');
    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        /* try the next root */
      }
    }
    return null;
  }

  /** Resolve one expert's folder, refusing anything that would escape the source path. */
  async function expertDir(expertName) {
    const root = sourcePath();
    if (typeof root !== 'string' || root.trim().length === 0) {
      throw new Error('源 agent 路径未配置：请先在「设置 → 模型 → 源 agent 路径」里保存路径。');
    }
    const name = String(expertName ?? '').trim();
    if (name.length === 0) throw new Error('expert_name 不能为空');
    if (/[\\/]/u.test(name) || name === '.' || name === '..') {
      throw new Error(`expert_name 必须是角色文件夹名，不能含路径分隔符：${name}`);
    }
    const { join } = await import('node:path');
    return { root, dir: join(root, name), name };
  }

  const textOut = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  };

  return [
    defineTool({
      name: 'register_task_participation',
      description:
        'Open the record of one expert taking part in one task. Writes the expert\'s task registration '
        + '(the tier it holds, the task it was split from, the session that runs it) and the daily log skeleton. '
        + 'The tier and the parent task are what let the user see this expert\'s place in the task tree.',
      parameters: {
        expert_name: { type: 'string', required: true, description: 'The expert\'s role folder name.' },
        task_name: { type: 'string', required: true, description: 'Human task name; becomes the log file and task folder name.' },
        tier: { type: 'number', required: true, description: 'The tier this expert holds in this task, 1–5.' },
        task_id: { type: 'string', description: 'The upstream task-board id, when there is one.' },
        parent_task_id: { type: 'string', description: 'The task this one was split from; omit for the root task.' },
        session_id: { type: 'string', description: 'The session that executes this task.' },
        upstream_task_id: {
          type: 'string',
          description: 'The team-board task this expert is attached to. The Lead creates board entries and passes this id when assigning work; a teammate that creates board entries of its own only writes into its own Team log.',
        },
      },
      output: textOut,
      execute: async (args, exec) => {
        const { dir, name } = await expertDir(args.expert_name);
        const previous = await readTaskRecord(dir, args.task_name);
        const attached = boardFor(exec?.agent);
        const explicit = typeof args.upstream_task_id === 'string' && args.upstream_task_id.trim().length > 0
          ? args.upstream_task_id.trim()
          : null;
        const prior = typeof previous?.upstreamTaskId === 'string' && previous.upstreamTaskId.length > 0
          ? previous.upstreamTaskId
          : null;

        // Board wiring is IDEMPOTENT and Lead-owned:
        //   - an explicit id, or one already recorded, is adopted (never re-created);
        //   - only the Lead creates a new entry (its board is the shared one);
        //   - a teammate without an id is told to ask the Lead, instead of silently writing
        //     into its own Team log and reporting success.
        let upstreamTaskId = prior;
        let upstreamRevision = previous?.upstreamRevision ?? null;
        let boardNote;
        if (attached.ok === false) {
          boardNote = attached.note;
        } else if (explicit !== null || prior !== null) {
          const id = explicit ?? prior;
          if (visibleTo(attached.board, exec.agent, id)) {
            const view = attached.board.getTask(exec.agent, id);
            upstreamTaskId = String(view.id);
            upstreamRevision = view.revision;
            boardNote = `已挂到任务板条目 ${upstreamTaskId}（当前修订 ${upstreamRevision}）`;
          } else {
            boardNote = `任务板条目 ${id} 不在你的名册里（下级名册与上级隔离），板子由上级维护`;
          }
        } else if (attached.membership.role === 'lead') {
          try {
            const created = await attached.board.createTask(exec.agent, {
              subject: String(args.task_name),
              description: `专家 ${name} 参与（第 ${args.tier} 层）`
                + (args.parent_task_id === undefined ? '' : `；上级任务 ${args.parent_task_id}`),
            });
            // `claim` sets the owner to the CALLER (the Lead) — the request's `owner` field is
            // not read by that action — so the expert's name lives in the description instead.
            const claimed = await transition(attached.board, exec.agent, created.id, () => ({ action: 'claim' }));
            upstreamTaskId = String(created.id);
            upstreamRevision = claimed.view?.revision ?? created.revision;
            boardNote = `已创建并认领 ${upstreamTaskId}（修订 ${upstreamRevision}；板主是 Lead，专家名写在描述里）`;
          } catch (error) {
            boardNote = `任务板写入失败：${String(error?.message ?? error)}`;
          }
        } else {
          boardNote = '下级不新建任务板条目；请上级创建后把 upstream_task_id 传给你';
        }

        const { record } = await writeTaskRegistration({
          roleDir: dir,
          expertName: name,
          taskName: args.task_name,
          tier: args.tier,
          taskId: args.task_id,
          parentTaskId: args.parent_task_id,
          sessionId: args.session_id,
          upstreamTaskId,
          upstreamRevision,
        });
        const log = await writeDailyLog({
          roleDir: dir,
          expertName: name,
          taskName: args.task_name,
          tier: args.tier,
          parentTaskId: args.parent_task_id,
          taskId: args.task_id,
          note: '登记任务参与',
        });
        return `${describe(record)}\n登记：${record.taskName}\\task.json\n日志：${log}`
          + `\n任务板：${boardNote}`;
      },
    }),

    defineTool({
      name: 'record_delivery',
      description:
        'Record what this expert delivers for this task, and the effect. Also appends the delivery to this '
        + 'expert\'s context memory for the task. The tier above still has to accept it (record_acceptance).',
      parameters: {
        expert_name: { type: 'string', required: true, description: 'The expert\'s role folder name.' },
        task_name: { type: 'string', required: true, description: 'The task name used when it was registered.' },
        deliverable: { type: 'string', required: true, description: 'What was produced: paths, artefacts, a short description.' },
        effect: { type: 'string', description: 'How complete it is, and what is left.' },
        feedback_improvements: {
          type: 'string',
          description: 'What from this task should be written back into this expert\'s .skills or markdown knowledge base.',
        },
      },
      output: textOut,
      execute: async (args, exec) => {
        const { dir, name } = await expertDir(args.expert_name);
        const { record } = await writeTaskRegistration({
          roleDir: dir,
          expertName: name,
          taskName: args.task_name,
          deliverable: args.deliverable,
        });
        // A path-shaped deliverable is verified on disk, so a registered string is never
        // mistaken for a produced artefact.
        const found = await findDeliverable(dir, args.deliverable);
        const deliverableNote = found === undefined
          ? ''
          : (found === null
            ? `\n交付物核对：已登记但**未找到实体文件**（${args.deliverable}）`
            : `\n交付物核对：实体文件存在 ${found}`);

        // The delivery itself goes onto the board as an edit — but only when the entry is
        // visible to THIS caller's board (a teammate's board is not the Lead's).
        let boardNote;
        const attached = boardFor(exec?.agent);
        if (attached.ok === false) {
          boardNote = attached.note;
        } else if (record.upstreamTaskId === null || record.upstreamTaskId === undefined) {
          boardNote = '该任务未登记任务板条目，仅写入侧表';
        } else if (!visibleTo(attached.board, exec.agent, record.upstreamTaskId)) {
          boardNote = `任务板条目 ${record.upstreamTaskId} 不在你的名册里，板子由上级维护`;
        } else {
          try {
            const result = await transition(attached.board, exec.agent, record.upstreamTaskId, () => ({
              action: 'edit',
              description: `交付物：${args.deliverable}`
                + (args.effect ? `｜完成效果：${args.effect}` : '')
                + '｜（待上级验收）',
            }));
            // Always write back the revision we just read: that is what heals a side table left
            // behind by a board transition made elsewhere.
            await writeTaskRegistration({
              roleDir: dir,
              expertName: name,
              taskName: args.task_name,
              upstreamRevision: result.view?.revision,
            });
            boardNote = '已更新交付说明';
          } catch (error) {
            boardNote = `任务板写入失败：${String(error?.message ?? error)}`;
          }
        }
        await writeDailyLog({
          roleDir: dir,
          expertName: name,
          taskName: args.task_name,
          tier: record.tier,
          note: `交付：${args.deliverable}`,
        });
        await appendContextMemory({
          roleDir: dir,
          expertName: name,
          taskName: args.task_name,
          tier: record.tier,
          actor: 'agent',
          text: `交付物：${args.deliverable}`
            + (args.effect ? `\n\n完成效果：${args.effect}` : '')
            + (args.feedback_improvements ? `\n\n可反哺 skills / 知识库：${args.feedback_improvements}` : ''),
        });
        return `${describe(record)}\n交付物：${args.deliverable}\n（待上级验收）${deliverableNote}\n任务板：${boardNote}`;
      },
    }),

    defineTool({
      name: 'record_acceptance',
      description:
        'The tier above records whether the delivery passes. A rejection keeps the task open and must carry '
        + 'the reason, so the lower tier can correct it.',
      parameters: {
        expert_name: { type: 'string', required: true, description: 'The expert whose delivery is being judged.' },
        task_name: { type: 'string', required: true, description: 'The task name used when it was registered.' },
        passed: { type: 'boolean', required: true, description: 'true = accepted, false = sent back.' },
        note: { type: 'string', description: 'The acceptance opinion; required when rejecting.' },
        reviewer: { type: 'string', description: 'Who judged it — the reviewing expert or "user".' },
      },
      output: textOut,
      execute: async (args, exec) => {
        const { dir, name } = await expertDir(args.expert_name);
        if (args.passed === false && !String(args.note ?? '').trim()) {
          throw new Error('驳回必须写明理由（note），否则下级无法修正。');
        }
        const { record } = await writeTaskRegistration({
          roleDir: dir,
          expertName: name,
          taskName: args.task_name,
        });
        // 驳回回退 lands here: an accepted delivery CLOSES the board task, a rejected one
        // records the reason AND sends the entry back to an open, unowned state, so the lower
        // tier really can redo it. Only when the entry is visible to THIS caller's board — the
        // acceptance is normally recorded by the upper tier, whose board is the shared one.
        let boardNote;
        const attached = boardFor(exec?.agent);
        if (attached.ok === false) {
          boardNote = attached.note;
        } else if (record.upstreamTaskId === null || record.upstreamTaskId === undefined) {
          boardNote = '该任务未登记任务板条目';
        } else if (!visibleTo(attached.board, exec.agent, record.upstreamTaskId)) {
          boardNote = `任务板条目 ${record.upstreamTaskId} 不在你的名册里，板子由上级维护`;
        } else {
          try {
            // The board only allows `in_progress → completed`, and a task is `pending` until it
            // is claimed (which itself requires its blockers to be done).
            let result;
            if (args.passed) {
              const before = attached.board.getTask(exec.agent, record.upstreamTaskId);
              if (before.status === 'completed') {
                result = { view: before, already: true };
              } else {
                let view = before;
                if (view.status === 'pending') {
                  const claimed = await transition(attached.board, exec.agent, record.upstreamTaskId, () => ({ action: 'claim' }));
                  view = claimed.view;
                }
                const done = await transition(attached.board, exec.agent, record.upstreamTaskId, () => ({ action: 'complete' }));
                result = { view: done.view };
              }
            } else {
              // A rejection must actually send the task back. Leaving a completed entry alone
              // while writing a rejection reason onto it produced a self-contradictory state
              // ("completed + rejected", still owned by the Lead) from which the lower tier
              // could never redo the work:
              //   1. record the reason (`edit` works in any non-deleted state);
              //   2. then return the entry to an open state and clear its owner —
              //      `reopen` from completed, `release` from in_progress.
              const edited = await transition(attached.board, exec.agent, record.upstreamTaskId, () => ({
                action: 'edit',
                description: `验收驳回：${args.note}`,
              }));
              let view = edited.view;
              const status = view?.status;
              const back = status === 'completed' ? 'reopen' : (status === 'in_progress' ? 'release' : undefined);
              if (back !== undefined) {
                const reopened = await transition(attached.board, exec.agent, record.upstreamTaskId, () => ({ action: back }));
                view = reopened.view ?? view;
              }
              result = { view, reopened: back };
            }
            await writeTaskRegistration({
              roleDir: dir,
              expertName: name,
              taskName: args.task_name,
              upstreamRevision: result.view?.revision,
            });
            boardNote = result.already === true
              ? '该条目已是完成态（无需重复）'
              : (args.passed
                ? '已标记完成'
                : `已回写驳回理由并退回待领取（${result.reopened ?? '状态本就开放'}），下级可重做`);
          } catch (error) {
            boardNote = `任务板写入失败：${String(error?.message ?? error)}`;
          }
        }
        // Acceptance is written after the registration so the status is not reset by it.
        const { readFile, writeFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const taskFile = join(dir, 'log', '_tasks', record.taskName, 'task.json');
        const stored = JSON.parse(await readFile(taskFile, 'utf8'));
        stored.acceptance = {
          status: args.passed ? 'passed' : 'rejected',
          by: args.reviewer ?? null,
          note: args.note ?? null,
          at: new Date().toISOString(),
        };
        await writeFile(taskFile, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
        await writeDailyLog({
          roleDir: dir,
          expertName: name,
          taskName: args.task_name,
          tier: stored.tier,
          note: args.passed ? '上级验收通过' : `上级驳回：${args.note}`,
        });
        await appendContextMemory({
          roleDir: dir,
          expertName: name,
          taskName: args.task_name,
          tier: stored.tier,
          actor: args.reviewer ?? 'upper-tier',
          text: args.passed ? '验收通过。' : `验收驳回：${args.note}`,
        });
        return `${describe(stored)}\n验收结果：${args.passed ? '通过' : `驳回（${args.note}）`}\n任务板：${boardNote}`;
      },
    }),

    defineTool({
      name: 'write_context_memory',
      description:
        'Append one entry to this expert\'s context memory for this task. The newest three entries are what get '
        + 'injected the next time this expert works on this task, so keep entries short and decision-oriented.',
      parameters: {
        expert_name: { type: 'string', required: true, description: 'The expert\'s role folder name.' },
        task_name: { type: 'string', required: true, description: 'The task name used when it was registered.' },
        text: { type: 'string', required: true, description: 'The memory: a decision, a constraint, a finding.' },
      },
      output: textOut,
      execute: async args => {
        const { dir, name } = await expertDir(args.expert_name);
        const { record } = await writeTaskRegistration({ roleDir: dir, expertName: name, taskName: args.task_name });
        const path = await appendContextMemory({
          roleDir: dir,
          expertName: name,
          taskName: args.task_name,
          tier: record.tier,
          actor: 'agent',
          text: args.text,
        });
        return `已写入记忆：${path}`;
      },
    }),

    defineTool({
      name: 'read_task_context',
      description:
        'Read the newest context memories this expert holds for this task — the same entries that are injected '
        + 'when it works on the task. Use it before starting work to recover where the task stands.',
      parameters: {
        expert_name: { type: 'string', required: true, description: 'The expert\'s role folder name.' },
        task_name: { type: 'string', required: true, description: 'The task name used when it was registered.' },
        limit: { type: 'number', description: 'How many entries to return; defaults to 3.' },
      },
      output: textOut,
      execute: async args => {
        const { dir } = await expertDir(args.expert_name);
        const memories = await readRecentMemories(dir, args.task_name, args.limit ?? 3);
        if (memories.length === 0) return `「${args.task_name}」暂无记忆条目。`;
        return memories.join('\n\n');
      },
    }),
  ];
}
