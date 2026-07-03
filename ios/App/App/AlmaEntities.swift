//
//  AlmaEntities.swift
//  App
//
//  App Intents *entities* (iOS 16+) — exposes recent ERP orders/products to Siri,
//  Spotlight and the Shortcuts app as first-class `AppEntity` types, plus a
//  parameterized `OpenOrderIntent(order:)` that deep-links to a specific order.
//
//  The native side cannot read the web session, so entity data comes from a shared
//  App Group cache (`group.com.almatraders.erp`): the web app periodically POSTs
//  recent orders to `EntityCacheBridge.setEntities`, which persists them; the
//  `EntityQuery`s below read that cache. Everything is read-only and fail-safe —
//  an empty/missing cache simply yields no entities.
//

import AppIntents
import Foundation
import UIKit

// MARK: - Shared App Group cache (read side)

/// Reads entity rows the web app cached into the shared App Group. Never throws —
/// a missing container / key / malformed JSON yields an empty list.
enum AlmaEntityCache {
    static let appGroup = "group.com.almatraders.erp"

    private static func rows(_ key: String) -> [[String: Any]] {
        guard let defaults = UserDefaults(suiteName: appGroup),
              let data = defaults.data(forKey: key),
              let json = try? JSONSerialization.jsonObject(with: data),
              let arr = json as? [[String: Any]] else {
            return []
        }
        return arr
    }

    @available(iOS 16.0, *)
    static func orders() -> [OrderEntity] {
        rows("orders").compactMap { dict in
            guard let id = dict["id"] as? String, !id.isEmpty else { return nil }
            let title = (dict["title"] as? String) ?? id
            let status = (dict["status"] as? String) ?? ""
            return OrderEntity(id: id, title: title, status: status)
        }
    }

    @available(iOS 16.0, *)
    static func products() -> [ProductEntity] {
        rows("products").compactMap { dict in
            guard let id = dict["id"] as? String, !id.isEmpty else { return nil }
            let title = (dict["title"] as? String) ?? id
            return ProductEntity(id: id, title: title)
        }
    }
}

// MARK: - OrderEntity

@available(iOS 16.0, *)
struct OrderEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Order")
    static var defaultQuery = OrderEntityQuery()

    var id: String
    var title: String
    var status: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(status)")
    }
}

@available(iOS 16.0, *)
struct OrderEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [OrderEntity] {
        let all = AlmaEntityCache.orders()
        return all.filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [OrderEntity] {
        AlmaEntityCache.orders()
    }
}

// MARK: - ProductEntity

@available(iOS 16.0, *)
struct ProductEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Product")
    static var defaultQuery = ProductEntityQuery()

    var id: String
    var title: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)")
    }
}

@available(iOS 16.0, *)
struct ProductEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [ProductEntity] {
        AlmaEntityCache.products().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [ProductEntity] {
        AlmaEntityCache.products()
    }
}

// MARK: - Parameterized intent → deep link to a specific order

/// "Open order …" — Siri/Shortcuts resolves the `order` parameter against the
/// cached OrderEntity list and deep-links to `almaerp://orders/<id>`, which
/// DeepLinkManager routes to `/orders/<id>` on the web side. Unlocks wishlist #9
/// (system-suggested contextual actions) via the entity suggestions above.
@available(iOS 16.0, *)
struct OpenOrderIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Alma Order"
    static var description = IntentDescription("Open a specific order in Alma ERP.")
    static var openAppWhenRun = true

    @Parameter(title: "Order")
    var order: OrderEntity

    @MainActor
    func perform() async throws -> some IntentResult {
        if let url = URL(string: "almaerp://orders/\(order.id)") {
            await UIApplication.shared.open(url)
        }
        return .result()
    }
}
