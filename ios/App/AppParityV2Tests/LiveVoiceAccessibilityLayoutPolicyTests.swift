import XCTest
@testable import App

final class LiveVoiceAccessibilityLayoutPolicyTests: XCTestCase {
    private typealias Policy = AlmaLiveVoiceAccessibilityLayoutPolicy

    func testVoiceOverMetadataIsCompleteOrderedAndStateful() {
        let elements: [Policy.Element] = [
            .sessionStatus(phase: .connecting, isMuted: false),
            .microphone(isMuted: false),
            .voiceSettings(selectedVoice: "Aoede"),
            .voicePreview(voiceName: "Aoede", isPlaying: false),
            .applyToCurrentCall(isEnabled: true),
            .saveForNextCall,
            .endCall,
        ]
        let descriptors = elements.map(Policy.voiceOverDescriptor)

        XCTAssertEqual(descriptors.map(\.readingOrder), [0, 10, 20, 30, 40, 50, 60])
        XCTAssertEqual(Set(descriptors.map(\.readingOrder)).count, descriptors.count)
        for descriptor in descriptors {
            XCTAssertFalse(descriptor.label.isEmpty)
            XCTAssertFalse(descriptor.hint.isEmpty)
            XCTAssertEqual(descriptor.label, descriptor.label.trimmingCharacters(in: .whitespacesAndNewlines))
            XCTAssertEqual(descriptor.hint, descriptor.hint.trimmingCharacters(in: .whitespacesAndNewlines))
        }

        XCTAssertEqual(descriptors[0].label, "লাইভ ভয়েস অবস্থা")
        XCTAssertEqual(descriptors[0].value, "সংযোগ হচ্ছে")
        XCTAssertEqual(descriptors[1].label, "মাইক্রোফোন")
        XCTAssertEqual(descriptors[1].value, "চালু")
        XCTAssertEqual(descriptors[2].value, "Aoede")
        XCTAssertEqual(descriptors[3].value, "বন্ধ")
        XCTAssertEqual(descriptors[4].value, "উপলব্ধ")
        XCTAssertNil(descriptors[5].value)
        XCTAssertNil(descriptors[6].value)
    }

    func testVoiceOverValuesDescribeEveryChangingState() {
        let phaseRows: [(Policy.SessionPhase, String)] = [
            (.connecting, "সংযোগ হচ্ছে"),
            (.listening, "শুনছি"),
            (.working, "কাজ করছি"),
            (.speaking, "বলছি"),
            (.reconnecting, "সংযোগ ফিরে আনা হচ্ছে"),
            (.ended, "কল শেষ হয়েছে"),
        ]
        for (phase, value) in phaseRows {
            XCTAssertEqual(
                Policy.voiceOverDescriptor(for: .sessionStatus(
                    phase: phase,
                    isMuted: false)).value,
                value)
        }

        XCTAssertEqual(
            Policy.voiceOverDescriptor(for: .sessionStatus(
                phase: .listening,
                isMuted: true)).value,
            "শুনছি, মাইক্রোফোন বন্ধ")
        XCTAssertEqual(
            Policy.voiceOverDescriptor(for: .sessionStatus(
                phase: .ended,
                isMuted: true)).value,
            "কল শেষ হয়েছে")

        let muted = Policy.voiceOverDescriptor(for: .microphone(isMuted: true))
        XCTAssertEqual(muted.value, "বন্ধ")
        XCTAssertEqual(muted.hint, "মাইক্রোফোন চালু হবে")

        let previewPlaying = Policy.voiceOverDescriptor(for: .voicePreview(
            voiceName: "  Kore  ",
            isPlaying: true))
        XCTAssertEqual(previewPlaying.label, "Kore ভয়েস প্রিভিউ")
        XCTAssertEqual(previewPlaying.value, "চলছে")
        XCTAssertEqual(previewPlaying.hint, "ভয়েস নমুনা বন্ধ হবে")

        let unavailable = Policy.voiceOverDescriptor(for: .applyToCurrentCall(
            isEnabled: false))
        XCTAssertEqual(unavailable.value, "অনুপলব্ধ")
        XCTAssertEqual(
            Policy.voiceOverDescriptor(for: .voiceSettings(
                selectedVoice: " \n ")).value,
            "নির্বাচিত ভয়েস")
    }

    func testAccessibilityAndLayoutMatrixHasNoUnsafePolicyBranch() {
        let viewports: [Policy.Viewport] = [
            .init(width: 402, height: 874),
            .init(width: 320, height: 568),
            .init(width: 874, height: 402),
            .init(width: 568, height: 320),
        ]
        var matrixCount = 0

        for viewport in viewports {
            for textSize in Policy.TextSize.allCases {
                for boldText in [false, true] {
                    for reduceMotion in [false, true] {
                        for reduceTransparency in [false, true] {
                            for increaseContrast in [false, true] {
                                matrixCount += 1
                                let environment = Policy.Environment(
                                    viewport: viewport,
                                    textSize: textSize,
                                    isBoldTextEnabled: boldText,
                                    isReduceMotionEnabled: reduceMotion,
                                    isReduceTransparencyEnabled: reduceTransparency,
                                    isIncreaseContrastEnabled: increaseContrast)
                                let result = Policy.presentation(for: environment)

                                XCTAssertGreaterThanOrEqual(
                                    result.geometry.minimumHitTargetPoints,
                                    44,
                                    "environment: \(environment)")
                                XCTAssertGreaterThanOrEqual(
                                    result.geometry.preferredControlDiameterPoints,
                                    result.geometry.minimumHitTargetPoints,
                                    "environment: \(environment)")
                                XCTAssertGreaterThanOrEqual(
                                    result.geometry.maximumOrbDiameterPoints,
                                    0,
                                    "environment: \(environment)")
                                XCTAssertLessThanOrEqual(
                                    result.geometry.maximumOrbDiameterPoints,
                                    result.geometry.maximumContentWidthPoints,
                                    "environment: \(environment)")
                                XCTAssertLessThanOrEqual(
                                    result.geometry.maximumContentWidthPoints
                                        + (result.geometry.outerPaddingPoints * 2),
                                    viewport.width,
                                    "environment: \(environment)")
                                XCTAssertTrue(result.typography.usesSystemMetrics)
                                XCTAssertFalse(result.typography.allowsTextCompression)
                                XCTAssertEqual(
                                    result.typography.emphasis,
                                    boldText ? .boldTextEnabled : .systemDefault)
                                XCTAssertEqual(
                                    result.motion,
                                    reduceMotion ? .staticStateChanges : .outputPCMReactive)
                                XCTAssertTrue(result.surface.isContrastSafe)
                                XCTAssertGreaterThanOrEqual(
                                    result.surface.minimumTextContrastRatio,
                                    4.5)

                                if reduceTransparency || increaseContrast {
                                    XCTAssertEqual(result.surface, .opaqueHighContrast)
                                    XCTAssertFalse(result.surface.usesTransparency)
                                } else {
                                    XCTAssertEqual(result.surface, .contrastBackedMaterial)
                                    XCTAssertTrue(result.surface.usesTransparency)
                                }

                                if textSize.isAccessibilitySize {
                                    XCTAssertEqual(result.geometry.mode, .accessibilityStacked)
                                    XCTAssertEqual(result.geometry.controlAxis, .vertical)
                                    XCTAssertNil(result.geometry.statusLineLimit)
                                    XCTAssertTrue(result.geometry.showsPersistentControlTitles)
                                    XCTAssertTrue(result.geometry.scrollsVertically)
                                    XCTAssertTrue(result.typography.allowsMultilineControlTitles)
                                } else {
                                    XCTAssertEqual(result.geometry.controlAxis, .horizontal)
                                    XCTAssertNotNil(result.geometry.statusLineLimit)
                                    XCTAssertFalse(result.geometry.showsPersistentControlTitles)
                                    XCTAssertFalse(result.typography.allowsMultilineControlTitles)
                                }
                            }
                        }
                    }
                }
            }
        }

        XCTAssertEqual(matrixCount, 768)
    }

    func testSmallScreenLandscapeAndAccessibilityGeometryAreExplicit() {
        let smallPortrait = presentation(width: 320, height: 568)
        XCTAssertEqual(smallPortrait.geometry.mode, .smallPortrait)
        XCTAssertEqual(smallPortrait.geometry.orientation, .portrait)
        XCTAssertEqual(smallPortrait.geometry.outerPaddingPoints, 12)
        XCTAssertEqual(smallPortrait.geometry.maximumOrbDiameterPoints, 160)
        XCTAssertTrue(smallPortrait.geometry.scrollsVertically)

        let regularPortrait = presentation(width: 402, height: 874)
        XCTAssertEqual(regularPortrait.geometry.mode, .regularPortrait)
        XCTAssertEqual(regularPortrait.geometry.maximumOrbDiameterPoints, 220)
        XCTAssertFalse(regularPortrait.geometry.scrollsVertically)

        let landscape = presentation(width: 874, height: 402)
        XCTAssertEqual(landscape.geometry.mode, .compactLandscape)
        XCTAssertEqual(landscape.geometry.orientation, .landscape)
        XCTAssertEqual(landscape.geometry.maximumOrbDiameterPoints, 132)
        XCTAssertFalse(landscape.geometry.scrollsVertically)

        let smallLandscape = presentation(width: 568, height: 320)
        XCTAssertEqual(smallLandscape.geometry.mode, .compactLandscape)
        XCTAssertTrue(smallLandscape.geometry.scrollsVertically)
        XCTAssertEqual(
            smallLandscape.geometry.maximumOrbDiameterPoints,
            320 * 0.36,
            accuracy: 0.000_001)

        let accessibilityLandscape = presentation(
            width: 874,
            height: 402,
            textSize: .accessibility5)
        XCTAssertEqual(accessibilityLandscape.geometry.mode, .accessibilityStacked)
        XCTAssertEqual(accessibilityLandscape.geometry.controlAxis, .vertical)
        XCTAssertEqual(accessibilityLandscape.geometry.preferredControlDiameterPoints, 56)
        XCTAssertNil(accessibilityLandscape.geometry.statusLineLimit)
        XCTAssertTrue(accessibilityLandscape.geometry.scrollsVertically)
    }

    func testViewportRejectsNonFiniteAndNegativeGeometryDeterministically() {
        let invalid = Policy.Viewport(width: .infinity, height: -20)
        XCTAssertEqual(invalid, .init(width: 0, height: 0))

        let result = Policy.presentation(for: .init(
            viewport: invalid,
            textSize: .accessibility5,
            isBoldTextEnabled: true,
            isReduceMotionEnabled: true,
            isReduceTransparencyEnabled: true,
            isIncreaseContrastEnabled: true))
        XCTAssertEqual(result.geometry.maximumContentWidthPoints, 0)
        XCTAssertEqual(result.geometry.maximumOrbDiameterPoints, 0)
        XCTAssertGreaterThanOrEqual(result.geometry.minimumHitTargetPoints, 44)
        XCTAssertTrue(result.geometry.scrollsVertically)
    }

    private func presentation(
        width: Double,
        height: Double,
        textSize: Policy.TextSize = .large
    ) -> Policy.Presentation {
        Policy.presentation(for: .init(
            viewport: .init(width: width, height: height),
            textSize: textSize,
            isBoldTextEnabled: false,
            isReduceMotionEnabled: false,
            isReduceTransparencyEnabled: false,
            isIncreaseContrastEnabled: false))
    }
}
