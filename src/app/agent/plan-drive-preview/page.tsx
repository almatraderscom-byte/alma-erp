'use client'

/**
 * /agent/plan-drive-preview — a STATIC showcase of the Plan-Drive "Live Desk"
 * (Phase C) for owner review on the Vercel preview. It feeds hand-built mock data
 * straight into <PlanDriveTimeline>, so the full UI renders without any real
 * autodrive plans, without the kill-switch, and without touching the database.
 *
 * This is a demo surface only — the buttons toast instead of hitting the action
 * route. Nothing here runs in production behaviour; it exists purely so the owner
 * can SEE every state (decision / approval / driving + step ladders) at a glance.
 */
import toast, { Toaster } from 'react-hot-toast'
import {
  PlanDriveTimeline,
  type PlanDrivePanelData,
} from '@/agent/components/monitor/PlanDriveTimeline'

function minutesFromNow(min: number): string {
  return new Date(Date.now() + min * 60_000).toISOString()
}

const MOCK: PlanDrivePanelData = {
  enabled: true,
  activeCount: 2,
  needsDecisionCount: 1,
  dailyCapTaka: 500,
  perPlanCapTaka: 150,
  drives: [
    /* ── 1. NEEDS DECISION — cost cap hit, all owner controls visible ───────── */
    {
      planId: 'demo-decision',
      goal: 'নতুন ঈদ কালেকশনের ১০টি প্রোডাক্ট ওয়েবসাইটে আপলোড',
      conversationId: 'demo-conv-1',
      phase: 'needs-decision',
      doneCount: 6,
      totalCount: 9,
      currentLine: 'খরচের সীমা ছুঁয়েছে — এগোতে আপনার সিদ্ধান্ত দরকার',
      waitingReason: 'প্ল্যানের খরচ সীমা ছুঁয়েছে (152/150 টাকা)। এগোতে অনুমতি দিন।',
      nextTickAt: null,
      lastDrivenAt: minutesFromNow(-12),
      attemptCount: 1,
      maxAttempts: 5,
      costTaka: 152,
      steps: [
        { id: 's1', action: 'প্রোডাক্ট ছবিগুলোর ব্যাকগ্রাউন্ড পরিষ্কার করা', status: 'done', detail: '১০টি ছবি প্রসেস হয়েছে' },
        { id: 's2', action: 'প্রতিটি প্রোডাক্টের বাংলা বিবরণ লেখা', status: 'done' },
        { id: 's3', action: 'দাম ও সাইজ চার্ট যোগ করা', status: 'done' },
        { id: 's4', action: 'SEO কিওয়ার্ড বসানো', status: 'done' },
        { id: 's5', action: 'প্রথম ৬টি প্রোডাক্ট আপলোড', status: 'done' },
        { id: 's6', action: 'ক্যাটাগরি ট্যাগ ঠিক করা', status: 'done' },
        { id: 's7', action: 'বাকি ৪টি প্রোডাক্ট আপলোড', status: 'failed', detail: 'খরচের বাজেট শেষ' },
        { id: 's8', action: 'হোমপেজে ফিচার্ড হিসেবে দেখানো', status: 'pending' },
        { id: 's9', action: 'ফেসবুকে পোস্ট তৈরি করা', status: 'pending' },
      ],
    },
    /* ── 2. WAITING APPROVAL — a step is paused on the owner's nod ───────────── */
    {
      planId: 'demo-approval',
      goal: 'বকেয়া পেমেন্টের জন্য ৮ জন কাস্টমারকে রিমাইন্ডার পাঠানো',
      conversationId: 'demo-conv-2',
      phase: 'waiting-approval',
      doneCount: 3,
      totalCount: 5,
      currentLine: '"SMS পাঠানো" ধাপের জন্য আপনার অনুমোদন দরকার',
      waitingReason: 'এই ধাপে ৮ জন কাস্টমারকে SMS যাবে — পাঠানোর আগে আপনার অনুমোদন দরকার।',
      nextTickAt: null,
      lastDrivenAt: minutesFromNow(-4),
      attemptCount: 0,
      maxAttempts: 5,
      costTaka: 47,
      steps: [
        { id: 'a1', action: 'বকেয়া আছে এমন কাস্টমার খুঁজে বের করা', status: 'done', detail: '৮ জন পাওয়া গেছে' },
        { id: 'a2', action: 'প্রতিজনের বকেয়া পরিমাণ হিসাব করা', status: 'done' },
        { id: 'a3', action: 'বাংলায় ভদ্র রিমাইন্ডার মেসেজ তৈরি করা', status: 'done' },
        { id: 'a4', action: '৮ জনকে SMS পাঠানো', status: 'running' },
        { id: 'a5', action: 'কারা পেমেন্ট করল তা ট্র্যাক করা', status: 'pending' },
      ],
    },
    /* ── 3. DRIVING — actively working, live shimmer step ────────────────────── */
    {
      planId: 'demo-driving-1',
      goal: 'গত মাসের বিক্রির রিপোর্ট তৈরি ও বিশ্লেষণ',
      conversationId: 'demo-conv-3',
      phase: 'driving',
      doneCount: 2,
      totalCount: 6,
      currentLine: 'বিক্রির ডেটা একত্র করছি ও ট্রেন্ড বের করছি…',
      nextTickAt: minutesFromNow(3),
      lastDrivenAt: minutesFromNow(-1),
      attemptCount: 0,
      maxAttempts: 5,
      costTaka: 23,
      steps: [
        { id: 'd1', action: 'গত মাসের সব অর্ডার লোড করা', status: 'done', detail: '৩১৪টি অর্ডার' },
        { id: 'd2', action: 'মোট বিক্রি ও মুনাফা হিসাব করা', status: 'done' },
        { id: 'd3', action: 'সবচেয়ে বেশি বিক্রি হওয়া প্রোডাক্ট বের করা', status: 'running' },
        { id: 'd4', action: 'কাস্টমার সেগমেন্ট বিশ্লেষণ', status: 'pending' },
        { id: 'd5', action: 'আগের মাসের সাথে তুলনা', status: 'pending' },
        { id: 'd6', action: 'রিপোর্ট তৈরি করে আপনাকে পাঠানো', status: 'pending' },
      ],
    },
    /* ── 4. DRIVING — early stage, mostly pending ───────────────────────────── */
    {
      planId: 'demo-driving-2',
      goal: 'কম স্টকের প্রোডাক্টগুলোর রিঅর্ডার প্ল্যান বানানো',
      conversationId: 'demo-conv-4',
      phase: 'driving',
      doneCount: 1,
      totalCount: 4,
      currentLine: 'স্টক লেভেল যাচাই করছি…',
      nextTickAt: minutesFromNow(18),
      lastDrivenAt: minutesFromNow(-2),
      attemptCount: 1,
      maxAttempts: 5,
      costTaka: 9,
      steps: [
        { id: 'r1', action: 'কম স্টকের প্রোডাক্ট খুঁজে বের করা', status: 'done', detail: '১২টি প্রোডাক্ট' },
        { id: 'r2', action: 'বিক্রির গতি দেখে কত লাগবে হিসাব করা', status: 'running' },
        { id: 'r3', action: 'সাপ্লায়ার অনুযায়ী অর্ডার সাজানো', status: 'pending' },
        { id: 'r4', action: 'রিঅর্ডার প্রস্তাব আপনাকে দেখানো', status: 'pending' },
      ],
    },
  ],
}

export default function PlanDrivePreviewPage() {
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6">
      <Toaster position="top-center" />
      <div className="mb-5">
        <h1 className="text-lg font-extrabold tracking-tight text-cream/90">Plan-Drive লাইভ ডেস্ক — প্রিভিউ</h1>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          এটি শুধু ডিজাইন দেখার জন্য একটি ডেমো — উপরের সব কাজ নকল (mock) ডেটা।
          এখানে এজেন্ট নিজে থেকে যেভাবে কাজ এগিয়ে নেয়, প্রতিটি ধাপ লাইভ দেখায়, আর
          কোনটায় আপনার সিদ্ধান্ত/অনুমোদন দরকার তা একনজরে বোঝা যায় — পুরোটাই দেখানো হয়েছে।
          বাটনগুলো এখানে শুধু টোস্ট দেখাবে।
        </p>
      </div>

      <PlanDriveTimeline
        data={MOCK}
        onOpenConversation={() => toast('ডেমো — আসল কথোপকথন এখানে খোলে না')}
        onAction={async (_planId, action) => {
          const label = action === 'resume' ? 'আবার চালানো' : action === 'add-budget' ? 'বাজেট বাড়ানো' : 'বাদ দেওয়া'
          toast.success(`ডেমো: "${label}" — আসল কাজ এখানে হয় না`)
        }}
      />
    </div>
  )
}
