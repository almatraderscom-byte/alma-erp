/**
 * Persist salah status when owner confirms in chat — does not rely on the LLM calling mark_salah.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, dhakaMidnightUtc, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import { summarizeWaqts, pickAccountableWaqts, type Waqt } from '@/agent/lib/salah-context'
import { detectSalahConfirmation, detectSalahQaza, parseWaqtLabel } from '@/agent/lib/salah-confirm-intent'
import { isSalahSettled, resolvePrayedStatus } from '@/agent/lib/salah-resolve'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type AutoMarkResult = {
  marked: Array<{ date: string; waqt: string; status: string; fromText: string }>
}

export type AutoMarkOptions = {
  /**
   * Spoken live-call path only (Codex P1 round 5, PR #762): the owner's LATER
   * words replace an earlier settled status ("I prayed Isha" → "no, I missed
   * Isha"), instead of the chat helper's settled-record short circuit. Chat
   * keeps the default (false) — there the head + mark_salah own corrections.
   */
  allowSettledCorrection?: boolean
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
    confirmedAt: Date | null
  }>>
}

function waqtWindowStarted(
  summary: { waqt: string; date: string; windowStart: Date; notYetDue: boolean },
  now: Date,
): boolean {
  return !summary.notYetDue && now >= new Date(summary.windowStart)
}

/**
 * Scan owner messages (newest last) and upsert salah when they confirm prayer.
 * Only marks waqts whose window has already started — never future Maghrib/Isha at Asr time.
 */
export async function applySalahAutoMarkFromUserTexts(
  texts: string[],
  now = new Date(),
  opts: AutoMarkOptions = {},
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

  const fixable = [
    ...accountable,
    ...todaySummary.filter(
      (s) =>
        (s.status === 'missed' || s.status === 'pending') && waqtWindowStarted(s, now),
    ),
    ...yesterdaySummary.filter((s) => s.status === 'missed' || s.status === 'pending'),
  ]

  const markedKeys = new Set<string>()

  for (const text of cleaned) {
    // An explicit qaza / missed declaration wins over a generic "prayed" — "কাযা পড়েছি"
    // means qaza, not on-time, even though it contains "পড়েছি". Plain prayed text has no
    // qaza/missed signal so it still falls through to detectSalahConfirmation.
    // qaza/missed is only honoured once the waqt window (jamaat time) has started — the
    // `now < windowStart` guard below enforces the owner's "jamat time er por theke" rule.
    const qaza = detectSalahQaza(text)
    const det = qaza ? null : detectSalahConfirmation(text)
    if (!det && !qaza) continue

    const signal = det ?? qaza!
    const mode: 'prayed' | 'qaza' | 'missed' = det ? 'prayed' : qaza!.kind

    let targetWaqt: string | undefined = signal.waqt
    let dateYmd = signal.dateHint === 'yesterday' ? yesterdayYmd : todayYmd

    if (!targetWaqt && opts.allowSettledCorrection) {
      // Implicit spoken correction (Codex P1 round 6): "no, I missed it"
      // seconds after a confirm names no waqt, and the just-settled record
      // has already left the accountable list — the record confirmed within
      // the last 3 minutes with a DIFFERENT kind is the natural target.
      const newKind = mode === 'prayed' ? 'prayed' : mode
      const recent = [
        ...todayRecords.map((r) => ({ r, d: todayYmd })),
        ...yesterdayRecords.map((r) => ({ r, d: yesterdayYmd })),
      ]
        .filter(({ r }) => r.confirmedAt && isSalahSettled(r.status)
          && now.getTime() - new Date(r.confirmedAt).getTime() < 3 * 60_000)
        .sort((a, b) =>
          new Date(b.r.confirmedAt as Date).getTime() - new Date(a.r.confirmedAt as Date).getTime())[0]
      if (recent) {
        const recentKind = recent.r.status.startsWith('prayed') ? 'prayed' : recent.r.status
        if (recentKind !== newKind) {
          targetWaqt = recent.r.waqt
          dateYmd = recent.d
        }
      }
    }
    if (!targetWaqt) {
      const candidate = accountable.find((a) => {
        const { waqt, isYesterday } = parseWaqtLabel(a.waqt)
        const d = isYesterday ? yesterdayYmd : todayYmd
        return !markedKeys.has(`${d}:${waqt}`)
      })
      if (!candidate) {
        const fallback = fixable.find((a) => {
          const d = a.date
          return !markedKeys.has(`${d}:${a.waqt}`) && waqtWindowStarted(a, now)
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
    if (existing && isSalahSettled(existing.status) && !opts.allowSettledCorrection) {
      markedKeys.add(key)
      continue
    }

    if (existing && now < new Date(existing.windowStart)) {
      continue
    }

    let status: string
    if (mode === 'prayed') {
      status = existing?.windowEnd
        ? resolvePrayedStatus(new Date(existing.windowEnd), now)
        : 'prayed_on_time'
    } else {
      status = mode // 'qaza' | 'missed'
    }

    // Correction mode: only touch a settled record when the KIND changes
    // (prayed-family ↔ qaza/missed). A repeated "পড়েছি" later in the call
    // must not churn confirmedAt or downgrade prayed_on_time to prayed_late.
    if (existing && isSalahSettled(existing.status)) {
      const existingKind = existing.status.startsWith('prayed') ? 'prayed' : existing.status
      const newKind = mode === 'prayed' ? 'prayed' : mode
      if (existingKind === newKind) {
        markedKeys.add(key)
        continue
      }
    }

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
