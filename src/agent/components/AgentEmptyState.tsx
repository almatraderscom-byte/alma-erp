'use client'

import { motion } from 'framer-motion'

const SUGGESTIONS = [
  { text: 'আজকের অর্ডার সারাংশ দাও', icon: '📦' },
  { text: 'স্টক কম আছে কি চেক করো', icon: '📊' },
  { text: 'একটা Facebook পোস্ট ড্রাফট করো', icon: '✍️' },
  { text: 'স্টাফদের আজকের টাস্ক রিভিউ করো', icon: '👥' },
]

interface AgentEmptyStateProps {
  onSuggestion?: (text: string) => void
}

export default function AgentEmptyState({ onSuggestion }: AgentEmptyStateProps) {
  return (
    <div className="flex min-h-[min(440px,55dvh)] flex-col items-center justify-center px-4 py-12 text-center">
      {/* Subtle animated orb */}
      <motion.div
        className="relative mb-8 h-16 w-16"
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{
            background: 'radial-gradient(circle at 40% 35%, rgba(201,168,76,0.2) 0%, rgba(100,60,180,0.06) 60%, transparent 100%)',
          }}
          animate={{ scale: [1, 1.08, 1], opacity: [0.6, 1, 0.6] }}
          transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute inset-2 rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(232,201,106,0.15) 0%, transparent 70%)',
          }}
          animate={{ scale: [0.95, 1.1, 0.95] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
        />
        <div className="absolute inset-0 rounded-full border border-white/[0.06]" />
      </motion.div>

      <motion.p
        className="text-xl font-semibold text-white/90"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.4 }}
      >
        আস্সালামু আলাইকুম
      </motion.p>
      <motion.p
        className="mt-2 text-[14px] text-white/40"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15, duration: 0.4 }}
      >
        কিভাবে সাহায্য করতে পারি, স্যার?
      </motion.p>

      {onSuggestion && (
        <motion.div
          className="mt-8 grid w-full max-w-md grid-cols-2 gap-2"
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
              onClick={() => onSuggestion(s.text)}
              className="flex items-start gap-2 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 text-left text-[12px] leading-snug text-white/50 transition-all hover:border-white/[0.12] hover:bg-white/[0.04] hover:text-white/70 active:scale-[0.98]"
              variants={{
                hidden: { opacity: 0, y: 10 },
                visible: { opacity: 1, y: 0 },
              }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <span className="mt-0.5 text-sm">{s.icon}</span>
              <span>{s.text}</span>
            </motion.button>
          ))}
        </motion.div>
      )}
    </div>
  )
}
