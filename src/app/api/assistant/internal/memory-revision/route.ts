/**
 * POST /api/assistant/internal/memory-revision — weekly memory revision.
 *
 * The owner's rule: the agent reviews its own memory store every week. Stale
 * memories (old, unused, low-importance — likely no longer how the owner works)
 * are NEVER deleted silently: they are listed in a `memory_cleanup` pending
 * action so the owner sees exactly what would be removed and approves/rejects
 * in chat. Only on approval does the approve route delete them. Unused rows
 * quietly grow retrieval/context cost, so this keeps the brain lean without
 * ever losing something the owner still cares about.
 *
 * Called by the VPS worker scheduler (memory-revision, weekly Friday evening).
 * Internal-token authed, same scheme as the other /internal routes.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'
import { notifyOwner } from '@/agent/lib/notify-owner'

export const runtime = 'nodejs'
export const maxDuration = 60

// How long a memory must sit unused before it becomes a cleanup candidate.
const STALE_DAYS = 45
const MAX_CANDIDATES = 30

function checkToken(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  // Accept the VPS worker token AND Vercel cron (Bearer CRON_SECRET) — the VPS
  // scheduler never actually fired this route (zero memory_cleanup rows ever,
  // verified 2026-07-08), so a Vercel cron now guarantees the weekly run.
  for (const expected of [process.env.AGENT_INTERNAL_TOKEN, process.env.CRON_SECRET]) {
    if (!expected) continue
    try {
      if (timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return true
    } catch {
      /* length mismatch — try next */
    }
  }
  return false
}

/** Vercel crons call with GET — same auth, same weekly run. */
export async function GET(req: NextRequest) {
  return POST(req)
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  // ── Phase 0: HARD-RULE auto-deletes (owner rule 2026-07-08, no card needed) ──
  // 1. EXPIRED temporaries: already classified day-scoped/short-lived — being past
  //    expiry IS the owner's standing approval to remove them.
  // 2. EXACT DUPLICATES: identical unpinned content in the same scope (the head
  //    used to re-save the same observation daily) — keep the newest row only.
  let expiredDeleted = 0
  let duplicatesDeleted = 0
  try {
    const exp = await db.agentMemory.deleteMany({
      where: { pinned: false, expiresAt: { lt: new Date() } },
    })
    expiredDeleted = exp.count ?? 0
  } catch (err) {
    console.warn('[memory-revision] expired delete failed:', err instanceof Error ? err.message : String(err))
  }
  try {
    duplicatesDeleted = await db.$executeRawUnsafe(
      `DELETE FROM agent_memory a
       USING agent_memory b
       WHERE a.pinned = false AND b.pinned = false
         AND a.scope = b.scope AND a.content = b.content
         AND a."createdAt" < b."createdAt"`,
    )
  } catch (err) {
    console.warn('[memory-revision] duplicate delete failed:', err instanceof Error ? err.message : String(err))
  }

  // One revision card at a time — if the owner hasn't resolved last week's list,
  // don't pile a second one on top of it (auto-deletes above still ran).
  const open = await db.agentPendingAction.findFirst({
    where: { type: 'memory_cleanup', status: 'pending' },
    select: { id: true },
  })
  if (open) {
    return NextResponse.json({
      ok: true, skipped: 'previous_revision_pending', pendingActionId: open.id,
      expiredDeleted, duplicatesDeleted,
    })
  }

  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000)

  // Stale = never pinned, old, rarely/never retrieved, low importance. Pinned
  // rows are standing owner instructions — never candidates. session summaries
  // age fastest, so they naturally dominate early lists.
  const candidates: Array<{
    id: string
    content: string
    scope: string
    importance: number
    accessCount: number
    createdAt: Date
    lastUsedAt: Date | null
  }> = await db.agentMemory.findMany({
    where: {
      pinned: false,
      importance: { lte: 3 },
      accessCount: { lte: 2 },
      createdAt: { lt: cutoff },
      OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }],
    },
    orderBy: [{ importance: 'asc' }, { createdAt: 'asc' }],
    take: MAX_CANDIDATES,
    select: {
      id: true,
      content: true,
      scope: true,
      importance: true,
      accessCount: true,
      createdAt: true,
      lastUsedAt: true,
    },
  })

  // LEGACY day-scoped junk: rows saved BEFORE the expiry hard rule existed
  // ("৮ জুলাই ছুটি", daily salah logs) carry no expires_at, so the stale-45d
  // filter misses them for weeks. Surface them on the owner card right away.
  try {
    const { isEphemeralDayFact } = await import('@/agent/lib/agent-memory')
    const seen = new Set(candidates.map((c) => c.id))
    const legacyPool: typeof candidates = await db.agentMemory.findMany({
      where: { pinned: false, expiresAt: null },
      orderBy: { createdAt: 'asc' },
      take: 500,
      select: {
        id: true, content: true, scope: true, importance: true,
        accessCount: true, createdAt: true, lastUsedAt: true,
      },
    })
    for (const row of legacyPool) {
      if (candidates.length >= MAX_CANDIDATES) break
      if (!seen.has(row.id) && isEphemeralDayFact(row.content)) {
        candidates.push(row)
        seen.add(row.id)
      }
    }
  } catch (err) {
    console.warn('[memory-revision] legacy ephemeral scan failed:', err instanceof Error ? err.message : String(err))
  }

  const totalMemories = await db.agentMemory.count()

  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, candidates: 0, totalMemories, expiredDeleted, duplicatesDeleted })
  }

  const lines = candidates.map((c, i) => {
    const age = Math.round((Date.now() - new Date(c.createdAt).getTime()) / (24 * 60 * 60 * 1000))
    const oneLine = c.content.replace(/\s+/g, ' ').slice(0, 110)
    return `${i + 1}. ${oneLine}${c.content.length > 110 ? '…' : ''} (${age} দিন পুরোনো, ব্যবহার ${c.accessCount} বার)`
  })

  const summary =
    `🧹 সাপ্তাহিক মেমরি রিভিশন — ${candidates.length}টি পুরোনো স্মৃতি সম্ভবত আর দরকার নেই:\n\n` +
    lines.join('\n') +
    `\n\nApprove দিলে এগুলো মুছে যাবে (খরচ কমবে); Reject দিলে সব থেকে যাবে। ` +
    `মোট স্মৃতি: ${totalMemories}টি।`

  const action = await db.agentPendingAction.create({
    data: {
      type: 'memory_cleanup',
      payload: {
        memoryIds: candidates.map((c) => c.id),
        items: candidates.map((c) => ({
          id: c.id,
          content: c.content.slice(0, 300),
          scope: c.scope,
          createdAt: c.createdAt,
        })),
        staleDays: STALE_DAYS,
      },
      summary,
      costEstimate: 0,
      status: 'pending',
    },
  })

  try {
    await notifyOwner({
      tier: 2,
      title: 'সাপ্তাহিক মেমরি রিভিশন',
      message: summary + '\n\nচ্যাটে গিয়ে Approve/Reject করুন।',
      category: 'report',
    })
  } catch (err) {
    console.warn('[memory-revision] owner notify failed:', err instanceof Error ? err.message : String(err))
  }

  return NextResponse.json({
    ok: true,
    candidates: candidates.length,
    totalMemories,
    pendingActionId: action.id,
    expiredDeleted,
    duplicatesDeleted,
  })
}
