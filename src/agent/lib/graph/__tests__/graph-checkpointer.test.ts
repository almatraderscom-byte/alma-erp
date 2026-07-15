/**
 * LG-2 graph-checkpointer — offline behaviour lock.
 *
 * The contract that matters: gate discipline (preview ON / production OFF /
 * env force), fail-open on missing config, thread binding to conversationId,
 * durability 'sync', and TTL cleanup shape. `pg` is mocked — no real DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const queryMock = vi.fn()
const endMock = vi.fn()
vi.mock('pg', () => ({
  Pool: class {
    query = queryMock
    end = endMock
    on = vi.fn()
  },
}))
vi.mock('@langchain/langgraph-checkpoint-postgres', () => ({
  PostgresSaver: class {
    constructor(
      public pool: unknown,
      public serde: unknown,
      public options: { schema?: string } = {},
    ) {}
  },
}))

import {
  isGraphCheckpointEnabled,
  getGraphCheckpointer,
  checkpointConfigFor,
  cleanupGraphCheckpoints,
  __resetGraphCheckpointerForTests,
  CHECKPOINT_TTL_DAYS,
} from '../graph-checkpointer'

const ENV_KEYS = ['AGENT_LANGGRAPH_CHECKPOINT', 'VERCEL_ENV', 'DATABASE_URL'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  queryMock.mockReset()
  __resetGraphCheckpointerForTests()
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetGraphCheckpointerForTests()
})

describe('isGraphCheckpointEnabled (rollout discipline)', () => {
  it('force-on / kill switch / preview default / production default', () => {
    expect(isGraphCheckpointEnabled('true', 'production')).toBe(true)
    expect(isGraphCheckpointEnabled('false', 'preview')).toBe(false)
    expect(isGraphCheckpointEnabled(undefined, 'preview')).toBe(true)
    expect(isGraphCheckpointEnabled(undefined, 'production')).toBe(false)
    expect(isGraphCheckpointEnabled(undefined, undefined)).toBe(false)
  })
})

describe('getGraphCheckpointer', () => {
  it('gate off → null (production default)', () => {
    delete process.env.AGENT_LANGGRAPH_CHECKPOINT
    process.env.VERCEL_ENV = 'production'
    expect(getGraphCheckpointer()).toBeNull()
  })

  it('gate on but no DATABASE_URL → null, fail-open', () => {
    process.env.AGENT_LANGGRAPH_CHECKPOINT = 'true'
    delete process.env.DATABASE_URL
    expect(getGraphCheckpointer()).toBeNull()
  })

  it('gate on + DATABASE_URL → singleton PostgresSaver on the langgraph schema', () => {
    process.env.AGENT_LANGGRAPH_CHECKPOINT = 'true'
    process.env.DATABASE_URL = 'postgres://u:p@host:6543/db'
    const a = getGraphCheckpointer()
    expect(a).not.toBeNull()
    expect((a as unknown as { options: { schema: string } }).options.schema).toBe('langgraph')
    expect(getGraphCheckpointer()).toBe(a) // singleton
  })
})

describe('checkpointConfigFor (thread binding)', () => {
  it('thread_id = conversationId, ns per graph, turnId in metadata, durability sync', () => {
    const cfg = checkpointConfigFor({ conversationId: 'conv-9', turnId: 't-1', namespace: 'routine' })
    expect(cfg.configurable.thread_id).toBe('conv-9')
    expect(cfg.configurable.checkpoint_ns).toBe('routine')
    expect(cfg.metadata.turnId).toBe('t-1')
    // Serverless can freeze the process the moment the response flushes —
    // every super-step must persist BEFORE the next starts, or the step that
    // made the turn resumable is exactly the one that gets lost.
    expect(cfg.durability).toBe('sync')
  })

  it('no conversationId → stable turn-scoped thread (never a shared bucket)', () => {
    const cfg = checkpointConfigFor({ turnId: 't-7', namespace: 'routine' })
    expect(cfg.configurable.thread_id).toBe('turn:t-7')
  })
})

describe('cleanupGraphCheckpoints (TTL)', () => {
  it('gate off → null and NO query', async () => {
    delete process.env.AGENT_LANGGRAPH_CHECKPOINT
    process.env.VERCEL_ENV = 'production'
    expect(await cleanupGraphCheckpoints()).toBeNull()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('deletes whole stale threads with the default TTL', async () => {
    process.env.AGENT_LANGGRAPH_CHECKPOINT = 'true'
    process.env.DATABASE_URL = 'postgres://u:p@host:6543/db'
    queryMock.mockResolvedValue({ rows: [{ threads: 3 }] })
    const r = await cleanupGraphCheckpoints()
    expect(r).toEqual({ threads: 3 })
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('HAVING max(created_at)')
    expect(sql).toContain('"langgraph"."checkpoint_writes"')
    expect(sql).toContain('"langgraph"."checkpoint_blobs"')
    expect(sql).toContain('"langgraph"."checkpoints"')
    expect(params).toEqual([CHECKPOINT_TTL_DAYS])
  })

  it('query failure → null, never throws', async () => {
    process.env.AGENT_LANGGRAPH_CHECKPOINT = 'true'
    process.env.DATABASE_URL = 'postgres://u:p@host:6543/db'
    queryMock.mockRejectedValue(new Error('pooler down'))
    expect(await cleanupGraphCheckpoints()).toBeNull()
  })
})
