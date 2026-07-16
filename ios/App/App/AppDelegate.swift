import UIKit
import UserNotifications
import Capacitor
import CapawesomeCapacitorAppShortcuts

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        AlmaPerfLog.event("launch.didFinishLaunching")
        #if DEBUG
        runNavSelfTestIfRequested()
        if #available(iOS 17.0, *) { runOverlaySelfTestIfRequested() }
        runCacheSelfTestIfRequested()
        #endif
        // Home-screen quick action on COLD START: forward to the AppShortcuts
        // plugin (it retains the event until the JS listener attaches).
        if let shortcutItem = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem {
            NotificationCenter.default.post(
                name: NSNotification.Name(AppShortcutsPlugin.notificationName),
                object: nil,
                userInfo: [AppShortcutsPlugin.userInfoShortcutItemKey: shortcutItem]
            )
        }
        // Phase N4: register the background-refresh task handler. Must happen before
        // this method returns, per BGTaskScheduler requirements.
        BackgroundRefresh.register()

        // Stage 1: WhatsApp-style incoming calls. Register the PushKit VoIP registry
        // (+ CallKit) at launch so a live office call rings a native full-screen call
        // even when the app is backgrounded or killed. Deferred paths (token upload)
        // handle the not-yet-logged-in case. iOS 17+ to match AgoraIntercom.
        if #available(iOS 17.0, *) {
            CallKitVoIP.shared.start()
        }

        // PHASE S1: wrap the app in a native tab bar. The storyboard already created
        // the Capacitor bridge VC as the window root; we REUSE that same instance as
        // tab 0 so Capacitor keeps running (push / Live Pulse / reminders / on-device
        // plugins stay live) and only reparent it under a native tab bar. The other
        // tabs are session-sharing content web views. Revert = delete this block.
        if let capacitorRoot = window?.rootViewController {
            window?.rootViewController = AlmaTabBarController(dashboard: capacitorRoot)
            // S3 white-flash removal: the whole shell is dark-violet, but the launch
            // storyboard + an unset window background resolve to WHITE on a light-mode
            // device, so a cold launch could flash white before the first webview paints.
            // Pin the window to the shell's dark colour so every gap (launch → shell, tab
            // first-load, nav pushes) is dark, never white. We deliberately do NOT force
            // `overrideUserInterfaceStyle = .dark` on the window: that would flip the
            // WKWebViews' `prefers-color-scheme` to dark and could restyle the (light) ERP
            // content. The native chrome is already explicitly dark via its appearance
            // objects, so it needs no global override.
            window?.backgroundColor = UIColor(red: 0.055, green: 0.047, blue: 0.078, alpha: 1) // ~#0e0c14
            window?.makeKeyAndVisible()
        }

        // App-wide floating office chat head (drag anywhere → snaps to edge, tap → group
        // chat). Lives in its own passthrough window above the app, so it can't interfere
        // with any existing screen. Deferred so the scene/window is fully up first.
        if #available(iOS 17.0, *) {
            // IOSP-2: touch the overlay coordinator first so its keyboard-frame
            // observers are live before any overlay docks (shared z-order +
            // tab-bar/keyboard exclusion zones + Reduce Motion/Transparency policy).
            _ = AlmaOverlayCoordinator.shared
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { FloatingChatHead.shared.install() }
            // App-wide offline beacon + the ALMA Island result banner (own overlay
            // windows, same pattern — nothing existing is touched).
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                ConnectivityBeacon.shared.install()
                AlmaIslandWatch.shared.install()
            }
        }

        return true
    }

    // Home-screen quick action while the app is RUNNING/backgrounded.
    func application(_ application: UIApplication, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        NotificationCenter.default.post(
            name: NSNotification.Name(AppShortcutsPlugin.notificationName),
            object: nil,
            userInfo: [AppShortcutsPlugin.userInfoShortcutItemKey: shortcutItem]
        )
        completionHandler(true)
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
        // Phase N4: queue the next background reminder refresh.
        BackgroundRefresh.schedule()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Clear the app-icon badge on every open: server pushes use
        // ios_badgeType "Increase" (src/lib/notifications.ts), so without a reset
        // the count only ever grows. Notification Center items are untouched.
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(0)
        } else {
            application.applicationIconBadgeNumber = 0
        }
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // IOSP-1: almaerp:// deep links (Siri App Intents, Spotlight entities, widgets)
        // route through the NATIVE shell. Before, Capacitor delivered them to the
        // HIDDEN dashboard webview (DeepLinkManager → window.location.assign) — the
        // navigation happened on a webview nobody sees, and the hidden Capacitor
        // bridge page navigated away from the dashboard it must stay on. Same class
        // of bug AlmaNavBridge fixed for notification taps; same fix: post
        // .almaOpenPath and let AlmaTabBarController.routeNotificationTap decide
        // (native / tab / allowlisted web / fail-loud) via AlmaNavCoordinator.
        if url.scheme == "almaerp" {
            var path = "/" + (url.host ?? "") + url.path
            if path.count > 1, path.hasSuffix("/") { path = String(path.dropLast()) }
            if let q = url.query, !q.isEmpty { path += "?\(q)" }
            AlmaPerfLog.event("route.deepLink", path)
            NotificationCenter.default.post(name: .almaOpenPath, object: nil,
                                            userInfo: ["path": path])
            return true // consumed natively — the hidden webview must NOT navigate
        }
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

#if DEBUG
extension AppDelegate {
    /// IOSP-1 navigation-contract self-test (DEBUG builds only, env-gated — never
    /// compiled into Release/TestFlight). Simulator UI can't be driven headlessly
    /// (SpringBoard's "Open in …?" dialog blocks `simctl openurl`, and taps need a
    /// human), so the harness drives the SAME code path a notification tap / deep
    /// link uses: it posts `.almaOpenPath` for each route in
    /// `ALMA_NAV_SELFTEST_ROUTES` (comma-separated), one every 6 s starting 10 s
    /// after launch (unlock margin). Verification happens OUTSIDE the app:
    /// timed `simctl io screenshot` + the route.* signposts prove each decision.
    ///
    ///   SIMCTL_CHILD_ALMA_NAV_SELFTEST=1 \
    ///   SIMCTL_CHILD_ALMA_NAV_SELFTEST_ROUTES="/trading/accounts,/agent" \
    ///     xcrun simctl launch <udid> com.almatraders.erp
    func runNavSelfTestIfRequested() {
        let env = ProcessInfo.processInfo.environment
        guard env["ALMA_NAV_SELFTEST"] == "1" else { return }
        let routes = (env["ALMA_NAV_SELFTEST_ROUTES"] ?? "")
            .split(separator: ",").map(String.init).filter { $0.hasPrefix("/") }
        guard !routes.isEmpty else { return }
        AlmaPerfLog.event("navSelfTest.start", routes.joined(separator: ","))
        var delay: TimeInterval = 10
        for route in routes {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                AlmaPerfLog.event("navSelfTest.route", route)
                NotificationCenter.default.post(name: .almaOpenPath, object: nil,
                                                userInfo: ["path": route])
            }
            delay += 6
        }
    }

    /// IOSP-2 overlay self-test (DEBUG-only, env-gated). Drives the REAL keyboard
    /// exclusion path: posts a synthetic `keyboardWillChangeFrame` with an on-screen
    /// keyboard so `AlmaOverlayCoordinator` raises its exclusion and the floating
    /// chat head docks above it — then hides it again. Verify from outside with
    /// timed screenshots (head should sit higher during the keyboard window) and
    /// the route.* / overlaySelfTest signposts.
    ///
    ///   SIMCTL_CHILD_ALMA_OVERLAY_SELFTEST=1 xcrun simctl launch <udid> com.almatraders.erp
    @available(iOS 17.0, *)
    func runOverlaySelfTestIfRequested() {
        guard ProcessInfo.processInfo.environment["ALMA_OVERLAY_SELFTEST"] == "1" else { return }
        AlmaPerfLog.event("overlaySelfTest.start")
        // Park the head at the bottom edge first, so the keyboard-raise visibly lifts it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
            FloatingChatHead.shared.debugParkAtBottomEdge()
        }
        func postKeyboard(height: CGFloat, at delay: TimeInterval, tag: StaticString) {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                guard let scene = AlmaOverlayCoordinator.shared.foregroundScene() else { return }
                let screenH = scene.screen.bounds.height
                let width = scene.screen.bounds.width
                let originY = height > 0 ? screenH - height : screenH
                let name = height > 0 ? UIResponder.keyboardWillChangeFrameNotification
                                      : UIResponder.keyboardWillHideNotification
                AlmaPerfLog.event(tag)
                NotificationCenter.default.post(
                    name: name, object: nil,
                    userInfo: [UIResponder.keyboardFrameEndUserInfoKey:
                                NSValue(cgRect: CGRect(x: 0, y: originY, width: width, height: max(height, 300)))])
            }
        }
        postKeyboard(height: 340, at: 18, tag: "overlaySelfTest.keyboardUp")
        postKeyboard(height: 0, at: 26, tag: "overlaySelfTest.keyboardDown")
    }

    /// IOSP-3 cache self-test (DEBUG-only, env-gated). Proves single-flight (N
    /// concurrent identical GETs → ONE api.request) and TTL (repeated getCached
    /// within the window → cache.hit, no refetch). Verify from outside by counting
    /// `api.request` vs `cache.hit` signposts for the probe path.
    ///
    ///   SIMCTL_CHILD_ALMA_CACHE_SELFTEST=1 xcrun simctl launch <udid> com.almatraders.erp
    func runCacheSelfTestIfRequested() {
        guard ProcessInfo.processInfo.environment["ALMA_CACHE_SELFTEST"] == "1" else { return }
        // Decodes from ANY JSON shape (reads nothing) — we only care about request counts.
        struct Probe: Decodable { init(from decoder: Decoder) throws {} }
        let path = "/api/assistant/office/notifications"
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
            Task {
                AlmaPerfLog.event("cacheSelfTest.concurrentStart")
                // 6 identical GETs fired together → single-flight should collapse to 1.
                await withTaskGroup(of: Void.self) { group in
                    for _ in 0..<6 {
                        group.addTask { _ = try? await AlmaAPI.shared.get(path) as Probe }
                    }
                }
                AlmaPerfLog.event("cacheSelfTest.concurrentDone")
                // 4 sequential cached reads within a 60s TTL → 1 fetch + 3 cache.hit.
                AlmaPerfLog.event("cacheSelfTest.ttlStart")
                for _ in 0..<4 { _ = try? await AlmaAPI.shared.getCached(path, ttl: 60) as Probe }
                AlmaPerfLog.event("cacheSelfTest.ttlDone")
            }
        }
    }
}
#endif
