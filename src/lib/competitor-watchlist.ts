import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const KV_KEY = 'competitor_watchlist'

export type CompetitorEntry = { name: string; url: string }

export async function getCompetitorWatchlist(): Promise<CompetitorEntry[]> {
  const row = await db.agentKvSetting.findUnique({ where: { key: KV_KEY } })
  if (!row?.value) return []
  try {
    const parsed = JSON.parse(row.value)
    if (Array.isArray(parsed)) {
      return parsed.filter((e: CompetitorEntry) => e?.name && e?.url) as CompetitorEntry[]
    }
  } catch {
    /* ignore */
  }
  return []
}

export async function setCompetitorWatchlist(entries: CompetitorEntry[]): Promise<void> {
  const value = JSON.stringify(entries)
  await db.agentKvSetting.upsert({
    where: { key: KV_KEY },
    create: { key: KV_KEY, value },
    update: { value },
  })
}

export async function findCompetitorByName(name: string): Promise<CompetitorEntry | null> {
  const list = await getCompetitorWatchlist()
  const lower = name.toLowerCase().trim()
  return list.find(
    c => c.name.toLowerCase() === lower || c.name.toLowerCase().includes(lower),
  ) ?? null
}
