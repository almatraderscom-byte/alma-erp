import { describe, expect, it } from 'vitest'
import {
  buildSavedSalvageEventSequence,
  buildSavedSalvageReconciliation,
} from '../salvage-contract'

describe('saved interrupted-turn salvage reconciliation', () => {
  it('resets even an append-only live draft to the complete durable salvage', () => {
    const persistedText = 'কাজ হয়েছে।\n\n⚠️ অগ্রগতি সেভ করা আছে।'
    const events = buildSavedSalvageReconciliation({ persistedText, preambleText: '' })

    expect(events[0]).toMatchObject({ type: 'verification_retry' })
    expect(events[1]).toEqual({ type: 'text_delta', delta: persistedText })
  })

  it('atomically replaces a verifier buffer with the exact persisted body', () => {
    const persistedText = 'বস, অর্ডার দেখছি।\n\nসঠিক ফল।\n\n⚠️ অগ্রগতি সেভ করা আছে।'
    const events = buildSavedSalvageReconciliation({
      persistedText,
      preambleText: 'বস, অর্ডার দেখছি।',
    })

    expect(events[0]).toMatchObject({ type: 'verification_retry' })
    expect(events[1]).toEqual({
      type: 'text_delta',
      delta: '\n\nসঠিক ফল।\n\n⚠️ অগ্রগতি সেভ করা আছে।',
    })
    const body = events[1]?.type === 'text_delta' ? events[1].delta.trim() : ''
    expect(`বস, অর্ডার দেখছি।\n\n${body}`).toBe(persistedText)
  })

  it('sends the full persisted salvage when there is no pinned preamble', () => {
    const persistedText = 'যাচাইকৃত ফল।\n\n⚠️ অগ্রগতি সেভ করা আছে।'
    const events = buildSavedSalvageReconciliation({
      persistedText,
      preambleText: '',
    })

    expect(events.at(-1)).toEqual({ type: 'text_delta', delta: persistedText })
  })

  it('terminates a saved salvage with its durable message id and never error', () => {
    const events = buildSavedSalvageEventSequence(
      { persistedText: 'সেভ করা ফল', preambleText: '' },
      { type: 'done' as const, messageId: 'msg-salvage', tokensIn: 4 },
    )

    expect(events.at(-1)).toEqual({
      type: 'done',
      messageId: 'msg-salvage',
      tokensIn: 4,
    })
    expect(events.map((event) => event.type)).toEqual([
      'verification_retry',
      'text_delta',
      'done',
    ])
  })
})
