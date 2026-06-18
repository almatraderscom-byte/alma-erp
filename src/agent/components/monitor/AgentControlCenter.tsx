'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import type { AgentControls, AutonomyMode } from '@/agent/lib/agent-controls'

/** Owner Control Center — the master switches for the whole agent.
 *  Pause + autonomy + capability on/off, each wired to real agent behavior. */
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

  async function patch(partial: Partial<AgentControls>, okMsg?: string) {
    if (saving || !controls) return
    setSaving(true)
    const prev = controls
    setControls({ ...controls, ...partial, capabilities: { ...controls.capabilities, ...(partial.capabilities ?? {}) } })
    try {
      const res = await fetch('/api/assistant/controls', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setControls((await res.json()) as AgentControls)
      if (okMsg) toast.success(okMsg)
    } catch (err) {
      setControls(prev)
      toast.error(`পরিবর্তন ব্যর্থ: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const paused = controls?.paused === true
  const autonomy = controls?.autonomy ?? 'ask'
  const caps = controls?.capabilities

  return (
    <div className="safe-x mx-auto w-full max-w-5xl px-4 pt-4 md:px-6">
      <div className="alma-frost overflow-hidden rounded-[18px]">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 pt-4">
          <span className="text-[15px]">🎛️</span>
          <h2 className="text-[15px] font-bold text-cream">কন্ট্রোল সেন্টার</h2>
          <span className="ml-auto rounded-full border border-border-subtle bg-white/[0.02] px-2 py-0.5 text-[10px] text-muted">
            মালিক নিয়ন্ত্রণ
          </span>
        </div>
        <p className="px-4 pb-3 pt-1 text-[12px] leading-relaxed text-muted">
          এখান থেকে পুরো Agent নিয়ন্ত্রণ করুন — থামানো, অটোনমি, এবং কোন কাজ চালু/বন্ধ থাকবে।
        </p>

        {/* Master Pause */}
        <div
          className={`flex items-center justify-between gap-3 border-t px-4 py-3.5 transition-colors ${
            paused ? 'border-red-200 bg-red-50/60' : 'border-border-subtle'
          }`}
        >
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[14px] font-semibold text-cream">
              <span>{paused ? '🛑' : '🟢'}</span>
              {paused ? 'Agent বন্ধ আছে' : 'Agent চালু আছে'}
            </p>
            <p className="mt-0.5 text-[12px] leading-snug text-muted">
              {paused
                ? 'এখন কোনো উত্তর বা কাজ করবে না (ওয়েব + টেলিগ্রাম)। চালু করতে সুইচ চাপুন।'
                : 'সব কিছু বন্ধ করতে চাইলে এই সুইচ দিয়ে সাথে সাথে থামান।'}
            </p>
          </div>
          <Toggle
            on={!paused}
            disabled={loading || saving}
            onChange={(on) => void patch({ paused: !on }, on ? 'Agent আবার চালু ✅' : 'Agent pause করা হয়েছে 🛑')}
            label={paused ? 'Agent চালু করুন' : 'Agent বন্ধ করুন'}
          />
        </div>

        {/* Autonomy */}
        <div className="border-t border-border-subtle px-4 py-3.5">
          <p className="text-[14px] font-semibold text-cream">অটোনমি — নিজে কতটা কাজ করবে</p>
          <p className="mt-0.5 mb-2.5 text-[12px] leading-snug text-muted">
            টাকা খরচ ও পাবলিক পোস্ট সবসময় আগে অনুমতি নেবে — যেকোনো মোডেই।
          </p>
          <div className="flex gap-1 rounded-full border border-border bg-white/[0.02] p-1">
            {AUTONOMY_OPTIONS.map((opt) => {
              const active = autonomy === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  disabled={loading || saving}
                  onClick={() => void patch({ autonomy: opt.value }, `অটোনমি: ${opt.label}`)}
                  className={`flex-1 rounded-full px-2 py-1.5 text-[12px] font-semibold transition-all disabled:opacity-50 ${
                    active ? 'bg-[#E07A5F] text-white shadow-sm' : 'text-muted hover:bg-white/[0.04]'
                  }`}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Capability switches */}
        <div className="border-t border-border-subtle px-4 pb-4 pt-3.5">
          <p className="mb-1 text-[14px] font-semibold text-cream">ফিচার চালু/বন্ধ</p>
          <p className="mb-2.5 text-[12px] leading-snug text-muted">
            বন্ধ করলে Agent ঐ কাজ করবে না — চাইলে আপনাকে চালু করতে বলবে (টোকেন নষ্ট করবে না)।
          </p>
          <CapabilityRow
            icon="🔎" label="ওয়েব রিসার্চ" hint="Oxylabs পেইড রিসার্চ"
            on={caps?.webResearch !== false} disabled={loading || saving}
            onChange={(on) => void patch({ capabilities: { webResearch: on } as AgentControls['capabilities'] }, on ? 'ওয়েব রিসার্চ চালু' : 'ওয়েব রিসার্চ বন্ধ')}
          />
          <CapabilityRow
            icon="📣" label="সোশ্যাল/ফেসবুক পোস্ট ও অ্যাড" hint="পোস্ট ও ক্যাম্পেইন"
            on={caps?.socialPosting !== false} disabled={loading || saving}
            onChange={(on) => void patch({ capabilities: { socialPosting: on } as AgentControls['capabilities'] }, on ? 'সোশ্যাল পোস্ট চালু' : 'সোশ্যাল পোস্ট বন্ধ')}
          />
          <CapabilityRow
            icon="🎨" label="ছবি ও ভিডিও জেনারেশন" hint="Nano Banana / VEO"
            on={caps?.imageVideoGen !== false} disabled={loading || saving}
            onChange={(on) => void patch({ capabilities: { imageVideoGen: on } as AgentControls['capabilities'] }, on ? 'ছবি/ভিডিও চালু' : 'ছবি/ভিডিও বন্ধ')}
          />
        </div>
      </div>
    </div>
  )
}

const AUTONOMY_OPTIONS: Array<{ value: AutonomyMode; label: string }> = [
  { value: 'ask', label: 'আগে জিজ্ঞেস' },
  { value: 'notify', label: 'করে জানাও' },
  { value: 'auto', label: 'স্বয়ংক্রিয়' },
]

function CapabilityRow({
  icon, label, hint, on, disabled, onChange,
}: {
  icon: string
  label: string
  hint: string
  on: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-[13px] font-medium text-cream">
          <span>{icon}</span>{label}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted">{hint}</p>
      </div>
      <Toggle on={on} disabled={disabled} onChange={onChange} label={label} />
    </div>
  )
}

function Toggle({
  on, disabled, onChange, label,
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
        on ? 'bg-[#81B29A]' : 'bg-white/15'
      }`}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 500, damping: 34 }}
        className={`inline-block h-6 w-6 rounded-full bg-card/80 shadow-[0_1px_3px_rgba(0,0,0,0.2)] ${
          on ? 'ml-[22px]' : 'ml-0.5'
        }`}
      />
    </button>
  )
}
