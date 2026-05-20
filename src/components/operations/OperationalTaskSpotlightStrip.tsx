'use client'

import type { OperationalTaskAssignmentDto } from '@/hooks/useOperationalTasks'

const PRIORITY_DOT: Record<string, string> = {
  LOW: 'bg-emerald-400',
  NORMAL: 'bg-sky-400',
  HIGH: 'bg-amber-400',
  CRITICAL: 'bg-red-400',
}

type Props = {
  tasks: OperationalTaskAssignmentDto[]
  loading?: boolean
  onOpenSpotlight: (assignment: OperationalTaskAssignmentDto) => void
}

export function OperationalTaskSpotlightStrip({ tasks, loading, onOpenSpotlight }: Props) {
  if (loading) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 animate-pulse h-24" />
    )
  }
  if (!tasks.length) return null

  return (
    <div className="rounded-2xl border border-gold-dim/25 bg-gradient-to-br from-gold/10 via-[#0c0c12] to-black/40 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Active operations</p>
        <span className="text-[10px] text-zinc-500">{tasks.length} open</span>
      </div>
      <ul className="mt-3 space-y-2">
        {tasks.slice(0, 4).map(a => (
          <li key={a.id}>
            <button
              type="button"
              className="flex w-full items-start gap-3 rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-left transition hover:border-gold/30 hover:bg-black/50"
              onClick={() => onOpenSpotlight(a)}
            >
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[a.task.priority] || PRIORITY_DOT.NORMAL}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold text-cream">{a.task.title}</span>
                <span className="text-[10px] text-zinc-500 uppercase">{a.status.replace(/_/g, ' ')}</span>
              </span>
              <span className="shrink-0 text-[10px] font-bold text-gold">View →</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
