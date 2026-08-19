import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createKeyedSerialOperationQueue,
  createSerialOperationQueue,
  fetchPreviewWithDeadline,
  previewAttemptMayMutate,
  PreviewDeadlineError,
  recoverTimedOutOperation,
  resetPreviewCaptureState,
  runPreviewCaptureExclusive,
  withPreviewDeadline,
} from '../../../../../extension/alma-companion/preview-liveness.js'

const ROOT = process.cwd()

afterEach(() => {
  vi.useRealTimers()
})

describe('ALMA Companion preview liveness watchdog', () => {
  it('releases a permanently pending Chrome capture at its deadline', async () => {
    vi.useFakeTimers()
    const pending = withPreviewDeadline(new Promise(() => {}), 5_000, 'capture')
    const assertion = expect(pending).rejects.toEqual(expect.objectContaining({
      name: 'PreviewDeadlineError',
      timeoutMs: 5_000,
    } satisfies Partial<PreviewDeadlineError>))

    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
  })

  it('aborts a permanently pending frame upload at its deadline', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | null | undefined
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal
      // Deliberately ignore AbortSignal, reproducing a browser/network promise
      // that never settles even after controller.abort().
      return new Promise<Response>(() => {})
    })
    const pending = fetchPreviewWithDeadline(fetchImpl, 'https://example.test/frame', {}, 8_000)
    const assertion = expect(pending).rejects.toBeInstanceOf(PreviewDeadlineError)

    await vi.advanceTimersByTimeAsync(8_000)
    await assertion
    expect(signal?.aborted).toBe(true)
  })

  it('releases the exclusive capture gate after a bounded preview stage rejects', async () => {
    vi.useFakeTimers()
    const state = { busy: false, generation: 0, activeGeneration: null as number | null }
    const first = runPreviewCaptureExclusive(state, () => (
      withPreviewDeadline(new Promise(() => {}), 10_000, 'preview tab lookup')
    ))
    const firstAssertion = expect(first).rejects.toBeInstanceOf(PreviewDeadlineError)
    expect(state.busy).toBe(true)

    await vi.advanceTimersByTimeAsync(10_000)
    await firstAssertion
    expect(state.busy).toBe(false)
    await expect(runPreviewCaptureExclusive(state, async () => 'next frame')).resolves.toEqual({
      started: true,
      value: 'next frame',
    })
  })

  it('invalidates an old hung generation without unlocking its replacement', async () => {
    let releaseOld: (() => void) | undefined
    let releaseNew: (() => void) | undefined
    const state = { busy: false, generation: 0, activeGeneration: null as number | null }
    const old = runPreviewCaptureExclusive(state, () => new Promise<void>((resolve) => { releaseOld = resolve }))
    expect(state.busy).toBe(true)

    resetPreviewCaptureState(state)
    await expect(runPreviewCaptureExclusive(state, async () => 'too early')).resolves.toEqual({ started: false })
    releaseOld?.()
    await old
    expect(state.busy).toBe(false)

    const replacement = runPreviewCaptureExclusive(state, () => new Promise<void>((resolve) => { releaseNew = resolve }))
    expect(state.busy).toBe(true)
    releaseNew?.()
    await replacement
    expect(state.busy).toBe(false)
  })

  it('rejects a late old-generation response even when the replacement has the same activity IDs', () => {
    const state = { busy: true, generation: 8, activeGeneration: 8 }
    const original = {
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      expiresAt: '2030-01-01T00:00:30.000Z',
    }
    const replacement = { ...original, expiresAt: '2030-01-01T00:01:00.000Z' }
    const now = Date.parse('2030-01-01T00:00:00.000Z')

    expect(previewAttemptMayMutate(state, 7, replacement, original, now)).toBe(false)
    expect(previewAttemptMayMutate(state, 8, replacement, original, now)).toBe(true)
  })

  it('keeps abandoned CDP work ahead of a replacement until cleanup settles', async () => {
    let releaseOld: (() => void) | undefined
    const order: string[] = []
    const queue = createSerialOperationQueue()
    const old = queue.run(async () => {
      order.push('old:start')
      await new Promise<void>((resolve) => { releaseOld = resolve })
      order.push('old:recovered')
    })
    const replacement = queue.run(async () => { order.push('new:start') })

    await Promise.resolve()
    expect(order).toEqual(['old:start'])
    releaseOld?.()
    await Promise.all([old, replacement])
    expect(order).toEqual(['old:start', 'old:recovered', 'new:start'])
  })

  it('does not release a timed-out raw CDP operation until recovery drains it', async () => {
    vi.useFakeTimers()
    let settleRaw: (() => void) | undefined
    const raw = new Promise<void>((resolve) => { settleRaw = resolve })
    const recover = vi.fn(async () => {
      setTimeout(() => settleRaw?.(), 2_000)
      return true
    })
    const recovered = recoverTimedOutOperation(raw, recover, 3_000, 'CDP drain')

    await vi.advanceTimersByTimeAsync(1_999)
    expect(recover).toHaveBeenCalledOnce()
    let done = false
    void recovered.then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(recovered).resolves.toBe(true)
  })

  it('fails closed when detach cannot drain the raw timed-out CDP operation', async () => {
    vi.useFakeTimers()
    const recovered = recoverTimedOutOperation(
      new Promise(() => {}),
      async () => true,
      3_000,
      'CDP drain',
    )
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(recovered).resolves.toBe(false)
  })

  it('deduplicates one tab recovery but queues a different tab behind it', async () => {
    let releaseA: (() => void) | undefined
    let releaseB: (() => void) | undefined
    const order: string[] = []
    const queue = createKeyedSerialOperationQueue(async (tabId: number) => {
      order.push(`start:${tabId}`)
      await new Promise<void>((resolve) => {
        if (tabId === 1) releaseA = resolve
        else releaseB = resolve
      })
      order.push(`done:${tabId}`)
      return true
    })

    const firstA = queue.run(1)
    const duplicateA = queue.run(1)
    const recoveryB = queue.run(2)
    expect(duplicateA).toBe(firstA)
    await Promise.resolve()
    expect(order).toEqual(['start:1'])

    releaseA?.()
    await firstA
    await Promise.resolve()
    expect(order).toEqual(['start:1', 'done:1', 'start:2'])
    releaseB?.()
    await recoveryB
    expect(order).toEqual(['start:1', 'done:1', 'start:2', 'done:2'])
  })

  it('guards both Chrome capture and frame POST in the shipped worker', () => {
    const worker = readFileSync(join(ROOT, 'extension/alma-companion/background.js'), 'utf8')
    expect(worker).toContain("rawCapture = chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.captureScreenshot'")
    expect(worker).toMatch(/withPreviewDeadline\(\s+rawCapture,/)
    expect(worker).toContain('() => previewAttemptCurrent(generation, grant)')
    expect(worker).toMatch(/fetchPreviewWithDeadline\(\s+fetch,/)
    expect(worker).toMatch(/runPreviewCaptureExclusive\(\s+previewCaptureState,/)
    expect(worker).toContain('resetPreviewCaptureState(previewCaptureState)')
    expect(worker).toContain('previewAttemptCurrent(generation, grant)')
    expect(worker).toContain('const cdpOperationQueue = createSerialOperationQueue()')
    expect(worker).toContain('callTimeoutMs = COMMAND_CAPTURE_CALL_TIMEOUT_MS')
    expect(worker).toContain('async function ensureDebugger(tabId, isCurrent = () => true, timeoutMs = DEBUGGER_ATTACH_TIMEOUT_MS)')
    expect(worker).not.toContain('if (cdpTabId === tabId) return true')
    expect(worker).toMatch(/if \(!isCurrent\(\)\) \{\s+\/\/ This call created the attachment[\s\S]+await recoverDebuggerConnection\(tabId\)/)
    expect(worker).toContain('if (!isCurrent()) return null')
    expect(worker).toContain('activeGeneration: null')
    expect(worker).toContain('const debuggerRecoveryQueue = createKeyedSerialOperationQueue(performDebuggerRecovery)')
    expect(worker).toContain('if (debuggerPoisoned || !isCurrent()) return null')
    expect(worker).toContain('recoverTimedOutOperation(')
    expect(worker).not.toContain('PREVIEW_CAPTURE_TOTAL_TIMEOUT_MS')
    expect(worker).not.toContain('PREVIEW_TICK_TIMEOUT_MS')
    expect(worker).not.toContain('for (let attempt = 0; attempt < 2; attempt++)')
    expect(worker).toContain('if (debuggerPoisoned || !allowVisibleFallback) return null')
    expect(worker).toMatch(/\(\) => previewAttemptCurrent\(generation, grant\),\s+false,/)
  })
})
