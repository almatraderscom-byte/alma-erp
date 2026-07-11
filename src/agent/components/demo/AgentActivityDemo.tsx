'use client'

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useState } from 'react'

type ActivityMode = 'thinking' | 'researching' | 'writing'

const MODES: Array<{
  id: ActivityMode
  label: string
  detail: string
}> = [
  { id: 'thinking', label: 'ভাবছি', detail: 'প্রশ্নটি বুঝে পরিকল্পনা করছি' },
  { id: 'researching', label: 'খুঁজে দেখছি', detail: 'প্রয়োজনীয় তথ্য যাচাই করছি' },
  { id: 'writing', label: 'উত্তর লিখছি', detail: 'সবকিছু গুছিয়ে দিচ্ছি' },
]

function ThinkingMark({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <motion.g
      initial={{ opacity: 0, scale: 0.72, rotate: -18 }}
      animate={{ opacity: 1, scale: 1, rotate: 0 }}
      exit={{ opacity: 0, scale: 0.72, rotate: 18 }}
      transition={{ duration: reduceMotion ? 0 : 0.42, ease: [0.22, 1, 0.36, 1] }}
      style={{ transformOrigin: '16px 16px' }}
    >
      {[0, 45, 90, 135].map((angle, index) => (
        <motion.line
          key={angle}
          x1="16"
          y1="5.25"
          x2="16"
          y2="26.75"
          rx="2"
          transform={`rotate(${angle} 16 16)`}
          animate={reduceMotion ? undefined : {
            opacity: [0.48, 1, 0.48],
            scale: [0.82, 1.02, 0.82],
          }}
          transition={{
            duration: 1.85,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: index * 0.1,
          }}
        />
      ))}
      <motion.circle
        cx="16"
        cy="16"
        r="2.65"
        fill="currentColor"
        stroke="none"
        animate={reduceMotion ? undefined : { scale: [0.86, 1.08, 0.86] }}
        transition={{ duration: 1.85, repeat: Infinity, ease: 'easeInOut' }}
        style={{ transformOrigin: '16px 16px' }}
      />
    </motion.g>
  )
}

function ResearchingMark({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <motion.g
      initial={{ opacity: 0, scale: 0.74, rotate: -24 }}
      animate={{ opacity: 1, scale: 1, rotate: 0 }}
      exit={{ opacity: 0, scale: 0.74, rotate: 24 }}
      transition={{ duration: reduceMotion ? 0 : 0.42, ease: [0.22, 1, 0.36, 1] }}
      style={{ transformOrigin: '16px 16px' }}
    >
      <motion.circle
        cx="16"
        cy="16"
        r="10.25"
        fill="none"
        strokeDasharray="4 3.2"
        strokeLinecap="round"
        animate={reduceMotion ? undefined : { rotate: 360 }}
        transition={{ duration: 2.35, repeat: Infinity, ease: 'linear' }}
        style={{ transformOrigin: '16px 16px' }}
      />
      <motion.path
        d="M16 9.5v13M9.5 16h13"
        strokeLinecap="round"
        animate={reduceMotion ? undefined : {
          opacity: [0.52, 1, 0.52],
          scale: [0.78, 1, 0.78],
          rotate: [0, 90, 180],
        }}
        transition={{ duration: 1.75, repeat: Infinity, ease: 'easeInOut' }}
        style={{ transformOrigin: '16px 16px' }}
      />
      <circle cx="16" cy="16" r="2.2" fill="currentColor" stroke="none" />
    </motion.g>
  )
}

function WritingMark({ reduceMotion }: { reduceMotion: boolean }) {
  const paths = [
    'M5.5 10.25C9.25 7.7 13.1 8.2 16.15 10.2C19.35 12.3 22.35 11.95 26.5 9.25',
    'M5.5 16C9.3 13.6 12.8 14 16 16C19.25 18 22.7 18.35 26.5 16',
    'M5.5 21.75C9.35 19.05 12.45 19.7 15.75 21.75C19.05 23.8 22.45 24.1 26.5 21.2',
  ]

  return (
    <motion.g
      initial={{ opacity: 0, scale: 0.78, x: -2 }}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      exit={{ opacity: 0, scale: 0.78, x: 2 }}
      transition={{ duration: reduceMotion ? 0 : 0.42, ease: [0.22, 1, 0.36, 1] }}
      style={{ transformOrigin: '16px 16px' }}
    >
      {paths.map((path, index) => (
        <motion.path
          key={path}
          d={path}
          fill="none"
          strokeLinecap="round"
          pathLength={1}
          initial={{ pathLength: reduceMotion ? 1 : 0.12, opacity: 0.35 }}
          animate={{ pathLength: 1, opacity: [0.38, 1, 0.38] }}
          transition={{
            pathLength: { duration: reduceMotion ? 0 : 0.62, delay: index * 0.11, ease: 'easeOut' },
            opacity: { duration: 1.35, delay: index * 0.14, repeat: Infinity, ease: 'easeInOut' },
          }}
        />
      ))}
    </motion.g>
  )
}

function ActivityMark({ mode }: { mode: ActivityMode }) {
  const reduceMotion = useReducedMotion() ?? false

  return (
    <motion.span
      className="relative grid h-8 w-8 shrink-0 place-items-center text-[#D97757]"
      animate={reduceMotion ? undefined : {
        filter: [
          'drop-shadow(0 0 2px rgba(217,119,87,0.16))',
          'drop-shadow(0 0 7px rgba(217,119,87,0.34))',
          'drop-shadow(0 0 2px rgba(217,119,87,0.16))',
        ],
      }}
      transition={{ duration: 2.1, repeat: Infinity, ease: 'easeInOut' }}
      aria-hidden
    >
      <svg viewBox="0 0 32 32" className="h-7 w-7 overflow-visible" fill="none" stroke="currentColor" strokeWidth="2.05">
        <AnimatePresence initial={false} mode="sync">
          {mode === 'thinking' && <ThinkingMark key="thinking" reduceMotion={reduceMotion} />}
          {mode === 'researching' && <ResearchingMark key="researching" reduceMotion={reduceMotion} />}
          {mode === 'writing' && <WritingMark key="writing" reduceMotion={reduceMotion} />}
        </AnimatePresence>
      </svg>
    </motion.span>
  )
}

function ActivityIndicator({ mode }: { mode: ActivityMode }) {
  const item = MODES.find((candidate) => candidate.id === mode) ?? MODES[0]
  const reduceMotion = useReducedMotion() ?? false

  return (
    <div className="flex items-center gap-2.5" role="status" aria-live="polite">
      <ActivityMark mode={mode} />
      <div className="min-w-0">
        <div className="relative h-[20px] overflow-hidden">
          <AnimatePresence initial={false} mode="wait">
            <motion.p
              key={item.id}
              className="whitespace-nowrap text-[14px] font-medium leading-5 text-[#2F2D2A] dark:text-[#F2EFEA]"
              initial={reduceMotion ? false : { opacity: 0, y: 7, filter: 'blur(3px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -7, filter: 'blur(3px)' }}
              transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              {item.label}<span className="activity-ellipsis" aria-hidden>…</span>
            </motion.p>
          </AnimatePresence>
        </div>
        <AnimatePresence initial={false} mode="wait">
          <motion.p
            key={`${item.id}-detail`}
            className="mt-0.5 whitespace-nowrap text-[11.5px] leading-4 text-[#76716B] dark:text-[#A9A39A]"
            initial={reduceMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
            transition={{ duration: reduceMotion ? 0 : 0.24 }}
          >
            {item.detail}
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  )
}

export default function AgentActivityDemo() {
  const [mode, setMode] = useState<ActivityMode>('thinking')
  const [autoPlay, setAutoPlay] = useState(true)

  useEffect(() => {
    if (!autoPlay) return
    const timer = window.setInterval(() => {
      setMode((current) => {
        const currentIndex = MODES.findIndex((item) => item.id === current)
        return MODES[(currentIndex + 1) % MODES.length].id
      })
    }, 3100)
    return () => window.clearInterval(timer)
  }, [autoPlay])

  const chooseMode = (nextMode: ActivityMode) => {
    setAutoPlay(false)
    setMode(nextMode)
  }

  return (
    <div className="h-full overflow-y-auto px-4 pb-10 pt-[max(18px,env(safe-area-inset-top))] sm:px-6">
      <div className="mx-auto flex min-h-full w-full max-w-[430px] flex-col">
        <header className="mb-6 flex items-start justify-between gap-4 px-1">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#D97757]">iOS Agent</p>
            <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.025em] text-cream">কাজের অবস্থার ডেমো</h1>
            <p className="mt-1.5 max-w-[310px] text-[13px] leading-5 text-muted">একটি shape—কাজ বদলালে তার গতি, গঠন ও ভাষাও বদলাবে।</p>
          </div>
          <button
            type="button"
            onClick={() => setAutoPlay((value) => !value)}
            className="alma-glass mt-1 rounded-full px-3 py-1.5 text-[11px] font-medium text-muted transition-colors hover:text-cream active:scale-[0.98]"
            aria-pressed={autoPlay}
          >
            {autoPlay ? 'অটো চলছে' : 'অটো চালান'}
          </button>
        </header>

        <section className="alma-glass-lift relative overflow-hidden rounded-[28px] p-5 sm:p-6">
          <div className="pointer-events-none absolute inset-x-10 top-0 h-24 rounded-full bg-[#D97757]/[0.08] blur-3xl" />

          <div className="relative flex items-center gap-2 text-[11px] text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-[#80A98E] shadow-[0_0_8px_rgba(128,169,142,0.65)]" />
            ALMA আপনার অনুরোধে কাজ করছে
          </div>

          <div className="relative mt-9 min-h-[176px]">
            <div className="ml-auto max-w-[82%] rounded-[20px] rounded-br-[7px] bg-[#D97757]/[0.12] px-4 py-3 text-[14px] leading-6 text-cream">
              গত মাসের বিক্রি দেখে আগামী সপ্তাহের একটি ছোট পরিকল্পনা করে দিন।
            </div>

            <div className="mt-8 pl-1">
              <ActivityIndicator mode={mode} />
            </div>
          </div>

          <div className="relative mt-5 grid grid-cols-3 gap-2 border-t border-border-subtle pt-4">
            {MODES.map((item) => {
              const active = item.id === mode
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => chooseMode(item.id)}
                  className={`rounded-2xl border px-2 py-2.5 text-[11px] font-medium transition-all active:scale-[0.97] ${
                    active
                      ? 'border-[#D97757]/40 bg-[#D97757]/[0.12] text-[#D97757] shadow-[0_6px_18px_-12px_rgba(217,119,87,0.65)]'
                      : 'border-border-subtle bg-white/[0.025] text-muted hover:text-cream'
                  }`}
                  aria-pressed={active}
                >
                  {item.label}
                </button>
              )
            })}
          </div>
        </section>

        <div className="mt-5 grid grid-cols-3 gap-2 px-1 text-center">
          <div className="rounded-2xl border border-border-subtle bg-white/[0.025] px-2 py-3">
            <p className="text-[15px] text-[#D97757]">✳</p>
            <p className="mt-1 text-[10.5px] text-muted">শান্ত ভাবনা</p>
          </div>
          <div className="rounded-2xl border border-border-subtle bg-white/[0.025] px-2 py-3">
            <p className="text-[15px] text-[#D97757]">◌</p>
            <p className="mt-1 text-[10.5px] text-muted">ঘূর্ণমান খোঁজ</p>
          </div>
          <div className="rounded-2xl border border-border-subtle bg-white/[0.025] px-2 py-3">
            <p className="text-[15px] text-[#D97757]">≋</p>
            <p className="mt-1 text-[10.5px] text-muted">প্রবাহিত লেখা</p>
          </div>
        </div>

        <p className="mt-auto px-4 pt-8 text-center text-[10.5px] leading-4 text-muted">
          এটি শুধু visual demo—আপনার অনুমোদনের আগে মূল Agent chat বদলানো হয়নি।
        </p>
      </div>

      <style jsx>{`
        .activity-ellipsis {
          display: inline-block;
          width: 0.85em;
          overflow: hidden;
          vertical-align: bottom;
          animation: activity-ellipsis 1.15s steps(4, end) infinite;
        }

        @keyframes activity-ellipsis {
          0% { width: 0; }
          100% { width: 0.85em; }
        }

        @media (prefers-reduced-motion: reduce) {
          .activity-ellipsis { animation: none; width: 0.85em; }
        }
      `}</style>
    </div>
  )
}
