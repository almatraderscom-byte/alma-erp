import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock heavy deps BEFORE importing the module under test.
const mockPrisma = vi.hoisted(() => ({
  agentKvSetting: { findUnique: vi.fn() },
  agentCallEscalation: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  agentPendingAction: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  agentStaffTask: { findMany: vi.fn() },
  agentVoiceCall: { findUnique: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

const mockVoiceCall = vi.hoisted(() => ({ placeOutboundCall: vi.fn() }))
vi.mock('@/agent/lib/voice-call', () => mockVoiceCall)

const mockNotify = vi.hoisted(() => ({ notifyOwner: vi.fn().mockResolvedValue({ channels: [], statuses: {} }) }))
vi.mock('@/agent/lib/notify-owner', () => mockNotify)

const mockCard = vi.hoisted(() => ({ sendOwnerApprovalCard: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/agent/lib/telegram-owner-notify', () => mockCard)

const mockQuiet = vi.hoisted(() => ({
  getQuietHoursConfig: vi.fn().mockResolvedValue({ enabled: false, startHour: 22, endHour: 8 }),
  isQuietHoursDhaka: vi.fn().mockReturnValue(false),
}))
vi.mock('@/agent/lib/quiet-hours', () => mockQuiet)

import {
  callOutcome,
  ownerPrimaryNumber,
  getProactiveCallConfig,
  queueCallEscalation,
  processCallEscalations,
} from '@/agent/lib/proactive-call'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.OWNER_PHONE_NUMBERS = '01779640373'
  mockPrisma.agentKvSetting.findUnique.mockResolvedValue(null)
  mockQuiet.isQuietHoursDhaka.mockReturnValue(false)
})

describe('callOutcome', () => {
  it('maps terminal statuses from the ladder viewpoint', () => {
    expect(callOutcome({ status: 'completed' })).toBe('answered')
    expect(callOutcome({ status: 'report_missing' })).toBe('answered')
    expect(callOutcome({ status: 'no_answer' })).toBe('unreached')
    expect(callOutcome({ status: 'busy' })).toBe('unreached')
    expect(callOutcome({ status: 'failed' })).toBe('unreached')
    expect(callOutcome({ status: 'ringing' })).toBe('pending')
    expect(callOutcome(null)).toBe('pending')
  })
})

describe('ownerPrimaryNumber', () => {
  it('takes the first entry of OWNER_PHONE_NUMBERS', () => {
    process.env.OWNER_PHONE_NUMBERS = '01779640373,01711111111'
    expect(ownerPrimaryNumber()).toBe('01779640373')
  })
  it('null when unset', () => {
    process.env.OWNER_PHONE_NUMBERS = ''
    expect(ownerPrimaryNumber()).toBeNull()
  })
})

describe('getProactiveCallConfig', () => {
  it('defaults: autonomy OFF, 3 min stages, cap 4', async () => {
    const cfg = await getProactiveCallConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.stageWaitMin).toBe(3)
    expect(cfg.dailyCap).toBe(4)
    expect(cfg.approvalStuckMin).toBe(15)
    expect(cfg.urgentStuckMin).toBe(5)
  })
  it('reads KV overrides and clamps garbage', async () => {
    mockPrisma.agentKvSetting.findUnique.mockImplementation(({ where }: { where: { key: string } }) => {
      if (where.key === 'proactive_calls_enabled') return Promise.resolve({ value: 'true' })
      if (where.key === 'proactive_call_stage_wait_min') return Promise.resolve({ value: '999' })
      return Promise.resolve(null)
    })
    const cfg = await getProactiveCallConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.stageWaitMin).toBe(30) // clamped
  })
})

describe('queueCallEscalation', () => {
  it('dedupes on an active refId', async () => {
    mockPrisma.agentCallEscalation.findFirst.mockResolvedValue({ id: 'existing' })
    const id = await queueCallEscalation({ trigger: 'manual', refId: 'x', title: 't', purpose: 'p' })
    expect(id).toBeNull()
    expect(mockPrisma.agentCallEscalation.create).not.toHaveBeenCalled()
  })
  it('creates a queued row when none active', async () => {
    mockPrisma.agentCallEscalation.findFirst.mockResolvedValue(null)
    mockPrisma.agentCallEscalation.create.mockResolvedValue({ id: 'new-id' })
    const id = await queueCallEscalation({ trigger: 'manual', refId: 'x', title: 't', purpose: 'p' })
    expect(id).toBe('new-id')
  })
  it('refuses when no owner number configured', async () => {
    process.env.OWNER_PHONE_NUMBERS = ''
    const id = await queueCallEscalation({ trigger: 'manual', refId: 'x', title: 't', purpose: 'p' })
    expect(id).toBeNull()
  })
})

describe('processCallEscalations — queued rows', () => {
  const queuedRow = {
    id: 'esc1',
    trigger: 'manual',
    refId: 'x',
    title: 'Test',
    purpose: 'p',
    status: 'queued',
    createdAt: new Date(),
    nextCheckAt: new Date(Date.now() - 1000),
    waCallId: null,
    pstnCallId: null,
    approvalActionId: null,
  }

  it('autonomy OFF → permission card, no dial', async () => {
    mockPrisma.agentCallEscalation.findMany.mockResolvedValue([queuedRow])
    mockPrisma.agentCallEscalation.count.mockResolvedValue(0)
    mockPrisma.agentPendingAction.create.mockResolvedValue({ id: 'card1' })
    const res = await processCallEscalations()
    expect(res).toEqual([{ id: 'esc1', outcome: 'awaiting_approval' }])
    expect(mockVoiceCall.placeOutboundCall).not.toHaveBeenCalled()
    expect(mockPrisma.agentPendingAction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'proactive_call' }) }),
    )
    expect(mockCard.sendOwnerApprovalCard).toHaveBeenCalled()
  })

  it('autonomy ON → dials WhatsApp leg first', async () => {
    mockPrisma.agentKvSetting.findUnique.mockImplementation(({ where }: { where: { key: string } }) =>
      Promise.resolve(where.key === 'proactive_calls_enabled' ? { value: 'true' } : null))
    mockPrisma.agentCallEscalation.findMany.mockResolvedValue([queuedRow])
    mockPrisma.agentCallEscalation.count.mockResolvedValue(0)
    mockPrisma.agentCallEscalation.findUnique.mockResolvedValue(queuedRow)
    mockPrisma.agentCallEscalation.updateMany.mockResolvedValue({ count: 1 })
    mockVoiceCall.placeOutboundCall.mockResolvedValue({ ok: true, callRecordId: 'call1' })
    const res = await processCallEscalations()
    expect(res).toEqual([{ id: 'esc1', outcome: 'dialed_wa_calling' }])
    expect(mockVoiceCall.placeOutboundCall).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp', callType: 'owner', toNumber: '01779640373' }),
    )
  })

  it('daily cap reached → cancelled + summary push', async () => {
    mockPrisma.agentCallEscalation.findMany.mockResolvedValue([queuedRow])
    mockPrisma.agentCallEscalation.count.mockResolvedValue(4)
    const res = await processCallEscalations()
    expect(res).toEqual([{ id: 'esc1', outcome: 'cancelled_daily_cap' }])
    expect(mockVoiceCall.placeOutboundCall).not.toHaveBeenCalled()
    expect(mockNotify.notifyOwner).toHaveBeenCalled()
  })

  it('quiet hours defer non-critical trigger', async () => {
    mockQuiet.isQuietHoursDhaka.mockReturnValue(true)
    mockPrisma.agentCallEscalation.findMany.mockResolvedValue([queuedRow])
    const res = await processCallEscalations()
    expect(res).toEqual([{ id: 'esc1', outcome: 'deferred_quiet_hours' }])
  })

  it('business_alert pierces quiet hours', async () => {
    mockQuiet.isQuietHoursDhaka.mockReturnValue(true)
    mockPrisma.agentCallEscalation.findMany.mockResolvedValue([{ ...queuedRow, trigger: 'business_alert' }])
    mockPrisma.agentCallEscalation.count.mockResolvedValue(0)
    mockPrisma.agentPendingAction.create.mockResolvedValue({ id: 'card1' })
    const res = await processCallEscalations()
    // autonomy OFF here, so it lands on the card — but it was NOT deferred.
    expect(res).toEqual([{ id: 'esc1', outcome: 'awaiting_approval' }])
  })
})

describe('processCallEscalations — awaiting_approval', () => {
  const awaitingRow = {
    id: 'esc3',
    trigger: 'manual',
    refId: 'x',
    title: 'Test',
    purpose: 'p',
    status: 'awaiting_approval',
    createdAt: new Date(),
    nextCheckAt: new Date(Date.now() - 1000),
    waCallId: null,
    pstnCallId: null,
    approvalActionId: 'card1',
  }

  it('card rejected/expired → ladder cancelled', async () => {
    mockPrisma.agentCallEscalation.findMany.mockResolvedValue([awaitingRow])
    mockPrisma.agentPendingAction.findUnique.mockResolvedValue({ status: 'expired' })
    const res = await processCallEscalations()
    expect(res).toEqual([{ id: 'esc3', outcome: 'cancelled_rejected' }])
    expect(mockVoiceCall.placeOutboundCall).not.toHaveBeenCalled()
  })

  it('card approved but inline start crashed → cron recovers and dials', async () => {
    mockPrisma.agentCallEscalation.findMany.mockResolvedValue([awaitingRow])
    mockPrisma.agentPendingAction.findUnique.mockResolvedValue({ status: 'approved' })
    mockPrisma.agentCallEscalation.findUnique.mockResolvedValue(awaitingRow)
    mockPrisma.agentCallEscalation.updateMany.mockResolvedValue({ count: 1 })
    mockVoiceCall.placeOutboundCall.mockResolvedValue({ ok: true, callRecordId: 'call1' })
    const res = await processCallEscalations()
    expect(res).toEqual([{ id: 'esc3', outcome: 'dialed_wa_calling' }])
  })

  it('card still pending → keeps waiting', async () => {
    mockPrisma.agentCallEscalation.findMany.mockResolvedValue([awaitingRow])
    mockPrisma.agentPendingAction.findUnique.mockResolvedValue({ status: 'pending' })
    const res = await processCallEscalations()
    expect(res).toEqual([{ id: 'esc3', outcome: 'still_awaiting_approval' }])
  })
})

describe('processCallEscalations — call stages', () => {
  const waRow = {
    id: 'esc2',
    trigger: 'manual',
    refId: 'x',
    title: 'Test',
    purpose: 'p',
    status: 'wa_calling',
    createdAt: new Date(),
    nextCheckAt: new Date(Date.now() - 1000),
    waCallId: 'call1',
    pstnCallId: null,
    approvalActionId: null,
  }

  it('wa answered → resolved answered', async () => {
    mockPrisma.agentCallEscalation.findMany.mockResolvedValue([waRow])
    mockPrisma.agentVoiceCall.findUnique.mockResolvedValue({ status: 'completed' })
    const res = await processCallEscalations()
    expect(res).toEqual([{ id: 'esc2', outcome: 'answered' }])
  })

  it('wa unanswered → escalates to PSTN', async () => {
    mockPrisma.agentCallEscalation.findMany.mockResolvedValue([waRow])
    mockPrisma.agentVoiceCall.findUnique.mockResolvedValue({ status: 'no_answer' })
    mockVoiceCall.placeOutboundCall.mockResolvedValue({ ok: true, callRecordId: 'call2' })
    const res = await processCallEscalations()
    expect(res).toEqual([{ id: 'esc2', outcome: 'escalated_to_pstn' }])
    expect(mockVoiceCall.placeOutboundCall).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'phone', callType: 'owner' }),
    )
  })

  it('wa still ringing before timeout → waits', async () => {
    mockPrisma.agentCallEscalation.findMany.mockResolvedValue([
      { ...waRow, nextCheckAt: new Date(Date.now() + 120_000) },
    ])
    mockPrisma.agentVoiceCall.findUnique.mockResolvedValue({ status: 'ringing' })
    const res = await processCallEscalations()
    expect(res).toEqual([{ id: 'esc2', outcome: 'waiting' }])
  })

  it('pstn unanswered → unreached + summary push', async () => {
    mockPrisma.agentCallEscalation.findMany.mockResolvedValue([
      { ...waRow, status: 'pstn_calling', pstnCallId: 'call2' },
    ])
    mockPrisma.agentVoiceCall.findUnique.mockResolvedValue({ status: 'no_answer' })
    const res = await processCallEscalations()
    expect(res).toEqual([{ id: 'esc2', outcome: 'unreached' }])
    expect(mockNotify.notifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 2, telegramMode: 'always' }),
    )
  })
})
