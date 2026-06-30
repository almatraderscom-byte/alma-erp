'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'

/**
 * Two quick-reply buttons under the conscience-nudge "জামাতে পড়লেন নাকি একা?"
 * question. Tapping saves the answer DETERMINISTICALLY via a no-LLM endpoint (a
 * free-typed reply was sometimes missed by the model), so the answer always
 * lands. The agent's warm acknowledgement is persisted server-side; the active
 * thread poll surfaces it, and `onAnswered` nudges a faster refresh.
 */
export function JamaatQuickReply({
  conversationId,
  onAnswered,
}: {
  conversationId: string
  onAnswered?: () => void
}) {
  const [busy, setBusy] = useState<'jamaat' | 'alone' | null>(null)
  const [done, setDone] = useState<'jamaat' | 'alone' | null>(null)

  async function choose(answer: 'jamaat' | 'alone') {
    if (busy || done) return
    setBusy(answer)
    try {
      const res = await fetch('/api/assistant/salah/jamaat-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, answer }),
      })
      if (res.ok) {
        setDone(answer)
        onAnswered?.()
      }
    } catch {
      /* leave buttons active so the owner can retry */
    } finally {
      setBusy(null)
    }
  }

  if (done) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="mt-3 inline-flex items-center gap-2 rounded-xl border border-[#81B29A]/40 bg-[#81B29A]/[0.10] px-3.5 py-2 text-[12px] font-semibold text-[#81B29A]"
      >
        ✓ {done === 'jamaat' ? 'জামাতে পড়েছেন' : 'একা পড়েছেন'} — সংরক্ষিত
      </motion.div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="mt-3 flex flex-wrap gap-2"
    >
      <button
        type="button"
        onClick={() => void choose('jamaat')}
        disabled={!!busy}
        className="rounded-xl border border-[#E07A5F]/35 bg-[#E07A5F]/[0.07] px-4 py-2.5 text-[13px] font-semibold text-cream transition-all hover:border-[#E07A5F]/60 hover:bg-[#E07A5F]/[0.12] active:scale-[0.98] disabled:opacity-50"
      >
        🕌 জামাতে পড়েছি
      </button>
      <button
        type="button"
        onClick={() => void choose('alone')}
        disabled={!!busy}
        className="rounded-xl border border-border bg-white/[0.03] px-4 py-2.5 text-[13px] font-semibold text-muted-hi transition-all hover:border-border-strong hover:bg-white/[0.06] active:scale-[0.98] disabled:opacity-50"
      >
        🤲 একা পড়েছি
      </button>
    </motion.div>
  )
}
