'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const DEFAULT_MODEL_ID = 'claude-sonnet-4-6'
const AUTO_MODEL_ID = 'auto'

type ModelOption = {
  id: string
  label: string
  provider: 'anthropic' | 'google' | 'openai' | 'openrouter'
  default?: boolean
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  google: 'Google',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
}

interface AgentModelSelectorProps {
  conversationId: string | null
  modelId: string
  onModelChange: (modelId: string) => void
  disabled?: boolean
}

export default function AgentModelSelector({
  conversationId,
  modelId,
  onModelChange,
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
  const label = isAuto ? 'Auto' : (active?.label ?? 'Claude Sonnet 4.6')

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
        <span className="truncate">{loading ? '…' : label}</span>
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
              <span className="text-[10px] text-muted">রুটিন → সস্তা · sensitive → Sonnet</span>
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
        </div>
      )}
    </div>
  )
}
