import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma + notify BEFORE importing the module under test.
const mockPrisma = vi.hoisted(() => ({
  agentKvSetting: { findUnique: vi.fn(), upsert: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

const mockNotify = vi.hoisted(() => ({ notifyOwner: vi.fn().mockResolvedValue({ channels: [], statuses: {} }) }))
vi.mock('@/agent/lib/notify-owner', () => mockNotify)

import {
  isQuietHoursDhaka,
  shouldHold,
  dhakaHour,
  maybeHoldForQuietHours,
  flushQuietHoursQueue,
  quietHoursStatus,
  DND_QUEUE_KEY,
  type QuietHoursConfig,
} from '@/agent/lib/quiet-hours'

/** Build a Date that reads as a given Dhaka wall-clock hour (Dhaka = UTC+6). */
function dhakaAt(hour: number): Date {
  // UTC = Dhaka - 6. Pick a midday UTC base so no day-wrap surprises.
  return new Date(Date.UTC(2026, 5, 29, (hour - 6 + 24) % 24, 0, 0))
}

const ON: QuietHoursConfig = { enabled: true, startHour: 22, endHour: 8 }

describe('dhakaHour — wall-clock hour in Asia/Dhaka', () => {
  it('maps a UTC instant to the Dhaka hour (+6)', () => {
    expect(dhakaHour(dhakaAt(23))).toBe(23)
    expect(dhakaHour(dhakaAt(2))).toBe(2)
    expect(dhakaHour(dhakaAt(8))).toBe(8)
  })
})

describe('isQuietHoursDhaka — overnight window 22→8 wraps midnight', () => {
  it('quiet late at night (≥ start)', () => {
    expect(isQuietHoursDhaka(dhakaAt(22), ON)).toBe(true)
    expect(isQuietHoursDhaka(dhakaAt(23), ON)).toBe(true)
  })
  it('quiet in the small hours (< end)', () => {
    expect(isQuietHoursDhaka(dhakaAt(0), ON)).toBe(true)
    expect(isQuietHoursDhaka(dhakaAt(7), ON)).toBe(true)
  })
  it('NOT quiet during the day', () => {
    expect(isQuietHoursDhaka(dhakaAt(8), ON)).toBe(false) // boundary: end is exclusive
    expect(isQuietHoursDhaka(dhakaAt(12), ON)).toBe(false)
    expect(isQuietHoursDhaka(dhakaAt(21), ON)).toBe(false)
  })
  it('disabled config → never quiet', () => {
    expect(isQuietHoursDhaka(dhakaAt(2), { ...ON, enabled: false })).toBe(false)
  })
  it('degenerate window (start === end) → never quiet', () => {
    expect(isQuietHoursDhaka(dhakaAt(2), { enabled: true, startHour: 8, endHour: 8 })).toBe(false)
  })
  it('same-day window (9→17) does NOT wrap', () => {
    const day: QuietHoursConfig = { enabled: true, startHour: 9, endHour: 17 }
    expect(isQuietHoursDhaka(dhakaAt(12), day)).toBe(true)
    expect(isQuietHoursDhaka(dhakaAt(8), day)).toBe(false)
    expect(isQuietHoursDhaka(dhakaAt(20), day)).toBe(false)
  })
})

describe('shouldHold — what is held vs what pierces DND', () => {
  it('not quiet → never hold', () => {
    expect(shouldHold(1, undefined, false)).toBe(false)
    expect(shouldHold(2, 'report', false)).toBe(false)
  })
  it('quiet + routine tier-1/2 → hold', () => {
    expect(shouldHold(1, 'report', true)).toBe(true)
    expect(shouldHold(2, 'urgent', true)).toBe(true)
  })
  it('tier-3 emergency pierces DND (never held)', () => {
    expect(shouldHold(3, 'urgent', true)).toBe(false)
  })
  it('salah reminders pierce DND (time-critical)', () => {
    expect(shouldHold(1, 'salah', true)).toBe(false)
  })
})

describe('maybeHoldForQuietHours — gate behaviour', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.agentKvSetting.upsert.mockResolvedValue({})
  })

  it('holds a routine night ping and enqueues it', async () => {
    // DND enabled (default), window default 22-8, and it is night now.
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue(null) // settings default
    vi.useFakeTimers()
    vi.setSystemTime(dhakaAt(2))
    const held = await maybeHoldForQuietHours({ tier: 1, title: 'রুটিন', message: 'টুকিটাকি', category: 'report' })
    vi.useRealTimers()
    expect(held).toBe(true)
    expect(mockPrisma.agentKvSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: DND_QUEUE_KEY } }),
    )
  })

  it('does NOT hold a tier-3 emergency even at night', async () => {
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue(null)
    vi.useFakeTimers()
    vi.setSystemTime(dhakaAt(2))
    const held = await maybeHoldForQuietHours({ tier: 3, title: 'জরুরি', message: 'worker down', category: 'urgent' })
    vi.useRealTimers()
    expect(held).toBe(false)
    expect(mockPrisma.agentKvSetting.upsert).not.toHaveBeenCalled()
  })

  it('fail-OPEN: a KV error returns false (send normally, never swallow)', async () => {
    mockPrisma.agentKvSetting.findUnique.mockRejectedValue(new Error('db down'))
    vi.useFakeTimers()
    vi.setSystemTime(dhakaAt(2))
    const held = await maybeHoldForQuietHours({ tier: 1, title: 'x', message: 'y', category: 'report' })
    vi.useRealTimers()
    expect(held).toBe(false)
  })
})

describe('flushQuietHoursQueue — morning digest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.agentKvSetting.upsert.mockResolvedValue({})
  })

  it('no held items → nothing sent', async () => {
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue(null)
    const res = await flushQuietHoursQueue()
    expect(res.flushed).toBe(0)
    expect(mockNotify.notifyOwner).not.toHaveBeenCalled()
  })

  it('held items → ONE consolidated digest (bypassing the gate) then clears queue', async () => {
    const queue = [
      { tier: 1, title: 'A', message: 'aa', category: 'report', heldAt: '2026-06-29T18:30:00Z' },
      { tier: 2, title: 'B', message: 'bb', category: 'urgent', heldAt: '2026-06-29T20:00:00Z' },
    ]
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue({ value: JSON.stringify(queue) })
    const res = await flushQuietHoursQueue()
    expect(res.flushed).toBe(2)
    expect(mockNotify.notifyOwner).toHaveBeenCalledTimes(1)
    expect(mockNotify.notifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 1, category: 'report', _bypassQuietHours: true, actionUrl: '/agent' }),
    )
    // Queue cleared (upsert with empty array).
    expect(mockPrisma.agentKvSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { value: JSON.stringify([]) } }),
    )
  })

  it('digest tap targets the single held actionUrl when all held items share one', async () => {
    const queue = [
      { tier: 1, title: 'A', message: 'aa', category: 'report', actionUrl: '/orders', heldAt: '2026-06-29T18:30:00Z' },
      { tier: 1, title: 'B', message: 'bb', category: 'report', actionUrl: '/orders', heldAt: '2026-06-29T20:00:00Z' },
    ]
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue({ value: JSON.stringify(queue) })
    await flushQuietHoursQueue()
    expect(mockNotify.notifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ actionUrl: '/orders' }),
    )
  })
})

describe('maybeHoldForQuietHours — actionUrl survives the hold', () => {
  it('enqueues the held push WITH its actionUrl', async () => {
    vi.clearAllMocks()
    mockPrisma.agentKvSetting.upsert.mockResolvedValue({})
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue(null)
    vi.useFakeTimers()
    vi.setSystemTime(dhakaAt(2))
    const held = await maybeHoldForQuietHours({ tier: 1, title: 'x', message: 'y', category: 'report', actionUrl: '/agent/live-watch' })
    vi.useRealTimers()
    expect(held).toBe(true)
    const call = mockPrisma.agentKvSetting.upsert.mock.calls[0][0] as { update: { value: string } }
    const stored = JSON.parse(call.update.value) as Array<{ actionUrl?: string | null }>
    expect(stored[0].actionUrl).toBe('/agent/live-watch')
  })
})

describe('quietHoursStatus — read-only snapshot', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports enabled window + held count', async () => {
    mockPrisma.agentKvSetting.findUnique.mockImplementation(({ where }: { where: { key: string } }) => {
      if (where.key === DND_QUEUE_KEY) {
        return Promise.resolve({ value: JSON.stringify([{ tier: 1, title: 'held-1', message: 'm', heldAt: '2026-06-29T18:00:00Z' }]) })
      }
      return Promise.resolve(null) // default settings
    })
    const s = await quietHoursStatus(dhakaAt(2))
    expect(s.enabled).toBe(true)
    expect(s.windowDhaka).toBe('22:00–8:00')
    expect(s.isQuietNow).toBe(true)
    expect(s.heldCount).toBe(1)
    expect(s.heldPreview).toEqual(['held-1'])
  })
})
