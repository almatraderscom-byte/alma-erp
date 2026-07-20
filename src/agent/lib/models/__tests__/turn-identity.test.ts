/**
 * Model-identity note — kills the "I am Claude Sonnet" hallucination and reports a
 * mid-conversation model switch. Pure/deterministic (no DB), so it runs offline.
 */
import { describe, it, expect } from 'vitest'
import { buildModelIdentityNote } from '@/agent/lib/models/turn-identity'
import { getModel } from '@/agent/lib/models/registry'

describe('buildModelIdentityNote', () => {
  it('pins the REAL running model by its label', () => {
    const note = buildModelIdentityNote('or-deepseek-v4-flash')
    expect(note).toContain(getModel('or-deepseek-v4-flash').label)
    // Explicitly forbids inventing another model name.
    expect(note).toContain('Claude/Sonnet/GPT')
  })

  it('does NOT add a switch line on the first turn (no previous model)', () => {
    const note = buildModelIdentityNote('or-deepseek-v4-flash', null)
    expect(note).not.toContain('পাল্টে')
  })

  it('does NOT add a switch line when the model is unchanged', () => {
    const note = buildModelIdentityNote('claude-opus-4-8', 'claude-opus-4-8')
    expect(note).not.toContain('পাল্টে')
  })

  it('reports a mid-chat switch with BOTH old and new labels', () => {
    const note = buildModelIdentityNote('claude-opus-4-8', 'or-deepseek-v4-flash')
    expect(note).toContain('পাল্টে')
    expect(note).toContain(getModel('claude-opus-4-8').label)
    expect(note).toContain(getModel('or-deepseek-v4-flash').label)
  })

  it('ignores an unknown previous model id (no false switch line)', () => {
    const note = buildModelIdentityNote('claude-opus-4-8', 'totally-made-up')
    expect(note).not.toContain('পাল্টে')
  })
})
