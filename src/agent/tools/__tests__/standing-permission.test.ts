/**
 * B6 — the honest version of "stop asking me every time".
 *
 * The roadmap's phrasing: a standing "do it" grant per task family, time-boxed
 * and revocable. The permission table already understood such a grant
 * (`elevated` + `ElevationGrant`), and nothing in the system could create one —
 * so the mode existed and could never be reached.
 *
 * The rule that makes it safe is where the grant is BORN: the agent may ask
 * (a card), and only the approve route — reached by Boss pressing Approve —
 * writes it. These tests pin what the asking side may never do.
 */
import { describe, it, expect } from 'vitest'
import { AUTONOMY_TOOLS } from '@/agent/tools/autonomy-tools'
import { TOOL_CLASSIFICATION } from '@/agent/tools/capability-classification'
import { TASK_FAMILIES } from '@/agent/lib/autonomy-task-catalog'

const tool = AUTONOMY_TOOLS.find((t) => t.name === 'request_standing_permission')!

describe('request_standing_permission asks, never grants', () => {
  it('exists and needs the families and the minutes', () => {
    expect(tool).toBeTruthy()
    expect(tool.input_schema.required).toEqual(['families', 'minutes'])
  })

  it('is a staged card, not a write', () => {
    expect(TOOL_CLASSIFICATION.request_standing_permission?.mode).toBe('stage')
  })

  it('tells the head not to widen its own hands mid-task', () => {
    expect(tool.description).toMatch(/NEVER call this to widen your own hands/i)
    expect(tool.description).toMatch(/expires on its own/i)
  })

  it('refuses without a conversation — a grant lives in one', async () => {
    const res = await tool.handler({ families: ['staff-messaging'], minutes: 30 })
    expect(res.success).toBe(false)
  })

  it('refuses a family it does not know', async () => {
    const res = await tool.handler({
      families: ['make-me-god'], minutes: 30, conversationId: 'c1',
    })
    expect(res.success).toBe(false)
    expect(String(res.error)).toMatch(/check_autonomy/)
  })

  it('refuses money movement and permissions, whatever the wording', async () => {
    for (const family of ['money-movement', 'security-permissions']) {
      const res = await tool.handler({ families: [family], minutes: 10, conversationId: 'c1' })
      expect(res.success).toBe(false)
    }
  })

  it('refuses every R4 family in the catalog, not just the two named ones', async () => {
    const r4 = TASK_FAMILIES.filter((f) => f.tier === 'R4').map((f) => f.id)
    expect(r4.length).toBeGreaterThan(0)
    for (const family of r4) {
      const res = await tool.handler({ families: [family], minutes: 10, conversationId: 'c1' })
      expect(res.success).toBe(false)
    }
  })

  it('refuses a grant with no end, and one that runs too long', async () => {
    for (const minutes of [0, -5, 24 * 60]) {
      const res = await tool.handler({
        families: ['staff-messaging'], minutes, conversationId: 'c1',
      })
      expect(res.success).toBe(false)
    }
  })

  it('refuses an empty family list rather than asking for a blank permission', async () => {
    const res = await tool.handler({ families: [], minutes: 30, conversationId: 'c1' })
    expect(res.success).toBe(false)
  })
})

/**
 * Live on 2026-08-01: Boss said "stop asking me for the next 15 minutes" in the
 * middle of a staff-dispatch turn. The pinned skill's allowlist withheld
 * `request_standing_permission`, so the head searched for a tool it was already
 * holding and no card was ever staged.
 *
 * Asking is not the thing a skill needs protecting from — it stages a card like
 * any other request, and Boss is the only one who can turn it into a permission.
 */
describe('any skill may ask for a grant', () => {
  it('is in the set every skill keeps', async () => {
    const { ALWAYS_ALLOWED } = await import('@/agent/lib/skill-engine/enforcement')
    expect(ALWAYS_ALLOWED.has('request_standing_permission')).toBe(true)
  })

  it('survives a narrow skill allowlist', async () => {
    const { skillAllowlist } = await import('@/agent/lib/skill-engine/enforcement')
    const allowed = skillAllowlist({ requiredCapabilities: ['get_all_staff'] })
    expect(allowed?.has('request_standing_permission')).toBe(true)
  })
})
