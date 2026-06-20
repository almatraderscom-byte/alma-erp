/**
 * Marketing-head routing regression guard.
 *
 * Root cause this locks down: the owner types Banglish ("post banao", "post kore
 * dao", "facebook e post koro"). The original regex was Bangla-script + adjacency
 * only, so 7/15 natural marketing messages silently fell through to Sonnet and the
 * owner never saw Qwen answer. These cases hit the REGEX fast-path, which returns
 * BEFORE any network call — so the test is deterministic and offline.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { resolveHeadModelId } from '@/agent/lib/models/head-router'

const MARKETING_MESSAGES = [
  'ekta fb post er caption likhe dao',
  'akta post banao',
  'fb te post dao',
  'ekta marketing post banao',
  'caption ta lekho',
  'amar best selling panjabi er jonno akta post ready koro',
  'new product er promotion koro',
  'ekta ad banaw facebook er jonno',
  'ei product ta post kore dao',
  'marketing kemne korbo',
  'akta sundor post likhe dao customer der jonno',
  'boost dewar jonno akta creative banao',
  'ei panjabi ta niye facebook e post koro',
  'ekta fb post lagbe',
  'post ready koro',
]

// Must NOT route to the marketing head (these short-circuit before any network
// call: money keyword → deny, or are routed by triage which we don't exercise here).
const NON_MARKETING_DENY = [
  'staff er salary calculate koro',
  'ei expense ta delete koro',
]

describe('resolveHeadModelId — marketing routing', () => {
  beforeAll(() => {
    process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key'
    delete process.env.ENABLE_MARKETING_HEAD
    delete process.env.ENABLE_CHEAP_HEAD
  })

  it.each(MARKETING_MESSAGES)('routes marketing message to Qwen head: %s', async (msg) => {
    const decision = await resolveHeadModelId({
      requestedModelId: null,
      lastUserText: msg,
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
    })
    expect(decision.tier).toBe('marketing')
    expect(decision.modelId).toBe('or-qwen3-max')
  })

  it.each(NON_MARKETING_DENY)('keeps sensitive/money message on Sonnet: %s', async (msg) => {
    const decision = await resolveHeadModelId({
      requestedModelId: null,
      lastUserText: msg,
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
    })
    expect(decision.modelId).not.toBe('or-qwen3-max')
  })

  it('disabling ENABLE_MARKETING_HEAD stops Qwen routing on the regex path', async () => {
    process.env.ENABLE_MARKETING_HEAD = 'false'
    const decision = await resolveHeadModelId({
      requestedModelId: null,
      lastUserText: 'akta fb post banao',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
    })
    expect(decision.modelId).not.toBe('or-qwen3-max')
    delete process.env.ENABLE_MARKETING_HEAD
  })
})
