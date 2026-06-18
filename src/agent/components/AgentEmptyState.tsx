'use client'

import { motion } from 'framer-motion'
import { VoiceOrb } from './voice/VoiceOrb'

const SUGGESTIONS = [
  { text: 'আজকের অর্ডার সারাংশ দাও', icon: '📦' },
  { text: 'স্টক কম আছে কি চেক করো', icon: '📊' },
  { text: 'একটা Facebook পোস্ট ড্রাফট করো', icon: '✍️' },
  { text: 'স্টাফদের আজকের টাস্ক রিভিউ করো', icon: '👥' },
]

interface AgentEmptyStateProps {
  onSuggestion?: (text: string) => void
  onStartVoiceSession?: () => void
}

export default function AgentEmptyState({ onSuggestion, onStartVoiceSession }: AgentEmptyStateProps) {
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
            <VoiceOrb state="idle" size={132}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.2))' }}>
                <rect x="9" y="1" width="6" height="11" rx="3" />
                <path d="M19 10v2a7 7 0 01-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            </VoiceOrb>
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
          Orb-এ ট্যাপ করে কথা বলুন — অথবা নিচে টাইপ করুন
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
          {SUGGESTIONS.map((s) => (
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
