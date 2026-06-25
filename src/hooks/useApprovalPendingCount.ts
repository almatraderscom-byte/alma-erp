'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { safeFetchJson } from '@/lib/safe-fetch'

const POLL_MS = 30_000
const BACKOFF_MS = [5_000, 10_000, 20_000, 60_000]

function dispatchAuthFailure() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event('alma:auth-failure'))
}

/**
 * Agent-proposed actions (agent_pending_actions) live in a separate system from
 * ERP business approvals, but the owner wants them surfaced "ekhaner motoi" — so
 * their pending count folds into the same badge. Talks ONLY over HTTP, never
 * importing src/agent (one-way dependency rule). Any failure → 0, so a flaky
 * agent endpoint can never blank out the canonical ERP approval count.
 */
async function fetchAgentPendingCount(): Promise<number> {
  try {
    const result = await safeFetchJson<{ count?: number }>(
      '/api/assistant/actions?status=pending&limit=100',
      { cache: 'no-store' },
    )
    if (!result.ok) return 0
    return Number(result.data.count || 0)
  } catch {
    return 0
  }
}

export default function useApprovalPendingCount() {
  const { status: sessionStatus } = useSession()
  const [count, setCount] = useState(0)
  const countRef = useRef(0)
  const pausedRef = useRef(false)
  const backoffIndexRef = useRef(0)

  useEffect(() => {
    countRef.current = count
  }, [count])

  const refresh = useCallback(async (): Promise<'ok' | 'paused' | 'retry'> => {
    if (sessionStatus !== 'authenticated') return 'retry'
    if (pausedRef.current) return 'paused'
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'retry'

    try {
      // ERP approvals are the canonical/auth source — its 401 pauses polling.
      // Agent pending count rides alongside; it can't pause and can't error out
      // the badge (failure → 0, handled inside fetchAgentPendingCount).
      const [result, agentCount] = await Promise.all([
        safeFetchJson<{ totalPending?: number }>('/api/approvals?summary=1', {
          cache: 'no-store',
        }),
        fetchAgentPendingCount(),
      ])
      if (result.status === 401) {
        pausedRef.current = true
        dispatchAuthFailure()
        return 'paused'
      }
      if (!result.ok) {
        if (result.status >= 500 || result.status === 0) return 'retry'
        return 'retry'
      }
      backoffIndexRef.current = 0
      setCount(Number(result.data.totalPending || 0) + agentCount)
      return 'ok'
    } catch {
      setCount(countRef.current)
      return 'retry'
    }
  }, [sessionStatus])

  useEffect(() => {
    pausedRef.current = false
    backoffIndexRef.current = 0

    if (sessionStatus !== 'authenticated') return

    let cancelled = false
    let timer: number | undefined

    const schedule = (delayMs: number) => {
      if (cancelled) return
      timer = window.setTimeout(() => {
        void (async () => {
          if (cancelled || pausedRef.current) return
          if (document.hidden) {
            schedule(POLL_MS)
            return
          }
          const outcome = await refresh()
          if (cancelled || pausedRef.current) return
          if (outcome === 'paused') return
          let nextDelay = POLL_MS
          if (outcome === 'retry') {
            nextDelay = BACKOFF_MS[Math.min(backoffIndexRef.current, BACKOFF_MS.length - 1)]
            backoffIndexRef.current = Math.min(backoffIndexRef.current + 1, BACKOFF_MS.length - 1)
          } else if (outcome === 'ok') {
            backoffIndexRef.current = 0
          }
          schedule(nextDelay)
        })()
      }, delayMs)
    }

    void refresh()
    schedule(POLL_MS)

    const onUpdated = () => {
      if (!pausedRef.current && !document.hidden) void refresh()
    }
    const onVisibility = () => {
      if (!document.hidden && !pausedRef.current) void refresh()
    }

    window.addEventListener('alma:approvals-updated', onUpdated)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
      window.removeEventListener('alma:approvals-updated', onUpdated)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh, sessionStatus])

  return { count, refresh }
}
