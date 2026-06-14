/**
 * The agent's recurring daily duties, in the order they should appear in the monitor.
 * Each maps a scheduler job.name → a display label. Only DAILY duties listed
 * (not every-minute tickers). Keep this the single source of truth for the UI.
 */
export const DAILY_DUTIES = [
  { duty: 'salah_init', label: '🕌 সালাহ রিমাইন্ডার সেটআপ' },
  { duty: 'owner_briefing', label: '☀️ সকালের ব্রিফিং' },
  { duty: 'morning_dispatch', label: '📤 স্টাফ টাস্ক ডিসপ্যাচ' },
  { duty: 'personal_midday', label: '🤲 দুপুরের খোঁজখবর' },
  { duty: 'midday_checkin', label: '📊 স্টাফ মিড-ডে চেক' },
  { duty: 'messenger_scan', label: '💬 মেসেঞ্জার স্ক্যান' },
  { duty: 'order_watch', label: '📦 অর্ডার মনিটর' },
  { duty: 'evening_proposal', label: '📝 আগামীকালের টাস্ক প্রস্তাব' },
  { duty: 'night_report', label: '🌙 রাতের রিপোর্ট' },
  { duty: 'personal_checkin', label: '🤲 সন্ধ্যার খোঁজখবর' },
]

export const JOB_TO_DUTY = {
  'salah-init': 'salah_init',
  'owner-briefing': 'owner_briefing',
  'morning-staff-reminder': 'morning_dispatch',
  'personal-midday': 'personal_midday',
  'midday-checkin': 'midday_checkin',
  'messenger-scan': 'messenger_scan',
  'order-watch': 'order_watch',
  'evening-proposal': 'evening_proposal',
  'night-report': 'night_report',
  'personal-checkin': 'personal_checkin',
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
