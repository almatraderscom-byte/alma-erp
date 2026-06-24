'use client'

/**
 * /agent/plan-drive-preview — a LIVE, self-playing demo of how the Plan-Driver
 * should look INSIDE the office chat: the agent's own "কাজের ধাপ" todolist (the
 * same Claude-Code-style inline checklist already used in AgentThread), with the
 * current step spinning, finished steps ticked, and a stuck step parked with a
 * reason + self-scheduled retry — narrated by the agent in chat as it works.
 *
 * This is ONLY a preview window so the owner can watch the feel before we wire it
 * into the real office chat. Nothing here touches the database or the live agent;
 * a small scripted timeline drives it so it plays like watching a person work.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

type StepStatus = 'pending' | 'running' | 'done' | 'parked'

interface DemoStep {
  id: string
  title: string
  status: StepStatus
  note?: string
  retryAt?: string
}

interface ChatLine {
  id: number
  text: string
}

const INITIAL_STEPS: DemoStep[] = [
  { id: 's1', title: 'নতুন ১০টি প্রোডাক্ট ওয়েবসাইটে আপলোড', status: 'pending' },
  { id: 's2', title: 'গত মাসের বিক্রির রিপোর্ট তৈরি করে পাঠানো', status: 'pending' },
  { id: 's3', title: 'বকেয়া ৮ জন কাস্টমারকে রিমাইন্ডার SMS', status: 'pending' },
  { id: 's4', title: 'কম স্টকের প্রোডাক্টের রিঅর্ডার প্ল্যান', status: 'pending' },
  { id: 's5', title: 'ফেসবুকে আজকের অফার পোস্ট করা', status: 'pending' },
]

/** A scripted event: mutate a step, or push an agent chat line. `after` = ms to
 *  wait before the NEXT event fires, so the timeline paces like real work. */
type DemoEvent =
  | { kind: 'line'; text: string; after: number }
  | { kind: 'step'; id: string; status: StepStatus; note?: string; retryAt?: string; after: number }
  | { kind: 'pause'; after: number }

const SCRIPT: DemoEvent[] = [
  { kind: 'line', text: 'Sir, আজকের ৫টা কাজ পেলাম। এক এক করে শুরু করছি… 💪', after: 1200 },
  { kind: 'step', id: 's1', status: 'running', after: 2000 },
  { kind: 'step', id: 's1', status: 'done', after: 400 },
  { kind: 'line', text: '✅ ১ — ১০টি প্রোডাক্ট ওয়েবসাইটে আপলোড হয়ে গেছে।', after: 1200 },
  { kind: 'step', id: 's2', status: 'running', after: 2000 },
  { kind: 'step', id: 's2', status: 'done', after: 400 },
  { kind: 'line', text: '✅ ২ — বিক্রির রিপোর্ট তৈরি, আপনাকে পাঠিয়ে দিয়েছি।', after: 1200 },
  { kind: 'step', id: 's3', status: 'running', after: 2200 },
  {
    kind: 'step', id: 's3', status: 'parked',
    note: 'আটকে গেছে — ৮ জনকে SMS পাঠাতে আপনার অনুমোদন দরকার',
    retryAt: '১০ মিনিট পর আবার চেষ্টা করব',
    after: 600,
  },
  { kind: 'line', text: '⏸️ ৩ আটকে গেল — SMS পাঠাতে আপনার অনুমোদন লাগবে। দাঁড়িয়ে না থেকে ৪, ৫ এগিয়ে নিচ্ছি, পরে আবার ৩-এ ফিরব।', after: 1600 },
  { kind: 'step', id: 's4', status: 'running', after: 2000 },
  { kind: 'step', id: 's4', status: 'done', after: 400 },
  { kind: 'line', text: '✅ ৪ — রিঅর্ডার প্ল্যান বানিয়ে ফেলেছি।', after: 1100 },
  { kind: 'step', id: 's5', status: 'running', after: 2000 },
  { kind: 'step', id: 's5', status: 'done', after: 400 },
  { kind: 'line', text: '✅ ৫ — ফেসবুকে আজকের অফার পোস্ট হয়েছে।', after: 1300 },
  { kind: 'line', text: 'এখন আবার ৩ নম্বরে ফিরছি… 🔄', after: 1400 },
  { kind: 'step', id: 's3', status: 'running', after: 1800 },
  {
    kind: 'step', id: 's3', status: 'parked',
    note: 'এখনও আপনার অনুমোদনের অপেক্ষায়',
    retryAt: 'পরবর্তী নিজে-চেষ্টা ১০:৪৫',
    after: 600,
  },
  { kind: 'line', text: '৩ ছাড়া বাকি সব শেষ ✅ — শুধু এই একটাই আপনার অনুমোদনের অপেক্ষায়। নিচের বাটনে অনুমোদন দিলেই পাঠিয়ে দেব।', after: 4000 },
]

/* ── icons matching AgentThread's InlineAgentTodos ─────────────────────────── */
function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'running') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#E07A5F" strokeWidth="3" strokeLinecap="round" className="animate-spin">
        <path d="M21 12a9 9 0 11-6.219-8.56" />
      </svg>
    )
  }
  if (status === 'done') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    )
  }
  if (status === 'parked') {
    return <span className="text-[11px] leading-none">⏳</span>
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted opacity-50">
      <circle cx="12" cy="12" r="9" />
    </svg>
  )
}

function TodoCard({ steps, onApprove, approving }: { steps: DemoStep[]; onApprove: () => void; approving: boolean }) {
  const done = steps.filter((s) => s.status === 'done').length
  const anyRunning = steps.some((s) => s.status === 'running')
  return (
    <div className="mb-3 overflow-hidden rounded-2xl border border-white/[0.07] bg-card/70 backdrop-blur-sm">
      <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold text-muted">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#E07A5F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M9 12l2 2 4-4" />
        </svg>
        <span>কাজের ধাপ</span>
        {anyRunning && <span className="text-[9px] font-semibold text-[#E07A5F] animate-pulse">live</span>}
        <span className="ml-auto font-normal tabular-nums text-muted">{done}/{steps.length}</span>
      </div>
      <ul className="flex flex-col px-2 pb-2">
        {steps.map((s) => {
          const parked = s.status === 'parked'
          return (
            <li key={s.id} className={`rounded-lg px-1.5 py-1 ${parked ? 'bg-amber-50/50' : ''}`}>
              <div className="flex items-start gap-2">
                <span className="mt-[1px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  <StepIcon status={s.status} />
                </span>
                <span className={`text-[12.5px] leading-snug break-words [overflow-wrap:anywhere] ${
                  s.status === 'done' ? 'text-muted line-through' :
                  s.status === 'running' ? 'alma-thinking-shimmer font-medium' :
                  parked ? 'text-amber-900/90' :
                  'text-cream'
                }`}>
                  {s.title}
                </span>
                {parked && (
                  <span className="ml-auto shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[8.5px] font-bold uppercase text-amber-700">অপেক্ষায়</span>
                )}
              </div>
              {parked && (s.note || s.retryAt) && (
                <div className="ml-[22px] mt-1 space-y-1">
                  {s.note && <p className="text-[10.5px] leading-snug text-amber-800/90">⚠ {s.note}</p>}
                  {s.retryAt && <p className="text-[10px] text-muted">🕐 {s.retryAt}</p>}
                  <button
                    type="button"
                    onClick={onApprove}
                    disabled={approving}
                    className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-amber-500 px-3 py-1 text-[10px] font-bold text-white transition-transform active:scale-95 disabled:opacity-50 hover:bg-amber-600"
                  >
                    {approving ? '⏳ পাঠাচ্ছি…' : '✋ অনুমোদন দিন'}
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default function PlanDrivePreviewPage() {
  const [steps, setSteps] = useState<DemoStep[]>(INITIAL_STEPS)
  const [lines, setLines] = useState<ChatLine[]>([])
  const [approving, setApproving] = useState(false)
  const [finished, setFinished] = useState(false)
  const lineId = useRef(0)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const stopped = useRef(false)

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }, [])

  const applyStep = useCallback((id: string, status: StepStatus, note?: string, retryAt?: string) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, status, note, retryAt } : s)))
  }, [])

  const pushLine = useCallback((text: string) => {
    lineId.current += 1
    setLines((prev) => [...prev, { id: lineId.current, text }])
  }, [])

  const play = useCallback(() => {
    stopped.current = false
    setSteps(INITIAL_STEPS)
    setLines([])
    setFinished(false)
    lineId.current = 0
    clearTimers()

    let elapsed = 0
    for (const ev of SCRIPT) {
      const t = setTimeout(() => {
        if (stopped.current) return
        if (ev.kind === 'line') pushLine(ev.text)
        else if (ev.kind === 'step') applyStep(ev.id, ev.status, ev.note, ev.retryAt)
      }, elapsed)
      timers.current.push(t)
      elapsed += ev.after
    }
  }, [applyStep, pushLine, clearTimers])

  useEffect(() => {
    play()
    return () => { stopped.current = true; clearTimers() }
  }, [play, clearTimers])

  function approve() {
    if (approving) return
    stopped.current = true
    clearTimers()
    setApproving(true)
    applyStep('s3', 'running')
    setTimeout(() => {
      applyStep('s3', 'done')
      pushLine('ধন্যবাদ Sir! অনুমোদন পেয়েছি — ৮ জনকে SMS পাঠিয়ে দিয়েছি ✅। আজকের সব ৫টা কাজ শেষ। 🎉')
      setApproving(false)
      setFinished(true)
    }, 1300)
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <div className="mb-5">
        <h1 className="text-lg font-extrabold tracking-tight text-cream/90">এজেন্ট যেভাবে কাজ করবে — লাইভ ডেমো</h1>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          এটা শুধু দেখানোর জন্য একটা নকল চ্যাট। আসল কাজে এই &ldquo;কাজের ধাপ&rdquo; তালিকা আর এজেন্টের কথা
          আপনার <b className="text-cream/80">অফিস চ্যাটের ভেতরেই</b> দেখাবে — আলাদা কোনো পেজে নয়।
          এজেন্ট এক এক করে কাজ করে, কোনোটায় আটকে গেলে নিজে থেকে বলে দেয়, পরে আবার চেষ্টা করে।
        </p>
      </div>

      <TodoCard steps={steps} onApprove={approve} approving={approving} />

      <div className="space-y-3">
        <AnimatePresence initial={false}>
          {lines.map((l) => (
            <motion.div
              key={l.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-[14.5px] leading-relaxed text-cream"
            >
              {l.text}
            </motion.div>
          ))}
        </AnimatePresence>
        {!finished && (
          <div className="flex items-center gap-1.5 pt-1 text-muted">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-[#E07A5F]/40 border-t-[#E07A5F]" />
            <span className="alma-thinking-shimmer text-[12px]">এজেন্ট কাজ করছে…</span>
          </div>
        )}
      </div>

      <div className="mt-8 flex items-center gap-3 border-t border-border-subtle pt-4">
        <button
          type="button"
          onClick={play}
          className="rounded-full bg-[#E07A5F] px-4 py-2 text-[12px] font-bold text-white transition-transform active:scale-95 hover:bg-[#C45A3C]"
        >
          ↻ আবার দেখুন
        </button>
        <p className="text-[11px] text-muted">পছন্দ হলে আমি এটা অফিস চ্যাটে বসিয়ে দেব।</p>
      </div>
    </div>
  )
}
