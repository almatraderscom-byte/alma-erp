/**
 * Regression: `apiFailure()` tagged EVERY unmapped error code as
 * `approval.api.failed`, so unrelated 500s (verified live: a throw from
 * /api/debug/sentry-test) fired the critical approval alert in Sentry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logEvent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logger', () => ({ logEvent, errorMeta: () => ({}) }))

import { apiFailure } from '@/lib/safe-api-response'

function taggedEvent(): string {
  return logEvent.mock.calls.at(-1)?.[1] as string
}

beforeEach(() => vi.clearAllMocks())

describe('apiFailure Sentry event tagging', () => {
  it('does not disguise an unrelated failure as an approval failure', () => {
    apiFailure('internal_error', 'boom', { status: 500 })
    expect(taggedEvent()).toBe('api.failed')
  })

  it('keeps the real approval and wallet mappings', () => {
    apiFailure('approval_not_found', 'nope', { status: 404 })
    expect(taggedEvent()).toBe('approval.api.failed')
    apiFailure('wallet_locked', 'nope', { status: 409 })
    expect(taggedEvent()).toBe('approval.api.failed')
  })

  it('keeps the attendance, archive and telegram mappings', () => {
    apiFailure('attendance_missing', 'nope', { status: 404 })
    expect(taggedEvent()).toBe('attendance.api.failed')
    apiFailure('archive_filter_bad', 'nope', { status: 400 })
    expect(taggedEvent()).toBe('archive.filter.failed')
    apiFailure('telegram_send_failed', 'nope', { status: 502 })
    expect(taggedEvent()).toBe('telegram.queue.failed')
  })

  it('logs 5xx at error level and 4xx at warn level', () => {
    apiFailure('internal_error', 'boom', { status: 500 })
    expect(logEvent.mock.calls.at(-1)?.[0]).toBe('error')
    apiFailure('not_found', 'nope', { status: 404 })
    expect(logEvent.mock.calls.at(-1)?.[0]).toBe('warn')
  })
})
