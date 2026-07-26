/**
 * Phone console — the settings REGISTRY, shared by the server and the browser.
 *
 * Step 2 of the console is the first one that writes, so the shape of a setting is defined
 * once, here, and everything else is derived from it: the screen renders from this list, the
 * API validates against this list, and the gateway is handed exactly the subset marked as
 * its own. A setting that is not in this file cannot be changed from the console at all —
 * which is the point. The old PBX let anything be typed into anything.
 *
 * Three properties earn their place:
 *
 * - `scope` says WHO reads the value. `app` is read by Vercel while a call is being set up
 *   and takes effect on the very next call. `gateway` is read by the SIP gateway on the VPS,
 *   which pulls this over HTTP once a minute — so a gateway-scoped change takes up to a
 *   minute, and the screen says so rather than pretending it was instant. `both` is read by
 *   each of them independently (the blocklist, deliberately: the gateway refuses a blocked
 *   caller BEFORE answering, so blocking still works when Vercel is unreachable).
 *
 * - `envName` records the variable that used to control it. It is still the fallback when no
 *   KV row exists, so this change cannot break a running system: with an empty settings
 *   table every value is exactly what it is today.
 *
 * - `locked` is not here. Locked values live in LOCKED_AUDIO below and have no editor at
 *   all, because CLAUDE.md hard rule #1 freezes the call-audio tuning the owner approved on
 *   2026-07-26. Showing them read-only is deliberate: the owner should be able to SEE the
 *   numbers that make the voice sound right without being able to nudge them.
 *
 * Client-safe: no Prisma, no `node:` imports, no secrets.
 */

export type SettingScope = 'app' | 'gateway' | 'both'

export type SettingKind =
  | 'phones'    // comma-separated BD phone numbers, in ring order
  | 'number'
  | 'enum'
  | 'hours'     // "10-21", Dhaka, may wrap midnight
  | 'dates'     // comma-separated YYYY-MM-DD
  | 'weekdays'  // comma-separated sun..sat, rendered as toggles
  | 'ranges'    // "2027-02-18..2027-03-19=10-16", one per line
  | 'text'

export type SettingGroup = 'forward' | 'hours' | 'blocklist' | 'limits' | 'hold' | 'outbound'

export type SettingDef = {
  key: string
  group: SettingGroup
  label: string
  /** Why this exists and what breaks if it is wrong — the owner is not an engineer. */
  help: string
  kind: SettingKind
  scope: SettingScope
  envName?: string
  /** Used when neither a KV row nor the env var is set. Must equal today's code default. */
  fallback: string
  min?: number
  max?: number
  options?: ReadonlyArray<{ value: string; label: string }>
  /** Shown under the field when the value is at or near a limit that has burned us before. */
  warnAbove?: number
  warnNote?: string
  placeholder?: string
}

export const SETTING_GROUPS: ReadonlyArray<{ id: SettingGroup; title: string; blurb: string }> = [
  { id: 'forward', title: 'ফরওয়ার্ড ও ট্রান্সফার', blurb: 'মানুষ চাইলে কল কোথায় যাবে, কতবার রিং হবে।' },
  { id: 'hours', title: 'অফিস সময় ও ছুটি', blurb: 'কখন টিমকে রিং করা হবে, কখন AI বার্তা রাখবে।' },
  { id: 'blocklist', title: 'ব্লকলিস্ট', blurb: 'যেসব নম্বরের কল ধরাই হবে না।' },
  { id: 'limits', title: 'সীমা ও ক্যাপ', blurb: 'একসাথে কয়টা কল, দিনে কয়টা, ভয়েসমেইল কত লম্বা।' },
  { id: 'hold', title: 'হোল্ড অডিও', blurb: 'মানুষ খোঁজার সময় কলদাতা কী শোনে।' },
  { id: 'outbound', title: 'আউটবাউন্ড নিয়ম', blurb: 'আমাদের দিক থেকে কোন নম্বরে কল যেতে পারবে।' },
]

/**
 * Every setting the console may change. Order inside a group is the order on screen.
 *
 * The three keys without a `phone_` prefix (`office_hours_dhaka`, `blocked_callers`,
 * `inbound_transfer_mode`) already exist and are already read by the live inbound route —
 * they are adopted here, not recreated. Renaming them would have silently reset three
 * settings the owner has already tuned.
 */
export const PHONE_SETTINGS: ReadonlyArray<SettingDef> = [
  // ── forward & transfer ─────────────────────────────────────────────────────
  {
    key: 'phone_forward_support',
    group: 'forward',
    label: 'সাপোর্ট লাইন (রিং গ্রুপ)',
    help: 'সাধারণ গ্রাহক মানুষ চাইলে এই নম্বরগুলোতে রিং যায়, কমা দিয়ে যত খুশি — উপরে যেটা, আগে সেটা বাজে। খালি রাখলে ট্রান্সফার হবে না, AI নিজেই বার্তা নেবে। মোবাইল নম্বরের বদলে স্টাফের এক্সটেনশন (যেমন 1002) দিলে কলটা তার ব্রাউজার ফোনে যাবে — আর তখনই পর্দায় গ্রাহকের নাম, কত অর্ডার, কত বাকি সব দেখাবে, যেটা মোবাইলে কখনো দেখানো যায় না।',
    kind: 'phones',
    scope: 'app',
    envName: 'SIP_FORWARD_SUPPORT',
    fallback: '',
    placeholder: '1002, 01868996666',
  },
  {
    key: 'phone_forward_boss',
    group: 'forward',
    label: 'বসের নম্বর',
    help: 'শুধু যে কলদাতার সত্যিই বসকে দরকার, তার জন্য। সাধারণ অর্ডারের প্রশ্নে যেন কখনো আপনার ফোন না বাজে — নিয়মটা AI-এর প্রম্পটেই আছে।',
    kind: 'phones',
    scope: 'app',
    envName: 'SIP_FORWARD_BOSS',
    fallback: '',
    placeholder: '01779640373',
  },
  {
    key: 'phone_inbound_answer_mode',
    group: 'forward',
    label: 'কল এলে আগে কে ধরবে',
    help: '“আগে টিম” মানে অচেনা গ্রাহকের কল এলে আগে আপনাদের ফোন বাজবে (হোল্ড সুর সহ), কেউ না ধরলে তখন AI ধরবে। চেনা নম্বর — আপনার নিজের নম্বর, স্টাফের নম্বর, বা এজেন্টের কন্টাক্টে সেভ করা কেউ — সবসময় সোজা AI-ই পাবে, অপেক্ষা ছাড়া। কারো ব্রাউজার ফোন খোলা না থাকলে অপেক্ষাও হবে না, সাথে সাথে AI ধরবে।',
    kind: 'enum',
    scope: 'app',
    fallback: 'ai_first',
    options: [
      { value: 'ai_first', label: 'সবসময় AI আগে' },
      { value: 'staff_first', label: 'অচেনা হলে আগে টিম' },
    ],
  },
  {
    key: 'phone_inbound_ring_secs',
    group: 'forward',
    label: 'টিম কত সেকেন্ড বাজবে',
    help: 'এই সময়টা কলদাতা আপনাদের হোল্ড সুর শুনবে। এর মধ্যে কেউ না ধরলে AI কলটা নিয়ে নেবে এবং অপেক্ষার জন্য দুঃখ প্রকাশ করবে।',
    kind: 'number',
    scope: 'app',
    fallback: '30',
    min: 10,
    max: 60,
  },
  {
    key: 'phone_inbound_ring_group',
    group: 'forward',
    label: 'আগে কাদের ফোন বাজবে',
    help: 'খালি রাখাই ভালো — তাহলে যাদের ব্রাউজার ফোন সেই মুহূর্তে খোলা আছে, সবার বাজবে। নির্দিষ্ট করতে চাইলে এক্সটেনশন (1002) বা মোবাইল নম্বর কমা দিয়ে লিখুন।',
    kind: 'phones',
    scope: 'app',
    fallback: '',
    placeholder: '(খোলা থাকা সব ব্রাউজার ফোন)',
  },
  {
    key: 'inbound_transfer_mode',
    group: 'forward',
    label: 'ট্রান্সফারের ধরন',
    help: '“সরাসরি” মানে চাইলেই লাইন যুক্ত করে দেয়। “আগে জিজ্ঞেস” মানে যুক্ত না করে নাম-প্রয়োজন লিখে নেয় আর সাথে সাথে আপনাকে পুশ পাঠায়। অফিস সময়ের বাইরে এমনিতেই “আগে জিজ্ঞেস” চলে।',
    kind: 'enum',
    scope: 'app',
    fallback: 'direct',
    options: [
      { value: 'direct', label: 'সরাসরি যুক্ত করো' },
      { value: 'ask_first', label: 'আগে জিজ্ঞেস করো' },
    ],
  },
  {
    key: 'phone_ring_rounds',
    group: 'forward',
    label: 'রিং রাউন্ড',
    help: 'পুরো গ্রুপ ঘুরে কেউ না ধরলে আরেকবার ঘোরা হবে কি না। এক পাশ যথেষ্ট নয় — মানুষ হাতের কাজ নামাতে গিয়ে প্রথম রিং মিস করে। সব রাউন্ড শেষে কলদাতা AI-এর কাছেই ফেরত যায়, লাইন কাটে না।',
    kind: 'number',
    scope: 'gateway',
    envName: 'SIP_TRANSFER_ROUNDS',
    fallback: '2',
    min: 1,
    max: 4,
  },
  {
    key: 'phone_ring_member_timeout',
    group: 'forward',
    label: 'প্রতি নম্বরে রিং (সেকেন্ড)',
    help: 'গ্রুপের একজনের ফোন কত সেকেন্ড বাজবে, তারপর পরের জন। খুব কম দিলে কেউ ধরার সময়ই পাবে না; খুব বেশি দিলে কলদাতা হোল্ডে বসে থাকে।',
    kind: 'number',
    scope: 'gateway',
    envName: 'SIP_TRANSFER_RING_TIMEOUT',
    fallback: '30',
    min: 10,
    max: 60,
  },

  // ── office hours ───────────────────────────────────────────────────────────
  {
    key: 'office_hours_dhaka',
    group: 'hours',
    label: 'অফিস সময় (ঢাকা)',
    help: 'যেমন 10-21 মানে সকাল ১০টা থেকে রাত ৯টা। এর বাইরে AI কল ধরবেই — কলদাতা কখনো মরা লাইন পাবে না — কিন্তু ফাঁকা ডেস্কে রিং না করে বার্তা রেখে দেবে।',
    kind: 'hours',
    scope: 'app',
    envName: 'SIP_OFFICE_HOURS',
    fallback: '10-21',
    placeholder: '10-21',
  },
  {
    key: 'phone_holidays',
    group: 'hours',
    label: 'ছুটির দিন',
    help: 'তারিখগুলোতে সারাদিন অফিস-বন্ধের নিয়ম চলবে — AI ধরবে, ভদ্রভাবে বলবে আজ বন্ধ, বার্তা নিয়ে রাখবে। কমা দিয়ে YYYY-MM-DD ফরম্যাটে দিন। পুরনো তারিখ নিজে থেকে মুছে যাবে না, ক্ষতিও করে না।',
    kind: 'dates',
    scope: 'app',
    fallback: '',
    placeholder: '2026-08-15, 2026-09-05',
  },

  {
    key: 'phone_weekly_offdays',
    group: 'hours',
    label: 'সাপ্তাহিক বন্ধ',
    help: 'যেসব বারে সারাদিন অফিস-বন্ধের নিয়ম চলবে। কিছু না বাছলে সপ্তাহের সাতদিনই অফিস সময় অনুযায়ী চলবে।',
    kind: 'weekdays',
    scope: 'app',
    fallback: '',
  },
  {
    key: 'phone_special_hours',
    group: 'hours',
    label: 'বিশেষ সময় (রমজান, মৌসুম)',
    help: 'নির্দিষ্ট তারিখের মধ্যে অন্য অফিস সময়। প্রতি লাইনে একটা: 2027-02-18..2027-03-19=10-16। এই তারিখগুলোতে উপরের সাধারণ সময়ের বদলে এটাই চলবে; সাপ্তাহিক বন্ধ ও ছুটির দিন তবুও আগে বসে।',
    kind: 'ranges',
    scope: 'app',
    fallback: '',
    placeholder: '2027-02-18..2027-03-19=10-16',
  },

  // ── blocklist ──────────────────────────────────────────────────────────────
  {
    key: 'blocked_callers',
    group: 'blocklist',
    label: 'ব্লক করা নম্বর',
    help: 'এই নম্বরগুলোর কল ধরাই হবে না, তাই এক পয়সাও খরচ হবে না। শেষ ৯ সংখ্যা মিলিয়ে দেখা হয় — 01…, +880…, 880… যেভাবেই আসুক ধরা পড়বে। আপনার নিজের নম্বর কখনো ব্লক হবে না।',
    kind: 'phones',
    scope: 'both',
    envName: 'SIP_BLOCKLIST',
    fallback: '',
    placeholder: '01700000000, 01800000000',
  },

  // ── limits ─────────────────────────────────────────────────────────────────
  {
    key: 'phone_max_concurrent',
    group: 'limits',
    label: 'একসাথে সর্বোচ্চ কল',
    help: 'ট্রাঙ্কের সীমা ২টা চ্যানেল, তাই এখানে ২-ই ঠিক। এর বেশি দিলে গেটওয়ে এমন কল ছাড়ার চেষ্টা করবে যেটা প্রোভাইডার নিতেই পারে না — আর সেটা দেখতে “প্রোভাইডারের দোষ”-এর মতো লাগে। মনে রাখবেন, একটা ট্রান্সফার নিজেই দুইটা লেগ খায়।',
    kind: 'number',
    scope: 'gateway',
    envName: 'SIP_MAX_CONCURRENT_CALLS',
    fallback: '2',
    min: 1,
    max: 4,
    warnAbove: 2,
    warnNote: 'ট্রাঙ্কের সীমা ২ — এর বেশি দিলে অতিরিক্ত কল প্রোভাইডারের কাছে গিয়ে ব্যর্থ হবে।',
  },
  {
    key: 'phone_daily_call_cap',
    group: 'limits',
    label: 'দিনে সর্বোচ্চ আউটবাউন্ড কল',
    help: 'AI নিজে থেকে দিনে কয়টা কল করতে পারবে। শুধু যেগুলো সত্যিই লাইনে পৌঁছেছে সেগুলোই গোনা হয়; ব্যর্থ চেষ্টার জন্য আলাদা ছাদ আছে, তাই লাইন নষ্ট থাকলে সারাদিন ডায়াল করতে থাকবে না।',
    kind: 'number',
    scope: 'app',
    envName: 'VOICE_CALL_DAILY_CAP',
    fallback: '10',
    min: 1,
    max: 100,
  },
  {
    key: 'phone_outbound_ring_timeout',
    group: 'limits',
    label: 'আউটবাউন্ড রিং (সেকেন্ড)',
    help: 'আমরা কাউকে কল করলে তার ফোন কত সেকেন্ড বাজবে। ৩০ সেকেন্ডে ছিল বলে আপনি ফোন ধরার আগেই কল কেটে অপারেটরের “ব্যস্ত” ঘোষণা বাজছিল — তাই ৪৫।',
    kind: 'number',
    scope: 'gateway',
    envName: 'SIP_RING_TIMEOUT',
    fallback: '45',
    min: 20,
    max: 90,
  },
  {
    key: 'phone_voicemail_max_secs',
    group: 'limits',
    label: 'ভয়েসমেইলের দৈর্ঘ্য (সেকেন্ড)',
    help: 'AI কথা বলতে না পারলে কলদাতা কত সেকেন্ড পর্যন্ত বার্তা রাখতে পারবে।',
    kind: 'number',
    scope: 'gateway',
    envName: 'SIP_VOICEMAIL_MAX_SECS',
    fallback: '120',
    min: 30,
    max: 300,
  },

  // ── hold audio ─────────────────────────────────────────────────────────────
  {
    key: 'phone_moh_class',
    group: 'hold',
    label: 'হোল্ড অডিও ক্লাস',
    help: 'মানুষ খোঁজার সময় কোন সুর/বার্তা বাজবে। খালি রাখলে Asterisk-এর নিজের ডিফল্ট। নিচের আপলোড এই নামটাই ব্যবহার করে — হাতে বদলানোর দরকার নেই।',
    kind: 'text',
    scope: 'gateway',
    envName: 'SIP_MOH_CLASS',
    fallback: 'alma-hold',
    placeholder: 'alma-hold',
  },

  // ── outbound rules ─────────────────────────────────────────────────────────
  {
    key: 'phone_dest_policy',
    group: 'outbound',
    label: 'কোথায় কল যেতে পারবে',
    help: 'আমাদের লাইন থেকে কোন ধরনের নম্বরে কল যাওয়া বৈধ। আন্তর্জাতিক কল কোনো অবস্থাতেই নয় — চুরি যাওয়া একটা পাসওয়ার্ড দিয়ে বিদেশে কল করে বিল তোলা টোল-ফ্রড-এর সবচেয়ে সাধারণ রূপ।',
    kind: 'enum',
    scope: 'gateway',
    fallback: 'bd_all',
    options: [
      { value: 'bd_all', label: 'দেশের মোবাইল ও ল্যান্ডলাইন' },
      { value: 'bd_mobile', label: 'শুধু মোবাইল' },
      { value: 'internal_only', label: 'শুধু ভেতরের এক্সটেনশন' },
    ],
  },
  {
    key: 'phone_outbound_strip',
    group: 'outbound',
    label: 'সামনের যে অংশ কেটে যাবে',
    help: 'ডায়াল করার আগে নম্বরের শুরু থেকে এই অংশটা বাদ যাবে। খালি রাখাই স্বাভাবিক — আমাদের একটাই ট্রাঙ্ক, তাই কিছু কাটার দরকার নেই। বদলানোর আগে নিচের “পরীক্ষা” দিয়ে দেখে নিন আসলে কোন নম্বরে যাচ্ছে।',
    kind: 'text',
    scope: 'gateway',
    fallback: '',
    placeholder: '(খালি)',
  },
  {
    key: 'phone_outbound_prefix',
    group: 'outbound',
    label: 'সামনে যে অংশ যোগ হবে',
    help: 'কাটার পর নম্বরের শুরুতে এটা যোগ হবে। খালি রাখাই স্বাভাবিক। কিছু বসানোর আগে অবশ্যই “পরীক্ষা” দিয়ে দেখুন — ভুল প্রিফিক্স মানে প্রতিটা আউটবাউন্ড কল ভুল নম্বরে যাওয়া।',
    kind: 'text',
    scope: 'gateway',
    fallback: '',
    placeholder: '(খালি)',
  },
]

export function settingsInGroup(group: SettingGroup): ReadonlyArray<SettingDef> {
  return PHONE_SETTINGS.filter((s) => s.group === group)
}

export function findSetting(key: string): SettingDef | undefined {
  return PHONE_SETTINGS.find((s) => s.key === key)
}

/**
 * The call-audio tuning, shown and never editable.
 *
 * The owner listened to a live call on 2026-07-26 and called the voice perfect. Every one of
 * these is a CODE DEFAULT with deliberately no env override, so the tuning lives in git and
 * cannot be changed quietly over SSH — and it does not get a text box here either. They are
 * on the screen because "why does it sound right" deserves an answer that is not `ssh`.
 */
export const LOCKED_AUDIO: ReadonlyArray<{ label: string; value: string; why: string }> = [
  { label: 'ভয়েস', value: 'Charon (পুরুষ)', why: 'আপনার অনুমোদিত কণ্ঠ।' },
  { label: 'জিটার কুশন', value: '১২ ফ্রেম', why: 'শুরুর কুশন — এখান থেকেই দেরি বা কাঁপুনি ঠিক হয়।' },
  { label: 'কুশন বৃদ্ধি', value: '৪ ফ্রেম', why: 'সত্যিকারের শুকিয়ে যাওয়ায় কতটা বাড়বে।' },
  { label: 'সর্বোচ্চ কুশন', value: '৩৫ ফ্রেম', why: 'ছাদ — এর বেশি হলে উত্তর দেরিতে আসে।' },
  { label: 'বাক্য-শেষ সীমা', value: '৬০ মিলিসেকেন্ড', why: 'বাক্যের শেষকে দোষ হিসেবে গোনা হয় না — এটাই সেই পার্থক্যকারী।' },
  { label: 'কিউ উঁচু/নিচু', value: '৫০০ / ৫০ ফ্রেম', why: 'জমে গেলে কতটা ছেঁটে ফেলা হবে।' },
  { label: 'বার্জ-ইন ফেড', value: '২ ফ্রেম', why: 'আপনি কথা বললে AI কত দ্রুত থামে।' },
  { label: 'কথা শেষ বোঝার সময়', value: '৫০০ মিলিসেকেন্ড', why: 'চুপ থাকলে কতক্ষণে ধরে নেবে আপনার বলা শেষ।' },
]

// ── shapes the API returns ───────────────────────────────────────────────────

export type SettingView = {
  key: string
  value: string
  /** Where the effective value came from, so a screen never implies a KV row that is absent. */
  source: 'kv' | 'env' | 'default'
  updatedAt: string | null
}

export type SettingsPayload = {
  ok: true
  settings: SettingView[]
  /** Last time the gateway pulled its config — proof a gateway change actually landed. */
  gatewayPulledAt: string | null
  gatewayReachable: boolean
}

export type HistoryRow = {
  id: string
  key: string
  label: string
  from: string
  to: string
  actor: string
  at: string
  /** False once a later change to the same key supersedes it — reverting then is misleading. */
  revertable: boolean
}

export type HoldAudioState = {
  configured: boolean
  /** The MOH class Asterisk currently has loaded, as Asterisk itself reports it. */
  liveClass: string | null
  files: Array<{ name: string; seconds: number | null; bytes: number }>
  /** Live calls right now — a swap unloads the module, which cuts anyone on hold. */
  busy: boolean
  error: string | null
}

export type ProviderState = {
  /** True once a credential is stored. The password itself is never returned, ever. */
  stored: boolean
  username: string | null
  updatedAt: string | null
  lastCheckAt: string | null
  lastCheckOk: boolean | null
  lastError: string | null
  registrations: Array<{
    ip: string | null
    userAgent: string | null
    expiresIn: number | null
    at: string | null
  }>
}
