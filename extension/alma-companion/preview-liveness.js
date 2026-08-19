/**
 * Bound extension calls that are allowed to fail without stopping the preview
 * producer. Chrome debugger promises and network fetches can otherwise remain
 * pending forever while the command poll loop continues normally.
 */
export class PreviewDeadlineError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} timed out after ${timeoutMs}ms`)
    this.name = 'PreviewDeadlineError'
    this.timeoutMs = timeoutMs
  }
}

export async function withPreviewDeadline(promise, timeoutMs, label) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PreviewDeadlineError(label, timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

export async function fetchPreviewWithDeadline(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await withPreviewDeadline(
      fetchImpl(url, { ...init, signal: controller.signal }),
      timeoutMs,
      'Browser preview upload',
    )
  } finally {
    clearTimeout(timer)
  }
}

// A timed-out CDP promise may still be alive underneath Promise.race. Detach
// first, then prove that exact raw promise has settled before the serialized
// debugger queue may release its next operation.
export async function recoverTimedOutOperation(rawOperation, recover, timeoutMs, label) {
  if (!(await recover())) return false
  try {
    await withPreviewDeadline(
      Promise.resolve(rawOperation).then(() => undefined, () => undefined),
      timeoutMs,
      label,
    )
    return true
  } catch (err) {
    if (err instanceof PreviewDeadlineError) return false
    throw err
  }
}

export async function runPreviewCaptureExclusive(state, operation) {
  if (state.busy) return { started: false }
  const generation = Number(state.generation || 0) + 1
  state.generation = generation
  state.activeGeneration = generation
  state.busy = true
  try {
    return { started: true, value: await operation(generation) }
  } finally {
    if (state.activeGeneration === generation) {
      state.activeGeneration = null
      state.busy = false
    }
  }
}

export function resetPreviewCaptureState(state) {
  state.generation = Number(state.generation || 0) + 1
}

export function isPreviewCaptureGenerationCurrent(state, generation) {
  return state.generation === generation
}

export function previewAttemptMayMutate(state, generation, currentGrant, originalGrant, now = Date.now()) {
  return isPreviewCaptureGenerationCurrent(state, generation)
    && Boolean(currentGrant && originalGrant
      && currentGrant.turnId === originalGrant.turnId
      && currentGrant.conversationId === originalGrant.conversationId
      && Date.parse(currentGrant.expiresAt) > now)
}

// Keep side-effectful browser work ordered even when a caller gives up waiting
// at its own deadline. The queue retains the real operation promise, so a late
// Chrome debugger call must settle (including detach/recovery) before another
// debugger call is allowed to start.
export function createSerialOperationQueue() {
  let tail = Promise.resolve()

  return {
    run(operation) {
      const scheduled = tail.then(operation, operation)
      tail = scheduled.then(() => undefined, () => undefined)
      return scheduled
    },
    async waitForIdle() {
      while (true) {
        const snapshot = tail
        await snapshot
        if (snapshot === tail) return
      }
    },
  }
}

// A second request for the same debugger target shares its pending cleanup;
// a different target is queued behind it and performs its own detach. This is
// deliberately not a single global promise, which would incorrectly treat
// recovery(A) as recovery(B).
export function createKeyedSerialOperationQueue(operation) {
  const serial = createSerialOperationQueue()
  const pending = new Map()

  return {
    run(key) {
      const existing = pending.get(key)
      if (existing) return existing
      const scheduled = serial.run(() => operation(key))
      pending.set(key, scheduled)
      const clear = () => {
        if (pending.get(key) === scheduled) pending.delete(key)
      }
      scheduled.then(clear, clear)
      return scheduled
    },
    waitForIdle: () => serial.waitForIdle(),
  }
}
