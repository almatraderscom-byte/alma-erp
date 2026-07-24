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

function optionalNumber(value: unknown): number | null {
  if (value == null || String(value).trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

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
  const nextRenewalAt = optionalDate(body.nextRenewalAt)
  if (!name || !Number.isFinite(amount) || amount <= 0 || !nextRenewalAt) {
    return Response.json({ error: 'name, amount, nextRenewalAt required' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const row = await db.agentSubscription.create({
    data: {
      name,
      amount,
      currency: String(body.currency ?? 'USD').trim().toUpperCase(),
      billingCycle,
      nextRenewalAt,
      category: body.category ? String(body.category) : null,
      notes: body.notes ? String(body.notes) : null,
      plan: body.plan ? String(body.plan) : null,
      paymentMethod: body.paymentMethod ? String(body.paymentMethod) : null,
      providerId: optionalText(body.providerId)?.toLowerCase() ?? null,
      sourceType: SOURCE_TYPES.has(String(body.sourceType)) ? String(body.sourceType) : 'manual',
      externalSubscriptionId: optionalText(body.externalSubscriptionId),
      billingPeriodStart: optionalDate(body.billingPeriodStart),
      billingPeriodEnd: optionalDate(body.billingPeriodEnd),
      invoiceAmount: optionalNumber(body.invoiceAmount),
      invoiceCurrency: optionalText(body.invoiceCurrency)?.toUpperCase() ?? null,
      invoiceDueAt: optionalDate(body.invoiceDueAt),
      invoiceStatus: optionalText(body.invoiceStatus),
      sourceUrl: optionalText(body.sourceUrl),
      lastSyncedAt: optionalDate(body.lastSyncedAt),
      syncStatus: SYNC_STATUSES.has(String(body.syncStatus)) ? String(body.syncStatus) : 'manual',
      active: true,
    },
  })
  return Response.json(row, { status: 201 })
}
