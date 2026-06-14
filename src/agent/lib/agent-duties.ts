/**
 * Daily duty roster — keep in sync with worker/src/schedulers/duties.mjs
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
