import { describe, it, expect } from 'vitest'
import { messageContentToText, type RecalledTurn } from '@/agent/lib/message-recall'
import { buildSystemPromptBlocks, type BuildSystemPromptArgs } from '@/agent/lib/system-prompt'

/**
 * B2 — per-message embeddings + true RAG recall.
 *
 * The DB/embedding paths (attachMessageEmbedding, retrieveRelevantOldTurns) need
 * live Postgres+pgvector+OpenAI, so these lock the two pure contracts the feature
 * depends on:
 *   - stored-message text extraction (what gets embedded / shown back), and
 *   - that recalled old turns ride in the VOLATILE preamble (which B1 moves into
 *     the current owner turn) and never leak into the cached system prefix — so
 *     recall can't bust the conversation-history cache.
 */

function stableTextFor(args: BuildSystemPromptArgs): string {
  return buildSystemPromptBlocks(args).stable.map((b) => b.text).join('\n')
}
function volatileTextFor(args: BuildSystemPromptArgs): string {
  return buildSystemPromptBlocks(args).volatile.map((b) => b.text).join('\n')
}

const RECALL_A: RecalledTurn[] = [
  { id: 'msg_old_1', role: 'user', content: 'SENTINEL_RECALL_A আগের অর্ডারটা কবে দিয়েছিলাম', score: 0.71 },
]
const RECALL_B: RecalledTurn[] = [
  { id: 'msg_old_2', role: 'assistant', content: 'SENTINEL_RECALL_B সেটা গত মাসে ডেলিভারি হয়েছিল', score: 0.66 },
]

describe('B2 — stored message text extraction', () => {
  it('joins text blocks and ignores non-text/malformed blocks', () => {
    const content = [
      { type: 'file_ref', bucket: 'agent-files', path: 'a/b.png', mediaType: 'image/png' },
      { type: 'text', text: 'প্রথম লাইন' },
      { type: 'text', text: 'দ্বিতীয় লাইন' },
      { type: 'text' }, // malformed: no text
      123,
      null,
    ]
    expect(messageContentToText(content)).toBe('প্রথম লাইন\nদ্বিতীয় লাইন')
  })

  it('accepts a raw string and returns empty for unusable input', () => {
    expect(messageContentToText('plain string')).toBe('plain string')
    expect(messageContentToText([])).toBe('')
    expect(messageContentToText(null)).toBe('')
    expect(messageContentToText({ foo: 'bar' })).toBe('')
  })
})

describe('B2 — recall rides the volatile preamble, never the cached system prefix', () => {
  const BASE: BuildSystemPromptArgs = {
    businessId: 'ALMA_LIFESTYLE',
    personalMode: false,
    activeGroups: ['erp', 'finance', 'staff'],
  }

  it('business mode: recall appears in volatile, not in the stable system block', () => {
    const args: BuildSystemPromptArgs = { ...BASE, recalledTurns: RECALL_A }
    expect(stableTextFor(args)).not.toContain('SENTINEL_RECALL_A')
    expect(volatileTextFor(args)).toContain('SENTINEL_RECALL_A')
  })

  it('personal mode: recall appears in volatile, not in the stable system block', () => {
    const args: BuildSystemPromptArgs = { businessId: 'ALMA_LIFESTYLE', personalMode: true, recalledTurns: RECALL_A }
    expect(stableTextFor(args)).not.toContain('SENTINEL_RECALL_A')
    expect(volatileTextFor(args)).toContain('SENTINEL_RECALL_A')
  })

  it('different recall across two turns leaves the cached system block byte-identical', () => {
    const turnA: BuildSystemPromptArgs = { ...BASE, recalledTurns: RECALL_A }
    const turnB: BuildSystemPromptArgs = { ...BASE, recalledTurns: RECALL_B }
    // The cache-defining prefix is unchanged despite different recall…
    expect(stableTextFor(turnA)).toEqual(stableTextFor(turnB))
    // …and the recall really did differ (otherwise the assertion is vacuous).
    expect(volatileTextFor(turnA)).not.toEqual(volatileTextFor(turnB))
  })

  it('no recall produces no recall section at all', () => {
    const args: BuildSystemPromptArgs = { ...BASE, recalledTurns: [] }
    expect(volatileTextFor(args)).not.toContain('recall')
  })
})
