//
//  AlmaLiveVoiceOutputPCMEnvelope.swift
//  App
//
//  Pure, generation-bound envelope policy for the foreground Live Voice orb.
//

import Foundation

/// Follows the amplitude of the PCM that is actually queued for model-voice
/// playback. The reducer owns no timer, oscillator, microphone input, audio
/// engine, or UI state, so a silent output buffer can never manufacture motion.
struct AlmaLiveVoiceOutputPCMEnvelopeReducer: Equatable, Sendable {
    enum Phase: Equatable, Sendable {
        case listening
        case speaking
    }

    struct PCM16LEBuffer: Equatable, Sendable {
        let data: Data
        let sampleRate: Double
        let channelCount: Int

        init(data: Data, sampleRate: Double, channelCount: Int = 1) {
            self.data = data
            self.sampleRate = sampleRate
            self.channelCount = channelCount
        }
    }

    enum Event: Equatable, Sendable {
        case phaseChanged(Phase)
        case outputPCM(PCM16LEBuffer)
    }

    struct Input: Equatable, Sendable {
        let generation: UInt64
        let event: Event
    }

    enum IgnoredReason: Equatable, Sendable {
        case generationMismatch
        case invalidPCM
        case outputWhileListening
    }

    enum Outcome: Equatable, Sendable {
        case applied
        case ignored(IgnoredReason)
    }

    enum AnimationSemantics: Equatable, Sendable {
        /// Listening and settled silence are a calm, zero-amplitude orb.
        case calm
        /// Ordinary presentation may animate from the measured PCM envelope.
        case reactive
        /// Reduce Motion retains non-spatial emphasis but never changes scale.
        case staticSpeaking
    }

    struct Presentation: Equatable, Sendable {
        let level: Double
        let scale: Double
        let semantics: AnimationSemantics

        var allowsSpatialAnimation: Bool { semantics == .reactive }
    }

    struct Transition: Equatable, Sendable {
        let outcome: Outcome
        let phase: Phase
        /// RMS measured from the accepted output buffer before its silence floor
        /// and visual gain are applied.
        let measuredRMS: Double
        /// The unsmoothed, normalized target derived from that real PCM buffer.
        let targetLevel: Double
        /// Attack/release-smoothed output consumed by the foreground orb.
        let level: Double

        var mayApplyEffects: Bool {
            if case .applied = outcome { return true }
            return false
        }
    }

    struct Configuration: Equatable, Sendable {
        let silenceFloorRMS: Double
        let visualGain: Double
        let attackTimeSeconds: Double
        let releaseTimeSeconds: Double
        let zeroSnapLevel: Double

        static let liveVoice = Configuration(
            silenceFloorRMS: 0.002,
            visualGain: 4,
            attackTimeSeconds: 0.045,
            releaseTimeSeconds: 0.180,
            zeroSnapLevel: 0.001)

        init(
            silenceFloorRMS: Double,
            visualGain: Double,
            attackTimeSeconds: Double,
            releaseTimeSeconds: Double,
            zeroSnapLevel: Double
        ) {
            self.silenceFloorRMS = min(0.999, max(0, silenceFloorRMS))
            self.visualGain = max(0, visualGain)
            self.attackTimeSeconds = max(0.000_001, attackTimeSeconds)
            self.releaseTimeSeconds = max(0.000_001, releaseTimeSeconds)
            self.zeroSnapLevel = min(1, max(0, zeroSnapLevel))
        }
    }

    private(set) var generation: UInt64
    private(set) var phase: Phase = .listening
    private(set) var measuredRMS: Double = 0
    private(set) var targetLevel: Double = 0
    private(set) var level: Double = 0

    private let configuration: Configuration

    init?(generation: UInt64, configuration: Configuration = .liveVoice) {
        guard generation != 0 else { return nil }
        self.generation = generation
        self.configuration = configuration
    }

    /// Begins a new transport generation in a deliberately calm state. A late
    /// PCM callback from the old player therefore cannot revive the new orb.
    mutating func reset(generation: UInt64) -> Bool {
        guard generation != 0 else { return false }
        self.generation = generation
        phase = .listening
        measuredRMS = 0
        targetLevel = 0
        level = 0
        return true
    }

    mutating func reduce(_ input: Input) -> Transition {
        guard input.generation == generation else {
            return transition(.ignored(.generationMismatch))
        }

        switch input.event {
        case .phaseChanged(let newPhase):
            phase = newPhase
            if newPhase == .listening {
                // Listening must never reuse the owner's microphone or a stale
                // model-output envelope. It becomes calm immediately.
                measuredRMS = 0
                targetLevel = 0
                level = 0
            }
            return transition(.applied)

        case .outputPCM(let buffer):
            guard phase == .speaking else {
                return transition(.ignored(.outputWhileListening))
            }
            guard let measurement = Self.measure(buffer) else {
                return transition(.ignored(.invalidPCM))
            }

            measuredRMS = measurement.rms
            targetLevel = normalizedTarget(for: measurement.rms)
            let timeConstant = targetLevel > level
                ? configuration.attackTimeSeconds
                : configuration.releaseTimeSeconds
            let coefficient = 1 - exp(-measurement.durationSeconds / timeConstant)
            level += (targetLevel - level) * coefficient
            level = min(1, max(0, level))
            if targetLevel == 0, level <= configuration.zeroSnapLevel {
                level = 0
            }
            return transition(.applied)
        }
    }

    /// Maps the same measured envelope to two explicit accessibility paths.
    /// Reduce Motion holds scale at 1.0; color/luminance may still use `level`
    /// as a non-spatial indication that model PCM is present.
    func presentation(reduceMotion: Bool) -> Presentation {
        Self.presentation(level: level, phase: phase, reduceMotion: reduceMotion)
    }

    static func presentation(
        level: Double,
        phase: Phase,
        reduceMotion: Bool
    ) -> Presentation {
        let level = min(1, max(0, level))
        guard phase == .speaking, level > 0 else {
            return Presentation(level: 0, scale: 1, semantics: .calm)
        }
        if reduceMotion {
            return Presentation(level: level, scale: 1, semantics: .staticSpeaking)
        }
        return Presentation(
            level: level,
            scale: 1 + (level * 0.08),
            semantics: .reactive)
    }

    private func normalizedTarget(for rms: Double) -> Double {
        guard rms > configuration.silenceFloorRMS else { return 0 }
        let floorRemoved = (rms - configuration.silenceFloorRMS)
            / (1 - configuration.silenceFloorRMS)
        return min(1, max(0, floorRemoved * configuration.visualGain))
    }

    private func transition(_ outcome: Outcome) -> Transition {
        Transition(
            outcome: outcome,
            phase: phase,
            measuredRMS: measuredRMS,
            targetLevel: targetLevel,
            level: level)
    }

    private static func measure(
        _ buffer: PCM16LEBuffer
    ) -> (rms: Double, durationSeconds: Double)? {
        guard buffer.sampleRate.isFinite,
              buffer.sampleRate > 0,
              buffer.channelCount > 0,
              !buffer.data.isEmpty,
              buffer.data.count.isMultiple(of: MemoryLayout<Int16>.size)
        else { return nil }

        let sampleCount = buffer.data.count / MemoryLayout<Int16>.size
        guard sampleCount.isMultiple(of: buffer.channelCount) else { return nil }

        var sumOfSquares = 0.0
        buffer.data.withUnsafeBytes { rawBytes in
            for offset in stride(from: 0, to: rawBytes.count, by: 2) {
                let stored = rawBytes.loadUnaligned(
                    fromByteOffset: offset,
                    as: UInt16.self)
                let sample = Int16(bitPattern: UInt16(littleEndian: stored))
                let normalized = Double(sample) / 32_768.0
                sumOfSquares += normalized * normalized
            }
        }

        let frameCount = sampleCount / buffer.channelCount
        return (
            rms: sqrt(sumOfSquares / Double(sampleCount)),
            durationSeconds: Double(frameCount) / buffer.sampleRate)
    }
}
