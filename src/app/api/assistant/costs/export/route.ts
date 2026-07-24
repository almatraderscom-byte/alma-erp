import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

function csvEscape(val: unknown): string {
  const s = val == null ? '' : String(val)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const month = req.nextUrl.searchParams.get('month') // YYYY-MM
  const now = new Date()
  const monthStr = month && /^\d{4}-\d{2}$/.test(month)
    ? month
    : now.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }).slice(0, 7)

  const [y, m] = monthStr.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1) - 6 * 60 * 60 * 1000)
  const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - 6 * 60 * 60 * 1000)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const events = await db.agentCostEvent.findMany({
    where: { occurredAt: { gte: start, lt: end } },
    orderBy: { occurredAt: 'asc' },
  })
  const subs = await db.agentSubscription.findMany({ orderBy: { name: 'asc' } })

  const lines: string[] = []
  lines.push('=== Cost Events ===')
  lines.push(['occurred_at', 'provider', 'kind', 'cost_usd', 'conversation_id', 'job_id', 'units'].join(','))
  for (const e of events) {
    lines.push([
      csvEscape(e.occurredAt.toISOString()),
      csvEscape(e.provider),
      csvEscape(e.kind),
      csvEscape(e.costUsd),
      csvEscape(e.conversationId),
      csvEscape(e.jobId),
      csvEscape(JSON.stringify(e.units)),
    ].join(','))
  }
  lines.push('')
  lines.push('=== Subscriptions ===')
  lines.push([
    'name', 'provider_id', 'plan', 'amount', 'currency', 'billing_cycle',
    'next_renewal_at', 'invoice_amount', 'invoice_currency', 'invoice_due_at',
    'invoice_status', 'source_type', 'sync_status', 'last_synced_at',
    'source_url', 'payment_method', 'category', 'active', 'notes',
  ].join(','))
  for (const s of subs) {
    lines.push([
      csvEscape(s.name),
      csvEscape(s.providerId),
      csvEscape(s.plan),
      csvEscape(s.amount),
      csvEscape(s.currency),
      csvEscape(s.billingCycle),
      csvEscape(s.nextRenewalAt.toISOString().slice(0, 10)),
      csvEscape(s.invoiceAmount),
      csvEscape(s.invoiceCurrency),
      csvEscape(s.invoiceDueAt?.toISOString().slice(0, 10)),
      csvEscape(s.invoiceStatus),
      csvEscape(s.sourceType),
      csvEscape(s.syncStatus),
      csvEscape(s.lastSyncedAt?.toISOString()),
      csvEscape(s.sourceUrl),
      csvEscape(s.paymentMethod),
      csvEscape(s.category),
      csvEscape(s.active),
      csvEscape(s.notes),
    ].join(','))
  }

  const bom = '\uFEFF'
  const body = bom + lines.join('\n')
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="alma-agent-costs-${monthStr}.csv"`,
    },
  })
}
