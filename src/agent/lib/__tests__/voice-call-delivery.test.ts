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
  return { tx, prisma, enqueueContinuation: vi.fn() }
})

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/agent/lib/notify-owner', () => ({ notifyOwner: vi.fn() }))
vi.mock('@/agent/lib/telegram-owner-notify', () => ({ sendOwnerText: vi.fn() }))
vi.mock('@/agent/lib/approval-continuation', () => ({
  enqueueAgentContinuation: mocks.enqueueContinuation,
}))

import { dispatchVoiceCallDeliveries, persistVoiceCallReport } from '@/agent/lib/voice-call-delivery'

describe('durable voice-call report transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tx.agentMessage.upsert.mockResolvedValue({})
    mocks.tx.agentConversation.update.mockResolvedValue({})
    mocks.tx.agentPendingAction.update.mockResolvedValue({})
    mocks.tx.agentVoiceCallDelivery.findUnique.mockResolvedValue(null)
    mocks.tx.agentVoiceCallDelivery.create.mockResolvedValue({})
    mocks.prisma.agentVoiceCallDelivery.findMany.mockResolvedValue([])
    mocks.prisma.agentVoiceCallDelivery.updateMany.mockResolvedValue({ count: 1 })
    mocks.prisma.agentVoiceCallDelivery.update.mockResolvedValue({})
    mocks.enqueueContinuation.mockResolvedValue({
      outcome: 'queued', turnId: 'progress-turn', requestId: 'call-request', status: 'running',
    })
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

describe('voice-call continuation source binding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prisma.agentVoiceCallDelivery.updateMany.mockResolvedValue({ count: 1 })
    mocks.prisma.agentVoiceCallDelivery.update.mockResolvedValue({})
    mocks.enqueueContinuation.mockResolvedValue({
      outcome: 'queued', turnId: 'progress-turn', requestId: 'call-request', status: 'running',
    })
  })

  it('resumes from the exact terminal pending action without a free-form report prompt', async () => {
    mocks.prisma.agentVoiceCallDelivery.findMany.mockResolvedValue([{
      id: 'delivery-1', callId: 'call-1', channel: 'continuation', status: 'pending',
      attempts: 0, leaseUntil: null,
    }])
    mocks.prisma.agentVoiceCall.findUnique.mockResolvedValue({
      id: 'call-1', conversationId: 'conversation-1', pendingActionId: 'action-1',
      status: 'completed', summary: 'Order confirmed', transcript: [], recordingUrl: null,
      durationSecs: 42, recipientName: 'Rahim', toNumber: '+8801',
    })
    mocks.prisma.agentPendingAction.findUnique.mockResolvedValue({
      id: 'action-1', status: 'executed', type: 'agent_voice_call', workflowRunId: 'workflow-call-1',
      payload: { progressTurnId: 'progress-turn' },
    })

    const result = await dispatchVoiceCallDeliveries('call-1', 1, ['continuation'])

    expect(result).toEqual([{ id: 'delivery-1', channel: 'continuation', status: 'delivered' }])
    expect(mocks.enqueueContinuation).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      turnId: 'progress-turn',
      binding: {
        v: 1,
        origin: 'voice_call',
        source: { kind: 'pending_action', id: 'action-1' },
        conversationId: 'conversation-1',
        domain: 'calls',
        event: 'call_terminal',
        workflowRunId: 'workflow-call-1',
        directive: { kind: 'voice_call_terminal', version: 1 },
        expected: { sourceStatus: ['executed'], sourceType: 'agent_voice_call' },
      },
    })
    expect(mocks.enqueueContinuation.mock.calls[0][0].message).toBeUndefined()
  })

  it('settles the delivery without unattended execution when no pending-action source exists', async () => {
    mocks.prisma.agentVoiceCallDelivery.findMany.mockResolvedValue([{
      id: 'delivery-2', callId: 'call-2', channel: 'continuation', status: 'pending',
      attempts: 0, leaseUntil: null,
    }])
    mocks.prisma.agentVoiceCall.findUnique.mockResolvedValue({
      id: 'call-2', conversationId: 'conversation-1', pendingActionId: null,
      status: 'completed', summary: 'Inbound report already persisted', transcript: [], recordingUrl: null,
      durationSecs: 12, recipientName: null, toNumber: '+8802',
    })

    const result = await dispatchVoiceCallDeliveries('call-2', 1, ['continuation'])

    expect(result).toEqual([{ id: 'delivery-2', channel: 'continuation', status: 'delivered' }])
    expect(mocks.enqueueContinuation).not.toHaveBeenCalled()
  })

  it('retries instead of claiming delivery when bound continuation admission is rejected', async () => {
    mocks.prisma.agentVoiceCallDelivery.findMany.mockResolvedValue([{
      id: 'delivery-3', callId: 'call-3', channel: 'continuation', status: 'pending',
      attempts: 0, leaseUntil: null,
    }])
    mocks.prisma.agentVoiceCall.findUnique.mockResolvedValue({
      id: 'call-3', conversationId: 'conversation-1', pendingActionId: 'action-3',
      status: 'completed', summary: 'Exact report is already persisted', transcript: [], recordingUrl: null,
      durationSecs: 18, recipientName: null, toNumber: '+8803',
    })
    mocks.prisma.agentPendingAction.findUnique.mockResolvedValue({
      id: 'action-3', status: 'executed', type: 'agent_voice_call', workflowRunId: null,
      payload: {},
    })
    mocks.enqueueContinuation.mockResolvedValue({
      outcome: 'rejected', turnId: null, requestId: null, status: 'binding_required',
    })

    const result = await dispatchVoiceCallDeliveries('call-3', 1, ['continuation'])

    expect(result).toEqual([{ id: 'delivery-3', channel: 'continuation', status: 'retry' }])
    expect(mocks.prisma.agentVoiceCallDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'delivery-3' },
      data: expect.objectContaining({ status: 'retry', lastError: 'voice_call_continuation_binding_required' }),
    }))
  })
})
