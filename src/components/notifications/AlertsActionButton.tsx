'use client'

import { useNotificationShell } from '@/contexts/NotificationShellContext'
import { cn } from '@/lib/utils'

/**
 * In-flow Alerts control for page headers (never fixed — avoids overlapping page actions).
 */
export function AlertsActionButton({ className }: { className?: string }) {
  const { unread, criticalUnacked, openPanel } = useNotificationShell()

  return (
    <button
      type="button"
      onClick={openPanel}
      data-platform-alerts="true"
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-gold-dim/40',
        'bg-[#0b0b0f]/90 px-3 py-2 text-xs font-bold text-cream',
        'shadow-lg shadow-black/25 backdrop-blur transition-colors hover:border-gold-dim/60 hover:bg-gold/10',
        'max-w-full',
        className,
      )}
      aria-label="Open notification center"
    >
      <span className="whitespace-nowrap">Alerts</span>
      {unread > 0 && (
        <span className="shrink-0 rounded-full bg-gold px-2 py-0.5 text-[10px] font-black text-black">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
      {criticalUnacked > 0 && (
        <span className="shrink-0 rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-black text-white">
          {criticalUnacked}
        </span>
      )}
    </button>
  )
}
