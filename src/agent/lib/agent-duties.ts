/**
 * Daily duty roster — keep in sync with worker/src/schedulers/duties.mjs
 */
export const DAILY_DUTIES = [
  { duty: 'salah_init', label: '🕌 সালাহ রিমাইন্ডার সেটআপ' },
  { duty: 'cs_index_products', label: '🖼️ প্রোডাক্ট ভিজ্যুয়াল ইনডেক্স' },
  { duty: 'cost_reconcile', label: '🧮 কস্ট রিকনসাইল' },
  { duty: 'owner_briefing', label: '☀️ সকালের ব্রিফিং' },
  { duty: 'morning_dispatch', label: '📤 স্টাফ টাস্ক ডিসপ্যাচ' },
  { duty: 'ads_monitor', label: '📢 অ্যাড মনিটর' },
  { duty: 'token_health', label: '🔑 টোকেন হেলথ চেক' },
  { duty: 'subscription_renewal', label: '🔄 সাবস্ক্রিপশন চেক' },
  { duty: 'midday_checkin', label: '📊 স্টাফ মিড-ডে চেক' },
  { duty: 'personal_midday', label: '🤲 দুপুরের খোঁজখবর' },
  { duty: 'staff_morale', label: '💚 স্টাফ উৎসাহ বার্তা' },
  { duty: 'order_watch', label: '📦 অর্ডার মনিটর' },
  { duty: 'night_report', label: '🌙 রাতের রিপোর্ট' },
  { duty: 'evening_proposal', label: '📝 আগামীকালের টাস্ক প্রস্তাব' },
  { duty: 'personal_checkin', label: '🤲 সন্ধ্যার খোঁজখবর' },
  { duty: 'daily_summary', label: '📋 দৈনিক সারসংক্ষেপ' },
  { duty: 'weekly_review', label: '🗓️ সাপ্তাহিক রিভিউ (শুক্র)', weeklyOnly: true as const },
] as const

export const CONTINUOUS_SERVICES = [
  { key: 'messenger_scan', label: 'মেসেঞ্জার স্ক্যান' },
  { key: 'salah_escalation', label: 'সালাহ এসকেলেশন' },
  { key: 'proof_timeout', label: 'প্রুফ টাইমআউট' },
  { key: 'reminder_ticker', label: 'রিমাইন্ডার' },
  { key: 'cs_services', label: 'CS সার্ভিস' },
] as const

export type AgentDutyStatus = 'pending' | 'done' | 'failed' | 'skipped' | 'missed'

export type AgentDutyRow = {
  id: string
  duty: string
  label: string
  dutyDate: string
  status: AgentDutyStatus
  detail: string | null
  ranAt: string | null
  createdAt: string
}

export type ContinuousServiceHealth = {
  key: string
  label: string
  healthy: boolean
}

export function isFridayDhaka(now = new Date()): boolean {
  const dow = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dhaka',
    weekday: 'short',
  }).format(now)
  return dow === 'Fri'
}

export function dutiesForToday(now = new Date()) {
  const friday = isFridayDhaka(now)
  return DAILY_DUTIES.filter((d) => !('weeklyOnly' in d && d.weeklyOnly) || friday)
}
