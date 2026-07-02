'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'

/** Owner-facing AI model on/off panel — mirrors /api/assistant/models.
 *  OFF = that model is unusable app-wide; pinned chats auto-fall-back. */

interface ModelRow {
  id: string
  label: string
  provider: string
  enabled: boolean
}

const PROVIDER_TAG: Record<string, string> = {
  google: 'border-sky-300/40 bg-sky-400/10 text-sky-300',
  openrouter: 'border-violet-300/40 bg-violet-400/10 text-violet-300',
  anthropic: 'border-amber-300/40 bg-amber-400/10 text-amber-300',
}

export default function ModelTogglePanel() {
  const [models, setModels] = useState<ModelRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void fetch('/api/assistant/models')
      .then((r) => (r.ok ? (r.json() as Promise<{ models: ModelRow[] }>) : null))
      .then((d) => { if (d?.models) setModels(d.models) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function toggle(modelId: string, enabled: boolean) {
    if (saving || !models) return
    setSaving(true)
    const prev = models
    setModels(models.map((m) => (m.id === modelId ? { ...m, enabled } : m)))
    try {
      const res = await fetch('/api/assistant/models', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, enabled }),
      })
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; enabledMap?: Record<string, boolean>; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      if (data.enabledMap) {
        const map = data.enabledMap
        setModels((cur) => cur?.map((m) => ({ ...m, enabled: map[m.id] !== false })) ?? cur)
      }
      const label = prev.find((m) => m.id === modelId)?.label ?? modelId
      toast.success(enabled ? `${label} চালু ✅` : `${label} বন্ধ 🔴`)
    } catch (err) {
      setModels(prev)
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="safe-x mx-auto w-full max-w-5xl px-4 pt-4 md:px-6">
      <div className="alma-frost overflow-hidden rounded-[18px]">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 pt-4">
          <span className="text-[15px]">🧠</span>
          <h2 className="text-[15px] font-bold text-cream">AI Model on/off</h2>
          <span className="ml-auto rounded-full border border-border-subtle bg-white/[0.02] px-2 py-0.5 text-[10px] text-muted">
            মালিক নিয়ন্ত্রণ
          </span>
        </div>
        <p className="px-4 pb-3 pt-1 text-[12px] leading-relaxed text-muted">
          OFF করলে সেই model পুরো সিস্টেমে বন্ধ — pinned chat-ও অটো Gemini/DeepSeek-এ চলে যাবে।
        </p>

        {/* Model rows */}
        <div className="border-t border-border-subtle px-4 pb-4 pt-1.5">
          {loading && <p className="py-2 text-[12px] text-muted">লোড হচ্ছে…</p>}
          {!loading && !models && <p className="py-2 text-[12px] text-muted">Model তালিকা আনা যায়নি।</p>}
          {models?.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-[13px] font-medium text-cream">{m.label}</p>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${
                    PROVIDER_TAG[m.provider] ?? 'border-border-subtle bg-white/[0.02] text-muted'
                  }`}
                >
                  {m.provider}
                </span>
              </div>
              <Toggle
                on={m.enabled}
                disabled={loading || saving}
                onChange={(on) => void toggle(m.id, on)}
                label={m.label}
              />
            </div>
          ))}
        </div>
      </div>
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
