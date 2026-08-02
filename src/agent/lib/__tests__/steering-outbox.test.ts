/**
 * The outbox is the answer to one owner sentence: a message he typed while the
 * agent was working must stay visible until the agent actually has it. So the
 * cases that matter here are the three ways it used to disappear.
 */
import { describe, expect, it } from 'vitest'
import {
  OUTBOX_MAX_AGE_MS,
  OUTBOX_STORAGE_KEY,
  addEntry,
  entriesToResend,
  loadOutbox,
  markAttempt,
  rehydrate,
  removeEntries,
  retryDelayMs,
  saveOutbox,
  type OutboxStorage,
  type SteeringOutboxEntry,
} from '@/agent/lib/steering-outbox'

function memoryStorage(seed?: string): OutboxStorage & { value: string | null } {
  return {
    value: seed ?? null,
    getItem(key) { return key === OUTBOX_STORAGE_KEY ? this.value : null },
    setItem(key, value) { if (key === OUTBOX_STORAGE_KEY) this.value = value },
  }
}

const entry = (over: Partial<SteeringOutboxEntry> = {}): SteeringOutboxEntry => ({
  clientMessageId: 'c1',
  conversationId: 'conv1',
  turnId: 'turn1',
  text: 'ekhon eta koro',
  files: [],
  queuedAt: new Date(1_700_000_000_000).toISOString(),
  attempts: 0,
  ...over,
})

describe('it survives a reload', () => {
  it('round-trips through storage', () => {
    const store = memoryStorage()
    saveOutbox(store, [entry()])
    expect(loadOutbox(store, 1_700_000_001_000).map((e) => e.text)).toEqual(['ekhon eta koro'])
  })

  it('a corrupt or half-written entry cannot take the composer down', () => {
    expect(loadOutbox(memoryStorage('not json'))).toEqual([])
    expect(loadOutbox(memoryStorage('{"not":"an array"}'))).toEqual([])
    expect(loadOutbox(memoryStorage('[{"clientMessageId":"c1"}]'))).toEqual([])
  })

  it('no storage at all (SSR, private mode) is simply empty, never a throw', () => {
    expect(loadOutbox(null)).toEqual([])
    expect(() => saveOutbox(null, [entry()])).not.toThrow()
  })

  it('drops anything older than a day rather than re-sending stale instructions', () => {
    const store = memoryStorage()
    saveOutbox(store, [entry()])
    const later = 1_700_000_000_000 + OUTBOX_MAX_AGE_MS + 1
    expect(loadOutbox(store, later)).toEqual([])
  })
})

describe('a reload must not run the same instruction twice', () => {
  // Codex round 3: a client-side turn id only exists for a LIVE stream, so
  // after a refresh every entry looked stranded and got re-sent as a new turn —
  // even one the running turn had already consumed.
  it('an accepted entry is dropped on rehydrate and never resent', () => {
    const list = [entry({ accepted: true }), entry({ clientMessageId: 'c2' })]
    expect(rehydrate(list).map((e) => e.clientMessageId)).toEqual(['c2'])
    expect(entriesToResend(list, null, 'conv1').map((e) => e.clientMessageId)).toEqual(['c2'])
  })
})

describe('a retry can never double-send', () => {
  it('adding the same clientMessageId replaces rather than appends', () => {
    const list = addEntry(addEntry([], entry()), entry({ attempts: 2 }))
    expect(list).toHaveLength(1)
    expect(list[0].attempts).toBe(2)
  })

  it('delivery removes exactly the delivered ids', () => {
    const list = [entry(), entry({ clientMessageId: 'c2' })]
    expect(removeEntries(list, ['c1']).map((e) => e.clientMessageId)).toEqual(['c2'])
  })

  it('a failed attempt is counted and kept — never dropped', () => {
    const list = markAttempt([entry()], 'c1', 'HTTP 500')
    expect(list).toHaveLength(1)
    expect(list[0].attempts).toBe(1)
    expect(list[0].lastError).toBe('HTTP 500')
  })

  it('backs off instead of hot-looping, and stays capped', () => {
    expect(retryDelayMs(0)).toBe(1_000)
    expect(retryDelayMs(3)).toBe(8_000)
    expect(retryDelayMs(99)).toBe(30_000)
  })
})

describe('the 409 case — the turn ended before the message landed', () => {
  it('an entry aimed at a finished turn is re-sent as a new turn, not deleted', () => {
    const list = [entry(), entry({ clientMessageId: 'c2', turnId: 'turn2' })]
    expect(entriesToResend(list, 'turn2', 'conv1').map((e) => e.clientMessageId)).toEqual(['c1'])
  })

  it('an entry aimed at the turn still running is left alone', () => {
    expect(entriesToResend([entry()], 'turn1', 'conv1')).toEqual([])
  })

  it('another conversation’s queue is never touched', () => {
    expect(entriesToResend([entry({ conversationId: 'other' })], null, 'conv1')).toEqual([])
    expect(entriesToResend([entry()], null, null)).toEqual([])
  })
})
