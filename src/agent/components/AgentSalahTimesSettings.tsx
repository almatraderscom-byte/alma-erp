'use client'

import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  WAQT_ORDER,
  WAQT_LABELS,
  type SalahTimeConfig,
  type WaqtKey,
} from '@/lib/salah/time-config-shared'

const FIELD_LABELS = {
  azan: 'আযান / ওয়াক্ত শুরু',
  prayer: 'জামাত',
  end: 'ওয়াক্ত শেষ',
} as const

export default function AgentSalahTimesSettings() {
  const [open, setOpen] = useState(false)
  const [cfg, setCfg] = useState<SalahTimeConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/salah-times', { cache: 'no-store' })
      if (!res.ok) throw new Error('load failed')
      const data = await res.json() as { config: SalahTimeConfig }
      setCfg(data.config)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load failed')
    }
  }, [])

  useEffect(() => {
    if (open && !cfg) void load()
  }, [open, cfg, load])

  function patch(waqt: WaqtKey, field: keyof SalahTimeConfig[WaqtKey], value: string) {
    if (!cfg) return
    setCfg({
      ...cfg,
      [waqt]: { ...cfg[waqt], [field]: value },
    })
    setOk(false)
  }

  async function save() {
    if (!cfg) return
    setSaving(true)
    setErr(null)
    setOk(false)
    try {
      const res = await fetch('/api/agent/salah-times', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: cfg }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error ?? 'save failed')
      }
      const data = await res.json() as { config: SalahTimeConfig }
      setCfg(data.config)
      setOk(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm font-bold text-zinc-300"
      >
        <span>🕌 নামাজের সময় (৩×৫ ওয়াক্ত)</span>
        <span className="text-xs text-muted">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-white/10 px-3 py-3">
          <p className="mb-3 text-[10px] text-muted">
            আযান · জামাত · ওয়াক্ত শেষ — HH:MM (২৪ঘ) Dhaka। জুম্মায় যোহর আযান ১:০০ কোডে থাকে।
          </p>

          {!cfg ? (
            <p className="text-xs text-zinc-500">লোড হচ্ছে…</p>
          ) : (
            <div className="space-y-3">
              {WAQT_ORDER.map((waqt) => (
                <div key={waqt} className="grid gap-2 sm:grid-cols-4 sm:items-end">
                  <div className="text-xs font-semibold text-cream sm:pb-2">{WAQT_LABELS[waqt]}</div>
                  {(['azan', 'prayer', 'end'] as const).map((field) => (
                    <label key={field} className="block text-[10px] text-muted">
                      {FIELD_LABELS[field]}
                      <input
                        type="time"
                        value={cfg[waqt][field].length === 5 ? cfg[waqt][field] : cfg[waqt][field]}
                        onChange={(e) => patch(waqt, field, e.target.value)}
                        className="mt-0.5 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-cream"
                      />
                    </label>
                  ))}
                </div>
              ))}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                  className={cn(
                    'rounded-lg border border-gold/40 px-3 py-1.5 text-xs font-semibold text-gold',
                    saving && 'opacity-50',
                  )}
                >
                  {saving ? 'সেভ…' : '💾 সেভ করুন'}
                </button>
                {ok && <span className="text-xs text-emerald-400">✓ সেভ হয়েছে</span>}
                {err && <span className="text-xs text-red-400">{err}</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
