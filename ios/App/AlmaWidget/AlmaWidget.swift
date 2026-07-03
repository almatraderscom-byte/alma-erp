//
//  AlmaWidget.swift
//  AlmaWidget
//
//  Static "quick access" widget for Alma ERP.
//
//  Design decisions (v1):
//   - No network, no shared auth, no App Group. A single static timeline
//     entry with `.never` reload — the widget content is constant, so
//     WidgetKit never needs to refresh it.
//   - Deep links use the almaerp:// custom scheme already registered by the
//     host app's Info.plist (CFBundleURLSchemes) and handled by AlmaAppIntents
//     / the Capacitor DeepLinkManager on the web side:
//       almaerp://orders, almaerp://inventory, almaerp://payroll, almaerp://agent
//   - systemSmall  → whole widget is one tap target (widgetURL) → agent.
//   - systemMedium → 2x2 grid of Links, one per destination.
//   - iOS 16 compatible. containerBackground(for:) is iOS 17+, so it is
//     applied behind an availability check with a plain-background fallback.
//
//  Colors are inline (Color(red:green:blue:)) — no asset catalog by design.
//

import WidgetKit
import SwiftUI

// MARK: - Palette

private enum AlmaPalette {
    /// Background #0c0b12
    static let background = Color(red: 0x0c / 255.0, green: 0x0b / 255.0, blue: 0x12 / 255.0)
    /// Gold accent #C9A84C
    static let gold = Color(red: 0xC9 / 255.0, green: 0xA8 / 255.0, blue: 0x4C / 255.0)
    /// Muted tile surface, slightly lifted off the background.
    static let tile = Color(red: 0x1a / 255.0, green: 0x18 / 255.0, blue: 0x24 / 255.0)
    static let textPrimary = Color.white
    static let textSecondary = Color(red: 0.72, green: 0.72, blue: 0.78)
}

// MARK: - Destinations

private struct AlmaDestination: Identifiable {
    let id: String
    let label: String          // Bangla label
    let systemImage: String    // SF Symbol
    let url: URL

    init(id: String, label: String, systemImage: String, scheme: String) {
        self.id = id
        self.label = label
        self.systemImage = systemImage
        // Force-unwrap is safe: all URLs are compile-time literal almaerp:// strings.
        self.url = URL(string: "almaerp://\(scheme)")!
    }
}

private let almaDestinations: [AlmaDestination] = [
    AlmaDestination(id: "orders", label: "অর্ডার", systemImage: "bag.fill", scheme: "orders"),
    AlmaDestination(id: "inventory", label: "ইনভেন্টরি", systemImage: "archivebox.fill", scheme: "inventory"),
    AlmaDestination(id: "payroll", label: "পেরোল", systemImage: "creditcard.fill", scheme: "payroll"),
    AlmaDestination(id: "agent", label: "অ্যাসিস্ট্যান্ট", systemImage: "sparkles", scheme: "agent"),
]

private let agentURL = URL(string: "almaerp://agent")!

// MARK: - Timeline

struct AlmaEntry: TimelineEntry {
    let date: Date
}

struct AlmaProvider: TimelineProvider {
    func placeholder(in context: Context) -> AlmaEntry {
        AlmaEntry(date: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (AlmaEntry) -> Void) {
        completion(AlmaEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<AlmaEntry>) -> Void) {
        // Static content: a single entry that never needs to reload.
        let timeline = Timeline(entries: [AlmaEntry(date: Date())], policy: .never)
        completion(timeline)
    }
}

// MARK: - Shared pieces

private struct BrandMark: View {
    var compact: Bool = false

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "hexagon.fill")
                .font(.system(size: compact ? 13 : 15, weight: .bold))
                .foregroundColor(AlmaPalette.gold)
            Text("ALMA ERP")
                .font(.system(size: compact ? 13 : 15, weight: .heavy, design: .rounded))
                .kerning(1.5)
                .foregroundColor(AlmaPalette.textPrimary)
        }
    }
}

private struct DestinationTile: View {
    let destination: AlmaDestination

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: destination.systemImage)
                .font(.system(size: 20, weight: .semibold))
                .foregroundColor(AlmaPalette.gold)
            Text(destination.label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(AlmaPalette.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AlmaPalette.tile)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(AlmaPalette.gold.opacity(0.18), lineWidth: 1)
        )
    }
}

// MARK: - Small

private struct SmallWidgetView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BrandMark(compact: true)
            Spacer(minLength: 8)
            Image(systemName: "sparkles")
                .font(.system(size: 30, weight: .semibold))
                .foregroundColor(AlmaPalette.gold)
            Spacer(minLength: 8)
            Text("অ্যাসিস্ট্যান্ট")
                .font(.system(size: 16, weight: .bold))
                .foregroundColor(AlmaPalette.textPrimary)
            Text("ট্যাপ করে খুলুন")
                .font(.system(size: 11, weight: .regular))
                .foregroundColor(AlmaPalette.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        // The whole widget is a single tap target → agent.
        .widgetURL(agentURL)
    }
}

// MARK: - Medium

private struct MediumWidgetView: View {
    private let columns = [
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            BrandMark()
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(almaDestinations) { destination in
                    Link(destination: destination.url) {
                        DestinationTile(destination: destination)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Entry view (dispatches on family)

struct AlmaWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    var entry: AlmaProvider.Entry

    var body: some View {
        content
            .almaContainerBackground()
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .systemSmall:
            SmallWidgetView()
        default:
            // systemMedium (and any larger family that may be offered).
            MediumWidgetView()
        }
    }
}

// MARK: - Background helper (iOS 17 containerBackground, iOS 16 fallback)

private extension View {
    @ViewBuilder
    func almaContainerBackground() -> some View {
        if #available(iOS 17.0, *) {
            self.containerBackground(for: .widget) {
                AlmaPalette.background
            }
        } else {
            // iOS 16: no containerBackground API; pad + fill manually.
            self
                .padding(14)
                .background(AlmaPalette.background)
        }
    }
}

// MARK: - Widget

struct AlmaWidget: Widget {
    private let kind = "AlmaWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: AlmaProvider()) { entry in
            AlmaWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("ALMA ERP")
        .description("অর্ডার, ইনভেন্টরি, পেরোল ও অ্যাসিস্ট্যান্ট — এক ট্যাপে।")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
