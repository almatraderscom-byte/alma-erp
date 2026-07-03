//
//  PulseActivityAttributes.swift
//  Shared between the App target and the AlmaWidgetExtension target.
//
//  "Business Pulse" Live Activity model. This single file is compiled into
//  BOTH targets (the App drives the activity via ActivityKit; the widget
//  extension renders it via ActivityConfiguration). Keep it dependency-free
//  and identical for both sides — it is the shared contract.
//
//  ActivityKit is iOS 16.1+. `ActivityAttributes` conformance requires the
//  type itself to be available at iOS 16.1, so the availability annotation is
//  placed on the type declarations (not merely on members). The whole file is
//  additionally guarded with `#if canImport(ActivityKit)` so it is a harmless
//  no-op if the SDK ever lacks ActivityKit.
//

#if canImport(ActivityKit)
import ActivityKit
import Foundation

@available(iOS 16.1, *)
struct PulseActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var ordersToday: Int
        var statusLine: String
        var updatedAt: Date
    }

    var title: String
}
#endif
