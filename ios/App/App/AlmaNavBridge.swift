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

/// Durable handoff between OneSignal's earliest cold-start click callback and the
/// tab shell, which may not exist yet (storyboard/root wrapping/Face ID can all
/// finish later). A single tap is persisted until the shell confirms it routed.
enum AlmaNotificationRouteStore {
    struct Record: Codable {
        let id: String
        let path: String
        let receivedAt: TimeInterval
    }

    private static let pendingKey = "alma.notification.pendingRoute.v1"
    private static let consumedKey = "alma.notification.lastConsumedRoute.v1"
    private static let maxAge: TimeInterval = 24 * 60 * 60
    private static let duplicateWindow: TimeInterval = 20

    @discardableResult
    static func receive(routePath: String?, actionUrl: String?, source: String?,
                        deliveryId: String? = nil) -> Record? {
        guard let path = normalize(routePath: routePath, actionUrl: actionUrl, source: source) else {
            return nil
        }
        let now = Date().timeIntervalSince1970
        let stableId = deliveryId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = (stableId?.isEmpty == false ? stableId! : UUID().uuidString)

        if let recent = decode(key: consumedKey),
           now - recent.receivedAt < duplicateWindow,
           (recent.id == id || recent.path == path) {
            return recent
        }
        if let pending = decode(key: pendingKey),
           now - pending.receivedAt < duplicateWindow,
           (pending.id == id || pending.path == path) {
            return pending
        }

        let record = Record(id: id, path: path, receivedAt: now)
        if let data = try? JSONEncoder().encode(record) {
            UserDefaults.standard.set(data, forKey: pendingKey)
        }
        DispatchQueue.main.async {
            NotificationCenter.default.post(
                name: .almaOpenPath, object: nil,
                userInfo: ["path": record.path, "notificationDeliveryId": record.id])
        }
        return record
    }

    static func pending() -> Record? {
        guard let record = decode(key: pendingKey) else { return nil }
        if Date().timeIntervalSince1970 - record.receivedAt > maxAge {
            UserDefaults.standard.removeObject(forKey: pendingKey)
            return nil
        }
        return record
    }

    static func consume(id: String) {
        guard let record = decode(key: pendingKey), record.id == id else { return }
        UserDefaults.standard.removeObject(forKey: pendingKey)
        if let data = try? JSONEncoder().encode(record) {
            UserDefaults.standard.set(data, forKey: consumedKey)
        }
    }

    private static func decode(key: String) -> Record? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(Record.self, from: data)
    }

    /// Push data may carry either a purpose-built relative routePath or the full
    /// production action URL. Only the internal path/query enters the native router.
    private static func normalize(routePath: String?, actionUrl: String?, source: String?) -> String? {
        let candidate = [routePath, actionUrl]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        var path: String?
        if let candidate, candidate.hasPrefix("/"), !candidate.hasPrefix("//") {
            path = candidate
        } else if let candidate, let url = URL(string: candidate),
                  url.scheme == "https" || url.scheme == "http" {
            var internalPath = url.path.isEmpty ? "/" : url.path
            if let query = url.query, !query.isEmpty { internalPath += "?\(query)" }
            path = internalPath
        } else if source == "agent" {
            path = "/agent"
        }
        guard let path, path.hasPrefix("/"), !path.hasPrefix("//"),
              !path.contains("\\") && !path.contains("\n") && !path.contains("\r")
        else { return nil }
        return path
    }
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
        // The direct native OneSignal listener normally arrives first. This JS
        // bridge remains a backwards-compatible fallback; the store deduplicates
        // both callbacks so one tap can never push the same page twice.
        _ = AlmaNotificationRouteStore.receive(
            routePath: path,
            actionUrl: nil,
            source: call.getString("source"),
            deliveryId: call.getString("deliveryId"))
        call.resolve()
    }
}
