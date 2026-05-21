'use client'

import { useCallback, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import {
  safeFetchJson,
  safeFetchJsonOrThrow,
  safeFetchJsonWithToast,
  type FetchState,
  type SafeFetchOptions,
  type SafeFetchResult,
} from '@/lib/safe-fetch'

export { safeFetchJsonOrThrow, safeFetchJsonWithToast }
import type { ApiErrorShape } from '@/lib/safe-api-response'

export type { FetchState }

type RunOptions = SafeFetchOptions & {
  /** Show toast on failure (default true). */
  toastOnError?: boolean
  /** Block concurrent runs (default true). */
  singleFlight?: boolean
  /** Label for retrying state (second attempt). */
  isRetry?: boolean
}

/**
 * Client fetch with idle | loading | success | failed | retrying states.
 */
export function useSafeFetch<T = Record<string, unknown>>() {
  const [state, setState] = useState<FetchState>('idle')
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiErrorShape | null>(null)
  const [status, setStatus] = useState(0)
  const inflightRef = useRef(false)

  const reset = useCallback(() => {
    setState('idle')
    setData(null)
    setError(null)
    setStatus(0)
    inflightRef.current = false
  }, [])

  const run = useCallback(
    async (url: string, options: RunOptions = {}): Promise<SafeFetchResult<T>> => {
      const {
        toastOnError = true,
        singleFlight = true,
        isRetry = false,
        ...fetchInit
      } = options

      if (singleFlight && inflightRef.current) {
        return {
          ok: false,
          status: 0,
          state: 'failed',
          parseError: false,
          error: { code: 'in_flight', message: 'Request already in progress' },
        }
      }

      inflightRef.current = true
      setState(isRetry ? 'retrying' : 'loading')
      setError(null)

      const result = await safeFetchJson<T>(url, fetchInit)
      inflightRef.current = false
      setStatus(result.status)

      if (result.ok) {
        setState('success')
        setData(result.data)
        setError(null)
      } else {
        setState('failed')
        setError(result.error)
        if (toastOnError) toast.error(result.error.message)
      }

      return result
    },
    [],
  )

  const isLoading = state === 'loading' || state === 'retrying'
  const isFailed = state === 'failed'
  const isSuccess = state === 'success'

  return {
    state,
    data,
    error,
    status,
    isLoading,
    isFailed,
    isSuccess,
    run,
    reset,
    setData,
  }
}

