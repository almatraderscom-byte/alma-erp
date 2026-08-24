/**
 * Open-loop task chip — conversation-scoped list of unfinished work, plus the
 * Continue / Cancel actions for chat follow-ups.
 *
 *   GET  ?conversationId=...   → { tasks: [...] }
 *        Combines two kinds the owner asked to see together:
 *          • chat_followup    — agent_open_tasks rows the head recorded
 *          • approval_pending — agent_pending_actions still awaiting a decision
 *        (Approval cards keep their own inline Approve/Reject; here they only
 *         add to the "বাকি কাজ" count and link back via pendingActionId.)
 *
 *   POST { id, action: 'continue' | 'cancel' }  (chat_followup only)
 *        • continue → atomically binds the exact source to one durable turn,
 *          schedules/runs it, and returns only the turn attach descriptor.
 *          The private resumeNote never crosses the client authority boundary.
 *        • cancel   → marks it cancelled.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { extractBearerToken, verifyAgentInternalToken } from '@/lib/agent-internal-auth'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { listOpenTasks, getOpenTask, resolveOpenTask } from '@/agent/lib/open-task'
import { enqueueAgentContinuation } from '@/agent/lib/approval-continuation'
import {
  ContinuationBindingError,
  continuationDomainForWorkflowKind,
  findExistingBoundContinuationTurn,
  settleUnclaimedOpenTaskContinuation,
  type ContinuationBindingV1,
} from '@/agent/lib/continuation-binding'
import { getTurnSnapshot } from '@/agent/lib/turn-status'

export const runtime = 'nodejs'
export const maxDuration = 120

type ContinuationResult = Awaited<ReturnType<typeof enqueueAgentContinuation>>

async function continuationResponse(
  openTaskId: string,
  conversationId: string,
  continuation: ContinuationResult,
) {
  if (continuation.outcome === 'deferred') {
    return NextResponse.json({
      ok: false, error: 'continuation_deferred', openTaskId,
    }, { status: 503 })
  }
  if (continuation.outcome === 'disabled') {
    return NextResponse.json({
      ok: false, error: 'continuation_blocked',
      reason: continuation.status, openTaskId,
    }, { status: 409 })
  }
  if (continuation.outcome === 'rejected' || !continuation.turnId) {
    return NextResponse.json({
      ok: false, error: 'continuation_rejected',
      reason: continuation.status, openTaskId,
    }, { status: 422 })
  }

  const snapshot = await getTurnSnapshot(continuation.turnId)
  if (!snapshot || snapshot.conversationId !== conversationId) {
    return NextResponse.json({
      ok: false, error: 'continuation_snapshot_unavailable', openTaskId,
    }, { status: 503 })
  }
  return NextResponse.json({
    ok: true,
    action: 'continue',
    conversationId: snapshot.conversationId,
    turnId: snapshot.id,
    // This is the client-applied cursor, not the server high-water mark.
    // A first attach must replay every pre-response card/artifact event.
    lastSeq: -1,
    status: snapshot.status,
  }, { status: snapshot.status === 'running' ? 202 : 200 })
}

function isInternalToken(req: NextRequest): boolean {
  return verifyAgentInternalToken(extractBearerToken(req.headers.get('authorization')))
}

async function checkAuth(req: NextRequest): Promise<boolean> {
  if (isInternalToken(req)) return true
  const session = await getServerSession(authOptions)
  return !!(session && isSystemOwner(session))
}

export async function GET(req: NextRequest) {
  const gate = requireAgentEnabled()
  if (gate) return gate
  if (!(await checkAuth(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const conversationId = req.nextUrl.searchParams.get('conversationId')
  const businessId = req.nextUrl.searchParams.get('business_id') || 'ALMA_LIFESTYLE'
  if (!conversationId) return NextResponse.json({ tasks: [] })

  // Chat follow-ups the head recorded (self-reconciling against resolved cards).
  const followups = await listOpenTasks(conversationId, businessId)

  // Approval cards still awaiting a decision for this chat.
  const pending = await prisma.agentPendingAction.findMany({
    where: { conversationId, businessId, status: 'pending' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, summary: true, type: true, createdAt: true },
  })

  const tasks = [
    ...followups
      .filter((t) => t.kind === 'chat_followup')
      .map((t) => ({
        id: t.id,
        kind: 'chat_followup' as const,
        title: t.title,
        // `resumeNote` is execution authority rendered server-side only after
        // the source-bound turn is claimed. The task list exposes identity and
        // a display title, never the directive itself.
        note: '',
        ageMinutes: t.ageMinutes,
      })),
    ...pending.map((p) => ({
      id: p.id,
      kind: 'approval_pending' as const,
      title: (p.summary || 'অনুমোদন বাকি').slice(0, 120),
      note: p.summary || '',
      pendingActionId: p.id,
      ageMinutes: Math.max(0, Math.round((Date.now() - p.createdAt.getTime()) / 60000)),
    })),
  ]

  return NextResponse.json({ tasks })
}

export async function POST(req: NextRequest) {
  const gate = requireAgentEnabled()
  if (gate) return gate
  if (!(await checkAuth(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { id?: string; action?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  const id = String(body.id ?? '').trim()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  if (body.action !== 'continue' && body.action !== 'cancel') {
    return NextResponse.json({ error: 'invalid action' }, { status: 400 })
  }
  const action = body.action

  if (action === 'cancel') {
    const task = await getOpenTask(id)
    if (!task) return NextResponse.json({ error: 'not found' }, { status: 404 })
    await resolveOpenTask(id, 'cancelled')
    return NextResponse.json({ ok: true, action: 'cancel' })
  }

  // Read only immutable binding facts here. bind/enqueue revalidates the source
  // status + conversation in its DB transaction before creating/reusing a turn;
  // this read cannot authorize execution by itself.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const task = await (prisma as any).agentOpenTask.findUnique({
    where: { id },
    select: {
      id: true,
      businessId: true,
      conversationId: true,
      kind: true,
      status: true,
      workflowRunId: true,
    },
  }) as {
    id: string
    businessId: string
    conversationId: string | null
    kind: string
    status: string
    workflowRunId: string | null
  } | null
  if (!task) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (task.kind !== 'chat_followup') {
    return NextResponse.json({ error: 'open_task_not_continuable' }, { status: 409 })
  }
  if (!task.conversationId) {
    return NextResponse.json({ error: 'open_task_conversation_missing' }, { status: 409 })
  }
  try {
    // A Continue response can be lost after the executor has already finished
    // and resolved this source. Immutable request identity wins before mutable
    // source status: replay the one prior turn, but never create from a terminal
    // unbound task.
    const existing = await findExistingBoundContinuationTurn({
      conversationId: task.conversationId,
      origin: 'open_task',
      source: { kind: 'open_task', id: task.id },
      event: 'resume_requested',
    })
    if (existing) {
      if (existing.status === 'running' && !existing.executionClaimed) {
        if (task.status !== 'open') {
          // Atomically settle a deferred turn whose source completed before it
          // gained execution authority. A concurrent claim wins this CAS and
          // is observed via the same exact descriptor; it is never canceled
          // underneath its executor and the terminal source is never rerun.
          const settlement = await settleUnclaimedOpenTaskContinuation({
            conversationId: task.conversationId,
            turnId: existing.turnId,
            requestId: existing.requestId,
          })
          return continuationResponse(task.id, task.conversationId, {
            outcome: 'observe',
            turnId: existing.turnId,
            requestId: existing.requestId,
            status: settlement.status,
          })
        }
        const retried = await enqueueAgentContinuation({
          conversationId: task.conversationId,
          binding: existing.binding,
          turnId: existing.turnId,
          force: true,
          inlineDeadlineAtMs: Date.now() + 115_000,
        })
        return continuationResponse(task.id, task.conversationId, retried)
      }
      return continuationResponse(task.id, task.conversationId, {
        outcome: 'observe',
        turnId: existing.turnId,
        requestId: existing.requestId,
        status: existing.status,
      })
    }
  } catch (error) {
    if (error instanceof ContinuationBindingError) {
      const status = error.code === 'continuation_binding_conflict' ? 409 : 422
      return NextResponse.json({ error: error.code, openTaskId: task.id }, { status })
    }
    console.error('[assistant/open-tasks] continuation replay lookup failed', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'continuation_failed', openTaskId: task.id }, { status: 500 })
  }
  // Only an existing immutable binding can explain running/terminal replay.
  // A source with no matching bound turn may start execution only from `open`.
  if (task.status !== 'open') {
    return NextResponse.json({ error: 'open_task_already_resolved', status: task.status }, { status: 409 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workflow = task.workflowRunId
    ? await (prisma as any).workflowRun.findUnique({
        where: { id: task.workflowRunId },
        select: { id: true, kind: true, status: true, stateVersion: true },
      }) as { id: string; kind: string; status: string; stateVersion: number } | null
    : null
  if (task.workflowRunId && !workflow) {
    return NextResponse.json({ error: 'open_task_workflow_missing' }, { status: 409 })
  }

  const domain = continuationDomainForWorkflowKind(workflow?.kind)
  const binding: ContinuationBindingV1 = {
    v: 1,
    origin: 'open_task',
    source: { kind: 'open_task', id: task.id },
    conversationId: task.conversationId,
    domain,
    event: 'resume_requested',
    directive: { kind: 'open_task_resume', version: 1 },
    expected: {
      sourceStatus: ['open'],
      sourceType: 'chat_followup',
      ...(workflow ? {
        workflowKind: workflow.kind,
        workflowStateVersion: workflow.stateVersion,
      } : {}),
    },
    ...(workflow ? { workflowRunId: workflow.id } : {}),
  }

  try {
    const continuation = await enqueueAgentContinuation({
      conversationId: task.conversationId,
      binding,
      force: true,
      // 120 s route budget minus response/terminal headroom; the shared helper
      // runs inline only when its full 90 s cap still fits.
      inlineDeadlineAtMs: Date.now() + 115_000,
    })

    return continuationResponse(task.id, task.conversationId, continuation)
  } catch (error) {
    if (error instanceof ContinuationBindingError) {
      const status = error.code === 'continuation_source_not_found'
        ? 404
        : error.code === 'continuation_source_status_mismatch'
          || error.code === 'continuation_binding_conflict'
          ? 409
          : 422
      return NextResponse.json({ error: error.code, openTaskId: task.id }, { status })
    }
    console.error('[assistant/open-tasks] continuation failed', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'continuation_failed', openTaskId: task.id }, { status: 500 })
  }
}
