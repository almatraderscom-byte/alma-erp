import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { extractBearerToken, verifyAgentInternalToken } from '@/lib/agent-internal-auth'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { sortTodosForDisplay } from '@/agent/lib/todo-sort'
import { getDutyEnabledMap, isDutyEnabledSync } from '@/agent/lib/duty-enabled'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

function dueDateRangeDhaka(ymd: string): { start: Date; end: Date } {
  const day = ymd.slice(0, 10)
  return {
    start: new Date(`${day}T00:00:00+06:00`),
    end: new Date(`${day}T23:59:59.999+06:00`),
  }
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
  if (!(await checkAuth(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const businessId = req.nextUrl.searchParams.get('business_id') || 'ALMA_LIFESTYLE'
  const statusParam = req.nextUrl.searchParams.get('status')
  const includeCompleted = req.nextUrl.searchParams.get('includeCompleted') === 'true'

  // view=owner — the dashboard "আমার টুডু" scope (owner rule 2026-07-12): ONLY
  //   1. the owner's own todos (source='owner' — added by him in the UI, or added
  //      for him by the agent on his request) → persist until HE completes them;
  //   2. agent-raised items that need the OWNER's action today
  //      (source='owner_action') → shown for the day they were raised, then they
  //      reset (drop off) at the Dhaka day end automatically.
  // The agent's own work items (source='agent'), scheduler duties (day_shift /
  // dutyKey) and every other machine source NEVER appear in this view — that
  // noise is what inflated the widget to 23 "pending" items.
  if (req.nextUrl.searchParams.get('view') === 'owner') {
    const { start, end } = dueDateRangeDhaka(todayYmdDhaka())
    const [ownerTodos, ownerActions] = await Promise.all([
      prisma.agentTodo.findMany({
        where: {
          businessId,
          source: 'owner',
          dutyKey: null,
          status: includeCompleted ? undefined : { notIn: ['completed', 'cancelled'] },
        },
        orderBy: [{ createdAt: 'desc' }],
      }),
      prisma.agentTodo.findMany({
        where: {
          businessId,
          source: 'owner_action',
          status: { notIn: ['completed', 'cancelled'] },
          OR: [
            { createdAt: { gte: start, lte: end } },
            { dueDate: { gte: start, lte: end } },
          ],
        },
        orderBy: [{ createdAt: 'desc' }],
      }),
    ])
    const serializedOwner = sortTodosForDisplay([...ownerActions, ...ownerTodos]).map((t) => ({
      ...t,
      dueDate: t.dueDate?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      completedAt: t.completedAt?.toISOString() ?? null,
    }))
    return NextResponse.json({ todos: serializedOwner })
  }

  const where: Record<string, unknown> = { businessId }

  if (statusParam) {
    const statuses = statusParam.split(',').map(s => s.trim())
    where.status = statuses.length === 1 ? statuses[0] : { in: statuses }
  } else if (!includeCompleted) {
    where.status = { notIn: ['completed', 'cancelled'] }
  }

  const todos = await prisma.agentTodo.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }],
  })

  // Make the persistent list match today's agent duties:
  //  - drop salah (never a to-do, per owner),
  //  - drop duties the owner switched OFF in the Control Center,
  //  - drop stale rows from previous days (the count was inflated by all-time
  //    history) — keep anything due/created today, plus active ad-hoc tasks,
  //  - carry over recent UNFINISHED work (pending/in-progress) from the last few
  //    days so genuinely-missed tasks don't silently vanish. Bounded window keeps
  //    the count from re-inflating with old history; finished/failed rows stay hidden.
  const CARRYOVER_DAYS = 3
  const OPEN_STATUSES = new Set(['pending', 'in_progress', 'running'])
  const dutyEnabled = await getDutyEnabledMap()
  const { start, end } = dueDateRangeDhaka(todayYmdDhaka())
  const carryoverStart = new Date(start.getTime() - CARRYOVER_DAYS * 24 * 60 * 60 * 1000)
  const visibleTodos = todos.filter((t) => {
    if (t.dutyKey === 'salah_init') return false
    if (t.dutyKey && !isDutyEnabledSync(t.dutyKey, dutyEnabled)) return false
    const dueToday = t.dueDate ? t.dueDate >= start && t.dueDate <= end : false
    const createdToday = t.createdAt >= start && t.createdAt <= end
    const activeAdhoc = !t.dutyKey && t.status !== 'completed' && t.status !== 'cancelled'
    const recentUnfinished = OPEN_STATUSES.has(t.status) && t.createdAt >= carryoverStart
    // Keep a just-cancelled row visible for the rest of today so the owner sees
    // the red-cross + agent-name removal trail (then it drops off tomorrow).
    const recentlyCancelled =
      (t.status === 'cancelled' || t.status === 'failed') && t.updatedAt >= start && t.updatedAt <= end
    return dueToday || createdToday || activeAdhoc || recentUnfinished || recentlyCancelled
  })

  const serialized = sortTodosForDisplay(visibleTodos).map((t) => ({
    ...t,
    dueDate: t.dueDate?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
  }))

  return NextResponse.json({ todos: serialized })
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
    dutyKey?: string
  }

  if (!body.title?.trim()) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 })
  }

  const businessId = body.businessId || 'ALMA_LIFESTYLE'
  const dutyKey = body.dutyKey?.trim() || null

  if (dutyKey && body.dueDate) {
    const { start, end } = dueDateRangeDhaka(body.dueDate)
    const existing = await prisma.agentTodo.findFirst({
      where: {
        businessId,
        dutyKey,
        dueDate: { gte: start, lte: end },
      },
    })
    if (existing) {
      return NextResponse.json({ todo: existing, deduped: true })
    }
  }

  const todo = await prisma.agentTodo.create({
    data: {
      title: body.title.trim(),
      description: body.description?.trim() || null,
      priority: body.priority || 'normal',
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      source: body.source || 'owner',
      dutyKey,
      businessId,
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
