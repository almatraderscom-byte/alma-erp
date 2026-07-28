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

enum OfficeRobotDragDirection: Equatable {
    case left
    case right

    var runningSpriteRow: Int {
        switch self {
        case .left: 2
        case .right: 1
        }
    }

    var horizontalSign: CGFloat {
        switch self {
        case .left: -1
        case .right: 1
        }
    }
}

@available(iOS 17.0, *)
struct OfficeRobotPetButton: View {
    let isCallActive: Bool
    let taskCount: Int
    let completionToken: Int
    let reduceMotion: Bool
    let isVisible: Bool
    let isDragging: Bool
    let dragDirection: OfficeRobotDragDirection
    let onTap: () -> Void
    let onLongPress: () -> Void

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

    @State private var row = 0
    @State private var column = 0
    @State private var lift: CGFloat = 0
    @State private var robotScale: CGFloat = 1
    @State private var ambientOffsetX: CGFloat = 0
    @State private var ambientRotationDegrees: Double = 0
    @State private var isCelebrating = false
    @State private var isAppActive = false
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
        let offsetX: CGFloat
        let rotationDegrees: Double

        init(
            row: Int,
            column: Int,
            milliseconds: Int,
            offsetX: CGFloat = 0,
            rotationDegrees: Double = 0
        ) {
            self.row = row
            self.column = column
            self.milliseconds = milliseconds
            self.offsetX = offsetX
            self.rotationDegrees = rotationDegrees
        }
    }

    private struct PlaybackContext: Equatable {
        let motionAllowed: Bool
        let isVisible: Bool
        let isAppActive: Bool
        let isDragging: Bool
        let dragDirection: OfficeRobotDragDirection
    }

    // Short, intermittent micro-actions feel alive without becoming distracting.
    // Rows 9 and 10 contain the atlas's real right/left head-turn poses.
    private static let blinkBeats = [
        SpriteBeat(row: 0, column: 1, milliseconds: 115),
        SpriteBeat(row: 0, column: 0, milliseconds: 180),
    ]

    private static let doubleBlinkBeats = [
        SpriteBeat(row: 0, column: 1, milliseconds: 100),
        SpriteBeat(row: 0, column: 0, milliseconds: 125),
        SpriteBeat(row: 0, column: 1, milliseconds: 100),
        SpriteBeat(row: 0, column: 0, milliseconds: 210),
    ]

    private static let lookRightBeats = [
        SpriteBeat(row: 9, column: 1, milliseconds: 180, offsetX: 0.5, rotationDegrees: 0.7),
        SpriteBeat(row: 9, column: 2, milliseconds: 720, offsetX: 1.2, rotationDegrees: 1.2),
        SpriteBeat(row: 9, column: 1, milliseconds: 180, offsetX: 0.5, rotationDegrees: 0.7),
        SpriteBeat(row: 0, column: 0, milliseconds: 260),
    ]

    private static let lookLeftBeats = [
        SpriteBeat(row: 10, column: 7, milliseconds: 180, offsetX: -0.5, rotationDegrees: -0.7),
        SpriteBeat(row: 10, column: 6, milliseconds: 720, offsetX: -1.2, rotationDegrees: -1.2),
        SpriteBeat(row: 10, column: 7, milliseconds: 180, offsetX: -0.5, rotationDegrees: -0.7),
        SpriteBeat(row: 0, column: 0, milliseconds: 260),
    ]

    private static let swayBeats = [
        SpriteBeat(row: 0, column: 0, milliseconds: 420, offsetX: -1.1, rotationDegrees: -1.0),
        SpriteBeat(row: 0, column: 0, milliseconds: 560, offsetX: 1.1, rotationDegrees: 1.0),
        SpriteBeat(row: 0, column: 0, milliseconds: 420),
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
        isDragging: Bool = false,
        dragDirection: OfficeRobotDragDirection = .right,
        onTap: @escaping () -> Void,
        onLongPress: @escaping () -> Void
    ) {
        self.isCallActive = isCallActive
        self.taskCount = taskCount
        self.completionToken = completionToken
        self.reduceMotion = reduceMotion
        self.isVisible = isVisible
        self.isDragging = isDragging
        self.dragDirection = dragDirection
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
            && isAppActive
    }

    private var normalizedTaskCount: Int { max(0, taskCount) }

    private var playbackContext: PlaybackContext {
        PlaybackContext(
            motionAllowed: motionAllowed,
            isVisible: isVisible,
            isAppActive: isAppActive,
            isDragging: isDragging,
            dragDirection: dragDirection
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
                .rotationEffect(.degrees(ambientRotationDegrees))
                .offset(x: ambientOffsetX, y: lift - 2)
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
            isAppActive = UIApplication.shared.applicationState == .active
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
            ambientOffsetX = 0
            ambientRotationDegrees = 0
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
        .onReceive(
            NotificationCenter.default.publisher(
                for: UIApplication.didBecomeActiveNotification
            )
        ) { _ in
            isAppActive = true
        }
        .onReceive(
            NotificationCenter.default.publisher(
                for: UIApplication.willResignActiveNotification
            )
        ) { _ in
            isAppActive = false
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

        guard isAppActive, isVisible, !isDragging else {
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
        ambientOffsetX = 0
        ambientRotationDegrees = 0

        if pendingCompletionToken != nil, isAppActive, isVisible, !isDragging {
            pendingCompletionToken = nil
            let emitHaptic = pendingCompletionShouldEmitHaptic
            pendingCompletionShouldEmitHaptic = true
            playCompletionCelebration(emitHaptic: emitHaptic)
            return
        }

        if isDragging {
            row = dragDirection.runningSpriteRow
            column = 0
            guard motionAllowed else { return }
            startDragPlayback()
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
                row = 0
                column = 0
                withAnimation(.easeInOut(duration: 0.24)) {
                    ambientOffsetX = 0
                    ambientRotationDegrees = 0
                }

                do {
                    try await Task.sleep(
                        for: .milliseconds(Int.random(in: 1_600...3_600))
                    )
                } catch {
                    return
                }

                let beats = Self.idleAction(for: Int.random(in: 0..<10))
                for beat in beats {
                    guard !Task.isCancelled,
                          playbackGeneration == generation,
                          motionAllowed,
                          !isDragging,
                          !isCelebrating
                    else { return }
                    row = beat.row
                    column = beat.column
                    withAnimation(.easeInOut(duration: min(0.34, Double(beat.milliseconds) / 1_000 * 0.72))) {
                        ambientOffsetX = beat.offsetX
                        ambientRotationDegrees = beat.rotationDegrees
                    }
                    do {
                        try await Task.sleep(for: .milliseconds(beat.milliseconds))
                    } catch {
                        return
                    }
                }
            }
        }
    }

    private static func idleAction(for roll: Int) -> [SpriteBeat] {
        switch roll {
        case 0...3:
            return blinkBeats
        case 4:
            return doubleBlinkBeats
        case 5...6:
            return lookRightBeats
        case 7...8:
            return lookLeftBeats
        default:
            return swayBeats
        }
    }

    private func startDragPlayback() {
        playbackTask?.cancel()
        guard motionAllowed, isDragging, !isCelebrating else { return }

        let generation = UUID()
        let direction = dragDirection
        playbackGeneration = generation
        playbackTask = Task { @MainActor in
            while !Task.isCancelled {
                for frame in 0..<8 {
                    guard !Task.isCancelled,
                          playbackGeneration == generation,
                          motionAllowed,
                          isDragging,
                          dragDirection == direction,
                          !isCelebrating
                    else { return }
                    row = direction.runningSpriteRow
                    column = frame
                    withAnimation(.linear(duration: 0.07)) {
                        ambientOffsetX = direction.horizontalSign * 1.2
                        ambientRotationDegrees = direction.horizontalSign * 0.8
                    }
                    do {
                        try await Task.sleep(for: .milliseconds(82))
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
        ambientOffsetX = 0
        ambientRotationDegrees = 0

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
            ambientOffsetX = 0
            ambientRotationDegrees = 0
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
        (1, 0..<8),
        (2, 0..<8),
        (4, 0..<5),
        (9, 1..<3),
        (10, 6..<8),
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
