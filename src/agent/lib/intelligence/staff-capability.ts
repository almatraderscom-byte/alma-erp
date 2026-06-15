import { prisma } from '@/lib/prisma'

const db = prisma as any

export interface StaffCapability {
  staffId: string
  staffName: string
  taskType: string
  completionRate: number
  avgCompletionMinutes: number
  proofPassRate: number
  redoCount: number
  totalTasks: number
}

export interface StaffCapabilityProfile {
  staffId: string
  staffName: string
  capabilities: StaffCapability[]
  overallCompletionRate: number
  strongTypes: string[]
  weakTypes: string[]
}

export async function buildStaffCapabilityProfile(
  staffId: string,
  staffName: string,
  businessId: string = 'ALMA_LIFESTYLE',
  daysBack: number = 30,
): Promise<StaffCapabilityProfile> {
  const since = new Date(Date.now() - daysBack * 86_400_000).toISOString()

  try {
    const tasks = await db.agentStaffTask.findMany({
      where: {
        staffId,
        createdAt: { gte: since },
      },
      select: {
        type: true,
        status: true,
        createdAt: true,
        completedAt: true,
      },
    })

    const byType = new Map<string, { total: number; done: number; redo: number; totalMinutes: number }>()

    for (const t of tasks) {
      const type = t.type ?? 'general'
      if (!byType.has(type)) byType.set(type, { total: 0, done: 0, redo: 0, totalMinutes: 0 })
      const entry = byType.get(type)!
      entry.total++
      if (t.status === 'done' || t.status === 'done_verified') {
        entry.done++
        if (t.completedAt && t.createdAt) {
          entry.totalMinutes += (new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime()) / 60000
        }
      }
      if (t.status === 'redo' || t.status === 'redo_requested') entry.redo++
    }

    const capabilities: StaffCapability[] = []
    for (const [taskType, data] of byType) {
      capabilities.push({
        staffId,
        staffName,
        taskType,
        completionRate: data.total > 0 ? Math.round((data.done / data.total) * 100) : 0,
        avgCompletionMinutes: data.done > 0 ? Math.round(data.totalMinutes / data.done) : 0,
        proofPassRate: data.total > 0 ? Math.round(((data.done - data.redo) / data.total) * 100) : 0,
        redoCount: data.redo,
        totalTasks: data.total,
      })
    }

    const totalTasks = tasks.length
    const totalDone = tasks.filter((t: any) => t.status === 'done' || t.status === 'done_verified').length
    const overallCompletionRate = totalTasks > 0 ? Math.round((totalDone / totalTasks) * 100) : 0

    const strongTypes = capabilities
      .filter(c => c.completionRate >= 80 && c.totalTasks >= 3)
      .map(c => c.taskType)

    const weakTypes = capabilities
      .filter(c => c.completionRate < 50 && c.totalTasks >= 3)
      .map(c => c.taskType)

    return { staffId, staffName, capabilities, overallCompletionRate, strongTypes, weakTypes }
  } catch {
    return { staffId, staffName, capabilities: [], overallCompletionRate: 0, strongTypes: [], weakTypes: [] }
  }
}

export async function getAllStaffCapabilities(businessId: string = 'ALMA_LIFESTYLE'): Promise<StaffCapabilityProfile[]> {
  try {
    const staffRows = await db.agentStaff.findMany({
      where: { businessId, active: true },
      select: { id: true, displayName: true },
    })

    const profiles = await Promise.all(
      staffRows.map((s: any) => buildStaffCapabilityProfile(s.id, s.displayName, businessId))
    )
    return profiles
  } catch {
    return []
  }
}
