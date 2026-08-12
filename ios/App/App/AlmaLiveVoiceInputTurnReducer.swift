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
    /// Sequence of the first frame captured after playback stopped. Sound whose
    /// onset lands well past this cannot be echo — the echo's source is gone.
    private var tailStartSequence: UInt64?
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
        tailStartSequence = nil
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
                // The model resuming speech (a multi-sentence reply's next
                // sentence) must not erase an answer the owner gave inside the
                // inter-sentence pause (verified finding #3, 2026-08-13). The
                // buffered tail gets the same owner-evidence decision it would
                // have gotten at the tail boundary; only echo is discarded.
                let drained = bufferedSuppression == .playbackTail
                    ? takeTailIfOwnerSpeech()
                    : []
                clearSuppressedFrames()
                tailStartSequence = nil
                bufferedSuppression = .activePlayback
                activePlaybackCandidateSequence = nil
                if !drained.isEmpty {
                    appendSuppressed(frame)
                    return sending(drained)
                }
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
            // A CONFIRMED barge-in does not lose its voice because playback
            // drained: the owner's sentence continues into the tail and keeps
            // streaming (verified finding #4, 2026-08-13).
            if activePlaybackOwnerConfirmed {
                return sending([frame])
            }
            if bufferedSuppression != .playbackTail {
                tailStartSequence = sequence
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
                bufferedSuppression = nil
                if activePlaybackCandidateSequence != nil {
                    appendSuppressed(frame)
                    retainCandidateSpanIfPresent()
                    activePlaybackCandidateSequence = nil
                    return sending(takeSuppressedFrames())
                }
                // No acoustic owner onset was ever flagged, so decide by how the
                // sound ends. The tail window is sized well past the measured
                // playback-echo decay, so echo falls far below its own peak
                // before the window closes, while an owner who started speaking
                // in the tail is still audible at its edge. The threshold is
                // relative to the buffer's own peak — a buffer filled wall to
                // wall with speech has a loud edge and drains, a decayed echo
                // has a silent edge and is discarded. Draining a buffer whose
                // sound already died replayed ALMA's own voice as the owner's
                // next turn — she then answered herself ("আমি তো বুঝলাম না আমি
                // তোমাকে কি বলতেছি…", owner report 2026-08-12).
                appendSuppressed(frame)
                let retained = takeTailIfOwnerSpeech(boundaryRMS: frame.rms)
                tailStartSequence = nil
                guard !retained.isEmpty else {
                    clearSuppressedFrames()
                    return sending([frame])
                }
                return sending(retained)
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
    /// One owner-evidence decision for a buffered no-AEC tail, used both at the
    /// tail boundary and when the model resumes speaking mid-pause.
    ///
    /// A human answers 200-500 ms after the agent's question — an onset-based
    /// rule threw that away and made the owner repeat himself (report
    /// 2026-08-13). What separates him from echo is not when the sound STARTS
    /// but whether it OUTLIVES the echo: playback stopped when the tail began
    /// and the measured echo dies within ~650 ms, so any sound still loud
    /// ≥700 ms (35 frames at 20 ms) into the tail is the owner. The threshold
    /// is capped so soft speech after loud playback still counts (finding #5),
    /// and the flushed span is trimmed to the final loud run so a retained
    /// buffer can never replay the decayed-echo prefix as an owner turn
    /// (finding #7). Returns [] when the buffer is echo; empties the buffer
    /// when it returns frames.
    private mutating func takeTailIfOwnerSpeech(boundaryRMS: Double? = nil) -> [AudioFrame] {
        guard !suppressedFrames.isEmpty else { return [] }
        let peak = suppressedFrames.map(\.rms).max() ?? 0
        let threshold = max(0.003, min(peak * 0.25, 0.02))
        let audibleAtBoundary = (boundaryRMS.map { $0 >= threshold } ?? false)
            || suppressedFrames.suffix(3).contains { $0.rms >= threshold }
        let sustained: Bool = {
            guard let tailStart = tailStartSequence,
                  let lastLoud = suppressedFrames.last(where: { $0.rms >= threshold })
            else { return false }
            return lastLoud.sequence >= tailStart + 35
        }()
        guard audibleAtBoundary || sustained else { return [] }
        var frames = takeSuppressedFrames()
        if !audibleAtBoundary,
           let lastLoudIndex = frames.lastIndex(where: { $0.rms >= threshold }) {
            var runStart = lastLoudIndex
            while runStart > frames.startIndex,
                  frames[frames.index(before: runStart)].rms >= threshold {
                runStart = frames.index(before: runStart)
            }
            frames.removeFirst(runStart)
        }
        return frames
    }

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
