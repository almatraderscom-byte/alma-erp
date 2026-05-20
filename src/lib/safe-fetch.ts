'use client'

import {
  readApiError,
  safeResponseJson,
  unwrapApiData,
  type ApiErrorShape,
} from '@/lib/safe-api-response'

export type FetchState = 'idle' | 'loading' | 'success' | 'failed' | 'retrying'

export type SafeFetchResult<T> =
  | { ok: true; data: T; status: number; state: 'success' }
  | {
      ok: false
      error: ApiErrorShape
      status: number
      state: 'failed'
      parseError: boolean
      rolledBack?: boolean
    }

export type SafeFetchOptions = RequestInit & {
  timeoutMs?: number
}

/**
 * Never throws on JSON parse failures. Unwraps { ok, data } or legacy flat payloads.
 */
export async function safeFetchJson<T = Record<string, unknown>>(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult<T>> {
  const { timeoutMs = 30_000, ...init } = options
  let res: Response
  try {
    if (timeoutMs > 0 && typeof AbortController !== 'undefined') {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        res = await fetch(url, { ...init, signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
    } else {
      res = await fetch(url, init)
    }
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError'
    return {
      ok: false,
      status: 0,
      state: 'failed',
      parseError: true,
      rolledBack: true,
      error: {
        code: aborted ? 'timeout' : 'network_error',
        message: aborted
          ? 'Request timed out. Check connection and retry.'
          : 'Network error. Check connection and retry.',
      },
    }
  }

  const parsed = await safeResponseJson<Record<string, unknown>>(res)
  const body = parsed.data

  if (!parsed.ok || parsed.parseError) {
    const err = readApiError(body)
    return {
      ok: false,
      status: parsed.status,
      state: 'failed',
      parseError: true,
      rolledBack: Boolean(body.rolledBack) || parsed.status >= 500,
      error: err,
    }
  }

  if (body.ok === false) {
    const err = readApiError(body)
    return {
      ok: false,
      status: res.status,
      state: 'failed',
      parseError: false,
      rolledBack: Boolean(body.rolledBack),
      error: err,
    }
  }

  if (!res.ok) {
    const err = readApiError(body)
    return {
      ok: false,
      status: res.status,
      state: 'failed',
      parseError: false,
      error: err,
    }
  }

  return {
    ok: true,
    status: res.status,
    state: 'success',
    data: unwrapApiData<T>(body),
  }
}

/** @deprecated alias */
export const safeJson = safeResponseJson
