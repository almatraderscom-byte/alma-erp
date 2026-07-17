import { describe, expect, it } from 'vitest'
import { connectionStateForAgora, isExpectedAgoraPeer, webCallErrorCode } from '../office-call-web-policy'

describe('Office web call policy', () => {
  it('accepts only the participant-bound Agora uid', () => {
    expect(isExpectedAgoraPeer({ candidate: 22, expected: 22, established: null })).toBe(true)
    expect(isExpectedAgoraPeer({ candidate: 23, expected: 22, established: null })).toBe(false)
    expect(isExpectedAgoraPeer({ candidate: 23, expected: null, established: 22 })).toBe(false)
  })

  it('keeps transport loss recoverable instead of ending the call', () => {
    expect(connectionStateForAgora('RECONNECTING', true)).toBe('reconnecting')
    expect(connectionStateForAgora('DISCONNECTED', true)).toBe('reconnecting')
    expect(connectionStateForAgora('CONNECTED', true)).toBe('in-call')
    expect(connectionStateForAgora('CONNECTED', false)).toBe('connecting')
  })

  it('surfaces actionable microphone diagnostics', () => {
    expect(webCallErrorCode(new DOMException('blocked', 'NotAllowedError'))).toBe('microphone_permission_denied')
    expect(webCallErrorCode(new DOMException('busy', 'NotReadableError'))).toBe('microphone_in_use')
    expect(webCallErrorCode(new DOMException('gone', 'NotFoundError'))).toBe('microphone_not_found')
  })
})
