import type { OperationalTaskAssignmentDto } from '@/hooks/useOperationalTasks'

export const OPS_HERO_STATUSES = ['ACTIVE', 'ACKNOWLEDGED', 'IN_PROGRESS'] as const

export type OpsHeroStatus = (typeof OPS_HERO_STATUSES)[number]

export const OPS_PRIORITY_RANK: Record<OperationalTaskAssignmentDto['task']['priority'], number> = {
  CRITICAL: 4,
  HIGH: 3,
  NORMAL: 2,
  LOW: 1,
}

export function isOpsHeroEligible(status: string): status is OpsHeroStatus {
  return (OPS_HERO_STATUSES as readonly string[]).includes(status)
}

export function pickPrimaryOpsTask(
  tasks: OperationalTaskAssignmentDto[],
): OperationalTaskAssignmentDto | null {
  const open = tasks.filter(t => isOpsHeroEligible(t.status))
  if (!open.length) return null
  return [...open].sort(
    (a, b) => OPS_PRIORITY_RANK[b.task.priority] - OPS_PRIORITY_RANK[a.task.priority],
  )[0]!
}

export const OPS_PRIORITY_GLOW: Record<OperationalTaskAssignmentDto['task']['priority'], string> = {
  LOW: 'shadow-[0_0_48px_rgba(52,211,153,0.18)] ring-emerald-500/25',
  NORMAL: 'shadow-[0_0_48px_rgba(56,189,248,0.18)] ring-sky-500/25',
  HIGH: 'shadow-[0_0_56px_rgba(245,158,11,0.22)] ring-amber-500/30',
  CRITICAL: 'shadow-[0_0_64px_rgba(239,68,68,0.28)] ring-red-500/35',
}

export const OPS_PRIORITY_BADGE: Record<OperationalTaskAssignmentDto['task']['priority'], string> = {
  LOW: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  NORMAL: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  HIGH: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  CRITICAL: 'border-red-500/50 bg-red-500/15 text-red-200',
}

export function opsStatusLabel(status: string): string {
  return status.replace(/_/g, ' ')
}
