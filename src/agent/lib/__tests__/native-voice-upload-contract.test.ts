import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

describe('native voice upload contract', () => {
  it('uses the same multipart field name on every iOS transcribe path and the server', () => {
    const chat = readFileSync(join(ROOT, 'ios/App/App/AssistantSwiftUI.swift'), 'utf8')
    const voice = readFileSync(join(ROOT, 'ios/App/App/AssistantVoiceSwiftUI.swift'), 'utf8')
    const route = readFileSync(join(ROOT, 'src/app/api/assistant/transcribe/route.ts'), 'utf8')

    const nativeTranscribeCalls = [...chat.matchAll(/path:\s*"\/api\/assistant\/transcribe",\s*fileField:\s*"([^"]+)"/g),
      ...voice.matchAll(/path:\s*"\/api\/assistant\/transcribe",\s*fileField:\s*"([^"]+)"/g)]

    // Count-agnostic: the contract is the FIELD NAME, not how many call sites
    // exist (PR #529 added a 4th and broke the old hard-coded count).
    expect(nativeTranscribeCalls.length).toBeGreaterThanOrEqual(3)
    expect(nativeTranscribeCalls.map((match) => match[1])).toEqual(
      nativeTranscribeCalls.map(() => 'audio'),
    )
    expect(route).toContain("formData.get('audio')")
    expect(route).not.toContain("formData.get('file')")
  })

  it('shows truthful AI Call connection states without silently downgrading', () => {
    const voice = readFileSync(join(ROOT, 'ios/App/App/AssistantVoiceSwiftUI.swift'), 'utf8')

    expect(voice).toContain('case .live: return "রিয়েলটাইম"')
    expect(voice).toContain('case .reconnecting: return "পুনঃসংযোগ"')
    expect(voice).toContain('case .failed: return "সংযোগ হয়নি"')
    expect(voice).toContain('func retryLiveConnection()')
    expect(voice).not.toContain('startLegacySession()')
    expect(voice).not.toContain('সাধারণ ভয়েস চালু হয়েছে')
    expect(voice).not.toContain('নিরাপদ voice mode চালু হয়েছে')
    expect(voice).not.toContain('Text("LIVE")')
  })

  it('presents the native voice surface as a persistent hands-free AI call', () => {
    const voice = readFileSync(join(ROOT, 'ios/App/App/AssistantVoiceSwiftUI.swift'), 'utf8')
    const assistant = readFileSync(join(ROOT, 'ios/App/App/AssistantSwiftUI.swift'), 'utf8')

    expect(voice).toContain('Text("ALMA AI Call")')
    expect(voice).toContain('"mic.slash.fill"')
    expect(voice).toContain('"speaker.wave.2.fill"')
    expect(voice).toContain('"message.fill"')
    expect(voice).toContain('"phone.down.fill"')
    expect(voice).toContain('func setInputMuted(_ muted: Bool)')
    expect(voice).toContain('func setSpeakerEnabled(_ enabled: Bool) throws')
    expect(voice).toContain('struct AlmaVoiceCallMiniBar: View')
    expect(assistant).toContain('let voiceEngine = AlmaVoiceEngine()')
    // PR #541 moved the mini-bar instantiation into the voice file (app-wide
    // call bar via AlmaCallBarBridge) — assert the bar is wired SOMEWHERE, not
    // pinned to the old call site.
    expect(`${assistant}\n${voice}`).toContain('AlmaVoiceCallMiniBar(')
    expect(voice).toContain('স্বাভাবিকভাবে বলুন—ট্যাপ করার প্রয়োজন নেই')
  })

  it('allows only the one-time same-resource Vercel preview redirect in debug builds', () => {
    const transport = readFileSync(join(ROOT, 'ios/App/App/AssistantTransport.swift'), 'utf8')

    expect(transport).toContain('#if DEBUG')
    expect(transport).toContain('original.host == redirect.host')
    expect(transport).toContain('original.path == redirect.path')
    expect(transport).toContain('$0.name == "_vercel_share"')
    expect(transport).toContain('completionHandler(nil)')
  })

  it('waits for the live socket to open before sending setup and accepts binary JSON frames', () => {
    const voice = readFileSync(join(ROOT, 'ios/App/App/AssistantVoiceSwiftUI.swift'), 'utf8')
    const connectBody = voice.slice(voice.indexOf('private func connect('), voice.indexOf('private func setupMessage('))
    const didOpenBody = voice.slice(voice.indexOf('didOpenWithProtocol'), voice.indexOf('didCloseWith'))

    expect(connectBody).not.toContain('sendJSON(setupMessage')
    expect(didOpenBody).toContain('sendJSON(setupMessage')
    expect(voice).toContain('case .data(let data):')
    expect(voice).toContain('String(data: data, encoding: .utf8)')
    expect(voice).toContain('ALMA-VOICE websocket send failed')
    expect(voice).toContain('completionCallbackType: .dataPlayedBack')
    expect(voice).toContain('modelTurnCompleteReceived')
    expect(voice).toContain('modelGenerationCompleteReceived')
    expect(voice).toContain('pendingPlaybackBuffers.isEmpty')
    expect(voice).toContain('liveToolTurnPending ? .thinking : .listening')
    expect(voice).toContain('playbackPrebufferSeconds = 0.16')
    expect(voice).not.toContain('private var queuedAudio')
  })

  it('holds model echo locally while preserving sustained natural barge-in', () => {
    const voice = readFileSync(join(ROOT, 'ios/App/App/AssistantVoiceSwiftUI.swift'), 'utf8')

    expect(voice).toContain('bargeInRequiredFrames = 12')
    expect(voice).toContain('receiverBargeInRequiredFrames = 7')
    expect(voice).toContain('bargeInPreRollChunks = 14')
    expect(voice).toContain('echoFloorRMS * 2.35 + 0.008')
    expect(voice).toContain('voiceProcessingUnavailable && speakerEnabled')
    expect(voice).toContain('? bargeInRequiredFrames')
    expect(voice).toContain(': receiverBargeInRequiredFrames')
    expect(voice).toContain('beginLocalBargeIn()')
    expect(voice).toContain('for chunk in preRoll { sendRealtimeAudio(chunk) }')
    expect(voice).toContain('input.isVoiceProcessingEnabled')
    expect(voice).toContain('audioEngine.outputNode.isVoiceProcessingEnabled')
  })

  it('gates CallKit media on real activation and keeps receiver routing possible', () => {
    const voice = readFileSync(join(ROOT, 'ios/App/App/AssistantVoiceSwiftUI.swift'), 'utf8')
    const callKit = readFileSync(join(ROOT, 'ios/App/App/CallKitVoIP.swift'), 'utf8')
    const callUI = readFileSync(join(ROOT, 'ios/App/App/AgentCallUI.swift'), 'utf8')
    const liveConfigure = voice.slice(
      voice.indexOf('private func configureAudioOnQueue()'),
      voice.indexOf('private func capture('),
    )

    expect(voice).toContain('struct AlmaLiveAudioReadiness')
    expect(voice).toContain('callKitManaged && socketSetupComplete && !callKitAudioActive')
    expect(voice).toContain('socketSetupComplete && audioConfigured')
    expect(voice).toContain('func callKitAudioDeactivated()')
    expect(voice).toContain('try resumeAudioGraphAfterActivation()')
    expect(voice).toContain('updateReadiness { $0.audioConfigured = false }')
    expect(callKit).toContain('AgentCallController.shared.audioSessionDeactivated()')
    expect(liveConfigure).toContain('options: [.allowBluetoothHFP]')
    expect(liveConfigure).not.toContain('options: [.allowBluetoothHFP, .defaultToSpeaker]')
    expect(voice).toContain('overrideOutputAudioPort(enabled ? .speaker : .none)')
    expect(voice).toContain('isProximityMonitoringEnabled = callConnection == .live && receiver')
    // The category must exist BEFORE CXAnswerCallAction.fulfill() causes CallKit
    // to activate hardware; doing this after didActivate recreates the cold/
    // background silent call.
    expect(callUI).toContain('try eng.prepareCallKitAudioSession()')
    expect(callUI.indexOf('try eng.prepareCallKitAudioSession()')).toBeLessThan(
      callUI.indexOf('eng.begin()'),
    )
    expect(callKit).toContain('guard AgentCallController.shared.start(callId: call.broadcastId, purpose: "") else')
    expect(callKit.indexOf('AgentCallController.shared.start(callId: call.broadcastId')).toBeLessThan(
      callKit.indexOf('action.fulfill()', callKit.indexOf('AgentCallController.shared.start(callId: call.broadcastId')),
    )
    // A cold in-app call pre-activates once and does not immediately queue a
    // teardown; retries still stop the previous attempt.
    expect(voice).toContain('try self.live.prepareStandaloneAudioSession()')
    expect(voice).toContain('if liveSessionHasStarted { live.stop() }')
    // Speaker and receiver are both enforced. The old handler only repaired a
    // receiver->speaker change, so another subsystem could pin speaker OFF calls
    // back to loudspeaker forever.
    expect(voice).toContain('(!wantSpeaker && onSpeaker)')
    expect(voice).toContain('verifyRequestedRoute(attempt: 1)')
    expect(voice).toContain('options: [.allowBluetoothHFP]')
    // "speaking" UI is not treated as render proof anymore.
    expect(voice).toContain('output.renderStalled')
    expect(voice).toContain('renderedSamples > 0')
    expect(voice).toContain('output.renderRecovered')
  })
})
