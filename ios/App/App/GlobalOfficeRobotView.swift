//
//  GlobalOfficeRobotView.swift
//  ALMA ERP
//
//  A small, self-contained Office Robot control for the app-wide overlay.
//  The owning shell supplies state and navigation actions; this view owns only
//  sprite playback and one-shot presentation effects.
//

import Combine
import SwiftUI
import UIKit

@available(iOS 17.0, *)
struct OfficeRobotPetButton: View {
    let isCallActive: Bool
    let taskCount: Int
    let completionToken: Int
    let reduceMotion: Bool
    let isVisible: Bool
    let onTap: () -> Void
    let onLongPress: () -> Void

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.scenePhase) private var scenePhase

    @State private var row = 0
    @State private var column = 0
    @State private var lift: CGFloat = 0
    @State private var robotScale: CGFloat = 1
    @State private var isCelebrating = false
    @State private var isLowPowerMode: Bool
    @State private var lastHandledCompletionToken: Int
    @State private var pendingCompletionToken: Int?
    @State private var pendingCompletionShouldEmitHaptic = true
    @State private var playbackTask: Task<Void, Never>?
    @State private var playbackGeneration = UUID()

    private struct SpriteBeat {
        let row: Int
        let column: Int
        let milliseconds: Int
    }

    private struct PlaybackContext: Equatable {
        let motionAllowed: Bool
        let isVisible: Bool
        let isSceneActive: Bool
    }

    // Codex companion cadence: a quiet 6.6-second breathing/blinking cycle.
    private static let idleBeats = [
        SpriteBeat(row: 0, column: 0, milliseconds: 1_680),
        SpriteBeat(row: 0, column: 1, milliseconds: 660),
        SpriteBeat(row: 0, column: 2, milliseconds: 660),
        SpriteBeat(row: 0, column: 3, milliseconds: 840),
        SpriteBeat(row: 0, column: 4, milliseconds: 840),
        SpriteBeat(row: 0, column: 5, milliseconds: 1_920),
    ]

    private static let celebrationBeats = (0..<5).map {
        SpriteBeat(row: 4, column: $0, milliseconds: $0 == 4 ? 260 : 140)
    }

    init(
        isCallActive: Bool,
        taskCount: Int,
        completionToken: Int,
        reduceMotion: Bool,
        isVisible: Bool = true,
        onTap: @escaping () -> Void,
        onLongPress: @escaping () -> Void
    ) {
        self.isCallActive = isCallActive
        self.taskCount = taskCount
        self.completionToken = completionToken
        self.reduceMotion = reduceMotion
        self.isVisible = isVisible
        self.onTap = onTap
        self.onLongPress = onLongPress
        _isLowPowerMode = State(initialValue: ProcessInfo.processInfo.isLowPowerModeEnabled)
        _lastHandledCompletionToken = State(initialValue: completionToken)
    }

    private var motionAllowed: Bool {
        !reduceMotion
            && !systemReduceMotion
            && !isLowPowerMode
            && isVisible
            && scenePhase == .active
    }

    private var normalizedTaskCount: Int { max(0, taskCount) }

    private var playbackContext: PlaybackContext {
        PlaybackContext(
            motionAllowed: motionAllowed,
            isVisible: isVisible,
            isSceneActive: scenePhase == .active
        )
    }

    private var accessibilityValue: String {
        var parts: [String] = []
        if isCallActive { parts.append("কল চলছে") }
        if normalizedTaskCount > 0 {
            parts.append("\(normalizedTaskCount)টি আপডেট")
        }
        if parts.isEmpty { parts.append("প্রস্তুত") }
        return parts.joined(separator: ", ")
    }

    var body: some View {
        ZStack {
            callHalo

            Ellipse()
                .fill(.black.opacity(0.18))
                .frame(width: 30, height: 4)
                .blur(radius: 2)
                .scaleEffect(x: lift < 0 ? 0.66 : 1)
                .opacity(lift < 0 ? 0.30 : 0.62)
                .offset(y: 24)

            OfficeRobotSpriteFrame(row: row, column: column)
                .frame(width: 52, height: 56.34)
                .scaleEffect(robotScale)
                .offset(y: lift - 2)
                .shadow(
                    color: isCallActive
                        ? Color(red: 0.20, green: 0.84, blue: 0.67).opacity(0.34)
                        : Color(red: 0.49, green: 0.30, blue: 1.0).opacity(0.24),
                    radius: 5,
                    y: 2
                )

            if normalizedTaskCount > 0 {
                Text(normalizedTaskCount > 99 ? "99+" : "\(normalizedTaskCount)")
                    .font(.system(size: normalizedTaskCount > 99 ? 8 : 10, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .padding(.horizontal, normalizedTaskCount > 9 ? 5 : 4)
                    .frame(minWidth: 20, minHeight: 20)
                    .background(Color(red: 0.88, green: 0.31, blue: 0.25), in: Capsule())
                    .overlay(Capsule().strokeBorder(.white.opacity(0.72), lineWidth: 1))
                    .shadow(color: .black.opacity(0.22), radius: 3, y: 1)
                    .offset(x: 25, y: -24)
                    .accessibilityHidden(true)
            }

            if isCallActive {
                Image(systemName: "phone.fill")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 18, height: 18)
                    .background(Color(red: 0.18, green: 0.72, blue: 0.47), in: Circle())
                    .overlay(Circle().strokeBorder(.white.opacity(0.74), lineWidth: 1))
                    .shadow(color: .black.opacity(0.20), radius: 3, y: 1)
                    .offset(x: -24, y: 24)
                    .accessibilityHidden(true)
            }
        }
        .frame(width: 68, height: 68)
        .contentShape(Circle())
        .gesture(interactionGesture)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("ALMA Office Robot")
        .accessibilityValue(accessibilityValue)
        .accessibilityHint("ট্যাপ করলে খুলবে, লং প্রেস করলে আরও অপশন দেখাবে")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onTap() }
        .accessibilityAction(named: Text("আরও অপশন")) { onLongPress() }
        .onAppear {
            isLowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
            restartPlayback()
        }
        .onDisappear {
            if isCelebrating {
                pendingCompletionToken = lastHandledCompletionToken
                pendingCompletionShouldEmitHaptic = false
            }
            playbackGeneration = UUID()
            playbackTask?.cancel()
            playbackTask = nil
            isCelebrating = false
            lift = 0
            robotScale = 1
        }
        .onChange(of: playbackContext) { _, _ in
            restartPlayback()
        }
        .onChange(of: completionToken) { _, newValue in
            handleCompletion(newValue)
        }
        .onReceive(
            NotificationCenter.default.publisher(
                for: .NSProcessInfoPowerStateDidChange
            )
        ) { _ in
            isLowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
        }
    }

    private var interactionGesture: some Gesture {
        LongPressGesture(minimumDuration: 0.55)
            .exclusively(before: TapGesture())
            .onEnded { result in
                switch result {
                case .first(true):
                    onLongPress()
                case .second:
                    onTap()
                default:
                    break
                }
            }
    }

    @ViewBuilder
    private var callHalo: some View {
        if isCallActive {
            TimelineView(.animation(
                minimumInterval: 1.0 / 20.0,
                paused: !motionAllowed
            )) { timeline in
                let elapsed = timeline.date.timeIntervalSinceReferenceDate
                let wave = motionAllowed
                    ? 0.5 + 0.5 * sin(elapsed * .pi * 2 / 1.8)
                    : 0.5

                Circle()
                    .stroke(
                        Color(red: 0.20, green: 0.84, blue: 0.67)
                            .opacity(0.22 + wave * 0.28),
                        lineWidth: 2
                    )
                    .frame(width: 61, height: 61)
                    .scaleEffect(0.93 + wave * 0.09)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    private func handleCompletion(_ token: Int) {
        guard token != lastHandledCompletionToken else { return }
        lastHandledCompletionToken = token

        guard scenePhase == .active, isVisible else {
            pendingCompletionToken = token
            pendingCompletionShouldEmitHaptic = true
            return
        }
        playCompletionCelebration(emitHaptic: true)
    }

    private func restartPlayback() {
        if isCelebrating {
            pendingCompletionToken = lastHandledCompletionToken
            // Resuming or adapting the same reaction must not repeat the
            // success haptic.
            pendingCompletionShouldEmitHaptic = false
        }

        playbackGeneration = UUID()
        playbackTask?.cancel()
        playbackTask = nil
        isCelebrating = false
        lift = 0
        robotScale = 1

        if pendingCompletionToken != nil, scenePhase == .active, isVisible {
            pendingCompletionToken = nil
            let emitHaptic = pendingCompletionShouldEmitHaptic
            pendingCompletionShouldEmitHaptic = true
            playCompletionCelebration(emitHaptic: emitHaptic)
            return
        }

        guard motionAllowed else {
            row = 0
            column = 0
            return
        }
        startIdlePlayback()
    }

    private func startIdlePlayback() {
        playbackTask?.cancel()
        guard motionAllowed, !isCelebrating else { return }

        let generation = UUID()
        playbackGeneration = generation
        playbackTask = Task { @MainActor in
            while !Task.isCancelled {
                for beat in Self.idleBeats {
                    guard !Task.isCancelled,
                          playbackGeneration == generation,
                          motionAllowed,
                          !isCelebrating
                    else { return }
                    row = beat.row
                    column = beat.column
                    do {
                        try await Task.sleep(for: .milliseconds(beat.milliseconds))
                    } catch {
                        return
                    }
                }
            }
        }
    }

    private func playCompletionCelebration(emitHaptic: Bool) {
        playbackGeneration = UUID()
        playbackTask?.cancel()
        playbackTask = nil
        isCelebrating = true

        if emitHaptic {
            let feedback = UINotificationFeedbackGenerator()
            feedback.prepare()
            feedback.notificationOccurred(.success)
        }

        guard motionAllowed else {
            row = 4
            column = 4
            let generation = UUID()
            playbackGeneration = generation
            playbackTask = Task { @MainActor in
                do {
                    try await Task.sleep(for: .milliseconds(420))
                } catch {
                    return
                }
                guard playbackGeneration == generation else { return }
                row = 0
                column = 0
                isCelebrating = false
                playbackTask = nil
            }
            return
        }

        withAnimation(.easeOut(duration: 0.18)) {
            lift = -9
            robotScale = 1.07
        }

        let generation = UUID()
        playbackGeneration = generation
        playbackTask = Task { @MainActor in
            var beatNumber = 0
            for _ in 0..<3 {
                for beat in Self.celebrationBeats {
                    guard !Task.isCancelled,
                          playbackGeneration == generation
                    else { return }
                    row = beat.row
                    column = beat.column
                    beatNumber += 1

                    if beatNumber == 3 {
                        withAnimation(.spring(response: 0.34, dampingFraction: 0.56)) {
                            lift = 0
                            robotScale = 1
                        }
                    }

                    do {
                        try await Task.sleep(for: .milliseconds(beat.milliseconds))
                    } catch {
                        return
                    }
                }
            }

            guard !Task.isCancelled,
                  playbackGeneration == generation
            else { return }
            row = 0
            column = 0
            lift = 0
            robotScale = 1
            isCelebrating = false
            playbackTask = nil
            startIdlePlayback()
        }
    }
}

@available(iOS 17.0, *)
private struct OfficeRobotSpriteFrame: View {
    let row: Int
    let column: Int

    var body: some View {
        if let frame = OfficeRobotFrameStore.image(row: row, column: column) {
            Image(uiImage: frame)
                .resizable()
                .interpolation(.none)
        } else {
            Image(systemName: "sparkles")
                .resizable()
                .scaledToFit()
                .foregroundStyle(Color(red: 0.49, green: 0.30, blue: 1.0))
                .padding(15)
        }
    }
}

@available(iOS 17.0, *)
private enum OfficeRobotFrameStore {
    private static let sheetColumns = 8
    private static let sheetRows = 11
    private static let requiredFrames: [(row: Int, columns: Range<Int>)] = [
        (0, 0..<6),
        (4, 0..<5),
    ]

    // Crop once, then switch small frames. This avoids scaling the full atlas for
    // every idle beat while preserving the original pixel-art interpolation.
    private static let frames: [Int: UIImage] = {
        guard let source = UIImage(named: "CodexPetSpritesheet")?.cgImage else {
            return [:]
        }
        let frameWidth = source.width / sheetColumns
        let frameHeight = source.height / sheetRows
        var result: [Int: UIImage] = [:]

        for required in requiredFrames {
            for column in required.columns {
                let rect = CGRect(
                    x: CGFloat(column * frameWidth),
                    y: CGFloat(required.row * frameHeight),
                    width: CGFloat(frameWidth),
                    height: CGFloat(frameHeight)
                )
                guard let crop = source.cropping(to: rect) else { continue }
                result[required.row * sheetColumns + column] = UIImage(cgImage: crop)
            }
        }
        return result
    }()

    static func image(row: Int, column: Int) -> UIImage? {
        frames[row * sheetColumns + column]
    }
}
