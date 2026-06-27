import { prisma } from '@/lib/prisma'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'

/**
 * Graph-memory (Task B). A light triple store over the agent's learned knowledge:
 * each edge is `subject -predicate-> object` connecting business entities
 * (customer/order/staff/product/topic). Vector memory answers "what's similar to
 * this text"; the graph answers "what is connected to this entity" — recall by
 * traversal, which flat embedding search cannot do. This is the agent's own
 * learned cross-entity knowledge, NOT a mirror of ERP tables.
 */

export type GraphEntityType = 'customer' | 'order' | 'staff' | 'product' | 'topic' | (string & NonNullable<unknown>)

/** Stable lookup id from a free-text label so the same entity dedupes across edges. */
export function normalizeEntityId(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200)
}

export type RecordEdgeInput = {
  subjectType: string
  subjectLabel: string
  subjectId?: string | null
  predicate: string
  objectType: string
  objectLabel: string
  objectId?: string | null
  note?: string | null
  businessId: AgentBusinessId
}

export type GraphEdge = {
  id: string
  subjectType: string
  subjectId: string
  subjectLabel: string | null
  predicate: string
  objectType: string
  objectId: string
  objectLabel: string | null
  weight: number
  note: string | null
}

/**
 * Upsert one relationship. A repeated triple is reinforced (weight++, lastSeenAt
 * refreshed) rather than duplicated. Labels/note are refreshed to the latest.
 */
export async function recordEdge(input: RecordEdgeInput): Promise<GraphEdge> {
  const subjectType = input.subjectType.trim()
  const objectType = input.objectType.trim()
  const predicate = input.predicate.trim()
  const subjectLabel = input.subjectLabel.trim()
  const objectLabel = input.objectLabel.trim()
  const subjectId = (input.subjectId?.trim() || normalizeEntityId(subjectLabel))
  const objectId = (input.objectId?.trim() || normalizeEntityId(objectLabel))
  const note = input.note?.trim() || null
  const businessId = input.businessId
  const now = new Date()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const edge = await db.agentKnowledgeEdge.upsert({
    where: {
      edge_triple: { businessId, subjectType, subjectId, predicate, objectType, objectId },
    },
    create: {
      subjectType, subjectId, subjectLabel,
      predicate,
      objectType, objectId, objectLabel,
      note, businessId, lastSeenAt: now,
    },
    update: {
      weight: { increment: 1 },
      lastSeenAt: now,
      subjectLabel, objectLabel,
      ...(note ? { note } : {}),
    },
    select: {
      id: true, subjectType: true, subjectId: true, subjectLabel: true,
      predicate: true, objectType: true, objectId: true, objectLabel: true,
      weight: true, note: true,
    },
  })
  return edge as GraphEdge
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

/** One readable line per edge, oriented from the entity that was asked about. */
export function describeEdge(edge: GraphEdge, fromEntityId: string): string {
  const subj = edge.subjectLabel || edge.subjectId
  const obj = edge.objectLabel || edge.objectId
  const tail = edge.note ? ` — ${edge.note}` : ''
  const reinforced = edge.weight > 1 ? ` [x${edge.weight}]` : ''
  // Orient so the queried entity reads naturally as the starting point.
  if (edge.objectId === fromEntityId && edge.subjectId !== fromEntityId) {
    return `${obj} ← ${edge.predicate} ← ${subj} (${edge.subjectType})${tail}${reinforced}`
  }
  return `${subj} → ${edge.predicate} → ${obj} (${edge.objectType})${tail}${reinforced}`
}

export type NeighborhoodResult = {
  entity: { id: string; label: string; type: string | null }
  edges: GraphEdge[]
  lines: string[]
  hops: number
}

/**
 * Fetch the relationship neighborhood around an entity. hop 1 = direct edges
 * (entity as subject or object); hop 2 = edges of those neighbors. Bounded.
 */
export async function getEntityNeighborhood(opts: {
  label: string
  type?: string | null
  businessId: AgentBusinessId
  hops?: number
  limit?: number
}): Promise<NeighborhoodResult> {
  const id = normalizeEntityId(opts.label)
  const hops = clamp(opts.hops ?? 1, 1, 2)
  const limit = clamp(opts.limit ?? 30, 1, 80)
  const businessId = opts.businessId
  const type = opts.type?.trim() || null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const select = {
    id: true, subjectType: true, subjectId: true, subjectLabel: true,
    predicate: true, objectType: true, objectId: true, objectLabel: true,
    weight: true, note: true,
  }

  const hop1: GraphEdge[] = await db.agentKnowledgeEdge.findMany({
    where: {
      businessId,
      OR: [
        { subjectId: id, ...(type ? { subjectType: type } : {}) },
        { objectId: id, ...(type ? { objectType: type } : {}) },
      ],
    },
    orderBy: [{ weight: 'desc' }, { lastSeenAt: 'desc' }],
    take: limit,
    select,
  })

  const seen = new Set(hop1.map((e) => e.id))
  const edges: GraphEdge[] = [...hop1]
  const label =
    hop1.find((e) => e.subjectId === id)?.subjectLabel ||
    hop1.find((e) => e.objectId === id)?.objectLabel ||
    opts.label

  if (hops >= 2 && hop1.length > 0 && edges.length < limit) {
    const neighborIds = new Set<string>()
    for (const e of hop1) {
      if (e.subjectId !== id) neighborIds.add(e.subjectId)
      if (e.objectId !== id) neighborIds.add(e.objectId)
    }
    neighborIds.delete(id)
    const ids = [...neighborIds].slice(0, 12)
    if (ids.length > 0) {
      const hop2: GraphEdge[] = await db.agentKnowledgeEdge.findMany({
        where: {
          businessId,
          OR: [{ subjectId: { in: ids } }, { objectId: { in: ids } }],
        },
        orderBy: [{ weight: 'desc' }, { lastSeenAt: 'desc' }],
        take: limit - edges.length,
        select,
      })
      for (const e of hop2) {
        if (!seen.has(e.id)) {
          seen.add(e.id)
          edges.push(e)
        }
      }
    }
  }

  const lines = edges.map((e) => describeEdge(e, id))
  return {
    entity: { id, label, type },
    edges,
    lines,
    hops,
  }
}
