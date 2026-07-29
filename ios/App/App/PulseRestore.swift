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

    #if DEBUG
    /// Sim-testing hook (DEBUG only): launching with ALMA_PULSE_RESET=1 ends
    /// every Pulse activity before the restore runs, forcing a FRESH activity
    /// from the cache. Needed because the simulator's SpringBoard freezes the
    /// compact island snapshot at first render and ignores updates
    /// (live-verified 2026-07-16: pushed state changes never repainted the
    /// compact slot) — only a new activity re-renders it there. Devices
    /// repaint on update, so this hook is pointless (and absent) in Release.
    @available(iOS 16.1, *)
    static func debugResetIfRequested() async {
        guard ProcessInfo.processInfo.arguments.contains("ALMA_PULSE_RESET=1")
            || ProcessInfo.processInfo.environment["ALMA_PULSE_RESET"] == "1" else { return }
        for activity in Activity<PulseActivityAttributes>.activities {
            if #available(iOS 16.2, *) {
                await activity.end(nil, dismissalPolicy: .immediate)
            } else {
                await activity.end(dismissalPolicy: .immediate)
            }
        }
        note("debug_reset")
    }

    /// Sim-testing hook (DEBUG only): `ALMA_PULSE_DEMO=approval` starts an
    /// actionable approval; `working` starts a line-by-line Agent task panel.
    /// Both carry a fresh update epoch so the Robot's explicit ≤2s transition
    /// can be recorded without pretending that arbitrary background timers are
    /// reliable. Release receives these epochs from the real snapshot/push.
    /// Returns true when it started the demo, so launch skips the cache restore/sync.
    @available(iOS 16.2, *)
    static func debugStartDemoApprovalIfRequested() async -> Bool {
        #if canImport(ActivityKit)
        guard let demo = ProcessInfo.processInfo.environment["ALMA_PULSE_DEMO"],
              demo == "approval" || demo == "working" else { return false }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            if ProcessInfo.processInfo.environment["ALMA_ROBOT_SELFTEST"] == "1" {
                RobotSelfTestTrace.mark("robotSelfTest.dynamicIslandDisabled")
            }
            note("demo_activities_disabled")
            return false
        }
        for activity in Activity<PulseActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        let now = Date().timeIntervalSince1970
        let json: String
        if demo == "working" {
            json = #"""
            {"ordersToday":1,"statusLine":"২টি Agent কাজ চলছে","mode":"working","headline":"২টি Agent কাজ চলছে","subtitle":"Meta campaign audit · Ads data যাচাই করছে","pendingTaskCount":2,"approvalCount":0,"runningOrderCount":0,"pendingApprovals":0,"openTasks":2,"updatedAtEpoch":\#(now),"staleAfterEpoch":\#(now + 900),"items":[{"id":"agent-task:demo-meta","kind":"pendingTask","title":"Meta campaign audit","subtitle":"Ads data যাচাই করছে","valueText":"চলছে","severity":"attention","createdAtEpoch":\#(now),"link":"almaerp://agent?conversationId=demo-meta"},{"id":"agent-task:demo-stock","kind":"pendingTask","title":"Inventory update","subtitle":"Stock adjustment প্রস্তুত করছে","valueText":"চলছে","severity":"normal","createdAtEpoch":\#(now),"link":"almaerp://agent?conversationId=demo-stock"}]}
            """#
        } else {
            json = #"""
            {"ordersToday":1,"statusLine":"১টা অনুমোদন অপেক্ষায়","mode":"approval","headline":"আপনার অনুমোদন দরকার","subtitle":"১টা অনুরোধ অপেক্ষায় · এখনই সিদ্ধান্ত দিন","pendingTaskCount":2,"approvalCount":1,"runningOrderCount":1,"orderProgress":0.5,"pendingApprovals":1,"openTasks":2,"updatedAtEpoch":\#(now),"staleAfterEpoch":\#(now + 900),"approvalId":"erp:demo-approval-000","approvalTitle":"ওয়ালেট উত্তোলন — টেস্ট","approvalCounterparty":"PAYROLL · এখন","approvalAmountText":"৳৭,৪০০"}
            """#
        }
        guard let data = json.data(using: .utf8),
              let state = try? JSONDecoder().decode(PulseActivityAttributes.ContentState.self, from: data) else {
            if ProcessInfo.processInfo.environment["ALMA_ROBOT_SELFTEST"] == "1" {
                RobotSelfTestTrace.mark("robotSelfTest.dynamicIslandDecodeFailed")
            }
            note("demo_decode_failed")
            return false
        }
        do {
            if ProcessInfo.processInfo.environment["ALMA_ROBOT_SELFTEST"] == "1" {
                RobotSelfTestTrace.mark("robotSelfTest.dynamicIslandRequesting")
            }
            _ = try Activity.request(
                attributes: PulseActivityAttributes(title: "ALMA"),
                content: ActivityContent(state: state, staleDate: nil),
                pushType: nil)
            note("debug_demo_approval")
            if ProcessInfo.processInfo.environment["ALMA_ROBOT_SELFTEST"] == "1" {
                RobotSelfTestTrace.mark("robotSelfTest.dynamicIslandStarted")
                AlmaPerfLog.event("robotSelfTest.dynamicIslandStarted")
            }
            return true
        } catch {
            if ProcessInfo.processInfo.environment["ALMA_ROBOT_SELFTEST"] == "1" {
                RobotSelfTestTrace.mark("robotSelfTest.dynamicIslandRequestFailed")
            }
            note("demo_request_failed: \(error.localizedDescription)")
            return false
        }
        #else
        return false
        #endif
    }
    #endif

    @available(iOS 16.1, *)
    static func restartFromCache() {
        #if canImport(ActivityKit)
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            note("activities_disabled"); return
        }

        // Pulse already live: don't fight it — but push one SILENT same-state
        // update so the system re-renders it under the CURRENT widget binary.
        // Without this, an activity started before an app update keeps showing
        // the old build's compact layout until the next (throttled, webview-
        // dependent) web sync — live-hit 2026-07-16 while shipping the
        // approvals-first island. Silent by contract: no AlertConfiguration.
        if let live = Activity<PulseActivityAttributes>.activities.first {
            // App termination also terminates the previous token observer.
            // Re-observe (deduped inside the bridge) so an activity that
            // survived the process can register its current APNs token again.
            LiveActivityBridgePlugin.observePushToken(of: live)
            if let cached = readCache() {
                let staleDate = cached.state.staleAfterDate.flatMap { $0 > Date() ? $0 : nil }
                Task {
                    if #available(iOS 16.2, *) {
                        await live.update(ActivityContent(state: cached.state, staleDate: staleDate))
                    } else {
                        await live.update(using: cached.state)
                    }
                }
                note("refreshed_live")
            } else {
                note("already_live")
            }
            return
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
            let request = try LiveActivityBridgePlugin.requestPulseActivity(
                attributes: attributes,
                state: cached.state,
                staleDate: staleDate
            )
            if request.pushBacked {
                LiveActivityBridgePlugin.observePushToken(of: request.activity)
            }
            note(request.pushBacked ? "restored" : "restored_local")
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
