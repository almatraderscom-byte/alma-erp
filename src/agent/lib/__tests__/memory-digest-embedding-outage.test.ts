/**
 * A transient embedding outage must not cost a week of digests.
 *
 * Codex P2 round 7 (PR #711): when the distiller returned scenarios but no
 * persona and every scenario embedding failed, the build committed an EMPTY
 * replacement — deleting good blocks and putting nothing in their place, until
 * the next weekly run. The adjacent `no_signal` path already preserved blocks
 * through transient model failures; this closes the same gap for embeddings.
 *
 * Lives in its own file because it needs the embedding provider mocked as
 * failing for the whole module graph.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = {
  $queryRawUnsafe: vi.fn(),
  $executeRawUnsafe: vi.fn(),
  $transaction: vi.fn(),
}
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

const smartText = vi.fn()
vi.mock('@/agent/lib/llm-text', () => ({ agentSmartText: (...args: unknown[]) => smartText(...args) }))
vi.mock('@/agent/lib/embeddings', () => ({
  embed: vi.fn().mockResolvedValue({ success: false, error: 'embedding provider down' }),
  vectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$executeRawUnsafe.mockResolvedValue(1)
  mockPrisma.$transaction.mockResolvedValue([])
})

const facts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i}`, content: `তথ্য ${i}`, pinned: false }))

const scenarioOnly = JSON.stringify({
  persona: '',
  scenarios: [{ topic: 'দাম', summary: 'কস্ট প্রাইস ছাড়া কোনো কোটেশন পাঠানো হয় না কখনো।' }],
})

describe('buildDigestForTarget — embedding provider down', () => {
  it('skips the write instead of committing an empty slot', async () => {
    const { buildDigestForTarget, MIN_SOURCE_FACTS } = await import('@/agent/lib/memory-digest')
    mockPrisma.$queryRawUnsafe.mockResolvedValue(facts(MIN_SOURCE_FACTS + 2))
    smartText.mockResolvedValue(scenarioOnly)

    const result = await buildDigestForTarget({ scope: 'personal', businessId: null })

    expect(result.skipped).toBe('embedding_failed')
    expect(result.scenariosWritten).toBe(0)
    expect(result.personaWritten).toBe(false)
  })

  it('leaves the existing blocks completely untouched', async () => {
    const { buildDigestForTarget, MIN_SOURCE_FACTS } = await import('@/agent/lib/memory-digest')
    mockPrisma.$queryRawUnsafe.mockResolvedValue(facts(MIN_SOURCE_FACTS + 2))
    smartText.mockResolvedValue(scenarioOnly)

    await buildDigestForTarget({ scope: 'personal', businessId: null })

    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    const deletes = mockPrisma.$executeRawUnsafe.mock.calls.filter((c) =>
      String(c[0]).includes('DELETE FROM agent_memory_digest'),
    )
    expect(deletes).toHaveLength(0)
  })

  it('still writes when a persona survives — the persona needs no embedding', async () => {
    const { buildDigestForTarget, MIN_SOURCE_FACTS } = await import('@/agent/lib/memory-digest')
    mockPrisma.$queryRawUnsafe.mockResolvedValue(facts(MIN_SOURCE_FACTS + 2))
    smartText.mockResolvedValue(
      JSON.stringify({
        persona: 'বস দাম নিয়ে আগে থেকে জানাতে বলেন এবং দেরি হলে সাথে সাথে জানাতে চান।',
        scenarios: [{ topic: 'দাম', summary: 'কস্ট প্রাইস ছাড়া কোনো কোটেশন পাঠানো হয় না কখনো।' }],
      }),
    )

    const result = await buildDigestForTarget({ scope: 'personal', businessId: null })

    expect(result.personaWritten).toBe(true)
    expect(result.scenariosWritten).toBe(0) // the scenario could not be embedded
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
  })
})
