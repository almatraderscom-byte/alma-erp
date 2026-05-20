import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { errorMeta, logEvent } from '@/lib/logger'
import { apiFailure, apiSuccess, type ApiErrorShape } from '@/lib/safe-api-response'

export type { ApiErrorShape }

export { apiSuccess, apiFailure } from '@/lib/safe-api-response'

type RouteHandler = (req: NextRequest, ctx?: unknown) => Promise<NextResponse>

/**
 * Wraps an API route handler — always returns JSON, never raw Prisma/HTML errors.
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
    try {
      return await handler(req, ctx)
    } catch (err) {
      const custom = options?.classifyError?.(err)
      const message = (err as Error).message || String(err)
      logEvent('error', `${routeLabel}.failed`, {
        route: routeLabel,
        durationMs: Date.now() - started,
        errMessage: message,
        ...errorMeta(err),
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
export function apiDataSuccess<T extends Record<string, unknown>>(data: T, init?: { status?: number }) {
  return apiSuccess({ data })
}
