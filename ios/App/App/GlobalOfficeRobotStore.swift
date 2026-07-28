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
import UIKit

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

    /// Monotonic UI edge trigger. Initial launch establishes a baseline without
    /// incrementing; a later, explicitly new completion increments exactly once.
    @Published private(set) var completionToken = 0
    @Published private(set) var latestCompletion: LatestCompletion?
    @Published private(set) var lastRefreshAt: Date?

    static let maximumPublishedCount = 999
    static let pollIntervalNanoseconds: UInt64 = 12_000_000_000

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
        let latestCompletion: LatestCompletion?

        var snapshot: Snapshot {
            return Snapshot(
                runningCount: runningCount,
                attentionCount: attentionCount,
                latestCompletion: latestCompletion
            )
        }
    }

    private var reducerState: ReducerState
    private var pollTask: Task<Void, Never>?
    private var pollGeneration: UUID?
    private var lifecycleObservers: [NSObjectProtocol] = []
    private var isInstalled = false

    private init() {
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

        if UIApplication.shared.applicationState == .active {
            start()
        }
    }

    /// Starts exactly one structured polling loop. The first refresh is immediate.
    func start() {
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

    private func refresh(expectedGeneration: UUID) async {
        do {
            let response: PetStatusResponse = try await AlmaAPI.shared.get(
                "/api/assistant/pet-status"
            )
            guard !Task.isCancelled,
                  pollGeneration == expectedGeneration,
                  UIApplication.shared.applicationState == .active
            else { return }

            apply(snapshot: response.snapshot)
            lastRefreshAt = Date()
        } catch {
            // Fail open: retain the last server-confirmed counts. A transient
            // network/auth failure must not flash a false idle state.
        }
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
        latestCompletion = nil
        lastRefreshAt = nil
    }
}
