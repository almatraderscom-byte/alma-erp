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
