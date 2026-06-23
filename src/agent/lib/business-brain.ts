import { prisma } from '@/lib/prisma'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'

const db = prisma as any

export interface BusinessContext {
  model: string
  currentState: string
  staffReality: string
  priorities: string
  ownerStyle: string
}

/**
 * Builds a dynamic business context block from live ERP data.
 * Injected into the volatile section of every prompt (kept compact — target <500 tokens).
 */
export async function buildBusinessContext(businessId: AgentBusinessId): Promise<string> {
  if (businessId !== 'ALMA_LIFESTYLE') return ''

  const [staffProfiles, recentTasks, recentApprovals] = await Promise.all([
    getStaffReality(),
    getRecentTaskPerformance(),
    getRecentApprovalPatterns(),
  ])

  return `
## 📊 লাইভ ব্যবসা বাস্তবতা (ALMA Lifestyle)

### স্টাফ বাস্তবতা (গত ৩০ দিন)
${staffProfiles}

### সাম্প্রতিক টাস্ক পারফরম্যান্স (৭ দিন)
${recentTasks}

### Owner অনুমোদন প্যাটার্ন
${recentApprovals}
`.trim()
}

async function getStaffReality(): Promise<string> {
  try {
    const staff: Array<{
      name: string
      role: string
      completed: bigint | number
      redo_count: bigint | number
      total: bigint | number
    }> = await db.$queryRawUnsafe(`
      SELECT s.name as name, s.role,
        COUNT(t.id) FILTER (WHERE t.status IN ('done', 'done_verified')) as completed,
        COUNT(t.id) FILTER (WHERE t.status IN ('redo', 'redo_requested')) as redo_count,
        COUNT(t.id) as total
      FROM agent_staff s
      LEFT JOIN staff_tasks t ON t.staff_id = s.id AND t.created_at > NOW() - INTERVAL '30 days'
      WHERE s.active = true AND s.business_id = 'ALMA_LIFESTYLE'
      GROUP BY s.name, s.role
    `).catch(() => [])

    if (staff.length > 0) {
      return staff.map((s) => {
        const total = Number(s.total)
        const completed = Number(s.completed)
        const redoCount = Number(s.redo_count)
        const rate = total > 0 ? Math.round((completed / total) * 100) : 0
        const redoRate = total > 0 ? Math.round((redoCount / total) * 100) : 0
        const level = rate < 60 ? '⚠️ সহজ task দরকার' : rate > 80 ? '✅ harder task দেওয়া যায়' : '📊 উন্নতি হচ্ছে'
        return `- **${s.name}** (${s.role}): ${total}টি task, ${rate}% complete, ${redoRate}% redo — ${level}`
      }).join('\n')
    }

    return `- **Eyafi**: Creative — FB post, ad, content, video। শিখছে, professional না।
- **Mustahid**: Photo, basic video, office। Step-by-step instruction দরকার।`
  } catch (err) {
    console.warn('[business-brain] getStaffReality failed:', err instanceof Error ? err.message : err)
    return '(Staff data unavailable — basic skill level assume করুন)'
  }
}

async function getRecentTaskPerformance(): Promise<string> {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const tasks: Array<{ type: string; status: string; cnt: bigint | number }> =
      await db.$queryRawUnsafe(`
        SELECT type, status, COUNT(*) as cnt
        FROM staff_tasks
        WHERE created_at >= $1
        GROUP BY type, status
        ORDER BY cnt DESC
        LIMIT 20
      `, sevenDaysAgo).catch(() => [])

    if (!tasks.length) return '(সাম্প্রতিক task data নেই)'

    const byType = new Map<string, { done: number; total: number }>()
    for (const t of tasks) {
      const type = t.type
      if (!byType.has(type)) byType.set(type, { done: 0, total: 0 })
      const entry = byType.get(type)!
      entry.total += Number(t.cnt)
      if (t.status === 'done' || t.status === 'done_verified') entry.done += Number(t.cnt)
    }

    return Array.from(byType).map(([type, data]) => {
      const rate = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0
      return `- ${type}: ${rate}% done (${data.done}/${data.total})`
    }).join('\n')
  } catch (err) {
    console.warn('[business-brain] getRecentTaskPerformance failed:', err instanceof Error ? err.message : err)
    return '(Task performance data unavailable)'
  }
}

async function getRecentApprovalPatterns(): Promise<string> {
  try {
    const rows: Array<{ approved: bigint | number; rejected: bigint | number; total: bigint | number }> =
      await db.$queryRawUnsafe(`
        SELECT COUNT(*) FILTER (WHERE status = 'approved') as approved,
               COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
               COUNT(*) as total
        FROM agent_pending_actions
        WHERE "createdAt" > NOW() - INTERVAL '14 days'
      `).catch(() => [{ approved: 0, rejected: 0, total: 0 }])

    const r = rows[0] ?? { approved: 0, rejected: 0, total: 0 }
    const total = Number(r.total)
    const approved = Number(r.approved)
    const approveRate = total > 0 ? Math.round((approved / total) * 100) : 0

    if (total === 0) return 'সাম্প্রতিক approval data নেই।'

    const insight = approveRate > 80
      ? 'Owner বেশিরভাগই approve করেন — routine কাজে trust আছে।'
      : approveRate > 50
        ? 'Owner selective — carefully review করেন।'
        : 'Owner অনেক reject করেন — task quality বাড়ানো দরকার।'

    return `${total}টি action, ${approveRate}% approved। ${insight}`
  } catch (err) {
    console.warn('[business-brain] getRecentApprovalPatterns failed:', err instanceof Error ? err.message : err)
    return 'Owner concise Bangla instructions দেন, result-oriented।'
  }
}
