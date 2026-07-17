export type WebAgoraConnectionState = 'idle' | 'connecting' | 'in-call' | 'reconnecting' | 'ended' | 'error'

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
