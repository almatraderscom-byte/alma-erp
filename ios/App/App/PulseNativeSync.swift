//
//  PulseNativeSync.swift
//  App target only.
//
//  Native Dynamic-Panel sync — the fix for the device-hit 2026-07-17 outage:
//  the panel's ONLY data path was the hidden Capacitor webview's
//  LivePulseManager fetch, and that webview's session cookie had expired, so
//  every sync 401'd (Vercel logs) and the owner's island sat on stale counts
//  (grey clock, wrong numbers, no approval mode/nag/colour) for hours while
//  the SERVER was already serving the correct snapshot.
//
//  This path uses AlmaAPI — the native URLSession layer that syncs cookies
//  from the SHARED WKWebsiteDataStore (the store the owner's visible, working
//  tabs keep fresh) — so the panel no longer depends on the hidden webview's
//  session at all. The web-layer sync stays untouched as a second writer;
//  both funnel into the same plugin cache/apply pipeline, so whichever runs
//  last simply refreshes the same activity (idempotent).
//
//  Safety contract: silent no-op on ANY failure, throttled, never touches the
//  voice island, and reuses the EXACT plugin primitives (cache → nag → apply)
//  so behavior stays identical to a web-driven update.
//

import Foundation

#if canImport(ActivityKit)
import ActivityKit
#endif

enum PulseNativeSync {
    /// Native sync cadence — matches the web layer's 5-minute throttle so the
    /// two writers together stay ~one update per few minutes.
    private static let throttleSeconds: TimeInterval = 240
    private static let lastSyncKey = "alma.pulse.lastNativeSyncAt"

    /// Fire-and-forget: fetch the canonical snapshot over the NATIVE session
    /// and drive the Live Activity exactly like a webview update would.
    @available(iOS 16.1, *)
    static func syncNow(reason: String) {
        #if canImport(ActivityKit)
        let now = Date().timeIntervalSince1970
        let last = UserDefaults.standard.double(forKey: lastSyncKey)
        guard now - last >= throttleSeconds else { return }
        UserDefaults.standard.set(now, forKey: lastSyncKey)

        Task {
            guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
            if #available(iOS 17.0, *),
               !Activity<AlmaVoiceActivityAttributes>.activities.isEmpty {
                return   // voice owns the island — never fight it
            }
            do {
                let state: PulseActivityAttributes.ContentState =
                    try await AlmaAPI.shared.get("/api/assistant/live-pulse")
                LiveActivityBridgePlugin.breadcrumb(
                    "native_sync(\(reason)) approvals=\(state.approvals) orders=\(state.runningOrders)")
                LiveActivityBridgePlugin.cacheLastState(title: "ALMA ERP", state: state)
                let alert = LiveActivityBridgePlugin.approvalNagAlert(for: state)
                LiveActivityBridgePlugin.applyCore(state: state, title: "ALMA ERP", alert: alert)
            } catch {
                // 401/offline/decode — the panel keeps its honest stale state;
                // breadcrumb only, never a crash, never a fake update.
                LiveActivityBridgePlugin.breadcrumb("native_sync_failed(\(reason))")
            }
        }
        #endif
    }
}
