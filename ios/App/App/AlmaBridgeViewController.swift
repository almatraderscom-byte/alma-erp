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
    }
}
