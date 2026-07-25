'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Fetch one console endpoint, optionally on a timer. Every sub-page needs the same three
 * things — data, a loading flag and an error that is shown rather than swallowed — and a
 * poll that keeps running after the page is gone is a leak, so the mounted flag is here
 * once instead of in six components.
 */
export function useJson<T>(url: string, pollMs?: number) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch(url, { cache: 'no-store' })
      const body = (await res.json()) as T & { ok?: boolean; error?: string }
      if (!alive.current) return
      if (!res.ok || body.ok === false) { setError(body.error ?? `HTTP ${res.status}`); return }
      setError(null)
      setData(body)
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [url])

  useEffect(() => {
    alive.current = true
    setLoading(true)
    void load()
    const t = pollMs ? setInterval(() => void load(), pollMs) : null
    return () => { alive.current = false; if (t) clearInterval(t) }
  }, [load, pollMs])

  return { data, error, loading, reload: load }
}
