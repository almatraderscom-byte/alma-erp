import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

const SOURCE_TYPES = new Set(['manual', 'provider_api', 'provider_export', 'invoice'])
const SYNC_STATUSES = new Set(['manual', 'live', 'partial', 'stale', 'error'])

function optionalText(value: unknown): string | null {
  const text = value == null ? '' : String(value).trim()
  return text || null
}

function optionalDate(value: unknown): Date | null {
  const text = optionalText(value)
  if (!text) return null
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date
}

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
  if (body.amount != null) {
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      return Response.json({ error: 'amount must be a positive number' }, { status: 400 })
    }
    data.amount = amount
  }
  if (body.currency != null) data.currency = String(body.currency).trim().toUpperCase()
  if (body.billingCycle != null) data.billingCycle = body.billingCycle === 'yearly' ? 'yearly' : 'monthly'
  if (body.nextRenewalAt != null) {
    const date = optionalDate(body.nextRenewalAt)
    if (!date) return Response.json({ error: 'nextRenewalAt must be a valid date' }, { status: 400 })
    data.nextRenewalAt = date
  }
  if (body.category != null) data.category = body.category ? String(body.category) : null
  if (body.notes != null) data.notes = body.notes ? String(body.notes) : null
  if (body.plan != null) data.plan = body.plan ? String(body.plan) : null
  if (body.paymentMethod != null) data.paymentMethod = body.paymentMethod ? String(body.paymentMethod) : null
  if (body.providerId != null) data.providerId = optionalText(body.providerId)?.toLowerCase() ?? null
  if (body.sourceType != null && SOURCE_TYPES.has(String(body.sourceType))) data.sourceType = String(body.sourceType)
  if (body.externalSubscriptionId != null) data.externalSubscriptionId = optionalText(body.externalSubscriptionId)
  if (body.billingPeriodStart != null) data.billingPeriodStart = optionalDate(body.billingPeriodStart)
  if (body.billingPeriodEnd != null) data.billingPeriodEnd = optionalDate(body.billingPeriodEnd)
  if (body.invoiceAmount != null) {
    const amount = Number(body.invoiceAmount)
    data.invoiceAmount = Number.isFinite(amount) ? amount : null
  }
  if (body.invoiceCurrency != null) data.invoiceCurrency = optionalText(body.invoiceCurrency)?.toUpperCase() ?? null
  if (body.invoiceDueAt != null) data.invoiceDueAt = optionalDate(body.invoiceDueAt)
  if (body.invoiceStatus != null) data.invoiceStatus = optionalText(body.invoiceStatus)
  if (body.sourceUrl != null) data.sourceUrl = optionalText(body.sourceUrl)
  if (body.lastSyncedAt != null) data.lastSyncedAt = optionalDate(body.lastSyncedAt)
  if (body.syncStatus != null && SYNC_STATUSES.has(String(body.syncStatus))) data.syncStatus = String(body.syncStatus)
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
