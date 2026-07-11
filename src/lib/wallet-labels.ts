/**
 * Bangla display labels for staff wallet transactions.
 *
 * The ledger's `note` column is free text (historically English); staff-facing
 * surfaces must never fall back to a raw enum like "SALARY ACCRUAL". This map
 * gives every entry type — and the attendance fine/refund sources — a clear
 * Bangla label, plus a helper that builds a one-line Bangla description.
 */

export const WALLET_TYPE_LABEL_BN: Record<string, string> = {
  SALARY_ACCRUAL: 'মাসিক বেতন',
  ADVANCE: 'অ্যাডভান্স নেওয়া',
  ADVANCE_RECOVERY: 'অ্যাডভান্স ফেরত (বেতন থেকে কাটা)',
  WITHDRAWAL: 'টাকা উত্তোলন',
  ADJUSTMENT: 'সমন্বয়',
  COMMISSION: 'কমিশন',
  EID_BONUS: 'ঈদ বোনাস',
  PERFORMANCE_BONUS: 'পারফরম্যান্স বোনাস',
  MEAL_DEDUCTION: 'মিল-কাটা (লাঞ্চ)',
  OVERTIME: 'ওভারটাইম',
  REIMBURSEMENT: 'খরচ ফেরত (রিইমবার্সমেন্ট)',
  PENALTY: 'জরিমানা',
  SALARY_PAYMENT: 'বেতন প্রদান',
}

/** Attendance fines/refunds post as PENALTY/ADJUSTMENT; `source` tells them apart. */
export const WALLET_SOURCE_LABEL_BN: Record<string, string> = {
  attendance_late_penalty: 'দেরিতে চেক-ইনের জরিমানা',
  attendance_early_leave_penalty: 'আগে বের হওয়ার জরিমানা',
  attendance_no_checkout_fine: 'চেক-আউট না করার জরিমানা',
  attendance_late_penalty_reversal: 'জরিমানা ফেরত — আপিল মঞ্জুর',
  attendance_exception_refund: 'জরিমানা ফেরত — অনুমতি মঞ্জুর',
  attendance_reset_reversal: 'জরিমানা ফেরত — চেক-ইন সংশোধন',
  monthly_accrual: 'মাসিক বেতন',
}

const BN_DIGITS: Record<string, string> = {
  '0': '০', '1': '১', '2': '২', '3': '৩', '4': '৪',
  '5': '৫', '6': '৬', '7': '৭', '8': '৮', '9': '৯',
}

export function toBnDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, d => BN_DIGITS[d] ?? d)
}

const BN_MONTHS = [
  'জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
  'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর',
]

/** "2026-06" → "জুন ২০২৬" */
export function periodYmBn(periodYm: string | null | undefined): string | null {
  if (!periodYm) return null
  const [y, m] = periodYm.split('-').map(Number)
  if (!y || !m || m < 1 || m > 12) return null
  return `${BN_MONTHS[m - 1]} ${toBnDigits(y)}`
}

/** ISO date/Date → "৯ জুলাই ২০২৬" (Asia/Dhaka calendar date) */
export function dateBn(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(d)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value || 0)
  return `${toBnDigits(get('day'))} ${BN_MONTHS[get('month') - 1]} ${toBnDigits(get('year'))}`
}

export type WalletEntryLabelInput = {
  type: string
  source?: string | null
  periodYm?: string | null
  note?: string | null
}

/** Primary Bangla label for a wallet transaction (never a raw enum). */
export function walletEntryLabelBn(entry: WalletEntryLabelInput): string {
  const bySource = entry.source ? WALLET_SOURCE_LABEL_BN[entry.source] : undefined
  if (bySource) {
    const period = entry.type === 'SALARY_ACCRUAL' ? periodYmBn(entry.periodYm) : null
    return period ? `${bySource} — ${period}` : bySource
  }
  const byType = WALLET_TYPE_LABEL_BN[entry.type]
  if (byType) {
    const period = entry.type === 'SALARY_ACCRUAL' ? periodYmBn(entry.periodYm) : null
    return period ? `${byType} — ${period}` : byType
  }
  return entry.type.replace(/_/g, ' ')
}
