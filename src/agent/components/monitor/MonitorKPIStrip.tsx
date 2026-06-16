'use client'

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { StaffMonitorData } from '@/agent/lib/staff-monitor-types'

type BrainStats = {
  memoryCount: number
  activePlaybookCount: number
  proposedPlaybookCount: number
  knowledgeCount: number
  lastKnowledgeBuild: string | null
  lastSessionSummary: string | null
  todayCostUsd: number
}

function AnimatedNumber({ value, prefix = '', suffix = '', className }: {
  value: number; prefix?: string; suffix?: string; className?: string
}) {
  const [display, setDisplay] = useState(0)
  const rafRef = useRef<number>(0)
  const startRef = useRef(0)
  const fromRef = useRef(0)

  useEffect(() => {
    fromRef.current = display
    startRef.current = performance.now()
    const duration = 800

    function tick(now: number) {
      const elapsed = now - startRef.current
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      setDisplay(Math.round(fromRef.current + (value - fromRef.current) * eased))
      if (progress < 1) rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return <span className={className}>{prefix}{display}{suffix}</span>
}

type KPIItem = {
  label: string
  value: number
  displayValue?: string
  sub: string
  color: string
  trend?: 'up' | 'down' | 'flat'
  pulse?: boolean
}

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } } }

export function MonitorKPIStrip({ data, brainStats }: {
  data: StaffMonitorData
  brainStats: BrainStats | null
}) {
  const totalDuties = (data.agentDuties ?? []).length
  const doneDuties = (data.agentDuties ?? []).filter(d => d.status === 'done').length
  const failedDuties = (data.agentDuties ?? []).filter(d => d.status === 'failed' || d.status === 'missed').length
  const pendingApprovals = data.pendingApprovals?.length ?? 0

  const kpis: KPIItem[] = [
    {
      label: 'Agent Duties',
      value: doneDuties,
      displayValue: `${doneDuties}/${totalDuties}`,
      sub: failedDuties > 0 ? `${failedDuties} failed` : 'on track',
      color: failedDuties > 0 ? 'text-red-500' : 'text-emerald-600',
      trend: failedDuties > 0 ? 'down' : 'up',
    },
    {
      label: 'Staff Active',
      value: data.staffSummaries?.length ?? 0,
      sub: 'tracked today',
      color: 'text-[#D4A84B]',
      trend: 'flat',
    },
    {
      label: 'Pending Ack',
      value: data.unackedMessages?.length ?? 0,
      sub: 'unseen msgs',
      color: (data.unackedMessages?.length ?? 0) > 0 ? 'text-amber-500' : 'text-emerald-600',
      pulse: (data.unackedMessages?.length ?? 0) > 0,
      trend: (data.unackedMessages?.length ?? 0) > 0 ? 'up' : 'flat',
    },
    {
      label: 'Approvals',
      value: pendingApprovals,
      sub: pendingApprovals > 0 ? 'waiting' : 'all clear',
      color: pendingApprovals > 0 ? 'text-amber-500' : 'text-emerald-600',
      pulse: pendingApprovals > 0,
    },
    {
      label: 'AI Cost',
      value: brainStats ? Math.round(brainStats.todayCostUsd * 100) : 0,
      displayValue: brainStats ? `$${brainStats.todayCostUsd.toFixed(2)}` : '—',
      sub: 'USD today',
      color: 'text-[#E07A5F]',
    },
    {
      label: 'Failures',
      value: data.failures?.length ?? 0,
      sub: 'delivery',
      color: (data.failures?.length ?? 0) > 0 ? 'text-red-500' : 'text-emerald-600',
      trend: (data.failures?.length ?? 0) > 0 ? 'down' : 'flat',
    },
  ]

  return (
    <motion.div
      variants={stagger}
      initial="hidden"
      animate="show"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
    >
      {kpis.map(kpi => (
        <motion.div
          key={kpi.label}
          variants={fadeUp}
          className={cn(
            'group relative overflow-hidden rounded-2xl border border-black/[0.06] bg-white px-3.5 py-3 shadow-sm',
            'transition-all duration-300 hover:border-black/[0.12] hover:shadow-md',
            kpi.pulse && 'animate-[pulse-status_2s_ease-in-out_infinite]',
          )}
        >
          <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-[#E07A5F]/[0.03] to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
          <div className="relative">
            <div className="flex items-center justify-between">
              <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-[#94a3b8]">{kpi.label}</p>
              {kpi.trend && (
                <span className={cn(
                  'text-[10px]',
                  kpi.trend === 'up' ? 'text-emerald-500' : kpi.trend === 'down' ? 'text-red-500' : 'text-[#94a3b8]',
                )}>
                  {kpi.trend === 'up' ? '↑' : kpi.trend === 'down' ? '↓' : '→'}
                </span>
              )}
            </div>
            <p className={cn('mt-1 text-2xl font-black tabular-nums tracking-tight', kpi.color)}>
              {kpi.displayValue ?? <AnimatedNumber value={kpi.value} />}
            </p>
            <p className="mt-0.5 text-[10px] text-[#94a3b8]">{kpi.sub}</p>
          </div>
        </motion.div>
      ))}
    </motion.div>
  )
}
