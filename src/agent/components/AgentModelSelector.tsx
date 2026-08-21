'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const DEFAULT_MODEL_ID = 'claude-sonnet-4-6'
const AUTO_MODEL_ID = 'auto'
/** Sentinel the API understands as "clear the stored level". */
const AUTO_EFFORT = 'auto'

type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

type ModelOption = {
  id: string
  label: string
  provider: 'anthropic' | 'google' | 'openai' | 'openrouter' | 'xai'
  default?: boolean
  /** Levels this model REALLY accepts (server-side registry, effort.ts). */
  effortLevels?: EffortLevel[]
  /** What the provider does when no level is sent — shown as the Auto hint. */
  effortDefault?: EffortLevel | null
}

/** Owner-facing labels. Order = the neutral scale, cheapest first. */
const EFFORT_ORDER: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'দ্রুত',
  medium: 'স্বাভাবিক',
  high: 'বেশি',
  xhigh: 'আরও বেশি',
  max: 'সর্বোচ্চ',
}
const EFFORT_EN: Record<EffortLevel, string> = {
  low: 'Low', medium: 'Normal', high: 'High', xhigh: 'Extra high', max: 'Max',
}

/**
 * Levels to offer for the CURRENT pick.
 *
 * On a concrete model: exactly that model's real list (Gemini stops at 'বেশি',
 * Sonnet 4.6 has no 'আরও বেশি') — nothing is offered that its API would reject.
 *
 * On Auto: the union, because the head can be any of them and Boss must still be
 * able to say "Max". The honesty comes from saying so out loud — the footer
 * spells out that a head without that level runs its own ceiling instead, which
 * is exactly what the server's clamp does (down, never up).
 */
function levelsFor(models: ModelOption[], modelId: string): EffortLevel[] {
  if (modelId !== AUTO_MODEL_ID) {
    return models.find((m) => m.id === modelId)?.effortLevels ?? []
  }
  const offered = new Set(models.flatMap((m) => m.effortLevels ?? []))
  return EFFORT_ORDER.filter((lvl) => offered.has(lvl))
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  google: 'Google',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  xai: 'xAI',
}

interface AgentModelSelectorProps {
  conversationId: string | null
  modelId: string
  onModelChange: (modelId: string) => void
  /** 'auto' or a level — the chat's stored thinking level. */
  effortLevel?: string
  onEffortChange?: (effortLevel: string) => void
  disabled?: boolean
}

export default function AgentModelSelector({
  conversationId,
  modelId,
  onModelChange,
  effortLevel = 'auto',
  onEffortChange,
  disabled = false,
}: AgentModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<ModelOption[]>([])
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void fetch('/api/assistant/models')
      .then(async (res) => (res.ok ? res.json() as Promise<{ models: ModelOption[] }> : null))
      .then((data) => {
        if (data?.models?.length) setModels(data.models)
        else setModels([{ id: DEFAULT_MODEL_ID, label: 'Claude Sonnet 4.6', provider: 'anthropic', default: true }])
      })
      .catch(() => {
        setModels([{ id: DEFAULT_MODEL_ID, label: 'Claude Sonnet 4.6', provider: 'anthropic', default: true }])
      })
  }, [])

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const isAuto = modelId === AUTO_MODEL_ID
  const active = models.find((m) => m.id === modelId)
  const levels = levelsFor(models, modelId)
  const activeEffort = levels.includes(effortLevel as EffortLevel) ? (effortLevel as EffortLevel) : null
  const label = isAuto ? 'Auto' : (active?.label ?? 'Claude Sonnet 4.6')
  // The pill carries the level too, so the depth is visible without opening the
  // menu — a setting that costs money must not be invisible while it is on.
  const pillLabel = activeEffort ? `${label} · ${EFFORT_EN[activeEffort]}` : label

  async function pick(nextId: string) {
    setOpen(false)
    if (nextId === modelId) return
    onModelChange(nextId)
    if (!conversationId) return
    setLoading(true)
    try {
      const res = await fetch(`/api/assistant/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: nextId }),
      })
      if (!res.ok) throw new Error('model_update_failed')
    } catch {
      onModelChange(modelId)
    } finally {
      setLoading(false)
    }
  }

  /**
   * The level is stored on the CONVERSATION, like the model — one PATCH, and the
   * optimistic state rolls back if the write fails, so the pill can never show a
   * depth the server is not actually running.
   */
  async function pickEffort(next: string) {
    if (!onEffortChange) return
    const previous = effortLevel
    if (next === previous) return
    onEffortChange(next)
    if (!conversationId) return
    setLoading(true)
    try {
      const res = await fetch(`/api/assistant/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ effortLevel: next }),
      })
      if (!res.ok) throw new Error('effort_update_failed')
    } catch {
      onEffortChange(previous)
    } finally {
      setLoading(false)
    }
  }

  const grouped = models.reduce<Record<string, ModelOption[]>>((acc, m) => {
    acc[m.provider] = acc[m.provider] ?? []
    acc[m.provider].push(m)
    return acc
  }, {})

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled || loading}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[13px] font-medium transition-all',
          open ? 'bg-white/[0.05] text-cream' : 'text-muted hover:bg-white/[0.04] hover:text-cream',
          (disabled || loading) && 'opacity-50',
        )}
      >
        <span className="truncate">{loading ? '…' : pillLabel}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="opacity-40"><path d="M6 9l6 6 6-6"/></svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1.5 w-56 overflow-hidden rounded-xl border border-border bg-card/80 shadow-[0_-8px_30px_rgba(0,0,0,0.12)]">
          <div className="border-b border-border-subtle px-3 py-2 text-[10px] text-muted">
            Auto = সিস্টেম নিজে বেছে নেবে · নাহলে যেটা select করবেন সেই model-ই চলবে
          </div>
          <button
            type="button"
            onClick={() => void pick(AUTO_MODEL_ID)}
            className={cn(
              'flex w-full items-center justify-between px-3 py-2.5 text-left text-[12px] transition-colors hover:bg-white/[0.03]',
              isAuto ? 'text-[#E07A5F] font-medium' : 'text-muted-hi',
            )}
          >
            <span className="flex flex-col">
              <span>⚡ Auto (সিস্টেম বেছে নেবে)</span>
              <span className="text-[10px] text-muted">রুটিন → সস্তা · sensitive → Gemini Pro</span>
            </span>
            {isAuto && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
            )}
          </button>
          {Object.entries(grouped).map(([provider, items]) => (
            <div key={provider}>
              <div className="px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                {PROVIDER_LABELS[provider] ?? provider}
              </div>
              {items.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => void pick(m.id)}
                  className={cn(
                    'flex w-full items-center justify-between px-3 py-2 text-left text-[12px] transition-colors hover:bg-white/[0.03]',
                    m.id === modelId ? 'text-[#E07A5F] font-medium' : 'text-muted-hi',
                  )}
                >
                  <span>{m.label}</span>
                  {m.id === modelId && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
                  )}
                </button>
              ))}
            </div>
          ))}
          {onEffortChange && levels.length > 0 && (
            <div className="border-t border-border-subtle">
              <div className="px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                Thinking level
              </div>
              <div className="flex flex-wrap gap-1 px-3 pb-3 pt-1">
                <button
                  type="button"
                  onClick={() => void pickEffort(AUTO_EFFORT)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                    !activeEffort
                      ? 'border-[#E07A5F] text-[#E07A5F]'
                      : 'border-border text-muted hover:text-cream',
                  )}
                >
                  Auto
                </button>
                {levels.map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => void pickEffort(lvl)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                      activeEffort === lvl
                        ? 'border-[#E07A5F] text-[#E07A5F]'
                        : 'border-border text-muted hover:text-cream',
                    )}
                  >
                    {EFFORT_EN[lvl]} · {EFFORT_LABELS[lvl]}
                  </button>
                ))}
              </div>
              <div className="px-3 pb-2.5 text-[10px] leading-relaxed text-muted">
                {!activeEffort
                  ? `Auto = মডেলের নিজের default${active?.effortDefault ? ` (${EFFORT_EN[active.effortDefault]})` : ''}`
                  : isAuto
                    ? 'যত বেশি level, তত বেশি ভাবে (খরচ ও সময় বাড়ে)। যে model-এ এই level নেই, সেখানে তার সর্বোচ্চতে নেমে চলবে — যেমন Gemini-তে High।'
                    : 'যত বেশি level, তত বেশি ভাবে — উত্তর ভালো হয়, খরচ ও সময় বাড়ে।'}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
