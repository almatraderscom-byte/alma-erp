'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const DEFAULT_MODEL_ID = 'claude-sonnet-4-6'

type ModelOption = {
  id: string
  label: string
  provider: 'anthropic' | 'google' | 'openai'
  default?: boolean
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  google: 'Google',
  openai: 'OpenAI',
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
      .then((data) => { if (data?.models) setModels(data.models) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const active = models.find((m) => m.id === modelId)
  const label = active?.label ?? 'Claude Sonnet 4.6'

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
          'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-all',
          open ? 'bg-white/[0.06] text-white/80' : 'text-white/60 hover:bg-white/[0.04] hover:text-white/80',
          (disabled || loading) && 'opacity-50',
        )}
      >
        <span className="truncate">{loading ? '…' : label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="opacity-40"><path d="M6 9l6 6 6-6"/></svg>
      </button>

      {open && (
        <div className="absolute left-1/2 top-full z-50 mt-1.5 w-56 -translate-x-1/2 overflow-hidden rounded-xl border border-white/[0.08] bg-[rgba(12,12,18,0.95)] shadow-[0_8px_30px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
          <div className="border-b border-white/[0.04] px-3 py-2 text-[10px] text-white/30">
            Sonnet = default ও সবচেয়ে নির্ভরযোগ্য
          </div>
          {Object.entries(grouped).map(([provider, items]) => (
            <div key={provider}>
              <div className="px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-white/25">
                {PROVIDER_LABELS[provider] ?? provider}
              </div>
              {items.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => void pick(m.id)}
                  className={cn(
                    'flex w-full items-center justify-between px-3 py-2 text-left text-[12px] transition-colors hover:bg-white/[0.05]',
                    m.id === modelId ? 'text-gold' : 'text-white/60',
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
