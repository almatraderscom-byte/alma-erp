/**
 * Digest lifecycle: a summary must never outlive the facts it summarises.
 *
 * Codex P1 (PR #711): when the weekly revision deletes enough facts that a scope
 * drops below the distillation minimum, the build used to return early and leave
 * the old L2/L3 rows in place — and because the persona block is injected on
 * every turn, deleted facts kept speaking through their summary.
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
  embed: vi.fn().mockResolvedValue({ success: true, data: [0.1, 0.2] }),
  vectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$executeRawUnsafe.mockResolvedValue(1)
  mockPrisma.$transaction.mockResolvedValue([])
})

const facts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i}`, content: `তথ্য ${i}`, pinned: false }))

/** All DELETE statements the module issued, whether direct or inside a transaction. */
function deleteStatements(): string[] {
  return mockPrisma.$executeRawUnsafe.mock.calls
    .map((call) => String(call[0]))
    .filter((sql) => sql.includes('DELETE FROM agent_memory_digest'))
}

describe('buildDigestForTarget — stale digest cleanup', () => {
  it('deletes the slot’s existing blocks when the facts fall below the minimum', async () => {
    const { buildDigestForTarget, MIN_SOURCE_FACTS } = await import('@/agent/lib/memory-digest')
    mockPrisma.$queryRawUnsafe.mockResolvedValue(facts(MIN_SOURCE_FACTS - 1))

    const result = await buildDigestForTarget({ scope: 'personal', businessId: null })

    expect(result.skipped).toBe('too_few_facts')
    expect(smartText).not.toHaveBeenCalled()
    const deletes = deleteStatements()
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).toContain('business_id IS NULL')
  })

  it('scopes the cleanup to the right business — one slot must not wipe another', async () => {
    const { buildDigestForTarget, MIN_SOURCE_FACTS } = await import('@/agent/lib/memory-digest')
    mockPrisma.$queryRawUnsafe.mockResolvedValue(facts(MIN_SOURCE_FACTS - 1))

    await buildDigestForTarget({ scope: 'business', businessId: 'ALMA_TRADING' })

    expect(deleteStatements()[0]).toContain("business_id = 'ALMA_TRADING'")
    expect(mockPrisma.$executeRawUnsafe.mock.calls[0][1]).toBe('business')
  })

  it('keeps the previous blocks when the facts are there but the model returned nothing', async () => {
    // A flaky model call must not destroy a good digest — the freshness window
    // in retrieval is what stops a persistently failing job from going stale.
    const { buildDigestForTarget, MIN_SOURCE_FACTS } = await import('@/agent/lib/memory-digest')
    mockPrisma.$queryRawUnsafe.mockResolvedValue(facts(MIN_SOURCE_FACTS + 5))
    smartText.mockResolvedValue('{"persona":"","scenarios":[]}')

    const result = await buildDigestForTarget({ scope: 'personal', businessId: null })

    expect(result.skipped).toBe('no_signal')
    expect(deleteStatements()).toHaveLength(0)
  })

  it('replaces the slot in one transaction on a successful build', async () => {
    const { buildDigestForTarget, MIN_SOURCE_FACTS } = await import('@/agent/lib/memory-digest')
    mockPrisma.$queryRawUnsafe.mockResolvedValue(facts(MIN_SOURCE_FACTS + 5))
    smartText.mockResolvedValue(
      JSON.stringify({
        persona: 'বস দাম নিয়ে আগে থেকে জানাতে বলেন এবং দেরি হলে সাথে সাথে জানাতে চান।',
        scenarios: [{ topic: 'দাম', summary: 'কস্ট প্রাইস ছাড়া কোনো কোটেশন পাঠানো হয় না কখনো।' }],
      }),
    )

    const result = await buildDigestForTarget({ scope: 'personal', businessId: null })

    expect(result.personaWritten).toBe(true)
    expect(result.scenariosWritten).toBe(1)
    // The delete rides inside the transaction, not as a separate statement.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    const statements = mockPrisma.$transaction.mock.calls[0][0] as unknown[]
    expect(statements).toHaveLength(3) // delete + persona + one scenario
  })
})

describe('retrieveMemoryDigests — a digest may not outlive its sources', () => {
  it('withholds blocks whose source facts are no longer all present', async () => {
    // The predicate itself is SQL, so this asserts the guard is IN the query;
    // its behaviour is verified against a real PostgreSQL instance separately.
    const { retrieveMemoryDigests } = await import('@/agent/lib/memory-digest')
    mockPrisma.$queryRawUnsafe.mockResolvedValue([])

    await retrieveMemoryDigests({ personalMode: true, businessId: 'ALMA_LIFESTYLE' })

    const sql = String(mockPrisma.$queryRawUnsafe.mock.calls[0][0])
    expect(sql).toContain('jsonb_array_elements_text(d.source_ids)')
    expect(sql).toContain('jsonb_array_length(d.source_ids)')
    expect(sql).toContain('d.source_ids IS NULL') // rows without a source list still serve
  })

  it('also refuses blocks the weekly job stopped refreshing', async () => {
    const { retrieveMemoryDigests } = await import('@/agent/lib/memory-digest')
    mockPrisma.$queryRawUnsafe.mockResolvedValue([])

    await retrieveMemoryDigests({ personalMode: true, businessId: 'ALMA_LIFESTYLE' })

    expect(String(mockPrisma.$queryRawUnsafe.mock.calls[0][0])).toContain('refreshed_at > NOW() - INTERVAL')
  })

  it('scopes personal turns to the NULL business and business turns to their id', async () => {
    const { retrieveMemoryDigests } = await import('@/agent/lib/memory-digest')
    mockPrisma.$queryRawUnsafe.mockResolvedValue([])

    await retrieveMemoryDigests({ personalMode: true, businessId: 'ALMA_LIFESTYLE' })
    expect(String(mockPrisma.$queryRawUnsafe.mock.calls[0][0])).toContain('d.business_id IS NULL')

    mockPrisma.$queryRawUnsafe.mockClear()
    await retrieveMemoryDigests({ personalMode: false, businessId: 'ALMA_TRADING' })
    const [sql, param] = mockPrisma.$queryRawUnsafe.mock.calls[0]
    expect(String(sql)).toContain('d.business_id = $1')
    expect(param).toBe('ALMA_TRADING')
  })

  it('never throws into the turn when the table is missing', async () => {
    const { retrieveMemoryDigests } = await import('@/agent/lib/memory-digest')
    mockPrisma.$queryRawUnsafe.mockRejectedValue(new Error('relation "agent_memory_digest" does not exist'))

    await expect(
      retrieveMemoryDigests({ personalMode: false, businessId: 'ALMA_LIFESTYLE' }),
    ).resolves.toEqual([])
  })
})

describe('clearDigestRows', () => {
  it('targets exactly one slot', async () => {
    const { clearDigestRows } = await import('@/agent/lib/memory-digest')
    await clearDigestRows({ scope: 'business', businessId: 'ALMA_LIFESTYLE' })

    const [sql, param] = mockPrisma.$executeRawUnsafe.mock.calls[0]
    expect(String(sql)).toContain("business_id = 'ALMA_LIFESTYLE'")
    expect(String(sql)).toContain('scope = $1')
    expect(param).toBe('business')
  })
})
