import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  connectionStateForAgora,
  isExpectedAgoraPeer,
  isRecoverableOutgoingOfficeCall,
  webCallErrorCode,
} from '../office-call-web-policy'
import { canClaimWebCallLease } from '../office-call-web-lease'

describe('Office web call policy', () => {
  it('allows the first-party web app to use its microphone in production headers', () => {
    const vercelConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8')) as {
      headers?: Array<{ headers?: Array<{ key?: string; value?: string }> }>
    }
    const permissionsPolicy = vercelConfig.headers
      ?.flatMap((rule) => rule.headers ?? [])
      .find((header) => header.key?.toLowerCase() === 'permissions-policy')

    expect(permissionsPolicy?.value).toContain('microphone=(self)')
    expect(permissionsPolicy?.value).not.toContain('microphone=()')
  })

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

  it('allows exactly one live media owner per browser call across 30 cycles', () => {
    for (let call = 0; call < 30; call += 1) {
      const now = 1_000_000 + call
      const active = { owner: `tab-a-${call}`, expiresAt: now + 15_000 }
      expect(canClaimWebCallLease(active, `tab-a-${call}`, now)).toBe(true)
      expect(canClaimWebCallLease(active, `tab-b-${call}`, now)).toBe(false)
      expect(canClaimWebCallLease(active, `tab-b-${call}`, active.expiresAt)).toBe(true)
    }
  })

  it('never recovers a canonically-ended or locally-dismissed outgoing call', () => {
    const nowMs = Date.parse('2026-07-19T00:00:00.000Z')
    const call = {
      id: 'call-1',
      kind: 'call',
      outgoingByMe: true,
      endedAt: null,
      canonicalState: 'ENDED',
      createdAt: new Date(nowMs - 5_000).toISOString(),
    }
    expect(isRecoverableOutgoingOfficeCall({ call, nowMs })).toBe(false)
    expect(isRecoverableOutgoingOfficeCall({
      call: { ...call, canonicalState: 'CONNECTED' },
      nowMs,
      locallyDismissed: true,
    })).toBe(false)
  })

  it('ages legacy/ringing recovery out after the normal ring window', () => {
    const nowMs = Date.parse('2026-07-19T00:00:00.000Z')
    const base = {
      id: 'call-2',
      kind: 'call',
      outgoingByMe: true,
      endedAt: null,
      canonicalState: null,
    }
    expect(isRecoverableOutgoingOfficeCall({
      call: { ...base, createdAt: new Date(nowMs - 30_000).toISOString() },
      nowMs,
    })).toBe(true)
    expect(isRecoverableOutgoingOfficeCall({
      call: { ...base, createdAt: new Date(nowMs - 61_000).toISOString() },
      nowMs,
    })).toBe(false)
  })

  it('keeps a fresh canonical connected call recoverable across a reload', () => {
    const nowMs = Date.parse('2026-07-19T00:00:00.000Z')
    expect(isRecoverableOutgoingOfficeCall({
      call: {
        id: 'call-3',
        kind: 'call',
        outgoingByMe: true,
        endedAt: null,
        canonicalState: 'RECONNECTING',
        createdAt: new Date(nowMs - 30 * 60_000).toISOString(),
      },
      nowMs,
    })).toBe(true)
  })
})
