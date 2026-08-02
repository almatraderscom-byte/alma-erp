/**
 * W3 — the chat-mirror's settle/dedupe logic (mac-agent/ui-driver.mjs).
 *
 * The watcher re-reads the driven app's whole conversation every ~3s. The
 * failure modes worth pinning down:
 *   1. a STREAMING assistant message grows between reads — emitting it on
 *      every poll would spam the feed with part-copies;
 *   2. a SHRUNKEN read of the same conversation (virtualized list) must never
 *      reset the emitted counter — silence beats duplicates;
 *   3. a SWITCHED conversation (the owner, or the driver pressing "New") is
 *      history to baseline silently — except a fresh empty chat, whose first
 *      messages are the news. The count-only model went permanently mute
 *      after a live "New" click; that regression stays dead here.
 *
 * Pure logic, no AX, no darwin dependency — runs everywhere.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DRIVER_MJS = resolve(__dirname, '../../../../../mac-agent/ui-driver.mjs')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let settleNewMessages: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let resolveBundleId: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let canSynthesizeKey: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let normalizeKey: any

beforeAll(async () => {
  const mod = await import(pathToFileURL(DRIVER_MJS).href)
  settleNewMessages = mod.settleNewMessages
  resolveBundleId = mod.resolveBundleId
  canSynthesizeKey = mod.canSynthesizeKey
  const policy = await import(
    pathToFileURL(resolve(__dirname, '../../../../../mac-agent/ui-policy.mjs')).href
  )
  normalizeKey = policy.normalizeKey
})

const owner = (text: string) => ({ who: 'owner', text })
const assistant = (text: string) => ({ who: 'assistant', text })
const fresh = () => ({ emittedCount: 0, pendingLast: null, firstText: null })

describe('settleNewMessages', () => {
  it('holds the last (possibly streaming) message until one unchanged read', () => {
    let state = fresh()

    // First read: owner asked, assistant reply is mid-stream.
    let r = settleNewMessages(state, [owner('hi'), assistant('PON')])
    // The owner message is settled (something follows it); the last is held.
    expect(r.emit).toEqual([owner('hi')])
    state = r.state
    expect(state.emittedCount).toBe(1)
    expect(state.pendingLast).toEqual(assistant('PON'))

    // Second read: still growing — nothing new emitted.
    r = settleNewMessages(state, [owner('hi'), assistant('PONG (almost')])
    expect(r.emit).toEqual([])
    state = r.state

    // Third read: unchanged since last poll → settled, emitted once.
    r = settleNewMessages(state, [owner('hi'), assistant('PONG (almost')])
    expect(r.emit).toEqual([assistant('PONG (almost')])
    state = r.state
    expect(state.emittedCount).toBe(2)
    expect(state.pendingLast).toBeNull()

    // Fourth read, no change at all: nothing re-emitted, ever.
    r = settleNewMessages(state, [owner('hi'), assistant('PONG (almost')])
    expect(r.emit).toEqual([])
  })

  it('a new message settles the previous last immediately', () => {
    let state = fresh()
    let r = settleNewMessages(state, [owner('q1')])
    expect(r.emit).toEqual([]) // lone last message: held for one poll
    state = r.state

    // Next read: the assistant answered and a NEW owner turn began.
    r = settleNewMessages(state, [owner('q1'), assistant('a1'), owner('q2')])
    expect(r.emit).toEqual([owner('q1'), assistant('a1')])
    state = r.state
    expect(state.emittedCount).toBe(2)
    expect(state.pendingLast).toEqual(owner('q2'))
  })

  it('never resets on a shrunken read of the same conversation', () => {
    // Watcher baselined at [a], then saw b and c arrive.
    let state = { emittedCount: 1, pendingLast: owner('a'), firstText: 'a' }
    let r = settleNewMessages(state, [owner('a'), assistant('b'), owner('c')])
    expect(r.emit).toEqual([assistant('b')]) // c held as the streaming last
    state = r.state
    expect(state.emittedCount).toBe(2)

    // Same conversation read shorter (first text unchanged): counter kept.
    r = settleNewMessages(state, [owner('a'), assistant('b')])
    expect(r.emit).toEqual([])
    expect(r.state.emittedCount).toBe(2)

    // Tail-only view (head scrolled off → first text differs): treated as a
    // switch, baselined silently, no duplicates either way.
    r = settleNewMessages(state, [owner('c')])
    expect(r.emit).toEqual([])
  })

  it('a "New" chat resets the state and its first messages flow', () => {
    // Watching a conversation with history…
    let state = { emittedCount: 3, pendingLast: null, firstText: 'old-first' }
    // …the driver presses New: the read is EMPTY.
    let r = settleNewMessages(state, [])
    expect(r.emit).toEqual([])
    state = r.state
    expect(state.emittedCount).toBe(0)
    expect(state.firstText).toBeNull()

    // The new chat's first exchange emits like any live conversation.
    r = settleNewMessages(state, [owner('W3 test prompt')])
    expect(r.emit).toEqual([])
    state = r.state
    r = settleNewMessages(state, [owner('W3 test prompt'), assistant('W3-OK')])
    expect(r.emit).toEqual([owner('W3 test prompt')])
    state = r.state
    r = settleNewMessages(state, [owner('W3 test prompt'), assistant('W3-OK')])
    expect(r.emit).toEqual([assistant('W3-OK')])
  })

  it('switching to another conversation baselines it silently', () => {
    let state = fresh()
    let r = settleNewMessages(state, [owner('convo A'), assistant('reply A'), owner('follow')])
    state = r.state

    // A different conversation appears (first message changed): history.
    r = settleNewMessages(state, [owner('convo B'), assistant('old 1'), owner('old 2'), assistant('old 3')])
    expect(r.emit).toEqual([])
    state = r.state
    expect(state.emittedCount).toBe(4)
    expect(state.firstText).toBe('convo B')

    // But a genuinely new message in convo B flows.
    r = settleNewMessages(state, [owner('convo B'), assistant('old 1'), owner('old 2'), assistant('old 3'), owner('new!')])
    expect(r.emit).toEqual([])
    state = r.state
    r = settleNewMessages(state, [owner('convo B'), assistant('old 1'), owner('old 2'), assistant('old 3'), owner('new!')])
    expect(r.emit).toEqual([owner('new!')])
  })

  it('a big jump straight from empty is a reopened old conversation — history', () => {
    let state = settleNewMessages(fresh(), []).state // watcher saw an empty chat
    const r = settleNewMessages(state, [owner('m1'), assistant('m2'), owner('m3'), assistant('m4')])
    expect(r.emit).toEqual([])
    expect(r.state.emittedCount).toBe(4)
  })

  it('a baselined MID-STREAM message emits its full text once it settles', () => {
    // Mirror starts while the assistant is replying: the partial last message
    // is baselined (already counted), the stream finishes, the count never
    // changes — the completed text must still come out, exactly once.
    let state = {
      emittedCount: 2,
      pendingLast: { who: 'assistant', text: 'partial' },
      firstText: 'hi',
      baselineLast: { who: 'assistant', text: 'partial' },
    }
    // Grown but not yet settled: held.
    let r = settleNewMessages(state, [owner('hi'), assistant('partial plus more')])
    expect(r.emit).toEqual([])
    // Unchanged read: settled — emit the full text, count stays put.
    r = settleNewMessages(r.state, [owner('hi'), assistant('partial plus more')])
    expect(r.emit).toEqual([assistant('partial plus more')])
    expect(r.state.emittedCount).toBe(2)
    expect(r.state.baselineLast).toBeNull()
    // And never again.
    r = settleNewMessages(r.state, [owner('hi'), assistant('partial plus more')])
    expect(r.emit).toEqual([])
  })

  it('a baselined SETTLED message never re-emits', () => {
    const state = {
      emittedCount: 2,
      pendingLast: { who: 'assistant', text: 'done' },
      firstText: 'hi',
      baselineLast: { who: 'assistant', text: 'done' },
    }
    const r = settleNewMessages(state, [owner('hi'), assistant('done')])
    expect(r.emit).toEqual([])
  })

  it('tolerates a malformed read', () => {
    expect(settleNewMessages(fresh(), null).emit).toEqual([])
  })
})

describe('canSynthesizeKey', () => {
  it('accepts every named key, letters, digits and modifier combos', () => {
    for (const k of ['return', 'enter', 'tab', 'escape', 'space', 'down', 'pageup', 'f5', 'a', 'z', '0', '9', '/', '`']) {
      expect(canSynthesizeKey(k), k).toBe(true)
    }
    for (const k of ['cmd+return', 'cmd+shift+p', 'ctrl+opt+left', 'cmd+a']) {
      expect(canSynthesizeKey(k), k).toBe(true)
    }
  })
  it('accepts what the policy normalizes from common spellings', () => {
    // The driver feeds normalizeKey() output into canSynthesizeKey — aliases
    // the policy folds (command→cmd, esc→escape, alt→opt) must synthesize.
    for (const raw of ['Command+Return', 'esc', 'alt+Tab', 'Control+C', 'spacebar']) {
      expect(canSynthesizeKey(normalizeKey(raw)), raw).toBe(true)
    }
  })
  it('refuses what the helper cannot press', () => {
    for (const k of ['', 'cmd+', '+a', 'hyper+a', 'fn+f1', 'cmd+unknownkey', 'a+b']) {
      expect(canSynthesizeKey(k), k).toBe(false)
    }
  })
})

describe('resolveBundleId', () => {
  it('maps short names through the policy allowlist', () => {
    expect(resolveBundleId('claude')).toBe('com.anthropic.claudefordesktop')
    expect(resolveBundleId('Claude')).toBe('com.anthropic.claudefordesktop')
  })
  it('passes bundle ids through untouched for the policy to judge', () => {
    expect(resolveBundleId('com.apple.keychainaccess')).toBe('com.apple.keychainaccess')
  })
  it('leaves unknown names for the policy to refuse by name', () => {
    expect(resolveBundleId('finder')).toBe('finder')
  })
})
