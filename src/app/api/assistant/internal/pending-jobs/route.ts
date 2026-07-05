// VPS worker polls this endpoint to find approved jobs.
// Authenticated with AGENT_INTERNAL_TOKEN (constant-time compare).
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const jobs = await db.agentPendingAction.findMany({
    where: {
      status: 'approved',
      // NOTE: this list is the single gate between "queued" and "the worker ever
      // sees it" — a job type missing here hangs at approved until the watchdog
      // checkpoints it (exactly how workbench_run was caught missing in the P2 e2e).
      type: { in: ['image_gen', 'video_gen', 'video_edit', 'video_finish', 'long_agent_task', 'dispatch_staff_tasks', 'add_staff_task_now', 'staff_announcement', 'urgent_notify', 'outbound_call', 'browser_action', 'workbench_run'] },
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  })

  return Response.json({ jobs })
}
