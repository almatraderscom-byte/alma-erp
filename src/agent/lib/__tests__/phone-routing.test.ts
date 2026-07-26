import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  agentKvSetting: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
  agentVoiceCall: { groupBy: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import { decideInbound, decideTime, dhakaParts, routeForDid, type DidRoute } from '@/agent/lib/phone-routing'
import { applyOutboundRules } from '@/agent/lib/phone-settings'

/** A Dhaka wall-clock instant. Bangladesh is UTC+6 with no daylight saving. */
const dhaka = (ymd: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + (h - 6) * 3_600_000 + m * 60_000)
}

// 2026-07-26 is a Sunday; 2026-07-31 is a Friday.
const SUNDAY = '2026-07-26'
const FRIDAY = '2026-07-31'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.OWNER_PHONE_NUMBERS = '01779640373'
  delete process.env.SIP_OFFICE_HOURS
})

describe('dhakaParts', () => {
  it('reads the Dhaka wall clock, not UTC', () => {
    // 20:00 UTC is 02:00 the NEXT day in Dhaka — the case a naive UTC read gets wrong.
    const p = dhakaParts(new Date('2026-07-26T20:00:00Z'))
    expect(p.ymd).toBe('2026-07-27')
    expect(p.hour).toBe(2)
    expect(p.weekday).toBe('mon')
  })
})

describe('decideTime', () => {
  const hours = { office_hours_dhaka: '10-21' }

  it('opens and closes on the ordinary window', () => {
    expect(decideTime(hours, dhaka(SUNDAY, '11:00')).open).toBe(true)
    expect(decideTime(hours, dhaka(SUNDAY, '21:30')).open).toBe(false)
    expect(decideTime(hours, dhaka(SUNDAY, '09:59')).open).toBe(false)
  })

  it('handles a window that wraps midnight', () => {
    expect(decideTime({ office_hours_dhaka: '22-6' }, dhaka(SUNDAY, '23:00')).open).toBe(true)
    expect(decideTime({ office_hours_dhaka: '22-6' }, dhaka(SUNDAY, '03:00')).open).toBe(true)
    expect(decideTime({ office_hours_dhaka: '22-6' }, dhaka(SUNDAY, '12:00')).open).toBe(false)
  })

  it('lets a holiday beat the hours, at any hour', () => {
    const v = decideTime({ ...hours, phone_holidays: SUNDAY }, dhaka(SUNDAY, '11:00'))
    expect(v.open).toBe(false)
    expect(v.rule).toBe('holiday')
  })

  it('lets a weekly off-day beat the hours', () => {
    const v = decideTime({ ...hours, phone_weekly_offdays: 'fri' }, dhaka(FRIDAY, '11:00'))
    expect(v.open).toBe(false)
    expect(v.rule).toBe('weekly_offday')
    // And an ordinary day is untouched by the same setting.
    expect(decideTime({ ...hours, phone_weekly_offdays: 'fri' }, dhaka(SUNDAY, '11:00')).open).toBe(true)
  })

  it('applies a special window inside its date range only', () => {
    const s = { ...hours, phone_special_hours: '2026-07-20..2026-07-28=10-16' }
    // 17:00 is open on the ordinary window and closed on the Ramadan-style one.
    expect(decideTime(s, dhaka(SUNDAY, '17:00')).open).toBe(false)
    expect(decideTime(s, dhaka(SUNDAY, '17:00')).rule).toBe('special_hours')
    expect(decideTime(s, dhaka('2026-08-05', '17:00')).open).toBe(true)
  })

  it('ranks a holiday above a special window above the ordinary hours', () => {
    const s = { ...hours, phone_holidays: SUNDAY, phone_special_hours: `${SUNDAY}..${SUNDAY}=10-16` }
    expect(decideTime(s, dhaka(SUNDAY, '11:00')).rule).toBe('holiday')
  })
})

describe('decideInbound', () => {
  const routes: DidRoute[] = [
    { did: '09649777738', label: 'বস', line: 'boss', allowTransfer: true },
    { did: '09649777739', label: 'সাপোর্ট', line: 'support', forwardSupport: '01888888888', allowTransfer: true },
  ]
  const settings = {
    office_hours_dhaka: '10-21',
    phone_forward_support: '01868996666',
    phone_forward_boss: '01779640373',
    inbound_transfer_mode: 'direct',
  }
  const base = { caller: '01712345678', did: '09649777738', owner: false, settings, routes }

  it('uses the DID row and its own forward number', () => {
    const d = decideInbound({ ...base, did: '09649777739', at: dhaka(SUNDAY, '12:00') })
    expect(d.route?.line).toBe('support')
    expect(d.forwardSupport).toBe('01888888888')
  })

  it('matches a DID on its last nine digits, so +880 forms still find their row', () => {
    expect(routeForDid(routes, '+8809649777739')?.label).toBe('সাপোর্ট')
  })

  it('falls back to the global forward numbers when the row has none', () => {
    const d = decideInbound({ ...base, at: dhaka(SUNDAY, '12:00') })
    expect(d.forwardSupport).toBe('01868996666')
  })

  it('takes a message instead of ringing an empty desk after hours', () => {
    const d = decideInbound({ ...base, at: dhaka(SUNDAY, '22:00') })
    expect(d.time.open).toBe(false)
    expect(d.transferMode).toBe('ask_first')
  })

  it('never blocks the owner and never sends him after-hours handling', () => {
    const d = decideInbound({
      ...base,
      caller: '01779640373',
      owner: true,
      at: dhaka(SUNDAY, '23:00'),
      settings: { ...settings, blocked_callers: '01779640373' },
    })
    expect(d.blocked).toBe(false)
    expect(d.transferMode).toBe('direct')
  })

  it('blocks a listed caller whatever form the number is written in', () => {
    for (const form of ['01712345678', '+8801712345678', '880 1712345678']) {
      const d = decideInbound({ ...base, at: dhaka(SUNDAY, '12:00'), settings: { ...settings, blocked_callers: form } })
      expect(d.blocked).toBe(true)
    }
  })

  it('honours a line marked as never-transfer, even in office hours', () => {
    const noTransfer: DidRoute[] = [{ did: '09649777738', label: 'শুধু AI', line: 'support', allowTransfer: false }]
    const d = decideInbound({ ...base, routes: noTransfer, at: dhaka(SUNDAY, '12:00') })
    expect(d.transferMode).toBe('ask_first')
  })

  it('always says what would happen, in words', () => {
    const d = decideInbound({ ...base, at: dhaka(SUNDAY, '12:00') })
    expect(d.outcome.length).toBeGreaterThan(10)
  })
})

describe('applyOutboundRules', () => {
  const plain = { destPolicy: 'bd_all', outboundStrip: '', outboundPrefix: '' }

  it('normalises every BD form to what Asterisk actually dials', () => {
    for (const input of ['01712345678', '+8801712345678', '8801712345678', '017-1234 5678']) {
      const r = applyOutboundRules(input, plain)
      expect(r.dialled).toBe('01712345678')
      expect(r.allowed).toBe(true)
    }
  })

  it('refuses anything that is not a BD destination', () => {
    expect(applyOutboundRules('00447700900123', plain).allowed).toBe(false)
    expect(applyOutboundRules('12345', plain).allowed).toBe(false)
  })

  it('allows internal extensions under every policy', () => {
    for (const destPolicy of ['bd_all', 'bd_mobile', 'internal_only']) {
      expect(applyOutboundRules('1001', { ...plain, destPolicy }).allowed).toBe(true)
    }
  })

  it('narrows to mobiles, and to nothing but internal, on request', () => {
    expect(applyOutboundRules('0241234567', { ...plain, destPolicy: 'bd_mobile' }).allowed).toBe(false)
    expect(applyOutboundRules('01712345678', { ...plain, destPolicy: 'bd_mobile' }).allowed).toBe(true)
    expect(applyOutboundRules('01712345678', { ...plain, destPolicy: 'internal_only' }).allowed).toBe(false)
  })

  it('applies strip then prefix, and reports the number that would really be dialled', () => {
    const r = applyOutboundRules('901712345678', { destPolicy: 'bd_all', outboundStrip: '9', outboundPrefix: '' })
    expect(r.dialled).toBe('01712345678')
    expect(r.allowed).toBe(true)
    // A prefix that makes the number un-dialable is caught here rather than on a live call.
    expect(applyOutboundRules('01712345678', { ...plain, outboundPrefix: '99' }).allowed).toBe(false)
  })
})
