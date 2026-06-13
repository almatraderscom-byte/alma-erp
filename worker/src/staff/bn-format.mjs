/** Bengali numerals and Dhaka date/time labels for staff messages. */

const BN_DIGITS = { 0: '০', 1: '১', 2: '২', 3: '৩', 4: '৪', 5: '৫', 6: '৬', 7: '৭', 8: '৮', 9: '৯' }

const BN_MONTHS = [
  'জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
  'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর',
]

export function bnNum(n) {
  if (n == null || n === undefined) return '০'
  return String(Number(n) || 0).replace(/\d/g, (d) => BN_DIGITS[d] ?? d)
}

/** "১৩ জুন" from YYYY-MM-DD */
export function formatDhakaDateLabel(ymd) {
  const [y, m, d] = ymd.split('-').map(Number)
  return `${bnNum(d)} ${BN_MONTHS[m - 1] ?? m}`
}

export function formatDhakaTimeBn(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(now)
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '12'
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00'
  const dayPeriod = parts.find((p) => p.type === 'dayPeriod')?.value ?? ''
  const periodBn = /pm/i.test(dayPeriod) ? 'বিকাল' : 'সকাল'
  return `${periodBn} ${bnNum(hour)}:${bnNum(minute)}`
}
