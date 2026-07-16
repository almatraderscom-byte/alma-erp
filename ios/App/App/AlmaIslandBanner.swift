//
//  AlmaIslandBanner.swift
//  ALMA ERP — the native ALMA Island (owner-approved WOW design, 2026-07).
//
//  A Dynamic-Island-style pill that drops from the top of ANY screen when a new
//  office result lands for the logged-in user: task approved (confetti burst +
//  celebration), redo requested (amber, with the Boss's note), weekly award
//  (gold). The watcher polls the same office notifications feed the web bell
//  uses, remembers what it has already surfaced, and only ever surfaces fresh
//  unread results — so it never re-plays old news.
//
//  Lives in its own passthrough window (same pattern as FloatingChatHead) so no
//  existing screen is touched and touches outside the island fall through.
//

import UIKit
import SwiftUI

// MARK: - Feed contract (subset of /api/assistant/office/notifications)

private struct IslandNotice: Decodable, Equatable {
    let id: String
    let kind: String
    let title: String
    let body: String?
    let read: Bool
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        kind = (try? c.decode(String.self, forKey: .kind)) ?? ""
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        body = try? c.decodeIfPresent(String.self, forKey: .body)
        read = (try? c.decode(Bool.self, forKey: .read)) ?? true
    }
    enum CodingKeys: String, CodingKey { case id, kind, title, body, read }
}

private struct IslandFeed: Decodable {
    let items: [IslandNotice]
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        items = (try? c.decodeIfPresent([IslandNotice].self, forKey: .items)) ?? []
    }
    enum CodingKeys: String, CodingKey { case items }
}

// MARK: - Watcher

@available(iOS 17.0, *)
final class AlmaIslandWatch {
    static let shared = AlmaIslandWatch()
    private init() {}

    /// Result kinds worth an Island moment (approve / redo / award — not chatter).
    private static let islandKinds: Set<String> = ["approved", "redo", "award"]

    private var timer: Timer?
    private var seen: Set<String>? = nil // nil until the first (seeding) poll
    private var window: PassthroughWindow?

    func install() {
        // IOSP-4: the 30s office-notification poll is scene-aware — suspended in the
        // background (nothing to surface there; the Island window only shows on a
        // foreground screen) and resumed on foreground. Removes idle background work.
        NotificationCenter.default.addObserver(
            self, selector: #selector(resumePoll),
            name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(suspendPoll),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
        resumePoll()
        Task { await poll() } // seed immediately
    }

    @objc private func resumePoll() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { await self?.poll() }
        }
    }

    @objc private func suspendPoll() {
        timer?.invalidate()
        timer = nil
    }

    private func poll() async {
        guard let feed: IslandFeed = try? await AlmaAPI.shared.get("/api/assistant/office/notifications") else { return }
        if seen == nil {
            seen = Set(feed.items.map(\.id))
            return
        }
        let fresh = feed.items.first { !$0.read && !(seen!.contains($0.id)) && Self.islandKinds.contains($0.kind) }
        feed.items.forEach { seen!.insert($0.id) }
        if let n = fresh { await MainActor.run { self.present(n) } }
    }

    @MainActor private func present(_ n: IslandNotice) {
        guard window == nil else { return } // one at a time; the next poll re-finds anything missed
        // IOSP-2: shared scene lookup + z-order via AlmaOverlayCoordinator.
        guard let scene = AlmaOverlayCoordinator.shared.foregroundScene() else { return }

        let w = PassthroughWindow(windowScene: scene)
        w.windowLevel = AlmaOverlayCoordinator.Level.island
        w.backgroundColor = .clear
        let host = UIHostingController(rootView: AlmaIslandView(
            kind: n.kind, title: n.title, body: n.body ?? "",
            onDone: { [weak self] in
                Task { @MainActor in
                    self?.window?.isHidden = true
                    self?.window = nil
                }
            }))
        host.view.backgroundColor = .clear
        w.rootViewController = host
        w.isHidden = false
        window = w
        if n.kind == "approved" || n.kind == "award" {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } else {
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }
    }
}

// MARK: - Island view (pill → spring open → confetti → fold away)

@available(iOS 17.0, *)
private struct AlmaIslandView: View {
    let kind: String
    let title: String
    let body_: String
    let onDone: () -> Void

    @State private var open = false
    @State private var confetti = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(kind: String, title: String, body: String, onDone: @escaping () -> Void) {
        self.kind = kind
        self.title = title
        self.body_ = body
        self.onDone = onDone
    }

    private var good: Bool { kind == "approved" || kind == "award" }
    private var icon: String { kind == "approved" ? "✅" : kind == "award" ? "🏆" : "🔄" }
    private var accent: Color {
        good ? Color(red: 0.29, green: 0.87, blue: 0.5) : Color(red: 0.98, green: 0.75, blue: 0.14)
    }

    var body: some View {
        ZStack(alignment: .top) {
            if confetti { ConfettiBurst().allowsHitTesting(false) }
            island
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        // IOSP-2: the whole pill reads as one VoiceOver element with its message.
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title). \(body_)")
        .onAppear {
            // IOSP-2: Reduce Motion → open instantly and skip the confetti burst.
            if reduceMotion {
                open = true
            } else {
                withAnimation(.spring(response: 0.55, dampingFraction: 0.68).delay(0.42)) { open = true }
                if good {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) { confetti = true }
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 5.2) {
                if reduceMotion { open = false }
                else { withAnimation(.spring(response: 0.45, dampingFraction: 0.8)) { open = false } }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 5.8) { onDone() }
        }
    }

    private var island: some View {
        ZStack {
            if open {
                HStack(spacing: 12) {
                    Text(icon)
                        .font(.system(size: 19))
                        .frame(width: 42, height: 42)
                        .background(accent.opacity(0.18), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(accent.opacity(0.4)))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.system(size: 13, weight: .bold)).lineLimit(1)
                        if !body_.isEmpty {
                            Text(body_).font(.system(size: 11))
                                .foregroundStyle(.white.opacity(0.62)).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .transition(.opacity)
            } else {
                HStack(spacing: 8) {
                    Circle().fill(Color(red: 0.96, green: 0.64, blue: 0.55))
                        .frame(width: 7, height: 7)
                        .shadow(color: Color(red: 0.96, green: 0.64, blue: 0.55).opacity(0.6), radius: 4)
                    Text("ALMA").font(.system(size: 11, weight: .bold)).tracking(1.5)
                }
                .transition(.opacity)
            }
        }
        .foregroundStyle(.white)
        // IOSP-2: width from the layout container (capped 560 + 11pt side insets),
        // not UIScreen.main.bounds — which is wrong under split-view/stage-manager
        // and on external displays. Closed pill stays a fixed 110.
        .frame(maxWidth: open ? 560 : 110)
        .frame(height: open ? 74 : 30)
        .padding(.horizontal, open ? 11 : 0)
        .background(Color(red: 0.05, green: 0.05, blue: 0.07).opacity(0.94),
                    in: RoundedRectangle(cornerRadius: open ? 26 : 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: open ? 26 : 24, style: .continuous)
            .strokeBorder(.white.opacity(0.09)))
        .shadow(color: .black.opacity(0.45), radius: 20, y: 8)
        .padding(.top, 10)
    }
}

/// One-shot confetti burst rendered with Canvas — brand palette + success green.
@available(iOS 17.0, *)
private struct ConfettiBurst: View {
    private struct Bit {
        let x0: CGFloat, vx: CGFloat, vy: CGFloat, size: CGFloat, spin: Double, hue: Color
    }
    private let bits: [Bit]
    private let born = Date()

    init() {
        let palette: [Color] = [
            Color(red: 0.88, green: 0.48, blue: 0.37), Color(red: 0.96, green: 0.64, blue: 0.55),
            Color(red: 0.95, green: 0.77, blue: 0.55), Color(red: 0.29, green: 0.87, blue: 0.5),
            Color(red: 0.55, green: 0.36, blue: 0.96), .white,
        ]
        bits = (0..<80).map { _ in
            Bit(x0: CGFloat.random(in: 0.3...0.7),
                vx: CGFloat.random(in: -90...90),
                vy: CGFloat.random(in: 60...220),
                size: CGFloat.random(in: 4...8),
                spin: Double.random(in: -4...4),
                hue: palette.randomElement()!)
        }
    }

    var body: some View {
        TimelineView(.animation) { tl in
            Canvas { ctx, size in
                let t = tl.date.timeIntervalSince(born)
                guard t < 2.4 else { return }
                for b in bits {
                    let x = b.x0 * size.width + b.vx * t
                    let y = 60 + b.vy * t + 140 * t * t
                    guard y < size.height else { continue }
                    let alpha = max(0, 1 - t / 2.2)
                    var rect = ctx
                    rect.translateBy(x: x, y: y)
                    rect.rotate(by: .radians(b.spin * t))
                    rect.opacity = alpha
                    rect.fill(Path(CGRect(x: -b.size / 2, y: -b.size / 4, width: b.size, height: b.size / 2)),
                              with: .color(b.hue))
                }
            }
        }
        .ignoresSafeArea()
        .frame(maxHeight: 420, alignment: .top)
    }
}
