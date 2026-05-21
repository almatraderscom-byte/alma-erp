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
  | { ok: true; data: T; status: number; state: 'success'; requestId?: string }
  | {
      ok: false
      error: ApiErrorShape
      status: number
      state: 'failed' | 'retrying'
      parseError: boolean
      rolledBack?: boolean
      requestId?: string
    }

export type SafeFetchOptions = RequestInit & {
  timeoutMs?: number
  /** Retry once on network/5xx/parse failure (default 0). */
  retries?: number
  /** Override the auto-generated X-Request-Id (use when caller already has one). */
  requestId?: string
}

const RID_HEADER = 'x-request-id'

/** Reads the existing X-Request-Id header from a HeadersInit, regardless of shape. */
function readExistingRequestId(headers: HeadersInit | undefined): string | undefined {
  if (!headers) return undefined
  if (headers instanceof Headers) {
    return headers.get(RID_HEADER) || headers.get('X-Request-Id') || undefined
  }
  if (Array.isArray(headers)) {
    const match = headers.find(([k]) => k.toLowerCase() === RID_HEADER)
    return match?.[1]
  }
  const rec = headers as Record<string, string>
  return rec[RID_HEADER] || rec['X-Request-Id']
}

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `cli-${Math.random().toString(36).slice(2)}-${Date.now()}`
}

function withRequestIdHeaders(headers: HeadersInit | undefined, requestId: string): HeadersInit {
  if (headers instanceof Headers) {
    const next = new Headers(headers)
    if (!next.has(RID_HEADER) && !next.has('X-Request-Id')) next.set('X-Request-Id', requestId)
    return next
  }
  if (Array.isArray(headers)) {
    const exists = headers.some(([k]) => k.toLowerCase() === RID_HEADER)
    return exists ? headers : [...headers, ['X-Request-Id', requestId]]
  }
  const rec: Record<string, string> = { ...((headers as Record<string, string>) || {}) }
  if (!rec[RID_HEADER] && !rec['X-Request-Id']) rec['X-Request-Id'] = requestId
  return rec
}

/**
 * Never throws on JSON parse failures. Unwraps { ok, data } or legacy flat payloads.
 */
async function safeFetchJsonOnce<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  requestId: string,
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
      requestId,
      error: {
        code: aborted ? 'timeout' : 'network_error',
        message: aborted
          ? 'Request timed out. Check connection and retry.'
          : 'Network error. Check connection and retry.',
      },
    }
  }

  const responseRid = res.headers.get('x-request-id') || requestId
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
      requestId: responseRid,
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
      requestId: responseRid,
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
      requestId: responseRid,
      error: err,
    }
  }

  return {
    ok: true,
    status: res.status,
    state: 'success',
    data: unwrapApiData<T>(body),
    requestId: responseRid,
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
  const { timeoutMs = 30_000, retries = 0, requestId: overrideRid, ...init } = options
  const existing = readExistingRequestId(init.headers)
  const requestId = overrideRid || existing || generateRequestId()
  const initWithRid: RequestInit = { ...init, headers: withRequestIdHeaders(init.headers, requestId) }
  let last = await safeFetchJsonOnce<T>(url, initWithRid, timeoutMs, requestId)
  let attempt = 0
  while (attempt < retries && shouldRetry(last)) {
    attempt += 1
    await new Promise(r => setTimeout(r, 400 * attempt))
    last = await safeFetchJsonOnce<T>(url, initWithRid, timeoutMs, requestId)
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
