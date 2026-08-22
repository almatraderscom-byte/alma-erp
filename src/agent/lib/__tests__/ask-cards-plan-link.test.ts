import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPrisma = {
  agentAskCard: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
}
const completePlanStepsLinkedToAskCard = vi.fn()

vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/agent/lib/planner', () => ({ completePlanStepsLinkedToAskCard }))
vi.mock('@/agent/lib/grind/owner-gate', () => ({ resolveGrindGate: vi.fn() }))

const card = (status: string, selectedOption: string | null) => ({
  id: 'ask-1',
  conversationId: 'conv-1',
  question: 'চালাব?',
  options: JSON.stringify(['হ্যাঁ', 'না']),
  questions: null,
  status,
  selectedOption,
  workflowRunId: null,
})

beforeEach(() => vi.clearAllMocks())

describe('ask-card plan linkage', () => {
  it('settles the linked plan row after the first durable answer', async () => {
    mockPrisma.agentAskCard.findUnique
      .mockResolvedValueOnce(card('pending', null))
      .mockResolvedValueOnce(card('answered', 'হ্যাঁ'))
    mockPrisma.agentAskCard.updateMany.mockResolvedValueOnce({ count: 1 })

    const { answerAskCard } = await import('@/agent/lib/ask-cards')
    await expect(answerAskCard('ask-1', 'হ্যাঁ')).resolves.toMatchObject({
      ok: true,
      alreadyAnswered: false,
    })
    expect(completePlanStepsLinkedToAskCard).toHaveBeenCalledOnce()
    expect(completePlanStepsLinkedToAskCard).toHaveBeenCalledWith('ask-1')
  })

  it('retries tracker settlement idempotently for the same recorded answer', async () => {
    mockPrisma.agentAskCard.findUnique.mockResolvedValueOnce(card('answered', 'হ্যাঁ'))

    const { answerAskCard } = await import('@/agent/lib/ask-cards')
    await expect(answerAskCard('ask-1', 'হ্যাঁ')).resolves.toMatchObject({
      ok: true,
      alreadyAnswered: true,
    })
    expect(mockPrisma.agentAskCard.updateMany).not.toHaveBeenCalled()
    expect(completePlanStepsLinkedToAskCard).toHaveBeenCalledWith('ask-1')
  })

  it('rejects a same-option retry after the card was superseded', async () => {
    mockPrisma.agentAskCard.findUnique.mockResolvedValueOnce(card('superseded', 'হ্যাঁ'))

    const { answerAskCard } = await import('@/agent/lib/ask-cards')
    await expect(answerAskCard('ask-1', 'হ্যাঁ')).resolves.toMatchObject({
      ok: false,
      alreadyAnswered: true,
      reason: 'different_answer_recorded',
    })
    expect(mockPrisma.agentAskCard.updateMany).not.toHaveBeenCalled()
    expect(completePlanStepsLinkedToAskCard).not.toHaveBeenCalled()
  })
})
