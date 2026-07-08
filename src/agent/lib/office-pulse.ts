/**
 * Office Pulse — LIVE office/staff/agent-work block for the head's system prompt
 * (owner decision 2026-07-08).
 *
 * The daily business snapshot only carries YESTERDAY's tour, so every office
 * question ("কে অফিসে?", "টাস্কের কী অবস্থা?") and every autonomous wake made
 * the head re-discover state via live tool calls — and each tool round re-bills
 * the FULL prompt context (the real cost multiplier on cache-less heads).
 *
 * This module keeps one compact (~300-500 token) rolling summary of TODAY:
 * sales so far, who is in the office right now, staff-task board, pending
 * approvals/proposals, and the agent's own open background work. It is pure
 * SQL/service reads — NO LLM — cached in agent_kv_settings and delta-refreshed
 * on read when older than 10 minutes. Owner turns and background wakes share
 * the same pulse, exactly the owner's "first one writes the summary, the next
 * one updates it" model. Zero quality loss: the head answers office questions
 * from the pulse in ONE round, and live tools remain available when the owner
 * explicitly wants fresh/deep data.
 */
import { prisma } from '@/lib/prisma'
import { getAgentOrdersSummary } from '@/lib/agent-api/orders.service'
import { getOwnerHubData } from '@/agent/lib/office-hub'
import { roundMoney } from '@/lib/money'

const KV_KEY = 'agent.office_pulse'
const FRESH_MINUTES = 10

export type OfficePulse = { text: string; generatedAt: string }

function tk(n: number): string {
  return `৳${Math.round(n).toLocaleString('en-US')}`
}

/** Build the pulse text from live data. Pure reads — never throws (returns ''). */
export async function buildOfficePulseText(): Promise<string> {
  try {
    const [sales, hub] = await Promise.all([
      getAgentOrdersSummary('today').catch(() => null),
      getOwnerHubData().catch(() => null),
    ])

    const lines: string[] = []
    if (sales) {
      lines.push(`• আজকের বিক্রি এ পর্যন্ত: ${tk(roundMoney(sales.totalRevenue))} (${sales.totalOrders} অর্ডার)`)
    }
    if (hub) {
      const present = hub.team.filter((t) => t.checkedIn)
      const absent = hub.team.filter((t) => !t.checkedIn)
      lines.push(
        `• অফিসে এখন: ${present.length ? present.map((t) => t.name).join(', ') : 'কেউ চেক-ইন করেনি'}` +
          (absent.length ? ` | অনুপস্থিত/চেক-ইন বাকি: ${absent.map((t) => t.name).join(', ')}` : ''),
      )
      lines.push(
        `• স্টাফ টাস্ক বোর্ড: ${hub.kpis.active} চলছে, ${hub.kpis.pending} অনুমোদনের অপেক্ষায়, ` +
          `${hub.kpis.overdue} ওভারডিউ, আজ শেষ ${hub.kpis.doneToday}টা`,
      )
      const activeTop = hub.activeTasks.slice(0, 4)
      if (activeTop.length) {
        lines.push(`• চলমান টাস্ক: ${activeTop.map((t) => `${t.staffName} — ${t.title}`).join('; ')}`)
      }
      const overdue = hub.overdueUpdates.slice(0, 3)
      if (overdue.length) {
        lines.push(`• আপডেট বাকি: ${overdue.map((o) => o.staffName ?? o.title ?? '').filter(Boolean).join('; ')}`)
      }
      if (hub.proposals.length) {
        lines.push(`• জরিমানা/পুরস্কার প্রস্তাব pending: ${hub.proposals.length}টা`)
      }
    }

    // The agent's own background work (open tasks + unacked outbox) — so a wake
    // or the owner can see what the agent itself is mid-way through.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = prisma as any
      const [openAgentTasks, unackedOutbox] = await Promise.all([
        db.agentOpenTask.count({ where: { status: { in: ['open', 'running'] } } }).catch(() => 0),
        db.agentOutbox.count({ where: { requiresAck: true, acknowledgedAt: null } }).catch(() => 0),
      ])
      if (openAgentTasks || unackedOutbox) {
        lines.push(`• এজেন্টের নিজের কাজ: ${openAgentTasks}টা চলছে/খোলা, ${unackedOutbox}টা রিপোর্ট আন-অ্যাকড`)
      }
    } catch {
      /* table shape drift — skip the agent-work line, keep the rest */
    }

    return lines.join('\n')
  } catch (err) {
    console.warn('[office-pulse] build failed:', err instanceof Error ? err.message : String(err))
    return ''
  }
}

/**
 * Read the shared pulse; delta-refresh when older than `maxAgeMinutes`.
 * Shared across owner turns AND background wakes via agent_kv_settings.
 * Fail-open: returns null on any error — a missing pulse never blocks a turn.
 */
export async function getOfficePulse(maxAgeMinutes = FRESH_MINUTES): Promise<OfficePulse | null> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: KV_KEY }, select: { value: true } })
    if (row?.value) {
      try {
        const cached = JSON.parse(row.value) as OfficePulse
        const ageMs = Date.now() - new Date(cached.generatedAt).getTime()
        if (cached.text && Number.isFinite(ageMs) && ageMs < maxAgeMinutes * 60_000) return cached
      } catch {
        /* corrupt cache — rebuild below */
      }
    }

    const text = await buildOfficePulseText()
    if (!text) return null
    const pulse: OfficePulse = { text, generatedAt: new Date().toISOString() }
    await prisma.agentKvSetting.upsert({
      where: { key: KV_KEY },
      create: { key: KV_KEY, value: JSON.stringify(pulse) },
      update: { value: JSON.stringify(pulse) },
    })
    return pulse
  } catch (err) {
    console.warn('[office-pulse] read failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}
