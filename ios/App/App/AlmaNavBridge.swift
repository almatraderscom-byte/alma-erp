//
//  AlmaNavBridge.swift
//  ALMA ERP — notification-tap deep-link bridge (JS → native shell).
//
//  Why: OneSignal notification-click events are delivered to the Capacitor
//  Dashboard webview (tab 0), which sits HIDDEN under the native SwiftUI shell —
//  `window.location.assign` there navigated a webview nobody sees, so every
//  notification tap appeared to land on the Dashboard (owner bug 2026-07-14).
//  The web click handler (src/lib/native-push.ts) now hands the target path to
//  this plugin on iOS; old app builds don't expose it, the JS call fails, and
//  the handler falls back to the previous webview navigation.
//
//  Registered in AlmaBridgeViewController.capacitorDidLoad() like the other
//  local plugins. The actual routing lives in
//  AlmaTabBarController.routeNotificationTap(to:) (SwiftUIShell.swift), which
//  reuses the S6 pushSmart machinery — native screen when migrated, web view
//  otherwise.
//

import Capacitor
import UIKit

extension Notification.Name {
    /// Posted by AlmaNavBridgePlugin. userInfo: ["path": String] — an ERP route
    /// path starting with "/", optionally carrying a query string.
    static let almaOpenPath = Notification.Name("almaOpenPath")
}

@objc(AlmaNavBridgePlugin)
public class AlmaNavBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AlmaNavBridgePlugin"
    public let jsName = "AlmaNavBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openPath", returnType: CAPPluginReturnPromise)
    ]

    @objc public func openPath(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), path.hasPrefix("/") else {
            call.reject("path (a '/…' ERP route) is required")
            return
        }
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .almaOpenPath, object: nil,
                                            userInfo: ["path": path])
        }
        call.resolve()
    }
}
