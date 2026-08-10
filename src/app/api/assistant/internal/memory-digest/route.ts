/**
 * POST /api/assistant/internal/memory-digest — weekly L2/L3 memory distillation.
 *
 * Rebuilds the distilled memory layers (scenario blocks + persona block) from the
 * current fact rows, one slot per scope/business. Derived data only: every run
 * replaces the previous blocks, so a failed run costs freshness, never facts.
 *
 * Scheduled by Vercel cron on Friday, AFTER the weekly memory revision has
 * removed expired and duplicate rows — distilling first would bake stale facts
 * into the persona block for a week.
 *
 * Auth matches the other /internal routes: the VPS worker token or the Vercel
 * cron secret.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { runMemoryDigest } from '@/agent/lib/memory-digest'

export const runtime = 'nodejs'
export const maxDuration = 300

function checkToken(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
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

  const { results } = await runMemoryDigest()
  return NextResponse.json({ ok: true, results })
}
