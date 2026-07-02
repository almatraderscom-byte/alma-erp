// One-shot entrance-watch test (owner-only, session-authed — so the owner can
// tap "টেস্ট" on the admin page without needing CRON_SECRET). Captures a live
// frame, runs identification, pushes the result card to the owner's Telegram
// and returns the identification JSON for the page to display.
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { runEntranceWatchTest } from '@/agent/lib/entrance-watch'

export const runtime = 'nodejs'
export const maxDuration = 90

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const session = await getServerSession(authOptions)
  if (!session?.user || !isSystemOwner(session)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let deviceId: string | undefined
  try {
    const body = (await req.json()) as { deviceId?: string }
    deviceId = body.deviceId?.trim() || undefined
  } catch {
    /* empty body is fine */
  }

  const result = await runEntranceWatchTest(deviceId)
  return NextResponse.json(result)
}
