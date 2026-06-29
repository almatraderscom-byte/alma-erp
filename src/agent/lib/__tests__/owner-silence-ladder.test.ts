import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma + the pending-followup source + notify BEFORE importing the module.
const mockPrisma = vi.hoisted(() => ({
  agentKvSetting: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

const mockPending = vi.hoisted(() => ({ collectPendingItems: vi.fn() }))
vi.mock('@/agent/lib/pending-followup', () => mockPending)

const mockNotify = vi.hoisted(() => ({ notifyOwner: vi.fn().mockResolvedValue({ channels: [], statuses: {} }) }))
vi.mock('@/agent/lib/notify-owner', () => mockNotify)

vi.mock('@/lib/agent-api/dhaka-date', () => ({ todayYmdDhaka: () => '2026-06-29' }))

import {
  computeSilenceEscalation,
  runOwnerSilenceLadder,
  LADDER_L1_MIN,
  LADDER_L2_MIN,
  type PendingLike,
} from '@/agent/lib/owner-silence-ladder'

const NOW = Date.parse('2026-06-29T12:00:00Z')
function agedItem(minutes: number, type = 'dispatch_staff_tasks', summary = ''): PendingLike {
  return { type, summary, createdAt: new Date(NOW - minutes * 60_000) }
}

describe('computeSilenceEscalation — the rung is driven by how long the oldest item waits', () => {
  it('empty pending set → L0, nothing extra', () => {
    const esc = computeSilenceEscalation([], NOW)
    expect(esc.level).toBe(0)
    expect(esc.channel).toBe('none')
  })

  it('a fresh item stays at L0 (normal Telegram nudge handles it)', () => {
    const esc = computeSilenceEscalation([agedItem(20)], NOW)
    expect(esc.level).toBe(0)
  })

  it(`crosses to L1 (loud ntfy-critical) at ${LADDER_L1_MIN} min of silence`, () => {
    expect(computeSilenceEscalation([agedItem(LADDER_L1_MIN - 1)], NOW).level).toBe(0)
    const esc = computeSilenceEscalation([agedItem(LADDER_L1_MIN)], NOW)
    expect(esc.level).toBe(1)
    expect(esc.channel).toBe('ntfy_critical')
    expect(esc.callWarranted).toBe(false)
  })

  it(`a money/critical-type item at ${LADDER_L2_MIN} min reaches L2 (call-worthy)`, () => {
    const esc = computeSilenceEscalation([agedItem(LADDER_L2_MIN, 'ads_optimizer_batch')], NOW)
    expect(esc.level).toBe(2)
    expect(esc.callWarranted).toBe(true)
    expect(esc.hasCritical).toBe(true)
  })

  it('a NON-critical item at L2 age stays at L1 — phone-tier is reserved for critical', () => {
    const esc = computeSilenceEscalation([agedItem(LADDER_L2_MIN, 'duty_approval_block')], NOW)
    expect(esc.level).toBe(1)
  })

  it('a summary with a money cue (৳/টাকা) is treated as critical', () => {
    const esc = computeSilenceEscalation([agedItem(LADDER_L2_MIN, 'duty_approval_block', 'refund ৳১২০০ ফেরত')], NOW)
    expect(esc.level).toBe(2)
  })

  it('reports the oldest age across a mixed set', () => {
    const esc = computeSilenceEscalation([agedItem(30), agedItem(200, 'ads_optimizer_batch'), agedItem(10)], NOW)
    expect(esc.oldestAgeMin).toBe(200)
    expect(esc.level).toBe(2)
  })
})

describe('runOwnerSilenceLadder — escalates once per rung, resets when clear', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.agentKvSetting.upsert.mockResolvedValue({})
    mockPrisma.agentKvSetting.deleteMany.mockResolvedValue({})
  })

  it('fires the loud alert when it first climbs to L1', async () => {
    mockPending.collectPendingItems.mockResolvedValue([
      { id: 'a', type: 'dispatch_staff_tasks', label: 'স্টাফ কাজ', createdAt: new Date(NOW - LADDER_L1_MIN * 60_000) },
    ])
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue(null) // no prior ladder state
    const res = await runOwnerSilenceLadder({ now: new Date(NOW) })
    expect(res.escalated).toBe(true)
    expect(res.level).toBe(1)
    expect(mockNotify.notifyOwner).toHaveBeenCalledTimes(1)
    expect(mockNotify.notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ tier: 2, category: 'urgent' }))
  })

  it('does NOT re-fire at the same rung for the same pending set', async () => {
    const items = [{ id: 'a', type: 'dispatch_staff_tasks', label: 'x', createdAt: new Date(NOW - LADDER_L1_MIN * 60_000) }]
    mockPending.collectPendingItems.mockResolvedValue(items)
    // Prior state already at L1 with the SAME fingerprint.
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({ level: 1, firedAt: '2026-06-29T11:00:00Z', fingerprint: `dispatch_staff_tasks@${items[0].createdAt.getTime()}` }),
    })
    const res = await runOwnerSilenceLadder({ now: new Date(NOW) })
    expect(res.escalated).toBe(false)
    expect(mockNotify.notifyOwner).not.toHaveBeenCalled()
  })

  it('climbs from L1 to L2 (tier-3) as silence deepens on a critical item', async () => {
    const items = [{ id: 'c', type: 'ads_optimizer_batch', label: 'ads', createdAt: new Date(NOW - LADDER_L2_MIN * 60_000) }]
    mockPending.collectPendingItems.mockResolvedValue(items)
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({ level: 1, firedAt: '2026-06-29T10:00:00Z', fingerprint: `ads_optimizer_batch@${items[0].createdAt.getTime()}` }),
    })
    const res = await runOwnerSilenceLadder({ now: new Date(NOW) })
    expect(res.escalated).toBe(true)
    expect(res.level).toBe(2)
    expect(mockNotify.notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ tier: 3 }))
  })

  it('clears ladder state when nothing is pending', async () => {
    mockPending.collectPendingItems.mockResolvedValue([])
    const res = await runOwnerSilenceLadder({ now: new Date(NOW) })
    expect(res.escalated).toBe(false)
    expect(res.detail).toBe('nothing_pending')
    expect(mockPrisma.agentKvSetting.deleteMany).toHaveBeenCalled()
  })
})
