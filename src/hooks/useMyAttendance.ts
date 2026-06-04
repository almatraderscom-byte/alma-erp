'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AttendanceClientError } from '@/lib/attendance-errors'
import { fetchMyAttendance, logAttendanceClientFailure, type MyAttendancePayload } from '@/lib/attendance-client'
import {
  clearAttendancePortalCache,
  normalizeMyAttendancePayload,
  readAttendancePortalCache,
  writeAttendancePortalCache,
} from '@/lib/attendance-portal-normalize'

type State = {
  data: MyAttendancePayload | null
  loading: boolean
  error: AttendanceClientError | null
  lastOkAt: number | null
}

const DISABLED_ATTENDANCE_STATE: State = {
  data: null,
  loading: false,
  error: null,
  lastOkAt: null,
}

export function useMyAttendance(businessId: string, employeeId: string | null, enabled: boolean) {
  const [state, setState] = useState<State>({
    data: null,
    loading: Boolean(enabled),
    error: null,
    lastOkAt: null,
  })
  const requestId = useRef(0)
  const retryTimer = useRef<ReturnType<typeof setTimeout>>()
  const disabledStateAppliedRef = useRef(false)

  const load = useCallback(
    async (opts?: { silent?: boolean; force?: boolean; clearCache?: boolean }) => {
      if (!enabled) {
        if (!disabledStateAppliedRef.current) {
          setState(DISABLED_ATTENDANCE_STATE)
          disabledStateAppliedRef.current = true
        }
        return
      }
      if (!employeeId) {
        if (!disabledStateAppliedRef.current) {
          setState(DISABLED_ATTENDANCE_STATE)
          disabledStateAppliedRef.current = true
        }
        return
      }
      disabledStateAppliedRef.current = false

      if (opts?.clearCache) clearAttendancePortalCache(businessId, employeeId)

      if (!opts?.force && !opts?.silent) {
        const cached = readAttendancePortalCache(businessId, employeeId)
        if (cached) {
          setState(prev => ({
            data: cached,
            loading: false,
            error: null,
            lastOkAt: prev.lastOkAt ?? Date.now(),
          }))
        }
      }

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setState(prev => ({
          ...prev,
          loading: false,
          error: new AttendanceClientError(
            'NETWORK',
            'You are offline. Attendance will reload when connection returns.',
            0,
            true,
          ),
        }))
        return
      }

      const id = ++requestId.current
      if (!opts?.silent) {
        setState(prev => (prev.loading ? prev : { ...prev, loading: true, error: null }))
      }

      try {
        const payload = normalizeMyAttendancePayload(await fetchMyAttendance(businessId))
        if (id !== requestId.current) return
        writeAttendancePortalCache(businessId, employeeId, payload)
        if (payload.needsEmployeeLink) {
          setState({ data: payload, loading: false, error: null, lastOkAt: Date.now() })
          return
        }
        setState({ data: payload, loading: false, error: null, lastOkAt: Date.now() })
        if (retryTimer.current) {
          clearTimeout(retryTimer.current)
          retryTimer.current = undefined
        }
      } catch (e) {
        if (id !== requestId.current) return
        const err =
          e instanceof AttendanceClientError
            ? e
            : new AttendanceClientError('UNKNOWN', (e as Error).message || 'Could not load attendance', 0, true)

        logAttendanceClientFailure('attendance.load_failed', {
          code: err.code,
          status: err.status,
          message: err.message,
          businessId,
          employeeId,
        })

        setState(prev => ({
          ...prev,
          loading: false,
          error: err,
          data: opts?.silent && prev.lastOkAt ? prev.data : null,
        }))

        if (err.retryable && !retryTimer.current) {
          retryTimer.current = setTimeout(() => {
            retryTimer.current = undefined
            if (typeof document === 'undefined' || !document.hidden) {
              void load({ silent: true, force: true })
            }
          }, 8_000)
        }
      }
    },
    [businessId, employeeId, enabled],
  )

  useEffect(() => {
    void load()
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current)
    }
  }, [load])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisible = () => {
      if (document.visibilityState === 'visible' && enabled) void load({ silent: true, force: true })
    }
    const onOnline = () => {
      if (enabled) void load({ silent: false, force: true })
    }
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && enabled) void load({ silent: false, force: true })
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [enabled, load])

  const refetch = useCallback(
    (opts?: { clearCache?: boolean }) =>
      load({ silent: false, force: true, clearCache: opts?.clearCache }),
    [load],
  )

  return useMemo(
    () => ({
      attendance: state.data,
      loading: state.loading,
      error: state.error,
      lastOkAt: state.lastOkAt,
      refetch,
    }),
    [state.data, state.loading, state.error, state.lastOkAt, refetch],
  )
}
