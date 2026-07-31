/**
 * Naming a tool and saying it ran (owner incident 2026-07-26).
 *
 * Told to start a fix campaign, the head ran only `find_tool` and then wrote:
 *   "start_fix_campaign executed। Campaign ID: seo-fix-almatraders-20260726।
 *    মোট ৭টা ধাপ (audit verify → batch diagnose → …)। প্রথম ধাপ চলছে।"
 * No campaign existed — verified against the live plan-driver API. The id, the
 * step count and the pipeline were all invented.
 *
 * The verb rules missed it (English "executed") and the ledger rules key on
 * generic completion language, not on a tool the reply NAMES. This check has
 * nothing to interpret: either the named tool is in the turn's ledger or it isn't.
 */
import { describe, expect, it } from 'vitest'
import { detectToolExecutionClaims } from '@/agent/lib/claim-verifier'

const KNOWN = new Set([
  'start_fix_campaign',
  'find_tool',
  'run_website_seo_audit',
  'check_website_seo_audit',
  'post_to_facebook',
  'get_orders',
])
const isKnownTool = (n: string) => KNOWN.has(n)

describe('named-tool execution claims', () => {
  it('blocks the exact reply from the incident', () => {
    const text =
      'বস, start_fix_campaign টুল লোড করতে find_tool চালিয়ে দেখছি।\n'
      + 'start_fix_campaign executed। Campaign ID: seo-fix-almatraders-20260726। মোট ৭টা ধাপ।'
    const v = detectToolExecutionClaims(text, ['find_tool'], isKnownTool)
    expect(v).toHaveLength(1)
    expect(v[0].category).toBe('tool_not_called')
    expect(v[0].requiredTools).toEqual(['start_fix_campaign'])
  })

  it.each([
    'run_website_seo_audit চালানো হয়েছে (target=almatraders.com)।',
    'I called post_to_facebook and it worked.',
    'get_orders invoked — ৫টা অর্ডার পেলাম।',
  ])('blocks: %s', (text) => {
    expect(detectToolExecutionClaims(text, [], isKnownTool)).toHaveLength(1)
  })

  it('allows the claim when the tool really ran', () => {
    const text = 'start_fix_campaign executed। Campaign ID: 8f2c…'
    expect(detectToolExecutionClaims(text, ['start_fix_campaign'], isKnownTool)).toEqual([])
  })

  it('allows a stated INTENTION to call it', () => {
    const text = 'এখন start_fix_campaign কল করব।'
    expect(detectToolExecutionClaims(text, ['find_tool'], isKnownTool)).toEqual([])
  })

  it('ignores snake_case prose that is not a registered tool', () => {
    const text = 'the batch_size setting was changed and applied.'
    expect(detectToolExecutionClaims(text, [], isKnownTool)).toEqual([])
  })

  it('does not fire on a reply that names no tool at all', () => {
    const text = 'অডিট শেষ হয়েছে, স্কোর ৮৮/১০০।'
    expect(detectToolExecutionClaims(text, [], isKnownTool)).toEqual([])
  })

  it('checks each sentence, so one honest line does not excuse a fabricated one', () => {
    const text = 'find_tool চালিয়েছি। তারপর start_fix_campaign চালানো হয়েছে।'
    const v = detectToolExecutionClaims(text, ['find_tool'], isKnownTool)
    expect(v).toHaveLength(1)
    expect(v[0].requiredTools).toEqual(['start_fix_campaign'])
  })
})

/**
 * Live on 2026-07-31, and the more convincing half of the lie.
 *
 * The head could not see `update_orders` — it had been added to a list the
 * head-tool diet skips — so it never called it. Then it wrote a RESULT for the
 * call it never made: "প্রমাণ: update_orders tool success:true, দুটো অর্ডারেই
 * courier field updated, no error." Nothing had happened; only the ERP row said
 * so. The old gate matched "ran / চালিয়েছি" verbs, which that sentence carefully
 * did not contain.
 */
describe('a fabricated tool RESULT is a claim too', () => {
  const known = (name: string) => ['update_orders', 'update_order', 'get_orders'].includes(name)

  it('catches the exact sentence from the live run', () => {
    const out = detectToolExecutionClaims(
      'প্রমাণ: update_orders tool success:true, দুটো অর্ডারেই courier field updated, no error।',
      ['get_orders'],
      known,
    )
    expect(out).toHaveLength(1)
    expect(out[0].requiredTools).toEqual(['update_orders'])
  })

  it('catches an English result claim with no verb of running', () => {
    const out = detectToolExecutionClaims(
      'update_orders returned success:true so both orders are updated',
      [],
      known,
    )
    expect(out).toHaveLength(1)
  })

  it('stays quiet when the tool actually ran', () => {
    expect(
      detectToolExecutionClaims('update_orders success:true — card staged', ['update_orders'], known),
    ).toEqual([])
  })

  it('stays quiet about a tool it intends to call', () => {
    expect(
      detectToolExecutionClaims('এখন update_orders দিয়ে কার্ড বানাবো', [], known),
    ).toEqual([])
  })
})

describe('recommending a tool is not claiming it ran (bot P2 on #664)', () => {
  const known = (name: string) => ['update_orders', 'get_orders'].includes(name)

  it('stays quiet when the reply merely suggests the tool', () => {
    expect(detectToolExecutionClaims('update_orders দিয়ে করা যাবে', [], known)).toEqual([])
    expect(detectToolExecutionClaims('you should use update_orders for this', [], known)).toEqual([])
  })

  it('still catches the fabricated result', () => {
    expect(
      detectToolExecutionClaims('update_orders success:true — done', [], known),
    ).toHaveLength(1)
  })
})

describe('a past-tense assertion is not a recommendation (bot P2, round 2)', () => {
  const known = (name: string) => ['update_orders'].includes(name)

  it('catches "I did use update_orders; success:true"', () => {
    expect(
      detectToolExecutionClaims('I did use update_orders; success:true', [], known),
    ).toHaveLength(1)
  })

  it('still lets a genuine suggestion through', () => {
    expect(
      detectToolExecutionClaims('you should use update_orders instead', [], known),
    ).toEqual([])
  })
})
