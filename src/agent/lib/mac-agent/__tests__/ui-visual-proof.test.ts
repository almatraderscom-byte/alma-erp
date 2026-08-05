import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  awaitResult: vi.fn(),
  share: vi.fn(),
}))

vi.mock('@/agent/lib/mac-agent/bus', () => ({
  enqueueCommand: mocks.enqueue,
  awaitResult: mocks.awaitResult,
}))

vi.mock('@/agent/lib/mac-agent/screenshot-share', () => ({
  shareAnnotatedScreenshot: mocks.share,
}))

import { runUiActionWithVisualProof, visualProofMarkdown } from '@/agent/lib/mac-agent/ui-visual-proof'

const outcome = (id: string, stdout: string) => ({
  id, status: 'done', exitCode: 0, stdout, stderr: '', error: null, timedOut: false,
})

describe('approved Mac action visual proof', () => {
  beforeEach(() => {
    mocks.enqueue.mockReset()
    mocks.awaitResult.mockReset()
    mocks.share.mockReset()
    mocks.enqueue
      .mockResolvedValueOnce({ id: 'before' })
      .mockResolvedValueOnce({ id: 'action' })
      .mockResolvedValueOnce({ id: 'after' })
    mocks.awaitResult
      .mockResolvedValueOnce(outcome('before', 'data:image/jpeg;base64,AAAA'))
      .mockResolvedValueOnce(outcome('action', JSON.stringify({ clicked: true })))
      .mockResolvedValueOnce(outcome('after', 'data:image/jpeg;base64,BBBB'))
    mocks.share
      .mockResolvedValueOnce({ ok: true, imageUrl: 'https://proof/before', instruction: '' })
      .mockResolvedValueOnce({ ok: true, imageUrl: 'https://proof/after', instruction: '' })
  })

  it('queues BEFORE → action → AFTER and returns an inline proof pair', async () => {
    const result = await runUiActionWithVisualProof({
      deviceId: 'mac-1', uiAction: 'ui_click', approvedBy: 'card-1',
      params: { bundleId: 'com.openai.codex', elementLabel: 'New chat', approved: true },
    })
    expect(mocks.enqueue.mock.calls.map((call) => call[0].action)).toEqual([
      'ui_screenshot', 'ui_click', 'ui_screenshot',
    ])
    expect(mocks.enqueue.mock.calls[2][0].params).toMatchObject({
      proofPhase: 'after', proofForCommandId: 'action', proofBeforeImageUrl: 'https://proof/before',
    })
    expect(result.proofComplete).toBe(true)
    expect(result.verification?.verdict).toBe('verified')
    expect(visualProofMarkdown(result)).toContain('https://proof/before')
    expect(visualProofMarkdown(result)).toContain('https://proof/after')
  })

  it('fails closed before the act when the BEFORE screenshot is unavailable', async () => {
    mocks.awaitResult.mockReset().mockResolvedValueOnce({
      id: 'before', status: 'failed', exitCode: null, stdout: '', stderr: '', error: 'permission', timedOut: false,
    })
    const result = await runUiActionWithVisualProof({
      deviceId: 'mac-1', uiAction: 'ui_type', approvedBy: 'card-1',
      params: { bundleId: 'com.openai.codex', elementLabel: 'Message', text: 'hello' },
    })
    expect(mocks.enqueue).toHaveBeenCalledTimes(1)
    expect(result.actionOutcome).toBeNull()
    expect(result.proofError).toContain('before_capture_failed')
  })

  it('leaves AFTER durably queued when the action outlives the route wait', async () => {
    mocks.awaitResult.mockReset()
      .mockResolvedValueOnce(outcome('before', 'data:image/jpeg;base64,AAAA'))
      .mockResolvedValueOnce({
        id: 'action', status: 'delivered', exitCode: null, stdout: '', stderr: '', error: null, timedOut: true,
      })
    const result = await runUiActionWithVisualProof({
      deviceId: 'mac-1', uiAction: 'ui_key', approvedBy: 'card-1', budgetMs: 30_000,
      params: { bundleId: 'com.openai.codex', key: 'enter', focusedLabel: 'Message' },
    })
    expect(mocks.enqueue).toHaveBeenCalledTimes(3)
    expect(result.pendingAfterCommandId).toBe('after')
    expect(result.proofComplete).toBe(false)
  })
})
