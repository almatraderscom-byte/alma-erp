import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  awaitResult: vi.fn(),
  share: vi.fn(),
  markDeferred: vi.fn(),
  kvFind: vi.fn(),
  kvUpsert: vi.fn(),
  pendingFind: vi.fn(),
  pendingUpdate: vi.fn(),
  appendNote: vi.fn(),
  continueAction: vi.fn(),
}))

vi.mock('@/agent/lib/mac-agent/bus', () => ({
  enqueueCommand: mocks.enqueue,
  awaitResult: mocks.awaitResult,
  markUiProofDeferred: mocks.markDeferred,
}))

vi.mock('@/agent/lib/mac-agent/screenshot-share', () => ({
  shareAnnotatedScreenshot: mocks.share,
}))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentKvSetting: { findUnique: mocks.kvFind, upsert: mocks.kvUpsert },
    agentPendingAction: { findUnique: mocks.pendingFind, update: mocks.pendingUpdate },
  },
}))
vi.mock('@/agent/lib/conversation-note', () => ({ appendAssistantNote: mocks.appendNote }))
vi.mock('@/agent/lib/approval-continuation', () => ({
  enqueueApprovedActionContinuation: mocks.continueAction,
}))

import {
  deliverDeferredUiAfterProof,
  runUiActionWithVisualProof,
  visualProofMarkdown,
} from '@/agent/lib/mac-agent/ui-visual-proof'

const outcome = (id: string, stdout: string) => ({
  id, status: 'done', exitCode: 0, stdout, stderr: '', error: null, timedOut: false,
})

describe('approved Mac action visual proof', () => {
  beforeEach(() => {
    mocks.enqueue.mockReset()
    mocks.awaitResult.mockReset()
    mocks.share.mockReset()
    mocks.markDeferred.mockReset().mockResolvedValue(true)
    mocks.kvFind.mockReset().mockResolvedValue(null)
    mocks.kvUpsert.mockReset().mockResolvedValue({})
    mocks.pendingFind.mockReset().mockResolvedValue({ conversationId: 'conversation-1', result: {} })
    mocks.pendingUpdate.mockReset().mockResolvedValue({})
    mocks.appendNote.mockReset().mockResolvedValue(undefined)
    mocks.continueAction.mockReset().mockResolvedValue(undefined)
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
    expect(mocks.markDeferred).toHaveBeenCalledWith('after')
  })

  it('delivers deferred AFTER proof and resumes the approved workflow', async () => {
    mocks.share.mockReset().mockResolvedValue({
      ok: true,
      imageUrl: 'https://proof/after',
      instruction: '',
    })
    const delivered = await deliverDeferredUiAfterProof({
      commandId: 'after-1',
      rawStdout: 'data:image/jpeg;base64,BBBB',
      params: {
        proofPhase: 'after',
        proofPendingActionId: 'card-1',
        proofActionLabel: 'Click Send',
        proofBeforeImageUrl: 'https://proof/before',
      },
    })
    expect(delivered).toBe(true)
    expect(mocks.appendNote).toHaveBeenCalledWith(
      'conversation-1',
      expect.stringContaining('https://proof/after'),
    )
    expect(mocks.continueAction).toHaveBeenCalledWith('card-1')
    expect(mocks.kvUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { value: 'done_resumed' },
    }))
  })

  it('keeps deferred proof retryable when screenshot sharing fails', async () => {
    mocks.share.mockReset().mockResolvedValue({ ok: false, error: 'storage_down' })
    const delivered = await deliverDeferredUiAfterProof({
      commandId: 'after-2',
      rawStdout: 'data:image/jpeg;base64,BBBB',
      params: { proofPhase: 'after', proofPendingActionId: 'card-1' },
    })
    expect(delivered).toBe(false)
    expect(mocks.continueAction).not.toHaveBeenCalled()
    expect(mocks.kvUpsert).not.toHaveBeenCalled()
  })

  it('upgrades already-delivered legacy proof by resuming without reposting it', async () => {
    mocks.kvFind.mockResolvedValue({ value: 'done' })
    const delivered = await deliverDeferredUiAfterProof({
      commandId: 'after-legacy',
      rawStdout: 'data:image/jpeg;base64,BBBB',
      params: { proofPhase: 'after', proofPendingActionId: 'card-legacy' },
    })
    expect(delivered).toBe(true)
    expect(mocks.share).not.toHaveBeenCalled()
    expect(mocks.appendNote).not.toHaveBeenCalled()
    expect(mocks.continueAction).toHaveBeenCalledWith('card-legacy')
  })
})
