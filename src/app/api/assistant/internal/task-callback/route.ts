/**
 * POST /api/assistant/internal/task-callback
 * Staff Done / proof / owner approve-redo — task verification flow.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'
import {
  shouldVerifyTaskType,
  proofPromptForType,
  type ProofType,
  type VerificationStatus,
} from '@/agent/lib/task-verification'

export const runtime = 'nodejs'

function checkToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

type TaskAction =
  | 'done'
  | 'proof'
  | 'auto_verified'
  | 'approve'
  | 'redo'
  | 'timeout_unverified'

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const {
    taskId,
    staffId,
    action = 'done',
    proofType,
    proofData,
    reviewerNote,
    evidence,
    method,
  } = body as {
    taskId?: string
    staffId?: string
    action?: TaskAction
    proofType?: ProofType
    proofData?: Record<string, unknown>
    reviewerNote?: string
    evidence?: string
    method?: string
  }

  if (!taskId) return NextResponse.json({ error: 'taskId required' }, { status: 400 })

  const task = await db.agentStaffTask.findUnique({
    where: { id: taskId },
    include: { staff: { select: { id: true, name: true, telegramChatId: true } } },
  })

  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const staffActions: TaskAction[] = ['done', 'proof']
  if (staffId && staffActions.includes(action) && task.staff.id !== staffId) {
    return NextResponse.json({ error: 'Staff mismatch' }, { status: 403 })
  }

  const now = new Date()

  if (action === 'done') {
    const verify = await shouldVerifyTaskType(task.type)
    if (!verify) {
      await db.agentStaffTask.update({
        where: { id: taskId },
        data: {
          status: 'done',
          verificationStatus: 'not_required',
          completedAt: now,
          proofType: 'none',
        },
      })
      return NextResponse.json({
        ok: true,
        instant: true,
        taskId,
        status: 'done',
        staffName: task.staff.name,
        taskTitle: task.title,
        taskType: task.type,
      })
    }

    const prompt = proofPromptForType(task.type)
    await db.agentStaffTask.update({
      where: { id: taskId },
      data: {
        status: 'awaiting_proof',
        verificationStatus: 'awaiting_proof',
        proofData: {
          proofRequestedAt: now.toISOString(),
          reminderSentAt: null,
        },
      },
    })

    return NextResponse.json({
      ok: true,
      instant: false,
      taskId,
      status: 'awaiting_proof',
      staffName: task.staff.name,
      taskTitle: task.title,
      taskType: task.type,
      staffChatId: task.staff.telegramChatId,
      proofMode: prompt.mode,
      staffMessage: prompt.message,
    })
  }

  if (action === 'auto_verified') {
    await db.agentStaffTask.update({
      where: { id: taskId },
      data: {
        verificationStatus: 'auto_verified',
        proofType: (method === 'auto_erp' ? 'auto_erp' : 'auto_fb') as ProofType,
        proofData: {
          ...(task.proofData as object ?? {}),
          evidence: evidence ?? '',
          checkedAt: now.toISOString(),
          method: method ?? 'auto',
        },
      },
    })
    const updated = await db.agentStaffTask.findUnique({
      where: { id: taskId },
      include: { staff: { select: { id: true, name: true } } },
    })
    return NextResponse.json({
      ok: true,
      taskId,
      status: updated?.status,
      verificationStatus: 'auto_verified',
      staffName: updated?.staff?.name ?? task.staff.name,
      taskTitle: updated?.title ?? task.title,
      evidence: evidence ?? '',
      needsOwnerReview: true,
    })
  }

  if (action === 'proof') {
    await db.agentStaffTask.update({
      where: { id: taskId },
      data: {
        verificationStatus: 'proof_submitted',
        proofType: proofType ?? 'photo',
        proofData: {
          ...(task.proofData as object ?? {}),
          ...proofData,
          submittedAt: now.toISOString(),
        },
      },
    })
    const updated = await db.agentStaffTask.findUnique({
      where: { id: taskId },
      include: { staff: { select: { id: true, name: true } } },
    })
    return NextResponse.json({
      ok: true,
      taskId,
      verificationStatus: 'proof_submitted',
      staffName: updated?.staff?.name ?? task.staff.name,
      taskTitle: updated?.title ?? task.title,
      proofType: proofType ?? 'photo',
      proofData: proofData ?? {},
      needsOwnerReview: true,
    })
  }

  if (action === 'approve') {
    await db.agentStaffTask.update({
      where: { id: taskId },
      data: {
        status: 'done',
        verificationStatus: 'owner_approved',
        completedAt: now,
      },
    })
    return NextResponse.json({
      ok: true,
      taskId,
      status: 'done',
      staffName: task.staff.name,
      taskTitle: task.title,
      staffId: task.staff.id,
      proposedFor: task.proposedFor instanceof Date
        ? task.proposedFor.toISOString().slice(0, 10)
        : String(task.proposedFor).slice(0, 10),
      completed: true,
    })
  }

  if (action === 'redo') {
    const redoCount = (task.redoCount ?? 0) + 1
    await db.agentStaffTask.update({
      where: { id: taskId },
      data: {
        status: 'sent',
        verificationStatus: 'redo_requested',
        reviewerNote: reviewerNote?.trim() || null,
        redoCount,
        proofType: null,
        proofData: {
          redoAt: now.toISOString(),
          redoCount,
        },
        completedAt: null,
      },
    })
    return NextResponse.json({
      ok: true,
      taskId,
      status: 'sent',
      verificationStatus: 'redo_requested' as VerificationStatus,
      staffName: task.staff.name,
      taskTitle: task.title,
      staffChatId: task.staff.telegramChatId,
      reviewerNote: reviewerNote?.trim() || null,
      redoCount,
    })
  }

  if (action === 'timeout_unverified') {
    await db.agentStaffTask.update({
      where: { id: taskId },
      data: {
        status: 'done_unverified',
        verificationStatus: 'awaiting_proof',
        proofData: {
          ...(task.proofData as object ?? {}),
          timedOutAt: now.toISOString(),
          unverified: true,
        },
      },
    })
    return NextResponse.json({
      ok: true,
      taskId,
      status: 'done_unverified',
      staffName: task.staff.name,
      taskTitle: task.title,
      flagged: true,
    })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
