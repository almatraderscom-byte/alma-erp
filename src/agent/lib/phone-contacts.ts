/**
 * Phone identity resolution — who is this number, in the order every ring surface
 * agrees on: the team's own phonebook first (a saved name is a deliberate act),
 * then the ERP customer record (with order context, so an unsaved customer still
 * shows as "কাস্টমার — অর্ডার AL-0325" instead of a bare number).
 *
 * Used by the CallKit ring push (app-ring), the in-call screen-pop (caller) and
 * the recents list (history) — one resolver, three surfaces, no drift.
 */
import { prisma } from '@/lib/prisma'

 
const db = prisma as any

/** "+8801712-345678" → "01712345678"; keeps short internal extensions as-is. */
export function normalizePhone(raw: string): string {
  let d = String(raw ?? '').replace(/\D/g, '')
  if (d.startsWith('880') && d.length >= 12) d = '0' + d.slice(3)
  return d
}

export type PhoneIdentity = {
  /** Best display name, or null when the number is a stranger. */
  name: string | null
  /** 'contact' | 'customer' | null */
  source: 'contact' | 'customer' | null
  /** Customer extras when found (regardless of whether a contact name won). */
  totalOrders?: number
  lastOrderNumber?: string | null
  lastOrderStatus?: string | null
}

/** Resolve one number. Never throws — a lookup failure is a bare number, not a dead ring. */
export async function resolvePhoneIdentity(rawNumber: string): Promise<PhoneIdentity> {
  const digits = normalizePhone(rawNumber)
  const tail = digits.slice(-10)
  const none: PhoneIdentity = { name: null, source: null }
  if (tail.length < 9) return none
  try {
    const [contact, customer, lastOrder] = await Promise.all([
      db.phoneContact.findFirst({
        where: { phone: { endsWith: tail } },
        select: { name: true },
      }) as Promise<{ name: string } | null>,
      db.lifestyleCustomer.findFirst({
        where: { phone: { endsWith: tail } },
        select: { name: true, totalOrders: true },
      }) as Promise<{ name: string | null; totalOrders: number | null } | null>,
      db.lifestyleOrder.findFirst({
        where: { phone: { endsWith: tail } },
        orderBy: { createdAt: 'desc' },
        select: { orderNumber: true, status: true },
      }).catch(() => null) as Promise<{ orderNumber: string | null; status: string | null } | null>,
    ])
    const name = contact?.name ?? customer?.name ?? null
    if (!name && !customer && !lastOrder) return none
    return {
      name,
      source: contact ? 'contact' : customer ? 'customer' : null,
      totalOrders: customer?.totalOrders ?? (lastOrder ? 1 : 0),
      lastOrderNumber: lastOrder?.orderNumber ?? null,
      lastOrderStatus: lastOrder?.status ?? null,
    }
  } catch {
    return none
  }
}

/**
 * The one-line string a RINGING phone shows (CallKit lock screen). A saved name
 * wins; a known customer says so with their latest order — exactly what the owner
 * asked for: "যাতে বুঝি আমাদের কাস্টমার".
 */
export async function callerRingDisplay(rawNumber: string): Promise<string> {
  const digits = normalizePhone(rawNumber)
  const id = await resolvePhoneIdentity(rawNumber)
  if (!id.name && !id.lastOrderNumber) return digits || 'অজানা নম্বর'
  const parts: string[] = []
  if (id.name) parts.push(id.name)
  else parts.push('কাস্টমার')
  if (id.lastOrderNumber) parts.push(`অর্ডার ${id.lastOrderNumber}`)
  return `${parts.join(' · ')} (${digits})`
}
