'use client'

import { motion } from 'framer-motion'
import AgentVoiceOrb from './voice/AgentVoiceOrb'

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
          className="relative mb-2 flex h-44 w-full items-center justify-center"
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        >
          <motion.div
            className="absolute h-44 w-44 rounded-full blur-3xl"
            style={{ background: 'radial-gradient(circle, rgba(224,122,95,0.28) 0%, rgba(56,189,248,0.08) 55%, transparent 75%)' }}
            animate={{ opacity: [0.35, 0.65, 0.35], scale: [0.92, 1.08, 0.92] }}
            transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.button
            type="button"
            onClick={onStartVoiceSession}
            className="relative rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[#E07A5F]/50"
            whileTap={{ scale: 0.96 }}
            aria-label="ভয়েস মোড শুরু করুন"
          >
            <AgentVoiceOrb agentState={null} size={168} />
          </motion.button>
        </motion.div>

        <motion.p
          className="text-lg font-semibold text-[#1a1a2e]"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.4 }}
        >
          আস্সালামু আলাইকুম
        </motion.p>
        <motion.p
          className="mt-1.5 text-[13px] text-[#64748b]"
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
              className="flex items-start gap-2 rounded-2xl border border-black/[0.06] bg-white/80 px-3 py-2.5 text-left text-[12px] font-medium text-[#1a1a2e]/80 shadow-sm transition-all hover:border-[#E07A5F]/25 hover:bg-white active:scale-[0.98]"
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
