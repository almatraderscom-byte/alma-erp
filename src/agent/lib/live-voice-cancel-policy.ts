export type LiveVoiceDisconnectCancellation = Readonly<{
  abortInProcessTurn: boolean
  requestDurableCancel: boolean
}>

/**
 * Ordinary chat deliberately survives a dropped HTTP client. A Live Voice tool
 * turn is different: provider cancellation means the spoken request is no
 * longer authoritative, so the server work must stop as well as the iOS Task.
 */
export function liveVoiceDisconnectCancellation(input: {
  voice: unknown
  cancellationAlreadyRequested: boolean
  hasDurableTurnID: boolean
}): LiveVoiceDisconnectCancellation {
  if (input.voice !== true || input.cancellationAlreadyRequested) {
    return { abortInProcessTurn: false, requestDurableCancel: false }
  }
  return {
    abortInProcessTurn: true,
    requestDurableCancel: input.hasDurableTurnID,
  }
}
