'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import AgentSparkleLoader from './AgentSparkleLoader'

export interface PendingAction {
  id: string
  summary: string
  costEstimate?: number
}

type CardPhase = 'idle' | 'loading' | 'approved' | 'rejected'

interface AgentConfirmCardProps {
  action: PendingAction
  onResolved: (status: 'approved' | 'rejected') => void
}

export default function AgentConfirmCard({ action, onResolved }: AgentConfirmCardProps) {
  const [phase, setPhase] = useState<CardPhase>('idle')
  const [loadingDecision, setLoadingDecision] = useState<'approve' | 'reject' | null>(null)

  async function resolve(decision: 'approve' | 'reject') {
    if (phase !== 'idle') return
    setPhase('loading')
    setLoadingDecision(decision)
    try {
      const res = await fetch(`/api/assistant/actions/${action.id}/${decision}`, {
        method: 'POST',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      const next = decision === 'approve' ? 'approved' : 'rejected'
      setPhase(next)
      toast.success(decision === 'approve' ? 'অনুমোদিত ✓' : 'বাতিল করা হয়েছে')
      onResolved(decision === 'approve' ? 'approved' : 'rejected')
    } catch (err) {
      toast.error(`সমস্যা: ${err instanceof Error ? err.message : String(err)}`)
      setPhase('idle')
      setLoadingDecision(null)
    }
  }

  const loadingLabel =
    loadingDecision === 'approve'
      ? 'অনুমোদন প্রক্রিয়া হচ্ছে…'
      : loadingDecision === 'reject'
        ? 'বাতিল করা হচ্ছে…'
        : 'প্রক্রিয়া হচ্ছে…'

  return (
    <motion.div
      layout
      className="relative mt-3 overflow-hidden rounded-xl border border-yellow-500/40 bg-yellow-950/30 p-4 text-sm"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <AnimatePresence mode="wait">
        {phase === 'loading' && (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 rounded-xl bg-zinc-950/88 backdrop-blur-sm"
          >
            <AgentSparkleLoader label={loadingLabel} size="lg" />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        {phase === 'approved' ? (
          <motion.div
            key="approved"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-2 py-4 text-center"
          >
            <motion.span
              className="text-3xl"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 14 }}
            >
              ✅
            </motion.span>
            <p className="text-sm font-semibold text-green-400">অনুমোদিত হয়েছে</p>
            <p className="text-xs text-zinc-500">স্টাফদের কাছে টাস্ক পাঠানো হচ্ছে…</p>
          </motion.div>
        ) : phase === 'rejected' ? (
          <motion.div
            key="rejected"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-2 py-4 text-center"
          >
            <motion.span
              className="text-3xl"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 14 }}
            >
              ❌
            </motion.span>
            <p className="text-sm font-semibold text-red-400">বাতিল করা হয়েছে</p>
          </motion.div>
        ) : (
          <motion.div
            key="idle"
            animate={{ opacity: phase === 'loading' ? 0.35 : 1 }}
            transition={{ duration: 0.2 }}
          >
            <div className="mb-1 flex items-center gap-2 font-semibold text-yellow-400">
              <span>⚠️</span>
              <span>অনুমোদন প্রয়োজন</span>
              {action.costEstimate != null && action.costEstimate > 0 && (
                <span className="ml-auto text-xs font-normal text-yellow-300">
                  আনুমানিক খরচ: ৳{action.costEstimate.toFixed(2)}
                </span>
              )}
            </div>
            <pre className="mb-3 whitespace-pre-wrap font-sans text-xs leading-relaxed text-gray-200">
              {action.summary}
            </pre>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => resolve('approve')}
                disabled={phase !== 'idle'}
                className="flex-1 rounded-lg bg-green-600 px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-green-500 disabled:pointer-events-none disabled:opacity-40"
              >
                ✓ Approve
              </button>
              <button
                type="button"
                onClick={() => resolve('reject')}
                disabled={phase !== 'idle'}
                className="flex-1 rounded-lg bg-red-700 px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:pointer-events-none disabled:opacity-40"
              >
                ✗ Reject
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
