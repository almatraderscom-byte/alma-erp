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
  ads_optimizer: 'ads-optimizer',
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
  owner_task_intake: 'owner-task-intake',
  personal_checkin: 'personal-checkin',
  evening_proposal: 'evening-proposal',
  approval_chase: 'approval-escalation',
  daily_summary: 'daily-summary',
  weekly_review: 'weekly-review',
  weekly_reflection: 'weekly-reflection',
  customer_intel: 'customer-intel',
  marketing_weekly: 'marketing-weekly',
}

/** Single capability item with a Bangla how-to command example. */
export type CapabilityItem = { name: string; command: string }

/** Agent capability categories for the capabilities reference section. */
export const AGENT_CAPABILITIES: ReadonlyArray<{
  category: string
  icon: string
  items: readonly CapabilityItem[]
}> = [
  {
    category: 'ব্যবসা ও ERP',
    icon: '📊',
    items: [
      { name: 'সেলস সামারি ও ড্যাশবোর্ড', command: '"আজকের সেল কত?" বা "বিজনেস সামারি দাও"' },
      { name: 'অর্ডার ম্যানেজমেন্ট ও ইস্যু ডিটেক্ট', command: '"আজকের অর্ডার দেখাও" বা "কোন অর্ডারে সমস্যা আছে?"' },
      { name: 'ইনভেন্টরি স্ট্যাটাস ও রিঅর্ডার', command: '"স্টক কি শেষ হচ্ছে?" বা "কোন প্রোডাক্ট রিঅর্ডার করতে হবে?"' },
      { name: 'কাস্টমার সেগমেন্ট ও ইন্টেলিজেন্স', command: '"VIP কাস্টমার লিস্ট দাও" বা "কাস্টমার অ্যানালাইসিস করো"' },
      { name: 'প্রাইসিং ও রিটার্ন অ্যানালাইসিস', command: '"রিটার্ন রেট কেমন?" বা "প্রাইসিং কম্পেয়ার করো"' },
      { name: 'এমপ্লয়ি ওভারভিউ ও অ্যাটেন্ডেন্স', command: '"আজকে কে কে এসেছে?" বা "স্টাফ অ্যাটেন্ডেন্স দাও"' },
      { name: 'স্ট্র্যাটেজিক রিভিউ ও মার্কেটিং ইন্টেল', command: '"বিজনেস স্ট্র্যাটেজি রিভিউ দাও" বা "মার্কেট ট্রেন্ড কি?"' },
    ],
  },
  {
    category: 'স্টাফ ম্যানেজমেন্ট',
    icon: '👥',
    items: [
      { name: 'টাস্ক প্রপোজাল ও ডিসপ্যাচ', command: '"শামীমকে এই কাজটা দাও" বা "আজকের টাস্ক লিস্ট পাঠাও"' },
      { name: 'মিড-ডে চেক ও প্রগ্রেস ট্র্যাক', command: '"স্টাফদের প্রগ্রেস কেমন?" বা "কে কি করেছে আজকে?"' },
      { name: 'প্রুফ ভেরিফিকেশন ও ফলোআপ', command: '"প্রুফ চেক করো" বা "কার ফলোআপ বাকি?"' },
      { name: 'অ্যানাউন্সমেন্ট ও কোচিং মেসেজ', command: '"সবাইকে জানাও যে..." বা "শামীমকে কোচিং মেসেজ দাও"' },
      { name: 'লোকেশন ট্র্যাকিং ও প্রেজেন্স', command: '"সবাই কোথায় আছে?" বা "লোকেশন আপডেট দাও"' },
      { name: 'ছুটি ম্যানেজমেন্ট', command: '"রহিমের ছুটি approve করো" বা "কে কে ছুটিতে আছে?"' },
      { name: 'পারফরম্যান্স রিভিউ ও মোরাল বুস্ট', command: '"স্টাফদের পারফরম্যান্স কেমন?" বা "মোরাল বুস্ট মেসেজ দাও"' },
    ],
  },
  {
    category: 'ALMA Trading (Binance P2P)',
    icon: '💱',
    items: [
      { name: 'ট্রেডিং ড্যাশবোর্ড ও অ্যাকাউন্ট', command: '"ট্রেডিং ড্যাশবোর্ড দাও" বা "অ্যাকাউন্ট ব্যালান্স কত?"' },
      { name: 'আজকের ট্রেড ও ডেইলি সামারি', command: '"আজকের ট্রেড কেমন হলো?" বা "P2P সামারি দাও"' },
      { name: 'ভলিউম টার্গেট ও মার্চেন্ট প্রগ্রেস', command: '"ভলিউম টার্গেট কতটুকু হলো?" বা "মার্চেন্ট লেভেল কোথায়?"' },
      { name: 'এমপ্লয়ি রিপোর্ট ও bKash সামারি', command: '"bKash কতটুকু ইউজ হয়েছে?" বা "ট্রেডিং স্টাফ রিপোর্ট"' },
      { name: 'ট্রেডিং স্টাফ টাস্ক ও ডিসপ্যাচ', command: '"ট্রেডিং টিমকে টাস্ক দাও" বা "ট্রেডিং স্টাফ কি করছে?"' },
    ],
  },
  {
    category: 'ফাইন্যান্স',
    icon: '💰',
    items: [
      { name: 'এক্সপেন্স লগ (একক ও ব্যাচ)', command: '"৫০০ টাকা রিকশা খরচ লগ করো" বা "আজকের সব খরচ এন্ট্রি দাও"' },
      { name: 'লেজার এন্ট্রি ও ব্যালান্স', command: '"লেজার ব্যালান্স কত?" বা "ক্যাশ ইন হ্যান্ড কত?"' },
      { name: 'ফাইন্যান্সিয়াল হেলথ চেক', command: '"ফাইন্যান্স কেমন চলছে?" বা "ফাইন্যান্সিয়াল রিপোর্ট দাও"' },
      { name: 'ট্রানজ্যাকশন এডিট ও ডিলিট', command: '"শেষ ট্রানজ্যাকশনটা ভুল, ঠিক করো" বা "এই এন্ট্রি ডিলিট করো"' },
      { name: 'AI কস্ট ট্র্যাকিং ও বাজেট মনিটর', command: '"AI খরচ কত হলো?" বা "এই মাসে বাজেট কেমন?"' },
    ],
  },
  {
    category: 'কন্টেন্ট ও মার্কেটিং',
    icon: '📸',
    items: [
      { name: 'অটো কন্টেন্ট পোস্ট (৩ স্লট/দিন)', command: '"আজকের পোস্ট রেডি করো" বা "কন্টেন্ট ক্যালেন্ডার দাও"' },
      { name: 'Facebook পোস্ট ও মেসেঞ্জার', command: '"এই ছবি দিয়ে ফেসবুকে পোস্ট করো" বা "পেজের রিচ কেমন?"' },
      { name: 'ইমেজ জেনারেশন (Nano)', command: '"এই প্রোডাক্টের ছবি বানাও" বা "সোশ্যাল মিডিয়া ব্যানার তৈরি করো"' },
      { name: 'VEO 3 ভিডিও/রিলস জেনারেশন', command: '"এই প্রোডাক্টের রিলস বানাও" বা "প্রমো ভিডিও তৈরি করো"' },
      { name: 'ভার্চুয়াল ট্রাই-অন', command: '"এই জামাটা মডেলের গায়ে দেখাও" বা "ট্রাই-অন ইমেজ বানাও"' },
      { name: 'ব্র্যান্ড অ্যাসেট ম্যানেজমেন্ট', command: '"ব্র্যান্ড গাইডলাইন দাও" বা "লোগো ভ্যারিয়েশন দেখাও"' },
      { name: 'Ad ক্যাম্পেইন ও বাজেট কন্ট্রোল', command: '"Ad ক্যাম্পেইন কেমন চলছে?" বা "Ad বাজেট বাড়াও/কমাও"' },
      { name: 'SEO অডিট ও কীওয়ার্ড রিসার্চ', command: '"সাইটের SEO কেমন?" বা "কীওয়ার্ড রিসার্চ করো"' },
      { name: 'কম্পিটিটর ওয়াচলিস্ট', command: '"কম্পিটিটররা কি করছে?" বা "মার্কেট পজিশন কোথায়?"' },
    ],
  },
  {
    category: 'কাস্টমার সার্ভিস',
    icon: '💬',
    items: [
      { name: 'মেসেঞ্জার ইনবক্স স্ক্যান ও রিপ্লাই', command: '"মেসেঞ্জারে কি মেসেজ এসেছে?" বা "ইনবক্স চেক করো"' },
      { name: 'প্রোডাক্ট ম্যাচিং (ইমেজ/টেক্সট)', command: '"এই ছবির মতো প্রোডাক্ট আছে?" বা "লাল শাড়ি দেখাও"' },
      { name: 'অর্ডার ড্রাফট ক্রিয়েট', command: '"এই কাস্টমারের অর্ডার তৈরি করো" বা "কুইক অর্ডার বানাও"' },
      { name: 'হিউম্যান হ্যান্ডঅফ', command: '"এটা আমাকে ট্রান্সফার করো" বা "হিউম্যান এজেন্ট দরকার"' },
      { name: 'ফলোআপ রিকভারি', command: '"ড্রপ হওয়া কাস্টমারদের ফলোআপ করো" বা "রিকভারি মেসেজ পাঠাও"' },
    ],
  },
  {
    category: 'ওয়েবসাইট',
    icon: '🌐',
    items: [
      { name: 'প্রোডাক্ট পাবলিশ/আনপাবলিশ', command: '"এই প্রোডাক্ট পাবলিশ করো" বা "এটা আনপাবলিশ করো"' },
      { name: 'ফিচার্ড সেট ও ক্যাটালগ', command: '"ফিচার্ড প্রোডাক্ট আপডেট করো" বা "নতুন ক্যাটালগ সেট করো"' },
      { name: 'ওয়েব পেজ ফেচ ও হেলথ চেক', command: '"সাইট ঠিকমতো চলছে?" বা "হোমপেজ চেক করো"' },
    ],
  },
  {
    category: 'ব্যক্তিগত',
    icon: '🤲',
    items: [
      { name: 'সালাহ রিমাইন্ডার ও ট্র্যাকিং', command: '"পরের নামাজ কখন?" বা "আজকে কয় ওয়াক্ত পড়েছি?"' },
      { name: 'পার্সোনাল রিমাইন্ডার ও টু-ডু', command: '"৫টায় মনে করিও" বা "আমার টু-ডু লিস্ট দাও"' },
      { name: 'ফ্যামিলি কন্ট্যাক্ট ও কল', command: '"আম্মুকে কল করো" বা "ফ্যামিলিতে মেসেজ পাঠাও"' },
      { name: 'আর্জেন্ট NTFY/Twilio অ্যালার্ট', command: '"আর্জেন্ট নোটিফিকেশন পাঠাও" বা "ক্রিটিক্যাল অ্যালার্ট দাও"' },
      { name: 'দুপুর ও সন্ধ্যার খোঁজখবর', command: '"আজকে কেমন গেলো?" বা "সন্ধ্যার আপডেট দাও"' },
    ],
  },
  {
    category: 'ডায়াগনস্টিক ও AI',
    icon: '🔧',
    items: [
      { name: 'হেলথ স্ক্যান ও ইস্যু ডায়াগনোজ', command: '"সিস্টেম ঠিক আছে?" বা "হেলথ চেক করো"' },
      { name: 'সোর্স কোড রিড ও সার্চ', command: '"এই ফাইলটা দেখাও" বা "কোডে সার্চ করো"' },
      { name: 'প্লেবুক ম্যানেজমেন্ট', command: '"প্লেবুক রুলস দেখাও" বা "নতুন রুল অ্যাড করো"' },
      { name: 'মেমোরি সেভ/সার্চ/আপডেট', command: '"এটা মনে রাখো" বা "আমি কি বলেছিলাম সেদিন?"' },
      { name: 'সেশন সামারাইজার', command: '"গত চ্যাটের সামারি দাও" বা "আজকের সব চ্যাট সামারি করো"' },
      { name: 'নলেজ গ্রাফ বিল্ড', command: '"নলেজ আপডেট করো" বা "কি কি জানো আমার সম্পর্কে?"' },
      { name: 'আউটকাম মেজারমেন্ট', command: '"এজেন্ট কতটুকু কাজ করেছে?" বা "আউটকাম রিপোর্ট দাও"' },
      { name: 'অটো-ফিক্স পাইপলাইন (Cursor Cloud Agent)', command: '"ইস্যু অটো-ফিক্স করো" বা "বাগ ডিটেক্ট করে ঠিক করো"' },
      { name: 'প্লেবুক সেলফ-লার্নিং', command: '"প্লেবুক থেকে শিখো" বা "নতুন প্যাটার্ন খোঁজো"' },
    ],
  },
]

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
  /** True only once the staff has actually checked in today (attendance_records).
   *  Before check-in the monitor must not count/show them as active — task time
   *  starts at check-in, not at dispatch. */
  checkedIn?: boolean
  /** True while the staff is in active driving mode — no task dispatch or
   *  follow-up until they resume. Shown as a badge so the owner sees it. */
  driving?: boolean
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

export type ActiveReminderRow = {
  id: string
  title: string
  body: string | null
  dueAt: string
  tier: number
  status: string
  snoozedUntil: string | null
  isRecurring: boolean
}

export type ActiveTodoRow = {
  id: string
  title: string
  detail: string | null
  priority: string
  dueHint: string | null
  createdAt: string
}

export type PendingApprovalRow = {
  id: string
  type: string
  summary: string
  status: string
  businessId: string
  createdAt: string
  staffName: string | null
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
  activeReminders?: ActiveReminderRow[]
  activeTodos?: ActiveTodoRow[]
  pendingApprovals?: PendingApprovalRow[]
  dutyTimeOverrides?: Record<string, string>
  geoStatus?: GeoStaffStatus[]
  productivityAlerts?: ProductivityAlert[]
  geoFenceMonitoringEnabled?: boolean
  dutyEnabled?: Record<string, boolean>
  generatedAt: string
}

export type GeoStaffStatus = {
  staffId: string
  staffName: string
  status: 'in_zone' | 'outside' | 'stale' | 'no_data'
  distanceM?: number
  lastUpdate?: string
  mapsLink?: string
}

export type ProductivityAlert = {
  staffId: string
  staffName: string
  type: 'proof_timeout' | 'slow_task' | 'idle' | 'proof_sent'
  message: string
  at: string
}
