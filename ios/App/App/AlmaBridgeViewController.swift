//
//  AlmaBridgeViewController.swift
//  App
//
//  Custom Capacitor bridge view controller that registers the local
//  LiveActivityBridge plugin instance. Main.storyboard's root scene must set
//  its customClass to `AlmaBridgeViewController` (module `App`) instead of the
//  stock `CAPBridgeViewController` (module `Capacitor`) — see AlmaWidget/INTEGRATION.md.
//
//  `capacitorDidLoad()` is the sanctioned hook for registering local plugin
//  instances: by this point `bridge` is set (per CAPBridgeViewController docs),
//  and `registerPluginInstance(_:)` is the documented API for non-pod plugins.
//

import Capacitor
import UIKit

class AlmaBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LiveActivityBridgePlugin())
        bridge?.registerPluginInstance(NativeIntelligenceBridgePlugin())
        bridge?.registerPluginInstance(NativeSpeechBridgePlugin())
        bridge?.registerPluginInstance(EntityCacheBridgePlugin())

        // PHASE S1: this Capacitor web view is now tab 0 of the native tab bar, so
        // hide the web's own bottom nav (as the other tabs do). The user-script runs
        // on the next document load — the ERP loads after the bootstrap redirect, so
        // the nav is hidden by the time the dashboard renders.
        bridge?.webView?.configuration.userContentController.addUserScript(AlmaEmbed.userScript())
    }
}
