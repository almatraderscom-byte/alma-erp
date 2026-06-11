'use client'

import { motion } from 'framer-motion'

const SUGGESTIONS = [
  'আজকের অর্ডার সারাংশ দাও',
  'স্টক কম আছে কি চেক করো',
  'একটা Facebook পোস্ট ড্রাফট করো',
]

interface AgentEmptyStateProps {
  onSuggestion?: (text: string) => void
}

export default function AgentEmptyState({ onSuggestion }: AgentEmptyStateProps) {
  return (
    <div className="flex min-h-[min(420px,55dvh)] flex-col items-center justify-center px-6 py-12 text-center">
      <motion.div
        className="relative mb-8 flex h-16 w-16 items-center justify-center"
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        <motion.span
          className="absolute inset-0 rounded-full bg-gold/10 blur-xl"
          animate={{ scale: [1, 1.15, 1], opacity: [0.35, 0.55, 0.35] }}
          transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}
        />
        <span className="relative text-3xl text-gold/70">✦</span>
      </motion.div>

      <motion.p
        className="text-lg font-semibold tracking-tight text-cream"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08, duration: 0.35 }}
      >
        আস্সালামু আলাইকুম
      </motion.p>
      <motion.p
        className="mt-2 max-w-xs text-[13px] leading-relaxed text-zinc-500"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.14, duration: 0.35 }}
      >
        কিভাবে সাহায্য করতে পারি, স্যার?
      </motion.p>

      {onSuggestion && (
        <motion.div
          className="mt-8 flex w-full max-w-md flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-center"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.22, duration: 0.35 }}
        >
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSuggestion(s)}
              className="rounded-full border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-left text-[12px] text-zinc-400 transition-colors hover:border-gold-dim/35 hover:bg-gold/5 hover:text-cream sm:text-center"
            >
              {s}
            </button>
          ))}
        </motion.div>
      )}
    </div>
  )
}
