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

        // PHASE S1/S2: this Capacitor web view is now tab 0 of the native tab bar.
        // Set the native-shell flag (activates the ERP's embed mode), hide the web's
        // own bottom nav, and — since the Dashboard tab is now wrapped in a native
        // header (S3) — hide the web's own top page-header too (hideWebHeader:true sets
        // window.__almaNativeHeader). Scripts run on the next document load; the ERP
        // loads after the bootstrap redirect, so this applies by the time it renders.
        if let content = bridge?.webView?.configuration.userContentController {
            AlmaEmbed.install(into: content, hideWebHeader: true)
        }
    }
}
