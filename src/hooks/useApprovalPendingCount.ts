'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { safeFetchJson } from '@/lib/safe-fetch'

const POLL_MS = 30_000

export default function useApprovalPendingCount() {
  const [count, setCount] = useState(0)
  const countRef = useRef(0)

  useEffect(() => {
    countRef.current = count
  }, [count])

  const refresh = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    try {
      const result = await safeFetchJson<{ totalPending?: number }>('/api/approvals?summary=1', {
        cache: 'no-store',
      })
      if (result.ok) {
        setCount(Number(result.data.totalPending || 0))
      }
    } catch {
      // Keep previous count on failure — do not reset to 0
      setCount(countRef.current)
    }
  }, [])

  useEffect(() => {
    void refresh()

    const onUpdated = () => {
      void refresh()
    }
    const onVisibility = () => {
      if (!document.hidden) void refresh()
    }

    window.addEventListener('alma:approvals-updated', onUpdated)
    document.addEventListener('visibilitychange', onVisibility)
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh()
    }, POLL_MS)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener('alma:approvals-updated', onUpdated)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  return { count, refresh }
}
