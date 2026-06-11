import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const data: Record<string, unknown> = {}
  if (body.name != null) data.name = String(body.name)
  if (body.amount != null) data.amount = Number(body.amount)
  if (body.currency != null) data.currency = String(body.currency)
  if (body.billingCycle != null) data.billingCycle = body.billingCycle === 'yearly' ? 'yearly' : 'monthly'
  if (body.nextRenewalAt != null) data.nextRenewalAt = new Date(String(body.nextRenewalAt))
  if (body.category != null) data.category = body.category ? String(body.category) : null
  if (body.notes != null) data.notes = body.notes ? String(body.notes) : null
  if (body.active != null) data.active = Boolean(body.active)

  const row = await db.agentSubscription.update({ where: { id: params.id }, data })
  return Response.json(row)
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  await db.agentSubscription.update({ where: { id: params.id }, data: { active: false } })
  return Response.json({ ok: true })
}
