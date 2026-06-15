'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import AgentSparkleLoader from './AgentSparkleLoader'

export interface PendingAction {
  id: string
  summary: string
  costEstimate?: number
  actionType?: string
  entryCount?: number
  isFinance?: boolean
  isBatch?: boolean
}

type CardPhase = 'idle' | 'loading' | 'approved' | 'rejected' | 'editing'

interface AgentConfirmCardProps {
  action: PendingAction
  onResolved: (status: 'approved' | 'rejected') => void
  onUpdated?: (summary: string, meta: Partial<PendingAction>) => void
}

const EDIT_FIELDS: Record<string, string> = {
  amount: '💰 পরিমাণ',
  personName: '👤 নাম',
  category: '📂 ক্যাটাগরি',
  direction: '↔️ দিক',
  currency: '💱 মুদ্রা',
  note: '📝 নোট',
}

export default function AgentConfirmCard({ action, onResolved, onUpdated }: AgentConfirmCardProps) {
  const [phase, setPhase] = useState<CardPhase>('idle')
  const [loadingDecision, setLoadingDecision] = useState<'approve' | 'reject' | null>(null)
  const [summary, setSummary] = useState(action.summary)
  const [meta, setMeta] = useState(action)
  const [editField, setEditField] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editFields, setEditFields] = useState<string[]>([])

  useEffect(() => {
    if (!action.isFinance) return
    void fetch(`/api/assistant/actions/${action.id}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.editFields) setEditFields(d.editFields as string[]) })
      .catch(() => {})
  }, [action.id, action.isFinance])

  async function resolve(decision: 'approve' | 'reject') {
    if (phase !== 'idle' && phase !== 'editing') return
    setPhase('loading')
    setLoadingDecision(decision)
    try {
      const res = await fetch(`/api/assistant/actions/${action.id}/${decision}`, { method: 'POST' })
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

  async function removeBatchItem(index: number) {
    try {
      const res = await fetch(`/api/assistant/actions/${action.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeEntryIndex: index }),
      })
      const data = await res.json() as PendingAction & { summary: string; entryCount?: number; isBatch?: boolean }
      if (!res.ok) throw new Error(data.summary ?? 'patch failed')
      setSummary(data.summary)
      const next = { ...meta, summary: data.summary, entryCount: data.entryCount, isBatch: data.isBatch }
      setMeta(next)
      onUpdated?.(data.summary, next)
      toast.success(`#${index + 1} সরানো হয়েছে`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function applyEdit() {
    if (!editField || !editValue.trim()) return
    try {
      const res = await fetch(`/api/assistant/actions/${action.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: editField, value: editValue.trim() }),
      })
      const data = await res.json() as { summary: string; entryCount?: number; isBatch?: boolean }
      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'patch failed')
      setSummary(data.summary)
      setEditField(null)
      setEditValue('')
      setPhase('idle')
      onUpdated?.(data.summary, meta)
      toast.success('কার্ড আপডেট হয়েছে')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const loadingLabel =
    loadingDecision === 'approve' ? 'অনুমোদন প্রক্রিয়া হচ্ছে…'
      : loadingDecision === 'reject' ? 'বাতিল করা হচ্ছে…'
        : 'প্রক্রিয়া হচ্ছে…'

  if (phase === 'loading') {
    return (
      <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
        className="mt-3 flex min-h-[140px] items-center justify-center rounded-xl border border-[rgba(234,179,8,0.2)] bg-[rgba(20,18,10,0.6)] backdrop-blur-xl p-6">
        <AgentSparkleLoader label={loadingLabel} size="lg" />
      </motion.div>
    )
  }

  if (phase === 'approved') {
    return (
      <motion.div layout initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
        className="mt-3 rounded-xl border border-[rgba(34,197,94,0.25)] bg-[rgba(10,30,15,0.5)] backdrop-blur-xl px-4 py-5 text-center text-sm shadow-[0_0_20px_rgba(34,197,94,0.1)]">
        <span className="text-3xl">✅</span>
        <p className="mt-2 text-sm font-semibold text-green-400">অনুমোদিত হয়েছে</p>
      </motion.div>
    )
  }

  if (phase === 'rejected') {
    return (
      <motion.div layout initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
        className="mt-3 rounded-xl border border-[rgba(239,68,68,0.25)] bg-[rgba(30,10,10,0.5)] backdrop-blur-xl px-4 py-5 text-center text-sm shadow-[0_0_20px_rgba(239,68,68,0.1)]">
        <span className="text-3xl">❌</span>
        <p className="mt-2 text-sm font-semibold text-red-400">বাতিল করা হয়েছে</p>
      </motion.div>
    )
  }

  return (
    <motion.div layout className="mt-3 rounded-xl border border-[rgba(234,179,8,0.25)] bg-[rgba(30,25,10,0.5)] backdrop-blur-xl p-4 text-sm shadow-[0_0_20px_rgba(234,179,8,0.08)]"
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <div className="mb-1 flex items-center gap-2 font-semibold text-yellow-400">
        <span>⚠️</span>
        <span>অনুমোদন প্রয়োজন</span>
      </div>
      <pre className="mb-3 whitespace-pre-wrap font-sans text-xs leading-relaxed text-gray-200">{summary}</pre>

      {meta.actionType === 'oxylabs_spend' && meta.costEstimate != null && (
        <p className="mb-3 rounded-lg border border-amber-500/30 bg-[rgba(30,25,10,0.5)] backdrop-blur-md px-3 py-2 text-xs text-amber-200">
          Oxylabs prepaid credit: আনুমানিক <strong>{meta.costEstimate}</strong> ক্রেডিট খরচ হবে (USD নয়)।
          Reject করলে কোনো ক্রেডিট খরচ হবে না।
        </p>
      )}

      {meta.isBatch && (meta.entryCount ?? 0) > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {Array.from({ length: meta.entryCount! }, (_, i) => (
            <button key={i} type="button" onClick={() => void removeBatchItem(i)}
              className="rounded-lg border border-red-500/30 bg-[rgba(30,10,10,0.4)] backdrop-blur-md px-2 py-1 text-[10px] text-red-300 hover:bg-red-950/40">
              🗑️ {i + 1}
            </button>
          ))}
        </div>
      )}

      {phase === 'editing' && (
        <div className="mb-3 space-y-2 rounded-lg border border-white/[0.06] bg-[rgba(8,8,12,0.5)] backdrop-blur-md p-3">
          {!editField ? (
            <div className="flex flex-wrap gap-2">
              {(editFields.length ? editFields : Object.keys(EDIT_FIELDS)).map((f) => (
                <button key={f} type="button" onClick={() => setEditField(f)}
                  className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[10px] text-cream backdrop-blur-md hover:border-gold-dim/50 hover:bg-gold/5">
                  {EDIT_FIELDS[f] ?? f}
                </button>
              ))}
              <button type="button" onClick={() => setPhase('idle')}
                className="rounded-lg border border-white/[0.06] px-2 py-1 text-[10px] text-muted">বাতিল</button>
            </div>
          ) : (
            <>
              <p className="text-[10px] text-muted">{EDIT_FIELDS[editField] ?? editField} — নতুন মান:</p>
              <input value={editValue} onChange={(e) => setEditValue(e.target.value)}
                className="w-full rounded-lg border border-white/[0.06] bg-[rgba(20,20,28,0.5)] backdrop-blur-md px-2 py-1.5 text-xs text-cream focus:outline-none focus:border-gold-dim/60" />
              <button type="button" onClick={() => void applyEdit()}
                className="rounded-lg bg-gold/10 border border-gold-dim/30 px-3 py-1.5 text-[10px] text-gold-lt hover:bg-gold/20 hover:shadow-[0_0_8px_rgba(201,168,76,0.15)]">সংরক্ষণ</button>
            </>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={() => resolve('approve')}
          className="flex-1 rounded-lg border border-[rgba(34,197,94,0.3)] bg-[rgba(34,197,94,0.12)] backdrop-blur-md px-4 py-2.5 text-xs font-medium text-green-400 transition-all hover:bg-[rgba(34,197,94,0.2)] hover:shadow-[0_0_14px_rgba(34,197,94,0.2)]">
          {meta.isBatch ? '✅ সব Approve' : '✓ Approve'}
        </button>
        {meta.isFinance && (
          <button type="button" onClick={() => setPhase('editing')}
            className="flex-1 rounded-lg border border-[rgba(234,179,8,0.3)] bg-[rgba(234,179,8,0.1)] backdrop-blur-md px-4 py-2.5 text-xs font-medium text-amber-400 transition-all hover:bg-[rgba(234,179,8,0.2)] hover:shadow-[0_0_14px_rgba(234,179,8,0.2)]">
            ✏️ সংশোধন
          </button>
        )}
        <button type="button" onClick={() => resolve('reject')}
          className="flex-1 rounded-lg border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.1)] backdrop-blur-md px-4 py-2.5 text-xs font-medium text-red-400 transition-all hover:bg-[rgba(239,68,68,0.2)] hover:shadow-[0_0_14px_rgba(239,68,68,0.2)]">
          ✗ Reject
        </button>
      </div>
    </motion.div>
  )
}
