import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Pure snooze-window math (no mocks) ────────────────────────────────────────
import {
  isWithinSnoozeWindow,
  computeSnoozeLockUntil,
} from '@/lib/salah/duty-window'

describe('snooze window math', () => {
  const prayer = new Date('2026-07-06T07:30:00.000Z') // arbitrary jamat instant
  const prayerIso = prayer.toISOString()
  const end = new Date(prayer.getTime() + 90 * 60_000) // waqt ends 90 min after jamat
  const endIso = end.toISOString()

  it('opens 15 min before jamat and closes at waqt end', () => {
    const before16 = new Date(prayer.getTime() - 16 * 60_000)
    const before15 = new Date(prayer.getTime() - 15 * 60_000)
    const atEnd = new Date(end.getTime())
    const justBeforeEnd = new Date(end.getTime() - 1000)

    expect(isWithinSnoozeWindow(prayerIso, endIso, before16)).toBe(false) // too early
    expect(isWithinSnoozeWindow(prayerIso, endIso, before15)).toBe(true)  // exactly -15
    expect(isWithinSnoozeWindow(prayerIso, endIso, prayer)).toBe(true)    // at jamat
    expect(isWithinSnoozeWindow(prayerIso, endIso, justBeforeEnd)).toBe(true)
    expect(isWithinSnoozeWindow(prayerIso, endIso, atEnd)).toBe(false)    // window end exclusive
  })

  it('grants the full amount when it fits before waqt end', () => {
    const now = new Date(prayer.getTime()) // 90 min of runway left
    const r = computeSnoozeLockUntil(prayerIso, endIso, 15, now)
    expect(r).not.toBeNull()
    expect(r!.grantedMin).toBe(15)
    expect(r!.lockUntil.toISOString()).toBe(new Date(now.getTime() + 15 * 60_000).toISOString())
  })

  it('caps the lock at waqt end (never past it)', () => {
    const now = new Date(end.getTime() - 10 * 60_000) // only 10 min left
    const r = computeSnoozeLockUntil(prayerIso, endIso, 30, now)
    expect(r).not.toBeNull()
    expect(r!.grantedMin).toBe(10)
    expect(r!.lockUntil.toISOString()).toBe(endIso)
  })

  it('returns null outside the window (no fake lock)', () => {
    const after = new Date(end.getTime() + 60_000)
    expect(computeSnoozeLockUntil(prayerIso, endIso, 15, after)).toBeNull()
    const tooEarly = new Date(prayer.getTime() - 30 * 60_000)
    expect(computeSnoozeLockUntil(prayerIso, endIso, 15, tooEarly)).toBeNull()
  })
})

// ── applySalahButtonSnooze engine (mocked deps) ───────────────────────────────
const mockDb = vi.hoisted(() => ({
  agentSalahOverride: { deleteMany: vi.fn().mockResolvedValue({}), create: vi.fn().mockResolvedValue({}) },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockDb }))

const mockSchedule = vi.hoisted(() => ({ getDhakaSchedule: vi.fn() }))
vi.mock('@/agent/lib/dhaka-schedule', () => mockSchedule)

const mockLock = vi.hoisted(() => ({ setOwnerCallLockUntil: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/owner-call-lock', () => mockLock)

const mockState = vi.hoisted(() => ({
  is30SnoozeUsed: vi.fn(),
  mark30SnoozeUsed: vi.fn().mockResolvedValue(undefined),
  setFollowupState: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/salah/snooze-state', () => mockState)

import { applySalahButtonSnooze } from '@/agent/lib/salah-snooze'

describe('applySalahButtonSnooze', () => {
  const now = new Date('2026-07-06T07:30:00.000Z')
  const prayerStart = new Date(now.getTime()) // in-window: now === jamat
  const waqtEnd = new Date(now.getTime() + 90 * 60_000)

  beforeEach(() => {
    vi.clearAllMocks()
    mockSchedule.getDhakaSchedule.mockResolvedValue({
      dhuhr: { prayerStart, end: waqtEnd },
    })
    mockState.is30SnoozeUsed.mockResolvedValue(false)
  })

  it('15 min: locks call + reminder and owes a re-reminder at expiry', async () => {
    const r = await applySalahButtonSnooze({ waqt: 'dhuhr', minutes: 15, dateYmd: '2026-07-06', now })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.grantedMin).toBe(15)
    // per-waqt override written
    expect(mockDb.agentSalahOverride.deleteMany).toHaveBeenCalledOnce()
    expect(mockDb.agentSalahOverride.create).toHaveBeenCalledOnce()
    // global call lock set to now+15
    const lockArg = mockLock.setOwnerCallLockUntil.mock.calls[0][0] as Date
    expect(lockArg.toISOString()).toBe(new Date(now.getTime() + 15 * 60_000).toISOString())
    // post-snooze follow-up armed at the expiry instant, reminder still owed
    expect(mockState.setFollowupState).toHaveBeenCalledOnce()
    const fu = mockState.setFollowupState.mock.calls[0][2]
    expect(fu.remindAt).toBe(new Date(now.getTime() + 15 * 60_000).toISOString())
    expect(fu.callAt).toBeNull()
    // 15 min NEVER consumes the 30-min allowance
    expect(mockState.mark30SnoozeUsed).not.toHaveBeenCalled()
  })

  it('30 min: works once, then is refused for the same waqt', async () => {
    const first = await applySalahButtonSnooze({ waqt: 'dhuhr', minutes: 30, dateYmd: '2026-07-06', now })
    expect(first.ok).toBe(true)
    expect(mockState.mark30SnoozeUsed).toHaveBeenCalledOnce()

    // second attempt: 30 already used
    mockState.is30SnoozeUsed.mockResolvedValue(true)
    const second = await applySalahButtonSnooze({ waqt: 'dhuhr', minutes: 30, dateYmd: '2026-07-06', now })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.reason).toBe('thirty_used')
    expect(second.thirtyUsed).toBe(true)
  })

  it('15 min still works after 30 is spent', async () => {
    mockState.is30SnoozeUsed.mockResolvedValue(true) // 30 already used
    const r = await applySalahButtonSnooze({ waqt: 'dhuhr', minutes: 15, dateYmd: '2026-07-06', now })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.grantedMin).toBe(15)
  })

  it('refuses (no fake lock) outside the snooze window', async () => {
    const late = new Date(waqtEnd.getTime() + 60_000)
    const r = await applySalahButtonSnooze({ waqt: 'dhuhr', minutes: 15, dateYmd: '2026-07-06', now: late })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('outside_window')
    expect(mockLock.setOwnerCallLockUntil).not.toHaveBeenCalled()
  })
})
