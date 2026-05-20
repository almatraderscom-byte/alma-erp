import { NextResponse } from 'next/server'
import { logEvent } from '@/lib/logger'

export type ApiErrorShape = {
  code: string
  message: string
}

export type ApiJsonFailure = {
  ok: false
  error: ApiErrorShape
  /** @deprecated legacy flat fields — prefer error.code / error.message */
  code?: string
  message?: string
  rolledBack?: boolean
  retryable?: boolean
}

export type ApiJsonSuccess<T extends Record<string, unknown> = Record<string, unknown>> = {
  ok: true
} & T

export type SafeJsonResult<T = Record<string, unknown>> =
  | { ok: true; data: T; status: number; parseError?: false }
  | {
      ok: false
      data: Partial<ApiJsonFailure> & Record<string, unknown>
      status: number
      parseError: boolean
      rawSnippet?: string
    }

const HTML_PREFIX = /^\s*</

function snippet(text: string, max = 180): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

/** Client-safe JSON parse — never throws. */
export async function safeResponseJson<T = Record<string, unknown>>(
  response: Response,
): Promise<SafeJsonResult<T>> {
  const status = response.status
  let text = ''
  try {
    text = await response.text()
  } catch {
    logClientRecoverable('safeFetchJson.parse.failed', { status, reason: 'body_unreadable' })
    return {
      ok: false,
      status,
      parseError: true,
      data: failurePayload('response_body_unreadable', 'Server response could not be read. Try again.'),
    }
  }

  if (!text.trim()) {
    logClientRecoverable('safeFetchJson.parse.failed', { status, reason: 'empty_body' })
    return {
      ok: false,
      status,
      parseError: true,
      data: failurePayload(
        'empty_response',
        status >= 500
          ? 'Server timed out or returned an empty response. Refresh and check status.'
          : 'Empty response from server. Refresh and try again.',
        status >= 500,
      ),
    }
  }

  if (HTML_PREFIX.test(text)) {
    logClientRecoverable('safeFetchJson.parse.failed', {
      status,
      reason: 'html_body',
      rawSnippet: snippet(text),
    })
    return {
      ok: false,
      status,
      parseError: true,
      rawSnippet: snippet(text),
      data: failurePayload(
        'non_json_response',
        'Server returned an error page instead of JSON. Try again in a moment.',
        true,
      ),
    }
  }

  try {
    const data = JSON.parse(text) as T
    return { ok: true, data, status, parseError: false }
  } catch {
    logClientRecoverable('safeFetchJson.parse.failed', {
      status,
      reason: 'invalid_json',
      rawSnippet: snippet(text),
    })
    return {
      ok: false,
      status,
      parseError: true,
      rawSnippet: snippet(text),
      data: failurePayload(
        'invalid_json',
        'Invalid JSON from server. Refresh and retry.',
        status >= 500,
      ),
    }
  }
}

function failurePayload(code: string, message: string, rolledBack = false): Partial<ApiJsonFailure> & Record<string, unknown> {
  return {
    ok: false as const,
    error: { code, message },
    code,
    message,
    ...(rolledBack ? { rolledBack: true, retryable: true } : {}),
  }
}

/** Unwrap { ok, data } envelope or legacy flat JSON. */
export function unwrapApiData<T>(body: Record<string, unknown>): T {
  if (body.ok === true && body.data != null && typeof body.data === 'object') {
    return body.data as T
  }
  return body as T
}

export function readApiError(body: Record<string, unknown>): ApiErrorShape {
  const nested = body.error
  if (nested && typeof nested === 'object' && 'message' in nested) {
    const e = nested as ApiErrorShape
    return {
      code: e.code || String(body.code || 'request_failed'),
      message: e.message || String(body.message || 'Request failed'),
    }
  }
  return {
    code: String(body.code || body.error || 'request_failed'),
    message: String(body.message || body.error || 'Request failed'),
  }
}

export function apiSuccess<T extends Record<string, unknown>>(
  payload: T,
  init?: { status?: number; headers?: HeadersInit },
) {
  return NextResponse.json({ ok: true, ...payload } satisfies ApiJsonSuccess<T>, {
    status: init?.status ?? 200,
    headers: init?.headers,
  })
}

export function apiDataSuccess<T extends Record<string, unknown>>(
  data: T,
  init?: { status?: number; headers?: HeadersInit },
) {
  return apiSuccess({ data }, init)
}

export function apiFailure(
  code: string,
  message: string,
  init?: { status?: number; rolledBack?: boolean; extra?: Record<string, unknown> },
) {
  const status = init?.status ?? 400
  const event =
    code.includes('attendance') ? 'attendance.api.failed'
    : code.includes('approval') || code.includes('wallet') ? 'approval.api.failed'
    : code.includes('archive') ? 'archive.filter.failed'
    : code.includes('telegram') ? 'telegram.queue.failed'
    : 'approval.api.failed'

  logEvent(status >= 500 ? 'error' : 'warn', event, { code, message, status })

  const body: ApiJsonFailure = {
    ok: false,
    error: { code, message },
    code,
    message,
    ...(init?.rolledBack ? { rolledBack: true, retryable: true } : {}),
    ...init?.extra,
  }
  return NextResponse.json(body, { status })
}

export function classifyApprovalTxError(err: unknown): {
  error: string
  message: string
  rolledBack: boolean
} {
  const msg = (err as Error).message || String(err)
  if (msg.includes('Unable to start a transaction') || msg.includes('pool')) {
    logEvent('error', 'approval.transaction.failed', { message: msg })
    return {
      error: 'approval_transaction_pool_wait',
      message: 'Database is busy. Wait a few seconds and retry.',
      rolledBack: true,
    }
  }
  if (
    msg.includes('timed out')
    || msg.includes('Transaction already closed')
    || msg.includes('expired transaction')
  ) {
    logEvent('error', 'approval.transaction.failed', { message: msg })
    return {
      error: 'approval_transaction_timeout',
      message: 'Approval timed out before completing. Refresh — no change was committed if the row is still pending.',
      rolledBack: true,
    }
  }
  if (msg.includes('deadlock') || msg.includes('40P01')) {
    return {
      error: 'approval_transaction_deadlock',
      message: 'Temporary database conflict. Retry the approval.',
      rolledBack: true,
    }
  }
  return {
    error: 'approval_failed',
    message: msg || 'Approval could not be completed.',
    rolledBack: true,
  }
}

function logClientRecoverable(event: string, meta: Record<string, unknown>) {
  if (typeof window !== 'undefined') {
    if (process.env.NODE_ENV === 'development') {
      console.warn(JSON.stringify({ event, ...meta }))
    }
  }
}
