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

/**
 * Claude-app style question card: a clean floating card with the question on top,
 * the options as divider-separated list rows (radio select — not chunky boxed
 * buttons), an ALWAYS-present "Other" row with a free-text input so the owner can
 * share his own opinion, and a rounded Submit pill. Matches the assistant's own
 * AskUserQuestion card UI + feel.
 */
export default function AgentAskCard({ card, onSelect, disabled }: AgentAskCardProps) {
  const [phase, setPhase] = useState<AskPhase>('idle')
  const [chosen, setChosen] = useState<string | null>(null)
  const [otherActive, setOtherActive] = useState(false)
  const [otherText, setOtherText] = useState('')

  const answer = otherActive ? otherText.trim() : chosen
  const canSubmit = !disabled && !!answer

  function submit() {
    if (phase !== 'idle' || !canSubmit || !answer) return
    setPhase('answered')
    onSelect(answer)
  }

  if (phase === 'answered' && answer) {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="mt-3 rounded-3xl border border-white/[0.08] bg-card/80 px-5 py-4 text-sm shadow-float"
      >
        <p className="text-[13px] leading-snug text-muted">{card.question}</p>
        <p className="mt-1.5 text-[13px] font-semibold text-[#E07A5F]">✓ {answer}</p>
      </motion.div>
    )
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="mt-3 overflow-hidden rounded-3xl border border-white/[0.08] bg-card/80 shadow-float"
    >
      {/* Question title */}
      <div className="px-5 pb-2 pt-5">
        <p className="text-[15px] font-semibold leading-snug text-cream">{card.question}</p>
      </div>

      {/* Options — divider-separated list rows with a radio dot (Claude-app feel) */}
      <div className="mt-1 flex flex-col">
        {card.options.map((opt) => {
          const active = !otherActive && chosen === opt
          return (
            <button
              key={opt}
              type="button"
              onClick={() => { if (!disabled) { setChosen(opt); setOtherActive(false) } }}
              disabled={disabled}
              className="flex items-center gap-3 border-t border-white/[0.06] px-5 py-3.5 text-left transition-colors hover:bg-white/[0.03] active:bg-white/[0.05] disabled:pointer-events-none disabled:opacity-40"
            >
              <span
                className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border transition-colors ${
                  active ? 'border-[#E07A5F]' : 'border-white/25'
                }`}
              >
                {active && <span className="h-2.5 w-2.5 rounded-full bg-[#E07A5F]" />}
              </span>
              <span className="text-[14px] font-medium text-cream">{opt}</span>
            </button>
          )
        })}

        {/* Always-present "Other" row — owner can share his own opinion in free text */}
        <button
          type="button"
          onClick={() => { if (!disabled) { setOtherActive(true); setChosen(null) } }}
          disabled={disabled}
          className="flex items-center gap-3 border-t border-white/[0.06] px-5 py-3.5 text-left transition-colors hover:bg-white/[0.03] active:bg-white/[0.05] disabled:pointer-events-none disabled:opacity-40"
        >
          <span
            className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border transition-colors ${
              otherActive ? 'border-[#E07A5F]' : 'border-white/25'
            }`}
          >
            {otherActive && <span className="h-2.5 w-2.5 rounded-full bg-[#E07A5F]" />}
          </span>
          <span className={`text-[14px] font-medium ${otherActive ? 'text-cream' : 'text-muted'}`}>
            অন্য কিছু (নিজে লিখুন)
          </span>
        </button>

        {otherActive && (
          <div className="border-t border-white/[0.06] px-5 py-3">
            <input
              autoFocus
              type="text"
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
              disabled={disabled}
              placeholder="আপনার মতামত লিখুন…"
              className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-2.5 text-[14px] text-cream outline-none transition-colors placeholder:text-muted focus:border-[#E07A5F]/50 disabled:opacity-40"
            />
          </div>
        )}
      </div>

      {/* Submit pill */}
      <div className="flex justify-end px-5 py-4">
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="rounded-full bg-[#E07A5F] px-6 py-2.5 text-[13px] font-semibold text-white transition-all hover:brightness-110 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
        >
          Submit
        </button>
      </div>
    </motion.div>
  )
}
