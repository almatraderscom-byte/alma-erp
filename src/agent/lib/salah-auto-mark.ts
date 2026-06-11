/**
 * Persist salah status when owner confirms in chat — does not rely on the LLM calling mark_salah.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, dhakaMidnightUtc, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import { summarizeWaqts, pickAccountableWaqts, type Waqt } from '@/agent/lib/salah-context'
import { detectSalahConfirmation, parseWaqtLabel } from '@/agent/lib/salah-confirm-intent'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const FINAL_STATUSES = new Set(['prayed_on_time', 'prayed_late', 'qaza'])

export type AutoMarkResult = {
  marked: Array<{ date: string; waqt: string; status: string; fromText: string }>
}

async function loadDayRecords(dateYmd: string) {
  return db.agentSalahRecord.findMany({
    where: { date: dhakaMidnightUtc(dateYmd) },
    orderBy: { windowStart: 'asc' },
  }) as Promise<Array<{
    waqt: string
    status: string
    windowStart: Date
    windowEnd: Date
  }>>
}

/**
 * Scan owner messages (newest last) and upsert salah when they confirm prayer.
 * Upgrades pending/missed → prayed_on_time so reminders do not repeat.
 */
export async function applySalahAutoMarkFromUserTexts(
  texts: string[],
  now = new Date(),
): Promise<AutoMarkResult> {
  const result: AutoMarkResult = { marked: [] }
  const cleaned = texts.map((t) => t.trim()).filter(Boolean)
  if (!cleaned.length) return result

  const todayYmd = todayYmdDhaka(now)
  const yesterdayYmd = addDaysYmd(todayYmd, -1)

  const [todayRecords, yesterdayRecords] = await Promise.all([
    loadDayRecords(todayYmd),
    loadDayRecords(yesterdayYmd),
  ])

  const todaySummary = summarizeWaqts(todayYmd, todayRecords, now)
  const yesterdaySummary = summarizeWaqts(yesterdayYmd, yesterdayRecords, now)
  const accountable = pickAccountableWaqts(todaySummary, yesterdaySummary)

  // Also allow fixing rows already wrongly marked missed
  const fixable = [
    ...accountable,
    ...todaySummary.filter((s) => s.status === 'missed' || s.status === 'pending'),
    ...yesterdaySummary.filter((s) => s.status === 'missed' || s.status === 'pending'),
  ]

  const markedKeys = new Set<string>()

  for (const text of cleaned) {
    const det = detectSalahConfirmation(text)
    if (!det) continue

    let targetWaqt: string | undefined = det.waqt
    let dateYmd = det.dateHint === 'yesterday' ? yesterdayYmd : todayYmd

    if (!targetWaqt) {
      const candidate = accountable.find((a) => {
        const { waqt, isYesterday } = parseWaqtLabel(a.waqt)
        const d = isYesterday ? yesterdayYmd : todayYmd
        return !markedKeys.has(`${d}:${waqt}`)
      })
      if (!candidate) {
        const fallback = fixable.find((a) => {
          const d = a.date
          return !markedKeys.has(`${d}:${a.waqt}`)
        })
        if (!fallback) continue
        targetWaqt = fallback.waqt
        dateYmd = fallback.date
      } else {
        const parsed = parseWaqtLabel(candidate.waqt)
        targetWaqt = parsed.waqt
        dateYmd = parsed.isYesterday ? yesterdayYmd : todayYmd
      }
    }

    if (!targetWaqt || !WAQT_SET.has(targetWaqt as Waqt)) continue

    const key = `${dateYmd}:${targetWaqt}`
    if (markedKeys.has(key)) continue

    const records = dateYmd === todayYmd ? todayRecords : yesterdayRecords
    const existing = records.find((r) => r.waqt === targetWaqt)
    if (existing && FINAL_STATUSES.has(existing.status)) {
      markedKeys.add(key)
      continue
    }

    const status = 'prayed_on_time'

    await db.agentSalahRecord.upsert({
      where: { date_waqt: { date: dhakaMidnightUtc(dateYmd), waqt: targetWaqt } },
      update: { status, confirmedAt: now },
      create: {
        date: dhakaMidnightUtc(dateYmd),
        waqt: targetWaqt,
        windowStart: existing?.windowStart ?? now,
        windowEnd: existing?.windowEnd ?? now,
        status,
        confirmedAt: now,
      },
    })

    markedKeys.add(key)
    result.marked.push({ date: dateYmd, waqt: targetWaqt, status, fromText: text.slice(0, 80) })
  }

  return result
}

const WAQT_SET = new Set<string>(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'])
