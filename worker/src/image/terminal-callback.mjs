export const IMAGE_TERMINAL_CALLBACK_KEY = '__imageTerminalCallback'

export function makeImageTerminalCallback(
  status,
  data,
  error,
  recordedAt = new Date().toISOString(),
  receiptId = globalThis.crypto?.randomUUID?.() ?? `${recordedAt}:${Math.random().toString(36).slice(2)}`,
) {
  if (status !== 'success' && status !== 'failed') throw new Error('invalid_image_terminal_status')
  return {
    version: 1,
    status,
    receiptId,
    ...(data && typeof data === 'object' ? { data } : {}),
    ...(typeof error === 'string' && error ? { error } : {}),
    recordedAt,
  }
}

export function readImageTerminalCallback(result) {
  const marker = result?.[IMAGE_TERMINAL_CALLBACK_KEY]
    ?? (result?.version === 1 ? result : null)
  if (!marker || marker.version !== 1) return null
  if (marker.status !== 'success' && marker.status !== 'failed') return null
  return marker
}

/** Once a paid render has a success receipt, no later queue bookkeeping event
 * may replace (or report over) it with failure. Other transitions keep the
 * latest marker so a genuine provider failure remains retryable. */
export function chooseDurableImageTerminalCallback(previousValue, nextValue) {
  const previous = readImageTerminalCallback(previousValue)
  const next = readImageTerminalCallback(nextValue)
  if (!next) throw new Error('invalid_next_image_terminal_callback')
  return previous?.status === 'success' && next.status === 'failed' ? previous : next
}

/** BullMQ emits `failed` after each attempt. Only the exhausted event is an
 * owner-visible terminal failure. */
export function isTerminalBullMqFailure(job) {
  if (!job) return true
  const allowedAttempts = Math.max(1, Number(job.opts?.attempts) || 1)
  return Number(job.attemptsMade) >= allowedAttempts
}

/** An approved row with a durable callback marker is callback-only recovery;
 * it must never enter the provider queue again. Historical retained BullMQ
 * terminal jobs without a marker are settled failed so the owner gets Retry. */
export function imageApprovedRecovery(marker, bullState) {
  if (marker) return 'replay_callback'
  if (bullState === 'completed' || bullState === 'failed') return 'settle_callback_lost'
  return 'enqueue_or_wait'
}
