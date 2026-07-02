'use client'

import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { FluidOrb } from './voice/FluidOrb'

type Suggestion = { text: string; icon: string }
type DayPart = 'morning' | 'afternoon' | 'evening' | 'night'

/**
 * Time-of-day quick suggestions (Phase C). The home grid felt static showing the
 * same four prompts at every hour; this rotates them by Dhaka day-part so the agent
 * surfaces what the owner most likely wants right now — start-of-day review in the
 * morning, sales/approvals at midday, wrap-up + tomorrow's plan in the evening, and
 * a quiet digest at night. Purely cosmetic; each item is just a seed message.
 */
const SUGGESTIONS_BY_PART: Record<DayPart, Suggestion[]> = {
  morning: [
    { text: 'আজকের অর্ডার সারাংশ দাও', icon: '📦' },
    { text: 'স্টাফদের আজকের টাস্ক রিভিউ করো', icon: '👥' },
    { text: 'স্টক কম আছে কি চেক করো', icon: '📊' },
    { text: 'আজকের জন্য একটা প্ল্যান বানাও', icon: '🗒️' },
  ],
  afternoon: [
    { text: 'এখন পর্যন্ত আজকের বিক্রি কেমন?', icon: '💰' },
    { text: 'অনুমোদনের জন্য কী কী পেন্ডিং আছে?', icon: '✅' },
    { text: 'একটা Facebook পোস্ট ড্রাফট করো', icon: '✍️' },
    { text: 'স্টক কম আছে কি চেক করো', icon: '📊' },
  ],
  evening: [
    { text: 'আজকের দিনের বিক্রির রিপোর্ট দাও', icon: '📈' },
    { text: 'কালকের জন্য স্টাফ টাস্ক প্রস্তাব করো', icon: '👥' },
    { text: 'একটা Facebook পোস্ট ড্রাফট করো', icon: '✍️' },
    { text: 'আজকের খরচ রিভিউ করো', icon: '🧾' },
  ],
  night: [
    { text: 'আজকের দিনের সারাংশ দাও', icon: '🌙' },
    { text: 'ব্যবসার আর্থিক অবস্থা কেমন?', icon: '💹' },
    { text: 'কালকের জন্য কী কী ঠিক করা দরকার?', icon: '🗒️' },
    { text: 'কোনো রিমাইন্ডার বা ফলো-আপ বাকি আছে?', icon: '🔔' },
  ],
}

const GREETING_SUBTITLE: Record<DayPart, string> = {
  morning: 'শুভ সকাল, Sir — দিনটা শুরু করি',
  afternoon: 'শুভ দুপুর, Sir — কীভাবে সাহায্য করতে পারি',
  evening: 'শুভ সন্ধ্যা, Sir — দিনটা গুছিয়ে নিই',
  night: 'শুভ রাত্রি, Sir — কী দেখে নেবো',
}

/** Current Dhaka hour → day-part. */
function dhakaDayPart(now = new Date()): DayPart {
  const hourStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    hour12: false,
  }).format(now)
  const hour = Number(hourStr) % 24
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 21) return 'evening'
  return 'night'
}

interface AgentEmptyStateProps {
  onSuggestion?: (text: string) => void
  onStartVoiceSession?: () => void
}

export default function AgentEmptyState({ onSuggestion, onStartVoiceSession }: AgentEmptyStateProps) {
  const dayPart = useMemo(() => dhakaDayPart(), [])
  const suggestions = SUGGESTIONS_BY_PART[dayPart]
  return (
    <div className="flex flex-col px-4 py-6">
      <div className="flex flex-col items-center text-center mb-6">
        <motion.div
          className="relative mb-2 flex h-40 w-full items-center justify-center"
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        >
          <motion.button
            type="button"
            onClick={onStartVoiceSession}
            className="relative flex select-none touch-manipulation items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[#E07A5F]/50 [-webkit-touch-callout:none]"
            whileTap={{ scale: 0.95 }}
            aria-label="ভয়েস মোড শুরু করুন"
          >
            {/* The same fluid orb as the voice console — one consciousness,
                one identity. FluidOrb falls back to the CSS VoiceOrb itself
                when WebGL is unavailable. */}
            <FluidOrb state="idle" size={148} />
            <span className="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.35))' }}>
                <rect x="9" y="1" width="6" height="11" rx="3" />
                <path d="M19 10v2a7 7 0 01-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            </span>
          </motion.button>
        </motion.div>

        <motion.p
          className="text-lg font-semibold text-cream"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.4 }}
        >
          আস্সালামু আলাইকুম
        </motion.p>
        <motion.p
          className="mt-1.5 text-[13px] text-muted"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.4 }}
        >
          {GREETING_SUBTITLE[dayPart]} — Orb-এ ট্যাপ করে কথা বলুন বা টাইপ করুন
        </motion.p>
      </div>

      {onSuggestion && (
        <motion.div
          className="grid w-full max-w-md mx-auto grid-cols-2 gap-2"
          initial="hidden"
          animate="visible"
          variants={{
            hidden: {},
            visible: { transition: { staggerChildren: 0.06, delayChildren: 0.25 } },
          }}
        >
          {suggestions.map((s) => (
            <motion.button
              key={s.text}
              type="button"
              variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0 } }}
              onClick={() => onSuggestion(s.text)}
              className="alma-frost flex items-start gap-2.5 rounded-[18px] px-4 py-3 text-left text-[13px] font-medium text-cream/85 transition-all hover:border-[#E07A5F]/30 hover:text-cream active:scale-[0.98]"
            >
              <span className="text-base leading-none">{s.icon}</span>
              <span className="leading-snug">{s.text}</span>
            </motion.button>
          ))}
        </motion.div>
      )}
    </div>
  )
}
