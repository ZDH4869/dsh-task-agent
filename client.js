/**
 * Task Agent Kit — Client half.
 *
 * Adds the "Agent 观察室" (Agent Deck):
 *   - a panel entry in the sidebar's global panel icons that opens the deck;
 *   - the deck itself, registered under its own `main` key, so it never shadows the
 *     shipped Conversation panel.
 *
 * The deck lists the role presets the Host half registered (`taskagent-*`) and can
 * start a conversation bound to one of them. Live per-role work status is derived
 * from the session hooks when the owner supplies them, and is shown as "—" when it
 * cannot be known — the deck never invents a state.
 */

window.__ModuleLoader__.load({
  id: 'dsh-task-agent-kit',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const PANEL_KEY = 'agentDeck';
    const ROLE_PREFIX = 'taskagent-';
    const DENSITIES = [3, 4, 5];

    const C = {
      bg: 'var(--dsw-alias-bg-base)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      // Overlay and popover background, for the tier-picker modal surface.
      overlay: 'var(--dsw-alias-bg-overlay)',
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      accent: 'var(--dsw-alias-brand-primary)',
      // Button tokens, copied from the host's own Button.module.css. NEVER fill a button with
      // `brand-primary`: in the dark theme the brand IS near-white (see the boot stylesheet's
      // dark override), so the button rendered as a white slab. The host pairs a dedicated
      // fill token with a dedicated foreground token.
      buttonPrimary: 'var(--dsw-alias-button-primary-fill)',
      buttonPrimaryHover: 'var(--dsw-alias-button-primary-hover)',
      onPrimary: 'var(--dsw-alias-label-primary-foreground)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      border3: 'var(--dsw-alias-border-l3)',
      radiusSm: 'var(--dsw-radius-sm)',
      radiusMd: 'var(--dsw-radius-md)',
      ok: 'var(--dsw-alias-state-success-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    };

    /**
     * Workspace id the shell currently has selected, read from the slot's
     * `useWorkspaces` snapshot selector (a standard prop on both `main` and
     * `shell.overlay`).
     *
     * `SessionCreateRequest.workspaceId` is what binds a new conversation to the project
     * workspace (`dsh-api-session-controller/lib/typert.host.js:2016`), and the shipped
     * flow creates sessions the same way
     * (`dsh-client-ui-workspace/lib/client.js:817`: `sessions.create({ workspaceId })`).
     *
     * The snapshot's exact field names are not part of the inspected surface, so the shape
     * is probed defensively and what was found is reported through the picker's status
     * line instead of failing silently.
     */
    function workspaceIdOf(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return { id: undefined, keys: [] };
      const keys = Object.keys(snapshot);
      for (const key of ['activeWorkspaceId', 'selectedWorkspaceId', 'currentWorkspaceId', 'workspaceId']) {
        const value = snapshot[key];
        if (typeof value === 'string' && value.length > 0) return { id: value, keys, via: key };
      }
      const byId = snapshot.byId ?? snapshot.byWorkspaceId ?? snapshot.workspaces;
      const list = Array.isArray(byId) ? byId : (byId !== null && typeof byId === 'object' ? Object.values(byId) : []);
      const marked = list.find(entry => entry?.active === true || entry?.isActive === true || entry?.selected === true);
      const only = list.length === 1 ? list[0] : undefined;
      for (const entry of [marked, only]) {
        const value = entry?.workspaceId ?? entry?.id;
        if (typeof value === 'string' && value.length > 0) return { id: value, keys };
      }
      return { id: undefined, keys };
    }

    /**
     * The workspace to create a conversation in, mirroring dsh-client-ui-workspace:890:
     * the held session's workspace first, then the most recently touched workspace. The
     * deck replaces the conversation in the main view, so `retainedBy.mainView` is often 0
     * and the recent fallback is the one that actually fires.
     */
    function currentWorkspaceId(workspaces, sessions) {
      const byId = sessions?.byId;
      const sessionList = Array.isArray(byId) ? byId : Object.values(byId ?? {});
      const held = sessionList.find(session => (session?.retainedBy?.mainView ?? 0) > 0);
      const currentId = held?.id ?? held?.sessionId;
      const items = Array.isArray(workspaces?.items) ? workspaces.items : [];
      if (typeof currentId === 'string' && currentId.length > 0) {
        const workspace = items.find(item => (item?.sessionIds ?? []).includes(currentId));
        if (workspace !== undefined) return workspace?.workspaceId ?? workspace?.id;
      }
      // No held session: pick the workspace whose newest session (or createdAt) is latest,
      // the exact `recentWorkspace` rule from dsh-client-ui-workspace.
      let selected;
      let selectedTime = Number.NEGATIVE_INFINITY;
      for (const workspace of items) {
        let latest = Number.NEGATIVE_INFINITY;
        for (const sessionId of workspace.sessionIds ?? []) {
          const session = byId?.[sessionId];
          if (session !== undefined) latest = Math.max(latest, session.updatedAt ?? 0);
        }
        if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt ?? '') || 0;
        if (selected === undefined || latest > selectedTime) {
          selected = workspace.workspaceId;
          selectedTime = latest;
        }
      }
      return selected;
    }

    /**
     * Every Session id the client catalog currently knows, in whatever shape the snapshot
     * exposes. `openSession` throws `sessions.retain: unknown session` for anything outside
     * this set, so a remembered mapping must be checked against it before being trusted.
     */
    function knownSessionIds(sessions) {
      const ids = new Set();
      const byId = sessions?.byId;
      if (byId !== null && typeof byId === 'object' && !Array.isArray(byId)) {
        for (const key of Object.keys(byId)) ids.add(key);
      }
      if (Array.isArray(sessions?.ids)) for (const id of sessions.ids) if (typeof id === 'string') ids.add(id);
      const list = Array.isArray(sessions?.items) ? sessions.items : [];
      for (const item of list) {
        const id = item?.sessionId ?? item?.id;
        if (typeof id === 'string') ids.add(id);
      }
      return ids;
    }

    /**
     * Open a Session, tolerating the brief window in which a just-created id is not yet in
     * the client catalog (the catalog refreshes asynchronously). `openSession` throws before
     * navigating on an unknown id, so retrying cannot leave a half-open page behind.
     */
    async function openWhenKnown(ctx, sessionId, attempts = 6) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          ctx.uiWorkspace.openSession(sessionId);
          return true;
        } catch (error) {
          const message = String(error?.message ?? error);
          if (!/unknown session/u.test(message)) throw error;
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
      return false;
    }

    /**
     * Is a remembered mapping still usable for this expert?
     *
     * Three ways a mapping can be rotten, all seen in practice:
     *   - the Session is a GHOST (gone from the client catalog) → `sessions.retain: unknown`;
     *   - the Session is ARCHIVED → the shell refuses to show it and falls back to the
     *     new-conversation page, which reads as "choose a workspace";
     *   - the Session is bound to a DIFFERENT expert (an earlier reuse gave two experts one
     *     conversation) → it would open someone else's page.
     */
    function mappingUsable(sessions, workspaces, sessionId, presetId) {
      if (!knownSessionIds(sessions).has(sessionId)) return { ok: false, why: '不在会话目录（幽灵映射）' };
      const archived = Array.isArray(workspaces?.archivedSessionIds) ? workspaces.archivedSessionIds : [];
      if (archived.includes(sessionId)) return { ok: false, why: '会话已归档' };
      const byId = sessions?.byId;
      const summary = (byId !== null && typeof byId === 'object' && !Array.isArray(byId))
        ? byId[sessionId]
        : (Array.isArray(sessions?.items)
          ? sessions.items.find(item => (item?.sessionId ?? item?.id) === sessionId)
          : undefined);
      const bound = summary?.projections?.agentPreset ?? summary?.agentPreset;
      if (typeof bound === 'string' && bound.length > 0 && bound !== presetId) {
        return { ok: false, why: `已绑定其它 agent（${bound}）` };
      }
      return { ok: true };
    }

    /**
     * Create one genuinely NEW Session inside a workspace, through the client Session store.
     *
     * `uiWorkspace.connectWorkspace` REUSES a blank Session and exposes no `fresh` argument,
     * so it cannot give two experts a page each. The store's `create({ workspaceId })` is the
     * same call the shell's own `reuseOrCreateBlank` makes when it wants a new Session, and
     * it updates the client store — which is what stops the conversation hero from asking the
     * user to choose a workspace again.
     */
    async function createFreshSession(ctx, workspaceId) {
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) return undefined;
      try {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
        if (sessions === undefined || typeof sessions.create !== 'function') return undefined;
        const raw = await sessions.create({ workspaceId });
        if (typeof raw === 'string') return raw;
        return raw?.sessionId ?? raw?.id ?? raw?.value?.sessionId ?? undefined;
      } catch (error) {
        console.warn('[task-agent-kit] client sessions.create failed', error);
        return undefined;
      }
    }

    /**
     * Unwrap a Client remote answer.
     *
     * Every Client remote replies with a result envelope (`{ ok, value, error }`), not the
     * bare value: shipped code always guards with `if (!result.ok) throw …` before reading
     * `result.value` — see `dsh-client-ui-agent-preset` line 1588 for `agentPresets.list`
     * and `dsh-api-session-controller` line 2744 for `session.create`. Reading the envelope
     * as if it were the value produced an empty role list and a session id that was never a
     * string, so no conversation was ever opened.
     */
    function unwrapRemote(what, result) {
      if (result !== null && typeof result === 'object' && 'ok' in result) {
        if (result.ok !== true) {
          throw new Error(`${what} failed: ${result.error?.message ?? JSON.stringify(result.error ?? null)}`);
        }
        return result.value;
      }
      // A transport that already unwrapped the envelope stays accepted.
      return result;
    }

    // Permanent page map: expert id -> its dedicated session id. It lives in the settings
    // document (`permanentPages`) so it survives restart and is shared across the deck and
    // the conversation header, exactly like the two settings rows do. Like every factory
    // helper here, `ctx` is passed in — it is not a factory-scope variable.
    function configForm(ctx) {
      try {
        const view = ctx.configForms.describe().getSnapshot().view;
        const served = (view?.namespaces ?? []).map(entry => entry?.ns).filter(ns => typeof ns === 'string');
        return ctx.configForms.get(served.find(ns => ns === 'task-agent-kit') ?? served.find(ns => ns.endsWith(':task-agent-kit')) ?? 'task-agent-kit');
      } catch {
        return ctx.configForms.get('task-agent-kit');
      }
    }
    async function readPermanentPages(ctx) {
      try {
        const raw = configForm(ctx).getSnapshot()?.value?.permanentPages;
        return typeof raw === 'string' && raw.length > 0 ? (JSON.parse(raw) ?? {}) : {};
      } catch {
        return {};
      }
    }
    async function writePermanentPages(ctx, map) {
      const accepted = await configForm(ctx).set('permanentPages', JSON.stringify(map ?? {}));
      if (accepted === false) throw new Error('宿主拒绝了常驻页映射写入，请重试。');
    }

    /** presetId -> the expert's own folder, published by the Host half on every scan. */
    async function readExpertFolders(ctx) {
      try {
        const raw = configForm(ctx).getSnapshot()?.value?.expertFolders;
        return typeof raw === 'string' && raw.length > 0 ? (JSON.parse(raw) ?? {}) : {};
      } catch {
        return {};
      }
    }

    /**
     * presetId -> that expert's latest task history, published by the Host half.
     *
     * The Client cannot read the task files, so this is what the observer room's
     * "expert × task × tier × status" view renders.
     */
    async function readExpertTasks(ctx) {
      try {
        const raw = configForm(ctx).getSnapshot()?.value?.expertTasks;
        return typeof raw === 'string' && raw.length > 0 ? (JSON.parse(raw) ?? {}) : {};
      } catch {
        return {};
      }
    }

    /**
     * Ask the Host half to create one expert role.
     *
     * This plugin exposes no `@Remote`, so the request goes through the Settings document and
     * the answer comes back in `roleRequestResult`, matched by `requestId`. Resolves with the
     * Host's answer, or `undefined` when it never answered in time.
     */
    async function requestNewExpert(ctx, spec, timeoutMs = 30000) {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const accepted = await configForm(ctx).set('roleRequest', JSON.stringify({
        requestId,
        name: spec.name,
        description: spec.description,
        parentPath: spec.parentPath ?? '',
        tier: spec.tier,
        mountShared: spec.mountShared,
      }));
      if (accepted === false) throw new Error('宿主拒绝了创建请求');
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 400));
        let result;
        try {
          const raw = configForm(ctx).getSnapshot()?.value?.roleRequestResult;
          result = typeof raw === 'string' && raw.length > 0 ? JSON.parse(raw) : undefined;
        } catch {
          result = undefined;
        }
        if (result !== undefined && result.requestId === requestId) return result;
      }
      return undefined;
    }

    /**
     * The Workspace rooted at one directory, creating it when it does not exist yet.
     *
     * Each expert's own folder IS its workflow's home (that is the whole point of a role
     * folder), so the permanent page belongs in a Workspace over it. `workspace.create` is
     * idempotent ("create or idempotently resolve"), so an existing folder is reused.
     */
    async function ensureWorkspace(ctx, workspaces, path) {
      if (typeof path !== 'string' || path.length === 0) return undefined;
      const items = Array.isArray(workspaces?.items) ? workspaces.items : [];
      const known = items.find(item => item?.path === path);
      if (known !== undefined && typeof known.workspaceId === 'string') return known.workspaceId;
      try {
        const value = unwrapRemote('workspace.create', await ctx.remote.workspace.create({ path }));
        return typeof value?.workspace?.workspaceId === 'string' ? value.workspace.workspaceId : undefined;
      } catch (error) {
        console.warn('[task-agent-kit] workspace.create failed', error);
        return undefined;
      }
    }

    /**
     * Session id the shell currently has selected, from a slot's `useSessions` selector.
     *
     * Binding a role to the session the new-conversation page ALREADY opened is what keeps
     * the chosen workspace: `agentPresets.select(sessionId, presetId)` selects a preset
     * before the session's first turn (`@Remote('select')`; the shipped picker calls it as
     * `select(session.id, staged)`). Creating a fresh session instead loses the workspace,
     * because the workspace snapshot carries no "currently selected" field at all.
     */
    function sessionIdOf(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return { id: undefined, keys: [] };
      const keys = Object.keys(snapshot);
      for (const key of ['currentSessionId', 'currentId', 'activeSessionId', 'selectedSessionId', 'current']) {
        const value = snapshot[key];
        if (typeof value === 'string' && value.length > 0) return { id: value, keys, via: key };
      }
      const byId = snapshot.byId ?? snapshot.sessions;
      const list = Array.isArray(byId) ? byId : (byId !== null && typeof byId === 'object' ? Object.values(byId) : []);
      // The shell has no "current session" field: it takes the session the main view holds
      // (`Object.values(byId).find(s => (s.retainedBy.mainView ?? 0) > 0)?.id`, the idiom in
      // dsh-client-ui-workspace:2720 and dsh-client-ui-session:283). Without this the picker
      // fell back to creating a fresh session, which is what dropped the chosen workspace.
      const held = list.find(entry => (entry?.retainedBy?.mainView ?? 0) > 0);
      // The session's own `cwd` is the authoritative "where this conversation lives": the
      // workspaces snapshot exposes no selected-workspace field to read instead.
      const cwd = typeof held?.cwd === 'string' && held.cwd.length > 0 ? held.cwd : undefined;
      for (const value of [held?.id, held?.sessionId]) {
        if (typeof value === 'string' && value.length > 0) return { id: value, keys, cwd };
      }
      const marked = list.find(entry => entry?.current === true || entry?.active === true || entry?.selected === true);
      for (const entry of [marked, list.length === 1 ? list[0] : undefined]) {
        const value = typeof entry === 'string' ? entry : (entry?.sessionId ?? entry?.id);
        if (typeof value === 'string' && value.length > 0) return { id: value, keys };
      }
      const ids = Array.isArray(snapshot.ids) ? snapshot.ids : [];
      if (ids.length === 1 && typeof ids[0] === 'string') return { id: ids[0], keys };
      return { id: undefined, keys };
    }

    // A stable selector: rebuilding `value => value` on every render made the shell's
    // workspace selector return an unstable snapshot and blanked the deck.
    const identity = value => value;

    /** Read the selected session through a slot's standard `useSessions` prop. */
    function useCurrentSession(props) {
      const hook = props?.useSessions;
      if (typeof hook !== 'function') return { id: undefined, keys: [] };
      try {
        return sessionIdOf(hook(identity));
      } catch {
        return { id: undefined, keys: [] };
      }
    }

    /** Read the selected workspace through a slot's standard `useWorkspaces` prop. */
    function useWorkspace(props) {
      const hook = props?.useWorkspaces;
      if (typeof hook !== 'function') return { id: undefined, keys: [] };
      // A cell's standard props are stable for its lifetime, so the hook call order
      // cannot change between renders; a throwing selector must never blank the deck.
      try {
        return workspaceIdOf(hook(identity));
      } catch {
        return { id: undefined, keys: [] };
      }
    }

    /** Panel content for a keyed `main` cell: the whole deck lives here. */
    function createDeck(ctx) {
      // The panel takes no host hook: the workspace selector produced an unstable snapshot
      // here and blanked the whole cell (a throwing component blanks its slot entry), while
      // the workspace-preserving flow lives in the hero picker, which is where the user is
      // when a workspace is actually being chosen.
      function AgentDeckView(props) {
        const [state, setState] = useState({ phase: 'loading' });
        const [density, setDensity] = useState(3);
        const [page, setPage] = useState(0);
        const [busy, setBusy] = useState('');
        const [onlyActive, setOnlyActive] = useState(false);
        // The "create one expert" form: undefined when closed, otherwise its draft values.
        const [expertForm, setExpertForm] = useState(undefined);
        // Hoisted once per render (stable order), then reused by both the status map and the
        // create path. The current workspace is derived from the held session, mirroring
        // dsh-client-ui-workspace:890 — a permanent page must be born inside a workspace,
        // otherwise the shell prompts for one and drops the preset on the way.
        const sessionsSnapshot = typeof props?.useSessions === 'function' ? props.useSessions(identity) : undefined;
        const workspacesSnapshot = typeof props?.useWorkspaces === 'function' ? props.useWorkspaces(identity) : undefined;
        const workspaceId = currentWorkspaceId(workspacesSnapshot, sessionsSnapshot);

        const refresh = useCallback(async () => {
          setState(current => ({ ...current, phase: current.roster ? 'ready' : 'loading' }));
          try {
            const roster = unwrapRemote('agentPresets.list', await ctx.remote.agentPresets.list());
            const all = Array.isArray(roster?.presets) ? roster.presets : [];
            const roles = all.filter(preset => typeof preset?.id === 'string' && preset.id.startsWith(ROLE_PREFIX));
            // The per-expert task history the Host published: what the history view renders.
            const history = await readExpertTasks(ctx);
            // Keep what the roster actually answered. The shipped preset control lists our
            // role while this panel showed none, so the panel must name the ids it received
            // instead of leaving the mismatch to guesswork.
            setState(current => ({
              ...current,
              phase: 'ready',
              roster: roles,
              history,
              allIds: all.map(preset => String(preset?.id ?? '(no id)')),
              fetchedAt: Date.now(),
            }));
          } catch (error) {
            setState(current => ({ ...current, phase: 'error', message: String(error?.message ?? error) }));
          }
        }, []);

        useEffect(() => {
          void refresh();
        }, [refresh]);

        // Live status is optional: it is only truthful when the session summaries expose
        // their bound preset. The summary's own `running` flag is used rather than a
        // per-session status hook, because a hook cannot be called once per role inside
        // the render loop — doing that threw and blanked the whole panel.
        const statusOf = useMemo(() => {
          const sessions = sessionsSnapshot;
          const byId = sessions?.byId ?? sessions?.items;
          if (byId === undefined || byId === null) return () => undefined;
          return presetId => {
            const ids = Array.isArray(byId) ? byId.map(item => item?.sessionId) : Object.keys(byId);
            for (const id of ids) {
              const summary = Array.isArray(byId) ? byId.find(item => item?.sessionId === id) : byId[id];
              const bound = summary?.projections?.agentPreset ?? summary?.agentPreset;
              if (bound === presetId) return summary?.running === true ? 'working' : 'idle';
            }
            return undefined;
          };
        }, [sessionsSnapshot]);

        const openDeck = useCallback(() => {
          try {
            ctx.layout.selectPanel(PANEL_KEY);
          } catch (error) {
            // Never silent: a failed panel switch used to look like an unresponsive
            // button, which is impossible to diagnose from the outside.
            console.error('[task-agent-kit] selectPanel failed', error);
          }
        }, []);

        const startWithRole = useCallback(async preset => {
          setBusy(preset.id);
          const diag = [];
          try {
            // One expert = one dedicated page (see src/permanent-page.js for the tested
            // spec this mirrors): reuse the remembered session, otherwise create it once,
            // persist the mapping, and open it. Tasks still run in their own sessions via
            // the tier picker's 完成 path.
            const map = await readPermanentPages(ctx);
            const existing = map[preset.id];
            if (typeof existing === 'string' && existing.length > 0) {
              // A mapping can be rotten in three ways (ghost, archived, or bound to another
              // expert) — and every one of them ends with the shell sitting on the
              // new-conversation page, which reads as "choose a workspace". Verify first.
              const usable = mappingUsable(sessionsSnapshot, workspacesSnapshot, existing, preset.id);
              if (usable.ok) {
                ctx.uiWorkspace.openSession(existing);
                setBusy('');
                setState(current => ({ ...current, actionNote: `复用已记住的常驻页 ${existing}` }));
                return;
              }
              diag.push(`丢弃坏映射 ${existing}（${usable.why}）`);
            }
            // A dedicated page must be a FRESH Session inside a workspace. `connectWorkspace`
            // REUSES a blank Session and takes no `fresh` argument, so it cannot give two
            // experts a page each; the client Session store's `create({ workspaceId })` is the
            // call the shell's own `reuseOrCreateBlank` makes for a new Session.
            const sessionsService = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
            // The expert's own folder is its workflow's home, so its permanent page belongs in
            // a Workspace over THAT folder rather than in whatever workspace was last used.
            const folder = (await readExpertFolders(ctx))[preset.id];
            let targetWorkspaceId = workspaceId;
            if (typeof folder === 'string' && folder.length > 0) {
              const own = await ensureWorkspace(ctx, workspacesSnapshot, folder);
              if (typeof own === 'string' && own.length > 0) targetWorkspaceId = own;
              diag.push(`专家工作区=${own ?? '未取到'}(${folder})`);
            }
            diag.push(`ws=${typeof targetWorkspaceId === 'string' && targetWorkspaceId.length > 0 ? targetWorkspaceId : '未解析'}`);
            diag.push(`sessions.create=${sessionsService === undefined ? '无' : typeof sessionsService.create}`);

            let sessionId = await createFreshSession(ctx, targetWorkspaceId);
            diag.push(`存储创建=${sessionId ?? '无'}`);
            if (typeof sessionId !== 'string' || sessionId.length === 0) {
              // The shell's connector: in-workspace, but it may reuse a blank Session.
              if (typeof targetWorkspaceId === 'string' && targetWorkspaceId.length > 0 && typeof ctx.uiWorkspace?.connectWorkspace === 'function') {
                sessionId = await ctx.uiWorkspace.connectWorkspace(targetWorkspaceId);
                diag.push(`连接工作区=${sessionId ?? '无'}`);
              }
            }
            if (typeof sessionId !== 'string' || sessionId.length === 0) {
              // NEVER create a workspace-less Session here: it opens a conversation the shell
              // then asks the user to attach to a workspace, which is the exact loop this
              // whole path exists to avoid. Report instead of creating it.
              setState(current => ({ ...current, actionError: `${preset.name ?? preset.id}: 无法在工作区里新建会话。${diag.join(' · ')}` }));
              setBusy('');
              return;
            }
            // Bind the expert preset to the fresh session (the shipped preset picker's flow),
            // then remember it as this expert's dedicated page.
            try {
              unwrapRemote('agentPresets.select', await ctx.remote.agentPresets.select(sessionId, preset.id));
              diag.push('已绑定 preset');
            } catch (selectError) {
              diag.push(`绑定 preset 失败=${String(selectError?.message ?? selectError)}`);
              console.warn('[task-agent-kit] preset select failed', selectError);
            }
            await writePermanentPages(ctx, { ...map, [preset.id]: sessionId });
            // The client catalog refreshes asynchronously, so a brand-new id can still be
            // "unknown" for a moment; opening retries briefly instead of giving up.
            const opened = await openWhenKnown(ctx, sessionId);
            diag.push(opened ? `已打开 ${sessionId}` : `打开失败 ${sessionId}`);
            setBusy('');
            setState(current => ({
              ...current,
              actionNote: diag.join(' · '),
              actionError: opened ? undefined : `${preset.name ?? preset.id}: 会话已创建但界面无法打开（${diag.join(' · ')}）。`,
            }));
          } catch (error) {
            setBusy('');
            setState(current => ({ ...current, actionError: `${preset.name ?? preset.id}: ${String(error?.message ?? error)}｜${diag.join(' · ')}` }));
          }
        }, [workspaceId]);

        /**
         * Route A finish logic: create one expert folder through the Host, then hand the new
         * preset to `startWithRole`, which opens its own page and remembers it. Route B (bind
         * an existing conversation) reuses the same tail — select the preset, write the map.
         */
        const createExpert = useCallback(async draft => {
          setExpertForm(current => ({ ...(current ?? draft), busy: true, message: undefined }));
          try {
            const name = String(draft.name ?? '').trim();
            const description = String(draft.description ?? '').trim();
            if (name.length === 0) throw new Error('专家名不能为空');
            if (description.length === 0) throw new Error('用途不能为空（它会写进 agent.json.description）');
            const answer = await requestNewExpert(ctx, { ...draft, name, description });
            if (answer === undefined) throw new Error('宿主未在 30 秒内回应；请确认「源 agent 路径」已保存');
            if (answer.status !== 'ok') throw new Error(answer.error ?? '创建失败');
            setExpertForm(undefined);
            await refresh();
            await startWithRole({ id: answer.presetId, name: answer.roleName });
          } catch (error) {
            setExpertForm(current => ({ ...(current ?? draft), busy: false, message: String(error?.message ?? error) }));
          }
        }, [refresh, startWithRole]);

        const roles = state.roster ?? [];
        // The room shows every role by default and can be narrowed to the ones with work
        // in flight. A role whose status cannot be known is never counted as active.
        const shown = onlyActive ? roles.filter(preset => statusOf(preset.id) === 'working') : roles;
        const perPage = density * density;
        const pageCount = Math.max(1, Math.ceil(shown.length / perPage));
        const safePage = Math.min(page, pageCount - 1);
        const visible = shown.slice(safePage * perPage, safePage * perPage + perPage);

        const grid = h('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: `repeat(${density}, minmax(0, 1fr))`,
            gap: 12,
            padding: 16,
            flex: '1 1 auto',
            overflow: 'auto',
            alignContent: 'start',
          },
        }, visible.map(preset => {
          const live = statusOf(preset.id);
          const broken = typeof preset.broken === 'string' && preset.broken.length > 0;
          // History view: what this expert has been asked to do, at which tier, and where each
          // task stands. Published by the Host, because the Client cannot read the task files.
          const history = Array.isArray(state.history?.[preset.id]) ? state.history[preset.id] : [];
          const latest = history[0];
          const statusText = { passed: '已验收', rejected: '已驳回', pending: '待验收' };
          const taskLine = latest === undefined
            ? '暂无任务记录'
            : `${history.length} 个任务 · 最近「${latest.name}」第 ${latest.tier} 层 · ${statusText[latest.status] ?? latest.status}`;
          const badge = broken
            ? { text: '配置错误', color: C.bad }
            : live === 'working'
              ? { text: '工作中', color: C.ok }
              : live === 'idle'
                ? { text: '空闲中', color: C.idle }
                : { text: '可用', color: C.dim };
          return h('button', {
            key: preset.id,
            type: 'button',
            onClick: () => void startWithRole(preset),
            // The tooltip carries the whole history, so a card stays readable at 5×5.
            title: [
              preset.broken ?? preset.description ?? preset.id,
              ...(history.length === 0
                ? ['暂无任务记录']
                : history.map(task => `· ${task.name}（第 ${task.tier} 层 · ${statusText[task.status] ?? task.status}）`
                  + (task.deliverable === null || task.deliverable === undefined ? '' : ` → ${task.deliverable}`))),
            ].join('\n'),
            style: {
              textAlign: 'left',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              minHeight: 96,
              padding: '10px 12px',
              borderRadius: 10,
              border: `1px solid ${C.border}`,
              background: C.layer,
              color: C.text,
              cursor: busy === preset.id ? 'progress' : 'pointer',
              opacity: busy === preset.id ? 0.6 : 1,
            },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
            h('span', { style: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, preset.name ?? preset.id),
            h('span', { style: { fontSize: 11, color: badge.color, border: `1px solid ${badge.color}`, borderRadius: 999, padding: '0 6px', whiteSpace: 'nowrap' } }, badge.text),
          ),
          h('span', { style: { fontSize: 11, color: C.dim, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, preset.description ?? preset.id),
          h('span', { style: { fontSize: 10, color: latest === undefined ? C.dim : C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, taskLine),
          h('span', { style: { fontSize: 10, color: C.dim, fontFamily: 'monospace' } }, preset.id));
        }));

        const header = h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${C.border}` },
        },
        h('span', { style: { fontSize: 14, fontWeight: 600, color: C.text } }, 'Agent 观察室'),
        h('span', { style: { fontSize: 11, color: C.dim } },
          onlyActive ? `工作中 ${shown.length} / 共 ${roles.length} 个角色` : `共 ${roles.length} 个角色`),
        h('span', { style: { fontSize: 10, color: C.dim, fontFamily: 'monospace' } },
          `工作区 ${typeof workspaceId === 'string' && workspaceId.length > 0 ? workspaceId : '（未解析）'}`),
        h('span', { style: { flex: '1 1 auto' } }),
        h('button', {
          type: 'button',
          // A one-click reset for the persistent-page map. Rotten mappings (ghosts, archived
          // Sessions, or one Session claimed by two experts) all show up as "choose a
          // workspace"; clearing them makes the next click build clean pages.
          onClick: async () => {
            try {
              await writePermanentPages(ctx, {});
              setState(current => ({ ...current, actionError: undefined, actionNote: '已清空常驻页映射；下次点击会为每个专家新建专属对话。' }));
            } catch (error) {
              setState(current => ({ ...current, actionError: `清空常驻页映射失败：${String(error?.message ?? error)}` }));
            }
          },
          title: '清空"专家 → 常驻对话"的映射，下次点击重新创建',
          style: {
            fontSize: 11,
            background: 'transparent',
            color: C.text,
            border: `0.5px solid ${C.border3}`,
            borderRadius: C.radiusSm,
            padding: '3px 10px',
            cursor: 'pointer',
          },
        }, '重置常驻页'),
        h('button', {
          type: 'button',
          // Route A: create one expert (folder + preset) and immediately make its own page the
          // conversation you land on. Route B lives beside it and reuses the same tail.
          onClick: () => setExpertForm(current => (current === undefined
            ? { name: '', description: '', parentPath: '', tier: 5, mountShared: true, busy: false, message: undefined }
            : undefined)),
          title: '新建一个专家 agent（独立文件夹 + 立即可用）',
          style: {
            fontSize: 11,
            background: expertForm === undefined ? C.buttonPrimary : 'transparent',
            color: expertForm === undefined ? C.onPrimary : C.text,
            border: `0.5px solid ${expertForm === undefined ? C.buttonPrimary : C.border3}`,
            borderRadius: C.radiusSm,
            padding: '3px 10px',
            cursor: 'pointer',
          },
        }, '＋ 新建专家'),
        h('button', {
          type: 'button',
          'aria-pressed': onlyActive,
          onClick: () => {
            setOnlyActive(current => !current);
            setPage(0);
          },
          title: '只显示有任务在进行的角色',
          style: {
            fontSize: 11,
            background: onlyActive ? C.buttonPrimary : 'transparent',
            color: onlyActive ? C.onPrimary : C.text,
            border: `0.5px solid ${onlyActive ? C.buttonPrimary : C.border3}`,
            borderRadius: C.radiusSm,
            padding: '3px 10px',
            cursor: 'pointer',
          },
        }, onlyActive ? '仅活动 ✓' : '仅活动'),
        h('label', { style: { fontSize: 11, color: C.dim, display: 'flex', alignItems: 'center', gap: 4 } },
          '显示方式',
          h('select', {
            value: String(density),
            onChange: event => {
              setDensity(Number(event.target.value));
              setPage(0);
            },
            style: { background: 'transparent', color: C.text, border: `0.5px solid ${C.border3}`, borderRadius: C.radiusSm, padding: '2px 6px' },
          }, DENSITIES.map(n => h('option', { key: n, value: String(n) }, `${n} × ${n}`)))),
        h('button', {
          type: 'button',
          onClick: () => void refresh(),
          style: { background: 'transparent', color: C.text, border: `0.5px solid ${C.border3}`, borderRadius: C.radiusSm, padding: '3px 10px', cursor: 'pointer' },
        }, '刷新'));

        const footer = h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderTop: `1px solid ${C.border}` },
        },
        h('button', {
          type: 'button',
          disabled: safePage <= 0,
          onClick: () => setPage(current => Math.max(0, current - 1)),
          style: { background: 'transparent', color: C.text, border: `0.5px solid ${C.border3}`, borderRadius: C.radiusSm, padding: '2px 10px', cursor: safePage <= 0 ? 'default' : 'pointer', opacity: safePage <= 0 ? 0.5 : 1 },
        }, '‹'),
        h('span', { style: { fontSize: 11, color: C.dim } }, `第 ${safePage + 1} / ${pageCount} 页`),
        h('button', {
          type: 'button',
          disabled: safePage >= pageCount - 1,
          onClick: () => setPage(current => Math.min(pageCount - 1, current + 1)),
          style: { background: 'transparent', color: C.text, border: `0.5px solid ${C.border3}`, borderRadius: C.radiusSm, padding: '2px 10px', cursor: safePage >= pageCount - 1 ? 'default' : 'pointer', opacity: safePage >= pageCount - 1 ? 0.5 : 1 },
        }, '›'),
        h('span', { style: { flex: '1 1 auto' } }),
        h('span', { style: { fontSize: 10, color: C.dim } }, '点卡片 = 以该角色开会话'));

        const body = state.phase === 'loading'
          ? h('div', { style: { padding: 24, color: C.dim, fontSize: 12 } }, '正在读取角色…')
          : state.phase === 'error'
            ? h('div', { style: { padding: 24, color: C.bad, fontSize: 12 } }, `读取角色失败：${state.message}`)
            : roles.length === 0
              ? h('div', { style: { padding: 24, color: C.dim, fontSize: 12, lineHeight: 1.7 } },
                '还没有可用的角色。',
                h('br'),
                '请在「设置 → 模型」里配置「源 agent 路径」，并确保该路径下至少有一个带 Agent.md 的角色文件夹。',
                h('br'),
                // Name the ids the roster actually answered: without this the panel cannot
                // tell "the registry has no role" apart from "the filter missed its id".
                h('code', { style: { fontSize: 11, wordBreak: 'break-all' } },
                  `宿主名单 ${(state.allIds ?? []).length} 项：${(state.allIds ?? []).join(', ') || '（空）'}`),
                h('br'),
                `期望前缀：${ROLE_PREFIX}`)
              : grid;

        // The "create one expert" form. It posts a request through the Settings document and
        // waits for the Host's answer, so its own busy/message state is shown here.
        const fieldStyle = {
          background: 'transparent',
          color: C.text,
          border: `0.5px solid ${C.border3}`,
          borderRadius: C.radiusSm,
          padding: '4px 8px',
          fontSize: 12,
        };
        const expertFormPanel = expertForm === undefined ? null : h('div', {
          style: {
            margin: '12px 16px 0',
            padding: 12,
            border: `1px solid ${C.border2}`,
            borderRadius: 10,
            background: C.layer,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          },
        },
        h('div', { style: { fontSize: 12, fontWeight: 600, color: C.text } }, '新建专家 agent'),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('input', {
            value: expertForm.name ?? '',
            placeholder: '专家名（必填，如「数据分析」）',
            onChange: event => setExpertForm(current => ({ ...current, name: event.target.value })),
            style: { ...fieldStyle, flex: '1 1 200px' },
          }),
          h('label', { style: { fontSize: 11, color: C.dim, display: 'flex', alignItems: 'center', gap: 4 } },
            '默认层级',
            h('select', {
              value: String(expertForm.tier ?? 5),
              onChange: event => setExpertForm(current => ({ ...current, tier: Number(event.target.value) })),
              style: fieldStyle,
            }, [1, 2, 3, 4, 5].map(n => h('option', { key: n, value: String(n) }, `${n}`)))),
          h('label', { style: { fontSize: 11, color: C.dim, display: 'flex', alignItems: 'center', gap: 4 } },
            h('input', {
              type: 'checkbox',
              checked: expertForm.mountShared !== false,
              onChange: event => setExpertForm(current => ({ ...current, mountShared: event.target.checked })),
            }),
            '挂载公共资源')),
        h('input', {
          value: expertForm.description ?? '',
          placeholder: '用途一句话（必填；写进 agent.json.description，之后可用 agent 修改）',
          onChange: event => setExpertForm(current => ({ ...current, description: event.target.value })),
          style: fieldStyle,
        }),
        // The expert's own folder. Only two spellings are accepted, and the live line says
        // which one is in force so the created location is never a guess.
        h('input', {
          value: expertForm.parentPath ?? '',
          placeholder: '源文件夹路径（可选；如 D:\\DSH_desktop\\Agents\\新agent，必须以专家名结尾）',
          onChange: event => setExpertForm(current => ({ ...current, parentPath: event.target.value })),
          style: fieldStyle,
        }),
        h('div', { style: { fontSize: 10, color: C.dim, wordBreak: 'break-all' } },
          (() => {
            const raw = String(expertForm.parentPath ?? '').trim().replace(/[\\/]+$/u, '');
            const name = String(expertForm.name ?? '').trim();
            if (raw.length === 0) return `将创建于：源 agent 路径\\${name || '<专家名>'}`;
            const tail = raw.split(/[\\/]/u).pop();
            if (name.length > 0 && tail !== name) {
              return `✗ 路径必须以专家名结尾（期望 \\${name}），否则会被拒绝；或清空本字段。`;
            }
            return `将创建于：${raw}（路径已以专家名结尾 → 直接建在这里）`;
          })()),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', {
            type: 'button',
            disabled: expertForm.busy === true,
            onClick: () => void createExpert(expertForm),
            style: {
              background: C.buttonPrimary,
              color: C.onPrimary,
              border: 'none',
              borderRadius: C.radiusSm,
              padding: '4px 14px',
              fontSize: 12,
              cursor: expertForm.busy === true ? 'progress' : 'pointer',
              opacity: expertForm.busy === true ? 0.6 : 1,
            },
          }, expertForm.busy === true ? '创建中…（宿主建文件夹 → 重扫 → 建常驻页）' : '创建并进入它的对话'),
          h('button', {
            type: 'button',
            disabled: expertForm.busy === true,
            onClick: () => setExpertForm(undefined),
            style: { background: 'transparent', color: C.dim, border: 'none', fontSize: 12, cursor: 'pointer' },
          }, '取消'),
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: { fontSize: 11, color: C.dim } },
            '重名会被拒绝；不会覆盖已有角色。'),
          expertForm.message === undefined
            ? null
            : h('span', { style: { fontSize: 11, color: C.bad } }, expertForm.message)));

        return h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            // The frame's window controls (close / maximise) float over the top of every
            // main panel, so the panel must reserve that strip or its header collides.
            paddingTop: 36,
            boxSizing: 'border-box',
            background: C.bg,
            color: C.text,
          },
        },
        header,
        state.actionError === undefined ? null : h('div', { style: { padding: '8px 16px', fontSize: 11, color: C.bad, borderBottom: `1px solid ${C.border}` } }, state.actionError),
        state.actionNote === undefined ? null : h('div', { style: { padding: '6px 16px', fontSize: 10, color: C.dim, fontFamily: 'monospace', borderBottom: `1px solid ${C.border}`, wordBreak: 'break-all' } }, state.actionNote),
        expertFormPanel,
        body,
        footer);
      }

      // A throwing component blanks its slot entry entirely, which is indistinguishable
      // from "the panel did not open". Catching here turns any render failure into a
      // readable card instead of an empty page.
      return function AgentDeck(props) {
        try {
          return AgentDeckView(props);
        } catch (error) {
          return h('div', { style: { padding: 24, color: C.bad, fontSize: 12, lineHeight: 1.7 } },
            '观察室渲染失败：',
            h('code', { style: { wordBreak: 'break-all' } }, String(error?.stack ?? error?.message ?? error)));
        }
      };
    }

    /**
     * Glyph the host draws inside its own sidebar panel row.
     *
     * `sidebar.panellist` receives `{ size, active }` and the host owns the button, its
     * tooltip, its `aria-current`, and the `selectPanel` call — this renders the mark
     * only, so it must not be interactive itself.
     */
    function createDeckEntry() {
      return function AgentDeckGlyph(props) {
        const size = typeof props?.size === 'number' ? props.size : 16;
        const active = props?.active === true;
        return h('span', {
          'aria-hidden': true,
          style: {
            fontSize: size,
            lineHeight: 1,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: active ? C.accent : 'currentColor',
          },
        }, '▦');
      };
    }

    const TIER_LABELS = ['一', '二', '三', '四', '五'];

    /** Shared, tiny store so the hero button and the picker panel stay in sync. */
    function createPlanStore() {
      let state = { open: false, tier: 1, selections: {}, roles: undefined, busy: '', message: undefined, workspaceId: undefined, sessionId: undefined, sessionCwd: undefined, allIds: undefined };
      const listeners = new Set();
      return {
        get: () => state,
        set(patch) {
          state = { ...state, ...patch };
          for (const listener of listeners) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        reset() {
          state = { ...state, tier: 1, selections: {}, message: undefined, busy: '' };
          for (const listener of listeners) listener();
        },
      };
    }

    function useStore(store) {
      const [, bump] = useState(0);
      useEffect(() => store.subscribe(() => bump(value => value + 1)), [store]);
      return store.get();
    }

    /**
     * The "添加任务 agent" control and its 1–5 tier picker.
     *
     * Both halves live in list slots the shell already allocates, under ids of our
     * own, so the shipped hero controls are neither replaced nor shadowed.
     */
    function createPlanFeature(ctx) {
      const store = createPlanStore();

      /** Lowest tier that has a selection becomes the conversation's own agent. */
      function primaryRole(state) {
        for (let tier = 1; tier <= state.tier; tier += 1) {
          const picked = state.selections[tier];
          if (Array.isArray(picked) && picked.length > 0) {
            return (state.roles ?? []).find(role => role.id === picked[0]);
          }
        }
        return undefined;
      }

      async function ensureRoles() {
        const current = store.get();
        if (current.roles !== undefined) return current.roles;
        const roster = unwrapRemote('agentPresets.list', await ctx.remote.agentPresets.list());
        const all = Array.isArray(roster?.presets) ? roster.presets : [];
        const roles = all.filter(preset => typeof preset?.id === 'string' && preset.id.startsWith(ROLE_PREFIX));
        store.set({ roles, allIds: all.map(preset => String(preset?.id ?? '(no id)')) });
        return roles;
      }

      async function complete() {
        const state = store.get();
        const role = primaryRole(state);
        if (role === undefined) {
          store.set({ message: { kind: 'error', text: '请至少勾选一个 agent。' } });
          return;
        }
        store.set({ busy: 'create', message: undefined });
        try {
          // Preferred path: the new-conversation page already opened a blank session for the
          // chosen workspace, so select the role on THAT session. Creating a new one would
          // leave the workspace behind, which is exactly what the user saw happen.
          if (typeof state.sessionId === 'string' && state.sessionId.length > 0) {
            unwrapRemote('agentPresets.select', await ctx.remote.agentPresets.select(state.sessionId, role.id));
            savePlan(state.sessionId, state, role);
            store.set({ busy: '', message: { kind: 'ok', text: `已把「${role.name ?? role.id}」设为该对话的 agent。` } });
            ctx.uiWorkspace.openSession(state.sessionId);
            return;
          }
          const created = unwrapRemote('session.create', await ctx.remote.session.create({
            agentPreset: role.id,
            ...(state.workspaceId === undefined ? {} : { workspaceId: state.workspaceId }),
          }));
          const sessionId = typeof created === 'string' ? created : created?.sessionId;
          savePlan(sessionId, state, role);
          store.set({ busy: '', message: { kind: 'ok', text: `已创建「${role.name ?? role.id}」的任务对话。` } });
          if (typeof sessionId === 'string' && sessionId.length > 0) ctx.uiWorkspace.openSession(sessionId);
        } catch (error) {
          store.set({ busy: '', message: { kind: 'error', text: `创建失败：${String(error?.message ?? error)}` } });
        }
      }

      function AddTaskAgentButton() {
        const state = useStore(store);
        return h('button', {
          type: 'button',
          onClick: async () => {
            const next = !state.open;
            store.set({ open: next });
            if (next) {
              try {
                await ensureRoles();
              } catch (error) {
                store.set({ message: { kind: 'error', text: `读取角色失败：${String(error?.message ?? error)}` } });
              }
            }
          },
          title: '为这个对话配置任务 agent（不配置就是原始对话）',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            background: state.open ? C.layer2 : 'transparent',
            color: C.text,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            cursor: 'pointer',
            fontSize: 12,
            whiteSpace: 'nowrap',
          },
        },
        h('span', { 'aria-hidden': true }, '＋'),
        h('span', null, '添加任务 agent'));
      }

      function TaskAgentPicker(props) {
        const state = useStore(store);
        // `shell.overlay` carries both standard props: the workspace is only a fallback,
        // because the selected session already owns the workspace the user chose.
        const workspace = useWorkspace(props);
        const session = useCurrentSession(props);
        useEffect(() => {
          if (workspace.id !== store.get().workspaceId) store.set({ workspaceId: workspace.id });
        }, [workspace.id]);
        useEffect(() => {
          if (session.id !== store.get().sessionId || session.cwd !== store.get().sessionCwd) {
            store.set({ sessionId: session.id, sessionCwd: session.cwd });
          }
        }, [session.id]);
        // Hooks run before the early return: the picker is mounted for the whole
        // session, it only renders nothing while closed.
        useEffect(() => {
          if (!state.open) return undefined;
          const onKey = event => {
            if (event.key === 'Escape') store.set({ open: false });
          };
          window.addEventListener('keydown', onKey);
          return () => window.removeEventListener('keydown', onKey);
        }, [state.open]);
        if (!state.open) return null;
        const roles = state.roles;

        const tierRows = [];
        for (let tier = 1; tier <= state.tier; tier += 1) {
          const picked = state.selections[tier] ?? [];
          tierRows.push(h('div', { key: `tier-${tier}`, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { fontSize: 12, color: C.text, fontWeight: 600 } },
              `选择${TIER_LABELS[tier - 1]}级 agent`,
              tier === 1
                ? h('span', { style: { marginLeft: 8, fontSize: 10, color: C.dim, fontWeight: 400 } }, '（一级 = 你直接对接的总 Agent）')
                : h('span', { style: { marginLeft: 8, fontSize: 10, color: C.dim, fontWeight: 400 } }, '（未派活的下级不工作）')),
            roles === undefined
              ? h('div', { style: { fontSize: 11, color: C.dim } }, '正在读取角色…')
              : roles.length === 0
                ? h('div', { style: { fontSize: 11, color: C.dim } },
                  '没有可用角色：请在设置里配置「源 agent 路径」，并确保其下有带 Agent.md 的角色文件夹。',
                  h('br'),
                  h('code', { style: { fontSize: 10, wordBreak: 'break-all' } },
                    `宿主名单 ${(state.allIds ?? []).length} 项：${(state.allIds ?? []).join(', ') || '（空）'} · 期望前缀 ${ROLE_PREFIX}`))
                : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 } },
                  roles.map(role => {
                    const on = picked.includes(role.id);
                    return h('button', {
                      key: `${tier}-${role.id}`,
                      type: 'button',
                      onClick: () => {
                        const next = on ? picked.filter(id => id !== role.id) : [...picked, role.id];
                        store.set({ selections: { ...state.selections, [tier]: next }, message: undefined });
                      },
                      title: role.broken ?? role.description ?? role.id,
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        textAlign: 'left',
                        padding: '6px 8px',
                        borderRadius: 8,
                        border: `1px solid ${on ? C.accent : C.border}`,
                        background: on ? C.layer2 : C.layer,
                        color: C.text,
                        cursor: 'pointer',
                        fontSize: 12,
                        overflow: 'hidden',
                      },
                    },
                    h('span', { 'aria-hidden': true, style: { color: on ? C.accent : C.dim } }, on ? '☑' : '☐'),
                    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, role.name ?? role.id));
                  }))));
        }

        // The picker is registered in `shell.overlay` (a frame-wide layer), so it draws
        // as a modal: a token-derived scrim, a centred card, and a click on the scrim or
        // Escape closing it. It cannot live in `conversation.hero.dock`, which only
        // renders while the Conversation has no session at all.
        return h('div', {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: '8vh 16px 16px',
            background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent)',
            // `shell.overlay` is click-through by design ("entries opt back into pointer
            // events"), so the scrim and every control inside must claim them explicitly.
            pointerEvents: 'auto',
          },
          onClick: event => {
            if (event.target === event.currentTarget) store.set({ open: false });
          },
        },
        h('div', {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '添加任务 agent',
          style: {
            width: 'min(960px, 100%)',
            maxHeight: '78vh',
            overflow: 'auto',
            padding: 16,
            border: `1px solid ${C.border2}`,
            borderRadius: 12,
            background: C.overlay,
            color: C.text,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 12, fontWeight: 600, color: C.text } }, '设定 agent 层级'),
          h('select', {
            value: String(state.tier),
            onChange: event => {
              const tier = Number(event.target.value);
              const selections = Object.fromEntries(Object.entries(state.selections).filter(([key]) => Number(key) <= tier));
              store.set({ tier, selections, message: undefined });
            },
            style: { background: 'transparent', color: C.text, border: `0.5px solid ${C.border3}`, borderRadius: C.radiusSm, padding: '2px 6px', fontSize: 12 },
          }, [1, 2, 3, 4, 5].map(n => h('option', { key: n, value: String(n) }, String(n)))),
          h('span', { style: { fontSize: 11, color: C.dim } }, '1–5 层；上级拆解后派发给下级，下级遇疑反向询问上级')),
        ...tierRows,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('button', {
            type: 'button',
            onClick: () => store.reset(),
            style: { background: 'transparent', color: C.text, border: `0.5px solid ${C.border3}`, borderRadius: C.radiusSm, padding: '3px 14px', cursor: 'pointer', fontSize: 12 },
          }, '重置'),
          h('button', {
            type: 'button',
            onClick: () => void complete(),
            style: { background: C.buttonPrimary, color: C.onPrimary, border: 'none', borderRadius: C.radiusSm, padding: '3px 14px', cursor: state.busy === 'create' ? 'progress' : 'pointer', fontSize: 12, opacity: state.busy === 'create' ? 0.6 : 1 },
          }, state.busy === 'create' ? '创建中…' : '完成'),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', {
            type: 'button',
            onClick: () => store.set({ open: false }),
            style: { background: 'transparent', color: C.dim, border: 'none', cursor: 'pointer', fontSize: 12 },
          }, '收起')),
        state.message === undefined
          ? null
          : h('div', { style: { fontSize: 11, color: state.message.kind === 'error' ? C.bad : C.ok } }, state.message.text),
        // Which target 完成 will act on. A missing session means the role cannot be bound to
        // the page the user is on, which is worth seeing before pressing anything.
        h('div', { style: { fontSize: 10, color: C.dim, wordBreak: 'break-all' } },
          `会话 ${state.sessionId ?? '（未取到）'} · 目录 ${state.sessionCwd ?? '（由会话决定）'} · 角色 ${(state.roles ?? []).length}`)));
      }

      const PLAN_KEY_PREFIX = 'task-agent-plan:';

      /** Persist the tier plan so the conversation header can show it later. */
      function savePlan(sessionId, snapshot, role) {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return;
        try {
          const tiers = Object.keys(snapshot.selections ?? {})
            .map(Number)
            .sort((a, b) => a - b)
            .map(tier => ({
              tier,
              agents: (snapshot.selections[tier] ?? [])
                .map(id => (snapshot.roles ?? []).find(entry => entry.id === id)?.name ?? id),
            }));
          const payload = { createdAt: Date.now(), primary: role?.name ?? role?.id, tiers };
          window.localStorage.setItem(`${PLAN_KEY_PREFIX}${sessionId}`, JSON.stringify(payload));
        } catch {
          /* storage is only a cache for this label; losing it must not fail the creation */
        }
      }

      /**
       * Header chip for a configured conversation: hovering it lists every tier and the
       * agent chosen for it, which is the plan the user made in the picker.
       */
      function TaskPlanChip(props) {
        const sessionId = props?.sessionId;
        let plan;
        try {
          plan = typeof sessionId === 'string'
            ? JSON.parse(window.localStorage.getItem(`${PLAN_KEY_PREFIX}${sessionId}`) ?? 'null')
            : undefined;
        } catch {
          plan = undefined;
        }
        if (plan === null || plan === undefined) return null;
        const lines = (plan.tiers ?? []).map(entry => `第 ${entry.tier} 层：${(entry.agents ?? []).join('、') || '（未选）'}`);
        return h('span', {
          title: [`一级 agent（你直接对接）：${plan.primary ?? '—'}`, ...lines].join('\n'),
          style: {
            fontSize: 11,
            color: C.dim,
            border: `1px solid ${C.border}`,
            borderRadius: 999,
            padding: '1px 8px',
            whiteSpace: 'nowrap',
            cursor: 'default',
          },
        }, `任务 agent · ${(plan.tiers ?? []).length} 层`);
      }
      return { AddTaskAgentButton, TaskAgentPicker, TaskPlanChip };
    }

    /**
     * Route B: bind the conversation the user is IN as some expert's permanent page.
     *
     * This is the "incubate an expert by talking to one" path: the architect agent creates the
     * role with `create_task_agent_role`, then the user points this control at it — from then
     * on this very conversation IS that expert's page. It shares the tail of route A: select
     * the preset on the session, then remember the mapping.
     */
    function createExpertPageBinder(ctx) {
      return function ExpertPageBinder(props) {
        const sessionId = props?.sessionId;
        const [roles, setRoles] = useState(undefined);
        const [note, setNote] = useState(undefined);

        useEffect(() => {
          let alive = true;
          void (async () => {
            try {
              const roster = unwrapRemote('agentPresets.list', await ctx.remote.agentPresets.list());
              const all = Array.isArray(roster?.presets) ? roster.presets : [];
              if (alive) setRoles(all.filter(preset => typeof preset?.id === 'string' && preset.id.startsWith(ROLE_PREFIX)));
            } catch {
              if (alive) setRoles([]);
            }
          })();
          return () => {
            alive = false;
          };
        }, []);

        if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
        return h('select', {
          value: '',
          title: '把当前对话设为某个专家的常驻页；此后这个对话就是它的页面',
          onChange: async event => {
            const presetId = String(event.target.value ?? '');
            if (presetId.length === 0) return;
            try {
              unwrapRemote('agentPresets.select', await ctx.remote.agentPresets.select(sessionId, presetId));
              const map = await readPermanentPages(ctx);
              await writePermanentPages(ctx, { ...map, [presetId]: sessionId });
              setNote('已设为常驻页 ✓');
            } catch (error) {
              setNote(String(error?.message ?? error));
            }
          },
          style: {
            fontSize: 11,
            background: 'transparent',
            color: C.text,
            border: `0.5px solid ${C.border3}`,
            borderRadius: C.radiusSm,
            padding: '2px 6px',
            maxWidth: 150,
          },
        },
        h('option', { value: '' }, note ?? '设为常驻页 ▾'),
        (roles ?? []).map(role => h('option', { key: role.id, value: role.id }, role.name ?? role.id)));
      };
    }

    /**
     * The Settings → Models row for the source-agent path.
     *
     * Values come from the Client's `configForms` mirror — "the one `settings.describe`
     * reader in the browser", and the same path every shipped Settings page uses. The
     * form controller it hands back owns the write queue and the revision bookkeeping,
     * so this row never touches revisions itself.
     *
     * Reading `ctx.remote.settings.describe()` directly is NOT equivalent: it answered
     * `{ writable, hasDocument, namespaces: [] }` here, i.e. an empty namespace list.
     *
     * The namespace is the Host's entry id for the row. A bundle patch's `include` may
     * prefix it, so it is resolved from the mirror instead of hardcoded.
     */
    function createPathRow(ctx, spec) {
      const NS = 'task-agent-kit';
      // One row = one Config field. Both the source-agent path and the shared-resource path
      // are configured through this factory, so the two cannot drift apart.
      const FIELD = spec.field;
      const LABEL = spec.label;
      const HINT = spec.hint;
      // An array-shaped field (`sharedRoots`) is written as a one-element list.
      const MULTIPLE = spec.multiple === true;

      /** Namespaces the Host serves, plus the one that belongs to this plugin. */
      function resolveNamespace() {
        try {
          const view = ctx.configForms.describe().getSnapshot().view;
          const served = (view?.namespaces ?? []).map(entry => entry?.ns).filter(ns => typeof ns === 'string');
          return { ns: served.find(ns => ns === NS) ?? served.find(ns => ns.endsWith(`:${NS}`)), served };
        } catch (error) {
          return { ns: undefined, served: [], error: String(error?.message ?? error) };
        }
      }

      return function ConfigPathRow() {
        // `configForms.get` memoizes per entry id, so resolving on every render is cheap
        // and self-corrects once the mirror serves the (possibly prefixed) namespace.
        const resolved = resolveNamespace();
        const form = ctx.configForms.get(resolved.ns ?? NS);
        const [snapshot, setSnapshot] = useState(() => form.getSnapshot());
        const [busy, setBusy] = useState(false);
        const [notice, setNotice] = useState(undefined);

        useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form]);

        const raw = snapshot?.value?.[FIELD];
        const value = Array.isArray(raw) ? String(raw[0] ?? '') : (typeof raw === 'string' ? raw : '');

        const write = useCallback(async next => {
          setBusy(true);
          setNotice(undefined);
          try {
            // Clearing a list field unsets it; setting one writes a single-element list.
            const accepted = next === ''
              ? await form.unset(FIELD)
              : await form.set(FIELD, MULTIPLE ? [next] : next);
            setNotice(accepted === false
              ? { kind: 'error', text: '宿主拒绝了这次写入（修订号可能已变化），请重试。' }
              : { kind: 'ok', text: '已保存并触发重扫，无需重启。' });
          } catch (error) {
            setNotice({ kind: 'error', text: String(error?.message ?? error) });
          } finally {
            setBusy(false);
          }
        }, [form]);

        const browse = useCallback(async () => {
          try {
            const picked = await ctx.uiWorkspace.pickDirectory();
            if (typeof picked === 'string' && picked.length > 0) await write(picked);
          } catch (error) {
            setNotice({ kind: 'error', text: String(error?.message ?? error) });
          }
        }, [write]);

        const buttonStyle = {
          background: 'transparent',
          color: C.text,
          border: `0.5px solid ${C.border3}`,
          borderRadius: C.radiusSm,
          padding: '3px 12px',
          cursor: busy ? 'progress' : 'pointer',
          fontSize: 12,
          opacity: busy ? 0.6 : 1,
        };

        return h('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0', borderTop: `1px solid ${C.border}` },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 13, color: C.text, minWidth: 140 } }, LABEL),
          h('code', {
            style: { flex: '1 1 240px', fontSize: 11, color: C.dim, wordBreak: 'break-all' },
          }, snapshot?.status === 'loading' ? '读取中…' : (value || '（未配置）')),
          h('button', { type: 'button', onClick: () => void browse(), style: buttonStyle, disabled: busy }, '浏览'),
          h('button', { type: 'button', onClick: () => void write(''), style: buttonStyle, disabled: busy }, '清除')),
        h('div', { style: { fontSize: 11, color: C.dim } }, HINT),
        // The mirror's own state stays on screen: an unserved namespace or a read-only
        // document is then visible instead of a silently inert row.
        h('div', { style: { fontSize: 11, color: C.dim } },
          `命名空间 ${resolved.ns ?? `（未提供；宿主提供 ${resolved.served.join(', ') || '无'}）`}`
          + ` · 状态 ${snapshot?.status ?? '未知'}`
          + (snapshot?.writable === false ? ' · 只读' : '')
          + ` · 修订 ${snapshot?.revision ?? '—'}`),
        notice !== undefined
          ? h('div', { style: { fontSize: 11, color: notice.kind === 'error' ? C.bad : C.ok } },
            `${notice.kind === 'error' ? '设置不可用：' : ''}${notice.text}`)
          : null);
      };
    }

    return {
      // `remote` itself must be declared: reading `ctx.remote` without it throws
      // `cannot get property "remote" without inject`, and every shared namespace
      // below is reached through it. `configForms` is the Client mirror of the Host
      // settings document and the supported read path for a plugin Config row.
      inject: ['slots', 'layout', 'remote', 'remote.agentPresets', 'remote.session', 'remote.workspace', 'configForms', 'uiWorkspace'],
      apply(ctx) {
        const disposers = [];

        disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_KEY,
        }, createDeck(ctx))));

        // `sidebar.panellist` is a GLYPH seat, not a button seat: the host draws the
        // panel row (tooltip, focus, active state) and calls `selectPanel(id)` with the
        // registration id. The id must therefore EQUAL the `main` key, or the shell
        // dispatches a panel that does not exist and nothing visibly happens.
        disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_KEY,
          order: 50,
          label: () => 'Agent 观察室',
        }, createDeckEntry())));

        // Hero creation flow: the trigger sits beside the workspace picker; the tier
        // picker is a frame-wide modal. It cannot live in `conversation.hero.dock`,
        // which the Conversation renders only while `sessionId === undefined` — a new
        // conversation that already owns a draft session would never show it.
        const plan = createPlanFeature(ctx);
        disposers.push(ctx.slots.inject('conversation.hero.modeActions', () => ctx.slots.register({
          name: 'conversation.hero.modeActions',
          id: 'task-agent-plan',
          order: 10,
          label: () => '添加任务 agent',
        }, plan.AddTaskAgentButton)));
        disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'task-agent-plan-panel',
          order: 10,
        }, plan.TaskAgentPicker)));

        // Session header: the tier plan the user configured, readable on hover beside the
        // shipped agent-team chip. Session scope, so the cell receives `sessionId`.
        disposers.push(ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'task-agent-plan-chip',
          order: 20,
          label: () => '任务 agent 层级',
        }, plan.TaskPlanChip)));

        // Route B, same slot: point THIS conversation at an expert and it becomes that
        // expert's permanent page. A list slot, so it sits beside the plan chip.
        disposers.push(ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'task-agent-page-binder',
          order: 21,
          label: () => '设为专家常驻页',
        }, createExpertPageBinder(ctx))));

        // Settings → Models footer: the source-agent path, then the shared-resource path.
        // Both are ordinary Config rows read and written through the `configForms` mirror.
        const pathRows = [
          {
            id: 'task-agent-source-path',
            order: 10,
            field: 'sourceAgentPath',
            label: '源 agent 路径',
            hint: '该路径下的每个一级文件夹（需含 Agent.md）会成为一个可选的任务 Agent。保存后立即重扫，无需重启。',
          },
          {
            id: 'task-agent-shared-path',
            order: 11,
            field: 'sharedRoots',
            multiple: true,
            label: '公共资源路径',
            hint: '公共资源根目录：其 .skills 会挂载进每一个 Agent（含以后新建的），.mcp/mcp.json 的服务器也会合并进去；open_project 下的应用项目与 MCP 源码按路径使用。保存后立即重扫，无需重启。',
          },
        ];
        for (const row of pathRows) {
          disposers.push(ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
            name: 'settings.models.footer',
            id: row.id,
            order: row.order,
            label: () => row.label,
          }, createPathRow(ctx, row))));
        }

        ctx.effect(() => () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* a slot that was never claimed has nothing to release */
            }
          }
        });
      },
    };
  },
});
