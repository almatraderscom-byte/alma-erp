import UIKit
import UserNotifications
import Capacitor
import CapawesomeCapacitorAppShortcuts

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
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

        // Dynamic Panel lifecycle (spec §14) — on every activation: reconcile
        // duplicate activities, then restore the panel from the plugin's cache
        // if nothing is live (survives app restarts; the web sync is throttled
        // to 5 min and webview-dependent, so without this the lock screen sat
        // empty after a relaunch — owner-hit 2026-07-16). Registered as a
        // NotificationCenter observer because it provably fires in this app,
        // while the AppDelegate method path was found NOT to (see the
        // alma.diag.didBecomeActiveMethod marker in applicationDidBecomeActive).
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil, queue: .main
        ) { _ in
            // Badge reset moved from applicationDidBecomeActive(_:) — that
            // method never fired on cold launch here, so the reset had been
            // silently dead: server pushes use ios_badgeType "Increase"
            // (src/lib/notifications.ts), so without this the icon count only
            // ever grows. Notification Center items are untouched.
            if #available(iOS 16.0, *) {
                UNUserNotificationCenter.current().setBadgeCount(0)
            } else {
                UIApplication.shared.applicationIconBadgeNumber = 0
            }
            if #available(iOS 16.1, *) {
                PulseRestore.reconcile()
                PulseRestore.restartFromCache()
            }
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

    // applicationDidBecomeActive(_:) was REMOVED on purpose (2026-07-16): the
    // method was observed not to fire on cold launch in this app (proven by a
    // UserDefaults marker that stayed empty while the equivalent
    // NotificationCenter observer ran) — so the badge reset that lived here
    // silently never worked. All did-become-active work now runs in the
    // didBecomeActiveNotification observer registered in didFinishLaunching.
    // Do not re-add lifecycle work here.

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
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
