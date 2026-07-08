//
//  LiveActivityBridge.swift
//  App
//
//  Local Capacitor plugin that lets the web app (while in the foreground)
//  start / update / end the "Business Pulse" Live Activity via ActivityKit.
//
//  JS side calls:
//    LiveActivityBridge.update({ ordersToday, statusLine, title })  → { started }
//    LiveActivityBridge.end()                                       → { ended }
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

import Capacitor
import Foundation

#if canImport(ActivityKit)
import ActivityKit
#endif

@objc(LiveActivityBridgePlugin)
public class LiveActivityBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveActivityBridgePlugin"
    public let jsName = "LiveActivityBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise)
    ]

    /// UserDefaults key holding the last pulse payload as JSON (with a
    /// `savedAt` timestamp). PulseRestore reads this to bring the island back
    /// after a voice session ends while the app is backgrounded.
    static let lastStateKey = "alma.pulse.lastState"

    // MARK: - update

    @objc public func update(_ call: CAPPluginCall) {
        let ordersToday = call.getInt("ordersToday", 0)
        let statusLine = call.getString("statusLine", "")
        let title = call.getString("title", "ALMA ERP")
        let pendingApprovals = call.getInt("pendingApprovals", 0)
        let openTasks = call.getInt("openTasks", 0)

        // Persist the full payload FIRST (even if starting fails below) so a
        // post-voice restore always has the freshest data the web layer sent.
        Self.cacheLastState(
            ordersToday: ordersToday,
            statusLine: statusLine,
            title: title,
            pendingApprovals: pendingApprovals,
            openTasks: openTasks
        )

        #if canImport(ActivityKit)
        if #available(iOS 16.1, *) {
            // ActivityKit must be enabled by the user / entitlement.
            guard ActivityAuthorizationInfo().areActivitiesEnabled else {
                call.resolve(["started": false, "reason": "activities_disabled"])
                return
            }

            // The voice session owns the island while it runs — don't let the
            // web's pulse tick steal the compact slot mid-conversation.
            if #available(iOS 17.0, *),
               !Activity<AlmaVoiceActivityAttributes>.activities.isEmpty {
                call.resolve(["started": false, "reason": "voice_active"])
                return
            }

            let state = PulseActivityAttributes.ContentState(
                ordersToday: ordersToday,
                statusLine: statusLine,
                updatedAt: Date(),
                pendingApprovals: pendingApprovals,
                openTasks: openTasks
            )

            // If a Pulse activity is already running, update it; otherwise request one.
            if let activity = Activity<PulseActivityAttributes>.activities.first {
                Task {
                    if #available(iOS 16.2, *) {
                        await activity.update(ActivityContent(state: state, staleDate: nil))
                    } else {
                        await activity.update(using: state)
                    }
                }
                call.resolve(["started": true, "updated": true])
                return
            }

            let attributes = PulseActivityAttributes(title: title)
            do {
                if #available(iOS 16.2, *) {
                    _ = try Activity.request(
                        attributes: attributes,
                        content: ActivityContent(state: state, staleDate: nil),
                        pushType: nil
                    )
                } else {
                    // iOS 16.1 API: contentState: form (deprecated on newer SDKs but still compiles).
                    _ = try Activity.request(
                        attributes: attributes,
                        contentState: state,
                        pushType: nil
                    )
                }
                call.resolve(["started": true, "updated": false])
            } catch {
                call.resolve(["started": false, "reason": "request_failed", "error": error.localizedDescription])
            }
            return
        }
        #endif

        // Below iOS 16.1, or ActivityKit unavailable at compile time.
        call.resolve(["started": false, "reason": "unsupported_os"])
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

    // MARK: - Last-state cache

    /// Persists the last pulse payload (JSON, with `savedAt` and the content
    /// `updatedAt`) so PulseRestore can re-request the activity after a voice
    /// session ends. Best-effort: never throws, never crashes.
    private static func cacheLastState(
        ordersToday: Int,
        statusLine: String,
        title: String,
        pendingApprovals: Int,
        openTasks: Int
    ) {
        let payload: [String: Any] = [
            "ordersToday": ordersToday,
            "statusLine": statusLine,
            "title": title,
            "pendingApprovals": pendingApprovals,
            "openTasks": openTasks,
            "updatedAt": Date().timeIntervalSince1970,
            "savedAt": Date().timeIntervalSince1970
        ]
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        UserDefaults.standard.set(data, forKey: lastStateKey)
    }
}
