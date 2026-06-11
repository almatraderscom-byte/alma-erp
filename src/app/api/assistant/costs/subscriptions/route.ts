import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const rows = await db.agentSubscription.findMany({ orderBy: [{ active: 'desc' }, { nextRenewalAt: 'asc' }] })
  return Response.json(rows)
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  const name = String(body.name ?? '').trim()
  const amount = Number(body.amount)
  const billingCycle = body.billingCycle === 'yearly' ? 'yearly' : 'monthly'
  const nextRenewalAt = body.nextRenewalAt ? String(body.nextRenewalAt) : null
  if (!name || !Number.isFinite(amount) || amount <= 0 || !nextRenewalAt) {
    return Response.json({ error: 'name, amount, nextRenewalAt required' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const row = await db.agentSubscription.create({
    data: {
      name,
      amount,
      currency: String(body.currency ?? 'USD'),
      billingCycle,
      nextRenewalAt: new Date(nextRenewalAt),
      category: body.category ? String(body.category) : null,
      notes: body.notes ? String(body.notes) : null,
      active: true,
    },
  })
  return Response.json(row, { status: 201 })
}
