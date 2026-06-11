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
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className="mt-3 rounded-xl border border-blue-500/25 bg-blue-950/20 px-4 py-3 text-sm"
      >
        <p className="text-xs text-zinc-500">{card.question}</p>
        <p className="mt-1 text-xs font-medium text-blue-200">
          ✅ নির্বাচন: {selected}
        </p>
      </motion.div>
    )
  }

  return (
    <motion.div
      layout
      className="mt-3 rounded-xl border border-blue-500/40 bg-blue-950/30 p-4 text-sm"
    >
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
            disabled={disabled}
            className="rounded-lg border border-blue-500/30 bg-blue-900/40 px-4 py-2.5 text-left text-xs font-medium text-blue-100 transition-colors hover:bg-blue-800/50 disabled:pointer-events-none disabled:opacity-40"
          >
            {opt}
          </button>
        ))}
      </div>
    </motion.div>
  )
}
