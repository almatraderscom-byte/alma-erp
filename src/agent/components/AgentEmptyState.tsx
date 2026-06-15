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
      {/* Animated gradient orb */}
      <motion.div
        className="relative mb-10 flex h-24 w-24 items-center justify-center"
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      >
        {/* Outer radial glow */}
        <motion.div
          className="absolute inset-[-40%] rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(201,168,76,0.08) 0%, transparent 70%)',
          }}
          animate={{ scale: [1, 1.1, 1], opacity: [0.5, 0.8, 0.5] }}
          transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
        />
        {/* Primary orb — gold to purple */}
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{
            background: 'radial-gradient(circle at 40% 35%, rgba(201,168,76,0.25) 0%, rgba(139,105,20,0.12) 35%, rgba(100,60,180,0.08) 65%, transparent 100%)',
          }}
          animate={{ rotate: [0, 360] }}
          transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
        />
        {/* Secondary orb — blue offset */}
        <motion.div
          className="absolute inset-2 rounded-full"
          style={{
            background: 'radial-gradient(circle at 60% 65%, rgba(80,120,220,0.12) 0%, rgba(120,80,200,0.08) 40%, transparent 70%)',
          }}
          animate={{ rotate: [360, 0] }}
          transition={{ duration: 15, repeat: Infinity, ease: 'linear' }}
        />
        {/* Inner bright core */}
        <motion.div
          className="absolute inset-4 rounded-full"
          style={{
            background: 'radial-gradient(circle at 50% 50%, rgba(232,201,106,0.2) 0%, rgba(201,168,76,0.08) 50%, transparent 80%)',
          }}
          animate={{ scale: [0.9, 1.1, 0.9], opacity: [0.6, 1, 0.6] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
        />
        {/* Border ring */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            border: '1px solid rgba(201,168,76,0.15)',
            boxShadow: '0 0 20px rgba(201,168,76,0.06), inset 0 0 20px rgba(201,168,76,0.04)',
          }}
        />
      </motion.div>

      {/* Greeting with gold gradient text */}
      <motion.p
        className="text-2xl font-bold tracking-tight"
        style={{
          backgroundImage: 'linear-gradient(135deg, #C9A84C 0%, #FAFAF8 50%, #E8C96A 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.4 }}
      >
        আস্সালামু আলাইকুম
      </motion.p>
      <motion.p
        className="mt-3 max-w-xs text-[14px] leading-relaxed text-zinc-400"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18, duration: 0.4 }}
      >
        কিভাবে সাহায্য করতে পারি, স্যার?
      </motion.p>

      {/* Suggestion pills — staggered fade-in */}
      {onSuggestion && (
        <motion.div
          className="mt-10 flex w-full max-w-md flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:justify-center"
          initial="hidden"
          animate="visible"
          variants={{
            hidden: {},
            visible: { transition: { staggerChildren: 0.08, delayChildren: 0.3 } },
          }}
        >
          {SUGGESTIONS.map((s) => (
            <motion.button
              key={s}
              type="button"
              onClick={() => onSuggestion(s)}
              className="rounded-2xl border border-white/[0.06] bg-[rgba(20,20,28,0.5)] px-5 py-3 text-left text-[12.5px] text-zinc-400 backdrop-blur-md transition-all hover:border-[rgba(201,168,76,0.25)] hover:bg-[rgba(201,168,76,0.04)] hover:text-cream hover:shadow-[0_0_16px_rgba(201,168,76,0.08)] sm:text-center"
              variants={{
                hidden: { opacity: 0, y: 14 },
                visible: { opacity: 1, y: 0 },
              }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            >
              {s}
            </motion.button>
          ))}
        </motion.div>
      )}
    </div>
  )
}
