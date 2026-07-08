//
//  PulseRestore.swift
//  App target only.
//
//  Brings the "Business Pulse" Live Activity back after a voice session.
//
//  Why: VoiceLiveActivityController.start() ends any running Pulse activity
//  (voice owns the island during a conversation). The web layer only restarts
//  Pulse when the app is next foregrounded — so after a voice session ended
//  from the island/lock screen, the pulse stayed gone. This restores it from
//  the payload LiveActivityBridgePlugin caches on every update.
//
//  Safety contract: silent no-op on ANY failure — never throws out, never
//  crashes. Stale cache (> 6h) is ignored; the restored state keeps the
//  cached `updatedAt` (the data is only as fresh as when it was cached).
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
    @available(iOS 16.1, *)
    static func restartFromCache() {
        #if canImport(ActivityKit)
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        // Never fight an existing activity: skip if Pulse is already live, or
        // if a voice session still owns the island.
        guard Activity<PulseActivityAttributes>.activities.isEmpty else { return }
        if #available(iOS 17.0, *) {
            guard Activity<AlmaVoiceActivityAttributes>.activities.isEmpty else { return }
        }

        guard let data = UserDefaults.standard.data(forKey: LiveActivityBridgePlugin.lastStateKey),
              let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let savedAt = payload["savedAt"] as? TimeInterval,
              Date().timeIntervalSince(Date(timeIntervalSince1970: savedAt)) < maxCacheAge
        else { return }

        let ordersToday = payload["ordersToday"] as? Int ?? 0
        let statusLine = payload["statusLine"] as? String ?? ""
        let title = payload["title"] as? String ?? "ALMA ERP"
        let pendingApprovals = payload["pendingApprovals"] as? Int ?? 0
        let openTasks = payload["openTasks"] as? Int ?? 0
        // Keep the cached updatedAt — the data is as fresh as when it was
        // cached, not "now". Fall back to savedAt if absent.
        let updatedAt = Date(timeIntervalSince1970: payload["updatedAt"] as? TimeInterval ?? savedAt)

        let state = PulseActivityAttributes.ContentState(
            ordersToday: ordersToday,
            statusLine: statusLine,
            updatedAt: updatedAt,
            pendingApprovals: pendingApprovals,
            openTasks: openTasks
        )
        let attributes = PulseActivityAttributes(title: title)

        if #available(iOS 16.2, *) {
            _ = try? Activity.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: nil),
                pushType: nil
            )
        } else {
            _ = try? Activity.request(
                attributes: attributes,
                contentState: state,
                pushType: nil
            )
        }
        #endif
    }
}
