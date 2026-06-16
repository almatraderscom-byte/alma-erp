import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { extractBearerToken, verifyAgentInternalToken } from '@/lib/agent-internal-auth'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'

function isInternalToken(req: NextRequest): boolean {
  return verifyAgentInternalToken(extractBearerToken(req.headers.get('authorization')))
}

async function checkAuth(req: NextRequest): Promise<boolean> {
  if (isInternalToken(req)) return true
  const session = await getServerSession(authOptions)
  return !!(session && isSystemOwner(session))
}

export async function GET(req: NextRequest) {
  if (!(await checkAuth(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const businessId = req.nextUrl.searchParams.get('business_id') || 'ALMA_LIFESTYLE'
  const statusParam = req.nextUrl.searchParams.get('status')
  const includeCompleted = req.nextUrl.searchParams.get('includeCompleted') === 'true'

  const where: Record<string, unknown> = { businessId }

  if (statusParam) {
    const statuses = statusParam.split(',').map(s => s.trim())
    where.status = statuses.length === 1 ? statuses[0] : { in: statuses }
  } else if (!includeCompleted) {
    where.status = { notIn: ['completed', 'cancelled'] }
  }

  const todos = await prisma.agentTodo.findMany({
    where,
    orderBy: [
      { status: 'asc' },
      { priority: 'desc' },
      { createdAt: 'desc' },
    ],
  })

  return NextResponse.json({ todos })
}

export async function POST(req: NextRequest) {
  if (!(await checkAuth(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json() as {
    title: string
    description?: string
    priority?: string
    dueDate?: string
    source?: string
    businessId?: string
  }

  if (!body.title?.trim()) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 })
  }

  const todo = await prisma.agentTodo.create({
    data: {
      title: body.title.trim(),
      description: body.description?.trim() || null,
      priority: body.priority || 'normal',
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      source: body.source || 'owner',
      businessId: body.businessId || 'ALMA_LIFESTYLE',
    },
  })

  return NextResponse.json({ todo }, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  if (!(await checkAuth(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json() as {
    id: string
    title?: string
    description?: string
    priority?: string
    status?: string
    dueDate?: string | null
  }

  if (!body.id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  // Capture pre-update state so we can detect "just completed" transitions
  // and send the owner a Telegram completion ping (Cursor-style "task done" feedback).
  const before = await prisma.agentTodo.findUnique({ where: { id: body.id } })
  if (!before) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const data: Record<string, unknown> = {}
  if (body.title !== undefined) data.title = body.title.trim()
  if (body.description !== undefined) data.description = body.description?.trim() || null
  if (body.priority !== undefined) data.priority = body.priority
  if (body.status !== undefined) {
    data.status = body.status
    if (body.status === 'completed') data.completedAt = new Date()
    else data.completedAt = null
  }
  if (body.dueDate !== undefined) data.dueDate = body.dueDate ? new Date(body.dueDate) : null

  const todo = await prisma.agentTodo.update({
    where: { id: body.id },
    data,
  })

  // Fire-and-forget Telegram ping when a task transitions into the "completed"
  // state. Only pings for agent-completed tasks (not when the owner ticks off
  // their own task in the UI) to avoid notification spam.
  if (
    body.status === 'completed' &&
    before.status !== 'completed' &&
    before.source === 'agent'
  ) {
    void sendOwnerText(`✅ কাজ সম্পন্ন: ${todo.title}`).catch(() => {})
  }

  return NextResponse.json({ todo })
}

export async function DELETE(req: NextRequest) {
  if (!(await checkAuth(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const id = req.nextUrl.searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  await prisma.agentTodo.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
