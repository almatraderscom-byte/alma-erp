/**
 * P0-3 — the expectation must survive the round trip (review bot #690).
 *
 * The head is told to take the session `ui_session` / `new_chat` returns and
 * hand it straight back as `expectSession`. That object speaks the DAEMON's
 * field names (firstText, messages, composerEmpty). Accepting only the
 * expectation's own names silently dropped the single field that identifies a
 * conversation and left the app-wide window title — "ChatGPT" — as the entire
 * guard, which matches every chat in the app.
 *
 * These tests pin the mapping, because the failure mode is invisible: the guard
 * still runs, still reports a match, and still writes into the wrong chat.
 */
import { describe, it, expect } from 'vitest'
import { normalizeExpectSession } from '@/agent/lib/mac-agent/expect-session'

describe('normalizeExpectSession', () => {
  it('keeps the fingerprint when the daemon\'s own session object is passed back', () => {
    const returned = {
      windowTitle: 'ChatGPT',
      firstText: 'Boss er order gulo niye kotha bolchilam',
      messages: 11,
      composerEmpty: true,
    }
    expect(normalizeExpectSession(returned)).toEqual({
      windowTitle: 'ChatGPT',
      sessionFirstText: 'Boss er order gulo niye kotha bolchilam',
    })
  })

  it('a returned brand-new session becomes the empty-chat expectation', () => {
    // Its first line is empty by definition, so the message count is the only
    // thing that can protect the chat new_chat just opened.
    expect(normalizeExpectSession({ windowTitle: 'ChatGPT', firstText: '', messages: 0 }))
      .toEqual({ windowTitle: 'ChatGPT', emptySession: true })
  })

  it('still accepts the expectation-shaped object the schema documents', () => {
    expect(normalizeExpectSession({ sessionTitle: 'ChatGPT', sessionFirstText: 'purano kotha', emptySession: false }))
      .toEqual({ sessionTitle: 'ChatGPT', sessionFirstText: 'purano kotha' })
  })

  it('is null when there is no expectation to state', () => {
    expect(normalizeExpectSession(undefined)).toBeNull()
    expect(normalizeExpectSession('nonsense')).toBeNull()
    expect(normalizeExpectSession({})).toEqual({})
  })
})
