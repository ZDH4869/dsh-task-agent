/**
 * Open one expert's permanent page: reuse it when it exists, create it once otherwise.
 *
 * The mapping (expert id -> session id) and the session creation are injected, so the logic
 * is testable without the harness. This is the "one expert = one dedicated page" rule from
 * the v2 spec: the observer room opens THIS page, while tasks run in their own sessions.
 */

/**
 * @param preset - the role/preset being opened (`{ id }` at minimum).
 * @param readMap - async () => Record<string, string>, the persisted page map.
 * @param writeMap - async (map) => void, persists the updated map.
 * @param createSession - async (presetId) => string | { sessionId?: string }, creates a
 *   session bound to the preset.
 * @param openSession - (sessionId) => void, navigates to the session.
 * @returns `{ reused, sessionId }`; `reused` is true when the page already existed.
 */
export async function openPermanentPage({ preset, readMap, writeMap, createSession, openSession }) {
  const id = preset?.id;
  const map = await readMap();
  const existing = map?.[id];
  if (typeof existing === 'string' && existing.length > 0) {
    openSession(existing);
    return { reused: true, sessionId: existing };
  }
  const created = await createSession(id);
  const sessionId = typeof created === 'string' ? created : created?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { reused: false, sessionId: undefined };
  }
  await writeMap({ ...(map ?? {}), [id]: sessionId });
  openSession(sessionId);
  return { reused: false, sessionId };
}
