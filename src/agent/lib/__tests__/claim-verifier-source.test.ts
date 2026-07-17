import { describe, it, expect } from 'vitest'
import { detectClaimViolations } from '../claim-verifier'

/**
 * Source-attribution honesty (live-hit 2026-07-17): the head told the owner
 * "Meta MCP থেকে লাইভ চেক করে দেখলাম" while its ONE tool call that turn was
 * growth_control_room (old Graph path) — and the number was wrong too.
 * Claiming data CAME FROM Meta MCP requires an actual meta_ads_* call.
 */
describe('meta_mcp_source_claim', () => {
  const LIE = 'বস, Meta MCP থেকে লাইভ চেক করে দেখলাম: গত ৭ দিনে spend ৳0।'

  it('flags an MCP-source claim when no meta_ads_* tool ran (the live incident)', () => {
    const v = detectClaimViolations(LIE, ['growth_control_room'])
    expect(v).toHaveLength(1)
    expect(v[0].ruleId).toBe('meta_mcp_source_claim')
    expect(v[0].category).toBe('source_attribution')
  })

  it('passes when ANY bridged meta_ads_* tool actually ran (wildcard prefix)', () => {
    expect(detectClaimViolations(LIE, ['meta_ads_insights_performance_trend'])).toHaveLength(0)
    expect(detectClaimViolations(LIE, ['meta_ads_list_tools', 'growth_control_room'])).toHaveLength(0)
  })

  it('does NOT flag talking ABOUT the MCP being closed/disconnected', () => {
    const honest = 'বস, Meta MCP থেকে ডেটা আনা যায়নি — আপনার অ্যাকাউন্টে rollout এখনো খোলেনি, তাই পুরনো রিপোর্ট থেকে বলছি।'
    expect(detectClaimViolations(honest, ['growth_control_room'])).toHaveLength(0)
  })

  it('does NOT flag answers that never mention MCP', () => {
    const plain = 'বস, গত ৭ দিনে spend $11.48, impressions 49,804 — growth রিপোর্ট থেকে।'
    expect(detectClaimViolations(plain, ['growth_control_room'])).toHaveLength(0)
  })

  it('flags "MCP-এ কোনো data নেই" too — asserting MCP state without calling it (live-hit round 2)', () => {
    const slipped = 'বস, ad spend ৳12। Impressions, clicks, CTR — Meta MCP-এ কোনো readable data নেই (campaignsWithData=0)।'
    const v = detectClaimViolations(slipped, ['get_financial_health'])
    expect(v).toHaveLength(1)
    expect(v[0].ruleId).toBe('meta_mcp_source_claim')
  })

  it('still allows honest connection-state talk', () => {
    const honest = 'বস, Meta MCP এখনো এই অ্যাকাউন্টে খোলেনি (rollout বাকি) — তাই Graph রিপোর্ট থেকে বলছি।'
    expect(detectClaimViolations(honest, ['growth_control_room'])).toHaveLength(0)
  })
})
