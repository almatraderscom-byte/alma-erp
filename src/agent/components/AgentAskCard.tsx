'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'

export interface AskCard {
  id: string
  question: string
  options: string[]
}

type AskPhase = 'idle' | 'answered'

interface AgentAskCardProps {
  card: AskCard
  onSelect: (option: string) => void
  disabled?: boolean
}

export default function AgentAskCard({ card, onSelect, disabled }: AgentAskCardProps) {
  const [phase, setPhase] = useState<AskPhase>('idle')
  const [selected, setSelected] = useState<string | null>(null)

  function handleSelect(opt: string) {
    if (phase !== 'idle' || disabled) return
    setSelected(opt)
    setPhase('answered')
    onSelect(opt)
  }

  if (phase === 'answered' && selected) {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="mt-3 rounded-[18px] border border-black/[0.07] bg-white px-4 py-3 text-sm shadow-card"
      >
        <p className="text-[12px] text-[#64748b]">{card.question}</p>
        <p className="mt-1 text-[12px] font-medium text-[#E07A5F]">
          ✓ নির্বাচন: {selected}
        </p>
      </motion.div>
    )
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="mt-3 rounded-[18px] border border-black/[0.07] bg-white p-4 text-sm shadow-card"
    >
      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-[#1a1a2e]">
        <span>❓</span>
        <span>একটি প্রশ্ন</span>
      </div>
      <p className="mb-3 text-[13px] leading-relaxed text-[#334155]">{card.question}</p>
      <div className="flex flex-col gap-2">
        {card.options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => handleSelect(opt)}
            disabled={disabled}
            className="rounded-xl border border-black/[0.08] bg-black/[0.02] px-4 py-2.5 text-left text-[13px] font-medium text-[#1a1a2e] transition-all hover:border-[#E07A5F]/40 hover:bg-[#E07A5F]/[0.06] active:scale-[0.99] disabled:pointer-events-none disabled:opacity-40"
          >
            {opt}
          </button>
        ))}
      </div>
    </motion.div>
  )
}
