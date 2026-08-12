import XCTest
@testable import App

final class LiveVoiceInputTurnReducerTests: XCTestCase {
    private let generation: UInt64 = 41

    func testProductionEffectAdapterDeliversEachTransportEffectExactlyOnce() {
        let frames = [
            AlmaLiveVoiceInputTurnReducer.AudioFrame(
                sequence: 1, pcm: pcm(1), rms: 0.02),
            AlmaLiveVoiceInputTurnReducer.AudioFrame(
                sequence: 2, pcm: pcm(2), rms: 0.03),
        ]
        let transcript = AlmaLiveVoiceInputTurnReducer.TranscriptUpdate(
            turnOrdinal: 7, text: "ঠিক আছে", finalized: true)
        var effects = AlmaLiveVoiceInputTurnReducer.Effects()
        effects.audioFramesToSend = frames
        effects.sendAudioStreamEnd = true
        effects.transcriptUpdate = transcript
        var audioBatches: [[UInt64]] = []
        var streamEndCount = 0
        var transcriptUpdates: [AlmaLiveVoiceInputTurnReducer.TranscriptUpdate] = []

        AlmaLiveVoiceInputTurnEffectDelivery.apply(
            effects,
            sendAudioFrames: { audioBatches.append($0.map(\.sequence)) },
            sendAudioStreamEnd: { streamEndCount += 1 },
            updateTranscript: { transcriptUpdates.append($0) })

        XCTAssertEqual(audioBatches, [[1, 2]])
        XCTAssertEqual(streamEndCount, 1)
        XCTAssertEqual(transcriptUpdates, [transcript])
    }

    func testInputTurnReducerRollbackGateHasDeterministicPrecedence() throws {
        let suite = "LiveVoiceInputTurnReducerTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertTrue(AlmaLiveVoiceRecoveryFeatures.isEnabled(
            .inputTurnReducerV1,
            environment: [:],
            defaults: defaults))
        AlmaLiveVoiceRecoveryFeatures.set(
            false,
            for: .inputTurnReducerV1,
            defaults: defaults)
        XCTAssertFalse(AlmaLiveVoiceRecoveryFeatures.isEnabled(
            .inputTurnReducerV1,
            environment: [:],
            defaults: defaults))
        XCTAssertTrue(AlmaLiveVoiceRecoveryFeatures.isEnabled(
            .inputTurnReducerV1,
            environment: ["ALMA_LIVE_VOICE_INPUT_TURN_REDUCER_V1": "true"],
            defaults: defaults))
    }

    func testTrustedRouteContinuouslyEmitsQuietNormalAndPausedPCMExactlyOnce() {
        var reducer = AlmaLiveVoiceInputTurnReducer(generation: generation)
        let levels = [0.006, 0.030, 0.000, 0.011, 0.004] + Array(repeating: 0.018, count: 220)
        var emitted: [UInt64] = []

        for (offset, level) in levels.enumerated() {
            let sequence = UInt64(offset + 1)
            let effect = reducer.acceptAudioFrame(
                generation: generation,
                sequence: sequence,
                pcm: pcm(sequence),
                rms: level,
                route: .trustedAECOrReceiver,
                ready: true,
                suppression: offset < 2 ? .activePlayback : .none)
            emitted += effect.audioFramesToSend.map(\.sequence)
        }

        let duplicate = reducer.acceptAudioFrame(
            generation: generation,
            sequence: UInt64(levels.count),
            pcm: pcm(UInt64(levels.count)),
            rms: 0.030,
            route: .trustedAECOrReceiver,
            ready: true,
            suppression: .none)

        XCTAssertEqual(emitted, (1...UInt64(levels.count)).map { $0 })
        XCTAssertTrue(duplicate.audioFramesToSend.isEmpty)
    }

    func testTrustedRouteDoesNotLoseImmediatePostGreetingPCM() {
        var reducer = AlmaLiveVoiceInputTurnReducer(generation: generation)

        let duringPlayback = reducer.acceptAudioFrame(
            generation: generation,
            sequence: 1,
            pcm: pcm(1),
            rms: 0.006,
            route: .trustedAECOrReceiver,
            ready: true,
            suppression: .activePlayback)
        let playbackTail = reducer.acceptAudioFrame(
            generation: generation,
            sequence: 2,
            pcm: pcm(2),
            rms: 0.030,
            route: .trustedAECOrReceiver,
            ready: true,
            suppression: .playbackTail)

        XCTAssertEqual(duringPlayback.audioFramesToSend.map(\.sequence), [1])
        XCTAssertEqual(playbackTail.audioFramesToSend.map(\.sequence), [2])
    }

    func testNoAECLoudspeakerRetainsCompleteShortUtteranceAcrossPlaybackTail() {
        var reducer = AlmaLiveVoiceInputTurnReducer(generation: generation)
        let shortUtteranceFrames = 100

        for sequence in 1...shortUtteranceFrames {
            let effect = reducer.acceptAudioFrame(
                generation: generation,
                sequence: UInt64(sequence),
                pcm: pcm(UInt64(sequence)),
                rms: sequence < 15 ? 0.006 : 0.030,
                route: .noAECLoudspeaker,
                ready: true,
                suppression: .playbackTail)
            XCTAssertTrue(effect.audioFramesToSend.isEmpty)
        }

        let released = reducer.acceptAudioFrame(
            generation: generation,
            sequence: 101,
            pcm: pcm(101),
            rms: 0.004,
            route: .noAECLoudspeaker,
            ready: true,
            suppression: .none)

        XCTAssertEqual(released.audioFramesToSend.map(\.sequence), (1...101).map(UInt64.init))
        XCTAssertEqual(reducer.bufferedSuppressedFrameCount, 0)
    }

    func testNoAECActivePlaybackBufferIsBoundedAndDrainsFIFOAfterConfirmation() {
        var reducer = AlmaLiveVoiceInputTurnReducer(
            generation: generation,
            maximumSuppressedFrames: 3)

        for sequence in 1...4 {
            let effect = reducer.acceptAudioFrame(
                generation: generation,
                sequence: UInt64(sequence),
                pcm: pcm(UInt64(sequence)),
                rms: 0.030,
                route: .noAECLoudspeaker,
                ready: true,
                suppression: .activePlayback,
                ownerSpeechCandidate: sequence == 3)
            XCTAssertTrue(effect.audioFramesToSend.isEmpty)
        }

        XCTAssertEqual(reducer.bufferedSuppressedFrameCount, 3)
        let confirmed = reducer.acceptAudioFrame(
            generation: generation,
            sequence: 5,
            pcm: pcm(5),
            rms: 0.030,
            route: .noAECLoudspeaker,
            ready: true,
            suppression: .activePlayback,
            ownerSpeechConfirmed: true)
        let continuing = reducer.acceptAudioFrame(
            generation: generation,
            sequence: 6,
            pcm: pcm(6),
            rms: 0.012,
            route: .noAECLoudspeaker,
            ready: true,
            suppression: .activePlayback)

        XCTAssertEqual(confirmed.audioFramesToSend.map(\.sequence), [3, 4, 5])
        XCTAssertEqual(continuing.audioFramesToSend.map(\.sequence), [6])
    }

    func testNoAECCandidateOnsetSurvivesActivePlaybackIntoTailWithoutEchoPrefix() {
        var reducer = AlmaLiveVoiceInputTurnReducer(
            generation: generation,
            maximumSuppressedFrames: 16)

        // Frames 1...4 are model echo. The acoustic discriminator first sees a
        // plausible owner onset at frame 5; final confirmation lands in the tail.
        for sequence in 1...6 {
            let effect = reducer.acceptAudioFrame(
                generation: generation,
                sequence: UInt64(sequence),
                pcm: pcm(UInt64(sequence)),
                rms: 0.03,
                route: .noAECLoudspeaker,
                ready: true,
                suppression: .activePlayback,
                ownerSpeechCandidate: sequence == 5)
            XCTAssertTrue(effect.audioFramesToSend.isEmpty)
        }

        let firstTail = reducer.acceptAudioFrame(
            generation: generation,
            sequence: 7,
            pcm: pcm(7),
            rms: 0.025,
            route: .noAECLoudspeaker,
            ready: true,
            suppression: .playbackTail)
        XCTAssertTrue(firstTail.audioFramesToSend.isEmpty)

        let confirmed = reducer.acceptAudioFrame(
            generation: generation,
            sequence: 8,
            pcm: pcm(8),
            rms: 0.026,
            route: .noAECLoudspeaker,
            ready: true,
            suppression: .playbackTail,
            ownerSpeechConfirmed: true)

        XCTAssertEqual(confirmed.audioFramesToSend.map(\.sequence), [5, 6, 7, 8])
        XCTAssertEqual(reducer.bufferedSuppressedFrameCount, 0)
    }

    func testNoAECActiveEchoIsDiscardedWhenTailBeginsWithoutOwnerCandidate() {
        var reducer = AlmaLiveVoiceInputTurnReducer(generation: generation)
        for sequence in 1...4 {
            _ = reducer.acceptAudioFrame(
                generation: generation,
                sequence: UInt64(sequence),
                pcm: pcm(UInt64(sequence)),
                rms: 0.03,
                route: .noAECLoudspeaker,
                ready: true,
                suppression: .activePlayback)
        }

        _ = reducer.acceptAudioFrame(
            generation: generation,
            sequence: 5,
            pcm: pcm(5),
            rms: 0.01,
            route: .noAECLoudspeaker,
            ready: true,
            suppression: .playbackTail)
        let expired = reducer.acceptAudioFrame(
            generation: generation,
            sequence: 6,
            pcm: pcm(6),
            rms: 0.004,
            route: .noAECLoudspeaker,
            ready: true,
            suppression: .none)

        XCTAssertEqual(expired.audioFramesToSend.map(\.sequence), [5, 6])
    }

    /// The 2026-08-12 owner report: ALMA answered her own echo ("আমি তো বুঝলাম
    /// না আমি তোমাকে কি বলতেছি…"). On a no-AEC route her playback leaks into the
    /// tail buffer; it decays to near-silence inside the window, and draining
    /// that dead buffer wholesale fed her own words back as the owner's turn.
    func testNoAECDecayedEchoTailIsDiscardedInsteadOfReplayedAsOwnerSpeech() {
        var reducer = AlmaLiveVoiceInputTurnReducer(generation: generation)

        // Echo, loud at first, decaying to ambient before the tail expires.
        let decay: [Double] = [0.030, 0.028, 0.020, 0.012, 0.006, 0.002, 0.0015, 0.0015]
        for (offset, level) in decay.enumerated() {
            let effect = reducer.acceptAudioFrame(
                generation: generation,
                sequence: UInt64(offset + 1),
                pcm: pcm(UInt64(offset + 1)),
                rms: level,
                route: .noAECLoudspeaker,
                ready: true,
                suppression: .playbackTail)
            XCTAssertTrue(effect.audioFramesToSend.isEmpty)
        }

        let boundary = reducer.acceptAudioFrame(
            generation: generation,
            sequence: 9,
            pcm: pcm(9),
            rms: 0.0015,
            route: .noAECLoudspeaker,
            ready: true,
            suppression: .none)

        // Only live listening continues; the dead echo never reaches the model.
        XCTAssertEqual(boundary.audioFramesToSend.map(\.sequence), [9])
        XCTAssertEqual(reducer.bufferedSuppressedFrameCount, 0)
    }

    /// The mirror case: an owner who starts talking inside the tail is still
    /// audible when it expires, and the whole utterance — first syllable
    /// included — must reach the model.
    func testNoAECSpeechAudibleAtTailBoundaryStillDrainsCompletely() {
        var reducer = AlmaLiveVoiceInputTurnReducer(generation: generation)

        for sequence in 1...6 {
            let effect = reducer.acceptAudioFrame(
                generation: generation,
                sequence: UInt64(sequence),
                pcm: pcm(UInt64(sequence)),
                rms: 0.030,
                route: .noAECLoudspeaker,
                ready: true,
                suppression: .playbackTail)
            XCTAssertTrue(effect.audioFramesToSend.isEmpty)
        }

        let boundary = reducer.acceptAudioFrame(
            generation: generation,
            sequence: 7,
            pcm: pcm(7),
            rms: 0.028,
            route: .noAECLoudspeaker,
            ready: true,
            suppression: .none)

        XCTAssertEqual(boundary.audioFramesToSend.map(\.sequence), (1...7).map(UInt64.init))
        XCTAssertEqual(reducer.bufferedSuppressedFrameCount, 0)
    }

    /// A human answers 200-500 ms after the agent finishes — inside the echo
    /// window. What separates him from echo is that his sound OUTLIVES it:
    /// echo dies by ~650 ms, his sentence is still loud past 700 ms. Requiring
    /// a late ONSET instead threw his reply away and made him repeat himself
    /// (owner report 2026-08-13, "৪-৬ বার বলা লাগে").
    func testNoAECImmediateReplyStartingInsideEchoWindowIsRetained() {
        var reducer = AlmaLiveVoiceInputTurnReducer(generation: generation)

        var sequence: UInt64 = 0
        func frame(_ rms: Double, _ suppression: AlmaLiveVoiceInputTurnReducer.PlaybackSuppression) -> [UInt64] {
            sequence += 1
            return reducer.acceptAudioFrame(
                generation: generation,
                sequence: sequence,
                pcm: pcm(sequence),
                rms: rms,
                route: .noAECLoudspeaker,
                ready: true,
                suppression: suppression
            ).audioFramesToSend.map(\.sequence)
        }
        // 15 quiet frames (300 ms), then the owner's reply overlapping the echo
        // window and sustaining well past it, ending quietly before the tail
        // expires.
        for _ in 0..<15 { XCTAssertEqual(frame(0.0015, .playbackTail), []) }
        for _ in 0..<60 { XCTAssertEqual(frame(0.030, .playbackTail), []) }
        for _ in 0..<10 { XCTAssertEqual(frame(0.0015, .playbackTail), []) }

        let released = frame(0.0015, .none)
        // Sustained retention trims to the final loud run: the 15-frame quiet
        // lead is dropped, the reply itself (60 loud + 10 quiet close + the
        // boundary frame) goes through — 71 frames from sequence 16.
        XCTAssertEqual(released.count, 71)
        XCTAssertEqual(released.first, 16)
        XCTAssertEqual(reducer.bufferedSuppressedFrameCount, 0)
    }

    /// A short reply spoken and FINISHED inside the tail has a quiet edge, but
    /// it outlives the echo window, so it is retained.
    func testNoAECLateOnsetUtteranceInsideTailIsRetained() {
        var reducer = AlmaLiveVoiceInputTurnReducer(generation: generation)

        // 40 quiet tail frames (echo already dead), then a 1s utterance that
        // ends with 10 quiet frames before the tail expires.
        var sequence: UInt64 = 0
        func frame(_ rms: Double, _ suppression: AlmaLiveVoiceInputTurnReducer.PlaybackSuppression) -> [UInt64] {
            sequence += 1
            return reducer.acceptAudioFrame(
                generation: generation,
                sequence: sequence,
                pcm: pcm(sequence),
                rms: rms,
                route: .noAECLoudspeaker,
                ready: true,
                suppression: suppression
            ).audioFramesToSend.map(\.sequence)
        }
        for _ in 0..<40 { XCTAssertEqual(frame(0.0015, .playbackTail), []) }
        for _ in 0..<50 { XCTAssertEqual(frame(0.030, .playbackTail), []) }
        for _ in 0..<10 { XCTAssertEqual(frame(0.0015, .playbackTail), []) }

        let released = frame(0.0015, .none)
        // Trimmed to the utterance's own run: 50 loud + 10 quiet close +
        // boundary frame, starting at sequence 41 — the 40-frame quiet lead
        // never reaches the model.
        XCTAssertEqual(released.count, 61)
        XCTAssertEqual(released.first, 41)
        XCTAssertEqual(reducer.bufferedSuppressedFrameCount, 0)
    }

    /// Finding #3 (2026-08-13): the model resuming its next sentence must not
    /// erase an answer the owner gave inside the inter-sentence pause.
    func testNoAECAnswerInInterSentencePauseSurvivesModelResuming() {
        var reducer = AlmaLiveVoiceInputTurnReducer(generation: generation)
        var sequence: UInt64 = 0
        func frame(_ rms: Double, _ suppression: AlmaLiveVoiceInputTurnReducer.PlaybackSuppression) -> [UInt64] {
            sequence += 1
            return reducer.acceptAudioFrame(
                generation: generation, sequence: sequence, pcm: pcm(sequence),
                rms: rms, route: .noAECLoudspeaker, ready: true,
                suppression: suppression
            ).audioFramesToSend.map(\.sequence)
        }
        // Owner answers 300ms into the pause and is still talking (sustained
        // past the echo window) when the model's next sentence begins.
        for _ in 0..<15 { XCTAssertEqual(frame(0.0015, .playbackTail), []) }
        for _ in 0..<45 { XCTAssertEqual(frame(0.030, .playbackTail), []) }
        let resumed = frame(0.030, .activePlayback)
        // The buffered answer drains instead of being wiped. Speech is audible
        // at the boundary, so the whole buffer (quiet lead included — post-
        // playback silence, not echo) goes through.
        XCTAssertEqual(resumed.count, 60)
    }

    /// Finding #4 (2026-08-13): a CONFIRMED barge-in whose sentence continues
    /// into the tail keeps streaming; it does not go silent at the boundary.
    func testNoAECConfirmedBargeInKeepsStreamingThroughTail() {
        var reducer = AlmaLiveVoiceInputTurnReducer(generation: generation)
        _ = reducer.acceptAudioFrame(
            generation: generation, sequence: 1, pcm: pcm(1), rms: 0.03,
            route: .noAECLoudspeaker, ready: true,
            suppression: .activePlayback, ownerSpeechConfirmed: true)
        let tail = reducer.acceptAudioFrame(
            generation: generation, sequence: 2, pcm: pcm(2), rms: 0.03,
            route: .noAECLoudspeaker, ready: true,
            suppression: .playbackTail)
        XCTAssertEqual(tail.audioFramesToSend.map(\.sequence), [2])
    }

    /// Finding #5 (2026-08-13): soft owner speech after loud playback echo must
    /// clear the threshold — the cap keeps a 0.2-rms echo from silencing a
    /// 0.03-rms voice.
    func testNoAECSoftSpeechAfterLoudEchoClearsCappedThreshold() {
        var reducer = AlmaLiveVoiceInputTurnReducer(generation: generation)
        var sequence: UInt64 = 0
        func frame(_ rms: Double, _ suppression: AlmaLiveVoiceInputTurnReducer.PlaybackSuppression) -> [UInt64] {
            sequence += 1
            return reducer.acceptAudioFrame(
                generation: generation, sequence: sequence, pcm: pcm(sequence),
                rms: rms, route: .noAECLoudspeaker, ready: true,
                suppression: suppression
            ).audioFramesToSend.map(\.sequence)
        }
        for _ in 0..<10 { XCTAssertEqual(frame(0.20, .playbackTail), []) }   // loud echo
        for _ in 0..<20 { XCTAssertEqual(frame(0.0015, .playbackTail), []) } // decay
        for _ in 0..<20 { XCTAssertEqual(frame(0.030, .playbackTail), []) }  // soft owner
        let released = frame(0.030, .none)
        XCTAssertFalse(released.isEmpty)
    }

    /// Finding #7 (2026-08-13): a sustained retention must not drag the decayed
    /// echo prefix along — the model never hears its own voice replayed.
    func testNoAECSustainedRetentionTrimsEchoPrefix() {
        var reducer = AlmaLiveVoiceInputTurnReducer(generation: generation)
        var sequence: UInt64 = 0
        func frame(_ rms: Double, _ suppression: AlmaLiveVoiceInputTurnReducer.PlaybackSuppression) -> [UInt64] {
            sequence += 1
            return reducer.acceptAudioFrame(
                generation: generation, sequence: sequence, pcm: pcm(sequence),
                rms: rms, route: .noAECLoudspeaker, ready: true,
                suppression: suppression
            ).audioFramesToSend.map(\.sequence)
        }
        for _ in 0..<10 { XCTAssertEqual(frame(0.030, .playbackTail), []) }  // echo
        for _ in 0..<30 { XCTAssertEqual(frame(0.0015, .playbackTail), []) } // silence
        for _ in 0..<20 { XCTAssertEqual(frame(0.030, .playbackTail), []) }  // owner, quiet edge below
        for _ in 0..<5 { XCTAssertEqual(frame(0.0015, .playbackTail), []) }
        let released = frame(0.0015, .none)
        // Sustained retention fires, but the flushed span starts at the owner's
        // run (sequence 41), never at the echo (sequence 1).
        XCTAssertEqual(released.first, 41)
        XCTAssertTrue(released.allSatisfy { $0 >= 41 })
    }

    func testMuteEndsOnlyAnOpenAudioStreamAndUnmuteResumes() {
        var reducer = AlmaLiveVoiceInputTurnReducer(generation: generation)

        XCTAssertFalse(reducer.setMuted(true, generation: generation).sendAudioStreamEnd)
        XCTAssertTrue(reducer.acceptAudioFrame(
            generation: generation,
            sequence: 1,
            pcm: pcm(1),
            rms: 0.006,
            route: .trustedAECOrReceiver,
            ready: true,
            suppression: .none
        ).audioFramesToSend.isEmpty)

        _ = reducer.setMuted(false, generation: generation)
        XCTAssertEqual(reducer.acceptAudioFrame(
            generation: generation,
            sequence: 2,
            pcm: pcm(2),
            rms: 0.006,
            route: .trustedAECOrReceiver,
            ready: true,
            suppression: .none
        ).audioFramesToSend.map(\.sequence), [2])
        XCTAssertTrue(reducer.setMuted(true, generation: generation).sendAudioStreamEnd)
        XCTAssertFalse(reducer.setMuted(true, generation: generation).sendAudioStreamEnd)
    }

    func testTranscriptionAndEnergyOrderingShareOneExactlyFinalizedTurn() {
        var transcriptionFirst = AlmaLiveVoiceInputTurnReducer(generation: generation)
        XCTAssertEqual(transcriptionFirst.observeInputTranscription(
            generation: generation,
            text: "আমি ",
            finished: false
        ).transcriptUpdate, .init(turnOrdinal: 1, text: "আমি ", finalized: false))
        _ = transcriptionFirst.observeOwnerEnergy(generation: generation)
        XCTAssertEqual(transcriptionFirst.observeInputTranscription(
            generation: generation,
            text: "যাই",
            finished: true
        ).transcriptUpdate, .init(turnOrdinal: 1, text: "আমি যাই", finalized: true))

        var energyFirst = AlmaLiveVoiceInputTurnReducer(generation: generation)
        _ = energyFirst.observeOwnerEnergy(generation: generation)
        XCTAssertEqual(energyFirst.observeInputTranscription(
            generation: generation,
            text: "আমি যাই",
            finished: true
        ).transcriptUpdate, .init(turnOrdinal: 1, text: "আমি যাই", finalized: true))
        XCTAssertNil(energyFirst.observeInputTranscription(
            generation: generation,
            text: nil,
            finished: true
        ).transcriptUpdate)
    }

    func testMarkerOnlyFinishedAndMissingFinishedFallbackFinalizeExactlyOnce() {
        var marker = AlmaLiveVoiceInputTurnReducer(generation: generation)
        _ = marker.observeInputTranscription(
            generation: generation,
            text: "শেষ করি",
            finished: false)
        XCTAssertEqual(marker.observeInputTranscription(
            generation: generation,
            text: nil,
            finished: true
        ).transcriptUpdate, .init(turnOrdinal: 1, text: "শেষ করি", finalized: true))
        XCTAssertNil(marker.observeInputTranscription(
            generation: generation,
            text: nil,
            finished: true
        ).transcriptUpdate)

        var fallback = AlmaLiveVoiceInputTurnReducer(generation: generation)
        _ = fallback.observeInputTranscription(
            generation: generation,
            text: "বলুন",
            finished: false)
        XCTAssertEqual(fallback.observeResponseBoundary(
            generation: generation,
            .modelAudio
        ).transcriptUpdate, .init(turnOrdinal: 1, text: "বলুন", finalized: true))
        XCTAssertNil(fallback.observeResponseBoundary(
            generation: generation,
            .turnComplete
        ).transcriptUpdate)
    }

    func testLateToolOnlyAndDelayedActivityFragmentsDoNotCreateOwnerTurns() {
        var toolOnly = AlmaLiveVoiceInputTurnReducer(generation: generation)
        XCTAssertNil(toolOnly.observeResponseBoundary(
            generation: generation,
            .toolCall
        ).transcriptUpdate)
        XCTAssertNil(toolOnly.observeInputTranscription(
            generation: generation,
            text: "late tool fragment",
            finished: true
        ).transcriptUpdate)
        XCTAssertEqual(toolOnly.currentOwnerTurnOrdinal, 0)

        var delayedActivity = AlmaLiveVoiceInputTurnReducer(generation: generation)
        _ = delayedActivity.observeInputTranscription(
            generation: generation,
            text: "সম্পূর্ণ",
            finished: true)
        _ = delayedActivity.observeResponseBoundary(generation: generation, .modelAudio)
        _ = delayedActivity.observeActivityStarted(generation: generation)
        _ = delayedActivity.observeActivityEnded(generation: generation)
        XCTAssertEqual(delayedActivity.currentOwnerTurnOrdinal, 1)
        XCTAssertNil(delayedActivity.observeInputTranscription(
            generation: generation,
            text: "late",
            finished: true
        ).transcriptUpdate)
    }

    func testQuickBargeInCreatesNewOwnerTurnAndStaleGenerationIsIgnored() {
        var reducer = AlmaLiveVoiceInputTurnReducer(generation: generation)
        _ = reducer.observeInputTranscription(
            generation: generation,
            text: "প্রথম",
            finished: true)
        _ = reducer.observeResponseBoundary(generation: generation, .modelAudio)
        _ = reducer.observeLocalBargeIn(generation: generation)

        XCTAssertEqual(reducer.observeInputTranscription(
            generation: generation,
            text: "থামো",
            finished: true
        ).transcriptUpdate, .init(turnOrdinal: 2, text: "থামো", finalized: true))
        XCTAssertNil(reducer.observeInputTranscription(
            generation: generation - 1,
            text: "stale",
            finished: true
        ).transcriptUpdate)
        XCTAssertTrue(reducer.acceptAudioFrame(
            generation: generation - 1,
            sequence: 99,
            pcm: pcm(99),
            rms: 0.030,
            route: .trustedAECOrReceiver,
            ready: true,
            suppression: .none
        ).audioFramesToSend.isEmpty)
    }

    private func pcm(_ sequence: UInt64) -> AlmaLiveVoiceCapturedInputPCM {
        AlmaLiveVoiceCapturedInputPCM(
            data: Data([UInt8(truncatingIfNeeded: sequence), 0]),
            deliveryToken: nil)
    }
}
