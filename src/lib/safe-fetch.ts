'use client'

import toast from 'react-hot-toast'
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
      state: 'failed' | 'retrying'
      parseError: boolean
      rolledBack?: boolean
    }

export type SafeFetchOptions = RequestInit & {
  timeoutMs?: number
  /** Retry once on network/5xx/parse failure (default 0). */
  retries?: number
}

/**
 * Never throws on JSON parse failures. Unwraps { ok, data } or legacy flat payloads.
 */
async function safeFetchJsonOnce<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<SafeFetchResult<T>> {
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
      rolledBack: res.status >= 500,
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

function shouldRetry(result: SafeFetchResult<unknown>): boolean {
  if (result.ok) return false
  if (result.parseError) return true
  if (result.status === 0) return true
  if (result.status >= 500) return true
  return Boolean(result.rolledBack)
}

export async function safeFetchJson<T = Record<string, unknown>>(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult<T>> {
  const { timeoutMs = 30_000, retries = 0, ...init } = options
  let last = await safeFetchJsonOnce<T>(url, init, timeoutMs)
  let attempt = 0
  while (attempt < retries && shouldRetry(last)) {
    attempt += 1
    await new Promise(r => setTimeout(r, 400 * attempt))
    last = await safeFetchJsonOnce<T>(url, init, timeoutMs)
    if (last.ok) return { ...last, state: 'success' }
    last = { ...last, state: 'retrying' as const }
  }
  return last
}

/** One-shot fetch with optional toast on failure. */
export async function safeFetchJsonWithToast<T = Record<string, unknown>>(
  url: string,
  options: SafeFetchOptions & { toastOnError?: boolean } = {},
): Promise<SafeFetchResult<T>> {
  const { toastOnError = true, ...init } = options
  const result = await safeFetchJson<T>(url, init)
  if (!result.ok && toastOnError) toast.error(result.error.message)
  return result
}

/** Throws on failure after optional toast — for try/catch loaders. */
export async function safeFetchJsonOrThrow<T = Record<string, unknown>>(
  url: string,
  options: SafeFetchOptions & { toastOnError?: boolean } = {},
): Promise<T> {
  const result = await safeFetchJsonWithToast<T>(url, options)
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

/** @deprecated alias */
export const safeJson = safeResponseJson
