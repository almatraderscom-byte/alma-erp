'use client'

/**
 * Chat mode picker — "how may the agent work in this chat".
 *
 * Owner ask 2026-07-25 (Claude-Code-style mode menu). Sits next to the model
 * chip, mirrors its interaction exactly, and persists per conversation so a mode
 * survives reload and applies to every later message in that chat.
 *
 * There is deliberately no "bypass permissions" entry: money, publishing and
 * staff messaging live behind approval cards in this app, and a blanket bypass is
 * the one switch that turns a mistake into an irreversible one. "Ask me less" is
 * served by the autonomy ladder and per-family grants instead.
 */

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { CHAT_MODES, CHAT_MODE_META, type ChatMode } from '@/agent/lib/chat-mode'

const MODE_ICON: Record<ChatMode, string> = {
  auto: '⚡',
  direct: '➡️',
  plan: '📋',
  plan_drive: '🔄',
}

interface AgentModeSelectorProps {
  conversationId: string | null
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
  disabled?: boolean
}

export default function AgentModeSelector({
  conversationId,
  mode,
  onModeChange,
  disabled = false,
}: AgentModeSelectorProps) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  async function pick(next: ChatMode) {
    setOpen(false)
    if (next === mode) return
    onModeChange(next)
    if (!conversationId) return // new chat — the mode rides with the first send
    setSaving(true)
    try {
      const res = await fetch(`/api/assistant/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatMode: next }),
      })
      if (!res.ok) throw new Error('mode_update_failed')
    } catch {
      onModeChange(mode) // never leave the chip claiming a mode the server rejected
    } finally {
      setSaving(false)
    }
  }

  const meta = CHAT_MODE_META[mode]

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled || saving}
        onClick={() => setOpen((v) => !v)}
        title={meta.hint}
        className={cn(
          'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-all',
          mode === 'auto'
            ? 'border-border text-muted hover:bg-white/[0.04] hover:text-cream'
            : 'border-[#E07A5F]/40 bg-[#E07A5F]/[0.08] text-[#E07A5F]',
          open && 'bg-white/[0.05]',
          (disabled || saving) && 'opacity-50',
        )}
      >
        <span className="truncate">{saving ? '…' : `${MODE_ICON[mode]} ${meta.label}`}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="opacity-40"><path d="M6 9l6 6 6-6"/></svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1.5 w-64 overflow-hidden rounded-xl border border-border bg-card shadow-[0_-8px_30px_rgba(0,0,0,0.18)] backdrop-blur-xl">
          <div className="border-b border-border-subtle px-3 py-2 text-[10px] text-muted">
            কাজটা কীভাবে হবে — যেকোনো সময় বদলাতে পারবেন
          </div>
          {CHAT_MODES.map((m) => {
            const info = CHAT_MODE_META[m]
            return (
              <button
                key={m}
                type="button"
                onClick={() => void pick(m)}
                className={cn(
                  'flex w-full items-start justify-between gap-2 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]',
                  m === mode ? 'text-[#E07A5F]' : 'text-muted-hi',
                )}
              >
                <span className="flex min-w-0 flex-col">
                  <span className={cn('text-[12px]', m === mode && 'font-semibold')}>
                    {MODE_ICON[m]} {info.label}
                  </span>
                  <span className="text-[10px] leading-snug text-muted">{info.hint}</span>
                </span>
                {m === mode && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="mt-1 shrink-0"><path d="M20 6L9 17l-5-5"/></svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
