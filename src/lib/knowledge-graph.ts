import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const GLOBAL_ENTITY_ID = '_global'

function normalizeEntityId(entityId?: string | null): string {
  return entityId?.trim() || GLOBAL_ENTITY_ID
}

export type KnowledgeFact = {
  id: string
  entityType: string
  entityId: string | null
  entityName: string | null
  attribute: string
  value: string
  confidence: number
  evidenceCount: number
  source: string | null
}

/** Upsert a business fact. Confidence grows as evidence accumulates (capped at 0.95). */
export async function learnFact(args: {
  entityType: string
  entityId?: string
  entityName?: string
  attribute: string
  value: string
  source?: string
  confidenceDelta?: number
}) {
  const entityId = normalizeEntityId(args.entityId)
  const key = { entityType: args.entityType, entityId, attribute: args.attribute }

  try {
    const existing = await db.agentKnowledge.findUnique({
      where: { entityType_entityId_attribute: key },
    }) as KnowledgeFact | null

    if (existing) {
      await db.agentKnowledge.update({
        where: { id: existing.id },
        data: {
          value: args.value,
          entityName: args.entityName ?? existing.entityName,
          confidence: Math.min(0.95, existing.confidence + (args.confidenceDelta ?? 0.05)),
          evidenceCount: existing.evidenceCount + 1,
          source: args.source ?? existing.source,
        },
      })
      return { updated: true }
    }

    await db.agentKnowledge.create({
      data: {
        entityType: args.entityType,
        entityId,
        entityName: args.entityName ?? null,
        attribute: args.attribute,
        value: args.value,
        confidence: 0.5,
        source: args.source ?? 'derived',
      },
    })
    return { created: true }
  } catch (e) {
    console.warn('[knowledge] upsert failed', e)
    return null
  }
}

/** Read facts for an entity type (optionally filtered by id). */
export async function recallFacts(entityType: string, entityId?: string): Promise<KnowledgeFact[]> {
  const where: Record<string, string> = { entityType }
  if (entityId) where.entityId = normalizeEntityId(entityId)

  return db.agentKnowledge.findMany({
    where,
    orderBy: { confidence: 'desc' },
    take: 30,
  }) as Promise<KnowledgeFact[]>
}

/** Fuzzy match facts by entity name (Bangla/product names). */
export async function searchFactsByName(
  entityType: string,
  entityName: string,
): Promise<KnowledgeFact[]> {
  const q = entityName.trim()
  if (!q) return recallFacts(entityType)

  const rows = await db.agentKnowledge.findMany({
    where: {
      entityType,
      OR: [
        { entityName: { contains: q, mode: 'insensitive' } },
        { entityId: { contains: q, mode: 'insensitive' } },
        { value: { contains: q, mode: 'insensitive' } },
      ],
    },
    orderBy: { confidence: 'desc' },
    take: 20,
  }) as KnowledgeFact[]

  if (rows.length) return rows
  return recallFacts(entityType)
}

export function formatFactLine(f: Pick<KnowledgeFact, 'attribute' | 'value' | 'confidence'>): string {
  const conf = Math.round(f.confidence * 100)
  const label =
    conf >= 75 ? 'উচ্চ নিশ্চয়তা' : conf >= 55 ? 'মাঝারি' : 'সম্ভাব্য'
  return `${f.value} (${label}, ${conf}%)`
}

export async function getKnowledgeNoteForProduct(productId: string, productName?: string): Promise<string | null> {
  const facts = await recallFacts('product', productId)
  if (!facts.length && productName) {
    const byName = await searchFactsByName('product', productName)
    if (byName.length) return pickBriefingNotes(byName)
  }
  return pickBriefingNotes(facts)
}

function pickBriefingNotes(facts: KnowledgeFact[]): string | null {
  const attrs = ['peak_season', 'seasonality', 'sales_trend', 'best_content_type', 'avg_weekly_sales']
  const parts: string[] = []
  for (const attr of attrs) {
    const f = facts.find((x) => x.attribute === attr)
    if (f && f.confidence >= 0.45) parts.push(formatFactLine(f))
  }
  return parts.length ? parts.slice(0, 2).join(' · ') : null
}
