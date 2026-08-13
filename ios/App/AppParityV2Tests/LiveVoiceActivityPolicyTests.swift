import XCTest
@testable import App

#if canImport(ActivityKit)
import ActivityKit

@available(iOS 17.0, *)
final class LiveVoiceActivityPolicyTests: XCTestCase {
    private let startedAt = Date(timeIntervalSince1970: 1_700_000_000)

    func testPayloadContainsOnlyPrivacySafeLowFrequencyState() throws {
        let state = AlmaVoiceActivityAttributes.ContentState(
            phase: "working",
            startedAt: startedAt,
            isMuted: true)
        let payload = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: JSONEncoder().encode(state)) as? [String: Any])

        XCTAssertEqual(Set(payload.keys), ["phase", "startedAt", "isMuted"])
        XCTAssertEqual(payload["phase"] as? String, "working")
        for forbidden in [
            "transcript", "reply", "captionTail", "pcm", "levels",
            "waveform", "toolArguments", "toolResult", "businessData",
        ] {
            XCTAssertNil(payload[forbidden])
        }
    }

    func testEveryTruthfulPhaseHasDistinctStatusAndNonSyntheticIcon() {
        let expected: [(phase: String, status: String, image: String)] = [
            ("connecting", "সংযোগ হচ্ছে", "antenna.radiowaves.left.and.right"),
            ("listening", "শুনছি", "waveform"),
            ("thinking", "ভাবছি", "brain.head.profile"),
            ("working", "কাজ করছি", "gearshape.2.fill"),
            ("speaking", "বলছি", "speaker.wave.2.fill"),
            ("reconnecting", "আবার সংযোগ হচ্ছে", "arrow.triangle.2.circlepath"),
            ("ended", "শেষ হয়েছে", "checkmark.circle.fill"),
        ]

        for row in expected {
            let result = presentation(phase: row.phase, surface: .expanded)
            XCTAssertEqual(result.phase, row.phase)
            XCTAssertEqual(result.status, row.status)
            XCTAssertEqual(result.systemImage, row.image)
            if row.phase != "listening" {
                XCTAssertNotEqual(
                    result.systemImage,
                    "waveform",
                    "a non-listening phase must not imply live input motion")
            }
        }
    }

    func testStaleExplicitEndAndHardExpiryRemoveAllRunningImplications() {
        let now = startedAt.addingTimeInterval(10)
        for surface in AlmaVoiceActivityPresentationPolicy.Surface.allCases {
            let stale = presentation(
                phase: "listening",
                isStale: true,
                now: now,
                surface: surface)
            assertTerminal(stale)
            XCTAssertEqual(stale.status, "সেশন শেষ—আপডেট বন্ধ")
            XCTAssertEqual(stale.systemImage, "clock.badge.exclamationmark")

            let ended = presentation(
                phase: "ended",
                now: now,
                surface: surface)
            assertTerminal(ended)
            XCTAssertEqual(ended.systemImage, "checkmark.circle.fill")

            let expired = presentation(
                phase: "speaking",
                now: AlmaVoiceActivityPrivacyPolicy.hardExpiry(
                    startedAt: startedAt),
                surface: surface)
            assertTerminal(expired)
            XCTAssertNotEqual(expired.systemImage, "waveform")
        }
    }

    func testActivityKitStaleDeadlineSurvivesProcessTerminationAndIsHardBounded() {
        let ordinaryNow = startedAt.addingTimeInterval(60)
        XCTAssertEqual(
            AlmaVoiceActivityPrivacyPolicy.staleDate(
                now: ordinaryNow,
                startedAt: startedAt),
            ordinaryNow.addingTimeInterval(90))

        let nearExpiry = AlmaVoiceActivityPrivacyPolicy
            .hardExpiry(startedAt: startedAt)
            .addingTimeInterval(-30)
        XCTAssertEqual(
            AlmaVoiceActivityPrivacyPolicy.staleDate(
                now: nearExpiry,
                startedAt: startedAt),
            AlmaVoiceActivityPrivacyPolicy.hardExpiry(startedAt: startedAt))
        XCTAssertLessThan(
            AlmaVoiceActivityPrivacyPolicy.freshnessRefreshSeconds,
            AlmaVoiceActivityPrivacyPolicy.staleAfterSeconds)
        XCTAssertEqual(AlmaVoiceActivityPrivacyPolicy.endedDismissalSeconds, 4)
    }

    func testAllFamiliesDynamicTypeVoiceOverHitTargetsAndContrastAreSafe() {
        let phases = [
            "connecting", "listening", "thinking", "working",
            "speaking", "reconnecting", "ended",
        ]
        var rows = 0

        for surface in AlmaVoiceActivityPresentationPolicy.Surface.allCases {
            for phase in phases {
                for isAccessibilitySize in [false, true] {
                    for reduceTransparency in [false, true] {
                        for increaseContrast in [false, true] {
                            rows += 1
                            let result = presentation(
                                phase: phase,
                                surface: surface,
                                environment: .init(
                                    isAccessibilitySize: isAccessibilitySize,
                                    reduceTransparency: reduceTransparency,
                                    increaseContrast: increaseContrast))

                            XCTAssertFalse(result.accessibilityLabel.isEmpty)
                            XCTAssertFalse(result.accessibilityValue.isEmpty)
                            XCTAssertFalse(result.accessibilityHint.isEmpty)
                            XCTAssertGreaterThanOrEqual(
                                result.minimumInteractiveTarget, 44)
                            XCTAssertGreaterThanOrEqual(
                                result.minimumTextContrastRatio, 4.5)
                            XCTAssertGreaterThanOrEqual(result.backgroundOpacity, 0.86)

                            let full = surface == .lockScreen || surface == .expanded
                            XCTAssertEqual(
                                result.usesStackedLayout,
                                isAccessibilitySize && full)
                            XCTAssertEqual(
                                result.statusLineLimit == nil,
                                isAccessibilitySize && full)
                            if reduceTransparency || increaseContrast {
                                XCTAssertGreaterThanOrEqual(result.backgroundOpacity, 0.96)
                                XCTAssertGreaterThanOrEqual(
                                    result.minimumTextContrastRatio, 9.5)
                            }
                        }
                    }
                }
            }
        }

        XCTAssertEqual(rows, 224)
    }

    func testControlsExistOnlyOnSupportedActiveFamilies() {
        let lock = presentation(phase: "listening", surface: .lockScreen)
        XCTAssertTrue(lock.showsElapsedTimer)
        XCTAssertFalse(lock.showsListenAction)
        XCTAssertTrue(lock.showsEndAction)

        let expanded = presentation(phase: "working", surface: .expanded)
        XCTAssertTrue(expanded.showsElapsedTimer)
        XCTAssertTrue(expanded.showsListenAction)
        XCTAssertTrue(expanded.showsEndAction)

        for surface in [
            AlmaVoiceActivityPresentationPolicy.Surface.compact,
            .minimal,
        ] {
            let result = presentation(phase: "speaking", surface: surface)
            XCTAssertFalse(result.showsElapsedTimer)
            XCTAssertFalse(result.showsListenAction)
            XCTAssertFalse(result.showsEndAction)
        }
    }

    func testLifecycleTruthMapsWorkReconnectSuspendAndEndDeterministically() {
        typealias Truth = AlmaLiveVoiceLifecycleReducer.UITruth

        XCTAssertEqual(resolve(.init(
            session: .ready,
            work: .idle,
            isMuted: false,
            isTimerRunning: true), fallback: "connecting"), "connecting")
        XCTAssertEqual(resolve(.init(
            session: .ready,
            work: .pending(count: 2),
            isMuted: false,
            isTimerRunning: true), fallback: "speaking"), "working")
        XCTAssertEqual(resolve(.init(
            session: .reconnecting(.networkUnavailable),
            work: .pending(count: 1),
            isMuted: false,
            isTimerRunning: false), fallback: "speaking"), "reconnecting")
        XCTAssertEqual(resolve(.init(
            session: .reconnecting(.providerDisconnected),
            work: .idle,
            isMuted: false,
            isTimerRunning: false), fallback: "connecting"), "connecting")
        XCTAssertEqual(resolve(.init(
            session: .reconnecting(.providerDisconnected),
            work: .pending(count: 1),
            isMuted: false,
            isTimerRunning: false), fallback: "ended"), "ended")
        XCTAssertEqual(resolve(.init(
            session: .suspended(.deviceLocked),
            work: .idle,
            isMuted: true,
            isTimerRunning: false), fallback: "listening"), "idle")
        XCTAssertEqual(resolve(.init(
            session: .ended,
            work: .idle,
            isMuted: false,
            isTimerRunning: false), fallback: "listening"), "ended")

        func resolve(_ truth: Truth, fallback: String) -> String {
            AlmaVoiceActivityLifecyclePhasePolicy.resolve(
                truth,
                conversationalFallback: fallback)
        }
    }

    private func assertTerminal(
        _ presentation: AlmaVoiceActivityPresentationPolicy.Presentation,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(presentation.phase, "ended", file: file, line: line)
        XCTAssertFalse(presentation.showsElapsedTimer, file: file, line: line)
        XCTAssertFalse(presentation.showsListenAction, file: file, line: line)
        XCTAssertFalse(presentation.showsEndAction, file: file, line: line)
        XCTAssertFalse(
            presentation.systemImage.contains("waveform"),
            file: file,
            line: line)
        XCTAssertEqual(
            presentation.accessibilityHint,
            "সেশনটি আর চলছে না",
            file: file,
            line: line)
    }

    private func presentation(
        phase: String,
        isMuted: Bool = false,
        isStale: Bool = false,
        now: Date? = nil,
        surface: AlmaVoiceActivityPresentationPolicy.Surface,
        environment: AlmaVoiceActivityPresentationPolicy.Environment = .init(
            isAccessibilitySize: false,
            reduceTransparency: false,
            increaseContrast: false)
    ) -> AlmaVoiceActivityPresentationPolicy.Presentation {
        AlmaVoiceActivityPresentationPolicy.presentation(
            phase: phase,
            isMuted: isMuted,
            startedAt: startedAt,
            isStale: isStale,
            now: now ?? startedAt.addingTimeInterval(10),
            surface: surface,
            environment: environment)
    }
}
#endif
