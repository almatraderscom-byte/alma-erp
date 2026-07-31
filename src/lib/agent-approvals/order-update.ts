/**
 * Applying ONE approved order change — the unit both the single card and the
 * batch card are made of.
 *
 * B5's rule is "one card per job, not per item", and the only way that stays
 * honest is if a batch of ten runs exactly the same code as a batch of one.
 * Anything that differs between them is a bug the owner would only meet on the
 * larger, riskier card.
 */
import { prisma } from '@/lib/prisma'
import { updateOrderTextFieldsInPostgres } from '@/lib/lifestyle/write'
import { applyOrderStatusChange, normalizeOrderStatus } from '@/lib/lifestyle/order-status-workflow'

export interface OrderUpdatePayload {
  orderId: string
  invoiceNum?: string | null
  status?: string | null
  fields?: Record<string, string>
  reason?: string | null
}

export interface OrderUpdateOutcome {
  ok: boolean
  orderId: string
  label: string
  applied: string[]
  failures: string[]
  verified: Array<{ field: string; expected: unknown; live: unknown; ok: boolean }>
}

const TEXT_FIELDS = ['courier', 'trackingId', 'notes'] as const

export async function executeOrderUpdate(payload: OrderUpdatePayload): Promise<OrderUpdateOutcome> {
  const orderId = String(payload.orderId ?? '')
  const applied: string[] = []
  const failures: string[] = []

  // Courier, tracking and the note FIRST, status last. A parcel marked shipped
  // before its tracking id exists is one a customer is told about and cannot
  // find — and the courier SMS the status change queues carries that id.
  const textFields = Object.fromEntries(
    Object.entries(payload.fields ?? {}).filter(([k]) => (TEXT_FIELDS as readonly string[]).includes(k)),
  ) as { courier?: string; trackingId?: string; notes?: string }

  if (Object.keys(textFields).length) {
    // A text-only path on purpose: the edit-form helper recalculates sellPrice
    // and profit on every write, so adding a tracking id would rewrite the
    // order's financial result.
    const res = await updateOrderTextFieldsInPostgres(orderId, textFields)
    if ('error' in res) failures.push(`fields: ${res.error}`)
    else applied.push(...Object.keys(textFields))
  }

  if (payload.status) {
    // Through the SHARED workflow, never the low-level helper: a status change
    // also creates or reverses the handler's commission, queues the courier SMS
    // on Shipped, notifies the role matrix and the handler, and logs.
    const res = await applyOrderStatusChange({
      id: orderId,
      status: String(payload.status),
      reason: payload.reason ?? '',
      actorUserId: 'owner-approval',
    })
    if (!res.ok) failures.push(`status: ${res.error}`)
    else applied.push('status')
  }

  // The write reporting success is not the evidence — read the row back.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const live = await (prisma as any).lifestyleOrder.findUnique({ where: { id: orderId } })
  const liveValue = (field: string): unknown => {
    switch (field) {
      case 'status': return live?.status ?? null
      case 'courier': return live?.courier ?? null
      case 'trackingId': return live?.trackingId ?? null
      case 'notes': return live?.notes ?? null
      default: return null
    }
  }

  const wanted: Record<string, unknown> = { ...(payload.fields ?? {}) }
  if (payload.status) wanted.status = payload.status

  const verified = Object.entries(wanted).map(([field, want]) => {
    const got = liveValue(field)
    const same = field === 'status'
      // The ERP has one spelling per status; both sides go through the same
      // normaliser so "processing" and "Packed" are not read as a mismatch.
      ? normalizeOrderStatus(String(got ?? '')) === normalizeOrderStatus(String(want))
      : String(got ?? '').trim() === String(want).trim()
    return { field, expected: want, live: got, ok: same }
  })

  return {
    ok: failures.length === 0 && verified.every((v) => v.ok),
    orderId,
    label: String(live?.invoiceNum || payload.invoiceNum || orderId),
    applied,
    failures,
    verified,
  }
}

/**
 * When an item throws part-way, the truth is whatever the row says NOW.
 *
 * `executeOrderUpdate` commits the text fields before the status workflow, and
 * that workflow can throw from a downstream notification AFTER the status
 * landed. Reporting "nothing applied" there would be its own false claim, so the
 * caller re-reads instead of guessing.
 */
export async function readBackOrderOutcome(
  payload: OrderUpdatePayload,
  error: unknown,
): Promise<OrderUpdateOutcome> {
  const orderId = String(payload.orderId ?? '')
  const wanted: Record<string, unknown> = { ...(payload.fields ?? {}) }
  if (payload.status) wanted.status = payload.status

  let live: Record<string, unknown> | null = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    live = await (prisma as any).lifestyleOrder.findUnique({ where: { id: orderId } })
  } catch {
    live = null
  }

  const liveValue = (field: string): unknown => {
    switch (field) {
      case 'status': return live?.status ?? null
      case 'courier': return live?.courier ?? null
      case 'trackingId': return live?.trackingId ?? null
      case 'notes': return live?.notes ?? null
      default: return null
    }
  }

  const verified = Object.entries(wanted).map(([field, want]) => {
    const got = liveValue(field)
    const same = field === 'status'
      ? normalizeOrderStatus(String(got ?? '')) === normalizeOrderStatus(String(want))
      : String(got ?? '').trim() === String(want).trim()
    return { field, expected: want, live: got, ok: same }
  })

  return {
    ok: false,
    orderId,
    label: String((live?.invoiceNum as string | undefined) || payload.invoiceNum || orderId),
    applied: verified.filter((v) => v.ok).map((v) => v.field),
    failures: [`threw: ${error instanceof Error ? error.message : String(error)}`],
    verified,
  }
}

/** One order's line on the owner-facing note: what the ERP says now. */
export function outcomeNoteLines(outcome: OrderUpdateOutcome): string {
  return outcome.verified
    .map((v) => `${v.ok ? '✅' : '❌'} ${v.field}: ${String(v.live ?? '(খালি)').slice(0, 60)}`)
    .join('\n')
}
