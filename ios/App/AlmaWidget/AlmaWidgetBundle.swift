//
//  AlmaWidgetBundle.swift
//  AlmaWidget
//
//  Home-screen widget extension for the Alma ERP Capacitor app.
//  v1: static "quick access" widget — no network, no shared auth.
//  Brand tile + deep-link buttons via the almaerp:// custom scheme
//  (registered by the host app; Capacitor delivers it to the web app
//  as an appUrlOpen event). See AlmaWidget.swift for the widget itself.
//

import WidgetKit
import SwiftUI

@main
struct AlmaWidgetBundle: WidgetBundle {
    var body: some Widget {
        AlmaWidget()
        // Live Activity — iOS 16.1+ only. WidgetBundle bodies can't hold a bare
        // `if #available`, so the availability check lives in a builder member.
        pulseLiveActivity
        voiceLiveActivity
    }

    @WidgetBundleBuilder
    private var pulseLiveActivity: some Widget {
        if #available(iOS 16.1, *) {
            PulseLiveActivity()
        }
    }

    // ALMA voice-session island — iOS 17+ (LiveActivityIntent End button).
    @WidgetBundleBuilder
    private var voiceLiveActivity: some Widget {
        if #available(iOS 17.0, *) {
            AlmaVoiceLiveActivity()
        }
    }
}
