export const DIRECT_YOUTUBE_VOICE_INTERRUPTION_BLOCKER =
  'দুঃখিত বস—সার্ভারের authoritative completion event আসার আগে সংযোগ শেষ হয়েছে। তাই draft উত্তরটি বলছি না বা কাজ সম্পন্ন দাবি করছি না; আবার বলুন।'

export type HeldVoiceReplyState = {
  text: string
  authoritativeDone?: boolean
  interruptedBeforeDone?: boolean
}

export type HeldVoiceReplyEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'verification_retry'; categories: readonly string[] }
  | { type: 'done' }
  | { type: 'transport_end' }
  | { type: 'transport_error' }

/**
 * Voice cannot retract speech. Buffer model prose until the server reaches a
 * terminal outcome; any verification rewrite discards the rejected draft.
 */
export function reduceHeldVoiceReply(
  state: HeldVoiceReplyState,
  event: HeldVoiceReplyEvent,
): HeldVoiceReplyState {
  if (event.type === 'verification_retry') return { ...state, text: '' }
  if (event.type === 'done') {
    return state.interruptedBeforeDone
      ? state
      : { ...state, authoritativeDone: true }
  }
  if (event.type === 'transport_end' || event.type === 'transport_error') {
    return state.authoritativeDone
      ? state
      : { ...state, text: '', interruptedBeforeDone: true }
  }
  return { ...state, text: state.text + event.delta }
}

export function flushHeldVoiceReply(state: HeldVoiceReplyState): string {
  return state.text
}

/**
 * Voice turns may only release prose after the SSE terminal event was parsed.
 * A socket EOF is transport state, not proof that the server completed or
 * persisted the turn. This also covers short durable-lane continuations.
 */
export function settleHeldVoiceReply(
  state: HeldVoiceReplyState,
  options: { requireAuthoritativeDone: boolean },
): string {
  if (
    options.requireAuthoritativeDone
    && (!state.authoritativeDone || state.interruptedBeforeDone)
  ) {
    return DIRECT_YOUTUBE_VOICE_INTERRUPTION_BLOCKER
  }
  return flushHeldVoiceReply(state)
}
