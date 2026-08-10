/**
 * The timeout race must not leave marks.
 *
 * Codex P2 (PR #711), twice. Reinforcement lifts a memory's future ranking, so it
 * may only happen for memories the turn actually received. The first attempt
 * checked an abort flag inside the raced work, which still left a window: the
 * deadline could pass while the UPDATE was in flight. Reinforcement now runs
 * AFTER the race resolves, which is what these tests pin down.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = {
  $queryRawUnsafe: vi.fn(),
  $executeRawUnsafe: vi.fn(),
}
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/agent/lib/embeddings', () => ({
  embed: vi.fn().mockResolvedValue({ success: true, data: [0.1, 0.2] }),
  vectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}))
vi.mock('@/agent/lib/memory-digest', () => ({ retrieveMemoryDigests: vi.fn().mockResolvedValue([]) }))

const factRow = {
  id: 'm1',
  content: 'অর্ডার ORD-123 কুরিয়ারে দেরি হয়েছিল',
  scope: 'business',
  importance: 3,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  last_used_at: null,
  score: 0.9,
}

/** The reinforcement UPDATE, if it ran at all. */
function reinforcementCalls() {
  return mockPrisma.$executeRawUnsafe.mock.calls.filter((c) => String(c[0]).includes('access_count'))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$executeRawUnsafe.mockResolvedValue(1)
})

describe('retrieveRelevantMemories — reinforcement follows the race', () => {
  it('marks memories as used when retrieval wins', async () => {
    const { retrieveRelevantMemories } = await import('@/agent/lib/agent-memory')
    mockPrisma.$queryRawUnsafe.mockResolvedValue([factRow])

    const memories = await retrieveRelevantMemories('ORD-123 er ki obostha', false, 'ALMA_LIFESTYLE')

    expect(memories.map((m) => m.id)).toContain('m1')
    expect(reinforcementCalls()).toHaveLength(1)
    expect(reinforcementCalls()[0][1]).toEqual(['m1'])
  })

  it('marks nothing when retrieval loses the race — the turn never saw them', async () => {
    vi.useFakeTimers()
    try {
      const { retrieveRelevantMemories } = await import('@/agent/lib/agent-memory')
      mockPrisma.$queryRawUnsafe.mockImplementation(() => new Promise(() => {})) // never settles

      const pending = retrieveRelevantMemories('ORD-123 er ki obostha', false, 'ALMA_LIFESTYLE')
      await vi.advanceTimersByTimeAsync(5000)

      await expect(pending).resolves.toEqual([])
      expect(reinforcementCalls()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks nothing when the query fails', async () => {
    const { retrieveRelevantMemories } = await import('@/agent/lib/agent-memory')
    mockPrisma.$queryRawUnsafe.mockRejectedValue(new Error('db down'))

    await expect(retrieveRelevantMemories('ORD-123', false, 'ALMA_LIFESTYLE')).resolves.toEqual([])
    expect(reinforcementCalls()).toHaveLength(0)
  })

  it('marks nothing when the search found nothing', async () => {
    const { retrieveRelevantMemories } = await import('@/agent/lib/agent-memory')
    mockPrisma.$queryRawUnsafe.mockResolvedValue([])

    await expect(retrieveRelevantMemories('কিছু একটা', false, 'ALMA_LIFESTYLE')).resolves.toEqual([])
    expect(reinforcementCalls()).toHaveLength(0)
  })
})
