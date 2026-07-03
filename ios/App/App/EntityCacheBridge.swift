//
//  EntityCacheBridge.swift
//  App
//
//  Local Capacitor plugin that lets the web app push recent ERP orders/products
//  into the shared App Group cache (`group.com.almatraders.erp`) so the App
//  Intents entity queries in AlmaEntities.swift can surface them to Siri /
//  Spotlight / Shortcuts. The native side can't read the web session, so this
//  bridge is the data path.
//
//  JS side calls:
//    EntityCacheBridge.setEntities({ orders: [...], products: [...] }) → { saved }
//
//  Each order row: { id: String, title: String, status: String }.
//  Each product row: { id: String, title: String }.
//
//  Registered by AlmaBridgeViewController.capacitorDidLoad() via
//  registerPluginInstance(). Safety contract: NEVER crashes / rejects-hard — if the
//  App Group container is unavailable (entitlement not provisioned) it resolves
//  { saved:false } and the web layer simply moves on.
//

import AppIntents
import Capacitor
import Foundation

@objc(EntityCacheBridgePlugin)
public class EntityCacheBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "EntityCacheBridgePlugin"
    public let jsName = "EntityCacheBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEntities", returnType: CAPPluginReturnPromise)
    ]

    private let appGroup = "group.com.almatraders.erp"

    @objc public func setEntities(_ call: CAPPluginCall) {
        guard let defaults = UserDefaults(suiteName: appGroup) else {
            // App Group entitlement not provisioned on this build — fail-open.
            call.resolve(["saved": false, "reason": "no_app_group"])
            return
        }

        let orders = call.getArray("orders", []) ?? []
        let products = call.getArray("products", []) ?? []

        persist(orders, forKey: "orders", into: defaults)
        persist(products, forKey: "products", into: defaults)

        // Refresh the entity parameter values Siri/Spotlight suggests.
        if #available(iOS 16.0, *) {
            AlmaShortcuts.updateAppShortcutParameters()
        }

        call.resolve(["saved": true, "orders": orders.count, "products": products.count])
    }

    /// Serialize a JS array to JSON and store it; a non-serializable payload is
    /// skipped rather than crashing.
    private func persist(_ value: [Any], forKey key: String, into defaults: UserDefaults) {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value) else {
            return
        }
        defaults.set(data, forKey: key)
    }
}
