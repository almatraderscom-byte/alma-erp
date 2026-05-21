import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { errorMeta, logEvent } from '@/lib/logger'
import { apiFailure, apiSuccess, type ApiErrorShape } from '@/lib/safe-api-response'
import { captureException } from '@/lib/sentry/capture'

export type { ApiErrorShape }

export { apiSuccess, apiFailure } from '@/lib/safe-api-response'

type RouteHandler = (req: NextRequest, ctx?: unknown) => Promise<NextResponse>

/** Best-effort: attach route + requestId as Sentry tags for the current scope. */
async function tagSentryScope(routeLabel: string, requestId?: string): Promise<void> {
  if (typeof window !== 'undefined') return
  try {
    const Sentry = await import('@sentry/nextjs')
    const scope = Sentry.getCurrentScope()
    if (!scope) return
    scope.setTag('route', routeLabel)
    if (requestId) {
      scope.setTag('request.id', requestId)
      scope.setExtra('requestId', requestId)
    }
  } catch {
    /* Sentry not initialized — never block request */
  }
}

/**
 * Wraps an API route handler — always returns JSON, never raw Prisma/HTML errors.
 * Also: tags the active Sentry scope with the route label and incoming X-Request-Id,
 * and captures uncaught exceptions explicitly so they always show in Sentry even
 * when the structured logger downgrades them.
 */
export function withApiRoute(
  routeLabel: string,
  handler: RouteHandler,
  options?: {
    classifyError?: (err: unknown) => { code: string; message: string; status: number; retryable?: boolean }
  },
): RouteHandler {
  return async (req: NextRequest, ctx?: unknown) => {
    const started = Date.now()
    const requestId = req.headers.get('x-request-id')?.trim() || undefined
    await tagSentryScope(routeLabel, requestId)
    try {
      return await handler(req, ctx)
    } catch (err) {
      const custom = options?.classifyError?.(err)
      const message = (err as Error).message || String(err)
      logEvent('error', `${routeLabel}.failed`, {
        route: routeLabel,
        requestId,
        durationMs: Date.now() - started,
        errMessage: message,
        ...errorMeta(err),
      })
      // Always capture uncaught route errors to Sentry — categorised + tagged.
      void captureException(err, {
        category: 'api',
        event: `${routeLabel}.failed`,
        critical: true,
        extra: {
          route: routeLabel,
          requestId,
          durationMs: Date.now() - started,
        },
      })
      if (custom) {
        return apiFailure(custom.code, custom.message, {
          status: custom.status,
          rolledBack: custom.retryable,
        })
      }

      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        const retryable = ['P2024', 'P2034', 'P2028'].includes(err.code)
        return apiFailure('database_error', 'Database error. Retry in a few seconds.', {
          status: retryable ? 503 : 500,
          rolledBack: retryable,
        })
      }

      return apiFailure('internal_error', message || 'Request failed', {
        status: 500,
        rolledBack: true,
      })
    }
  }
}

/** Success payload with standard envelope. */
export function apiDataSuccess<T extends Record<string, unknown>>(data: T, init?: { status?: number; headers?: HeadersInit }) {
  return apiSuccess({ data }, init)
}
