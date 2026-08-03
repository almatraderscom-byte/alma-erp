/**
 * P0-3 — the session expectation, normalised (audit §G; review bot #690).
 *
 * The head is told to take the session `ui_session` / `ui_new_chat` returns and
 * hand it straight back as `expectSession`. That object speaks the DAEMON's
 * field names — `firstText`, `messages`, `composerEmpty` — not the
 * expectation's. Accepting only the expectation's own names silently dropped
 * the one field that identifies a conversation and left the app-wide window
 * title ("ChatGPT") as the entire guard, which matches every chat in the app.
 *
 * The failure mode is invisible from the outside: the guard still runs, still
 * reports a match, and still writes into the wrong chat. Hence its own module
 * with its own tests, rather than an inline object literal.
 */
export interface ExpectSession {
  windowTitle?: string
  sessionTitle?: string
  sessionFirstText?: string
  emptySession?: true
}

export function normalizeExpectSession(raw: unknown): ExpectSession | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const firstText = r.sessionFirstText ?? r.firstText
  return {
    ...(r.windowTitle ? { windowTitle: String(r.windowTitle) } : {}),
    ...(r.sessionTitle ? { sessionTitle: String(r.sessionTitle) } : {}),
    ...(firstText ? { sessionFirstText: String(firstText) } : {}),
    // A returned session with NO messages is the empty-chat expectation — and
    // it is the only signal a brand-new chat has, since its first line is empty
    // by definition.
    ...(r.emptySession === true || Number(r.messages) === 0 ? { emptySession: true as const } : {}),
  }
}
