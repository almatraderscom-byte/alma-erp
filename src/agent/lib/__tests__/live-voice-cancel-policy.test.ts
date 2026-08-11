import { describe, expect, it } from 'vitest'
import { liveVoiceDisconnectCancellation } from '@/agent/lib/live-voice-cancel-policy'

describe('Live Voice disconnect cancellation', () => {
  it('propagates a voice disconnect to the in-process and durable turn', () => {
    expect(liveVoiceDisconnectCancellation({
      voice: true,
      cancellationAlreadyRequested: false,
      hasDurableTurnID: true,
    })).toEqual({ abortInProcessTurn: true, requestDurableCancel: true })
  })

  it('still aborts voice work before a durable turn id is available', () => {
    expect(liveVoiceDisconnectCancellation({
      voice: true,
      cancellationAlreadyRequested: false,
      hasDurableTurnID: false,
    })).toEqual({ abortInProcessTurn: true, requestDurableCancel: false })
  })

  it('preserves ordinary chat background-resume behavior and is one-shot', () => {
    expect(liveVoiceDisconnectCancellation({
      voice: false,
      cancellationAlreadyRequested: false,
      hasDurableTurnID: true,
    })).toEqual({ abortInProcessTurn: false, requestDurableCancel: false })
    expect(liveVoiceDisconnectCancellation({
      voice: true,
      cancellationAlreadyRequested: true,
      hasDurableTurnID: true,
    })).toEqual({ abortInProcessTurn: false, requestDurableCancel: false })
  })
})
