import XCTest
@testable import App

final class LiveVoiceOutputPCMEnvelopeTests: XCTestCase {
    private typealias Reducer = AlmaLiveVoiceOutputPCMEnvelopeReducer
    private let generation: UInt64 = 41

    func testProviderReceiptWithoutLocalRenderKeepsEnvelopeAtZero() throws {
        var reducer = try makeReducer()

        let receipt = reducer.reduce(.init(
            generation: generation,
            event: .providerPCMReceived(
                buffer(repeating: Int16.max, count: 480))))

        XCTAssertEqual(receipt.outcome, .applied)
        XCTAssertEqual(receipt.measuredRMS, 0)
        XCTAssertEqual(receipt.targetLevel, 0)
        XCTAssertEqual(receipt.level, 0)
        XCTAssertEqual(reducer.phase, .listening)
        XCTAssertEqual(
            reducer.presentation(reduceMotion: false).semantics,
            .calm)
    }

    func testEnvelopeMeasuresLocallyRenderedPCMProgress() throws {
        var quiet = try makeReducer()
        var loud = try makeReducer()
        enterSpeaking(&quiet)
        enterSpeaking(&loud)

        let quietTransition = quiet.reduce(.init(
            generation: generation,
            event: .renderedPCM(buffer(repeating: 1_638, count: 480))))
        let loudTransition = loud.reduce(.init(
            generation: generation,
            event: .renderedPCM(buffer(repeating: 9_830, count: 480))))

        XCTAssertEqual(quietTransition.outcome, .applied)
        XCTAssertEqual(loudTransition.outcome, .applied)
        XCTAssertEqual(quietTransition.measuredRMS, 1_638.0 / 32_768.0, accuracy: 0.000_001)
        XCTAssertEqual(loudTransition.measuredRMS, 9_830.0 / 32_768.0, accuracy: 0.000_001)
        XCTAssertGreaterThan(loudTransition.targetLevel, quietTransition.targetLevel)
        XCTAssertGreaterThan(loudTransition.level, quietTransition.level)
    }

    func testSilenceSettlesAndListeningIsImmediatelyCalm() throws {
        var reducer = try makeReducer()
        enterSpeaking(&reducer)
        _ = reducer.reduce(.init(
            generation: generation,
            event: .renderedPCM(buffer(repeating: 12_000, count: 480))))

        let silence = reducer.reduce(.init(
            generation: generation,
            event: .renderedPCM(buffer(repeating: 0, count: 48_000))))
        XCTAssertEqual(silence.measuredRMS, 0)
        XCTAssertEqual(silence.targetLevel, 0)
        XCTAssertLessThan(silence.level, 0.001)
        XCTAssertEqual(reducer.presentation(reduceMotion: false).semantics, .calm)

        _ = reducer.reduce(.init(
            generation: generation,
            event: .renderedPCM(buffer(repeating: 12_000, count: 480))))
        XCTAssertGreaterThan(reducer.level, 0)
        let listening = reducer.reduce(.init(
            generation: generation,
            event: .phaseChanged(.listening)))

        XCTAssertEqual(listening.level, 0)
        XCTAssertEqual(listening.targetLevel, 0)
        XCTAssertEqual(reducer.presentation(reduceMotion: false), .init(
            level: 0,
            scale: 1,
            semantics: .calm))
        let ignoredPCM = reducer.reduce(.init(
            generation: generation,
            event: .renderedPCM(buffer(repeating: 12_000, count: 480))))
        XCTAssertEqual(ignoredPCM.outcome, .ignored(.outputWhileListening))
        XCTAssertEqual(ignoredPCM.level, 0)
    }

    func testStaleGenerationCannotMutateCurrentEnvelope() throws {
        var reducer = try makeReducer()
        enterSpeaking(&reducer)
        let before = reducer

        let stale = reducer.reduce(.init(
            generation: generation - 1,
            event: .renderedPCM(buffer(repeating: Int16.max, count: 480))))

        XCTAssertEqual(stale.outcome, .ignored(.generationMismatch))
        XCTAssertFalse(stale.mayApplyEffects)
        XCTAssertEqual(stale.level, 0)
        XCTAssertEqual(reducer, before)
    }

    func testMixerRenderMeasurementUsesRenderedDuration() throws {
        let configuration = Reducer.Configuration(
            silenceFloorRMS: 0,
            visualGain: 1,
            attackTimeSeconds: 0.25,
            releaseTimeSeconds: 0.50,
            zeroSnapLevel: 0)
        var reducer = try XCTUnwrap(Reducer(
            generation: generation,
            configuration: configuration))
        enterSpeaking(&reducer)

        let rendered = reducer.reduce(.init(
            generation: generation,
            event: .renderedPCMMeasured(.init(
                rms: 0.5,
                durationSeconds: 0.25))))

        XCTAssertEqual(rendered.outcome, .applied)
        XCTAssertEqual(rendered.measuredRMS, 0.5)
        XCTAssertEqual(rendered.targetLevel, 0.5)
        XCTAssertEqual(rendered.level, 0.5 * (1 - exp(-1)), accuracy: 0.000_000_1)
    }

    func testAttackReleaseSmoothingIsDeterministicAndReduceMotionIsStatic() throws {
        let configuration = Reducer.Configuration(
            silenceFloorRMS: 0,
            visualGain: 1,
            attackTimeSeconds: 0.25,
            releaseTimeSeconds: 0.50,
            zeroSnapLevel: 0)
        var first = try XCTUnwrap(Reducer(
            generation: generation,
            configuration: configuration))
        var second = first
        enterSpeaking(&first)
        enterSpeaking(&second)

        let loud = buffer(repeating: Int16.max, count: 1, sampleRate: 4)
        let silence = buffer(repeating: 0, count: 1, sampleRate: 4)
        let firstAttack = first.reduce(.init(
            generation: generation,
            event: .renderedPCM(loud)))
        let secondAttack = second.reduce(.init(
            generation: generation,
            event: .renderedPCM(loud)))
        let firstRelease = first.reduce(.init(
            generation: generation,
            event: .renderedPCM(silence)))
        let secondRelease = second.reduce(.init(
            generation: generation,
            event: .renderedPCM(silence)))

        let target = Double(Int16.max) / 32_768.0
        let expectedAttack = target * (1 - exp(-1))
        let expectedRelease = expectedAttack * exp(-0.5)
        XCTAssertEqual(firstAttack.level, expectedAttack, accuracy: 0.000_000_1)
        XCTAssertEqual(firstRelease.level, expectedRelease, accuracy: 0.000_000_1)
        XCTAssertEqual(firstAttack, secondAttack)
        XCTAssertEqual(firstRelease, secondRelease)

        let reactive = first.presentation(reduceMotion: false)
        let reduced = first.presentation(reduceMotion: true)
        let reducedAtDifferentAmplitude = Reducer.presentation(
            level: 0.95,
            phase: .speaking,
            reduceMotion: true)
        XCTAssertEqual(reactive.semantics, .reactive)
        XCTAssertTrue(reactive.allowsSpatialAnimation)
        XCTAssertGreaterThan(reactive.scale, 1)
        XCTAssertEqual(reduced.semantics, .staticSpeaking)
        XCTAssertFalse(reduced.allowsSpatialAnimation)
        XCTAssertEqual(reduced.scale, 1)
        XCTAssertEqual(reduced.level, 0.35)
        XCTAssertEqual(reducedAtDifferentAmplitude, reduced)
    }

    private func makeReducer(
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws -> Reducer {
        try XCTUnwrap(Reducer(generation: generation), file: file, line: line)
    }

    private func enterSpeaking(
        _ reducer: inout Reducer,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let transition = reducer.reduce(.init(
            generation: generation,
            event: .phaseChanged(.speaking)))
        XCTAssertEqual(transition.outcome, .applied, file: file, line: line)
    }

    private func buffer(
        repeating sample: Int16,
        count: Int,
        sampleRate: Double = 24_000
    ) -> Reducer.PCM16LEBuffer {
        let littleEndianSamples = Array(repeating: sample.littleEndian, count: count)
        let data = littleEndianSamples.withUnsafeBytes { Data($0) }
        return Reducer.PCM16LEBuffer(data: data, sampleRate: sampleRate)
    }
}
