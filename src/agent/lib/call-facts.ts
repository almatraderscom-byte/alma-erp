/**
 * Facts handed to a LIVE call before the model says a word.
 *
 * WHY (owner, 2026-07-25, second time this bit him): he asked on a live call who was in
 * today. The model called `get_attendance`, the tool returned the right people — and the
 * model had already answered with two invented names ("মোশারফ আর রাফি"). It only got it
 * right after he corrected it. Gemini Live drops a functionResponse that lands while it is
 * speaking, so a mid-call tool round-trip is not a reliable way to learn a NAME.
 *
 * Names are the one thing that must never be improvised, so they travel WITH the call. The
 * tools stay — they are how the model refreshes and answers everything else — but the answer
 * to "who is in today" is already in front of it, before the first sentence.
 *
 * Read-only, best-effort: a call must never fail because this could not be built.
 *
 * The tool registry is imported LAZILY, inside the function. Importing it at module load
 * pulled the whole registry into voice-call.ts's import graph, and the agent behaviour-gate
 * suite died on it (`registry.ts:427 Cannot read properties of undefined`) before a single
 * test ran — a call-path helper must not drag that much module init behind it.
 */

interface StaffRow { name?: string; role?: string }
interface AttendanceRow { name?: string; checkIn?: string; lateMinutes?: number }
interface AttendanceData {
  present?: AttendanceRow[]
  late?: AttendanceRow[]
  absent?: AttendanceRow[]
  counts?: { present?: number; late?: number; absent?: number; totalEmployees?: number }
}

/** Dhaka clock time from an ISO stamp, for "কখন ঢুকেছে". */
function dhakaTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' })
}

const names = (rows?: AttendanceRow[]) => (rows ?? []).map((r) => String(r?.name ?? '').trim()).filter(Boolean)

/**
 * A short Bangla block for the owner's live calls: who exists, who is in today, who is late.
 * Returns '' when nothing could be read — the caller then simply sends no facts.
 */
export async function buildOwnerCallFacts(businessId = 'ALMA_LIFESTYLE'): Promise<string> {
  const ctx = { businessId }
  const { executeTool } = await import('@/agent/tools/registry')
  const [staffRes, attRes] = await Promise.all([
    executeTool('get_all_staff', {}, ctx).catch(() => null),
    executeTool('get_attendance', {}, ctx).catch(() => null),
  ])

  const lines: string[] = []

  const staff = (staffRes?.success ? staffRes.data : null) as StaffRow[] | null
  if (Array.isArray(staff) && staff.length) {
    const list = staff.map((s) => String(s?.name ?? '').trim()).filter(Boolean)
    if (list.length) lines.push(`স্টাফ (মোট ${list.length} জন): ${list.join(', ')}`)
  }

  const att = (attRes?.success ? attRes.data : null) as AttendanceData | null
  if (att) {
    const present = names(att.present)
    const late = (att.late ?? []).map((r) => {
      const t = dhakaTime(r?.checkIn)
      const mins = Number(r?.lateMinutes ?? 0)
      const detail = [t && `${t}-এ ঢুকেছে`, mins > 0 && `${mins} মিনিট দেরি`].filter(Boolean).join(', ')
      return detail ? `${r?.name} (${detail})` : String(r?.name ?? '')
    }).filter(Boolean)
    const absent = names(att.absent)

    lines.push(`আজ উপস্থিত: ${present.length ? present.join(', ') : 'কেউ না'}`)
    if (late.length) lines.push(`দেরিতে এসেছে: ${late.join(', ')}`)
    lines.push(`আজ অনুপস্থিত: ${absent.length ? absent.join(', ') : 'কেউ না'}`)
  }

  if (!lines.length) return ''
  return lines.join('\n')
}
