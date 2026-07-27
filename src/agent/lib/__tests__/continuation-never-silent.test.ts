/**
 * OWNER INCIDENT 2026-07-27 — he approved an SEO batch, the card said
 * "✅ সম্পন্ন", and the agent never spoke again. What woke it was my own test
 * question, which is precisely how the fault survived a session I had called
 * verified.
 *
 * The continuation must end in WORDS, whatever happens to it. These tests drive
 * the real `runContinuationInline` through the three endings a turn can have.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const notes: Array<{ conversationId: string; text: string }> = []
const events: Array<Record<string, unknown>> = []
let turnBehaviour: 'speaks' | 'silent' | 'throws' | 'card' = 'speaks'

vi.mock('@/agent/lib/conversation-note', () => ({
  appendAssistantNote: async (conversationId: string, text: string) => {
    notes.push({ conversationId, text })
  },
}))

vi.mock('@/agent/lib/turn-status', () => ({
  createTurn: async () => 'turn-1',
  finalizeTurnIfRunning: async () => {},
}))

vi.mock('@/agent/lib/turn-queue', () => ({
  buildTurnJobData: () => null,
  enqueueTurnJob: async () => null,
  isTurnHandoffConfigured: () => false,
}))

vi.mock('@/lib/prisma', () => ({ prisma: {} }))

vi.mock('@/agent/lib/models/run-owner-turn', () => ({
  // eslint-disable-next-line require-yield
  runOwnerTurn: async function* () {
    if (turnBehaviour === 'throws') throw new Error('The operation was aborted')
    if (turnBehaviour === 'silent') return
    if (turnBehaviour === 'card') {
      yield { type: 'ask_card', askCardId: 'a1', question: 'কোনটা?', options: ['ক', 'খ'] }
      return
    }
    yield { type: 'text_delta', delta: 'বস, পরের ব্যাচ পাঠালাম।' }
  },
}))

const { runContinuationInline } = await import('@/agent/lib/approval-continuation')

beforeEach(() => {
  notes.length = 0
  events.length = 0
  turnBehaviour = 'speaks'
})

describe('an approval continuation never ends in silence', () => {
  it('a turn that speaks needs no note — the reply IS the answer', async () => {
    turnBehaviour = 'speaks'
    await runContinuationInline({ conversationId: 'c1', message: 'go on' }, 'turn-1')
    expect(notes).toHaveLength(0)
  })

  it('a turn that stages a CARD counts as speaking — the job visibly moved', async () => {
    turnBehaviour = 'card'
    await runContinuationInline({ conversationId: 'c1', message: 'go on' }, 'turn-1')
    expect(notes).toHaveLength(0)
  })

  it('a turn that completes saying NOTHING gets an honest note', async () => {
    turnBehaviour = 'silent'
    await runContinuationInline({ conversationId: 'c1', message: 'go on' }, 'turn-1')
    expect(notes).toHaveLength(1)
    expect(notes[0].conversationId).toBe('c1')
    // it must not read as success
    expect(notes[0].text).toContain('শেষ হয়নি')
    expect(notes[0].text).toContain('চালিয়ে যাও')
  })

  it('the 90s abort is reported as a timeout, in words, not a console line', async () => {
    turnBehaviour = 'throws'
    await runContinuationInline({ conversationId: 'c1', message: 'go on' }, 'turn-1')
    expect(notes).toHaveLength(1)
    expect(notes[0].text).toContain('সময়সীমা')
    expect(notes[0].text).toContain('শেষ হয়নি')
  })

  it('the note never claims the work was done', async () => {
    for (const b of ['silent', 'throws'] as const) {
      notes.length = 0
      turnBehaviour = b
      await runContinuationInline({ conversationId: 'c1', message: 'go on' }, 'turn-1')
      expect(notes[0].text).not.toContain('সম্পন্ন হয়েছে')
      expect(notes[0].text).not.toContain('হয়ে গেছে')
    }
  })
})
