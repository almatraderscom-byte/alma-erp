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
    <div className="flex flex-col px-4 py-6">
      {/* Greeting */}
      <div className="flex flex-col items-center text-center mb-6">
        <motion.div
          className="relative mb-6 h-24 w-24"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Soft outer glow — breathing halo */}
          <motion.div
            className="absolute -inset-3 rounded-full blur-2xl"
            style={{
              background:
                'radial-gradient(circle at 50% 50%, rgba(45,212,191,0.45) 0%, rgba(56,189,248,0.28) 45%, transparent 72%)',
            }}
            animate={{ opacity: [0.5, 0.85, 0.5], scale: [0.95, 1.06, 0.95] }}
            transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
          />

          {/* The orb itself */}
          <div className="absolute inset-0 overflow-hidden rounded-full shadow-[0_8px_28px_-6px_rgba(13,148,136,0.45)]">
            {/* Iridescent base */}
            <div
              className="absolute inset-0"
              style={{
                background:
                  'radial-gradient(circle at 35% 30%, #99f6e4 0%, #2dd4bf 34%, #0891b2 68%, #155e75 100%)',
              }}
            />
            {/* Rotating conic spectrum (Siri-like color drift) */}
            <motion.div
              className="absolute -inset-1/4 blur-xl mix-blend-screen"
              style={{
                background:
                  'conic-gradient(from 0deg, #34d399, #22d3ee, #818cf8, #2dd4bf, #38bdf8, #34d399)',
              }}
              animate={{ rotate: 360 }}
              transition={{ duration: 9, repeat: Infinity, ease: 'linear' }}
            />
            {/* Counter-rotating violet bloom */}
            <motion.div
              className="absolute -inset-1/3 opacity-70 blur-2xl mix-blend-screen"
              style={{
                background: 'radial-gradient(circle at 70% 65%, rgba(129,140,248,0.9) 0%, transparent 55%)',
              }}
              animate={{ rotate: -360, scale: [1, 1.18, 1] }}
              transition={{
                rotate: { duration: 12, repeat: Infinity, ease: 'linear' },
                scale: { duration: 6, repeat: Infinity, ease: 'easeInOut' },
              }}
            />
            {/* Glossy highlight + glass rim */}
            <div
              className="absolute inset-0 rounded-full"
              style={{ background: 'radial-gradient(circle at 32% 26%, rgba(255,255,255,0.7) 0%, transparent 40%)' }}
            />
            <div className="absolute inset-0 rounded-full ring-1 ring-white/30" />
          </div>
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
          কিভাবে সাহায্য করতে পারি, স্যার?
        </motion.p>
      </div>

      {/* Suggestions */}
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
