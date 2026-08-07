import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

describe('native voice upload contract', () => {
  it('keeps the TestFlight workflow input aligned with the committed iOS build', () => {
    const project = readFileSync(join(ROOT, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')
    const workflow = readFileSync(join(ROOT, '.github/workflows/ios-testflight.yml'), 'utf8')
    const builds = [...project.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)]
      .map((match) => match[1])
    const expectedBuild = workflow.match(/expected_build:[\s\S]*?default: '(\d+)'/)?.[1]

    expect([...new Set(builds)]).toHaveLength(1)
    expect(expectedBuild).toBe(builds[0])
    expect(workflow).toContain(`this release: ${builds[0]}`)
  })

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
    expect(voice).toContain('debugInjectUserTurnsWhenReady')
    expect(voice).toContain('debugInjectNextQueuedTurnAfterPlayback')
    expect(voice).toContain('components(separatedBy: "|||")')
    expect(voice).toContain('model turn complete transcriptChars=')
    expect(voice).toContain('launchValue("ALMA_LIVE_SAY")')
    expect(voice).toContain('#if DEBUG')
  })

  it('keeps native voice delivery human, emotionally appropriate, and naturally finite', () => {
    const voice = readFileSync(join(ROOT, 'ios/App/App/AssistantVoiceSwiftUI.swift'), 'utf8')

    expect(voice).toContain('private var allowAffective = false')
    expect(voice).toContain('প্রশ্নের মতো করে পুনরাবৃত্তি করবে না')
    expect(voice).toContain('“আর কিছু জানতে চান?”')
    expect(voice).toContain('স্বাভাবিকভাবে থামবে')
    expect(voice).toContain('দুঃখ বা খারাপ খবরে')
    expect(voice).toContain('চাপ, রাগ বা হতাশায়')
    expect(voice).toContain('শ্বাসের শব্দ, দীর্ঘশ্বাস')
    expect(voice).toContain('"temperature": 0.4')
  })

  it('offers only the approved Gemini Live models and Bengali voice personas', () => {
    const voice = readFileSync(join(ROOT, 'ios/App/App/AssistantVoiceSwiftUI.swift'), 'utf8')

    expect(voice).toContain('struct AlmaLiveSettingsSheet: View')
    expect(voice).toContain('gemini-2.5-flash-native-audio-preview-12-2025')
    expect(voice).toContain('gemini-3.1-flash-live-preview')
    expect(voice).toContain('.init(id: "Aoede", name: "মায়া"')
    expect(voice).toContain('.init(id: "Achernar", name: "নীলা"')
    expect(voice).toContain('.init(id: "Kore", name: "তারা"')
    expect(voice).toContain('.init(id: "Charon", name: "আরিফ"')
    expect(voice).toContain('.init(id: "Orus", name: "অর্ক"')
    expect(voice).toContain('.init(id: "Sulafat", name: "সামি"')
    expect(voice).toContain('func applySelectedLiveProfileNow()')
    expect(voice).not.toContain('gpt-realtime')
  })

  it('discriminates loudspeaker echo while preserving natural barge-in', () => {
    const voice = readFileSync(join(ROOT, 'ios/App/App/AssistantVoiceSwiftUI.swift'), 'utf8')
    const probeStart = voice.indexOf('let echoExposedLoudspeaker')
    const directGateStart = voice.indexOf('let threshold = max(bargeInMinimumRMS', probeStart)
    const probeFlow = voice.slice(probeStart, directGateStart)
    const finishPlayback = voice.slice(
      voice.indexOf('private func finishModelPlayback('),
      voice.indexOf('private func beginLocalBargeIn('),
    )
    const stopPlayback = voice.slice(
      voice.indexOf('private func stopModelPlayback('),
      voice.indexOf('func sendToolResponse('),
    )

    expect(voice).toContain('receiverBargeInRequiredFrames = 7')
    expect(voice).toContain('bargeInMinimumRMS = 0.014')
    expect(voice).toContain('loudspeakerProbeCandidateRMS = 0.014')
    expect(voice).toContain('loudspeakerProbeSettleSeconds = 0.22')
    expect(voice).toContain('loudspeakerProbeWindowSeconds = 0.42')
    expect(voice).toContain('loudspeakerProbeVoiceRequiredFrames = 2')
    expect(voice).toContain('loudspeakerProbeRetainedEnergyRatio = 0.60')
    expect(voice).toContain('loudspeakerProbeDuckVolume: Float = 0.35')
    expect(voice).toContain('bargeInPreRollChunks = 14')
    expect(voice).toContain('echoFloorRMS * 1.9 + 0.003')
    expect(voice).toContain('voiceProcessingUnavailable && speakerEnabled')
    expect(voice).toContain('setLoudspeakerProbeMuted(true)')
    expect(voice).toContain('loudspeakerProbeDuckAppliedAt = Date()')
    expect(voice).toContain('duckAppliedAt != .distantPast')
    expect(voice).toContain('self.player.volume = muted ? self.loudspeakerProbeDuckVolume : 1')
    expect(probeFlow.indexOf('duckAppliedAt != .distantPast'))
      .toBeLessThan(probeFlow.indexOf('loudspeakerProbeVoiceFrames += 1'))
    expect(probeFlow).toContain('loudspeakerProbeCandidatePeakRMS')
    expect(probeFlow).toContain('* loudspeakerProbeRetainedEnergyRatio')
    expect(finishPlayback).toContain('pendingPlaybackBuffers.isEmpty')
    expect(finishPlayback).toContain('self?.player.volume = 1')
    expect(stopPlayback).toContain('self?.player.volume = 1')
    expect(voice).toContain('bargeSpeechFrames >= receiverBargeInRequiredFrames')
    expect(voice).toContain('beginLocalBargeIn()')
    expect(voice).toContain('for chunk in preRoll { sendRealtimeAudio(chunk) }')
    expect(voice).toContain('let serverCanOwnBargeIn = !voiceProcessingUnavailable || !speakerEnabled')
    expect(voice).toContain('if serverCanOwnBargeIn {')
    expect(voice).toContain('sendNormally = true')
    expect(voice).toContain('input.isVoiceProcessingEnabled')
    expect(voice).toContain('audioEngine.outputNode.isVoiceProcessingEnabled')
    expect(voice).toContain('listenSuppressedUntil = Date().addingTimeInterval(')
    expect(voice).toContain('echoExposedLoudspeaker ? 1.2 : 0.25')
    expect(voice).toContain('if Date() < listenSuppressedUntil')
    expect(voice).toContain('listenSuppressedUntil = .distantPast')
    expect(voice).toContain('"endOfSpeechSensitivity": "END_SENSITIVITY_LOW"')
    expect(voice).toContain('"silenceDurationMs": 1200')
    expect(voice).toContain('listenNoiseFloorRMS * 1.8 + 0.001')
    expect(voice).toContain('listenNoiseFloorRMS * 1.25 + 0.001')
    expect(voice).toContain('listenContinuousLoudFrames >= 9000')
    expect(voice).not.toContain('listenContinuousLoudFrames >= 1500')
    expect(voice).toContain('["audioStreamEnd": true]')
    expect(voice).toContain('input stream flushed after listen gate close')

    // Acoustic discriminator invariant: a pure loudspeaker echo that follows
    // the player duck must stay below the retained-energy threshold, while a
    // modest nearby voice mixed with that echo must cross it. This guards both
    // regressions the owner observed: self-cutting and an uninterruptible agent.
    const candidateRms = 0.014
    const duckRatio = 0.35
    const retainedRatio = 0.60
    const preDuckEcho = 0.08
    const pureEchoAfterDuck = preDuckEcho * duckRatio
    const retainedThreshold = preDuckEcho * retainedRatio
    const quietHumanRms = 0.045
    const humanPlusEcho = Math.hypot(pureEchoAfterDuck, quietHumanRms)

    expect(candidateRms).toBeLessThan(0.025)
    expect(pureEchoAfterDuck).toBeLessThan(retainedThreshold)
    expect(humanPlusEcho).toBeGreaterThan(retainedThreshold)
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
    expect(voice).toContain('try audioEngine.inputNode.setVoiceProcessingEnabled(true)')
    expect(voice).toContain('voiceProcessingUnavailable = !audioEngine.inputNode.isVoiceProcessingEnabled')
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
