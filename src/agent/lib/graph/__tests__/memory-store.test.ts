/**
 * LG-7 memory Store adapter — offline behaviour lock.
 *
 * Contracts: namespace ↔ scope translation; get by key then by id; put
 * delegates to createOrUpdateAgentMemory (embedding/expiry rules stay owned
 * there); DELETE IS REFUSED (owner-curated memory, project rule); semantic
 * search delegates to the head's own searchAgentMemory ranking; expired facts
 * never surface; gate discipline. prisma + memory libs mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const findFirstMock = vi.fn()
const findManyMock = vi.fn()
vi.mock('@/lib/prisma', () => ({
  prisma: { agentMemory: { findFirst: (...a: unknown[]) => findFirstMock(...a), findMany: (...a: unknown[]) => findManyMock(...a) } },
}))
const searchMock = vi.fn()
vi.mock('@/agent/lib/memory-search', () => ({
  searchAgentMemory: (...a: unknown[]) => searchMock(...a),
}))
const upsertMock = vi.fn()
vi.mock('@/agent/lib/agent-memory', () => ({
  createOrUpdateAgentMemory: (...a: unknown[]) => upsertMock(...a),
}))

import { AlmaMemoryStore, isMemoryStoreEnabled, getAlmaMemoryStore, __resetMemoryStoreForTests } from '../memory-store'

const ROW = {
  id: 'm-1',
  scope: 'business',
  key: 'best_seller',
  content: 'পাঞ্জাবি বেস্ট সেলার',
  pinned: true,
  metadata: { type: 'business' },
  importance: 3,
  createdAt: new Date('2026-07-01'),
  updatedAt: new Date('2026-07-10'),
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetMemoryStoreForTests()
  process.env.AGENT_LANGGRAPH_STORE = 'true'
})

describe('isMemoryStoreEnabled / getAlmaMemoryStore', () => {
  it('gate discipline + singleton', () => {
    delete process.env.AGENT_LANGGRAPH_STORE
    expect(isMemoryStoreEnabled('true', 'production')).toBe(true)
    expect(isMemoryStoreEnabled('false', 'preview')).toBe(false)
    expect(isMemoryStoreEnabled(undefined, 'preview')).toBe(true)
    expect(isMemoryStoreEnabled(undefined, 'production')).toBe(false)

    process.env.AGENT_LANGGRAPH_STORE = 'true'
    const a = getAlmaMemoryStore()
    expect(a).not.toBeNull()
    expect(getAlmaMemoryStore()).toBe(a)
    process.env.AGENT_LANGGRAPH_STORE = 'false'
    expect(getAlmaMemoryStore()).toBeNull()
  })
})

describe('AlmaMemoryStore', () => {
  it('get: scope+key hit maps to an Item (live facts only)', async () => {
    findFirstMock.mockResolvedValueOnce(ROW)
    const item = await new AlmaMemoryStore().get(['business'], 'best_seller')
    expect(item).toMatchObject({
      namespace: ['business'],
      key: 'best_seller',
      value: { content: 'পাঞ্জাবি বেস্ট সেলার', pinned: true, importance: 3 },
    })
    const where = (findFirstMock.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(where.scope).toBe('business')
    expect(where.OR).toBeTruthy() // expiry filter present
  })

  it('get: falls back to row-id lookup when no keyed fact matches', async () => {
    findFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...ROW, key: null })
    const item = await new AlmaMemoryStore().get(['business'], 'm-1')
    expect(item?.key).toBe('m-1')
    expect(findFirstMock).toHaveBeenCalledTimes(2)
  })

  it('put: delegates to createOrUpdateAgentMemory with the joined scope', async () => {
    await new AlmaMemoryStore().put(['business', 'ALMA_LIFESTYLE'], 'best_seller', {
      content: 'নতুন তথ্য',
      pinned: false,
    })
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'business:ALMA_LIFESTYLE', key: 'best_seller', content: 'নতুন তথ্য' }),
    )
  })

  it('DELETE IS REFUSED — owner-curated memory (project rule)', async () => {
    await expect(new AlmaMemoryStore().delete(['business'], 'best_seller')).rejects.toThrow(/not supported/)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("search with a query rides the head's own semantic ranking", async () => {
    searchMock.mockResolvedValue([
      { id: 'm-2', scope: 'business', key: null, content: 'ঈদের আগে সেল বাড়ে', pinned: false, metadata: null, score: 0.91 },
    ])
    const hits = await new AlmaMemoryStore().search(['business'], { query: 'eid sale pattern', limit: 5 })
    expect(searchMock).toHaveBeenCalledWith({ query: 'eid sale pattern', scope: 'business', limit: 5 })
    expect(hits[0]).toMatchObject({ key: 'm-2', score: 0.91 })
  })

  it('search without a query lists newest live facts under the scope prefix', async () => {
    findManyMock.mockResolvedValue([ROW])
    const hits = await new AlmaMemoryStore().search(['business'])
    expect(hits).toHaveLength(1)
    const where = (findManyMock.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(where.scope).toEqual({ startsWith: 'business' })
    expect(where.OR).toBeTruthy() // expiry filter
  })

  it('listNamespaces maps distinct scopes to paths', async () => {
    findManyMock.mockResolvedValue([{ scope: 'business' }, { scope: 'business:ALMA_TRADING' }])
    const ns = await new AlmaMemoryStore().listNamespaces()
    expect(ns).toEqual([['business'], ['business', 'ALMA_TRADING']])
  })
})
