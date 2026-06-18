'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import type { AgentControls } from '@/agent/lib/agent-controls'

/** Owner Control Center — the master switches for the whole agent.
 *  Phase 1 ships the master Pause (fully wired). More switches land next. */
export default function AgentControlCenter() {
  const [controls, setControls] = useState<AgentControls | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void fetch('/api/assistant/controls')
      .then((r) => (r.ok ? (r.json() as Promise<AgentControls>) : null))
      .then((d) => { if (d) setControls(d) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function setPaused(paused: boolean) {
    if (saving) return
    setSaving(true)
    const prev = controls
    setControls((c) => (c ? { ...c, paused } : c)) // optimistic
    try {
      const res = await fetch('/api/assistant/controls', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const next = (await res.json()) as AgentControls
      setControls(next)
      toast.success(paused ? 'Agent pause করা হয়েছে 🛑' : 'Agent আবার চালু ✅')
    } catch (err) {
      setControls(prev) // rollback
      toast.error(`পরিবর্তন ব্যর্থ: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const paused = controls?.paused === true

  return (
    <div className="safe-x mx-auto w-full max-w-5xl px-4 pt-4 md:px-6">
      <div className="alma-frost overflow-hidden rounded-[18px]">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 pt-4">
          <span className="text-[15px]">🎛️</span>
          <h2 className="text-[15px] font-bold text-[#1a1a2e]">কন্ট্রোল সেন্টার</h2>
          <span className="ml-auto rounded-full border border-black/[0.06] bg-black/[0.02] px-2 py-0.5 text-[10px] text-[#94a3b8]">
            মালিক নিয়ন্ত্রণ
          </span>
        </div>
        <p className="px-4 pb-3 pt-1 text-[12px] leading-relaxed text-[#64748b]">
          এখান থেকে পুরো Agent নিয়ন্ত্রণ করুন। আরও সুইচ (অটোনমি, খরচ, পোস্টিং, ভয়েস) শীঘ্রই যোগ হবে।
        </p>

        {/* Master Pause */}
        <div
          className={`flex items-center justify-between gap-3 border-t px-4 py-3.5 transition-colors ${
            paused ? 'border-red-200 bg-red-50/60' : 'border-black/[0.06]'
          }`}
        >
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[14px] font-semibold text-[#1a1a2e]">
              <span>{paused ? '🛑' : '🟢'}</span>
              {paused ? 'Agent বন্ধ আছে' : 'Agent চালু আছে'}
            </p>
            <p className="mt-0.5 text-[12px] leading-snug text-[#64748b]">
              {paused
                ? 'এখন কোনো উত্তর বা কাজ করবে না (ওয়েব + টেলিগ্রাম)। চালু করতে সুইচ চাপুন।'
                : 'সব কিছু বন্ধ করতে চাইলে এই সুইচ দিয়ে সাথে সাথে থামান।'}
            </p>
          </div>
          <Toggle
            on={!paused}
            disabled={loading || saving}
            onChange={(on) => void setPaused(!on)}
            label={paused ? 'Agent চালু করুন' : 'Agent বন্ধ করুন'}
          />
        </div>
      </div>
    </div>
  )
}

function Toggle({
  on,
  disabled,
  onChange,
  label,
}: {
  on: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        on ? 'bg-[#81B29A]' : 'bg-black/15'
      }`}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 500, damping: 34 }}
        className={`inline-block h-6 w-6 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] ${
          on ? 'ml-[22px]' : 'ml-0.5'
        }`}
      />
    </button>
  )
}
