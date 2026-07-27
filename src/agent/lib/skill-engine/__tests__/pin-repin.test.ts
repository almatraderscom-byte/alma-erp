/**
 * FOUND LIVE 2026-07-27 — the pin was frozen for the whole conversation, but the
 * JOB is not. He audits the site, reads the result, then says "ekhon thik koro".
 * Same chat, different job. The fix order stayed pinned to
 * `seo-auditing-own-site`, whose allowlist holds no write tool, so the agent
 * announced "draft_seo_fixes চালিয়ে batch ready করছি" and could not possibly do
 * it — and spent $0.36 on a full crawl first.
 *
 * Only the RULE layer may move a pin. Rules are the deterministic cases SK-3
 * deliberately never sends to a model; keyword drift must not re-pick, or the
 * cached prefix the pin exists to protect is rewritten every turn. An OWNER pin
 * is never overridden.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

let stored: { pinnedSkill: string | null; skillRouteTrace: unknown } | null = null
const writes: Array<{ skill: string; source: string }> = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentConversation: {
      findUnique: async () => stored,
      update: async ({ data }: { data: { pinnedSkill: string; skillRouteTrace: { source: string } } }) => {
        writes.push({ skill: data.pinnedSkill, source: data.skillRouteTrace.source })
        stored = { pinnedSkill: data.pinnedSkill, skillRouteTrace: data.skillRouteTrace }
        return stored
      },
    },
  },
}))

const { resolveSkillPin } = await import('@/agent/lib/skill-engine/pin')

beforeEach(() => {
  writes.length = 0
})

describe('a pinned skill follows the job when the job changes', () => {
  it('audit → fix inside one chat re-pins to the fixing skill', async () => {
    stored = { pinnedSkill: 'seo-auditing-own-site', skillRouteTrace: { source: 'router' } }
    const pin = await resolveSkillPin('c1', 'almatraders.com er slug gulo thik kore dao')
    expect(pin.skill).toBe('seo-fixing-own-site')
    expect(writes).toHaveLength(1)
    expect(pin.trace?.layer).toBe('rule')
  })

  it('fix → audit re-pins the other way too', async () => {
    stored = { pinnedSkill: 'seo-fixing-own-site', skillRouteTrace: { source: 'router' } }
    const pin = await resolveSkillPin('c1', 'almatraders.com er purno seo audit koro')
    expect(pin.skill).toBe('seo-auditing-own-site')
  })

  it('a message with no RULE match leaves the pin alone', async () => {
    stored = { pinnedSkill: 'seo-auditing-own-site', skillRouteTrace: { source: 'router' } }
    const pin = await resolveSkillPin('c1', 'ha koro')
    expect(pin.skill).toBe('seo-auditing-own-site')
    expect(writes).toHaveLength(0)
  })

  it('keyword drift alone never moves a pin — that would break the cache', async () => {
    stored = { pinnedSkill: 'seo-auditing-own-site', skillRouteTrace: { source: 'router' } }
    // "website" scores on other skills but matches no rule.
    const pin = await resolveSkillPin('c1', 'website ta kemon dekhacche?')
    expect(pin.skill).toBe('seo-auditing-own-site')
    expect(writes).toHaveLength(0)
  })

  it("an OWNER's own pin is never overridden by a rule", async () => {
    stored = { pinnedSkill: 'seo-auditing-own-site', skillRouteTrace: { source: 'owner' } }
    const pin = await resolveSkillPin('c1', 'almatraders.com er slug gulo thik kore dao')
    expect(pin.skill).toBe('seo-auditing-own-site')
    expect(pin.source).toBe('owner')
    expect(writes).toHaveLength(0)
  })
})
