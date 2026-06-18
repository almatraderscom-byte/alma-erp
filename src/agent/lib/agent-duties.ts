/**
 * Daily duty roster — keep in sync with worker/src/schedulers/duties.mjs
 * Every scheduled job in SCHEDULER_REGISTRY should map to either a DAILY_DUTY or CONTINUOUS_SERVICE.
 */
export const DAILY_DUTIES = [
  { duty: 'salah_init', label: '🕌 সালাহ রিমাইন্ডার সেটআপ', time: '00:00' },
  { duty: 'cs_index_products', label: '🖼️ প্রোডাক্ট ভিজ্যুয়াল ইনডেক্স', time: '00:30' },
  { duty: 'knowledge_build', label: '🧠 নলেজ গ্রাফ বিল্ড', time: '01:00' },
  { duty: 'owner_briefing', label: '☀️ সকালের ব্রিফিং', time: '07:30' },
  { duty: 'daily_strategist', label: '🎯 ডেইলি স্ট্র্যাটেজি পাস', time: '08:00' },
  { duty: 'cost_reconcile', label: '🧮 কস্ট রিকনসাইল', time: '08:15' },
  { duty: 'daily_cashflow', label: '💰 ডেইলি ক্যাশফ্লো', time: '08:30' },
  { duty: 'payment_reminders', label: '💳 পেমেন্ট রিমাইন্ডার', time: '12:00' },
  { duty: 'morning_dispatch', label: '📤 স্টাফ টাস্ক ডিসপ্যাচ', time: '09:00' },
  { duty: 'ads_monitor', label: '📢 অ্যাড মনিটর', time: '09:30' },
  { duty: 'ads_optimizer', label: '🎯 অ্যাড অপটিমাইজার', time: '09:45' },
  { duty: 'token_health', label: '🔑 টোকেন হেলথ চেক', time: '09:30' },
  { duty: 'content_engine_1', label: '📸 কন্টেন্ট পোস্ট #1', time: '10:00' },
  { duty: 'subscription_renewal', label: '🔄 সাবস্ক্রিপশন চেক', time: '10:00' },
  { duty: 'catchup_scan', label: '🔄 ক্যাচ-আপ মিসড ডিউটি', time: '10:00' },
  { duty: 'approval_tracker', label: '📋 অ্যাপ্রুভাল ট্র্যাকার', time: '10:00' },
  { duty: 'staff_presence', label: '👋 স্টাফ প্রেজেন্স নাজ', time: '11:00' },
  { duty: 'outcome_measure', label: '📈 আউটকাম মেজারমেন্ট', time: '11:00' },
  { duty: 'order_watch', label: '📦 অর্ডার মনিটর', time: '12:00' },
  { duty: 'staff_morale', label: '💚 স্টাফ উৎসাহ বার্তা', time: '13:00' },
  { duty: 'midday_checkin', label: '📊 স্টাফ মিড-ডে চেক', time: '13:30' },
  { duty: 'personal_midday', label: '🤲 দুপুরের খোঁজখবর', time: '14:00' },
  { duty: 'content_engine_2', label: '📸 কন্টেন্ট পোস্ট #2', time: '15:00' },
  { duty: 'content_engine_3', label: '📸 কন্টেন্ট পোস্ট #3', time: '19:00' },
  { duty: 'owner_task_intake', label: '🌙 Sir-কাজ সংগ্রহ', time: '20:30' },
  { duty: 'night_report', label: '🌙 রাতের রিপোর্ট', time: '21:00' },
  { duty: 'personal_checkin', label: '🤲 সন্ধ্যার খোঁজখবর', time: '21:00' },
  { duty: 'evening_proposal', label: '📝 আগামীকালের টাস্ক প্রস্তাব', time: '21:05' },
  { duty: 'approval_chase', label: '⚡ অ্যাপ্রুভাল চেজ', time: '22:30' },
  { duty: 'daily_summary', label: '📋 দৈনিক সারসংক্ষেপ', time: '23:30' },
  { duty: 'weekly_review', label: '🗓️ সাপ্তাহিক রিভিউ (শুক্র)', time: '21:30', weeklyOnly: true as const },
  { duty: 'weekly_reflection', label: '🪞 সাপ্তাহিক সেলফ-রিফ্লেকশন (শুক্র)', time: '22:00', weeklyOnly: true as const },
  { duty: 'customer_intel', label: '🔍 কাস্টমার ইন্টেলিজেন্স (শনি)', time: '10:00', saturdayOnly: true as const },
  { duty: 'marketing_weekly', label: '📈 সাপ্তাহিক মার্কেটিং রিপোর্ট (শনি)', time: '10:00', saturdayOnly: true as const },
] as const

export const CONTINUOUS_SERVICES = [
  { key: 'messenger_scan', label: 'মেসেঞ্জার স্ক্যান' },
  { key: 'salah_escalation', label: 'সালাহ এসকেলেশন' },
  { key: 'proof_timeout', label: 'প্রুফ টাইমআউট' },
  { key: 'reminder_ticker', label: 'রিমাইন্ডার' },
  { key: 'cs_services', label: 'CS সার্ভিস' },
  { key: 'ack_escalation', label: 'Unseen এসকেলেশন' },
  { key: 'lunch_watch', label: 'লাঞ্চ মনিটর' },
  { key: 'session_summarizer', label: 'সেশন সামারাইজ' },
  { key: 'cs_escalation', label: 'CS ড্রাফট এসকেলেশন' },
  { key: 'cs_followups', label: 'CS ফলোআপ' },
  { key: 'cs_messenger_poll', label: 'CS ইনবক্স পোল' },
  { key: 'budget_check', label: 'বাজেট চেক' },
  { key: 'balance_check', label: 'ব্যালান্স রিফ্রেশ' },
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

export function dayOfWeekDhaka(now = new Date()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dhaka',
    weekday: 'short',
  }).format(now)
}

export function isFridayDhaka(now = new Date()): boolean {
  return dayOfWeekDhaka(now) === 'Fri'
}

export function isSaturdayDhaka(now = new Date()): boolean {
  return dayOfWeekDhaka(now) === 'Sat'
}

export function dutiesForToday(now = new Date()) {
  const friday = isFridayDhaka(now)
  const saturday = isSaturdayDhaka(now)
  return DAILY_DUTIES.filter((d) => {
    if ('weeklyOnly' in d && d.weeklyOnly) return friday
    if ('saturdayOnly' in d && d.saturdayOnly) return saturday
    return true
  })
}

// ── Owner-facing categories (for the Control Center / Monitor toggle UI) ──
export type DutyCategory = 'staff' | 'sales' | 'finance' | 'marketing' | 'reports' | 'personal' | 'system'

/** Display order + labels for the category-grouped duty toggles. */
export const DUTY_CATEGORY_META: Array<{ key: DutyCategory; label: string; icon: string }> = [
  { key: 'staff', label: 'স্টাফ', icon: '👥' },
  { key: 'sales', label: 'সেলস ও কাস্টমার', icon: '📦' },
  { key: 'finance', label: 'ফিন্যান্স', icon: '💰' },
  { key: 'marketing', label: 'মার্কেটিং ও কন্টেন্ট', icon: '📣' },
  { key: 'reports', label: 'রিপোর্ট ও অ্যাপ্রুভাল', icon: '📊' },
  { key: 'personal', label: 'ব্যক্তিগত ও সালাহ', icon: '🤲' },
  { key: 'system', label: 'সিস্টেম ও নলেজ', icon: '⚙️' },
]

/** Each duty key → its owner-facing category. */
export const DUTY_CATEGORY: Record<string, DutyCategory> = {
  // Staff
  morning_dispatch: 'staff', staff_presence: 'staff', staff_morale: 'staff',
  midday_checkin: 'staff', evening_proposal: 'staff',
  // Sales & customers
  order_watch: 'sales', customer_intel: 'sales',
  // Finance
  cost_reconcile: 'finance', daily_cashflow: 'finance', payment_reminders: 'finance',
  subscription_renewal: 'finance',
  // Marketing & content
  ads_monitor: 'marketing', ads_optimizer: 'marketing', content_engine_1: 'marketing',
  content_engine_2: 'marketing', content_engine_3: 'marketing', marketing_weekly: 'marketing',
  // Reports & approvals
  owner_briefing: 'reports', daily_strategist: 'reports', owner_task_intake: 'reports',
  night_report: 'reports', daily_summary: 'reports', weekly_review: 'reports',
  weekly_reflection: 'reports', approval_tracker: 'reports', approval_chase: 'reports',
  outcome_measure: 'reports',
  // Personal & salah
  salah_init: 'personal', personal_midday: 'personal', personal_checkin: 'personal',
  // System & knowledge
  cs_index_products: 'system', knowledge_build: 'system', token_health: 'system',
  catchup_scan: 'system',
}

export function dutyCategory(dutyKey: string): DutyCategory {
  return DUTY_CATEGORY[dutyKey] ?? 'system'
}
