'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { MonitorWarning, StaffMonitorRow, StaffMonitorData } from '@/agent/lib/staff-monitor-types'

type Alert = {
  id: string
  severity: 'critical' | 'warn' | 'info'
  title: string
  detail?: string
  action?: { label: string; onClick: () => void }
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' })
}

export function MonitorAlertPanel({ data, isLive, onEscalate, escalating }: {
  data: StaffMonitorData
  isLive: boolean
  onEscalate: (m: StaffMonitorRow) => void
  escalating: string | null
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const alerts: Alert[] = []

  const systemErrors = (data.warnings ?? []).filter(w => w.kind.startsWith('duty_') || w.kind === 'worker_heartbeat')
  const otherWarnings = (data.warnings ?? []).filter(w => !w.kind.startsWith('duty_') && w.kind !== 'worker_heartbeat')

  systemErrors.forEach((w, i) => {
    alerts.push({
      id: `sys-${w.kind}-${i}`,
      severity: w.severity === 'critical' ? 'critical' : 'warn',
      title: w.message,
      detail: w.kind === 'worker_heartbeat' ? 'Fix: SSH to VPS → pm2 restart agent-worker' :
              w.kind === 'duty_failed' ? 'Click the failed duty to retrigger' :
              w.kind === 'duty_missed' ? 'Duty was not run in its time window' : undefined,
    })
  })

  otherWarnings.forEach((w, i) => {
    alerts.push({
      id: `warn-${w.kind}-${i}`,
      severity: w.severity === 'critical' ? 'critical' : 'warn',
      title: w.message,
    })
  })

  if (isLive && (data.failures?.length ?? 0) > 0) {
    alerts.push({
      id: 'delivery-failures',
      severity: 'warn',
      title: `${data.failures.length} delivery failure${data.failures.length > 1 ? 's' : ''} detected`,
      detail: data.failures.slice(0, 2).map(f => `${f.staffName}: ${f.errorReason ?? 'unknown'}`).join(' · '),
    })
  }

  if (isLive && (data.unackedMessages?.length ?? 0) > 3) {
    alerts.push({
      id: 'many-unacked',
      severity: 'warn',
      title: `${data.unackedMessages.length} messages unseen by staff`,
      detail: 'Consider sending critical NTFY alerts',
    })
  }

  const visibleAlerts = alerts.filter(a => !dismissed.has(a.id))

  if (visibleAlerts.length === 0) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-1.5"
    >
      <AnimatePresence>
        {visibleAlerts.map(alert => (
          <motion.div
            key={alert.id}
            initial={{ opacity: 0, height: 0, y: -8 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: -8 }}
            transition={{ duration: 0.25 }}
            className={cn(
              'flex items-start gap-3 rounded-xl border px-4 py-2.5 text-[12px]',
              alert.severity === 'critical'
                ? 'border-red-500/30 bg-red-50 text-red-800 shadow-sm'
                : 'border-amber-500/25 bg-amber-50 text-amber-800',
            )}
          >
            <span className="mt-0.5 shrink-0 text-base">
              {alert.severity === 'critical' ? '🚨' : '⚠️'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{alert.title}</p>
              {alert.detail && <p className="mt-0.5 text-[10px] opacity-60">{alert.detail}</p>}
            </div>
            <button
              type="button"
              onClick={() => setDismissed(prev => new Set([...prev, alert.id]))}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-white/[0.04] hover:text-muted"
            >
              ✕
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </motion.div>
  )
}
