import UIKit
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

        // PHASE S0 SPIKE: swap the window root to the native tab-bar shell so the
        // owner can feel a native frame on device. This replaces the storyboard
        // (Capacitor) root for THIS build only. To revert, delete this block —
        // the Capacitor root returns unchanged.
        if window == nil { window = UIWindow(frame: UIScreen.main.bounds) }
        window?.rootViewController = SpikeTabBarController()
        window?.makeKeyAndVisible()

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
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

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
