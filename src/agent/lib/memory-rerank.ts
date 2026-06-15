export interface RankableMemory {
  id: string
  content: string
  similarity: number // 0..1 (caller converts distance → similarity)
  importance?: number | null // 1..5
  createdAt: Date
  lastUsedAt?: Date | null
}

const HALF_LIFE_DAYS = 14

export function blendedScore(m: RankableMemory, now = new Date()): number {
  const anchor = m.lastUsedAt ?? m.createdAt
  const ageDays = Math.max(0, (now.getTime() - anchor.getTime()) / 86_400_000)
  const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
  const importance = Math.min(1, Math.max(0, (m.importance ?? 2) / 5))
  const sim = Math.min(1, Math.max(0, m.similarity))
  return 0.55 * sim + 0.25 * recency + 0.2 * importance
}

export function rerankMemories<T extends RankableMemory>(cands: T[], take = 6, now = new Date()): T[] {
  return [...cands]
    .map((m) => ({ m, s: blendedScore(m, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, take)
    .map((x) => x.m)
}
