import { describe, it, expect } from 'vitest'
import { classifyErrorCode } from '../registry'

describe('classifyErrorCode (Phase 1 stable error codes)', () => {
  it.each([
    ['Product not found', 'not_found'],
    ['খুঁজে পাইনি এই অর্ডার', 'not_found'],
    ['401 Unauthorized', 'auth'],
    ['Request timed out after 30s', 'timeout'],
    ['429 Too Many Requests', 'rate_limited'],
    ['fetch failed: ECONNRESET', 'network'],
    ['Invalid input: name is required', 'bad_args'],
    ['PrismaClientKnownRequestError: column does not exist', 'db'],
    ['Upstream provider returned 502', 'provider_5xx'],
    ['something completely different', 'handler_error'],
    [undefined, 'unknown'],
  ])('%s → %s', (input, expected) => {
    expect(classifyErrorCode(input as string | undefined)).toBe(expected)
  })
})
