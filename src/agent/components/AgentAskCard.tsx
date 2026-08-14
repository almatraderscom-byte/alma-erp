'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { impactMedium, selection } from '@/lib/haptics'

export interface AskCard {
  id: string
  question: string
  options: string[]
  /** Multi-question group (Claude-Code-style batched card). When present with
   *  more than one entry, the card renders every question and submits ONE
   *  combined answer; question/options mirror the first entry for old paths. */
  questions?: Array<{ question: string; options: string[] }>
  /** Durable state from agent_ask_cards (poll/reload path). Absent on the live SSE path. */
  status?: string
  /** The answer recorded in the DB (tap or free text), when already answered. */
  selectedOption?: string | null
  /** Still 'pending' in the DB but the owner already replied by typing — render settled. */
  staleInChat?: boolean
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
  const [chosenByIndex, setChosenByIndex] = useState<Record<number, string | null>>({})
  const [otherActiveByIndex, setOtherActiveByIndex] = useState<Record<number, boolean>>({})
  const [otherTextByIndex, setOtherTextByIndex] = useState<Record<number, string>>({})

  // One rendering model for both shapes: a single question is a one-entry group.
  const group = card.questions && card.questions.length > 0
    ? card.questions
    : [{ question: card.question, options: card.options }]
  const multi = group.length > 1

  const answerFor = (i: number): string | null => {
    if (otherActiveByIndex[i]) {
      const t = (otherTextByIndex[i] ?? '').trim()
      return t || null
    }
    return chosenByIndex[i] ?? null
  }
  const allAnswers = group.map((_, i) => answerFor(i))
  const answer = multi
    ? (allAnswers.every(Boolean)
        ? group.map((entry, i) => `${entry.question} — ${allAnswers[i]}`).join('\n')
        : null)
    : allAnswers[0]
  const canSubmit = !disabled && !!answer

  // Durable state (poll/reload path): the card may arrive already settled — either
  // answered (tap/free text recorded in agent_ask_cards) or superseded, or still
  // 'pending' in the DB while the owner already replied by typing (staleInChat).
  // These render as a settled breadcrumb instead of re-arming an old question.
  const settledByServer =
    (card.status != null && card.status !== 'pending') || card.selectedOption != null

  function submit() {
    if (phase !== 'idle' || !canSubmit || !answer) return
    impactMedium()
    setPhase('answered')
    onSelect(answer)
  }

  if (settledByServer || (phase === 'answered' && answer)) {
    const shownAnswer = settledByServer ? card.selectedOption : answer
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="mt-3 rounded-3xl border border-white/[0.08] bg-card/80 px-5 py-4 text-sm shadow-float"
      >
        <p className="text-[13px] leading-snug text-muted">{card.question}</p>
        {shownAnswer ? (
          <p className="mt-1.5 text-[13px] font-semibold text-[#E07A5F]">✓ {shownAnswer}</p>
        ) : (
          <p className="mt-1.5 text-[13px] text-muted">উত্তর দেওয়া হয়েছে চ্যাটে</p>
        )}
      </motion.div>
    )
  }

  // Pending-but-stale: the owner already answered by typing in the chat. Show the
  // question as a quiet settled breadcrumb — never a live Submit for an old ask.
  if (card.staleInChat) {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="mt-3 rounded-3xl border border-white/[0.08] bg-card/80 px-5 py-4 text-sm shadow-float"
      >
        <p className="text-[13px] leading-snug text-muted">{card.question}</p>
        <p className="mt-1.5 text-[13px] text-muted">উত্তর দেওয়া হয়েছে চ্যাটে</p>
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
      {multi && (
        <div className="px-5 pt-4">
          <span className="rounded-full border border-[#E07A5F]/40 bg-[#E07A5F]/10 px-2.5 py-0.5 text-[11px] font-semibold text-[#E07A5F]">
            {group.length}টি প্রশ্ন — সব উত্তর দিয়ে একবারে পাঠান
          </span>
        </div>
      )}
      {group.map((entry, qi) => {
        const otherActive = !!otherActiveByIndex[qi]
        const chosen = chosenByIndex[qi] ?? null
        return (
          <div key={qi}>
            {/* Question title */}
            <div className={`px-5 pb-2 ${qi === 0 && !multi ? 'pt-5' : 'pt-4'}`}>
              <p className="text-[15px] font-semibold leading-snug text-cream">
                {multi ? `${qi + 1}. ${entry.question}` : entry.question}
              </p>
            </div>

            {/* Options — divider-separated list rows with a radio dot (Claude-app feel) */}
            <div className="mt-1 flex flex-col">
              {entry.options.map((opt, i) => {
                const active = !otherActive && chosen === opt
                // Boss must never have to guess what the agent itself would pick
                // (owner rule 2026-07-25): options[0] is the recommendation.
                const recommended = i === 0 && entry.options.length > 1
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => {
                      if (disabled) return
                      selection()
                      setChosenByIndex((m) => ({ ...m, [qi]: opt }))
                      setOtherActiveByIndex((m) => ({ ...m, [qi]: false }))
                    }}
                    disabled={disabled}
                    className="flex items-center gap-3 border-t border-white/[0.06] px-5 py-3.5 text-left transition-colors hover:bg-white/[0.03] active:bg-white/[0.05] disabled:pointer-events-none disabled:opacity-40"
                  >
                    <span
                      className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border transition-colors ${
                        active ? 'border-[#E07A5F]' : 'border-white/25'
                      }`}
                    >
                      {active && (
                        <motion.span
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                          className="h-2.5 w-2.5 rounded-full bg-[#E07A5F]"
                        />
                      )}
                    </span>
                    <span className="text-[14px] font-medium text-cream">{opt}</span>
                    {recommended && (
                      <span className="ml-auto shrink-0 rounded-full border border-[#E07A5F]/40 bg-[#E07A5F]/10 px-2 py-0.5 text-[11px] font-semibold text-[#E07A5F]">
                        প্রস্তাবিত
                      </span>
                    )}
                  </button>
                )
              })}

              {/* Always-present "Other" row — the owner's own words are a valid answer */}
              <button
                type="button"
                onClick={() => {
                  if (disabled) return
                  selection()
                  setOtherActiveByIndex((m) => ({ ...m, [qi]: true }))
                  setChosenByIndex((m) => ({ ...m, [qi]: null }))
                }}
                disabled={disabled}
                className="flex items-center gap-3 border-t border-white/[0.06] px-5 py-3.5 text-left transition-colors hover:bg-white/[0.03] active:bg-white/[0.05] disabled:pointer-events-none disabled:opacity-40"
              >
                <span
                  className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border transition-colors ${
                    otherActive ? 'border-[#E07A5F]' : 'border-white/25'
                  }`}
                >
                  {otherActive && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                      className="h-2.5 w-2.5 rounded-full bg-[#E07A5F]"
                    />
                  )}
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
                    value={otherTextByIndex[qi] ?? ''}
                    onChange={(e) => setOtherTextByIndex((m) => ({ ...m, [qi]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
                    disabled={disabled}
                    placeholder="আপনার মতামত লিখুন…"
                    className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-2.5 text-[14px] text-cream outline-none transition-colors placeholder:text-muted focus:border-[#E07A5F]/50 disabled:opacity-40"
                  />
                </div>
              )}
            </div>
          </div>
        )
      })}

      {/* Submit pill — one submission answers every question on the card */}
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
