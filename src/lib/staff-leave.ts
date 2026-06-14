import { prisma } from '@/lib/prisma'

export function dhakaDateYmd(date = new Date()): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

/** Is the staff on approved leave on the given Dhaka date (YYYY-MM-DD)? */
export async function isStaffOnLeave(
  staffId: string,
  dateYmd?: string,
): Promise<{ onLeave: boolean; type?: string; reason?: string }> {
  const date = dateYmd ?? dhakaDateYmd()
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const row = await db.staffLeave.findFirst({
      where: {
        staffId,
        status: 'approved',
        startDate: { lte: date },
        endDate: { gte: date },
      },
      select: { type: true, reason: true },
    })
    return row
      ? { onLeave: true, type: row.type, reason: row.reason ?? undefined }
      : { onLeave: false }
  } catch {
    return { onLeave: false }
  }
}

export async function resolveAgentStaffIdByName(name: string): Promise<string | null> {
  const trimmed = name.trim()
  if (!trimmed) return null
  const row = await prisma.agentStaff.findFirst({
    where: { name: { equals: trimmed, mode: 'insensitive' }, active: true },
    select: { id: true },
  })
  return row?.id ?? null
}

/** Match ERP user name → agent_staff → leave check (absent monitor). */
export async function isStaffOnLeaveByUserName(
  userName: string,
  dateYmd?: string,
): Promise<{ onLeave: boolean; type?: string; reason?: string }> {
  const staffId = await resolveAgentStaffIdByName(userName)
  if (!staffId) return { onLeave: false }
  return isStaffOnLeave(staffId, dateYmd)
}

export async function isStaffOnLeaveByUserId(
  userId: string,
  dateYmd?: string,
): Promise<{ onLeave: boolean; type?: string; reason?: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true },
  })
  if (!user?.name) return { onLeave: false }
  return isStaffOnLeaveByUserName(user.name, dateYmd)
}
