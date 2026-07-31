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
        (7, 0..<6),
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
