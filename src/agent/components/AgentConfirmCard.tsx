'use client'

import { useState } from 'react'
import toast from 'react-hot-toast'

export interface PendingAction {
  id: string
  summary: string
  costEstimate?: number
}

interface AgentConfirmCardProps {
  action: PendingAction
  onResolved: (status: 'approved' | 'rejected') => void
}

export default function AgentConfirmCard({ action, onResolved }: AgentConfirmCardProps) {
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null)

  async function resolve(decision: 'approve' | 'reject') {
    setLoading(decision)
    try {
      const res = await fetch(`/api/assistant/actions/${action.id}/${decision}`, {
        method: 'POST',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      toast.success(decision === 'approve' ? 'Approved ✓' : 'Rejected')
      onResolved(decision === 'approve' ? 'approved' : 'rejected')
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      setLoading(null)
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-yellow-500/40 bg-yellow-950/30 p-4 text-sm">
      <div className="mb-1 flex items-center gap-2 text-yellow-400 font-semibold">
        <span>⚠️</span>
        <span>অনুমোদন প্রয়োজন</span>
        {action.costEstimate != null && action.costEstimate > 0 && (
          <span className="ml-auto text-xs text-yellow-300 font-normal">
            আনুমানিক খরচ: ৳{action.costEstimate.toFixed(2)}
          </span>
        )}
      </div>
      <pre className="mb-3 whitespace-pre-wrap text-gray-200 text-xs leading-relaxed font-sans">
        {action.summary}
      </pre>
      <div className="flex gap-2">
        <button
          onClick={() => resolve('approve')}
          disabled={loading !== null}
          className="flex-1 rounded-lg bg-green-600 px-4 py-2 text-white font-medium text-xs hover:bg-green-500 disabled:opacity-50 transition-colors"
        >
          {loading === 'approve' ? '⏳ Approving…' : '✓ Approve'}
        </button>
        <button
          onClick={() => resolve('reject')}
          disabled={loading !== null}
          className="flex-1 rounded-lg bg-red-700 px-4 py-2 text-white font-medium text-xs hover:bg-red-600 disabled:opacity-50 transition-colors"
        >
          {loading === 'reject' ? '⏳ Rejecting…' : '✗ Reject'}
        </button>
      </div>
    </div>
  )
}
