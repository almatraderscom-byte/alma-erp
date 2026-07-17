'use client'

import { APP_BUILD_ID } from '@/lib/runtime-build'

const DEVICE_ID_KEY = 'alma_office_call_device_id'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function callIdFromChannel(channel: string): string | null {
  const candidate = channel.startsWith('itc_') ? channel.slice(4) : ''
  return UUID_RE.test(candidate) ? candidate : null
}

function deviceId(): string | undefined {
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY)
    if (existing) return existing
    const created = window.crypto.randomUUID()
    window.localStorage.setItem(DEVICE_ID_KEY, created)
    return created
  } catch {
    return undefined
  }
}

export function emitWebOfficeCallEvent(args: {
  channel: string
  event: string
  state?: string
  latencyMs?: number
  metadata?: Record<string, unknown>
}): void {
  const callId = callIdFromChannel(args.channel)
  if (!callId || typeof window === 'undefined') return
  const body = JSON.stringify({
    callId,
    event: args.event,
    platform: 'web',
    deviceId: deviceId(),
    appBuild: APP_BUILD_ID,
    state: args.state,
    latencyMs: args.latencyMs,
    metadata: args.metadata,
    occurredAt: new Date().toISOString(),
  })
  void fetch('/api/assistant/office/calls/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {})
}
