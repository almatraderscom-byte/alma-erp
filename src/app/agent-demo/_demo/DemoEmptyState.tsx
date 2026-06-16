'use client'

import { motion } from 'framer-motion'
import { DEMO_SUGGESTIONS } from './mock-data'

interface DemoEmptyStateProps {
  onSuggestion: (text: string) => void
}

export default function DemoEmptyState({ onSuggestion }: DemoEmptyStateProps) {
  return (
    <div className="flex flex-col px-4 py-8">
      <div className="mb-8 flex flex-col items-center text-center">
        <motion.div
          className="relative mb-3 flex h-44 w-full items-center justify-center"
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Soft ambient glow */}
          <motion.div
            className="absolute h-44 w-44 rounded-full blur-3xl"
            style={{
              background:
                'radial-gradient(circle, rgba(224,122,95,0.30) 0%, rgba(129,178,154,0.10) 55%, transparent 75%)',
            }}
            animate={{ opacity: [0.35, 0.7, 0.35], scale: [0.9, 1.1, 0.9] }}
            transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
          />
          {/* Rotating accent ring */}
          <motion.div
            className="absolute h-[164px] w-[164px] rounded-full"
            style={{
              background:
                'conic-gradient(from 0deg, transparent, rgba(224,122,95,0.35), transparent 40%)',
              mask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))',
              WebkitMask:
                'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))',
            }}
            animate={{ rotate: 360 }}
            transition={{ duration: 9, repeat: Infinity, ease: 'linear' }}
          />
          <motion.div
            className="relative flex h-[148px] w-[148px] items-center justify-center rounded-full"
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.96 }}
          >
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background:
                  'radial-gradient(circle at 35% 30%, #F6E6DF 0%, #E8B4A0 25%, #E07A5F 50%, #c45a42 85%)',
                boxShadow:
                  '0 12px 44px rgba(224,122,95,0.35), inset 0 -10px 28px rgba(0,0,0,0.08), inset 0 4px 16px rgba(255,255,255,0.35)',
              }}
            />
            <div
              className="absolute rounded-full"
              style={{
                width: 52,
                height: 34,
                top: 20,
                left: '50%',
                transform: 'translateX(-50%) rotate(-15deg)',
                background: 'radial-gradient(ellipse, rgba(255,255,255,0.55) 0%, transparent 70%)',
                filter: 'blur(5px)',
              }}
            />
            <svg
              className="relative z-10"
              width="30"
              height="30"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.15))' }}
              aria-hidden
            >
              <rect x="9" y="1" width="6" height="11" rx="3" />
              <path d="M19 10v2a7 7 0 01-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </motion.div>
        </motion.div>

        <motion.h1
          className="text-balance text-2xl font-bold text-[#1a1a2e]"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.4 }}
        >
          আস্‌সালামু আলাইকুম
        </motion.h1>
        <motion.p
          className="mt-2 max-w-sm text-pretty text-[14px] leading-relaxed text-[#64748b]"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.4 }}
        >
          আপনার ব্যবসার সহকারী। নিচে একটা প্রশ্ন বেছে নিন বা টাইপ করে শুরু করুন।
        </motion.p>
      </div>

      <motion.div
        className="mx-auto grid w-full max-w-lg grid-cols-1 gap-2.5 sm:grid-cols-2"
        initial="hidden"
        animate="visible"
        variants={{
          hidden: {},
          visible: { transition: { staggerChildren: 0.06, delayChildren: 0.25 } },
        }}
      >
        {DEMO_SUGGESTIONS.map((s) => (
          <motion.button
            key={s.text}
            type="button"
            variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0 } }}
            onClick={() => onSuggestion(s.text)}
            className="group flex items-center gap-3 rounded-2xl border border-black/[0.06] bg-white/80 px-4 py-3.5 text-left shadow-sm backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:border-[#E07A5F]/30 hover:bg-white hover:shadow-md active:translate-y-0"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#E07A5F]/[0.08] text-base transition-colors group-hover:bg-[#E07A5F]/[0.14]">
              {s.icon}
            </span>
            <span className="text-[13px] font-medium leading-snug text-[#1a1a2e]/85">{s.text}</span>
          </motion.button>
        ))}
      </motion.div>
    </div>
  )
}
