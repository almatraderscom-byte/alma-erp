'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AgentSparkleLoader from './AgentSparkleLoader'

export interface AskCard {
  id: string
  question: string
  options: string[]
}

interface AgentAskCardProps {
  card: AskCard
  onSelect: (option: string) => void
  disabled?: boolean
}

export default function AgentAskCard({ card, onSelect, disabled }: AgentAskCardProps) {
  const [selecting, setSelecting] = useState<string | null>(null)

  function handleSelect(opt: string) {
    if (selecting || disabled) return
    setSelecting(opt)
    onSelect(opt)
  }

  return (
    <motion.div
      layout
      className="relative mt-3 overflow-hidden rounded-xl border border-blue-500/40 bg-blue-950/30 p-4 text-sm"
    >
      <AnimatePresence>
        {selecting && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-zinc-950/88 backdrop-blur-sm"
          >
            <AgentSparkleLoader label="উত্তর পাঠানো হচ্ছে…" size="md" />
          </motion.div>
        )}
      </AnimatePresence>

      <div className={selecting ? 'opacity-35' : undefined}>
        <div className="mb-2 flex items-center gap-2 font-semibold text-blue-300">
          <span>❓</span>
          <span>একটি প্রশ্ন</span>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-gray-200">{card.question}</p>
        <div className="flex flex-col gap-2">
          {card.options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => handleSelect(opt)}
              disabled={disabled || selecting !== null}
              className="rounded-lg border border-blue-500/30 bg-blue-900/40 px-4 py-2.5 text-left text-xs font-medium text-blue-100 transition-colors hover:bg-blue-800/50 disabled:pointer-events-none disabled:opacity-40"
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  )
}
