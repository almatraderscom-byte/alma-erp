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
      {/* Warm gradient orb */}
      <motion.div
        className="relative mb-8 h-16 w-16"
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{
            background: 'radial-gradient(circle at 40% 35%, rgba(224,122,95,0.3) 0%, rgba(129,178,154,0.15) 60%, transparent 100%)',
          }}
          animate={{ scale: [1, 1.08, 1], opacity: [0.6, 1, 0.6] }}
          transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute inset-2 rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(212,168,75,0.2) 0%, transparent 70%)',
          }}
          animate={{ scale: [0.95, 1.1, 0.95] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
        />
        <div className="absolute inset-0 rounded-full border border-black/[0.06]" />
      </motion.div>

      <motion.p
        className="text-xl font-semibold text-[#1a1a2e]"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.4 }}
      >
        আস্সালামু আলাইকুম
      </motion.p>
      <motion.p
        className="mt-2 text-[14px] text-[#64748b]"
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
              className="flex items-start gap-2 rounded-2xl border border-black/[0.06] bg-white p-3 text-left text-[12px] leading-snug text-[#64748b] shadow-sm transition-all hover:border-[#E07A5F]/20 hover:bg-[#E07A5F]/[0.03] hover:text-[#1a1a2e] hover:shadow-md active:scale-[0.98]"
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
