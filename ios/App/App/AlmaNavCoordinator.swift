//
//  AlmaNavCoordinator.swift
//  ALMA ERP — IOSP-1: single typed navigation decision point.
//
//  Every internal link the shell opens (root-tab callbacks, More rows, screen
//  link-outs, notification taps, almaerp:// deep links, Assistant assistive nav)
//  resolves through ONE decision here. The IOSP-0 baseline found the old flow
//  could silently embed WKWebView on any router miss — an unknown internal path
//  looked identical to an approved web page. This coordinator makes web an
//  EXPLICIT classification, never a fallthrough:
//
//    native   → AlmaNativeRouter screen (incl. typed dynamic routes)
//    tabRoot  → the path IS a root tab (e.g. /agent) — select it, don't push a copy
//    web      → allowlisted embedded web (classification + reason logged)
//    unknown  → structured `route.unknown` telemetry + owner-facing Bangla alert
//               with an explicit "ওয়েবে খুলুন" handoff — never silent
//
//  The allowlists MIRROR ios/route-contract.json (the machine-readable contract).
//  scripts/iosp0-route-contract-check.mjs parses this file and fails CI when the
//  two drift. Add a route to the fixture first, then here.
//

import UIKit

@available(iOS 17.0, *)
enum AlmaNavCoordinator {

    /// Typed outcome for an internal ERP route path.
    enum Decision {
        case native(UIViewController)
        case tabRoot(Int)
        case web(reason: String)
        case unknown
    }

    // MARK: - Contract allowlists (mirror ios/route-contract.json — checker-enforced)

    /// temporary-web: owner-approved embedded-web debt, each with a decision phase.
    /// Expiry reviews happen in the phase noted in route-contract.json.
    static let temporaryWebRoutes: Set<String> = [
        // NP-1: /agent/live-watch NATIVE (Monitor → Agents tab, AG-08).
        // NP-4: /portal/wallet, /forgot-password, /reset-password NATIVE.
        "/agent/creative-studio-demo", // NP-8: retire (web-page removal rides the merge — this branch must not trigger Vercel builds)
        "/agent/mac",
        "/agent/media",
        "/agent/phone",
        "/agent/phone-console",
        "/agent/phone-console/calls",
        "/agent/phone-console/extensions",
        "/agent/phone-console/line",
        "/agent/phone-console/live",
        "/agent/phone-console/quality",
        "/agent/phone-console/recordings",
        "/agent/phone-console/routing",
        "/agent/phone-console/routing/outbound",
        "/agent/phone-console/routing/preview",
        "/agent/phone-console/settings",
        "/agent/phone-console/settings/blocklist",
        "/agent/phone-console/settings/history",
        "/agent/phone-console/settings/hold",
        "/agent/phone-console/settings/hours",
        "/agent/phone-console/settings/limits",
        "/agent/phone-console/settings/provider"
    ]

    /// NP-4 (AU-02): typed QUERY routes — these native screens accept their query
    /// string (reset token), so a query no longer forces the web page for them.
    static let queryCapableRoutes: Set<String> = [
        // An order entity link carries its exact id as /orders?focus=<id>.
        // OrdersScreen consumes the query and opens the native detail sheet.
        "/orders",
        "/reset-password",
        // A Meta Ads push taps through as /agent/growth?rec=<id>. The native
        // Growth screen now reads that id and opens on that recommendation, so
        // the query must no longer bounce the tap to the web page.
        "/agent/growth"
    ]

    /// public-web-allowed: public informational/share pages — web is correct.
    static let publicWebRoutes: Set<String> = [
        "/privacy-policy",
        "/app/download"
    ]

    /// public-web-allowed dynamic prefixes (e.g. public invoice share links).
    static let publicWebPrefixes: [String] = [
        "/invoice/share/"
    ]

    /// Root-tab paths that must SELECT their tab instead of pushing a copy.
    /// (/, /dashboard, /orders, /approvals also have native router cases for
    /// pushed cross-links; /agent has no pushable screen — the Agent tab is the
    /// only correct destination, closing the IOSP-0 `/agent` deep-link gap.)
    static let tabRootIndex: [String: Int] = [
        "/agent": 2
    ]

    // MARK: - Decision

    /// Resolve `path` (may carry a query string) to a typed decision.
    /// `openWebForced` is threaded into native screens as their escape hatch —
    /// exactly the closure semantics AlmaNativeRouter has always used.
    @MainActor
    static func decide(path: String,
                       openWebForced: @escaping (_ path: String, _ title: String) -> Void)
        -> Decision {
        let bare = path.split(separator: "?").first.map(String.init) ?? path
        let hasQuery = path.dropFirst(bare.count).count > 1 // "?" alone isn't a query

        if let index = tabRootIndex[bare], !hasQuery {
            return .tabRoot(index)
        }

        // Query-carrying links: most native screens don't receive query context —
        // /attendance?review=… only works on the web page. Until a
        // native screen accepts the parameter (typed path routes like
        // /employees/{id} already do), the query keeps its web page — but as an
        // EXPLICIT, telemetry-logged decision, not a silent fallthrough.
        if hasQuery {
            // Canonical Agent entity links carry a server-stamped business_id.
            // Resolve the full path so the native router can validate the route/
            // business pairing before constructing a screen. A bad pairing must
            // never fall through to web or fetch another business's record.
            if isBusinessScopedEntityLink(path: path, bare: bare) {
                if let native = AlmaNativeRouter.screen(for: path, openWebForced: openWebForced) {
                    return .native(native)
                }
                return .unknown
            }
            // NP-4: typed query routes go native WITH their query (reset token).
            if queryCapableRoutes.contains(bare),
               let native = AlmaNativeRouter.screen(for: path, openWebForced: openWebForced) {
                return .native(native)
            }
            if AlmaNativeRouter.screen(for: bare, openWebForced: { _, _ in }) != nil
                || tabRootIndex[bare] != nil {
                return .web(reason: "query-context")
            }
            // fall through to allowlist / unknown below using the bare path
        }

        if let native = AlmaNativeRouter.screen(for: bare, openWebForced: openWebForced) {
            return .native(native)
        }
        if temporaryWebRoutes.contains(bare) {
            return .web(reason: "temporary-web")
        }
        if publicWebRoutes.contains(bare) {
            return .web(reason: "public-web")
        }
        if publicWebPrefixes.contains(where: { bare.hasPrefix($0) }) {
            return .web(reason: "public-web")
        }
        return .unknown
    }

    private static func isBusinessScopedEntityLink(path: String, bare: String) -> Bool {
        guard queryValue(path, name: "business_id") != nil else { return false }
        if bare == "/orders" {
            return !(queryValue(path, name: "focus") ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return hasOnePathParam(bare, after: "/orders/")
            || hasOnePathParam(bare, after: "/employees/")
            || hasOnePathParam(bare, after: "/trading/accounts/")
            || hasTwoPathParams(bare, after: "/agent/references/")
    }

    private static func hasOnePathParam(_ path: String, after prefix: String) -> Bool {
        guard path.hasPrefix(prefix) else { return false }
        let remainder = path.dropFirst(prefix.count)
        return !remainder.isEmpty && !remainder.contains("/")
    }

    private static func hasTwoPathParams(_ path: String, after prefix: String) -> Bool {
        guard path.hasPrefix(prefix) else { return false }
        let parts = path.dropFirst(prefix.count).split(separator: "/", omittingEmptySubsequences: false)
        return parts.count == 2 && parts.allSatisfy { !$0.isEmpty }
    }

    private static func queryValue(_ path: String, name: String) -> String? {
        guard let query = path.split(separator: "?").dropFirst().first else { return nil }
        return URLComponents(string: "https://x/?\(query)")?
            .queryItems?.first { $0.name == name }?.value
    }
}
