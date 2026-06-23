'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { VoiceOrb } from '@/agent/components/voice/VoiceOrb'
import type { VoiceState } from '@/agent/lib/voice-types'

/** Time-of-day greeting (Asia/Dhaka, computed client-side). Sample copy for the demo. */
function greeting(): { hi: string; sub: string } {
  const h = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Dhaka' }).format(new Date()),
  )
  if (h < 5) return { hi: 'শুভ রাত্রি', sub: 'এখনো জেগে আছেন — আমি আছি, Sir' }
  if (h < 12) return { hi: 'শুভ সকাল', sub: 'আজকের দিনটা গুছিয়ে শুরু করি' }
  if (h < 15) return { hi: 'শুভ দুপুর', sub: 'ব্যবসা ঠিকঠাক চলছে, Sir' }
  if (h < 18) return { hi: 'শুভ বিকেল', sub: 'বিকেলের আপডেট নিয়ে নিন' }
  if (h < 20) return { hi: 'শুভ সন্ধ্যা', sub: 'ইশার আগে কাজ গুছিয়ে নিই' }
  return { hi: 'শুভ রাত্রি', sub: 'আজকের কাজ শেষ করে দিই' }
}

// Sample data — purely for the look. No real numbers fetched in the demo.
const STATS = [
  { label: 'আজকের সেল', value: '৳ ৪২,৫০০', tone: '#E07A5F' },
  { label: 'অর্ডার', value: '১৮', hint: '৫ pending', tone: '#5b8cff' },
  { label: 'অফিসে', value: '৩ জন', hint: 'live', tone: '#22d3ee' },
]

const SUGGESTIONS = [
  { icon: '📦', title: 'আজকের অর্ডার সারাংশ', sub: '১৮টি অর্ডার · ৫টি pending' },
  { icon: '📊', title: 'স্টক অ্যালার্ট', sub: '৩টি পণ্য কমে এসেছে' },
  { icon: '✍️', title: 'Facebook পোস্ট ড্রাফট', sub: 'নতুন ক্যাম্পেইনের জন্য' },
  { icon: '👥', title: 'স্টাফ টাস্ক রিভিউ', sub: 'আজকের কাজ দেখে নিন' },
]

const fade = {
  hidden: { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0 },
}

export default function HomeDemoView({ userName }: { userName: string }) {
  const g = greeting()
  const [orb, setOrb] = useState<VoiceState>('idle')
  const first = (userName || 'Sir').split(' ')[0]

  return (
    <div className="relative mx-auto flex w-full max-w-md flex-col px-4 pb-28 pt-3">
      {/* DEMO ribbon */}
      <div className="mb-3 flex items-center justify-between">
        <span className="rounded-full border border-[#E07A5F]/40 bg-[#E07A5F]/10 px-2.5 py-1 text-[10px] font-semibold tracking-wide text-[#E9B8A8]">
          ✨ NEW HOME · DEMO
        </span>
        <span className="text-[11px] text-muted">
          {new Intl.DateTimeFormat('bn-BD', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Dhaka' }).format(new Date())}
        </span>
      </div>

      {/* Hero: orb + greeting */}
      <motion.div
        className="relative flex flex-col items-center overflow-hidden rounded-[28px] border border-white/10 bg-gradient-to-b from-white/[0.07] to-white/[0.02] px-5 pb-6 pt-7 text-center backdrop-blur-xl"
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        style={{ boxShadow: '0 24px 70px rgba(0,0,0,0.35)' }}
      >
        {/* soft accent glow behind orb */}
        <div
          className="pointer-events-none absolute left-1/2 top-2 h-44 w-44 -translate-x-1/2 rounded-full opacity-50 blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(224,122,95,0.5), transparent 70%)' }}
        />
        <motion.button
          type="button"
          onClick={() => setOrb((s) => (s === 'idle' ? 'listening' : 'idle'))}
          whileTap={{ scale: 0.95 }}
          className="relative z-10 mb-4 rounded-full focus:outline-none"
          aria-label="ভয়েস মোড"
        >
          <VoiceOrb state={orb} size={148}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.25))' }}>
              <rect x="9" y="1" width="6" height="11" rx="3" />
              <path d="M19 10v2a7 7 0 01-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </VoiceOrb>
        </motion.button>

        <motion.h1
          className="relative z-10 text-[22px] font-bold leading-tight text-cream"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12 }}
        >
          {g.hi}, {first}
        </motion.h1>
        <motion.p
          className="relative z-10 mt-1 text-[13px] text-muted"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.18 }}
        >
          আস্‌সালামু আলাইকুম — {g.sub}
        </motion.p>

        <div className="relative z-10 mt-3 flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-3 py-1 text-[11px] font-medium text-emerald-300">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          Agent online · {orb === 'listening' ? 'শুনছি…' : 'কথা বলতে ট্যাপ করুন'}
        </div>
      </motion.div>

      {/* Quick stats */}
      <motion.div
        className="mt-4 grid grid-cols-3 gap-2.5"
        initial="hidden"
        animate="visible"
        variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.07, delayChildren: 0.25 } } }}
      >
        {STATS.map((s) => (
          <motion.div
            key={s.label}
            variants={fade}
            className="flex flex-col gap-1 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-3 backdrop-blur-md"
          >
            <span className="h-1 w-6 rounded-full" style={{ background: s.tone }} />
            <span className="text-[15px] font-bold leading-none text-cream">{s.value}</span>
            <span className="text-[10.5px] leading-tight text-muted">
              {s.label}{s.hint ? ` · ${s.hint}` : ''}
            </span>
          </motion.div>
        ))}
      </motion.div>

      {/* Smart suggestions */}
      <motion.div
        className="mt-5 flex flex-col gap-2.5"
        initial="hidden"
        animate="visible"
        variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.07, delayChildren: 0.4 } } }}
      >
        <p className="px-1 text-[12px] font-semibold uppercase tracking-wide text-muted">যা করতে পারি</p>
        {SUGGESTIONS.map((s) => (
          <motion.button
            key={s.title}
            variants={fade}
            type="button"
            whileTap={{ scale: 0.98 }}
            className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-left backdrop-blur-md transition-colors hover:border-[#E07A5F]/40 hover:bg-white/[0.06]"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-white/10 to-white/[0.03] text-lg">
              {s.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-semibold text-cream">{s.title}</span>
              <span className="block truncate text-[11.5px] text-muted">{s.sub}</span>
            </span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </motion.button>
        ))}
      </motion.div>

      {/* Primary actions */}
      <motion.div
        className="mt-6 flex gap-2.5"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.7 }}
      >
        <button
          type="button"
          onClick={() => setOrb('listening')}
          className="flex flex-1 items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold text-white"
          style={{ background: 'linear-gradient(135deg, #E07A5F, #c75f44)', boxShadow: '0 10px 30px rgba(224,122,95,0.35)' }}
        >
          🎙️ কথা বলুন
        </button>
        <button
          type="button"
          className="flex items-center justify-center gap-2 rounded-2xl border border-white/12 bg-white/[0.05] px-5 py-3.5 text-sm font-semibold text-cream backdrop-blur-md"
        >
          ⌨️ টাইপ
        </button>
      </motion.div>

      <p className="mt-4 text-center text-[10.5px] text-muted/70">
        এটি একটি ডিজাইন ডেমো · আসল data নয় · আসল Agent অপরিবর্তিত
      </p>
    </div>
  )
}
