import AppIntents
import UIKit

/**
 * Siri / Shortcuts / Action Button integration (iOS 16+).
 *
 * Each intent opens the app on a deep-linked ERP route; deep links use the
 * almaerp:// custom scheme, which Capacitor delivers to the web app as an
 * appUrlOpen event (see DeepLinkManager on the web side).
 * Phrases appear automatically in the Shortcuts app and Siri once the build is
 * installed ("Open Alma ERP", "Alma ERP assistant", ...).
 */

@available(iOS 16.0, *)
struct OpenAlmaIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Alma ERP"
    static var description = IntentDescription("Open the Alma ERP dashboard.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenAssistantIntent: AppIntent {
    static var title: LocalizedStringResource = "Talk to ALMA Assistant"
    static var description = IntentDescription("Open the ALMA AI assistant.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        if let url = URL(string: "almaerp://agent") {
            await UIApplication.shared.open(url)
        }
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenOrdersIntent: AppIntent {
    static var title: LocalizedStringResource = "Alma ERP Orders"
    static var description = IntentDescription("Open orders in Alma ERP.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        if let url = URL(string: "almaerp://orders") {
            await UIApplication.shared.open(url)
        }
        return .result()
    }
}

@available(iOS 16.0, *)
struct AlmaShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenAlmaIntent(),
            phrases: [
                "Open \(.applicationName)",
                "\(.applicationName) খোলো",
            ],
            shortTitle: "Open Alma ERP",
            systemImageName: "house.fill"
        )
        AppShortcut(
            intent: OpenAssistantIntent(),
            phrases: [
                "Talk to \(.applicationName) assistant",
                "\(.applicationName) assistant",
            ],
            shortTitle: "ALMA Assistant",
            systemImageName: "sparkles"
        )
        AppShortcut(
            intent: OpenOrdersIntent(),
            phrases: [
                "\(.applicationName) orders",
                "Show \(.applicationName) orders",
            ],
            shortTitle: "Orders",
            systemImageName: "bag.fill"
        )
    }
}
