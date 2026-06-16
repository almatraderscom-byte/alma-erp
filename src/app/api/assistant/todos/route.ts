import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || !isSystemOwner(session)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const businessId = req.nextUrl.searchParams.get('business_id') || 'ALMA_LIFESTYLE'
  const status = req.nextUrl.searchParams.get('status')

  const where: Record<string, unknown> = { businessId }
  if (status) where.status = status

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
  const session = await getServerSession(authOptions)
  if (!session || !isSystemOwner(session)) {
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
  const session = await getServerSession(authOptions)
  if (!session || !isSystemOwner(session)) {
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

  return NextResponse.json({ todo })
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || !isSystemOwner(session)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const id = req.nextUrl.searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  await prisma.agentTodo.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
