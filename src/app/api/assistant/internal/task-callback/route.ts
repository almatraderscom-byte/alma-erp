/**
 * POST /api/assistant/internal/task-callback
 * Called by the worker when a staff member taps [✅ Done] on their task.
 * Updates task status to 'done' and notifies the owner via the agent loop.
 * Internal token auth only.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'

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

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { taskId, staffId, action } = body as {
    taskId?: string; staffId?: string; action?: 'done' | 'ack'
  }

  if (!taskId) return NextResponse.json({ error: 'taskId required' }, { status: 400 })

  const task = await db.agentStaffTask.findUnique({
    where:   { id: taskId },
    include: { staff: { select: { id: true, name: true } } },
  })

  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  if (staffId && task.staff.id !== staffId) {
    return NextResponse.json({ error: 'Staff mismatch' }, { status: 403 })
  }

  const status = action === 'done' ? 'done' : 'done'
  await db.agentStaffTask.update({
    where: { id: taskId },
    data:  { status, completedAt: new Date() },
  })

  return NextResponse.json({ ok: true, taskId, status, staffName: task.staff.name, taskTitle: task.title })
}
