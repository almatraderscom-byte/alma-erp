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

const live = {
  windowTitle: 'ChatGPT',
  firstText: 'Boss er order gulo niye kotha bolchilam',
  textCount: 12,
  articles: 4,
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
    const fresh = { ...live, firstText: '', textCount: 3, articles: 0 }
    expect(sessionMatches({ emptySession: true }, fresh).ok).toBe(true)
  })

  it('checks the window title independently of the conversation title', () => {
    const v = sessionMatches({ windowTitle: 'Claude' }, live)
    expect(v.ok).toBe(false)
    expect(v.field).toBe('windowTitle')
  })
})
