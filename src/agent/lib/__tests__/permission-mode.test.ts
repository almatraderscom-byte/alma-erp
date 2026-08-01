/**
 * PM-0 — the permission table, pinned.
 *
 * The two invariants worth failing CI over: R4 is owner-only in every mode, and
 * R3 never runs without a card unless a live, family-scoped, expiring grant says
 * so. Everything else in this system leans on those two lines.
 */
import { describe, it, expect } from 'vitest'
import {
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  normalizePermissionMode,
  narrowerMode,
  modeVerdict,
  minimumModeFor,
  autoModeFor,
  adviseForAction,
  permissionModeNote,
  isElevationGrantLive,
  type PermissionMode,
  isFamilyGrantLive,
} from '@/agent/lib/permission-mode'
import type { RiskTier } from '@/agent/lib/autonomy-task-catalog'

const TIERS: RiskTier[] = ['R0', 'R1', 'R2', 'R3', 'R4']
const NOW = Date.parse('2026-07-27T12:00:00Z')

describe('the invariants', () => {
  it('R4 is owner-only in EVERY mode', () => {
    for (const mode of PERMISSION_MODES) {
      expect(modeVerdict({ mode, tier: 'R4' })).toBe('owner_only')
    }
  })

  it('R4 is owner-only even with an elevation grant naming it', () => {
    expect(modeVerdict({
      mode: 'elevated',
      tier: 'R4',
      taskClass: 'money-movement',
      grant: { families: ['money-movement'], expiresAt: '2099-01-01T00:00:00Z' },
      now: NOW,
    })).toBe('owner_only')
  })

  it('R3 needs a card in every mode except a live, named elevation', () => {
    for (const mode of PERMISSION_MODES) {
      const v = modeVerdict({ mode, tier: 'R3' })
      expect(v === 'card' || v === 'blocked').toBe(true)
    }
  })

  it('no mode unlocks R4, so there is no mode to suggest', () => {
    expect(minimumModeFor('R4')).toBeNull()
    expect(autoModeFor('R4')).toBeNull()
    expect(autoModeFor('R3')).toBeNull()
  })
})

describe('the table', () => {
  const table: Record<PermissionMode, Record<RiskTier, string>> = {
    plan: { R0: 'auto', R1: 'blocked', R2: 'blocked', R3: 'blocked', R4: 'owner_only' },
    careful: { R0: 'auto', R1: 'card', R2: 'card', R3: 'card', R4: 'owner_only' },
    standard: { R0: 'auto', R1: 'auto', R2: 'auto', R3: 'card', R4: 'owner_only' },
    supervised: { R0: 'auto', R1: 'auto', R2: 'auto', R3: 'card', R4: 'owner_only' },
    elevated: { R0: 'auto', R1: 'auto', R2: 'auto', R3: 'card', R4: 'owner_only' },
  }

  for (const mode of PERMISSION_MODES) {
    it(`${mode} matches the published table`, () => {
      for (const tier of TIERS) {
        expect(`${mode}/${tier}=${modeVerdict({ mode, tier })}`).toBe(`${mode}/${tier}=${table[mode][tier]}`)
      }
    })
  }

  it('supervised has the same AUTHORITY as standard — only the behaviour differs', () => {
    for (const tier of TIERS) {
      expect(modeVerdict({ mode: 'supervised', tier })).toBe(modeVerdict({ mode: 'standard', tier }))
    }
  })
})

describe('time-boxed elevation', () => {
  const live = { families: ['public-publish'], expiresAt: '2026-07-27T12:30:00Z' }
  const expired = { families: ['public-publish'], expiresAt: '2026-07-27T11:00:00Z' }

  it('lifts R3 only for the named family, only while live', () => {
    expect(modeVerdict({ mode: 'elevated', tier: 'R3', taskClass: 'public-publish', grant: live, now: NOW })).toBe('auto')
    expect(modeVerdict({ mode: 'elevated', tier: 'R3', taskClass: 'customer-messaging', grant: live, now: NOW })).toBe('card')
    expect(modeVerdict({ mode: 'elevated', tier: 'R3', taskClass: 'public-publish', grant: expired, now: NOW })).toBe('card')
    expect(modeVerdict({ mode: 'elevated', tier: 'R3', taskClass: 'public-publish', grant: null, now: NOW })).toBe('card')
  })

  it('a grant without an expiry or without families is not a grant', () => {
    expect(isElevationGrantLive({ families: ['public-publish'], expiresAt: '' }, NOW)).toBe(false)
    expect(isElevationGrantLive({ families: [], expiresAt: '2099-01-01T00:00:00Z' }, NOW)).toBe(false)
    expect(isElevationGrantLive(null, NOW)).toBe(false)
  })
})

describe('inheritance — a sub-agent may never exceed its parent', () => {
  it('picks the more restrictive of two modes', () => {
    expect(narrowerMode('elevated', 'plan')).toBe('plan')
    expect(narrowerMode('standard', 'careful')).toBe('careful')
    expect(narrowerMode('supervised', 'supervised')).toBe('supervised')
    expect(narrowerMode('plan', 'careful')).toBe('plan')
  })
})

describe('the mode advisor', () => {
  it('a Plan-mode refusal names the mode, the reason and the way out', () => {
    const a = adviseForAction({ mode: 'plan', tier: 'R1', whatBn: 'SEO কপি আপডেট' })
    expect(a.verdict).toBe('blocked')
    expect(a.blockedByMode).toBe(true)
    expect(a.suggestedMode).toBe('careful')
    expect(a.reasonBn).toContain('প্ল্যান')
    expect(a.reasonBn).toContain('সতর্ক')
    expect(a.reasonBn).toContain('SEO কপি আপডেট')
  })

  it('never dangles a mode that would not actually help, for R3', () => {
    const a = adviseForAction({ mode: 'standard', tier: 'R3', whatBn: 'কাস্টমারকে মেসেজ' })
    expect(a.verdict).toBe('card')
    expect(a.suggestedMode).toBeNull()
    expect(a.reasonBn).toContain('আপনার অনুমোদনেই হবে')
  })

  it('offers the no-more-asking mode when one genuinely exists', () => {
    const a = adviseForAction({ mode: 'careful', tier: 'R1', whatBn: 'স্মৃতিতে রাখা' })
    expect(a.verdict).toBe('card')
    expect(a.suggestedMode).toBe('standard')
    expect(a.reasonBn).toContain('স্বাভাবিক')
  })

  it('says plainly that R4 is his, in any mode', () => {
    const a = adviseForAction({ mode: 'elevated', tier: 'R4', whatBn: 'টাকা পাঠানো' })
    expect(a.blockedByMode).toBe(false)
    expect(a.suggestedMode).toBeNull()
    expect(a.reasonBn).toContain('মোড বদলালেও')
  })

  it('says nothing when the mode already allows it', () => {
    expect(adviseForAction({ mode: 'standard', tier: 'R1' }).reasonBn).toBe('')
  })
})

describe('the per-turn banner', () => {
  it('is marked internal and states the mode', () => {
    for (const mode of PERMISSION_MODES) {
      const note = permissionModeNote(mode)
      expect(note.startsWith('[INTERNAL CONTROL')).toBe(true)
      expect(note).toContain('NOT a new Boss message')
      expect(note).toContain('অনুমতি মোড')
    }
  })

  it('tells the agent to name the mode instead of answering vaguely, and never to switch it', () => {
    const note = permissionModeNote('plan')
    expect(note).toContain('গোলমেলে উত্তর দিও না')
    expect(note).toContain('মোড তুমি নিজে বদলাবে না')
  })

  it('shows what a LIVE grant covers and until when', () => {
    // A fixed past timestamp used to pass here; the banner now filters expired
    // families, which is the point — it must never advertise a permission the
    // execution checks would refuse.
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString()
    const note = permissionModeNote('elevated', { families: ['public-publish'], expiresAt })
    expect(note).toContain('public-publish')
    expect(note).toContain(expiresAt)
  })
})

describe('housekeeping', () => {
  it('defaults to স্বাভাবিক and never to the loosest mode', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('standard')
    expect(normalizePermissionMode('nonsense')).toBe('standard')
    expect(normalizePermissionMode(undefined)).toBe('standard')
    expect(normalizePermissionMode('elevated')).toBe('elevated')
  })
})

/**
 * B6 review-bot P1 (#667): reaching a grant by switching the whole conversation
 * to `elevated` was a much larger promise than the card made. From Careful, that
 * one switch also stopped asking about every unrelated R1/R2 write. A grant for
 * one family must mean one family.
 */
describe('a family-scoped grant sits ON TOP of the mode, not instead of it', () => {
  const live = { families: ['staff-messaging'], expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const now = Date.now()

  it('lifts the card for the family it names, even under Careful', () => {
    expect(modeVerdict({ mode: 'careful', tier: 'R3', taskClass: 'staff-messaging', grant: live, now }))
      .toBe('auto')
  })

  it('leaves every other family exactly as Careful had it', () => {
    expect(modeVerdict({ mode: 'careful', tier: 'R1', taskClass: 'internal-reminders', grant: live, now }))
      .toBe('card')
    expect(modeVerdict({ mode: 'careful', tier: 'R3', taskClass: 'public-publish', grant: live, now }))
      .toBe('card')
  })

  it('never touches R4, grant or no grant', () => {
    const withMoney = { families: ['money-movement'], expiresAt: live.expiresAt }
    expect(modeVerdict({ mode: 'standard', tier: 'R4', taskClass: 'money-movement', grant: withMoney, now }))
      .toBe('owner_only')
  })

  it('does not un-plan Plan mode', () => {
    expect(modeVerdict({ mode: 'plan', tier: 'R3', taskClass: 'staff-messaging', grant: live, now }))
      .toBe('blocked')
  })

  it('is over the moment it expires', () => {
    const dead = { families: ['staff-messaging'], expiresAt: new Date(now - 1000).toISOString() }
    expect(modeVerdict({ mode: 'careful', tier: 'R3', taskClass: 'staff-messaging', grant: dead, now }))
      .toBe('card')
  })
})

/** Review-bot round 2 on #667 — two grants, two clocks. */
describe('each family keeps the window it was given', () => {
  const now = Date.now()
  const grant = {
    families: ['staff-messaging', 'customer-messaging'],
    expiresAt: new Date(now + 4 * 60 * 60_000).toISOString(),
    windows: {
      'staff-messaging': new Date(now + 15 * 60_000).toISOString(),
      'customer-messaging': new Date(now + 4 * 60 * 60_000).toISOString(),
    },
  }

  it('does not extend the short grant to the long one’s cutoff', () => {
    expect(isFamilyGrantLive(grant, 'staff-messaging', now + 20 * 60_000)).toBe(false)
    expect(isFamilyGrantLive(grant, 'customer-messaging', now + 20 * 60_000)).toBe(true)
  })

  it('reads the per-family window in the verdict', () => {
    expect(modeVerdict({ mode: 'standard', tier: 'R3', taskClass: 'staff-messaging', grant, now: now + 20 * 60_000 }))
      .toBe('card')
    expect(modeVerdict({ mode: 'standard', tier: 'R3', taskClass: 'customer-messaging', grant, now: now + 20 * 60_000 }))
      .toBe('auto')
  })

  it('falls back to the grant-wide cutoff for older rows without windows', () => {
    const old = { families: ['staff-messaging'], expiresAt: new Date(now + 60_000).toISOString() }
    expect(isFamilyGrantLive(old, 'staff-messaging', now)).toBe(true)
    expect(isFamilyGrantLive(old, 'staff-messaging', now + 120_000)).toBe(false)
  })
})

/** Review-bot P2 (#667 round 5): the row outlives the permission. */
describe('the banner names only families that are still live', () => {
  const now = Date.now()
  it('drops an expired family and keeps the live one', () => {
    const grant = {
      families: ['staff-messaging', 'customer-messaging'],
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
      windows: {
        'staff-messaging': new Date(now - 60_000).toISOString(),
        'customer-messaging': new Date(now + 60 * 60_000).toISOString(),
      },
    }
    const note = permissionModeNote('standard', grant)
    expect(note).toContain('customer-messaging')
    expect(note).not.toContain('staff-messaging')
  })

  it('says nothing about a grant that has fully expired', () => {
    const dead = { families: ['staff-messaging'], expiresAt: new Date(now - 1000).toISOString() }
    expect(permissionModeNote('standard', dead)).not.toContain('সময়-বাঁধা অনুমতি চালু')
  })
})

/** Review-bot P2 (#667 round 15): a half-written windows map must not widen. */
describe('a family without its own window is not granted', () => {
  it('drops the family whose window is missing or malformed', async () => {
    const { parseElevationGrant } = await import('@/agent/lib/permission-mode')
    const now = Date.now()
    const grant = parseElevationGrant({
      families: ['staff-messaging', 'customer-messaging'],
      expiresAt: new Date(now + 4 * 60 * 60_000).toISOString(),
      windows: {
        'staff-messaging': 'not-a-date',
        'customer-messaging': new Date(now + 4 * 60 * 60_000).toISOString(),
      },
    })
    expect(grant?.families).toEqual(['customer-messaging'])
    expect(isFamilyGrantLive(grant, 'staff-messaging', now)).toBe(false)
  })

  it('keeps the old shape working — no windows means the grant-wide cutoff', async () => {
    const { parseElevationGrant } = await import('@/agent/lib/permission-mode')
    const now = Date.now()
    const grant = parseElevationGrant({
      families: ['staff-messaging'],
      expiresAt: new Date(now + 60_000).toISOString(),
    })
    expect(isFamilyGrantLive(grant, 'staff-messaging', now)).toBe(true)
  })
})
