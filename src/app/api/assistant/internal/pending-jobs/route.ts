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
      type: { in: ['image_gen', 'video_gen', 'video_edit', 'video_finish', 'audio_gen', 'long_agent_task', 'dispatch_staff_tasks', 'add_staff_task_now', 'staff_announcement', 'urgent_notify', 'outbound_call', 'browser_action', 'workbench_run', 'seo_audit', 'agent_graph_run'] },
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  })

  // Phase 5 execution lease (roadmap §A leaseUntil): handing a job to the worker
  // takes the lease on its WorkflowRun, so overlapping polls / a second worker
  // instance cannot pick the SAME job up again mid-execution. A crashed worker
  // just lets the lease expire and the job resurfaces. Jobs without a run
  // (cron/legacy rows) pass through untouched — the lease narrows duplicates,
  // it never blocks delivery.
  const LEASE_TTL_MS: Record<string, number> = {
    video_gen: 15 * 60_000, video_edit: 15 * 60_000, video_finish: 15 * 60_000,
    long_agent_task: 15 * 60_000, browser_action: 15 * 60_000, workbench_run: 15 * 60_000, agent_graph_run: 30 * 60_000,
    seo_audit: 15 * 60_000,
  }
  // Phase 7 kill switch: AGENT_WORKFLOW_LEASES=false hands every job out
  // unleased (pre-Phase-5 behavior) without a deploy.
  if (process.env.AGENT_WORKFLOW_LEASES === 'false') {
    return Response.json({ jobs })
  }
  try {
    const { acquireWorkflowLease } = await import('@/agent/lib/workflow-run')
    const handout: unknown[] = []
    for (const job of jobs as Array<{ id: string; type: string }>) {
      const lease = await acquireWorkflowLease(job.id, LEASE_TTL_MS[job.type] ?? 5 * 60_000)
        .catch(() => 'no_run' as const)
      if (lease !== 'held') handout.push(job)
    }
    return Response.json({ jobs: handout })
  } catch {
    return Response.json({ jobs }) // lease layer down → behave exactly as before
  }
}
