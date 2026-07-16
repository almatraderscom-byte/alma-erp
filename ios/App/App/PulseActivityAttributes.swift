//
//  PulseActivityAttributes.swift
//  Shared between the App target and the AlmaWidgetExtension target.
//
//  "Business Pulse" Dynamic Panel model. This single file is compiled into
//  BOTH targets (the App drives the activity via ActivityKit; the widget
//  extension renders it via ActivityConfiguration). Keep it dependency-free
//  and identical for both sides — it is the shared contract.
//
//  ActivityKit is iOS 16.1+. `ActivityAttributes` conformance requires the
//  type itself to be available at iOS 16.1, so the availability annotation is
//  placed on the type declarations (not merely on members). The whole file is
//  additionally guarded with `#if canImport(ActivityKit)` so it is a harmless
//  no-op if the SDK ever lacks ActivityKit.
//
//  ── DECODE-SAFETY RULES (do not break these) ─────────────────────────────
//  1. EVERY field added after v1 is OPTIONAL. Swift's synthesised Codable does
//     NOT apply property defaults when a key is missing, so a non-optional new
//     field would fail to decode (a) an activity already running across an app
//     update, and (b) a push whose payload omits it. `nil` ≡ "not provided".
//  2. `mode` is a String, never an enum. An unknown//future mode from the
//     server must degrade to .overview, not throw and kill the whole update.
//  3. Dates are Double EPOCH SECONDS, never `Date`. ActivityKit decodes a
//     pushed content-state with its own JSONDecoder whose date strategy is not
//     contractual (`.deferredToDate` measures from 2001, not 1970), so a `Date`
//     field would silently decode to the wrong instant on the push path. The
//     legacy `updatedAt: Date?` survives only to decode states persisted by
//     build ≤ 73 and is never sent by v3 writers.
//
//  The canonical JSON shape is produced in ONE place on the server —
//  `toPulseContentState()` in src/lib/pulse-state.ts — and is used verbatim by
//  both the local Capacitor bridge and the remote ActivityKit push.
//

#if canImport(ActivityKit)
import ActivityKit
import Foundation

// MARK: - Modes

/// The panel's active mode. Mirrors PulseMode in src/lib/pulse-state.ts.
enum PulseMode: String, Codable, Hashable, CaseIterable {
    case urgent
    case approval
    case orders
    case working
    case stale
    case offline
    case success
    case overview
}

/// Severity of a feed row. Mirrors PulseSeverity in src/lib/pulse-state.ts.
enum PulseSeverity: String, Codable, Hashable {
    case normal
    case attention
    case urgent
}

// MARK: - Feed row

/// One notification-style row. At most three are ever sent (spec §4).
struct PulseItem: Codable, Hashable, Identifiable {
    var id: String
    /// Raw kind string — decoded leniently, see `iconKind`.
    var kind: String?
    var title: String
    var subtitle: String?
    var valueText: String?
    var progress: Double?
    /// Raw severity string — see `level`.
    var severity: String?
    var createdAtEpoch: Double?
    /// almaerp:// destination for a tap.
    var link: String?

    var level: PulseSeverity {
        PulseSeverity(rawValue: severity ?? "") ?? .normal
    }

    var createdAt: Date? {
        createdAtEpoch.map { Date(timeIntervalSince1970: $0) }
    }

    /// Progress clamped to 0…1 — never trust the wire (spec §4).
    var clampedProgress: Double? {
        progress.map { min(1, max(0, $0)) }
    }
}

// MARK: - Attributes

@available(iOS 16.1, *)
struct PulseActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        // ── v1 ──
        var ordersToday: Int
        var statusLine: String
        /// LEGACY. Only decodes states persisted by build ≤ 73; v3 writers send
        /// `updatedAtEpoch` instead. Optional so a push may omit it (rule 3).
        var updatedAt: Date?

        // ── v2 hub counters ──
        var pendingApprovals: Int?
        var openTasks: Int?

        // ── v3 Dynamic Panel ──
        /// Raw mode string — resolved via `activeMode` so an unknown value
        /// degrades to .overview instead of failing the decode (rule 2).
        var mode: String?
        var headline: String?
        var subtitle: String?
        var pendingTaskCount: Int?
        var approvalCount: Int?
        var runningOrderCount: Int?
        var orderProgress: Double?
        var items: [PulseItem]?
        var updatedAtEpoch: Double?
        var staleAfterEpoch: Double?

        var approvalId: String?
        var approvalTitle: String?
        var approvalCounterparty: String?
        /// Money. Rendered `.privacySensitive()` — iOS redacts it while the
        /// phone is locked and reveals it after Face ID (owner decision
        /// 2026-07-16).
        var approvalAmountText: String?

        var alertTitle: String?
        var alertDetail: String?
        var alertSeverity: String?

        var successTitle: String?
        var successDetail: String?
        var successAtEpoch: Double?
    }

    var title: String
}

// MARK: - Derived view of the state

@available(iOS 16.1, *)
extension PulseActivityAttributes.ContentState {
    /// The mode to render. Unknown/absent → .overview (rule 2).
    var activeMode: PulseMode {
        PulseMode(rawValue: mode ?? "") ?? .overview
    }

    /// When this data was produced. Prefers the v3 epoch; falls back to the
    /// legacy Date for an activity still running from an older build.
    var updatedAtDate: Date {
        if let e = updatedAtEpoch { return Date(timeIntervalSince1970: e) }
        return updatedAt ?? Date()
    }

    /// After this instant the data is no longer trustworthy as "now".
    var staleAfterDate: Date? {
        staleAfterEpoch.map { Date(timeIntervalSince1970: $0) }
    }

    /// Non-negative counts — the wire is never trusted (spec §4).
    var pendingTasks: Int { max(0, pendingTaskCount ?? openTasks ?? 0) }
    var approvals: Int { max(0, approvalCount ?? pendingApprovals ?? 0) }
    var runningOrders: Int { max(0, runningOrderCount ?? 0) }

    var clampedOrderProgress: Double? {
        orderProgress.map { min(1, max(0, $0)) }
    }

    var feedItems: [PulseItem] { Array((items ?? []).prefix(3)) }

    /// Headline with a safe fallback, so the panel is never blank even if a
    /// push arrives without copy.
    var displayHeadline: String {
        let h = (headline ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return h.isEmpty ? "ALMA ERP" : h
    }

    /// Subtitle falls back to the legacy v1 status line.
    var displaySubtitle: String {
        let s = (subtitle ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? statusLine : s
    }

    /// The single most important number for the compact Dynamic Island slot —
    /// the Island must never show three competing metrics (spec §3.2).
    /// Owner rule 2026-07-16: pending approvals outrank every other count in
    /// this slot — an approval is a blocked decision waiting on the owner,
    /// while task/order counts are ambient. (Matters mostly for legacy
    /// payloads without an explicit mode, where `max(approvals, tasks)` let a
    /// big task backlog bury 2 waiting approvals behind "৩৮".)
    var compactValue: Int {
        switch activeMode {
        case .approval: return approvals
        case .orders: return runningOrders
        case .working, .overview, .stale, .offline, .success, .urgent:
            if approvals > 0 { return approvals }
            return runningOrders > 0 ? runningOrders : pendingTasks
        }
    }

    /// True when `compactValue` is showing the approvals count — the compact
    /// slot marks it with the approval seal so the owner knows WHAT the number
    /// is without expanding.
    var compactShowsApprovals: Bool {
        activeMode == .approval || (approvals > 0 && compactValue == approvals)
    }
}
#endif
