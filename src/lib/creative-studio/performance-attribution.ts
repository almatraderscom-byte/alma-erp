import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import {
  requireStudioBrandAccess,
  type StudioActor,
} from '@/lib/creative-studio/studio-access'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any
type AnyRecord = Record<string, unknown>

export type MetaPerformanceMetrics = {
  externalObjectId: string
  reach: number
  impressions: number
  engagements: number
  clicks: number
  conversions: number
  spendAmount: number | null
  spendCurrency: string | null
  revenueBdt: number | null
  sourceWindow: string
  raw: AnyRecord
}

export type PerformanceCandidate = {
  snapshotId: string
  assetVersionId: string
  sceneKey: string
  reach: number
  impressions: number
  engagements: number
  clicks: number
  conversions: number
}

export type PerformanceWinner = PerformanceCandidate & {
  score: number
  runnerUpScore: number
  comparedVersionIds: string[]
}

export type MetaPerformanceFetcher = (delivery: {
  id: string
  platform: 'facebook' | 'instagram'
  pageRef: string
  externalPostId: string
  adId: string | null
}) => Promise<MetaPerformanceMetrics>

export class PerformanceAttributionError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status = 422) {
    super(code)
    this.name = 'PerformanceAttributionError'
    this.code = code
    this.status = status
  }
}

function record(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as AnyRecord
    : {}
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(String(value ?? ''))
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date(0).toISOString()
}

function nonNegativeInt(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0
}

export function normalizePerformanceMetrics(
  value: Partial<MetaPerformanceMetrics>,
): MetaPerformanceMetrics {
  const externalObjectId = String(value.externalObjectId ?? '').trim().slice(0, 160)
  const sourceWindow = String(value.sourceWindow ?? '').trim().slice(0, 160)
  if (!externalObjectId) throw new PerformanceAttributionError('external_object_id_required')
  if (!sourceWindow) throw new PerformanceAttributionError('performance_window_required')
  const spend = value.spendAmount == null ? null : Number(value.spendAmount)
  const currency = typeof value.spendCurrency === 'string'
    ? value.spendCurrency.trim().toUpperCase().slice(0, 12)
    : null
  return {
    externalObjectId,
    sourceWindow,
    reach: nonNegativeInt(value.reach),
    impressions: nonNegativeInt(value.impressions),
    engagements: nonNegativeInt(value.engagements),
    clicks: nonNegativeInt(value.clicks),
    conversions: nonNegativeInt(value.conversions),
    spendAmount: spend !== null && Number.isFinite(spend) ? Math.max(0, Math.round(spend * 100) / 100) : null,
    spendCurrency: currency || null,
    revenueBdt: value.revenueBdt == null ? null : Math.max(0, roundMoney(Number(value.revenueBdt) || 0)),
    raw: record(value.raw),
  }
}

export function deterministicPerformanceScore(input: {
  reach: number
  engagements: number
  clicks: number
  conversions: number
}): number {
  return nonNegativeInt(input.reach)
    + nonNegativeInt(input.engagements) * 4
    + nonNegativeInt(input.clicks) * 8
    + nonNegativeInt(input.conversions) * 50
}

export function selectDeterministicPerformanceWinner(
  candidates: PerformanceCandidate[],
): PerformanceWinner | null {
  const eligible = candidates
    .filter((candidate) => nonNegativeInt(candidate.impressions) >= 100)
    .filter((candidate, index, rows) => (
      rows.findIndex((row) => row.assetVersionId === candidate.assetVersionId) === index
    ))
    .map((candidate) => ({
      ...candidate,
      score: deterministicPerformanceScore(candidate),
    }))
    .sort((a, b) => (
      b.score - a.score
      || b.impressions - a.impressions
      || a.assetVersionId.localeCompare(b.assetVersionId)
    ))
  if (eligible.length < 2) return null
  const [winner, runnerUp] = eligible
  if (winner.score < 100 || winner.score * 10 < runnerUp.score * 11) return null
  return {
    ...winner,
    runnerUpScore: runnerUp.score,
    comparedVersionIds: eligible.map((candidate) => candidate.assetVersionId),
  }
}

export function nextDeterministicSceneWeight(previousWeight: number): number {
  return Math.min(150, Math.max(50, nonNegativeInt(previousWeight) || 100) + 5)
}

export function performanceSourceFingerprint(input: {
  deliveryId: string
  sourceWindow: string
  metrics: MetaPerformanceMetrics
}): string {
  return createHash('sha256').update(JSON.stringify({
    deliveryId: input.deliveryId,
    sourceWindow: input.sourceWindow,
    externalObjectId: input.metrics.externalObjectId,
    reach: input.metrics.reach,
    impressions: input.metrics.impressions,
    engagements: input.metrics.engagements,
    clicks: input.metrics.clicks,
    conversions: input.metrics.conversions,
    spendAmount: input.metrics.spendAmount,
    spendCurrency: input.metrics.spendCurrency,
  })).digest('hex')
}

async function applyDeterministicFeedback(input: {
  snapshotId: string
  recipeId: string | null
  now: Date
}): Promise<{ applied: boolean; reason: string; sceneKey?: string; nextWeight?: number }> {
  if (!input.recipeId) return { applied: false, reason: 'recipe_missing' }
  const alreadyApplied = await db.creativePerformanceFeedbackEvent.findUnique({
    where: { sourceSnapshotId: input.snapshotId },
    select: { id: true },
  })
  if (alreadyApplied) return { applied: false, reason: 'snapshot_feedback_already_applied' }
  const since = new Date(input.now.getTime() - 90 * 24 * 60 * 60_000)
  const snapshots = await db.creativePerformanceSnapshot.findMany({
    where: {
      capturedAt: { gte: since },
      delivery: { recipeId: input.recipeId, status: 'PUBLISHED' },
    },
    include: {
      delivery: { select: { sceneKey: true } },
    },
    orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
    take: 200,
  })
  const latestByVersion = new Map<string, AnyRecord>()
  for (const snapshot of snapshots) {
    const versionId = String(snapshot.assetVersionId)
    if (!latestByVersion.has(versionId)) latestByVersion.set(versionId, snapshot)
  }
  const candidates: PerformanceCandidate[] = [...latestByVersion.values()].map((snapshot) => ({
    snapshotId: String(snapshot.id),
    assetVersionId: String(snapshot.assetVersionId),
    sceneKey: String(record(snapshot.delivery).sceneKey ?? 'unclassified'),
    reach: Number(snapshot.reach ?? 0),
    impressions: Number(snapshot.impressions ?? 0),
    engagements: Number(snapshot.engagements ?? 0),
    clicks: Number(snapshot.clicks ?? 0),
    conversions: Number(snapshot.conversions ?? 0),
  }))
  const winner = selectDeterministicPerformanceWinner(candidates)
  if (!winner) return { applied: false, reason: 'insufficient_deterministic_margin' }
  if (winner.snapshotId !== input.snapshotId) {
    return { applied: false, reason: 'new_snapshot_not_winner' }
  }

  const weeklyCutoff = new Date(input.now.getTime() - 7 * 24 * 60 * 60_000)
  const recent = await db.creativePerformanceFeedbackEvent.findFirst({
    where: {
      createdAt: { gte: weeklyCutoff },
      weight: {
        recipeId: input.recipeId,
        sceneKey: winner.sceneKey,
      },
    },
    select: { id: true },
  })
  if (recent) return { applied: false, reason: 'weekly_weight_window_already_applied' }

  const result = await db.$transaction(async (tx: typeof db) => {
    const weight = await tx.creativeRecipePerformanceWeight.upsert({
      where: {
        recipeId_sceneKey: {
          recipeId: input.recipeId!,
          sceneKey: winner.sceneKey,
        },
      },
      create: {
        recipeId: input.recipeId!,
        sceneKey: winner.sceneKey,
        weight: 100,
        sampleCount: 0,
      },
      update: {},
    })
    const previousWeight = Number(weight.weight)
    const nextWeight = nextDeterministicSceneWeight(previousWeight)
    await tx.creativeRecipePerformanceWeight.update({
      where: { id: weight.id },
      data: {
        weight: nextWeight,
        sampleCount: { increment: winner.comparedVersionIds.length },
      },
    })
    await tx.creativePerformanceFeedbackEvent.create({
      data: {
        weightId: weight.id,
        sourceSnapshotId: input.snapshotId,
        winnerAssetVersionId: winner.assetVersionId,
        comparedVersionIds: winner.comparedVersionIds,
        score: winner.score,
        previousWeight,
        nextWeight,
        reasonCode: 'metrics_margin_10pct_min_100_impressions',
      },
    })
    return nextWeight
  })
  return {
    applied: true,
    reason: 'deterministic_winner_weighted',
    sceneKey: winner.sceneKey,
    nextWeight: result,
  }
}

export async function syncDueCreativePerformance(input: {
  fetchMetrics: MetaPerformanceFetcher
  now?: Date
  limit?: number
}): Promise<{
  processed: number
  inserted: number
  deduplicated: number
  failed: number
  feedbackApplied: number
  results: Array<{ deliveryId: string; ok: boolean; error?: string }>
}> {
  const now = input.now ?? new Date()
  const limit = Math.max(1, Math.min(25, Math.round(input.limit ?? 10)))
  const deliveries = await db.creativePublishDelivery.findMany({
    where: {
      status: 'PUBLISHED',
      externalPostId: { not: null },
      OR: [{ metricsNextSyncAt: null }, { metricsNextSyncAt: { lte: now } }],
    },
    orderBy: [{ metricsNextSyncAt: 'asc' }, { publishedAt: 'asc' }],
    take: limit,
  })
  const summary = {
    processed: 0,
    inserted: 0,
    deduplicated: 0,
    failed: 0,
    feedbackApplied: 0,
    results: [] as Array<{ deliveryId: string; ok: boolean; error?: string }>,
  }
  for (const delivery of deliveries) {
    summary.processed += 1
    try {
      const metrics = normalizePerformanceMetrics(await input.fetchMetrics({
        id: String(delivery.id),
        platform: String(delivery.platform).toLowerCase() as 'facebook' | 'instagram',
        pageRef: String(delivery.pageRef),
        externalPostId: String(delivery.externalPostId),
        adId: typeof delivery.adId === 'string' ? delivery.adId : null,
      }))
      const sourceFingerprint = performanceSourceFingerprint({
        deliveryId: String(delivery.id),
        sourceWindow: metrics.sourceWindow,
        metrics,
      })
      const existing = await db.creativePerformanceSnapshot.findUnique({
        where: { sourceFingerprint },
        select: { id: true },
      })
      let snapshotId: string
      if (existing) {
        snapshotId = String(existing.id)
        summary.deduplicated += 1
      } else {
        const snapshot = await db.creativePerformanceSnapshot.create({
          data: {
            deliveryId: delivery.id,
            assetVersionId: delivery.assetVersionId,
            campaignPackId: delivery.campaignPackId,
            externalObjectId: metrics.externalObjectId,
            source: 'meta_graph',
            sourceFingerprint,
            reach: metrics.reach,
            impressions: metrics.impressions,
            engagements: metrics.engagements,
            clicks: metrics.clicks,
            conversions: metrics.conversions,
            spendAmount: metrics.spendAmount,
            spendCurrency: metrics.spendCurrency,
            revenueBdt: metrics.revenueBdt,
            rawMetrics: metrics.raw,
            capturedAt: now,
          },
        })
        snapshotId = String(snapshot.id)
        summary.inserted += 1
      }
      const feedback = await applyDeterministicFeedback({
        snapshotId,
        recipeId: typeof delivery.recipeId === 'string' ? delivery.recipeId : null,
        now,
      })
      if (feedback.applied) summary.feedbackApplied += 1
      await db.creativePublishDelivery.update({
        where: { id: delivery.id },
        data: {
          metricsLastSyncedAt: now,
          metricsNextSyncAt: new Date(now.getTime() + 24 * 60 * 60_000),
          metricsLastError: null,
        },
      })
      summary.results.push({ deliveryId: String(delivery.id), ok: true })
      void snapshotId
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      summary.failed += 1
      await db.creativePublishDelivery.update({
        where: { id: delivery.id },
        data: {
          metricsNextSyncAt: new Date(now.getTime() + 6 * 60 * 60_000),
          metricsLastError: message.slice(0, 2_000),
        },
      })
      summary.results.push({ deliveryId: String(delivery.id), ok: false, error: message })
    }
  }
  return summary
}

function serializeSnapshot(row: AnyRecord) {
  return {
    id: String(row.id),
    deliveryId: String(row.deliveryId),
    assetVersionId: String(row.assetVersionId),
    campaignPackId: typeof row.campaignPackId === 'string' ? row.campaignPackId : null,
    externalObjectId: String(row.externalObjectId),
    reach: Number(row.reach ?? 0),
    impressions: Number(row.impressions ?? 0),
    engagements: Number(row.engagements ?? 0),
    clicks: Number(row.clicks ?? 0),
    conversions: Number(row.conversions ?? 0),
    spendAmount: row.spendAmount == null ? null : Number(row.spendAmount),
    spendCurrency: typeof row.spendCurrency === 'string' ? row.spendCurrency : null,
    revenueBdt: row.revenueBdt == null ? null : roundMoney(Number(row.revenueBdt)),
    capturedAt: iso(row.capturedAt),
  }
}

export async function getCreativePerformanceDashboard(
  actor: StudioActor,
  input: {
    brandProfileId: string
    projectId?: string | null
    assetId?: string | null
  },
) {
  const brandProfileId = String(input.brandProfileId ?? '').trim()
  if (!brandProfileId) throw new PerformanceAttributionError('brand_profile_id_required')
  const access = await requireStudioBrandAccess(actor, brandProfileId)
  const deliveryWhere: AnyRecord = {
    ownerId: access.ownerId,
    brandProfileId,
  }
  if (input.projectId) deliveryWhere.projectId = input.projectId
  if (input.assetId) deliveryWhere.assetId = input.assetId
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000)

  const [
    deliveries,
    oldestQueued,
    recentDeliveryCount,
    recentProblemCount,
    spend,
    qcRows,
    workerHeartbeat,
    archivePending,
    archiveOldest,
    weights,
  ] = await Promise.all([
    db.creativePublishDelivery.findMany({
      where: deliveryWhere,
      include: {
        performanceSnapshots: {
          orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
          take: 1,
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    }),
    db.creativePublishDelivery.findFirst({
      where: { ...deliveryWhere, status: { in: ['SCHEDULED', 'FAILED_RETRYABLE'] } },
      orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
      select: { scheduledFor: true },
    }),
    db.creativePublishDelivery.count({
      where: { ...deliveryWhere, createdAt: { gte: sevenDaysAgo } },
    }),
    db.creativePublishDelivery.count({
      where: {
        ...deliveryWhere,
        createdAt: { gte: sevenDaysAgo },
        status: { in: ['FAILED_RETRYABLE', 'NEEDS_REVIEW'] },
      },
    }),
    db.agentCostEvent.aggregate({
      where: { occurredAt: { gte: sevenDaysAgo } },
      _sum: { costUsd: true },
    }),
    db.creativeAssetVersion.findMany({
      where: {
        createdAt: { gte: sevenDaysAgo },
        asset: { project: { brandProfileId } },
      },
      select: { qc: true },
      take: 1_000,
    }),
    db.agentKvSetting.findUnique({
      where: { key: 'worker_heartbeat_at' },
      select: { value: true },
    }),
    db.creativeArchiveReceipt.count({
      where: { verifiedAt: null },
    }),
    db.creativeArchiveReceipt.findFirst({
      where: { verifiedAt: null },
      orderBy: { archivedAt: 'asc' },
      select: { archivedAt: true },
    }),
    db.creativeRecipePerformanceWeight.findMany({
      where: {
        recipe: { brandProfileId },
      },
      orderBy: [{ weight: 'desc' }, { sceneKey: 'asc' }],
      take: 30,
    }),
  ])

  let qcMeasured = 0
  let qcPassed = 0
  for (const row of qcRows as AnyRecord[]) {
    const qc = record(row.qc)
    const verdict = String(qc.verdict ?? qc.status ?? '').toLowerCase()
    if (!verdict) continue
    qcMeasured += 1
    if (verdict === 'pass' || verdict === 'passed' || qc.passed === true) qcPassed += 1
  }
  const latestSnapshots: ReturnType<typeof serializeSnapshot>[] = deliveries.flatMap((delivery: AnyRecord) => (
    Array.isArray(delivery.performanceSnapshots) && delivery.performanceSnapshots[0]
      ? [serializeSnapshot(delivery.performanceSnapshots[0])]
      : []
  ))
  const totals = latestSnapshots.reduce<{
    reach: number
    impressions: number
    engagements: number
    clicks: number
    conversions: number
  }>((sum, snapshot) => ({
    reach: sum.reach + snapshot.reach,
    impressions: sum.impressions + snapshot.impressions,
    engagements: sum.engagements + snapshot.engagements,
    clicks: sum.clicks + snapshot.clicks,
    conversions: sum.conversions + snapshot.conversions,
  }), { reach: 0, impressions: 0, engagements: 0, clicks: 0, conversions: 0 })
  const now = Date.now()
  const workerHeartbeatAt = workerHeartbeat?.value
    ? new Date(String(workerHeartbeat.value))
    : null

  return {
    scope: {
      brandProfileId,
      projectId: input.projectId ?? null,
      assetId: input.assetId ?? null,
      role: access.role,
    },
    totals,
    deliveries: deliveries.map((delivery: AnyRecord) => ({
      id: String(delivery.id),
      assetId: String(delivery.assetId),
      assetVersionId: String(delivery.assetVersionId),
      campaignPackId: typeof delivery.campaignPackId === 'string' ? delivery.campaignPackId : null,
      sceneKey: String(delivery.sceneKey),
      platform: String(delivery.platform).toLowerCase(),
      status: String(delivery.status).toLowerCase(),
      postId: typeof delivery.externalPostId === 'string' ? delivery.externalPostId : null,
      permalinkUrl: typeof delivery.permalinkUrl === 'string' ? delivery.permalinkUrl : null,
      latestSnapshot: Array.isArray(delivery.performanceSnapshots) && delivery.performanceSnapshots[0]
        ? serializeSnapshot(delivery.performanceSnapshots[0])
        : null,
    })),
    weights: weights.map((weight: AnyRecord) => ({
      recipeId: String(weight.recipeId),
      sceneKey: String(weight.sceneKey),
      weight: Number(weight.weight),
      sampleCount: Number(weight.sampleCount),
      updatedAt: iso(weight.updatedAt),
    })),
    observability: {
      queueAgeSec: oldestQueued
        ? Math.max(0, Math.round((now - new Date(oldestQueued.scheduledFor).getTime()) / 1_000))
        : 0,
      workerHeartbeatAt: workerHeartbeatAt && Number.isFinite(workerHeartbeatAt.getTime())
        ? workerHeartbeatAt.toISOString()
        : null,
      workerHeartbeatAgeSec: workerHeartbeatAt && Number.isFinite(workerHeartbeatAt.getTime())
        ? Math.max(0, Math.round((now - workerHeartbeatAt.getTime()) / 1_000))
        : null,
      providerErrorRatePct: recentDeliveryCount
        ? Math.round((recentProblemCount / recentDeliveryCount) * 10_000) / 100
        : 0,
      spendUsd7d: Number(spend?._sum?.costUsd ?? 0),
      qcRatePct7d: qcMeasured ? Math.round((qcPassed / qcMeasured) * 10_000) / 100 : null,
      archivePending,
      archiveLagHours: archiveOldest
        ? Math.max(0, Math.round((now - new Date(archiveOldest.archivedAt).getTime()) / 3_600_000))
        : 0,
      publishFailures7d: recentProblemCount,
    },
  }
}

export function performanceAttributionErrorResponse(error: unknown, event: string): Response {
  if (error instanceof PerformanceAttributionError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status })
  }
  console.error(`[${event}] request failed`, error)
  return Response.json({ error: 'creative_performance_failed' }, { status: 500 })
}
