import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Phase 3 (roadmap 3.4) — the shared durable event publisher used by INLINE
 * turns. Locks the three guarantees replay correctness depends on:
 *   - adjacent deltas coalesce, but chronology across kinds/controls is exact;
 *   - seq is strictly increasing and each row is written exactly once;
 *   - the cursor deduper resumes strictly after `afterSeq` (Last-Event-ID).
 * Prisma is mocked in-memory; Redis is skipped (no REDIS_URL in tests).
 */

interface Row { turnId: string; seq: number; type: string; payload: unknown }
const rows: Row[] = []
const turnUpdates: Array<{ id: string; lastSeq: number }> = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentTurnEvent: {
      upsert: async ({ create }: { create: Row }) => {
        // (turnId, seq) unique: second write with same key is a no-op (upsert update:{})
        if (!rows.some((r) => r.turnId === create.turnId && r.seq === create.seq)) rows.push(create)
        return create
      },
    },
    agentTurn: {
      updateMany: async ({ where, data }: { where: { id: string }; data: { lastSeq: number } }) => {
        turnUpdates.push({ id: where.id, lastSeq: data.lastSeq })
        return { count: 1 }
      },
    },
  },
}))

import { createTurnEventPublisher, createSeqDeduper, getReplayEvents } from '@/agent/lib/turn-events'

beforeEach(() => {
  rows.length = 0
  turnUpdates.length = 0
  delete process.env.REDIS_URL
  delete process.env.LONG_TASK_REDIS_URL
})

describe('Phase 3 — createTurnEventPublisher', () => {
  it('coalesces adjacent deltas and flushes them BEFORE a control event', async () => {
    const pub = createTurnEventPublisher('t1', { coalesceMs: 5_000 })
    pub.emit({ type: 'text_delta', delta: 'আজ' })
    pub.emit({ type: 'text_delta', delta: 'কের ' })
    pub.emit({ type: 'text_delta', delta: 'বিক্রি' })
    pub.emit({ type: 'tool_start', id: 't', name: 'get_sales_summary' })
    const lastSeq = await pub.finish()

    expect(rows.map((r) => r.type)).toEqual(['text_delta', 'tool_start'])
    expect((rows[0].payload as { delta: string }).delta).toBe('আজকের বিক্রি')
    expect(rows.map((r) => r.seq)).toEqual([0, 1])
    expect(lastSeq).toBe(1)
  })

  it('keeps chronology when the delta KIND switches (thinking → text)', async () => {
    const pub = createTurnEventPublisher('t2', { coalesceMs: 5_000 })
    pub.emit({ type: 'thinking_delta', delta: 'ভাবছি…' })
    pub.emit({ type: 'text_delta', delta: 'বস, ' })
    pub.emit({ type: 'text_delta', delta: 'আজ মঙ্গলবার।' })
    pub.emit({ type: 'done', messageId: 'm9' })
    await pub.finish()

    expect(rows.map((r) => r.type)).toEqual(['thinking_delta', 'text_delta', 'done'])
    expect((rows[1].payload as { delta: string }).delta).toBe('বস, আজ মঙ্গলবার।')
  })

  it('flushes oversize deltas early (maxDeltaChars) with increasing seq', async () => {
    const pub = createTurnEventPublisher('t3', { coalesceMs: 5_000, maxDeltaChars: 6 })
    pub.emit({ type: 'text_delta', delta: 'aaaa' })
    pub.emit({ type: 'text_delta', delta: 'bbbb' })   // 8 ≥ 6 → flush
    pub.emit({ type: 'text_delta', delta: 'cc' })
    await pub.finish()

    expect(rows.map((r) => r.seq)).toEqual([0, 1])
    expect((rows[0].payload as { delta: string }).delta).toBe('aaaabbbb')
    expect((rows[1].payload as { delta: string }).delta).toBe('cc')
  })

  it('bumps AgentTurn.lastSeq as rows land (liveness signal)', async () => {
    const pub = createTurnEventPublisher('t4', { coalesceMs: 5_000 })
    pub.emit({ type: 'conversation_id', id: 'c1' })
    pub.emit({ type: 'done', messageId: 'm1' })
    await pub.finish()

    expect(turnUpdates.at(-1)).toEqual({ id: 't4', lastSeq: 1 })
  })
})

describe('Phase 3 — replay cursor semantics', () => {
  it('deduper seeded with afterSeq resumes strictly after the cursor', () => {
    const dedup = createSeqDeduper(7)
    expect(dedup.accept(5)).toBe(false)
    expect(dedup.accept(7)).toBe(false)
    expect(dedup.accept(8)).toBe(true)
    expect(dedup.accept(8)).toBe(false)
    expect(dedup.accept(9)).toBe(true)
  })

  it('getReplayEvents fails open to [] when the store is unreachable', async () => {
    // The mock has no findMany — the helper must warn and return [] (fail-open),
    // never throw into the SSE route.
    const out = await getReplayEvents('missing-turn', 3)
    expect(out).toEqual([])
  })
})
