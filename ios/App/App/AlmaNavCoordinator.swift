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
        "/agent/live-watch",          // IOSP-7: native Live Watch or documented exception
        "/portal/wallet",             // IOSP-7: native wallet or documented exception
        "/forgot-password",           // IOSP-7: native shell + secure handoff
        "/reset-password",            // IOSP-7: native reset completion
        "/agent/creative-studio-demo" // IOSP-7: dev/demo route — exclude or remove
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

        // Query-carrying links: native screens don't receive query context —
        // /orders?focus=…, /attendance?review=… only work on the web page. Until a
        // native screen accepts the parameter (typed path routes like
        // /employees/{id} already do), the query keeps its web page — but as an
        // EXPLICIT, telemetry-logged decision, not a silent fallthrough.
        if hasQuery {
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
}
