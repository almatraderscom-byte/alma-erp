export type WebAgoraConnectionState = 'idle' | 'connecting' | 'in-call' | 'reconnecting' | 'ended' | 'error'

const CALL_RING_WINDOW_MS = 60_000
// Canonical calls have a two-hour hard maximum. Keep a small projection grace
// period, but never let a day-old legacy feed row take over the whole Office UI.
const CALL_RECOVERY_WINDOW_MS = 2 * 60 * 60_000 + 5 * 60_000
const RECOVERABLE_CANONICAL_STATES = new Set([
  'ANSWERED',
  'CONNECTING',
  'CONNECTED',
  'RECONNECTING',
])

export type RecoverableOfficeCall = {
  id: string
  kind: string
  outgoingByMe: boolean
  endedAt: string | null
  canonicalState: string | null
  createdAt: string
}

/**
 * Select only a genuinely resumable outgoing call for the global recovery UI.
 * Canonical ENDED is authoritative even if a legacy broadcast projection lags.
 * Legacy/ringing rows are recoverable only during the normal ring window.
 */
export function isRecoverableOutgoingOfficeCall(args: {
  call: RecoverableOfficeCall
  nowMs: number
  locallyDismissed?: boolean
}): boolean {
  const { call } = args
  if (args.locallyDismissed || call.kind !== 'call' || !call.outgoingByMe || call.endedAt) return false

  const createdAt = Date.parse(call.createdAt)
  if (!Number.isFinite(createdAt)) return false
  const ageMs = Math.max(0, args.nowMs - createdAt)
  const canonical = call.canonicalState?.toUpperCase() ?? null

  if (canonical === 'ENDED') return false
  if (!canonical || canonical === 'CREATED' || canonical === 'RINGING') {
    return ageMs < CALL_RING_WINDOW_MS
  }
  return RECOVERABLE_CANONICAL_STATES.has(canonical) && ageMs < CALL_RECOVERY_WINDOW_MS
}

export function isExpectedAgoraPeer(args: {
  candidate: string | number
  expected: string | number | null
  established: string | number | null
}): boolean {
  const candidate = String(args.candidate)
  if (args.expected !== null && candidate !== String(args.expected)) return false
  if (args.established !== null && candidate !== String(args.established)) return false
  return true
}

export function connectionStateForAgora(
  current: string,
  peerJoined: boolean,
): WebAgoraConnectionState | null {
  if (current === 'RECONNECTING' || current === 'DISCONNECTED') return 'reconnecting'
  if (current === 'CONNECTED') return peerJoined ? 'in-call' : 'connecting'
  if (current === 'CONNECTING') return 'connecting'
  return null
}

export function webCallErrorCode(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'AbortError') return 'join_cancelled'
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'microphone_permission_denied'
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') return 'microphone_not_found'
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') return 'microphone_in_use'
  }
  return error instanceof Error && error.message ? error.message : 'call_failed'
}
