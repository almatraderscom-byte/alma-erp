/**
 * REVIEW ANNUALLY — confirm Eid/Ramadan Gregorian dates for the current year.
 * Hand-curated per-year table; no runtime Hijri computation (accuracy risk).
 */
import { todayYmdDhaka, addDaysYmd } from '@/lib/agent-api/dhaka-date'

export interface RetailEvent {
  name: string
  dateYmd: string
  leadDays: number
  note: string
}

/** Fixed Gregorian dates — update each year before peak season. */
const RETAIL_EVENTS: RetailEvent[] = [
  // ── 2026 ──
  { name: 'Ramadan 2026 (start)', dateYmd: '2026-02-18', leadDays: 30, note: 'Ramadan prep — modest/family content tone' },
  { name: 'ঈদুল ফিতর 2026', dateYmd: '2026-03-20', leadDays: 45, note: 'Panjabi/family-set peak — stock+content+ads ramp' },
  { name: 'স্বাধীনতা দিবস 2026', dateYmd: '2026-03-26', leadDays: 7, note: 'Patriotic/traditional micro-campaign' },
  { name: 'পহেলা বৈশাখ 2026', dateYmd: '2026-04-14', leadDays: 21, note: 'Red-white traditional + panjabi/saree push' },
  { name: 'ঈদুল আযহা 2026', dateYmd: '2026-05-27', leadDays: 45, note: 'Second Eid peak — family sets + panjabi' },
  { name: 'শীত কালেকশন 2026', dateYmd: '2026-11-15', leadDays: 30, note: 'Moshari/shawl/hoodie — stock in by mid-Oct' },
  { name: 'বিজয় দিবস 2026', dateYmd: '2026-12-16', leadDays: 14, note: 'Victory Day — limited patriotic angle' },
  // ── 2027 (early-year events visible within ~120d from late 2026) ──
  { name: 'Ramadan 2027 (start)', dateYmd: '2027-02-07', leadDays: 30, note: 'Ramadan prep window' },
  { name: 'ঈদুল ফিতর 2027', dateYmd: '2027-03-09', leadDays: 45, note: 'Panjabi/family-set peak' },
  { name: 'পহেলা বৈশাখ 2027', dateYmd: '2027-04-14', leadDays: 21, note: 'Boishakh traditional push' },
  { name: 'ঈদুল আযহা 2027', dateYmd: '2027-05-16', leadDays: 45, note: 'Second Eid peak' },
]

const HORIZON_DAYS = 120

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = new Date(`${fromYmd}T00:00:00+06:00`).getTime()
  const b = new Date(`${toYmd}T00:00:00+06:00`).getTime()
  return Math.round((b - a) / 86_400_000)
}

export function upcomingEvents(now = new Date()): Array<RetailEvent & { daysUntil: number; inLeadWindow: boolean }> {
  const today = todayYmdDhaka(now)
  const horizonEnd = addDaysYmd(today, HORIZON_DAYS)

  return RETAIL_EVENTS
    .map((ev) => {
      const daysUntil = daysBetween(today, ev.dateYmd)
      return {
        ...ev,
        daysUntil,
        inLeadWindow: daysUntil >= 0 && daysUntil <= ev.leadDays,
      }
    })
    .filter((ev) => ev.dateYmd >= today && ev.dateYmd <= horizonEnd)
    .sort((a, b) => a.daysUntil - b.daysUntil)
}

/** Events whose prep window is active now (daysUntil <= leadDays). */
export function eventsInLeadWindow(now = new Date()): Array<RetailEvent & { daysUntil: number; inLeadWindow: boolean }> {
  return upcomingEvents(now).filter((e) => e.inLeadWindow)
}
