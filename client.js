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
  // The loader id MUST equal the package name: the module table resolves a bundle by id.
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

    /** Read the selected session through a slot's standard `useSessions` prop. */
    function useCurrentSession(props) {
      const hook = props?.useSessions;
      const snapshot = typeof hook === 'function' ? hook(value => value) : undefined;
      return sessionIdOf(snapshot);
    }

    /** Read the selected workspace through a slot's standard `useWorkspaces` prop. */
    function useWorkspace(props) {
      const hook = props?.useWorkspaces;
      // A cell's standard props are stable for its lifetime, so the hook call order
      // cannot change between renders.
      const snapshot = typeof hook === 'function' ? hook(value => value) : undefined;
      return workspaceIdOf(snapshot);
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

        const refresh = useCallback(async () => {
          setState(current => ({ ...current, phase: current.roster ? 'ready' : 'loading' }));
          try {
            const roster = unwrapRemote('agentPresets.list', await ctx.remote.agentPresets.list());
            const all = Array.isArray(roster?.presets) ? roster.presets : [];
            const roles = all.filter(preset => typeof preset?.id === 'string' && preset.id.startsWith(ROLE_PREFIX));
            // Keep what the roster actually answered. The shipped preset control lists our
            // role while this panel showed none, so the panel must name the ids it received
            // instead of leaving the mismatch to guesswork.
            setState({
              phase: 'ready',
              roster: roles,
              allIds: all.map(preset => String(preset?.id ?? '(no id)')),
              fetchedAt: Date.now(),
            });
          } catch (error) {
            setState({ phase: 'error', message: String(error?.message ?? error) });
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
          const sessions = typeof props?.useSessions === 'function' ? props.useSessions() : undefined;
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
        }, [props]);

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
          try {
            const created = unwrapRemote('session.create', await ctx.remote.session.create({ agentPreset: preset.id }));
            const sessionId = typeof created === 'string' ? created : created?.sessionId;
            if (typeof sessionId === 'string' && sessionId.length > 0) ctx.uiWorkspace.openSession(sessionId);
            setBusy('');
          } catch (error) {
            setBusy('');
            setState(current => ({ ...current, actionError: `${preset.name ?? preset.id}: ${String(error?.message ?? error)}` }));
          }
        }, []);

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
            title: preset.broken ?? preset.description ?? preset.id,
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
          h('span', { style: { fontSize: 10, color: C.dim, fontFamily: 'monospace' } }, preset.id));
        }));

        const header = h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${C.border}` },
        },
        h('span', { style: { fontSize: 14, fontWeight: 600, color: C.text } }, 'Agent 观察室'),
        h('span', { style: { fontSize: 11, color: C.dim } },
          onlyActive ? `工作中 ${shown.length} / 共 ${roles.length} 个角色` : `共 ${roles.length} 个角色`),
        h('span', { style: { flex: '1 1 auto' } }),
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
            background: onlyActive ? C.accent : C.layer2,
            color: onlyActive ? C.bg : C.text,
            border: `1px solid ${onlyActive ? C.accent : C.border}`,
            borderRadius: 6,
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
            style: { background: C.layer2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '2px 6px' },
          }, DENSITIES.map(n => h('option', { key: n, value: String(n) }, `${n} × ${n}`)))),
        h('button', {
          type: 'button',
          onClick: () => void refresh(),
          style: { background: C.layer2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '3px 10px', cursor: 'pointer' },
        }, '刷新'));

        const footer = h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderTop: `1px solid ${C.border}` },
        },
        h('button', {
          type: 'button',
          disabled: safePage <= 0,
          onClick: () => setPage(current => Math.max(0, current - 1)),
          style: { background: C.layer2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '2px 10px', cursor: safePage <= 0 ? 'default' : 'pointer', opacity: safePage <= 0 ? 0.5 : 1 },
        }, '‹'),
        h('span', { style: { fontSize: 11, color: C.dim } }, `第 ${safePage + 1} / ${pageCount} 页`),
        h('button', {
          type: 'button',
          disabled: safePage >= pageCount - 1,
          onClick: () => setPage(current => Math.min(pageCount - 1, current + 1)),
          style: { background: C.layer2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '2px 10px', cursor: safePage >= pageCount - 1 ? 'default' : 'pointer', opacity: safePage >= pageCount - 1 ? 0.5 : 1 },
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
        body,
        footer);
      }

      // A throwing component blanks its slot entry entirely, which is indistinguishable
      // from "the panel did not open". Catching here turns any render failure into a
      // readable card instead of an empty page.
      return function AgentDeck() {
        try {
          return AgentDeckView();
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
            style: { background: C.layer2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '2px 6px', fontSize: 12 },
          }, [1, 2, 3, 4, 5].map(n => h('option', { key: n, value: String(n) }, String(n)))),
          h('span', { style: { fontSize: 11, color: C.dim } }, '1–5 层；上级拆解后派发给下级，下级遇疑反向询问上级')),
        ...tierRows,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('button', {
            type: 'button',
            onClick: () => store.reset(),
            style: { background: C.layer2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '3px 14px', cursor: 'pointer', fontSize: 12 },
          }, '重置'),
          h('button', {
            type: 'button',
            onClick: () => void complete(),
            style: { background: C.accent, color: C.bg, border: 'none', borderRadius: 6, padding: '3px 14px', cursor: state.busy === 'create' ? 'progress' : 'pointer', fontSize: 12, opacity: state.busy === 'create' ? 0.6 : 1 },
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
    function createSourcePathRow(ctx) {
      const NS = 'task-agent-kit';

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

      return function AgentSourcePathRow() {
        // `configForms.get` memoizes per entry id, so resolving on every render is cheap
        // and self-corrects once the mirror serves the (possibly prefixed) namespace.
        const resolved = resolveNamespace();
        const form = ctx.configForms.get(resolved.ns ?? NS);
        const [snapshot, setSnapshot] = useState(() => form.getSnapshot());
        const [busy, setBusy] = useState(false);
        const [notice, setNotice] = useState(undefined);

        useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form]);

        const value = typeof snapshot?.value?.sourceAgentPath === 'string' ? snapshot.value.sourceAgentPath : '';

        const write = useCallback(async next => {
          setBusy(true);
          setNotice(undefined);
          try {
            const accepted = next === ''
              ? await form.unset('sourceAgentPath')
              : await form.set('sourceAgentPath', next);
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
          background: C.layer2,
          color: C.text,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          padding: '3px 12px',
          cursor: busy ? 'progress' : 'pointer',
          fontSize: 12,
          opacity: busy ? 0.6 : 1,
        };

        return h('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0', borderTop: `1px solid ${C.border}` },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 13, color: C.text, minWidth: 140 } }, '源 agent 路径'),
          h('code', {
            style: { flex: '1 1 240px', fontSize: 11, color: C.dim, wordBreak: 'break-all' },
          }, snapshot?.status === 'loading' ? '读取中…' : (value || '（未配置）')),
          h('button', { type: 'button', onClick: () => void browse(), style: buttonStyle, disabled: busy }, '浏览'),
          h('button', { type: 'button', onClick: () => void write(''), style: buttonStyle, disabled: busy }, '清除')),
        h('div', { style: { fontSize: 11, color: C.dim } },
          '该路径下的每个一级文件夹（需含 Agent.md）会成为一个可选的任务 Agent。保存后立即重扫，无需重启。'),
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
      inject: ['slots', 'layout', 'remote', 'remote.agentPresets', 'remote.session', 'configForms', 'uiWorkspace'],
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

        // Settings → Models footer: the source-agent path with a browse button.
        disposers.push(ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
          name: 'settings.models.footer',
          id: 'task-agent-source-path',
          order: 10,
          label: () => '源 agent 路径',
        }, createSourcePathRow(ctx))));

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
