/**
 * Data-fetching primitives for Alma ERP.
 *
 * useQuery — fetch + poll + error state + manual refetch
 * useMutation — async action + loading + error + optimistic helper
 */
'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { APIError } from '@/lib/api'
import { subscribeMobileRefresh } from '@/lib/mobile-refresh'

// ── QueryState ────────────────────────────────────────────────────────────

export interface QueryState<T> {
  data:    T | null
  loading: boolean
  error:   string | null
  refetch: () => void
  /** True on the very first load (data is null and loading is true) */
  initialLoading: boolean
}

interface QueryOptions {
  /** Auto-refetch interval in ms. 0 = disabled. */
  pollMs?: number
  /** Skip the fetch entirely (e.g. when an id is null). */
  enabled?: boolean
  /** Optional short-lived client cache for expensive dashboard-style reads. */
  cacheKey?: string
  cacheMs?: number
  /** Called when the fetch succeeds. */
  onSuccess?: (data: unknown) => void
  /** Called when the fetch fails. */
  onError?: (err: string) => void
}

const queryCache = new Map<string, { value: unknown; expiresAt: number }>()

export function invalidateQueryCache(prefix?: string) {
  if (!prefix) {
    queryCache.clear()
    return
  }
  for (const key of queryCache.keys()) {
    if (key.startsWith(prefix)) queryCache.delete(key)
  }
}

/**
 * Generic data-fetching hook.
 *
 * @param fetcher  async function that returns T
 * @param deps     values that cause a refetch when they change (like useEffect deps)
 * @param opts     polling interval, enabled flag, callbacks
 */
export function useQuery<T>(
  fetcher: () => Promise<T | null>,
  deps: unknown[] = [],
  opts: QueryOptions = {}
): QueryState<T> {
  const [data,    setData]    = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  // Track whether we've ever completed a fetch
  const hasFetched = useRef(false)
  const timerRef   = useRef<ReturnType<typeof setInterval>>()
  const retryRef   = useRef<ReturnType<typeof setTimeout>>()
  // Prevent state updates after unmount
  const mounted    = useRef(true)
  const requestId  = useRef(0)

  const run = useCallback(async (silent = false, forceFresh = false) => {
    if (opts.enabled === false) { if (!silent) setLoading(false); return }
    const id = ++requestId.current
    const cacheKey = opts.cacheKey
    const cacheMs = opts.cacheMs ?? 0
    if (!forceFresh && cacheKey && cacheMs > 0) {
      const cached = queryCache.get(cacheKey)
      if (cached && cached.expiresAt > Date.now()) {
        setData(cached.value as T)
        hasFetched.current = true
        if (!silent) setLoading(false)
        return
      }
    }
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    try {
      const result = await fetcher()
      if (!mounted.current || id !== requestId.current) return
      if (result !== null) setData(result)
      if (cacheKey && cacheMs > 0 && result !== null) {
        queryCache.set(cacheKey, { value: result, expiresAt: Date.now() + cacheMs })
      }
      hasFetched.current = true
      setError(null)
      if (retryRef.current) {
        clearTimeout(retryRef.current)
        retryRef.current = undefined
      }
      opts.onSuccess?.(result)
    } catch (e) {
      if (!mounted.current || id !== requestId.current) return
      const msg = e instanceof APIError ? e.userMessage : (e as Error).message
      if (silent && hasFetched.current) {
        if (!retryRef.current && typeof navigator !== 'undefined' && navigator.onLine !== false) {
          retryRef.current = setTimeout(() => {
            retryRef.current = undefined
            if (mounted.current && (typeof document === 'undefined' || !document.hidden)) run(true, true)
          }, 5_000)
        }
        return
      }
      setError(msg)
      opts.onError?.(msg)
    } finally {
      if (mounted.current && id === requestId.current) setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    if (opts.enabled === false) return
    return subscribeMobileRefresh(() => {
      void run(false, true)
    })
  }, [run, opts.enabled])

  useEffect(() => {
    mounted.current = true
    run()
    if (opts.pollMs && opts.pollMs > 0) {
      timerRef.current = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return
        run(true)
      }, opts.pollMs)
    }
    return () => {
      mounted.current = false
      if (timerRef.current) clearInterval(timerRef.current)
      if (retryRef.current) clearTimeout(retryRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run])

  return {
    data,
    loading,
    error,
    refetch: () => run(false, true),
    initialLoading: !hasFetched.current && loading,
  }
}

// ── MutationState ─────────────────────────────────────────────────────────

export interface MutationState<TArgs extends unknown[], TResult> {
  mutate:  (...args: TArgs) => Promise<TResult | null>
  loading: boolean
  error:   string | null
  data:    TResult | null
  reset:   () => void
}

/**
 * Mutation hook for create/update/delete operations.
 *
 * @param fn  async function to call — receives typed args, returns TResult
 */
export function useMutation<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>
): MutationState<TArgs, TResult> {
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [data,    setData]    = useState<TResult | null>(null)
  const mounted = useRef(true)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const mutate = useCallback(async (...args: TArgs): Promise<TResult | null> => {
    setLoading(true); setError(null)
    try {
      const result = await fn(...args)
      if (mounted.current) setData(result)
      return result
    } catch (e) {
      const msg = e instanceof APIError ? e.userMessage : (e as Error).message
      if (mounted.current) setError(msg)
      return null
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [fn])

  const reset = useCallback(() => { setData(null); setError(null) }, [])

  return { mutate, loading, error, data, reset }
}

// ── Optimistic update helper ───────────────────────────────────────────────

/**
 * Wraps a mutation with optimistic local state.
 * Reverts on error.
 *
 * @example
 * const [optimistic, setOptimistic] = useState(order.status)
 * const { mutate } = useOptimistic(
 *   api.mutations.updateStatus,
 *   (status) => setOptimistic(status),
 *   () => setOptimistic(order.status)   // revert
 * )
 */
export function useOptimistic<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  onOptimistic: (...args: TArgs) => void,
  onRevert: () => void
): MutationState<TArgs, TResult> {
  const mutation = useMutation(fn)

  const wrappedMutate = useCallback(async (...args: TArgs) => {
    onOptimistic(...args)
    const result = await mutation.mutate(...args)
    if (!result) onRevert()
    return result
  }, [mutation.mutate, onOptimistic, onRevert])

  return { ...mutation, mutate: wrappedMutate }
}
