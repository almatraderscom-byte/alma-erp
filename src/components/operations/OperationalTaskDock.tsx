'use client'

import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui'
import type { OperationalTaskAssignmentDto } from '@/hooks/useOperationalTasks'
import {
  invalidateOperationalTasksCache,
  patchAssignmentAction,
} from '@/hooks/useOperationalTasks'
import { PLATFORM_Z } from '@/lib/platform-z-index'
import { opsStatusLabel, OPS_PRIORITY_BADGE } from '@/lib/operational-task-spotlight-client'

type Props = {
  businessId: string
  tasks: OperationalTaskAssignmentDto[]
  primary: OperationalTaskAssignmentDto | null
  heroOpen: boolean
  onReopen: () => void
  onUpdated: () => void | Promise<void>
}

export function OperationalTaskDock({
  businessId,
  tasks,
  primary,
  heroOpen,
  onReopen,
  onUpdated,
}: Props) {
  if (!primary || heroOpen || !tasks.length) return null

  const t = primary.task
  const badge = OPS_PRIORITY_BADGE[t.priority] || OPS_PRIORITY_BADGE.NORMAL
  const extra = tasks.length > 1 ? tasks.length - 1 : 0

  async function quickComplete() {
    try {
      await patchAssignmentAction(primary!.id, 'complete')
      invalidateOperationalTasksCache(businessId)
      toast.success('Task completed')
      await onUpdated()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const card = (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden rounded-2xl border border-gold-dim/35 bg-[#0a0a12]/95 shadow-[0_8px_32px_rgba(0,0,0,0.45)] backdrop-blur-md ring-1 ring-white/10"
    >
      <div className="flex items-stretch gap-0">
        <div className="w-1 shrink-0 bg-gradient-to-b from-gold via-gold/60 to-transparent" />
        <div className="min-w-0 flex-1 p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[9px] font-black uppercase tracking-[0.16em] text-gold/90">
                Active operation
              </p>
              <p className="mt-1 truncate text-sm font-black text-cream">{t.title}</p>
              <p className="mt-1 text-[10px] text-zinc-500">
                {opsStatusLabel(primary.status)}
                {extra > 0 ? ` · +${extra} more` : ''}
              </p>
            </div>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-black uppercase ${badge}`}>
              {t.priority}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="xs" variant="gold" className="min-h-[36px] flex-1" onClick={onReopen}>
              Open briefing
            </Button>
            <Button size="xs" variant="secondary" className="min-h-[36px]" onClick={() => void quickComplete()}>
              Complete
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  )

  return (
    <>
      <div className="md:hidden mb-4">{card}</div>
      <div
        className="pointer-events-none hidden md:block fixed right-5 w-[min(100vw-2.5rem,340px)]"
        style={{
          zIndex: PLATFORM_Z.opsTaskDock,
          bottom: 'calc(5.5rem + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <div className="pointer-events-auto">{card}</div>
      </div>
    </>
  )
}
