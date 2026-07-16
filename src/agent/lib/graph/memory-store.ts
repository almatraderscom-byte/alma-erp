/**
 * LG-7 — LangGraph long-term memory via a BaseStore ADAPTER over the EXISTING
 * pgvector `agent_memory` table (docs/langgraph-adoption-roadmap.md).
 *
 * No data migration, no second memory system: this is a thin translation
 * layer so graph nodes (and later `Send` subgraphs) read memory through
 * LangGraph's standard Store interface while the data, embeddings, expiry
 * rules and weekly revision stay EXACTLY where they are today.
 *
 *   namespace  → the existing `scope` string as a single-element path
 *                (e.g. ['business'], ['personal']) — nested paths join with
 *                ':' to match the scope convention already in the table
 *   key        → AgentMemory.key (keyed facts) or the row id
 *   value      → { content, metadata, pinned, importance }
 *   search     → delegates to searchAgentMemory (the SAME embedding search
 *                the head's recall uses — one ranking, one truth)
 *   put        → delegates to createOrUpdateAgentMemory (embedding, expiry
 *                and importance hard-rules all apply unchanged)
 *   delete     → REFUSED. Owner-facing memory is deleted only via the owner's
 *                own flows and the weekly revision (project rule: the head is
 *                the single writer/curator of memory). A graph node that
 *                needs deletion is a design smell, not a missing feature.
 *
 * Fail-open discipline: getAlmaMemoryStore() returns null when gated off —
 * callers compile their graph without a store, exactly like the checkpointer.
 * Gate: AGENT_LANGGRAPH_STORE — preview ON, production OFF, false = kill.
 */
import { BaseStore } from '@langchain/langgraph'
import type { Item, Operation, OperationResults } from '@langchain/langgraph'
import type { SearchItem } from '@langchain/langgraph-checkpoint'
import { prisma } from '@/lib/prisma'
import { searchAgentMemory } from '@/agent/lib/memory-search'
import { createOrUpdateAgentMemory } from '@/agent/lib/agent-memory'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export function isMemoryStoreEnabled(
  flag = process.env.AGENT_LANGGRAPH_STORE,
  vercelEnv = process.env.VERCEL_ENV,
): boolean {
  if (flag === 'true') return true
  if (flag === 'false') return false
  return vercelEnv === 'preview'
}

const nsToScope = (namespace: string[]): string => namespace.join(':')
const scopeToNs = (scope: string): string[] => scope.split(':')

type MemoryRow = {
  id: string
  scope: string
  key: string | null
  content: string
  pinned: boolean
  metadata: Record<string, unknown> | null
  importance?: number
  createdAt: Date
  updatedAt: Date
}

function rowToItem(row: MemoryRow): Item {
  return {
    namespace: scopeToNs(row.scope),
    key: row.key ?? row.id,
    value: {
      content: row.content,
      metadata: row.metadata ?? null,
      pinned: row.pinned,
      ...(row.importance !== undefined ? { importance: row.importance } : {}),
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export class AlmaMemoryStore extends BaseStore {
  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results: unknown[] = []
    for (const op of operations) {
      if ('key' in op && 'namespace' in op && !('value' in op)) {
        results.push(await this.getItem(op.namespace, op.key))
      } else if ('value' in op) {
        results.push(await this.putItem(op.namespace, op.key, op.value))
      } else if ('namespacePrefix' in op) {
        results.push(
          await this.searchItems(op.namespacePrefix, {
            query: op.query,
            limit: op.limit,
          }),
        )
      } else {
        results.push(await this.listScopes(op.limit ?? 100, op.offset ?? 0))
      }
    }
    return results as OperationResults<Op>
  }

  private async getItem(namespace: string[], key: string): Promise<Item | null> {
    const scope = nsToScope(namespace)
    const row: MemoryRow | null =
      (await db.agentMemory.findFirst({
        where: { scope, key, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      })) ??
      (await db.agentMemory.findFirst({
        where: { scope, id: key, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      }))
    return row ? rowToItem(row) : null
  }

  private async putItem(
    namespace: string[],
    key: string,
    value: Record<string, unknown> | null,
  ): Promise<void> {
    if (value === null) {
      // See module doc: deletion stays with the owner's flows + weekly revision.
      throw new Error(
        'AlmaMemoryStore: delete is not supported — owner-facing memory is curated only by the head/owner flows',
      )
    }
    await createOrUpdateAgentMemory({
      scope: nsToScope(namespace),
      key,
      content: String(value.content ?? ''),
      pinned: value.pinned === true,
      metadata: (value.metadata as Record<string, unknown> | null) ?? null,
      importance: typeof value.importance === 'number' ? value.importance : null,
    })
  }

  private async searchItems(
    namespacePrefix: string[],
    opts: { query?: string; limit?: number },
  ): Promise<SearchItem[]> {
    const scope = nsToScope(namespacePrefix)
    if (!opts.query?.trim()) {
      // Listing without a semantic query: newest live facts under the scope.
      const rows: MemoryRow[] = await db.agentMemory.findMany({
        where: {
          scope: { startsWith: scope },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: { updatedAt: 'desc' },
        take: Math.min(opts.limit ?? 10, 50),
      })
      return rows.map((r) => ({ ...rowToItem(r) }))
    }
    // Semantic search = the head's own recall ranking (embedding + fallback).
    const hits = await searchAgentMemory({ query: opts.query, scope, limit: opts.limit ?? 10 })
    const now = new Date()
    return hits.map((h) => ({
      namespace: scopeToNs(h.scope),
      key: h.key ?? h.id,
      value: { content: h.content, metadata: h.metadata, pinned: h.pinned },
      createdAt: now, // search hits don't carry timestamps; not worth a second query
      updatedAt: now,
      ...(h.score !== null ? { score: h.score } : {}),
    }))
  }

  private async listScopes(limit: number, offset: number): Promise<string[][]> {
    const rows: Array<{ scope: string }> = await db.agentMemory.findMany({
      distinct: ['scope'],
      select: { scope: true },
      orderBy: { scope: 'asc' },
      take: limit,
      skip: offset,
    })
    return rows.map((r) => scopeToNs(r.scope))
  }
}

let store: AlmaMemoryStore | null = null

/** The shared store, or null when gated off — callers compile without it. */
export function getAlmaMemoryStore(): AlmaMemoryStore | null {
  if (!isMemoryStoreEnabled()) return null
  if (!store) {
    store = new AlmaMemoryStore()
    console.log('[memory-store] gate: enabled=true (BaseStore adapter over agent_memory)')
  }
  return store
}

/** Test hook (vitest only). */
export function __resetMemoryStoreForTests(): void {
  store = null
}
