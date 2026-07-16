//
//  PulseRestore.swift
//  App target only.
//
//  Brings the "Business Pulse" Dynamic Panel back after a voice session, and
//  reconciles duplicate activities on launch/foreground (spec §14).
//
//  Why restore exists: VoiceLiveActivityController.start() ends any running
//  Pulse activity (voice owns the island during a conversation). The web layer
//  only restarts Pulse when the app is next foregrounded — so after a voice
//  session ended from the island/lock screen, the pulse stayed gone. This
//  restores it from the payload LiveActivityBridgePlugin caches on every update.
//
//  Safety contract: silent no-op on ANY failure — never throws out, never
//  crashes. Stale cache (> 6h) is ignored. The restored state keeps the cached
//  timestamps, so a restore can never make old data look current — the panel
//  renders itself stale via ActivityKit's own staleDate.
//
//  Reconciliation is SILENT by contract: it never passes an AlertConfiguration,
//  so restoring state can never replay an approval chime (spec §14).
//

import Foundation

#if canImport(ActivityKit)
import ActivityKit
#endif

enum PulseRestore {
    /// Cached payloads older than this are considered stale and not restored.
    private static let maxCacheAge: TimeInterval = 6 * 60 * 60

    /// Re-request the Pulse Live Activity from the cached last state, if it is
    /// safe and sensible to do so. Silent no-op otherwise.
    /// Restore-outcome breadcrumb (UserDefaults, no PII) — the restore path is
    /// deliberately silent, and this is its one observable trace (same pattern
    /// as the plugin's `alma.pulse.lastResult`).
    private static let lastRestoreKey = "alma.pulse.lastRestore"
    private static func note(_ reason: String) {
        UserDefaults.standard.set(
            "\(reason) @\(Int(Date().timeIntervalSince1970))", forKey: lastRestoreKey)
    }

    @available(iOS 16.1, *)
    static func restartFromCache() {
        #if canImport(ActivityKit)
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            note("activities_disabled"); return
        }

        // Never fight an existing activity: skip if Pulse is already live, or
        // if a voice session still owns the island.
        guard Activity<PulseActivityAttributes>.activities.isEmpty else {
            note("already_live"); return
        }
        if #available(iOS 17.0, *) {
            guard Activity<AlmaVoiceActivityAttributes>.activities.isEmpty else {
                note("voice_active"); return
            }
        }

        guard let cached = readCache() else { note("no_fresh_cache"); return }

        // A stale-by-now cache still restores (the panel honestly renders its
        // stale state), but never hand ActivityKit a PAST staleDate — some OS
        // versions reject it at request time.
        let staleDate = cached.state.staleAfterDate.flatMap { $0 > Date() ? $0 : nil }

        let attributes = PulseActivityAttributes(title: cached.title)
        do {
            let activity: Activity<PulseActivityAttributes>
            if #available(iOS 16.2, *) {
                activity = try Activity.request(
                    attributes: attributes,
                    content: ActivityContent(state: cached.state, staleDate: staleDate),
                    pushType: .token
                )
            } else {
                activity = try Activity.request(
                    attributes: attributes,
                    contentState: cached.state,
                    pushType: .token
                )
            }
            LiveActivityBridgePlugin.observePushToken(of: activity)
            note("restored")
        } catch {
            note("request_failed: \(error.localizedDescription)")
        }
        #endif
    }

    /// On launch / foreground return: end duplicate Pulse activities so only one
    /// survives (spec §14). ActivityKit can leave more than one alive if the app
    /// was killed mid-request; two panels for one workspace is always wrong.
    @available(iOS 16.1, *)
    static func reconcile() {
        #if canImport(ActivityKit)
        let activities = Activity<PulseActivityAttributes>.activities
        guard activities.count > 1 else { return }
        // Keep the first, end the rest. The surviving one is refreshed by the
        // web layer's next syncLivePulse() with authoritative server data.
        Task {
            for activity in activities.dropFirst() {
                if #available(iOS 16.2, *) {
                    await activity.end(nil, dismissalPolicy: .immediate)
                } else {
                    await activity.end(dismissalPolicy: .immediate)
                }
            }
        }
        #endif
    }

    // MARK: - Cache

    #if canImport(ActivityKit)
    @available(iOS 16.1, *)
    private struct Cached {
        let title: String
        let state: PulseActivityAttributes.ContentState
    }

    @available(iOS 16.1, *)
    private static func readCache() -> Cached? {
        guard let data = UserDefaults.standard.data(forKey: LiveActivityBridgePlugin.lastStateKey),
              let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let savedAt = payload["savedAt"] as? TimeInterval,
              Date().timeIntervalSince(Date(timeIntervalSince1970: savedAt)) < maxCacheAge
        else { return nil }

        let title = payload["title"] as? String ?? "ALMA ERP"

        // v3 cache — the canonical snapshot JSON.
        if let json = payload["snapshotJson"] as? String,
           let jsonData = json.data(using: .utf8),
           let state = try? JSONDecoder().decode(
               PulseActivityAttributes.ContentState.self, from: jsonData
           ) {
            return Cached(title: title, state: state)
        }

        // v1/v2 cache written by an older build that is still on disk after the
        // app update — restore what it had rather than dropping the panel.
        let state = PulseActivityAttributes.ContentState(
            ordersToday: payload["ordersToday"] as? Int ?? 0,
            statusLine: payload["statusLine"] as? String ?? "",
            updatedAt: Date(timeIntervalSince1970: payload["updatedAt"] as? TimeInterval ?? savedAt),
            pendingApprovals: payload["pendingApprovals"] as? Int ?? 0,
            openTasks: payload["openTasks"] as? Int ?? 0
        )
        return Cached(title: title, state: state)
    }
    #endif
}
