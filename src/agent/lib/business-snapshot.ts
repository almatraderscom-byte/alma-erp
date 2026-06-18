import { prisma } from '@/lib/prisma'
import { createOrUpdateAgentMemory } from '@/agent/lib/agent-memory'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import type { OwnerBriefingData } from '@/agent/lib/owner-briefing-data'

/**
 * Daily business-state snapshot.
 *
 * The agent already tours the ERP once a day when it builds the owner briefing
 * (buildOwnerBriefingData). That tour used to be thrown away — so every later
 * chat turn re-queried live ERP via tool calls, and each tool call is a full
 * model round-trip that re-writes the (cold) prompt cache. Expensive.
 *
 * Now we persist a COMPACT snapshot from that one daily tour and inject it into
 * the chat system prompt. Routine business questions ("ajker sales koto",
 * "pending koto", "kon product kom") are answered straight from the snapshot —
 * no tool round-trip. Live tools are only used when the owner explicitly wants
 * fresh/real-time data or the snapshot is stale/missing.
 */

const SNAPSHOT_SCOPE = 'business'
const SNAPSHOT_KEY = 'business_snapshot'

export type BusinessSnapshot = {
  text: string
  generatedAt: string
  /** snapshot's business date (Dhaka YMD) */
  date: string
  /** true when the snapshot is from today (Dhaka) */
  isToday: boolean
}

function fmtTk(n: number): string {
  return `৳${Math.round(n).toLocaleString('en-US')}`
}

/** Build a short (~200-350 token) Bangla summary of today's business state. */
export function buildSnapshotText(b: OwnerBriefingData): string {
  const lines: string[] = []

  if (b.sales) {
    lines.push(
      `• বিক্রি: গতকাল ${fmtTk(b.sales.yesterdayTotal)} (${b.sales.yesterdayOrders} অর্ডার); ৭-দিন গড় ${fmtTk(b.sales.sevenDayAvg)}/দিন`,
    )
  }
  if (b.pendingOrders) {
    const mm = b.pendingOrders.mismatch ? ' ⚠️mismatch (refresh দরকার)' : ''
    lines.push(`• পেন্ডিং অর্ডার: ${b.pendingOrders.count} টি${mm}`)
  }
  if (b.inventory?.items?.length) {
    const low = b.inventory.items
      .filter((i) => i.currentStock <= i.reorderLevel)
      .slice(0, 6)
      .map((i) => `${i.name} (${i.currentStock})`)
    if (low.length) {
      lines.push(`• কম স্টক: ${low.join(', ')}`)
    }
  }
  if (b.reorderSuggestions?.length) {
    lines.push(`• Reorder সাজেশন: ${b.reorderSuggestions.length} টি product`)
  }
  if (b.csWaiting && (b.csWaiting.unrepliedCount || b.csWaiting.nearWindowCount || b.csWaiting.openAlerts)) {
    lines.push(
      `• CS অপেক্ষমাণ: ${b.csWaiting.unrepliedCount} unreplied, ${b.csWaiting.nearWindowCount} near-window, ${b.csWaiting.openAlerts} alert`,
    )
  }
  if (b.staffYesterday) {
    const low = b.staffYesterday.lowPerformers.slice(0, 3).map((p) => `${p.name} (${p.pct}%)`)
    lines.push(
      `• স্টাফ (গতকাল): ${b.staffYesterday.done}/${b.staffYesterday.total} done${low.length ? `; কম: ${low.join(', ')}` : ''}`,
    )
  }
  if (b.decisions?.length) {
    const top = b.decisions.slice(0, 3).map((d) => d.text).filter(Boolean)
    if (top.length) lines.push(`• মূল সিদ্ধান্ত: ${top.join('; ')}`)
  }

  if (!lines.length) return ''
  return lines.join('\n')
}

/**
 * Persist the compact snapshot. Fire-and-forget friendly — never throws.
 * Called from buildOwnerBriefingData so it refreshes on the daily tour and
 * whenever the briefing tool runs.
 */
export async function saveBusinessSnapshot(b: OwnerBriefingData): Promise<void> {
  try {
    const text = buildSnapshotText(b)
    if (!text) return
    await createOrUpdateAgentMemory({
      scope: SNAPSHOT_SCOPE,
      key: SNAPSHOT_KEY,
      content: text,
      pinned: false,
      importance: 2,
      metadata: {
        type: 'business_snapshot',
        date: b.today,
        generatedAt: b.generatedAt,
      },
    })
  } catch (err) {
    console.warn('[snapshot] save failed:', err instanceof Error ? err.message : String(err))
  }
}

/** Read the latest snapshot. Returns null if none / on error. */
export async function getBusinessSnapshot(): Promise<BusinessSnapshot | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const row = await db.agentMemory.findFirst({
      where: { scope: SNAPSHOT_SCOPE, key: SNAPSHOT_KEY },
      select: { content: true, metadata: true, createdAt: true },
    })
    if (!row?.content) return null
    const meta = (row.metadata ?? {}) as { date?: string; generatedAt?: string }
    const date = meta.date ?? ''
    return {
      text: String(row.content),
      generatedAt: meta.generatedAt ?? new Date(row.createdAt).toISOString(),
      date,
      isToday: date === todayYmdDhaka(),
    }
  } catch (err) {
    console.warn('[snapshot] read failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}
