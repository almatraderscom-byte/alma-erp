import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import { listAgentOrders } from '@/lib/agent-api/orders.service'
import {
  resolveProductCode,
  normalizeProductCode,
} from '@/agent/lib/catalog/inventory-lookup'
import { sendMessengerText } from '@/agent/lib/cs/meta-messenger'
import { upsertCsCustomerFromDraft, extractSizesFromItems } from '@/agent/lib/cs/customers'
import { schedulePostConfirmThanks } from '@/agent/lib/cs/followups'
import { recordCsEvent } from '@/agent/lib/cs/analytics'
import { incrementCsReplyCount } from '@/agent/lib/cs/guards'
import { notifyOwner } from '@/agent/lib/notify-owner'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.startsWith('880')) return digits
  if (digits.startsWith('0')) return `88${digits}`
  if (digits.length === 10) return `880${digits}`
  return digits
}

function phonesMatch(a: string, b: string): boolean {
  const na = normalizePhone(a)
  const nb = normalizePhone(b)
  return na === nb || na.endsWith(nb.slice(-10)) || nb.endsWith(na.slice(-10))
}

const STATUS_BN: Record<string, string> = {
  draft: 'ড্রাফট — কনফার্মেশন অপেক্ষায়',
  pending: 'অর্ডার নেওয়া হয়েছে',
  confirmed: 'কনফার্ম হয়েছে',
  processing: 'প্যাকিং হচ্ছে',
  shipped: 'শিপ করা হয়েছে',
  delivered: 'ডেলিভারি সম্পন্ন',
  cancelled: 'বাতিল',
  refunded: 'রিটার্ন/রিফান্ড',
}

export async function computeCodAmount(items: Array<{ code?: string; qty?: number }>): Promise<number> {
  let total = 0
  for (const item of items) {
    const code = normalizeProductCode(String(item.code ?? ''))
    const qty = Math.max(1, Number(item.qty ?? 1))
    if (!code) continue
    const resolved = await resolveProductCode(code)
    if (resolved.ok) total += roundMoney(resolved.row.sellPrice * qty)
  }
  return roundMoney(total)
}

export function buildOrderConfirmMessage(draft: {
  items: unknown
  address?: string | null
  codAmount?: number | null
  customerName?: string | null
}): string {
  const items = Array.isArray(draft.items) ? draft.items as Array<{ code?: string; qty?: number; variant?: string }> : []
  const lines = items.map((i) => {
    const v = i.variant ? ` (${i.variant})` : ''
    return `• ${i.code} x${i.qty ?? 1}${v}`
  }).join('\n')
  const cod = draft.codAmount ? `\nCOD: ৳${draft.codAmount.toLocaleString('bn-BD')}` : ''
  const addr = draft.address ? `\nঠিকানা: ${draft.address}` : ''
  return (
    `আলহামদুলিল্লাহ ভাইয়া, অর্ডার কনফার্ম ✅\n\n` +
    `${lines}${addr}${cod}\n\n` +
    `ডেলিভারি প্রসেসে দিয়ে দিচ্ছি ইনশাআল্লাহ 🙏`
  )
}

export async function confirmCsOrderDraft(input: {
  draftId: string
  confirmedBy?: string
}): Promise<{ ok: boolean; error?: string; message?: string }> {
  const draft = await db.csOrderDraft.findUnique({ where: { id: input.draftId } })
  if (!draft) return { ok: false, error: 'draft_not_found' }
  if (draft.status === 'confirmed') return { ok: false, error: 'already_confirmed' }

  const codAmount = draft.codAmount ?? await computeCodAmount(draft.items as Array<{ code?: string; qty?: number }>)
  const confirmText = buildOrderConfirmMessage({ ...draft, codAmount })

  await db.csOrderDraft.update({
    where: { id: draft.id },
    data: {
      status: 'confirmed',
      confirmedAt: new Date(),
      confirmedBy: input.confirmedBy ?? null,
      codAmount,
    },
  })

  await sendMessengerText(draft.pageId, draft.psid, confirmText)
  await incrementCsReplyCount(draft.conversationId)

  const sizes = extractSizesFromItems(draft.items as Array<{ code?: string; variant?: string }>)
  await upsertCsCustomerFromDraft({
    pageId: draft.pageId,
    psid: draft.psid,
    customerName: draft.customerName,
    phone: draft.phone,
    address: draft.address,
    sizesNoted: sizes,
  })

  await schedulePostConfirmThanks(draft.conversationId)
  await recordCsEvent('draft_confirmed', {
    conversationId: draft.conversationId,
    metadata: { draftId: draft.id, codAmount },
  })

  return { ok: true, message: confirmText }
}

export async function getCustomerOrderStatus(input: {
  psid: string
  pageId?: string
}): Promise<{
  orders: Array<{
    source: 'cs_draft' | 'erp'
    id: string
    status: string
    statusBn: string
    placedAt?: string
    totalAmount?: number
  }>
  unknownExternal: boolean
}> {
  const where: Record<string, unknown> = { psid: input.psid }
  if (input.pageId) where.pageId = input.pageId

  const csDrafts = await db.csOrderDraft.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 5,
  })

  const orders: Array<{
    source: 'cs_draft' | 'erp'
    id: string
    status: string
    statusBn: string
    placedAt?: string
    totalAmount?: number
  }> = csDrafts.map((d: {
    id: string
    status: string
    createdAt: Date
    codAmount: number | null
    erpOrderId: string | null
  }) => ({
    source: 'cs_draft' as const,
    id: d.id,
    status: d.status,
    statusBn: STATUS_BN[d.status] ?? d.status,
    placedAt: d.createdAt.toISOString(),
    totalAmount: d.codAmount ?? undefined,
  }))

  const phone = csDrafts.find((d: { phone?: string }) => d.phone)?.phone
    ?? (await db.csCustomer.findFirst({ where: { psid: input.psid }, select: { phone: true } }))?.phone

  let unknownExternal = false

  if (phone) {
    try {
      const { orders: erpOrders } = await listAgentOrders({ limit: 100 })
      const matched = erpOrders.filter((o) => o.customerPhone && phonesMatch(o.customerPhone, phone))
      for (const o of matched.slice(0, 3)) {
        const known = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded']
        if (!known.includes(o.status)) {
          unknownExternal = true
          continue
        }
        orders.push({
          source: 'erp',
          id: o.id,
          status: o.status,
          statusBn: STATUS_BN[o.status] ?? o.status,
          placedAt: o.placedAt,
          totalAmount: o.totalAmount,
        })
      }
    } catch {
      unknownExternal = true
    }
  }

  if (unknownExternal) {
    await notifyOwner({
      tier: 1,
      title: '⚠️ CS Order Status Unknown',
      message: `PSID ${input.psid} — ERP স্ট্যাটাস অজানা/এক্সটার্নাল`,
      category: 'urgent',
    })
  }

  return { orders, unknownExternal }
}
