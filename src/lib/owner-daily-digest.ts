import { prisma } from '@/lib/prisma'
import type { HealthScanReport } from '@/lib/diagnostic/health-scan'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type DailyDigest = {
  generatedAt: string
  business: unknown | null
  websiteHealth: unknown | null
  pendingApprovalsCount: number
  openTodos: Array<{ title: string; priority: string; ageDays: number }>
  lingeringTodos: Array<{ title: string; ageDays: number }>
  healthScan: HealthScanReport | null
}

export async function buildOwnerDailyDigest(): Promise<DailyDigest> {
  let business: unknown | null = null
  try {
    const { buildOwnerBriefingData } = await import('@/agent/lib/owner-briefing-data')
    business = await buildOwnerBriefingData()
  } catch (err) {
    console.warn('[daily-digest] buildOwnerBriefingData failed:', err instanceof Error ? err.message : err)
    business = null
  }

  let websiteHealth: unknown | null = null
  try {
    const { getWebsiteHealth } = await import('@/lib/website/consistency')
    const { websiteSupabaseConfigured } = await import('@/lib/website/supabase-client')
    if (websiteSupabaseConfigured()) websiteHealth = await getWebsiteHealth()
  } catch (err) {
    console.warn('[daily-digest] websiteHealth failed:', err instanceof Error ? err.message : err)
    websiteHealth = null
  }

  let pendingApprovalsCount = 0
  try {
    pendingApprovalsCount = await db.agentPendingAction.count({ where: { status: 'pending' } })
  } catch (err) {
    console.warn('[daily-digest] pendingApprovalsCount failed:', err instanceof Error ? err.message : err)
    pendingApprovalsCount = 0
  }

  let openTodos: DailyDigest['openTodos'] = []
  let lingeringTodos: DailyDigest['lingeringTodos'] = []
  try {
    const todos = await db.agentOwnerTodo.findMany({
      where: { status: 'open' },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: 50,
    })
    const now = Date.now()
    openTodos = todos.map((t: { title: string; priority: string; createdAt: Date }) => ({
      title: t.title,
      priority: t.priority,
      ageDays: Math.floor((now - new Date(t.createdAt).getTime()) / 86400000),
    }))
    lingeringTodos = todos
      .filter(
        (t: { createdAt: Date; nudgeAfterDays: number }) =>
          (now - new Date(t.createdAt).getTime()) / 86400000 >= (t.nudgeAfterDays ?? 3),
      )
      .map((t: { title: string; createdAt: Date }) => ({
        title: t.title,
        ageDays: Math.floor((now - new Date(t.createdAt).getTime()) / 86400000),
      }))
  } catch (err) {
    console.warn('[daily-digest] openTodos fetch failed:', err instanceof Error ? err.message : err)
  }

  let healthScan: HealthScanReport | null = null
  try {
    const { runHealthScan } = await import('@/lib/diagnostic/health-scan')
    healthScan = await runHealthScan()
  } catch (err) {
    console.warn('[daily-digest] healthScan failed:', err instanceof Error ? err.message : err)
    healthScan = null
  }

  return {
    generatedAt: new Date().toISOString(),
    business,
    websiteHealth,
    pendingApprovalsCount,
    openTodos,
    lingeringTodos,
    healthScan,
  }
}
