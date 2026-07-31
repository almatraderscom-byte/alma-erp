//
//  LiveActivityBridge.swift
//  App
//
//  Local Capacitor plugin that lets the web app (while in the foreground)
//  start / update / end the "Business Pulse" Dynamic Panel via ActivityKit.
//
//  JS side calls:
//    LiveActivityBridge.update({ title, snapshotJson, alert?, … }) → { started }
//    LiveActivityBridge.markOffline()                              → { ok }
//    LiveActivityBridge.end()                                      → { ended }
//
//  This is a *local* plugin (not a published pod). It is registered by
//  AlmaBridgeViewController.capacitorDidLoad() via bridge.registerPluginInstance().
//  The CAPBridgedPlugin shape mirrors Capacitor 7's shipped plugins exactly
//  (see @capacitor/haptics HapticsPlugin.swift).
//
//  Safety contract: this plugin NEVER crashes. Below iOS 16.1, when ActivityKit
//  is unavailable/disabled, or on any thrown error, it resolves the promise with
//  a falsy result instead of rejecting-hard or trapping.
//
//  SOUND: an alert (and therefore a sound) is requested ONLY when the caller
//  passes `alert: true`, which the web layer does solely for a NEW approval or
//  urgent event it has not alerted on before (spec §11). Every ordinary count /
//  progress refresh goes through the silent path.
//

import Capacitor
import Foundation
import UIKit
import UserNotifications

#if canImport(ActivityKit)
import ActivityKit
#endif

@objc(LiveActivityBridgePlugin)
public class LiveActivityBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveActivityBridgePlugin"
    public let jsName = "LiveActivityBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "markOffline", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise)
    ]

    /// UserDefaults key holding the last pulse payload as JSON (with a
    /// `savedAt` timestamp). PulseRestore reads this to bring the island back
    /// after a voice session ends while the app is backgrounded.
    static let lastStateKey = "alma.pulse.lastState"

    /// UserDefaults breadcrumb: the outcome of the LAST update() call
    /// ("updated" / "started" / "activities_disabled" / "voice_active" / …) plus
    /// a timestamp. The plugin is deliberately fail-open, which also makes it
    /// silent — this is the one observable trace of WHY the panel did or didn't
    /// refresh, readable in diagnostics without any logging. No PII.
    static let lastResultKey = "alma.pulse.lastResult"

    static func breadcrumb(_ reason: String) {
        UserDefaults.standard.set(
            "\(reason) @\(Int(Date().timeIntervalSince1970))", forKey: lastResultKey)
    }

    // MARK: - update

    @objc public func update(_ call: CAPPluginCall) {
        // First line on purpose: distinguishes "JS→native dispatch happened"
        // from every later guard/outcome (each of which overwrites this).
        Self.breadcrumb("invoked")
        let title = call.getString("title", "ALMA ERP")
        let snapshotJson = call.getString("snapshotJson")

        #if canImport(ActivityKit)
        if #available(iOS 16.1, *) {
            guard ActivityAuthorizationInfo().areActivitiesEnabled else {
                Self.breadcrumb("activities_disabled")
                call.resolve(["started": false, "reason": "activities_disabled"])
                return
            }

            // The voice session owns the island while it runs — don't let the
            // web's pulse tick steal the compact slot mid-conversation.
            if #available(iOS 17.0, *),
               !Activity<AlmaVoiceActivityAttributes>.activities.isEmpty {
                Self.breadcrumb("voice_active")
                call.resolve(["started": false, "reason": "voice_active"])
                return
            }

            guard let state = Self.decodeState(snapshotJson: snapshotJson, call: call) else {
                Self.breadcrumb("bad_payload")
                call.resolve(["started": false, "reason": "bad_payload"])
                return
            }

            // Persist the DECODED state (re-encoded) so a post-voice restore
            // always has the freshest payload — even if starting fails below.
            // Caching the decoded state rather than the raw `snapshotJson`
            // string matters for version skew: an older web bundle (e.g. prod
            // before this branch deploys) calls update() with only the legacy
            // scalars and NO snapshotJson — live-verified in the sim on
            // 2026-07-16, where the cache silently stopped being written and
            // restore would have had nothing.
            Self.cacheLastState(title: title, state: state)

            let alert = call.getBool("alert", false)
            var alertConfig: AlertConfiguration? = alert
                ? Self.makeAlert(
                    title: call.getString("alertTitle", "ALMA ERP"),
                    body: call.getString("alertBody", ""),
                    kind: call.getString("alertKind", "approval")
                )
                : nil
            // Approval nag (owner ask 2026-07-16): while approvals sit pending,
            // the island should re-announce them every so often — an alerting
            // update is the ONE sanctioned way iOS lets a Live Activity draw
            // attention (brief expanded presentation + sound); nothing can
            // programmatically hold the island open. Native so it also works
            // with the legacy web bundle, which never sends `alert`.
            if alertConfig == nil {
                alertConfig = Self.approvalNagAlert(for: state)
            }

            Self.apply(state: state, title: title, alert: alertConfig, call: call)
            return
        }
        #endif

        // Below iOS 16.1, or ActivityKit unavailable at compile time.
        call.resolve(["started": false, "reason": "unsupported_os"])
    }

    // MARK: - markOffline

    /// The web layer could not reach the server. Keep the counts but say so —
    /// never present a stale count as current (spec §2 rule 9, §6.7).
    @objc public func markOffline(_ call: CAPPluginCall) {
        #if canImport(ActivityKit)
        if #available(iOS 16.1, *) {
            guard let activity = Activity<PulseActivityAttributes>.activities.first else {
                call.resolve(["ok": false, "reason": "no_activity"])
                return
            }
            // `activity.content` is 16.2+; `contentState` is the 16.1 spelling.
            var state: PulseActivityAttributes.ContentState
            if #available(iOS 16.2, *) {
                state = activity.content.state
            } else {
                state = activity.contentState
            }
            state.mode = PulseMode.offline.rawValue
            state.headline = "সংযোগের অপেক্ষায়"
            state.subtitle = "সর্বশেষ পাওয়া তথ্য দেখাচ্ছে"
            Task {
                if #available(iOS 16.2, *) {
                    await activity.update(ActivityContent(state: state, staleDate: nil))
                } else {
                    await activity.update(using: state)
                }
            }
            call.resolve(["ok": true])
            return
        }
        #endif
        call.resolve(["ok": false, "reason": "unsupported_os"])
    }

    // MARK: - end

    @objc public func end(_ call: CAPPluginCall) {
        // The web layer is explicitly stopping the pulse — drop the cached
        // payload so a post-voice restore doesn't resurrect it.
        UserDefaults.standard.removeObject(forKey: Self.lastStateKey)

        #if canImport(ActivityKit)
        if #available(iOS 16.1, *) {
            let activities = Activity<PulseActivityAttributes>.activities
            guard !activities.isEmpty else {
                call.resolve(["ended": true, "count": 0])
                return
            }
            Task {
                for activity in activities {
                    if #available(iOS 16.2, *) {
                        await activity.end(nil, dismissalPolicy: .immediate)
                    } else {
                        await activity.end(dismissalPolicy: .immediate)
                    }
                }
            }
            call.resolve(["ended": true, "count": activities.count])
            return
        }
        #endif

        call.resolve(["ended": false, "reason": "unsupported_os"])
    }
}

// MARK: - ActivityKit plumbing

#if canImport(ActivityKit)
@available(iOS 16.1, *)
extension LiveActivityBridgePlugin {
    private static let pushObserverLock = NSLock()
    private static var observedPushActivityIDs = Set<String>()

    private static func finishObservingPushToken(activityID: String) {
        pushObserverLock.lock()
        observedPushActivityIDs.remove(activityID)
        pushObserverLock.unlock()
    }


    /// Decode the canonical v3 payload, falling back to the legacy scalar keys
    /// so an older web bundle (or a degraded server response) still works.
    static func decodeState(
        snapshotJson: String?,
        call: CAPPluginCall
    ) -> PulseActivityAttributes.ContentState? {
        if let json = snapshotJson, let data = json.data(using: .utf8) {
            if let decoded = try? JSONDecoder().decode(
                PulseActivityAttributes.ContentState.self, from: data
            ) {
                return decoded
            }
        }
        // Legacy path — v1/v2 scalars only.
        return PulseActivityAttributes.ContentState(
            ordersToday: call.getInt("ordersToday", 0),
            statusLine: call.getString("statusLine", ""),
            updatedAt: Date(),
            pendingApprovals: call.getInt("pendingApprovals", 0),
            openTasks: call.getInt("openTasks", 0)
        )
    }

    /// One alert configuration, with the bundled sound for its kind and a safe
    /// fallback to the system default if the .caf is missing (spec §11.2/§18).
    ///
    /// NOTE: `AlertSound.named` takes a plain `String` on this SDK, not the
    /// `UNNotificationSoundName` the spec's snippet shows — verified against the
    /// compiler, as spec §11.3 asks.
    static func makeAlert(title: String, body: String, kind: String) -> AlertConfiguration {
        let file = kind == "urgent" ? "alma_urgent.caf" : "alma_approval.caf"
        let sound: AlertConfiguration.AlertSound =
            Bundle.main.url(forResource: file, withExtension: nil) != nil
                ? .named(file)
                : .default
        return AlertConfiguration(
            title: LocalizedStringResource(stringLiteral: title),
            body: LocalizedStringResource(stringLiteral: body),
            sound: sound
        )
    }

    /// Approval nag (owner ask 2026-07-16): pending approvals re-announce every
    /// `approvalNagInterval` via an alerting update. Cooldown lives in
    /// UserDefaults and clears the moment approvals hit zero — so the NEXT
    /// pending approval after a clean slate alerts immediately.
    private static let approvalNagInterval: TimeInterval = 15 * 60
    private static let approvalNagKey = "alma.pulse.lastApprovalNag"

    static func approvalNagAlert(
        for state: PulseActivityAttributes.ContentState
    ) -> AlertConfiguration? {
        let approvals = state.approvals
        guard approvals > 0 else {
            UserDefaults.standard.removeObject(forKey: approvalNagKey)
            return nil
        }
        let now = Date().timeIntervalSince1970
        let last = UserDefaults.standard.double(forKey: approvalNagKey)
        guard now - last >= approvalNagInterval else { return nil }
        UserDefaults.standard.set(now, forKey: approvalNagKey)
        Self.breadcrumb("approval_nag \(approvals)")
        let bn = String(approvals).map { ch -> Character in
            guard let d = ch.wholeNumberValue else { return ch }
            return Character(UnicodeScalar(0x09E6 + d)!)
        }
        return makeAlert(
            title: "অনুমোদন বাকি",
            body: "\(String(bn))টা অনুমোদন আপনার অপেক্ষায় — চেপে দেখুন",
            kind: "approval")
    }

    /// Update the running activity, or request a new one. New activities ask for
    /// a push token so the server can drive the panel while the app is closed.
    static func apply(
        state: PulseActivityAttributes.ContentState,
        title: String,
        alert: AlertConfiguration?,
        call: CAPPluginCall
    ) {
        let outcome = applyCore(state: state, title: title, alert: alert)
        switch outcome {
        case .updated:
            call.resolve(["started": true, "updated": true, "alerted": alert != nil])
        case .started:
            call.resolve(["started": true, "updated": false])
        case .failed(let message):
            call.resolve(["started": false, "reason": "request_failed", "error": message])
        }
    }

    enum ApplyOutcome {
        case updated
        case started
        case failed(String)
    }

    /// Call-free core so the NATIVE sync path (PulseNativeSync — the fix for
    /// the webview-401 outage 2026-07-17) drives the exact same pipeline as a
    /// webview update. One implementation, two entry points.
    @discardableResult
    static func applyCore(
        state: PulseActivityAttributes.ContentState,
        title: String,
        alert: AlertConfiguration?
    ) -> ApplyOutcome {
        var renderedState = state
        renderedState.robotAnimationEpoch = Date().timeIntervalSince1970
        let staleDate = renderedState.staleAfterDate.flatMap {
            $0 > Date() ? $0 : nil
        }

        if let activity = Activity<PulseActivityAttributes>.activities.first {
            Task {
                if #available(iOS 16.2, *) {
                    let content = ActivityContent(
                        state: renderedState,
                        staleDate: staleDate
                    )
                    if let alert {
                        await activity.update(content, alertConfiguration: alert)
                    } else {
                        await activity.update(content)
                    }
                } else {
                    await activity.update(using: renderedState)
                }
            }
            Self.breadcrumb("updated")
            return .updated
        }

        let attributes = PulseActivityAttributes(title: title)
        do {
            let request = try requestPulseActivity(
                attributes: attributes,
                state: renderedState,
                staleDate: staleDate
            )
            if request.pushBacked {
                observePushToken(of: request.activity)
            }
            Self.breadcrumb(request.pushBacked ? "started" : "started_local")
            return .started
        } catch {
            Self.breadcrumb("request_failed: \(error.localizedDescription)")
            return .failed(error.localizedDescription)
        }
    }

    /// Prefer a token-backed activity so the server can update the Island while
    /// the app is suspended. ActivityKit can reject token creation before a
    /// push token is available (observed as ActivityInput error 0 on Simulator
    /// and some restored installs). A local activity is still valid and gives
    /// the owner the current Pulse immediately; the next foreground sync can
    /// retry the token-backed path after that activity ends.
    static func requestPulseActivity(
        attributes: PulseActivityAttributes,
        state: PulseActivityAttributes.ContentState,
        staleDate: Date?
    ) throws -> (
        activity: Activity<PulseActivityAttributes>,
        pushBacked: Bool
    ) {
        do {
            let activity: Activity<PulseActivityAttributes>
            if #available(iOS 16.2, *) {
                activity = try Activity.request(
                    attributes: attributes,
                    content: ActivityContent(state: state, staleDate: staleDate),
                    pushType: .token
                )
            } else {
                activity = try Activity.request(
                    attributes: attributes,
                    contentState: state,
                    pushType: .token
                )
            }
            return (activity, true)
        } catch {
            breadcrumb("token_request_failed_local_fallback: \(error.localizedDescription)")
            let activity: Activity<PulseActivityAttributes>
            if #available(iOS 16.2, *) {
                activity = try Activity.request(
                    attributes: attributes,
                    content: ActivityContent(state: state, staleDate: staleDate),
                    pushType: nil
                )
            } else {
                activity = try Activity.request(
                    attributes: attributes,
                    contentState: state,
                    pushType: nil
                )
            }
            return (activity, false)
        }
    }

    /// Ship the activity's ActivityKit push token to the server so it can send
    /// remote updates. Mirrors CallKitVoIP's registration: AlmaAPI copies the
    /// web session cookies into URLSession, so this is authenticated as the
    /// signed-in owner. Best-effort — a failure just means no remote updates.
    ///
    /// The raw token is NEVER logged (spec §15).
    static func observePushToken(of activity: Activity<PulseActivityAttributes>) {
        pushObserverLock.lock()
        let inserted = observedPushActivityIDs.insert(activity.id).inserted
        pushObserverLock.unlock()
        guard inserted else { return }

        Task {
            defer {
                // Keep lock operations in a synchronous helper; NSLock must
                // never be held across an async suspension point.
                finishObservingPushToken(activityID: activity.id)
            }

            // When the app process relaunches, an existing Activity can already
            // have a token and `pushTokenUpdates` may not produce a new value
            // immediately. Register the current token first, then keep watching
            // for rotation. The server upsert is intentionally idempotent.
            if let currentToken = activity.pushToken {
                await registerPushToken(currentToken)
            }
            for await tokenData in activity.pushTokenUpdates {
                await registerPushToken(tokenData)
            }
        }
    }

    /// Token registration can race the native session-cookie restore at cold
    /// launch. Retry briefly in-process; never log the token or fail the app.
    private static func registerPushToken(_ tokenData: Data) async {
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        guard !token.isEmpty else { return }
        struct Body: Encodable { let platform = "ios"; let activityToken: String }
        struct Resp: Decodable { let ok: Bool? }

        let retryDelays: [UInt64] = [0, 1_000_000_000, 3_000_000_000]
        for delay in retryDelays {
            if delay > 0 {
                try? await Task.sleep(nanoseconds: delay)
            }
            do {
                let response: Resp = try await AlmaAPI.shared.send(
                    "POST",
                    "/api/assistant/internal/live-activity/register",
                    body: Body(activityToken: token)
                )
                if response.ok != false {
                    breadcrumb("push_token_registered")
                    return
                }
            } catch {
                // Retry below. The final failure is recorded without token/PII.
            }
        }
        breadcrumb("push_token_registration_failed")
    }
}
#endif

// MARK: - Last-state cache

#if canImport(ActivityKit)
@available(iOS 16.1, *)
extension LiveActivityBridgePlugin {
    /// Persists the last decoded state (re-encoded, plus `savedAt`) so
    /// PulseRestore can re-request the activity after a voice session ends.
    /// Best-effort: never throws, never crashes.
    static func cacheLastState(title: String, state: PulseActivityAttributes.ContentState) {
        guard let stateData = try? JSONEncoder().encode(state),
              let snapshotJson = String(data: stateData, encoding: .utf8) else { return }
        let payload: [String: Any] = [
            "title": title,
            "snapshotJson": snapshotJson,
            "savedAt": Date().timeIntervalSince1970
        ]
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        UserDefaults.standard.set(data, forKey: lastStateKey)
    }
}
#endif

// MARK: - Haptics (spec §12)
//
// Deliberately NOT implemented here. Spec §12 sketches a Swift
// UINotificationFeedbackGenerator wrapper, but this app already ships
// @capacitor/haptics, which is exactly that generator behind a plugin — and the
// approval flow that must fire the haptic lives in the web layer, so it can
// call it directly. A second native path would be duplicate surface with no
// caller. See `notifyApprovalOutcome()` in src/lib/live-pulse.ts, which fires
// the success/error haptic ONLY after the server confirms, never on the tap.
//
// Custom haptics are never attempted from the widget extension or in the
// background: background vibration belongs to iOS and the user's settings.
