/**
 * GET /api/assistant/plan-driver — the owner-facing Plan-Drive panel (Phase C).
 *
 * Returns every in-flight autonomous plan (driving / waiting-approval /
 * needs-decision) with a step-by-step status, so the owner can WATCH the agent
 * pursue each task live — the same way the Day-Shift "office" session is visible —
 * instead of it all happening invisibly in the background. Read-only; safe to poll.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getPlanDrivePanel } from '@/agent/lib/plan-driver/plan-drive-view'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const data = await getPlanDrivePanel()
  return NextResponse.json(data)
}
