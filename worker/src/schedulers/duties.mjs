/**
 * The agent's recurring daily duties, in the order they should appear in the monitor.
 * Each maps a scheduler job.name → a display label. Keep in sync with src/agent/lib/agent-duties.ts
 */

export const DAILY_DUTIES = [
  { duty: 'salah_init', label: '🕌 সালাহ রিমাইন্ডার সেটআপ', job: 'salah-init' },
  { duty: 'cs_index_products', label: '🖼️ প্রোডাক্ট ভিজ্যুয়াল ইনডেক্স', job: 'cs-index-products' },
  { duty: 'cost_reconcile', label: '🧮 কস্ট রিকনসাইল', job: 'cost-reconcile' },
  { duty: 'owner_briefing', label: '☀️ সকালের ব্রিফিং', job: 'owner-briefing' },
  { duty: 'morning_dispatch', label: '📤 স্টাফ টাস্ক ডিসপ্যাচ', job: 'morning-staff-reminder' },
  { duty: 'ads_monitor', label: '📢 অ্যাড মনিটর', job: 'ads-monitor' },
  { duty: 'token_health', label: '🔑 টোকেন হেলথ চেক', job: 'token-health' },
  { duty: 'subscription_renewal', label: '🔄 সাবস্ক্রিপশন চেক', job: 'subscription-renewal' },
  { duty: 'midday_checkin', label: '📊 স্টাফ মিড-ডে চেক', job: 'midday-checkin' },
  { duty: 'personal_midday', label: '🤲 দুপুরের খোঁজখবর', job: 'personal-midday' },
  { duty: 'staff_morale', label: '💚 স্টাফ উৎসাহ বার্তা', job: 'staff-morale' },
  { duty: 'order_watch', label: '📦 অর্ডার মনিটর', job: 'order-watch' },
  { duty: 'night_report', label: '🌙 রাতের রিপোর্ট', job: 'night-report' },
  { duty: 'evening_proposal', label: '📝 আগামীকালের টাস্ক প্রস্তাব', job: 'evening-proposal' },
  { duty: 'personal_checkin', label: '🤲 সন্ধ্যার খোঁজখবর', job: 'personal-checkin' },
  { duty: 'daily_summary', label: '📋 দৈনিক সারসংক্ষেপ', job: 'daily-summary' },
  { duty: 'weekly_review', label: '🗓️ সাপ্তাহিক রিভিউ (শুক্র)', job: 'weekly-review', weeklyOnly: true },
]

/** Continuous background services — health line in monitor, not a daily checklist. */
export const CONTINUOUS_SERVICES = [
  { key: 'messenger_scan', label: 'মেসেঞ্জার স্ক্যান' },
  { key: 'salah_escalation', label: 'সালাহ এসকেলেশন' },
  { key: 'proof_timeout', label: 'প্রুফ টাইমআউট' },
  { key: 'reminder_ticker', label: 'রিমাইন্ডার' },
  { key: 'cs_services', label: 'CS সার্ভিস' },
]

export const JOB_TO_DUTY = Object.fromEntries(
  DAILY_DUTIES.map((d) => [d.job, d.duty]),
)

export function isFridayDhaka(date = new Date()) {
  const dow = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dhaka',
    weekday: 'short',
  }).format(date)
  return dow === 'Fri'
}

/** Duties expected today (excludes weekly-only rows except on Friday). */
export function dutiesForToday(date = new Date()) {
  const friday = isFridayDhaka(date)
  return DAILY_DUTIES.filter((d) => !d.weeklyOnly || friday)
}

/**
 * Catch-up policy (Dhaka minutes-of-day):
 *  - scheduledAfterMin: normal window start — don't catch up before this.
 *  - catchUpUntilMin: too late to run safely — mark missed + alert.
 *  - critical: owner alert on miss.
 */
export const DUTY_CATCHUP = {
  morning_dispatch: { scheduledAfterMin: 9 * 60, catchUpUntilMin: 14 * 60, critical: true },
  owner_briefing: { scheduledAfterMin: 7 * 60 + 30, catchUpUntilMin: 12 * 60, critical: true },
  evening_proposal: { scheduledAfterMin: 21 * 60 + 5, catchUpUntilMin: 23 * 60 + 30, critical: true },
  night_report: { scheduledAfterMin: 21 * 60, catchUpUntilMin: 23 * 60 + 59, critical: false },
  order_watch: { scheduledAfterMin: 12 * 60, catchUpUntilMin: 20 * 60, critical: false },
}
