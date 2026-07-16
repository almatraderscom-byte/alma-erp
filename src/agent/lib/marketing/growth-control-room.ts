/**
 * Phase 48 — the growth control room: ONE joined view of experiments, ads
 * changes, organic calendar, measurement truth, capability health, and
 * pending approvals — so the owner (and the head) reason from a single
 * evidence-backed picture instead of six scattered reports.
 *
 * Read-only. Every section degrades to `available:false` on its own —
 * a broken source never hides the rest.
 */
import { prisma } from '@/lib/prisma'
import { assessMeasurementHealth, type MeasurementHealth } from '@/agent/lib/marketing/measurement-health'
import { getCalendarHealth, type CalendarHealth } from '@/agent/lib/marketing/content-calendar'
import { listExperiments, listLearnings } from '@/agent/lib/marketing/experiment-registry'
import { getApprovedBrief } from '@/agent/lib/marketing/growth-brief'
import { capiHealth, type CapiHealth } from '@/agent/lib/marketing/meta-capi'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

interface Section<T> {
  available: boolean
  data: T | null
  error?: string
}

export interface GrowthControlRoom {
  generatedAt: string
  brief: Section<{ version: number; objective: string | null; monthlyBudgetCapBdt: number | null }>
  experiments: Section<{ running: number; drafts: number; recent: Array<{ name: string; status: string }> }>
  learnings: Section<Array<{ name: string; status: string; learning: string }>>
  adsChanges: Section<Array<{ actionType: string; at: string; resourceId: string | null }>>
  calendar: Section<CalendarHealth>
  measurement: Section<MeasurementHealth>
  capi: Section<CapiHealth>
  approvals: Section<{ pendingCount: number }>
}

async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { available: true, data: await fn() }
  } catch (err) {
    return { available: false, data: null, error: err instanceof Error ? err.message.slice(0, 200) : String(err) }
  }
}

/** Assemble the control room snapshot. Never throws. */
export async function buildGrowthControlRoom(windowDays = 7): Promise<GrowthControlRoom> {
  const [brief, experiments, learnings, adsChanges, calendar, measurement, capi, approvals] = await Promise.all([
    section(async () => {
      const b = await getApprovedBrief('ALMA_LIFESTYLE')
      if (!b) throw new Error('no approved growth brief')
      return {
        version: b.version,
        objective: b.brief.objective ?? null,
        monthlyBudgetCapBdt: b.brief.economics?.monthlyBudgetCapBdt ?? null,
      }
    }),
    section(async () => {
      const rows = await listExperiments({ limit: 20 })
      return {
        running: rows.filter((r) => r.status === 'running').length,
        drafts: rows.filter((r) => r.status === 'draft').length,
        recent: rows.slice(0, 8).map((r) => ({ name: r.name, status: r.status })),
      }
    }),
    section(async () => (await listLearnings('ALMA_LIFESTYLE', 8)).map((l) => ({ name: l.name, status: l.status, learning: l.learning }))),
    section(async () => {
      const rows = await db.agentAuditLog.findMany({
        where: { actionType: { startsWith: 'meta_campaign' }, createdAt: { gte: new Date(Date.now() - windowDays * 86400000) } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { actionType: true, createdAt: true, resourceId: true },
      })
      return rows.map((r: { actionType: string; createdAt: Date; resourceId: string | null }) => ({
        actionType: r.actionType,
        at: r.createdAt.toISOString(),
        resourceId: r.resourceId,
      }))
    }),
    section(() => getCalendarHealth()),
    section(() => assessMeasurementHealth(windowDays)),
    section(() => capiHealth()),
    section(async () => {
      const pendingCount = await db.agentPendingAction.count({ where: { status: 'pending' } })
      return { pendingCount }
    }),
  ])

  return {
    generatedAt: new Date().toISOString(),
    brief,
    experiments,
    learnings,
    adsChanges,
    calendar,
    measurement,
    capi,
    approvals,
  }
}
