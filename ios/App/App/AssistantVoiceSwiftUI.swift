//
//  AssistantVoiceSwiftUI.swift
//  ALMA ERP — S6b: the voice-to-voice console (orb page), fully native.
//
//  A 100% clone of the web VoiceConsole (src/agent/components/voice/) — same
//  near-black canvas, state-hued aurora + dot grid, fluid orb with a 72-bar
//  reactive ring, status badge, transcript pill, live spoken-subtitle caption,
//  action-card feed, and the কথোপকথন dock — but running on native audio, which
//  also fixes the owner's two live complaints about the web orb:
//
//    • "tap করলে 2–5s পরে কাজ করে" — the web paid getUserMedia + AudioWorklet +
//      OpenAI session-mint latency on every tap. Natively the audio session is
//      prewarmed when the console opens; tapping the orb just starts an
//      AVAudioRecorder → the mic is hot in tens of milliseconds.
//    • "voice dewar agei nij thekei kaj shuru kore" — the web VAD used a fixed
//      0.045 RMS speech threshold with no ambient calibration, so room noise
//      could count as speech. The native VAD calibrates a noise floor for the
//      first 400ms, requires 250ms of SUSTAINED speech above max(0.045, floor×2.5)
//      before arming, and only then starts the end-of-utterance silence timer.
//
//  Voice turn: record (m4a) → /api/assistant/transcribe (Whisper) → /api/assistant/chat
//  {voice:true} SSE → sentence-chunked /api/assistant/tts playback (prefetch next
//  chunk while one plays) → auto-relisten in কথোপকথন mode. Same web constants:
//  silence 2600ms (1400ms for <3s utterances), 8s no-speech abort, 180s cap,
//  ack pool, 4s heartbeat after 14s silence.
//
//  HALF-DUPLEX (2026-07-06): the mic is open ONLY in `.listening`. While the agent
//  speaks, a `ttsActive` gate keeps EVERY mic shut — STT, auto-listen, and the wake
//  word — so the agent can never hear (and re-transcribe) its own TTS. The old
//  auto barge-in mic did exactly that on the loud, no-echo-cancellation speaker
//  route, so it is gone; interrupting mid-reply is now a deliberate orb TAP.
//

import SwiftUI
import UIKit
import AVFoundation
import MetalKit
import Speech
import SoundAnalysis
import PhotosUI
import os

// MARK: - Gemini Live models + Bengali voice presets

struct AlmaLiveModelChoice: Identifiable, Hashable {
    let id: String
    let title: String
    let detail: String
    let badge: String
    let strengths: String
    let limitations: String
    let costLifecycle: String
    let bestUse: String
}

struct AlmaLiveVoiceChoice: Identifiable, Hashable {
    let id: String
    let name: String
    let detail: String
    let symbol: String
}

// MARK: - Live Voice recovery rollout gates

/// Phase-specific rollback switches must be checked where behavior starts. Do
/// not add a future phase here until its entry point actually reads the flag.
enum AlmaLiveVoiceRecoveryFeature: String {
    case evidenceV1 = "evidence-v1"
    case previewCatalogV1 = "preview-catalog-v1"
    case privateLiveActivityV1 = "private-live-activity-v1"
    case profileTransactionV1 = "profile-transaction-v1"
    case toolOrchestrationV1 = "tool-orchestration-v1"
    case phase1BContractV1 = "phase1b-contract-v1"
    case inputTurnReducerV1 = "input-turn-reducer-v1"
    case lifecycleReducerV1 = "lifecycle-reducer-v1"

    var defaultEnabled: Bool {
        switch self {
        case .evidenceV1, .previewCatalogV1, .privateLiveActivityV1,
             .profileTransactionV1, .toolOrchestrationV1, .phase1BContractV1,
             .inputTurnReducerV1, .lifecycleReducerV1:
            true
        }
    }
}

enum AlmaLiveVoiceRecoveryFeatures {
    private static let defaultsPrefix = "alma-live-voice-recovery-"

    static func isEnabled(
        _ feature: AlmaLiveVoiceRecoveryFeature,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        defaults: UserDefaults = .standard
    ) -> Bool {
        let environmentKey = "ALMA_LIVE_VOICE_" + feature.rawValue
            .replacingOccurrences(of: "-", with: "_")
            .uppercased()
        if let value = environment[environmentKey]?.lowercased() {
            if ["1", "true", "yes", "on"].contains(value) { return true }
            if ["0", "false", "no", "off"].contains(value) { return false }
        }
        let key = defaultsPrefix + feature.rawValue
        guard defaults.object(forKey: key) != nil else { return feature.defaultEnabled }
        return defaults.bool(forKey: key)
    }

    static func set(
        _ enabled: Bool,
        for feature: AlmaLiveVoiceRecoveryFeature,
        defaults: UserDefaults = .standard
    ) {
        defaults.set(enabled, forKey: defaultsPrefix + feature.rawValue)
    }
}

enum AlmaLiveVoicePreferences {
    static let modelKey = "alma-live-model"
    static let voiceKey = "alma-live-voice"
    static let selectionVersionKey = "alma-live-selection-version"
    private static let legacyGemini25 = "gemini-2.5-flash-native-audio-preview-12-2025"
    private static let legacyGemini31 = "gemini-3.1-flash-live-preview"
    private static let bundledContract = try? AlmaLiveVoiceContractStore.load()

    static var activeContract: AlmaLiveVoiceContract? {
        guard AlmaLiveVoiceRecoveryFeatures.isEnabled(.phase1BContractV1) else { return nil }
        return bundledContract
    }

    static var gemini25: String {
        activeContract?.enabledModels.first(where: { $0.capabilities.affectiveDialog })?.id
            ?? legacyGemini25
    }

    static var gemini31: String {
        activeContract?.enabledModels.first(where: { !$0.capabilities.affectiveDialog })?.id
            ?? legacyGemini31
    }

    private static let legacyModels: [AlmaLiveModelChoice] = [
        .init(id: legacyGemini25, title: "Gemini 2.5 Live",
              detail: "বাংলা কথোপকথন ও আবেগের টোনে বেশি স্বাভাবিক",
              badge: "Natural",
              strengths: "স্বাভাবিক pacing, কণ্ঠের mood ও জটিল workflow; synchronous ও asynchronous function calling সমর্থন করে।",
              limitations: "Preview model; 3.1 হলো Google-এর recommended replacement। Preview behavior ও rate limit বদলাতে পারে।",
              costLifecycle: "Preview · shutdown date ঘোষণা হয়নি · audio input $3/M token, output $12/M token; transcription text আলাদা bill হয়।",
              bestUse: "স্বাভাবিক বাংলা আলাপ, দীর্ঘ ব্যাখ্যা এবং non-blocking tool workflow"),
        .init(id: legacyGemini31, title: "Gemini 3.1 Live",
              detail: "নতুন, দ্রুত ও নির্ভুল রিয়েলটাইম কথোপকথন",
              badge: "Fast",
              strengths: "Low-latency audio-to-audio, acoustic nuance, numeric precision ও multimodal awareness।",
              limitations: "Preview model; Live function calling synchronous-only—tool result না আসা পর্যন্ত model অপেক্ষা করে।",
              costLifecycle: "Preview · shutdown date ঘোষণা হয়নি · audio input $3/M token (~$0.005/min), output $12/M (~$0.018/min); text/transcription extra।",
              bestUse: "দ্রুত realtime প্রশ্নোত্তর, সংখ্যাভিত্তিক তথ্য ও synchronous ERP lookup"),
    ]

    // The display names are ALMA personas; `id` is Google's official voice name.
    private static let legacyVoices: [AlmaLiveVoiceChoice] = [
        .init(id: "Aoede", name: "মায়া", detail: "হালকা · স্বাভাবিক", symbol: "wind"),
        .init(id: "Achernar", name: "নীলা", detail: "কোমল · শান্ত", symbol: "moon.stars.fill"),
        .init(id: "Kore", name: "তারা", detail: "দৃঢ় · পরিষ্কার", symbol: "sparkles"),
        .init(id: "Charon", name: "আরিফ", detail: "তথ্যপূর্ণ · স্থির", symbol: "waveform"),
        .init(id: "Orus", name: "অর্ক", detail: "গভীর · পেশাদার", symbol: "briefcase.fill"),
        .init(id: "Sulafat", name: "সামি", detail: "উষ্ণ · বন্ধুসুলভ", symbol: "sun.max.fill"),
    ]

    static var models: [AlmaLiveModelChoice] {
        activeContract?.modelChoices ?? legacyModels
    }

    static var voices: [AlmaLiveVoiceChoice] {
        activeContract?.voiceChoices ?? legacyVoices
    }

    private static var selection: AlmaLiveVoiceMigratedSelection {
        let defaults = UserDefaults.standard
        guard let contract = activeContract else {
            let model = defaults.string(forKey: modelKey)
                .flatMap { saved in legacyModels.contains(where: { $0.id == saved }) ? saved : nil }
                ?? legacyGemini25
            let voice = defaults.string(forKey: voiceKey)
                .flatMap { saved in legacyVoices.contains(where: { $0.id == saved }) ? saved : nil }
                ?? "Aoede"
            return .init(selectionVersion: 0, modelID: model, voiceID: voice, migrated: false)
        }
        let version = defaults.object(forKey: selectionVersionKey) == nil
            ? nil : defaults.integer(forKey: selectionVersionKey)
        let migrated = contract.migrate(.init(
            selectionVersion: version,
            modelID: defaults.string(forKey: modelKey),
            voiceID: defaults.string(forKey: voiceKey)))
        if migrated.migrated {
            defaults.set(migrated.modelID, forKey: modelKey)
            defaults.set(migrated.voiceID, forKey: voiceKey)
            defaults.set(migrated.selectionVersion, forKey: selectionVersionKey)
        }
        return migrated
    }

    static var modelID: String { selection.modelID }

    static var voiceID: String { selection.voiceID }

    static var requestBody: [String: String] {
        var body = ["model": modelID, "voice": voiceID]
        if let contract = activeContract { body["contractVersion"] = contract.contractVersion }
        return body
    }

    static func save(modelID: String, voiceID: String) {
        guard models.contains(where: { $0.id == modelID }),
              voices.contains(where: { $0.id == voiceID }) else { return }
        UserDefaults.standard.set(modelID, forKey: modelKey)
        UserDefaults.standard.set(voiceID, forKey: voiceKey)
        if let contract = activeContract {
            UserDefaults.standard.set(contract.schemaVersion, forKey: selectionVersionKey)
        }
    }
}

struct AlmaLiveVoiceProfile: Equatable, Hashable {
    let modelID: String
    let voiceID: String

    var isValid: Bool {
        AlmaLiveVoicePreferences.models.contains { $0.id == modelID }
            && AlmaLiveVoicePreferences.voices.contains { $0.id == voiceID }
    }
}

struct AlmaLiveVoiceProfileTransaction: Equatable {
    enum Phase: Equatable {
        case idle
        case applying(previous: AlmaLiveVoiceProfile, proposed: AlmaLiveVoiceProfile)
        case rollingBack(previous: AlmaLiveVoiceProfile, rejected: AlmaLiveVoiceProfile)
    }

    private(set) var saved: AlmaLiveVoiceProfile
    private(set) var active: AlmaLiveVoiceProfile
    private(set) var phase: Phase = .idle

    init(saved: AlmaLiveVoiceProfile) {
        self.saved = saved
        active = saved
    }

    var isBusy: Bool { phase != .idle }

    var requested: AlmaLiveVoiceProfile {
        switch phase {
        case .idle: return active
        case .applying(_, let proposed): return proposed
        case .rollingBack(let previous, _): return previous
        }
    }

    mutating func save(_ profile: AlmaLiveVoiceProfile) -> Bool {
        guard profile.isValid else { return false }
        saved = profile
        return true
    }

    mutating func beginApply(_ proposed: AlmaLiveVoiceProfile) -> Bool {
        guard phase == .idle, proposed.isValid else { return false }
        guard proposed != active else { return true }
        phase = .applying(previous: active, proposed: proposed)
        return true
    }

    mutating func connected(_ profile: AlmaLiveVoiceProfile) -> Bool {
        switch phase {
        case .idle:
            guard profile == active else { return false }
        case .applying(_, let proposed):
            guard profile == proposed else { return false }
            active = proposed
            phase = .idle
        case .rollingBack(let previous, _):
            guard profile == previous else { return false }
            active = previous
            phase = .idle
        }
        return true
    }

    mutating func failed(_ profile: AlmaLiveVoiceProfile) -> AlmaLiveVoiceProfile? {
        switch phase {
        case .applying(let previous, let proposed) where proposed == profile:
            phase = .rollingBack(previous: previous, rejected: proposed)
            return previous
        case .rollingBack(let previous, _) where previous == profile:
            phase = .idle
            return nil
        default:
            return nil
        }
    }

    mutating func resetForNewCall(saved profile: AlmaLiveVoiceProfile) {
        saved = profile
        active = profile
        phase = .idle
    }

    mutating func abort() {
        phase = .idle
    }
}

struct AlmaLiveVoiceProviderUsage: Codable, Equatable {
    var inputAudioTokens = 0
    var outputAudioTokens = 0
    var inputTextTokens = 0
    var outputTextTokens = 0
    var inputTotalTokens = 0
    var outputTotalTokens = 0

    mutating func mergeCumulative(_ newer: AlmaLiveVoiceProviderUsage) {
        inputAudioTokens = max(inputAudioTokens, newer.inputAudioTokens)
        outputAudioTokens = max(outputAudioTokens, newer.outputAudioTokens)
        inputTextTokens = max(inputTextTokens, newer.inputTextTokens)
        outputTextTokens = max(outputTextTokens, newer.outputTextTokens)
        inputTotalTokens = max(inputTotalTokens, newer.inputTotalTokens)
        outputTotalTokens = max(outputTotalTokens, newer.outputTotalTokens)
    }
}

enum AlmaLiveVoiceProviderUsageParser {
    static func parse(_ metadata: [String: Any]) -> AlmaLiveVoiceProviderUsage {
        var usage = AlmaLiveVoiceProviderUsage()
        usage.inputTotalTokens = nonNegativeInt(metadata["promptTokenCount"])
        usage.outputTotalTokens = nonNegativeInt(
            metadata["responseTokenCount"] ?? metadata["candidatesTokenCount"])
        for detail in details(
            metadata["promptTokensDetails"] ?? metadata["promptTokenDetails"]
        ) {
            switch modality(detail) {
            case "AUDIO": usage.inputAudioTokens += nonNegativeInt(detail["tokenCount"])
            case "TEXT": usage.inputTextTokens += nonNegativeInt(detail["tokenCount"])
            default: break
            }
        }
        for detail in details(
            metadata["responseTokensDetails"] ?? metadata["responseTokenDetails"]
        ) {
            switch modality(detail) {
            case "AUDIO": usage.outputAudioTokens += nonNegativeInt(detail["tokenCount"])
            case "TEXT": usage.outputTextTokens += nonNegativeInt(detail["tokenCount"])
            default: break
            }
        }
        return usage
    }

    private static func details(_ value: Any?) -> [[String: Any]] {
        value as? [[String: Any]] ?? []
    }

    private static func modality(_ detail: [String: Any]) -> String {
        (detail["modality"] as? String ?? "").uppercased()
    }

    private static func nonNegativeInt(_ value: Any?) -> Int {
        guard let number = value as? NSNumber else { return 0 }
        return max(0, number.intValue)
    }
}

struct AlmaLiveVoiceUsageSegment: Codable, Equatable {
    let model: String
    let voice: String
    var inputAudioQueuedBytes = 0
    var outputAudioReceivedBytes = 0
    var inputTranscriptionCharacters = 0
    var outputTranscriptionCharacters = 0
    var providerUsage = AlmaLiveVoiceProviderUsage()
}

struct AlmaLiveVoiceUsageReport: Codable, Equatable {
    let callId: String
    let conversationId: String?
    let segments: [AlmaLiveVoiceUsageSegment]
}

final class AlmaLiveVoiceUsageMeter: @unchecked Sendable {
    private let lock = NSLock()
    private var callID = ""
    private var order: [AlmaLiveVoiceProfile] = []
    private var segments: [AlmaLiveVoiceProfile: AlmaLiveVoiceUsageSegment] = [:]

    func begin(callID: String) {
        lock.lock()
        self.callID = callID
        order.removeAll(keepingCapacity: true)
        segments.removeAll(keepingCapacity: true)
        lock.unlock()
    }

    func recordInputAudio(byteCount: Int, profile: AlmaLiveVoiceProfile) {
        mutate(profile) { $0.inputAudioQueuedBytes += max(0, byteCount) }
    }

    func recordOutputAudio(byteCount: Int, profile: AlmaLiveVoiceProfile) {
        mutate(profile) { $0.outputAudioReceivedBytes += max(0, byteCount) }
    }

    func recordInputTranscription(_ text: String, profile: AlmaLiveVoiceProfile) {
        mutate(profile) { $0.inputTranscriptionCharacters += text.count }
    }

    func recordOutputTranscription(_ text: String, profile: AlmaLiveVoiceProfile) {
        mutate(profile) { $0.outputTranscriptionCharacters += text.count }
    }

    func recordProviderUsage(
        _ usage: AlmaLiveVoiceProviderUsage,
        profile: AlmaLiveVoiceProfile
    ) {
        mutate(profile) { $0.providerUsage.mergeCumulative(usage) }
    }

    func report(conversationID: String?) -> AlmaLiveVoiceUsageReport? {
        lock.lock()
        defer { lock.unlock() }
        guard !callID.isEmpty else { return nil }
        let rows = order.compactMap { segments[$0] }
        guard !rows.isEmpty else { return nil }
        return AlmaLiveVoiceUsageReport(
            callId: callID,
            conversationId: conversationID,
            segments: rows)
    }

    private func mutate(
        _ profile: AlmaLiveVoiceProfile,
        _ body: (inout AlmaLiveVoiceUsageSegment) -> Void
    ) {
        guard profile.isValid else { return }
        lock.lock()
        if segments[profile] == nil {
            order.append(profile)
            segments[profile] = AlmaLiveVoiceUsageSegment(
                model: profile.modelID,
                voice: profile.voiceID)
        }
        var segment = segments[profile]!
        body(&segment)
        segments[profile] = segment
        lock.unlock()
    }
}

// MARK: - Deterministic Gemini Live tool orchestration

enum AlmaLiveVoiceToolName: String, CaseIterable {
    case quickLookup = "quick_erp_lookup"
    case endCall = "end_call"
    case runAgentTurn = "run_agent_turn"
}

struct AlmaLiveVoiceToolInvocation: Equatable {
    enum Payload: Equatable {
        case quickLookup(tool: String)
        case endCall
        case runAgentTurn(request: String)
        case malformed
        case unsupported
    }

    let callID: String
    let functionName: String
    let payload: Payload

    /// Provider call IDs are opaque wire identities. Never synthesize, trim, or
    /// normalize them: a response must echo the exact ID and invoked name.
    static func decode(_ value: [String: Any]) -> AlmaLiveVoiceToolInvocation? {
        guard let callID = value["id"] as? String,
              !callID.isEmpty,
              callID.count <= 512,
              let functionName = value["name"] as? String,
              !functionName.isEmpty,
              functionName.count <= 128 else { return nil }
        let args = value["args"] as? [String: Any]
        let payload: Payload
        switch functionName {
        case AlmaLiveVoiceToolName.quickLookup.rawValue:
            if let tool = args?["tool"] as? String, !tool.isEmpty {
                payload = .quickLookup(tool: tool)
            } else {
                payload = .malformed
            }
        case AlmaLiveVoiceToolName.endCall.rawValue:
            payload = .endCall
        case AlmaLiveVoiceToolName.runAgentTurn.rawValue:
            if let request = args?["request"] as? String, !request.isEmpty {
                payload = .runAgentTurn(request: request)
            } else {
                payload = .malformed
            }
        default:
            payload = .unsupported
        }
        return .init(callID: callID, functionName: functionName, payload: payload)
    }
}

/// Pure ordered reducer for one logical Live session. Execution and response
/// delivery are both FIFO, but backend completion may arrive in any order. A
/// physical websocket replacement supersedes only its in-flight send ticket;
/// accepted calls and exact completed payloads remain available for replay.
struct AlmaLiveVoiceToolLedger: Equatable {
    enum Admission: Equatable {
        case accepted
        case duplicate(replayScheduled: Bool)
        case conflictingIdentity
        case capacityExceeded
    }

    struct ResponseTicket: Equatable {
        let ticketID: Int
        let transportOrdinal: Int
        let callID: String
        let functionName: String
        let result: String
    }

    private enum Phase: Equatable {
        case queued
        case executing
        case completed(result: String)
        case sending(result: String, ticketID: Int, transportOrdinal: Int)
        case delivered(result: String)
        case cancelled
    }

    private struct Entry: Equatable {
        let invocation: AlmaLiveVoiceToolInvocation
        var phase: Phase
    }

    private static let maximumEntries = 128
    private var order: [String] = []
    private var entries: [String: Entry] = [:]
    private var nextTicketID = 0

    var hasOutstandingCalls: Bool {
        entries.values.contains {
            switch $0.phase {
            case .delivered, .cancelled: return false
            default: return true
            }
        }
    }

    mutating func reset() {
        order.removeAll(keepingCapacity: true)
        entries.removeAll(keepingCapacity: true)
        nextTicketID = 0
    }

    mutating func admit(_ invocation: AlmaLiveVoiceToolInvocation) -> Admission {
        if var existing = entries[invocation.callID] {
            guard existing.invocation == invocation else {
                return .conflictingIdentity
            }
            if case .delivered(let result) = existing.phase {
                existing.phase = .completed(result: result)
                entries[invocation.callID] = existing
                return .duplicate(replayScheduled: true)
            }
            return .duplicate(replayScheduled: false)
        }
        if entries.count >= Self.maximumEntries {
            guard let retiredID = order.first(where: { id in
                guard let entry = entries[id] else { return true }
                switch entry.phase {
                case .delivered, .cancelled: return true
                default: return false
                }
            }) else { return .capacityExceeded }
            entries.removeValue(forKey: retiredID)
            order.removeAll { $0 == retiredID }
        }
        order.append(invocation.callID)
        entries[invocation.callID] = Entry(invocation: invocation, phase: .queued)
        return .accepted
    }

    /// At most one provider call executes at a time. This preserves provider
    /// order even when one frame contains several heterogeneous function calls.
    mutating func nextExecution() -> AlmaLiveVoiceToolInvocation? {
        guard !entries.values.contains(where: {
            if case .executing = $0.phase { return true }
            return false
        }) else { return nil }
        guard let id = order.first(where: {
            guard let entry = entries[$0] else { return false }
            if case .queued = entry.phase { return true }
            return false
        }), var entry = entries[id] else { return nil }
        entry.phase = .executing
        entries[id] = entry
        return entry.invocation
    }

    @discardableResult
    mutating func complete(callID: String, functionName: String, result: String) -> Bool {
        guard var entry = entries[callID],
              entry.invocation.functionName == functionName,
              case .executing = entry.phase else { return false }
        entry.phase = .completed(result: result)
        entries[callID] = entry
        return true
    }

    /// Returns only executing calls, whose local/backend Tasks must be cancelled.
    /// Queued/completed responses are suppressed without starting new work.
    mutating func cancel(callIDs: [String]) -> [AlmaLiveVoiceToolInvocation] {
        var executing: [AlmaLiveVoiceToolInvocation] = []
        for id in callIDs {
            guard var entry = entries[id] else { continue }
            if case .executing = entry.phase { executing.append(entry.invocation) }
            switch entry.phase {
            case .delivered, .cancelled:
                continue
            default:
                entry.phase = .cancelled
                entries[id] = entry
            }
        }
        return executing
    }

    /// The earliest nonterminal call is a strict response barrier. A later,
    /// faster tool can complete first, but its wire response cannot overtake it.
    mutating func nextResponse(transportOrdinal: Int) -> ResponseTicket? {
        for id in order {
            guard var entry = entries[id] else { continue }
            switch entry.phase {
            case .cancelled, .delivered:
                continue
            case .queued, .executing:
                return nil
            case .completed(let result):
                nextTicketID &+= 1
                if nextTicketID == 0 { nextTicketID = 1 }
                let ticket = ResponseTicket(
                    ticketID: nextTicketID,
                    transportOrdinal: transportOrdinal,
                    callID: entry.invocation.callID,
                    functionName: entry.invocation.functionName,
                    result: result)
                entry.phase = .sending(
                    result: result,
                    ticketID: ticket.ticketID,
                    transportOrdinal: transportOrdinal)
                entries[id] = entry
                return ticket
            case .sending(let result, _, let sourceTransport):
                guard sourceTransport != transportOrdinal else { return nil }
                // A replacement transport supersedes the old ticket. Its later
                // completion cannot retire this newly minted replay ticket.
                entry.phase = .completed(result: result)
                entries[id] = entry
                return nextResponse(transportOrdinal: transportOrdinal)
            }
        }
        return nil
    }

    @discardableResult
    mutating func finishSend(_ ticket: ResponseTicket, succeeded: Bool) -> Bool {
        guard var entry = entries[ticket.callID],
              entry.invocation.functionName == ticket.functionName,
              case .sending(let result, let ticketID, let transportOrdinal) = entry.phase,
              ticketID == ticket.ticketID,
              transportOrdinal == ticket.transportOrdinal else { return false }
        entry.phase = succeeded ? .delivered(result: result) : .completed(result: result)
        entries[ticket.callID] = entry
        return true
    }

    mutating func invalidateTransport(_ transportOrdinal: Int) {
        for id in order {
            guard var entry = entries[id],
                  case .sending(let result, _, let sourceTransport) = entry.phase,
                  sourceTransport == transportOrdinal else { continue }
            entry.phase = .completed(result: result)
            entries[id] = entry
        }
    }
}

// MARK: - Full-duplex barge-in evidence

/// Pure decision math for the no-AEC loudspeaker path.  Volume by itself cannot
/// distinguish a nearby owner from ALMA's rendered voice.  We therefore require
/// both (a) Apple's built-in sound classifier to prefer speech over music/noise
/// and (b) the microphone waveform to stop matching ALMA's rendered waveform.
/// Keeping this function side-effect free makes the false-stop boundaries unit
/// testable without opening an audio device.
enum AlmaLiveBargeInEvidence {
    static func normalizedCorrelation(_ lhs: [Float], _ rhs: [Float],
                                      maximumOffset: Int = 28) -> Double {
        guard lhs.count >= 24, rhs.count >= 24 else { return 0 }
        let limit = min(maximumOffset, min(lhs.count, rhs.count) / 4)
        var best = 0.0
        for offset in -limit...limit {
            let lhsStart = max(0, offset)
            let rhsStart = max(0, -offset)
            let count = min(lhs.count - lhsStart, rhs.count - rhsStart)
            guard count >= 20 else { continue }
            var lhsMean = 0.0
            var rhsMean = 0.0
            for index in 0..<count {
                lhsMean += Double(lhs[lhsStart + index])
                rhsMean += Double(rhs[rhsStart + index])
            }
            lhsMean /= Double(count)
            rhsMean /= Double(count)
            var dot = 0.0
            var lhsEnergy = 0.0
            var rhsEnergy = 0.0
            for index in 0..<count {
                let a = Double(lhs[lhsStart + index]) - lhsMean
                let b = Double(rhs[rhsStart + index]) - rhsMean
                dot += a * b
                lhsEnergy += a * a
                rhsEnergy += b * b
            }
            guard lhsEnergy > 1e-8, rhsEnergy > 1e-8 else { continue }
            best = max(best, abs(dot) / sqrt(lhsEnergy * rhsEnergy))
        }
        return min(1, best)
    }

    static func isHumanSpeech(micRMS: Double,
                              echoFloorRMS: Double,
                              echoCorrelation: Double,
                              calibratedEchoCorrelation: Double,
                              speechConfidence: Double,
                              musicConfidence: Double,
                              noiseConfidence: Double) -> Bool {
        // If the acoustic path never produced a reliable correlation, do not
        // guess; the older volume-duck discriminator remains the fallback.
        guard calibratedEchoCorrelation >= 0.20 else { return false }
        let speechDominates = speechConfidence >= 0.34
            && speechConfidence >= musicConfidence + 0.12
            && speechConfidence >= noiseConfidence + 0.06
        guard speechDominates else { return false }
        let correlationBoundary = max(0.14, calibratedEchoCorrelation * 0.62)
        let echoStoppedMatching = echoCorrelation <= correlationBoundary
        let nearbyEnergyRise = micRMS >= max(0.012, echoFloorRMS * 1.08 + 0.0015)
        return echoStoppedMatching && nearbyEnergyRise
    }
}

private final class AlmaLiveSoundObserver: NSObject, SNResultsObserving {
    let onClassification: (Double, Double, Double) -> Void

    init(onClassification: @escaping (Double, Double, Double) -> Void) {
        self.onClassification = onClassification
    }

    func request(_ request: any SNRequest, didProduce result: any SNResult) {
        guard let result = result as? SNClassificationResult else { return }
        let speech = result.classification(forIdentifier: "speech")?.confidence ?? 0
        let musicIDs = ["music", "singing", "choir_singing", "singing_bowl", "keyboard_musical"]
        let music = musicIDs.reduce(0.0) {
            max($0, result.classification(forIdentifier: $1)?.confidence ?? 0)
        }
        let noise = result.classifications.reduce(0.0) { partial, item in
            item.identifier.contains("noise") ? max(partial, item.confidence) : partial
        }
        onClassification(speech, music, noise)
    }

    func request(_ request: any SNRequest, didFailWithError error: any Error) {
        #if DEBUG
        NSLog("ALMA-VOICE sound classifier failed: %@", String(describing: error))
        #endif
    }

    func requestDidComplete(_ request: any SNRequest) {}
}

// MARK: - State + strings (web STATUS dict parity)

enum AlmaVoiceState: String {
    case idle, listening, transcribing, thinking, speaking, error

    var statusText: String {
        switch self {
        case .idle: return "নিষ্ক্রিয়"
        case .listening: return "শুনছি…"
        case .transcribing: return "বুঝে নিচ্ছি…"
        case .thinking: return "ভাবছি…"
        case .speaking: return "বলছি"
        case .error: return "আবার চেষ্টা করুন"
        }
    }

    /// FluidOrb hue per state (degrees, web FluidOrb.tsx).
    var hue: Double {
        switch self {
        case .idle: return 168        // cyan
        case .listening: return 145   // emerald
        case .transcribing, .thinking: return 265 // violet
        case .speaking: return 210    // azure
        case .error: return 8         // red-orange
        }
    }

    var tint: Color { Color(hue: hue / 360.0, saturation: 0.75, brightness: 0.95) }
}

/// The user-visible lifecycle of the in-app AI call. This is intentionally
/// separate from `AlmaVoiceState`: a call can be connected while the model is
/// listening, thinking, or speaking, and the UI must never confuse those two
/// kinds of state.
enum AlmaCallConnectionState: Equatable {
    case idle, connecting, live, reconnecting, failed
}

/// The live socket and the iOS media session become ready independently.  In
/// particular, a CallKit answer may deliver Gemini's `setupComplete` before
/// `CXProviderDelegate.didActivate`, or in the opposite order.  Media is usable
/// only after both signals have arrived; keeping this as a small value type
/// makes the ordering contract deterministic and unit-testable.
struct AlmaLiveAudioReadiness: Equatable {
    var socketSetupComplete = false
    var callKitManaged = false
    var callKitAudioActive = false
    var audioConfigured = false
    var setupPublished = false
    var socketAttempt: AlmaLiveVoiceSocketAttempt?
    var pendingCallKitAttempt: AlmaLiveVoiceSocketAttempt?

    var waitingForCallKit: Bool {
        callKitManaged && socketSetupComplete && !callKitAudioActive
    }

    var canPublishLive: Bool {
        socketSetupComplete && audioConfigured
            && (!callKitManaged || callKitAudioActive)
            && !setupPublished
    }

    mutating func beginSocketAttempt() {
        socketSetupComplete = false
        setupPublished = false
        socketAttempt = nil
        pendingCallKitAttempt = nil
    }

    mutating func bindSocketAttempt(_ attempt: AlmaLiveVoiceSocketAttempt) {
        socketSetupComplete = false
        setupPublished = false
        socketAttempt = attempt
        pendingCallKitAttempt = nil
    }

    @discardableResult
    mutating func acceptSocketSetup(_ attempt: AlmaLiveVoiceSocketAttempt) -> Bool {
        guard socketAttempt == attempt else { return false }
        socketSetupComplete = true
        return true
    }

    @discardableResult
    mutating func deferSetupForCallKit(_ attempt: AlmaLiveVoiceSocketAttempt) -> Bool {
        guard socketAttempt == attempt, socketSetupComplete, !setupPublished else {
            return false
        }
        pendingCallKitAttempt = attempt
        return true
    }

    @discardableResult
    mutating func claimPublish(_ attempt: AlmaLiveVoiceSocketAttempt) -> Bool {
        guard socketAttempt == attempt, canPublishLive else { return false }
        setupPublished = true
        if pendingCallKitAttempt == attempt { pendingCallKitAttempt = nil }
        return true
    }

    mutating func resetMedia() {
        socketSetupComplete = false
        audioConfigured = false
        setupPublished = false
        socketAttempt = nil
        pendingCallKitAttempt = nil
    }

    /// `nil` means the physical attempt is no longer current. Keeping stale and
    /// current-but-pending distinct prevents teardown races from becoming false
    /// setup/resumption failure claims.
    func setupAcceptance(for attempt: AlmaLiveVoiceSocketAttempt) -> Bool? {
        guard socketAttempt == attempt else { return nil }
        return socketSetupComplete
    }
}

/// Runtime socket-attempt identity. The ordinal remains unique even when the
/// diagnostics gate is disabled and its evidence generation would otherwise be 0.
struct AlmaLiveVoiceSocketAttempt: Equatable {
    let ordinal: Int
    let socketIdentity: ObjectIdentifier
    let evidenceGeneration: Int
    let startAttempt: AlmaLiveVoiceStartAttemptState.Token
    let engineConnectionGeneration: Int
    let recoveryAttempt: Bool
    let resumptionRequested: Bool

    init(
        ordinal: Int,
        socketIdentity: ObjectIdentifier,
        evidenceGeneration: Int,
        startAttempt: AlmaLiveVoiceStartAttemptState.Token = 0,
        engineConnectionGeneration: Int = 0,
        recoveryAttempt: Bool = false,
        resumptionRequested: Bool = false
    ) {
        self.ordinal = ordinal
        self.socketIdentity = socketIdentity
        self.evidenceGeneration = evidenceGeneration
        self.startAttempt = startAttempt
        self.engineConnectionGeneration = engineConnectionGeneration
        self.recoveryAttempt = recoveryAttempt
        self.resumptionRequested = resumptionRequested
    }
}

// MARK: - Phase 0A typed, privacy-safe evidence

enum AlmaLiveVoiceEvidenceCallMode: String, Codable, Sendable {
    case standalone
    case callKit = "callkit"
    case debugNoNetwork = "debug-no-network"
}

enum AlmaLiveVoiceEvidenceRoute: String, Codable, Sendable {
    case builtInSpeaker = "built-in-speaker"
    case builtInReceiver = "built-in-receiver"
    case bluetoothHFP = "bluetooth-hfp"
    case headphones
    case other
    case none
}

enum AlmaLiveVoiceEvidenceEventName: String, Codable, Sendable {
    case sessionStarted = "session.started"
    case sessionEnded = "session.ended"
    case profileActivated = "profile.activated"
    case transportStarted = "transport.started"
    case socketOpened = "transport.socket-opened"
    case socketClosed = "transport.socket-closed"
    case socketError = "transport.socket-error"
    case providerErrorObserved = "provider.error-observed"
    case reconnectScheduled = "transport.reconnect-scheduled"
    case reconnectSetupFailed = "transport.reconnect-setup-failed"
    case goAwayObserved = "transport.go-away-observed"
    case resumptionHandleObserved = "transport.resumption-handle-observed"
    case resumptionUnavailable = "transport.resumption-unavailable"
    case resumptionAttemptFailed = "transport.resumption-attempt-failed"
    case resumptionAccepted = "transport.resumption-accepted"
    case audioGraphReady = "audio.graph-ready"
    case audioRouteChanged = "audio.route-changed"
    case appBackgrounded = "lifecycle.app-backgrounded"
    case appWillEnterForeground = "lifecycle.app-will-enter-foreground"
    case appBecameActive = "lifecycle.app-became-active"
    case audioInterruptionBegan = "lifecycle.audio-interruption-began"
    case audioInterruptionEnded = "lifecycle.audio-interruption-ended"
    case mediaServicesReset = "lifecycle.media-services-reset"
    case callKitAudioActivated = "lifecycle.callkit-audio-activated"
    case callKitAudioDeactivated = "lifecycle.callkit-audio-deactivated"
    case fullRestartScheduled = "lifecycle.full-restart-scheduled"
    case rawFirstEnergy = "input.raw-first-energy"
    case conversionFirstSucceeded = "input.conversion-first-succeeded"
    case conversionFailed = "input.conversion-failed"
    case audioWithheldByPolicy = "input.audio-withheld-by-policy"
    case audioNotQueued = "input.audio-not-queued"
    case audioFirstQueued = "input.audio-first-queued"
    case audioFirstSendSucceeded = "input.audio-first-send-succeeded"
    case audioSendFailed = "input.audio-send-failed"
    case audioSendTrackingUnavailable = "input.audio-send-tracking-unavailable"
    case staleSendCompletionIgnored = "input.stale-send-completion-ignored"
    case providerInputTranscriptionObserved = "provider.input-transcription-observed"
    case providerModelAudioObserved = "provider.model-audio-observed"
    case toolCallObserved = "tool.call-observed"
}

enum AlmaLiveVoiceEvidenceRouteReason: String, Codable, Sendable {
    case systemNotification = "system-notification"
    case verification
}

/// Content-free reasons why a successfully converted, energy-bearing capture
/// was not queued at that observation. Raw values are fixed report vocabulary;
/// no runtime/provider/user string can enter the ledger through this type.
enum AlmaLiveVoiceEvidenceInputPolicy: UInt8, Hashable, Sendable {
    case playbackTailSuppression = 0
    case listenCalibration = 1
    case listenGateClosed = 2
    case noAECEchoGuard = 3

    var bit: UInt8 { 1 << rawValue }

    var retention: AlmaLiveVoiceEvidenceInputRetention {
        switch self {
        case .playbackTailSuppression: return .discarded
        case .listenCalibration, .listenGateClosed, .noAECEchoGuard:
            return .boundedPreRoll
        }
    }

    var evidenceReason: AlmaLiveVoiceEvidenceReason {
        switch self {
        case .playbackTailSuppression: return .playbackTailSuppression
        case .listenCalibration: return .listenCalibration
        case .listenGateClosed: return .listenGateClosed
        case .noAECEchoGuard: return .noAECEchoGuard
        }
    }
}

enum AlmaLiveVoiceEvidenceInputRetention: String, Codable, Sendable {
    case boundedPreRoll = "bounded-pre-roll"
    case discarded
}

enum AlmaLiveVoiceEvidenceConversionFailure: Sendable {
    case converterUnavailable
    case outputBufferUnavailable
    case conversionError
    case emptyOutput

    var evidenceReason: AlmaLiveVoiceEvidenceReason {
        switch self {
        case .converterUnavailable: return .converterUnavailable
        case .outputBufferUnavailable: return .outputBufferUnavailable
        case .conversionError: return .conversionError
        case .emptyOutput: return .emptyConvertedAudio
        }
    }
}

enum AlmaLiveVoiceEvidenceNotQueuedReason: Equatable, Sendable {
    case serializationFailed
    case socketUnavailable
    case socketNotReady
    case sourceAttemptMismatch

    var evidenceReason: AlmaLiveVoiceEvidenceReason {
        switch self {
        case .serializationFailed: return .serializationFailed
        case .socketUnavailable: return .socketUnavailable
        case .socketNotReady: return .socketNotReady
        case .sourceAttemptMismatch: return .sourceAttemptMismatch
        }
    }
}

enum AlmaLiveVoiceAudioSendValidation {
    static func notQueuedReason(
        socketIdentity: ObjectIdentifier,
        currentAttempt: AlmaLiveVoiceSocketAttempt?,
        socketReady: Bool,
        requireReady: Bool,
        sourceAttempt: AlmaLiveVoiceSocketAttempt?
    ) -> AlmaLiveVoiceEvidenceNotQueuedReason? {
        guard let currentAttempt,
              currentAttempt.socketIdentity == socketIdentity else {
            return .sourceAttemptMismatch
        }
        if requireReady && !socketReady { return .socketNotReady }
        if let sourceAttempt, sourceAttempt != currentAttempt {
            return .sourceAttemptMismatch
        }
        return nil
    }
}

struct AlmaLiveVoiceEvidenceInputWindowID: Hashable, Sendable {
    let localSessionID: String
    let transportGeneration: Int
    let windowOrdinal: Int
}

/// Recorder-minted identity carried beside the exact converted PCM chunk. It
/// contains no audio or owner content and cannot be moved to another pre-roll
/// frame without moving the chunk value itself.
struct AlmaLiveVoiceEvidenceInputDeliveryToken: Equatable, Sendable {
    let windowID: AlmaLiveVoiceEvidenceInputWindowID
}

struct AlmaLiveVoiceCapturedInputPCM: Equatable, Sendable {
    let data: Data
    let deliveryToken: AlmaLiveVoiceEvidenceInputDeliveryToken?

    static func trackedEvidenceIndex(in chunks: [Self]) -> Int? {
        chunks.lastIndex { $0.deliveryToken != nil }
    }

    /// Retains evidence only for the selected exact PCM chunk. Callers keep the
    /// original buffer and FIFO iteration, avoiding a temporary array on the
    /// realtime capture path and never transplanting a token to other bytes.
    static func deliveryTokenForSending(
        _ chunk: Self,
        at index: Int,
        trackedIndex: Int?
    ) -> AlmaLiveVoiceEvidenceInputDeliveryToken? {
        index == trackedIndex ? chunk.deliveryToken : nil
    }
}

enum AlmaLiveVoiceEvidenceTransportEvent: String, Codable, Hashable, Sendable {
    case socketClosed
    case socketReceiveFailed
    case socketSendFailed
    case socketPingTimedOut
    case socketPingFailed
    case providerErrorObserved
    case reconnectScheduled
    case reconnectSetupFailed
    case goAwayObserved
    case resumptionHandleObserved
    case resumptionUnavailable
    case resumptionAttemptFailed
    case resumptionAccepted
}

enum AlmaLiveVoiceEvidenceLifecycleEvent: String, Codable, Sendable {
    case appBackgrounded
    case appWillEnterForeground
    case appBecameActive
    case audioInterruptionBegan
    case audioInterruptionEnded
    case mediaServicesReset
    case callKitAudioActivated
    case callKitAudioDeactivated
    case fullRestartScheduled
}

/// Immutable source-observation identity for lifecycle callbacks. The local ID
/// is generated by the evidence recorder (never owner/provider content), and is
/// required so a delayed callback cannot attach itself to a reused engine's next
/// logical call. Uptime is captured at the OS callback, not after an actor hop.
struct AlmaLiveVoiceLifecycleEvidenceContext: Equatable, Sendable {
    let localSessionID: String
    let observedUptime: TimeInterval
}

struct AlmaLiveVoiceLifecycleSourceToken: Equatable, Sendable {
    let bindingOrdinal: Int
    let localSessionID: String
}

struct AlmaLiveVoiceLifecycleObservation: Equatable, Sendable {
    let sourceToken: AlmaLiveVoiceLifecycleSourceToken
    let evidenceContext: AlmaLiveVoiceLifecycleEvidenceContext
    let evidenceSubmittedAtSource: Bool
}

enum AlmaLiveVoiceLifecycleSessionFence {
    static func acceptsBehaviorEpoch(
        _ expectedEpoch: Int,
        currentEpoch: Int,
        isClosed: Bool
    ) -> Bool {
        !isClosed && expectedEpoch > 0 && expectedEpoch == currentEpoch
    }

    static func acceptsSourceToken(
        _ sourceToken: AlmaLiveVoiceLifecycleSourceToken,
        currentToken: AlmaLiveVoiceLifecycleSourceToken?,
        isClosed: Bool
    ) -> Bool {
        !isClosed && sourceToken == currentToken
    }
}

/// Thread-safe bridge used only at CallKit's nonisolated delegate boundary. It
/// binds an immutable logical-session ID when the agent call begins, then records
/// the OS callback before the UI actor hop. Clearing is identity-checked so an old
/// engine cannot detach a replacement call's evidence source.
@available(iOS 17.0, *)
final class AlmaLiveVoiceLifecycleEvidenceRelay: @unchecked Sendable {
    private let lock = NSLock()
    private weak var source: AlmaGeminiLiveSession?
    private var sourceToken: AlmaLiveVoiceLifecycleSourceToken?
    /// A terminal CallKit deactivation normally arrives after the engine has
    /// stopped. Retain only the evidence objects until that physical callback
    /// (or a bounded fallback), so teardown cannot erase the final route fact.
    private var terminalSource: AlmaGeminiLiveSession?
    private var terminalToken: AlmaLiveVoiceLifecycleSourceToken?
    private var terminalFinalizer: AlmaLiveVoiceTerminalEvidenceFinalizer?
    private var nextBindingOrdinal = 0

    @discardableResult
    func bind(_ source: AlmaGeminiLiveSession) -> AlmaLiveVoiceLifecycleSourceToken {
        let sessionID = source.lifecycleEvidenceSessionID
        lock.lock()
        nextBindingOrdinal += 1
        let token = AlmaLiveVoiceLifecycleSourceToken(
            bindingOrdinal: nextBindingOrdinal,
            localSessionID: sessionID)
        self.source = source
        sourceToken = token
        lock.unlock()
        return token
    }

    func clear(_ expectedSource: AlmaGeminiLiveSession) {
        lock.lock()
        guard source === expectedSource else {
            lock.unlock()
            return
        }
        source = nil
        sourceToken = nil
        lock.unlock()
    }

    @discardableResult
    func deferFinalization(
        _ expectedSource: AlmaGeminiLiveSession,
        token expectedToken: AlmaLiveVoiceLifecycleSourceToken,
        finalizer: AlmaLiveVoiceTerminalEvidenceFinalizer,
        fallbackAfter: TimeInterval = 2
    ) -> Bool {
        lock.lock()
        guard source === expectedSource, sourceToken == expectedToken,
              terminalFinalizer == nil else {
            lock.unlock()
            return false
        }
        terminalSource = expectedSource
        terminalToken = expectedToken
        terminalFinalizer = finalizer
        // The stopped agent is no longer the active media owner. Keeping it in
        // the ordinary slots would steal a new Office call's didActivate while
        // we wait for the old agent call's terminal didDeactivate.
        source = nil
        sourceToken = nil
        lock.unlock()

        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, fallbackAfter)) { [weak self] in
            _ = self?.finishDeferredFinalization(for: expectedToken)
        }
        return true
    }

    /// Idempotent and token-bound: a fallback from call A can never detach or
    /// close a replacement call B that reused the relay.
    @discardableResult
    func finishDeferredFinalization(
        for expectedToken: AlmaLiveVoiceLifecycleSourceToken
    ) -> Bool {
        lock.lock()
        guard terminalToken == expectedToken, let finalizer = terminalFinalizer else {
            lock.unlock()
            return false
        }
        terminalSource = nil
        terminalToken = nil
        terminalFinalizer = nil
        if sourceToken == expectedToken {
            source = nil
            sourceToken = nil
        }
        lock.unlock()
        finalizer.finish()
        return true
    }

    @discardableResult
    func record(
        _ event: AlmaLiveVoiceEvidenceLifecycleEvent,
        observedUptime: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) -> AlmaLiveVoiceLifecycleObservation? {
        lock.lock()
        // A terminal deactivation belongs to the lease that requested the
        // CallKit end, even if a replacement binding has already appeared.
        let selectedSource = event == .callKitAudioDeactivated
            ? (terminalSource ?? source)
            : source
        let selectedToken = event == .callKitAudioDeactivated
            ? (terminalToken ?? sourceToken)
            : sourceToken
        guard let selectedSource, let selectedToken else {
            lock.unlock()
            return nil
        }
        lock.unlock()
        let context = AlmaLiveVoiceLifecycleEvidenceContext(
            localSessionID: selectedToken.localSessionID,
            observedUptime: observedUptime)
        let submitted = selectedSource.recordLifecycleEvidence(
            event,
            context: context)
        let observation = AlmaLiveVoiceLifecycleObservation(
            sourceToken: selectedToken,
            evidenceContext: context,
            evidenceSubmittedAtSource: submitted)
        if event == .callKitAudioDeactivated {
            _ = finishDeferredFinalization(for: selectedToken)
        }
        return observation
    }
}

/// Owns the narrow evidence tail after a CallKit-managed engine has otherwise
/// torn down. Session-ID checks make its timeout harmless if an engine object is
/// ever reused before the OS delivers `didDeactivate`.
@available(iOS 17.0, *)
final class AlmaLiveVoiceTerminalEvidenceFinalizer: @unchecked Sendable {
    private let lock = NSLock()
    private let live: AlmaGeminiLiveSession
    private let recorder: AlmaLiveVoiceEvidenceRecorder
    private let expectedLocalSessionID: String
    private let outcome: AlmaLiveVoiceEvidenceSessionOutcome
    private var finished = false

    init(
        live: AlmaGeminiLiveSession,
        recorder: AlmaLiveVoiceEvidenceRecorder,
        expectedLocalSessionID: String,
        outcome: AlmaLiveVoiceEvidenceSessionOutcome
    ) {
        self.live = live
        self.recorder = recorder
        self.expectedLocalSessionID = expectedLocalSessionID
        self.outcome = outcome
    }

    @discardableResult
    func finish() -> Bool {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return false
        }
        finished = true
        lock.unlock()

        guard live.lifecycleEvidenceSessionID == expectedLocalSessionID,
              recorder.sessionID == expectedLocalSessionID else { return false }
        live.finishEvidenceSession()
        recorder.endSession(outcome)
        return true
    }
}

enum AlmaLiveVoiceProviderControlEvidence {
    static func providerErrorEvents(
        recoveryAttempt: Bool,
        resumptionRequested: Bool,
        setupAccepted: Bool
    ) -> [AlmaLiveVoiceEvidenceTransportEvent] {
        var events: [AlmaLiveVoiceEvidenceTransportEvent] = [.providerErrorObserved]
        guard !setupAccepted else { return events }
        if recoveryAttempt { events.append(.reconnectSetupFailed) }
        if resumptionRequested { events.append(.resumptionAttemptFailed) }
        return events
    }

    static func setupCompleteEvents(
        resumptionRequested: Bool
    ) -> [AlmaLiveVoiceEvidenceTransportEvent] {
        resumptionRequested ? [.resumptionAccepted] : []
    }

    static func resumptionUpdateEvents(
        resumable: Bool,
        hasUsableHandle: Bool
    ) -> [AlmaLiveVoiceEvidenceTransportEvent] {
        if !resumable { return [.resumptionUnavailable] }
        return hasUsableHandle ? [.resumptionHandleObserved] : []
    }
}

typealias AlmaLiveVoiceEvidenceRevisionStatus = AlmaBuildProvenanceStatus

enum AlmaLiveVoiceEvidenceReason: String, Codable, Sendable {
    case converterUnavailable = "converter-unavailable"
    case outputBufferUnavailable = "output-buffer-unavailable"
    case conversionError = "conversion-error"
    case emptyConvertedAudio = "empty-converted-audio"
    case socketUnavailable = "socket-unavailable"
    case socketNotReady = "socket-not-ready"
    case sourceAttemptMismatch = "source-attempt-mismatch"
    case serializationFailed = "serialization-failed"
    case socketSendFailed = "socket-send-failed"
    case socketReceiveFailed = "socket-receive-failed"
    case socketPingTimedOut = "socket-ping-timed-out"
    case socketPingFailed = "socket-ping-failed"
    case evidenceBindingUnavailable = "evidence-binding-unavailable"
    case playbackTailSuppression = "playback-tail-suppression"
    case listenCalibration = "listen-calibration"
    case listenGateClosed = "listen-gate-closed"
    case noAECEchoGuard = "no-aec-echo-guard"
}

enum AlmaLiveVoiceEvidenceSessionOutcome: String, Codable, Sendable {
    case ownerEnded = "owner-ended"
    case failed
    case debugFixture = "debug-fixture"
}

#if DEBUG
enum AlmaLiveVoiceEvidenceFixture: String, Sendable {
    case noNetwork = "voice-debug-no-network"
    case unitTest = "voice-test-0001"
}
#endif

enum AlmaLiveVoiceEvidenceTool: String, Codable, Sendable {
    case quickLookup = "quick-erp-lookup"
    case endCall = "end-call"
    case runAgentTurn = "run-agent-turn"
    case unknown

    init(providerName: String?) {
        switch providerName {
        case "quick_erp_lookup": self = .quickLookup
        case "end_call": self = .endCall
        case "run_agent_turn": self = .runAgentTurn
        default: self = .unknown
        }
    }
}

struct AlmaLiveVoiceEvidenceSendContext: Equatable, Sendable {
    let localSessionID: String
    let transportGeneration: Int
    let inputWindowOrdinal: Int?
    let turnOrdinal: Int
    let audioChunkOrdinal: Int
    let byteCount: Int

    fileprivate init(
        localSessionID: String,
        transportGeneration: Int,
        inputWindowOrdinal: Int?,
        turnOrdinal: Int,
        audioChunkOrdinal: Int,
        byteCount: Int
    ) {
        self.localSessionID = localSessionID
        self.transportGeneration = transportGeneration
        self.inputWindowOrdinal = inputWindowOrdinal
        self.turnOrdinal = turnOrdinal
        self.audioChunkOrdinal = audioChunkOrdinal
        self.byteCount = byteCount
    }
}

/// Pure identity/generation/ready reducer. Callers synchronize mutations; the
/// value type itself makes the current-ready-socket acceptance rule unit-testable
/// without constructing a URLSession task.
struct AlmaLiveVoiceEvidenceTransportBinding: Equatable {
    private(set) var generation = 0
    private(set) var socketIdentity: ObjectIdentifier?
    private(set) var ready = false

    mutating func begin(generation: Int) {
        self.generation = generation
        socketIdentity = nil
        ready = false
    }

    mutating func bind(socketIdentity: ObjectIdentifier, generation: Int) {
        guard generation == self.generation else { return }
        self.socketIdentity = socketIdentity
        ready = false
    }

    @discardableResult
    mutating func markReady(
        socketIdentity: ObjectIdentifier,
        generation: Int
    ) -> Bool {
        guard self.socketIdentity == socketIdentity, self.generation == generation else {
            return false
        }
        ready = true
        return true
    }

    mutating func markNotReady() {
        ready = false
    }

    func matches(
        socketIdentity: ObjectIdentifier,
        generation: Int? = nil,
        requireReady: Bool
    ) -> Bool {
        self.socketIdentity == socketIdentity
            && (generation == nil || self.generation == generation)
            && (!requireReady || ready)
    }

    func completion(
        socketIdentity: ObjectIdentifier,
        sourceGeneration: Int
    ) -> (currentGeneration: Int, isCurrentReadySocket: Bool) {
        (
            generation,
            sourceGeneration == generation
                && self.socketIdentity == socketIdentity
                && ready
        )
    }
}

/// Pure fixed-size reducer for the first capture stages in each local input
/// window. It separates raw observation from conversion and local withholding,
/// while enforcing raw → conversion → policy/queue ordering.
struct AlmaLiveVoiceEvidenceInputStageState: Equatable {
    struct Snapshot: Equatable {
        let windowID: AlmaLiveVoiceEvidenceInputWindowID
        let intakeComplete: Bool
        let needsRaw: Bool
        let needsConversion: Bool
        let needsConversionFailure: Bool
        let pendingPolicyMask: UInt8
    }

    private(set) var localSessionID = "not-started"
    private(set) var transportGeneration = 0
    private(set) var windowEpoch = 0
    private(set) var active = false
    private(set) var rawEnergyRecorded = false
    private(set) var conversionRecorded = false
    private(set) var conversionFailureRecorded = false
    private(set) var policyWithheldMask: UInt8 = 0
    private(set) var intakeComplete = false

    mutating func reset(localSessionID: String, transportGeneration: Int) {
        self.localSessionID = localSessionID
        self.transportGeneration = transportGeneration
        windowEpoch = 0
        active = transportGeneration > 0
        _ = rearm(transportGeneration: transportGeneration)
    }

    @discardableResult
    mutating func rearm(transportGeneration: Int) -> Bool {
        guard active, transportGeneration == self.transportGeneration else { return false }
        windowEpoch += 1
        rawEnergyRecorded = false
        conversionRecorded = false
        conversionFailureRecorded = false
        policyWithheldMask = 0
        intakeComplete = false
        return true
    }

    mutating func deactivate() {
        active = false
    }

    func snapshot() -> Snapshot {
        Snapshot(
            windowID: .init(
                localSessionID: localSessionID,
                transportGeneration: transportGeneration,
                windowOrdinal: windowEpoch),
            intakeComplete: intakeComplete,
            needsRaw: !rawEnergyRecorded && !intakeComplete,
            needsConversion: !conversionRecorded && !intakeComplete,
            needsConversionFailure: !conversionFailureRecorded && !conversionRecorded,
            pendingPolicyMask: ~policyWithheldMask)
    }

    mutating func claimRaw(
        windowID: AlmaLiveVoiceEvidenceInputWindowID,
        hasEnergy: Bool
    ) -> Bool {
        guard matches(windowID),
              !intakeComplete,
              hasEnergy,
              !rawEnergyRecorded else { return false }
        rawEnergyRecorded = true
        return true
    }

    mutating func claimConversionSucceeded(
        windowID: AlmaLiveVoiceEvidenceInputWindowID,
        hasEnergy: Bool,
        byteCount: Int
    ) -> Bool {
        guard matches(windowID),
              !intakeComplete,
              hasEnergy,
              byteCount > 0,
              rawEnergyRecorded,
              !conversionRecorded else { return false }
        conversionRecorded = true
        return true
    }

    mutating func claimConversionFailure(
        windowID: AlmaLiveVoiceEvidenceInputWindowID
    ) -> Bool {
        guard matches(windowID),
              rawEnergyRecorded,
              !conversionRecorded,
              !conversionFailureRecorded else { return false }
        conversionFailureRecorded = true
        return true
    }

    mutating func claimPolicyWithheld(
        _ policy: AlmaLiveVoiceEvidenceInputPolicy,
        windowID: AlmaLiveVoiceEvidenceInputWindowID
    ) -> Bool {
        guard chainReady(windowID),
              !intakeComplete,
              policyWithheldMask & policy.bit == 0 else { return false }
        policyWithheldMask |= policy.bit
        return true
    }

    func chainReady(_ windowID: AlmaLiveVoiceEvidenceInputWindowID) -> Bool {
        matches(windowID)
            && rawEnergyRecorded
            && conversionRecorded
    }

    func matches(_ windowID: AlmaLiveVoiceEvidenceInputWindowID) -> Bool {
        active
            && windowID.localSessionID == localSessionID
            && windowID.transportGeneration == transportGeneration
            && windowID.windowOrdinal == windowEpoch
    }

    mutating func markIntakeComplete(_ windowID: AlmaLiveVoiceEvidenceInputWindowID) {
        guard chainReady(windowID) else { return }
        intakeComplete = true
    }

    mutating func markIntakeNeedsRetry(_ windowID: AlmaLiveVoiceEvidenceInputWindowID) {
        guard matches(windowID) else { return }
        intakeComplete = false
    }
}

struct AlmaLiveVoiceEvidenceEvent: Codable, Equatable, Sendable {
    let sequence: Int
    let elapsedMilliseconds: Int
    let name: AlmaLiveVoiceEvidenceEventName
    let localSessionID: String
    let transportGeneration: Int
    let sourceTransportGeneration: Int?
    let inputWindowOrdinal: Int?
    let turnOrdinal: Int?
    let toolOrdinal: Int?
    let audioChunkOrdinal: Int?
    let byteCount: Int?
    let rmsMilli: Int?
    let route: AlmaLiveVoiceEvidenceRoute?
    let routeReason: AlmaLiveVoiceEvidenceRouteReason?
    let reason: AlmaLiveVoiceEvidenceReason?
    let retention: AlmaLiveVoiceEvidenceInputRetention?
    let tool: AlmaLiveVoiceEvidenceTool?
    let resumedTransport: Bool?
}

struct AlmaLiveVoiceEvidenceReport: Codable, Equatable, Sendable {
    struct App: Codable, Equatable, Sendable {
        let version: String
        let build: String
        let commit: String
        let revisionStatus: AlmaLiveVoiceEvidenceRevisionStatus
    }

    struct Session: Codable, Equatable, Sendable {
        let id: String
        let startedAt: String
        let endedAt: String?
        let callMode: AlmaLiveVoiceEvidenceCallMode
        let requestedModelID: String
        let requestedVoiceID: String
        let activeModelID: String
        let activeVoiceID: String
        let outcome: AlmaLiveVoiceEvidenceSessionOutcome?
    }

    let schemaVersion: Int
    let generatedAt: String
    let privacyContract: [String]
    let featureEnabled: Bool
    let app: App
    let session: Session
    let events: [AlmaLiveVoiceEvidenceEvent]
}

enum AlmaLiveVoiceEvidenceExportError: Error {
    case disabled
}

/// A bounded evidence ledger shared by the main actor, audio queue, and socket
/// callbacks. Its API accepts only allow-listed enums and numeric aggregates;
/// there is deliberately no arbitrary detail string that could carry speech,
/// prompts, URLs, credentials, provider IDs, or tool payloads.
final class AlmaLiveVoiceEvidenceRecorder: @unchecked Sendable {
    private struct StageKey: Hashable {
        let transportGeneration: Int
        let turnOrdinal: Int
    }

    private struct ModelStageKey: Hashable {
        let transportGeneration: Int
        let playbackGeneration: Int
    }

    private struct PolicyWindowKey: Hashable {
        let windowID: AlmaLiveVoiceEvidenceInputWindowID
        let policy: AlmaLiveVoiceEvidenceInputPolicy
    }

    private struct TransportEventKey: Hashable {
        let transportGeneration: Int
        let event: AlmaLiveVoiceEvidenceTransportEvent
    }

    private static let logger = Logger(
        subsystem: "com.almatraders.erp.voice",
        category: "RecoveryEvidence")
    private static let firstEnergyEvidenceFloor = 0.000_001
    private static let maximumEvents = 600

    private let enabled: Bool
    private let buildProvenance: AlmaBuildProvenance
    private let lock = NSLock()
    private var sessionActive = false
    private var localSessionID = "not-started"
    private var startedAt = Date()
    private var startedUptime = ProcessInfo.processInfo.systemUptime
    private var endedAt: Date?
    private var callMode: AlmaLiveVoiceEvidenceCallMode = .standalone
    private var requestedModelID = "unknown"
    private var requestedVoiceID = "unknown"
    private var activeModelID = "unknown"
    private var activeVoiceID = "unknown"
    private var outcome: AlmaLiveVoiceEvidenceSessionOutcome?
    private var sequence = 0
    private var lastElapsedMilliseconds = 0
    private var transportGeneration = 0
    private var transportActive = false
    /// Never reused for this recorder's lifetime. `transportGeneration` resets
    /// to an inactive sentinel between logical sessions, while this counter
    /// prevents a delayed callback from session A/gen 1 authenticating against
    /// session B's first transport.
    private var nextTransportGeneration = 0
    private var turnOrdinal = 0
    private var toolOrdinal = 0
    private var audioChunkOrdinal = 0
    private var activeTurnOrdinal: Int?
    private var currentInputWindowID: AlmaLiveVoiceEvidenceInputWindowID?
    private var inputWindowTurns: [AlmaLiveVoiceEvidenceInputWindowID: Int] = [:]
    private var events: [AlmaLiveVoiceEvidenceEvent] = []
    private var rawEnergyWindows = Set<AlmaLiveVoiceEvidenceInputWindowID>()
    private var conversionSucceededWindows = Set<AlmaLiveVoiceEvidenceInputWindowID>()
    private var conversionFailureWindows = Set<AlmaLiveVoiceEvidenceInputWindowID>()
    private var rawEnergyStages = Set<StageKey>()
    private var conversionSucceededStages = Set<StageKey>()
    private var conversionFailureStages = Set<StageKey>()
    private var policyWithheldWindows = Set<PolicyWindowKey>()
    private var notQueuedStages = Set<StageKey>()
    private var queuedStages = Set<StageKey>()
    private var sendSucceededStages = Set<StageKey>()
    private var sendFailedStages = Set<StageKey>()
    private var outstandingAudioSends: [Int: AlmaLiveVoiceEvidenceSendContext] = [:]
    private var untrackedSendStages = Set<StageKey>()
    private var transcriptionStages = Set<StageKey>()
    private var ambiguousTranscriptionGenerations = Set<Int>()
    private var staleCompletionGenerations = Set<Int>()
    private var modelAudioStages = Set<ModelStageKey>()
    private var transportEventStages = Set<TransportEventKey>()

    init(
        enabled: Bool,
        buildProvenance: AlmaBuildProvenance = AlmaBuildProvenanceLoader.current
    ) {
        self.enabled = enabled
        self.buildProvenance = buildProvenance
    }

    var isEnabled: Bool { enabled }

    static func isFirstEnergyCandidate(_ rms: Double) -> Bool {
        rms.isFinite && rms >= firstEnergyEvidenceFloor
    }

    var sessionID: String {
        lock.lock()
        let value = localSessionID
        lock.unlock()
        return value
    }

    @discardableResult
    func beginSession(
        modelID: String,
        voiceID: String,
        callMode: AlmaLiveVoiceEvidenceCallMode
    ) -> String {
        beginSession(
            modelID: modelID,
            voiceID: voiceID,
            callMode: callMode,
            localSessionID: Self.makeLocalSessionID())
    }

    #if DEBUG
    @discardableResult
    func beginFixtureSession(
        modelID: String,
        voiceID: String,
        callMode: AlmaLiveVoiceEvidenceCallMode,
        fixture: AlmaLiveVoiceEvidenceFixture
    ) -> String {
        beginSession(
            modelID: modelID,
            voiceID: voiceID,
            callMode: callMode,
            localSessionID: fixture.rawValue)
    }
    #endif

    private func beginSession(
        modelID: String,
        voiceID: String,
        callMode: AlmaLiveVoiceEvidenceCallMode,
        localSessionID: String
    ) -> String {
        guard enabled else { return "evidence-disabled" }
        lock.lock()
        sessionActive = true
        self.localSessionID = localSessionID
        startedAt = Date()
        startedUptime = ProcessInfo.processInfo.systemUptime
        endedAt = nil
        self.callMode = callMode
        requestedModelID = Self.safeModelID(modelID)
        requestedVoiceID = Self.safeVoiceID(voiceID)
        activeModelID = "unknown"
        activeVoiceID = "unknown"
        outcome = nil
        sequence = 0
        lastElapsedMilliseconds = 0
        transportGeneration = 0
        transportActive = false
        turnOrdinal = 0
        toolOrdinal = 0
        audioChunkOrdinal = 0
        activeTurnOrdinal = nil
        currentInputWindowID = nil
        inputWindowTurns.removeAll(keepingCapacity: true)
        events.removeAll(keepingCapacity: true)
        rawEnergyWindows.removeAll(keepingCapacity: true)
        conversionSucceededWindows.removeAll(keepingCapacity: true)
        conversionFailureWindows.removeAll(keepingCapacity: true)
        rawEnergyStages.removeAll(keepingCapacity: true)
        conversionSucceededStages.removeAll(keepingCapacity: true)
        conversionFailureStages.removeAll(keepingCapacity: true)
        policyWithheldWindows.removeAll(keepingCapacity: true)
        notQueuedStages.removeAll(keepingCapacity: true)
        queuedStages.removeAll(keepingCapacity: true)
        sendSucceededStages.removeAll(keepingCapacity: true)
        sendFailedStages.removeAll(keepingCapacity: true)
        outstandingAudioSends.removeAll(keepingCapacity: true)
        untrackedSendStages.removeAll(keepingCapacity: true)
        transcriptionStages.removeAll(keepingCapacity: true)
        ambiguousTranscriptionGenerations.removeAll(keepingCapacity: true)
        staleCompletionGenerations.removeAll(keepingCapacity: true)
        modelAudioStages.removeAll(keepingCapacity: true)
        transportEventStages.removeAll(keepingCapacity: true)
        appendLocked(name: .sessionStarted)
        let created = localSessionID
        lock.unlock()
        return created
    }

    func endSession(_ outcome: AlmaLiveVoiceEvidenceSessionOutcome) {
        guard enabled else { return }
        lock.lock()
        guard sessionActive, endedAt == nil else { lock.unlock(); return }
        self.outcome = outcome
        appendLocked(name: .sessionEnded)
        endedAt = Date()
        sessionActive = false
        transportActive = false
        currentInputWindowID = nil
        lock.unlock()
    }

    func activateProfile(modelID: String, voiceID: String, generation: Int) {
        guard enabled else { return }
        lock.lock()
        guard acceptsTransportLocked(generation) else {
            lock.unlock()
            return
        }
        activeModelID = Self.safeModelID(modelID)
        activeVoiceID = Self.safeVoiceID(voiceID)
        appendLocked(name: .profileActivated)
        lock.unlock()
    }

    @discardableResult
    func beginTransportAttempt(resuming: Bool) -> Int {
        guard enabled else { return 0 }
        lock.lock()
        guard sessionActive else { lock.unlock(); return 0 }
        nextTransportGeneration += 1
        transportGeneration = nextTransportGeneration
        transportActive = true
        currentInputWindowID = nil
        appendLocked(name: .transportStarted, resumedTransport: resuming)
        let generation = transportGeneration
        lock.unlock()
        return generation
    }

    /// Activates the recorder-minted prospective window for this exact logical
    /// session and transport. Capture observations carrying an older/future
    /// ordinal are rejected instead of being attributed to the current call.
    @discardableResult
    func activateInputWindow(
        _ windowID: AlmaLiveVoiceEvidenceInputWindowID,
        generation: Int
    ) -> Bool {
        guard enabled else { return false }
        lock.lock()
        guard acceptsTransportLocked(generation),
              currentInputWindowID == nil,
              windowID.localSessionID == localSessionID,
              windowID.transportGeneration == generation,
              windowID.windowOrdinal == 1 else {
            lock.unlock()
            return false
        }
        currentInputWindowID = windowID
        lock.unlock()
        return true
    }

    func recordSocketOpened(generation: Int) {
        appendIfCurrentTransport(name: .socketOpened, generation: generation)
    }

    func recordTransportEvent(
        _ event: AlmaLiveVoiceEvidenceTransportEvent,
        generation: Int,
        observedUptime: TimeInterval? = nil
    ) {
        guard enabled else { return }
        lock.lock()
        guard acceptsTransportLocked(generation) else { lock.unlock(); return }
        let key = TransportEventKey(
            transportGeneration: generation,
            event: event)
        guard transportEventStages.insert(key).inserted else {
            lock.unlock()
            return
        }
        let name: AlmaLiveVoiceEvidenceEventName
        let reason: AlmaLiveVoiceEvidenceReason?
        switch event {
        case .socketClosed:
            name = .socketClosed; reason = nil
        case .socketReceiveFailed:
            name = .socketError; reason = .socketReceiveFailed
        case .socketSendFailed:
            name = .socketError; reason = .socketSendFailed
        case .socketPingTimedOut:
            name = .socketError; reason = .socketPingTimedOut
        case .socketPingFailed:
            name = .socketError; reason = .socketPingFailed
        case .providerErrorObserved:
            name = .providerErrorObserved; reason = nil
        case .reconnectScheduled:
            name = .reconnectScheduled; reason = nil
        case .reconnectSetupFailed:
            name = .reconnectSetupFailed; reason = nil
        case .goAwayObserved:
            name = .goAwayObserved; reason = nil
        case .resumptionHandleObserved:
            name = .resumptionHandleObserved; reason = nil
        case .resumptionUnavailable:
            name = .resumptionUnavailable; reason = nil
        case .resumptionAttemptFailed:
            name = .resumptionAttemptFailed; reason = nil
        case .resumptionAccepted:
            name = .resumptionAccepted; reason = nil
        }
        appendLocked(
            name: name,
            reason: reason,
            observedUptime: observedUptime)
        lock.unlock()
    }

    func recordLifecycleEvent(
        _ event: AlmaLiveVoiceEvidenceLifecycleEvent,
        expectedLocalSessionID: String? = nil,
        observedUptime: TimeInterval? = nil
    ) {
        guard enabled else { return }
        lock.lock()
        guard sessionActive,
              expectedLocalSessionID == nil || expectedLocalSessionID == localSessionID else {
            lock.unlock()
            return
        }
        let name: AlmaLiveVoiceEvidenceEventName
        switch event {
        case .appBackgrounded: name = .appBackgrounded
        case .appWillEnterForeground: name = .appWillEnterForeground
        case .appBecameActive: name = .appBecameActive
        case .audioInterruptionBegan: name = .audioInterruptionBegan
        case .audioInterruptionEnded: name = .audioInterruptionEnded
        case .mediaServicesReset: name = .mediaServicesReset
        case .callKitAudioActivated: name = .callKitAudioActivated
        case .callKitAudioDeactivated: name = .callKitAudioDeactivated
        case .fullRestartScheduled: name = .fullRestartScheduled
        }
        appendLocked(name: name, observedUptime: observedUptime)
        lock.unlock()
    }

    func recordAudioGraphReady(generation: Int, route: AlmaLiveVoiceEvidenceRoute) {
        appendIfCurrentTransport(name: .audioGraphReady, generation: generation, route: route)
    }

    func recordAudioRouteChanged(
        generation: Int,
        route: AlmaLiveVoiceEvidenceRoute,
        reason: AlmaLiveVoiceEvidenceRouteReason
    ) {
        appendIfCurrentTransport(
            name: .audioRouteChanged,
            generation: generation,
            route: route,
            routeReason: reason)
    }

    func recordRawEnergy(
        rms: Double,
        generation: Int,
        inputWindowID: AlmaLiveVoiceEvidenceInputWindowID? = nil,
        observedUptime: TimeInterval? = nil
    ) {
        guard enabled, Self.isFirstEnergyCandidate(rms) else { return }
        lock.lock()
        guard acceptsTransportLocked(generation) else { lock.unlock(); return }
        if let inputWindowID {
            guard acceptsInputWindowLocked(inputWindowID),
                  rawEnergyWindows.insert(inputWindowID).inserted else {
                lock.unlock()
                return
            }
            appendLocked(
                name: .rawFirstEnergy,
                inputWindowOrdinal: inputWindowID.windowOrdinal,
                rmsMilli: min(1_000, max(0, Int((rms * 1_000).rounded()))),
                observedUptime: observedUptime)
            lock.unlock()
            return
        }
        let turn = ensureActiveTurnLocked()
        let key = StageKey(transportGeneration: generation, turnOrdinal: turn)
        guard rawEnergyStages.insert(key).inserted else { lock.unlock(); return }
        appendLocked(
            name: .rawFirstEnergy,
            turnOrdinal: turn,
            rmsMilli: min(1_000, max(0, Int((rms * 1_000).rounded()))),
            observedUptime: observedUptime)
        lock.unlock()
    }

    func recordConversionSucceeded(
        byteCount: Int,
        generation: Int,
        inputWindowID: AlmaLiveVoiceEvidenceInputWindowID? = nil,
        observedUptime: TimeInterval? = nil
    ) {
        guard enabled, byteCount > 0 else { return }
        lock.lock()
        guard acceptsTransportLocked(generation) else {
            lock.unlock()
            return
        }
        if let inputWindowID {
            guard acceptsInputWindowLocked(inputWindowID),
                  rawEnergyWindows.contains(inputWindowID),
                  conversionSucceededWindows.insert(inputWindowID).inserted else {
                lock.unlock()
                return
            }
            appendLocked(
                name: .conversionFirstSucceeded,
                inputWindowOrdinal: inputWindowID.windowOrdinal,
                byteCount: byteCount,
                observedUptime: observedUptime)
            lock.unlock()
            return
        }
        let turn = ensureActiveTurnLocked()
        let key = StageKey(transportGeneration: generation, turnOrdinal: turn)
        guard conversionSucceededStages.insert(key).inserted else { lock.unlock(); return }
        appendLocked(
            name: .conversionFirstSucceeded,
            turnOrdinal: turn,
            byteCount: byteCount,
            observedUptime: observedUptime)
        lock.unlock()
    }

    func recordConversionFailed(
        _ failure: AlmaLiveVoiceEvidenceConversionFailure,
        generation: Int,
        inputWindowID: AlmaLiveVoiceEvidenceInputWindowID? = nil,
        observedUptime: TimeInterval? = nil
    ) {
        guard enabled else { return }
        lock.lock()
        guard acceptsTransportLocked(generation) else {
            lock.unlock()
            return
        }
        if let inputWindowID {
            guard acceptsInputWindowLocked(inputWindowID),
                  rawEnergyWindows.contains(inputWindowID),
                  conversionFailureWindows.insert(inputWindowID).inserted else {
                lock.unlock()
                return
            }
            appendLocked(
                name: .conversionFailed,
                inputWindowOrdinal: inputWindowID.windowOrdinal,
                reason: failure.evidenceReason,
                observedUptime: observedUptime)
            lock.unlock()
            return
        }
        guard let turn = activeTurnOrdinal else {
            lock.unlock()
            return
        }
        let key = StageKey(transportGeneration: generation, turnOrdinal: turn)
        guard rawEnergyStages.contains(key),
              conversionFailureStages.insert(key).inserted else {
            lock.unlock()
            return
        }
        appendLocked(
            name: .conversionFailed,
            turnOrdinal: turn,
            reason: failure.evidenceReason,
            observedUptime: observedUptime)
        lock.unlock()
    }

    func recordInputWithheldByPolicy(
        _ policy: AlmaLiveVoiceEvidenceInputPolicy,
        generation: Int,
        inputWindowID: AlmaLiveVoiceEvidenceInputWindowID,
        observedUptime: TimeInterval? = nil
    ) {
        guard enabled else { return }
        lock.lock()
        guard acceptsTransportLocked(generation),
              acceptsInputWindowLocked(inputWindowID) else {
            lock.unlock()
            return
        }
        let policyKey = PolicyWindowKey(windowID: inputWindowID, policy: policy)
        guard rawEnergyWindows.contains(inputWindowID),
              conversionSucceededWindows.contains(inputWindowID),
              policyWithheldWindows.insert(policyKey).inserted else {
            lock.unlock()
            return
        }
        appendLocked(
            name: .audioWithheldByPolicy,
            inputWindowOrdinal: inputWindowID.windowOrdinal,
            reason: policy.evidenceReason,
            retention: policy.retention,
            observedUptime: observedUptime)
        lock.unlock()
    }

    func recordAudioQueued(
        byteCount: Int,
        generation: Int,
        inputWindowID: AlmaLiveVoiceEvidenceInputWindowID? = nil,
        observedUptime: TimeInterval? = nil
    ) -> AlmaLiveVoiceEvidenceSendContext? {
        guard enabled, byteCount > 0 else { return nil }
        lock.lock()
        guard acceptsTransportLocked(generation) else { lock.unlock(); return nil }
        let turn: Int
        if let inputWindowID {
            guard rawEnergyWindows.contains(inputWindowID),
                  conversionSucceededWindows.contains(inputWindowID),
                  let correlated = turnForInputWindowLocked(inputWindowID) else {
                lock.unlock()
                return nil
            }
            turn = correlated
        } else {
            turn = ensureActiveTurnLocked()
        }
        let key = StageKey(transportGeneration: generation, turnOrdinal: turn)
        audioChunkOrdinal += 1
        let chunk = audioChunkOrdinal
        if queuedStages.insert(key).inserted {
            appendLocked(
                name: .audioFirstQueued,
                inputWindowOrdinal: inputWindowID?.windowOrdinal,
                turnOrdinal: turn,
                audioChunkOrdinal: chunk,
                byteCount: byteCount,
                observedUptime: observedUptime)
        }
        let context = AlmaLiveVoiceEvidenceSendContext(
            localSessionID: localSessionID,
            transportGeneration: generation,
            inputWindowOrdinal: inputWindowID?.windowOrdinal,
            turnOrdinal: turn,
            audioChunkOrdinal: chunk,
            byteCount: byteCount)
        outstandingAudioSends[chunk] = context
        lock.unlock()
        return context
    }

    func recordAudioSendCompletion(
        _ context: AlmaLiveVoiceEvidenceSendContext,
        succeeded: Bool,
        currentGeneration: Int,
        isCurrentReadySocket: Bool,
        observedUptime: TimeInterval? = nil
    ) {
        guard enabled else { return }
        lock.lock()
        guard sessionActive, context.localSessionID == localSessionID else {
            lock.unlock()
            return
        }
        guard outstandingAudioSends[context.audioChunkOrdinal] == context else {
            lock.unlock()
            return
        }
        outstandingAudioSends.removeValue(forKey: context.audioChunkOrdinal)
        let isCurrent = context.transportGeneration == transportGeneration
            && context.transportGeneration == currentGeneration
            && isCurrentReadySocket
        guard isCurrent else {
            if staleCompletionGenerations.insert(context.transportGeneration).inserted {
                appendLocked(
                    name: .staleSendCompletionIgnored,
                    sourceTransportGeneration: context.transportGeneration,
                    inputWindowOrdinal: context.inputWindowOrdinal,
                    turnOrdinal: context.turnOrdinal,
                    audioChunkOrdinal: context.audioChunkOrdinal,
                    byteCount: context.byteCount,
                    observedUptime: observedUptime)
            }
            lock.unlock()
            return
        }
        let key = StageKey(
            transportGeneration: context.transportGeneration,
            turnOrdinal: context.turnOrdinal)
        if succeeded {
            guard sendSucceededStages.insert(key).inserted else {
                lock.unlock()
                return
            }
            appendLocked(
                name: .audioFirstSendSucceeded,
                inputWindowOrdinal: context.inputWindowOrdinal,
                turnOrdinal: context.turnOrdinal,
                audioChunkOrdinal: context.audioChunkOrdinal,
                byteCount: context.byteCount,
                observedUptime: observedUptime)
        } else if sendFailedStages.insert(key).inserted {
            appendLocked(
                name: .audioSendFailed,
                inputWindowOrdinal: context.inputWindowOrdinal,
                turnOrdinal: context.turnOrdinal,
                audioChunkOrdinal: context.audioChunkOrdinal,
                byteCount: context.byteCount,
                reason: .socketSendFailed,
                observedUptime: observedUptime)
        }
        lock.unlock()
    }

    func recordAudioNotQueued(
        _ reason: AlmaLiveVoiceEvidenceNotQueuedReason,
        byteCount: Int,
        generation: Int,
        inputWindowID: AlmaLiveVoiceEvidenceInputWindowID? = nil,
        observedUptime: TimeInterval? = nil
    ) {
        guard enabled, byteCount > 0 else { return }
        lock.lock()
        guard acceptsTransportLocked(generation) else {
            lock.unlock()
            return
        }
        let turn: Int
        if let inputWindowID {
            guard rawEnergyWindows.contains(inputWindowID),
                  conversionSucceededWindows.contains(inputWindowID),
                  let correlated = turnForInputWindowLocked(inputWindowID) else {
                lock.unlock()
                return
            }
            turn = correlated
            activeTurnOrdinal = correlated
        } else if let activeTurnOrdinal {
            turn = activeTurnOrdinal
        } else {
            lock.unlock()
            return
        }
        let key = StageKey(transportGeneration: generation, turnOrdinal: turn)
        if inputWindowID == nil,
           !(rawEnergyStages.contains(key) && conversionSucceededStages.contains(key)) {
            lock.unlock()
            return
        }
        guard notQueuedStages.insert(key).inserted else { lock.unlock(); return }
        appendLocked(
            name: .audioNotQueued,
            inputWindowOrdinal: inputWindowID?.windowOrdinal,
            turnOrdinal: turn,
            byteCount: byteCount,
            reason: reason.evidenceReason,
            observedUptime: observedUptime)
        lock.unlock()
    }

    /// Runtime readiness remains authoritative for delivery. This event means
    /// only that Phase 0A could not correlate the send to its diagnostic socket
    /// binding, so no local completion/provider receipt claim will be made.
    func recordAudioSendTrackingUnavailable(
        byteCount: Int,
        generation: Int,
        inputWindowID: AlmaLiveVoiceEvidenceInputWindowID? = nil,
        observedUptime: TimeInterval? = nil
    ) {
        guard enabled, byteCount > 0 else { return }
        lock.lock()
        guard acceptsTransportLocked(generation) else { lock.unlock(); return }
        let turn: Int
        if let inputWindowID {
            guard rawEnergyWindows.contains(inputWindowID),
                  conversionSucceededWindows.contains(inputWindowID),
                  let correlated = turnForInputWindowLocked(inputWindowID) else {
                lock.unlock()
                return
            }
            turn = correlated
            activeTurnOrdinal = correlated
        } else {
            turn = ensureActiveTurnLocked()
        }
        let key = StageKey(transportGeneration: generation, turnOrdinal: turn)
        if inputWindowID == nil,
           !(rawEnergyStages.contains(key) && conversionSucceededStages.contains(key)) {
            lock.unlock()
            return
        }
        guard untrackedSendStages.insert(key).inserted else { lock.unlock(); return }
        appendLocked(
            name: .audioSendTrackingUnavailable,
            inputWindowOrdinal: inputWindowID?.windowOrdinal,
            turnOrdinal: turn,
            byteCount: byteCount,
            reason: .evidenceBindingUnavailable,
            observedUptime: observedUptime)
        lock.unlock()
    }

    func recordProviderInputTranscriptionObserved(
        generation: Int,
        correlateToActiveInput: Bool = true
    ) {
        guard enabled else { return }
        lock.lock()
        guard acceptsTransportLocked(generation) else { lock.unlock(); return }
        guard correlateToActiveInput, let turn = activeTurnOrdinal else {
            guard ambiguousTranscriptionGenerations.insert(generation).inserted else {
                lock.unlock()
                return
            }
            appendLocked(name: .providerInputTranscriptionObserved)
            lock.unlock()
            return
        }
        let key = StageKey(transportGeneration: generation, turnOrdinal: turn)
        guard transcriptionStages.insert(key).inserted else { lock.unlock(); return }
        appendLocked(name: .providerInputTranscriptionObserved, turnOrdinal: turn)
        lock.unlock()
    }

    /// A locally confirmed interruption starts a new owner input turn even if
    /// the provider never delivered `turnComplete` for the interrupted model
    /// audio. The supplied values are the already-observed current mic RMS and
    /// converted pre-roll size; no PCM/content enters the ledger.
    func recordConfirmedBargeInInputBoundary(
        rms: Double,
        convertedByteCount: Int,
        generation: Int,
        observedUptime: TimeInterval? = nil
    ) {
        guard enabled else { return }
        lock.lock()
        guard acceptsTransportLocked(generation) else { lock.unlock(); return }
        let turn = ensureActiveTurnLocked()
        let key = StageKey(transportGeneration: generation, turnOrdinal: turn)
        if Self.isFirstEnergyCandidate(rms), rawEnergyStages.insert(key).inserted {
            appendLocked(
                name: .rawFirstEnergy,
                turnOrdinal: turn,
                rmsMilli: min(1_000, max(0, Int((rms * 1_000).rounded()))),
                observedUptime: observedUptime)
        }
        if convertedByteCount > 0, conversionSucceededStages.insert(key).inserted {
            appendLocked(
                name: .conversionFirstSucceeded,
                turnOrdinal: turn,
                byteCount: convertedByteCount,
                observedUptime: observedUptime)
        }
        lock.unlock()
    }

    /// The first PCM chunk of a local playback epoch belongs to the prior input
    /// window (if one exists), then arms one stable prospective input window for
    /// natural listening, VPIO barge-in, local acoustic barge-in, or manual orb
    /// interruption. Provider `turnComplete` never advances this correlation.
    func recordProviderModelAudioObserved(
        generation: Int,
        playbackGeneration: Int,
        nextInputWindowID: AlmaLiveVoiceEvidenceInputWindowID? = nil,
        observedUptime: TimeInterval? = nil
    ) {
        guard enabled else { return }
        lock.lock()
        let key = ModelStageKey(
            transportGeneration: generation,
            playbackGeneration: playbackGeneration)
        let nextWindowAccepted = nextInputWindowID.map {
            acceptsNextInputWindowLocked($0, generation: generation)
        } ?? true
        guard acceptsTransportLocked(generation),
              nextWindowAccepted,
              modelAudioStages.insert(key).inserted else {
            lock.unlock()
            return
        }
        appendLocked(
            name: .providerModelAudioObserved,
            turnOrdinal: activeTurnOrdinal,
            observedUptime: observedUptime)
        activeTurnOrdinal = nil
        if let nextInputWindowID {
            currentInputWindowID = nextInputWindowID
        }
        lock.unlock()
    }

    func recordModelTurnCompleted(generation: Int) {
        guard enabled else { return }
        lock.lock()
        guard acceptsTransportLocked(generation) else { lock.unlock(); return }
        // Observation only. Cross-stream ordering is not guaranteed, and local
        // PCM may still be buffered, so this signal cannot close/advance input.
        lock.unlock()
    }

    @discardableResult
    func recordToolCallObserved(
        _ tool: AlmaLiveVoiceEvidenceTool,
        generation: Int
    ) -> Int? {
        guard enabled else { return nil }
        lock.lock()
        guard acceptsTransportLocked(generation) else { lock.unlock(); return nil }
        toolOrdinal += 1
        let ordinal = toolOrdinal
        appendLocked(
            name: .toolCallObserved,
            turnOrdinal: activeTurnOrdinal,
            toolOrdinal: ordinal,
            tool: tool)
        lock.unlock()
        return ordinal
    }

    func report() -> AlmaLiveVoiceEvidenceReport {
        lock.lock()
        let report = reportLocked()
        lock.unlock()
        return report
    }

    func encodedReport() throws -> Data {
        guard enabled else { throw AlmaLiveVoiceEvidenceExportError.disabled }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(report())
    }

    func exportURL() throws -> URL {
        let data = try encodedReport()
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("alma-live-voice-evidence-\(sessionID).json")
        try data.write(to: url, options: .atomic)
        return url
    }

    private func appendIfCurrentTransport(
        name: AlmaLiveVoiceEvidenceEventName,
        generation: Int,
        route: AlmaLiveVoiceEvidenceRoute? = nil,
        routeReason: AlmaLiveVoiceEvidenceRouteReason? = nil
    ) {
        guard enabled else { return }
        lock.lock()
        guard acceptsTransportLocked(generation) else { lock.unlock(); return }
        appendLocked(name: name, route: route, routeReason: routeReason)
        lock.unlock()
    }

    private func acceptsTransportLocked(_ generation: Int) -> Bool {
        sessionActive && transportActive && generation > 0
            && generation == transportGeneration
    }

    private func ensureActiveTurnLocked() -> Int {
        if let activeTurnOrdinal { return activeTurnOrdinal }
        turnOrdinal += 1
        activeTurnOrdinal = turnOrdinal
        return turnOrdinal
    }

    private func acceptsInputWindowLocked(
        _ windowID: AlmaLiveVoiceEvidenceInputWindowID
    ) -> Bool {
        acceptsTransportLocked(windowID.transportGeneration)
            && currentInputWindowID == windowID
            && windowID.localSessionID == localSessionID
            && windowID.windowOrdinal > 0
    }

    private func acceptsNextInputWindowLocked(
        _ windowID: AlmaLiveVoiceEvidenceInputWindowID,
        generation: Int
    ) -> Bool {
        guard windowID.localSessionID == localSessionID,
              windowID.transportGeneration == generation,
              windowID.windowOrdinal > 0 else { return false }
        if let currentInputWindowID {
            return currentInputWindowID.localSessionID == localSessionID
                && currentInputWindowID.transportGeneration == generation
                && windowID.windowOrdinal == currentInputWindowID.windowOrdinal + 1
        }
        return windowID.windowOrdinal == 1
    }

    private func turnForInputWindowLocked(
        _ windowID: AlmaLiveVoiceEvidenceInputWindowID
    ) -> Int? {
        guard acceptsInputWindowLocked(windowID) else { return nil }
        if let turn = inputWindowTurns[windowID] {
            activeTurnOrdinal = turn
            return turn
        }
        turnOrdinal += 1
        let turn = turnOrdinal
        inputWindowTurns[windowID] = turn
        activeTurnOrdinal = turn
        return turn
    }

    private func appendLocked(
        name: AlmaLiveVoiceEvidenceEventName,
        sourceTransportGeneration: Int? = nil,
        inputWindowOrdinal: Int? = nil,
        turnOrdinal: Int? = nil,
        toolOrdinal: Int? = nil,
        audioChunkOrdinal: Int? = nil,
        byteCount: Int? = nil,
        rmsMilli: Int? = nil,
        route: AlmaLiveVoiceEvidenceRoute? = nil,
        routeReason: AlmaLiveVoiceEvidenceRouteReason? = nil,
        reason: AlmaLiveVoiceEvidenceReason? = nil,
        retention: AlmaLiveVoiceEvidenceInputRetention? = nil,
        tool: AlmaLiveVoiceEvidenceTool? = nil,
        resumedTransport: Bool? = nil,
        observedUptime: TimeInterval? = nil
    ) {
        sequence += 1
        let observedElapsed = max(
            0,
            Int(((observedUptime ?? ProcessInfo.processInfo.systemUptime) - startedUptime) * 1_000))
        let elapsed = max(lastElapsedMilliseconds, observedElapsed)
        lastElapsedMilliseconds = elapsed
        let event = AlmaLiveVoiceEvidenceEvent(
            sequence: sequence,
            elapsedMilliseconds: elapsed,
            name: name,
            localSessionID: localSessionID,
            transportGeneration: transportGeneration,
            sourceTransportGeneration: sourceTransportGeneration,
            inputWindowOrdinal: inputWindowOrdinal,
            turnOrdinal: turnOrdinal,
            toolOrdinal: toolOrdinal,
            audioChunkOrdinal: audioChunkOrdinal,
            byteCount: byteCount,
            rmsMilli: rmsMilli,
            route: route,
            routeReason: routeReason,
            reason: reason,
            retention: retention,
            tool: tool,
            resumedTransport: resumedTransport)
        events.append(event)
        if events.count > Self.maximumEvents {
            events.removeFirst(events.count - Self.maximumEvents)
        }
        Self.logger.info("session=\(self.localSessionID, privacy: .public) sequence=\(self.sequence) event=\(name.rawValue, privacy: .public) transport=\(self.transportGeneration)")
    }

    private func reportLocked() -> AlmaLiveVoiceEvidenceReport {
        let info = Bundle.main.infoDictionary
        return AlmaLiveVoiceEvidenceReport(
            schemaVersion: 2,
            generatedAt: Self.iso(Date()),
            privacyContract: [
                "no-pcm-or-audio-payload",
                "no-transcript-prompt-or-user-content",
                "no-tool-arguments-results-or-provider-call-id",
                "no-url-token-cookie-credential-or-user-content-hash",
                "typed-allowlisted-fields-only",
                "raw-energy-is-not-proof-of-owner-speech",
                "queue-is-not-send-and-local-send-is-not-provider-receipt",
                "policy-is-a-local-app-decision-at-that-observation",
            ],
            featureEnabled: enabled,
            app: .init(
                version: Self.safeBuildValue(
                    info?["CFBundleShortVersionString"] as? String),
                build: Self.safeBuildValue(info?["CFBundleVersion"] as? String),
                commit: buildProvenance.evidenceCommit,
                revisionStatus: buildProvenance.revisionStatus),
            session: .init(
                id: localSessionID,
                startedAt: Self.iso(startedAt),
                endedAt: endedAt.map(Self.iso),
                callMode: callMode,
                requestedModelID: requestedModelID,
                requestedVoiceID: requestedVoiceID,
                activeModelID: activeModelID,
                activeVoiceID: activeVoiceID,
                outcome: outcome),
            events: events)
    }

    private static func makeLocalSessionID() -> String {
        return "voice-" + UUID().uuidString.lowercased()
    }

    private static func safeModelID(_ value: String) -> String {
        AlmaLiveVoicePreferences.models.contains(where: { $0.id == value }) ? value : "unknown"
    }

    private static func safeVoiceID(_ value: String) -> String {
        AlmaLiveVoicePreferences.voices.contains(where: { $0.id == value }) ? value : "unknown"
    }

    private static func safeBuildValue(_ value: String?) -> String {
        guard let value,
              value.range(of: #"^[A-Za-z0-9._-]{1,80}$"#, options: .regularExpression) != nil
        else { return "unknown" }
        return value
    }

    private static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

/// Release-safe audio evidence. Contains state/route/timing only — never
/// transcripts, credentials, URLs, or user content. The previous TestFlight
/// instrumentation was blind whenever the graph claimed to be running but the
/// hardware render path was silent.
enum AlmaVoiceAudioTrace {
    private static let logger = Logger(subsystem: "com.almatraders.erp.voice", category: "Audio")
    private static let lock = NSLock()
    private static var rows: [String] = []
    private static let startedAt = Date()

    static func event(_ name: String, _ detail: String = "") {
        let row = String(format: "+%.3f %@ %@", Date().timeIntervalSince(startedAt), name, detail)
        logger.info("\(row, privacy: .public)")
        lock.lock()
        rows.append(row)
        if rows.count > 120 { rows.removeFirst(rows.count - 120) }
        lock.unlock()
    }

    static func tail(_ count: Int = 14) -> String {
        lock.lock()
        let value = rows.suffix(count).joined(separator: " | ")
        lock.unlock()
        return value
    }
}

// MARK: - Voice engine (recorder + VAD + TTS chunk player + turn runner)

@available(iOS 17.0, *)
@Observable
@MainActor
final class AlmaVoiceEngine {
    weak var chatVM: AssistantVM?

    private var thinkHeartbeat: Task<Void, Never>?
    var state: AlmaVoiceState = .idle {
        didSet {
            // LOCKED-ADJ: silence-filler heartbeat — soft haptic every 1.6s while thinking.
            thinkHeartbeat?.cancel()
            if state == .thinking || state == .transcribing {
                thinkHeartbeat = Task { @MainActor in
                    let gen = UIImpactFeedbackGenerator(style: .soft)
                    gen.prepare()
                    while !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: 1_600_000_000)
                        guard !Task.isCancelled else { return }
                        gen.impactOccurred(intensity: 0.45)
                        gen.prepare()
                    }
                }
            }
            guard oldValue != state else { return }
            if state == .error { keepAliveStop() }   // dead turn = release the hold
            refreshWake()
            liveActivity.phaseChanged()
            tr("state \(oldValue) → \(state)")
        }
    }

    /// The wake word is the ONLY ambient mic, and it may run ONLY when the console is
    /// idle AND no TTS is playing. Gating it on `ttsActive` too means the agent's own
    /// greeting / narration can never trip the wake recogniser. Any non-idle state (or
    /// live TTS) stops it, so it never fights the STT mic.
    private func refreshWake() {
        let on = state == .idle && !ttsActive && !closed && !startingListen && !liveActive
            && sessionReady && callConnection == .idle
        if on { wake.start() } else { wake.stop() }
        tr(on ? "wake→ON" : "wake→off")
    }

    // Sim self-test tracing (launch-arg / env ALMA_VOICE_TRACE only; silent in prod).
    private static let trace =
        ProcessInfo.processInfo.arguments.contains { $0.hasPrefix("ALMA_VOICE_TRACE") } ||
        ProcessInfo.processInfo.environment["ALMA_VOICE_TRACE"] != nil
    private func tr(_ m: String) {
        guard Self.trace else { return }
        NSLog("ALMA-VOICE %@  [state=%@ ttsActive=%d]", m, "\(state)", ttsActive ? 1 : 0)
    }
    var transcript = ""              // what the owner said (final)
    var replyText = ""               // full streamed reply
    var saidLines: [String] = []     // spoken sentences (dim)
    var nowLine = ""                 // sentence being spoken (bright)
    var lastQ = ""                   // previous exchange (history block)
    var lastA = ""
    var convoMode = true             // কথোপকথন চালু (auto-relisten)
    var listenSeconds = 0
    var micLevel: Double = 0         // 0…1 for the orb/ring
    var ttsLevel: Double = 0
    var errorToast: String?
    var callConnection: AlmaCallConnectionState = .idle
    var connectionFailureText = ""
    var isMuted = false
    var speakerOn = true
    private(set) var liveProfileTransaction = AlmaLiveVoiceProfileTransaction(
        saved: AlmaLiveVoiceProfile(
            modelID: AlmaLiveVoicePreferences.modelID,
            voiceID: AlmaLiveVoicePreferences.voiceID))
    private(set) var liveProfileStatusText = ""
    private var currentConnectionProfile = AlmaLiveVoiceProfile(
        modelID: AlmaLiveVoicePreferences.modelID,
        voiceID: AlmaLiveVoicePreferences.voiceID)
    private var liveUsageCallID = UUID().uuidString.lowercased()
    private(set) var callStartedAt: Date?
    private let recoveryEvidence: AlmaLiveVoiceEvidenceRecorder

    var recoveryEvidenceSessionID: String { recoveryEvidence.sessionID }
    var isRecoveryEvidenceEnabled: Bool { recoveryEvidence.isEnabled }

    var savedLiveModelID: String { liveProfileTransaction.saved.modelID }
    var savedLiveVoiceID: String { liveProfileTransaction.saved.voiceID }
    var activeLiveModelID: String { liveProfileTransaction.active.modelID }
    var activeLiveVoiceID: String { liveProfileTransaction.active.voiceID }
    var isApplyingLiveProfile: Bool { liveProfileTransaction.isBusy }

    var selectedLiveModel: AlmaLiveModelChoice {
        AlmaLiveVoicePreferences.models.first(where: { $0.id == savedLiveModelID })
            ?? AlmaLiveVoicePreferences.models[0]
    }

    var selectedLiveVoice: AlmaLiveVoiceChoice {
        AlmaLiveVoicePreferences.voices.first(where: { $0.id == savedLiveVoiceID })
            ?? AlmaLiveVoicePreferences.voices[0]
    }

    @discardableResult
    func saveLiveProfile(modelID: String, voiceID: String) -> Bool {
        let profile = AlmaLiveVoiceProfile(modelID: modelID, voiceID: voiceID)
        guard liveProfileTransaction.save(profile) else { return false }
        AlmaLiveVoicePreferences.save(modelID: modelID, voiceID: voiceID)
        liveProfileStatusText = "পরের কলের জন্য সেভ হয়েছে।"
        UISelectionFeedbackGenerator().selectionChanged()
        return true
    }

    @discardableResult
    func applyLiveProfileNow(modelID: String, voiceID: String) -> Bool {
        guard AlmaLiveVoiceRecoveryFeatures.isEnabled(.profileTransactionV1),
              callConnection == .live || callConnection == .failed,
              !liveProfileTransaction.isBusy
        else { return false }
        let proposed = AlmaLiveVoiceProfile(modelID: modelID, voiceID: voiceID)
        guard proposed.isValid else { return false }
        if proposed == liveProfileTransaction.active {
            liveProfileStatusText = "এই profile-ই এখন সক্রিয়।"
            return true
        }
        guard liveProfileTransaction.beginApply(proposed) else { return false }
        currentConnectionProfile = proposed
        liveProfileStatusText = "নতুন profile যাচাই করে চালু করা হচ্ছে…"
        feedStatus("নতুন মডেল ও কণ্ঠ যাচাই করা হচ্ছে…")
        startLiveConnection(resetAttempts: true)
        return true
    }

    // ── Agent → owner in-app call (plan C2) ──
    // Set by the CallKit answer hand-off BEFORE begin(). On live connect the brief
    // is sent as realtime text so the agent SPEAKS FIRST with the reason
    // it called; on end() the CallKit system call is closed alongside the session.
    var activeAgentCallId: String?
    var pendingAgentCallBrief: String?
    private var agentBriefSent = false
    /// Installed only by AgentCallController. The controller captures the exact
    /// logical generation + CallKit UUID, so a delayed permission/socket failure
    /// can never end a replacement call that happens to reuse this engine path.
    @ObservationIgnored
    var agentCallTerminalFailure: (@MainActor (String) -> Void)?
    /// Exact controller-owned terminal request for Agent CallKit sessions.
    /// Engine-originated ends (Live Activity, model hangup, lifecycle) use this
    /// instead of a fire-and-forget CX transaction that could leave a ghost call.
    @ObservationIgnored
    var agentCallEndRequest: (@MainActor () -> Void)?

    /// Standalone engines claim this token themselves. Agent CallKit engines
    /// adopt the exact reservation minted before CXAnswer/CXStart and never
    /// release it; CallKit owns that token through matching didDeactivate/reset.
    @ObservationIgnored
    var callAudioAdmissionToken: AlmaCallAudioAdmission.Token?

    /// Agent call: CallKit owns the audio session, so the live session must not
    /// configure/activate it itself (build 89: audio never started).
    var callKitManaged = false {
        didSet { live.callKitOwnsAudioSession = callKitManaged }
    }

    /// CXProviderDelegate didActivate → hand the activated session to the live
    /// engine (starts, or retries, capture/playback).
    func callKitAudioActivated(_ observation: AlmaLiveVoiceLifecycleObservation) {
        guard acceptsCallAudioMediaMutation(),
              AlmaLiveVoiceLifecycleSessionFence.acceptsSourceToken(
            observation.sourceToken,
            currentToken: callKitLifecycleToken,
            isClosed: closed) else { return }
        guard acceptsLifecycleEffect(.callKitActivated) else { return }
        live.callKitAudioActivated(
            lifecycleEvidenceContext: observation.evidenceContext,
            lifecycleEvidenceSubmittedAtSource: observation.evidenceSubmittedAtSource)
    }

    func callKitAudioDeactivated(_ observation: AlmaLiveVoiceLifecycleObservation) {
        guard AlmaLiveVoiceLifecycleSessionFence.acceptsSourceToken(
            observation.sourceToken,
            currentToken: callKitLifecycleToken,
            isClosed: closed) else { return }
        guard acceptsLifecycleEffect(.callKitDeactivated) else { return }
        live.callKitAudioDeactivated(
            lifecycleEvidenceContext: observation.evidenceContext,
            lifecycleEvidenceSubmittedAtSource: observation.evidenceSubmittedAtSource)
    }

    /// CallKit activates the category that exists when CXAnswerCallAction is
    /// fulfilled. Preparing it afterwards leaves cold/background answers on the
    /// previous/default output unit until foregrounding or a route toggle.
    func prepareCallKitAudioSession() throws {
        guard acceptsCallAudioMediaMutation(),
              AlmaLiveVoicePreviewTakeoverRelay.shared
            .stopAndRestoreBeforeAudioTakeover()
        else { throw AlmaLiveVoiceError.audioStart }
        guard acceptsCallAudioMediaMutation() else { throw AlmaLiveVoiceError.audioStart }
        try live.prepareCallKitAudioSession()
    }

    /// Brief may arrive AFTER the live socket connected (the CallKit answer never
    /// waits on the network). Send it as the opening note either way, once.
    func deliverAgentBrief(_ brief: String) {
        guard activeAgentCallId != nil, !agentBriefSent, !brief.isEmpty else { return }
        if liveActive {
            agentBriefSent = true
            sendAgentBriefNote(brief)
        } else {
            pendingAgentCallBrief = brief
        }
    }

    private func sendAgentBriefNote(_ brief: String) {
        live.sendRealtimeText(
            "তুমি নিজে Boss-কে কল করেছ (Boss এইমাত্র ধরেছেন)। কারণ: \(String(brief.prefix(800)))। " +
            "সালাম দিয়ে শুরু করে কারণটা সংক্ষেপে নিজের ভাষায় বলো, তারপর Boss-এর কথা শোনো।")
    }

    struct Card: Identifiable, Equatable {
        enum Kind { case tool, approval, ask, modelSwitch }
        let id: String
        let kind: Kind
        var icon: String
        var title: String
        var sub: String
        var status: String           // run | ok | fail | wait | resolved-label
        var options: [String] = []   // ask cards
        var pendingActionId: String?
        var askCardId: String?
        var big: String = ""         // data cards: big number line
        var delta: String = ""       //   …its delta caption
        var spark: [Double] = []     //   …sparkline points
    }
    var cards: [Card] = []

    // ── Kimi-style rolling call transcript (owner spec 2026-07-23) ──
    // One line per turn: Boss's words dim, ALMA's words bright, tool progress
    // as status rows. The last user/agent line updates LIVE as words stream.
    struct LiveFeedLine: Identifiable, Equatable {
        enum Kind { case user, agent, status }
        let id: String
        let kind: Kind
        var text: String
    }
    var liveFeed: [LiveFeedLine] = []
    private var liveStatusNudgeTask: Task<Void, Never>? = nil
    private var feedUserLineId: String? = nil
    private var feedAgentLineId: String? = nil

    private func feedUpsert(id: String?, kind: LiveFeedLine.Kind, text: String) -> String {
        if let id, let i = liveFeed.firstIndex(where: { $0.id == id }) {
            liveFeed[i].text = text
            return id
        }
        let newId = UUID().uuidString
        liveFeed.append(.init(id: newId, kind: kind, text: text))
        if liveFeed.count > 80 { liveFeed.removeFirst(liveFeed.count - 80) }
        return newId
    }
    private func feedFinalizeUser() { feedUserLineId = nil }
    private func feedFinalizeAgent() { feedAgentLineId = nil }
    func feedStatus(_ text: String) {
        _ = feedUpsert(id: nil, kind: .status, text: text)
    }

    // internals
    private var recorder: AVAudioRecorder?
    private var vadTask: Task<Void, Never>?
    private var turnTask: Task<Void, Never>?
    /// Durable completion detector for run_agent_turn: the chat SSE connection
    /// can die SILENTLY mid-turn on real networks (owner device 2026-07-24 — the
    /// head's reply landed in chat but the voice agent waited the full 120s
    /// watchdog). This task polls the DB-backed turn-status endpoint alongside
    /// the stream; whichever channel finishes first wins.
    private var livePollTask: Task<Void, Never>?
    /// Turn id from the SSE `turn_id` event — lets the poller match OUR turn
    /// exactly and never deliver a stale previous answer.
    private var liveTurnId: String?
    /// done.needContinue from the last SSE done event (deadline-cut turn).
    private var lastDoneNeedContinue = false
    /// Machine-continuation budget per owner ask (chat parity, bounded).
    private var liveContinueBudget = 3
    private var heartbeatTask: Task<Void, Never>?
    private var lastUserText = ""
    private var lastToolNarration = Date.distantPast
    private var narratedFirstTool = false
    private var verificationSaid = false     // verification_retry spoken once per turn
    private var lastAudioAt = Date()
    private var lastEventAt = Date()          // stall watchdog: last SSE event received
    private var emptyListens = 0              // consecutive silent auto-listens (convo re-arm)
    private var ackData: [Data] = []
    private var ackIdx = 0
    private var sessionReady = false
    private var closed = false
    private var streamingActive = false      // a live-STT listen is in flight
    private(set) var liveActive = false       // persistent Gemini Live full-duplex session
    private var liveConnectTask: Task<Void, Never>?
    private var liveBudgetMonitorTask: Task<Void, Never>?
    private var liveBudgetGuard = AlmaLiveVoiceLocalBudgetGuard()
    private var liveConnectAttempt = 0
    private var connectionGeneration = 0
    private var hasEverConnected = false
    private var liveSessionHasStarted = false
    private var liveToolTurnPending = false
    private var activeLiveToolInvocation: AlmaLiveVoiceToolInvocation?
    private var quickLookupTask: Task<Void, Never>?

    /// Never advertise realtime until the Gemini socket has actually completed its
    /// setup handshake. AI Call does not silently downgrade to normal STT/TTS: a
    /// failure is shown honestly, retried, and then left recoverable via one button.
    var transportBadgeText: String {
        switch callConnection {
        case .idle, .connecting: return "সংযোগ হচ্ছে"
        case .live: return "রিয়েলটাইম"
        case .reconnecting: return "পুনঃসংযোগ"
        case .failed: return "সংযোগ হয়নি"
        }
    }

    var transportReady: Bool { callConnection == .live }
    var isCallRunning: Bool { callConnection != .idle }

    var visibleStatusText: String {
        switch callConnection {
        case .idle, .connecting: return "নিরাপদ লাইভ সংযোগ তৈরি হচ্ছে…"
        case .reconnecting: return "সংযোগ ফিরিয়ে আনা হচ্ছে…"
        case .failed: return "কলটি সংযুক্ত হয়নি"
        case .live:
            if isMuted { return "মাইক্রোফোন বন্ধ" }
            if state == .idle { return "শুনছি…" }
            if state == .thinking && liveToolTurnPending { return "কাজ করছি…" }
            return state.statusText
        }
    }

    func callElapsedText(at now: Date) -> String {
        guard let callStartedAt else { return "00:00" }
        let seconds = max(0, Int(now.timeIntervalSince(callStartedAt)))
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
    // MIC GATE (half-duplex): true from the moment ANY TTS chunk starts until the
    // queue goes fully silent. While true, NO mic opens — not the STT listen, not
    // auto-listen, not the wake word. This is the guard that stops the agent from
    // hearing its own voice (the barge-in mic used to do exactly that on the loud,
    // no-echo-cancellation speaker session). Tap-to-interrupt on the orb still works.
    private var ttsActive = false

    private let tts = AlmaTtsQueue()
    private var streamer = AlmaStreamingSTT()
    /// A console listen may still be suspended in `AlmaStreamingSTT.start()` when
    /// the owner hangs up or begins a replacement call.  Keep both an operation
    /// generation and the concrete source object so a late mic/socket callback
    /// can never authenticate against the reused engine.
    private var listenStartTask: Task<Void, Never>?
    private var listenGeneration: UInt64 = 0
    private let live: AlmaGeminiLiveSession
    let wake = AlmaWakeWord()
    // Dynamic Island / Lock Screen Live Activity (docs/alma-live-activity-PLAN.md)
    private let liveActivity = VoiceLiveActivityController()
    private var liveActivityEndObserver: NSObjectProtocol?
    // Conversation keep-alive + audio self-heal (owner bugs 2026-07-08: background
    // re-listen died, foreground return needed an app kill)
    private var keepAlive: AVAudioPlayer?
    private var recoveryObservers: [NSObjectProtocol] = []
    /// MainActor behavior fence independent of the optional evidence gate.
    /// The engine object is reused, so every logical call must mint a new epoch.
    private var lifecycleBehaviorEpoch = 0
    private var lifecycleReducerEnabled = false
    private var lifecycleReducer: AlmaLiveVoiceLifecycleReducer?
    private var callKitLifecycleToken: AlmaLiveVoiceLifecycleSourceToken?
    /// A system call may preempt standalone Live Voice on PushKit's reporting
    /// deadline. Evidence queues are drained only by the post-report teardown
    /// receipt, never inside the synchronous pre-report stop callback.
    private var systemPreemptionEvidenceFinalizer: AlmaLiveVoiceTerminalEvidenceFinalizer?
    fileprivate var startingListen = false   // a listen is spinning up (double-tap guard)

    fileprivate func wakeWordEligibilityToken() -> Int? {
        guard state == .idle, !ttsActive, !closed, !startingListen, !liveActive,
              sessionReady, callConnection == .idle
        else { return nil }
        return lifecycleBehaviorEpoch
    }

    fileprivate func isWakeWordEligible(lifecycleEpoch: Int) -> Bool {
        wakeWordEligibilityToken() == lifecycleEpoch
    }

    init() {
        let evidence = AlmaLiveVoiceEvidenceRecorder(
            enabled: AlmaLiveVoiceRecoveryFeatures.isEnabled(.evidenceV1))
        recoveryEvidence = evidence
        live = AlmaGeminiLiveSession(evidenceRecorder: evidence)
    }

    // Image attachments — voice parity with the chat composer. Photograph a
    // product / paste a poster and the SAME multimodal turn the chat runs fires
    // by voice. Uses the shared AgentFileRef + /api/assistant/upload.
    struct PendingImage: Identifiable, Equatable {
        enum State: Equatable { case uploading, ready(AgentFileRef), failed }
        let id = UUID()
        let image: UIImage
        var state: State = .uploading
    }
    var pendingImages: [PendingImage] = []
    private var readyImageFiles: [AgentFileRef] {
        pendingImages.compactMap { if case .ready(let f) = $0.state { return f } else { return nil } }
    }

    /// TRUE streaming STT (gpt-4o-transcribe realtime, live words as spoken). Back ON
    /// by default: it transcribed the owner's Bangla correctly on device in build 44 —
    /// the crash there was the .voiceChat VPIO session (now .default), NOT the streaming
    /// itself. Its transcription is markedly better than the record→Whisper fallback,
    /// which mis-heard/failed on 4G. ANY pre-audio failure still falls back to the
    /// recorder. Escape hatch: `alma-voice-streaming` = false.
    private var streamingEnabled: Bool {
        (UserDefaults.standard.object(forKey: "alma-voice-streaming") as? Bool) ?? true
    }

    private var recURL: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("alma-voice-turn.m4a")
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    private func acceptsCallAudioMediaMutation() -> Bool {
        guard let callAudioAdmissionToken else { return false }
        return AlmaCallAudioAdmission.shared.acceptsMediaMutation(callAudioAdmissionToken)
    }

    private func stopForSystemCallReservation() {
        guard !callKitManaged else { return }
        // `claimSystem` invokes this before PushKit reports the incoming call.
        // Keep the synchronous boundary local: stop publication/socket/mic now,
        // queue CoreAudio teardown, and leave its bounded drain to the receipt
        // that CallKit executes immediately after reportNewIncomingCall returns.
        end(waitForAudioTeardown: false)
    }

    private func finishSystemCallReservationTeardown() {
        live.waitForPendingAudioTeardown()
        _ = systemPreemptionEvidenceFinalizer?.finish()
        systemPreemptionEvidenceFinalizer = nil
    }

    /// Prewarm on console open: audio session active + mic permission + ack cache +
    /// time-of-day greeting. This is what kills the web's 2–5s first-tap latency.
    func begin() {
        // Re-opening a minimized call must only reveal its existing engine. Starting
        // a second socket here would duplicate audio and lose the live context.
        guard callConnection == .idle else { return }
        let claimedStandaloneToken: AlmaCallAudioAdmission.Token?
        if callKitManaged {
            guard acceptsCallAudioMediaMutation() else {
                connectionFailureText = "অন্য একটি কলের অডিও এখন সক্রিয়।"
                errorToast = connectionFailureText
                return
            }
            claimedStandaloneToken = nil
        } else {
            guard callAudioAdmissionToken == nil,
                  let token = AlmaCallAudioAdmission.shared.claimNormal(
                    .assistant(engine: ObjectIdentifier(self)),
                    stop: { [weak self] in self?.stopForSystemCallReservation() },
                    finishTeardown: { [self] in finishSystemCallReservationTeardown() })
            else {
                connectionFailureText = "অন্য একটি কলের অডিও এখন সক্রিয়।"
                errorToast = connectionFailureText
                return
            }
            callAudioAdmissionToken = token
            claimedStandaloneToken = token
        }
        guard AlmaLiveVoicePreviewTakeoverRelay.shared
            .stopAndRestoreBeforeAudioTakeover()
        else {
            if let claimedStandaloneToken {
                AlmaCallAudioAdmission.shared.release(claimedStandaloneToken)
                callAudioAdmissionToken = nil
            }
            connectionFailureText = "আগের কলের অডিও বন্ধ হচ্ছে — একটু পরে আবার চেষ্টা করুন।"
            errorToast = connectionFailureText
            return
        }
        guard acceptsCallAudioMediaMutation() else {
            if let claimedStandaloneToken {
                AlmaCallAudioAdmission.shared.release(claimedStandaloneToken)
                callAudioAdmissionToken = nil
            }
            connectionFailureText = "অন্য একটি কলের অডিও এখন সক্রিয়।"
            errorToast = connectionFailureText
            return
        }
        lifecycleBehaviorEpoch &+= 1
        lifecycleReducerEnabled = AlmaLiveVoiceRecoveryFeatures.isEnabled(.lifecycleReducerV1)
        if lifecycleReducerEnabled,
           let generation = UInt64(exactly: lifecycleBehaviorEpoch),
           var reducer = AlmaLiveVoiceLifecycleReducer(
               generation: generation,
               backgroundContinuation: callKitManaged
                   ? .whileCallKitActive
                   : .foregroundOnly,
               initialRoute: callKitManaged ? .builtInReceiver : .builtInSpeaker,
               initialCallKitState: callKitManaged ? .reserved : .notManaged) {
            // A fresh engine is still connecting. Provider readiness opens only
            // from this generation's explicit `liveDidConnect` callback.
            _ = reducer.reduce(.init(generation: generation, event: .providerDisconnected))
            if UIApplication.shared.applicationState != .active {
                _ = reducer.reduce(.init(generation: generation, event: .appBackgrounded))
            }
            if !UIApplication.shared.isProtectedDataAvailable {
                _ = reducer.reduce(.init(generation: generation, event: .deviceLocked))
            }
            lifecycleReducer = reducer
        } else {
            lifecycleReducerEnabled = false
            lifecycleReducer = nil
        }
        if #available(iOS 17.0, *) { AlmaCallBarBridge.shared.engine = self }
        agentBriefSent = false
        closed = false
        // A hang-up left half-scheduled on the previous call must not reject
        // the next one's end request (Codex P2 round 6 — the console reuses
        // this engine instance across calls).
        modelEndPending = false
        lastHangupContextAt = .distantPast
        callConnection = .connecting
        connectionFailureText = ""
        liveConnectAttempt = 0
        hasEverConnected = false
        callStartedAt = nil
        isMuted = false
        let savedProfile = AlmaLiveVoiceProfile(
            modelID: AlmaLiveVoicePreferences.modelID,
            voiceID: AlmaLiveVoicePreferences.voiceID)
        liveProfileTransaction.resetForNewCall(saved: savedProfile)
        currentConnectionProfile = savedProfile
        liveProfileStatusText = ""
        recoveryEvidence.beginSession(
            modelID: savedProfile.modelID,
            voiceID: savedProfile.voiceID,
            callMode: callKitManaged ? .callKit : .standalone)
        live.beginEvidenceSession()
        if let activeAgentCallId, !activeAgentCallId.isEmpty {
            liveUsageCallID = activeAgentCallId.lowercased()
        } else {
            liveUsageCallID = UUID().uuidString.lowercased()
        }
        live.beginUsageSession(callID: liveUsageCallID)
        startLiveBudgetMonitor()
        live.beginToolOrchestrationSession(
            enabled: AlmaLiveVoiceRecoveryFeatures.isEnabled(.toolOrchestrationV1))
        if callKitManaged {
            callKitLifecycleToken = CallKitVoIP.shared.bindAgentLifecycleEvidence(live)
        } else {
            callKitLifecycleToken = nil
        }
        // A CallKit incoming call must start on the receiver. Explicitly pinning
        // it to `.speaker` prevents the locked system call screen from clearing
        // our app-level override, so its Speaker OFF button appears to do
        // nothing. Foreground, app-owned voice sessions keep their speaker-first
        // behaviour; CallKit can then own receiver/speaker changes normally.
        speakerOn = !callKitManaged
        liveSessionHasStarted = false
        AlmaVoiceAudioTrace.event("engine.begin", callKitManaged ? "callkit=1" : "callkit=0")
        tts.engine = self
        // Island up for the whole session; the island's End button posts
        // almaVoiceEndRequested (AlmaVoiceEndIntent runs in this process).
        liveActivity.engine = self
        liveActivity.start()
        if liveActivityEndObserver == nil {
            let liveActivitySourceBehaviorEpoch = lifecycleBehaviorEpoch
            liveActivityEndObserver = NotificationCenter.default.addObserver(
                forName: .almaVoiceEndRequested, object: nil, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    self?.endFromLifecycleRequest(
                        expectedLifecycleEpoch: liveActivitySourceBehaviorEpoch)
                }
            }
        }
        // Self-heal wiring (owner bugs 2026-07-08): foreground return, call/other-app
        // interruption, media-services reset — and the island's "শুনুন" orb button.
        if recoveryObservers.isEmpty {
            let nc = NotificationCenter.default
            // Capture the thread-safe live-session reference once on MainActor.
            // NotificationCenter's `.main` queue then records callback time and
            // logical-session identity before any deferred UI recovery work.
            let lifecycleEvidenceSource = live
            let lifecycleEvidenceSessionID = live.lifecycleEvidenceSessionID
            let lifecycleSourceBehaviorEpoch = lifecycleBehaviorEpoch
            recoveryObservers.append(nc.addObserver(
                forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
            ) { [weak self] _ in
                let context = lifecycleEvidenceSource.lifecycleEvidenceContext(
                    localSessionID: lifecycleEvidenceSessionID)
                lifecycleEvidenceSource.recordLifecycleEvidence(
                    .appBackgrounded,
                    context: context)
                Task { @MainActor in
                    _ = self?.reduceLifecycle(
                        .appBackgrounded,
                        expectedLifecycleEpoch: lifecycleSourceBehaviorEpoch)
                }
            })
            recoveryObservers.append(nc.addObserver(
                forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
            ) { [weak self] _ in
                let context = lifecycleEvidenceSource.lifecycleEvidenceContext(
                    localSessionID: lifecycleEvidenceSessionID)
                lifecycleEvidenceSource.recordLifecycleEvidence(
                    .appWillEnterForeground,
                    context: context)
                Task { @MainActor in
                    guard let self else { return }
                    let transition = self.reduceLifecycle(
                        .appForegrounded,
                        expectedLifecycleEpoch: lifecycleSourceBehaviorEpoch)
                    if self.lifecycleAllowsMediaRecovery(transition) {
                        self.recoverAudio(
                            "foreground",
                            expectedLifecycleEpoch: lifecycleSourceBehaviorEpoch)
                    }
                }
            })
            recoveryObservers.append(nc.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { _ in
                let context = lifecycleEvidenceSource.lifecycleEvidenceContext(
                    localSessionID: lifecycleEvidenceSessionID)
                lifecycleEvidenceSource.recordLifecycleEvidence(
                    .appBecameActive,
                    context: context)
            })
            recoveryObservers.append(nc.addObserver(
                forName: UIApplication.protectedDataWillBecomeUnavailableNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    _ = self?.reduceLifecycle(
                        .deviceLocked,
                        expectedLifecycleEpoch: lifecycleSourceBehaviorEpoch)
                }
            })
            recoveryObservers.append(nc.addObserver(
                forName: UIApplication.protectedDataDidBecomeAvailableNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    let transition = self.reduceLifecycle(
                        .deviceUnlocked,
                        expectedLifecycleEpoch: lifecycleSourceBehaviorEpoch)
                    if self.lifecycleAllowsMediaRecovery(transition) {
                        self.recoverAudio(
                            "device-unlocked",
                            expectedLifecycleEpoch: lifecycleSourceBehaviorEpoch)
                    }
                }
            })
            recoveryObservers.append(nc.addObserver(
                forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
            ) { [weak self] note in
                guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
                let began = type == .began
                let context = lifecycleEvidenceSource.lifecycleEvidenceContext(
                    localSessionID: lifecycleEvidenceSessionID)
                lifecycleEvidenceSource.recordLifecycleEvidence(
                    began ? .audioInterruptionBegan : .audioInterruptionEnded,
                    context: context)
                Task { @MainActor in
                    self?.handleInterruption(
                        began: began,
                        expectedLifecycleEpoch: lifecycleSourceBehaviorEpoch)
                }
            })
            recoveryObservers.append(nc.addObserver(
                forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main
            ) { [weak self] _ in
                let context = lifecycleEvidenceSource.lifecycleEvidenceContext(
                    localSessionID: lifecycleEvidenceSessionID)
                lifecycleEvidenceSource.recordLifecycleEvidence(
                    .mediaServicesReset,
                    context: context)
                Task { @MainActor in
                    self?.recoverAudio(
                        "mediaReset",
                        expectedLifecycleEpoch: lifecycleSourceBehaviorEpoch)
                }
            })
            recoveryObservers.append(nc.addObserver(
                forName: .almaVoiceListenRequested, object: nil, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    self?.islandListen(
                        expectedLifecycleEpoch: lifecycleSourceBehaviorEpoch)
                }
            })
            #if DEBUG
            recoveryObservers.append(nc.addObserver(
                forName: Notification.Name("almaVoiceDebugSay"), object: nil, queue: .main
            ) { [weak self] note in
                guard let text = note.userInfo?["text"] as? String else { return }
                Task { @MainActor in self?.debugInjectUserTurn(text) }
            })
            #endif
        }
        let micPermissionBehaviorEpoch = lifecycleBehaviorEpoch
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                guard let self,
                      !self.closed,
                      self.lifecycleBehaviorEpoch == micPermissionBehaviorEpoch,
                      self.callConnection != .idle,
                      self.acceptsCallAudioMediaMutation()
                else { return }
                guard granted else {
                    self.connectionFailureText = "মাইক্রোফোনের অনুমতি নেই। Settings থেকে Microphone চালু করুন।"
                    self.errorToast = self.connectionFailureText
                    self.callConnection = .failed
                    self.state = .error
                    self.failActiveAgentCallTerminally(
                        "microphone permission denied")
                    return
                }
                self.wake.engine = self
                self.live.engine = self
                if !self.callKitManaged {
                    do {
                        guard self.acceptsCallAudioMediaMutation(),
                              AlmaLiveVoicePreviewTakeoverRelay.shared
                            .stopAndRestoreBeforeAudioTakeover()
                        else { throw AlmaLiveVoiceError.audioStart }
                        guard self.acceptsCallAudioMediaMutation()
                        else { throw AlmaLiveVoiceError.audioStart }
                        try self.live.prepareStandaloneAudioSession()
                    } catch {
                        AlmaVoiceAudioTrace.event("session.prepare.failed", String(describing: error))
                        self.liveConnectionFailed(error: error, message: "লাইভ অডিও প্রস্তুত করা যায়নি।")
                        return
                    }
                }
                self.startLiveConnection(resetAttempts: true)
            }
        }
    }

    /// Three bounded attempts cover transient radio / preview hand-off failures.
    /// Authentication errors stop immediately because retrying cannot repair them.
    private func startLiveConnection(resetAttempts: Bool) {
        guard !closed, acceptsCallAudioMediaMutation() else { return }
        _ = reduceLifecycle(.providerDisconnected)
        if resetAttempts { liveConnectAttempt = 0 }
        liveConnectTask?.cancel()
        connectionGeneration += 1
        let generation = connectionGeneration
        // A cold session has no graph/socket to tear down. The old unconditional
        // stop queued AVAudioSession.setActive(false) directly ahead of the very
        // first configure/start sequence.
        if liveSessionHasStarted { live.stop() }
        currentConnectionProfile = liveProfileTransaction.requested
        let liveStartAttempt = live.reserveStartAttempt(
            engineConnectionGeneration: generation,
            profile: currentConnectionProfile)
        liveSessionHasStarted = true
        liveActive = false
        sessionReady = false
        micLevel = 0
        ttsLevel = 0
        state = .idle
        callConnection = hasEverConnected || liveConnectAttempt > 0 ? .reconnecting : .connecting
        live.setInputMuted(isMuted)
        try? live.setSpeakerEnabled(speakerOn)

        liveConnectTask = Task { [weak self] in
            guard let self else { return }
            if self.liveConnectAttempt > 0 {
                let delay = UInt64(self.liveConnectAttempt) * 1_000_000_000
                try? await Task.sleep(nanoseconds: delay)
                guard !Task.isCancelled, self.acceptsCallAudioMediaMutation() else { return }
            }
            guard self.acceptsCallAudioMediaMutation() else { return }
            do {
                try await self.live.start(attempt: liveStartAttempt)
            } catch {
                guard !Task.isCancelled else { return }
                self.liveConnectionFailed(error: error, message: nil, generation: generation)
                return
            }

            // `start()` mints the session and opens the socket; setup completion is
            // delivered by delegate callback. Never spin forever on a half-open socket.
            try? await Task.sleep(nanoseconds: 12_000_000_000)
            guard !Task.isCancelled, !self.closed,
                  self.acceptsCallAudioMediaMutation(),
                  generation == self.connectionGeneration,
                  !self.liveActive else { return }
            // Socket setup DONE but audio still waiting on a late CallKit
            // didActivate: the ~10s audio-retry ladder can outlive this 12s
            // watchdog (Codex P2) — grant it one more full window before
            // declaring the call dead.
            if self.live.isAwaitingCallKitAudio {
                try? await Task.sleep(nanoseconds: 12_000_000_000)
                guard !Task.isCancelled, !self.closed, generation == self.connectionGeneration,
                      !self.liveActive else { return }
            }
            self.live.stop()
            self.liveConnectionFailed(
                error: nil,
                message: "লাইভ সংযোগের সময় শেষ হয়েছে।",
                generation: generation
            )
        }
    }

    private func liveConnectionFailed(error: Error?, message: String?, generation: Int? = nil) {
        guard !closed, generation == nil || generation == connectionGeneration else { return }
        liveConnectTask?.cancel()
        liveConnectTask = nil
        liveActive = false
        sessionReady = false
        micLevel = 0
        ttsLevel = 0

        let isAuthenticationFailure: Bool = {
            guard let apiError = error as? AlmaAPIError else { return false }
            if case .notAuthenticated = apiError { return true }
            if case .http(let status, _) = apiError, status == 401 || status == 403 { return true }
            return false
        }()
        if isAuthenticationFailure {
            if liveProfileTransaction.isBusy {
                liveProfileTransaction.abort()
                liveProfileStatusText = "সেশন authentication ব্যর্থ—profile পরিবর্তন করা হয়নি।"
            }
            connectionFailureText = "সেশন শেষ হয়েছে। অ্যাপে আবার লগইন করে কল চালু করুন।"
            errorToast = connectionFailureText
            callConnection = .failed
            state = .error
            failActiveAgentCallTerminally("live authentication failed")
            return
        }

        if liveConnectAttempt < 2 {
            liveConnectAttempt += 1
            callConnection = .reconnecting
            live.recordLifecycleEvidence(.fullRestartScheduled)
            startLiveConnection(resetAttempts: false)
            return
        }

        let failedProfilePhase = liveProfileTransaction.phase
        if let rollbackProfile = liveProfileTransaction.failed(currentConnectionProfile) {
            currentConnectionProfile = rollbackProfile
            liveProfileStatusText = "নতুন profile health check-এ ব্যর্থ; আগেরটি ফিরিয়ে আনা হচ্ছে…"
            feedStatus("নতুন profile চালু হয়নি—আগেরটি ফিরিয়ে আনা হচ্ছে…")
            liveConnectAttempt = 0
            live.recordLifecycleEvidence(.fullRestartScheduled)
            startLiveConnection(resetAttempts: true)
            return
        }
        if case .rollingBack = failedProfilePhase {
            liveProfileStatusText = "নতুন profile ও আগের profile—দুটির সংযোগই ব্যর্থ হয়েছে।"
        }

        connectionFailureText = message ?? "লাইভ ভয়েস সংযোগ পাওয়া যাচ্ছে না। ইন্টারনেট দেখে আবার চেষ্টা করুন।"
        errorToast = connectionFailureText
        callConnection = .failed
        state = .error
        // Agent call on a real device: send the reason to the server so it is
        // diagnosable without a console (TestFlight builds log nowhere).
        if activeAgentCallId != nil {
            let detail = String((error.map { String(describing: $0) } ?? message ?? "unknown").prefix(200))
            let trace = String(AlmaVoiceAudioTrace.tail(5).prefix(230))
            failActiveAgentCallTerminally(
                "live failed: \(detail) | vpUnavailable=\(live.voiceProcessingUnavailable) | \(trace)")
        }
    }

    /// Every provider/audio callback carries the exact engine connection
    /// generation that created it. `end()` and every replacement attempt advance
    /// this value before the engine can be reused, so a deferred MainActor block
    /// from call A cannot mutate call B.
    func acceptsLiveCallback(connectionGeneration expected: Int) -> Bool {
        !closed && liveSessionHasStarted && acceptsCallAudioMediaMutation()
            && connectionGeneration == expected
    }

    private func failActiveAgentCallTerminally(_ reason: String) {
        guard activeAgentCallId != nil else { return }
        if let agentCallTerminalFailure {
            agentCallTerminalFailure(String(reason.prefix(480)))
        } else {
            AgentCallController.shared.reportLiveFailure(String(reason.prefix(480)))
        }
    }

    func retryLiveConnection() {
        guard callConnection == .failed, acceptsCallAudioMediaMutation() else { return }
        connectionFailureText = ""
        errorToast = nil
        live.recordLifecycleEvidence(.fullRestartScheduled)
        startLiveConnection(resetAttempts: true)
    }

    func toggleMute() {
        guard callConnection == .live else { return }
        setMuted(!isMuted)
        UISelectionFeedbackGenerator().selectionChanged()
    }

    func setMuted(_ muted: Bool) {
        guard acceptsLifecycleEffect(muted ? .userMuted : .userUnmuted) else { return }
        isMuted = muted
        live.setInputMuted(muted)
        if muted { micLevel = 0 }
        liveActivity.stateChanged()
    }

    func toggleSpeaker() {
        guard callConnection == .live else { return }
        let requested = !speakerOn
        do {
            try live.setSpeakerEnabled(requested)
            speakerOn = requested
            UISelectionFeedbackGenerator().selectionChanged()
        } catch {
            errorToast = "অডিও আউটপুট বদলানো গেল না।"
        }
    }

    func end() {
        end(waitForAudioTeardown: true)
    }

    private func startLiveBudgetMonitor() {
        liveBudgetMonitorTask?.cancel()
        liveBudgetMonitorTask = nil
        liveBudgetGuard = AlmaLiveVoiceLocalBudgetGuard()
        guard let contract = AlmaLiveVoicePreferences.activeContract else { return }
        let interval = UInt64(contract.localBudget.pollIntervalMilliseconds) * 1_000_000
        liveBudgetMonitorTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: interval)
                guard !Task.isCancelled, let self, !self.closed else { return }
                let evaluation = AlmaLiveVoiceLocalBudgetEvaluator.evaluate(
                    report: self.live.usageReport(conversationID: nil),
                    contract: contract)
                guard let action = self.liveBudgetGuard.consume(evaluation) else { continue }
                switch action {
                case .alert(let estimatedMicroUSD):
                    let spent = Double(estimatedMicroUSD) / 1_000_000
                    let limit = Double(contract.localBudget.terminationMicroUSD) / 1_000_000
                    self.errorToast = String(
                        format: "Live Voice খরচ $%.2f হয়েছে; $%.2f সীমায় কল শেষ হবে।",
                        spent, limit)
                case .terminate:
                    self.errorToast = "Live Voice-এর নির্ধারিত খরচসীমা পূর্ণ হওয়ায় কল শেষ হয়েছে।"
                    self.feedStatus("খরচসীমা পূর্ণ হয়েছে — কল শেষ করা হচ্ছে।")
                    self.end()
                    return
                }
            }
        }
    }

    private func end(waitForAudioTeardown: Bool) {
        guard !closed else { return }
        _ = reduceLifecycle(.userEnded)
        let standaloneAdmissionToken = callKitManaged ? nil : callAudioAdmissionToken
        if let standaloneAdmissionToken {
            _ = AlmaCallAudioAdmission.shared.beginTeardown(standaloneAdmissionToken)
        }
        lifecycleBehaviorEpoch &+= 1
        let evidenceOutcome: AlmaLiveVoiceEvidenceSessionOutcome =
            callConnection == .failed ? .failed : .ownerEnded
        let evidenceSessionID = recoveryEvidence.sessionID
        let terminalEvidenceFinalizer = AlmaLiveVoiceTerminalEvidenceFinalizer(
            live: live,
            recorder: recoveryEvidence,
            expectedLocalSessionID: evidenceSessionID,
            outcome: evidenceOutcome)
        let defersTerminalCallKitEvidence: Bool
        if callKitManaged, let callKitLifecycleToken {
            defersTerminalCallKitEvidence = CallKitVoIP.shared
                .deferAgentLifecycleEvidenceFinalization(
                    live,
                    token: callKitLifecycleToken,
                    finalizer: terminalEvidenceFinalizer)
        } else {
            defersTerminalCallKitEvidence = false
        }
        let defersStandaloneSystemPreemptionEvidence =
            !callKitManaged && !waitForAudioTeardown
        if defersStandaloneSystemPreemptionEvidence {
            systemPreemptionEvidenceFinalizer = terminalEvidenceFinalizer
        } else if !defersTerminalCallKitEvidence {
            if callKitManaged {
                CallKitVoIP.shared.clearAgentLifecycleEvidence(live)
            }
            _ = terminalEvidenceFinalizer.finish()
        }
        callKitLifecycleToken = nil
        closed = true
        // Agent call: closing the session must also close the CallKit system call
        // (the CXEndCallAction it triggers posts 'completed' to the server).
        if let agentCallId = activeAgentCallId {
            activeAgentCallId = nil
            pendingAgentCallBrief = nil
            if let agentCallEndRequest {
                self.agentCallEndRequest = nil
                agentCallEndRequest()
            } else if #available(iOS 17.0, *), CallKitVoIP.shared.hasCall(callId: agentCallId) {
                Task {
                    _ = await CallKitVoIP.shared.requestEnd(
                        callId: agentCallId,
                        reason: "agent_call_done")
                }
            }
        }
        liveConnectTask?.cancel(); liveConnectTask = nil
        liveBudgetMonitorTask?.cancel(); liveBudgetMonitorTask = nil
        liveSessionHasStarted = false
        connectionGeneration += 1
        keepAliveStop()
        for ob in recoveryObservers { NotificationCenter.default.removeObserver(ob) }
        recoveryObservers = []
        liveActivity.end()
        if let ob = liveActivityEndObserver {
            NotificationCenter.default.removeObserver(ob)
            liveActivityEndObserver = nil
        }
        wake.stop()
        vadTask?.cancel(); vadTask = nil
        turnTask?.cancel(); turnTask = nil
        quickLookupTask?.cancel(); quickLookupTask = nil
        livePollTask?.cancel(); livePollTask = nil
        liveStatusNudgeTask?.cancel(); liveStatusNudgeTask = nil
        heartbeatTask?.cancel(); heartbeatTask = nil
        recorder?.stop(); recorder = nil
        listenGeneration &+= 1
        listenStartTask?.cancel(); listenStartTask = nil
        startingListen = false
        let endingStreamer = streamer
        streamer = AlmaStreamingSTT()
        endingStreamer.cancel(); streamingActive = false
        // Keep the admission bridge non-idle until the app-owned graph/session
        // teardown has completed. Otherwise a newly admitted preview can activate
        // and then be deactivated by this call's stale audioQueue cleanup.
        live.stop(waitForAudioTeardown: waitForAudioTeardown); liveActive = false
        live.endToolOrchestrationSession()
        // Snapshot after socket/input shutdown so the report has a closed local
        // measurement boundary. No transcript text leaves the device.
        let usageReport = live.usageReport(conversationID: chatVM?.conversationId)
        if let usageReport {
            Task {
                struct UsageResp: Decodable { let ok: Bool? }
                let _: UsageResp? = try? await AlmaAPI.shared.send(
                    "POST", "/api/assistant/live-session/usage",
                    body: usageReport)
                if let convId = usageReport.conversationId, !convId.isEmpty {
                    struct CompactBody: Encodable { let conversationId: String; let ifNeeded: Bool }
                    struct CompactResp: Decodable { let compacted: Bool? }
                    let resp: CompactResp? = try? await AlmaAPI.shared.send(
                        "POST", "/api/assistant/internal/compact-conversation",
                        body: CompactBody(conversationId: convId, ifNeeded: true))
                    #if DEBUG
                    NSLog("ALMA-VOICE call end: usage segments=%d compacted=%@",
                          usageReport.segments.count,
                          (resp?.compacted ?? false) ? "yes" : "no")
                    #endif
                }
            }
        }
        tts.stopAll()
        if #available(iOS 17.0, *), AlmaCallBarBridge.shared.engine === self {
            AlmaCallBarBridge.shared.engine = nil
            AlmaCallBarBridge.shared.consoleVisible = false
        }
        sessionReady = false
        callConnection = .idle
        connectionFailureText = ""
        callStartedAt = nil
        isMuted = false
        speakerOn = true
        UIDevice.current.isProximityMonitoringEnabled = false
        liveToolTurnPending = false
        activeLiveToolInvocation = nil
        state = .idle
        if let standaloneAdmissionToken {
            AlmaCallAudioAdmission.shared.release(standaloneAdmissionToken)
        }
        callAudioAdmissionToken = nil
        Task { await chatVM?.loadMessages() }   // the voice turn lands in the thread
    }

    func exportRecoveryEvidence() -> URL? {
        do {
            live.flushEvidence()
            let url = try recoveryEvidence.exportURL()
            UIAccessibility.post(
                notification: .announcement,
                argument: "ভয়েস evidence report প্রস্তুত হয়েছে")
            return url
        } catch {
            errorToast = "ভয়েস evidence report তৈরি করা যায়নি।"
            return nil
        }
    }

    #if DEBUG
    func debugPrepareRecoveryEvidenceFixture() {
        let fixtureProfile = AlmaLiveVoiceProfile(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede")
        liveProfileTransaction.resetForNewCall(saved: fixtureProfile)
        currentConnectionProfile = fixtureProfile
        recoveryEvidence.beginFixtureSession(
            modelID: fixtureProfile.modelID,
            voiceID: fixtureProfile.voiceID,
            callMode: .debugNoNetwork,
            fixture: .noNetwork)
        recoveryEvidence.endSession(.debugFixture)
    }
    #endif

    // ── Conversation keep-alive + audio self-heal ──────────────────────────
    // Keep-alive: a looping SILENT player runs ONLY while a conversation is
    // actively cycling (owner: never always-on). With the `audio` background
    // mode it stops iOS suspending the app between turns, so backgrounded
    // re-listen works and a mid-question exit can't truncate the mic. Released
    // when the conversation goes idle, on error, on শেষ, on console close.

    private static let silentWav: Data = {
        var d = Data()
        func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let samples = 8000                                    // 1s mono 8kHz 16-bit
        d.append("RIFF".data(using: .ascii)!); le32(UInt32(36 + samples * 2))
        d.append("WAVEfmt ".data(using: .ascii)!); le32(16); le16(1); le16(1)
        le32(8000); le32(16000); le16(2); le16(16)
        d.append("data".data(using: .ascii)!); le32(UInt32(samples * 2))
        d.append(Data(count: samples * 2))
        return d
    }()

    private func keepAliveStart() {
        guard keepAlive == nil else { return }
        keepAlive = try? AVAudioPlayer(data: Self.silentWav)
        keepAlive?.numberOfLoops = -1
        keepAlive?.volume = 0
        keepAlive?.play()
        tr("keepAlive ON")
    }

    private func keepAliveStop() {
        guard keepAlive != nil else { return }
        keepAlive?.stop(); keepAlive = nil
        tr("keepAlive off")
    }

    /// All lifecycle callbacks enter the pure reducer with the logical call
    /// epoch captured at their source. Rollback restores the pre-reducer path.
    @discardableResult
    private func reduceLifecycle(
        _ event: AlmaLiveVoiceLifecycleReducer.Event,
        expectedLifecycleEpoch: Int? = nil
    ) -> AlmaLiveVoiceLifecycleReducer.Transition? {
        guard lifecycleReducerEnabled,
              var reducer = lifecycleReducer,
              let generation = UInt64(exactly: expectedLifecycleEpoch ?? lifecycleBehaviorEpoch)
        else { return nil }
        let transition = reducer.reduce(.init(generation: generation, event: event))
        lifecycleReducer = reducer
        return transition
    }

    private func acceptsLifecycleEffect(
        _ event: AlmaLiveVoiceLifecycleReducer.Event,
        expectedLifecycleEpoch: Int? = nil
    ) -> Bool {
        guard lifecycleReducerEnabled else { return true }
        return reduceLifecycle(
            event,
            expectedLifecycleEpoch: expectedLifecycleEpoch)?.mayApplyEffects == true
    }

    private func lifecycleAllowsMediaRecovery(
        _ transition: AlmaLiveVoiceLifecycleReducer.Transition?
    ) -> Bool {
        guard lifecycleReducerEnabled else { return true }
        return transition?.mayApplyEffects == true
            && transition?.decision.ui.session == .ready
    }

    /// Post-background / post-interruption self-heal: reactivate the session and
    /// clear stuck half-state, so the console NEVER needs an app kill again.
    private func recoverAudio(
        _ why: String,
        expectedLifecycleEpoch: Int? = nil
    ) {
        if let expectedLifecycleEpoch {
            guard AlmaLiveVoiceLifecycleSessionFence.acceptsBehaviorEpoch(
                expectedLifecycleEpoch,
                currentEpoch: lifecycleBehaviorEpoch,
                isClosed: closed) else { return }
        }
        guard !closed else { return }
        if liveActive {
            live.recoverAudio()
            tr("recoverAudio live(\(why))")
            return
        }
        // During connect/failure there is no legacy mode to revive. The bounded
        // Live reconnect loop (or the Retry button) owns recovery truthfully.
        tr("recoverAudio skipped(\(why))")
    }

    private func endFromLifecycleRequest(expectedLifecycleEpoch: Int) {
        guard AlmaLiveVoiceLifecycleSessionFence.acceptsBehaviorEpoch(
            expectedLifecycleEpoch,
            currentEpoch: lifecycleBehaviorEpoch,
            isClosed: closed) else { return }
        end()
    }

    private func handleInterruption(
        began: Bool,
        expectedLifecycleEpoch: Int
    ) {
        guard AlmaLiveVoiceLifecycleSessionFence.acceptsBehaviorEpoch(
            expectedLifecycleEpoch,
            currentEpoch: lifecycleBehaviorEpoch,
            isClosed: closed) else { return }
        let transition = reduceLifecycle(
            began ? .audioInterruptionBegan : .audioInterruptionEnded,
            expectedLifecycleEpoch: expectedLifecycleEpoch)
        if lifecycleReducerEnabled, transition?.mayApplyEffects != true { return }
        if began {
            tr("audio INTERRUPTED")
            keepAlive?.pause()
        } else if lifecycleAllowsMediaRecovery(transition) {
            recoverAudio("interruption-ended")
            keepAlive?.play()
        }
    }

    /// Island orb button (AlmaVoiceListenIntent) — start listening WITHOUT
    /// bringing the app forward; the intent runs in this process in background.
    private func islandListen(expectedLifecycleEpoch: Int? = nil) {
        if let expectedLifecycleEpoch {
            guard AlmaLiveVoiceLifecycleSessionFence.acceptsBehaviorEpoch(
                expectedLifecycleEpoch,
                currentEpoch: lifecycleBehaviorEpoch,
                isClosed: closed) else { return }
        }
        guard !closed else { return }
        if liveActive {
            if state == .speaking { live.interruptPlayback() }
            return
        }
        recoverAudio("islandListen")
        switch state {
        case .speaking: tts.stopAll(); startListening()
        case .idle, .error: startListening()
        default: break
        }
    }

    private func greeting() -> String {
        var cal = Calendar.current
        cal.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        let h = cal.component(.hour, from: Date())
        let word = h >= 5 && h < 12 ? "সুপ্রভাত" : h < 17 ? "শুভ দুপুর" : h < 21 ? "শুভ সন্ধ্যা" : "শুভ রাত্রি"
        return "\(word) Boss — বলুন, কী করতে হবে।"
    }

    /// Pre-synthesize the rotating acknowledgements ("জি বস।"…) for instant playback.
    private func prefetchAcks() async {
        let acks = ["জি Boss।", "আচ্ছা Boss, দেখছি।", "ঠিক আছে Boss।", "জি Boss, এক্ষুনি দেখছি।"]
        for a in acks.shuffled().prefix(2) {
            if let d = try? await AssistantNet.postJSONForData(path: "/api/assistant/tts", body: ["text": a]) {
                ackData.append(d)
            }
        }
    }

    /// DEBUG self-test entry (never fires in production — used only by the local
    /// simctl hook): inject a "transcribed" utterance to exercise the full
    /// thinking → SSE → chunked-TTS → speaking → auto-relisten loop headlessly
    /// (this Mac mini has no microphone, so the mic leg can't be simulated).
    func debugInjectUtterance(_ text: String) {
        transcript = text
        runTurn(text)
    }

    /// Sim-only (launch-arg gated): feed a canned reply through the TTS queue exactly
    /// as SSE deltas would, and log each sentence chunk it produces — proves the
    /// newline-split fix without needing backend auth. Never runs in production.
    func debugTtsChunks(_ reply: String) {
        tts.debugChunkLog(reply)
    }

    /// Sim-only: reproduce the feedback-loop scenario WITHOUT the backend — the agent
    /// starts speaking, then (as the old barge-in mic did) something tries to open the
    /// mic mid-speech. The gate MUST block it. Then silence opens the gate. Pure state
    /// machine, opens no real mic. Watch the ALMA-VOICE trace for BLOCKED then PASS.
    func debugGateTest() {
        tr("GATE-TEST begin")
        state = .thinking
        ttsDidStartFirstChunk()      // agent begins speaking → gate closes
        startListening()             // the old barge fired here → must log BLOCKED now
        startListening()             // twice, to be sure
        ttsDidGoSilent()             // agent finished → gate opens
        tr(ttsActive ? "GATE-TEST FAIL: gate still closed" : "GATE-TEST PASS: gate open after silence")
    }

    /// Attach a photo (chat composer parity) — optimistic thumbnail, uploads to
    /// /api/assistant/upload, becomes a ready AgentFileRef sent with the next turn.
    func attachImage(_ image: UIImage) {
        guard let jpeg = image.jpegData(compressionQuality: 0.85) else { return }
        let item = PendingImage(image: image)
        pendingImages.append(item)
        let fileId = item.id
        Task { [weak self] in
            struct UploadResponse: Decodable { let bucket: String; let path: String; let mediaType: String }
            do {
                let data = try await AssistantNet.uploadMultipart(
                    path: "/api/assistant/upload", fileField: "file",
                    filename: "photo-\(Int(Date().timeIntervalSince1970)).jpg",
                    mime: "image/jpeg", data: jpeg,
                    extraFields: ["conversationId": self?.chatVM?.conversationId ?? "general"])
                let up = try JSONDecoder().decode(UploadResponse.self, from: data)
                await MainActor.run {
                    guard let self, let i = self.pendingImages.firstIndex(where: { $0.id == fileId }) else { return }
                    self.pendingImages[i].state = .ready(.init(bucket: up.bucket, path: up.path, mediaType: up.mediaType))
                }
            } catch {
                await MainActor.run {
                    guard let self, let i = self.pendingImages.firstIndex(where: { $0.id == fileId }) else { return }
                    self.pendingImages[i].state = .failed
                }
            }
        }
    }
    func removeImage(_ id: UUID) { pendingImages.removeAll { $0.id == id } }

    /// Suggestion chips (design dock): run a normal voice turn from a canned prompt.
    func runChip(_ text: String) {
        guard state == .idle || state == .error else { return }
        if liveActive {
            live.sendRealtimeText(text)
            return
        }
        tts.stopAll()
        transcript = text
        runTurn(text)
    }

    // ── Orb tap (web handleTapOrb parity) ──────────────────────────────────

    func tapOrb() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        if liveActive {
            if state == .speaking { live.interruptPlayback() }
            return
        }
        switch state {
        case .listening:
            if streamingActive { streamer.finishNow() }   // commit the utterance
            else { finishListening(force: true) }         // tap again = send now
        case .speaking:
            tts.stopAll()                        // tap = stop reply and talk
            startListening()
        case .idle, .error:
            tts.stopAll()
            startListening()
        case .transcribing, .thinking:
            break
        }
    }

    // ── Listening + calibrated VAD ─────────────────────────────────────────

    func startListening() {
        guard !closed, sessionReady, callConnection != .idle,
              state != .listening, !startingListen else { return }
        // HALF-DUPLEX GATE: never open the mic while the agent is still speaking. If a
        // caller (auto-listen, wake, a stray tap) reaches here mid-TTS, refuse — the
        // owner taps the orb to interrupt (that path stops TTS first, clearing the gate).
        guard !ttsActive else { tr("startListening BLOCKED (ttsActive)"); return }
        tr("startListening ALLOWED")
        startingListen = true
        keepAliveStart()                 // conversation live → survive backgrounding
        wake.stop()                      // free the mic for the STT engine
        tts.stopAll()
        listenGeneration &+= 1
        let generation = listenGeneration
        listenStartTask?.cancel()
        listenStartTask = nil
        streamer.cancel()
        if streamingEnabled {
            // Try TRUE streaming STT first. start() throws on any PRE-audio
            // failure (token mint / socket / mic engine) — those fall back to the
            // proven record-then-transcribe path with NO state changed yet.
            let source = AlmaStreamingSTT()
            source.engine = self
            streamer = source
            listenStartTask = Task { @MainActor [weak self, weak source] in
                guard let self, let source,
                      self.acceptsListenSource(source, generation: generation),
                      self.startingListen
                else { return }
                do {
                    try await source.start()
                    guard !Task.isCancelled,
                          self.acceptsListenSource(source, generation: generation),
                          self.streamingActive
                    else {
                        source.cancel()
                        return
                    }
                } catch is CancellationError {
                    source.cancel()
                } catch {
                    guard self.acceptsListenSource(source, generation: generation),
                          self.startingListen
                    else {
                        source.cancel()
                        return
                    }
                    source.cancel()
                    self.startListeningRecorder(expectedGeneration: generation)
                }
                if self.listenGeneration == generation, self.streamer === source {
                    self.listenStartTask = nil
                }
            }
        } else {
            startListeningRecorder(expectedGeneration: generation)
        }
    }

    private func acceptsListenSource(
        _ source: AlmaStreamingSTT,
        generation: UInt64? = nil
    ) -> Bool {
        guard streamer === source, !closed, sessionReady, callConnection != .idle else {
            return false
        }
        return generation.map { $0 == listenGeneration } ?? true
    }

    /// The proven record → /transcribe path. Unchanged; used when streaming is
    /// off or its setup failed.
    private func startListeningRecorder(expectedGeneration: UInt64) {
        guard expectedGeneration == listenGeneration,
              !closed, sessionReady, callConnection != .idle,
              startingListen, state != .listening else { return }
        streamingActive = false
        do {
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 24_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            ]
            let rec = try AVAudioRecorder(url: recURL, settings: settings)
            rec.isMeteringEnabled = true
            rec.record()
            recorder = rec
            state = .listening
            nowLine = ""; saidLines = []   // fresh listen — stale caption gone
            transcript = ""
            listenSeconds = 0
            playMicChime()
            UISelectionFeedbackGenerator().selectionChanged()
            startingListen = false
            runVAD()
        } catch {
            startingListen = false
            errorToast = "মাইক্রোফোন ব্যবহার করা যাচ্ছে না — orb-এ ট্যাপ করে আবার চেষ্টা করুন।"
            state = .error
        }
    }

    // ── Streaming-STT callbacks (from AlmaStreamingSTT) ────────────────────

    /// Mic + socket are live — enter listening, exactly like the recorder path.
    func streamDidStart(from source: AlmaStreamingSTT) {
        guard acceptsListenSource(source), startingListen else {
            source.cancel()
            return
        }
        streamingActive = true
        startingListen = false
        state = .listening
        nowLine = ""; saidLines = []; transcript = ""
        listenSeconds = 0
        playMicChime()
        UISelectionFeedbackGenerator().selectionChanged()
    }
    func streamSeconds(_ s: Int, from source: AlmaStreamingSTT) {
        guard acceptsListenSource(source), streamingActive else { return }
        listenSeconds = s
    }
    func streamLevel(_ l: Double, from source: AlmaStreamingSTT) {
        guard acceptsListenSource(source), streamingActive else { return }
        micLevel = l
    }
    /// Live interim words — the owner sees his sentence build as he speaks.
    func streamPartial(_ text: String, from source: AlmaStreamingSTT) {
        guard acceptsListenSource(source), streamingActive, state == .listening else { return }
        transcript = text
    }

    @discardableResult
    private func retireStreamingListen(from source: AlmaStreamingSTT) -> UInt64? {
        guard acceptsListenSource(source) else { return nil }
        streamingActive = false
        startingListen = false
        listenStartTask?.cancel(); listenStartTask = nil
        listenGeneration &+= 1
        // Retire the concrete producer as part of the same MainActor transition.
        // The engine instance is reused for later calls; leaving this object as
        // `streamer` would let an already-queued duplicate terminal callback from
        // the old listen authenticate after that reuse.
        streamer = AlmaStreamingSTT()
        return listenGeneration
    }

    func streamNoSpeech(from source: AlmaStreamingSTT) {
        guard retireStreamingListen(from: source) != nil else { return }
        streamingActive = false
        micLevel = 0
        state = .idle
        noSpeechEnded()
    }

    /// A listen window opened but the owner said nothing. In কথোপকথন mode we keep the
    /// conversation ALIVE across a couple of natural pauses — re-arm listening instead
    /// of dead-ending, so the owner can fire question after question hands-free. After
    /// a few empty windows we stop (chime) so the mic isn't held open forever.
    private func noSpeechEnded() {
        guard convoMode, !closed, emptyListens < 2 else {
            emptyListens = 0
            keepAliveStop()              // conversation idle — release the audio hold
            playCloseChime()
            return
        }
        emptyListens += 1
        scheduleAutoListen()
    }
    func streamFinal(_ text: String, from source: AlmaStreamingSTT) {
        guard retireStreamingListen(from: source) != nil else { return }
        micLevel = 0
        state = .transcribing
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        playAck()
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else {
            state = .idle
            errorToast = "শুনতে পাইনি Boss — আরেকবার বলুন।"
            scheduleAutoListen()
            return
        }
        transcript = clean
        runTurn(clean)
    }
    func streamError(_ msg: String, from source: AlmaStreamingSTT) {
        guard retireStreamingListen(from: source) != nil else { return }
        micLevel = 0
        // Mid-listen socket/audio failure: recover to idle + speak (hands-free
        // owner can't read a toast), then keep the conversation loop alive.
        state = .idle
        errorToast = msg
        tts.sayNow("শুনতে পাইনি Boss — আরেকবার বলুন।")
        scheduleAutoListen()
    }

    /// Streaming socket never came up (or died) AFTER the owner spoke — the
    /// mic-first buffer arrives here as a WAV and goes through the proven
    /// /transcribe path, so connection latency can never eat his words.
    func streamFallbackUpload(_ wav: Data, from source: AlmaStreamingSTT) {
        guard let terminalGeneration = retireStreamingListen(from: source) else { return }
        let expectedLifecycleEpoch = lifecycleBehaviorEpoch
        micLevel = 0
        state = .transcribing
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        playAck()
        Task { [weak self] in
            guard let self else { return }
            do {
                let data = try await AssistantNet.uploadMultipart(
                    path: "/api/assistant/transcribe", fileField: "audio",
                    filename: "voice.wav", mime: "audio/wav", data: wav)
                let t = try JSONDecoder().decode(TranscribeResponse.self, from: data)
                guard !Task.isCancelled,
                      !self.closed,
                      self.lifecycleBehaviorEpoch == expectedLifecycleEpoch,
                      self.listenGeneration == terminalGeneration,
                      self.sessionReady,
                      self.callConnection != .idle,
                      self.state == .transcribing
                else { return }
                let text = (t.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else {
                    self.state = .idle
                    self.errorToast = "শুনতে পাইনি Boss — আরেকবার বলুন।"
                    self.scheduleAutoListen()
                    return
                }
                self.transcript = text
                self.runTurn(text)
            } catch {
                guard !Task.isCancelled,
                      !self.closed,
                      self.lifecycleBehaviorEpoch == expectedLifecycleEpoch,
                      self.listenGeneration == terminalGeneration,
                      self.sessionReady,
                      self.callConnection != .idle
                else { return }
                self.state = .error
                self.errorToast = "ট্রান্সক্রিপশন ব্যর্থ।"
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if self.state == .error { self.state = .idle }
            }
        }
    }

    /// The calibrated VAD loop — the core fix for "starts before I speak".
    private func runVAD() {
        vadTask?.cancel()
        vadTask = Task { [weak self] in
            guard let self else { return }
            let tickMs = 33.0
            var elapsed = 0.0
            var noiseFloor = 0.0, floorSamples = 0.0
            var speechThresh = 0.022                 // lowered: owner speech peaked ~0.047, old 0.045 dropped softer speech
            let silenceThresh = 0.014
            var sustainedMs = 0.0                    // continuous speech accumulator
            var spoke = false
            var speechStartAt = 0.0
            var silenceMs = 0.0

            while !Task.isCancelled, let rec = self.recorder, self.state == .listening {
                rec.updateMeters()
                let db = rec.averagePower(forChannel: 0)
                let rms = pow(10.0, Double(db) / 20.0)
                self.micLevel = min(1, rms * 6)
                self.listenSeconds = Int(elapsed / 1000)

                if elapsed < 400 {
                    // Calibration window: learn the room's noise floor, never
                    // treat this window as speech.
                    noiseFloor += rms; floorSamples += 1
                    if elapsed + tickMs >= 400 && floorSamples > 0 {
                        let floor = noiseFloor / floorSamples
                        // Clamp BOTH ends: never below 0.022 (soft speech), never above
                        // 0.06 — else if the owner is already mid-word when the listen
                        // window opens, his voice poisons the floor and the threshold
                        // climbs past his own speech → nothing arms → the turn dies and
                        // conversation "freezes" though he's clearly talking.
                        speechThresh = min(0.06, max(0.022, floor * 2.0))
                    }
                } else if !spoke {
                    if rms > speechThresh {
                        sustainedMs += tickMs
                        if sustainedMs >= 250 {      // must SUSTAIN speech to arm
                            spoke = true
                            speechStartAt = elapsed
                        }
                    } else {
                        sustainedMs = 0
                    }
                    // No-speech abort (web: 8s in convo mode). In কথোপকথন mode this
                    // re-arms for a couple of pauses instead of dead-ending the loop.
                    if elapsed > 8_000 {
                        self.cancelListening(playChime: false)
                        self.noSpeechEnded()
                        return
                    }
                } else {
                    if rms < silenceThresh {
                        silenceMs += tickMs
                        let span = elapsed - speechStartAt
                        let window = span < 3_000 ? 1_400.0 : 2_600.0   // web adaptive window
                        if silenceMs >= window {
                            self.finishListening(force: false)
                            return
                        }
                    } else if rms > speechThresh {
                        silenceMs = 0
                    }
                }
                if elapsed > 180_000 {               // web hard cap
                    self.finishListening(force: false)
                    return
                }
                elapsed += tickMs
                try? await Task.sleep(nanoseconds: UInt64(tickMs * 1_000_000))
            }
        }
    }

    private func cancelListening(playChime: Bool) {
        vadTask?.cancel()
        recorder?.stop(); recorder = nil
        micLevel = 0
        state = .idle
        if playChime { playCloseChime() }
    }

    private func finishListening(force: Bool) {
        vadTask?.cancel()
        recorder?.stop(); recorder = nil
        micLevel = 0
        state = .transcribing
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        playAck()                                    // instant "জি বস।"
        Task { [weak self] in
            guard let self else { return }
            guard let audio = try? Data(contentsOf: self.recURL), audio.count > 3_000 else {
                self.state = .idle
                if !force { self.errorToast = "অডিও খুব ছোট — আবার বলুন।" }
                return
            }
            do {
                let data = try await AssistantNet.uploadMultipart(
                    path: "/api/assistant/transcribe", fileField: "audio",
                    filename: "voice.m4a", mime: "audio/mp4", data: audio)
                let t = try JSONDecoder().decode(TranscribeResponse.self, from: data)
                let text = (t.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else {
                    self.state = .idle
                    self.errorToast = "শুনতে পাইনি Boss — আরেকবার বলুন।"
                    self.scheduleAutoListen()
                    return
                }
                self.transcript = text
                self.runTurn(text)
            } catch {
                // A transient upload/transcribe failure must NOT dead-end on a scary
                // error orb — recover to idle and (in convo mode) re-listen so the
                // owner just speaks again. Speak the retry so a hands-free owner hears it.
                self.state = .idle
                self.errorToast = "একটু গোলমাল হলো Boss — আরেকবার বলুন।"
                self.tts.sayNow("শুনতে একটু সমস্যা হলো Boss, আরেকবার বলুন।")
                self.scheduleAutoListen()
            }
        }
    }

    // ── Turn (chat voice:true → chunked TTS) ───────────────────────────────

    /// A voice-turn body. The shared AssistantVM.ChatBody has no `resume` field
    /// (frozen file) and the model-switch approval needs to re-run the SAME turn
    /// with resume{approve}, so the voice console encodes its own body here.
    private struct VoiceChatBody: Encodable {
        let conversationId: String?
        let message: String
        let modelId: String?
        let voice: Bool
        let files: [AgentFileRef]
        let resume: Resume?
        struct Resume: Encodable { let approve: Bool }
        /// Server-claimed continuation of a deadline-cut turn (chat parity) —
        /// no new owner message; consumes the predecessor's continuation flag.
        var autoContinueFromTurnId: String? = nil
    }

    private func runTurn(_ text: String, resume: Bool = false) {
        emptyListens = 0                 // real turn — reset the silent-window counter
        if !resume, !lastUserText.isEmpty { lastQ = lastUserText; lastA = replyText }
        lastUserText = text
        state = .thinking
        replyText = ""
        saidLines = []; nowLine = ""
        cards.removeAll { $0.kind == .tool }
        narratedFirstTool = false
        verificationSaid = false
        lastAudioAt = Date()
        lastEventAt = Date()
        tts.beginTurn()
        startHeartbeat()

        let files = resume ? [] : readyImageFiles
        let body = VoiceChatBody(conversationId: chatVM?.conversationId,
                                 message: text,
                                 modelId: chatVM?.modelId ?? "auto",
                                 voice: true,
                                 files: files,
                                 resume: resume ? .init(approve: true) : nil)
        if !resume { pendingImages.removeAll() }
        turnTask?.cancel()
        turnTask = Task { [weak self] in
            guard let self else { return }
            defer { self.heartbeatTask?.cancel() }
            do {
                await AlmaAPI.shared.syncCookies()
                var req = URLRequest(url: AssistantNet.base.appendingPathComponent("/api/assistant/chat"))
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = try JSONEncoder().encode(body)
                try await AssistantNet.streamEvents(request: req) { [weak self] ev in
                    self?.handle(ev)
                }
                self.tts.finishFeed()
            } catch is CancellationError {
            } catch {
                self.tts.sayNow("দুঃখিত Boss, একটা সমস্যা হয়েছে — একটু পরে আরেকবার বলুন।")
                self.errorToast = "উত্তর পেতে ব্যর্থ"
                self.tts.finishFeed()
            }
        }
    }

    private func handle(_ ev: AgentSSEEvent, speak: Bool = true) {
        lastEventAt = Date()   // stall watchdog: any event keeps the turn alive
        switch ev.type {
        case "conversation_id":
            if let id = ev.id { chatVM?.conversationId = id }
        case "turn_id":
            if let id = ev.id { liveTurnId = id }
        case "text_delta":
            replyText += ev.delta ?? ""
            if speak { tts.feed(ev.delta ?? "") }
        case "tool_start":
            // Humanise the raw tool id for the step chip (get_pending_approvals →
            // "Get Pending Approvals") — never show snake_case to the owner.
            let raw = ev.name ?? "টুল"
            let label = raw.contains("_")
                ? raw.replacingOccurrences(of: "_", with: " ").capitalized
                : raw
            cards.append(.init(id: ev.id ?? UUID().uuidString, kind: .tool, icon: "🔧",
                               title: label, sub: "", status: "run"))
            // Speak a friendly, GENERIC "working on it" once per turn — never the raw
            // tool name (owner heard "get_pending_approvals, বস" spoken aloud).
            if !narratedFirstTool {
                narratedFirstTool = true
                lastToolNarration = Date()
                if speak { tts.sayNow("একটু দেখে নিচ্ছি, Boss…") }
            }
        case "tool_end":
            if let i = cards.firstIndex(where: { $0.id == ev.id }) {
                cards[i].status = ev.success == false ? "fail" : "ok"
                cards[i].sub = String((ev.resultPreview ?? "").prefix(80))
            }
        case "ask_card":
            if let aid = ev.askCardId {
                let q = ev.question ?? ""
                let opts = ev.options ?? []
                cards.append(.init(id: aid, kind: .ask, icon: "❓", title: q, sub: "",
                                   status: "wait", options: opts, askCardId: aid))
                if speak {
                    tts.sayNow(q)
                    if !opts.isEmpty { tts.sayNow("\(opts.joined(separator: ", নাকি ")) — কোনটা, Boss?") }
                }
            }
        case "confirm_card":
            if let pid = ev.pendingActionId {
                cards.append(.init(id: pid, kind: .approval, icon: "🛡️",
                                   title: "আপনার অনুমোদন দরকার",
                                   sub: ev.summary ?? "", status: "wait", pendingActionId: pid))
                if speak { tts.sayNow("Boss, একটা অনুমোদন দরকার — \(String((ev.summary ?? "").prefix(120)))") }
            }
        case "verification_retry":
            // The head is self-correcting — in voice this reads as a hang unless
            // spoken (web parity). Once per turn.
            if !verificationSaid {
                verificationSaid = true
                lastAudioAt = Date()
                if speak { tts.sayNow("একটু যাচাই করে ঠিক করে নিচ্ছি, Boss…") }
            }
        case "model_switch_required":
            // A premium head needs the owner's OK. Spoken + a tappable card;
            // approve re-runs the same turn with resume{approve}.
            cards.append(.init(id: "modelswitch-\(cards.count)", kind: .modelSwitch,
                               icon: "🧠", title: "শক্তিশালী মডেলের অনুমতি দরকার",
                               sub: "", status: "wait"))
            lastAudioAt = Date()
            if speak { tts.sayNow("এটার জন্য আরও শক্তিশালী মডেল দরকার, Boss — অনুমতি দিলে এগিয়ে যাই।") }
        case "done":
            lastDoneNeedContinue = ev.needContinue ?? false
        case "error":
            if speak { tts.sayNow("দুঃখিত Boss, একটা সমস্যা হয়েছে — একটু পরে আরেকবার বলুন।") }
        default:
            break
        }
    }

    // ── Persistent Gemini Live callbacks + existing head-agent bridge ─────

    func liveDidConnect() {
        liveConnectTask?.cancel()
        liveConnectTask = nil
        let profilePhase = liveProfileTransaction.phase
        guard liveProfileTransaction.connected(currentConnectionProfile) else {
            live.stop()
            return
        }
        _ = reduceLifecycle(.providerReconnected)
        switch profilePhase {
        case .applying:
            liveProfileStatusText = "যাচাই সফল—নতুন profile এই কলে সক্রিয়।"
            feedStatus("নতুন মডেল ও কণ্ঠ সক্রিয় হয়েছে।")
        case .rollingBack:
            liveProfileStatusText = "নতুন profile চালু হয়নি; আগের সক্রিয় profile ফিরেছে।"
            feedStatus("আগের মডেল ও কণ্ঠ নিরাপদে ফিরিয়ে আনা হয়েছে।")
        case .idle:
            break
        }
        if !liveActive && liveFeed.isEmpty { feedUserLineId = nil; feedAgentLineId = nil }
        liveActive = true
        sessionReady = true
        callConnection = .live
        connectionFailureText = ""
        errorToast = nil
        hasEverConnected = true
        liveConnectAttempt = 0
        if callStartedAt == nil { callStartedAt = Date() }
        live.setInputMuted(isMuted)
        try? live.setSpeakerEnabled(speakerOn)
        wake.stop()
        state = liveToolTurnPending ? .thinking : .listening
        keepAliveStart()
        // Agent call route diagnostics. Do not force a CallKit-managed receiver
        // back to speaker: receiver-first is intentional and leaves the locked
        // system Speaker button in control of the route.
        if let callId = activeAgentCallId {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                guard let self, self.liveActive else { return }
                let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
                    .map { $0.portType.rawValue }.joined(separator: "+")
                if self.speakerOn && outputs.contains("Receiver") {
                    self.live.nudgeSpeakerRoute()
                    if #available(iOS 17.0, *) {
                        Task { await CallKitVoIP.postAgentCallStatus(callId, status: nil,
                                                                     note: "route was \(outputs) 2s after connect — nudged to speaker") }
                    }
                }
            }
        }
        if let brief = pendingAgentCallBrief, !agentBriefSent {
            pendingAgentCallBrief = nil
            agentBriefSent = true
            sendAgentBriefNote(brief.isEmpty ? "Boss-এর সাথে জরুরি কথা আছে" : brief)
        }
    }

    /// Reflect the hardware route, not merely the last button request.  This is
    /// what makes the speaker button truthful when iOS selects a receiver,
    /// Bluetooth HFP device, wired headset, or built-in speaker asynchronously.
    func liveAudioRouteChanged(speaker: Bool, receiver: Bool) {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portType)
        let routeEvent: AlmaLiveVoiceLifecycleReducer.Event
        if outputs.isEmpty {
            routeEvent = .routeLost
        } else if outputs.contains(.builtInSpeaker) {
            routeEvent = .routeChanged(.builtInSpeaker)
        } else if outputs.contains(.builtInReceiver) {
            routeEvent = .routeChanged(.builtInReceiver)
        } else if outputs.contains(.bluetoothHFP)
                    || outputs.contains(.bluetoothA2DP)
                    || outputs.contains(.bluetoothLE) {
            routeEvent = .routeChanged(.bluetooth)
        } else if outputs.contains(.headphones)
                    || outputs.contains(.headsetMic)
                    || outputs.contains(.usbAudio) {
            routeEvent = .routeChanged(.wired)
        } else if outputs.contains(.airPlay) {
            routeEvent = .routeChanged(.airPlay)
        } else if outputs.contains(.carAudio) {
            routeEvent = .routeChanged(.carAudio)
        } else {
            routeEvent = .routeChanged(.otherUsable)
        }
        _ = reduceLifecycle(routeEvent)
        speakerOn = speaker
        UIDevice.current.isProximityMonitoringEnabled = callConnection == .live && receiver
    }

    func liveWillReconnect() {
        guard !closed else { return }
        _ = reduceLifecycle(.providerDisconnected)
        liveActive = false
        sessionReady = false
        callConnection = .reconnecting
        state = liveToolTurnPending ? .thinking : .idle
    }

    #if DEBUG
    private var debugQueuedUserTurns: [String] = []

    /// Simulator-only conversation harness: inject a typed sentence as if Boss
    /// spoke it — exercises the full Gemini turn (direct answer vs run_agent_turn,
    /// audio, transcripts, nudges) without a microphone.
    func debugInjectUserTurn(_ text: String) {
        guard liveActive else { return }
        lastUserTurnAt = Date()
        ackNudgesThisUserTurn = 0
        lastUserText = text
        _ = feedUpsert(id: nil, kind: .user, text: text)
        feedFinalizeUser()
        live.sendRealtimeText(text)
    }

    /// Deterministic Simulator regression harness. Wait for the real Live socket
    /// and audio graph, then inject one typed user turn. This exercises Gemini
    /// audio generation, transcripts, player draining and echo/barge-in logic;
    /// only the microphone-originating prompt is replaced. DEBUG never ships in
    /// TestFlight/Release.
    func debugInjectUserTurnWhenReady(_ text: String, attemptsLeft: Int = 24) {
        guard attemptsLeft > 0 else {
            NSLog("ALMA-VOICE debug live injection timed out")
            return
        }
        if liveActive {
            NSLog("ALMA-VOICE debug live injection sent")
            debugInjectUserTurn(text)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.debugInjectUserTurnWhenReady(text, attemptsLeft: attemptsLeft - 1)
        }
    }

    /// Run multiple deterministic prompts through one real Live session. This
    /// catches second-turn regressions that a fresh call cannot expose (stale
    /// transcript state, undrained PCM, or a mic gate that never rearms).
    func debugInjectUserTurnsWhenReady(_ turns: [String]) {
        let normalized = turns.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard let first = normalized.first else { return }
        debugQueuedUserTurns = Array(normalized.dropFirst())
        debugInjectUserTurnWhenReady(first)
    }

    private func debugInjectNextQueuedTurnAfterPlayback(attemptsLeft: Int = 20) {
        guard !debugQueuedUserTurns.isEmpty else { return }
        guard attemptsLeft > 0 else {
            NSLog("ALMA-VOICE debug queued injection timed out")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, self.liveActive else { return }
            guard self.state == .listening else {
                self.debugInjectNextQueuedTurnAfterPlayback(attemptsLeft: attemptsLeft - 1)
                return
            }
            let next = self.debugQueuedUserTurns.removeFirst()
            NSLog("ALMA-VOICE debug queued injection sent remaining=%d",
                  self.debugQueuedUserTurns.count)
            self.debugInjectUserTurn(next)
        }
    }
    #endif

    func liveInputTranscript(_ text: String) {
        applyLiveInputTranscript(text, replacingAggregate: false, finalized: false)
    }

    func liveInputTranscriptSnapshot(_ text: String, finalized: Bool) {
        applyLiveInputTranscript(text, replacingAggregate: true, finalized: finalized)
    }

    private func applyLiveInputTranscript(
        _ text: String,
        replacingAggregate: Bool,
        finalized: Bool
    ) {
        // Gemini sends input transcription as incremental fragments — build the
        // full sentence for the live feed line (and the legacy MIC strip).
        lastUserTurnAt = Date()
        ackNudgesThisUserTurn = 0
        if let id = feedUserLineId, let i = liveFeed.firstIndex(where: { $0.id == id }) {
            let joined = replacingAggregate ? text : (liveFeed[i].text + text)
            transcript = joined
            feedUserLineId = feedUpsert(id: id, kind: .user, text: joined)
        } else {
            transcript = text
            feedUserLineId = feedUpsert(id: nil, kind: .user, text: text)
        }
        // DETERMINISTIC hang-up (owner bug 2026-07-30, sim-reproduced even with
        // the end_call tool present: Gemini says "আল্লাহ হাফেজ" but skips the
        // tool). If Boss's own words ask to hang up, the call ends after the
        // model's goodbye finishes — model cooperation not required.
        if Self.hangupContext(in: transcript) { lastHangupContextAt = Date() }
        if Self.hangupIntent(in: transcript) {
            #if DEBUG
            NSLog("ALMA-VOICE hang-up intent heard in input transcript")
            #endif
            scheduleModelRequestedEnd(hardFallback: 20)
        }
        if state != .speaking { state = .listening }
        if finalized { feedFinalizeUser() }
    }

    /// BROAD corroboration signal (weaker than hangupIntent): any word family a
    /// genuine hang-up sentence would contain. The model's end_call is honored
    /// only when Boss said something like this within the last 25 s. Memory
    /// instructions ("এই কথাটা মনে রেখে দাও") are explicitly excluded (Codex P1
    /// round 7): a রাখ-family word preceded by মনে/নোট/সেভ is about REMEMBERING,
    /// not hanging up.
    static func hangupContext(in text: String) -> Bool {
        let t = text.lowercased()
        if t.contains("মনে রেখ") || t.contains("মনে রাখ") || t.contains("নোট") || t.contains("সেভ") || t.contains("মেমরি") {
            return false
        }
        return t.contains("রাখ") || t.contains("রেখে") || t.contains("কাট") || t.contains("হাফেজ")
            || t.contains("বিদায়") || t.contains("bye") || t.contains("hang up") || t.contains("শেষ কর")
    }

    private var lastHangupContextAt = Date.distantPast

    /// end_call arrived from the model — approve only with recent corroboration
    /// from Boss's own transcript, else refuse (spurious-trigger guard).
    func approveModelRequestedEnd() -> Bool {
        guard Date().timeIntervalSince(lastHangupContextAt) < 25 else { return false }
        scheduleModelRequestedEnd()
        return true
    }

    /// Boss's spoken request to end the call. Deliberately narrow (Codex P1
    /// round 5: "এই কথাটা মনে রেখে দাও" is a MEMORY instruction, not a
    /// hang-up): bare "রেখে দাও/রাখো" counts only as a short standalone closing
    /// utterance; longer sentences need explicit call/phone context or a
    /// salutation formula.
    static func hangupIntent(in text: String) -> Bool {
        let t = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        // Closing salutations.
        if t.contains("আল্লাহ হাফেজ") || t.contains("আল্লাহহাফেজ") || t.contains("খোদা হাফেজ") { return true }
        // Explicit call/phone context.
        if t.contains("ফোন রাখ") || t.contains("ফোন রেখে") || t.contains("ফোনটা রাখ") { return true }
        if t.contains("কল রাখ") || t.contains("কল রেখে") || t.contains("কল কাট") || t.contains("ফোন কাট") || t.contains("কলটা কাট") { return true }
        if t.contains("hang up") { return true }
        // Standalone closings.
        if t.contains("এখন রাখি") || t.contains("আচ্ছা রাখি") || t.contains("তাহলে রাখি") || t.contains("রাখি তাহলে") { return true }
        if t.count <= 12, t.contains("রেখে দাও") || t.contains("রেখে দেন") || t == "রাখো" || t == "রাখেন" || t == "রাখি" { return true }
        return false
    }

    func liveOutputTranscript(_ text: String) {
        replyText = text
        nowLine = text
        feedAgentLineId = feedUpsert(id: feedAgentLineId, kind: .agent, text: text)
    }

    func livePlaybackChanged(active: Bool, level: Double) {
        live.setToolResponsePlaybackBlocked(active)
        ttsLevel = level
        if active {
            state = .speaking
            feedFinalizeUser()          // Boss's sentence is done once ALMA starts answering
        } else {
            // Model asked to hang up (end_call): the goodbye just finished
            // playing — actually end the call now (owner bug 2026-07-30:
            // "আল্লাহ হাফেজ বলার পরও রাখে না").
            if modelEndPending {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                    self?.performModelRequestedEnd()
                }
            }
            feedFinalizeAgent()         // agent turn ended — next reply is a new line
            liveToolTurnPending = activeLiveToolInvocation != nil || live.hasOutstandingToolCalls
            if liveActive { state = liveToolTurnPending ? .thinking : .listening }
            #if DEBUG
            debugInjectNextQueuedTurnAfterPlayback()
            #endif
        }
    }

    private var lastToolCallAt = Date.distantPast
    private var lastUserTurnAt = Date.distantPast
    private var ackNudgesThisUserTurn = 0

    private func deliverLiveToolResult(
        callId: String,
        functionName: String,
        text: String
    ) {
        guard let activeLiveToolInvocation,
              activeLiveToolInvocation.callID == callId,
              activeLiveToolInvocation.functionName == functionName else { return }
        let delivered: Bool
        if live.usesToolOrchestration {
            delivered = live.completeToolCall(
                callID: callId,
                functionName: functionName,
                result: text)
        } else {
            live.sendToolResponse(callId: callId, result: text, name: functionName)
            delivered = true
        }
        guard delivered else { return }
        _ = reduceLifecycle(.toolCompleted(id: callId))
        self.activeLiveToolInvocation = nil
        liveToolTurnPending = false
        liveStatusNudgeTask?.cancel()
        if state == .thinking { state = .listening }
    }

    func liveWasInterrupted() {
        ttsLevel = 0
        nowLine = ""
        // NOTE: deliberately NOT clearing liveToolTurnPending — an interruption
        // only stops the AUDIO, the head/tool turn keeps running. Clearing it here
        // Gemini reports "interrupted" for any new user-role content, but that
        // only stops audio; accepted backend work continues under its call ID.
        feedFinalizeAgent()
        state = liveToolTurnPending ? .thinking : .listening
    }

    /// Model called end_call (Boss asked to hang up): end the call for real once
    /// the goodbye finishes playing. Fallbacks cover a goodbye that never
    /// arrives (2.5s if nothing is playing, 8s hard) so the call can never
    /// hang half-alive.
    private var modelEndPending = false

    func scheduleModelRequestedEnd(hardFallback: TimeInterval = 8) {
        guard !modelEndPending, !closed else { return }
        modelEndPending = true
        // The hard deadline is a GUARANTEE (Codex P2 round 6): it forces the
        // end even mid-tool, so a stalled head turn can never hold the call
        // open forever after Boss asked to hang up.
        DispatchQueue.main.asyncAfter(deadline: .now() + hardFallback) { [weak self] in
            self?.performModelRequestedEnd(force: true)
        }
        if state != .speaking, hardFallback <= 8 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
                guard let self, self.modelEndPending, self.state != .speaking else { return }
                self.performModelRequestedEnd()
            }
        }
    }

    private func performModelRequestedEnd(force: Bool = false) {
        guard modelEndPending, !closed else { return }
        // Mid-tool (e.g. "পড়েছি, রাখো" → mark_salah still running): let the tool
        // reply first; the next playback-finish ends it, and the hard-deadline
        // path arrives with force to guarantee termination regardless.
        if liveToolTurnPending, !force { return }
        modelEndPending = false
        // Agent call: go through the controller so its window tears down too
        // (on-device the engine end also closes the CallKit call → 'completed').
        if #available(iOS 17.0, *), AgentCallController.shared.isActive,
           AgentCallController.shared.engine === self {
            AgentCallController.shared.endFromUI()
        } else {
            end()
        }
    }

    func liveDidFail(_ message: String) {
        guard !closed else { return }
        liveConnectionFailed(error: nil, message: message)
    }

    func handleLiveToolInvocation(_ invocation: AlmaLiveVoiceToolInvocation) {
        switch invocation.payload {
        case .quickLookup(let tool):
            runQuickLookup(tool: tool, callId: invocation.callID)
        case .runAgentTurn(let request):
            runLiveAgentTurn(request: request, callId: invocation.callID)
        case .endCall:
            guard beginLiveToolInvocation(invocation) else { return }
            let result = approveModelRequestedEnd()
                ? "ঠিক আছে — বিদায় বলা শেষ হলেই কল কেটে যাবে।"
                : "Boss কল শেষ করতে বলেননি — কল কাটা হয়নি, স্বাভাবিকভাবে কথা চালিয়ে যাও।"
            deliverLiveToolResult(
                callId: invocation.callID,
                functionName: invocation.functionName,
                text: result)
        case .malformed:
            guard beginLiveToolInvocation(invocation) else { return }
            deliverLiveToolResult(
                callId: invocation.callID,
                functionName: invocation.functionName,
                text: "Tool arguments সঠিক ছিল না; Boss-কে আবার বলতে অনুরোধ করুন।")
        case .unsupported:
            guard beginLiveToolInvocation(invocation) else { return }
            deliverLiveToolResult(
                callId: invocation.callID,
                functionName: invocation.functionName,
                text: "এই function এই client সমর্থন করে না।")
        }
    }

    func cancelLiveToolInvocation(_ invocation: AlmaLiveVoiceToolInvocation) {
        guard activeLiveToolInvocation?.callID == invocation.callID,
              activeLiveToolInvocation?.functionName == invocation.functionName else { return }
        quickLookupTask?.cancel(); quickLookupTask = nil
        turnTask?.cancel(); turnTask = nil
        livePollTask?.cancel(); livePollTask = nil
        liveStatusNudgeTask?.cancel(); liveStatusNudgeTask = nil
        _ = reduceLifecycle(.toolCompleted(id: invocation.callID))
        activeLiveToolInvocation = nil
        liveToolTurnPending = false
        if state == .thinking { state = liveActive ? .listening : .idle }
    }

    private func beginLiveToolInvocation(_ invocation: AlmaLiveVoiceToolInvocation) -> Bool {
        guard activeLiveToolInvocation == nil else {
            if !live.usesToolOrchestration {
                live.sendToolResponse(
                    callId: invocation.callID,
                    result: "আগের কাজটি এখনো চলছে; নতুন করে কিছু শুরু করা হয়নি।",
                    name: invocation.functionName)
            }
            return false
        }
        guard acceptsLifecycleEffect(.toolPending(id: invocation.callID)) else { return false }
        activeLiveToolInvocation = invocation
        liveToolTurnPending = true
        state = .thinking
        return true
    }

    private func isActiveLiveTool(callID: String, functionName: String) -> Bool {
        activeLiveToolInvocation?.callID == callID
            && activeLiveToolInvocation?.functionName == functionName
    }

    /// FAST LANE (owner spec 2026-07-23): simple read-only lookups skip the head
    /// entirely — one whitelisted ERP tool over /api/assistant/voice-tool, answer
    /// in seconds. Actions/memory/complex work still cross the head route.
    func runQuickLookup(tool: String, callId: String) {
        let invocation = AlmaLiveVoiceToolInvocation(
            callID: callId,
            functionName: AlmaLiveVoiceToolName.quickLookup.rawValue,
            payload: tool.isEmpty ? .malformed : .quickLookup(tool: tool))
        guard beginLiveToolInvocation(invocation) else { return }
        guard !tool.isEmpty else {
            deliverLiveToolResult(
                callId: callId,
                functionName: invocation.functionName,
                text: "Tool arguments সঠিক ছিল না; Boss-কে আবার বলতে অনুরোধ করুন।")
            return
        }
        let started = Date()
        lastToolCallAt = started
        feedStatus("তথ্য দেখা হচ্ছে…")
        state = .thinking
        quickLookupTask?.cancel()
        quickLookupTask = Task { [weak self] in
            guard let self else { return }
            do {
                await AlmaAPI.shared.syncCookies()
                struct QuickResp: Decodable { let ok: Bool?; let ms: Int?; let result: String?; let error: String? }
                let resp: QuickResp = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/voice-tool",
                    body: ["tool": tool, "business_id": "ALMA_LIFESTYLE"])
                #if DEBUG
                NSLog("ALMA-VOICE quick lookup %@ done clientMs=%d serverMs=%d ok=%d",
                      tool, Int(Date().timeIntervalSince(started) * 1000), resp.ms ?? -1, (resp.ok ?? false) ? 1 : 0)
                #endif
                if resp.ok == true, let payload = resp.result {
                    self.deliverLiveToolResult(
                        callId: callId,
                        functionName: invocation.functionName,
                        text: "তথ্য (JSON): \(payload)। এখান থেকে Boss-এর প্রশ্নের উত্তরটুকু সংক্ষেপে স্বাভাবিক বাংলায় বলুন।")
                } else {
                    self.deliverLiveToolResult(
                        callId: callId,
                        functionName: invocation.functionName,
                        text: "তথ্যটা এখন আনা গেল না (\(resp.error ?? "unknown"))। Boss-কে ছোট করে জানান, দরকার হলে run_agent_turn দিয়ে চেষ্টা করুন।")
                }
            } catch is CancellationError {
                return
            } catch {
                self.deliverLiveToolResult(
                    callId: callId,
                    functionName: invocation.functionName,
                    text: "তথ্যটা এখন আনা গেল না। Boss-কে ছোট করে জানান।")
            }
        }
    }

    /// Gemini Live is the low-latency ears/voice only. Every meaningful owner turn
    /// still crosses the existing head route, preserving memory, tools, approvals,
    /// claim verification, and the durable call workflow.
    func runLiveAgentTurn(request: String, callId: String) {
        let clean = request.trimmingCharacters(in: .whitespacesAndNewlines)
        let invocation = AlmaLiveVoiceToolInvocation(
            callID: callId,
            functionName: AlmaLiveVoiceToolName.runAgentTurn.rawValue,
            payload: clean.isEmpty ? .malformed : .runAgentTurn(request: request))
        guard beginLiveToolInvocation(invocation) else { return }
        lastToolCallAt = Date()
        guard !clean.isEmpty else {
            deliverLiveToolResult(
                callId: callId,
                functionName: invocation.functionName,
                text: "Boss-এর বক্তব্য খালি ছিল; আবার বলতে অনুরোধ করুন।")
            return
        }
        emptyListens = 0
        transcript = clean
        lastUserText = clean
        replyText = ""
        cards.removeAll { $0.kind == .tool }
        state = .thinking
        // Feed: lock Boss's final sentence in place; Gemini's STT is authoritative.
        // The streaming line may ALREADY be finalized (ack playback started before
        // the toolCall arrived) — update the last user line instead of adding a
        // duplicate row.
        if let id = feedUserLineId {
            _ = feedUpsert(id: id, kind: .user, text: clean)
        } else if let i = liveFeed.lastIndex(where: { $0.kind == .user }) {
            liveFeed[i].text = clean
        } else {
            _ = feedUpsert(id: nil, kind: .user, text: clean)
        }
        feedFinalizeUser()
        feedFinalizeAgent()
        liveStatusNudgeTask?.cancel()
        let started = Date()
        liveStatusNudgeTask = nil
        let body = VoiceChatBody(conversationId: chatVM?.conversationId,
                                 message: clean,
                                 modelId: chatVM?.modelId ?? "auto",
                                 voice: true,
                                 files: readyImageFiles,
                                 resume: nil)
        pendingImages.removeAll()
        liveTurnId = nil
        lastDoneNeedContinue = false
        liveContinueBudget = 3
        turnTask?.cancel()
        turnTask = Task { [weak self] in
            guard let self else { return }
            do {
                await AlmaAPI.shared.syncCookies()
                var req = URLRequest(url: AssistantNet.base.appendingPathComponent("/api/assistant/chat"))
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = try JSONEncoder().encode(body)
                try await AssistantNet.streamEvents(request: req,
                                                    stopOn: { $0.type == "done" || $0.type == "error" }) { [weak self] ev in
                    #if DEBUG
                    NSLog("ALMA-VOICE sse %@", ev.type)
                    #endif
                    self?.handle(ev, speak: false)
                }
                // Deadline-cut turn (chat parity): the head asks for a machine
                // continuation instead of finishing — chat auto-continues, so
                // voice must too, else Boss gets HALF an answer for a hard task.
                var continues = 0
                while self.lastDoneNeedContinue, continues < 3,
                      self.isActiveLiveTool(
                        callID: callId,
                        functionName: invocation.functionName),
                      let fromTurn = self.liveTurnId {
                    continues += 1
                    self.lastDoneNeedContinue = false
                    #if DEBUG
                    NSLog("ALMA-VOICE turn needs continuation %d (from %@)", continues, fromTurn)
                    #endif
                    self.liveTurnId = nil
                    var contBody = body
                    contBody.autoContinueFromTurnId = fromTurn
                    var contReq = URLRequest(url: AssistantNet.base.appendingPathComponent("/api/assistant/chat"))
                    contReq.httpMethod = "POST"
                    contReq.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    contReq.httpBody = try JSONEncoder().encode(contBody)
                    try await AssistantNet.streamEvents(request: contReq,
                                                        stopOn: { $0.type == "done" || $0.type == "error" }) { [weak self] ev in
                        self?.handle(ev, speak: false)
                    }
                }
                #if DEBUG
                NSLog("ALMA-VOICE head turn stream ended; reply chars=%d", self.replyText.count)
                // Poller-path test harness: pretend the stream died right at the
                // finish line — the DB poller MUST deliver the answer instead.
                if ProcessInfo.processInfo.environment["ALMA_VOICE_KILL_SSE"] == "1"
                    || ProcessInfo.processInfo.arguments.contains("ALMA_VOICE_KILL_SSE=1") {
                    NSLog("ALMA-VOICE TEST killSSE — suppressing SSE completion")
                    return
                }
                #endif
                guard self.isActiveLiveTool(
                    callID: callId,
                    functionName: invocation.functionName) else { return }
                let result = self.replyText.trimmingCharacters(in: .whitespacesAndNewlines)
                self.deliverLiveToolResult(
                    callId: callId,
                    functionName: invocation.functionName,
                    text: result.isEmpty ? "Head agent কোনো কথ্য উত্তর দেয়নি। স্ক্রিনের approval বা প্রশ্নের card দেখুন।" : result
                )
                self.livePollTask?.cancel()
            } catch is CancellationError {
                // Provider cancellation and a competing poller both suppress
                // late results. The ledger is the only response authority.
                self.livePollTask?.cancel()
                return
            } catch {
                // Stream transport died. Do NOT give up: the turn keeps running
                // server-side and the DB poller below fetches its result. pending
                // stays SET; the 120s stall watchdog remains the last net.
                #if DEBUG
                NSLog("ALMA-VOICE head turn stream FAILED (%@) — poller keeps waiting", String(describing: error))
                #endif
            }
        }
        // DB-backed completion poller: catches the answer within ~4s of the turn
        // finishing even when the SSE connection is silently dead (owner device
        // 2026-07-24: reply visible in chat, voice waited the full watchdog).
        livePollTask?.cancel()
        livePollTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            while let self, !Task.isCancelled,
                  self.isActiveLiveTool(
                    callID: callId,
                    functionName: invocation.functionName) {
                if let outcome = await self.pollHeadTurnOutcome(requestStart: started) {
                    guard self.isActiveLiveTool(
                        callID: callId,
                        functionName: invocation.functionName),
                          !Task.isCancelled else { return }
                    self.liveStatusNudgeTask?.cancel()
                    #if DEBUG
                    NSLog("ALMA-VOICE poller delivered turn outcome (%d chars)", outcome.count)
                    #endif
                    self.replyText = outcome
                    self.lastEventAt = Date()
                    self.deliverLiveToolResult(
                        callId: callId,
                        functionName: invocation.functionName,
                        text: outcome)
                    self.turnTask?.cancel()
                    return
                }
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    /// One poll round: DB turn status for the live conversation. Returns the
    /// spoken-result payload once OUR turn reached a terminal state, else nil.
    private func pollHeadTurnOutcome(requestStart: Date) async -> String? {
        guard let convId = chatVM?.conversationId, !convId.isEmpty else {
            #if DEBUG
            NSLog("ALMA-VOICE poll: no conversationId yet")
            #endif
            return nil
        }
        struct StatusResp: Decodable {
            let status: String?
            let turnId: String?
            let assistantMessageId: String?
            let startedAt: String?
            let continuationNeeded: Bool?
        }
        let st: StatusResp
        do {
            st = try await AlmaAPI.shared.send(
                "GET", "/api/assistant/conversations/\(convId)/turn-status")
        } catch {
            #if DEBUG
            NSLog("ALMA-VOICE poll: turn-status FAILED %@", String(describing: error))
            #endif
            return nil
        }
        #if DEBUG
        NSLog("ALMA-VOICE poll: status=%@ turn=%@ ourTurn=%@ msg=%@",
              st.status ?? "nil", st.turnId ?? "nil", liveTurnId ?? "nil",
              st.assistantMessageId ?? "nil")
        #endif
        guard let status = st.status, status != "running", status != "idle" else {
            // The turn is alive server-side even if the SSE went quiet — keep the
            // 120s stall watchdog from killing a healthy long turn (it cleared
            // liveToolTurnPending, which also stopped THIS poller: owner's 3min
            // silence on 2026-07-24).
            if st.status == "running" { lastEventAt = Date() }
            return nil
        }
        // Stale-turn guard: never speak a PREVIOUS answer. Prefer an exact turn-id
        // match; without one (the turn_id event died with the stream) accept only
        // a turn that started after this request did.
        if let ourId = liveTurnId {
            guard st.turnId == ourId else { return nil }
        } else {
            let isoFrac = ISO8601DateFormatter()
            isoFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let isoPlain = ISO8601DateFormatter()
            guard let raw = st.startedAt,
                  let startedAt = isoFrac.date(from: raw) ?? isoPlain.date(from: raw),
                  startedAt > requestStart.addingTimeInterval(-10) else { return nil }
        }
        if status == "done", st.continuationNeeded == true, liveContinueBudget > 0,
           let fromTurn = st.turnId {
            // Deadline-cut turn discovered by POLLING (its stream is dead):
            // trigger the machine continuation ourselves and keep waiting for
            // the successor turn — never speak half an answer.
            liveContinueBudget -= 1
            #if DEBUG
            NSLog("ALMA-VOICE poller triggering continuation (budget %d)", liveContinueBudget)
            #endif
            startVoiceContinuation(fromTurn: fromTurn)
            return nil
        }
        if status == "error" || status == "canceled" {
            return "কাজটা শেষ করা যায়নি। Boss-কে ছোট করে জানান, একটু পরে আবার চেষ্টা করা যাবে।"
        }
        guard let mid = st.assistantMessageId, !mid.isEmpty else {
            return Self.noSpokenReplyNote
        }
        return await fetchAssistantMessageText(conversationId: convId, messageId: mid)
    }

    /// Fire a server-claimed machine continuation for a deadline-cut turn whose
    /// stream is gone. Events flow through handle(); the poller keeps watching.
    private func startVoiceContinuation(fromTurn: String) {
        let body = VoiceChatBody(conversationId: chatVM?.conversationId,
                                 message: "",
                                 modelId: chatVM?.modelId ?? "auto",
                                 voice: true,
                                 files: [],
                                 resume: nil,
                                 autoContinueFromTurnId: fromTurn)
        liveTurnId = nil
        Task { [weak self] in
            guard let self else { return }
            do {
                await AlmaAPI.shared.syncCookies()
                var req = URLRequest(url: AssistantNet.base.appendingPathComponent("/api/assistant/chat"))
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = try JSONEncoder().encode(body)
                try await AssistantNet.streamEvents(request: req,
                                                    stopOn: { $0.type == "done" || $0.type == "error" }) { [weak self] ev in
                    self?.handle(ev, speak: false)
                }
            } catch {
                // Poller keeps watching the successor turn regardless.
            }
        }
    }

    private static let noSpokenReplyNote =
        "Head agent কোনো কথ্য উত্তর দেয়নি। স্ক্রিনের approval বা প্রশ্নের card দেখুন।"

    /// Fetch the final assistant message text by id (latest-30 page first, full
    /// history as fallback).
    private func fetchAssistantMessageText(conversationId: String, messageId: String) async -> String? {
        struct Block: Decodable { let type: String?; let text: String? }
        enum FlexContent: Decodable {
            case blocks([Block]), plain(String), empty
            init(from decoder: Decoder) throws {
                let c = try decoder.singleValueContainer()
                if let b = try? c.decode([Block].self) { self = .blocks(b) }
                else if let s = try? c.decode(String.self) { self = .plain(s) }
                else { self = .empty }
            }
            var joined: String {
                switch self {
                case .blocks(let b):
                    return b.compactMap { $0.type == "text" ? $0.text : nil }
                        .joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                case .plain(let s): return s.trimmingCharacters(in: .whitespacesAndNewlines)
                case .empty: return ""
                }
            }
        }
        struct Msg: Decodable { let id: String?; let content: FlexContent? }
        for query in [["limit": "30"], [:]] {
            let page: [Msg]? = try? await AlmaAPI.shared.send(
                "GET", "/api/assistant/conversations/\(conversationId)/messages",
                query: query.mapValues { Optional($0) }, body: Optional<AnyEncodable>.none)
            if let row = page?.first(where: { $0.id == messageId }) {
                let text = row.content?.joined ?? ""
                return text.isEmpty ? Self.noSpokenReplyNote : text
            }
        }
        return "কাজ শেষ হয়েছে, উত্তরটা পড়া গেল না — Boss-কে চ্যাটে দেখতে বলুন।"
    }

    /// Web heartbeat: every 4s while thinking, if silent for 14s say "এখনো কাজ চলছে…".
    /// STALL WATCHDOG: if NO SSE event arrives for 30s while thinking/speaking, the turn
    /// stream is dead (dropped connection) — never leave the orb frozen: cancel, apologise,
    /// and (in convo mode) re-listen so the owner can just speak again.
    private func startHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                guard let self else { continue }
                // Live AI call: the head legitimately streams sparse events during
                // long tool phases — a 30s SSE gap is NORMAL there, and killing the
                // turn silently was why business answers never arrived (sim finding
                // 2026-07-23). Live gets 120s and a SPOKEN failure; legacy keeps 30s.
                let stallLimit: TimeInterval = self.liveActive ? 120 : 30
                if (self.state == .thinking || self.state == .speaking),
                   Date().timeIntervalSince(self.lastEventAt) > stallLimit {
                    self.turnTask?.cancel()
                    if self.liveActive {
                        if let invocation = self.activeLiveToolInvocation {
                            self.deliverLiveToolResult(
                                callId: invocation.callID,
                                functionName: invocation.functionName,
                                text: "কাজটির উত্তর আসতে সমস্যা হচ্ছে। Boss-কে ছোট করে জানান, একটু পরে আবার চেষ্টা করা যাবে।")
                        } else {
                            self.liveToolTurnPending = false
                            self.state = .listening
                        }
                    } else {
                        self.tts.stopAll()
                        self.state = .idle
                        self.tts.sayNow("দুঃখিত Boss, উত্তরটা আটকে গেল — আরেকবার বলুন।")
                        self.scheduleAutoListen()
                    }
                    continue
                }
                guard self.state == .thinking else { continue }
                if !self.liveActive, Date().timeIntervalSince(self.lastAudioAt) > 14 {
                    self.lastAudioAt = Date()
                    self.tts.sayNow("এখনো কাজ চলছে Boss, একটু সময় দিন…")
                }
            }
        }
    }

    // ── Card actions ───────────────────────────────────────────────────────

    func approve(_ card: Card, yes: Bool) {
        guard let pid = card.pendingActionId else { return }
        if let i = cards.firstIndex(where: { $0.id == card.id }) {
            cards[i].status = yes ? "অনুমোদিত" : "বাতিল"
        }
        Task { [weak self] in
            await self?.chatVM?.approveAction(pid, approve: yes)
            guard let self else { return }
            let message = yes ? "অনুমোদন হয়েছে; কাজের আসল ফল এলে জানাব।" : "কাজটি বাতিল হয়েছে।"
            if self.liveActive { self.live.sendRealtimeText(message) }
            else { self.tts.sayNow(yes ? "অনুমোদন করে দিয়েছি Boss, কাজ এগোচ্ছে।" : "বাতিল করে দিয়েছি Boss।") }
        }
    }

    func answer(_ card: Card, option: String) {
        guard let aid = card.askCardId else { return }
        // Persist first, then let the voice engine own exactly ONE spoken turn.
        // The chat VM must not also start its default text continuation here.
        Task { [weak self] in
            guard let self else { return }
            let saved = await self.chatVM?.answerAskCard(
                aid, option: option, continueInChat: false) ?? false
            guard saved else {
                self.tts.sayNow("উত্তরটা সংরক্ষণ করা যায়নি Boss, আবার চেষ্টা করুন।")
                return
            }
            if let i = self.cards.firstIndex(where: { $0.id == card.id }) {
                self.cards[i].status = option
            }
            self.tts.stopAll()
            self.runTurn(option)
        }
    }

    /// Premium-model permission — approve re-runs the SAME question with resume.
    func resolveModelSwitch(_ card: Card, approve: Bool) {
        if let i = cards.firstIndex(where: { $0.id == card.id }) {
            cards[i].status = approve ? "অনুমোদিত" : "বাতিল"
        }
        if approve, !lastUserText.isEmpty {
            tts.stopAll()
            runTurn(lastUserText, resume: true)
        } else {
            tts.sayNow("আচ্ছা Boss, তাহলে বাদ দিলাম।")
        }
    }

    // ── TTS callbacks (from AlmaTtsQueue) ──────────────────────────────────

    func ttsDidStartFirstChunk() {
        lastAudioAt = Date()
        ttsActive = true                 // MIC GATE closes: agent is speaking
        tr("TTS first chunk — gate CLOSED")
        refreshWake()                    // ...so the wake mic can't hear the agent
        // Recording can flip the route to the receiver. Restore loudspeaker only
        // while it is still the owner's selected route; a CallKit/app speaker-OFF
        // choice must survive the next TTS chunk.
        if speakerOn {
            try? AVAudioSession.sharedInstance().overrideOutputAudioPort(.speaker)
        }
        if state == .thinking || state == .transcribing { state = .speaking }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    func ttsDidStartChunk(_ text: String) {
        ttsActive = true                 // stays closed for every chunk of the reply
        // Keep every spoken chunk on the selected output. Never turn a deliberate
        // receiver route back into loudspeaker just because a new chunk began.
        if speakerOn {
            try? AVAudioSession.sharedInstance().overrideOutputAudioPort(.speaker)
        }
        lastAudioAt = Date()
        if !nowLine.isEmpty { saidLines.append(nowLine) }
        if saidLines.count > 2 { saidLines.removeFirst(saidLines.count - 2) }
        nowLine = text
    }

    func ttsLevelChanged(_ level: Double) { ttsLevel = level }

    /// The queue drained and playback stopped — the agent is SILENT now. Clear the mic
    /// gate. If this is a mid-turn gap (narration finished, reply not started yet) drop
    /// the orb back to «ভাবছি»; the real end-of-turn (ttsAllDone) flips it to idle+listen.
    func ttsDidGoSilent() {
        ttsActive = false
        ttsLevel = 0
        tr("TTS silent — gate OPEN")
        if state == .speaking { state = .thinking }
        refreshWake()
    }

    func ttsAllDone() {
        ttsActive = false                // gate open — safe to re-listen
        ttsLevel = 0
        tr("TTS all done — turn complete")
        if !nowLine.isEmpty { saidLines.append(nowLine); nowLine = "" }
        if state == .speaking || state == .thinking {
            state = .idle
            if convoMode { scheduleAutoListen() } else { keepAliveStop() }
        }
    }

    /// Re-open the mic AFTER the agent has fully finished speaking (half-duplex). The
    /// 700ms gap lets the speaker route settle so the very tail of the reply can't leak
    /// into the fresh listen. Guards on `!ttsActive` in case a new line started speaking.
    private func scheduleAutoListen() {
        guard convoMode, !closed else { return }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard let self, !self.closed, self.state == .idle, !self.ttsActive else { return }
            self.startListening()
        }
    }

    // ── Chimes + acks ──────────────────────────────────────────────────────

    private func playAck() {
        guard !ackData.isEmpty else { return }
        let d = ackData[ackIdx % ackData.count]; ackIdx += 1
        tts.playRaw(d)
    }
    private func playMicChime() { AudioServicesPlaySystemSound(1113) }   // begin-record
    private func playCloseChime() { AudioServicesPlaySystemSound(1114) } // end-record
}

// MARK: - Gemini Live full-duplex transport

enum AlmaLiveVoiceError: Error { case badSession, badURL, noMic, noConverter, audioStart }

/// One persistent websocket + one AVAudioEngine for BOTH capture and playback.
/// VoiceProcessingIO is enabled on that single engine, so the owner can interrupt
/// naturally without the old multi-engine crash/feedback-loop failure mode.
struct AlmaLiveVoiceStartAttemptState {
    typealias Token = UInt64

    private enum Phase {
        case stopped
        case reserved
        case active
    }

    private var nextToken: Token = 0
    private var currentToken: Token?
    private var phase: Phase = .stopped

    mutating func reserve() -> Token {
        nextToken &+= 1
        if nextToken == 0 { nextToken = 1 }
        currentToken = nextToken
        phase = .reserved
        return nextToken
    }

    mutating func activate(_ token: Token) -> Bool {
        guard currentToken == token, phase == .reserved else { return false }
        phase = .active
        return true
    }

    func acceptsActive(_ token: Token) -> Bool {
        currentToken == token && phase == .active
    }

    var activeToken: Token? {
        guard phase == .active else { return nil }
        return currentToken
    }

    mutating func invalidate() {
        currentToken = nil
        phase = .stopped
    }
}

@available(iOS 17.0, *)
final class AlmaGeminiLiveSession: NSObject, URLSessionWebSocketDelegate {
    weak var engine: AlmaVoiceEngine?
    private let evidenceRecorder: AlmaLiveVoiceEvidenceRecorder
    private let usageMeter = AlmaLiveVoiceUsageMeter()
    private let toolLedgerLock = NSLock()
    private var toolLedger = AlmaLiveVoiceToolLedger()
    private var toolOrchestrationEnabled = false
    private var toolResponsePlaybackBlocked = false
    private var toolEngineConnectionGeneration: Int?
    private let traceID = String(UUID().uuidString.prefix(8))

    init(evidenceRecorder: AlmaLiveVoiceEvidenceRecorder) {
        self.evidenceRecorder = evidenceRecorder
        super.init()
    }

    func beginUsageSession(callID: String) {
        usageMeter.begin(callID: callID)
    }

    func beginToolOrchestrationSession(enabled: Bool) {
        toolLedgerLock.lock()
        toolLedger.reset()
        toolOrchestrationEnabled = enabled
        toolResponsePlaybackBlocked = false
        toolEngineConnectionGeneration = nil
        toolLedgerLock.unlock()
    }

    func endToolOrchestrationSession() {
        toolLedgerLock.lock()
        toolLedger.reset()
        toolOrchestrationEnabled = false
        toolResponsePlaybackBlocked = false
        toolEngineConnectionGeneration = nil
        toolLedgerLock.unlock()
    }

    var usesToolOrchestration: Bool {
        toolLedgerLock.lock()
        let enabled = toolOrchestrationEnabled
        toolLedgerLock.unlock()
        return enabled
    }

    var hasOutstandingToolCalls: Bool {
        toolLedgerLock.lock()
        let outstanding = toolLedger.hasOutstandingCalls
        toolLedgerLock.unlock()
        return outstanding
    }

    func setToolResponsePlaybackBlocked(_ blocked: Bool) {
        toolLedgerLock.lock()
        toolResponsePlaybackBlocked = blocked
        toolLedgerLock.unlock()
        if !blocked { drainToolResponses() }
    }

    @discardableResult
    func completeToolCall(callID: String, functionName: String, result: String) -> Bool {
        toolLedgerLock.lock()
        let completed = toolLedger.complete(
            callID: callID,
            functionName: functionName,
            result: result)
        toolLedgerLock.unlock()
        guard completed else { return false }
        dispatchNextToolExecution()
        drainToolResponses()
        return true
    }

    func usageReport(conversationID: String?) -> AlmaLiveVoiceUsageReport? {
        usageMeter.report(conversationID: conversationID)
    }

    struct SessionResponse: Decodable {
        let token: String
        let model: String
        let voice: String
        let affectiveDialog: Bool?
        let expiresAt: String
        let websocketUrl: String
    }

    // MARK: Ring-time prewarm (plan C2 latency fix, 2026-07-30)
    //
    // On a weak abroad network the answer→greeting delay was dominated by the
    // post-answer round trip to Vercel that mints the ephemeral Gemini token.
    // The VoIP RING is the earliest signal a live session is about to be
    // needed, so the incoming-push handler mints the token during the ~5–75 s
    // the phone is ringing; answer then goes straight to the Google websocket.
    // Tokens are single-use — a declined ring just lets the mint age out.
    private static var prewarmed: (session: SessionResponse, at: Date)?
    private static let prewarmLock = NSLock()

    static func prewarm() {
        Task.detached(priority: .userInitiated) {
            await AlmaAPI.shared.syncCookies()
            let selection = AlmaLiveVoicePreferences.requestBody
            guard let raw = try? await AssistantNet.postJSONForData(
                    path: "/api/assistant/live-session", body: selection),
                  let minted = try? JSONDecoder().decode(SessionResponse.self, from: raw),
                  !minted.token.isEmpty else { return }
            prewarmLock.lock()
            prewarmed = (minted, Date())
            prewarmLock.unlock()
            #if DEBUG
            NSLog("ALMA-VOICE prewarmed live-session token at ring")
            #endif
        }
    }

    private static func takePrewarmed() -> (session: SessionResponse, at: Date)? {
        prewarmLock.lock()
        defer { prewarmLock.unlock() }
        guard let candidate = prewarmed else { return nil }
        prewarmed = nil
        // Bounded by the token's SERVER-SIDE newSessionExpireTime (120 s, raised
        // from 60 s alongside this feature — Codex P1): past that, Google will
        // refuse to open a session no matter the 30-minute overall expiry. Keep
        // a 30 s margin for the mint response + websocket setup.
        guard Date().timeIntervalSince(candidate.at) < 90 else { return nil }
        return candidate
    }

    private var session: URLSession?
    private var ws: URLSessionWebSocketTask?
    private let audioEngine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var inputConverter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private var playbackFormat: AVAudioFormat?
    private var tapInstalled = false
    private var playbackReferenceTapInstalled = false
    private var configured = false
    private var stopped = true
    /// `Task.cancel()` alone cannot stop a queued async start from running after
    /// hang-up. This separate lifetime token is reserved synchronously by the
    /// engine, activated exactly once by `start`, and invalidated before stop
    /// tears down the current socket/audio graph.
    private let startAttemptLock = NSCondition()
    private var startAttemptState = AlmaLiveVoiceStartAttemptState()
    private var startAttemptEngineConnectionGeneration: Int?
    private var startAttemptProfile: AlmaLiveVoiceProfile?
    private var startAttemptTeardownInProgress = false
    /// Protected by `startAttemptLock`; binds the mutable session/socket slots
    /// to the logical attempt that published them.
    private var socketStartAttempt: AlmaLiveVoiceStartAttemptState.Token?
    private var socketReady = false
    private var reconnecting = false
    private let keepaliveLock = NSLock()
    private var pingTimer: DispatchSourceTimer?
    private var awaitingPongAttempt: AlmaLiveVoiceSocketAttempt?
    private var routeObserver: NSObjectProtocol?
    /// One serial home for keepalive state + reconnect entry (Codex P2 round 4):
    /// the timer, ping completions, and receive-failure recovery all funnel here
    /// so two callbacks can never both pass recoverConnection's guards and
    /// tear down / replace the socket concurrently.
    private let netQueue = DispatchQueue(label: "alma.voice.net")
    private let evidenceTransportLock = NSLock()
    private var evidenceTransportBinding = AlmaLiveVoiceEvidenceTransportBinding()
    private var evidenceAudioTurnEpoch = 0
    private var evidenceAudioSendPending = false
    private var evidenceAudioSendSucceeded = false
    private var nextEvidenceSendClaimID = 0
    private enum AudioSendEvidenceClaimResult {
        case claimed(generation: Int, turnEpoch: Int, claimID: Int)
        case alreadyCovered
        case unavailable
    }
    private let evidenceSubmissionLock = NSLock()
    private let evidenceQueue = DispatchQueue(label: "alma.voice.recovery-evidence")
    private var evidenceSessionAccepting = false
    /// Accessed only on `evidenceQueue`; completion callbacks carry a local claim
    /// ID so an immediate callback can never overtake context creation.
    private var evidenceSendContexts: [Int: AlmaLiveVoiceEvidenceSendContext] = [:]
    private var hasConnectedOnce = false
    private var mintedSession: SessionResponse?
    private var mintedAt = Date.distantPast
    private var reconnectAttempts = 0
    /// Affective dialog is OFF on the production 3.1 transport. Requesting an
    /// unsupported setup field made calls burn their first connection on a 1007
    /// close and retry; keep the downgrade path for a future isolated migration.
    private var allowAffective = false
    private var pendingResumptionHandle: String?
    private var latestResumptionHandle: String?
    private var outputTranscript = ""
    private let inputTurnReducerLock = NSLock()
    private var inputTurnReducer = AlmaLiveVoiceInputTurnReducer(generation: 0)
    private var inputTurnReducerEnabled = false
    private var nextInputFrameSequence: UInt64 = 0

    // Gemini emits native audio as many tiny PCM frames. A player callback for one
    // frame is NOT the end of the model's turn: treating it that way made the UI
    // bounce speaking → listening between words and could expose speaker echo to
    // server VAD. Keep one turn-level playback state instead. We prebuffer a small
    // amount (Gemini generates faster than realtime), then finish only after BOTH
    // server turnComplete and the local queue have drained.
    private var nextPlaybackBufferID = 0
    private var pendingPlaybackBuffers = Set<Int>()
    private var bufferedPlaybackDuration = 0.0
    private var estimatedPlaybackEnd = Date.distantPast
    private var playbackGeneration = 0
    private var modelAudioTurnOpen = false
    #if DEBUG
    private var micDebugFrameCount = 0
    #endif
    private var modelGenerationCompleteReceived = false
    private var modelTurnCompleteReceived = false
    private var playbackStarted = false
    private var firstInputFrameTraced = false
    private var firstModelPCMTraced = false
    private var firstPlaybackPrimed = false
    private var playbackRecoveryGeneration = 0

    // Natural barge-in without self-interruption. While model audio is active, the
    // post-VoiceProcessingIO microphone is held locally. Only sustained speech well
    // above the calibrated residual-echo floor opens the gate; the short pre-roll is
    // then forwarded so Boss's first syllable is retained. Normal listening remains
    // fully streaming and tap-free.
    private var bargeInPending = false
    private var bargeSpeechFrames = 0
    private var echoCalibrationFrames = 0
    private var echoFloorRMS = 0.008
    private var micPreRoll: [AlmaLiveVoiceCapturedInputPCM] = []
    // When hardware echo cancellation is unavailable on loudspeaker, RMS alone
    // cannot tell ALMA's own voice from Boss speaking over it. A short side-chain
    // probe ducks only ALMA's player (never the microphone): acoustic echo then
    // disappears, while a real nearby voice remains and can be confirmed.
    private var loudspeakerProbeActive = false
    private var loudspeakerProbeCandidateFrames = 0
    private var loudspeakerProbeCandidatePeakRMS = 0.0
    private var loudspeakerProbeDuckAppliedAt = Date.distantPast
    private var loudspeakerProbeVoiceFrames = 0
    private var loudspeakerProbeCooldownFrames = 0
    // The simulator has no reliable VoiceProcessingIO echo cancellation. Observe
    // the main mixer's real rendered output and subtract its conservatively
    // predicted acoustic energy from the microphone. This lets a short owner
    // interjection interrupt within ~80ms without teaching ALMA to cut herself
    // off. The volume-duck probe below remains only as a no-reference fallback.
    private var playbackReferenceHistory: [(capturedAt: TimeInterval, rms: Double)] = []
    private var playbackReferenceWaveHistory: [(capturedAt: TimeInterval, samples: [Float])] = []
    private var playbackReferenceEchoCorrelation = 0.0
    private var playbackReferenceEchoCorrelationFrames = 0
    private var playbackReferenceReadyFrames = 0
    private var playbackReferenceSpeechFrames = 0
    private var bargeInEvidenceTraceFrames = 0
    private var soundAnalyzer: SNAudioStreamAnalyzer?
    private var soundRequest: SNClassifySoundRequest?
    private var soundObserver: AlmaLiveSoundObserver?
    private var soundAnalysisFramePosition: AVAudioFramePosition = 0
    private var soundSpeechConfidence = 0.0
    private var soundMusicConfidence = 0.0
    private var soundNoiseConfidence = 0.0
    private var soundClassificationAt = Date.distantPast
    // Listening-path noise gate (protected by audioLock, see capture()).
    private var listenPreRoll: [AlmaLiveVoiceCapturedInputPCM] = []
    private var listenGateOpen = false
    private var listenSpeechFrames = 0
    private var listenSilenceFrames = 0
    private var listenNoiseFloorRMS = 0.004
    private var listenCalibrationFrames = 0
    private var listenCalibMinRMS = Double.greatestFiniteMagnitude
    private var listenContinuousLoudFrames = 0
    // Natural playback can leave an acoustic/AGC tail after the queue reports
    // drained. Do not reopen the normal listening gate until that tail expires;
    // otherwise ALMA's last words are transcribed as a new (often garbled) user
    // turn. Local/server barge-in explicitly clears this guard so a real owner
    // interruption continues streaming without delay.
    private var listenSuppressedUntil = Date.distantPast
    private var listenTailSuppressionLogged = false
    private let playbackPrebufferSeconds = 0.16
    // Owner speech measured around 0.047 only at its PEAK. A 0.045 floor meant
    // ordinary syllables never accumulated enough frames to interrupt. AEC/
    // receiver routes can safely use the calibrated residual-echo floor with a
    // low absolute guard; the sustained-frame requirement still rejects clicks.
    private let bargeInMinimumRMS = 0.014
    private let receiverBargeInRequiredFrames = 7 // ≈140ms on receiver/AEC routes
    // This threshold starts a discriminator; it never stops playback by itself.
    // Keep it below normal conversational RMS so a quiet "একটু থামো" reaches
    // the duck probe instead of being discarded before echo discrimination.
    private let loudspeakerProbeCandidateRMS = 0.014
    private let loudspeakerProbeCandidateRequiredFrames = 2 // ≈40ms before ducking
    // Wall-clock bounds are intentional. The Bluetooth/Simulator acoustic path
    // still delivered pre-duck energy 184ms after player.volume changed in the
    // owner run. Wait beyond that measured tail before classifying retained
    // energy; a continuous human remains, while stale loudspeaker echo decays.
    private let loudspeakerProbeSettleSeconds = 0.22
    private let loudspeakerProbeWindowSeconds = 0.42
    private let loudspeakerProbeVoiceRequiredFrames = 2
    // Instrumented owner run: a false greeting-echo probe retained 54.7% after
    // the duck, while the owner's real barge-in retained 75.2% and produced a
    // server INTERRUPTED event. A 60% boundary separates those measured cases.
    // The lowered candidate threshold above lets quiet speech ENTER the probe;
    // this ratio decides whether retained energy is human, not mere echo.
    private let loudspeakerProbeRetainedEnergyRatio = 0.60
    private let loudspeakerProbeDuckVolume: Float = 0.35
    private let loudspeakerProbeCooldownRequiredFrames = 60
    // SoundAnalysis' shortest built-in classification window is 500ms. Keep a
    // full 1.2s so an early interjection is never lost while that first result
    // arrives; this buffer exists only while ALMA is actively speaking.
    private let bargeInPreRollChunks = 60        // ≈1.2s, including first syllable
    private let playbackReferenceHistorySeconds = 0.32
    private let playbackReferenceMinimumRMS = 0.004
    private let playbackReferenceReadyRequiredFrames = 4
    private let playbackReferenceSpeechRequiredFrames = 4 // ≈80ms
    private let audioLock = NSLock()
    // Accessed only while `audioLock` is held. These one-shot guards keep the
    // evidence recorder and OSLog off the realtime callback after each stage's
    // first observation, while leaving the audio/VAD decisions untouched.
    private var evidenceInputStageState = AlmaLiveVoiceEvidenceInputStageState()
    private var captureSocketAttempt: AlmaLiveVoiceSocketAttempt?
    /// EVERY AVAudioEngine/AVAudioPlayerNode lifecycle call goes through this ONE
    /// serial queue. Build 82 device crash reports (0x8BADF00D watchdog): main
    /// thread deadlocked inside AVFAudio's recursive_mutex ([AVAudioPlayerNode
    /// stop] / [AVAudioEngine inputNode]) because socket threads and UI buttons
    /// hit the engine concurrently. Serializing removes the lock inversion.
    private let audioQueue = DispatchQueue(label: "alma.voice.audio")
    private var inputMuted = false
    private var speakerEnabled = true
    /// VoiceProcessingIO can emit one last asynchronous receiver reset while the
    /// graph is coming up. During this short window we defend the requested route;
    /// afterwards CallKit owns all built-in route changes. The locked system call
    /// screen does not reliably label its speaker selection as `.override`, so we
    /// must adopt the actual route for every route-change reason.
    private var bootstrapRouteProtectionUntil = Date.distantPast
    private let readinessLock = NSLock()
    private var readiness = AlmaLiveAudioReadiness()
    private var socketAttemptOrdinal = 0
    /// CallKit owns the AVAudioSession for an agent call (plan C2). The app must
    /// NOT set the category or activate it — doing so threw on the owner's
    /// device (build 89: "লাইভ অডিও চালু করা যায়নি", agent silent). CallKit has
    /// already configured playAndRecord/voiceChat; if its activation has not
    /// landed yet, audio setup is retried from callKitAudioActivated().
    var callKitOwnsAudioSession = false {
        didSet {
            updateReadiness { state in
                state.callKitManaged = callKitOwnsAudioSession
                if !callKitOwnsAudioSession { state.callKitAudioActive = false }
            }
        }
    }
    private var audioConfigPending = false
    /// Engine watchdog peek: socket setup finished but audio is still waiting on
    /// CallKit's didActivate (the retry ladder is running).
    var isAwaitingCallKitAudio: Bool { readinessSnapshot().waitingForCallKit }
    /// True when hardware echo cancellation could not be enabled (CallKit-owned
    /// session). The barge-in gate compensates with a higher echo floor.
    private(set) var voiceProcessingUnavailable = false
    /// Bumped on every stop()/reconnect so a delayed audio retry belonging to a
    /// dead attempt cannot touch the replacement session.
    private var audioAttemptGeneration = 0

    func beginEvidenceSession() {
        evidenceSubmissionLock.lock()
        evidenceSessionAccepting = false
        audioLock.lock()
        evidenceInputStageState.deactivate()
        audioLock.unlock()
        evidenceSubmissionLock.unlock()
        evidenceQueue.sync { evidenceSendContexts.removeAll(keepingCapacity: true) }
        evidenceSubmissionLock.lock()
        evidenceSessionAccepting = evidenceRecorder.isEnabled
        evidenceSubmissionLock.unlock()
    }

    func finishEvidenceSession() {
        evidenceSubmissionLock.lock()
        evidenceSessionAccepting = false
        audioLock.lock()
        evidenceInputStageState.deactivate()
        audioLock.unlock()
        evidenceSubmissionLock.unlock()
        _ = invalidateSocketReadiness()
        evidenceQueue.sync { evidenceSendContexts.removeAll(keepingCapacity: true) }
    }

    func flushEvidence() {
        guard evidenceRecorder.isEnabled else { return }
        // A point-in-time drain does not close intake. Holding the submission
        // lock here would let a live export priority-invert the realtime tap;
        // the recorder's own lock still makes the subsequent report snapshot
        // internally consistent.
        evidenceQueue.sync {}
    }

    var lifecycleEvidenceSessionID: String { evidenceRecorder.sessionID }

    func lifecycleEvidenceContext(
        localSessionID: String? = nil,
        observedUptime: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) -> AlmaLiveVoiceLifecycleEvidenceContext {
        AlmaLiveVoiceLifecycleEvidenceContext(
            localSessionID: localSessionID ?? evidenceRecorder.sessionID,
            observedUptime: observedUptime)
    }

    @discardableResult
    func recordLifecycleEvidence(
        _ event: AlmaLiveVoiceEvidenceLifecycleEvent,
        context: AlmaLiveVoiceLifecycleEvidenceContext? = nil
    ) -> Bool {
        let source = context ?? lifecycleEvidenceContext()
        return submitEvidence { recorder in
            recorder.recordLifecycleEvent(
                event,
                expectedLocalSessionID: source.localSessionID,
                observedUptime: source.observedUptime)
        }
    }

    private func recordTransportEvidence(
        _ event: AlmaLiveVoiceEvidenceTransportEvent,
        generation: Int,
        observedUptime: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) {
        guard generation > 0 else { return }
        _ = submitEvidence { recorder in
            recorder.recordTransportEvent(
                event,
                generation: generation,
                observedUptime: observedUptime)
        }
    }

    @discardableResult
    private func submitEvidenceLocked(
        _ action: @escaping (AlmaLiveVoiceEvidenceRecorder) -> Void
    ) -> Bool {
        guard evidenceRecorder.isEnabled, evidenceSessionAccepting else { return false }
        evidenceQueue.async { [weak self] in
            guard let self else { return }
            action(self.evidenceRecorder)
        }
        return true
    }

    @discardableResult
    private func submitEvidence(
        _ action: @escaping (AlmaLiveVoiceEvidenceRecorder) -> Void
    ) -> Bool {
        guard evidenceRecorder.isEnabled else { return false }
        evidenceSubmissionLock.lock()
        let submitted = submitEvidenceLocked(action)
        evidenceSubmissionLock.unlock()
        return submitted
    }

    private func submitEvidenceSync(
        _ action: (AlmaLiveVoiceEvidenceRecorder) -> Void
    ) {
        guard evidenceRecorder.isEnabled else { return }
        evidenceSubmissionLock.lock()
        guard evidenceSessionAccepting else {
            evidenceSubmissionLock.unlock()
            return
        }
        evidenceQueue.sync { action(evidenceRecorder) }
        evidenceSubmissionLock.unlock()
    }

    private func trace(_ name: String, _ detail: String = "") {
        AlmaVoiceAudioTrace.event(name, "id=\(traceID) \(detail)")
    }

    private func beginEvidenceTransport(resuming: Bool) -> Int {
        guard evidenceRecorder.isEnabled else { return 0 }
        evidenceSubmissionLock.lock()
        guard evidenceSessionAccepting else {
            evidenceSubmissionLock.unlock()
            return 0
        }
        var generation = 0
        var localSessionID = "not-started"
        evidenceQueue.sync {
            generation = evidenceRecorder.beginTransportAttempt(resuming: resuming)
            localSessionID = evidenceRecorder.sessionID
        }
        evidenceTransportLock.lock()
        evidenceTransportBinding.begin(generation: generation)
        evidenceAudioTurnEpoch += 1
        evidenceAudioSendPending = false
        evidenceAudioSendSucceeded = false
        evidenceTransportLock.unlock()

        audioLock.lock()
        evidenceInputStageState.reset(
            localSessionID: localSessionID,
            transportGeneration: generation)
        let inputWindowID = evidenceInputStageState.snapshot().windowID
        evidenceQueue.sync {
            _ = evidenceRecorder.activateInputWindow(
                inputWindowID,
                generation: generation)
        }
        audioLock.unlock()
        evidenceSubmissionLock.unlock()
        return generation
    }

    private func evidenceTransportGenerationSnapshot() -> Int {
        guard evidenceRecorder.isEnabled else { return 0 }
        evidenceTransportLock.lock()
        let generation = evidenceTransportBinding.generation
        evidenceTransportLock.unlock()
        return generation
    }

    private func bindEvidenceSocket(
        _ socket: URLSessionWebSocketTask,
        generation: Int
    ) {
        guard evidenceRecorder.isEnabled else { return }
        evidenceTransportLock.lock()
        evidenceTransportBinding.bind(
            socketIdentity: ObjectIdentifier(socket),
            generation: generation)
        evidenceTransportLock.unlock()
    }

    private func evidenceGeneration(
        for socket: URLSessionWebSocketTask,
        requireReady: Bool
    ) -> Int? {
        guard evidenceRecorder.isEnabled else { return nil }
        evidenceTransportLock.lock()
        let matches = evidenceTransportBinding.matches(
            socketIdentity: ObjectIdentifier(socket),
            requireReady: requireReady)
        let generation = matches ? evidenceTransportBinding.generation : nil
        evidenceTransportLock.unlock()
        return generation
    }

    private func evidenceCompletionState(
        for socket: URLSessionWebSocketTask,
        sourceGeneration: Int,
        turnEpoch: Int,
        succeeded: Bool
    ) -> (currentGeneration: Int, isCurrentReadySocket: Bool) {
        guard evidenceRecorder.isEnabled else { return (0, false) }
        evidenceTransportLock.lock()
        let state = evidenceTransportBinding.completion(
            socketIdentity: ObjectIdentifier(socket),
            sourceGeneration: sourceGeneration)
        if turnEpoch == evidenceAudioTurnEpoch {
            evidenceAudioSendPending = false
            if succeeded && state.isCurrentReadySocket { evidenceAudioSendSucceeded = true }
        }
        evidenceTransportLock.unlock()
        return state
    }

    private func claimEvidenceAudioSend(
        for socket: URLSessionWebSocketTask,
        sourceGeneration: Int
    ) -> AudioSendEvidenceClaimResult {
        guard evidenceRecorder.isEnabled else { return .alreadyCovered }
        evidenceTransportLock.lock()
        guard evidenceTransportBinding.matches(
            socketIdentity: ObjectIdentifier(socket),
            generation: sourceGeneration,
            requireReady: true
        ) else {
            evidenceTransportLock.unlock()
            return .unavailable
        }
        let result: AudioSendEvidenceClaimResult
        if evidenceAudioSendPending || evidenceAudioSendSucceeded {
            result = .alreadyCovered
        } else {
            evidenceAudioSendPending = true
            nextEvidenceSendClaimID += 1
            result = .claimed(
                generation: evidenceTransportBinding.generation,
                turnEpoch: evidenceAudioTurnEpoch,
                claimID: nextEvidenceSendClaimID)
        }
        evidenceTransportLock.unlock()
        return result
    }

    private func abandonEvidenceAudioSendClaim(turnEpoch: Int) {
        guard evidenceRecorder.isEnabled else { return }
        evidenceTransportLock.lock()
        if turnEpoch == evidenceAudioTurnEpoch { evidenceAudioSendPending = false }
        evidenceTransportLock.unlock()
    }

    private func beginNextEvidenceAudioTurn(generation: Int) {
        guard evidenceRecorder.isEnabled else { return }
        evidenceTransportLock.lock()
        if generation == evidenceTransportBinding.generation {
            evidenceAudioTurnEpoch += 1
            evidenceAudioSendPending = false
            evidenceAudioSendSucceeded = false
        }
        evidenceTransportLock.unlock()
    }

    /// Caller holds `evidenceSubmissionLock` and `audioLock`. Rearming and
    /// enqueueing while the behavioral model turn opens makes the boundary
    /// indivisible: capture can only publish fully before or fully after it.
    private func beginModelEvidenceEpochLocked(
        transportGeneration: Int,
        playbackGeneration: Int,
        observedUptime: TimeInterval
    ) {
        guard evidenceRecorder.isEnabled, evidenceSessionAccepting else { return }
        guard evidenceInputStageState.rearm(
            transportGeneration: transportGeneration) else { return }
        let nextInputWindowID = evidenceInputStageState.snapshot().windowID
        _ = submitEvidenceLocked { recorder in
            recorder.recordProviderModelAudioObserved(
                generation: transportGeneration,
                playbackGeneration: playbackGeneration,
                nextInputWindowID: nextInputWindowID,
                observedUptime: observedUptime)
        }
    }

    /// Claims the first content-free source observations as one ordered batch.
    /// The conversion result may arrive after raw measurement, but its original
    /// callback uptimes are retained. No recorder collection or logging work is
    /// performed on the realtime audio callback.
    private func submitCaptureStageEvidence(
        rms: Double,
        convertedByteCount: Int?,
        failureReason: AlmaLiveVoiceEvidenceConversionFailure?,
        snapshot: AlmaLiveVoiceEvidenceInputStageState.Snapshot,
        rawObservedUptime: TimeInterval,
        conversionObservedUptime: TimeInterval
    ) {
        guard evidenceRecorder.isEnabled else { return }
        let hasEnergy = AlmaLiveVoiceEvidenceRecorder.isFirstEnergyCandidate(rms)
        let mayClaimSource: Bool
        if convertedByteCount != nil {
            mayClaimSource = hasEnergy && (snapshot.needsRaw || snapshot.needsConversion)
        } else {
            // A persistent converter failure must not reacquire the audio lock
            // on every callback after its one raw/failure observation was taken.
            mayClaimSource = hasEnergy && snapshot.needsRaw
        }
        let mayClaimFailure = failureReason != nil
            && hasEnergy
            && snapshot.needsConversionFailure
        guard mayClaimSource || mayClaimFailure else { return }

        audioLock.lock()
        let recordRaw = evidenceInputStageState.claimRaw(
            windowID: snapshot.windowID,
            hasEnergy: hasEnergy)
        let recordConversion: Bool
        let recordFailure: Bool
        if let convertedByteCount {
            recordConversion = evidenceInputStageState.claimConversionSucceeded(
                windowID: snapshot.windowID,
                hasEnergy: hasEnergy,
                byteCount: convertedByteCount)
            recordFailure = false
        } else if failureReason != nil {
            recordConversion = false
            recordFailure = evidenceInputStageState.claimConversionFailure(
                windowID: snapshot.windowID)
        } else {
            recordConversion = false
            recordFailure = false
        }
        if recordRaw || recordConversion || recordFailure {
            let recorder = evidenceRecorder
            evidenceQueue.async {
                if recordRaw {
                    recorder.recordRawEnergy(
                        rms: rms,
                        generation: snapshot.windowID.transportGeneration,
                        inputWindowID: snapshot.windowID,
                        observedUptime: rawObservedUptime)
                }
                if recordConversion, let convertedByteCount {
                    recorder.recordConversionSucceeded(
                        byteCount: convertedByteCount,
                        generation: snapshot.windowID.transportGeneration,
                        inputWindowID: snapshot.windowID,
                        observedUptime: conversionObservedUptime)
                }
                if recordFailure, let failureReason {
                    recorder.recordConversionFailed(
                        failureReason,
                        generation: snapshot.windowID.transportGeneration,
                        inputWindowID: snapshot.windowID,
                        observedUptime: conversionObservedUptime)
                }
            }
        }
        audioLock.unlock()
    }

    /// Caller holds `audioLock`. The current frame must itself carry energy;
    /// otherwise a later silent frame could inherit an earlier frame's chain
    /// and falsely become the policy observation.
    private func claimInputPolicyWithheldEvidenceLocked(
        _ policy: AlmaLiveVoiceEvidenceInputPolicy,
        snapshot: AlmaLiveVoiceEvidenceInputStageState.Snapshot,
        hasEnergy: Bool
    ) -> Bool {
        guard evidenceRecorder.isEnabled,
              hasEnergy,
              snapshot.pendingPolicyMask & policy.bit != 0 else { return false }
        return evidenceInputStageState.claimPolicyWithheld(
            policy,
            windowID: snapshot.windowID)
    }

    /// Caller holds `audioLock`; enqueue only fixed typed/numeric data before
    /// releasing it so model rearm/session finish cannot overtake the claim.
    /// Recorder collection and logging still run later on `evidenceQueue`.
    private func enqueueInputPolicyWithheldEvidence(
        _ policy: AlmaLiveVoiceEvidenceInputPolicy,
        snapshot: AlmaLiveVoiceEvidenceInputStageState.Snapshot,
        observedUptime: TimeInterval
    ) {
        let recorder = evidenceRecorder
        evidenceQueue.async {
            recorder.recordInputWithheldByPolicy(
                policy,
                generation: snapshot.windowID.transportGeneration,
                inputWindowID: snapshot.windowID,
                observedUptime: observedUptime)
        }
    }

    private func evidenceRoute(_ session: AVAudioSession = .sharedInstance()) -> AlmaLiveVoiceEvidenceRoute {
        let ports = session.currentRoute.outputs.map(\.portType)
        if ports.contains(.builtInSpeaker) { return .builtInSpeaker }
        if ports.contains(.builtInReceiver) { return .builtInReceiver }
        if ports.contains(.bluetoothHFP) { return .bluetoothHFP }
        if ports.contains(.headphones) || ports.contains(.headsetMic) { return .headphones }
        return ports.isEmpty ? .none : .other
    }

    private func audioSessionDescription(_ session: AVAudioSession = .sharedInstance()) -> String {
        let outputs = session.currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: "+")
        return "category=\(session.category.rawValue) mode=\(session.mode.rawValue) "
            + "options=\(session.categoryOptions.rawValue) route=\(outputs.isEmpty ? "none" : outputs)"
    }

    private func prepareAudioSession(activate: Bool) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
        try? session.setPreferredIOBufferDuration(0.02)
        if activate { try session.setActive(true) }
        trace(activate ? "session.prepared.standalone" : "session.prepared.callkit",
              audioSessionDescription(session))
    }

    func prepareCallKitAudioSession() throws {
        try prepareAudioSession(activate: false)
        #if !targetEnvironment(simulator)
        // CallKit activates the session immediately after the answer action is
        // fulfilled. VoiceProcessingIO cannot reliably be swapped in after that
        // activation, so prepare it while the graph is still cold. This is the
        // real-device path that gives Gemini clean continuous mic audio during
        // playback instead of forcing Boss through a local RMS gate.
        audioQueue.sync {
            voiceProcessingUnavailable = false
            do {
                try audioEngine.inputNode.setVoiceProcessingEnabled(true)
                voiceProcessingUnavailable = !audioEngine.inputNode.isVoiceProcessingEnabled
            } catch {
                voiceProcessingUnavailable = true
                trace("voiceProcessing.preflight.failed", String(describing: error))
            }
        }
        #endif
    }

    func prepareStandaloneAudioSession() throws {
        try prepareAudioSession(activate: true)
    }

    @discardableResult
    private func updateReadiness(_ update: (inout AlmaLiveAudioReadiness) -> Void) -> AlmaLiveAudioReadiness {
        readinessLock.lock()
        update(&readiness)
        let snapshot = readiness
        readinessLock.unlock()
        return snapshot
    }

    private func readinessSnapshot() -> AlmaLiveAudioReadiness {
        readinessLock.lock()
        let snapshot = readiness
        readinessLock.unlock()
        return snapshot
    }

    private func bindRuntimeSocketAttempt(
        _ socket: URLSessionWebSocketTask,
        evidenceGeneration: Int,
        startAttempt: AlmaLiveVoiceStartAttemptState.Token,
        engineConnectionGeneration: Int,
        recoveryAttempt: Bool,
        resumptionRequested: Bool
    ) -> AlmaLiveVoiceSocketAttempt {
        readinessLock.lock()
        socketAttemptOrdinal += 1
        let attempt = AlmaLiveVoiceSocketAttempt(
            ordinal: socketAttemptOrdinal,
            socketIdentity: ObjectIdentifier(socket),
            evidenceGeneration: evidenceGeneration,
            startAttempt: startAttempt,
            engineConnectionGeneration: engineConnectionGeneration,
            recoveryAttempt: recoveryAttempt,
            resumptionRequested: resumptionRequested)
        readiness.bindSocketAttempt(attempt)
        socketReady = false
        audioLock.lock()
        captureSocketAttempt = nil
        audioLock.unlock()
        readinessLock.unlock()
        return attempt
    }

    private func isCurrentSocketAttempt(_ attempt: AlmaLiveVoiceSocketAttempt) -> Bool {
        readinessLock.lock()
        let current = readiness.socketAttempt == attempt
        readinessLock.unlock()
        return current
    }

    /// Snapshot the runtime attempt before withdrawing readiness. Recovery is
    /// authorized again under `startAttemptLock`, so this snapshot can become
    /// stale without ever targeting a replacement socket.
    private func currentSocketAttempt(
        for socket: URLSessionWebSocketTask
    ) -> AlmaLiveVoiceSocketAttempt? {
        readinessLock.lock()
        let attempt = readiness.socketAttempt
        let current = attempt?.socketIdentity == ObjectIdentifier(socket)
            ? attempt
            : nil
        readinessLock.unlock()
        return current
    }

    /// Must be called while `startAttemptLock` is held. Unlike readiness, these
    /// fields survive the brief not-ready interval between a transport failure
    /// and its source-bound recovery transaction.
    private func isCurrentPhysicalSocketAttemptLocked(
        _ attempt: AlmaLiveVoiceSocketAttempt
    ) -> Bool {
        startAttemptState.acceptsActive(attempt.startAttempt)
            && socketStartAttempt == attempt.startAttempt
            && ws.map(ObjectIdentifier.init) == attempt.socketIdentity
    }

    private func isCurrentPhysicalSocketAttempt(
        _ attempt: AlmaLiveVoiceSocketAttempt
    ) -> Bool {
        startAttemptLock.lock()
        let current = isCurrentPhysicalSocketAttemptLocked(attempt)
        startAttemptLock.unlock()
        return current
    }

    private func acceptSocketSetup(
        _ attempt: AlmaLiveVoiceSocketAttempt
    ) -> AlmaLiveAudioReadiness? {
        readinessLock.lock()
        guard readiness.acceptSocketSetup(attempt) else {
            readinessLock.unlock()
            return nil
        }
        if readiness.waitingForCallKit {
            _ = readiness.deferSetupForCallKit(attempt)
        }
        let snapshot = readiness
        readinessLock.unlock()
        return snapshot
    }

    /// Atomically distinguishes a current pending/accepted setup from an attempt
    /// that was invalidated after its frame entered `onMessage`. A stale frame
    /// must never be reclassified as a failed recovery attempt.
    private func currentSocketSetupAccepted(
        _ attempt: AlmaLiveVoiceSocketAttempt
    ) -> Bool? {
        readinessLock.lock()
        let accepted = readiness.setupAcceptance(for: attempt)
        readinessLock.unlock()
        return accepted
    }

    @discardableResult
    private func deferSocketSetupForCallKit(
        _ attempt: AlmaLiveVoiceSocketAttempt
    ) -> Bool {
        readinessLock.lock()
        let deferred = readiness.deferSetupForCallKit(attempt)
        readinessLock.unlock()
        return deferred
    }

    private func canPublishSocketSetup(
        _ attempt: AlmaLiveVoiceSocketAttempt
    ) -> Bool {
        readinessLock.lock()
        let canPublish = readiness.socketAttempt == attempt && readiness.canPublishLive
        readinessLock.unlock()
        return canPublish
    }

    /// Publish evidence-ready and behavioral-ready as one source-bound state
    /// transition. Capture can only observe `socketReady` after the exact
    /// generation/identity has been marked ready.
    private func publishSocketReady(_ attempt: AlmaLiveVoiceSocketAttempt) -> Bool {
        readinessLock.lock()
        guard readiness.socketAttempt == attempt, readiness.canPublishLive else {
            readinessLock.unlock()
            return false
        }
        evidenceTransportLock.lock()
        let evidenceMatches = !evidenceRecorder.isEnabled
            || evidenceTransportBinding.matches(
                socketIdentity: attempt.socketIdentity,
                generation: attempt.evidenceGeneration,
                requireReady: false)
        guard evidenceMatches, readiness.claimPublish(attempt) else {
            evidenceTransportLock.unlock()
            readinessLock.unlock()
            return false
        }
        if evidenceRecorder.isEnabled {
            guard evidenceTransportBinding.markReady(
                socketIdentity: attempt.socketIdentity,
                generation: attempt.evidenceGeneration) else {
                evidenceTransportLock.unlock()
                readinessLock.unlock()
                return false
            }
        }
        socketReady = true
        evidenceTransportLock.unlock()
        audioLock.lock()
        captureSocketAttempt = attempt
        audioLock.unlock()
        readinessLock.unlock()
        return true
    }

    /// Withdraw diagnostics readiness before behavioral readiness. When a
    /// source attempt is supplied, a stale callback cannot invalidate its
    /// replacement.
    @discardableResult
    private func invalidateSocketReadiness(
        attempt: AlmaLiveVoiceSocketAttempt? = nil,
        socket: URLSessionWebSocketTask? = nil
    ) -> Bool {
        readinessLock.lock()
        if let attempt, readiness.socketAttempt != attempt {
            readinessLock.unlock()
            return false
        }
        if let socket,
           readiness.socketAttempt?.socketIdentity != ObjectIdentifier(socket) {
            readinessLock.unlock()
            return false
        }
        let invalidatedTransportOrdinal = readiness.socketAttempt?.ordinal
        evidenceTransportLock.lock()
        evidenceTransportBinding.markNotReady()
        socketReady = false
        evidenceTransportLock.unlock()
        audioLock.lock()
        captureSocketAttempt = nil
        audioLock.unlock()
        readiness.beginSocketAttempt()
        audioConfigPending = false
        readinessLock.unlock()
        if let invalidatedTransportOrdinal {
            toolLedgerLock.lock()
            toolLedger.invalidateTransport(invalidatedTransportOrdinal)
            toolLedgerLock.unlock()
        }
        return true
    }

    private func socketReadySnapshot() -> Bool {
        readinessLock.lock()
        let value = socketReady
        readinessLock.unlock()
        return value
    }

    func reserveStartAttempt(
        engineConnectionGeneration: Int,
        profile: AlmaLiveVoiceProfile
    ) -> AlmaLiveVoiceStartAttemptState.Token {
        startAttemptLock.lock()
        while startAttemptTeardownInProgress { startAttemptLock.wait() }
        let token = startAttemptState.reserve()
        startAttemptEngineConnectionGeneration = engineConnectionGeneration
        startAttemptProfile = profile
        startAttemptLock.unlock()
        return token
    }

    private func profile(
        for attempt: AlmaLiveVoiceStartAttemptState.Token
    ) -> AlmaLiveVoiceProfile? {
        startAttemptLock.lock()
        let profile = startAttemptState.acceptsActive(attempt)
            ? startAttemptProfile
            : nil
        startAttemptLock.unlock()
        return profile
    }

    private func activateStartAttempt(
        _ attempt: AlmaLiveVoiceStartAttemptState.Token
    ) -> Bool {
        startAttemptLock.lock()
        guard startAttemptState.activate(attempt) else {
            startAttemptLock.unlock()
            return false
        }
        stopped = false
        inputTurnReducerLock.lock()
        inputTurnReducerEnabled = AlmaLiveVoiceRecoveryFeatures.isEnabled(.inputTurnReducerV1)
        inputTurnReducer.reset(generation: attempt)
        nextInputFrameSequence = 0
        inputTurnReducerLock.unlock()
        firstInputFrameTraced = false
        firstModelPCMTraced = false
        firstPlaybackPrimed = false
        playbackRecoveryGeneration += 1
        updateReadiness { state in
            state.callKitManaged = callKitOwnsAudioSession
            state.beginSocketAttempt()
        }
        startAttemptLock.unlock()
        return true
    }

    private func acceptsStartAttempt(
        _ attempt: AlmaLiveVoiceStartAttemptState.Token
    ) -> Bool {
        startAttemptLock.lock()
        let accepts = startAttemptState.acceptsActive(attempt)
        startAttemptLock.unlock()
        return accepts
    }

    private func activeStartAttempt() -> AlmaLiveVoiceStartAttemptState.Token? {
        startAttemptLock.lock()
        let token = startAttemptState.activeToken
        startAttemptLock.unlock()
        return token
    }

    private func engineConnectionGeneration(
        for attempt: AlmaLiveVoiceStartAttemptState.Token
    ) -> Int? {
        startAttemptLock.lock()
        let generation = startAttemptState.acceptsActive(attempt)
            ? startAttemptEngineConnectionGeneration
            : nil
        startAttemptLock.unlock()
        return generation
    }

    private func dispatchEngineCallback(
        engineConnectionGeneration: Int,
        requiring socketAttempt: AlmaLiveVoiceSocketAttempt? = nil,
        _ callback: @escaping @MainActor (AlmaVoiceEngine) -> Void
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let engine = self.engine,
                  engine.acceptsLiveCallback(
                    connectionGeneration: engineConnectionGeneration)
            else { return }
            if let socketAttempt {
                guard self.isCurrentSocketAttempt(socketAttempt),
                      self.acceptsStartAttempt(socketAttempt.startAttempt)
                else { return }
            }
            callback(engine)
        }
    }

    private func dispatchEngineCallbackForActiveAttempt(
        _ callback: @escaping @MainActor (AlmaVoiceEngine) -> Void
    ) {
        guard let attempt = activeStartAttempt(),
              let generation = engineConnectionGeneration(for: attempt)
        else { return }
        dispatchEngineCallback(
            engineConnectionGeneration: generation,
            callback)
    }

    private func usesInputTurnReducer() -> Bool {
        inputTurnReducerLock.lock()
        let enabled = inputTurnReducerEnabled
        inputTurnReducerLock.unlock()
        return enabled
    }

    private func reduceInputTurn(
        generation: AlmaLiveVoiceStartAttemptState.Token,
        _ update: (inout AlmaLiveVoiceInputTurnReducer) -> AlmaLiveVoiceInputTurnReducer.Effects
    ) -> AlmaLiveVoiceInputTurnReducer.Effects {
        inputTurnReducerLock.lock()
        guard inputTurnReducerEnabled else {
            inputTurnReducerLock.unlock()
            return .none
        }
        let effects = update(&inputTurnReducer)
        inputTurnReducerLock.unlock()
        return effects
    }

    private func reduceCapturedInput(
        _ chunk: AlmaLiveVoiceCapturedInputPCM,
        rms: Double,
        hasOwnerEnergy: Bool,
        route: AlmaLiveVoiceInputTurnReducer.InputRoute,
        suppression: AlmaLiveVoiceInputTurnReducer.PlaybackSuppression,
        ownerSpeechConfirmed: Bool,
        attempt: AlmaLiveVoiceSocketAttempt
    ) -> AlmaLiveVoiceInputTurnReducer.Effects {
        inputTurnReducerLock.lock()
        guard inputTurnReducerEnabled else {
            inputTurnReducerLock.unlock()
            return .none
        }
        nextInputFrameSequence &+= 1
        if ownerSpeechConfirmed {
            _ = inputTurnReducer.observeLocalBargeIn(generation: attempt.startAttempt)
        } else if hasOwnerEnergy, suppression != .activePlayback {
            _ = inputTurnReducer.observeOwnerEnergy(generation: attempt.startAttempt)
        }
        let effects = inputTurnReducer.acceptAudioFrame(
            generation: attempt.startAttempt,
            sequence: nextInputFrameSequence,
            pcm: chunk,
            rms: rms,
            route: route,
            ready: true,
            suppression: suppression,
            ownerSpeechConfirmed: ownerSpeechConfirmed)
        inputTurnReducerLock.unlock()
        return effects
    }

    private func applyInputTurnEffects(
        _ effects: AlmaLiveVoiceInputTurnReducer.Effects,
        attempt: AlmaLiveVoiceSocketAttempt
    ) {
        if !effects.audioFramesToSend.isEmpty {
            sendCapturedInputChunks(
                effects.audioFramesToSend.map(\.pcm),
                sourceAttempt: attempt)
        }
        if effects.sendAudioStreamEnd {
            sendInputStreamEnd(sourceAttempt: attempt)
        }
        if let transcript = effects.transcriptUpdate {
            dispatchEngineCallback(
                engineConnectionGeneration: attempt.engineConnectionGeneration,
                requiring: attempt
            ) {
                $0.liveInputTranscriptSnapshot(
                    transcript.text,
                    finalized: transcript.finalized)
            }
        }
    }

    private func commitMintedSession(
        _ minted: SessionResponse,
        mintedAt date: Date,
        attempt: AlmaLiveVoiceStartAttemptState.Token
    ) -> Bool {
        startAttemptLock.lock()
        guard startAttemptState.acceptsActive(attempt) else {
            startAttemptLock.unlock()
            return false
        }
        mintedSession = minted
        mintedAt = date
        allowAffective = minted.affectiveDialog
            ?? (minted.model == AlmaLiveVoicePreferences.gemini25)
        startAttemptLock.unlock()
        return true
    }

    func start(attempt: AlmaLiveVoiceStartAttemptState.Token) async throws {
        try Task.checkCancellation()
        guard activateStartAttempt(attempt) else { throw CancellationError() }
        trace("transport.start", callKitOwnsAudioSession ? "callkit=1" : "callkit=0")
        guard let desiredProfile = profile(for: attempt) else {
            throw CancellationError()
        }
        let desiredModel = desiredProfile.modelID
        let desiredVoice = desiredProfile.voiceID
        if let warm = Self.takePrewarmed(),
           warm.session.model == desiredModel, warm.session.voice == desiredVoice {
            try Task.checkCancellation()
            guard commitMintedSession(
                warm.session,
                mintedAt: warm.at,
                attempt: attempt
            ) else { throw CancellationError() }
            #if DEBUG
            NSLog("ALMA-VOICE using prewarmed token (age %.1fs)", Date().timeIntervalSince(warm.at))
            #endif
            try connect(
                warm.session,
                resumptionHandle: nil,
                recoveryAttempt: false,
                startAttempt: attempt)
            return
        }
        await AlmaAPI.shared.syncCookies()
        try Task.checkCancellation()
        guard acceptsStartAttempt(attempt) else { throw CancellationError() }
        #if DEBUG
        let mintStart = Date()
        NSLog("ALMA-VOICE mint begin")
        #endif
        let raw = try await AssistantNet.postJSONForData(
            path: "/api/assistant/live-session",
            body: ["model": desiredModel, "voice": desiredVoice])
        try Task.checkCancellation()
        guard acceptsStartAttempt(attempt) else { throw CancellationError() }
        #if DEBUG
        NSLog("ALMA-VOICE mint done in %.2fs", Date().timeIntervalSince(mintStart))
        #endif
        guard let minted = try? JSONDecoder().decode(SessionResponse.self, from: raw),
              !minted.token.isEmpty else { throw AlmaLiveVoiceError.badSession }
        guard commitMintedSession(
            minted,
            mintedAt: Date(),
            attempt: attempt
        ) else { throw CancellationError() }
        try connect(
            minted,
            resumptionHandle: nil,
            recoveryAttempt: false,
            startAttempt: attempt)
    }

    private func connect(
        _ minted: SessionResponse,
        resumptionHandle: String?,
        recoveryAttempt: Bool,
        startAttempt: AlmaLiveVoiceStartAttemptState.Token
    ) throws {
        guard var parts = URLComponents(string: minted.websocketUrl) else { throw AlmaLiveVoiceError.badURL }
        parts.queryItems = (parts.queryItems ?? []) + [URLQueryItem(name: "access_token", value: minted.token)]
        guard let url = parts.url else { throw AlmaLiveVoiceError.badURL }

        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 60
        cfg.timeoutIntervalForResource = 60 * 60
        let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        let socket = s.webSocketTask(with: url)

        // Stop and socket publication are serialized here. If stop wins, this
        // local task is discarded; if publication wins, stop observes and
        // cancels the exact newly-published socket before returning.
        startAttemptLock.lock()
        guard startAttemptState.acceptsActive(startAttempt),
              let engineConnectionGeneration = startAttemptEngineConnectionGeneration
        else {
            startAttemptLock.unlock()
            s.invalidateAndCancel()
            throw CancellationError()
        }
        let evidenceGeneration = beginEvidenceTransport(resuming: resumptionHandle != nil)
        session = s
        ws = socket
        socketStartAttempt = startAttempt
        bindEvidenceSocket(socket, generation: evidenceGeneration)
        let attempt = bindRuntimeSocketAttempt(
            socket,
            evidenceGeneration: evidenceGeneration,
            startAttempt: startAttempt,
            engineConnectionGeneration: engineConnectionGeneration,
            recoveryAttempt: recoveryAttempt,
            resumptionRequested: resumptionHandle != nil)
        pendingResumptionHandle = resumptionHandle
        socket.resume()
        receiveLoop(socket, attempt: attempt)
        startAttemptLock.unlock()
    }

    private func setupMessage(model: String, voice: String, resumptionHandle: String?) -> [String: Any] {
        let instruction = """
        **Persona**
        তুমি ALMA — Boss-এর ব্যক্তিগত AI সহকারী, এখন Boss-এর সাথে ফোন কলে। unmistakably প্রমিত বাংলাদেশি বাংলা ও বাংলাদেশি উচ্চারণে একজন মনোযোগী, উষ্ণ, স্বাভাবিক মানুষের মতো কথা বলবে; হিন্দি বা ভারতীয় বাংলা টান আনবে না। কণ্ঠকে scripted announcer বা customer-service bot-এর মতো শোনাবে না।

        **Conversation**
        Boss কী বলছে এবং যে আবেগে বলছে—দুটোই শুনে delivery স্বাভাবিকভাবে মিলাবে। দুঃখ বা খারাপ খবরে আন্তরিক ও নরম হবে; চাপ, রাগ বা হতাশায় শান্ত ও স্থির হবে; সুখবর বা রসিকতায় স্বতঃস্ফূর্ত উষ্ণতা থাকবে। জোর করে হাসি, আশাবাদ, উপদেশ, “হুম”, দীর্ঘশ্বাস বা অভিনয় করবে না।
        একবারে একটি সম্পূর্ণ ভাব conversationalভাবে বলবে, তারপর স্বাভাবিকভাবে থেমে শুনবে। Boss কথা শুরু করলেই বাক্য শেষ করার চেষ্টা না করে সঙ্গে সঙ্গে চুপ করবে। Boss-এর কথা প্রশ্নের মতো পুনরাবৃত্তি করবে না, ফাঁকা ভূমিকা দেবে না, এবং প্রতিটি উত্তরের শেষে “আর কিছু জানতে চান?”, “কেমন হলো?”, “ঠিক আছে?” ধরনের অভ্যাসগত প্রশ্ন করবে না। তথ্য কম থাকলেই শুধু একটি ছোট clarification প্রশ্ন করবে।

        **Tool flow**
        কখন নিজে উত্তর দেবে: সালাম, কুশল, হালকা গল্প, মতামত, সাধারণ জ্ঞান — সাথে সাথে নিজেই ছোট করে উত্তর দেবে; কোনো tool ডাকবে না, দেরি করবে না।
        কখন quick_erp_lookup: আজকের হাজিরা, বিক্রি, অর্ডার, স্টক, নামাজ, পেন্ডিং অনুমোদন — এমন নির্দিষ্ট read-only তথ্য-প্রশ্নে সরাসরি quick_erp_lookup চালাবে (কয়েক সেকেন্ডে ফল আসে), আগে ছোট্ট ack বলবে। কখন run_agent_turn: quick_erp_lookup-এর নির্দিষ্ট তালিকার বাইরে হিসাব/বিশ্লেষণ, রিপোর্ট, মেমরি, বা কোনো কাজ করা/পরিবর্তনের অনুরোধে run_agent_turn ঠিক একবার চালাবে, আর ডাকার ঠিক আগে নিজের ভাষায় ছোট্ট এক কথায় জানাবে যে বিষয়টা দেখছ — প্রতিবার ভিন্নভাবে বলবে, বাঁধা বুলি নয়। ব্যবসার তথ্য বা হিসাব কখনো নিজে বানাবে না। run_agent_turn-এর request সবসময় Boss-এর নিজের ভাষায় (বাংলা/বাংলিশ) হুবহু দেবে — ইংরেজিতে অনুবাদ করলে ভেতরের রাউটিং ভুল মডেলে যায়।
        Boss স্পষ্টভাবে কলটি শেষ করতে চাইলে ("ফোন রাখো", "কল কাটো", "এখন রাখি", বিদায়ী সালাম "আল্লাহ হাফেজ"): এক ছোট্ট বাক্যে সালাম-বিদায় বলবে এবং সাথে সাথে end_call চালাবে — শুধু মুখে বিদায় বললে কল কাটে না। সাবধান: কিছু মনে রাখতে বা সেভ করতে বলা (যেমন "এই কথাটা মনে রেখে দাও") কল রাখার অনুরোধ নয় — তখন end_call একদম নয়।
        ভেতরের শব্দ মুখে আনবে না: tool, function, acknowledgement, system, agent — এগুলো কখনো উচ্চারণ করবে না।
        Boss-এর কথা সত্যিই অস্পষ্ট হলে কেবল তখনই ছোট প্রশ্নে পরিষ্কার করে নেবে; পরিষ্কার অনুরোধে পাল্টা নিশ্চিতকরণ প্রশ্ন করবে না — ছোট্ট এক কথা বলে সাথে সাথে run_agent_turn চালাবে। ack বলার পর tool চালানো কখনো ভুলবে না।
        Approval মানে কাজ শেষ নয় — result-এ completed/reportReady না বললে বলবে কাজ চলছে।
        **Guardrails**
        মালিককে শুধু "Boss" বলবে, তবে প্রতি বাক্যে নয়। ভয়েসে emoji পড়বে না; ইসলামি আদব বজায় রাখবে। ব্যবসা, টাকা বা গুরুতর বিষয়ে পরিষ্কার ও পেশাদার থাকবে। প্রচলিত technical শব্দ ইংরেজিতে বলা স্বাভাবিক হলে বলবে, কিন্তু বাক্যের গঠন বাংলা রাখবে। লিখিত রিপোর্ট বা তালিকা আবৃত্তি করবে না—Boss চাইলে তবেই তালিকা দেবে।
        """
        let resumption: [String: Any] = resumptionHandle.map { ["handle": $0] } ?? [:]
        var generationConfig: [String: Any] = [
            "responseModalities": ["AUDIO"],
            "temperature": 0.7,
            "speechConfig": [
                "voiceConfig": ["prebuiltVoiceConfig": ["voiceName": voice]],
            ],
        ]
        if let thinking = AlmaLiveVoicePreferences.activeContract?
            .model(id: model)?.capabilities.thinking {
            generationConfig["thinkingConfig"] = thinking.mode == "budget"
                ? ["thinkingBudget": thinking.budget ?? 0]
                : ["thinkingLevel": thinking.level ?? "MINIMAL"]
        } else {
            generationConfig["thinkingConfig"] = model == AlmaLiveVoicePreferences.gemini25
                ? ["thinkingBudget": 0]
                : ["thinkingLevel": "MINIMAL"]
        }
        // Gemini's raw Live websocket schema nests this under generationConfig.
        // Sending it at the setup root closes the socket with 1007 and silently
        // downgrades the whole call to non-affective speech.
        if allowAffective { generationConfig["enableAffectiveDialog"] = true }
        let contextWindowCompression: [String: Any]
        if let compression = AlmaLiveVoicePreferences.activeContract?.contextCompression {
            contextWindowCompression = [
                "triggerTokens": String(compression.triggerTokens),
                "slidingWindow": ["targetTokens": String(compression.targetTokens)],
            ]
        } else {
            contextWindowCompression = ["slidingWindow": [:]]
        }
        var setup: [String: Any] = [
            "model": model.hasPrefix("models/") ? model : "models/\(model)",
            "generationConfig": generationConfig,
            "systemInstruction": ["parts": [["text": instruction]]],
            "inputAudioTranscription": [:],
            "outputAudioTranscription": [:],
            "sessionResumption": resumption,
            "contextWindowCompression": contextWindowCompression,
            "realtimeInputConfig": [
                "automaticActivityDetection": [
                    "disabled": false,
                    "startOfSpeechSensitivity": "START_SENSITIVITY_LOW",
                    "endOfSpeechSensitivity": "END_SENSITIVITY_LOW",
                    "prefixPaddingMs": 250,
                    "silenceDurationMs": 1200,
                ],
                "activityHandling": "START_OF_ACTIVITY_INTERRUPTS",
                "turnCoverage": "TURN_INCLUDES_ONLY_ACTIVITY",
            ],
            "tools": [["functionDeclarations": [[
                "name": "quick_erp_lookup",
                "description": "সাধারণ ব্যবসার তথ্য কয়েক সেকেন্ডে দেখার দ্রুত পথ — আজকের হাজিরা/উপস্থিতি (get_attendance), বিক্রির সারাংশ (get_sales_summary), অর্ডার তালিকা (get_orders), ব্যবসার সার্বিক চিত্র (get_dashboard_snapshot), স্টক (get_inventory_status), নামাজের অবস্থা (get_salah_status), পেন্ডিং অনুমোদন (get_pending_approvals), নামাজের সময় (get_prayer_times)। শুধু তথ্য পড়া — কোনো কাজ, পরিবর্তন, বার্তা পাঠানো বা মেমরি নয়।",
                "parameters": [
                    "type": "OBJECT",
                    "properties": ["tool": [
                        "type": "STRING",
                        "enum": ["get_attendance", "get_sales_summary", "get_orders", "get_dashboard_snapshot", "get_inventory_status", "get_salah_status", "get_pending_approvals", "get_prayer_times"],
                    ]],
                    "required": ["tool"],
                ],
            ], [
                "name": "end_call",
                "description": "কলটি সত্যিই কেটে দেয়। Boss 'রাখি/রেখে দাও/কল কাটো/আল্লাহ হাফেজ' বলে কল শেষ করতে চাইলে — ছোট্ট সালাম-বিদায় বলার সাথে সাথে এটা চালাবে। মুখে বিদায় বললে কল কাটে না; এই tool না চালালে Boss-কে নিজ হাতে কাটতে হয়।",
                "parameters": ["type": "OBJECT", "properties": [:]],
            ], [
                "name": "run_agent_turn",
                "description": "Boss-এর অনুরোধ ALMA head agent-এ পাঠায় — শুধু কাজ করা, কিছু পাঠানো/পরিবর্তন, অনুমোদন, মেমরি বা জটিল বিশ্লেষণের জন্য। সাধারণ তথ্য দেখার জন্য এটা নয় — সেগুলোতে quick_erp_lookup ব্যবহার করবে (অনেক দ্রুত)। request-টি Boss-এর কথার হুবহু বাংলা/বাংলিশ রূপে দেবে — ইংরেজিতে অনুবাদ একদম নয়।",
                "parameters": [
                    "type": "OBJECT",
                    "properties": ["request": ["type": "STRING"]],
                    "required": ["request"],
                ],
            ]]]],
        ]
        return ["setup": setup]
    }

    private func configureAudio(for attempt: AlmaLiveVoiceSocketAttempt) throws {
        try audioQueue.sync {
            // This check runs on the same serial queue as terminal graph
            // teardown. Configuration therefore either completes first and is
            // torn down next, or observes the invalidated token and does not
            // touch AVAudioSession at all.
            guard acceptsStartAttempt(attempt.startAttempt),
                  isCurrentSocketAttempt(attempt)
            else { throw CancellationError() }
            try configureAudioOnQueue(for: attempt)
        }
    }

    /// Socket is live AND audio is running — announce the connection once.
    private func finishSetup(for attempt: AlmaLiveVoiceSocketAttempt) {
        startAttemptLock.lock()
        guard startAttemptState.acceptsActive(attempt.startAttempt),
              isCurrentSocketAttempt(attempt),
              canPublishSocketSetup(attempt)
        else {
            startAttemptLock.unlock()
            return
        }
        trace("setup.live", audioSessionDescription())
        #if DEBUG
        NSLog("ALMA-VOICE setup finished — session LIVE (audio configured)")
        #endif
        audioConfigPending = false
        submitEvidenceSync { recorder in
            recorder.activateProfile(
                modelID: mintedSession?.model ?? AlmaLiveVoicePreferences.modelID,
                voiceID: mintedSession?.voice ?? AlmaLiveVoicePreferences.voiceID,
                generation: attempt.evidenceGeneration)
            recorder.recordAudioGraphReady(
                generation: attempt.evidenceGeneration,
                route: evidenceRoute())
        }
        guard publishSocketReady(attempt) else {
            startAttemptLock.unlock()
            return
        }
        reconnecting = false
        reconnectAttempts = 0
        startKeepalive(for: attempt)
        dispatchEngineCallback(
            engineConnectionGeneration: attempt.engineConnectionGeneration,
            requiring: attempt
        ) { $0.liveDidConnect() }
        if !hasConnectedOnce {
            hasConnectedOnce = true
            sendRealtimeText("Boss-কে সময় অনুযায়ী খুব সংক্ষিপ্ত বাংলায় অভিবাদন জানিয়ে বলুন, কী করতে হবে। কোনো tool চালাবেন না।")
        }
        startAttemptLock.unlock()
        drainToolResponses()
    }

    /// CallKit activated the shared audio session (CXProviderDelegate didActivate).
    /// Start (or retry) capture/playback now that the session is really ours.
    func callKitAudioActivated(
        lifecycleEvidenceContext: AlmaLiveVoiceLifecycleEvidenceContext,
        lifecycleEvidenceSubmittedAtSource: Bool
    ) {
        guard !stopped, callKitOwnsAudioSession else { return }
        if !lifecycleEvidenceSubmittedAtSource {
            recordLifecycleEvidence(
                .callKitAudioActivated,
                context: lifecycleEvidenceContext)
        }
        trace("media.callkitActivated", audioSessionDescription())
        let gate = updateReadiness { $0.callKitAudioActive = true }
        // Activation can arrive before microphone permission and socket setup.
        // Remember it, but never build/start media early: startLiveConnection()
        // deliberately resets a previous socket attempt.
        guard gate.socketSetupComplete, let attempt = gate.socketAttempt else { return }
        if configured {
            // Activation landed AFTER audio setup. CallKit's activation resets
            // the output route (first call ends up on the RECEIVER — near
            // silent on a table) and a background-started engine may have died
            // — previously this path did NOTHING and the only recovery was the
            // app-foreground hook, which is exactly why the call only spoke
            // once the calling screen appeared (owner device 2026-07-31).
            do {
                try resumeAudioGraphAfterActivation(for: attempt)
                finishSetup(for: attempt)
                nudgeSpeakerRoute()
            } catch {
                guard acceptsStartAttempt(attempt.startAttempt),
                      isCurrentSocketAttempt(attempt)
                else { return }
                // Never publish LIVE when CallKit activated but the render unit
                // failed to reacquire hardware. Rebuild the graph through the
                // existing bounded retry path instead of leaving a silent timer.
                configured = false
                updateReadiness { $0.audioConfigured = false }
                _ = deferSocketSetupForCallKit(attempt)
                scheduleCallKitAudioRetry(for: attempt, retry: 1, lastError: error)
                return
            }
            // Mirror recoverAudio(): a mid-turn activation can stop the PLAYER
            // even when the engine restarts — without play() the queued
            // greeting stays silent until its watchdog expires (Codex P2).
            audioLock.lock()
            let shouldPlay = playbackStarted
            audioLock.unlock()
            audioQueue.async { [weak self, attempt] in
                guard let self, !self.stopped,
                      self.acceptsStartAttempt(attempt.startAttempt),
                      self.isCurrentSocketAttempt(attempt)
                else { return }
                if shouldPlay, !self.player.isPlaying { self.player.play() }
            }
            return
        }
        do {
            try configureAudio(for: attempt)
            // didActivate normally arrives BEFORE the socket's setupComplete.
            // Only finish the session when setup was already waiting on audio —
            // otherwise finishSetup() would announce a live call with ws == nil,
            // cancel the in-flight connect task and lose the greeting/brief.
            if gate.pendingCallKitAttempt == attempt || audioConfigPending {
                finishSetup(for: attempt)
            }
        } catch {
            _ = deferSocketSetupForCallKit(attempt)
            scheduleCallKitAudioRetry(for: attempt, retry: 1, lastError: error)
        }
    }

    /// CallKit may deactivate an otherwise live call for an interruption or
    /// route hand-off. Preserve queued audio, but pause hardware rendering until
    /// the matching didActivate arrives; never self-activate a CallKit session.
    func callKitAudioDeactivated(
        lifecycleEvidenceContext: AlmaLiveVoiceLifecycleEvidenceContext,
        lifecycleEvidenceSubmittedAtSource: Bool
    ) {
        guard callKitOwnsAudioSession else { return }
        if !lifecycleEvidenceSubmittedAtSource {
            recordLifecycleEvidence(
                .callKitAudioDeactivated,
                context: lifecycleEvidenceContext)
        }
        trace("media.callkitDeactivated")
        let gate = updateReadiness { $0.callKitAudioActive = false }
        audioConfigPending = gate.socketSetupComplete
        if let attempt = gate.socketAttempt, gate.socketSetupComplete {
            _ = deferSocketSetupForCallKit(attempt)
        }
        audioQueue.async { [weak self] in
            guard let self, !self.stopped else { return }
            if self.player.isPlaying { self.player.pause() }
            if self.audioEngine.isRunning { self.audioEngine.pause() }
        }
    }

    private func resumeAudioGraphAfterActivation(
        for attempt: AlmaLiveVoiceSocketAttempt
    ) throws {
        try audioQueue.sync {
            guard !stopped, configured,
                  acceptsStartAttempt(attempt.startAttempt),
                  isCurrentSocketAttempt(attempt)
            else { throw AlmaLiveVoiceError.audioStart }
            // `isRunning` can remain true across a CallKit hardware hand-off
            // while the render unit is no longer attached. Pause/start forces a
            // fresh render-resource acquisition without clearing player buffers.
            if audioEngine.isRunning { audioEngine.pause() }
            audioEngine.prepare()
            try audioEngine.start()
        }
    }

    /// Put the call back on the speaker if the OS quietly re-routed it to the
    /// receiver (VP init and CallKit activation both do this). Safe to call any
    /// time; no-op when the owner deliberately turned the speaker off.
    func nudgeSpeakerRoute() {
        guard configured, !stopped else { return }
        enforceRequestedRoute(reason: "nudge")
    }

    private func handleAudioRouteChange(_ notification: Notification? = nil) {
        guard configured, !stopped else { return }
        let av = AVAudioSession.sharedInstance()
        let reasonRaw = notification?.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        let outputs = av.currentRoute.outputs
        let onSpeaker = outputs.contains { $0.portType == .builtInSpeaker }
        let onReceiver = outputs.contains { $0.portType == .builtInReceiver }
        if evidenceRecorder.isEnabled {
            let generation = evidenceTransportGenerationSnapshot()
            let route = evidenceRoute(av)
            let reason: AlmaLiveVoiceEvidenceRouteReason = notification == nil
                ? .verification
                : .systemNotification
            _ = submitEvidence { recorder in
                recorder.recordAudioRouteChanged(
                    generation: generation,
                    route: route,
                    reason: reason)
            }
        }

        audioLock.lock()
        let bootstrapProtected = Date() < bootstrapRouteProtectionUntil
        let nativeCallKitSelection = callKitOwnsAudioSession
            && !bootstrapProtected
            && (onSpeaker || onReceiver)
        if nativeCallKitSelection { speakerEnabled = onSpeaker }
        audioLock.unlock()

        if nativeCallKitSelection {
            // The system CallKit screen has no CXProvider speaker callback. Its
            // only public signal is the actual AVAudioSession route. iOS does not
            // reliably report the locked-screen button as reason `.override`, so
            // adopt every post-bootstrap built-in route instead of fighting it.
            trace("route.callkitSelection", "want=\(onSpeaker ? "speaker" : "receiver") "
                  + "reason=\(reasonRaw ?? 0) " + audioSessionDescription(av))
            publishCurrentAudioRoute()
            return
        }
        trace("route.changed", "reason=\(reasonRaw ?? 0) protected=\(bootstrapProtected ? 1 : 0) "
              + audioSessionDescription(av))
        enforceRequestedRoute(reason: "routeChange")
    }

    private func enforceRequestedRoute(reason: String) {
        audioLock.lock()
        let wantSpeaker = speakerEnabled
        audioLock.unlock()
        let av = AVAudioSession.sharedInstance()
        let outputs = av.currentRoute.outputs
        let onSpeaker = outputs.contains { $0.portType == .builtInSpeaker }
        let onReceiver = outputs.contains { $0.portType == .builtInReceiver }
        if (wantSpeaker && onReceiver) || (!wantSpeaker && onSpeaker) {
            try? av.overrideOutputAudioPort(wantSpeaker ? .speaker : .none)
        }
        trace("route.enforce", "reason=\(reason) want=\(wantSpeaker ? "speaker" : "receiver") "
              + audioSessionDescription(av))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
            self?.verifyRequestedRoute(attempt: 1)
        }
    }

    private func verifyRequestedRoute(attempt: Int) {
        guard configured, !stopped else { return }
        audioLock.lock()
        let wantSpeaker = speakerEnabled
        audioLock.unlock()
        let av = AVAudioSession.sharedInstance()
        let outputs = av.currentRoute.outputs
        let onSpeaker = outputs.contains { $0.portType == .builtInSpeaker }
        let onReceiver = outputs.contains { $0.portType == .builtInReceiver }
        // Bluetooth/wired/AirPlay routes are legitimate and must not be replaced
        // with a built-in route merely because neither built-in port is present.
        let usingBuiltIn = onSpeaker || onReceiver
        let matched = !usingBuiltIn || (wantSpeaker ? onSpeaker : onReceiver)
        if matched {
            trace("route.verified", "attempt=\(attempt) want=\(wantSpeaker ? "speaker" : "receiver") "
                  + audioSessionDescription(av))
            publishCurrentAudioRoute()
            return
        }
        trace("route.mismatch", "attempt=\(attempt) want=\(wantSpeaker ? "speaker" : "receiver") "
              + audioSessionDescription(av))
        guard attempt < 4 else {
            publishCurrentAudioRoute()
            return
        }
        // Remove any defaultToSpeaker category left by dictation/intercom, then
        // re-apply the explicit temporary override. `.none` now resolves to the
        // receiver for a built-in route.
        if av.category != .playAndRecord || av.mode != .voiceChat
            || av.categoryOptions.contains(.defaultToSpeaker) {
            try? av.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
        }
        try? av.overrideOutputAudioPort(wantSpeaker ? .speaker : .none)
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(attempt) * 0.16) { [weak self] in
            self?.verifyRequestedRoute(attempt: attempt + 1)
        }
    }

    private func publishCurrentAudioRoute() {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        let speaker = outputs.contains { $0.portType == .builtInSpeaker }
        let receiver = outputs.contains { $0.portType == .builtInReceiver }
        trace("route.publish", "speaker=\(speaker ? 1 : 0) receiver=\(receiver ? 1 : 0) "
              + audioSessionDescription())
        dispatchEngineCallbackForActiveAttempt {
            $0.liveAudioRouteChanged(speaker: speaker, receiver: receiver)
        }
    }

    /// Caller holds `audioLock`. This resets detector state only; restoring the
    /// player's volume is deliberately queued after the lock is released.
    private func resetLoudspeakerProbeLocked(cooldown: Bool = false) {
        loudspeakerProbeActive = false
        loudspeakerProbeCandidateFrames = 0
        loudspeakerProbeCandidatePeakRMS = 0
        loudspeakerProbeDuckAppliedAt = .distantPast
        loudspeakerProbeVoiceFrames = 0
        loudspeakerProbeCooldownFrames = cooldown
            ? loudspeakerProbeCooldownRequiredFrames
            : 0
    }

    /// Caller holds `audioLock`.
    private func resetPlaybackReferenceLocked(clearHistory: Bool = true) {
        if clearHistory {
            playbackReferenceHistory.removeAll(keepingCapacity: true)
            playbackReferenceWaveHistory.removeAll(keepingCapacity: true)
        }
        playbackReferenceEchoCorrelation = 0
        playbackReferenceEchoCorrelationFrames = 0
        playbackReferenceReadyFrames = 0
        playbackReferenceSpeechFrames = 0
        bargeInEvidenceTraceFrames = 0
    }

    private static func correlationSamples(_ buffer: AVAudioPCMBuffer,
                                           targetCount: Int = 192) -> [Float] {
        let frames = Int(buffer.frameLength)
        guard frames > 0, let channels = buffer.floatChannelData else { return [] }
        let channelCount = max(1, Int(buffer.format.channelCount))
        let stride = max(1, frames / targetCount)
        var result: [Float] = []
        result.reserveCapacity(min(targetCount, frames))
        var start = 0
        while start < frames {
            let end = min(frames, start + stride)
            var total: Float = 0
            for channel in 0..<channelCount {
                for frame in start..<end { total += channels[channel][frame] }
            }
            result.append(total / Float((end - start) * channelCount))
            start = end
        }
        return result
    }

    /// Caller holds `audioLock`. Compare the current microphone waveform with
    /// every recently rendered frame. The maximum absorbs the physical
    /// speaker-to-microphone delay; a pure echo keeps a high match, while a
    /// nearby second speaker (double-talk) breaks it.
    private func recentPlaybackCorrelationLocked(micSamples: [Float],
                                                 now: TimeInterval) -> Double {
        guard !micSamples.isEmpty else { return 0 }
        let newest = now - 0.015
        let oldest = now - playbackReferenceHistorySeconds
        var best = 0.0
        for frame in playbackReferenceWaveHistory
            where frame.capturedAt >= oldest && frame.capturedAt <= newest {
            best = max(best, AlmaLiveBargeInEvidence.normalizedCorrelation(
                micSamples, frame.samples))
        }
        return best
    }

    private func configureSoundAnalysis(format: AVAudioFormat) {
        soundAnalyzer?.completeAnalysis()
        soundAnalyzer = nil
        soundRequest = nil
        soundObserver = nil
        soundAnalysisFramePosition = 0
        do {
            let analyzer = SNAudioStreamAnalyzer(format: format)
            let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
            // Apple's built-in model allows a 500ms minimum window. Heavy
            // overlap refreshes evidence every ~100ms after the first result.
            request.windowDuration = CMTime(seconds: 0.5, preferredTimescale: 16_000)
            request.overlapFactor = 0.8
            let observer = AlmaLiveSoundObserver { [weak self] speech, music, noise in
                guard let self else { return }
                self.audioLock.lock()
                self.soundSpeechConfidence = speech
                self.soundMusicConfidence = music
                self.soundNoiseConfidence = noise
                self.soundClassificationAt = Date()
                self.audioLock.unlock()
            }
            try analyzer.add(request, withObserver: observer)
            soundAnalyzer = analyzer
            soundRequest = request
            soundObserver = observer
            AlmaVoiceAudioTrace.event("bargeIn.classifier.ready", "windowMs=500 overlap=0.8")
        } catch {
            AlmaVoiceAudioTrace.event("bargeIn.classifier.unavailable",
                                      String(describing: error).prefix(120).description)
            #if DEBUG
            NSLog("ALMA-VOICE sound classifier unavailable: %@", String(describing: error))
            #endif
        }
    }

    /// Caller holds `audioLock`. Use the strongest recently rendered frame so
    /// callback jitter and the physical speaker-to-microphone delay cannot make
    /// ALMA's own syllable look like unexplained human energy.
    private func recentPlaybackReferenceRMSLocked(now: TimeInterval) -> Double {
        let cutoff = now - playbackReferenceHistorySeconds
        while let first = playbackReferenceHistory.first,
              first.capturedAt < cutoff {
            playbackReferenceHistory.removeFirst()
        }
        return playbackReferenceHistory.reduce(0) { max($0, $1.rms) }
    }

    private func capturePlaybackReference(
        _ buffer: AVAudioPCMBuffer,
        sourceStartAttempt: AlmaLiveVoiceStartAttemptState.Token
    ) {
        audioLock.lock()
        let sourceIsCurrent = captureSocketAttempt?.startAttempt == sourceStartAttempt
        let needsNoAECDetector = voiceProcessingUnavailable && speakerEnabled
        audioLock.unlock()
        guard !stopped, sourceIsCurrent, needsNoAECDetector else { return }
        let frames = Int(buffer.frameLength)
        guard frames > 0, let channels = buffer.floatChannelData else { return }
        let channelCount = max(1, Int(buffer.format.channelCount))
        var sum = 0.0
        for channel in 0..<channelCount {
            for frame in 0..<frames {
                let sample = Double(channels[channel][frame])
                sum += sample * sample
            }
        }
        let rms = (sum / Double(frames * channelCount)).squareRoot()
        let wave = Self.correlationSamples(buffer)
        let capturedAt = ProcessInfo.processInfo.systemUptime
        audioLock.lock()
        guard captureSocketAttempt?.startAttempt == sourceStartAttempt else {
            audioLock.unlock()
            return
        }
        playbackReferenceHistory.append((capturedAt: capturedAt, rms: rms))
        if !wave.isEmpty {
            playbackReferenceWaveHistory.append((capturedAt: capturedAt, samples: wave))
        }
        let cutoff = capturedAt - playbackReferenceHistorySeconds
        while let first = playbackReferenceHistory.first,
              first.capturedAt < cutoff {
            playbackReferenceHistory.removeFirst()
        }
        while let first = playbackReferenceWaveHistory.first,
              first.capturedAt < cutoff {
            playbackReferenceWaveHistory.removeFirst()
        }
        if rms >= playbackReferenceMinimumRMS {
            playbackReferenceReadyFrames = min(
                playbackReferenceReadyRequiredFrames,
                playbackReferenceReadyFrames + 1)
        }
        audioLock.unlock()
    }

    /// Short, soft volume-only duck: enough attenuation to distinguish echo,
    /// without the audible full-silence gaps caused by the old frame-based probe.
    /// Measurement is armed only AFTER audioQueue confirms the duck was applied;
    /// otherwise the next mic frame can still contain full-volume echo and falsely
    /// confirm ALMA's own voice as human speech. It never pauses/stops the graph,
    /// blocks the real-time capture callback, or touches CallKit's audio route.
    private func setLoudspeakerProbeMuted(_ muted: Bool) {
        audioQueue.async { [weak self] in
            guard let self, !self.stopped else { return }
            self.player.volume = muted ? self.loudspeakerProbeDuckVolume : 1
            self.audioLock.lock()
            if muted, self.loudspeakerProbeActive {
                self.loudspeakerProbeDuckAppliedAt = Date()
            } else {
                self.loudspeakerProbeDuckAppliedAt = .distantPast
            }
            self.audioLock.unlock()
            #if DEBUG
            NSLog("ALMA-VOICE loudspeaker probe volume %@ level=%.2f",
                  muted ? "ducked" : "restored", self.player.volume)
            #endif
        }
    }

    /// CallKit still owns activation, so never self-activate (that is what broke
    /// build 89). Re-attempt the category + engine start for ~10 s — a locked-
    /// screen answer can deliver didActivate several seconds late, and giving up
    /// at 3.6 s (3 tries) declared "audio failed" on calls that were about to
    /// work. If audio truly cannot start, fail with the UNDERLYING error so the
    /// device note finally says why (build 91's note was just the generic line).
    private func scheduleCallKitAudioRetry(
        for socketAttempt: AlmaLiveVoiceSocketAttempt,
        retry: Int,
        lastError: Error? = nil
    ) {
        let initialGate = readinessSnapshot()
        guard initialGate.socketAttempt == socketAttempt else { return }
        guard !initialGate.callKitManaged || initialGate.callKitAudioActive else {
            audioConfigPending = initialGate.socketSetupComplete
            _ = deferSocketSetupForCallKit(socketAttempt)
            return
        }
        guard retry <= 8 else {
            let detail = lastError.map { String(String(describing: $0).prefix(140)) } ?? "no didActivate"
            fail(
                "লাইভ অডিও চালু করা যায়নি। [\(detail)]",
                ifCurrentSocketAttempt: socketAttempt)
            return
        }
        let generation = audioAttemptGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            guard let self, !self.stopped, !self.configured,
                  generation == self.audioAttemptGeneration else { return }
            let gate = self.readinessSnapshot()
            guard gate.socketAttempt == socketAttempt else { return }
            guard !gate.callKitManaged || gate.callKitAudioActive else {
                self.audioConfigPending = gate.socketSetupComplete
                _ = self.deferSocketSetupForCallKit(socketAttempt)
                return
            }
            do {
                try self.configureAudio(for: socketAttempt)
                if gate.pendingCallKitAttempt == socketAttempt || self.audioConfigPending {
                    self.finishSetup(for: socketAttempt)
                }
            } catch {
                guard self.acceptsStartAttempt(socketAttempt.startAttempt),
                      self.isCurrentSocketAttempt(socketAttempt)
                else { return }
                self.scheduleCallKitAudioRetry(
                    for: socketAttempt,
                    retry: retry + 1,
                    lastError: error)
            }
        }
    }

    private func configureAudioOnQueue(
        for socketAttempt: AlmaLiveVoiceSocketAttempt
    ) throws {
        guard !configured else { return }
        trace("graph.configure.begin", audioSessionDescription())
        // A previous PARTIAL attempt (engine.start threw after the tap went in)
        // must not leave its tap behind: AVAudioEngine allows one tap per bus,
        // so retrying with a stale tap raises an Objective-C exception and
        // kills the app (review-bot P1 #3 on PR #653).
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        if playbackReferenceTapInstalled {
            audioEngine.mainMixerNode.removeTap(onBus: 0)
            playbackReferenceTapInstalled = false
        }
        let av = AVAudioSession.sharedInstance()
        // Ownership split mirrors AgoraIntercom.configureAudioSession: the APP
        // always owns the CATEGORY (a cold-launch answer leaves the session on
        // its default category, which makes inputNode unavailable), and only
        // ACTIVATION belongs to CallKit — calling setActive(true) there fought
        // the framework and left the answered call silent (build 89).
        // Do not use `.defaultToSpeaker`: clearing a temporary speaker override
        // with `.none` would otherwise route straight back to the default
        // speaker, making the receiver button impossible to implement.
        try av.setCategory(.playAndRecord, mode: .voiceChat,
                           options: [.allowBluetoothHFP])
        try? av.setPreferredIOBufferDuration(0.02)
        if !callKitOwnsAudioSession {
            try av.setActive(true)
        }
        audioLock.lock()
        let useSpeaker = speakerEnabled
        audioLock.unlock()
        try? av.overrideOutputAudioPort(useSpeaker ? .speaker : .none)

        let input = audioEngine.inputNode
        // Voice processing (echo cancellation) is BEST-EFFORT under CallKit: the
        // framework already owns/configured the session, and on the owner's
        // device enabling VP there failed — which used to abort the whole call
        // ("ring হয় but কথা বলে না", builds 89/90). A call without hardware AEC
        // still works (the barge-in gate calibrates its own echo floor), so only
        // the non-CallKit path treats VP as mandatory.
        #if targetEnvironment(simulator)
        // Simulator VPIO delivers ZERO input frames (Mac mic never reaches the
        // tap), which silently breaks the whole real-audio harness. Skip VP on
        // the sim only — the barge-in gate already has the no-AEC compensation.
        voiceProcessingUnavailable = true
        #else
        voiceProcessingUnavailable = false
        do { try input.setVoiceProcessingEnabled(true) } catch {
            if !callKitOwnsAudioSession { throw AlmaLiveVoiceError.audioStart }
            voiceProcessingUnavailable = true
        }
        if !(input.isVoiceProcessingEnabled && audioEngine.outputNode.isVoiceProcessingEnabled) {
            if !callKitOwnsAudioSession { throw AlmaLiveVoiceError.audioStart }
            voiceProcessingUnavailable = true
        }
        #endif
        let native = input.inputFormat(forBus: 0)
        guard native.sampleRate > 0, native.channelCount > 0 else { throw AlmaLiveVoiceError.noMic }
        guard let pcm16 = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000,
                                        channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: native, to: pcm16) else {
            throw AlmaLiveVoiceError.noConverter
        }
        inputConverter = converter
        inputFormat = pcm16

        guard let playback = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1) else {
            throw AlmaLiveVoiceError.audioStart
        }
        playbackFormat = playback
        configureSoundAnalysis(format: native)
        // Attach ONCE for the session object's lifetime. Repeated open/close
        // cycles used to attach/detach the player each call — detaching a node
        // with completion callbacks potentially in flight is a known CoreAudio
        // crash (device finding, build 82: app crashed after voice call cycles).
        if player.engine == nil { audioEngine.attach(player) }
        audioEngine.connect(player, to: audioEngine.mainMixerNode, format: playback)
        player.volume = 1
        audioEngine.mainMixerNode.outputVolume = 1
        input.installTap(onBus: 0, bufferSize: 960, format: native) {
            [weak self, socketAttempt] buffer, _ in
            self?.capture(
                buffer,
                nativeFormat: native,
                sourceStartAttempt: socketAttempt.startAttempt)
        }
        tapInstalled = true
        audioEngine.mainMixerNode.installTap(onBus: 0, bufferSize: 960, format: nil) {
            [weak self, socketAttempt] buffer, _ in
            self?.capturePlaybackReference(
                buffer,
                sourceStartAttempt: socketAttempt.startAttempt)
        }
        playbackReferenceTapInstalled = true
        audioEngine.prepare()
        do { try audioEngine.start() } catch {
            // Unwind the partial setup so the retry starts clean.
            input.removeTap(onBus: 0)
            tapInstalled = false
            audioEngine.mainMixerNode.removeTap(onBus: 0)
            playbackReferenceTapInstalled = false
            throw AlmaLiveVoiceError.audioStart
        }
        // setVoiceProcessingEnabled RESETS the output route to the receiver, so
        // the override above is dead by now — first-call greeting played near-
        // silent into the earpiece (owner device 2026-07-24; reopening worked
        // because this whole block is skipped once configured). Re-assert AFTER
        // VP + engine start so call one is as loud as call two.
        try? av.overrideOutputAudioPort(useSpeaker ? .speaker : .none)
        configured = true
        updateReadiness { $0.audioConfigured = true }
        trace("graph.configure.ready", "running=\(audioEngine.isRunning ? 1 : 0) vp=\(voiceProcessingUnavailable ? 0 : 1) "
              + audioSessionDescription(av))
        // On a REAL device the VP route reset can land asynchronously AFTER the
        // line above (owner 2026-07-31: first call silent until a manual
        // speaker toggle, second call fine — sim can't reproduce: no receiver
        // port and VP is skipped there). Two guards: a watchdog that re-asserts
        // the speaker whenever the OS re-routes to the receiver, plus one
        // delayed belt-and-braces nudge.
        bootstrapRouteProtectionUntil = Date().addingTimeInterval(1.2)
        if routeObserver == nil {
            routeObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
            ) { [weak self] notification in
                self?.handleAudioRouteChange(notification)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            self?.handleAudioRouteChange()
        }
    }

    private func inputEvidenceChainReady(
        _ windowID: AlmaLiveVoiceEvidenceInputWindowID
    ) -> Bool {
        guard evidenceRecorder.isEnabled else { return false }
        audioLock.lock()
        let ready = evidenceInputStageState.chainReady(windowID)
        audioLock.unlock()
        return ready
    }

    private func inputEvidenceWindowMatches(
        _ windowID: AlmaLiveVoiceEvidenceInputWindowID
    ) -> Bool {
        guard evidenceRecorder.isEnabled else { return false }
        audioLock.lock()
        let matches = evidenceInputStageState.matches(windowID)
        audioLock.unlock()
        return matches
    }

    private func markInputEvidenceIntakeComplete(
        _ windowID: AlmaLiveVoiceEvidenceInputWindowID
    ) {
        guard evidenceRecorder.isEnabled else { return }
        audioLock.lock()
        evidenceInputStageState.markIntakeComplete(windowID)
        audioLock.unlock()
    }

    private func markInputEvidenceIntakeNeedsRetry(
        _ windowID: AlmaLiveVoiceEvidenceInputWindowID
    ) {
        guard evidenceRecorder.isEnabled else { return }
        audioLock.lock()
        evidenceInputStageState.markIntakeNeedsRetry(windowID)
        audioLock.unlock()
    }

    private func capture(
        _ buffer: AVAudioPCMBuffer,
        nativeFormat: AVAudioFormat,
        sourceStartAttempt: AlmaLiveVoiceStartAttemptState.Token
    ) {
        audioLock.lock()
        let muted = inputMuted
        let evidenceSnapshot = evidenceInputStageState.snapshot()
        let evidenceGeneration = evidenceSnapshot.windowID.transportGeneration
        let evidenceIntakeComplete = evidenceSnapshot.intakeComplete
        let sourceAttempt = captureSocketAttempt
        audioLock.unlock()
        guard let sourceAttempt,
              sourceAttempt.startAttempt == sourceStartAttempt,
              !muted, !stopped,
              !evidenceRecorder.isEnabled
                || sourceAttempt.evidenceGeneration == evidenceGeneration else { return }
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return }
        var rms = 0.0
        if let samples = buffer.floatChannelData?[0] {
            var sum = 0.0
            for i in 0..<frames { let x = Double(samples[i]); sum += x * x }
            rms = (sum / Double(frames)).squareRoot()
        }
        let rawObservedUptime = ProcessInfo.processInfo.systemUptime
        let hasInputEvidenceEnergy = AlmaLiveVoiceEvidenceRecorder.isFirstEnergyCandidate(rms)

        guard let converter = inputConverter, let outFormat = inputFormat else {
            submitCaptureStageEvidence(
                rms: rms,
                convertedByteCount: nil,
                failureReason: .converterUnavailable,
                snapshot: evidenceSnapshot,
                rawObservedUptime: rawObservedUptime,
                conversionObservedUptime: ProcessInfo.processInfo.systemUptime)
            return
        }

        if !firstInputFrameTraced {
            firstInputFrameTraced = true
            trace("input.firstFrame", "frames=\(frames) rms=\(String(format: "%.5f", rms))")
        }
        dispatchEngineCallbackForActiveAttempt {
            $0.micLevel = min(1, rms * 7)
        }
        #if DEBUG
        micDebugFrameCount += 1
        if micDebugFrameCount % 100 == 0 {
            NSLog("ALMA-VOICE mic alive frames=%d rms=%.4f socketReady=1", micDebugFrameCount, rms)
        }
        #endif

        // Preserve the prior failure-path behavior: diagnostics may observe raw
        // energy before conversion, but the barge-in analyzer runs only when a
        // converter/output format is actually available.
        audioLock.lock()
        let needsNoAECDetector = voiceProcessingUnavailable && speakerEnabled
        audioLock.unlock()
        if needsNoAECDetector, let analyzer = soundAnalyzer {
            analyzer.analyze(buffer, atAudioFramePosition: soundAnalysisFramePosition)
            soundAnalysisFramePosition += AVAudioFramePosition(buffer.frameLength)
        }
        let micCorrelationSamples = needsNoAECDetector
            ? Self.correlationSamples(buffer)
            : []

        let capacity = AVAudioFrameCount(Double(frames) * outFormat.sampleRate / nativeFormat.sampleRate + 32)
        guard let output = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else {
            submitCaptureStageEvidence(
                rms: rms,
                convertedByteCount: nil,
                failureReason: .outputBufferUnavailable,
                snapshot: evidenceSnapshot,
                rawObservedUptime: rawObservedUptime,
                conversionObservedUptime: ProcessInfo.processInfo.systemUptime)
            return
        }
        var supplied = false
        var conversionError: NSError?
        converter.convert(to: output, error: &conversionError) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard conversionError == nil else {
            submitCaptureStageEvidence(
                rms: rms,
                convertedByteCount: nil,
                failureReason: .conversionError,
                snapshot: evidenceSnapshot,
                rawObservedUptime: rawObservedUptime,
                conversionObservedUptime: ProcessInfo.processInfo.systemUptime)
            return
        }
        guard output.frameLength > 0, let samples = output.int16ChannelData?[0] else {
            submitCaptureStageEvidence(
                rms: rms,
                convertedByteCount: nil,
                failureReason: .emptyOutput,
                snapshot: evidenceSnapshot,
                rawObservedUptime: rawObservedUptime,
                conversionObservedUptime: ProcessInfo.processInfo.systemUptime)
            return
        }
        let bytes = Data(bytes: samples, count: Int(output.frameLength) * MemoryLayout<Int16>.size)
        let captureUptime = ProcessInfo.processInfo.systemUptime
        submitCaptureStageEvidence(
            rms: rms,
            convertedByteCount: bytes.count,
            failureReason: nil,
            snapshot: evidenceSnapshot,
            rawObservedUptime: rawObservedUptime,
            conversionObservedUptime: captureUptime)
        let capturedInputChunk = AlmaLiveVoiceCapturedInputPCM(
            data: bytes,
            deliveryToken: evidenceRecorder.isEnabled
                    && !evidenceIntakeComplete
                    && hasInputEvidenceEnergy
                ? AlmaLiveVoiceEvidenceInputDeliveryToken(
                    windowID: evidenceSnapshot.windowID)
                : nil)

        var sendNormally = false
        var startBargeIn = false
        var startLoudspeakerProbe = false
        var endLoudspeakerProbe = false
        var flushAutomaticVADStream = false
        var probeLogRMS = 0.0
        var probeLogFloor = 0.0
        var referenceLogRMS = 0.0
        var referenceLogCorrelation = 0.0
        var referenceLogBaselineCorrelation = 0.0
        var referenceLogSpeechConfidence = 0.0
        var referenceLogMusicConfidence = 0.0
        var bargeInTraceDetail: String?
        var withheldPolicy: AlmaLiveVoiceEvidenceInputPolicy?
        var preRoll: [AlmaLiveVoiceCapturedInputPCM] = []
        let inputReducerEnabled = usesInputTurnReducer()
        var reducerRoute = AlmaLiveVoiceInputTurnReducer.InputRoute.trustedAECOrReceiver
        var reducerSuppression = AlmaLiveVoiceInputTurnReducer.PlaybackSuppression.none
        audioLock.lock()
        let echoExposedLoudspeaker = voiceProcessingUnavailable && speakerEnabled
        reducerRoute = echoExposedLoudspeaker ? .noAECLoudspeaker : .trustedAECOrReceiver
        if modelAudioTurnOpen && !bargeInPending {
            reducerSuppression = .activePlayback
        } else if Date() < listenSuppressedUntil {
            reducerSuppression = .playbackTail
        }
        if modelAudioTurnOpen && !bargeInPending {
            // Re-arm the listening gate for the next turn.
            listenGateOpen = false
            listenSpeechFrames = 0
            listenSilenceFrames = 0
            listenPreRoll.removeAll(keepingCapacity: true)
            // Official Gemini Live automatic VAD expects a continuous audio
            // stream and owns interruption. On VPIO/AEC or receiver routes the
            // microphone is safe to forward even while ALMA speaks; withholding
            // it behind the old local RMS threshold made short Bengali barge-ins
            // (especially "থামো") invisible to the model on real iPhones.
            let serverCanOwnBargeIn = !voiceProcessingUnavailable || !speakerEnabled
            if serverCanOwnBargeIn {
                resetLoudspeakerProbeLocked()
                micPreRoll.removeAll(keepingCapacity: true)
                bargeSpeechFrames = 0
                sendNormally = true
            } else {
                withheldPolicy = .noAECEchoGuard
                micPreRoll.append(capturedInputChunk)
                if micPreRoll.count > bargeInPreRollChunks {
                    micPreRoll.removeFirst(micPreRoll.count - bargeInPreRollChunks)
                }

                // Give a no-AEC loudspeaker route a short window to learn its
                // residual echo. That route keeps the side-chain discriminator;
                // directly streaming speaker echo would self-interrupt every turn.
                let playbackReferenceRMS = recentPlaybackReferenceRMSLocked(
                    now: captureUptime)
                let playbackCorrelation = recentPlaybackCorrelationLocked(
                    micSamples: micCorrelationSamples, now: captureUptime)
                if echoCalibrationFrames < 10 {
                    echoCalibrationFrames += 1
                    echoFloorRMS = max(echoFloorRMS, rms * 0.85)
                    if playbackCorrelation >= 0.05 {
                        playbackReferenceEchoCorrelationFrames += 1
                        let count = Double(playbackReferenceEchoCorrelationFrames)
                        playbackReferenceEchoCorrelation +=
                            (playbackCorrelation - playbackReferenceEchoCorrelation) / count
                    }
                    bargeSpeechFrames = 0
                    playbackReferenceSpeechFrames = 0
                    resetLoudspeakerProbeLocked()
                } else {
                // A CallKit receiver route has little acoustic feedback even
                // when AVAudioEngine could not enable VoiceProcessingIO. Treating
                // every no-AEC route like loudspeaker required RMS >= 0.081,
                // above the owner's measured speech (~0.047), so talking over
                // ALMA never stopped her. Receiver/AEC keeps the direct gate.
                // Echo-exposed loudspeaker instead ducks ALMA briefly and only
                // confirms speech that remains after her own echo has decayed.
                let echoExposedLoudspeaker = voiceProcessingUnavailable && speakerEnabled
                if echoExposedLoudspeaker {
                    let playbackReferenceReady = playbackReferenceReadyFrames
                        >= playbackReferenceReadyRequiredFrames
                        && playbackReferenceRMS >= playbackReferenceMinimumRMS
                    let soundClassificationFresh = Date().timeIntervalSince(
                        soundClassificationAt) <= 1.0
                    let professionalDetectorReady = playbackReferenceReady
                        && playbackReferenceEchoCorrelation >= 0.20
                        && soundClassificationFresh
                    if professionalDetectorReady {
                        if loudspeakerProbeActive { endLoudspeakerProbe = true }
                        resetLoudspeakerProbeLocked()
                        let humanSpeech = AlmaLiveBargeInEvidence.isHumanSpeech(
                            micRMS: rms,
                            echoFloorRMS: echoFloorRMS,
                            echoCorrelation: playbackCorrelation,
                            calibratedEchoCorrelation: playbackReferenceEchoCorrelation,
                            speechConfidence: soundSpeechConfidence,
                            musicConfidence: soundMusicConfidence,
                            noiseConfidence: soundNoiseConfidence)
                        bargeInEvidenceTraceFrames += 1
                        if bargeInEvidenceTraceFrames >= 25 {
                            bargeInEvidenceTraceFrames = 0
                            bargeInTraceDetail = String(
                                format: "mic=%.4f corr=%.3f baseline=%.3f speech=%.2f music=%.2f noise=%.2f candidate=%d",
                                rms, playbackCorrelation, playbackReferenceEchoCorrelation,
                                soundSpeechConfidence, soundMusicConfidence,
                                soundNoiseConfidence, humanSpeech ? 1 : 0)
                        }
                        if humanSpeech {
                            playbackReferenceSpeechFrames += 1
                        } else {
                            playbackReferenceSpeechFrames = max(
                                0, playbackReferenceSpeechFrames - 2)
                        }
                        if playbackReferenceSpeechFrames
                            >= playbackReferenceSpeechRequiredFrames {
                            bargeInPending = true
                            preRoll = micPreRoll
                            micPreRoll.removeAll(keepingCapacity: true)
                            bargeSpeechFrames = 0
                            referenceLogRMS = playbackReferenceRMS
                            referenceLogCorrelation = playbackCorrelation
                            referenceLogBaselineCorrelation = playbackReferenceEchoCorrelation
                            referenceLogSpeechConfidence = soundSpeechConfidence
                            referenceLogMusicConfidence = soundMusicConfidence
                            probeLogRMS = rms
                            probeLogFloor = echoFloorRMS
                            startBargeIn = true
                        }
                    } else if loudspeakerProbeActive {
                        let duckAppliedAt = loudspeakerProbeDuckAppliedAt
                        if duckAppliedAt != .distantPast {
                            let elapsed = Date().timeIntervalSince(duckAppliedAt)
                            if elapsed < loudspeakerProbeSettleSeconds {
                                // The duck is active but the acoustic echo tail
                                // has not had enough wall-clock time to decay.
                            } else {
                                // ALMA is softly ducked, so her echo should fall
                                // with it. A nearby human stays close to the
                                // pre-duck peak.
                                let voiceThreshold = max(
                                    0.010,
                                    listenNoiseFloorRMS * 2.5,
                                    loudspeakerProbeCandidatePeakRMS
                                        * loudspeakerProbeRetainedEnergyRatio
                                )
                                if rms >= voiceThreshold {
                                    loudspeakerProbeVoiceFrames += 1
                                }
                                if loudspeakerProbeVoiceFrames
                                    >= loudspeakerProbeVoiceRequiredFrames {
                                    bargeInPending = true
                                    preRoll = micPreRoll
                                    micPreRoll.removeAll(keepingCapacity: true)
                                    bargeSpeechFrames = 0
                                    probeLogRMS = rms
                                    probeLogFloor = echoFloorRMS
                                    startBargeIn = true
                                } else if elapsed >= loudspeakerProbeWindowSeconds {
                                    probeLogRMS = rms
                                    probeLogFloor = echoFloorRMS
                                    resetLoudspeakerProbeLocked(cooldown: true)
                                    endLoudspeakerProbe = true
                                }
                            }
                        }
                    } else if loudspeakerProbeCooldownFrames > 0 {
                        loudspeakerProbeCooldownFrames -= 1
                    } else {
                        // Low-cost trigger only starts the discriminator; it can
                        // never interrupt on RMS alone. The floor-relative term
                        // prevents constant probes on ordinary playback echo.
                        let candidateThreshold = max(
                            loudspeakerProbeCandidateRMS,
                            echoFloorRMS * 1.12 + 0.003
                        )
                        if rms >= candidateThreshold {
                            loudspeakerProbeCandidateFrames += 1
                            loudspeakerProbeCandidatePeakRMS = max(
                                loudspeakerProbeCandidatePeakRMS, rms)
                        } else {
                            loudspeakerProbeCandidateFrames = max(
                                0, loudspeakerProbeCandidateFrames - 1)
                            if loudspeakerProbeCandidateFrames == 0 {
                                loudspeakerProbeCandidatePeakRMS = 0
                            }
                            echoFloorRMS = echoFloorRMS * 0.96 + rms * 0.04
                        }
                        if loudspeakerProbeCandidateFrames
                            >= loudspeakerProbeCandidateRequiredFrames {
                            loudspeakerProbeActive = true
                            loudspeakerProbeCandidateFrames = 0
                            loudspeakerProbeDuckAppliedAt = .distantPast
                            loudspeakerProbeVoiceFrames = 0
                            probeLogRMS = rms
                            probeLogFloor = echoFloorRMS
                            startLoudspeakerProbe = true
                        }
                    }
                } else {
                    if loudspeakerProbeActive { endLoudspeakerProbe = true }
                    resetLoudspeakerProbeLocked()
                    let threshold = max(bargeInMinimumRMS, echoFloorRMS * 1.9 + 0.003)
                    if rms >= threshold {
                        bargeSpeechFrames += 1
                    } else {
                        bargeSpeechFrames = max(0, bargeSpeechFrames - 2)
                        // Adapt slowly only to samples classified as echo/room
                        // noise; never let speech raise its own threshold.
                        echoFloorRMS = echoFloorRMS * 0.96 + rms * 0.04
                    }
                    if bargeSpeechFrames >= receiverBargeInRequiredFrames {
                        bargeInPending = true
                        preRoll = micPreRoll
                        micPreRoll.removeAll(keepingCapacity: true)
                        bargeSpeechFrames = 0
                        startBargeIn = true
                    }
                }
                }
            }
        } else {
            if loudspeakerProbeActive { endLoudspeakerProbe = true }
            resetLoudspeakerProbeLocked()
            micPreRoll.removeAll(keepingCapacity: true)
            bargeSpeechFrames = 0
            if inputReducerEnabled {
                listenPreRoll.removeAll(keepingCapacity: true)
                listenGateOpen = false
                listenSpeechFrames = 0
                listenSilenceFrames = 0
                listenContinuousLoudFrames = 0
                if reducerSuppression == .playbackTail {
                    withheldPolicy = .playbackTailSuppression
                }
            } else {
            if Date() < listenSuppressedUntil {
                listenPreRoll.removeAll(keepingCapacity: true)
                listenGateOpen = false
                listenSpeechFrames = 0
                listenSilenceFrames = 0
                listenContinuousLoudFrames = 0
                #if DEBUG
                if !listenTailSuppressionLogged {
                    listenTailSuppressionLogged = true
                    NSLog("ALMA-VOICE listening suppressed for playback echo tail")
                }
                #endif
                let policyClaimed = claimInputPolicyWithheldEvidenceLocked(
                    .playbackTailSuppression,
                    snapshot: evidenceSnapshot,
                    hasEnergy: hasInputEvidenceEnergy)
                if policyClaimed {
                    enqueueInputPolicyWithheldEvidence(
                        .playbackTailSuppression,
                        snapshot: evidenceSnapshot,
                        observedUptime: captureUptime)
                }
                audioLock.unlock()
                return
            }
            // LISTENING noise gate (sim-proven 2026-07-30): streaming every idle
            // frame let ambient noise trip the server VAD the instant a model
            // turn opened — START_OF_ACTIVITY_INTERRUPTS then killed the turn
            // ~90 ms in ("এজেন্ট একটু কথা বলেই থেমে যায়"). Only sustained
            // above-floor signal opens the gate; a ~300 ms pre-roll preserves
            // the speech onset, and the ~1.1 s hangover (55 frames) exceeds the
            // server's 1200 ms silenceDuration so endpointing still belongs to
            // the server VAD, never to this gate. Bonus on weak abroad
            // networks: idle uplink drops to zero.
            listenPreRoll.append(capturedInputChunk)
            if listenPreRoll.count > 15 { listenPreRoll.removeFirst(listenPreRoll.count - 15) }
            // Floor learns upward WITHOUT ever eating live speech (Codex rounds
            // 4+5): the calibration window uses the MINIMUM rms it saw — steady
            // noise has no quiet frames so its level is learned, while a voice
            // that starts immediately still dips between syllables and only
            // those dips become the floor (P2 round 5). No always-on tracker:
            // that EMA overtook a steady utterance in ~1.8s and truncated it
            // (P1 round 5). Closed-gate frames adapt the floor, and the
            // gapless-noise failsafe below covers sound with no dips at all.
            if listenCalibrationFrames < 10 {
                listenCalibrationFrames += 1
                listenCalibMinRMS = min(listenCalibMinRMS, rms)
                if listenCalibrationFrames == 10 {
                    listenNoiseFloorRMS = max(listenNoiseFloorRMS, listenCalibMinRMS * 0.85)
                    listenCalibMinRMS = .greatestFiniteMagnitude
                }
                listenSpeechFrames = 0
                let policyClaimed = claimInputPolicyWithheldEvidenceLocked(
                    .listenCalibration,
                    snapshot: evidenceSnapshot,
                    hasEnergy: hasInputEvidenceEnergy)
                if policyClaimed {
                    enqueueInputPolicyWithheldEvidence(
                        .listenCalibration,
                        snapshot: evidenceSnapshot,
                        observedUptime: captureUptime)
                }
                audioLock.unlock()
                return
            }
            // Calibrated threshold, no hard 0.010 floor (Codex P2): a quiet or
            // distant speaker can sit below a fixed bound, and a closed gate
            // means their speech would never reach the server at all. The floor
            // EMA tracks the room, so the adaptive floor follows quiet rooms;
            // the tiny epsilon only guards digital-silence jitter.
            // Use hysteresis: opening needs a clear rise above the learned room,
            // but once speech begins a quieter clause or sentence ending must
            // remain in the same utterance. The previous 3x threshold measured
            // 0.0225 in the owner's run while ordinary long-form syllables were
            // quieter, so only short/near-mic phrases survived.
            let openThreshold = max(0.003, listenNoiseFloorRMS * 1.8 + 0.001)
            let keepOpenThreshold = max(0.003, listenNoiseFloorRMS * 1.25 + 0.001)
            let speechThreshold = listenGateOpen ? keepOpenThreshold : openThreshold
            if rms >= speechThreshold {
                listenSpeechFrames += 1
                listenSilenceFrames = 0
                // Gapless-noise failsafe: do not classify a legitimate long
                // monologue as noise. The old 30s cap was shorter than a normal
                // detailed request and could drop everything after that point.
                // Three minutes still bounds a truly stuck/noisy input.
                listenContinuousLoudFrames += 1
                if listenContinuousLoudFrames >= 9000 {
                    listenNoiseFloorRMS = max(listenNoiseFloorRMS, rms * 0.85)
                    listenGateOpen = false
                    listenSpeechFrames = 0
                    listenContinuousLoudFrames = 0
                    flushAutomaticVADStream = true
                    #if DEBUG
                    NSLog("ALMA-VOICE listen gate closed — gapless noise promoted to floor")
                    #endif
                }
            } else {
                listenSpeechFrames = max(0, listenSpeechFrames - 1)
                listenSilenceFrames += 1
                listenContinuousLoudFrames = 0
                // Never learn the room floor from a quiet tail inside an open
                // utterance. That feedback loop used to raise the threshold
                // until the rest of a long sentence could no longer reopen it.
                if !listenGateOpen {
                    listenNoiseFloorRMS = listenNoiseFloorRMS * 0.97 + rms * 0.03
                }
            }
            if !listenGateOpen, listenSpeechFrames >= 3 {
                listenGateOpen = true
                // Reset on BOTH transitions (Codex P2): a long utterance grows
                // the counter far past the open threshold, and decrement-by-one
                // silence would let the very next silent frame reopen the gate
                // and flush overlapping pre-roll in an open/close flap.
                listenSpeechFrames = 0
                preRoll = listenPreRoll
                listenPreRoll.removeAll(keepingCapacity: true)
                #if DEBUG
                NSLog("ALMA-VOICE listen gate OPEN rms=%.4f floor=%.4f", rms, listenNoiseFloorRMS)
                #endif
            } else if listenGateOpen, listenSilenceFrames >= 55 {
                listenGateOpen = false
                listenSpeechFrames = 0
                // Automatic Gemini VAD expects continuous audio. Because this
                // local acoustic gate intentionally pauses the stream, explicitly
                // flush cached audio at the boundary; the API allows audio to
                // resume with the next chunk.
                flushAutomaticVADStream = true
                #if DEBUG
                NSLog("ALMA-VOICE listen gate closed")
                #endif
            }
            sendNormally = listenGateOpen
            if !sendNormally { withheldPolicy = .listenGateClosed }
            }
        }
        if startBargeIn { withheldPolicy = nil }
        let claimedWithheldPolicy = withheldPolicy.flatMap { policy in
            claimInputPolicyWithheldEvidenceLocked(
                policy,
                snapshot: evidenceSnapshot,
                hasEnergy: hasInputEvidenceEnergy) ? policy : nil
        }
        if let claimedWithheldPolicy {
            enqueueInputPolicyWithheldEvidence(
                claimedWithheldPolicy,
                snapshot: evidenceSnapshot,
                observedUptime: captureUptime)
        }
        audioLock.unlock()

        let reducerEffects = inputReducerEnabled
            ? reduceCapturedInput(
                capturedInputChunk,
                rms: rms,
                hasOwnerEnergy: hasInputEvidenceEnergy,
                route: reducerRoute,
                suppression: reducerSuppression,
                ownerSpeechConfirmed: startBargeIn,
                attempt: sourceAttempt)
            : AlmaLiveVoiceInputTurnReducer.Effects.none

        if let bargeInTraceDetail {
            AlmaVoiceAudioTrace.event("bargeIn.evidence", bargeInTraceDetail)
        }

        if !inputReducerEnabled, flushAutomaticVADStream {
            sendInputStreamEnd(sourceAttempt: sourceAttempt)
            #if DEBUG
            NSLog("ALMA-VOICE input stream flushed after listen gate close")
            #endif
        }

        if startLoudspeakerProbe {
            #if DEBUG
            NSLog("ALMA-VOICE loudspeaker probe started rms=%.4f floor=%.4f",
                  probeLogRMS, probeLogFloor)
            #endif
            setLoudspeakerProbeMuted(true)
        } else if endLoudspeakerProbe {
            #if DEBUG
            NSLog("ALMA-VOICE loudspeaker probe dismissed rms=%.4f floor=%.4f",
                  probeLogRMS, probeLogFloor)
            #endif
            setLoudspeakerProbeMuted(false)
        }
        if startBargeIn {
            AlmaVoiceAudioTrace.event(
                "bargeIn.confirmed",
                String(format: "mic=%.4f corr=%.3f baseline=%.3f speech=%.2f music=%.2f",
                       probeLogRMS, referenceLogCorrelation,
                       referenceLogBaselineCorrelation, referenceLogSpeechConfidence,
                       referenceLogMusicConfidence))
            #if DEBUG
            if referenceLogRMS > 0 {
                NSLog("ALMA-VOICE local barge-in confirmed speech mic=%.4f reference=%.4f correlation=%.3f baseline=%.3f speech=%.2f music=%.2f",
                      probeLogRMS, referenceLogRMS, referenceLogCorrelation,
                      referenceLogBaselineCorrelation, referenceLogSpeechConfidence,
                      referenceLogMusicConfidence)
            } else {
                NSLog("ALMA-VOICE local barge-in confirmed human speech rms=%.4f floor=%.4f",
                      probeLogRMS, probeLogFloor)
            }
            #endif
            beginLocalBargeIn()
            if inputReducerEnabled {
                // The reducer owns the larger bounded FIFO and exact-once drain.
            } else if !preRoll.isEmpty {
                sendCapturedInputChunks(preRoll, sourceAttempt: sourceAttempt)
            } else {
                sendRealtimeAudio(
                    capturedInputChunk.data,
                    sourceAttempt: sourceAttempt,
                    inputEvidence: capturedInputChunk.deliveryToken)
            }
        } else if !inputReducerEnabled, sendNormally {
            if !preRoll.isEmpty {
                // Listen gate just opened: the pre-roll already contains this
                // frame — flush it instead of sending `bytes` twice.
                sendCapturedInputChunks(preRoll, sourceAttempt: sourceAttempt)
            } else {
                sendRealtimeAudio(
                    capturedInputChunk.data,
                    sourceAttempt: sourceAttempt,
                    inputEvidence: capturedInputChunk.deliveryToken)
            }
        }
        if inputReducerEnabled {
            applyInputTurnEffects(reducerEffects, attempt: sourceAttempt)
        }
    }

    /// Sends every buffered PCM frame in FIFO order, while tracking only the
    /// latest exact energy-bearing frame. Older silence/noise never inherits
    /// its token, and a large pre-roll cannot add evidence-lock work per chunk.
    private func sendCapturedInputChunks(
        _ chunks: [AlmaLiveVoiceCapturedInputPCM],
        sourceAttempt: AlmaLiveVoiceSocketAttempt
    ) {
        let trackedIndex = AlmaLiveVoiceCapturedInputPCM.trackedEvidenceIndex(in: chunks)
        for (index, chunk) in chunks.enumerated() {
            sendRealtimeAudio(
                chunk.data,
                sourceAttempt: sourceAttempt,
                inputEvidence: AlmaLiveVoiceCapturedInputPCM.deliveryTokenForSending(
                    chunk,
                    at: index,
                    trackedIndex: trackedIndex))
        }
    }

    private func sendRealtimeAudio(
        _ bytes: Data,
        sourceAttempt: AlmaLiveVoiceSocketAttempt,
        inputEvidence: AlmaLiveVoiceEvidenceInputDeliveryToken? = nil
    ) {
        let usageProfile = profile(for: sourceAttempt.startAttempt)
        sendJSON(["realtimeInput": ["audio": [
            "mimeType": "audio/pcm;rate=16000",
            "data": bytes.base64EncodedString(),
        ]]],
            audioEvidenceByteCount: inputEvidence == nil ? nil : bytes.count,
            audioEvidenceGeneration: sourceAttempt.evidenceGeneration,
            audioSourceAttempt: sourceAttempt,
            audioInputEvidence: inputEvidence,
            usageInputAudioByteCount: bytes.count,
            usageProfile: usageProfile)
    }

    private func sendInputStreamEnd(
        sourceAttempt: AlmaLiveVoiceSocketAttempt
    ) {
        readinessLock.lock()
        let socket = readiness.socketAttempt == sourceAttempt ? ws : nil
        readinessLock.unlock()
        guard let socket else { return }
        sendJSON(
            ["realtimeInput": ["audioStreamEnd": true]],
            sourceSocket: socket,
            audioSourceAttempt: sourceAttempt)
    }

    private func receiveLoop(
        _ socket: URLSessionWebSocketTask,
        attempt: AlmaLiveVoiceSocketAttempt
    ) {
        socket.receive { [weak self, weak socket] result in
            guard let self, let socket, !self.stopped, self.ws === socket,
                  self.isCurrentSocketAttempt(attempt) else { return }
            let evidenceGeneration = self.evidenceGeneration(
                for: socket,
                requireReady: false) ?? 0
            switch result {
            case .failure(let error):
                let observedUptime = ProcessInfo.processInfo.systemUptime
                #if DEBUG
                NSLog("ALMA-VOICE websocket receive failed: %@", String(describing: error))
                #endif
                self.recordTransportEvidence(
                    .socketReceiveFailed,
                    generation: evidenceGeneration,
                    observedUptime: observedUptime)
                if self.invalidateSocketReadiness(attempt: attempt) {
                    self.recoverConnection(from: attempt)
                }
            case .success(let message):
                switch message {
                case .string(let text):
                    self.onMessage(
                        text,
                        attempt: attempt,
                        evidenceGeneration: evidenceGeneration)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.onMessage(
                            text,
                            attempt: attempt,
                            evidenceGeneration: evidenceGeneration)
                    }
                @unknown default:
                    break
                }
                if self.ws === socket, self.isCurrentSocketAttempt(attempt) {
                    self.receiveLoop(socket, attempt: attempt)
                }
            }
        }
    }

    private func handleOrchestratedToolCalls(
        _ calls: [[String: Any]],
        attempt: AlmaLiveVoiceSocketAttempt
    ) {
        toolLedgerLock.lock()
        guard toolOrchestrationEnabled else {
            toolLedgerLock.unlock()
            return
        }
        var admittedAny = false
        for call in calls {
            guard let invocation = AlmaLiveVoiceToolInvocation.decode(call) else {
                #if DEBUG
                NSLog("ALMA-VOICE rejected tool call without exact provider id/name")
                #endif
                continue
            }
            switch toolLedger.admit(invocation) {
            case .accepted, .duplicate(replayScheduled: true):
                admittedAny = true
            case .duplicate(replayScheduled: false):
                break
            case .conflictingIdentity:
                #if DEBUG
                NSLog("ALMA-VOICE rejected conflicting duplicate tool id=%@", invocation.callID)
                #endif
            case .capacityExceeded:
                #if DEBUG
                NSLog("ALMA-VOICE tool ledger capacity reached")
                #endif
            }
        }
        if admittedAny { toolEngineConnectionGeneration = attempt.engineConnectionGeneration }
        toolLedgerLock.unlock()
        dispatchNextToolExecution()
        drainToolResponses()
    }

    private func handleOrchestratedToolCancellation(
        _ callIDs: [String],
        attempt: AlmaLiveVoiceSocketAttempt
    ) {
        toolLedgerLock.lock()
        guard toolOrchestrationEnabled,
              toolEngineConnectionGeneration == attempt.engineConnectionGeneration else {
            toolLedgerLock.unlock()
            return
        }
        let executing = toolLedger.cancel(callIDs: callIDs)
        toolLedgerLock.unlock()
        for invocation in executing {
            dispatchEngineCallback(
                engineConnectionGeneration: attempt.engineConnectionGeneration
            ) { $0.cancelLiveToolInvocation(invocation) }
        }
        dispatchNextToolExecution()
        drainToolResponses()
    }

    private func dispatchNextToolExecution() {
        toolLedgerLock.lock()
        guard toolOrchestrationEnabled,
              let generation = toolEngineConnectionGeneration,
              let invocation = toolLedger.nextExecution() else {
            toolLedgerLock.unlock()
            return
        }
        toolLedgerLock.unlock()
        // Accepted work belongs to the logical call, not the physical socket.
        // A reconnect after admission therefore cannot suppress its execution.
        dispatchEngineCallback(engineConnectionGeneration: generation) {
            $0.handleLiveToolInvocation(invocation)
        }
    }

    private func drainToolResponses() {
        toolLedgerLock.lock()
        let canDrain = toolOrchestrationEnabled && !toolResponsePlaybackBlocked
        toolLedgerLock.unlock()
        guard canDrain else { return }

        readinessLock.lock()
        let attempt = socketReady ? readiness.socketAttempt : nil
        let socket = attempt?.socketIdentity == ws.map(ObjectIdentifier.init) ? ws : nil
        readinessLock.unlock()
        guard let attempt, let socket else { return }

        toolLedgerLock.lock()
        guard let ticket = toolLedger.nextResponse(transportOrdinal: attempt.ordinal) else {
            toolLedgerLock.unlock()
            return
        }
        toolLedgerLock.unlock()

        let queued = sendJSON(
            ["toolResponse": ["functionResponses": [[
                "id": ticket.callID,
                "name": ticket.functionName,
                "response": ["result": ticket.result],
            ]]]],
            sourceSocket: socket,
            audioSourceAttempt: attempt
        ) { [weak self] error in
            guard let self else { return }
            self.toolLedgerLock.lock()
            let accepted = self.toolLedger.finishSend(ticket, succeeded: error == nil)
            self.toolLedgerLock.unlock()
            if accepted && error == nil { self.drainToolResponses() }
        }
        guard !queued else { return }
        toolLedgerLock.lock()
        _ = toolLedger.finishSend(ticket, succeeded: false)
        toolLedgerLock.unlock()
    }

    private func onMessage(
        _ text: String,
        attempt: AlmaLiveVoiceSocketAttempt,
        evidenceGeneration: Int
    ) {
        guard isCurrentSocketAttempt(attempt) else { return }
        guard let data = text.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        let observedUptime = ProcessInfo.processInfo.systemUptime
        if let metadata = root["usageMetadata"] as? [String: Any],
           let usageProfile = profile(for: attempt.startAttempt) {
            usageMeter.recordProviderUsage(
                AlmaLiveVoiceProviderUsageParser.parse(metadata),
                profile: usageProfile)
        }
        if let error = root["error"] as? [String: Any] {
            // The attempt may have been invalidated after the receive-loop guard.
            // Snapshot currentness and setup state together so an accepted resume
            // cannot be reported as a setup failure during concurrent teardown.
            guard let setupAccepted = currentSocketSetupAccepted(attempt) else { return }
            for event in AlmaLiveVoiceProviderControlEvidence.providerErrorEvents(
                recoveryAttempt: attempt.recoveryAttempt,
                resumptionRequested: attempt.resumptionRequested,
                setupAccepted: setupAccepted
            ) {
                recordTransportEvidence(
                    event,
                    generation: evidenceGeneration,
                    observedUptime: observedUptime)
            }
            #if DEBUG
            let code = error["code"] ?? "unknown"
            let status = error["status"] ?? "unknown"
            NSLog("ALMA-VOICE server error code=%@ status=%@", String(describing: code), String(describing: status))
            #endif
            var retryWithoutAffective = false
            var retryWithFreshToken = false
            startAttemptLock.lock()
            guard isCurrentPhysicalSocketAttemptLocked(attempt) else {
                startAttemptLock.unlock()
                return
            }
            if allowAffective {
                // Setup rejected (older token constraints don't know the affective
                // field) — drop it and retry the same call transparently.
                allowAffective = false
                reconnecting = false
                retryWithoutAffective = true
            } else if reconnecting {
                reconnecting = false
                retryWithFreshToken = true
            }
            startAttemptLock.unlock()
            if retryWithoutAffective {
                if invalidateSocketReadiness(attempt: attempt) {
                    recoverConnection(from: attempt, allowInitial: true)
                }
                return
            }
            if retryWithFreshToken {
                if invalidateSocketReadiness(attempt: attempt) {
                    recoverConnection(
                        from: attempt,
                        forceFreshToken: true,
                        allowInitial: true)
                }
                return
            }
            fail(
                "রিয়েলটাইম ভয়েস সার্ভার সংযোগ নেয়নি।",
                ifCurrentSocketAttempt: attempt)
            return
        }
        if root["setupComplete"] != nil {
            guard let gate = acceptSocketSetup(attempt) else { return }
            for event in AlmaLiveVoiceProviderControlEvidence.setupCompleteEvents(
                resumptionRequested: attempt.resumptionRequested
            ) {
                recordTransportEvidence(
                    event,
                    generation: evidenceGeneration,
                    observedUptime: observedUptime)
            }
            if gate.waitingForCallKit {
                audioConfigPending = true
                #if DEBUG
                NSLog("ALMA-VOICE socket ready — waiting for CallKit didActivate")
                #endif
                return
            }
            do {
                try configureAudio(for: attempt)
                finishSetup(for: attempt)
            } catch {
                guard acceptsStartAttempt(attempt.startAttempt),
                      isCurrentSocketAttempt(attempt)
                else { return }
                // Under CallKit the session may not be activated yet — keep the
                // socket and retry from callKitAudioActivated() instead of
                // failing the whole call (owner device, build 89).
                if callKitOwnsAudioSession {
                    audioConfigPending = true
                    _ = deferSocketSetupForCallKit(attempt)
                    scheduleCallKitAudioRetry(for: attempt, retry: 1, lastError: error)
                } else {
                    fail(
                        "লাইভ অডিও চালু করা যায়নি। [\(String(String(describing: error).prefix(140)))]",
                        ifCurrentSocketAttempt: attempt)
                }
            }
        }
        if let update = root["sessionResumptionUpdate"] as? [String: Any],
           let resumable = update["resumable"] as? Bool {
            let handle = update["newHandle"] as? String
            let hasUsableHandle = !(handle?.isEmpty ?? true)
            startAttemptLock.lock()
            guard isCurrentPhysicalSocketAttemptLocked(attempt) else {
                startAttemptLock.unlock()
                return
            }
            if resumable, hasUsableHandle { latestResumptionHandle = handle }
            startAttemptLock.unlock()
            for event in AlmaLiveVoiceProviderControlEvidence.resumptionUpdateEvents(
                resumable: resumable,
                hasUsableHandle: hasUsableHandle
            ) {
                recordTransportEvidence(
                    event,
                    generation: evidenceGeneration,
                    observedUptime: observedUptime)
            }
        }
        if let content = root["serverContent"] as? [String: Any] {
            handleServerContent(
                content,
                attempt: attempt,
                evidenceGeneration: evidenceGeneration)
        }
        if let tool = root["toolCall"] as? [String: Any],
           let calls = tool["functionCalls"] as? [[String: Any]] {
            if !calls.isEmpty {
                let effects = reduceInputTurn(generation: attempt.startAttempt) {
                    $0.observeResponseBoundary(
                        generation: attempt.startAttempt,
                        .toolCall)
                }
                applyInputTurnEffects(effects, attempt: attempt)
            }
            for call in calls {
                let evidenceTool = AlmaLiveVoiceEvidenceTool(
                    providerName: call["name"] as? String)
                _ = submitEvidence { recorder in
                    _ = recorder.recordToolCallObserved(
                        evidenceTool,
                        generation: evidenceGeneration)
                }
            }
            if usesToolOrchestration {
                handleOrchestratedToolCalls(calls, attempt: attempt)
            } else {
                // Rollback path retains the pre-ledger dispatcher, but never
                // invents a provider identity or replies under the wrong name.
                for call in calls where call["name"] as? String == AlmaLiveVoiceToolName.quickLookup.rawValue {
                    guard let id = call["id"] as? String, !id.isEmpty else { continue }
                    let toolName = (call["args"] as? [String: Any])?["tool"] as? String ?? ""
                    dispatchEngineCallback(
                        engineConnectionGeneration: attempt.engineConnectionGeneration,
                        requiring: attempt
                    ) { $0.runQuickLookup(tool: toolName, callId: id) }
                }
                for call in calls where call["name"] as? String == AlmaLiveVoiceToolName.endCall.rawValue {
                    guard let id = call["id"] as? String, !id.isEmpty else { continue }
                    dispatchEngineCallback(
                        engineConnectionGeneration: attempt.engineConnectionGeneration,
                        requiring: attempt
                    ) { [weak self] engine in
                        guard let self else { return }
                        let result = engine.approveModelRequestedEnd()
                            ? "ঠিক আছে — বিদায় বলা শেষ হলেই কল কেটে যাবে।"
                            : "Boss কল শেষ করতে বলেননি — কল কাটা হয়নি, স্বাভাবিকভাবে কথা চালিয়ে যাও।"
                        self.sendToolResponse(
                            callId: id,
                            result: result,
                            name: AlmaLiveVoiceToolName.endCall.rawValue)
                    }
                }
                for call in calls where call["name"] as? String == AlmaLiveVoiceToolName.runAgentTurn.rawValue {
                    guard let id = call["id"] as? String, !id.isEmpty else { continue }
                    let request = (call["args"] as? [String: Any])?["request"] as? String ?? ""
                    dispatchEngineCallback(
                        engineConnectionGeneration: attempt.engineConnectionGeneration,
                        requiring: attempt
                    ) { $0.runLiveAgentTurn(request: request, callId: id) }
                }
            }
        }
        if usesToolOrchestration,
           let cancellation = root["toolCallCancellation"] as? [String: Any],
           let ids = cancellation["ids"] as? [String] {
            handleOrchestratedToolCancellation(ids, attempt: attempt)
        }
        if root["goAway"] != nil {
            recordTransportEvidence(.goAwayObserved, generation: evidenceGeneration)
            if invalidateSocketReadiness(attempt: attempt) {
                recoverConnection(from: attempt)
            }
        }
    }

    // MARK: WebSocket keepalive / stall detection
    //
    // Owner symptom (Dubai, builds 89–91): mid-call the agent goes silent for
    // 15–20 s, then suddenly resumes. Root cause: a mobile network path change
    // (NAT rebind, wifi↔cellular) kills the TCP flow SILENTLY — receive() just
    // hangs, and nothing notices until the 60 s request timeout. A ping every
    // 5 s with a one-tick pong deadline turns that dead air into a fast
    // recoverConnection(), so the resumed session is back in a few seconds.
    private func startKeepalive(for attempt: AlmaLiveVoiceSocketAttempt) {
        stopKeepalive()
        let t = DispatchSource.makeTimerSource(queue: netQueue)
        t.schedule(deadline: .now() + 5, repeating: 5)
        t.setEventHandler { [weak self, attempt] in
            self?.keepaliveTick(from: attempt)
        }
        keepaliveLock.lock()
        pingTimer = t
        awaitingPongAttempt = nil
        keepaliveLock.unlock()
        t.resume()
    }

    private func stopKeepalive() {
        keepaliveLock.lock()
        let timer = pingTimer
        pingTimer = nil
        awaitingPongAttempt = nil
        keepaliveLock.unlock()
        timer?.cancel()
    }

    private func keepaliveTick(from sourceAttempt: AlmaLiveVoiceSocketAttempt) {
        guard !stopped, !reconnecting, socketReadySnapshot(), let socket = ws,
              sourceAttempt.socketIdentity == ObjectIdentifier(socket),
              currentSocketAttempt(for: socket) == sourceAttempt,
              isCurrentPhysicalSocketAttempt(sourceAttempt)
        else { return }
        keepaliveLock.lock()
        let timedOut = awaitingPongAttempt == sourceAttempt
        let shouldPing = awaitingPongAttempt == nil
        if timedOut {
            awaitingPongAttempt = nil
        } else if shouldPing {
            awaitingPongAttempt = sourceAttempt
        }
        keepaliveLock.unlock()
        if timedOut {
            // Previous ping got no pong within a full tick — the socket is stalled.
            #if DEBUG
            NSLog("ALMA-VOICE keepalive: pong missing — socket stalled, reconnecting")
            #endif
            if let generation = evidenceGeneration(for: socket, requireReady: false) {
                recordTransportEvidence(
                    .socketPingTimedOut,
                    generation: generation,
                    observedUptime: ProcessInfo.processInfo.systemUptime)
            }
            if invalidateSocketReadiness(attempt: sourceAttempt) {
                recoverConnection(from: sourceAttempt)
            }
            return
        }
        // Another attempt must never share this timer's single outstanding ping.
        guard shouldPing, isCurrentPhysicalSocketAttempt(sourceAttempt) else {
            keepaliveLock.lock()
            if awaitingPongAttempt == sourceAttempt {
                awaitingPongAttempt = nil
            }
            keepaliveLock.unlock()
            return
        }
        socket.sendPing { [weak self, sourceAttempt] error in
            // Hop back to netQueue — URLSession delivers this on its own queue.
            self?.netQueue.async {
                guard let self, !self.stopped,
                      self.isCurrentPhysicalSocketAttempt(sourceAttempt),
                      self.currentSocketAttempt(for: socket) == sourceAttempt
                else { return }
                self.keepaliveLock.lock()
                guard self.awaitingPongAttempt == sourceAttempt else {
                    self.keepaliveLock.unlock()
                    return
                }
                self.awaitingPongAttempt = nil
                self.keepaliveLock.unlock()
                if error == nil {
                    return
                } else {
                    #if DEBUG
                    NSLog("ALMA-VOICE keepalive: ping failed — reconnecting (%@)", String(describing: error))
                    #endif
                    if let generation = self.evidenceGeneration(
                        for: socket,
                        requireReady: false) {
                        self.recordTransportEvidence(
                            .socketPingFailed,
                            generation: generation,
                            observedUptime: ProcessInfo.processInfo.systemUptime)
                    }
                    if self.invalidateSocketReadiness(attempt: sourceAttempt) {
                        self.recoverConnection(from: sourceAttempt)
                    }
                }
            }
        }
    }

    /// Google rotates the physical websocket roughly every ten minutes. Resume with
    /// the latest handle, keeping the logical conversation and audio engine alive
    /// without replaying a greeting. The single-use ephemeral token stays valid for
    /// resumed connections until its 30-minute expireTime — past ~25 minutes (or if
    /// a resumed connect is rejected) mint a fresh token instead of dying, so a long
    /// AI call survives every rotation. Attempts are capped so a hard outage still
    /// fails loud instead of looping.
    private func recoverConnection(
        from sourceAttempt: AlmaLiveVoiceSocketAttempt,
        forceFreshToken: Bool = false,
        allowInitial: Bool = false
    ) {
        // Serialize on netQueue: receive failures (URLSession queue), goAway
        // (delegate queue) and keepalive stalls (timer) may race — only one may
        // pass the exact-source guard and replace the socket. A callback queued
        // by physical socket A must never select a later socket B when it runs.
        netQueue.async { [weak self, sourceAttempt] in
            self?.recoverConnectionOnNetQueue(
                from: sourceAttempt,
                forceFreshToken: forceFreshToken,
                allowInitial: allowInitial)
        }
    }

    private func recoverConnectionOnNetQueue(
        from sourceAttempt: AlmaLiveVoiceSocketAttempt,
        forceFreshToken: Bool,
        allowInitial: Bool
    ) {
        // Treat recovery as a compare-and-swap against the logical start
        // attempt. Stop/reopen cannot replace the shared socket slots until the
        // exact old resources have been detached below.
        startAttemptLock.lock()
        guard !stopped, !reconnecting,
              let startAttempt = startAttemptState.activeToken,
              startAttempt == sourceAttempt.startAttempt,
              let startAttemptEngineGeneration =
                startAttemptEngineConnectionGeneration,
              isCurrentPhysicalSocketAttemptLocked(sourceAttempt)
        else {
            startAttemptLock.unlock()
            return
        }
        // Rejected INITIAL setups may arrive as a socket close (no error JSON).
        // If we asked for affective dialog, retry the very first connect once
        // without it before declaring the call dead.
        let affectiveDowngradeRetry = !hasConnectedOnce && allowAffective
        guard hasConnectedOnce || allowInitial || affectiveDowngradeRetry, mintedSession != nil else {
            startAttemptLock.unlock()
            fail(
                "লাইভ ভয়েস সংযোগ বিচ্ছিন্ন হয়েছে।",
                ifCurrentStartAttempt: startAttempt)
            return
        }
        if affectiveDowngradeRetry {
            #if DEBUG
            NSLog("ALMA-VOICE initial setup failed — retrying without affective dialog")
            #endif
            allowAffective = false
        }
        guard reconnectAttempts < 3 else {
            startAttemptLock.unlock()
            fail(
                "লাইভ ভয়েস সংযোগ বিচ্ছিন্ন হয়েছে।",
                ifCurrentStartAttempt: startAttempt)
            return
        }
        reconnectAttempts += 1
        reconnecting = true
        let reconnectGeneration = evidenceTransportGenerationSnapshot()
        recordTransportEvidence(
            .reconnectScheduled,
            generation: reconnectGeneration)
        _ = invalidateSocketReadiness()
        stopKeepalive()
        #if DEBUG
        NSLog("ALMA-VOICE reconnect attempt %d (forceFreshToken=%d)", reconnectAttempts, forceFreshToken ? 1 : 0)
        #endif
        // CRITICAL (device finding, build 82): a socket can drop mid model-turn,
        // losing generationComplete/turnComplete forever. Without this reset the
        // turn stays open, the UI sticks on "বলছি", and — because the mic is
        // gated during a model turn — the call goes permanently DEAF. Close any
        // orphaned turn before reconnecting so the resumed session starts
        // cleanly in listening.
        stopModelPlayback(
            interrupted: false,
            engineConnectionGeneration: startAttemptEngineGeneration)
        outputTranscript = ""
        let oldSocket = ws
        let oldSession = session
        let resumptionHandle = latestResumptionHandle
        let priorMintedSession = mintedSession
        let tokenNearExpiry = Date().timeIntervalSince(mintedAt) > 25 * 60
        ws = nil
        session = nil
        socketStartAttempt = nil
        startAttemptLock.unlock()

        oldSocket?.cancel(with: .goingAway, reason: nil)
        oldSession?.invalidateAndCancel()
        dispatchEngineCallback(
            engineConnectionGeneration: startAttemptEngineGeneration
        ) { $0.liveWillReconnect() }

        if !forceFreshToken, !tokenNearExpiry, let minted = priorMintedSession {
            if (try? connect(
                minted,
                resumptionHandle: resumptionHandle,
                recoveryAttempt: true,
                startAttempt: startAttempt)) != nil { return }
        }
        Task { [weak self, startAttempt, priorMintedSession, resumptionHandle] in
            guard let self, self.acceptsStartAttempt(startAttempt) else { return }
            do {
                let body: [String: String] = [
                    "model": priorMintedSession?.model ?? AlmaLiveVoicePreferences.modelID,
                    "voice": priorMintedSession?.voice ?? AlmaLiveVoicePreferences.voiceID,
                ]
                let raw = try await AssistantNet.postJSONForData(
                    path: "/api/assistant/live-session", body: body)
                try Task.checkCancellation()
                guard self.acceptsStartAttempt(startAttempt) else { return }
                guard let minted = try? JSONDecoder().decode(SessionResponse.self, from: raw),
                      !minted.token.isEmpty else { throw AlmaLiveVoiceError.badSession }
                guard self.commitMintedSession(
                    minted,
                    mintedAt: Date(),
                    attempt: startAttempt
                ) else { return }
                try self.connect(
                    minted,
                    resumptionHandle: resumptionHandle,
                    recoveryAttempt: true,
                    startAttempt: startAttempt)
            } catch {
                self.startAttemptLock.lock()
                guard self.startAttemptState.acceptsActive(startAttempt) else {
                    self.startAttemptLock.unlock()
                    return
                }
                self.reconnecting = false
                self.startAttemptLock.unlock()
                self.fail(
                    "লাইভ ভয়েস সংযোগ বিচ্ছিন্ন হয়েছে।",
                    ifCurrentStartAttempt: startAttempt)
            }
        }
    }

    private func handleServerContent(
        _ content: [String: Any],
        attempt: AlmaLiveVoiceSocketAttempt,
        evidenceGeneration: Int
    ) {
        guard acceptsStartAttempt(attempt.startAttempt),
              isCurrentSocketAttempt(attempt)
        else { return }
        if content["interrupted"] as? Bool == true {
            _ = reduceInputTurn(generation: attempt.startAttempt) {
                $0.observeLocalBargeIn(generation: attempt.startAttempt)
            }
            #if DEBUG
            NSLog("ALMA-VOICE server INTERRUPTED model turn")
            #endif
            startAttemptLock.lock()
            guard startAttemptState.acceptsActive(attempt.startAttempt),
                  isCurrentSocketAttempt(attempt)
            else {
                startAttemptLock.unlock()
                return
            }
            stopModelPlayback(
                interrupted: true,
                engineConnectionGeneration: attempt.engineConnectionGeneration)
            startAttemptLock.unlock()
            dispatchEngineCallback(
                engineConnectionGeneration: attempt.engineConnectionGeneration,
                requiring: attempt
            ) { $0.liveWasInterrupted() }
        }
        if let input = content["inputTranscription"] as? [String: Any] {
            audioLock.lock()
            let modelPlaybackStillActive = modelAudioTurnOpen
            audioLock.unlock()
            _ = submitEvidence { recorder in
                recorder.recordProviderInputTranscriptionObserved(
                    generation: evidenceGeneration,
                    correlateToActiveInput: !modelPlaybackStillActive)
            }
            let text = input["text"] as? String
            let finished = input["finished"] as? Bool ?? false
            if let text, !text.isEmpty {
                if let usageProfile = profile(for: attempt.startAttempt) {
                    usageMeter.recordInputTranscription(text, profile: usageProfile)
                }
            }
            if usesInputTurnReducer() {
                let effects = reduceInputTurn(generation: attempt.startAttempt) {
                    $0.observeInputTranscription(
                        generation: attempt.startAttempt,
                        text: text,
                        finished: finished)
                }
                applyInputTurnEffects(effects, attempt: attempt)
            } else if let text {
                dispatchEngineCallback(
                    engineConnectionGeneration: attempt.engineConnectionGeneration,
                    requiring: attempt
                ) { $0.liveInputTranscript(text) }
            }
        }
        if let output = content["outputTranscription"] as? [String: Any],
           let text = output["text"] as? String {
            if let usageProfile = profile(for: attempt.startAttempt) {
                usageMeter.recordOutputTranscription(text, profile: usageProfile)
            }
            startAttemptLock.lock()
            guard startAttemptState.acceptsActive(attempt.startAttempt),
                  isCurrentSocketAttempt(attempt)
            else {
                startAttemptLock.unlock()
                return
            }
            outputTranscript += text
            let snapshot = outputTranscript
            startAttemptLock.unlock()
            dispatchEngineCallback(
                engineConnectionGeneration: attempt.engineConnectionGeneration,
                requiring: attempt
            ) { $0.liveOutputTranscript(snapshot) }
        }
        if let turn = content["modelTurn"] as? [String: Any],
           let parts = turn["parts"] as? [[String: Any]] {
            var observedInputBoundary = false
            for part in parts {
                guard let inline = part["inlineData"] as? [String: Any],
                      let encoded = inline["data"] as? String,
                      let pcm = Data(base64Encoded: encoded) else { continue }
                if !observedInputBoundary {
                    observedInputBoundary = true
                    let effects = reduceInputTurn(generation: attempt.startAttempt) {
                        $0.observeResponseBoundary(
                            generation: attempt.startAttempt,
                            .modelAudio)
                    }
                    applyInputTurnEffects(effects, attempt: attempt)
                }
                playPCM(
                    pcm,
                    attempt: attempt,
                    evidenceGeneration: evidenceGeneration)
            }
        }
        if content["generationComplete"] as? Bool == true {
            completeModelGeneration(attempt: attempt)
        }
        if content["turnComplete"] as? Bool == true {
            audioLock.lock()
            let responseHasLocalPlayback = modelAudioTurnOpen
            audioLock.unlock()
            let effects = reduceInputTurn(generation: attempt.startAttempt) {
                $0.observeResponseBoundary(
                    generation: attempt.startAttempt,
                    .turnComplete)
            }
            applyInputTurnEffects(effects, attempt: attempt)
            completeModelTurn(
                attempt: attempt,
                evidenceGeneration: evidenceGeneration)
            if !responseHasLocalPlayback {
                _ = reduceInputTurn(generation: attempt.startAttempt) {
                    $0.observeResponseCompleted(generation: attempt.startAttempt)
                }
            }
        }
    }

    private func playPCM(
        _ pcm: Data,
        attempt: AlmaLiveVoiceSocketAttempt,
        evidenceGeneration: Int
    ) {
        guard acceptsStartAttempt(attempt.startAttempt),
              isCurrentSocketAttempt(attempt)
        else { return }
        if let usageProfile = profile(for: attempt.startAttempt) {
            usageMeter.recordOutputAudio(byteCount: pcm.count, profile: usageProfile)
        }
        guard configured, let format = playbackFormat,
              let buffer = AVAudioPCMBuffer(pcmFormat: format,
                                            frameCapacity: AVAudioFrameCount(pcm.count / 2)),
              let destination = buffer.floatChannelData?[0] else { return }
        if !firstModelPCMTraced {
            firstModelPCMTraced = true
            trace("output.firstPCM", "bytes=\(pcm.count) running=\(audioEngine.isRunning ? 1 : 0)")
        }
        buffer.frameLength = buffer.frameCapacity
        pcm.withUnsafeBytes { raw in
            for index in 0..<Int(buffer.frameLength) {
                let sample = raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self)
                destination[index] = Float(Int16(littleEndian: sample)) / 32_768
            }
        }
        let duration = Double(buffer.frameLength) / format.sampleRate
        let now = Date()
        var bufferID = 0
        var generation = 0
        var newTurn = false
        var shouldStart = false
        var alreadyStarted = false
        var fallbackDeadline = Date.distantPast
        let serializesEvidenceBoundary = evidenceRecorder.isEnabled
        startAttemptLock.lock()
        guard startAttemptState.acceptsActive(attempt.startAttempt),
              isCurrentSocketAttempt(attempt)
        else {
            startAttemptLock.unlock()
            return
        }
        if serializesEvidenceBoundary { evidenceSubmissionLock.lock() }
        audioLock.lock()
        if bargeInPending {
            audioLock.unlock()
            if serializesEvidenceBoundary { evidenceSubmissionLock.unlock() }
            startAttemptLock.unlock()
            return
        }
        if !modelAudioTurnOpen {
            #if DEBUG
            NSLog("ALMA-VOICE model turn OPEN (first audio chunk)")
            #endif
            modelAudioTurnOpen = true
            modelGenerationCompleteReceived = false
            modelTurnCompleteReceived = false
            playbackStarted = false
            bufferedPlaybackDuration = 0
            estimatedPlaybackEnd = .distantPast
            pendingPlaybackBuffers.removeAll(keepingCapacity: true)
            playbackGeneration += 1
            echoCalibrationFrames = 0
            echoFloorRMS = 0.008
            bargeSpeechFrames = 0
            resetLoudspeakerProbeLocked()
            resetPlaybackReferenceLocked()
            micPreRoll.removeAll(keepingCapacity: true)
            newTurn = true
            if serializesEvidenceBoundary {
                beginModelEvidenceEpochLocked(
                    transportGeneration: evidenceGeneration,
                    playbackGeneration: playbackGeneration,
                    observedUptime: ProcessInfo.processInfo.systemUptime)
            }
        }
        generation = playbackGeneration
        nextPlaybackBufferID += 1
        bufferID = nextPlaybackBufferID
        pendingPlaybackBuffers.insert(bufferID)
        bufferedPlaybackDuration += duration
        alreadyStarted = playbackStarted
        if alreadyStarted {
            estimatedPlaybackEnd = max(now, estimatedPlaybackEnd).addingTimeInterval(duration)
            fallbackDeadline = estimatedPlaybackEnd
        } else {
            shouldStart = bufferedPlaybackDuration >= playbackPrebufferSeconds
        }
        audioLock.unlock()
        let scheduledBufferID = bufferID
        let scheduledGeneration = generation

        if newTurn, serializesEvidenceBoundary {
            beginNextEvidenceAudioTurn(generation: evidenceGeneration)
        }
        if serializesEvidenceBoundary { evidenceSubmissionLock.unlock() }
        startAttemptLock.unlock()

        audioQueue.async { [weak self, attempt] in
            guard let self, !self.stopped,
                  self.acceptsStartAttempt(attempt.startAttempt),
                  self.isCurrentSocketAttempt(attempt)
            else { return }
            self.audioLock.lock()
            let stillCurrent = self.playbackGeneration == scheduledGeneration
                && self.modelAudioTurnOpen
                && self.pendingPlaybackBuffers.contains(scheduledBufferID)
            self.audioLock.unlock()
            guard stillCurrent else { return }
            self.player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                self?.playbackBufferFinished(id: scheduledBufferID, generation: scheduledGeneration)
            }
        }

        if shouldStart {
            startBufferedPlayback(generation: scheduledGeneration, force: false)
        } else if newTurn {
            // A short answer can be smaller than the target prebuffer. Never make it
            // wait indefinitely for another frame.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) { [weak self] in
                self?.startBufferedPlayback(generation: scheduledGeneration, force: true)
            }
        } else if alreadyStarted {
            armPlaybackDrainFallback(generation: scheduledGeneration, deadline: fallbackDeadline)
        }
    }

    private func startBufferedPlayback(generation: Int, force: Bool) {
        audioLock.lock()
        guard !stopped, modelAudioTurnOpen, playbackGeneration == generation,
              !playbackStarted, !pendingPlaybackBuffers.isEmpty,
              force || bufferedPlaybackDuration >= playbackPrebufferSeconds else {
            audioLock.unlock()
            return
        }
        playbackStarted = true
        echoCalibrationFrames = 0
        echoFloorRMS = 0.008
        bargeSpeechFrames = 0
        resetLoudspeakerProbeLocked()
        resetPlaybackReferenceLocked()
        micPreRoll.removeAll(keepingCapacity: true)
        estimatedPlaybackEnd = Date().addingTimeInterval(bufferedPlaybackDuration)
        let deadline = estimatedPlaybackEnd
        let prebufferDuration = bufferedPlaybackDuration
        audioLock.unlock()

        audioQueue.async { [weak self] in
            guard let self, !self.stopped else { return }
            self.audioLock.lock()
            let stillCurrent = self.playbackGeneration == generation
                && self.modelAudioTurnOpen
                && self.playbackStarted
            self.audioLock.unlock()
            guard stillCurrent else { return }
            self.player.volume = 1
            if !self.firstPlaybackPrimed {
                self.firstPlaybackPrimed = true
                // A cold VoiceProcessingIO graph can report isRunning while its
                // render resource still belongs to the pre-activation/default
                // session. Reacquire it once, after real PCM is queued, without
                // discarding the scheduled player buffers.
                if self.audioEngine.isRunning { self.audioEngine.pause() }
                self.audioEngine.prepare()
                do {
                    try self.audioEngine.start()
                    self.trace("output.graphPrimed", "running=1")
                } catch {
                    self.trace("output.graphPrimeFailed", String(describing: error))
                }
            }
            if !self.player.isPlaying { self.player.play() }
            let recoveryGeneration = self.playbackRecoveryGeneration
            self.audioQueue.asyncAfter(deadline: .now() + 0.45) { [weak self] in
                guard let self, !self.stopped,
                      recoveryGeneration == self.playbackRecoveryGeneration else { return }
                self.audioLock.lock()
                let stillPlayingTurn = self.playbackStarted
                    && self.playbackGeneration == generation
                self.audioLock.unlock()
                guard stillPlayingTurn else { return }
                let renderedSamples: AVAudioFramePosition = self.player.lastRenderTime
                    .flatMap { self.player.playerTime(forNodeTime: $0)?.sampleTime } ?? 0
                let healthy = self.audioEngine.isRunning && self.player.isPlaying && renderedSamples > 0
                self.trace(healthy ? "output.renderHealthy" : "output.renderStalled",
                           "engine=\(self.audioEngine.isRunning ? 1 : 0) player=\(self.player.isPlaying ? 1 : 0) samples=\(renderedSamples)")
                guard !healthy else { return }
                if self.audioEngine.isRunning { self.audioEngine.pause() }
                self.audioEngine.prepare()
                do {
                    try self.audioEngine.start()
                    self.player.play()
                    self.trace("output.renderRecovered", "engine=1 player=\(self.player.isPlaying ? 1 : 0)")
                    self.dispatchEngineCallbackForActiveAttempt { [weak self] _ in
                        self?.enforceRequestedRoute(reason: "renderRecovery")
                    }
                    self.verifyRenderRecovery(after: 0.45,
                                              generation: recoveryGeneration,
                                              baselineSamples: renderedSamples)
                } catch {
                    self.trace("output.renderRecoveryFailed", String(describing: error))
                    self.reportRenderRecoveryFailure("engine restart failed")
                }
            }
        }
        // Belt+suspenders (same fix the legacy TTS path needed): anything can
        // flip the route to the receiver between turns — force the loud speaker
        // back whenever a spoken turn starts.
        audioLock.lock(); let wantSpeaker = speakerEnabled; audioLock.unlock()
        if wantSpeaker {
            dispatchEngineCallbackForActiveAttempt { _ in
                try? AVAudioSession.sharedInstance().overrideOutputAudioPort(.speaker)
            }
        }
        #if DEBUG
        NSLog("ALMA-VOICE playback turn started prebuffer=%.3fs", prebufferDuration)
        #endif
        dispatchEngineCallbackForActiveAttempt {
            $0.livePlaybackChanged(active: true, level: 0.65)
        }
        armPlaybackDrainFallback(generation: generation, deadline: deadline)
    }

    private func verifyRenderRecovery(after delay: TimeInterval,
                                      generation: Int,
                                      baselineSamples: AVAudioFramePosition) {
        audioQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopped,
                  generation == self.playbackRecoveryGeneration else { return }
            self.audioLock.lock()
            let stillPlayingTurn = self.playbackStarted
            self.audioLock.unlock()
            guard stillPlayingTurn else { return }
            let renderedSamples: AVAudioFramePosition = self.player.lastRenderTime
                .flatMap { self.player.playerTime(forNodeTime: $0)?.sampleTime } ?? 0
            let healthy = self.audioEngine.isRunning && self.player.isPlaying
                && renderedSamples > baselineSamples
            self.trace(healthy ? "output.renderRecoveryHealthy" : "output.renderRecoveryUnhealthy",
                       "engine=\(self.audioEngine.isRunning ? 1 : 0) player=\(self.player.isPlaying ? 1 : 0) "
                        + "samples=\(renderedSamples) baseline=\(baselineSamples)")
            if !healthy { self.reportRenderRecoveryFailure("renderer remained stalled") }
        }
    }

    private func reportRenderRecoveryFailure(_ reason: String) {
        let evidence = String(AlmaVoiceAudioTrace.tail(6).prefix(360))
        dispatchEngineCallbackForActiveAttempt { engine in
            guard engine.activeAgentCallId != nil else { return }
            AgentCallController.shared.reportLiveFailure("audio \(reason) | \(evidence)")
        }
    }

    private func playbackBufferFinished(id: Int, generation: Int) {
        audioLock.lock()
        guard playbackGeneration == generation else {
            audioLock.unlock()
            return
        }
        pendingPlaybackBuffers.remove(id)
        let shouldFinish = modelAudioTurnOpen
            && (modelGenerationCompleteReceived || modelTurnCompleteReceived)
            && pendingPlaybackBuffers.isEmpty
        audioLock.unlock()
        if shouldFinish { finishModelPlayback(generation: generation) }
    }

    /// VoiceProcessingIO occasionally omits per-buffer completion callbacks in the
    /// simulator. One turn-level deadline is a fallback only; extending it for every
    /// newly scheduled chunk prevents an older timer from ending speech mid-sentence.
    private func armPlaybackDrainFallback(generation: Int, deadline: Date) {
        let delay = max(0, deadline.timeIntervalSinceNow) + 0.12
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopped else { return }
            self.audioLock.lock()
            guard self.playbackGeneration == generation,
                  self.playbackStarted,
                  Date() >= self.estimatedPlaybackEnd.addingTimeInterval(0.08) else {
                self.audioLock.unlock()
                return
            }
            self.pendingPlaybackBuffers.removeAll(keepingCapacity: true)
            let shouldFinish = self.modelAudioTurnOpen
                && (self.modelGenerationCompleteReceived || self.modelTurnCompleteReceived)
            self.audioLock.unlock()
            if shouldFinish { self.finishModelPlayback(generation: generation) }
        }
        // HARD WATCHDOG (device finding, build 82): if generationComplete itself is
        // lost (rotation, dropped frame), the guard above can never pass and the
        // turn stays open — stuck "বলছি", mic gated, call deaf. 3s after the last
        // scheduled audio should have drained, force-close the turn no matter what.
        DispatchQueue.main.asyncAfter(deadline: .now() + delay + 3.0) { [weak self] in
            guard let self, !self.stopped else { return }
            self.audioLock.lock()
            let stuck = self.playbackGeneration == generation
                && self.modelAudioTurnOpen
                && Date() >= self.estimatedPlaybackEnd.addingTimeInterval(2.5)
            if stuck {
                self.modelGenerationCompleteReceived = true
                self.pendingPlaybackBuffers.removeAll(keepingCapacity: true)
            }
            self.audioLock.unlock()
            if stuck {
                #if DEBUG
                NSLog("ALMA-VOICE watchdog force-closed a stuck model turn")
                #endif
                self.finishModelPlayback(generation: generation)
            }
        }
    }

    private func completeModelGeneration(attempt: AlmaLiveVoiceSocketAttempt) {
        startAttemptLock.lock()
        guard startAttemptState.acceptsActive(attempt.startAttempt),
              isCurrentSocketAttempt(attempt)
        else {
            startAttemptLock.unlock()
            return
        }
        audioLock.lock()
        modelGenerationCompleteReceived = true
        let generation = playbackGeneration
        let needsStart = modelAudioTurnOpen && !playbackStarted && !pendingPlaybackBuffers.isEmpty
        let shouldFinish = modelAudioTurnOpen && pendingPlaybackBuffers.isEmpty
        audioLock.unlock()
        startAttemptLock.unlock()
        if needsStart { startBufferedPlayback(generation: generation, force: true) }
        if shouldFinish { finishModelPlayback(generation: generation) }
    }

    private func completeModelTurn(
        attempt: AlmaLiveVoiceSocketAttempt,
        evidenceGeneration: Int
    ) {
        startAttemptLock.lock()
        guard startAttemptState.acceptsActive(attempt.startAttempt),
              isCurrentSocketAttempt(attempt)
        else {
            startAttemptLock.unlock()
            return
        }
        #if DEBUG
        NSLog("ALMA-VOICE model turn complete transcriptChars=%d", outputTranscript.count)
        #endif
        outputTranscript = ""
        _ = submitEvidence { recorder in
            recorder.recordModelTurnCompleted(generation: evidenceGeneration)
        }
        audioLock.lock()
        bargeInPending = false
        bargeSpeechFrames = 0
        micPreRoll.removeAll(keepingCapacity: true)
        modelGenerationCompleteReceived = true
        modelTurnCompleteReceived = true
        let generation = playbackGeneration
        let needsStart = modelAudioTurnOpen && !playbackStarted && !pendingPlaybackBuffers.isEmpty
        let shouldFinish = modelAudioTurnOpen && pendingPlaybackBuffers.isEmpty
        audioLock.unlock()
        startAttemptLock.unlock()
        if needsStart { startBufferedPlayback(generation: generation, force: true) }
        if shouldFinish { finishModelPlayback(generation: generation) }
    }

    private func finishModelPlayback(generation: Int) {
        audioLock.lock()
        guard playbackGeneration == generation, modelAudioTurnOpen,
              (modelGenerationCompleteReceived || modelTurnCompleteReceived),
              pendingPlaybackBuffers.isEmpty else {
            audioLock.unlock()
            return
        }
        modelAudioTurnOpen = false
        modelGenerationCompleteReceived = false
        modelTurnCompleteReceived = false
        playbackStarted = false
        bufferedPlaybackDuration = 0
        estimatedPlaybackEnd = .distantPast
        playbackGeneration += 1
        echoCalibrationFrames = 0
        echoFloorRMS = 0.008
        bargeSpeechFrames = 0
        resetLoudspeakerProbeLocked()
        resetPlaybackReferenceLocked()
        micPreRoll.removeAll(keepingCapacity: true)
        // Simulator / speaker fallback has no VPIO cancellation and showed a
        // real 650ms post-playback echo re-opening the gate. Give that route a
        // full 1.2s; AEC/receiver routes need only a short render-tail guard.
        let echoExposedLoudspeaker = voiceProcessingUnavailable && speakerEnabled
        listenSuppressedUntil = Date().addingTimeInterval(
            echoExposedLoudspeaker ? 1.2 : 0.25)
        listenTailSuppressionLogged = false
        audioLock.unlock()

        audioQueue.async { [weak self] in
            self?.player.stop()
            self?.player.volume = 1
        }
        #if DEBUG
        NSLog("ALMA-VOICE playback turn finished")
        #endif
        if let attempt = activeStartAttempt() {
            _ = reduceInputTurn(generation: attempt) {
                $0.observeResponseCompleted(generation: attempt)
            }
        }
        dispatchEngineCallbackForActiveAttempt {
            $0.livePlaybackChanged(active: false, level: 0)
        }
    }

    private func beginLocalBargeIn() {
        stopModelPlayback(interrupted: false)
    }

    private func stopModelPlayback(
        interrupted: Bool,
        engineConnectionGeneration: Int? = nil
    ) {
        audioLock.lock()
        let wasActive = modelAudioTurnOpen || playbackStarted || !pendingPlaybackBuffers.isEmpty
        pendingPlaybackBuffers.removeAll(keepingCapacity: true)
        modelAudioTurnOpen = false
        modelGenerationCompleteReceived = false
        modelTurnCompleteReceived = false
        playbackStarted = false
        bufferedPlaybackDuration = 0
        estimatedPlaybackEnd = .distantPast
        playbackGeneration += 1
        if interrupted { bargeInPending = false }
        // This path is a real interruption (local pre-roll is sent immediately,
        // then the server confirms it). Never apply the natural-finish echo tail
        // guard here or the rest of the owner's utterance would be clipped.
        listenSuppressedUntil = .distantPast
        listenTailSuppressionLogged = false
        echoCalibrationFrames = 0
        echoFloorRMS = 0.008
        bargeSpeechFrames = 0
        resetLoudspeakerProbeLocked()
        resetPlaybackReferenceLocked()
        micPreRoll.removeAll(keepingCapacity: true)
        audioLock.unlock()

        audioQueue.async { [weak self] in
            self?.player.stop()
            self?.player.volume = 1
        }
        #if DEBUG
        if interrupted { NSLog("ALMA-VOICE server confirmed interruption") }
        #endif
        if wasActive {
            if let engineConnectionGeneration {
                dispatchEngineCallback(
                    engineConnectionGeneration: engineConnectionGeneration
                ) { $0.livePlaybackChanged(active: false, level: 0) }
            } else {
                dispatchEngineCallbackForActiveAttempt {
                    $0.livePlaybackChanged(active: false, level: 0)
                }
            }
        }
    }

    func sendToolResponse(callId: String, result: String, name: String) {
        sendJSON(["toolResponse": ["functionResponses": [[
            "id": callId,
            // The response must carry the INVOKED function's name — answering
            // end_call as run_agent_turn left the tool unresolved (Codex P2).
            "name": name,
            "response": ["result": result],
        ]]]])
    }

    func sendRealtimeText(_ text: String) {
        sendJSON(["realtimeInput": ["text": text]])
    }

    private func recordAudioNotQueued(
        _ reason: AlmaLiveVoiceEvidenceNotQueuedReason,
        byteCount: Int,
        sourceGeneration: Int,
        inputEvidence: AlmaLiveVoiceEvidenceInputDeliveryToken? = nil,
        observedUptime: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) {
        guard evidenceRecorder.isEnabled, byteCount > 0 else { return }
        evidenceSubmissionLock.lock()
        guard evidenceSessionAccepting else {
            evidenceSubmissionLock.unlock()
            return
        }
        guard let inputEvidence,
              inputEvidence.windowID.transportGeneration == sourceGeneration,
              inputEvidenceWindowMatches(inputEvidence.windowID),
              inputEvidenceChainReady(inputEvidence.windowID) else {
            evidenceSubmissionLock.unlock()
            return
        }
        let submitted = submitEvidenceLocked { recorder in
            recorder.recordAudioNotQueued(
                reason,
                byteCount: byteCount,
                generation: sourceGeneration,
                inputWindowID: inputEvidence.windowID,
                observedUptime: observedUptime)
        }
        if submitted {
            // This typed local disposition is one-shot for the window. A later
            // transport/model window can retry; this failed disposition must
            // not make every subsequent capture re-enter evidence locks.
            markInputEvidenceIntakeComplete(inputEvidence.windowID)
        }
        evidenceSubmissionLock.unlock()
    }

    private func prepareAudioSendEvidence(
        for socket: URLSessionWebSocketTask,
        byteCount: Int,
        sourceGeneration: Int,
        observedUptime: TimeInterval,
        inputEvidence: AlmaLiveVoiceEvidenceInputDeliveryToken?
    ) -> (
        claim: (
            generation: Int,
            turnEpoch: Int,
            claimID: Int,
            windowID: AlmaLiveVoiceEvidenceInputWindowID
        )?,
        submitted: Bool
    ) {
        guard evidenceRecorder.isEnabled else { return (nil, true) }
        evidenceSubmissionLock.lock()
        guard evidenceSessionAccepting else {
            evidenceSubmissionLock.unlock()
            return (nil, false)
        }
        guard let inputEvidence else {
            evidenceSubmissionLock.unlock()
            return (nil, true)
        }
        guard inputEvidence.windowID.transportGeneration == sourceGeneration,
              inputEvidenceWindowMatches(inputEvidence.windowID) else {
            evidenceSubmissionLock.unlock()
            return (nil, true)
        }
        let chainReady = inputEvidenceChainReady(inputEvidence.windowID)
        let claimResult: AudioSendEvidenceClaimResult = chainReady
            ? claimEvidenceAudioSend(for: socket, sourceGeneration: sourceGeneration)
            : .alreadyCovered
        let claim: (
            generation: Int,
            turnEpoch: Int,
            claimID: Int,
            windowID: AlmaLiveVoiceEvidenceInputWindowID
        )?
        let bindingUnavailable: Bool
        switch claimResult {
        case .claimed(let generation, let turnEpoch, let claimID):
            claim = (
                generation,
                turnEpoch,
                claimID,
                inputEvidence.windowID)
            bindingUnavailable = false
        case .alreadyCovered:
            claim = nil
            bindingUnavailable = false
        case .unavailable:
            claim = nil
            bindingUnavailable = true
        }
        guard claim != nil || bindingUnavailable else {
            evidenceSubmissionLock.unlock()
            return (nil, true)
        }
        let submitted = submitEvidenceLocked { [weak self] recorder in
            if bindingUnavailable {
                recorder.recordAudioSendTrackingUnavailable(
                    byteCount: byteCount,
                    generation: sourceGeneration,
                    inputWindowID: inputEvidence.windowID,
                    observedUptime: observedUptime)
                return
            }
            guard let claim,
                  let self,
                  let context = recorder.recordAudioQueued(
                    byteCount: byteCount,
                    generation: claim.generation,
                    inputWindowID: claim.windowID,
                    observedUptime: observedUptime) else { return }
            self.evidenceSendContexts[claim.claimID] = context
        }
        if !submitted, let claim {
            abandonEvidenceAudioSendClaim(turnEpoch: claim.turnEpoch)
        } else if submitted, claim != nil || bindingUnavailable {
            markInputEvidenceIntakeComplete(inputEvidence.windowID)
        }
        evidenceSubmissionLock.unlock()
        return (claim, submitted)
    }

    private func submitAudioSendCompletion(
        for socket: URLSessionWebSocketTask,
        claim: (
            generation: Int,
            turnEpoch: Int,
            claimID: Int,
            windowID: AlmaLiveVoiceEvidenceInputWindowID
        ),
        succeeded: Bool,
        observedUptime: TimeInterval
    ) {
        guard evidenceRecorder.isEnabled else { return }
        evidenceSubmissionLock.lock()
        guard evidenceSessionAccepting else {
            evidenceSubmissionLock.unlock()
            return
        }
        let state = evidenceCompletionState(
            for: socket,
            sourceGeneration: claim.generation,
            turnEpoch: claim.turnEpoch,
            succeeded: succeeded)
        if !succeeded || !state.isCurrentReadySocket {
            markInputEvidenceIntakeNeedsRetry(claim.windowID)
        }
        _ = submitEvidenceLocked { [weak self] recorder in
            guard let self,
                  let context = self.evidenceSendContexts.removeValue(
                    forKey: claim.claimID) else { return }
            recorder.recordAudioSendCompletion(
                context,
                succeeded: succeeded,
                currentGeneration: state.currentGeneration,
                isCurrentReadySocket: state.isCurrentReadySocket,
                observedUptime: observedUptime)
        }
        evidenceSubmissionLock.unlock()
    }

    @discardableResult
    private func sendJSON(
        _ object: [String: Any],
        requireReady: Bool = true,
        sourceSocket: URLSessionWebSocketTask? = nil,
        audioEvidenceByteCount: Int? = nil,
        audioEvidenceGeneration: Int? = nil,
        audioSourceAttempt: AlmaLiveVoiceSocketAttempt? = nil,
        audioInputEvidence: AlmaLiveVoiceEvidenceInputDeliveryToken? = nil,
        usageInputAudioByteCount: Int? = nil,
        usageProfile: AlmaLiveVoiceProfile? = nil,
        completion: ((Error?) -> Void)? = nil
    ) -> Bool {
        guard !stopped else { return false }
        let sourceGeneration = audioEvidenceGeneration
            ?? evidenceTransportGenerationSnapshot()
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else {
            if let byteCount = audioEvidenceByteCount {
                recordAudioNotQueued(
                    .serializationFailed,
                    byteCount: byteCount,
                    sourceGeneration: sourceGeneration,
                    inputEvidence: audioInputEvidence)
            }
            return false
        }
        guard let socket = sourceSocket ?? ws else {
            if let byteCount = audioEvidenceByteCount {
                recordAudioNotQueued(
                    .socketUnavailable,
                    byteCount: byteCount,
                    sourceGeneration: sourceGeneration,
                    inputEvidence: audioInputEvidence)
            }
            return false
        }
        readinessLock.lock()
        let notQueuedReason = AlmaLiveVoiceAudioSendValidation.notQueuedReason(
            socketIdentity: ObjectIdentifier(socket),
            currentAttempt: readiness.socketAttempt,
            socketReady: socketReady,
            requireReady: requireReady,
            sourceAttempt: audioSourceAttempt)
        guard notQueuedReason == nil else {
            readinessLock.unlock()
            if let byteCount = audioEvidenceByteCount, let notQueuedReason {
                recordAudioNotQueued(
                    notQueuedReason,
                    byteCount: byteCount,
                    sourceGeneration: sourceGeneration,
                    inputEvidence: audioInputEvidence)
            }
            return false
        }
        let evidenceSend = audioEvidenceByteCount.map {
            prepareAudioSendEvidence(
                for: socket,
                byteCount: $0,
                sourceGeneration: sourceGeneration,
                observedUptime: ProcessInfo.processInfo.systemUptime,
                inputEvidence: audioInputEvidence)
        }
        if let byteCount = usageInputAudioByteCount, let usageProfile {
            usageMeter.recordInputAudio(byteCount: byteCount, profile: usageProfile)
        }
        readinessLock.unlock()
        socket.send(.string(text)) { [weak self, weak socket] error in
            completion?(error)
            if let self, let socket, let evidenceSend,
               let claim = evidenceSend.claim, evidenceSend.submitted {
                self.submitAudioSendCompletion(
                    for: socket,
                    claim: claim,
                    succeeded: error == nil,
                    observedUptime: ProcessInfo.processInfo.systemUptime)
            }
            if let error {
                #if DEBUG
                NSLog("ALMA-VOICE websocket send failed: %@", String(describing: error))
                #endif
                // A stale socket's late failure must not tear down a healthy
                // replacement connection. For the CURRENT socket, a failed send
                // (mic audio streams continuously, so a rotating socket usually
                // hits a send first) recovers exactly like a failed receive --
                // never an instant call kill.
                guard let self, let socket,
                      let sourceAttempt = self.currentSocketAttempt(for: socket),
                      self.isCurrentPhysicalSocketAttempt(sourceAttempt)
                else { return }
                if let generation = self.evidenceGeneration(
                    for: socket,
                    requireReady: false) {
                    self.recordTransportEvidence(
                        .socketSendFailed,
                        generation: generation,
                        observedUptime: ProcessInfo.processInfo.systemUptime)
                }
                if self.invalidateSocketReadiness(attempt: sourceAttempt) {
                    self.recoverConnection(from: sourceAttempt)
                }
            }
        }
        return true
    }

    func setInputMuted(_ muted: Bool) {
        audioLock.lock()
        let flushAutomaticVADStream = muted && listenGateOpen
        let reducerAttempt = captureSocketAttempt
        inputMuted = muted
        let restoreProbeVolume = loudspeakerProbeActive
        resetLoudspeakerProbeLocked()
        micPreRoll.removeAll(keepingCapacity: true)
        bargeSpeechFrames = 0
        echoCalibrationFrames = 0
        echoFloorRMS = 0.008
        resetPlaybackReferenceLocked()
        // The listening gate must not carry audio or detector state across the
        // mute boundary (Codex P2): retained pre-roll chunks would otherwise be
        // flushed ahead of the first post-unmute utterance, and an open gate
        // would resume as open.
        listenPreRoll.removeAll(keepingCapacity: true)
        listenGateOpen = false
        listenSpeechFrames = 0
        listenSilenceFrames = 0
        listenNoiseFloorRMS = 0.004
        listenCalibrationFrames = 0
        listenCalibMinRMS = .greatestFiniteMagnitude
        listenContinuousLoudFrames = 0
        listenSuppressedUntil = .distantPast
        listenTailSuppressionLogged = false
        audioLock.unlock()
        if let reducerAttempt, usesInputTurnReducer() {
            let effects = reduceInputTurn(generation: reducerAttempt.startAttempt) {
                $0.setMuted(muted, generation: reducerAttempt.startAttempt)
            }
            applyInputTurnEffects(effects, attempt: reducerAttempt)
        } else if flushAutomaticVADStream {
            sendJSON(["realtimeInput": ["audioStreamEnd": true]])
        }
        if restoreProbeVolume { setLoudspeakerProbeMuted(false) }
    }

    func setSpeakerEnabled(_ enabled: Bool) throws {
        audioLock.lock()
        speakerEnabled = enabled
        let isConfigured = configured
        let restoreProbeVolume = loudspeakerProbeActive
        resetLoudspeakerProbeLocked()
        resetPlaybackReferenceLocked()
        audioLock.unlock()
        if restoreProbeVolume { setLoudspeakerProbeMuted(false) }
        trace("route.request", "want=\(enabled ? "speaker" : "receiver") configured=\(isConfigured ? 1 : 0)")
        guard isConfigured else { return }
        let session = AVAudioSession.sharedInstance()
        // Another in-process audio feature may have left defaultToSpeaker on the
        // shared session. Remove it before `.none`, otherwise speaker OFF is a
        // no-op and the route immediately returns to loudspeaker.
        if session.category != .playAndRecord || session.mode != .voiceChat
            || session.categoryOptions.contains(.defaultToSpeaker) {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
        }
        try session.overrideOutputAudioPort(enabled ? .speaker : .none)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
            self?.verifyRequestedRoute(attempt: 1)
        }
    }

    func interruptPlayback() {
        audioLock.lock()
        // A deliberate orb tap is an immediate barge-in: discard any remaining
        // model frames and let subsequent microphone frames flow without waiting
        // for the sustained-speech gate.
        bargeInPending = true
        audioLock.unlock()
        stopModelPlayback(interrupted: false)
    }

    func recoverAudio() {
        guard configured else { return }
        let gate = readinessSnapshot()
        if gate.callKitManaged {
            guard gate.callKitAudioActive else { return }
        } else {
            try? AVAudioSession.sharedInstance().setActive(true)
        }
        audioLock.lock()
        let shouldPlay = playbackStarted
        audioLock.unlock()
        audioQueue.async { [weak self] in
            guard let self, !self.stopped else { return }
            if !self.audioEngine.isRunning { try? self.audioEngine.start() }
            if shouldPlay, !self.player.isPlaying { self.player.play() }
        }
    }

    @discardableResult
    func stop(
        waitForAudioTeardown: Bool = false,
        ifCurrentStartAttempt expectedStartAttempt:
            AlmaLiveVoiceStartAttemptState.Token? = nil,
        ifCurrentSocketAttempt expectedSocketAttempt:
            AlmaLiveVoiceSocketAttempt? = nil
    ) -> Bool {
        // Invalidate first, under the same lock used by final socket
        // publication. A queued/cancelled `start` can no longer clear stopped
        // or publish a socket after this terminal boundary.
        startAttemptLock.lock()
        while startAttemptTeardownInProgress { startAttemptLock.wait() }
        let expectedLogicalAttempt = expectedStartAttempt
            ?? expectedSocketAttempt?.startAttempt
        if let expectedLogicalAttempt,
           !startAttemptState.acceptsActive(expectedLogicalAttempt) {
            startAttemptLock.unlock()
            return false
        }
        if let expectedSocketAttempt,
           !isCurrentPhysicalSocketAttemptLocked(expectedSocketAttempt) {
            startAttemptLock.unlock()
            return false
        }
        startAttemptTeardownInProgress = true
        startAttemptState.invalidate()
        startAttemptEngineConnectionGeneration = nil
        startAttemptProfile = nil
        socketStartAttempt = nil
        let detachedSocket = ws
        let detachedSession = session
        ws = nil
        session = nil
        stopped = true
        startAttemptLock.unlock()
        _ = invalidateSocketReadiness()
        stopKeepalive()
        soundAnalyzer?.completeAnalysis()
        soundAnalyzer = nil
        soundRequest = nil
        soundObserver = nil
        soundAnalysisFramePosition = 0
        if let ob = routeObserver {
            NotificationCenter.default.removeObserver(ob)
            routeObserver = nil
        }
        let hadTap = tapInstalled
        let hadPlaybackReferenceTap = playbackReferenceTapInstalled
        let appOwnsActivation = !callKitOwnsAudioSession
        tapInstalled = false
        playbackReferenceTapInstalled = false
        let teardownAudio = { [weak self] in
            guard let self else { return }
            if hadTap { self.audioEngine.inputNode.removeTap(onBus: 0) }
            if hadPlaybackReferenceTap {
                self.audioEngine.mainMixerNode.removeTap(onBus: 0)
            }
            self.player.stop()
            self.player.volume = 1
            if self.audioEngine.isRunning { self.audioEngine.stop() }
            if appOwnsActivation {
                try? AVAudioSession.sharedInstance().setActive(
                    false, options: [.notifyOthersOnDeactivation])
            }
        }
        if waitForAudioTeardown {
            audioQueue.sync(execute: teardownAudio)
        } else {
            audioQueue.async(execute: teardownAudio)
        }
        // Deliberately NOT detaching the player: detach with completion callbacks
        // in flight is a CoreAudio crash; the node stays attached for the next call.
        detachedSocket?.cancel(with: .normalClosure, reason: nil)
        detachedSession?.invalidateAndCancel()
        configured = false
        updateReadiness { state in
            state.callKitManaged = callKitOwnsAudioSession
            state.resetMedia()
        }
        // Must reset with the socket: a pending flag surviving into the next
        // connect attempt let a late didActivate finish THAT session before its
        // setupComplete (review-bot P1 #2 on PR #653).
        audioConfigPending = false
        audioAttemptGeneration += 1
        inputConverter = nil
        inputFormat = nil
        playbackFormat = nil
        reconnecting = false
        mintedSession = nil
        pendingResumptionHandle = nil
        latestResumptionHandle = nil
        hasConnectedOnce = false
        outputTranscript = ""
        audioLock.lock()
        pendingPlaybackBuffers.removeAll(keepingCapacity: true)
        bufferedPlaybackDuration = 0
        estimatedPlaybackEnd = .distantPast
        playbackGeneration += 1
        modelAudioTurnOpen = false
        modelGenerationCompleteReceived = false
        modelTurnCompleteReceived = false
        playbackStarted = false
        bargeInPending = false
        bargeSpeechFrames = 0
        echoCalibrationFrames = 0
        echoFloorRMS = 0.008
        resetLoudspeakerProbeLocked()
        resetPlaybackReferenceLocked()
        soundSpeechConfidence = 0
        soundMusicConfidence = 0
        soundNoiseConfidence = 0
        soundClassificationAt = .distantPast
        micPreRoll.removeAll(keepingCapacity: true)
        // Listening-gate state must not leak into the next session (Codex P2):
        // an open gate would stream background audio at call start, stale
        // pre-roll would flush a previous call's PCM, and a noise floor learned
        // in another room could suppress speech in the new one.
        listenPreRoll.removeAll(keepingCapacity: true)
        listenGateOpen = false
        listenSpeechFrames = 0
        listenSilenceFrames = 0
        listenNoiseFloorRMS = 0.004
        listenCalibrationFrames = 0
        listenCalibMinRMS = .greatestFiniteMagnitude
        listenContinuousLoudFrames = 0
        audioLock.unlock()
        startAttemptLock.lock()
        startAttemptTeardownInProgress = false
        startAttemptLock.broadcast()
        startAttemptLock.unlock()
        return true
    }

    /// Drains only work already queued on this session's private audio queue.
    /// A displaced standalone owner registers this as its post-PushKit-report
    /// receipt; no network, provider, or MainActor state is touched here.
    func waitForPendingAudioTeardown() {
        audioQueue.sync {}
    }

    private func fail(
        _ message: String,
        ifCurrentStartAttempt expectedStartAttempt:
            AlmaLiveVoiceStartAttemptState.Token? = nil,
        ifCurrentSocketAttempt expectedSocketAttempt:
            AlmaLiveVoiceSocketAttempt? = nil
    ) {
        guard !stopped,
              let attempt = expectedSocketAttempt?.startAttempt
                ?? expectedStartAttempt
                ?? activeStartAttempt(),
              let generation = engineConnectionGeneration(for: attempt)
        else { return }
        guard stop(
            ifCurrentStartAttempt: attempt,
            ifCurrentSocketAttempt: expectedSocketAttempt)
        else { return }
        dispatchEngineCallback(engineConnectionGeneration: generation) {
            $0.liveDidFail(message)
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        #if DEBUG
        NSLog("ALMA-VOICE websocket opened")
        #endif
        guard !stopped, ws === webSocketTask, let minted = mintedSession else { return }
        if let generation = evidenceGeneration(for: webSocketTask, requireReady: false) {
            _ = submitEvidence { recorder in
                recorder.recordSocketOpened(generation: generation)
            }
        }
        sendJSON(setupMessage(model: minted.model, voice: minted.voice,
                              resumptionHandle: pendingResumptionHandle),
                 requireReady: false,
                 sourceSocket: webSocketTask)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        #if DEBUG
        NSLog("ALMA-VOICE websocket closed code=%d", closeCode.rawValue)
        #endif
        if let generation = evidenceGeneration(
            for: webSocketTask,
            requireReady: false) {
            recordTransportEvidence(.socketClosed, generation: generation)
        }
    }
}

// MARK: - TRUE streaming STT (OpenAI Realtime transcription over WebSocket)
//
// Web parity for gap #12: the mic PCM streams straight to OpenAI's realtime
// transcription session and the transcript arrives WHILE the owner speaks. The
// ephemeral token is minted by our own /api/assistant/stt-session (same
// gpt-4o-transcribe + Bangla prompt). Endpointing stays OURS (server VAD off):
// the same calibrated/adaptive rules as the recorder path. ANY pre-audio
// failure throws from start() so the engine falls back to record→/transcribe —
// streaming is an upgrade, never a dependency.

enum AlmaVoiceSTTError: Error { case noToken, badURL, socket, noMic, noConverter }

@available(iOS 17.0, *)
final class AlmaStreamingSTT: NSObject, URLSessionWebSocketDelegate {
    weak var engine: AlmaVoiceEngine?    // @MainActor — UI hops through it
    // Closure sinks (chat-composer live dictation reuses this streamer without
    // an AlmaVoiceEngine): fired on the main thread alongside the engine hops.
    var onPartialSink: ((String) -> Void)?
    var onFinalSink: ((String) -> Void)?
    var onErrorSink: ((String) -> Void)?
    var onLevelSink: ((Double) -> Void)?
    var onNoSpeechSink: (() -> Void)?
    /// Composer dictation has no AlmaVoiceEngine — without this sink a degraded
    /// socket's WAV fallback had NOWHERE to go and the take silently vanished.
    var onFallbackUploadSink: ((Data) -> Void)?
    /// Composer dictation: the session is minted with server_vad (OpenAI commits
    /// at natural pauses → words stream LIVE), items accumulate across pauses,
    /// and the local VAD never auto-ends the utterance — only ✓/✕ do.
    var dictationMode = false
    /// Item-keyed transcript ledger: OpenAI pipelines SEVERAL committed chunks
    /// concurrently — deltas/completions interleave across items. One shared
    /// buffer garbled text and dropped chunks on ✓ (owner hit both). Each item
    /// keeps its own text, display joins them in arrival order, and finish waits
    /// for EVERY item to complete.
    private var dictItems: [(id: String, text: String, done: Bool)] = []
    private var finishRequested = false

    private var session: URLSession?
    private var ws: URLSessionWebSocketTask?
    private var connectTask: Task<Void, Never>?
    private let audioEngine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var outFormat: AVAudioFormat?
    private var tapInstalled = false
    private var openCont: CheckedContinuation<Void, Error>?
    private var openSocketIdentity: ObjectIdentifier?

    // VAD state — touched on the CoreAudio tap thread (serialized by CoreAudio).
    private var elapsedMs = 0.0
    private var noiseFloor = 0.0, floorSamples = 0.0
    private var speechThresh = 0.022
    private let silenceThresh = 0.014
    private var sustainedMs = 0.0
    private var spoke = false
    private var speechStartMs = 0.0
    private var silenceMs = 0.0
    private var lastSecond = -1

    private var committed = false
    private var completedFired = false
    private var failed = false
    private var partial = ""

    // MIC-FIRST plumbing ("tap korle 3-4 sec por start hoy" fix): the mic starts
    // the instant the owner taps; PCM buffers locally while the token + socket
    // connect in the background, then flushes. If the socket never comes up, the
    // buffered audio uploads to /transcribe as a WAV — the owner's words are
    // NEVER lost to connection latency.
    private let lock = NSLock()
    private var pending: [Data] = []      // chunks awaiting the socket
    private var fullAudio = Data()        // whole utterance (fallback upload)
    private var socketOpen = false
    private var connectFailed = false
    private var wantCommit = false        // VAD ended before the socket was ready
    private var fallbackUploaded = false  // WAV salvage fired (once per utterance)

    /// `cancel()` is a terminal state for one streamer instance.  The console
    /// and composer each create a fresh instance per listen; keeping cancellation
    /// outside `reset()` prevents a queued `start()` from clearing an earlier
    /// teardown and reopening AVAudioEngine after dismissal/hang-up.
    private let lifecycleLock = NSLock()
    private var startReserved = false
    private var cancellationRequested = false

    private struct TokenResp: Decodable { let key: String? }

    private func reset() {
        elapsedMs = 0; noiseFloor = 0; floorSamples = 0
        speechThresh = 0.022; sustainedMs = 0; spoke = false
        speechStartMs = 0; silenceMs = 0; lastSecond = -1
        committed = false; completedFired = false; failed = false; partial = ""
        dictItems = []; finishRequested = false; lastCommitAt = Date()
        dictVoicedMs = 0; dictDipMs = 0
        pending = []; fullAudio = Data()
        socketOpen = false; connectFailed = false; wantCommit = false
        fallbackUploaded = false
    }

    /// MIC FIRST: start capturing immediately (throws only on a mic failure —
    /// caller falls back to the recorder path with no state changed yet), then
    /// mint the token + open the socket in the background.
    func start() async throws {
        try Task.checkCancellation()

        // Serialize the cancellation decision with the actual synchronous mic
        // mutation. If cancel wins first, no tap is installed. If start wins,
        // cancel waits and then immediately tears down the just-started graph.
        lifecycleLock.lock()
        guard !startReserved, !cancellationRequested, !Task.isCancelled else {
            lifecycleLock.unlock()
            throw CancellationError()
        }
        startReserved = true
        reset()
        do {
            try startMic()
        } catch {
            stopMic()
            lifecycleLock.unlock()
            throw error
        }
        let cancelledDuringStart = Task.isCancelled || cancellationRequested
        lifecycleLock.unlock()
        if cancelledDuringStart {
            cancel()
            throw CancellationError()
        }

        await MainActor.run { self.engine?.streamDidStart(from: self) }
        try Task.checkCancellation()

        // Assign the connection task while cancellation is excluded.  Otherwise
        // cancel could observe nil, return, and let this stale start publish a new
        // token/WebSocket task immediately afterward.
        lifecycleLock.lock()
        guard !cancellationRequested, !Task.isCancelled else {
            lifecycleLock.unlock()
            cancel()
            throw CancellationError()
        }
        connectTask = Task { [weak self] in
            guard let self, !self.isCancellationRequested(), !Task.isCancelled else { return }
            await self.connect()
        }
        lifecycleLock.unlock()
    }

    private func isCancellationRequested() -> Bool {
        lifecycleLock.lock()
        let value = cancellationRequested
        lifecycleLock.unlock()
        return value
    }

    /// Token mint → socket handshake → force OUR endpointing → flush the buffer.
    private func connect() async {
        do {
            guard !isCancellationRequested(), !Task.isCancelled else { return }
            let data = try await AssistantNet.postJSONForData(
                path: "/api/assistant/stt-session",
                body: dictationMode ? ["mode": "dictation"] : [:])
            guard !isCancellationRequested(), !Task.isCancelled else { return }
            guard let key = (try? JSONDecoder().decode(TokenResp.self, from: data))?.key, !key.isEmpty else {
                #if DEBUG
                NSLog("ALMA-DICTATE stt-session mint returned no key: %@", String(data: data, encoding: .utf8) ?? "?")
                #endif
                throw AlmaVoiceSTTError.noToken
            }
            guard let url = URL(string: "wss://api.openai.com/v1/realtime") else { throw AlmaVoiceSTTError.badURL }
            let sess = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
            let task = sess.webSocketTask(with: url, protocols: ["realtime", "openai-insecure-api-key.\(key)"])

            // Token mint can return after lifecycle cancellation. Serialize the
            // final socket publication with `cancel()` so it either rejects the
            // stale local task or publishes it before cancel tears it down.
            lifecycleLock.lock()
            guard !cancellationRequested, !Task.isCancelled else {
                lifecycleLock.unlock()
                sess.invalidateAndCancel()
                return
            }
            session = sess
            ws = task
            lifecycleLock.unlock()
            try await awaitSocketOpen(task)
            if failed { closeSocket(); return }
            // NOTE: no session.update is sent — the GA realtime API rejects the
            // old transcription_session.update type (owner hit this live: the
            // server error killed every listen). turn_detection:null is already
            // baked into the session by /api/assistant/stt-session, and the
            // "only OUR VAD commit fires a turn" guard covers the rest.
            receiveLoop()
            let drained = markSocketOpenAndDrain()
            if drained.abort { closeSocket(); return }   // no-speech already ended it
            for c in drained.chunks { sendChunk(c) }
            if drained.commitNow { ws?.send(.string(#"{"type":"input_audio_buffer.commit"}"#)) { _ in } }
        } catch {
            let doUpload = markConnectFailed()
            closeSocket()
            if doUpload { uploadBufferedWav() }
            // else: mic keeps listening locally; endUtterance will upload the WAV.
        }
    }

    /// Lock-guarded transitions for connect() (NSLock is not async-safe inline).
    private func markSocketOpenAndDrain() -> (chunks: [Data], commitNow: Bool, abort: Bool) {
        lock.lock(); defer { lock.unlock() }
        if committed && !wantCommit { return ([], false, true) }
        let c = pending
        pending = []
        socketOpen = true
        return (c, wantCommit, false)
    }
    private func markConnectFailed() -> Bool {
        lock.lock(); defer { lock.unlock() }
        connectFailed = true
        return wantCommit && !completedFired && !failed
    }

    private func awaitSocketOpen(_ task: URLSessionWebSocketTask) async throws {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            lifecycleLock.lock()
            guard !cancellationRequested, ws === task, openCont == nil else {
                lifecycleLock.unlock()
                continuation.resume(throwing: AlmaVoiceSTTError.socket)
                return
            }
            openCont = continuation
            openSocketIdentity = ObjectIdentifier(task)
            // Install the waiter before resume. Delegate callbacks may arrive
            // immediately, but they must acquire this lock and can consume the
            // continuation only after publication is complete.
            task.resume()
            lifecycleLock.unlock()

            DispatchQueue.global(qos: .userInitiated).asyncAfter(
                deadline: .now() + 8
            ) { [weak self, weak task] in
                guard let self, let task else { return }
                _ = self.completeOpenHandshake(
                    for: task,
                    result: .failure(AlmaVoiceSTTError.socket))
            }
        }
    }

    @discardableResult
    private func completeOpenHandshake(
        for task: URLSessionTask,
        result: Result<Void, Error>
    ) -> Bool {
        lifecycleLock.lock()
        guard openSocketIdentity == ObjectIdentifier(task),
              let continuation = openCont
        else {
            lifecycleLock.unlock()
            return false
        }
        openCont = nil
        openSocketIdentity = nil
        lifecycleLock.unlock()
        continuation.resume(with: result)
        return true
    }

    // Delegate: handshake completed → resolve the open continuation.
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol proto: String?) {
        _ = completeOpenHandshake(for: webSocketTask, result: .success(()))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if completeOpenHandshake(
            for: task,
            result: .failure(AlmaVoiceSTTError.socket)
        ) { return }
        lifecycleLock.lock()
        let isCurrent = ws === task && !cancellationRequested
        lifecycleLock.unlock()
        if isCurrent, !completedFired { degradeToLocal() }
    }

    private func startMic() throws {
        let input = audioEngine.inputNode
        let inFmt = input.inputFormat(forBus: 0)
        guard inFmt.sampleRate > 0, inFmt.channelCount > 0 else { throw AlmaVoiceSTTError.noMic }
        guard let out = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000,
                                      channels: 1, interleaved: true),
              let conv = AVAudioConverter(from: inFmt, to: out) else { throw AlmaVoiceSTTError.noConverter }
        outFormat = out; converter = conv
        input.installTap(onBus: 0, bufferSize: 2_048, format: inFmt) { [weak self] buf, _ in
            self?.onAudio(buf, inFmt: inFmt)
        }
        tapInstalled = true
        audioEngine.prepare()
        try audioEngine.start()
    }

    /// Audio tap: RMS → orb + our adaptive VAD; PCM16@24k → socket (or buffer).
    private func onAudio(_ buf: AVAudioPCMBuffer, inFmt: AVAudioFormat) {
        if committed || failed { return }
        let frames = Int(buf.frameLength)
        guard frames > 0 else { return }

        // RMS from the float input (before conversion).
        var rms = 0.0
        if let ch = buf.floatChannelData?[0] {
            var sum = 0.0
            for i in 0..<frames { let v = Double(ch[i]); sum += v * v }
            rms = (sum / Double(frames)).squareRoot()
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.engine?.streamLevel(min(1, rms * 6), from: self)
            self.onLevelSink?(min(1, rms * 6))
        }

        // Dictation live-latency: commit at WORD GAPS, never mid-word (blind 3s
        // commits garbled the text + tiny chunks hallucinated the prompt). A
        // chunk goes out when ≥1.4s of voiced audio has accumulated AND the
        // level dips for ≥140ms (breath/word gap); 5s hard cap as safety.
        if dictationMode {
            let dt = Double(frames) / inFmt.sampleRate * 1000.0
            if rms > speechThresh { dictVoicedMs += dt; dictDipMs = 0 }
            else if rms < silenceThresh { dictDipMs += dt }
            let since = Date().timeIntervalSince(lastCommitAt)
            let wordGapReady = dictVoicedMs >= 1_400 && dictDipMs >= 140 && since > 1.2
            let hardCap = dictVoicedMs >= 800 && since > 5.0
            if wordGapReady || hardCap {
                lastCommitAt = Date()
                dictVoicedMs = 0; dictDipMs = 0
                ws?.send(.string(#"{"type":"input_audio_buffer.commit"}"#)) { _ in }
            }
        }

        // Adaptive VAD — mirrors the recorder path exactly.
        let dtMs = Double(frames) / inFmt.sampleRate * 1000.0
        if elapsedMs < 400 {
            noiseFloor += rms; floorSamples += 1
            if elapsedMs + dtMs >= 400 && floorSamples > 0 {
                // Clamp both ends (see recorder runVAD): a floor poisoned by the owner
                // already speaking must not push the threshold above his own voice.
                speechThresh = min(0.06, max(0.022, (noiseFloor / floorSamples) * 2.0))
            }
        } else if !spoke {
            if rms > speechThresh {
                sustainedMs += dtMs
                if sustainedMs >= 250 { spoke = true; speechStartMs = elapsedMs }
            } else { sustainedMs = 0 }
            if elapsedMs > 8_000 { endUtterance(noSpeech: true); return }
        } else {
            if rms < silenceThresh {
                silenceMs += dtMs
                let span = elapsedMs - speechStartMs
                let window = span < 3_000 ? 1_400.0 : 2_600.0
                if silenceMs >= window { endUtterance(noSpeech: false); return }
            } else if rms > speechThresh {
                silenceMs = 0
            }
        }
        if elapsedMs > 180_000 { endUtterance(noSpeech: false); return }

        let sec = Int(elapsedMs / 1000)
        if sec != lastSecond {
            lastSecond = sec
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.engine?.streamSeconds(sec, from: self)
            }
        }
        elapsedMs += dtMs

        // Convert to 24k mono int16; stream if the socket is live, buffer if not.
        guard let conv = converter, let out = outFormat else { return }
        let ratio = out.sampleRate / inFmt.sampleRate
        let cap = AVAudioFrameCount(Double(frames) * ratio + 16)
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: out, frameCapacity: cap) else { return }
        var fed = false
        var cErr: NSError?
        conv.convert(to: outBuf, error: &cErr) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return buf
        }
        let n = Int(outBuf.frameLength)
        guard cErr == nil, n > 0, let i16 = outBuf.int16ChannelData?[0] else { return }
        let bytes = Data(bytes: i16, count: n * MemoryLayout<Int16>.size)
        lock.lock()
        if fullAudio.count < 9_200_000 { fullAudio.append(bytes) }   // ~190s cap
        let open = socketOpen
        if !open { pending.append(bytes) }
        lock.unlock()
        if open { sendChunk(bytes) }
    }

    private func sendChunk(_ bytes: Data) {
        spokeSinceCommit = true
        let b64 = bytes.base64EncodedString()
        ws?.send(.string("{\"type\":\"input_audio_buffer.append\",\"audio\":\"\(b64)\"}")) { _ in }
    }

    /// End of speech: stop the mic (privacy), commit (or fall back), await text.
    /// Quiet/garbled chunks make the STT echo its own prompt back as "speech".
    /// These substrings only occur in that echo (comma-joined vocab runs from
    /// stt-session's dictation prompt), never in the owner's real sentences —
    /// sim-caught live 2026-07-24: the vocab list landed in the composer.
    private static let promptEchoMarkers = [
        "বাংলায় কথা বলা হচ্ছে", "Bangladeshi Bangla",
        "ALMA Lifestyle, ALMA Trading", "almatraders.com, অর্ডার",
        "ইনভেন্টরি, খরচ, বেতন", "কাস্টমার, স্টাফ, নামাজ",
    ]
    static func isPromptEcho(_ s: String) -> Bool {
        Self.promptEchoMarkers.contains { s.contains($0) }
    }

    private func dictJoinedText() -> String {
        dictItems.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            // Keep prompt echoes out of the LIVE view too, not just the
            // completed-event path.
            .filter { !Self.isPromptEcho($0) }
            .joined(separator: " ")
    }

    private func finishDictation(with text: String) {
        if completedFired { return }
        completedFired = true
        stopMic(); closeSocket()
        #if DEBUG
        NSLog("ALMA-DICTATE finish textLen=%d items=%d done=%d", text.count,
              dictItems.count, dictItems.filter(\.done).count)
        #endif
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if text.isEmpty {
                self.engine?.streamNoSpeech(from: self)
                self.onNoSpeechSink?()
            } else {
                self.engine?.streamFinal(text, from: self)
                self.onFinalSink?(text)
            }
        }
    }

    private func endUtterance(noSpeech: Bool) {
        // Dictation: only the ✓/✕ buttons end the take — the local VAD's silence
        // endpointing must never cut the owner off mid-thought.
        if dictationMode && !finishRequested { return }
        if committed { return }
        committed = true
        stopMic()
        if noSpeech {
            connectTask?.cancel()
            closeSocket()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.engine?.streamNoSpeech(from: self)
                self.onNoSpeechSink?()
            }
            return
        }
        lock.lock()
        wantCommit = true
        let open = socketOpen
        let dead = connectFailed
        lock.unlock()
        if open {
            ws?.send(.string(#"{"type":"input_audio_buffer.commit"}"#)) { _ in }
        } else if dead {
            uploadBufferedWav()
            return
        }
        // else: connect() commits (or uploads) when it resolves.
        // Salvage watchdog: whatever happens to the socket, the owner's words
        // reach /transcribe within 10s.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self, !self.completedFired, !self.failed else { return }
            self.failed = true
            self.closeSocket()
            self.uploadBufferedWav()
        }
    }

    /// Any socket trouble mid-listen: degrade SILENTLY to local capture — the
    /// mic keeps running, and the utterance completes via the WAV upload path.
    /// The owner never sees a raw API error for a transport hiccup.
    private func degradeToLocal() {
        #if DEBUG
        NSLog("ALMA-DICTATE realtime socket degraded to local upload")
        #endif
        lock.lock()
        let mustUpload = committed && wantCommit && !completedFired && !failed
        socketOpen = false
        connectFailed = true
        lock.unlock()
        closeSocket()
        if mustUpload { uploadBufferedWav() }
    }

    /// Socket path failed after speech — upload the buffered utterance as WAV.
    private func uploadBufferedWav() {
        // Once only: the salvage watchdog + degradeToLocal can both reach here
        // for one utterance — a second upload doubled the text in the composer.
        lock.lock()
        if fallbackUploaded { lock.unlock(); return }
        fallbackUploaded = true
        let pcm = fullAudio
        lock.unlock()
        guard pcm.count > 6_000 else {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.engine?.streamNoSpeech(from: self)
                self.onNoSpeechSink?()
            }
            return
        }
        let wav = Self.wavData(pcm: pcm)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            #if DEBUG
            NSLog("ALMA-DICTATE WAV fallback %d bytes (engine=%@ sink=%@)", wav.count,
                  self.engine == nil ? "nil" : "set", self.onFallbackUploadSink == nil ? "nil" : "set")
            #endif
            if let engine = self.engine { engine.streamFallbackUpload(wav, from: self) }
            else if let sink = self.onFallbackUploadSink { sink(wav) }
            else { self.onNoSpeechSink?() }
        }
    }

    /// Whole-utterance WAV for the dictation ACCURACY pass: the live view is
    /// built from 1.4–5s chunks transcribed independently (no cross-chunk
    /// context — Bangla accuracy suffers); the composer re-transcribes THIS
    /// full buffer in one call instead. nil when nothing was really spoken.
    func fullUtteranceWav() -> Data? {
        guard spoke else { return nil }
        lock.lock(); let pcm = fullAudio; lock.unlock()
        guard pcm.count > 48_000 else { return nil }   // <1s — nothing to gain
        return Self.wavData(pcm: pcm)
    }

    /// Minimal WAV container: PCM16 mono 24k.
    static func wavData(pcm: Data, rate: Int = 24_000) -> Data {
        var d = Data()
        func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(Data("RIFF".utf8)); le32(UInt32(36 + pcm.count)); d.append(Data("WAVE".utf8))
        d.append(Data("fmt ".utf8)); le32(16); le16(1); le16(1)
        le32(UInt32(rate)); le32(UInt32(rate * 2)); le16(2); le16(16)
        d.append(Data("data".utf8)); le32(UInt32(pcm.count)); d.append(pcm)
        return d
    }

    private func receiveLoop() {
        ws?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                if !self.completedFired { self.degradeToLocal() }
            case .success(let msg):
                if case .string(let s) = msg { self.onWSText(s) }
                if !self.completedFired && !self.failed { self.receiveLoop() }
            }
        }
    }

    private func onWSText(_ s: String) {
        guard let d = s.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let type = obj["type"] as? String else { return }
        switch type {
        case "conversation.item.input_audio_transcription.delta":
            if let delta = obj["delta"] as? String {
                if dictationMode {
                    let itemId = (obj["item_id"] as? String) ?? "item-\(dictItems.count)"
                    if let i = dictItems.firstIndex(where: { $0.id == itemId }) {
                        // A straggler delta after the item's final transcript
                        // would duplicate words the completed event already set.
                        if dictItems[i].done { return }
                        dictItems[i].text += delta
                    } else {
                        dictItems.append((id: itemId, text: delta, done: false))
                    }
                    let snap = dictJoinedText()
                    DispatchQueue.main.async { [weak self] in
                        guard let self else { return }
                        self.engine?.streamPartial(snap, from: self)
                        self.onPartialSink?(snap)
                    }
                } else {
                    partial += delta
                    let snap = partial
                    DispatchQueue.main.async { [weak self] in
                        guard let self else { return }
                        self.engine?.streamPartial(snap, from: self)
                        self.onPartialSink?(snap)
                    }
                }
            }
        case "conversation.item.input_audio_transcription.completed" where dictationMode:
            var piece = ((obj["transcript"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if Self.isPromptEcho(piece) { piece = "" }
            let itemId = (obj["item_id"] as? String) ?? ""
            #if DEBUG
            NSLog("ALMA-DICTATE completed item=%@ pieceLen=%d", itemId, piece.count)
            #endif
            if let i = dictItems.firstIndex(where: { $0.id == itemId }) {
                // An empty/filtered final transcript must never erase the words
                // already accumulated from deltas — the owner watched them land.
                if !piece.isEmpty { dictItems[i].text = piece }
                dictItems[i].done = true
            } else if !piece.isEmpty {
                dictItems.append((id: itemId, text: piece, done: true))
            }
            let snap = dictJoinedText()
            if finishRequested && dictItems.allSatisfy({ $0.done }) {
                finishDictation(with: snap)
            } else {
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    self.engine?.streamPartial(snap, from: self)
                    self.onPartialSink?(snap)
                }
            }
        case "conversation.item.input_audio_transcription.completed":
            // Guard for "nije nije kaj kore": a completed transcript only ends
            // the turn when OUR VAD committed it. A server-initiated commit
            // (should never happen with turn_detection null) just updates the
            // partial instead of firing a turn.
            lock.lock(); let ours = committed && wantCommit; lock.unlock()
            guard ours else {
                if let t = obj["transcript"] as? String { partial = t }
                return
            }
            completedFired = true
            let text = (obj["transcript"] as? String) ?? partial
            closeSocket()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.engine?.streamFinal(text, from: self)
                self.onFinalSink?(text)
            }
        case "input_audio_buffer.committed":
            spokeSinceCommit = false
            lastCommitAt = Date()
        case "error":
            if dictationMode && !finishRequested {
                // Forced-commit racing server_vad can hit an empty buffer — harmless,
                // never degrade a working live take over it.
                #if DEBUG
                NSLog("ALMA-DICTATE mid-take server notice (ignored)")
                #endif
                return
            }
            if dictationMode && finishRequested {
                // Trailing flush hit an empty buffer — everything is already in
                // the ledger; deliver it.
                finishDictation(with: dictJoinedText())
                return
            }
            degradeToLocal()
        default:
            break
        }
    }

    private func fail(_ msg: String) {
        if failed || completedFired { return }
        failed = true
        stopMic(); closeSocket()
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.engine?.streamError(msg, from: self)
            self.onErrorSink?(msg)
        }
    }

    /// Force-send now (owner tapped the orb while listening). If the VAD never
    /// armed — nothing was said — the tap CANCELS instead of committing ambient
    /// noise into a bogus turn.
    func finishNow() {
        if dictationMode {
            finishRequested = true
            lock.lock(); let open = socketOpen; lock.unlock()
            if !open {
                endUtterance(noSpeech: !spoke)   // WAV fallback path resolves it
                return
            }
            if spokeSinceCommit {
                ws?.send(.string(#"{"type":"input_audio_buffer.commit"}"#)) { _ in }
            }
            if dictItems.allSatisfy({ $0.done }) && !spokeSinceCommit {
                finishDictation(with: dictJoinedText())
            } else {
                // Never hang on a lost completion: 2.5s after ✓, deliver whatever
                // has arrived (items are individually complete sentences).
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
                    guard let self, !self.completedFired else { return }
                    self.finishDictation(with: self.dictJoinedText())
                }
            }
            return
        }
        endUtterance(noSpeech: !spoke)
    }

    /// Audio appended since the last server-side commit (dictation trailing flush).
    private var spokeSinceCommit = false
    /// Continuous-speech cap (owner: words must appear in 2-3s, not at the first
    /// long pause): force a commit every ~2.8s of uninterrupted speech so OpenAI
    /// transcribes the chunk NOW; server_vad still commits sooner at real pauses.
    private var lastCommitAt = Date()
    private var dictVoicedMs = 0.0
    private var dictDipMs = 0.0

    /// Hard stop with no callbacks (console closed / barge / teardown).
    func cancel() {
        lifecycleLock.lock()
        cancellationRequested = true
        let pendingConnectTask = connectTask
        connectTask = nil
        let pendingOpen = openCont
        openCont = nil
        openSocketIdentity = nil
        lifecycleLock.unlock()
        failed = true
        pendingConnectTask?.cancel()
        pendingOpen?.resume(throwing: AlmaVoiceSTTError.socket)
        stopMic(); closeSocket()
    }

    private func stopMic() {
        if tapInstalled { audioEngine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        if audioEngine.isRunning { audioEngine.stop() }
    }
    private func closeSocket() {
        ws?.cancel(with: .goingAway, reason: nil); ws = nil
        session?.invalidateAndCancel(); session = nil
    }
}

// MARK: - "ALMA" wake word (owner feature, 2026-07-06)
//
// While the console is OPEN and IDLE, an SFSpeechRecognizer listens for the
// wake word — saying «ALMA» starts a listen exactly like tapping the orb.
// It runs ONLY in idle (never while listening / thinking / speaking, so it
// can't fight the STT mic or hear ALMA's own TTS), recycles its recognition
// task every 50s (Apple's ~1min cap), and prefers on-device recognition.
// Escape hatch: UserDefaults "alma-wake-word" = false.

@available(iOS 17.0, *)
@MainActor
final class AlmaWakeWord {
    weak var engine: AlmaVoiceEngine?

    private let audioEngine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var tapOn = false
    private var recycleTask: Task<Void, Never>?
    private(set) var active = false
    private var desired = false
    private var authorizationGeneration: UInt64 = 0
    private var expectedLifecycleEpoch: Int?

    // DEFAULT ON (owner request, 2026-07-06): saying «ALMA» while the console is idle
    // starts a listen. It runs ONLY in idle — `startListening()` calls `wake.stop()`
    // before touching the STT mic, so the two mic taps never overlap (the earlier
    // crash surface). Escape hatch: set `alma-wake-word` = false.
    private var enabled: Bool {
        (UserDefaults.standard.object(forKey: "alma-wake-word") as? Bool) ?? true
    }

    /// The transcript tail counts as a wake hit on any close rendering of
    /// "ALMA" (en_US recognizer; the owner may say it inside a Bangla stream).
    static func hit(_ transcript: String) -> Bool {
        let tail = String(transcript.lowercased().suffix(28))
        return ["alma", "almah", "aalma", "aluma", "alema", "আলমা"].contains { tail.contains($0) }
    }

    func start() {
        guard enabled, !active, !desired,
              let engine,
              let lifecycleEpoch = engine.wakeWordEligibilityToken()
        else { return }
        desired = true
        authorizationGeneration &+= 1
        let generation = authorizationGeneration
        expectedLifecycleEpoch = lifecycleEpoch
        SFSpeechRecognizer.requestAuthorization { [weak self, weak engine] auth in
            DispatchQueue.main.async {
                guard let self, let engine,
                      self.engine === engine,
                      self.desired,
                      self.authorizationGeneration == generation,
                      self.expectedLifecycleEpoch == lifecycleEpoch,
                      engine.isWakeWordEligible(lifecycleEpoch: lifecycleEpoch)
                else { return }
                guard auth == .authorized else {
                    self.stop()
                    return
                }
                self.begin(generation: generation, lifecycleEpoch: lifecycleEpoch)
            }
        }
    }

    private func begin(generation: UInt64, lifecycleEpoch: Int) {
        guard enabled, desired, !active,
              authorizationGeneration == generation,
              expectedLifecycleEpoch == lifecycleEpoch,
              let e = engine,
              e.isWakeWordEligible(lifecycleEpoch: lifecycleEpoch)
        else {
            stop()
            return
        }
        let rec = SFSpeechRecognizer(locale: Locale(identifier: "en_US"))
        guard let rec, rec.isAvailable else { stop(); return }
        recognizer = rec
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        let input = audioEngine.inputNode
        let fmt = input.inputFormat(forBus: 0)
        guard fmt.sampleRate > 0, fmt.channelCount > 0 else { stop(); return }
        input.installTap(onBus: 0, bufferSize: 2_048, format: fmt) { [weak self] buf, _ in
            self?.request?.append(buf)
        }
        tapOn = true
        audioEngine.prepare()
        do { try audioEngine.start() } catch { stop(); return }
        active = true
        task = rec.recognitionTask(with: req) { [weak self] result, err in
            if let r = result, Self.hit(r.bestTranscription.formattedString) {
                DispatchQueue.main.async {
                    self?.wakeHit(generation: generation, lifecycleEpoch: lifecycleEpoch)
                }
            } else if err != nil {
                DispatchQueue.main.async {
                    self?.recycle(generation: generation, lifecycleEpoch: lifecycleEpoch)
                }
            }
        }
        recycleTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 50_000_000_000)
            guard !Task.isCancelled else { return }
            self?.recycle(generation: generation, lifecycleEpoch: lifecycleEpoch)
        }
    }

    private func wakeHit(generation: UInt64, lifecycleEpoch: Int) {
        guard desired, active,
              authorizationGeneration == generation,
              expectedLifecycleEpoch == lifecycleEpoch,
              let e = engine,
              e.isWakeWordEligible(lifecycleEpoch: lifecycleEpoch)
        else { return }
        stop()
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        e.startListening()
    }

    /// Apple caps continuous recognition (~1min) — tear down and re-arm.
    private func recycle(generation: UInt64, lifecycleEpoch: Int) {
        guard active, desired,
              authorizationGeneration == generation,
              expectedLifecycleEpoch == lifecycleEpoch,
              let e = engine,
              e.isWakeWordEligible(lifecycleEpoch: lifecycleEpoch)
        else {
            stop()
            return
        }
        teardown()
        begin(generation: generation, lifecycleEpoch: lifecycleEpoch)
    }

    func stop() {
        desired = false
        authorizationGeneration &+= 1
        expectedLifecycleEpoch = nil
        teardown()
    }

    private func teardown() {
        recycleTask?.cancel(); recycleTask = nil
        task?.cancel(); task = nil
        request?.endAudio(); request = nil
        if tapOn { audioEngine.inputNode.removeTap(onBus: 0); tapOn = false }
        if audioEngine.isRunning { audioEngine.stop() }
        active = false
    }

    /// SIM self-test hook (no mic on the build Mac): recognize a spoken-word
    /// audio FILE through the same hit() gate and surface the verdict visibly.
    /// Never fires in production — only the local simctl launch passes the arg.
    func debugRecognizeFile(_ url: URL) {
        SFSpeechRecognizer.requestAuthorization { [weak self] auth in
            DispatchQueue.main.async {
                guard let self else { return }
                guard auth == .authorized else {
                    self.engine?.errorToast = "WAKE TEST: speech auth denied (\(auth.rawValue))"
                    return
                }
                guard let rec = SFSpeechRecognizer(locale: Locale(identifier: "en_US")), rec.isAvailable else {
                    self.engine?.errorToast = "WAKE TEST: recognizer unavailable"
                    return
                }
                let req = SFSpeechURLRecognitionRequest(url: url)
                rec.recognitionTask(with: req) { result, err in
                    DispatchQueue.main.async {
                        if let r = result, r.isFinal {
                            let t = r.bestTranscription.formattedString
                            let ok = AlmaWakeWord.hit(t)
                            self.engine?.errorToast = ok ? "WAKE ✓ শুনেছি: «\(t)»" : "WAKE ✗ শুনেছি: «\(t)»"
                            if ok { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
                        } else if let err {
                            self.engine?.errorToast = "WAKE TEST: \(err.localizedDescription)"
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Sentence-chunked TTS queue (web tts-chunk-player parity)

/// Cuts streamed text on Bangla sentence boundaries ([।?!\n], min 24 chars),
/// synthesizes each via /api/assistant/tts, plays sequentially on AVAudioPlayer
/// (metering drives the orb) and prefetches the next chunk while one plays.
@available(iOS 17.0, *)
@MainActor
final class AlmaTtsQueue: NSObject, AVAudioPlayerDelegate {
    weak var engine: AlmaVoiceEngine?

    private var buffer = ""
    private var queue: [String] = []
    private var prefetched: [String: Data] = [:]
    private var player: AVAudioPlayer?
    private var currentText = ""
    private var fedAnything = false
    private var startedFirst = false
    private var feedFinished = false
    private var meterTask: Task<Void, Never>?
    private var pumpTask: Task<Void, Never>?
    private var workEpoch: UInt64 = 0
    private var pumping = false
    private var wasSilent = true             // fire ttsDidGoSilent once per silence edge

    /// Recovery probe: is a chunk actually sounding right now? (Stuck-flag repair.)
    var isAudiblyPlaying: Bool { player?.isPlaying ?? false }

    /// Reset the per-turn flags (greeting/acks must not count as the reply's
    /// first chunk — that kept the state stuck on "ভাবছি" during playback).
    func beginTurn() {
        startedFirst = false
        fedAnything = false
        feedFinished = false
        buffer = ""
    }

    /// Sim self-test: run `reply` through cutSentences in small deltas (like SSE) and
    /// NSLog every chunk so a mid-sentence split would be visible. Does not hit TTS.
    func debugChunkLog(_ reply: String) {
        buffer = ""; queue.removeAll()
        var i = reply.startIndex
        while i < reply.endIndex {
            let j = reply.index(i, offsetBy: 7, limitedBy: reply.endIndex) ?? reply.endIndex
            buffer += String(reply[i..<j]); cutSentences(flush: false); i = j
        }
        cutSentences(flush: true)
        NSLog("ALMA-TTS-TEST chunks=%d", queue.count)
        for (n, c) in queue.enumerated() { NSLog("ALMA-TTS-TEST [%d] «%@»", n, c) }
        queue.removeAll()
    }

    func feed(_ delta: String) {
        fedAnything = true
        feedFinished = false
        buffer += delta
        cutSentences(flush: false)
        pump()
    }

    /// Speak a line immediately after whatever is playing (narrations, acks).
    func sayNow(_ text: String) {
        fedAnything = true
        queue.append(text)
        pump()
    }

    func finishFeed() {
        feedFinished = true
        cutSentences(flush: true)
        pump()
        if !fedAnything && player == nil { engine?.ttsAllDone() }
    }

    func stopAll() {
        workEpoch &+= 1
        pumpTask?.cancel()
        pumpTask = nil
        pumping = false
        buffer = ""; queue.removeAll(); prefetched.removeAll()
        meterTask?.cancel()
        player?.stop(); player = nil
        startedFirst = false
        fedAnything = false
        feedFinished = false
        // We are now silent (deliberate stop / tap-to-interrupt). Clear the engine's
        // mic gate so a follow-on startListening() is allowed. Does NOT auto-listen.
        if !wasSilent {
            wasSilent = true
            engine?.ttsDidGoSilent()
        }
    }

    func playRaw(_ data: Data) {
        guard player == nil else { return }   // never talk over a reply chunk
        if let p = try? AVAudioPlayer(data: data) {
            player = p
            p.delegate = self
            p.isMeteringEnabled = true
            p.play()
            runMeter()
        }
    }

    /// Cut `buffer` into WHOLE-sentence chunks for TTS. A chunk may end ONLY at a real
    /// sentence terminator — «।», «?», «!», or an English «.» that isn't a decimal —
    /// NEVER at a bare newline. The model emits `\n` for formatting (and mid-stream
    /// soft-wraps), and the old code cut on it: a sentence got sliced in half and its
    /// tail bled into the next TTS clip — the owner heard "আমি এখন স্কু" … pause …
    /// "লে যাব সেখানে…". Newlines inside a chunk are collapsed to a single space so the
    /// whole sentence is synthesised in one smooth breath. Tiny sentences merge forward
    /// to ~24 chars so we don't fire a TTS call per clause. `end` is monotonic → always
    /// terminates (no re-scan of the same boundary → no main-thread spin).
    private func cutSentences(flush: Bool) {
        func isTerminator(_ i: String.Index) -> Bool {
            let ch = buffer[i]
            if ch == "।" || ch == "?" || ch == "!" { return true }
            if ch == "." {
                // English full stop, but not a decimal ("5.5") or an initial ("A."):
                // only a real end when the next char is whitespace / end-of-buffer.
                if i > buffer.startIndex, buffer[buffer.index(before: i)].isNumber { return false }
                let next = buffer.index(after: i)
                if next == buffer.endIndex { return true }
                return buffer[next] == " " || buffer[next] == "\n"
            }
            return false
        }
        func firstTerminator(from start: String.Index) -> String.Index? {
            var i = start
            while i < buffer.endIndex {
                if isTerminator(i) { return buffer.index(after: i) }
                i = buffer.index(after: i)
            }
            return nil
        }
        while true {
            guard var end = firstTerminator(from: buffer.startIndex) else { break }
            // Too short? Extend to the NEXT terminator so tiny sentences merge into one
            // TTS chunk. `end` only moves forward → guaranteed to terminate.
            while !flush,
                  buffer.distance(from: buffer.startIndex, to: end) < 24,
                  let next = firstTerminator(from: end) {
                end = next
            }
            if !flush, buffer.distance(from: buffer.startIndex, to: end) < 24 {
                break   // still short and no further terminator — wait for more text
            }
            let chunk = String(buffer[..<end])
                .replacingOccurrences(of: "\n", with: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            buffer = String(buffer[end...])
            if !chunk.isEmpty { queue.append(chunk) }
        }
        if flush {
            let tail = buffer
                .replacingOccurrences(of: "\n", with: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !tail.isEmpty { queue.append(tail) }
            buffer = ""
        }
    }

    private func pump() {
        guard player == nil, !pumping else { prefetchNext(); return }
        guard !queue.isEmpty else {
            // Nothing left to play → the queue is now SILENT. Tell the engine once per
            // silence edge so it can clear the mic gate (and, if a reply turn finished,
            // re-open the mic). This is what lets auto-listen wait for true silence.
            if !wasSilent {
                wasSilent = true
                engine?.ttsDidGoSilent()
            }
            if feedFinished && player == nil && fedAnything { engine?.ttsAllDone() }
            return
        }
        wasSilent = false
        pumping = true
        let text = queue.removeFirst()
        let epoch = workEpoch
        pumpTask = Task { [weak self] in
            guard let self else { return }
            var shouldContinue = false
            defer {
                if self.workEpoch == epoch {
                    self.pumping = false
                    self.pumpTask = nil
                    if shouldContinue { self.pump() }
                }
            }
            let data: Data
            if let d = self.prefetched.removeValue(forKey: text) {
                data = d
            } else if let d = try? await AssistantNet.postJSONForData(
                path: "/api/assistant/tts",
                body: ["text": almaNormalizeForTTS(String(text.prefix(600)))]) {
                data = d
            } else {
                shouldContinue = true
                return   // skip a failed chunk, keep going
            }
            guard !Task.isCancelled, self.workEpoch == epoch else { return }
            guard let p = try? AVAudioPlayer(data: data) else {
                shouldContinue = true
                return
            }
            self.player = p
            p.delegate = self
            p.isMeteringEnabled = true
            self.currentText = text
            if !self.startedFirst {
                self.startedFirst = true
                self.engine?.ttsDidStartFirstChunk()
            }
            self.engine?.ttsDidStartChunk(text)
            p.play()
            self.runMeter()
            self.prefetchNext()
        }
    }

    private func prefetchNext() {
        guard let next = queue.first, prefetched[next] == nil else { return }
        let epoch = workEpoch
        Task { [weak self] in
            if let d = try? await AssistantNet.postJSONForData(
                path: "/api/assistant/tts",
                body: ["text": almaNormalizeForTTS(String(next.prefix(600)))]) {
                guard !Task.isCancelled, let self, self.workEpoch == epoch else { return }
                self.prefetched[next] = d
            }
        }
    }

    private func runMeter() {
        meterTask?.cancel()
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 50_000_000)
                guard let self, let p = self.player, p.isPlaying else { continue }
                p.updateMeters()
                let rms = pow(10.0, Double(p.averagePower(forChannel: 0)) / 20.0)
                self.engine?.ttsLevelChanged(min(1, rms * 4))
            }
        }
    }

    nonisolated func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.meterTask?.cancel()
            self.player = nil
            self.engine?.ttsLevelChanged(0)
            self.pump()
        }
    }
}


// MARK: - The console view — the owner-confirmed v2 design (DESIGN-REFERENCE.html), 1:1
//
// Pixel target: docs/voice-console-native/DESIGN-REFERENCE.html + the v2 preview
// the owner confirmed 2026-07-06. Every component of that page exists here:
// near-black #04070D canvas, state-hued aurora, twinkling STARFIELD with comets,
// dot grid, top bar (ALMA. · এজেন্ট কনসোল · ঢাকা clock · verified transport), glass state
// badge, the WebGL FLUID ORB ported 1:1 to Metal (runtime-compiled — no pbxproj
// entry needed), 72-bar reactive waveform ring OUTSIDE the orb with a clear gap,
// spinning conic accent ring, 5 orbiting energy motes, thinking satellites,
// floor reflection, glowing caption (Sir in gold), checkmark steps, suggestion
// chips, live action-card feed (header + count + border-sweep pop), কথোপকথন
// dock. Tokens: ink #EAF2FB, muted #7C92A9, faint #55708C, gold #E2B366,
// line rgba(160,200,240,.13), good #3BE08F; hues idle 168 / listening 145 /
// thinking·transcribing 265 / speaking 210 / error 8. No mock/demo data — the
// feed and cards populate only from real SSE events (owner rule: production
// builds carry no placeholder content).

/// HSL → Color (the web uses HSL; SwiftUI's Color(hue:) is HSB). Faithful port.
@available(iOS 17.0, *)
func almaHSL(_ h: Double, _ s: Double, _ l: Double, _ a: Double = 1) -> Color {
    let c = (1 - abs(2 * l - 1)) * s
    let hp = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 60
    let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
    var r = 0.0, g = 0.0, b = 0.0
    switch hp {
    case 0..<1: (r, g, b) = (c, x, 0)
    case 1..<2: (r, g, b) = (x, c, 0)
    case 2..<3: (r, g, b) = (0, c, x)
    case 3..<4: (r, g, b) = (0, x, c)
    case 4..<5: (r, g, b) = (x, 0, c)
    default:    (r, g, b) = (c, 0, x)
    }
    let m = l - c / 2
    return Color(red: r + m, green: g + m, blue: b + m, opacity: a)
}

// MARK: - Edge glow (LOCKED owner demo 2026-07-08) — screen rim breathes with speech

@available(iOS 17.0, *)
struct AlmaVoiceEdgeGlow: View {
    var hue: Double
    var level: Double
    var active: Bool

    var body: some View {
        let tint = Color(hue: hue / 360.0, saturation: 0.9, brightness: 0.95)
        let strength = active ? 0.22 + level * 0.78 : 0
        ZStack {
            // tight bright rim
            Rectangle()
                .strokeBorder(tint.opacity(0.85), lineWidth: 3)
                .blur(radius: 7)
            // mid bloom
            Rectangle()
                .strokeBorder(tint.opacity(0.5), lineWidth: 14)
                .blur(radius: 24)
            // deep wash
            Rectangle()
                .strokeBorder(tint.opacity(0.3), lineWidth: 44)
                .blur(radius: 60)
        }
        .opacity(strength)
        .animation(.easeOut(duration: 0.12), value: level)
        .animation(.easeInOut(duration: 0.5), value: active)
    }
}

@available(iOS 17.0, *)
struct AlmaVoiceConsoleView: View {
    let vm: AssistantVM
    let engine: AlmaVoiceEngine
    @Environment(\.dismiss) private var dismiss
    @State private var liveBlink = false
    @State private var photoItem: PhotosPickerItem?
    @State private var minimizing = false
    @State private var endingCall = false
    @State private var showLiveSettings = false

    init(vm: AssistantVM) {
        self.vm = vm
        self.engine = vm.voiceEngine
    }

    /// DEBUG launch values (sim self-test only — simctl passes them as launch
    /// arguments; production launches carry neither env nor these args).
    private static func launchValue(_ key: String) -> String? {
        if let v = ProcessInfo.processInfo.environment[key], !v.isEmpty { return v }
        let prefix = key + "="
        if let a = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix(prefix) }) {
            let v = String(a.dropFirst(prefix.count))
            return v.isEmpty ? nil : v
        }
        return nil
    }

    // Web palette tokens.
    private let ink   = Color(red: 0.918, green: 0.949, blue: 0.984)   // #EAF2FB
    private let muted = Color(red: 0.486, green: 0.573, blue: 0.663)   // #7C92A9
    private let faint = Color(red: 0.333, green: 0.439, blue: 0.549)   // #55708C
    private let gold  = Color(red: 0.886, green: 0.702, blue: 0.400)   // #E2B366
    private let line  = Color(red: 0.627, green: 0.784, blue: 0.941).opacity(0.13)
    private let good  = Color(red: 0.231, green: 0.878, blue: 0.561)   // #3BE08F
    private let bg0   = Color(red: 0.016, green: 0.027, blue: 0.051)   // #04070D
    private let glass = Color(red: 0.549, green: 0.745, blue: 0.941)   // rgba(140,190,240,…) base

    private var hue: Double { engine.state.hue }
    private var toolSteps: [AlmaVoiceEngine.Card] { engine.cards.filter { $0.kind == .tool } }
    private var feedCards: [AlmaVoiceEngine.Card] { engine.cards.filter { $0.kind != .tool } }

    private static let dhakaClock: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "bn_BD@numbers=beng")
        f.timeZone = TimeZone(identifier: "Asia/Dhaka")
        f.dateFormat = "h:mm a"
        return f
    }()

    var body: some View {
        ZStack {
            bg0.ignoresSafeArea()
                // Shell-level floating bar coordination: hide it while the full
                // console is on screen, restore it on minimize.
                .onAppear { AlmaCallBarBridge.shared.consoleVisible = true }
                .onDisappear { AlmaCallBarBridge.shared.consoleVisible = false }
            aurora.ignoresSafeArea()
            AlmaStarfieldView().ignoresSafeArea().allowsHitTesting(false)
            dotGrid.ignoresSafeArea().allowsHitTesting(false)

            VStack(spacing: 0) {
                topBar
                Spacer(minLength: 4)
                stateBadge
                    .padding(.bottom, 10)
                AlmaFluidOrbView(state: engine.state,
                                 micLevel: engine.micLevel,
                                 ttsLevel: engine.ttsLevel)
                    .frame(width: orbSide, height: orbSide)
                    .contentShape(Circle())
                    .onTapGesture { engine.tapOrb() }
                voiceZone
                    .padding(.top, 16)
                feedSection
                Spacer(minLength: 4)
                dock
            }

            // LOCKED (owner demo 2026-07-08): speech-synced edge glow — the whole
            // screen's rim breathes with the live mic/TTS level in the state hue.
            AlmaVoiceEdgeGlow(hue: hue,
                              level: max(engine.micLevel, engine.ttsLevel),
                              active: engine.state != .idle)
                .ignoresSafeArea()
                .allowsHitTesting(false)
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showLiveSettings) {
            AlmaLiveSettingsSheet(engine: engine)
        }
        .onAppear {
            engine.chatVM = vm
            engine.begin()
            #if DEBUG
            if let liveSay = Self.launchValue("ALMA_LIVE_SAY") {
                engine.debugInjectUserTurnsWhenReady(
                    liveSay.components(separatedBy: "|||"))
            }
            #endif
            if let say = Self.launchValue("ALMA_VOICE_SAY") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 4) { engine.debugInjectUtterance(say) }
            }
            if let reply = Self.launchValue("ALMA_TTS_TEST") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { engine.debugTtsChunks(reply) }
            }
            if Self.launchValue("ALMA_GATE_TEST") != nil {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { engine.debugGateTest() }
            }
            if let wav = Self.launchValue("ALMA_WAKE_TEST") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    engine.wake.debugRecognizeFile(URL(fileURLWithPath: wav))
                }
            }
            // SIM MIC self-test: auto-start a real listen ~3s after the console opens,
            // so the record→transcribe→reply flow can be exercised headlessly by playing
            // known speech into the Mac mic. Never fires in production (launch-arg only).
            if Self.launchValue("ALMA_VOICE_LISTEN") != nil {
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { engine.startListening() }
            }
        }
        .onDisappear {
            // The chat button deliberately keeps the persistent Live session alive.
            // Any other dismissal is treated as a real hang-up.
            if !minimizing && !endingCall { engine.end() }
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("almaVoiceDebugMin"))) { _ in
            #if DEBUG
            // Sim harness: minimize like the chevron does — call stays alive.
            minimizing = true
            dismiss()
            #endif
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self),
                   let img = UIImage(data: data) {
                    await MainActor.run { engine.attachImage(img); photoItem = nil }
                }
            }
        }
        .onChange(of: engine.callConnection) { oldState, newState in
            if oldState != .idle && newState == .idle && !minimizing {
                endingCall = true
                dismiss()
            }
        }
        .overlay(alignment: .top) {
            if let t = engine.errorToast {
                Text(t)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(muted)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.top, 54)
                    .onAppear {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) {
                            if engine.errorToast == t { engine.errorToast = nil }
                        }
                    }
            }
        }
    }

    private var orbSide: CGFloat { min(300, max(220, UIScreen.main.bounds.width * 0.72)) }

    // ── Background: state-hued aurora + dot grid (web .aurora / .dotgrid) ──
    private var aurora: some View {
        GeometryReader { geo in
            ZStack {
                RadialGradient(colors: [almaHSL(hue, 0.80, 0.55, 0.13), .clear],
                               center: .init(x: 0.5, y: 0.18),
                               startRadius: 0, endRadius: max(geo.size.width, geo.size.height) * 0.7)
                RadialGradient(colors: [almaHSL(hue + 40, 0.70, 0.45, 0.06), .clear],
                               center: .init(x: 0.85, y: 0.95),
                               startRadius: 0, endRadius: max(geo.size.width, geo.size.height) * 0.9)
            }
            .animation(.easeInOut(duration: 0.6), value: hue)
        }
    }

    private var dotGrid: some View {
        GeometryReader { geo in
            Canvas { ctx, size in
                let step: CGFloat = 26
                let dot = Color(red: 0.588, green: 0.784, blue: 0.961).opacity(0.10)
                var y: CGFloat = 0
                while y < size.height {
                    var x: CGFloat = 0
                    while x < size.width {
                        ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1.4, height: 1.4)), with: .color(dot))
                        x += step
                    }
                    y += step
                }
            }
            .mask(
                RadialGradient(colors: [.black, .black.opacity(0.0)],
                               center: .init(x: 0.5, y: 0.22),
                               startRadius: 0, endRadius: max(geo.size.width, geo.size.height) * 0.6)
            )
        }
    }

    private var connectionColor: Color {
        switch engine.callConnection {
        case .live: return good
        case .connecting, .reconnecting: return gold
        case .failed: return Color(red: 0.949, green: 0.494, blue: 0.494)
        case .idle: return muted
        }
    }

    // ── Top bar: minimize · call identity/timer · truthful connection ──
    private var topBar: some View {
        ZStack {
            VStack(spacing: 2) {
                Text("ALMA AI Call")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(ink)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(engine.callElapsedText(at: context.date))
                        .font(.system(size: 12, design: .monospaced))
                        .monospacedDigit()
                        .foregroundStyle(muted)
                }
            }
            HStack(spacing: 10) {
                Button { minimizeCall() } label: {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(muted)
                        .frame(width: 38, height: 38)
                        .background(glass.opacity(0.06), in: Circle())
                        .overlay(Circle().strokeBorder(line, lineWidth: 1))
                }
                .accessibilityLabel("কল ছোট করুন")
                Spacer(minLength: 8)
                HStack(spacing: 6) {
                    Circle().fill(connectionColor).frame(width: 7, height: 7)
                    .shadow(color: connectionColor, radius: 5)
                    .opacity(liveBlink ? 0.35 : 1)
                    .onAppear {
                        guard !UIAccessibility.isReduceMotionEnabled else { return }
                        withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { liveBlink = true }
                    }
                    Text(engine.transportBadgeText)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(connectionColor)
                }
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(connectionColor.opacity(0.08), in: Capsule())
                .overlay(Capsule().strokeBorder(connectionColor.opacity(0.25), lineWidth: 1))
                Button { showLiveSettings = true } label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(muted)
                        .frame(width: 38, height: 38)
                        .background(glass.opacity(0.06), in: Circle())
                        .overlay(Circle().strokeBorder(line, lineWidth: 1))
                }
                .accessibilityLabel("লাইভ মডেল ও কণ্ঠ নির্বাচন")
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    // ── State badge: glass pill + glowing state-hued dot (web .statebadge) ──
    private var stateBadge: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(almaHSL(hue, 0.85, 0.62))
                .frame(width: 8, height: 8)
                .shadow(color: almaHSL(hue, 0.85, 0.62), radius: 6)
            Text(engine.visibleStatusText)
                .font(.system(size: 13))
                .foregroundStyle(engine.callConnection == .failed
                                 ? Color(red: 0.949, green: 0.627, blue: 0.557) : muted)
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .background(
            LinearGradient(colors: [glass.opacity(0.08), glass.opacity(0.02)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: Capsule())
        .overlay(Capsule().strokeBorder(line, lineWidth: 1))
        .animation(.easeInOut(duration: 0.4), value: hue)
    }

    // ── Kimi-style rolling call feed: Boss dim, ALMA bright, tools as steps ──
    @ViewBuilder private var liveFeedView: some View {
        ScrollViewReader { proxy in
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 9) {
                    ForEach(engine.liveFeed) { lineItem in
                        switch lineItem.kind {
                        case .user:
                            Text(lineItem.text)
                                .font(.system(size: 14.5))
                                .foregroundStyle(faint)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        case .agent:
                            goldBoss(lineItem.text)
                                .font(.system(size: 16, weight: .medium))
                                .foregroundStyle(ink)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        case .status:
                            Text(lineItem.text)
                                .font(.system(size: 12))
                                .foregroundStyle(muted)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    if !toolSteps.isEmpty && engine.state == .thinking {
                        VStack(alignment: .leading, spacing: 5) {
                            ForEach(toolSteps) { s in stepRow(s) }
                        }
                    }
                    Color.clear.frame(height: 1).id("feed-bottom")
                }
                .padding(.horizontal, 26)
            }
            .frame(maxHeight: 240)
            .mask(
                LinearGradient(stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .black, location: 0.12),
                    .init(color: .black, location: 1),
                ], startPoint: .top, endPoint: .bottom)
            )
            .onChange(of: engine.liveFeed) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("feed-bottom", anchor: .bottom) }
            }
            .onAppear { proxy.scrollTo("feed-bottom", anchor: .bottom) }
        }
    }

    // ── Transcript pill + glowing caption + checkmark steps (web voicezone) ──
    @ViewBuilder private var voiceZone: some View {
        VStack(spacing: 10) {
            // last exchange stays readable between turns
            if engine.state == .idle && engine.nowLine.isEmpty && !engine.lastA.isEmpty {
                VStack(spacing: 2) {
                    if !engine.lastQ.isEmpty {
                        Text(engine.lastQ).font(.system(size: 12)).foregroundStyle(faint).lineLimit(1)
                    }
                    Text(engine.lastA).font(.system(size: 13)).foregroundStyle(muted)
                        .multilineTextAlignment(.center).lineLimit(2)
                }
                .padding(.horizontal, 26)
            }
            if engine.liveActive && !engine.liveFeed.isEmpty {
                liveFeedView
            } else if !engine.transcript.isEmpty && engine.state != .idle {
                HStack(spacing: 8) {
                    Text("MIC").font(.system(size: 10.5, weight: .bold)).foregroundStyle(good)
                    Text(engine.transcript).font(.system(size: 13.5)).foregroundStyle(muted).lineLimit(1)
                }
                .padding(.horizontal, 16).padding(.vertical, 7)
                .background(glass.opacity(0.06), in: Capsule())
                .overlay(Capsule().strokeBorder(line, lineWidth: 1))
                .padding(.horizontal, 24)
            }
            // caption: glowing current line + dim said; else greeting/reply; idle hint
            Group {
                if engine.liveActive && !engine.liveFeed.isEmpty {
                    // Kimi-parity: the feed above carries all words; here only the
                    // interrupt hint while ALMA is speaking (same glass language).
                    if engine.state == .speaking {
                        Text("কথা বলা শুরু করুন বা অর্বে ছুঁয়ে থামান")
                            .font(.system(size: 12)).foregroundStyle(faint)
                    }
                } else if engine.state == .speaking && !engine.nowLine.isEmpty {
                    (Text(engine.saidLines.suffix(2).joined(separator: " ") + (engine.saidLines.isEmpty ? "" : " "))
                        .foregroundStyle(faint)
                     + Text(engine.nowLine).foregroundStyle(ink))
                        .font(.system(size: 16.5, weight: .medium))
                        .multilineTextAlignment(.center)
                        .lineLimit(7)
                        .truncationMode(.head)
                } else if !engine.replyText.isEmpty {
                    // Full reply readable: head-truncate → পুরনো লেখা সরে যায়, শেষটা সবসময় দেখা যায়।
                    goldBoss(engine.replyText)
                        .font(.system(size: 16.5))
                        .multilineTextAlignment(.center)
                        .lineLimit(7)
                        .truncationMode(.head)
                } else if engine.callConnection == .failed {
                    Text(engine.connectionFailureText)
                        .font(.system(size: 15))
                        .foregroundStyle(Color(red: 0.949, green: 0.627, blue: 0.557))
                        .multilineTextAlignment(.center)
                } else if engine.callConnection == .connecting || engine.callConnection == .reconnecting {
                    Text("একটু অপেক্ষা করুন—লাইভ কল প্রস্তুত হচ্ছে।")
                        .font(.system(size: 15))
                        .foregroundStyle(muted)
                        .multilineTextAlignment(.center)
                } else if engine.state == .idle {
                    (Text("আসসালামু আলাইকুম, ").foregroundStyle(muted)
                     + Text("Boss").foregroundStyle(gold)
                     + Text("। স্বাভাবিকভাবে বলুন—ট্যাপ করার প্রয়োজন নেই।").foregroundStyle(muted))
                        .font(.system(size: 15))
                        .multilineTextAlignment(.center)
                } else if engine.state == .listening {
                    Text(engine.isMuted ? "আপনার মাইক্রোফোন বন্ধ আছে" : "বলুন—আমি শুনছি, থামলে স্বাভাবিকভাবে উত্তর দেব।")
                        .font(.system(size: 12.5)).foregroundStyle(faint)
                }
            }
            .shadow(color: almaHSL(hue, 0.80, 0.60, 0.28), radius: 13)
            .padding(.horizontal, 26)
            // checkmark steps (web .steps) — tool progress for the current turn
            if !toolSteps.isEmpty && !(engine.liveActive && !engine.liveFeed.isEmpty) {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(toolSteps) { s in stepRow(s) }
                }
            }
        }
        .frame(minHeight: 66, alignment: .top)
    }

    /// Owner-address policy: legacy/provider wording is normalized before it can
    /// reach either the caption or VoiceOver; only Boss/বস is rendered.
    private func goldBoss(_ text: String) -> Text {
        let safe = text
            .replacingOccurrences(of: "Sir", with: "Boss", options: .caseInsensitive)
            .replacingOccurrences(of: "স্যার", with: "Boss")
        var out = Text("")
        var rest = Substring(safe)
        while true {
            let rs = ["Boss", "বস"].compactMap { rest.range(of: $0) }.min { $0.lowerBound < $1.lowerBound }
            guard let r = rs else { break }
            out = out + Text(String(rest[..<r.lowerBound])).foregroundStyle(ink)
            out = out + Text(String(rest[r])).foregroundStyle(gold)
            rest = rest[r.upperBound...]
        }
        return out + Text(String(rest)).foregroundStyle(ink)
    }

    @ViewBuilder private func stepRow(_ s: AlmaVoiceEngine.Card) -> some View {
        HStack(spacing: 8) {
            ZStack {
                Circle().strokeBorder(s.status == "ok" ? good : faint, lineWidth: 1.5)
                    .frame(width: 15, height: 15)
                if s.status == "ok" {
                    Image(systemName: "checkmark").font(.system(size: 7.5, weight: .bold)).foregroundStyle(good)
                } else if s.status == "fail" {
                    Image(systemName: "xmark").font(.system(size: 7.5, weight: .bold))
                        .foregroundStyle(Color(red: 0.949, green: 0.494, blue: 0.494))
                }
            }
            Text(s.title).font(.system(size: 13.5))
                .foregroundStyle(s.status == "ok" ? muted : faint)
                .lineLimit(1)
        }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    // ── Live action feed: header + count + glass cards (web .feed-col) ──
    @ViewBuilder private var feedSection: some View {
        if !feedCards.isEmpty {
            VStack(spacing: 10) {
                HStack {
                    Text("লাইভ অ্যাকশন ফিড")
                        .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(muted)
                    Spacer()
                    Text("\(feedCards.count)")
                        .font(.system(size: 11)).monospacedDigit().foregroundStyle(faint)
                        .padding(.horizontal, 10).padding(.vertical, 3)
                        .overlay(Capsule().strokeBorder(line, lineWidth: 1))
                }
                .padding(.horizontal, 22)
                ScrollView {
                    VStack(spacing: 10) {
                        ForEach(feedCards) { card in
                            AlmaFeedCard(card: card, engine: engine, hue: hue)
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .frame(maxHeight: 200)
            }
            .padding(.top, 10)
        }
    }

    // ── Call controls: mute · speaker · chat/minimize · hang up ──
    private var dock: some View {
        VStack(spacing: 10) {
            if engine.state == .speaking {
                Text("কথা শুরু করলেই ALMA থেমে শুনবে")
                    .font(.system(size: 12)).foregroundStyle(faint)
            }
            // attached-image thumbnails (chat composer parity)
            if !engine.pendingImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(engine.pendingImages) { img in
                            ZStack(alignment: .topTrailing) {
                                Image(uiImage: img.image).resizable().scaledToFill()
                                    .frame(width: 52, height: 52)
                                    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(line, lineWidth: 1))
                                    .overlay {
                                        if case .uploading = img.state {
                                            ZStack { Color.black.opacity(0.35); ProgressView().controlSize(.mini).tint(.white) }
                                                .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                                        } else if case .failed = img.state {
                                            RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Color.red.opacity(0.25))
                                        }
                                    }
                                Button { engine.removeImage(img.id) } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .accessibilityLabel("ছবি সরান")
                                        .font(.system(size: 15)).foregroundStyle(.white, .black.opacity(0.5))
                                }
                                .offset(x: 5, y: -5)
                            }
                        }
                    }
                    .padding(.horizontal, 22)
                }
            }
            if engine.callConnection == .failed {
                HStack(spacing: 10) {
                    Button { engine.retryLiveConnection() } label: {
                        Label("আবার সংযোগ করুন", systemImage: "arrow.clockwise")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(bg0)
                            .padding(.horizontal, 18).padding(.vertical, 11)
                            .background(good, in: Capsule())
                    }
                    Button { endCall() } label: {
                        Text("কল শেষ করুন")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(muted)
                            .padding(.horizontal, 18).padding(.vertical, 11)
                            .background(glass.opacity(0.06), in: Capsule())
                            .overlay(Capsule().strokeBorder(line, lineWidth: 1))
                    }
                }
            } else {
                HStack(spacing: 18) {
                    callControl(
                        icon: engine.isMuted ? "mic.slash.fill" : "mic.fill",
                        label: engine.isMuted ? "মাইক চালু" : "মিউট",
                        active: engine.isMuted,
                        enabled: engine.callConnection == .live
                    ) { engine.toggleMute() }

                    callControl(
                        icon: engine.speakerOn ? "speaker.wave.2.fill" : "speaker.fill",
                        label: "স্পিকার",
                        active: engine.speakerOn,
                        enabled: engine.callConnection == .live
                    ) { engine.toggleSpeaker() }

                    callControl(
                        icon: "message.fill",
                        label: "চ্যাট",
                        active: false,
                        enabled: true
                    ) { minimizeCall() }

                    Button { endCall() } label: {
                        VStack(spacing: 7) {
                            Image(systemName: "phone.down.fill")
                                .font(.system(size: 20, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(width: 58, height: 58)
                                .background(Color(red: 0.91, green: 0.20, blue: 0.24), in: Circle())
                                .shadow(color: Color.red.opacity(0.28), radius: 12, y: 5)
                            Text("শেষ")
                                .font(.system(size: 11.5, weight: .medium))
                                .foregroundStyle(muted)
                        }
                    }
                    .accessibilityLabel("কল শেষ করুন")
                }
            }

            PhotosPicker(selection: $photoItem, matching: .images) {
                Label("ছবি যোগ করুন", systemImage: "photo")
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(faint)
            }
        }
        .padding(.bottom, 22)
    }

    private func callControl(icon: String, label: String, active: Bool,
                             enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Image(systemName: icon)
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(active ? bg0 : ink)
                    .frame(width: 54, height: 54)
                    .background(active ? ink : glass.opacity(0.09), in: Circle())
                    .overlay(Circle().strokeBorder(active ? Color.clear : line, lineWidth: 1))
                Text(label)
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(muted)
            }
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.38)
    }

    private func minimizeCall() {
        minimizing = true
        dismiss()
    }

    private func endCall() {
        endingCall = true
        engine.end()
        dismiss()
    }

    private func chip(_ label: String, _ utterance: String, enabled: Bool) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            engine.runChip(utterance)
        } label: {
            Text(label)
                .font(.system(size: 13.5))
                .foregroundStyle(ink)
                .padding(.horizontal, 18).padding(.vertical, 9)
                .background(
                    LinearGradient(colors: [glass.opacity(0.09), glass.opacity(0.03)],
                                   startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: Capsule())
                .overlay(Capsule().strokeBorder(line, lineWidth: 1))
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }

}

/// Draft-only state for the pre-call picker. Voice taps always update the draft,
/// while the return value makes the side-effect boundary explicit: preview work
/// may start only after the process-wide admission gate reports idle.
struct AlmaLiveVoicePreCallDraft: Equatable {
    enum PreviewStatus: Equatable {
        case idle
        case loading(voiceID: String)
        case playing(voiceID: String)
        case unavailableDuringCall
        case unavailable
    }

    private(set) var modelID: String
    private(set) var voiceID: String
    private(set) var previewStatus: PreviewStatus = .idle

    init(modelID: String, voiceID: String) {
        self.modelID = AlmaLiveVoicePreferences.models.contains(where: { $0.id == modelID })
            ? modelID : AlmaLiveVoicePreferences.gemini25
        self.voiceID = AlmaLiveVoicePreferences.voices.contains(where: { $0.id == voiceID })
            ? voiceID : "Aoede"
    }

    mutating func selectModel(_ id: String, admission: AlmaLiveVoicePreviewGate) -> Bool {
        guard AlmaLiveVoicePreferences.models.contains(where: { $0.id == id }) else { return false }
        modelID = id
        guard admission.featureEnabled else {
            previewStatus = .unavailable
            return false
        }
        guard !admission.callIsActive else {
            previewStatus = .unavailableDuringCall
            return false
        }
        previewStatus = .loading(voiceID: voiceID)
        return true
    }

    /// Returns `true` only when the caller may ask the verified preview
    /// coordinator to resolve and play this exact model/voice identity.
    mutating func selectVoice(_ id: String, admission: AlmaLiveVoicePreviewGate) -> Bool {
        guard AlmaLiveVoicePreferences.voices.contains(where: { $0.id == id }) else { return false }
        voiceID = id
        guard admission.featureEnabled else {
            previewStatus = .unavailable
            return false
        }
        guard !admission.callIsActive else {
            previewStatus = .unavailableDuringCall
            return false
        }
        previewStatus = .loading(voiceID: id)
        return true
    }

    mutating func apply(_ decision: AlmaLiveVoicePreviewCoordinator.RequestDecision) {
        switch decision {
        case .started:
            previewStatus = .loading(voiceID: voiceID)
        case .blockedActiveCall:
            previewStatus = .unavailableDuringCall
        case .blockedFeatureOff, .blockedShutdown:
            previewStatus = .unavailable
        }
    }

    mutating func reflect(_ state: AlmaLiveVoicePreviewCoordinator.State) {
        switch state {
        case .idle, .stopped:
            previewStatus = .idle
        case .loading:
            previewStatus = .loading(voiceID: voiceID)
        case .playing(_, _, let playingVoiceID):
            previewStatus = .playing(voiceID: playingVoiceID)
        case .failed:
            previewStatus = .unavailable
        }
    }

    var previewAccessibilityAnnouncement: String {
        let statusVoiceID: String
        switch previewStatus {
        case .loading(let voiceID), .playing(let voiceID):
            statusVoiceID = voiceID
        case .idle, .unavailableDuringCall, .unavailable:
            statusVoiceID = voiceID
        }
        let voiceName = AlmaLiveVoicePreferences.voices
            .first(where: { $0.id == statusVoiceID })?.name ?? "ভয়েস"
        switch previewStatus {
        case .idle:
            return "ভয়েস Preview বন্ধ হয়েছে"
        case .loading:
            return "\(voiceName)-র Preview প্রস্তুত হচ্ছে"
        case .playing:
            return "\(voiceName)-র Preview চলছে"
        case .unavailableDuringCall:
            return "\(voiceName) draft-এ নির্বাচিত। কল বা অন্য audio চলায় Preview বন্ধ আছে"
        case .unavailable:
            return "\(voiceName) draft-এ নির্বাচিত। Verified Preview এখন পাওয়া যাচ্ছে না"
        }
    }
}

@MainActor
protocol AlmaLiveVoicePreCallPreviewCoordinating: AnyObject {
    var state: AlmaLiveVoicePreviewCoordinator.State { get }
    func play(
        modelID: String,
        voiceID: String
    ) -> AlmaLiveVoicePreviewCoordinator.RequestDecision
    func stop()
    func shutdown()
}

extension AlmaLiveVoicePreviewCoordinator: AlmaLiveVoicePreCallPreviewCoordinating {}

/// Sheet-owned bridge to the isolated preview core. It has no `AssistantVM` or
/// `AlmaVoiceEngine` reference, so opening voice settings cannot register a
/// call, ask for microphone permission, fetch a token, or open a socket.
@available(iOS 17.0, *)
@Observable
@MainActor
final class AlmaLiveVoicePreCallSettingsController {
    private(set) var draft: AlmaLiveVoicePreCallDraft
    private let coordinator: (any AlmaLiveVoicePreCallPreviewCoordinating)?
    private let admission: @MainActor () -> AlmaLiveVoicePreviewGate
    private let savePreferences: @MainActor (String, String) -> Void
    private var monitorTask: Task<Void, Never>?
    private var isShutdown = false

    init(
        modelID: String,
        voiceID: String,
        coordinator: (any AlmaLiveVoicePreCallPreviewCoordinating)?,
        admission: @escaping @MainActor () -> AlmaLiveVoicePreviewGate = {
            AlmaLiveVoicePreviewGate.production
        },
        savePreferences: @escaping @MainActor (String, String) -> Void = {
            AlmaLiveVoicePreferences.save(modelID: $0, voiceID: $1)
        }
    ) {
        draft = .init(modelID: modelID, voiceID: voiceID)
        self.coordinator = coordinator
        self.admission = admission
        self.savePreferences = savePreferences
    }

    static func production() -> AlmaLiveVoicePreCallSettingsController {
        let coordinator: AlmaLiveVoicePreviewCoordinator?
        do {
            // Phase 1A is bundled-first/offline. A CDN origin stays nil until a
            // separately verified production origin is deliberately injected.
            let store = try AlmaLiveVoicePreviewAssetStore.bundled(cdnBaseURL: nil)
            coordinator = AlmaLiveVoicePreviewCoordinator(
                store: store,
                admission: { AlmaLiveVoicePreviewGate.production })
        } catch {
            coordinator = nil
        }
        return AlmaLiveVoicePreCallSettingsController(
            modelID: AlmaLiveVoicePreferences.modelID,
            voiceID: AlmaLiveVoicePreferences.voiceID,
            coordinator: coordinator)
    }

    func selectModel(_ id: String) {
        guard !isShutdown else { return }
        guard draft.selectModel(id, admission: admission()) else {
            stopPreviewMonitoring()
            coordinator?.stop()
            return
        }
        requestExactPreview()
    }

    func selectVoice(_ id: String) {
        guard !isShutdown else { return }
        guard draft.selectVoice(id, admission: admission()) else {
            stopPreviewMonitoring()
            coordinator?.stop()
            return
        }
        requestExactPreview()
    }

    private func requestExactPreview() {
        stopPreviewMonitoring()
        guard let coordinator else {
            draft.apply(.blockedShutdown)
            return
        }

        let decision = coordinator.play(modelID: draft.modelID, voiceID: draft.voiceID)
        draft.apply(decision)
        guard case .started = decision else { return }
        monitorTask = Task { [weak self, weak coordinator] in
            guard let self, let coordinator else { return }
            while !Task.isCancelled {
                self.draft.reflect(coordinator.state)
                switch coordinator.state {
                case .loading, .playing:
                    try? await Task.sleep(for: .milliseconds(100))
                case .idle, .failed, .stopped:
                    return
                }
            }
        }
    }

    private func stopPreviewMonitoring() {
        monitorTask?.cancel()
        monitorTask = nil
    }

    func save() {
        guard !isShutdown else { return }
        savePreferences(draft.modelID, draft.voiceID)
    }

    func cancel() {
        shutdown()
    }

    func shutdown() {
        guard !isShutdown else { return }
        isShutdown = true
        stopPreviewMonitoring()
        coordinator?.shutdown()
    }
}

/// Pre-call model/voice picker. This is intentionally separate from the
/// in-call settings sheet below: Save/Cancel operate on a draft and preview
/// playback never creates or starts the live-call engine.
@available(iOS 17.0, *)
struct AlmaLiveVoicePreCallSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var controller: AlmaLiveVoicePreCallSettingsController
    @State private var accessibilityAnnouncementTask: Task<Void, Never>?

    private let ink = Color(red: 0.918, green: 0.949, blue: 0.984)
    private let muted = Color(red: 0.486, green: 0.573, blue: 0.663)
    private let gold = Color(red: 0.886, green: 0.702, blue: 0.400)
    private let good = Color(red: 0.231, green: 0.878, blue: 0.561)
    private let bg = Color(red: 0.016, green: 0.027, blue: 0.051)
    private let panel = Color(red: 0.055, green: 0.082, blue: 0.118)
    private let line = Color(red: 0.627, green: 0.784, blue: 0.941).opacity(0.16)

    init(controller: AlmaLiveVoicePreCallSettingsController? = nil) {
        _controller = State(initialValue: controller ?? .production())
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text("কলের আগে ভয়েস বেছে নিন")
                            .font(.system(size: 26, weight: .bold))
                            .foregroundStyle(ink)
                        Text("Save না করা পর্যন্ত মডেল ও কণ্ঠের পছন্দ বদলাবে না। Preview শুধু যাচাইকৃত local audio চালায়।")
                            .font(.system(size: 14))
                            .foregroundStyle(muted)
                    }

                    settingsSection(title: "মডেল", subtitle: "পরের লাইভ কলের model") {
                        VStack(spacing: 10) {
                            ForEach(AlmaLiveVoicePreferences.models) { model in
                                choiceButton(
                                    selected: controller.draft.modelID == model.id,
                                    accessibilityLabel: "\(model.title), \(model.badge), \(model.detail)"
                                ) {
                                    controller.selectModel(model.id)
                                } content: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack {
                                            Text(model.title)
                                                .font(.system(size: 16, weight: .semibold))
                                            Spacer()
                                            Text(model.badge)
                                                .font(.system(size: 10, weight: .bold))
                                                .foregroundStyle(gold)
                                                .padding(.horizontal, 8).padding(.vertical, 4)
                                                .background(gold.opacity(0.10), in: Capsule())
                                            if controller.draft.modelID == model.id {
                                                Image(systemName: "checkmark.circle.fill")
                                                    .foregroundStyle(good)
                                            }
                                        }
                                        Text(model.detail)
                                            .font(.system(size: 12.5))
                                            .foregroundStyle(muted)
                                        modelFact("শক্তি", model.strengths)
                                        modelFact("সীমাবদ্ধতা", model.limitations)
                                        modelFact("খরচ ও lifecycle", model.costLifecycle)
                                        modelFact("ভালো মানায়", model.bestUse)
                                    }
                                }
                                .accessibilityIdentifier("voice.precall.model.\(model.id)")
                                .accessibilityHint("Model draft-এ নির্বাচন করে বর্তমান draft voice-এর exact verified preview চালাবে")
                            }
                        }
                    }

                    settingsSection(
                        title: "Verified বাংলা নমুনা",
                        subtitle: "সব ১২টি immutable preview-তে এই একই script; preview cache hit হলে কোনো নতুন Gemini generation বা generation cost হয় না"
                    ) {
                        VStack(alignment: .leading, spacing: 7) {
                            ForEach(
                                Array(AlmaLiveVoicePreviewCatalog.expectedScriptLines.enumerated()),
                                id: \.offset
                            ) { index, scriptLine in
                                HStack(alignment: .firstTextBaseline, spacing: 9) {
                                    Text("\(index + 1)")
                                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                                        .foregroundStyle(gold)
                                        .frame(width: 16, alignment: .trailing)
                                    Text(scriptLine)
                                        .font(.system(size: 13.5))
                                        .foregroundStyle(ink)
                                }
                            }
                        }
                        .padding(14)
                        .background(panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .strokeBorder(line, lineWidth: 1))
                        .accessibilityIdentifier("voice.precall.verified-script")
                    }

                    settingsSection(title: "কণ্ঠ ও Preview", subtitle: "কণ্ঠে tap করলে draft select হবে এবং audio idle থাকলে preview শোনা যাবে") {
                        LazyVGrid(
                            columns: [GridItem(.flexible()), GridItem(.flexible())],
                            spacing: 10
                        ) {
                            ForEach(AlmaLiveVoicePreferences.voices) { voice in
                                choiceButton(
                                    selected: controller.draft.voiceID == voice.id,
                                    accessibilityLabel: "\(voice.name), \(voice.detail), \(voice.id)"
                                ) {
                                    controller.selectVoice(voice.id)
                                } content: {
                                    VStack(alignment: .leading, spacing: 8) {
                                        HStack {
                                            Image(systemName: voice.symbol)
                                                .foregroundStyle(controller.draft.voiceID == voice.id ? good : gold)
                                            Spacer()
                                            previewGlyph(for: voice.id)
                                        }
                                        Text(voice.name).font(.system(size: 16, weight: .semibold))
                                        Text(voice.detail).font(.system(size: 11.5)).foregroundStyle(muted)
                                        Text(voice.id)
                                            .font(.system(size: 10, design: .monospaced))
                                            .foregroundStyle(muted.opacity(0.72))
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .accessibilityIdentifier("voice.precall.voice.\(voice.id)")
                                .accessibilityHint("Draft নির্বাচন করে verified preview চালাবে, যদি কোনো call বা audio active না থাকে")
                            }
                        }

                        previewStatus
                    }

                    Text("Save করলে এই পছন্দ পরের কল শুরু হওয়ার সময় নেওয়া হবে। Cancel করলে আগের পছন্দই থাকবে।")
                        .font(.system(size: 11.5))
                        .foregroundStyle(muted)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                }
                .padding(20)
            }
            .accessibilityIdentifier("voice.precall.settings.scroll")
            .background(bg.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") {
                        controller.cancel()
                        dismiss()
                    }
                        .foregroundStyle(muted)
                        .accessibilityIdentifier("voice.precall.cancel")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") {
                        controller.save()
                        controller.shutdown()
                        dismiss()
                    }
                    .fontWeight(.semibold)
                    .foregroundStyle(gold)
                    .accessibilityIdentifier("voice.precall.save")
                }
            }
        }
        .presentationDetents([.large])
        .preferredColorScheme(.dark)
        .onChange(of: controller.draft.previewStatus) { oldStatus, newStatus in
            guard oldStatus != newStatus else { return }
            queueAccessibilityAnnouncement(
                controller.draft.previewAccessibilityAnnouncement)
        }
        .onDisappear {
            accessibilityAnnouncementTask?.cancel()
            accessibilityAnnouncementTask = nil
            controller.shutdown()
        }
    }

    @ViewBuilder
    private func previewGlyph(for voiceID: String) -> some View {
        if controller.draft.voiceID == voiceID {
            switch controller.draft.previewStatus {
            case .loading:
                ProgressView().controlSize(.mini).tint(good)
            case .playing:
                Image(systemName: "speaker.wave.2.fill").foregroundStyle(good)
            case .idle, .unavailable, .unavailableDuringCall:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(good)
            }
        } else {
            Image(systemName: "play.circle").foregroundStyle(muted)
        }
    }

    @ViewBuilder
    private var previewStatus: some View {
        let voiceName = AlmaLiveVoicePreferences.voices
            .first(where: { $0.id == controller.draft.voiceID })?.name ?? "ভয়েস"
        Group {
            switch controller.draft.previewStatus {
            case .idle:
                Label("কণ্ঠে tap করে verified preview শুনুন", systemImage: "play.circle")
                    .foregroundStyle(muted)
            case .loading:
                Label("\(voiceName)-র verified preview প্রস্তুত হচ্ছে…", systemImage: "checkmark.shield")
                    .foregroundStyle(gold)
            case .playing:
                Label("\(voiceName)-র verified preview চলছে", systemImage: "speaker.wave.2.fill")
                    .foregroundStyle(good)
            case .unavailableDuringCall:
                Label("কল বা অন্য audio চলায় preview এখন unavailable — draft Save করা যাবে।", systemImage: "phone.fill")
                    .foregroundStyle(gold)
            case .unavailable:
                Label("Verified preview এখন পাওয়া যাচ্ছে না — draft Save করা যাবে।", systemImage: "exclamationmark.circle")
                    .foregroundStyle(gold)
            }
        }
        .font(.system(size: 12.5, weight: .medium))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("voice.precall.preview.status")
    }

    private func settingsSection<Content: View>(
        title: String,
        subtitle: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            Text(title).font(.system(size: 18, weight: .semibold)).foregroundStyle(ink)
            Text(subtitle).font(.system(size: 12)).foregroundStyle(muted)
            content()
        }
    }

    private func modelFact(_ label: String, _ value: String) -> some View {
        (Text("\(label): ").fontWeight(.semibold) + Text(value))
            .font(.system(size: 11.5))
            .foregroundStyle(muted)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func choiceButton<Content: View>(
        selected: Bool,
        accessibilityLabel: String,
        action: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) -> some View {
        Button(action: action) {
            content()
                .foregroundStyle(ink)
                .padding(14)
                .background(selected ? good.opacity(0.09) : panel,
                            in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(selected ? good.opacity(0.75) : line,
                                      lineWidth: selected ? 1.4 : 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(selected ? "নির্বাচিত" : "নির্বাচিত নয়")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func queueAccessibilityAnnouncement(_ text: String) {
        accessibilityAnnouncementTask?.cancel()
        accessibilityAnnouncementTask = Task { @MainActor in
            do {
                try await Task.sleep(for: .milliseconds(250))
            } catch {
                return
            }
            guard !Task.isCancelled, UIAccessibility.isVoiceOverRunning else { return }
            let announcement = NSAttributedString(
                string: text,
                attributes: [
                    .accessibilitySpeechAnnouncementPriority: UIAccessibilityPriority.low,
                ])
            UIAccessibility.post(notification: .announcement, argument: announcement)
        }
    }
}

@available(iOS 17.0, *)
struct AlmaLiveSettingsSheet: View {
    let engine: AlmaVoiceEngine
    @Environment(\.dismiss) private var dismiss
    @State private var recoveryEvidenceURL: URL?
    @State private var draftModelID: String
    @State private var draftVoiceID: String
    @State private var localProfileMessage = ""

    init(engine: AlmaVoiceEngine) {
        self.engine = engine
        _draftModelID = State(initialValue: engine.savedLiveModelID)
        _draftVoiceID = State(initialValue: engine.savedLiveVoiceID)
    }

    private let ink = Color(red: 0.918, green: 0.949, blue: 0.984)
    private let muted = Color(red: 0.486, green: 0.573, blue: 0.663)
    private let gold = Color(red: 0.886, green: 0.702, blue: 0.400)
    private let good = Color(red: 0.231, green: 0.878, blue: 0.561)
    private let bg = Color(red: 0.016, green: 0.027, blue: 0.051)
    private let panel = Color(red: 0.055, green: 0.082, blue: 0.118)
    private let line = Color(red: 0.627, green: 0.784, blue: 0.941).opacity(0.16)

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text("বাংলা লাইভ ভয়েস")
                            .font(.system(size: 26, weight: .bold))
                            .foregroundStyle(ink)
                        Text("শুধু Gemini Native Audio। মডেল ও কণ্ঠের পছন্দ নিরাপদে এই ডিভাইসে সেভ থাকবে।")
                            .font(.system(size: 14))
                            .foregroundStyle(muted)
                    }

                    settingsSection(title: "মডেল", subtitle: "কথার ধরন ও response speed") {
                        VStack(spacing: 10) {
                            ForEach(AlmaLiveVoicePreferences.models) { model in
                                choiceButton(selected: draftModelID == model.id) {
                                    draftModelID = model.id
                                    localProfileMessage = ""
                                    UISelectionFeedbackGenerator().selectionChanged()
                                } content: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack {
                                            Text(model.title).font(.system(size: 16, weight: .semibold))
                                            Spacer()
                                            if engine.activeLiveModelID == model.id {
                                                Text("সক্রিয়")
                                                    .font(.system(size: 9, weight: .bold))
                                                    .foregroundStyle(good)
                                            } else if engine.savedLiveModelID == model.id {
                                                Text("সেভড")
                                                    .font(.system(size: 9, weight: .bold))
                                                    .foregroundStyle(muted)
                                            }
                                            Text(model.badge)
                                                .font(.system(size: 10, weight: .bold))
                                                .foregroundStyle(gold)
                                                .padding(.horizontal, 8).padding(.vertical, 4)
                                                .background(gold.opacity(0.10), in: Capsule())
                                            if draftModelID == model.id {
                                                Image(systemName: "checkmark.circle.fill")
                                                    .foregroundStyle(good)
                                            }
                                        }
                                        Text(model.detail).font(.system(size: 12.5)).foregroundStyle(muted)
                                    }
                                }
                            }
                        }
                    }

                    settingsSection(title: "কণ্ঠ", subtitle: "Google-এর official voice থেকে বাংলা-friendly presets") {
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                            ForEach(AlmaLiveVoicePreferences.voices) { voice in
                                choiceButton(selected: draftVoiceID == voice.id) {
                                    draftVoiceID = voice.id
                                    localProfileMessage = ""
                                    UISelectionFeedbackGenerator().selectionChanged()
                                } content: {
                                    VStack(alignment: .leading, spacing: 8) {
                                        HStack {
                                            Image(systemName: voice.symbol)
                                                .foregroundStyle(draftVoiceID == voice.id ? good : gold)
                                            Spacer()
                                            if engine.activeLiveVoiceID == voice.id {
                                                Text("সক্রিয়")
                                                    .font(.system(size: 9, weight: .bold))
                                                    .foregroundStyle(good)
                                            } else if engine.savedLiveVoiceID == voice.id {
                                                Text("সেভড")
                                                    .font(.system(size: 9, weight: .bold))
                                                    .foregroundStyle(muted)
                                            }
                                            if draftVoiceID == voice.id {
                                                Image(systemName: "checkmark.circle.fill").foregroundStyle(good)
                                            }
                                        }
                                        Text(voice.name).font(.system(size: 16, weight: .semibold))
                                        Text(voice.detail).font(.system(size: 11.5)).foregroundStyle(muted)
                                        Text(voice.id).font(.system(size: 10, design: .monospaced)).foregroundStyle(muted.opacity(0.72))
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                    }

                    if engine.isRecoveryEvidenceEnabled {
                        settingsSection(
                            title: "Privacy-safe evidence",
                            subtitle: "চলতি call-এর local snapshot: app/build, model/voice, call mode/outcome, input-window, typed lifecycle/transport/tool identity, withholding/not-queued/send outcome, timing, route, byte count ও rounded energy। Raw energy মানেই owner speech নয়; queued মানেই sent নয়; local send completion Gemini receipt নয়। Share চাপার আগে JSON device-এই থাকে। কোনো recording/PCM, transcript, prompt, tool arguments/results, URL, token বা provider call ID নেই।",
                            subtitleAccessibilityIdentifier: "voice.evidence.privacy-disclosure"
                        ) {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("Local session ID")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(muted)
                                Text(engine.recoveryEvidenceSessionID)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(ink)
                                    .textSelection(.enabled)
                                    .accessibilityIdentifier("voice.evidence.session-id")

                                Button {
                                    recoveryEvidenceURL = engine.exportRecoveryEvidence()
                                } label: {
                                    Label("Evidence JSON তৈরি করুন", systemImage: "doc.badge.gearshape")
                                        .font(.system(size: 14, weight: .semibold))
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 12)
                                        .background(panel, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 13, style: .continuous)
                                                .strokeBorder(line, lineWidth: 1))
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("voice.evidence.export")
                                .accessibilityHint("চলতি কলের content-free evidence snapshot বানাবে")

                                if let recoveryEvidenceURL {
                                    ShareLink(item: recoveryEvidenceURL) {
                                        Label("Evidence share করুন", systemImage: "square.and.arrow.up")
                                            .font(.system(size: 14, weight: .semibold))
                                            .foregroundStyle(good)
                                    }
                                    .accessibilityIdentifier("voice.evidence.share")
                                }
                            }
                        }
                    }

                    VStack(spacing: 9) {
                        Button {
                            if engine.saveLiveProfile(
                                modelID: draftModelID,
                                voiceID: draftVoiceID
                            ) {
                                localProfileMessage = "পরের কলের জন্য সেভ হয়েছে।"
                            }
                        } label: {
                            Label("পরের কলের জন্য সেভ করুন", systemImage: "square.and.arrow.down")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(ink)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(panel, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 15, style: .continuous)
                                        .strokeBorder(line, lineWidth: 1))
                        }
                        .disabled(
                            draftModelID == engine.savedLiveModelID
                                && draftVoiceID == engine.savedLiveVoiceID)
                        .accessibilityIdentifier("voice.settings.save-profile")

                        if AlmaLiveVoiceRecoveryFeatures.isEnabled(.profileTransactionV1) {
                            Button {
                                _ = engine.applyLiveProfileNow(
                                    modelID: draftModelID,
                                    voiceID: draftVoiceID)
                                localProfileMessage = ""
                            } label: {
                                Label(
                                    engine.isApplyingLiveProfile
                                        ? "যাচাই হচ্ছে…"
                                        : "এই কলেই যাচাই করে প্রয়োগ করুন",
                                    systemImage: "arrow.triangle.2.circlepath")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(bg)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 14)
                                    .background(good, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                            }
                            .disabled(
                                engine.isApplyingLiveProfile
                                    || (engine.callConnection != .live
                                        && engine.callConnection != .failed))
                            .opacity(
                                !engine.isApplyingLiveProfile
                                    && (engine.callConnection == .live
                                        || engine.callConnection == .failed)
                                    ? 1 : 0.45)
                            .accessibilityIdentifier("voice.settings.apply-profile")
                        }

                        let statusText = engine.liveProfileStatusText.isEmpty
                            ? localProfileMessage
                            : engine.liveProfileStatusText
                        Text(statusText.isEmpty
                             ? "Save শুধু পরের কল বদলায়। Apply health check পাস হলে বর্তমান call বদলায়; ব্যর্থ হলে আগের active profile ফিরে আসে।"
                             : statusText)
                            .font(.system(size: 11.5))
                            .foregroundStyle(statusText.isEmpty ? muted : good)
                            .multilineTextAlignment(.center)
                            .accessibilityIdentifier("voice.settings.profile-status")
                    }
                }
                .padding(20)
            }
            .accessibilityIdentifier("voice.settings.scroll")
            .background(bg.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("বাতিল") { dismiss() }.foregroundStyle(gold)
                }
            }
        }
        .presentationDetents([.large])
        .preferredColorScheme(.dark)
    }

    private func settingsSection<Content: View>(
        title: String,
        subtitle: String,
        subtitleAccessibilityIdentifier: String? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            Text(title).font(.system(size: 18, weight: .semibold)).foregroundStyle(ink)
            if let subtitleAccessibilityIdentifier {
                Text(subtitle)
                    .font(.system(size: 12))
                    .foregroundStyle(muted)
                    .accessibilityIdentifier(subtitleAccessibilityIdentifier)
            } else {
                Text(subtitle).font(.system(size: 12)).foregroundStyle(muted)
            }
            content()
        }
    }

    private func choiceButton<Content: View>(
        selected: Bool, action: @escaping () -> Void, @ViewBuilder content: () -> Content
    ) -> some View {
        Button(action: action) {
            content()
                .foregroundStyle(ink)
                .padding(14)
                .background(selected ? good.opacity(0.09) : panel,
                            in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(selected ? good.opacity(0.75) : line, lineWidth: selected ? 1.4 : 1)
                )
        }
        .buttonStyle(.plain)
    }
}

/// Compact, persistent call surface shown over chat after the full-screen call is
/// minimized. The same `AlmaVoiceEngine` keeps the socket, audio, and context alive.
@available(iOS 17.0, *)
/// App-wide handle to the live call: the mini bar must follow the owner to
/// EVERY tab (a phone call isn't an Assistant-page detail). The engine
/// registers itself on begin()/end(); the shell-level bar observes this.
@available(iOS 17.0, *)
@Observable
final class AlmaCallBarBridge {
    static let shared = AlmaCallBarBridge()
    weak var engine: AlmaVoiceEngine?
    /// Full-screen console open — the floating bar hides while the real UI shows.
    var consoleVisible = false
}

/// Shell-level floating call bar: rendered by AlmaTabBarController above ALL
/// tabs; tapping it selects the Assistant tab and reopens the console.
@available(iOS 17.0, *)
struct AlmaGlobalCallBar: View {
    let selectAssistant: () -> Void
    private var bridge: AlmaCallBarBridge { AlmaCallBarBridge.shared }
    var body: some View {
        if let engine = bridge.engine, engine.isCallRunning, !bridge.consoleVisible {
            AlmaVoiceCallMiniBar(engine: engine,
                                 reopen: selectAssistant,
                                 end: { engine.end() })
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}

/// Live who-is-talking wave for the mini bar: agent speech (green, slow pulse)
/// and the owner's own voice (coral, sharper) get visibly different designs,
/// driven by the same levels the orb uses — so "কথা হচ্ছে" is visible at a glance.
@available(iOS 17.0, *)
struct AlmaCallMiniWave: View {
    let engine: AlmaVoiceEngine
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20.0)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            let agent = engine.state == .speaking || engine.ttsLevel > 0.03
            let ownerTalking = !agent && engine.micLevel > 0.10
            let level = agent ? max(engine.ttsLevel, 0.2) : engine.micLevel
            let color = agent
                ? Color(red: 0.231, green: 0.878, blue: 0.561)
                : Color(red: 0.878, green: 0.478, blue: 0.373)   // ALMA coral
            HStack(spacing: 2.5) {
                ForEach(0..<5, id: \.self) { i in
                    let phase = sin(t * (agent ? 8.0 : 13.0) + Double(i) * 1.15) * 0.5 + 0.5
                    let active = agent || ownerTalking
                    let h: CGFloat = active ? 6 + CGFloat(min(1, level) * phase) * 16 : 4
                    Capsule()
                        .fill(active ? color : Color.white.opacity(0.28))
                        .frame(width: 3, height: h)
                }
            }
            .frame(width: 30, height: 24)
        }
    }
}

@available(iOS 17.0, *)
struct AlmaVoiceCallMiniBar: View {
    let engine: AlmaVoiceEngine
    let reopen: () -> Void
    let end: () -> Void

    private var statusColor: Color {
        switch engine.callConnection {
        case .live: return Color(red: 0.231, green: 0.878, blue: 0.561)
        case .connecting, .reconnecting: return Color(red: 0.886, green: 0.702, blue: 0.400)
        case .failed: return Color(red: 0.949, green: 0.494, blue: 0.494)
        case .idle: return .secondary
        }
    }

    var body: some View {
        HStack(spacing: 11) {
            Button(action: reopen) {
                HStack(spacing: 11) {
                    ZStack {
                        Circle().fill(statusColor.opacity(0.15)).frame(width: 38, height: 38)
                        AlmaCallMiniWave(engine: engine)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text("ALMA AI Call")
                            .font(.system(size: 13.5, weight: .semibold))
                            .foregroundStyle(Color(red: 0.918, green: 0.949, blue: 0.984))
                        TimelineView(.periodic(from: .now, by: 0.5)) { context in
                            let agentTalking = engine.state == .speaking || engine.ttsLevel > 0.03
                            let ownerTalking = !agentTalking && engine.micLevel > 0.10
                            Text(agentTalking ? "ALMA বলছে…"
                                 : ownerTalking ? "আপনি বলছেন…"
                                 : "\(engine.transportBadgeText)  ·  \(engine.callElapsedText(at: context.date))")
                                .font(.system(size: 11.5, design: .monospaced))
                                .foregroundStyle(agentTalking
                                    ? Color(red: 0.231, green: 0.878, blue: 0.561)
                                    : ownerTalking
                                        ? Color(red: 0.878, green: 0.478, blue: 0.373)
                                        : Color(red: 0.486, green: 0.573, blue: 0.663))
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            Button(action: end) {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(Color(red: 0.91, green: 0.20, blue: 0.24), in: Circle())
            }
            .accessibilityLabel("কল শেষ করুন")
        }
        .padding(.leading, 10).padding(.trailing, 8).padding(.vertical, 7)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 16, y: 8)
        .padding(.horizontal, 14)
        .padding(.top, 6)
    }
}

// MARK: - Feed card (web .card): glass, icon box, status pill, big number +
// sparkline, approve/ask buttons, pop entrance + v2 border-sweep.

@available(iOS 17.0, *)
struct AlmaFeedCard: View {
    let card: AlmaVoiceEngine.Card
    let engine: AlmaVoiceEngine
    let hue: Double
    @State private var appeared = false

    private let ink   = Color(red: 0.918, green: 0.949, blue: 0.984)
    private let muted = Color(red: 0.486, green: 0.573, blue: 0.663)
    private let faint = Color(red: 0.333, green: 0.439, blue: 0.549)
    private let gold  = Color(red: 0.886, green: 0.702, blue: 0.400)
    private let line  = Color(red: 0.627, green: 0.784, blue: 0.941).opacity(0.13)
    private let good  = Color(red: 0.231, green: 0.878, blue: 0.561)
    private let glass = Color(red: 0.549, green: 0.745, blue: 0.941)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text(card.icon).font(.system(size: 15))
                    .frame(width: 34, height: 34)
                    .background(glass.opacity(0.07), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(line, lineWidth: 1))
                VStack(alignment: .leading, spacing: 1) {
                    Text(card.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(ink).lineLimit(2)
                    if !card.sub.isEmpty {
                        Text(card.sub).font(.system(size: 11.5)).foregroundStyle(faint).lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                statusPill
            }
            if !card.big.isEmpty {
                HStack(alignment: .center, spacing: 14) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(card.big)
                            .font(.system(size: 26, weight: .bold)).monospacedDigit()
                            .foregroundStyle(ink)
                        if !card.delta.isEmpty {
                            Text(card.delta).font(.system(size: 12.5)).foregroundStyle(good)
                        }
                    }
                    Spacer(minLength: 0)
                    if card.spark.count > 1 { sparkline }
                }
            }
            if card.kind == .ask && card.status == "wait" {
                HStack(spacing: 6) {
                    ForEach(card.options.prefix(4), id: \.self) { opt in
                        Button { engine.answer(card, option: opt) } label: {
                            Text(opt).font(.system(size: 12, weight: .medium))
                                .foregroundStyle(muted)
                                .padding(.horizontal, 11).padding(.vertical, 5)
                                .background(glass.opacity(0.07), in: Capsule())
                                .overlay(Capsule().strokeBorder(line, lineWidth: 1))
                        }
                    }
                }
            }
            if card.kind == .approval && card.status == "wait" {
                HStack(spacing: 8) {
                    pillButton("অনুমোদন দিন", solid: true) { engine.approve(card, yes: true) }
                    pillButton("বাতিল", solid: false) { engine.approve(card, yes: false) }
                }
            }
            if card.kind == .modelSwitch && card.status == "wait" {
                HStack(spacing: 8) {
                    pillButton("অনুমতি দিন", solid: true) { engine.resolveModelSwitch(card, approve: true) }
                    pillButton("থাক", solid: false) { engine.resolveModelSwitch(card, approve: false) }
                }
            }
        }
        .padding(.horizontal, 17).padding(.vertical, 15)
        .background(
            LinearGradient(colors: [glass.opacity(0.085), glass.opacity(0.028)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
            .strokeBorder(card.kind == .approval || card.kind == .modelSwitch
                          ? gold.opacity(0.35) : line, lineWidth: 1))
        // v2 border-sweep: a conic light runs the border once when the card pops
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(
                    AngularGradient(stops: [
                        .init(color: .clear, location: 0.08),
                        .init(color: almaHSL(hue, 0.85, 0.68, 0.65), location: 0.22),
                        .init(color: .clear, location: 0.42),
                        .init(color: .clear, location: 0.58),
                        .init(color: almaHSL(hue, 0.85, 0.68, 0.30), location: 0.74),
                        .init(color: .clear, location: 0.90),
                    ], center: .center, angle: .degrees(210)),
                    lineWidth: 1)
                .opacity(appeared ? 0 : 1)
        )
        .shadow(color: .black.opacity(0.45), radius: 14, y: 7)
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 16)
        .scaleEffect(appeared ? 1 : 0.965)
        .onAppear {
            withAnimation(.spring(duration: 0.55)) { appeared = true }
        }
    }

    private var statusPill: some View {
        let (label, color): (String, Color) = {
            switch card.status {
            case "run":  return ("চলছে", Color(red: 0.957, green: 0.784, blue: 0.416))   // #F4C86A
            case "wait": return ("অপেক্ষায়", Color(red: 0.435, green: 0.698, blue: 1.0)) // #6FB2FF
            case "ok":   return ("সম্পন্ন", good)
            case "fail": return ("ব্যর্থ", Color(red: 0.949, green: 0.494, blue: 0.494))
            default:     return (card.status, good)
            }
        }()
        return Text(label)
            .font(.system(size: 11.5)).foregroundStyle(color)
            .padding(.horizontal, 11).padding(.vertical, 4)
            .background(color.opacity(0.08), in: Capsule())
            .overlay(Capsule().strokeBorder(color.opacity(0.35), lineWidth: 1))
    }

    private var sparkline: some View {
        Canvas { ctx, size in
            let pts = card.spark
            guard let maxV = pts.max(), maxV > 0, pts.count > 1 else { return }
            var p = Path()
            for (i, v) in pts.enumerated() {
                let x = CGFloat(i) / CGFloat(pts.count - 1) * (size.width - 8) + 4
                let y = size.height - 5 - CGFloat(v / maxV) * (size.height - 12)
                if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
            }
            ctx.stroke(p, with: .color(good.opacity(0.9)), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
            // soft fill under the line
            var fill = p
            fill.addLine(to: CGPoint(x: size.width - 4, y: size.height))
            fill.addLine(to: CGPoint(x: 4, y: size.height))
            fill.closeSubpath()
            ctx.fill(fill, with: .linearGradient(
                Gradient(colors: [good.opacity(0.22), .clear]),
                startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)))
        }
        .frame(width: 120, height: 38)
    }

    private func pillButton(_ text: String, solid: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text).font(.system(size: 12.5, weight: solid ? .semibold : .medium))
                .foregroundStyle(solid ? Color(red: 0.016, green: 0.063, blue: 0.094) : muted)
                .padding(.horizontal, 16).padding(.vertical, 7)
                .background(solid
                    ? AnyShapeStyle(LinearGradient(colors: [Color(red: 0.486, green: 0.890, blue: 0.784),
                                                            Color(red: 0.306, green: 0.639, blue: 1.0)],
                                                   startPoint: .topLeading, endPoint: .bottomTrailing))
                    : AnyShapeStyle(glass.opacity(0.07)),
                    in: Capsule())
                .overlay(solid ? nil : Capsule().strokeBorder(line, lineWidth: 1))
        }
    }
}

// MARK: - Starfield (v2): twinkling micro-stars + occasional comet, deterministic
// (no stored state — star fields derive from hash functions, comets from a 13s cycle).

@available(iOS 17.0, *)
struct AlmaStarfieldView: View {
    private func rnd(_ i: Int, _ k: Double) -> Double {
        let v = sin(Double(i) * 127.1 + k * 311.7) * 43758.5453
        return v - v.rounded(.down)
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            Canvas { ctx, size in
                let starColor = Color(red: 0.745, green: 0.863, blue: 0.980)
                let n = min(170, Int(size.width * size.height / 14000))
                for i in 0..<max(0, n) {
                    let x = rnd(i, 1) * size.width
                    let y = rnd(i, 2) * size.height
                    let r = 0.3 + 1.1 * rnd(i, 3)
                    let ph = rnd(i, 4) * 6.283
                    let sp = 0.4 + 1.4 * rnd(i, 5)
                    let tw = 0.35 + 0.65 * abs(sin(t * sp + ph))
                    let rr = r * (0.7 + 0.5 * tw)
                    ctx.fill(Path(ellipseIn: CGRect(x: x - rr, y: y - rr, width: rr * 2, height: rr * 2)),
                             with: .color(starColor.opacity(0.08 + 0.20 * tw)))
                }
                // comet: one every ~13s, 2.2s flight, path from the cycle hash
                let cycle = Int(t / 13)
                let ct = t - Double(cycle) * 13
                if ct < 2.2 {
                    let life = 1 - ct / 2.2
                    let x0 = size.width * (0.15 + 0.75 * rnd(cycle, 7))
                    let y0 = size.height * 0.30 * rnd(cycle, 8)
                    let vx = -(130 + 150 * rnd(cycle, 9))
                    let vy = 55 + 55 * rnd(cycle, 10)
                    let hx = x0 + vx * ct, hy = y0 + vy * ct
                    let tx = hx - vx * 0.35, ty = hy - vy * 0.35
                    var p = Path()
                    p.move(to: CGPoint(x: hx, y: hy))
                    p.addLine(to: CGPoint(x: tx, y: ty))
                    ctx.stroke(p, with: .linearGradient(
                        Gradient(colors: [Color(red: 0.843, green: 0.933, blue: 1.0).opacity(0.65 * life), .clear]),
                        startPoint: CGPoint(x: hx, y: hy), endPoint: CGPoint(x: tx, y: ty)),
                        style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                }
            }
        }
    }
}

// MARK: - The fluid orb — WebGL FRAG ported 1:1 to Metal + ring/motes/sats
//
// Proportions match the web exactly: the SPHERE is 62% of the component frame
// (Metal canvas = 124% of frame, shader R≈0.5), the 72-bar waveform ring's base
// radius is 45.6% of the frame (canvas 136%, base 0.335) — so the ring sits
// clearly OUTSIDE the orb with a visible gap. Idle bars read as a clean dotted
// ring; listening/speaking grow them into reactive bars (glow via shadow filter).
// Plus: breathing bloom, spinning conic accent ring, 5 orbiting energy motes,
// 3 thinking satellites, and the v2 floor reflection.

/// ChatGPT-voice-mode LIVING SCALE (owner video analysis 2026-07-31, frame
/// measurements): the reference orb keeps a PERFECT circular silhouette — its
/// life comes from the whole sphere breathing with the conversation. Baseline
/// while idle; it RECEDES ~10% while Boss speaks (attentive, trembling gently
/// with his real voice envelope) and SWELLS ~13% while the agent speaks
/// (pulsing with the real speech envelope). Reference-type scratchpad mutated
/// from the TimelineView tick — nothing here is observed state.
@available(iOS 17.0, *)
private final class AlmaOrbLife {
    var lastT: Double = 0
    var mic: Double = 0        // smoothed real mic envelope
    var tts: Double = 0        // smoothed real speech envelope
    var userP: Double = 0      // "Boss is talking" presence 0…1
    var agentP: Double = 0     // "agent is talking" presence 0…1

    func step(t: Double, state: AlmaVoiceState, micIn: Double, ttsIn: Double) {
        if lastT == 0 { lastT = t }
        let dt = min(0.1, max(0, t - lastT))
        lastT = t
        // Envelope followers — instant attack, musical release.
        mic += (micIn - mic) * min(1, dt * (micIn > mic ? 14 : 3.2))
        tts += (ttsIn - tts) * min(1, dt * (ttsIn > tts ? 16 : 2.8))
        // Presences ease in fast, linger briefly (no flicker between words).
        let userTarget: Double = (state == .listening && mic > 0.05) ? 1 : 0
        userP += (userTarget - userP) * min(1, dt * (userTarget > userP ? 5.0 : 1.4))
        let agentTarget: Double = state == .speaking ? 1 : 0
        agentP += (agentTarget - agentP) * min(1, dt * (agentTarget > agentP ? 5.0 : 1.6))
    }

    /// The living scale for the sphere cluster.
    var scale: Double {
        1 - userP * (0.10 - min(0.045, mic * 0.09))     // recede, tremble with Boss
        + agentP * (0.09 + min(0.07, tts * 0.11))       // swell, pulse with speech
    }
}

@available(iOS 17.0, *)
struct AlmaFluidOrbView: View {
    let state: AlmaVoiceState
    let micLevel: Double
    let ttsLevel: Double

    @State private var life = AlmaOrbLife()

    private var breathe: Double {
        switch state {
        case .idle: return 4.6
        case .error: return 1.2
        case .transcribing, .thinking: return 1.7
        case .listening, .speaking: return 2.8
        }
    }

    private func activity(t: Double, level: Double) -> Double {
        switch state {
        case .transcribing, .thinking: return 0.85
        case .listening: return 0.45 + level * 0.3
        case .speaking:
            let env = max(0, sin(t * 3.4)) * max(0, sin(t * 1.24 + 1.6))
            return 0.25 + max(env * 0.65, level * 0.5)
        case .error: return 0.32
        case .idle: return 0.12
        }
    }

    var body: some View {
        GeometryReader { geo in
            let side = min(geo.size.width, geo.size.height)
            let h = state.hue
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                let _ = life.step(t: t, state: state, micIn: micLevel, ttsIn: ttsLevel)
                let level = state == .speaking ? ttsLevel : micLevel
                let act = activity(t: t, level: level)
                let scale = (1 + 0.028 * (1 - cos(2 * .pi * t / breathe))) * life.scale
                ZStack {
                    // breathing bloom (web .orb-bloom)
                    Circle()
                        .fill(RadialGradient(colors: [almaHSL(h, 0.90, 0.60, 0.34),
                                                      almaHSL(h, 0.90, 0.50, 0.10), .clear],
                                             center: .init(x: 0.5, y: 0.45),
                                             startRadius: 0, endRadius: side * 0.85))
                        .frame(width: side * 1.5, height: side * 1.5)
                        .blur(radius: 18)
                        .scaleEffect(scale)

                    // v2 floor reflection (web .orb-reflection)
                    Ellipse()
                        .fill(RadialGradient(colors: [almaHSL(h, 0.90, 0.60, 0.20), .clear],
                                             center: .init(x: 0.5, y: 0.1),
                                             startRadius: 0, endRadius: side * 0.38))
                        .frame(width: side * 0.76, height: side * 0.15)
                        .blur(radius: 10)
                        .offset(y: side * 0.60)

                    // spinning conic accent ring (web .orb-ring, 14s)
                    Circle()
                        .stroke(AngularGradient(stops: [
                            .init(color: .clear, location: 0),
                            .init(color: almaHSL(h, 0.90, 0.70, 0.55), location: 80.0 / 360),
                            .init(color: .clear, location: 160.0 / 360),
                            .init(color: .clear, location: 200.0 / 360),
                            .init(color: almaHSL(h, 0.90, 0.70, 0.28), location: 290.0 / 360),
                            .init(color: .clear, location: 1),
                        ], center: .center), lineWidth: 1)
                        .frame(width: side * 0.92, height: side * 0.92)
                        .rotationEffect(.degrees(t.truncatingRemainder(dividingBy: 14) / 14 * 360))

                    // 72-bar reactive waveform ring + 5 energy motes (one canvas)
                    Canvas { ctx, size in
                        let cx = size.width / 2, cy = size.height / 2
                        let base = size.width * 0.335
                        let barsVisible = state == .idle || state == .listening || state == .speaking
                        if barsVisible {
                            ctx.drawLayer { layer in
                                layer.addFilter(.shadow(color: almaHSL(h, 0.90, 0.65, 0.55), radius: 5))
                                for i in 0..<72 {
                                    let a = Double(i) / 72 * 2 * .pi - .pi / 2
                                    var amp = 1.5
                                    switch state {
                                    case .listening:
                                        amp = 3 + abs(sin(t * 2.1 + Double(i) * 0.7)) * 9
                                            + Double.random(in: 0...7) + level * 10
                                    case .speaking:
                                        let env = max(0, sin(t * 3.4)) * max(0, sin(t * 1.24 + 1.6))
                                        amp = 2 + max(env, level) * (7 + abs(sin(Double(i) * 1.3 + t * 5)) * 13)
                                    default:
                                        amp = 1.2 + sin(t * 0.9 + Double(i) * 0.35) * 0.8
                                    }
                                    let r1 = base, r2 = base + amp
                                    var p = Path()
                                    p.move(to: CGPoint(x: cx + cos(a) * r1, y: cy + sin(a) * r1))
                                    p.addLine(to: CGPoint(x: cx + cos(a) * r2, y: cy + sin(a) * r2))
                                    layer.stroke(p, with: .color(almaHSL(h, 0.90, 0.68, 0.22 + amp / 40)),
                                                 style: StrokeStyle(lineWidth: 2.2, lineCap: .round))
                                }
                            }
                        }
                        // v2 energy motes
                        ctx.drawLayer { layer in
                            layer.addFilter(.shadow(color: almaHSL(h, 0.95, 0.72, 0.8), radius: 9))
                            for mi in 0..<5 {
                                let ma = t * (0.22 + Double(mi) * 0.06) + Double(mi) * 2.51
                                let mr = base * (1.16 + 0.09 * sin(t * 0.7 + Double(mi) * 1.7))
                                let ms = 1.3 + act * 1.9
                                let mx = cx + cos(ma) * mr, my = cy + sin(ma) * mr
                                layer.fill(Path(ellipseIn: CGRect(x: mx - ms, y: my - ms, width: ms * 2, height: ms * 2)),
                                           with: .color(almaHSL(h, 0.95, 0.80, 0.22 + act * 0.38)))
                            }
                        }
                    }
                    .frame(width: side * 1.36, height: side * 1.36)

                    // THE ORB — Metal port of the exact WebGL fluid shader;
                    // SwiftUI-gradient fallback if Metal is unavailable.
                    if AlmaOrbRenderer.shared != nil {
                        AlmaMetalOrbView(hue: h, stateKey: state.rawValue, level: level)
                            .frame(width: side * 1.24, height: side * 1.24)
                            // The living conversation scale (video-matched):
                            // recede while Boss talks, swell while ALMA talks.
                            .scaleEffect(life.scale)
                            .allowsHitTesting(false)
                    } else {
                        fallbackSphere(side: side, h: h, t: t)
                            .frame(width: side * 0.62, height: side * 0.62)
                            .clipShape(Circle())
                            .shadow(color: almaHSL(h, 0.90, 0.45, 0.35), radius: 30, y: 18)
                            .scaleEffect(scale)
                    }

                    // thinking satellites (web .sats, 3.6s spin)
                    ZStack {
                        satDot(h).offset(y: -side * 0.58)
                        satDot(h).offset(x: -side * 0.44, y: side * 0.40)
                        satDot(h).offset(x: side * 0.44, y: side * 0.40)
                    }
                    .rotationEffect(.degrees(t.truncatingRemainder(dividingBy: 3.6) / 3.6 * 360))
                    .opacity(state == .thinking || state == .transcribing ? 1 : 0)
                }
                .frame(width: geo.size.width, height: geo.size.height)
                .animation(.easeInOut(duration: 0.5), value: h)
            }
        }
    }

    private func satDot(_ h: Double) -> some View {
        Circle()
            .fill(almaHSL(h, 0.95, 0.78))
            .frame(width: 7, height: 7)
            .shadow(color: almaHSL(h, 0.95, 0.70), radius: 6)
    }

    /// Non-Metal fallback: the previous multi-layer gradient approximation,
    /// sized to the correct 62% sphere proportion.
    @ViewBuilder private func fallbackSphere(side: CGFloat, h: Double, t: Double) -> some View {
        let d = side * 0.62
        ZStack {
            Circle().fill(RadialGradient(stops: [
                .init(color: almaHSL(h, 0.95, 0.88), location: 0),
                .init(color: almaHSL(h, 0.92, 0.60), location: 0.42),
                .init(color: almaHSL(h, 0.88, 0.40), location: 0.74),
                .init(color: almaHSL(h + 18, 0.80, 0.16), location: 1),
            ], center: .init(x: 0.36, y: 0.28), startRadius: 0, endRadius: d * 0.6))
            Circle()
                .fill(AngularGradient(colors: [
                    almaHSL(h, 0.88, 0.62), almaHSL(h + 40, 0.85, 0.50),
                    almaHSL(h - 30, 0.90, 0.66), almaHSL(h, 0.88, 0.62),
                ], center: .center, angle: .degrees(t / 10 * 360)))
                .frame(width: d * 1.2, height: d * 1.2)
                .blur(radius: 14).blendMode(.screen)
                .opacity(0.42)
            Circle()
                .fill(RadialGradient(colors: [almaHSL(h, 1.0, 0.92, 0.9),
                                              almaHSL(h, 0.95, 0.70, 0.25), .clear],
                                     center: .center, startRadius: 0, endRadius: d * 0.16))
                .frame(width: d * 0.4, height: d * 0.4)
                .blur(radius: 3)
            Ellipse().fill(RadialGradient(colors: [.white.opacity(0.5), .clear],
                                          center: .center, startRadius: 0, endRadius: d * 0.16))
                .frame(width: d * 0.28, height: d * 0.18)
                .offset(x: -d * 0.10, y: -d * 0.16)
                .blendMode(.screen)
            Circle().fill(RadialGradient(stops: [
                .init(color: .clear, location: 0.66),
                .init(color: almaHSL(h + 18, 0.90, 0.72, 0.35), location: 0.86),
                .init(color: almaHSL(h + 18, 0.90, 0.80, 0.55), location: 0.94),
                .init(color: .clear, location: 1),
            ], center: .center, startRadius: 0, endRadius: d * 0.5))
                .blendMode(.screen)
        }
    }
}

// MARK: - Metal orb: the DESIGN-REFERENCE WebGL fragment shader, 1:1 in MSL,
// runtime-compiled (no .metal file → no pbxproj registration needed).

struct AlmaOrbUniforms {
    var resX: Float
    var resY: Float
    var time: Float
    var hue: Float
    var amp: Float
}

final class AlmaOrbRenderer {
    static let shared: AlmaOrbRenderer? = AlmaOrbRenderer()

    let device: MTLDevice
    let queue: MTLCommandQueue
    let pipeline: MTLRenderPipelineState

    private init?() {
        guard let dev = MTLCreateSystemDefaultDevice(), let q = dev.makeCommandQueue() else { return nil }
        device = dev
        queue = q
        do {
            let lib = try dev.makeLibrary(source: AlmaOrbRenderer.msl, options: nil)
            guard let vfn = lib.makeFunction(name: "almaOrbVertex"),
                  let ffn = lib.makeFunction(name: "almaOrbFragment") else { return nil }
            let pd = MTLRenderPipelineDescriptor()
            pd.vertexFunction = vfn
            pd.fragmentFunction = ffn
            pd.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipeline = try dev.makeRenderPipelineState(descriptor: pd)
        } catch {
            return nil
        }
    }

    /// The exact FRAG from DESIGN-REFERENCE.html translated GLSL→MSL (incl. the
    /// two v2 additions: second rim light + iridescent shimmer). GLSL mod() is
    /// euclidean, MSL fmod() is not — hsl2rgb uses x-6·floor(x/6) instead.
    static let msl = """
    #include <metal_stdlib>
    using namespace metal;

    struct AlmaU { float resX; float resY; float time; float hue; float amp; };

    static float ahash(float2 p) {
        p = fract(p * float2(123.34, 345.45));
        p += dot(p, p + 34.345);
        return fract(p.x * p.y);
    }
    static float anoise(float2 p) {
        float2 i = floor(p), f = fract(p);
        float2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(ahash(i), ahash(i + float2(1.0, 0.0)), u.x),
                   mix(ahash(i + float2(0.0, 1.0)), ahash(i + float2(1.0, 1.0)), u.x), u.y);
    }
    static float afbm(float2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { v += a * anoise(p); p = p * 2.03 + float2(7.3, 3.1); a *= 0.5; }
        return v;
    }
    static float3 ahsl(float h, float s, float l) {
        float3 k = h / 60.0 + float3(0.0, 4.0, 2.0);
        k = k - 6.0 * floor(k / 6.0);
        float3 rgb = clamp(fabs(k - 3.0) - 1.0, 0.0, 1.0);
        float c = (1.0 - fabs(2.0 * l - 1.0)) * s;
        return (rgb - 0.5) * c + l;
    }

    vertex float4 almaOrbVertex(uint vid [[vertex_id]]) {
        float2 pos[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
        return float4(pos[vid], 0.0, 1.0);
    }

    fragment float4 almaOrbFragment(float4 fragPos [[position]], constant AlmaU& u [[buffer(0)]]) {
        float2 res = float2(u.resX, u.resY);
        float2 fc = float2(fragPos.x, u.resY - fragPos.y);   // GL is y-up
        float2 p = (fc * 2.0 - res) / min(res.x, res.y);
        float t = u.time;
        float breath = sin(t * 1.37) * 0.5 + 0.5;
        float R = 0.50 + 0.016 * breath + 0.05 * u.amp;
        float r = length(p);
        float ang = t * 0.10;
        float2x2 rot = float2x2(float2(cos(ang), -sin(ang)), float2(sin(ang), cos(ang)));
        float2 q = rot * p;
        float spd = 0.16 + u.amp * 0.6;
        float2 w = q * 1.9;
        float n1 = afbm(w + float2(t * spd, -t * spd * 0.7));
        float n2 = afbm(w * 1.6 + 4.0 * float2(n1, n1 * 0.7) + float2(-t * spd * 0.8, t * spd * 0.5));
        float3 c1 = ahsl(u.hue,        0.88, 0.55);
        float3 c2 = ahsl(u.hue + 46.0, 0.85, 0.46);
        float3 c3 = ahsl(u.hue - 38.0, 0.90, 0.62);
        float3 col = mix(c1, c2, smoothstep(0.25, 0.75, n1));
        col = mix(col, c3, smoothstep(0.42, 0.9, n2) * 0.6);
        float nz = sqrt(max(0.0, 1.0 - (r * r) / (R * R)));
        col *= 0.26 + 0.72 * nz;
        col *= 1.0 - 0.30 * smoothstep(0.0, 1.0, (-p.y / R) * 0.5 + 0.5) * (1.0 - nz * 0.6);
        float core = exp(-r * r * 6.0);
        col += ahsl(u.hue, 0.55, 0.85) * core * (0.10 + 0.28 * u.amp * (0.55 + 0.45 * sin(t * 8.0)));
        float fres = pow(1.0 - nz, 2.6);
        col += ahsl(u.hue + 18.0, 0.9, 0.68) * fres * 0.85;
        col += ahsl(u.hue - 42.0, 0.85, 0.58) * pow(1.0 - nz, 4.2) * 0.4;
        col += 0.05 * float3(sin(n2 * 14.0 + t * 0.5), sin(n2 * 14.0 + 2.1 + t * 0.5), sin(n2 * 14.0 + 4.2 + t * 0.5)) * nz;
        float2 hp = p - float2(-0.42, 0.46) * R;
        col += float3(1.0) * exp(-dot(hp, hp) * 52.0) * 0.5;
        float inside = smoothstep(R, R - 0.012, r);
        float halo = exp(-max(r - R, 0.0) * 6.5);
        float3 haloCol = ahsl(u.hue, 0.9, 0.60) * halo * (0.30 + 0.35 * u.amp);
        float3 outCol = col * inside + haloCol * (1.0 - inside);
        float alpha = max(inside, halo * (0.5 + 0.3 * u.amp) * (1.0 - inside));
        return float4(outCol * alpha, alpha);   // premultiplied for CA compositing
    }
    """
}

struct AlmaMetalOrbView: UIViewRepresentable {
    var hue: Double
    var stateKey: String
    var level: Double

    func makeCoordinator() -> Coord { Coord() }

    func makeUIView(context: Context) -> MTKView {
        let v = MTKView(frame: .zero, device: AlmaOrbRenderer.shared?.device)
        v.delegate = context.coordinator
        v.preferredFramesPerSecond = 30
        v.isOpaque = false
        v.backgroundColor = .clear
        v.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        v.isUserInteractionEnabled = false
        context.coordinator.apply(hue: hue, state: stateKey, level: level)
        return v
    }

    func updateUIView(_ v: MTKView, context: Context) {
        context.coordinator.apply(hue: hue, state: stateKey, level: level)
    }

    final class Coord: NSObject, MTKViewDelegate {
        private let start = CACurrentMediaTime()
        private var last = CACurrentMediaTime()
        private var hue: Float = 168
        private var hueTarget: Float = 168
        private var amp: Float = 0.12
        private var state = "idle"
        private var level: Float = 0

        func apply(hue: Double, state: String, level: Double) {
            hueTarget = Float(hue)
            self.state = state
            self.level = Float(level)
        }

        func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

        func draw(in view: MTKView) {
            guard let r = AlmaOrbRenderer.shared,
                  let drawable = view.currentDrawable,
                  let rpd = view.currentRenderPassDescriptor,
                  let cb = r.queue.makeCommandBuffer(),
                  let enc = cb.makeRenderCommandEncoder(descriptor: rpd) else { return }
            let now = CACurrentMediaTime()
            let dt = Float(min(0.05, now - last))
            last = now
            let t = Float(now - start)
            // web frame(): hue eases at 4.2/s, activity at 5.5/s
            hue += (hueTarget - hue) * min(1, dt * 4.2)
            let env = max(0, sin(t * 3.4)) * max(0, sin(t * 1.24 + 1.6))
            let target: Float
            switch state {
            case "thinking", "transcribing": target = 0.85
            case "listening": target = 0.45 + level * 0.3
            case "speaking": target = 0.25 + max(env * 0.65, level * 0.5)
            case "error": target = 0.32
            default: target = 0.12
            }
            amp += (target - amp) * min(1, dt * 5.5)
            var u = AlmaOrbUniforms(resX: Float(view.drawableSize.width),
                                    resY: Float(view.drawableSize.height),
                                    time: t, hue: hue, amp: amp)
            enc.setRenderPipelineState(r.pipeline)
            enc.setFragmentBytes(&u, length: MemoryLayout<AlmaOrbUniforms>.stride, index: 0)
            enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            enc.endEncoding()
            cb.present(drawable)
            cb.commit()
        }
    }
}


// MARK: - Deterministic pre-TTS Bangla normalizer (inlined; Swift port of src/agent/lib/tts-normalize.ts)

// Complete 0-99 Bangla word table. This is the load-bearing part — the bn
// number words are irregular and must be exact.
private let almaONES: [String] = [
    "শূন্য",
    "এক",
    "দুই",
    "তিন",
    "চার",
    "পাঁচ",
    "ছয়",
    "সাত",
    "আট",
    "নয়",
    "দশ",
    "এগারো",
    "বারো",
    "তেরো",
    "চৌদ্দ",
    "পনেরো",
    "ষোলো",
    "সতেরো",
    "আঠারো",
    "ঊনিশ",
    "বিশ",
    "একুশ",
    "বাইশ",
    "তেইশ",
    "চব্বিশ",
    "পঁচিশ",
    "ছাব্বিশ",
    "সাতাশ",
    "আটাশ",
    "ঊনত্রিশ",
    "ত্রিশ",
    "একত্রিশ",
    "বত্রিশ",
    "তেত্রিশ",
    "চৌত্রিশ",
    "পঁয়ত্রিশ",
    "ছত্রিশ",
    "সাঁইত্রিশ",
    "আটত্রিশ",
    "ঊনচল্লিশ",
    "চল্লিশ",
    "একচল্লিশ",
    "বিয়াল্লিশ",
    "তেতাল্লিশ",
    "চুয়াল্লিশ",
    "পঁয়তাল্লিশ",
    "ছেচল্লিশ",
    "সাতচল্লিশ",
    "আটচল্লিশ",
    "ঊনপঞ্চাশ",
    "পঞ্চাশ",
    "একান্ন",
    "বাহান্ন",
    "তেপ্পান্ন",
    "চুয়ান্ন",
    "পঞ্চান্ন",
    "ছাপ্পান্ন",
    "সাতান্ন",
    "আটান্ন",
    "ঊনষাট",
    "ষাট",
    "একষট্টি",
    "বাষট্টি",
    "তেষট্টি",
    "চৌষট্টি",
    "পঁয়ষট্টি",
    "ছেষট্টি",
    "সাতষট্টি",
    "আটষট্টি",
    "ঊনসত্তর",
    "সত্তর",
    "একাত্তর",
    "বাহাত্তর",
    "তিয়াত্তর",
    "চুয়াত্তর",
    "পঁচাত্তর",
    "ছিয়াত্তর",
    "সাতাত্তর",
    "আটাত্তর",
    "ঊনআশি",
    "আশি",
    "একাশি",
    "বিরাশি",
    "তিরাশি",
    "চুরাশি",
    "পঁচাশি",
    "ছিয়াশি",
    "সাতাশি",
    "আটাশি",
    "ঊননব্বই",
    "নব্বই",
    "একানব্বই",
    "বিরানব্বই",
    "তিরানব্বই",
    "চুরানব্বই",
    "পঁচানব্বই",
    "ছিয়ানব্বই",
    "সাতানব্বই",
    "আটানব্বই",
    "নিরানব্বই",
]

private let almaBANGLA_DIGITS: [Character] = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"]

// Map a single digit char (ASCII or Bangla) to its Bangla word, else nil.
private func almaDigitWord(_ ch: Character) -> String? {
    if ch >= "0" && ch <= "9" {
        guard let ascii = ch.asciiValue else { return nil }
        let idx = Int(ascii) - 48
        if idx >= 0 && idx < almaONES.count { return almaONES[idx] }
        return nil
    }
    if let idx = almaBANGLA_DIGITS.firstIndex(of: ch), idx >= 0, idx < almaONES.count {
        return almaONES[idx]
    }
    return nil
}

// Convert a string of digits to their Bangla words, space-separated.
// Handles both ASCII and Bangla numerals.
private func almaDigitsToWords(_ digits: String) -> String {
    var out: [String] = []
    for ch in digits {
        if let w = almaDigitWord(ch) {
            out.append(w)
        }
    }
    return out.joined(separator: " ")
}

// Read a 1-3 digit group (0-999) into Bangla words. Used as the building block
// for the lakh/crore grouping. 0 within a larger number contributes nothing.
private func almaBelowThousand(_ n: Int) -> String {
    var parts: [String] = []
    let hundreds = n / 100
    let rest = n % 100
    if hundreds > 0, hundreds < almaONES.count { parts.append(almaONES[hundreds] + "শো") }
    if rest > 0, rest < almaONES.count { parts.append(almaONES[rest]) }
    return parts.joined(separator: " ")
}

// Convert a non-negative integer 0 → 99,99,99,999 into Bangla words using the
// lakh/crore system. Callers guarantee the range; out-of-range values fall back
// to digit-by-digit reading.
private func almaNonNegativeToBanglaWords(_ n: Int) -> String {
    if n == 0 { return almaONES[0] }

    let crore = n / 10000000
    let lakh = (n % 10000000) / 100000
    let thousand = (n % 100000) / 1000
    let rest = n % 1000

    var parts: [String] = []
    if crore > 0 { parts.append(almaBelowThousand(crore) + " কোটি") }
    if lakh > 0, lakh < almaONES.count { parts.append(almaONES[lakh] + " লাখ") }
    if thousand > 0, thousand < almaONES.count { parts.append(almaONES[thousand] + " হাজার") }
    if rest > 0 { parts.append(almaBelowThousand(rest)) }
    return parts.joined(separator: " ")
}

// Public: convert an integer to Bangla words.
//  - Negatives are prefixed with "মাইনাস ".
//  - Non-integers read the integer part in words, then "দশমিক", then up to two
//    decimal digits read digit-by-digit.
//  - Integers of 10 digits or more are read digit-by-digit.
func numberToBanglaWords(_ n: Double) -> String {
    if !n.isFinite { return almaStringifyNumber(n) }

    let negative = n < 0
    let absVal = n < 0 ? -n : n

    let intPart = absVal.rounded(.down)
    let isDecimal = absVal != intPart

    var intWords: String
    if intPart >= 1000000000 {
        // 10+ digits: outside lakh/crore range, read digit-by-digit.
        intWords = almaDigitsToWords(almaIntString(intPart))
    } else {
        intWords = almaNonNegativeToBanglaWords(Int(intPart))
    }

    var result = intWords
    if isDecimal {
        // Up to two decimal places, digit-by-digit after "দশমিক".
        // Mirror TS: abs.toFixed(2).split('.')[1].replace(/0+$/,'') || '0'
        let fixed = String(format: "%.2f", absVal)
        var decStr = "0"
        if let dotIdx = fixed.firstIndex(of: ".") {
            let after = String(fixed[fixed.index(after: dotIdx)...])
            var trimmed = after
            while trimmed.hasSuffix("0") { trimmed.removeLast() }
            decStr = trimmed.isEmpty ? "0" : trimmed
        }
        result = intWords + " দশমিক " + almaDigitsToWords(decStr)
    }

    return negative ? "মাইনাস " + result : result
}

// Integer-friendly overload so tests can call numberToBanglaWords(21).
func numberToBanglaWords(_ n: Int) -> String {
    return numberToBanglaWords(Double(n))
}

// Render the integer part of a Double as a plain digit string (no exponent,
// no separators). Used only for the digit-by-digit 10+ digit path.
private func almaIntString(_ d: Double) -> String {
    let s = String(format: "%.0f", d)
    return s
}

// Fallback stringification matching JS String(n) closely enough for the
// non-finite / edge cases (only ever hit on NaN / Infinity here).
private func almaStringifyNumber(_ n: Double) -> String {
    if n.isNaN { return "NaN" }
    if n == Double.infinity { return "Infinity" }
    if n == -Double.infinity { return "-Infinity" }
    if n == n.rounded() { return String(format: "%.0f", n) }
    return String(n)
}

// ---------------------------------------------------------------------------
// normalizeForTts
// ---------------------------------------------------------------------------

// Known-term phonetic map. Longer/more-specific keys first so ".com" and
// "almatraders" win before generic tokens. Matched case-insensitively at word
// boundaries (see buildTermRegex).
private let almaTERM_MAP: [(String, String)] = [
    ("almatraders", "আলমাট্রেডার্স"),
    (".com", " ডট কম"),
    ("WhatsApp", "হোয়াটসঅ্যাপ"),
    ("Facebook", "ফেসবুক"),
    ("Telegram", "টেলিগ্রাম"),
    ("Instagram", "ইনস্টাগ্রাম"),
    ("Google", "গুগল"),
    ("iPhone", "আইফোন"),
    ("Android", "অ্যান্ড্রয়েড"),
    ("crypto", "ক্রিপ্টো"),
    ("Vercel", "ভার্সেল"),
    ("Okay", "ওকে"),
    ("ALMA", "আলমা"),
    ("SUI", "সুই"),
    ("BTC", "বিটিসি"),
    ("ETH", "ইথেরিয়াম"),
    ("OK", "ওকে"),
    ("Sir", "Boss"),
    ("স্যার", "Boss"),
    ("বস", "Boss"),
    ("AI", "এআই"),
    ("API", "এপিআই"),
    ("URL", "ইউআরএল"),
    ("TTS", "টিটিএস"),
]

// Escape a literal string for use inside an NSRegularExpression pattern.
private func almaEscapeRegex(_ s: String) -> String {
    return NSRegularExpression.escapedPattern(for: s)
}

// Build a case-insensitive matcher for a term. ".com" is a suffix-style token
// (no leading boundary, matches when attached to a word); all others are
// bounded by non-letter/digit edges so "AI" doesn't fire inside "email".
private func almaBuildTermRegex(_ term: String) -> NSRegularExpression? {
    let pattern: String
    if term.hasPrefix(".") {
        pattern = almaEscapeRegex(term)
    } else {
        pattern = "(?<![A-Za-z0-9])" + almaEscapeRegex(term) + "(?![A-Za-z0-9])"
    }
    return try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
}

// Parse a numeric literal (ASCII digits, optional commas, optional decimal)
// into a Double. Returns nil if not parseable.
private func almaParseNumericLiteral(_ raw: String) -> Double? {
    let cleaned = raw.replacingOccurrences(of: ",", with: "")
    guard almaMatchesFull(cleaned, pattern: "^\\d+(\\.\\d+)?$") else { return nil }
    guard let v = Double(cleaned), v.isFinite else { return nil }
    return v
}

// Whole-string regex match helper.
private func almaMatchesFull(_ s: String, pattern: String) -> Bool {
    guard let re = try? NSRegularExpression(pattern: pattern, options: []) else { return false }
    let range = NSRange(s.startIndex..., in: s)
    return re.firstMatch(in: s, options: [], range: range) != nil
}

// Render a numeric literal to spoken Bangla. Integers with 10+ digits (or with
// grouping that yields a huge value) fall to digit-by-digit reading per spec.
private func almaSpeakNumericLiteral(_ raw: String) -> String {
    let cleaned = raw.replacingOccurrences(of: ",", with: "")
    guard let num = almaParseNumericLiteral(raw) else { return raw }

    let isInt = !cleaned.contains(".")
    // Standalone integers of more than 9 digits: digit-by-digit.
    if isInt {
        var stripped = cleaned
        if stripped.hasPrefix("-") { stripped.removeFirst() }
        if stripped.count > 9 {
            return almaDigitsToWords(cleaned)
        }
    }
    return numberToBanglaWords(num)
}

// Core regex-replace helper: applies `transform` to each match of `pattern`,
// rebuilding the string safely for multibyte Bangla. On any failure returns the
// input string unchanged.
private func almaReplace(
    _ input: String,
    pattern: String,
    options: NSRegularExpression.Options = [],
    transform: ([String]) -> String
) -> String {
    guard let re = try? NSRegularExpression(pattern: pattern, options: options) else {
        return input
    }
    let ns = input as NSString
    let fullRange = NSRange(location: 0, length: ns.length)
    let matches = re.matches(in: input, options: [], range: fullRange)
    if matches.isEmpty { return input }

    var result = ""
    var lastEnd = 0
    for m in matches {
        let mRange = m.range
        if mRange.location == NSNotFound { continue }
        // Text between previous match end and this match.
        if mRange.location > lastEnd {
            result += ns.substring(with: NSRange(location: lastEnd, length: mRange.location - lastEnd))
        }
        // Collect capture groups (index 0 = whole match).
        var groups: [String] = []
        for gi in 0..<m.numberOfRanges {
            let gr = m.range(at: gi)
            if gr.location == NSNotFound {
                groups.append("")
            } else {
                groups.append(ns.substring(with: gr))
            }
        }
        result += transform(groups)
        lastEnd = mRange.location + mRange.length
    }
    // Trailing text after the last match.
    if lastEnd < ns.length {
        result += ns.substring(with: NSRange(location: lastEnd, length: ns.length - lastEnd))
    }
    return result
}

// Public entry point. Renamed from TS normalizeForTts.
func almaNormalizeForTTS(_ input: String) -> String {
    let text = input
    if text.isEmpty { return text }

    var out = text

    // Boss rule: TTS must never speak emoji descriptions — drop all emoji scalars.
    out = String(out.unicodeScalars.filter { sc in
        !(sc.properties.isEmojiPresentation
          || (sc.properties.isEmoji && sc.value > 0x238C)
          || sc.value == 0xFE0F || sc.value == 0x200D)
    })

    // (a) Currency.
    // Taka symbol prefix: ৳1,250 / ৳1250
    out = almaReplace(out, pattern: "৳\\s*([\\d,]+(?:\\.\\d+)?)") { g in
        let num = g.count > 1 ? g[1] : ""
        return almaSpeakNumericLiteral(num) + " টাকা"
    }
    // Trailing "টাকা": 1250 টাকা -> এক হাজার দুইশো পঞ্চাশ টাকা (avoid double word)
    out = almaReplace(out, pattern: "([\\d,]+(?:\\.\\d+)?)\\s*টাকা") { g in
        let num = g.count > 1 ? g[1] : ""
        return almaSpeakNumericLiteral(num) + " টাকা"
    }
    // Dollar prefix: $3.42 -> তিন দশমিক চার দুই ডলার
    out = almaReplace(out, pattern: "\\$\\s*([\\d,]+(?:\\.\\d+)?)") { g in
        let num = g.count > 1 ? g[1] : ""
        return almaSpeakNumericLiteral(num) + " ডলার"
    }

    // (b) Percentages: 4.2% -> চার দশমিক দুই শতাংশ
    out = almaReplace(out, pattern: "([\\d,]+(?:\\.\\d+)?)\\s*%") { g in
        let num = g.count > 1 ? g[1] : ""
        return almaSpeakNumericLiteral(num) + " শতাংশ"
    }

    // (e) Phone numbers BEFORE generic digit groups: +8801XXXXXXXXX / 01XXXXXXXXX
    out = almaReplace(out, pattern: "\\+8801\\d{9}\\b") { g in
        let m = g.count > 0 ? g[0] : ""
        return almaDigitsToWords(m.replacingOccurrences(of: "+", with: ""))
    }
    out = almaReplace(out, pattern: "(?<!\\d)01\\d{9}(?!\\d)") { g in
        let m = g.count > 0 ? g[0] : ""
        return almaDigitsToWords(m)
    }

    // (f) Time like 4:50 -> চারটা পঞ্চাশ
    out = almaReplace(out, pattern: "(?<!\\d)([0-2]?\\d):([0-5]\\d)(?!\\d)") { g in
        let h = g.count > 1 ? g[1] : ""
        let mm = g.count > 2 ? g[2] : ""
        guard let hour = Int(h), let minute = Int(mm) else {
            return g.count > 0 ? g[0] : ""
        }
        let hourWord = numberToBanglaWords(hour) + "টা"
        let minuteWord = numberToBanglaWords(minute)
        return hourWord + " " + minuteWord
    }

    // (c) Standalone digit-groups (ASCII 0-9 and Bangla ০-৯, optional commas).
    out = almaReplace(out, pattern: "[\\d০-৯][\\d০-৯,]*(?:\\.[\\d০-৯]+)?") { g in
        let m = g.count > 0 ? g[0] : ""
        // Normalize Bangla numerals to ASCII for parsing.
        var ascii = ""
        for ch in m {
            if let bi = almaBANGLA_DIGITS.firstIndex(of: ch) {
                ascii += String(bi)
            } else {
                ascii.append(ch)
            }
        }
        let cleaned = ascii.replacingOccurrences(of: ",", with: "")
        var digitsOnly = cleaned.replacingOccurrences(of: ".", with: "")
        if digitsOnly.hasPrefix("-") { digitsOnly.removeFirst() }
        if digitsOnly.count > 9 {
            return almaDigitsToWords(cleaned.replacingOccurrences(of: ".", with: ""))
        }
        guard let num = almaParseNumericLiteral(ascii) else { return m }
        return numberToBanglaWords(num)
    }

    // (d) Known-term phonetic map. Applied after numbers so acronyms like "AI"
    // aren't disturbed by numeric rewrites.
    for (term, spoken) in almaTERM_MAP {
        guard let re = almaBuildTermRegex(term) else { continue }
        let ns = out as NSString
        let fullRange = NSRange(location: 0, length: ns.length)
        // Escape "$" in the replacement so it isn't treated as a group reference.
        let template = spoken.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "$", with: "\\$")
        out = re.stringByReplacingMatches(in: out, options: [], range: fullRange, withTemplate: template)
    }

    // Collapse any accidental double spaces introduced by substitutions.
    out = almaReplace(out, pattern: "[ \\t]{2,}") { _ in " " }

    return out
}
