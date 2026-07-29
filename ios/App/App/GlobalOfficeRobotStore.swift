//
//  GlobalOfficeRobotStore.swift
//  App
//
//  Owner-global task state for the app-wide Office Robot.
//
//  This store deliberately does not depend on AssistantScreen or AssistantVM.
//  While the app is active it reads the server-authoritative Pet status
//  snapshot. Polling stops in the background and restarts with an immediate
//  refresh when the app becomes active again.
//
//  Completion is driven only by the endpoint's explicit `latestCompletion`.
//  A falling runningCount is never treated as completion: it could also mean
//  cancellation, failure, expiry, or a temporarily unavailable row.
//

import Combine
import Foundation
import AVFoundation
import UIKit

#if DEBUG
/// Shared Simulator-only data for both the Robot popover and Agent Approvals.
/// Matching IDs make preview rows genuinely actionable end to end.
@MainActor
enum OfficeRobotDebugFixture {
    struct PendingDefinition {
        let id: String
        let actionId: String
        let type: String
        let title: String
        let detail: String
    }

    static let pendingDefinitions: [PendingDefinition] = [
        PendingDefinition(
            id: "fixture:approval",
            actionId: "fixture-approval-action",
            type: "inventory_adjustment",
            title: "Inventory approval",
            detail: "৩টি stock adjustment আপনার অনুমোদনের অপেক্ষায়"
        ),
        PendingDefinition(
            id: "fixture:campaign-approval",
            actionId: "fixture-campaign-action",
            type: "marketing_plan",
            title: "Meta campaign budget",
            detail: "৳৫,০০০ campaign budget approve বা reject করুন"
        ),
        PendingDefinition(
            id: "fixture:staff-approval",
            actionId: "fixture-staff-action",
            type: "staff_schedule_change",
            title: "Staff schedule change",
            detail: "আগামীকালের duty change আপনার সিদ্ধান্তের অপেক্ষায়"
        ),
    ]

    private(set) static var decisions: [
        String: GlobalOfficeRobotStore.ApprovalDecision
    ] = [:]

    static var isEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--alma-office-robot-fixture")
            || ProcessInfo.processInfo.environment["ALMA_OFFICE_ROBOT_FIXTURE"] == "1"
    }

    static var pending: [PendingDefinition] {
        pendingDefinitions.filter { decisions[$0.actionId] == nil }
    }

    static func contains(actionId: String) -> Bool {
        pendingDefinitions.contains { $0.actionId == actionId }
    }

    static func resolve(
        actionId: String,
        decision: GlobalOfficeRobotStore.ApprovalDecision
    ) {
        guard contains(actionId: actionId) else { return }
        decisions[actionId] = decision
    }
}
#endif

extension Notification.Name {
    /// Posted only after the native credentials flow has confirmed a live
    /// session and synchronized its cookies.
    static let almaAuthenticationDidRestore = Notification.Name(
        "almaAuthenticationDidRestore"
    )
}

@MainActor
final class GlobalOfficeRobotStore: ObservableObject {
    static let shared = GlobalOfficeRobotStore()

    /// Visible badge total: current running work + owner attention.
    /// Completion is communicated by a one-shot Robot reaction, not a stale
    /// badge that Office Chat cannot meaningfully clear.
    @Published private(set) var taskCount = 0
    @Published private(set) var runningCount = 0
    @Published private(set) var attentionCount = 0
    @Published private(set) var items: [TaskItem] = []
    /// A compact, temporary line above the Robot. Active work never permanently
    /// consumes screen space: it appears briefly, then returns once per minute
    /// until the server removes or resolves the item.
    @Published private(set) var transientHeadlineItem: TaskItem?
    /// One global reaction channel for every native Agent/business decision.
    /// The network layer is the source so a screen cannot forget to animate.
    @Published private(set) var approvalReaction: ApprovalReaction?

    /// Monotonic UI edge trigger. Initial launch establishes a baseline without
    /// incrementing; a later, explicitly new completion increments exactly once.
    @Published private(set) var completionToken = 0
    @Published private(set) var latestCompletion: LatestCompletion?
    @Published private(set) var lastRefreshAt: Date?

    static let maximumPublishedCount = 999
    static let pollIntervalNanoseconds: UInt64 = 12_000_000_000
    private static let dismissedItemsKey = "alma.officeRobot.dismissedItems.v1"

    enum ApprovalDecision: String, Equatable, Sendable {
        case approve
        case reject
    }

    enum ApprovalReactionPhase: String, Equatable, Sendable {
        case processing
        case succeeded
        case failed
    }

    struct ApprovalReaction: Identifiable, Equatable, Sendable {
        let id: UUID
        let decision: ApprovalDecision
        let phase: ApprovalReactionPhase
    }

    struct TaskItem: Decodable, Identifiable, Equatable, Sendable {
        let id: String
        let actionId: String?
        let turnId: String?
        let conversationId: String?
        let status: String
        let title: String
        let detail: String
        let updatedAt: String
        let dismissible: Bool

        var statusLabel: String {
            switch status {
            case "running": return "চলছে"
            case "attention": return "আপনার অনুমোদন দরকার"
            case "completed": return "শেষ হয়েছে"
            case "failed": return "সমস্যা হয়েছে"
            default: return "আপডেট"
            }
        }

        var systemImage: String {
            switch status {
            case "running": return "gearshape.2.fill"
            case "attention": return "hand.raised.fill"
            case "completed": return "checkmark.circle.fill"
            case "failed": return "exclamationmark.triangle.fill"
            default: return "bell.fill"
            }
        }
    }

    struct LatestCompletion: Decodable, Equatable, Sendable {
        let turnId: String
        let conversationId: String
        let preview: String?
        let completedAt: String
    }

    /// Transport-neutral input for the pure reducer.
    struct Snapshot: Equatable, Sendable {
        let runningCount: Int
        let attentionCount: Int
        let latestCompletion: LatestCompletion?

        init(
            runningCount: Int,
            attentionCount: Int,
            latestCompletion: LatestCompletion? = nil
        ) {
            self.runningCount = runningCount
            self.attentionCount = attentionCount
            self.latestCompletion = latestCompletion
        }
    }

    struct ReducerState: Equatable, Sendable {
        var hasEstablishedBaseline: Bool
        var lastObservedCompletionTurnId: String?
        var lastObservedCompletionCursor: String?
        var completionToken: Int
    }

    struct Reduction: Equatable, Sendable {
        let runningCount: Int
        let attentionCount: Int
        let taskCount: Int
        let latestCompletion: LatestCompletion?
        let state: ReducerState
    }

    /// Pure, deterministic reducer for unit tests.
    ///
    /// The first authoritative snapshot establishes a baseline without animating.
    /// After that, only a strictly newer completion cursor increments the
    /// animation token. Older responses cannot regress the published completion.
    static func reduce(
        snapshot: Snapshot,
        state previous: ReducerState
    ) -> Reduction {
        let running = clamp(snapshot.runningCount)
        let attention = clamp(snapshot.attentionCount)
        var next = previous
        var acceptedCompletion: LatestCompletion?

        if let completion = snapshot.latestCompletion {
            let turnId = completion.turnId.trimmingCharacters(in: .whitespacesAndNewlines)
            let cursor = "\(completion.completedAt)#\(turnId)"
            if !turnId.isEmpty {
                if !previous.hasEstablishedBaseline {
                    next.lastObservedCompletionTurnId = turnId
                    next.lastObservedCompletionCursor = cursor
                    acceptedCompletion = completion
                } else if previous.lastObservedCompletionCursor.map({ cursor > $0 }) ?? true {
                    next.lastObservedCompletionTurnId = turnId
                    next.lastObservedCompletionCursor = cursor
                    next.completionToken = incrementToken(previous.completionToken)
                    acceptedCompletion = completion
                } else if cursor == previous.lastObservedCompletionCursor {
                    acceptedCompletion = completion
                }
            }
        }
        next.hasEstablishedBaseline = true

        return Reduction(
            runningCount: running,
            attentionCount: attention,
            taskCount: saturatingAdd(
                running,
                attention
            ),
            latestCompletion: acceptedCompletion,
            state: next
        )
    }

    private struct PetStatusResponse: Decodable {
        let runningCount: Int
        let attentionCount: Int
        let items: [TaskItem]?
        let latestCompletion: LatestCompletion?

        private enum CodingKeys: String, CodingKey {
            case runningCount
            case attentionCount
            case items
            case latestCompletion
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            runningCount = (try? container.decode(Int.self, forKey: .runningCount)) ?? 0
            attentionCount = (try? container.decode(Int.self, forKey: .attentionCount)) ?? 0
            // Build 88's production endpoint predates the item feed. Keep the
            // native client backward-compatible instead of dropping the whole
            // snapshot when that key is absent.
            items = try? container.decodeIfPresent(
                [TaskItem].self,
                forKey: .items
            )
            latestCompletion = try? container.decodeIfPresent(
                LatestCompletion.self,
                forKey: .latestCompletion
            )
        }

        var snapshot: Snapshot {
            return Snapshot(
                runningCount: runningCount,
                attentionCount: attentionCount,
                latestCompletion: latestCompletion
            )
        }
    }

    private struct PendingActionsResponse: Decodable {
        let actions: [PendingAction]
        let nextCursor: String?

        init(actions: [PendingAction], nextCursor: String?) {
            self.actions = actions
            self.nextCursor = nextCursor
        }

        private enum CodingKeys: String, CodingKey {
            case data
            case actions
            case nextCursor
        }

        init(from decoder: Decoder) throws {
            let root = try decoder.container(keyedBy: CodingKeys.self)
            let container = (try? root.nestedContainer(
                keyedBy: CodingKeys.self,
                forKey: .data
            )) ?? root
            actions = (try? container.decode(
                [PendingAction].self,
                forKey: .actions
            )) ?? []
            nextCursor = try? container.decodeIfPresent(
                String.self,
                forKey: .nextCursor
            )
        }
    }

    private struct PendingAction: Decodable {
        let id: String
        let type: String?
        let status: String?
        let summary: String?
        let conversationId: String?
        let createdAt: String?
        let expired: Bool?

        var taskItem: TaskItem {
            TaskItem(
                id: "action:\(id)",
                actionId: id,
                turnId: nil,
                conversationId: conversationId,
                status: "attention",
                title: Self.title(for: type),
                detail: Self.detail(from: summary),
                updatedAt: createdAt ?? "",
                dismissible: false
            )
        }

        private static func title(for type: String?) -> String {
            switch type {
            case "agent_voice_call": return "Voice call (two-way)"
            case "outbound_call": return "Voice call (one-way)"
            case "dispatch_staff_tasks": return "Dispatch tasks"
            case "send_customer_message": return "Customer message"
            case "staff_announcement": return "Staff announcement"
            case "fb_post": return "Facebook post"
            case "instagram_post": return "Instagram post"
            case "marketing_plan": return "Marketing plan"
            default:
                let words = (type ?? "")
                    .replacingOccurrences(of: "_", with: " ")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard !words.isEmpty else { return "Agent approval" }
                return String(words.prefix(1)).uppercased()
                    + String(words.dropFirst())
            }
        }

        private static func detail(from summary: String?) -> String {
            let normalized = (summary ?? "")
                .replacingOccurrences(
                    of: #"\s+"#,
                    with: " ",
                    options: .regularExpression
                )
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !normalized.isEmpty else {
                return "Approve বা Reject করার অপেক্ষায়"
            }
            return String(normalized.prefix(140))
        }
    }

    private var reducerState: ReducerState
    private var pollTask: Task<Void, Never>?
    private var pollGeneration: UUID?
    private var lifecycleObservers: [NSObjectProtocol] = []
    private var isInstalled = false
    private var dismissedItemIds: Set<String>
    private var isUsingDebugFixture = false
    private var headlineTask: Task<Void, Never>?
    private var headlineSignature = ""
    private var approvalReactionClearTask: Task<Void, Never>?

    private init() {
        dismissedItemIds = Set(
            UserDefaults.standard.stringArray(forKey: Self.dismissedItemsKey) ?? []
        )
        reducerState = ReducerState(
            hasEstablishedBaseline: false,
            lastObservedCompletionTurnId: nil,
            lastObservedCompletionCursor: nil,
            completionToken: 0
        )
    }

    /// Register lifecycle observers once and begin polling when already active.
    /// Safe to call repeatedly from AppDelegate or the native shell.
    func install() {
        guard !isInstalled else {
            if UIApplication.shared.applicationState == .active { start() }
            return
        }
        isInstalled = true

        #if DEBUG
        if OfficeRobotDebugFixture.isEnabled {
            installDebugFixture()
            return
        }
        #endif

        let center = NotificationCenter.default
        lifecycleObservers.append(
            center.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.start() }
            }
        )
        lifecycleObservers.append(
            center.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.stop() }
            }
        )
        lifecycleObservers.append(
            center.addObserver(
                forName: AlmaAPI.authExpiredNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.clearVolatileStateForSessionChange() }
            }
        )
        lifecycleObservers.append(
            center.addObserver(
                forName: .almaAuthenticationDidRestore,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.start() }
            }
        )
        lifecycleObservers.append(
            center.addObserver(
                forName: Notification.Name("almaApprovalsChanged"),
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in await self?.refreshNow() }
            }
        )

        if UIApplication.shared.applicationState == .active {
            start()
        }
    }

    /// Starts exactly one structured polling loop. The first refresh is immediate.
    func start() {
        guard !isUsingDebugFixture else { return }
        guard UIApplication.shared.applicationState == .active else { return }
        guard pollTask == nil else { return }

        let generation = UUID()
        pollGeneration = generation
        pollTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled, self.pollGeneration == generation {
                await self.refresh(expectedGeneration: generation)
                do {
                    try await Task.sleep(nanoseconds: Self.pollIntervalNanoseconds)
                } catch {
                    return
                }
            }
        }
    }

    /// Stops polling immediately. An in-flight request is prevented from applying
    /// stale state by both task cancellation and the generation check.
    func stop() {
        pollGeneration = nil
        pollTask?.cancel()
        pollTask = nil
    }

    /// Explicit active-app refresh hook for the eventual global overlay.
    func refreshNow() async {
        guard UIApplication.shared.applicationState == .active else { return }
        if let generation = pollGeneration {
            await refresh(expectedGeneration: generation)
            return
        }

        // A manual refresh also establishes the one canonical polling loop.
        start()
    }

    /// Test seam used by reducer tests and the network adapter.
    func apply(snapshot: Snapshot) {
        let reduction = Self.reduce(snapshot: snapshot, state: reducerState)
        reducerState = reduction.state

        runningCount = reduction.runningCount
        attentionCount = reduction.attentionCount
        taskCount = reduction.taskCount
        completionToken = reduction.state.completionToken
        if let acceptedCompletion = reduction.latestCompletion {
            latestCompletion = acceptedCompletion
        }
    }

    @discardableResult
    func beginApprovalReaction(_ decision: ApprovalDecision) -> UUID {
        let id = UUID()
        approvalReactionClearTask?.cancel()
        approvalReaction = ApprovalReaction(
            id: id,
            decision: decision,
            phase: .processing
        )
        transientHeadlineItem = nil

        let impact = UIImpactFeedbackGenerator(style: .medium)
        impact.prepare()
        impact.impactOccurred(intensity: 0.82)
        return id
    }

    func finishApprovalReaction(
        id: UUID,
        decision: ApprovalDecision,
        succeeded: Bool
    ) {
        guard approvalReaction?.id == id else { return }
        approvalReaction = ApprovalReaction(
            id: id,
            decision: decision,
            phase: succeeded ? .succeeded : .failed
        )

        let feedback = UINotificationFeedbackGenerator()
        feedback.prepare()
        if succeeded, decision == .approve {
            feedback.notificationOccurred(.success)
            ApprovalRobotSound.shared.play(.approve)
        } else if succeeded {
            feedback.notificationOccurred(.warning)
            ApprovalRobotSound.shared.play(.reject)
        } else {
            feedback.notificationOccurred(.error)
            ApprovalRobotSound.shared.play(.reject)
        }

        if succeeded {
            Task { @MainActor [weak self] in
                await self?.refreshNow()
            }
        }

        approvalReactionClearTask?.cancel()
        approvalReactionClearTask = Task { @MainActor [weak self] in
            let duration: Duration = decision == .approve
                ? .milliseconds(2_400)
                : .milliseconds(5_250)
            try? await Task.sleep(for: duration)
            guard !Task.isCancelled, self?.approvalReaction?.id == id else { return }
            self?.approvalReaction = nil
            self?.reconcileHeadlineLoop(force: true)
        }
    }

    func dismiss(_ item: TaskItem) {
        guard item.dismissible else { return }
        dismissedItemIds.insert(item.id)
        UserDefaults.standard.set(
            Array(dismissedItemIds).sorted(),
            forKey: Self.dismissedItemsKey
        )
        items.removeAll { $0.id == item.id }
        reconcileHeadlineLoop(force: true)
    }

    private func refresh(expectedGeneration: UUID) async {
        async let petStatus = fetchPetStatus()
        async let pendingActions = fetchPendingActions()
        let (pet, actions) = await (petStatus, pendingActions)

        guard !Task.isCancelled,
              pollGeneration == expectedGeneration,
              UIApplication.shared.applicationState == .active,
              pet != nil || actions != nil
        else { return }

        var mergedItems: [TaskItem]
        if let petItems = pet?.items {
            mergedItems = petItems
        } else {
            // Missing means an old count-only server or a partial response;
            // retain the last good feed. A present [] remains authoritative.
            mergedItems = items
        }
        var resolvedAttentionCount = pet?.attentionCount ?? attentionCount

        if let actions {
            // /api/assistant/actions is the same owner-visible source used by
            // the Agent Approvals screen. It remains authoritative even while
            // production /pet-status is on its older count-only response.
            mergedItems.removeAll { $0.status == "attention" }
            let actionItems = actions.actions
                .filter {
                    ($0.status ?? "pending") == "pending"
                        && $0.expired != true
                        && !$0.id.isEmpty
                }
                .map(\.taskItem)
            mergedItems.append(contentsOf: actionItems)
            resolvedAttentionCount = actionItems.count
        }

        apply(
            snapshot: Snapshot(
                runningCount: pet?.runningCount ?? runningCount,
                attentionCount: resolvedAttentionCount,
                latestCompletion: pet?.latestCompletion
            )
        )
        publishItems(
            mergedItems
                .filter { !dismissedItemIds.contains($0.id) }
                .sorted {
                    if $0.status != $1.status {
                        if $0.status == "attention" { return true }
                        if $1.status == "attention" { return false }
                    }
                    return $0.updatedAt > $1.updatedAt
                }
        )
        lastRefreshAt = Date()
    }

    private func fetchPetStatus() async -> PetStatusResponse? {
        try? await AlmaAPI.shared.get("/api/assistant/pet-status")
    }

    private func fetchPendingActions() async -> PendingActionsResponse? {
        var cursor: String?
        var collected: [PendingAction] = []
        var seenIds = Set<String>()
        var seenCursors = Set<String>()

        // Pending approval count and rows must come from the same complete
        // owner queue. The hard page guard protects against a malformed server
        // cursor without bringing back the old silent 100-row truncation.
        for _ in 0..<100 {
            let page: PendingActionsResponse
            do {
                page = try await AlmaAPI.shared.get(
                    "/api/assistant/actions",
                    query: [
                        "status": "pending",
                        "limit": "100",
                        "cursor": cursor,
                    ]
                )
            } catch {
                return collected.isEmpty
                    ? nil
                    : PendingActionsResponse(
                        actions: collected,
                        nextCursor: nil
                    )
            }

            for action in page.actions where seenIds.insert(action.id).inserted {
                collected.append(action)
            }
            guard let next = page.nextCursor,
                  !next.isEmpty,
                  seenCursors.insert(next).inserted
            else {
                return PendingActionsResponse(
                    actions: collected,
                    nextCursor: nil
                )
            }
            cursor = next
        }

        return PendingActionsResponse(actions: collected, nextCursor: nil)
    }

    private static func clamp(_ value: Int) -> Int {
        min(max(value, 0), maximumPublishedCount)
    }

    private static func saturatingAdd(_ lhs: Int, _ rhs: Int) -> Int {
        let left = clamp(lhs)
        let right = clamp(rhs)
        guard left <= maximumPublishedCount - right else {
            return maximumPublishedCount
        }
        return left + right
    }

    private static func incrementToken(_ value: Int) -> Int {
        value == Int.max ? 1 : value + 1
    }

    private func clearVolatileStateForSessionChange() {
        stop()
        reducerState = ReducerState(
            hasEstablishedBaseline: false,
            lastObservedCompletionTurnId: nil,
            lastObservedCompletionCursor: nil,
            completionToken: completionToken
        )
        runningCount = 0
        attentionCount = 0
        taskCount = 0
        publishItems([])
        latestCompletion = nil
        lastRefreshAt = nil
    }

    private func publishItems(_ nextItems: [TaskItem]) {
        items = nextItems
        reconcileHeadlineLoop()
    }

    private func reconcileHeadlineLoop(force: Bool = false) {
        let candidates = items
            .filter { $0.status == "attention" || $0.status == "running" }
            .sorted {
                if $0.status != $1.status { return $0.status == "attention" }
                return $0.updatedAt > $1.updatedAt
            }
        let signature = candidates
            .map { "\($0.id)#\($0.status)#\($0.detail)" }
            .joined(separator: "|")

        guard force || signature != headlineSignature else { return }
        headlineSignature = signature
        headlineTask?.cancel()
        headlineTask = nil
        transientHeadlineItem = nil
        guard !candidates.isEmpty, approvalReaction == nil else { return }

        #if DEBUG
        let interval = ProcessInfo.processInfo.environment[
            "ALMA_ROBOT_HEADLINE_INTERVAL"
        ].flatMap(Double.init).map { max(7, $0) } ?? 60
        #else
        let interval: Double = 60
        #endif
        let visibleSeconds = min(6, interval - 1)

        headlineTask = Task { @MainActor [weak self] in
            var index = 0
            while !Task.isCancelled {
                guard let self, self.approvalReaction == nil else { return }
                self.transientHeadlineItem = candidates[index % candidates.count]
                try? await Task.sleep(for: .seconds(visibleSeconds))
                guard !Task.isCancelled else { return }
                self.transientHeadlineItem = nil
                try? await Task.sleep(for: .seconds(interval - visibleSeconds))
                index += 1
            }
        }
    }

    #if DEBUG
    private func installDebugFixture() {
        isUsingDebugFixture = true
        let now = ISO8601DateFormatter().string(from: Date())
        let attentionItems = OfficeRobotDebugFixture.pending.map {
            TaskItem(
                id: $0.id,
                actionId: $0.actionId,
                turnId: nil,
                conversationId: nil,
                status: "attention",
                title: $0.title,
                detail: $0.detail,
                updatedAt: now,
                dismissible: false
            )
        }
        publishItems(attentionItems + [
            TaskItem(
                id: "fixture:running",
                actionId: nil,
                turnId: "fixture-running",
                conversationId: "fixture-running",
                status: "running",
                title: "Meta campaign audit",
                detail: "Ads data যাচাই করছে",
                updatedAt: now,
                dismissible: false
            ),
            TaskItem(
                id: "fixture:completed",
                actionId: nil,
                turnId: "fixture-completed",
                conversationId: "fixture-completed",
                status: "completed",
                title: "Attendance report",
                detail: "রিপোর্ট তৈরি হয়েছে — খুলতে tap করুন",
                updatedAt: now,
                dismissible: true
            ),
        ])
        apply(
            snapshot: Snapshot(
                runningCount: 1,
                attentionCount: attentionItems.count
            )
        )
        scheduleDebugApprovalDemoIfRequested()
    }

    /// Simulator fixture decisions exercise the same Robot reaction/SFX path
    /// without POSTing an ID that cannot exist on the server.
    func resolveDebugFixtureAction(
        actionId: String,
        decision: ApprovalDecision
    ) async {
        guard isUsingDebugFixture,
              OfficeRobotDebugFixture.pending.contains(where: {
                  $0.actionId == actionId
              })
        else { return }

        let reactionId = beginApprovalReaction(decision)
        try? await Task.sleep(for: .milliseconds(850))
        OfficeRobotDebugFixture.resolve(actionId: actionId, decision: decision)
        let remainingIds = Set(
            OfficeRobotDebugFixture.pending.map(\.actionId)
        )
        publishItems(
            items.filter {
                $0.status != "attention"
                    || ($0.actionId.map(remainingIds.contains) ?? false)
            }
        )
        apply(
            snapshot: Snapshot(
                runningCount: 1,
                attentionCount: remainingIds.count
            )
        )
        finishApprovalReaction(
            id: reactionId,
            decision: decision,
            succeeded: true
        )
    }

    private func scheduleDebugApprovalDemoIfRequested() {
        let env = ProcessInfo.processInfo.environment[
            "ALMA_ROBOT_APPROVAL_DEMO"
        ]
        let argument = ProcessInfo.processInfo.arguments
            .first { $0.hasPrefix("ALMA_ROBOT_APPROVAL_DEMO=") }?
            .split(separator: "=", maxSplits: 1)
            .last
            .map(String.init)
        guard let raw = (env ?? argument)?.lowercased(), !raw.isEmpty else { return }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self else { return }
            let first: ApprovalDecision = raw == "reject" ? .reject : .approve
            let firstId = beginApprovalReaction(first)
            try? await Task.sleep(for: .seconds(2.2))
            finishApprovalReaction(id: firstId, decision: first, succeeded: true)

            guard raw == "both" else { return }
            try? await Task.sleep(for: .seconds(4))
            let rejectId = beginApprovalReaction(.reject)
            try? await Task.sleep(for: .seconds(2.2))
            finishApprovalReaction(id: rejectId, decision: .reject, succeeded: true)
        }
    }
    #endif
}

// MARK: - Robot approval sound

/// Plays the owner's two authored Robot cues without synthesizing speech or
/// changing the shared audio-session category (Voice/Call remains the owner).
@MainActor
private final class ApprovalRobotSound {
    static let shared = ApprovalRobotSound()

    private var player: AVAudioPlayer?

    func play(_ decision: GlobalOfficeRobotStore.ApprovalDecision) {
        player?.stop()
        let name = decision == .approve ? "RobotApproveSFX" : "RobotRejectSFX"
        guard let url = Bundle.main.url(
            forResource: name,
            withExtension: "mp3"
        ), let nextPlayer = try? AVAudioPlayer(contentsOf: url) else {
            #if DEBUG
            RobotSelfTestTrace.mark("robotApproval.soundMissing.\(decision.rawValue)")
            #endif
            return
        }
        nextPlayer.volume = decision == .approve ? 0.88 : 0.82
        nextPlayer.prepareToPlay()
        let started = nextPlayer.play()
        player = nextPlayer
        #if DEBUG
        RobotSelfTestTrace.mark(
            started
                ? "robotApproval.sound.\(decision.rawValue)"
                : "robotApproval.soundFailed.\(decision.rawValue)"
        )
        #endif
    }
}
