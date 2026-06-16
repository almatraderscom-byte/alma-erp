// Mock data for the public ALMA Agent design demo.
// No backend, no auth — purely for showcasing the refined UI.

export interface DemoFile {
  name: string
  kind: 'image' | 'pdf'
  src?: string
}

export interface DemoTool {
  name: string
  label: string
  icon: string
  done: boolean
  success?: boolean
}

export interface DemoDelegation {
  id: string
  roleLabel: string
  icon: string
  task: string
  done: boolean
  success?: boolean
  summary?: string
  tools?: string[]
}

export interface DemoMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  files?: DemoFile[]
  thinking?: string
  thinkingSeconds?: number
  tools?: DemoTool[]
  delegations?: DemoDelegation[]
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
}

export interface DemoConversation {
  id: string
  title: string
  preview: string
  dateLabel: string
  projectId: string | null
  live?: boolean
  messages: DemoMessage[]
}

export interface DemoProject {
  id: string
  name: string
  badge?: { label: string; tone: 'trading' | 'lifestyle' }
}

export const DEMO_PROJECTS: DemoProject[] = [
  { id: 'p-trading', name: 'ALMA Trading', badge: { label: 'Trading', tone: 'trading' } },
  { id: 'p-lifestyle', name: 'ALMA Lifestyle', badge: { label: 'Lifestyle', tone: 'lifestyle' } },
  { id: 'p-ops', name: 'Operations' },
]

export const DEMO_SUGGESTIONS = [
  { text: 'আজকের অর্ডার সারাংশ দাও', icon: '📦' },
  { text: 'স্টক কম আছে কি চেক করো', icon: '📊' },
  { text: 'একটা Facebook পোস্ট ড্রাফট করো', icon: '✍️' },
  { text: 'স্টাফদের আজকের টাস্ক রিভিউ করো', icon: '👥' },
]

export const DEMO_CONVERSATIONS: DemoConversation[] = [
  {
    id: 'c-1',
    title: 'আজকের অর্ডার ও স্টক রিভিউ',
    preview: 'আজ মোট ৪২টি অর্ডার, ৩টি পণ্যের স্টক কম…',
    dateLabel: '17 Jun',
    projectId: 'p-trading',
    live: true,
    messages: [
      {
        id: 'm-1',
        role: 'user',
        text: 'আজকের অর্ডারগুলোর একটা সারাংশ দাও আর কোন পণ্যের স্টক কম থাকলে জানাও।',
      },
      {
        id: 'm-2',
        role: 'assistant',
        thinking:
          'প্রথমে আজকের অর্ডার ডেটা টানতে হবে, তারপর প্রতিটি SKU-এর স্টক লেভেল মিলিয়ে দেখতে হবে কোনগুলো reorder threshold-এর নিচে। শেষে একটা পরিষ্কার সারাংশ বানাবো।',
        thinkingSeconds: 4,
        tools: [
          { name: 'orders', label: 'অর্ডার ডেটা', icon: '📦', done: true, success: true },
          { name: 'inventory', label: 'স্টক চেক', icon: '📊', done: true, success: true },
        ],
        delegations: [
          {
            id: 'd-1',
            roleLabel: 'বিশ্লেষক',
            icon: '📊',
            task: 'স্টক লেভেল বনাম reorder threshold বিশ্লেষণ',
            done: true,
            success: true,
            summary:
              '৩টি SKU reorder threshold-এর নিচে: Premium Basmati 5kg (১২ ইউনিট), Olive Oil 1L (৮ ইউনিট), Saffron 5g (৪ ইউনিট)। আজকের বিক্রির গতি অনুযায়ী Saffron ২ দিনের মধ্যে শেষ হবে।',
            tools: ['inventory', 'sales-velocity'],
          },
        ],
        text:
          '## আজকের সারাংশ\n\n**অর্ডার:** মোট **৪২টি** অর্ডার, যার মধ্যে ৩৮টি সম্পন্ন, ৪টি প্রসেসিং-এ।\n\n**মোট বিক্রি:** ৳ ১,৮৪,৫০০\n\n### ⚠️ স্টক কম\n| পণ্য | বর্তমান স্টক | অবস্থা |\n| --- | --- | --- |\n| Premium Basmati 5kg | ১২ | কম |\n| Olive Oil 1L | ৮ | কম |\n| Saffron 5g | ৪ | জরুরি |\n\nSaffron আজকের বিক্রির গতিতে **~২ দিনে** শেষ হবে — এখনই reorder করার পরামর্শ দিচ্ছি। চাইলে আমি সাপ্লায়ারকে একটা reorder ড্রাফট বানিয়ে দিতে পারি।',
        tokensIn: 1840,
        tokensOut: 412,
        costUsd: 0.0231,
      },
    ],
  },
  {
    id: 'c-2',
    title: 'Eid ক্যাম্পেইন — Facebook পোস্ট',
    preview: 'তিনটি ভিন্ন টোনে পোস্ট ড্রাফট করা হয়েছে…',
    dateLabel: '16 Jun',
    projectId: 'p-lifestyle',
    messages: [
      {
        id: 'm-3',
        role: 'user',
        text: 'আসছে Eid উপলক্ষে আমাদের premium gift hamper-এর জন্য একটা Facebook পোস্ট লেখো।',
      },
      {
        id: 'm-4',
        role: 'assistant',
        text:
          '🌙 **এই ঈদে ভালোবাসা হোক আরও বিশেষ** 🌙\n\nALMA Lifestyle-এর হাতে বাছাই করা **Premium Eid Hamper** — প্রিয়জনের মুখে হাসি ফোটানোর নিখুঁত উপহার।\n\n✨ খাঁটি মধু, প্রিমিয়াম খেজুর, হ্যান্ডক্রাফটেড চকলেট ও আরও অনেক কিছু\n🎁 এলিগ্যান্ট গিফট প্যাকেজিং — আনবক্সিং হবে স্মরণীয়\n🚚 সারাদেশে ফ্রি ডেলিভারি\n\nএবারের ঈদে দিন এমন এক উপহার, যা মনে থাকবে অনেকদিন।\n\n📩 অর্ডার করতে ইনবক্স করুন আজই।\n\n#ALMALifestyle #EidGift #PremiumHamper',
        tokensIn: 920,
        tokensOut: 286,
        costUsd: 0.0142,
      },
    ],
  },
  {
    id: 'c-3',
    title: 'সাপ্লায়ার পেমেন্ট হিসাব',
    preview: 'জুন মাসের বকেয়া পেমেন্ট ৳ ৩,২০,০০০…',
    dateLabel: '15 Jun',
    projectId: 'p-ops',
    messages: [
      {
        id: 'm-5',
        role: 'user',
        text: 'এই মাসে সাপ্লায়ারদের কত টাকা বকেয়া আছে?',
      },
      {
        id: 'm-6',
        role: 'assistant',
        text:
          'জুন মাসে মোট বকেয়া **৳ ৩,২০,০০০**:\n\n- Rahman Traders — ৳ ১,৪০,০০০ (due ২০ জুন)\n- Karim Imports — ৳ ১,১০,০০০ (due ২৫ জুন)\n- Hilal Foods — ৳ ৭০,০০০ (due ৩০ জুন)\n\nRahman Traders-এর পেমেন্ট সবার আগে — আর ৩ দিন বাকি।',
        tokensIn: 640,
        tokensOut: 198,
        costUsd: 0.0098,
      },
    ],
  },
  {
    id: 'c-4',
    title: 'নতুন স্টাফ অনবোর্ডিং চেকলিস্ট',
    preview: 'একটা সম্পূর্ণ অনবোর্ডিং চেকলিস্ট তৈরি…',
    dateLabel: '14 Jun',
    projectId: 'p-ops',
    messages: [],
  },
]

// ── Streaming demo script (the "live" reply users can trigger) ───────────────
export const STREAMING_REPLY = `দারুণ প্রশ্ন! চলুন দেখে নিই।

## এই সপ্তাহের পারফরম্যান্স

এই সপ্তাহে বিক্রি গত সপ্তাহের তুলনায় **১৮% বেড়েছে**। সবচেয়ে ভালো পারফর্ম করেছে Premium Basmati ও Eid Hamper ক্যাটেগরি।

মূল পয়েন্টগুলো:

- নতুন কাস্টমার এসেছে **৮৬ জন**
- রিপিট অর্ডার রেট **৪২%** — খুব স্বাস্থ্যকর
- গড় অর্ডার ভ্যালু বেড়ে **৳ ৪,৩৯০**

পরের সপ্তাহের জন্য আমি Eid Hamper-এর স্টক আরও বাড়ানোর পরামর্শ দিচ্ছি, কারণ চাহিদা দ্রুত বাড়ছে।`

export const STREAMING_THINKING = `ব্যবহারকারী সাপ্তাহিক পারফরম্যান্স জানতে চাইছেন। আমার উচিত বিক্রির তুলনা, কাস্টমার মেট্রিক, আর একটা actionable পরামর্শ দেওয়া। ডেটা টেনে একটা পরিষ্কার সারাংশ বানাই।`

// ── Monitor dashboard mock ───────────────────────────────────────────────────
export interface StaffActivity {
  id: string
  name: string
  role: string
  status: 'active' | 'idle' | 'offline'
  task: string
  lastSeen: string
  tasksToday: number
}

export const DEMO_STAFF: StaffActivity[] = [
  { id: 's-1', name: 'রাকিব হাসান', role: 'সেলস', status: 'active', task: 'অর্ডার #1042 প্যাকিং', lastSeen: 'এখন', tasksToday: 14 },
  { id: 's-2', name: 'সুমাইয়া আক্তার', role: 'কাস্টমার কেয়ার', status: 'active', task: 'ইনবক্স রিপ্লাই দিচ্ছে', lastSeen: 'এখন', tasksToday: 31 },
  { id: 's-3', name: 'তানভীর আহমেদ', role: 'ইনভেন্টরি', status: 'idle', task: 'স্টক কাউন্ট বিরতি', lastSeen: '৬ মিনিট আগে', tasksToday: 9 },
  { id: 's-4', name: 'নুসরাত জাহান', role: 'মার্কেটিং', status: 'active', task: 'Eid ক্যাম্পেইন রিভিউ', lastSeen: 'এখন', tasksToday: 7 },
  { id: 's-5', name: 'ইমরান খান', role: 'ডেলিভারি', status: 'offline', task: 'শিফট শেষ', lastSeen: '২ ঘণ্টা আগে', tasksToday: 22 },
]

export interface MonitorStat {
  label: string
  value: string
  delta: string
  positive: boolean
  icon: string
}

export const DEMO_MONITOR_STATS: MonitorStat[] = [
  { label: 'আজকের অর্ডার', value: '৪২', delta: '+১২%', positive: true, icon: '📦' },
  { label: 'আজকের বিক্রি', value: '৳ ১.৮৪L', delta: '+১৮%', positive: true, icon: '💰' },
  { label: 'সক্রিয় স্টাফ', value: '৩ / ৫', delta: 'লাইভ', positive: true, icon: '👥' },
  { label: 'পেন্ডিং টাস্ক', value: '৭', delta: '-৩', positive: true, icon: '✅' },
]

export const DEMO_ACTIVITY_FEED = [
  { id: 'a-1', icon: '📦', text: 'রাকিব অর্ডার #1042 সম্পন্ন করেছে', time: '২ মিনিট আগে', tone: 'success' as const },
  { id: 'a-2', icon: '💬', text: 'সুমাইয়া ৫টি কাস্টমার মেসেজের উত্তর দিয়েছে', time: '৮ মিনিট আগে', tone: 'info' as const },
  { id: 'a-3', icon: '⚠️', text: 'Saffron 5g স্টক জরুরি লেভেলে নেমেছে', time: '১৫ মিনিট আগে', tone: 'warning' as const },
  { id: 'a-4', icon: '🎁', text: 'নুসরাত Eid ক্যাম্পেইন ড্রাফট জমা দিয়েছে', time: '৩২ মিনিট আগে', tone: 'info' as const },
  { id: 'a-5', icon: '🚚', text: 'ইমরান ৮টি ডেলিভারি সম্পন্ন করে শিফট শেষ করেছে', time: '২ ঘণ্টা আগে', tone: 'success' as const },
]

// ── Costs dashboard mock ─────────────────────────────────────────────────────
export interface CostStat {
  label: string
  value: string
  sub: string
  icon: string
}

export const DEMO_COST_STATS: CostStat[] = [
  { label: 'এই মাসের খরচ', value: '$42.18', sub: 'গত মাস $51.40', icon: '💵' },
  { label: 'মোট টোকেন', value: '৮.৪M', sub: 'ইন ৬.১M · আউট ২.৩M', icon: '🔤' },
  { label: 'মোট কথোপকথন', value: '১,২৪৮', sub: 'এই মাসে +১৮৬', icon: '💬' },
  { label: 'গড়/চ্যাট', value: '$0.034', sub: 'খুব সাশ্রয়ী', icon: '📉' },
]

export interface DailyCost {
  day: string
  cost: number
}

export const DEMO_DAILY_COSTS: DailyCost[] = [
  { day: 'সোম', cost: 4.2 },
  { day: 'মঙ্গল', cost: 6.8 },
  { day: 'বুধ', cost: 5.1 },
  { day: 'বৃহঃ', cost: 7.9 },
  { day: 'শুক্র', cost: 6.2 },
  { day: 'শনি', cost: 8.4 },
  { day: 'রবি', cost: 3.6 },
]

export interface ModelUsage {
  model: string
  share: number
  cost: string
  tone: string
}

export const DEMO_MODEL_USAGE: ModelUsage[] = [
  { model: 'Claude Sonnet 4.6', share: 62, cost: '$26.14', tone: '#E07A5F' },
  { model: 'Claude Haiku', share: 28, cost: '$11.81', tone: '#81B29A' },
  { model: 'GPT-5 mini', share: 10, cost: '$4.23', tone: '#D4A84B' },
]
