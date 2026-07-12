/**
 * Server-built salah status text — agent must not invent "all 5 done" from raw DB rows.
 */
import type { WaqtSummary } from '@/agent/lib/salah-context'

const WAQT_BN: Record<string, string> = {
  fajr: 'ফজর',
  dhuhr: 'যোহর',
  asr: 'আসর',
  maghrib: 'মাগরিব',
  isha: 'ইশা',
}

function label(waqt: string) {
  return WAQT_BN[waqt] ?? waqt
}

/** One waqt's truth as a server-built Bangla line — exported so the salah tools
 *  can embed it PER WAQT (2026-07-12: Grok skipped the top-level answerBangla,
 *  parsed raw rows and told Boss maghrib was qaza mid-window). */
export function waqtStatusLineBangla(s: WaqtSummary): string {
  return statusLine(s)
}

function statusLine(s: WaqtSummary): string {
  if (s.notYetDue) return `${label(s.waqt)} — এখনো সময় হয়নি (বাকি)`
  if (s.isPhantom) return `${label(s.waqt)} — বাকি (ভুল মার্ক ঠিক করা হয়েছে)`
  if (s.effectivelyDone) {
    if (s.status === 'prayed_late') return `${label(s.waqt)} — আদায় হয়েছে (দেরিতে)`
    if (s.status === 'qaza') return `${label(s.waqt)} — কাযা আদায়`
    return `${label(s.waqt)} — সময়মতো আদায়`
  }
  if (s.status === 'missed' || s.isMissed) return `${label(s.waqt)} — মিস`
  if (s.isOverdue) return `${label(s.waqt)} — বাকি (সময় চলছে)`
  return `${label(s.waqt)} — বাকি`
}

export function buildSalahStatusAnswer(todaySummary: WaqtSummary[]) {
  const done = todaySummary.filter((s) => s.effectivelyDone)
  const upcoming = todaySummary.filter((s) => s.notYetDue)
  const remaining = todaySummary.filter((s) => !s.notYetDue && !s.effectivelyDone)

  const lines = todaySummary.map(statusLine)
  const allDone = upcoming.length === 0 && remaining.length === 0

  let answerBangla: string
  if (allDone) {
    answerBangla = `আলহামদুলিল্লাহ — আজকের সব ওয়াক্তের সময় শেষ হয়েছে এবং আদায় রেকর্ড আছে।`
  } else if (upcoming.length > 0 && remaining.length === 0) {
    answerBangla =
      `আজ ${done.length} ওয়াক্ত আদায় হয়েছে। ` +
      `বাকি: ${upcoming.map((s) => label(s.waqt)).join(', ')} — এগুলোর সময় এখনো হয়নি।`
  } else {
    const parts: string[] = []
    if (remaining.length) parts.push(`এখনই বাকি: ${remaining.map((s) => label(s.waqt)).join(', ')}`)
    if (upcoming.length) parts.push(`পরে বাকি: ${upcoming.map((s) => label(s.waqt)).join(', ')}`)
    answerBangla = `আজ ${done.length} ওয়াক্ত আদায় হয়েছে। ${parts.join('। ')}।`
  }

  return {
    allDone,
    doneCount: done.length,
    upcomingWaqts: upcoming.map((s) => s.waqt),
    remainingWaqts: remaining.map((s) => s.waqt),
    perWaqtLines: lines,
    answerBangla,
    rule: 'উত্তরে answerBangla ও perWaqtLines ব্যবহার করুন — raw status=prayed_on_time ভবিষ্যত ওয়াক্তে বিশ্বাস করবেন না।',
  }
}
