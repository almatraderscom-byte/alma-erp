//
//  AlmaLiveVoiceInputTurnReducer.swift
//  App
//
//  Deterministic ownership for Live Voice input PCM and transcription turns.
//

import Foundation

struct AlmaLiveVoiceInputTurnReducer {
    enum InputRoute: Equatable, Sendable {
        case trustedAECOrReceiver
        case noAECLoudspeaker
    }

    enum PlaybackSuppression: Equatable, Sendable {
        case none
        case activePlayback
        case playbackTail
    }

    enum ResponseBoundary: Equatable, Sendable {
        case modelAudio
        case toolCall
        case turnComplete
    }

    struct AudioFrame: Equatable, Sendable {
        let sequence: UInt64
        let pcm: AlmaLiveVoiceCapturedInputPCM
        let rms: Double
    }

    struct TranscriptUpdate: Equatable, Sendable {
        let turnOrdinal: UInt64
        let text: String
        let finalized: Bool
    }

    struct Effects: Equatable, Sendable {
        var audioFramesToSend: [AudioFrame] = []
        var sendAudioStreamEnd = false
        var transcriptUpdate: TranscriptUpdate?

        static let none = Effects()
    }

    /// The input tap is 20 ms today, so the default bound retains 3.2 seconds:
    /// enough for a complete short owner utterance while remaining under 110 KB
    /// of mono 16 kHz Int16 PCM. Tests use smaller bounds to prove eviction.
    static let defaultMaximumSuppressedFrames = 160

    private enum BufferedSuppression: Equatable {
        case activePlayback
        case playbackTail
    }

    private let maximumSuppressedFrames: Int
    private(set) var generation: UInt64
    private(set) var bufferedSuppressedFrameCount = 0
    private(set) var currentOwnerTurnOrdinal: UInt64 = 0
    private(set) var isAudioStreamOpen = false

    private var lastAcceptedFrameSequence: UInt64?
    private var suppressedFrames: [AudioFrame] = []
    private var bufferedSuppression: BufferedSuppression?
    /// First frame that the acoustic discriminator classified as a plausible
    /// owner onset.  It is intentionally separate from the stronger
    /// `ownerSpeechConfirmed` signal: confirmation takes several frames, and
    /// dropping the candidate span at the active-playback -> tail boundary
    /// clipped the first Bengali syllable.
    private var activePlaybackCandidateSequence: UInt64?
    private var activePlaybackOwnerConfirmed = false
    private var inputMuted = false

    private var ownerTurnCollecting = false
    private var ownerTurnFinalized = false
    private var responseStarted = false
    private var awaitingNextOwnerSignal = false
    private var ownerTranscript = ""

    init(
        generation: UInt64,
        maximumSuppressedFrames: Int = defaultMaximumSuppressedFrames
    ) {
        self.generation = generation
        self.maximumSuppressedFrames = max(1, maximumSuppressedFrames)
    }

    mutating func reset(generation: UInt64) {
        self.generation = generation
        lastAcceptedFrameSequence = nil
        suppressedFrames.removeAll(keepingCapacity: true)
        bufferedSuppression = nil
        bufferedSuppressedFrameCount = 0
        activePlaybackCandidateSequence = nil
        activePlaybackOwnerConfirmed = false
        inputMuted = false
        isAudioStreamOpen = false
        currentOwnerTurnOrdinal = 0
        ownerTurnCollecting = false
        ownerTurnFinalized = false
        responseStarted = false
        awaitingNextOwnerSignal = false
        ownerTranscript = ""
    }

    /// Accepts each converted input frame at most once. Trusted AEC/receiver
    /// routes never apply a local energy gate. The no-AEC loudspeaker path keeps
    /// active-playback echo fail-closed, but retains the entire bounded tail so
    /// a short utterance spoken immediately after playback is not lost.
    mutating func acceptAudioFrame(
        generation eventGeneration: UInt64,
        sequence: UInt64,
        pcm: AlmaLiveVoiceCapturedInputPCM,
        rms: Double,
        route: InputRoute,
        ready: Bool,
        suppression: PlaybackSuppression,
        ownerSpeechCandidate: Bool = false,
        ownerSpeechConfirmed: Bool = false
    ) -> Effects {
        guard eventGeneration == generation,
              ready,
              !inputMuted,
              !pcm.data.isEmpty,
              lastAcceptedFrameSequence.map({ sequence > $0 }) ?? true
        else { return .none }

        lastAcceptedFrameSequence = sequence
        let frame = AudioFrame(sequence: sequence, pcm: pcm, rms: rms)

        if route == .trustedAECOrReceiver {
            clearSuppressedFrames()
            activePlaybackCandidateSequence = nil
            activePlaybackOwnerConfirmed = false
            return sending([frame])
        }

        switch suppression {
        case .activePlayback:
            if activePlaybackOwnerConfirmed {
                return sending([frame])
            }
            if bufferedSuppression != .activePlayback {
                clearSuppressedFrames()
                bufferedSuppression = .activePlayback
                activePlaybackCandidateSequence = nil
            }
            if ownerSpeechCandidate || ownerSpeechConfirmed {
                activePlaybackCandidateSequence = activePlaybackCandidateSequence ?? sequence
            }
            if ownerSpeechConfirmed {
                activePlaybackOwnerConfirmed = true
                appendSuppressed(frame)
                retainCandidateSpanIfPresent()
                let frames = takeSuppressedFrames()
                activePlaybackOwnerConfirmed = true
                activePlaybackCandidateSequence = nil
                return sending(frames)
            }
            appendSuppressed(frame)
            return .none

        case .playbackTail:
            if bufferedSuppression != .playbackTail {
                // Ordinary active-playback frames are model echo.  Preserve only
                // the span beginning at an explicit acoustic owner candidate;
                // confirmation may arrive a few frames into the tail.
                if activePlaybackCandidateSequence != nil {
                    retainCandidateSpanIfPresent()
                } else {
                    clearSuppressedFrames()
                }
                bufferedSuppression = .playbackTail
            }
            activePlaybackOwnerConfirmed = false
            if ownerSpeechCandidate || ownerSpeechConfirmed {
                activePlaybackCandidateSequence = activePlaybackCandidateSequence ?? sequence
            }
            appendSuppressed(frame)
            if ownerSpeechConfirmed {
                retainCandidateSpanIfPresent()
                activePlaybackCandidateSequence = nil
                return sending(takeSuppressedFrames())
            }
            return .none

        case .none:
            activePlaybackOwnerConfirmed = false
            if bufferedSuppression == .playbackTail {
                appendSuppressed(frame)
                retainCandidateSpanIfPresent()
                activePlaybackCandidateSequence = nil
                return sending(takeSuppressedFrames())
            }
            // Never replay unconfirmed model audio retained during playback.
            clearSuppressedFrames()
            activePlaybackCandidateSequence = nil
            return sending([frame])
        }
    }

    /// Gemini automatic VAD needs an explicit stream boundary on mute. The
    /// boundary is emitted once only when this logical stream sent PCM.
    mutating func setMuted(
        _ muted: Bool,
        generation eventGeneration: UInt64
    ) -> Effects {
        guard eventGeneration == generation else { return .none }
        if muted == inputMuted { return .none }

        inputMuted = muted
        clearSuppressedFrames()
        activePlaybackCandidateSequence = nil
        activePlaybackOwnerConfirmed = false
        guard muted, isAudioStreamOpen else { return .none }
        isAudioStreamOpen = false
        return Effects(sendAudioStreamEnd: true)
    }

    /// Local energy and provider transcription are two observations of the same
    /// owner turn. Whichever arrives first opens it; the other never duplicates
    /// the ordinal or finalization.
    mutating func observeOwnerEnergy(generation eventGeneration: UInt64) -> Effects {
        guard eventGeneration == generation else { return .none }
        if awaitingNextOwnerSignal
            || (!ownerTurnCollecting && !ownerTurnFinalized && !responseStarted) {
            beginOwnerTurn()
        }
        return .none
    }

    mutating func observeInputTranscription(
        generation eventGeneration: UInt64,
        text: String?,
        finished: Bool
    ) -> Effects {
        guard eventGeneration == generation,
              !ownerTurnFinalized,
              !responseStarted,
              !awaitingNextOwnerSignal
        else { return .none }

        let fragment = text ?? ""
        let hasMeaningfulFragment = !fragment.trimmingCharacters(
            in: .whitespacesAndNewlines
        ).isEmpty

        if !ownerTurnCollecting {
            guard hasMeaningfulFragment else { return .none }
            beginOwnerTurn()
        }

        if !fragment.isEmpty {
            ownerTranscript += fragment
        }

        if finished {
            return finalizeOwnerTurn()
        }

        guard hasMeaningfulFragment else { return .none }
        return Effects(transcriptUpdate: TranscriptUpdate(
            turnOrdinal: currentOwnerTurnOrdinal,
            text: ownerTranscript,
            finalized: false))
    }

    /// A provider response is the deterministic fallback when input
    /// transcription omitted `finished`. Tool-only turns close without
    /// manufacturing an empty owner transcript.
    mutating func observeResponseBoundary(
        generation eventGeneration: UInt64,
        _ boundary: ResponseBoundary
    ) -> Effects {
        guard eventGeneration == generation else { return .none }
        _ = boundary
        let effect = finalizeOwnerTurn()
        responseStarted = true
        awaitingNextOwnerSignal = false
        return effect
    }

    mutating func observeResponseCompleted(generation eventGeneration: UInt64) -> Effects {
        guard eventGeneration == generation, responseStarted else { return .none }
        responseStarted = false
        ownerTurnCollecting = false
        awaitingNextOwnerSignal = true
        return .none
    }

    /// Provider activity start is authoritative only once a response has begun;
    /// a delayed callback after a finalized transcript still belongs to that
    /// already-closed turn and is ignored.
    mutating func observeActivityStarted(generation eventGeneration: UInt64) -> Effects {
        guard eventGeneration == generation else { return .none }
        if awaitingNextOwnerSignal {
            beginOwnerTurn()
        } else if !ownerTurnCollecting && !ownerTurnFinalized {
            beginOwnerTurn()
        }
        return .none
    }

    mutating func observeActivityEnded(generation eventGeneration: UInt64) -> Effects {
        guard eventGeneration == generation else { return .none }
        return .none
    }

    /// Local barge-in explicitly transfers ownership away from model playback.
    /// It is the only local signal allowed to open a new turn during a response.
    mutating func observeLocalBargeIn(generation eventGeneration: UInt64) -> Effects {
        guard eventGeneration == generation else { return .none }
        if responseStarted || awaitingNextOwnerSignal
            || ownerTurnFinalized || !ownerTurnCollecting {
            beginOwnerTurn()
        }
        return .none
    }

    private mutating func beginOwnerTurn() {
        currentOwnerTurnOrdinal &+= 1
        ownerTurnCollecting = true
        ownerTurnFinalized = false
        responseStarted = false
        awaitingNextOwnerSignal = false
        ownerTranscript = ""
    }

    private mutating func finalizeOwnerTurn() -> Effects {
        guard ownerTurnCollecting, !ownerTurnFinalized else { return .none }
        ownerTurnCollecting = false
        ownerTurnFinalized = true
        guard !ownerTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .none
        }
        return Effects(transcriptUpdate: TranscriptUpdate(
            turnOrdinal: currentOwnerTurnOrdinal,
            text: ownerTranscript,
            finalized: true))
    }

    private mutating func appendSuppressed(_ frame: AudioFrame) {
        suppressedFrames.append(frame)
        if suppressedFrames.count > maximumSuppressedFrames {
            suppressedFrames.removeFirst(suppressedFrames.count - maximumSuppressedFrames)
        }
        bufferedSuppressedFrameCount = suppressedFrames.count
    }

    /// Drops every pre-candidate frame.  The candidate itself is produced by a
    /// content/echo discriminator, not an RMS-only guess, so keeping the exact
    /// candidate boundary preserves onset without replaying earlier model echo.
    private mutating func retainCandidateSpanIfPresent() {
        guard let candidate = activePlaybackCandidateSequence,
              let index = suppressedFrames.firstIndex(where: { $0.sequence >= candidate })
        else { return }
        if index > 0 { suppressedFrames.removeFirst(index) }
        bufferedSuppressedFrameCount = suppressedFrames.count
    }

    private mutating func takeSuppressedFrames() -> [AudioFrame] {
        let frames = suppressedFrames
        clearSuppressedFrames()
        return frames
    }

    private mutating func clearSuppressedFrames() {
        suppressedFrames.removeAll(keepingCapacity: true)
        bufferedSuppression = nil
        bufferedSuppressedFrameCount = 0
    }

    private mutating func sending(_ frames: [AudioFrame]) -> Effects {
        guard !frames.isEmpty else { return .none }
        isAudioStreamOpen = true
        return Effects(audioFramesToSend: frames)
    }
}

/// Single production adapter boundary from reducer decisions to transport/UI
/// sinks. Keeping it pure makes exact-once delivery testable without opening a
/// microphone or websocket in the simulator.
struct AlmaLiveVoiceInputTurnEffectDelivery {
    static func apply(
        _ effects: AlmaLiveVoiceInputTurnReducer.Effects,
        sendAudioFrames: ([AlmaLiveVoiceInputTurnReducer.AudioFrame]) -> Void,
        sendAudioStreamEnd: () -> Void,
        updateTranscript: (AlmaLiveVoiceInputTurnReducer.TranscriptUpdate) -> Void
    ) {
        if !effects.audioFramesToSend.isEmpty {
            sendAudioFrames(effects.audioFramesToSend)
        }
        if effects.sendAudioStreamEnd { sendAudioStreamEnd() }
        if let transcript = effects.transcriptUpdate { updateTranscript(transcript) }
    }
}
