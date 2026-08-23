import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildInternalEntityReference } from '@/agent/lib/references/internal-registry'

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  touchConversationActivity: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentMessage: { create: mocks.createMessage },
  },
}))
vi.mock('@/agent/lib/conversation-activity', () => ({
  touchConversationActivity: mocks.touchConversationActivity,
}))

import { appendShiftNarrative } from '../day-shift'

const originalRollout = process.env.AGENT_REFERENCES_ROLLOUT
const originalKill = process.env.AGENT_REFERENCES_KILL_SWITCH

const lifestyle = buildInternalEntityReference({
  namespace: 'order',
  id: 'shift-order',
  sourceTool: 'get_orders',
  outputPath: 'data.orders[0].id',
  context: { businessId: 'ALMA_LIFESTYLE', roles: ['SUPER_ADMIN'] },
})!
const cdit = buildInternalEntityReference({
  namespace: 'cdit_project',
  id: 'wrong-business',
  sourceTool: 'get_cdit_projects',
  outputPath: 'data.projects[0].id',
  context: { businessId: 'CREATIVE_DIGITAL_IT', roles: ['SUPER_ADMIN'] },
})!
const viewerOnly = buildInternalEntityReference({
  namespace: 'order',
  id: 'wrong-role',
  sourceTool: 'get_orders',
  outputPath: 'data.orders[0].id',
  context: { businessId: 'ALMA_LIFESTYLE', roles: ['VIEWER'] },
})!

describe('day-shift reference persistence boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.AGENT_REFERENCES_KILL_SWITCH
  })

  afterAll(() => {
    if (originalRollout == null) delete process.env.AGENT_REFERENCES_ROLLOUT
    else process.env.AGENT_REFERENCES_ROLLOUT = originalRollout
    if (originalKill == null) delete process.env.AGENT_REFERENCES_KILL_SWITCH
    else process.env.AGENT_REFERENCES_KILL_SWITCH = originalKill
  })

  it.each(['shadow', 'on'] as const)(
    'canonicalizes and narrows caller references before persisting in %s',
    async (mode) => {
      process.env.AGENT_REFERENCES_ROLLOUT = mode
      const tampered = structuredClone(lifestyle)
      if (tampered.destination.type !== 'internal_entity') throw new Error('fixture')
      tampered.destination.webPath = '/agent/growth'

      await appendShiftNarrative('day-shift-conv', '  shift result  ', {
        references: [lifestyle, cdit, viewerOnly, tampered],
      })

      expect(mocks.createMessage).toHaveBeenCalledWith({
        data: expect.objectContaining({
          conversationId: 'day-shift-conv',
          content: [{ type: 'text', text: 'shift result' }],
          usage: { references: [lifestyle] },
        }),
      })
    },
  )

  it.each([
    ['off', false],
    ['on', true],
  ] as const)('persists references=%s? %s', async (mode, expected) => {
    process.env.AGENT_REFERENCES_ROLLOUT = mode
    await appendShiftNarrative('day-shift-conv', 'shift result', { references: [lifestyle] })

    const data = mocks.createMessage.mock.calls[0][0].data as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(data, 'usage')).toBe(expected)
  })

  it('lets the emergency kill switch win over ON at the final write boundary', async () => {
    process.env.AGENT_REFERENCES_ROLLOUT = 'on'
    process.env.AGENT_REFERENCES_KILL_SWITCH = 'true'

    await appendShiftNarrative('day-shift-conv', 'shift result', { references: [lifestyle] })

    expect(mocks.createMessage.mock.calls[0][0].data).not.toHaveProperty('usage')
  })
})
