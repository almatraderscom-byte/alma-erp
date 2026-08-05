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
struct OfficeRobotTaskTray: View {
    @ObservedObject var store: GlobalOfficeRobotStore
    let onOpenItem: (GlobalOfficeRobotStore.TaskItem) -> Void
    let onOfficeChat: () -> Void
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            List {
                if store.items.isEmpty {
                    Section {
                        ContentUnavailableView(
                            "কোনো Agent update নেই",
                            systemImage: "checkmark.circle",
                            description: Text("নতুন কাজ বা approval এলে Robot এখানে দেখাবে।")
                        )
                        .listRowBackground(Color.clear)
                    }
                } else {
                    Section {
                        ForEach(store.items) { item in
                            Button {
                                onOpenItem(item)
                            } label: {
                                HStack(alignment: .top, spacing: 12) {
                                    Image(systemName: item.systemImage)
                                        .font(.system(size: 16, weight: .semibold))
                                        .foregroundStyle(tint(for: item.status))
                                        .frame(width: 32, height: 32)
                                        .background(
                                            tint(for: item.status).opacity(0.13),
                                            in: RoundedRectangle(cornerRadius: 9)
                                        )
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(item.title)
                                            .font(.body.weight(.semibold))
                                            .foregroundStyle(.primary)
                                            .lineLimit(2)
                                        Text("\(item.statusLabel) · \(item.detail)")
                                            .font(.footnote)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(3)
                                    }
                                    Spacer(minLength: 4)
                                    Image(systemName: "chevron.right")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.tertiary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                if item.dismissible {
                                    Button("সরান", role: .destructive) {
                                        store.dismiss(item)
                                    }
                                }
                            }
                            .accessibilityHint(
                                item.conversationId == nil
                                    ? "Agent খুলবে"
                                    : "সঠিক Agent conversation খুলবে"
                            )
                        }
                    } header: {
                        Text("Agent কাজ ও notification")
                    } footer: {
                        Text("Badge-এ শুধু চলমান কাজ ও আপনার attention দরকার এমন item গোনা হয়। শেষ হওয়া item swipe করে সরানো যায়।")
                    }
                }

                Section("দ্রুত অ্যাকশন") {
                    Button(action: onOfficeChat) {
                        Label("Office Chat", systemImage: "bubble.left.and.bubble.right.fill")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Robot updates")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("বন্ধ করুন", action: onClose)
                }
            }
        }
    }

    private func tint(for status: String) -> Color {
        switch status {
        case "running": return .blue
        case "attention": return .orange
        case "completed": return .green
        case "failed": return .red
        default: return .secondary
        }
    }
}

@available(iOS 17.0, *)
private struct OfficeRobotPendingPopover: View {
    let items: [GlobalOfficeRobotStore.TaskItem]
    let onCollapse: () -> Void
    let onOpen: (GlobalOfficeRobotStore.TaskItem) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Pending actions")
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                    Text("\(items.count)টি সিদ্ধান্ত আপনার অপেক্ষায়")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button(action: onCollapse) {
                    Image(systemName: "chevron.up")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.primary)
                        .frame(width: 30, height: 30)
                        .background(.thinMaterial, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Pending action তালিকা বন্ধ করুন")
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 13)

            Divider().opacity(0.55)

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        Button {
                            onOpen(item)
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Text("\(index + 1)")
                                    .font(.system(size: 11, weight: .bold, design: .rounded))
                                    .foregroundStyle(.white)
                                    .frame(width: 24, height: 24)
                                    .background(Color.orange, in: Circle())

                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item.title)
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    Text(item.detail)
                                        .font(.system(size: 11.5, weight: .medium))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                                Spacer(minLength: 6)
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(.tertiary)
                                    .padding(.top, 7)
                            }
                            .contentShape(Rectangle())
                            .padding(.horizontal, 15)
                            .padding(.vertical, 11)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(
                            "\(index + 1)। \(item.title)। \(item.detail)। action নিতে খুলুন"
                        )

                        if index < items.count - 1 {
                            Divider().padding(.leading, 49)
                        }
                    }
                }
            }
            .frame(maxHeight: 264)
        }
        .frame(width: 322)
        .background(.regularMaterial)
        .accessibilityElement(children: .contain)
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
    let isDockedRight: Bool
    let pendingItems: [GlobalOfficeRobotStore.TaskItem]
    let transientHeadlineItem: GlobalOfficeRobotStore.TaskItem?
    let approvalReaction: GlobalOfficeRobotStore.ApprovalReaction?
    let onTap: () -> Void
    let onLongPress: () -> Void
    let onDragChanged: (CGSize) -> Void
    let onDragEnded: (CGSize, CGFloat) -> Void
    let onOpenPendingItem: (GlobalOfficeRobotStore.TaskItem) -> Void

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

    @State private var row = 0
    @State private var column = 0
    @State private var lift: CGFloat = 0
    @State private var robotScale: CGFloat = 1
    @State private var approvalScaleY: CGFloat = 1
    @State private var approvalGlitchAmount: CGFloat = 0
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
    @State private var isPendingExpanded = false

    private struct SpriteBeat {
        let row: Int
        let column: Int
        let milliseconds: Int
        let offsetX: CGFloat
        let offsetY: CGFloat
        let rotationDegrees: Double
        let scaleY: CGFloat
        let glitch: CGFloat

        init(
            row: Int,
            column: Int,
            milliseconds: Int,
            offsetX: CGFloat = 0,
            offsetY: CGFloat = 0,
            rotationDegrees: Double = 0,
            scaleY: CGFloat = 1,
            glitch: CGFloat = 0
        ) {
            self.row = row
            self.column = column
            self.milliseconds = milliseconds
            self.offsetX = offsetX
            self.offsetY = offsetY
            self.rotationDegrees = rotationDegrees
            self.scaleY = scaleY
            self.glitch = glitch
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
    private static let processingBeats = (0..<6).map {
        SpriteBeat(row: 7, column: $0, milliseconds: 170)
    }
    private static let approvalSuccessBeats =
        (0..<5).map { SpriteBeat(row: 4, column: $0, milliseconds: 135) }
        + (0..<4).map { SpriteBeat(row: 3, column: $0, milliseconds: 185) }
    /// Reject result: a brief confused glitch, disappointed left/right head
    /// shake, then a visibly slumped hold. Row 5 already owns the expression;
    /// never draw a second pair of eyes over the sprite's face.
    private static let rejectBeats = [
        SpriteBeat(row: 5, column: 0, milliseconds: 90,
                   offsetX: -3.6, offsetY: 0.5, rotationDegrees: -5.5,
                   scaleY: 0.98, glitch: 1),
        SpriteBeat(row: 5, column: 1, milliseconds: 82,
                   offsetX: 4.2, offsetY: 0.8, rotationDegrees: 6.2,
                   scaleY: 0.97, glitch: 0.72),
        SpriteBeat(row: 5, column: 2, milliseconds: 96,
                   offsetX: -3.1, offsetY: 1.2, rotationDegrees: -5.0,
                   scaleY: 0.95, glitch: 0.88),
        SpriteBeat(row: 5, column: 3, milliseconds: 110,
                   offsetX: 2.5, offsetY: 1.8, rotationDegrees: 4.1,
                   scaleY: 0.93, glitch: 0.38),
        SpriteBeat(row: 5, column: 4, milliseconds: 145,
                   offsetX: -1.7, offsetY: 2.8, rotationDegrees: -3.0,
                   scaleY: 0.90),
        SpriteBeat(row: 5, column: 5, milliseconds: 175,
                   offsetX: 1.2, offsetY: 3.8, rotationDegrees: 2.0,
                   scaleY: 0.87),
        SpriteBeat(row: 5, column: 6, milliseconds: 520,
                   offsetY: 5.2, rotationDegrees: -1.0,
                   scaleY: 0.82),
    ]

    init(
        isCallActive: Bool,
        taskCount: Int,
        completionToken: Int,
        reduceMotion: Bool,
        isVisible: Bool = true,
        isDragging: Bool = false,
        dragDirection: OfficeRobotDragDirection = .right,
        isDockedRight: Bool = true,
        pendingItems: [GlobalOfficeRobotStore.TaskItem] = [],
        transientHeadlineItem: GlobalOfficeRobotStore.TaskItem? = nil,
        approvalReaction: GlobalOfficeRobotStore.ApprovalReaction? = nil,
        onTap: @escaping () -> Void,
        onLongPress: @escaping () -> Void,
        onDragChanged: @escaping (CGSize) -> Void = { _ in },
        onDragEnded: @escaping (CGSize, CGFloat) -> Void = { _, _ in },
        onOpenPendingItem: @escaping (GlobalOfficeRobotStore.TaskItem) -> Void = { _ in }
    ) {
        self.isCallActive = isCallActive
        self.taskCount = taskCount
        self.completionToken = completionToken
        self.reduceMotion = reduceMotion
        self.isVisible = isVisible
        self.isDragging = isDragging
        self.dragDirection = dragDirection
        self.isDockedRight = isDockedRight
        self.pendingItems = pendingItems
        self.transientHeadlineItem = transientHeadlineItem
        self.approvalReaction = approvalReaction
        self.onTap = onTap
        self.onLongPress = onLongPress
        self.onDragChanged = onDragChanged
        self.onDragEnded = onDragEnded
        self.onOpenPendingItem = onOpenPendingItem
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
    private var normalizedPendingCount: Int { pendingItems.count }

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
        if normalizedPendingCount > 0 {
            parts.append("\(normalizedPendingCount)টি অনুমোদন বাকি")
        }
        let runningOnly = max(0, normalizedTaskCount - normalizedPendingCount)
        if runningOnly > 0 {
            parts.append("\(runningOnly)টি কাজ চলছে")
        }
        if parts.isEmpty { parts.append("প্রস্তুত") }
        return parts.joined(separator: ", ")
    }

    var body: some View {
        ZStack {
            callHalo
            transientHeadline

            Ellipse()
                .fill(.black.opacity(0.18))
                .frame(width: 30, height: 4)
                .blur(radius: 2)
                .scaleEffect(x: lift < 0 ? 0.66 : 1)
                .opacity(lift < 0 ? 0.30 : 0.62)
                .offset(y: 24)

            OfficeRobotSpriteFrame(row: row, column: column)
                .frame(width: 52, height: 56.34)
                .scaleEffect(
                    x: robotScale,
                    y: robotScale * approvalScaleY,
                    anchor: .bottom
                )
                .rotationEffect(.degrees(ambientRotationDegrees))
                .offset(x: ambientOffsetX, y: lift - 2)
                .shadow(
                    color: isCallActive
                        ? Color(red: 0.20, green: 0.84, blue: 0.67).opacity(0.34)
                        : Color(red: 0.49, green: 0.30, blue: 1.0).opacity(0.24),
                    radius: 5,
                    y: 2
                )

            if approvalGlitchAmount > 0 {
                OfficeRobotSpriteFrame(row: row, column: column)
                    .frame(width: 52, height: 56.34)
                    .scaleEffect(
                        x: robotScale,
                        y: robotScale * approvalScaleY,
                        anchor: .bottom
                    )
                    .colorMultiply(.cyan)
                    .opacity(0.22 * approvalGlitchAmount)
                    .offset(
                        x: ambientOffsetX - (3.4 * approvalGlitchAmount),
                        y: lift - 2
                    )
                    .blendMode(.screen)
                    .allowsHitTesting(false)

                OfficeRobotSpriteFrame(row: row, column: column)
                    .frame(width: 52, height: 56.34)
                    .scaleEffect(
                        x: robotScale,
                        y: robotScale * approvalScaleY,
                        anchor: .bottom
                    )
                    .colorMultiply(.red)
                    .opacity(0.18 * approvalGlitchAmount)
                    .offset(
                        x: ambientOffsetX + (3.1 * approvalGlitchAmount),
                        y: lift - 1
                    )
                    .blendMode(.screen)
                    .allowsHitTesting(false)
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

            approvalStatus
        }
        .frame(width: 68, height: 68)
        .contentShape(Circle())
        .gesture(interactionGesture)
        .simultaneousGesture(robotDragGesture)
        // Added after the Robot gesture so the pending NUMBER itself owns the
        // expand tap. There is intentionally no second chevron chip beside it.
        .overlay {
            if normalizedPendingCount > 0 {
                pendingCountControl
                    .offset(x: 25, y: -24)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("ALMA Office Robot")
        .accessibilityValue(accessibilityValue)
        .accessibilityHint("ট্যাপ করলে খুলবে, লং প্রেস করলে আরও অপশন দেখাবে")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onTap() }
        .accessibilityAction(named: Text("আরও অপশন")) { onLongPress() }
        .accessibilityAction(named: Text(
            isPendingExpanded ? "Pending তালিকা বন্ধ করুন" : "Pending actions দেখুন"
        )) {
            guard normalizedPendingCount > 0 else { return }
            withAnimation(.spring(response: 0.34, dampingFraction: 0.78)) {
                isPendingExpanded.toggle()
            }
        }
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
            approvalScaleY = 1
            approvalGlitchAmount = 0
            ambientOffsetX = 0
            ambientRotationDegrees = 0
        }
        .onChange(of: playbackContext) { _, _ in
            restartPlayback()
        }
        .onChange(of: completionToken) { _, newValue in
            handleCompletion(newValue)
        }
        .onChange(of: approvalReaction) { _, _ in
            if approvalReaction != nil { isPendingExpanded = false }
            restartPlayback()
        }
        .onChange(of: pendingItems.map(\.id)) { _, ids in
            if ids.isEmpty { isPendingExpanded = false }
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

    private var pendingCountControl: some View {
        Button {
            withAnimation(.spring(response: 0.34, dampingFraction: 0.78)) {
                isPendingExpanded.toggle()
            }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } label: {
            Text(normalizedPendingCount > 99 ? "99+" : "\(normalizedPendingCount)")
                .font(.system(
                    size: normalizedPendingCount > 99 ? 8 : 10,
                    weight: .bold,
                    design: .rounded
                ))
                .monospacedDigit()
                .foregroundStyle(.white)
                .padding(.horizontal, normalizedPendingCount > 9 ? 5 : 4)
                .frame(minWidth: 22, minHeight: 22)
                .background(
                    Color(red: 0.88, green: 0.31, blue: 0.25),
                    in: Capsule()
                )
                .overlay(Capsule().strokeBorder(.white.opacity(0.74), lineWidth: 1))
                .shadow(color: .black.opacity(0.24), radius: 4, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            isPendingExpanded
                ? "\(normalizedPendingCount)টি pending action তালিকা খোলা"
                : "\(normalizedPendingCount)টি pending action দেখুন"
        )
        .popover(
            isPresented: $isPendingExpanded,
            arrowEdge: isDockedRight ? .trailing : .leading
        ) {
            OfficeRobotPendingPopover(
                items: pendingItems,
                onCollapse: {
                    withAnimation(.easeOut(duration: 0.18)) {
                        isPendingExpanded = false
                    }
                },
                onOpen: { item in
                    isPendingExpanded = false
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(180))
                        onOpenPendingItem(item)
                    }
                }
            )
            .presentationCompactAdaptation(.popover)
        }
    }

    @ViewBuilder
    private var transientHeadline: some View {
        if approvalReaction == nil, !isPendingExpanded, let item = transientHeadlineItem {
            HStack(alignment: .top, spacing: 7) {
                Image(systemName: item.systemImage)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(item.status == "attention" ? .orange : .blue)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(item.detail)
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .frame(width: 196, alignment: .leading)
            .padding(.horizontal, 11)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(.white.opacity(0.38), lineWidth: 0.8)
            )
            .shadow(color: .black.opacity(0.18), radius: 12, y: 5)
            .offset(x: isDockedRight ? -80 : 80, y: -66)
            .transition(.asymmetric(
                insertion: .scale(scale: 0.72, anchor: isDockedRight ? .bottomTrailing : .bottomLeading)
                    .combined(with: .opacity),
                removal: .opacity.combined(with: .move(edge: .top))
            ))
            .animation(.spring(response: 0.46, dampingFraction: 0.72), value: item.id)
            .allowsHitTesting(false)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(item.statusLabel): \(item.title), \(item.detail)")
        }
    }

    @ViewBuilder
    private var approvalStatus: some View {
        if let reaction = approvalReaction {
            Text(approvalStatusText(reaction))
                .font(.system(size: 8.5, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .lineLimit(1)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(approvalStatusTint(reaction), in: Capsule())
                .overlay(Capsule().strokeBorder(.white.opacity(0.52), lineWidth: 0.7))
                .shadow(color: approvalStatusTint(reaction).opacity(0.34), radius: 5, y: 2)
                .offset(y: 34)
                .transition(.scale.combined(with: .opacity))
                .allowsHitTesting(false)
                .accessibilityLabel(approvalStatusText(reaction))
        }
    }

    private func approvalStatusText(
        _ reaction: GlobalOfficeRobotStore.ApprovalReaction
    ) -> String {
        switch reaction.phase {
        case .processing:
            return reaction.decision == .approve
                ? "অনুমোদন প্রসেস হচ্ছে…"
                : "বাতিল প্রসেস হচ্ছে…"
        case .succeeded:
            return reaction.decision == .approve
                ? "অনুমোদন সম্পন্ন"
                : "বাতিল করা হয়েছে"
        case .failed:
            return "কাজটি সম্পন্ন হয়নি"
        }
    }

    private func approvalStatusTint(
        _ reaction: GlobalOfficeRobotStore.ApprovalReaction
    ) -> Color {
        if reaction.phase == .failed { return .red }
        return reaction.decision == .approve ? .green : .orange
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

    private var robotDragGesture: some Gesture {
        DragGesture(minimumDistance: 6, coordinateSpace: .global)
            .onChanged { value in
                onDragChanged(value.translation)
            }
            .onEnded { value in
                onDragEnded(
                    value.translation,
                    value.predictedEndTranslation.width - value.translation.width
                )
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
        approvalScaleY = 1
        approvalGlitchAmount = 0
        ambientOffsetX = 0
        ambientRotationDegrees = 0

        if pendingCompletionToken != nil, isAppActive, isVisible, !isDragging {
            pendingCompletionToken = nil
            let emitHaptic = pendingCompletionShouldEmitHaptic
            pendingCompletionShouldEmitHaptic = true
            playCompletionCelebration(emitHaptic: emitHaptic)
            return
        }

        if let approvalReaction {
            startApprovalPlayback(approvalReaction)
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

    private func startApprovalPlayback(
        _ reaction: GlobalOfficeRobotStore.ApprovalReaction
    ) {
        playbackTask?.cancel()
        isCelebrating = true
        let beats: [SpriteBeat]
        let repeats: Int
        switch reaction.phase {
        case .processing:
            beats = Self.processingBeats
            repeats = .max
        case .succeeded where reaction.decision == .approve:
            beats = Self.approvalSuccessBeats
            repeats = 2
        case .succeeded:
            beats = Self.rejectBeats
            repeats = 2
        case .failed:
            // Error ≠ rejection (review-bot P2 on PR #651): a failed request keeps
            // the neutral processing motion; the red "কাজটি সম্পন্ন হয়নি" status
            // line carries the error message.
            beats = Self.processingBeats
            repeats = 2
        }

        guard motionAllowed else {
            switch reaction.phase {
            case .processing, .failed: row = 7; column = 2
            case .succeeded where reaction.decision == .approve: row = 3; column = 3
            case .succeeded: row = 5; column = 3
            }
            return
        }

        let generation = UUID()
        playbackGeneration = generation
        playbackTask = Task { @MainActor in
            var cycle = 0
            while !Task.isCancelled, cycle < repeats {
                for beat in beats {
                    guard !Task.isCancelled,
                          playbackGeneration == generation
                    else { return }
                    row = beat.row
                    column = beat.column
                    withAnimation(
                        .easeInOut(
                            duration: min(
                                0.18,
                                Double(beat.milliseconds) / 1_000 * 0.72
                            )
                        )
                    ) {
                        ambientOffsetX = beat.offsetX
                        lift = beat.offsetY
                        ambientRotationDegrees = beat.rotationDegrees
                        approvalScaleY = beat.scaleY
                        approvalGlitchAmount = beat.glitch
                    }
                    do {
                        try await Task.sleep(for: .milliseconds(beat.milliseconds))
                    } catch {
                        return
                    }
                }
                cycle += 1
            }
        }
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
        (3, 0..<4),
        (4, 0..<5),
        (5, 0..<8),
        (6, 0..<8),
        (7, 0..<6),
        (8, 0..<8),
        (9, 0..<8),
        (10, 0..<8),
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

// MARK: - Production launch experience (approved Preview v4)

extension Notification.Name {
    /// Emitted by the native dashboard after its first authoritative data payload.
    static let almaDashboardContentReady = Notification.Name("alma.dashboard.contentReady")
    /// Auth/error routes must never leave the user trapped behind decorative motion.
    static let almaDashboardContentUnavailable = Notification.Name("alma.dashboard.contentUnavailable")
}

/// Pure, deterministic motion math shared by the production view and focused tests.
/// Coordinates are authored against the approved 390×844 preview, then mapped into
/// the live window; the destination is supplied by the canonical FloatingChatHead.
@available(iOS 17.0, *)
enum LaunchRobotTimeline {
    static let duration: TimeInterval = 10.4
    static let activationHoldTime: TimeInterval = 7.05
    static let maximumReadinessHold: TimeInterval = 2.5
    static let fixedHostRevealTime: TimeInterval = 9.1

    enum Phase: String, Equatable {
        case waiting, drop, landing, awareness, hopOne, hopTwo, dance, spin
        case activation, reveal, merge, fixedReaction, complete
    }

    struct State: Equatable {
        var phase: Phase = .waiting
        var robotCenter = CGPoint(x: 195, y: -85)
        var robotSize = CGSize(width: 112, height: 121)
        var scaleX: CGFloat = 1
        var scaleY: CGFloat = 1
        var rotationDegrees: Double = 0
        var robotOpacity: Double = 1
        var row = 0
        var column = 0
        var beamOpacity: Double = 0
        var beamScaleX: CGFloat = 0.12
        var islandGlowOpacity: Double = 0
        var shadowOpacity: Double = 0.08
        var shadowScaleX: CGFloat = 0.45
        var impactOpacity: Double = 0
        var impactScale: CGFloat = 0.2
        var particleOpacity: Double = 0
        var particleScale: CGFloat = 1
        var coreOpacity: Double = 0
        var coreScale: CGFloat = 0.25
        var coreRotationDegrees: Double = 0
        var scanOpacity: Double = 0
        var scanProgress: CGFloat = 0
        var veilOpacity: Double = 1
        var gridOpacity: Double = 0.15
        var brandOpacity: Double = 1
        var brandOffsetY: CGFloat = 0
        var portalOpacity: Double = 0
        var portalScale: CGFloat = 1
        var portalRotationDegrees: Double = 0
        var shutterOpacity: Double = 0
        var shutterProgress: CGFloat = 0
        var hapticFlashOpacity: Double = 0
        var sceneShakeX: CGFloat = 0
        var sceneTiltDegrees: Double = 0
    }

    static func phase(at time: TimeInterval) -> Phase {
        switch time {
        case ..<0.5: .waiting
        case ..<1.2: .drop
        case ..<1.85: .landing
        case ..<3.3: .awareness
        case ..<3.85: .hopOne
        case ..<4.4: .hopTwo
        case ..<5.65: .dance
        case ..<6.35: .spin
        case ..<7.1: .activation
        case ..<8.0: .reveal
        case ..<9.1: .merge
        case ..<9.9: .fixedReaction
        case ..<duration: .complete
        default: .complete
        }
    }

    static func state(
        at rawTime: TimeInterval,
        canvas: CGSize = CGSize(width: 390, height: 844),
        destinationCenter: CGPoint = CGPoint(x: 334, y: 380)
    ) -> State {
        let time = min(max(0, rawTime), duration)
        let xRatio = canvas.width / 390
        let yRatio = canvas.height / 844
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: x * xRatio, y: y * yRatio)
        }
        func size(_ width: CGFloat, _ height: CGFloat) -> CGSize {
            CGSize(width: width * xRatio, height: height * xRatio)
        }
        func clamp(_ value: Double, _ lower: Double = 0, _ upper: Double = 1) -> Double {
            min(upper, max(lower, value))
        }
        func segment(_ value: Double, _ start: Double, _ end: Double) -> Double {
            clamp((value - start) / (end - start))
        }
        func smooth(_ value: Double) -> Double {
            let t = clamp(value)
            return t * t * (3 - 2 * t)
        }
        func easeOut(_ value: Double) -> Double {
            1 - pow(1 - clamp(value), 3)
        }
        func mix(_ start: CGFloat, _ end: CGFloat, _ progress: Double) -> CGFloat {
            start + (end - start) * progress
        }
        func mixD(_ start: Double, _ end: Double, _ progress: Double) -> Double {
            start + (end - start) * progress
        }

        var state = State()
        state.phase = phase(at: time)
        var x: CGFloat = 139
        var y: CGFloat = -145
        var width: CGFloat = 112
        var height: CGFloat = 121

        if time < 0.5 {
            state.islandGlowOpacity = 0.12 + 0.10 * sin(time / 0.09)
            state.brandOpacity = smooth(segment(time, 0.06, 0.42))
        } else if time < 1.2 {
            let p = easeOut(segment(time, 0.5, 1.2))
            y = mix(-132, 342, p)
            state.rotationDegrees = mixD(-5, 2, p)
            state.beamOpacity = sin(.pi * segment(time, 0.5, 1.2)) * 0.82
            state.beamScaleX = mix(0.18, 1, sin(.pi * segment(time, 0.5, 1.2)))
            state.islandGlowOpacity = 0.9 - p * 0.38
            state.column = min(7, Int(p * 8)); state.row = 1
            state.shadowOpacity = mixD(0.03, 0.46, p)
            state.shadowScaleX = mix(0.26, 1, p)
        } else if time < 1.85 {
            let p = segment(time, 1.2, 1.85)
            y = 342
            if p < 0.18 {
                let q = p / 0.18
                state.scaleX = mix(1, 1.16, q); state.scaleY = mix(1, 0.78, q)
                y += mix(0, 13, q)
            } else if p < 0.5 {
                let q = smooth((p - 0.18) / 0.32)
                state.scaleX = mix(1.16, 0.95, q); state.scaleY = mix(0.78, 1.07, q)
                y += mix(13, -14, q)
            } else {
                let q = smooth((p - 0.5) / 0.5)
                state.scaleX = mix(0.95, 1, q); state.scaleY = mix(1.07, 1, q)
                y += mix(-14, 0, q)
            }
            state.impactOpacity = sin(.pi * clamp(p * 1.55))
            state.impactScale = mix(0.35, 2.5, easeOut(p))
            state.particleOpacity = sin(.pi * clamp(p * 1.25))
            state.particleScale = mix(0.4, 1.25, p)
            state.shadowOpacity = 0.48; state.shadowScaleX = 1.05
            state.column = min(7, Int(p * 12) % 8); state.row = 2
            if p < 0.26 {
                let q = p / 0.26
                state.sceneShakeX = sin(q * .pi * 4) * (1 - q) * 2.4
                state.sceneTiltDegrees = sin(q * .pi * 3) * (1 - q) * 0.18
                state.hapticFlashOpacity = sin(.pi * q) * 0.48
            }
        } else if time < 3.3 {
            let p = segment(time, 1.85, 3.3)
            y = 342 + sin(p * .pi * 4) * 1.6
            if p < 0.3 {
                state.rotationDegrees = mixD(0, -7, smooth(p / 0.3)); x -= 5; state.column = 1
            } else if p < 0.62 {
                state.rotationDegrees = mixD(-7, 8, smooth((p - 0.3) / 0.32)); x += 6; state.column = 3
            } else {
                state.rotationDegrees = mixD(8, 0, smooth((p - 0.62) / 0.38))
                state.column = (p > 0.77 && p < 0.86) ? 1 : 0
            }
            state.row = p < 0.3 ? 10 : (p < 0.62 ? 9 : 0)
            state.shadowOpacity = 0.44; state.shadowScaleX = 0.96
        } else if time < 3.85 {
            let p = segment(time, 3.3, 3.85)
            y = 342 - sin(.pi * p) * 62; x = mix(139, 111, smooth(p))
            state.rotationDegrees = -sin(.pi * p) * 10
            state.scaleX = 1 + sin(.pi * p) * 0.05
            state.scaleY = 1 - sin(.pi * p) * 0.03
            state.shadowOpacity = mixD(0.44, 0.18, sin(.pi * p))
            state.shadowScaleX = mix(0.96, 0.58, sin(.pi * p))
            state.column = min(4, Int(p * 10) % 5); state.row = 4
        } else if time < 4.4 {
            let p = segment(time, 3.85, 4.4)
            y = 342 - sin(.pi * p) * 72; x = mix(111, 164, smooth(p))
            state.rotationDegrees = sin(.pi * p) * 12
            state.shadowOpacity = mixD(0.44, 0.15, sin(.pi * p))
            state.shadowScaleX = mix(0.96, 0.52, sin(.pi * p))
            state.column = min(7, Int(p * 11) % 8); state.row = 5
        } else if time < 5.65 {
            let p = segment(time, 4.4, 5.65)
            let wave = sin(p * .pi * 6)
            x = 139 + wave * 24; y = 342 - abs(wave) * 17
            state.rotationDegrees = wave * 14
            state.scaleX = 1 + abs(wave) * 0.035; state.scaleY = 1 - abs(wave) * 0.025
            state.shadowOpacity = 0.4; state.shadowScaleX = 0.86 + abs(wave) * 0.12
            state.column = Int(p * 24) % 8; state.row = 6 + (Int(p * 3) % 2)
        } else if time < 6.35 {
            let p = segment(time, 5.65, 6.35)
            y = 342 - sin(.pi * p) * 24
            state.rotationDegrees = easeOut(p) * 360
            state.scaleX = 1 + sin(.pi * p) * 0.08; state.scaleY = 1 - sin(.pi * p) * 0.04
            state.column = Int(p * 14) % 8; state.row = 8
            state.shadowOpacity = 0.35; state.shadowScaleX = mix(0.9, 0.6, sin(.pi * p))
        } else if time < 7.1 {
            let p = segment(time, 6.35, 7.1)
            y = 342 - sin(p * .pi) * 8
            state.column = min(3, Int(p * 8) % 4); state.row = 3
            state.coreOpacity = smooth(segment(p, 0.06, 0.34)) * (1 - smooth(segment(p, 0.84, 1)) * 0.15)
            state.coreScale = mix(0.25, 1.12, easeOut(segment(p, 0.02, 0.62)))
            state.coreRotationDegrees = p * 190
            state.scanOpacity = smooth(segment(p, 0.2, 0.42)); state.scanProgress = smooth(segment(p, 0.24, 1))
            state.veilOpacity = mixD(1, 0.76, smooth(segment(p, 0.52, 1)))
            state.gridOpacity = mixD(0.15, 0.34, smooth(segment(p, 0.08, 0.72)))
            if p > 0.25 && p < 0.52 {
                let q = segment(p, 0.25, 0.52)
                state.sceneShakeX = sin(q * .pi * 3) * (1 - q) * 1.15
                state.hapticFlashOpacity = sin(.pi * q) * 0.26
            }
        } else if time < 8.0 {
            let p = smooth(segment(time, 7.1, 8.0))
            y = 342; state.column = min(3, Int(p * 8) % 4); state.row = 3
            state.coreOpacity = mixD(0.85, 0, p); state.coreScale = mix(1.12, 2.35, p)
            state.coreRotationDegrees = 190 + p * 160
            state.scanOpacity = 1 - p; state.scanProgress = 1
            state.veilOpacity = mixD(0.76, 0, p); state.gridOpacity = mixD(0.34, 0, p)
            state.brandOpacity = 1 - p; state.brandOffsetY = -14 * p
            state.shutterOpacity = sin(.pi * p) * 0.85; state.shutterProgress = p
            state.portalOpacity = smooth(segment(p, 0.22, 0.62))
            state.portalScale = mix(0.62, 1, smooth(segment(p, 0.22, 0.78)))
            state.portalRotationDegrees = mixD(-18, 8, p)
        } else if time < 9.1 {
            let raw = segment(time, 8.0, 9.1)
            let p = smooth(segment(raw, 0, 0.72))
            let startCenter = point(195, 402.5)
            let arc = sin(.pi * p) * 92 * yRatio
            let center = CGPoint(
                x: mix(startCenter.x, destinationCenter.x, p),
                y: mix(startCenter.y, destinationCenter.y, p) - arc
            )
            width = mix(112, 52, p); height = mix(121, 56.34, p)
            state.robotCenter = center
            state.robotSize = size(width, height)
            state.rotationDegrees = sin(.pi * p) * 12
            state.column = Int(raw * 14) % 8; state.row = 10
            state.veilOpacity = 0; state.gridOpacity = 0; state.brandOpacity = 0
            state.portalOpacity = 1; state.portalScale = 1 + sin(.pi * raw) * 0.16
            state.portalRotationDegrees = raw * 120
            if raw > 0.72 {
                let q = smooth(segment(raw, 0.72, 1))
                state.robotCenter = destinationCenter
                state.robotSize = size(52, 56.34)
                state.scaleX = mix(1, 0.12, q); state.scaleY = mix(1, 0.12, q)
                state.rotationDegrees = q * 88
                state.robotOpacity = 1 - smooth(segment(q, 0.52, 1))
                state.hapticFlashOpacity = sin(.pi * segment(q, 0.34, 0.82)) * 0.62
                state.sceneShakeX = sin(q * .pi * 5) * (1 - q) * 1.9
            }
            state.shadowOpacity = 0
            return state
        } else {
            // From 9.1 s the canonical FloatingChatHead is the only visible owner.
            state.robotCenter = destinationCenter
            state.robotSize = size(52, 56.34)
            state.robotOpacity = 0
            state.row = 0; state.column = 0
            state.veilOpacity = 0; state.gridOpacity = 0; state.brandOpacity = 0
            let reaction = segment(time, 9.1, 9.9)
            state.portalOpacity = 1 - smooth(segment(reaction, 0.05, 0.58))
            state.portalScale = mix(1.18, 0.74, smooth(segment(reaction, 0, 0.58)))
            state.portalRotationDegrees = 120 + reaction * 90
            state.hapticFlashOpacity = sin(.pi * segment(reaction, 0, 0.26)) * 0.70
            return state
        }

        state.robotCenter = point(x + width / 2, y + height / 2)
        state.robotSize = size(width, height)
        return state
    }
}

@available(iOS 17.0, *)
@MainActor
final class LaunchRobotAnimationModel: ObservableObject {
    @Published private(set) var elapsed: TimeInterval = 0
    @Published var destinationCenter: CGPoint

    var onRevealFixedHost: ((Bool) -> Void)?
    var onComplete: (() -> Void)?

    private var playbackTask: Task<Void, Never>?
    private var dashboardResolved = false
    private var didRevealFixedHost = false
    private var didComplete = false
    private var didPrepareLanding = false
    private var didPrepareActivation = false
    private var didPrepareMerge = false
    private var didFireLanding = false
    private var didFireActivation = false
    private var didFireMerge = false
    private let landingFeedback = UIImpactFeedbackGenerator(style: .soft)
    private let activationFeedback = UIImpactFeedbackGenerator(style: .light)
    private let mergeFeedback = UIImpactFeedbackGenerator(style: .medium)

    init(destinationCenter: CGPoint) {
        self.destinationCenter = destinationCenter
    }

    func start(reduceMotion: Bool) {
        playbackTask?.cancel()
        guard !reduceMotion else {
            elapsed = LaunchRobotTimeline.duration
            didRevealFixedHost = true
            onRevealFixedHost?(false)
            playbackTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(360))
                self?.finishIfNeeded()
            }
            return
        }

        let start = Date()
        var accumulatedHold: TimeInterval = 0
        var holdStarted: Date?
        playbackTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                let now = Date()
                var effective = now.timeIntervalSince(start) - accumulatedHold
                if effective >= LaunchRobotTimeline.activationHoldTime,
                   !dashboardResolved {
                    if holdStarted == nil { holdStarted = now }
                    if let holdStarted,
                       now.timeIntervalSince(holdStarted) < LaunchRobotTimeline.maximumReadinessHold {
                        effective = LaunchRobotTimeline.activationHoldTime
                    } else if let holdStarted {
                        dashboardResolved = true
                        accumulatedHold += now.timeIntervalSince(holdStarted)
                        self.dashboardResolved = true
                        self.log("launchRobot.readinessTimedOut")
                        effective = now.timeIntervalSince(start) - accumulatedHold
                    }
                } else if dashboardResolved, let holdStarted {
                    accumulatedHold += now.timeIntervalSince(holdStarted)
                    effective = now.timeIntervalSince(start) - accumulatedHold
                }
                if dashboardResolved { holdStarted = nil }

                elapsed = min(effective, LaunchRobotTimeline.duration)
                handleOneShotEvents(at: elapsed)
                if elapsed >= LaunchRobotTimeline.duration {
                    finishIfNeeded()
                    return
                }
                try? await Task.sleep(for: .milliseconds(16))
            }
        }
    }

    func resolveDashboard() {
        dashboardResolved = true
    }

    func cancelAndReveal(reason: String) {
        guard !didComplete else { return }
        log("launchRobot.cancelled", reason)
        playbackTask?.cancel()
        playbackTask = nil
        elapsed = LaunchRobotTimeline.duration
        if !didRevealFixedHost {
            didRevealFixedHost = true
            onRevealFixedHost?(false)
        }
        finishIfNeeded()
    }

    private func handleOneShotEvents(at time: TimeInterval) {
        if time >= 1.0, !didPrepareLanding { didPrepareLanding = true; landingFeedback.prepare() }
        if time >= 1.2, !didFireLanding {
            didFireLanding = true; landingFeedback.impactOccurred(intensity: 0.72)
            log("launchRobot.haptic", "landing.soft")
        }
        if time >= 6.15, !didPrepareActivation { didPrepareActivation = true; activationFeedback.prepare() }
        if time >= 6.45, !didFireActivation {
            didFireActivation = true; activationFeedback.impactOccurred(intensity: 0.58)
            log("launchRobot.haptic", "activation.light")
        }
        if time >= 8.7, !didPrepareMerge { didPrepareMerge = true; mergeFeedback.prepare() }
        if time >= 8.95, !didFireMerge {
            didFireMerge = true; mergeFeedback.impactOccurred(intensity: 0.86)
            log("launchRobot.haptic", "merge.medium")
        }
        if time >= LaunchRobotTimeline.fixedHostRevealTime, !didRevealFixedHost {
            didRevealFixedHost = true
            onRevealFixedHost?(true)
        }
    }

    private func finishIfNeeded() {
        guard !didComplete else { return }
        didComplete = true
        playbackTask?.cancel()
        playbackTask = nil
        onComplete?()
    }

    private func log(_ name: StaticString, _ detail: String = "") {
        AlmaPerfLog.event(name, detail)
    }
}

@available(iOS 17.0, *)
private struct LaunchRobotExperienceView: View {
    @ObservedObject var model: LaunchRobotAnimationModel
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        GeometryReader { proxy in
            let state = LaunchRobotTimeline.state(
                at: model.elapsed,
                canvas: proxy.size,
                destinationCenter: model.destinationCenter
            )
            let scaleX = state.robotSize.width / 52
            let scaleY = state.robotSize.height / 56.34

            ZStack {
                Group {
                    if reduceTransparency {
                        Rectangle()
                            .fill(Color(red: 0.035, green: 0.045, blue: 0.105))
                    } else {
                        Rectangle()
                            .fill(.ultraThinMaterial)
                    }
                }
                .opacity(state.veilOpacity)

                LinearGradient(
                    colors: [
                        Color(red: 0.035, green: 0.055, blue: 0.14).opacity(0.88),
                        Color(red: 0.025, green: 0.035, blue: 0.09).opacity(0.70),
                        Color(red: 0.09, green: 0.025, blue: 0.10).opacity(0.72),
                    ],
                    startPoint: .top,
                    endPoint: .bottomTrailing
                )
                .opacity(state.veilOpacity)

                LaunchRobotGrid()
                    .opacity(state.gridOpacity)

                VStack(spacing: 5) {
                    Text("ALMA")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .tracking(3.0)
                    Text("OPERATIONS, IN MOTION")
                        .font(.system(size: 9, weight: .regular, design: .rounded))
                        .tracking(1.1)
                        .opacity(0.52)
                }
                .foregroundStyle(.white)
                .offset(y: state.brandOffsetY)
                .opacity(state.brandOpacity)
                .position(x: proxy.size.width / 2, y: max(84, proxy.safeAreaInsets.top + 46))

                LaunchRobotBeam()
                    .fill(LinearGradient(
                        colors: [.cyan.opacity(0.78), Color(red: 0.26, green: 0.53, blue: 1).opacity(0.16), .clear],
                        startPoint: .top,
                        endPoint: .bottom
                    ))
                    .frame(width: 78, height: min(430, proxy.size.height * 0.52))
                    .scaleEffect(x: state.beamScaleX, y: 1, anchor: .top)
                    .blur(radius: 4)
                    .opacity(state.beamOpacity)
                    .position(x: proxy.size.width / 2, y: proxy.safeAreaInsets.top + 205)

                Capsule()
                    .fill(Color.black)
                    .frame(width: 119, height: 32)
                    .overlay(alignment: .bottom) {
                        Capsule()
                            .fill(.cyan)
                            .frame(width: 46, height: 4)
                            .blur(radius: 4)
                            .opacity(state.islandGlowOpacity)
                            .offset(y: 3)
                    }
                    .position(x: proxy.size.width / 2, y: max(22, proxy.safeAreaInsets.top - 31))

                LaunchRobotCore(state: state)
                    .position(x: proxy.size.width / 2, y: proxy.size.height * (405 / 844))

                Rectangle()
                    .fill(LinearGradient(colors: [.clear, .cyan, .white, .cyan, .clear], startPoint: .leading, endPoint: .trailing))
                    .frame(height: 2)
                    .shadow(color: .cyan.opacity(0.55), radius: 8)
                    .opacity(state.scanOpacity)
                    .position(x: proxy.size.width / 2, y: proxy.size.height * (0.36 + 0.55 * state.scanProgress))

                Ellipse()
                    .fill(Color.black.opacity(0.72))
                    .frame(width: 90, height: 15)
                    .scaleEffect(x: state.shadowScaleX, y: 1)
                    .blur(radius: 5)
                    .opacity(state.shadowOpacity)
                    .position(x: proxy.size.width / 2, y: proxy.size.height * (476 / 844))

                Ellipse()
                    .stroke(.cyan.opacity(0.82), lineWidth: 2)
                    .frame(width: 70, height: 24)
                    .scaleEffect(state.impactScale)
                    .shadow(color: .cyan.opacity(0.45), radius: 10)
                    .opacity(state.impactOpacity)
                    .position(x: proxy.size.width / 2, y: proxy.size.height * (473 / 844))

                LaunchRobotParticles(state: state, canvas: proxy.size)

                LaunchRobotDestinationPortal(state: state)
                    .position(model.destinationCenter)

                LaunchRobotShutters(state: state)

                OfficeRobotSpriteFrame(row: state.row, column: state.column)
                    .frame(width: 52, height: 56.34)
                    .scaleEffect(
                        x: scaleX * state.scaleX,
                        y: scaleY * state.scaleY,
                        anchor: .bottom
                    )
                    .rotationEffect(.degrees(state.rotationDegrees))
                    .shadow(color: Color(red: 0.26, green: 0.53, blue: 1).opacity(0.48), radius: 9, y: 5)
                    .opacity(state.robotOpacity)
                    .position(state.robotCenter)

                RoundedRectangle(cornerRadius: 44, style: .continuous)
                    .stroke(.cyan.opacity(0.75), lineWidth: 2)
                    .shadow(color: .cyan.opacity(0.28), radius: 20)
                    .opacity(state.hapticFlashOpacity)
                    .padding(3)
                    .accessibilityHidden(true)
            }
            .offset(x: state.sceneShakeX)
            .rotationEffect(.degrees(state.sceneTiltDegrees))
            .ignoresSafeArea()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("ALMA প্রস্তুত হচ্ছে")
        }
    }
}

@available(iOS 17.0, *)
private struct LaunchRobotGrid: View {
    var body: some View {
        Canvas { context, size in
            var path = Path()
            let spacing: CGFloat = 42
            stride(from: CGFloat(0), through: size.width, by: spacing).forEach { x in
                path.move(to: CGPoint(x: x, y: size.height * 0.48))
                path.addLine(to: CGPoint(x: x, y: size.height))
            }
            stride(from: size.height * 0.48, through: size.height, by: spacing).forEach { y in
                path.move(to: CGPoint(x: 0, y: y))
                path.addLine(to: CGPoint(x: size.width, y: y))
            }
            context.stroke(path, with: .color(.cyan.opacity(0.28)), lineWidth: 0.7)
        }
        .mask(LinearGradient(colors: [.clear, .white, .clear], startPoint: .top, endPoint: .bottom))
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

@available(iOS 17.0, *)
private struct LaunchRobotBeam: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.midX - rect.width * 0.11, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.midX + rect.width * 0.11, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
            path.closeSubpath()
        }
    }
}

@available(iOS 17.0, *)
private struct LaunchRobotCore: View {
    let state: LaunchRobotTimeline.State

    var body: some View {
        ZStack {
            Circle()
                .fill(AngularGradient(
                    colors: [.clear, .cyan, .clear, Color(red: 0.60, green: 0.45, blue: 1), .clear, Color(red: 1, green: 0.56, blue: 0.49), .clear],
                    center: .center
                ))
            Circle().stroke(.white.opacity(0.56), lineWidth: 1).padding(13)
            Circle().stroke(.cyan.opacity(0.62), lineWidth: 1).padding(31)
            Circle().fill(.white).frame(width: 7, height: 7).shadow(color: .cyan, radius: 8)
        }
        .frame(width: 146, height: 146)
        .scaleEffect(state.coreScale)
        .rotationEffect(.degrees(state.coreRotationDegrees))
        .shadow(color: .cyan.opacity(0.35), radius: 24)
        .opacity(state.coreOpacity)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

@available(iOS 17.0, *)
private struct LaunchRobotParticles: View {
    let state: LaunchRobotTimeline.State
    let canvas: CGSize
    private let offsets: [CGSize] = [
        .init(width: -52, height: -4), .init(width: -35, height: -23),
        .init(width: -13, height: -31), .init(width: 15, height: -30),
        .init(width: 39, height: -20), .init(width: 54, height: -3),
    ]

    var body: some View {
        ForEach(Array(offsets.enumerated()), id: \.offset) { _, offset in
            Circle()
                .fill(.white)
                .frame(width: 4, height: 4)
                .shadow(color: .cyan, radius: 4)
                .scaleEffect(state.particleScale)
                .opacity(state.particleOpacity)
                .position(
                    x: canvas.width / 2 + offset.width,
                    y: canvas.height * (459 / 844) + offset.height
                )
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

@available(iOS 17.0, *)
private struct LaunchRobotDestinationPortal: View {
    let state: LaunchRobotTimeline.State

    var body: some View {
        ZStack {
            Circle()
                .fill(RadialGradient(
                    colors: [.white, .cyan, Color(red: 0.26, green: 0.53, blue: 1), Color(red: 0.13, green: 0.11, blue: 0.36), .clear],
                    center: .center,
                    startRadius: 2,
                    endRadius: 42
                ))
            Ellipse().stroke(.cyan.opacity(0.74), lineWidth: 1).padding(-9).rotationEffect(.degrees(28))
            Ellipse().stroke(Color(red: 0.60, green: 0.45, blue: 1).opacity(0.58), lineWidth: 1).padding(-16).rotationEffect(.degrees(-24))
        }
        .frame(width: 84, height: 96)
        .scaleEffect(state.portalScale)
        .rotationEffect(.degrees(state.portalRotationDegrees))
        .shadow(color: .cyan.opacity(0.72), radius: 22)
        .opacity(state.portalOpacity)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

@available(iOS 17.0, *)
private struct LaunchRobotShutters: View {
    let state: LaunchRobotTimeline.State

    var body: some View {
        GeometryReader { proxy in
            ForEach(0..<6, id: \.self) { index in
                LinearGradient(colors: [.clear, .cyan.opacity(0.22), .white.opacity(0.10), .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(height: proxy.size.height * 0.18)
                    .rotationEffect(.degrees(-3))
                    .offset(
                        x: (-proxy.size.width * 1.2) + proxy.size.width * 2.4 * state.shutterProgress,
                        y: proxy.size.height * CGFloat(index) * 0.16
                    )
            }
        }
        .opacity(state.shutterOpacity)
        .blendMode(.screen)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Owns the temporary overlay and no business/data work. Dashboard loading starts
/// normally underneath; this coordinator only consumes readiness and fail-open signals.
@available(iOS 17.0, *)
@MainActor
final class LaunchRobotCoordinator {
    static let shared = LaunchRobotCoordinator()
    static let enabledDefaultsKey = "alma.launchRobot.enabled"

    private var didRun = false
    private var host: UIHostingController<LaunchRobotExperienceView>?
    private var model: LaunchRobotAnimationModel?
    private weak var parentController: UIViewController?
    private var observers: [NSObjectProtocol] = []

    private init() {}

    static var isEnabled: Bool {
        let defaults = UserDefaults.standard
        if defaults.object(forKey: enabledDefaultsKey) == nil { return true }
        return defaults.bool(forKey: enabledDefaultsKey)
    }

    func install(in window: UIWindow?) {
        guard !didRun, Self.isEnabled, let parent = window?.rootViewController else { return }
        didRun = true
        FloatingChatHead.shared.setSuppressed(true, reason: "launch-animation")

        parent.loadViewIfNeeded()
        let fallback = CGPoint(
            x: max(56, parent.view.bounds.width - 56),
            y: max(160, parent.view.bounds.height * 0.45)
        )
        let model = LaunchRobotAnimationModel(destinationCenter: fallback)
        let host = UIHostingController(rootView: LaunchRobotExperienceView(model: model))
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false
        parent.addChild(host)
        parent.view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: parent.view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: parent.view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: parent.view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: parent.view.trailingAnchor),
        ])
        host.didMove(toParent: parent)
        parent.view.layoutIfNeeded()
        self.parentController = parent
        self.host = host
        self.model = model

        model.onRevealFixedHost = { [weak self] animated in
            guard let self else { return }
            self.refreshDestination()
            FloatingChatHead.shared.completeLaunchMerge(animated: animated)
        }
        model.onComplete = { [weak self] in self?.finish() }

        observers.append(NotificationCenter.default.addObserver(
            forName: .almaDashboardContentReady, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.model?.resolveDashboard()
                AlmaPerfLog.event("launchRobot.dashboardReady")
            }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .almaDashboardContentUnavailable, object: nil, queue: .main
        ) { [weak self] notification in
            let reason = notification.userInfo?["reason"] as? String ?? "unavailable"
            Task { @MainActor in self?.model?.cancelAndReveal(reason: reason) }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.model?.cancelAndReveal(reason: "background") }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.model?.cancelAndReveal(reason: "memory-warning") }
        })

        AlmaPerfLog.event("launchRobot.started", "preview=v4")
        model.start(
            reduceMotion: AlmaOverlayCoordinator.shared.reduceMotion
                || ProcessInfo.processInfo.isLowPowerModeEnabled
        )

        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(850))
            self?.refreshDestination()
        }
    }

    private func refreshDestination() {
        guard let hostView = host?.view else { return }
        if let center = FloatingChatHead.shared.launchDestinationCenter(in: hostView) {
            model?.destinationCenter = center
        }
    }

    private func finish() {
        guard let host else { return }
        if model?.elapsed ?? 0 < LaunchRobotTimeline.fixedHostRevealTime {
            FloatingChatHead.shared.completeLaunchMerge(animated: false)
        }
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        host.willMove(toParent: nil)
        host.view.removeFromSuperview()
        host.removeFromParent()
        self.host = nil
        self.model = nil
        self.parentController = nil
        AlmaPerfLog.event("launchRobot.completed")
    }
}
