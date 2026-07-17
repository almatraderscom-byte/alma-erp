//
//  AlmaPulseIntents.swift
//  Shared: App target + AlmaWidgetExtension target.
//
//  Approve/reject a pending action STRAIGHT FROM the expanded Dynamic Island /
//  lock-screen panel — no app launch (owner spec 2026-07-17, demo-approved).
//
//  How auth works with zero new infrastructure: this is a LiveActivityIntent,
//  and iOS runs those IN THE APP'S OWN PROCESS (launched in the background if
//  needed) — so the app's normal AlmaAPI session (WKWebsiteDataStore-synced
//  cookies) is available. The widget target only needs this TYPE to compile
//  for Button(intent:); perform() never executes there. The app injects the
//  actual network work through PulseIntentBridge.executor at launch, so this
//  file stays compilable in the widget target without importing AlmaAPI.
//

import Foundation

#if canImport(AppIntents)
import AppIntents

/// App-side executor injection point. AppDelegate assigns this at launch; the
/// widget target leaves it nil (its copy of perform() never runs).
public enum PulseIntentBridge {
    /// (pendingActionId, approve) → success. MUST be side-effect-complete:
    /// POST the decision, then refresh the Live Activity from the server.
    public static var executor: (@Sendable (String, Bool) async -> Bool)?
}

@available(iOS 17.0, *)
struct AlmaApproveActionIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "ALMA অনুমোদন"
    static var description = IntentDescription("Pending action অনুমোদন/বাতিল — অ্যাপ না খুলেই")
    /// Background execution — never bounce the owner into the foreground app.
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Action ID")
    var actionId: String

    @Parameter(title: "Approve")
    var approve: Bool

    init() {}

    init(actionId: String, approve: Bool) {
        self.actionId = actionId
        self.approve = approve
    }

    func perform() async throws -> some IntentResult {
        _ = await PulseIntentBridge.executor?(actionId, approve)
        return .result()
    }
}
#endif
