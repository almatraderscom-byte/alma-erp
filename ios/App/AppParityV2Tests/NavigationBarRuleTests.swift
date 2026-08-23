//
//  NavigationBarRuleTests.swift
//  ALMA ERP — the shell's nav bar is hidden exactly for the screen being shown.
//
//  Owner report 2026-08-23: after leaving a full-takeover screen (Creative Studio,
//  native login) the More tab's bar stayed hidden, so the NEXT pushed page had no
//  back button. The fix derives the bar state from the shown controller's
//  `almaHidesNavigationBar` flag in AlmaNavigationController — these tests pin
//  both halves: which routes are takeovers, and that the rule restores the bar.
//

import XCTest
import UIKit
import SwiftUI
@testable import App

@available(iOS 17.0, *)
@MainActor
final class NavigationBarRuleTests: XCTestCase {

    private func host(_ path: String) throws -> AlmaHostingControllerProtocol {
        let vc = try XCTUnwrap(AlmaNativeRouter.screen(for: path, openWebForced: { _, _ in }),
                               "router has no native screen for \(path)")
        return try XCTUnwrap(vc as? AlmaHostingControllerProtocol)
    }

    func testTakeoverRoutesAreTheOnlyOnesHidingTheBar() throws {
        XCTAssertTrue(try host("/agent/creative-studio").almaHidesNavigationBar)
        XCTAssertTrue(try host("/login").almaHidesNavigationBar)
        for path in ["/finance", "/employees", "/attendance", "/agent/catalog-images", "/settings/notifications"] {
            XCTAssertFalse(try host(path).almaHidesNavigationBar, "\(path) must keep the system bar + back")
        }
    }

    func testBarFollowsTheShownController() throws {
        let root = AlmaHostingController(rootView: Text("root"))
        let nav = AlmaNavigationController(rootViewController: root)
        nav.loadViewIfNeeded()
        XCTAssertFalse(nav.isNavigationBarHidden)

        // Takeover pushed → hidden; any later pushed page → visible again.
        let studio = try XCTUnwrap(AlmaNativeRouter.screen(for: "/agent/creative-studio", openWebForced: { _, _ in }))
        nav.navigationController(nav, willShow: studio, animated: false)
        nav.navigationController(nav, didShow: studio, animated: false)
        XCTAssertTrue(nav.isNavigationBarHidden)

        let finance = try XCTUnwrap(AlmaNativeRouter.screen(for: "/finance", openWebForced: { _, _ in }))
        nav.navigationController(nav, willShow: finance, animated: false)
        XCTAssertFalse(nav.isNavigationBarHidden, "a normal page after a takeover must get its bar (and back button) back")

        // A late re-hide during the pop transition (the old bug) is undone by didShow.
        nav.setNavigationBarHidden(true, animated: false)
        nav.navigationController(nav, didShow: root, animated: false)
        XCTAssertFalse(nav.isNavigationBarHidden)
    }

    func testEdgeSwipeBackStaysEnabledOnHiddenBarScreens() throws {
        let root = AlmaHostingController(rootView: Text("root"))
        let nav = AlmaNavigationController(rootViewController: root)
        nav.loadViewIfNeeded()
        let pop = try XCTUnwrap(nav.interactivePopGestureRecognizer)
        XCTAssertFalse(nav.gestureRecognizerShouldBegin(pop), "nothing to pop to at the root")
        let studio = try XCTUnwrap(AlmaNativeRouter.screen(for: "/agent/creative-studio", openWebForced: { _, _ in }))
        nav.pushViewController(studio, animated: false)
        XCTAssertTrue(nav.gestureRecognizerShouldBegin(pop), "takeover screens must still swipe back")
    }
}
