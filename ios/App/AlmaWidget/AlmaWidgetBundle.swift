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
    }
}
