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
  const [abroadOff, setAbroadOff] = useState<boolean | null>(null)
  const [abroadSaving, setAbroadSaving] = useState(false)
  const [abroadErr, setAbroadErr] = useState<string | null>(null)

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

  const loadAbroad = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/salah/abroad-calls', { cache: 'no-store' })
      if (!res.ok) throw new Error('load failed')
      const data = await res.json() as { off: boolean }
      setAbroadOff(data.off)
      setAbroadErr(null)
    } catch {
      setAbroadErr('টগল লোড হয়নি')
    }
  }, [])

  async function toggleAbroad() {
    if (abroadOff === null || abroadSaving) return
    const next = !abroadOff
    setAbroadSaving(true)
    setAbroadErr(null)
    try {
      const res = await fetch('/api/assistant/salah/abroad-calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ off: next }),
      })
      if (!res.ok) throw new Error('save failed')
      const data = await res.json() as { off: boolean }
      setAbroadOff(data.off)
    } catch {
      setAbroadErr('সেভ হয়নি — আবার চেষ্টা করুন')
    } finally {
      setAbroadSaving(false)
    }
  }

  useEffect(() => {
    if (open && !cfg) void load()
    if (open && abroadOff === null) void loadAbroad()
  }, [open, cfg, load, abroadOff, loadAbroad])

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
    <div className="rounded-xl border border-border-subtle bg-card/80 overflow-hidden shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-bold text-cream hover:bg-white/[0.02] transition-colors"
      >
        <span>🕌 নামাজের সময় (৩×৫ ওয়াক্ত)</span>
        <span className={cn(
          'text-[#E07A5F] transition-transform duration-200',
          open && 'rotate-180',
        )}>▼</span>
      </button>

      {open && (
        <div className="border-t border-border-subtle px-4 py-4">
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-card/60 px-3 py-2.5">
            <div>
              <p className="text-xs font-semibold text-cream">🌍 দেশের বাইরে আছি — ফোন কলে দেবে না</p>
              <p className="mt-0.5 text-[10px] text-muted">
                চালু থাকলে এজেন্ট BD নম্বরে কোনো কল দেবে না (নামাজের কলসহ)। Telegram/notification আগের মতোই আসবে।
              </p>
              {abroadErr && <p className="mt-0.5 text-[10px] txt-neg">{abroadErr}</p>}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={abroadOff === true}
              aria-label="দেশের বাইরে — ফোন কল বন্ধ"
              onClick={() => void toggleAbroad()}
              disabled={abroadOff === null || abroadSaving}
              className={cn(
                'relative h-6 w-11 shrink-0 rounded-full transition-colors',
                abroadOff ? 'bg-[#E07A5F]' : 'bg-white/10',
                (abroadOff === null || abroadSaving) && 'opacity-50',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all',
                  abroadOff ? 'left-[22px]' : 'left-0.5',
                )}
              />
            </button>
          </div>

          <p className="mb-4 text-[10px] text-muted">
            আযান · জামাত · ওয়াক্ত শেষ — HH:MM (২৪ঘ) Dhaka। জুম্মায় যোহর আযান ১:০০ কোডে থাকে।
          </p>

          {!cfg ? (
            <p className="text-xs text-muted">লোড হচ্ছে…</p>
          ) : (
            <div className="space-y-4">
              {WAQT_ORDER.map((waqt) => (
                <div key={waqt} className="grid gap-2 sm:grid-cols-4 sm:items-end rounded-lg bg-transparent p-2">
                  <div className="text-xs font-semibold text-cream sm:pb-2">{WAQT_LABELS[waqt]}</div>
                  {(['azan', 'prayer', 'end'] as const).map((field) => (
                    <label key={field} className="block text-[10px] text-muted">
                      {FIELD_LABELS[field]}
                      <input
                        type="time"
                        value={cfg[waqt][field].length === 5 ? cfg[waqt][field] : cfg[waqt][field]}
                        onChange={(e) => patch(waqt, field, e.target.value)}
                        className="mt-0.5 w-full rounded-lg border border-border bg-card/80 px-2 py-1.5 text-sm text-cream focus:outline-none focus:border-[#E07A5F]/40 transition-all"
                      />
                    </label>
                  ))}
                </div>
              ))}

              <div className="flex flex-wrap items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                  className={cn(
                    'rounded-lg border border-[#E07A5F]/25 bg-[#E07A5F]/[0.08] px-4 py-2 text-xs font-semibold text-[#E07A5F] transition-all',
                    saving
                      ? 'opacity-50'
                      : 'hover:bg-[#E07A5F]/15',
                  )}
                >
                  {saving ? 'সেভ…' : '💾 সেভ করুন'}
                </button>
                {ok && <span className="text-xs txt-pos font-medium">✓ সেভ হয়েছে</span>}
                {err && <span className="text-xs txt-neg">{err}</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
