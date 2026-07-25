import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  agentKvSetting: { findMany: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import { findSetting, gatewayConfigPayload, validateSetting, warningFor } from '@/agent/lib/phone-settings'
import { parseRegistrations } from '@/agent/lib/phone-provider'

const def = (key: string) => {
  const d = findSetting(key)
  if (!d) throw new Error(`no such setting: ${key}`)
  return d
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.agentKvSetting.findMany.mockResolvedValue([])
  process.env.OWNER_PHONE_NUMBERS = '01779640373'
})

describe('validateSetting', () => {
  it('keeps office hours in a shape the inbound route can parse', () => {
    expect(validateSetting(def('office_hours_dhaka'), '10-21')).toBeNull()
    // A wrapping window is legal — the route handles 22-6 deliberately.
    expect(validateSetting(def('office_hours_dhaka'), '22-6')).toBeNull()
    expect(validateSetting(def('office_hours_dhaka'), '10:00-21:00')).not.toBeNull()
    expect(validateSetting(def('office_hours_dhaka'), '10-25')).not.toBeNull()
    // Start == end would mean the office never opens, which is never what anyone meant.
    expect(validateSetting(def('office_hours_dhaka'), '10-10')).not.toBeNull()
  })

  it('refuses a blocklist containing the owner, whose own calls must always be answered', () => {
    expect(validateSetting(def('blocked_callers'), '01700000000')).toBeNull()
    // Same number, three ways of writing it — the match is on the last nine digits.
    for (const form of ['01779640373', '+8801779640373', '8801779640373']) {
      expect(validateSetting(def('blocked_callers'), form)).not.toBeNull()
    }
  })

  it('takes the forms the dialplan can actually terminate, and nothing shorter', () => {
    expect(validateSetting(def('phone_forward_support'), '01712345678')).toBeNull()
    expect(validateSetting(def('phone_forward_support'), '+8801712345678')).toBeNull()
    // BD landlines are shorter than mobiles, so the floor is ten digits, not eleven.
    expect(validateSetting(def('phone_forward_support'), '0241234567')).toBeNull()
    // Internal staff extensions are four digits and are legal ring-group members.
    expect(validateSetting(def('phone_forward_support'), '1001, 01712345678')).toBeNull()
    expect(validateSetting(def('phone_forward_support'), '017123')).not.toBeNull()
  })

  it('holds numbers inside the range the gateway will accept', () => {
    expect(validateSetting(def('phone_ring_rounds'), '2')).toBeNull()
    expect(validateSetting(def('phone_ring_rounds'), '0')).not.toBeNull()
    expect(validateSetting(def('phone_ring_rounds'), '9')).not.toBeNull()
    expect(validateSetting(def('phone_ring_rounds'), '2.5')).not.toBeNull()
  })

  it('warns past the trunk limit without refusing it', () => {
    const concurrency = def('phone_max_concurrent')
    expect(validateSetting(concurrency, '3')).toBeNull()
    expect(warningFor(concurrency, '3')).not.toBeNull()
    expect(warningFor(concurrency, '2')).toBeNull()
  })

  it('takes holidays only as real ISO dates', () => {
    expect(validateSetting(def('phone_holidays'), '2026-08-15, 2026-09-05')).toBeNull()
    expect(validateSetting(def('phone_holidays'), '')).toBeNull()
    expect(validateSetting(def('phone_holidays'), '15/08/2026')).not.toBeNull()
  })
})

describe('gatewayConfigPayload', () => {
  it('falls back to the env when no row is saved, so an empty table changes nothing', async () => {
    process.env.SIP_TRANSFER_ROUNDS = '3'
    const config = await gatewayConfigPayload()
    expect(config.transferRounds).toBe(3)
    expect(config.ringTimeout).toBe(45)
    delete process.env.SIP_TRANSFER_ROUNDS
  })

  it('never carries an audio-tuning value — those are locked in git, not remotely settable', async () => {
    // Asserted as an exact set rather than as a blocklist of words: the guarantee is that
    // NOTHING new reaches the gateway without someone changing this line, so a future phase
    // cannot quietly add SIP_JITTER_FRAMES or the voice name to the pull.
    expect(Object.keys(await gatewayConfigPayload()).sort()).toEqual([
      'blocklist',
      'maxConcurrent',
      'mohClass',
      'ringTimeout',
      'transferRingTimeout',
      'transferRounds',
      'voicemailMaxSecs',
    ])
  })
})

describe('parseRegistrations', () => {
  it('reads their JSON whatever the field names are', () => {
    const rows = parseRegistrations(JSON.stringify({
      data: [{ ip: '31.97.237.40', user_agent: 'Asterisk PBX 20.6.0', expires: '45', time: '09:23:21' }],
    }))
    expect(rows).toHaveLength(1)
    expect(rows[0].ip).toBe('31.97.237.40')
    expect(rows[0].expiresIn).toBe(45)
  })

  it('reads an HTML table by what the cells look like, not by column order', () => {
    const rows = parseRegistrations(`
      <table><tr><th>IP</th><th>UA</th></tr>
      <tr><td>163.227.239.96</td><td>NextGenSwitch v1.0.0</td><td>58</td><td>09:20:21</td></tr></table>`)
    expect(rows).toHaveLength(1)
    // The user agent is the whole point: this string is how the outbound outage was found.
    expect(rows[0].userAgent).toContain('NextGenSwitch')
    expect(rows[0].expiresIn).toBe(58)
  })

  it('returns nothing rather than inventing rows when the response is not a table', () => {
    expect(parseRegistrations('<html><body>Please log in</body></html>')).toHaveLength(0)
    expect(parseRegistrations('not json {')).toHaveLength(0)
  })
})
