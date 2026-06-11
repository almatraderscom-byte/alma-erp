'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
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
      setPhase(decision === 'approve' ? 'approved' : 'rejected')
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

  if (phase === 'loading') {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="mt-3 flex min-h-[140px] items-center justify-center rounded-xl border border-yellow-500/30 bg-zinc-950/90 p-6"
      >
        <AgentSparkleLoader label={loadingLabel} size="lg" />
      </motion.div>
    )
  }

  if (phase === 'approved') {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className="mt-3 rounded-xl border border-green-500/30 bg-green-950/25 px-4 py-5 text-center text-sm"
      >
        <motion.span
          className="text-3xl"
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 14 }}
        >
          ✅
        </motion.span>
        <p className="mt-2 text-sm font-semibold text-green-400">অনুমোদিত হয়েছে</p>
        <p className="mt-1 text-xs text-zinc-500">স্টাফদের কাছে টাস্ক পাঠানো হচ্ছে…</p>
      </motion.div>
    )
  }

  if (phase === 'rejected') {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className="mt-3 rounded-xl border border-red-500/30 bg-red-950/25 px-4 py-5 text-center text-sm"
      >
        <motion.span
          className="text-3xl"
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 14 }}
        >
          ❌
        </motion.span>
        <p className="mt-2 text-sm font-semibold text-red-400">বাতিল করা হয়েছে</p>
      </motion.div>
    )
  }

  return (
    <motion.div
      layout
      className="mt-3 rounded-xl border border-yellow-500/40 bg-yellow-950/30 p-4 text-sm"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
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
          className="flex-1 rounded-lg bg-green-600 px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-green-500"
        >
          ✓ Approve
        </button>
        <button
          type="button"
          onClick={() => resolve('reject')}
          className="flex-1 rounded-lg bg-red-700 px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-red-600"
        >
          ✗ Reject
        </button>
      </div>
    </motion.div>
  )
}
