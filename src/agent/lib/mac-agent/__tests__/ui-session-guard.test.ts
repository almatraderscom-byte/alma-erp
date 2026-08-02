/**
 * P0-3 — the Session Guard (foundation audit §G).
 *
 * Boss asked for a NEW ChatGPT chat and the agent wrote into his old one. The
 * audit's first root cause was that nothing in the system had any notion of
 * session identity, so no layer could tell the two apart — element-level
 * verification answered "did the text land in the field I named?", never "is
 * this the right conversation at all?".
 *
 * `sessionMatches` is that missing comparison, and it is deliberately dumb:
 * fields the caller actually stated, compared literally, mismatch refuses. No
 * model judgement in the loop — which is the whole point, because the model is
 * what got it wrong.
 */
import { describe, it, expect } from 'vitest'
import { sessionMatches } from '../../../../../mac-agent/ui-driver.mjs'

// Shaped like a real read from the owner's ChatGPT window (probed live
// 2026-08-02): no AXDocumentArticle at all, message count from the per-message
// headings, and firstText being the conversation's own first line.
const live = {
  bundleId: 'com.openai.codex',
  windowTitle: 'ChatGPT',
  firstText: 'Boss er order gulo niye kotha bolchilam',
  textCount: 252,
  articles: 0,
  messages: 11,
  composerEmpty: true,
  composerValue: '',
}

describe('sessionMatches', () => {
  it('passes when nothing was expected — an unstated expectation is not a mismatch', () => {
    expect(sessionMatches(undefined, live).ok).toBe(true)
    expect(sessionMatches({}, live).ok).toBe(true)
  })

  it('passes when the stated title and first message still match', () => {
    const v = sessionMatches({ sessionTitle: 'ChatGPT', sessionFirstText: live.firstText }, live)
    expect(v.ok).toBe(true)
  })

  it('ignores whitespace and case — AX returns the same text spaced differently', () => {
    const v = sessionMatches({ sessionFirstText: '  Boss er   ORDER gulo niye kotha bolchilam ' }, live)
    expect(v.ok).toBe(true)
  })

  // The reported failure, as a test: he switched chats between the card and the tap.
  it('REFUSES when the conversation on screen is a different one', () => {
    const v = sessionMatches({ sessionFirstText: 'ekta notun product er caption lekho' }, live)
    expect(v.ok).toBe(false)
    expect(v.field).toBe('sessionFirstText')
    expect(v.actual).toBe(live.firstText)
  })

  it('REFUSES when a brand-new chat was required but the old one is still open', () => {
    const v = sessionMatches({ emptySession: true }, live)
    expect(v.ok).toBe(false)
    expect(v.field).toBe('emptySession')
  })

  it('accepts an empty-session expectation against a genuinely empty chat', () => {
    // A fresh ChatGPT chat still shows sidebar chrome (textCount high) — what
    // makes it empty is that no message heading exists.
    const fresh = { ...live, firstText: '', messages: 0 }
    expect(sessionMatches({ emptySession: true }, fresh).ok).toBe(true)
  })

  // Review bot #690: requiring BOTH text and article nodes made the check
  // useless on the app it was written for — ChatGPT has no per-message
  // structure, so every old conversation passed as "empty".
  it('a written-in composer alone disproves an empty session', () => {
    const v = sessionMatches({ emptySession: true }, { ...live, messages: 0, composerEmpty: false })
    expect(v.ok).toBe(false)
    expect(v.actual).toContain('composer')
  })

  // The live probe's real finding: on ChatGPT `articles` is ALWAYS 0, so a
  // guard reading it would have called an 11-message conversation empty.
  it('counts messages from headings, so a busy ChatGPT chat is never "empty"', () => {
    const v = sessionMatches({ emptySession: true }, live)
    expect(v.ok).toBe(false)
    expect(v.actual).toContain('11 messages')
  })

  it('checks the window title independently of the conversation title', () => {
    const v = sessionMatches({ windowTitle: 'Claude' }, live)
    expect(v.ok).toBe(false)
    expect(v.field).toBe('windowTitle')
  })
})
