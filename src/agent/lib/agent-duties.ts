/**
 * Daily duty roster — keep in sync with worker/src/schedulers/duties.mjs
 */
export const DAILY_DUTIES = [
  { duty: 'salah_init', label: '🕌 সালাহ রিমাইন্ডার সেটআপ', time: '00:00' },
  { duty: 'cs_index_products', label: '🖼️ প্রোডাক্ট ভিজ্যুয়াল ইনডেক্স', time: '00:30' },
  { duty: 'cost_reconcile', label: '🧮 কস্ট রিকনসাইল', time: '08:15' },
  { duty: 'owner_briefing', label: '☀️ সকালের ব্রিফিং', time: '07:30' },
  { duty: 'morning_dispatch', label: '📤 স্টাফ টাস্ক ডিসপ্যাচ', time: '09:00' },
  { duty: 'content_engine_1', label: '📸 কন্টেন্ট পোস্ট #1', time: '10:00' },
  { duty: 'ads_monitor', label: '📢 অ্যাড মনিটর', time: '09:30' },
  { duty: 'token_health', label: '🔑 টোকেন হেলথ চেক', time: '09:30' },
  { duty: 'subscription_renewal', label: '🔄 সাবস্ক্রিপশন চেক', time: '10:00' },
  { duty: 'midday_checkin', label: '📊 স্টাফ মিড-ডে চেক', time: '13:30' },
  { duty: 'content_engine_2', label: '📸 কন্টেন্ট পোস্ট #2', time: '15:00' },
  { duty: 'personal_midday', label: '🤲 দুপুরের খোঁজখবর', time: '14:00' },
  { duty: 'staff_morale', label: '💚 স্টাফ উৎসাহ বার্তা', time: '13:00' },
  { duty: 'order_watch', label: '📦 অর্ডার মনিটর', time: '12:00' },
  { duty: 'content_engine_3', label: '📸 কন্টেন্ট পোস্ট #3', time: '19:00' },
  { duty: 'night_report', label: '🌙 রাতের রিপোর্ট', time: '21:00' },
  { duty: 'evening_proposal', label: '📝 আগামীকালের টাস্ক প্রস্তাব', time: '21:05' },
  { duty: 'personal_checkin', label: '🤲 সন্ধ্যার খোঁজখবর', time: '21:00' },
  { duty: 'daily_summary', label: '📋 দৈনিক সারসংক্ষেপ', time: '23:30' },
  { duty: 'weekly_review', label: '🗓️ সাপ্তাহিক রিভিউ (শুক্র)', time: '21:30', weeklyOnly: true as const },
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
  time: string | null
  createdAt: string
}

export type SalahDutyRow = {
  waqt: string
  label: string
  scheduledTime: string
  status: 'done' | 'pending' | 'missed'
  doneTime: string | null
  reminders: number
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
