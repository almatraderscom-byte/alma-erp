/**
 * Orchestrate approved marketing plan items → File 10 briefs + organic staff tasks.
 * Nothing auto-posts or auto-spends.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { sendOwnerApprovalCard } from '@/agent/lib/telegram-owner-notify'
import type { MarketingPlanItem } from '@/agent/lib/marketing/planner'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

async function pickOrganicStaff(): Promise<{ id: string; name: string } | null> {
  const staff = await db.agentStaff.findMany({
    where: { active: true, businessId: 'ALMA_LIFESTYLE' },
    select: { id: true, name: true, role: true },
    orderBy: { name: 'asc' },
  })
  const eyafi = staff.find((s: { name: string }) => s.name.toLowerCase().includes('eyafi'))
  const mustahid = staff.find((s: { name: string }) => s.name.toLowerCase().includes('mustahid'))
  return eyafi ?? mustahid ?? staff[0] ?? null
}

export async function orchestrateMarketingPlanItems(
  items: MarketingPlanItem[],
  conversationId?: string | null,
): Promise<{ creativeBriefs: number; organicTasks: number; actionIds: string[] }> {
  const staff = await pickOrganicStaff()
  const date = todayYmdDhaka()
  const actionIds: string[] = []
  let creativeBriefs = 0
  let organicTasks = 0

  for (const item of items) {
    const needsPaid = item.channel === 'paid' || item.channel === 'both'
    const needsOrganic = item.channel === 'organic' || item.channel === 'both'

    if (needsPaid) {
      const summary =
        `Marketing plan → ad creative brief\n` +
        `📅 ${item.dateYmd} | ${item.theme}\n` +
        `🎯 ${item.objective}\n\n` +
        `Brief: ${item.creativeBrief}\n` +
        (item.copyAngle ? `Angle: ${item.copyAngle}\n` : '') +
        `\nApprove → make_ad_creatives (File 10) — auto-post নয়।`

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: conversationId ?? null,
          type: 'ads_creative_brief',
          payload: {
            angleHint: item.copyAngle ?? item.creativeBrief,
            productCode: item.productCode ?? null,
            theme: item.theme,
            creativeBrief: item.creativeBrief,
            planDate: item.dateYmd,
            source: 'marketing_plan',
          },
          summary,
          costEstimate: 0,
          status: 'pending',
          businessId: 'ALMA_LIFESTYLE',
        },
      })
      actionIds.push(action.id)
      creativeBriefs += 1
      void sendOwnerApprovalCard({ summary, pendingActionId: action.id }).catch(() => {})
    }

    if (needsOrganic && staff) {
      const taskType = item.theme === 'default' && item.copyAngle?.includes('অফার')
        ? 'offer_idea'
        : 'organic_marketing'
      const summary =
        `Marketing plan → organic task\n` +
        `👤 ${staff.name} | ${item.dateYmd}\n` +
        `🎯 ${item.objective}\n\n` +
        `Approve → staff task dispatch — auto-post নয়।`

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: conversationId ?? null,
          type: 'add_staff_task_now',
          payload: {
            staffId: staff.id,
            staffName: staff.name,
            title: item.objective.slice(0, 120),
            type: taskType,
            detail: `${item.creativeBrief}${item.productCode ? `\nProduct: ${item.productCode}` : ''}`,
            date,
            productRef: item.productCode ?? null,
            source: 'marketing_plan',
          },
          summary,
          costEstimate: 0,
          status: 'pending',
          businessId: 'ALMA_LIFESTYLE',
        },
      })
      actionIds.push(action.id)
      organicTasks += 1
      void sendOwnerApprovalCard({ summary, pendingActionId: action.id }).catch(() => {})
    }
  }

  return { creativeBriefs, organicTasks, actionIds }
}
