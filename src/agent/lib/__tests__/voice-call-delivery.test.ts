import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const tx = {
    agentVoiceCall: { findUnique: vi.fn(), update: vi.fn() },
    agentPendingAction: { findUnique: vi.fn(), update: vi.fn() },
    agentMessage: { upsert: vi.fn() },
    agentConversation: { update: vi.fn() },
    agentVoiceCallDelivery: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  }
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    agentVoiceCall: { findUnique: vi.fn() },
    agentPendingAction: { findUnique: vi.fn() },
    agentVoiceCallDelivery: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  }
  return { tx, prisma }
})

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/agent/lib/notify-owner', () => ({ notifyOwner: vi.fn() }))
vi.mock('@/agent/lib/telegram-owner-notify', () => ({ sendOwnerText: vi.fn() }))
vi.mock('@/agent/lib/approval-continuation', () => ({ enqueueAgentContinuation: vi.fn() }))

import { persistVoiceCallReport } from '@/agent/lib/voice-call-delivery'

describe('durable voice-call report transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tx.agentMessage.upsert.mockResolvedValue({})
    mocks.tx.agentConversation.update.mockResolvedValue({})
    mocks.tx.agentPendingAction.update.mockResolvedValue({})
    mocks.tx.agentVoiceCallDelivery.findUnique.mockResolvedValue(null)
    mocks.tx.agentVoiceCallDelivery.create.mockResolvedValue({})
  })

  it('marks approval executed only when report is stored and creates three independent deliveries', async () => {
    const record = {
      id: 'call-1', status: 'ringing', transcript: [], summary: null,
      conversationId: 'conversation-1', pendingActionId: 'action-1',
      reportReceivedAt: null, endedAt: null, callSid: null, provider: 'ngs',
      durationSecs: null, costCredits: null, recipientName: 'Rahim', toNumber: '+8801',
    }
    mocks.tx.agentVoiceCall.findUnique.mockResolvedValue(record)
    mocks.tx.agentVoiceCall.update.mockImplementation(async ({ data }) => ({ ...record, ...data }))
    mocks.tx.agentPendingAction.findUnique.mockResolvedValue({ id: 'action-1', result: { reportReady: false } })

    await persistVoiceCallReport({
      callRecordId: 'call-1', status: 'completed', summary: 'কাজ হবে',
      transcript: [{ role: 'agent', message: 'আসসালামু আলাইকুম' }],
    })

    expect(mocks.tx.agentPendingAction.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'action-1' },
      data: expect.objectContaining({
        status: 'executed',
        result: expect.objectContaining({ callStatus: 'completed', reportReady: true }),
      }),
    }))
    expect(mocks.tx.agentMessage.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { clientRequestId: 'voice-call-report:call-1' },
    }))
    expect(mocks.tx.agentVoiceCallDelivery.create.mock.calls.map(([arg]) => arg.data.channel))
      .toEqual(['telegram', 'push', 'continuation'])
  })

  it('upgrades a synthetic missing-report alert without retaining the stale warning', async () => {
    const record = {
      id: 'call-2', status: 'report_missing', transcript: [], summary: 'রিপোর্ট আসেনি',
      conversationId: null, pendingActionId: null, reportReceivedAt: null,
      endedAt: new Date(), callSid: 'sid', provider: 'ngs', durationSecs: null,
      costCredits: null, recipientName: 'Karim', toNumber: '+8802',
    }
    mocks.tx.agentVoiceCall.findUnique.mockResolvedValue(record)
    mocks.tx.agentVoiceCall.update.mockImplementation(async ({ data }) => ({ ...record, ...data }))
    mocks.tx.agentVoiceCallDelivery.findUnique.mockResolvedValue({ id: 'delivery', status: 'delivered' })

    await persistVoiceCallReport({ callRecordId: 'call-2', status: 'completed', authoritativeReport: true })

    expect(mocks.tx.agentVoiceCall.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'completed', summary: null }),
    }))
    expect(mocks.tx.agentVoiceCallDelivery.update).toHaveBeenCalledTimes(3)
    expect(mocks.tx.agentVoiceCallDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'pending', attempts: 0, deliveredAt: null }),
    }))
  })
})
