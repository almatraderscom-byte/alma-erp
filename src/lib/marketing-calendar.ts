/**
 * Bangladesh fashion-retail seasonal calendar. Returns upcoming events within a
 * lead window so the agent can recommend stocking up + content ahead of demand.
 * Dates are approximate (some shift yearly — Eid by lunar calendar). Owner can refine.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

export interface SeasonEvent {
  name: string
  key: string
  approxMonth: number
  leadWeeks: number
  categories: string[]
  note: string
}

export const BD_SEASONS: SeasonEvent[] = [
  {
    name: 'ঈদুল ফিতর',
    key: 'eid_fitr',
    approxMonth: 3,
    leadWeeks: 6,
    categories: ['punjabi', 'panjabi', 'family_set', 'kids'],
    note: 'বছরের সবচেয়ে বড় সেল — ৬ সপ্তাহ আগে কন্টেন্ট+স্টক',
  },
  {
    name: 'ঈদুল আযহা',
    key: 'eid_adha',
    approxMonth: 5,
    leadWeeks: 5,
    categories: ['punjabi', 'family_set'],
    note: 'দ্বিতীয় বড় সেল',
  },
  {
    name: 'পহেলা বৈশাখ',
    key: 'pahela_baishakh',
    approxMonth: 3,
    leadWeeks: 3,
    categories: ['saree', 'panjabi', 'traditional'],
    note: 'লাল-সাদা থিম',
  },
  {
    name: 'পূজা',
    key: 'puja',
    approxMonth: 9,
    leadWeeks: 4,
    categories: ['saree', 'traditional'],
    note: 'শাড়ি ফোকাস',
  },
  {
    name: 'শীত কালেকশন',
    key: 'winter',
    approxMonth: 10,
    leadWeeks: 4,
    categories: ['winter', 'shawl', 'hoodie'],
    note: 'শীতের পোশাক',
  },
]

const KV_PREFIX = 'marketing_season_'

export type UpcomingSeason = SeasonEvent & {
  weeksUntil: number | null
  dateSource: 'owner' | 'approximate'
  exactDate: string | null
  inLeadWindow: boolean
}

function dhakaMonth(now = new Date()): number {
  const ymd = todayYmdDhaka(now)
  return parseInt(ymd.slice(5, 7), 10) - 1
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = new Date(`${fromYmd}T00:00:00Z`).getTime()
  const b = new Date(`${toYmd}T00:00:00Z`).getTime()
  return Math.round((b - a) / 86_400_000)
}

async function getOwnerSeasonDate(key: string): Promise<string | null> {
  try {
    const row = await prisma.agentKvSetting.findUnique({
      where: { key: `${KV_PREFIX}${key}` },
      select: { value: true },
    })
    const v = row?.value?.trim()
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
  } catch {
    return null
  }
}

function monthBasedWeeksUntil(approxMonth: number, now = new Date()): number {
  const month = dhakaMonth(now)
  const monthDiff = (approxMonth - month + 12) % 12
  return monthDiff * 4
}

/** Events whose lead window is active now (marketing/stocking should start). */
export async function upcomingSeasons(now = new Date()): Promise<UpcomingSeason[]> {
  const today = todayYmdDhaka(now)
  const results: UpcomingSeason[] = []

  for (const season of BD_SEASONS) {
    const ownerDate = await getOwnerSeasonDate(season.key)
    let weeksUntil: number | null
    let dateSource: 'owner' | 'approximate' = 'approximate'
    let exactDate: string | null = null

    if (ownerDate) {
      const days = daysBetween(today, ownerDate)
      weeksUntil = days > 0 ? Math.ceil(days / 7) : 0
      dateSource = 'owner'
      exactDate = ownerDate
    } else {
      weeksUntil = monthBasedWeeksUntil(season.approxMonth, now)
      exactDate = null
    }

    const inLeadWindow = weeksUntil != null && weeksUntil <= season.leadWeeks + 1
    if (inLeadWindow) {
      results.push({
        ...season,
        weeksUntil,
        dateSource,
        exactDate,
        inLeadWindow,
      })
    }
  }

  return results.sort((a, b) => (a.weeksUntil ?? 99) - (b.weeksUntil ?? 99))
}

/** Owner can set exact dates yearly via agent_kv_settings keys marketing_season_{key}. */
export function seasonDateSettingKey(seasonKey: string): string {
  return `${KV_PREFIX}${seasonKey}`
}
