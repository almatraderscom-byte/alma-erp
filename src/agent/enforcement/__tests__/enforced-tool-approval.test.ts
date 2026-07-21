import { beforeEach, describe, expect, it, vi } from 'vitest'

const upserts: Array<Record<string, unknown>> = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: {
      upsert: vi.fn(async (args: Record<string, unknown>) => {
        upserts.push(args)
        return { id: 'approval-one', summary: 'held' }
      }),
    },
  },
}))

import { stageEnforcedToolApproval } from '../enforced-tool-runner'

describe('AIOS held-action approval staging', () => {
  beforeEach(() => { upserts.length = 0 })

  it('deduplicates the same exact effect across provider tool-call retries', async () => {
    const common = {
      conversationId: 'conv-1',
      businessId: 'ALMA_LIFESTYLE',
      turnId: 'turn-1',
      toolName: 'send_whatsapp',
      toolInput: { message: 'hello', to: '+8801000000000' },
      model: 'gemini-3.1-pro',
      klass: 'publishing' as const,
    }
    const first = await stageEnforcedToolApproval({ ...common, toolCallId: 'call-a' })
    const retry = await stageEnforcedToolApproval({ ...common, toolCallId: 'call-b' })

    expect(first.success).toBe(true)
    expect(retry.success).toBe(true)
    expect(upserts).toHaveLength(2)
    expect((upserts[0].where as { dedupeKey: string }).dedupeKey)
      .toBe((upserts[1].where as { dedupeKey: string }).dedupeKey)
    expect((upserts[0].create as { payload: { sourceToolCallId: string } }).payload.sourceToolCallId)
      .toBe('call-a')
  })
})
