import crypto from 'crypto'
import { prisma } from '@/lib/prisma'
import { computeWalletSummary, moneyDecimal } from '@/lib/payroll-wallet'
import { notifyUser } from '@/lib/notifications'
import { roundMoney } from '@/lib/money'

export const MANUAL_ADVANCE_RECOVERY_SOURCE = 'advance_recovery_manual'

/**
 * Manual advance recovery — owner rule 2026-07-11: on top of the automatic
 * salary-time recovery, a super admin may settle a staff member's outstanding
 * advance from whatever balance is sitting in their wallet right now.
 *
 * Amount = min(outstanding advance, current wallet balance) — never drives the
 * wallet negative, never recovers more than is owed. Append-only ledger entry;
 * nothing is edited or deleted.
 */
export async function manualAdvanceRecovery(input: {
  employeeId: string
  businessId: string
  actorUserId: string
}) {
  const { employeeId, businessId, actorUserId } = input

  const entries = await prisma.employeeLedgerEntry.findMany({
    where: { employeeId, businessId, isArchived: false },
    orderBy: { createdAt: 'asc' },
  })
  const summary = computeWalletSummary(employeeId, businessId, entries)
  const outstanding = roundMoney(summary.outstandingAdvance)
  const balance = roundMoney(Math.max(0, summary.currentBalance))

  if (outstanding <= 0) {
    return { ok: false as const, error: 'এই কর্মচারীর কোনো অগ্রিম বকেয়া নেই।' }
  }
  if (balance <= 0) {
    return { ok: false as const, error: 'ওয়ালেটে ব্যালেন্স নেই — কাটার মতো টাকা নেই।' }
  }

  const recoverNow = roundMoney(Math.min(outstanding, balance))
  const remaining = roundMoney(outstanding - recoverNow)

  const linked = await prisma.user.findFirst({
    where: { active: true, employeeIdGas: employeeId },
    select: { id: true },
  })

  const entry = await prisma.employeeLedgerEntry.create({
    data: {
      employeeId,
      userId: linked?.id || null,
      businessId,
      date: new Date(),
      type: 'ADVANCE_RECOVERY',
      amount: moneyDecimal(recoverNow),
      note:
        remaining > 0
          ? `অগ্রিম সমন্বয় — ওয়ালেট ব্যালেন্স থেকে ৳${recoverNow.toLocaleString('en-BD')} কাটা হলো, Super Admin-এর নির্দেশে (বাকি ৳${remaining.toLocaleString('en-BD')})`
          : `অগ্রিম সমন্বয় — ওয়ালেট ব্যালেন্স থেকে ৳${recoverNow.toLocaleString('en-BD')} কাটা হলো, Super Admin-এর নির্দেশে (সম্পূর্ণ পরিশোধ)`,
      createdById: actorUserId,
      approvedById: actorUserId,
      source: MANUAL_ADVANCE_RECOVERY_SOURCE,
      sourceRef: `manual-recovery:${businessId}:${employeeId}:${crypto.randomUUID()}`,
    },
  })

  if (linked?.id) {
    await notifyUser({
      userId: linked.id,
      businessId,
      type: 'PAYROLL_ALERT',
      priority: 'NORMAL',
      title: 'অগ্রিম সমন্বয়',
      message:
        remaining > 0
          ? `আপনার ওয়ালেট থেকে ৳${recoverNow.toLocaleString('en-BD')} অগ্রিম কাটা হয়েছে। এখনো বাকি ৳${remaining.toLocaleString('en-BD')}।`
          : `আপনার ওয়ালেট থেকে ৳${recoverNow.toLocaleString('en-BD')} অগ্রিম কাটা হয়েছে। অগ্রিম সম্পূর্ণ পরিশোধ হয়েছে।`,
      actionUrl: '/portal/wallet',
    }).catch(() => {})
  }

  return { ok: true as const, entryId: entry.id, recovered: recoverNow, remaining }
}
