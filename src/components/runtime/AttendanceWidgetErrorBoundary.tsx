'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'
import * as Sentry from '@sentry/nextjs'
import { logAttendanceWidgetRuntimeCrash } from '@/lib/attendance-widget-log'
import { logEvent } from '@/lib/logger'
import { readDeviceFlags } from '@/lib/runtime/device'
import { Button, Card } from '@/components/ui'

type Props = {
  children: ReactNode
  section?: string
  onRetry?: () => void
  userId?: string
  businessId?: string
  employeeId?: string
  attendanceRecordId?: string
}

type State = {
  hasError: boolean
  message: string
  digest: string
}

function parseCrashLocation(stack?: string) {
  if (!stack) return {}
  const line = stack.split('\n').find(l => l.includes('.tsx') || l.includes('.js')) || ''
  const match = /at\s+(\S+).*?([^/]+\.tsx:\d+|\([^)]+\))/i.exec(line)
  return {
    component: match?.[1] || undefined,
    hook: line.includes('use') ? line : undefined,
    property: line,
  }
}

export class AttendanceWidgetErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '', digest: '' }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error.message || 'Attendance widget failed',
      digest: error.stack?.split('\n')[1]?.trim() || '',
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const pathname = typeof window !== 'undefined' ? window.location.pathname : undefined
    const loc = parseCrashLocation(error.stack)
    const componentStack = info.componentStack?.split('\n').slice(0, 12).join(' | ')
    const device = readDeviceFlags()
    logAttendanceWidgetRuntimeCrash(error, {
      pathname,
      component: loc.component || this.props.section || 'portal_attendance',
      hook: loc.hook,
      property: loc.property,
      componentStack: componentStack?.slice(0, 800),
      userId: this.props.userId,
      businessId: this.props.businessId,
      employeeId: this.props.employeeId,
      hydrationState: 'render',
    })
    logEvent('error', 'portal.attendance.render_failed', {
      pathname,
      section: this.props.section || 'portal_attendance',
      message: error.message?.slice(0, 200),
      ios: device.ios,
      safari: device.safari,
      pwa: device.pwa,
      android: device.android,
      userId: this.props.userId,
      businessId: this.props.businessId,
      employeeId: this.props.employeeId,
      attendanceRecordId: this.props.attendanceRecordId,
    })
    try {
      Sentry.withScope(scope => {
        scope.setTag('boundary', this.props.section || 'portal_attendance')
        scope.setTag('surface', 'attendance_widget')
        scope.setTag('device.ios', String(device.ios))
        scope.setTag('device.safari', String(device.safari))
        scope.setTag('device.pwa', String(device.pwa))
        scope.setTag('device.android', String(device.android))
        if (this.props.businessId) scope.setTag('business.id', this.props.businessId)
        if (this.props.employeeId) scope.setTag('employee.id', this.props.employeeId)
        if (this.props.attendanceRecordId) scope.setTag('attendance.recordId', this.props.attendanceRecordId)
        scope.setContext('attendanceBoundary', {
          pathname,
          component: loc.component || this.props.section || 'portal_attendance',
          componentStack,
          userId: this.props.userId,
          businessId: this.props.businessId,
          employeeId: this.props.employeeId,
          attendanceRecordId: this.props.attendanceRecordId,
          device,
        })
        Sentry.captureException(error)
      })
    } catch {
      // Sentry init may be skipped on dev — never let it crash the boundary.
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <Card className="p-5 md:col-span-2 border-amber-500/25 bg-amber-500/5 space-y-3">
        <p className="text-[10px] font-black uppercase tracking-widest text-amber-400">
          Attendance unavailable
        </p>
        <p className="text-sm text-zinc-400">
          This part of My Desk could not load. Account details and the rest of the app still work.
        </p>
        {this.state.message && (
          <p className="rounded-lg border border-border bg-black/30 px-3 py-2 text-[10px] font-mono text-zinc-500 break-all">
            {this.state.message.slice(0, 200)}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              this.props.onRetry?.()
              this.setState({ hasError: false, message: '', digest: '' })
            }}
          >
            Retry attendance
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (typeof window !== 'undefined') window.location.reload()
            }}
          >
            Refresh app
          </Button>
        </div>
      </Card>
    )
  }
}

/** Isolates a subsection so one card cannot take down the whole widget. */
export class AttendanceSubsectionBoundary extends Component<
  { children: ReactNode; name: string },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const componentStack = info.componentStack?.split('\n').slice(0, 8).join(' | ')
    logAttendanceWidgetRuntimeCrash(error, {
      component: `attendance_subsection:${this.props.name}`,
      componentStack: componentStack?.slice(0, 600),
    })
    try {
      Sentry.withScope(scope => {
        scope.setTag('boundary', `attendance_subsection:${this.props.name}`)
        scope.setTag('surface', 'attendance_subsection')
        scope.setContext('attendanceSubsection', {
          name: this.props.name,
          componentStack,
        })
        Sentry.captureException(error)
      })
    } catch {
      // never let observability break the UI
    }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <p className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
        {this.props.name} could not load — other attendance info is still shown below.
      </p>
    )
  }
}
