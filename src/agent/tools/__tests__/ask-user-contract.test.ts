/**
 * Two owner rules about asking (2026-07-25), both caught by Boss in the same
 * screenshot:
 *  1. a question ENDS the turn — he watched the agent ask, then keep talking
 *     and finish its answer under its own unanswered card;
 *  2. the agent must RECOMMEND — it handed him a flat list of equal options and
 *     left the decision entirely to him, unlike Claude's "(Recommended)".
 *
 * The turn-ending itself is enforced in run-owner-turn's loop; this locks the
 * contract the model reads, so a prompt edit can't quietly drop either rule.
 */
import { describe, expect, it } from 'vitest'
import { ASK_TOOLS } from '@/agent/tools/ask-tools'

const askUser = ASK_TOOLS.find((t) => t.name === 'ask_user')!

describe('ask_user contract', () => {
  it('is registered with 2–4 tappable options', () => {
    expect(askUser).toBeDefined()
    const options = askUser.input_schema.properties?.options as { minItems?: number; maxItems?: number }
    expect(options.minItems).toBe(2)
    expect(options.maxItems).toBe(4)
  })

  it('requires the agent to put its OWN recommendation first', () => {
    expect(askUser.description).toMatch(/options\[0\] MUST be the option YOU would choose/)
    expect(askUser.description).toContain('প্রস্তাবিত')
  })

  it('tells the model that asking ends its turn', () => {
    expect(askUser.description).toMatch(/Asking ENDS your turn/)
    expect(askUser.description).toMatch(/Do not write an answer or keep working underneath it/)
  })
})
