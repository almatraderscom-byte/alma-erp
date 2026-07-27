'use client'

/**
 * Permission mode picker — "how MUCH may the agent do without me".
 *
 * The second axis, beside AgentModeSelector's "how does it work" (owner ask
 * 2026-07-27). Same interaction on purpose: he already knows how the other chip
 * behaves, and two chips that behave differently would be a third thing to learn.
 *
 * The one line worth reading twice is in the footer of the menu, and it is true
 * in every mode: money movement and permission changes are his, always. That is
 * enforced by the risk-tier ceiling in the policy kernel, not by this component
 * — the chip only chooses among things the kernel already allows.
 */

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  PERMISSION_MODES,
  PERMISSION_MODE_META,
  type PermissionMode,
} from '@/agent/lib/permission-mode'

const MODE_ICON: Record<PermissionMode, string> = {
  plan: '📋',
  careful: '🛡️',
  standard: '⚖️',
  supervised: '👁️',
  elevated: '⏱️',
}

interface AgentPermissionSelectorProps {
  conversationId: string | null
  mode: PermissionMode
  onModeChange: (mode: PermissionMode) => void
  disabled?: boolean
}

export default function AgentPermissionSelector({
  conversationId,
  mode,
  onModeChange,
  disabled = false,
}: AgentPermissionSelectorProps) {
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

  async function pick(next: PermissionMode) {
    setOpen(false)
    if (next === mode) return
    onModeChange(next)
    if (!conversationId) return // new chat — the mode rides with the first send
    setSaving(true)
    try {
      const res = await fetch(`/api/assistant/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissionMode: next }),
      })
      if (!res.ok) throw new Error('permission_mode_update_failed')
    } catch {
      // Never leave the chip claiming a permission the server did not accept —
      // believing the agent is restrained when it is not is the worst outcome here.
      onModeChange(mode)
    } finally {
      setSaving(false)
    }
  }

  const meta = PERMISSION_MODE_META[mode]

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled || saving}
        onClick={() => setOpen((v) => !v)}
        title={meta.hint}
        className={cn(
          'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-all',
          mode === 'standard'
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
        <div className="absolute bottom-full left-0 z-50 mb-1.5 w-72 overflow-hidden rounded-xl border border-border bg-card shadow-[0_-8px_30px_rgba(0,0,0,0.18)] backdrop-blur-xl">
          <div className="border-b border-border-subtle px-3 py-2 text-[10px] text-muted">
            আমার অনুমোদন কতটুকু লাগবে — যেকোনো সময় বদলাতে পারবেন
          </div>
          {PERMISSION_MODES.map((m) => {
            const info = PERMISSION_MODE_META[m]
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
          <div className="border-t border-border-subtle px-3 py-2 text-[10px] leading-snug text-muted">
            যে মোডেই থাকুন — টাকা সরানো ও নিরাপত্তার কাজ সবসময় আপনার হাতেই থাকবে।
          </div>
        </div>
      )}
    </div>
  )
}
