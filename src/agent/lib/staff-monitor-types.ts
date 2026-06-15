/** Client-safe staff monitor types — no Prisma / server imports. */

export type MonitorWarning = {
  severity: 'critical' | 'warn'
  kind: string
  message: string
}

/** Maps duty key → worker job name for the retrigger API. */
export const DUTY_TO_JOB: Record<string, string> = {
  salah_init: 'salah-init',
  cs_index_products: 'cs-index-products',
  knowledge_build: 'knowledge-build',
  owner_briefing: 'owner-briefing',
  daily_strategist: 'daily-strategist',
  cost_reconcile: 'cost-reconcile',
  morning_dispatch: 'morning-staff-reminder',
  ads_monitor: 'ads-monitor',
  token_health: 'token-health',
  content_engine_1: 'content-engine-1',
  subscription_renewal: 'subscription-renewal',
  catchup_scan: 'catchup-scan',
  approval_tracker: 'approval-tracker',
  staff_presence: 'staff-presence',
  outcome_measure: 'outcome-measure',
  order_watch: 'order-watch',
  staff_morale: 'staff-morale',
  midday_checkin: 'midday-checkin',
  personal_midday: 'personal-midday',
  content_engine_2: 'content-engine-2',
  content_engine_3: 'content-engine-3',
  night_report: 'night-report',
  personal_checkin: 'personal-checkin',
  evening_proposal: 'evening-proposal',
  approval_chase: 'approval-escalation',
  daily_summary: 'daily-summary',
  weekly_review: 'weekly-review',
  weekly_reflection: 'weekly-reflection',
  customer_intel: 'customer-intel',
  marketing_weekly: 'marketing-weekly',
}

/** Agent capability categories for the capabilities reference section. */
export const AGENT_CAPABILITIES = [
  {
    category: 'ব্যবসা ও ERP',
    icon: '📊',
    items: [
      'সেলস সামারি ও ড্যাশবোর্ড',
      'অর্ডার ম্যানেজমেন্ট ও ইস্যু ডিটেক্ট',
      'ইনভেন্টরি স্ট্যাটাস ও রিঅর্ডার',
      'কাস্টমার সেগমেন্ট ও ইন্টেলিজেন্স',
      'প্রাইসিং ও রিটার্ন অ্যানালাইসিস',
      'এমপ্লয়ি ওভারভিউ ও অ্যাটেন্ডেন্স',
      'স্ট্র্যাটেজিক রিভিউ ও মার্কেটিং ইন্টেল',
    ],
  },
  {
    category: 'স্টাফ ম্যানেজমেন্ট',
    icon: '👥',
    items: [
      'টাস্ক প্রপোজাল ও ডিসপ্যাচ',
      'মিড-ডে চেক ও প্রগ্রেস ট্র্যাক',
      'প্রুফ ভেরিফিকেশন ও ফলোআপ',
      'অ্যানাউন্সমেন্ট ও কোচিং মেসেজ',
      'লোকেশন ট্র্যাকিং ও প্রেজেন্স',
      'ছুটি ম্যানেজমেন্ট',
      'পারফরম্যান্স রিভিউ ও মোরাল বুস্ট',
    ],
  },
  {
    category: 'ALMA Trading (Binance P2P)',
    icon: '💱',
    items: [
      'ট্রেডিং ড্যাশবোর্ড ও অ্যাকাউন্ট',
      'আজকের ট্রেড ও ডেইলি সামারি',
      'ভলিউম টার্গেট ও মার্চেন্ট প্রগ্রেস',
      'এমপ্লয়ি রিপোর্ট ও bKash সামারি',
      'ট্রেডিং স্টাফ টাস্ক ও ডিসপ্যাচ',
    ],
  },
  {
    category: 'ফাইন্যান্স',
    icon: '💰',
    items: [
      'এক্সপেন্স লগ (একক ও ব্যাচ)',
      'লেজার এন্ট্রি ও ব্যালান্স',
      'ফাইন্যান্সিয়াল হেলথ চেক',
      'ট্রানজ্যাকশন এডিট ও ডিলিট',
      'AI কস্ট ট্র্যাকিং ও বাজেট মনিটর',
    ],
  },
  {
    category: 'কন্টেন্ট ও মার্কেটিং',
    icon: '📸',
    items: [
      'অটো কন্টেন্ট পোস্ট (৩ স্লট/দিন)',
      'Facebook পোস্ট ও মেসেঞ্জার',
      'ইমেজ জেনারেশন (Nano)',
      'ভার্চুয়াল ট্রাই-অন',
      'ব্র্যান্ড অ্যাসেট ম্যানেজমেন্ট',
      'Ad ক্যাম্পেইন ও বাজেট কন্ট্রোল',
      'SEO অডিট ও কীওয়ার্ড রিসার্চ',
      'কম্পিটিটর ওয়াচলিস্ট',
    ],
  },
  {
    category: 'কাস্টমার সার্ভিস',
    icon: '💬',
    items: [
      'মেসেঞ্জার ইনবক্স স্ক্যান ও রিপ্লাই',
      'প্রোডাক্ট ম্যাচিং (ইমেজ/টেক্সট)',
      'অর্ডার ড্রাফট ক্রিয়েট',
      'হিউম্যান হ্যান্ডঅফ',
      'ফলোআপ রিকভারি',
    ],
  },
  {
    category: 'ওয়েবসাইট',
    icon: '🌐',
    items: [
      'প্রোডাক্ট পাবলিশ/আনপাবলিশ',
      'ফিচার্ড সেট ও ক্যাটালগ',
      'ওয়েব পেজ ফেচ ও হেলথ চেক',
    ],
  },
  {
    category: 'ব্যক্তিগত',
    icon: '🤲',
    items: [
      'সালাহ রিমাইন্ডার ও ট্র্যাকিং',
      'পার্সোনাল রিমাইন্ডার ও টু-ডু',
      'ফ্যামিলি কন্ট্যাক্ট ও কল',
      'আর্জেন্ট NTFY/Twilio অ্যালার্ট',
      'দুপুর ও সন্ধ্যার খোঁজখবর',
    ],
  },
  {
    category: 'ডায়াগনস্টিক ও AI',
    icon: '🔧',
    items: [
      'হেলথ স্ক্যান ও ইস্যু ডায়াগনোজ',
      'সোর্স কোড রিড ও সার্চ',
      'প্লেবুক ম্যানেজমেন্ট',
      'মেমোরি সেভ/সার্চ/আপডেট',
      'সেশন সামারাইজার',
      'নলেজ গ্রাফ বিল্ড',
      'আউটকাম মেজারমেন্ট',
    ],
  },
] as const

export type SchedulerHealth = {
  ackEscalationLastRun: string | null
  schedulersHeartbeatAt: string | null
  queueHeartbeatAt: string | null
}

export type StaffMonitorRow = {
  id: string
  staffId: string | null
  staffName: string | null
  businessId: string | null
  type: string
  content: string
  status: string
  telegramMessageId: string | null
  errorReason: string | null
  relatedTaskIds: unknown
  requiresAck: boolean
  acknowledgedAt: string | null
  createdAt: string
  sentAt: string | null
}

export type StaffSummary = {
  staffId: string
  staffName: string
  dispatched: number
  delivered: number
  failed: number
  tasksTotal: number
  tasksDone: number
  completionPct: number
  started: boolean
  lastActivityAt: string | null
}

export type AgentDutyRow = {
  id: string
  duty: string
  label: string
  dutyDate: string
  status: 'pending' | 'done' | 'failed' | 'missed' | 'skipped'
  detail: string | null
  ranAt: string | null
  time: string | null
  createdAt: string
}

export type SalahDutyRow = {
  waqt: string
  label: string
  scheduledTime: string
  status: 'pending' | 'done' | 'missed'
  doneTime: string | null
  reminders: number
}

export type ContinuousServiceHealth = {
  key: string
  label: string
  healthy: boolean
}

export type DutyHistoryDay = {
  date: string
  duties: AgentDutyRow[]
}

export type StaffMonitorData = {
  today: string
  feedDays: number
  isHistorical?: boolean
  historyDates?: string[]
  agentDuties: AgentDutyRow[]
  dutyHistory?: DutyHistoryDay[]
  salahDuties: SalahDutyRow[]
  continuousServices: ContinuousServiceHealth[]
  schedulerHealth: SchedulerHealth
  warnings: MonitorWarning[]
  unackedMessages: StaffMonitorRow[]
  feed: StaffMonitorRow[]
  historyFeed?: StaffMonitorRow[]
  failures: StaffMonitorRow[]
  staffSummaries: StaffSummary[]
  typeCounts: Record<string, number>
  mismatches: Array<{
    staffId: string
    staffName: string
    outboxId: string
    errorReason: string | null
    relatedTaskIds: string[]
  }>
  generatedAt: string
}
