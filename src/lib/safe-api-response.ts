import { NextResponse } from 'next/server'
import { logEvent } from '@/lib/logger'

export type ApiJsonFailure = {
  ok: false
  error: string
  message: string
  code?: string
  rolledBack?: boolean
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
    logClientRecoverable('approval.response.invalid', { status, reason: 'body_unreadable' })
    return {
      ok: false,
      status,
      parseError: true,
      data: {
        ok: false,
        error: 'response_body_unreadable',
        message: 'Server response could not be read. Try again.',
      },
    }
  }

  if (!text.trim()) {
    logClientRecoverable('approval.response.invalid', { status, reason: 'empty_body' })
    return {
      ok: false,
      status,
      parseError: true,
      data: {
        ok: false,
        error: 'empty_response',
        message:
          status >= 500
            ? 'Server timed out or returned an empty response. Your action may not have completed — refresh and check status.'
            : 'Empty response from server. Refresh and try again.',
        rolledBack: status >= 500,
      },
    }
  }

  if (HTML_PREFIX.test(text)) {
    logClientRecoverable('approval.response.invalid', {
      status,
      reason: 'html_body',
      rawSnippet: snippet(text),
    })
    return {
      ok: false,
      status,
      parseError: true,
      rawSnippet: snippet(text),
      data: {
        ok: false,
        error: 'non_json_response',
        message: 'Server returned an error page instead of JSON. Try again in a moment.',
        rolledBack: true,
      },
    }
  }

  try {
    const data = JSON.parse(text) as T
    return { ok: true, data, status, parseError: false }
  } catch {
    logClientRecoverable('approval.response.invalid', {
      status,
      reason: 'invalid_json',
      rawSnippet: snippet(text),
    })
    return {
      ok: false,
      status,
      parseError: true,
      rawSnippet: snippet(text),
      data: {
        ok: false,
        error: 'invalid_json',
        message: 'Invalid JSON from server. Refresh approvals and retry.',
        rolledBack: status >= 500,
      },
    }
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

export function apiFailure(
  error: string,
  message: string,
  init?: { status?: number; code?: string; rolledBack?: boolean; extra?: Record<string, unknown> },
) {
  const status = init?.status ?? 400
  logEvent(status >= 500 ? 'error' : 'warn', 'approval.api.failed', {
    error,
    message,
    code: init?.code,
    status,
  })
  return NextResponse.json(
    {
      ok: false,
      error,
      message,
      ...(init?.code ? { code: init.code } : {}),
      ...(init?.rolledBack ? { rolledBack: true } : {}),
      ...init?.extra,
    } satisfies ApiJsonFailure,
    { status },
  )
}

export function classifyApprovalTxError(err: unknown): {
  error: string
  message: string
  rolledBack: boolean
} {
  const msg = (err as Error).message || String(err)
  if (msg.includes('Unable to start a transaction') || msg.includes('pool')) {
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
  if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
    console.warn(JSON.stringify({ event, ...meta }))
  }
}
