//
//  ConnectivityBeacon.swift
//  ALMA ERP — app-wide offline experience (owner-approved WOW design, 2026-07).
//
//  The native twin of the web ConnectionGuard: when the network path drops, a
//  full-screen takeover blurs and darkens the app behind it and a terracotta
//  lighthouse beacon sweeps for signal — pulsing rings, an orbiting comet, an
//  ৮-second auto-retry countdown and a manual retry. When the path comes back
//  (verified with a real request), the takeover dissolves and a small chip
//  confirms "সংযোগ ফিরে এসেছে".
//
//  Lives in its own overlay window (like FloatingChatHead) so no existing screen
//  is touched. NWPathMonitor drives it; a short debounce stops Wi-Fi↔cellular
//  hand-offs from flashing the takeover.
//

import UIKit
import SwiftUI
import Network

@available(iOS 17.0, *)
final class ConnectivityBeacon {
    static let shared = ConnectivityBeacon()
    private init() {}

    private let monitor = NWPathMonitor()
    private var started = false
    private var overlay: UIWindow?
    private var chipWindow: PassthroughWindow?
    private var offlineDebounce: Timer?
    private var chipTimer: Timer?
    /// Never show the reconnect chip on the very first (startup) path report.
    private var wasOffline = false

    func install() {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async { self?.pathChanged(satisfied: path.status == .satisfied) }
        }
        monitor.start(queue: DispatchQueue(label: "alma.connectivity"))
    }

    @MainActor private func pathChanged(satisfied: Bool) {
        if satisfied {
            offlineDebounce?.invalidate()
            offlineDebounce = nil
            if overlay != nil {
                hideOverlay()
                showChip()
            }
            wasOffline = false
        } else {
            wasOffline = true
            // Debounce 1.5s — a Wi-Fi→cellular hop reports a brief unsatisfied path.
            guard offlineDebounce == nil, overlay == nil else { return }
            offlineDebounce = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.monitor.currentPath.status != .satisfied else { return }
                    self.showOverlay()
                }
            }
        }
    }

    /// Manual/auto retry: a real tiny request — path status alone can lie behind
    /// captive portals. Success dissolves the takeover.
    static func probe() async -> Bool {
        var req = URLRequest(url: AlmaAPI.baseURL.appendingPathComponent("api/health"))
        req.timeoutInterval = 5
        req.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            return (resp as? HTTPURLResponse)?.statusCode ?? 500 < 500
        } catch {
            return false
        }
    }

    @MainActor fileprivate func probeSucceeded() {
        hideOverlay()
        showChip()
    }

    // ── window plumbing ──────────────────────────────────────────────────────

    @MainActor private func scene() -> UIWindowScene? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    }

    @MainActor private func showOverlay() {
        guard overlay == nil, let scene = scene() else { return }
        let w = UIWindow(windowScene: scene)
        w.windowLevel = .alert - 1
        w.backgroundColor = .clear
        let host = UIHostingController(rootView: OfflineBeaconView())
        host.view.backgroundColor = .clear
        w.rootViewController = host
        w.isHidden = false
        w.alpha = 0
        UIView.animate(withDuration: 0.4) { w.alpha = 1 }
        overlay = w
    }

    @MainActor private func hideOverlay() {
        guard let w = overlay else { return }
        overlay = nil
        UIView.animate(withDuration: 0.45, animations: { w.alpha = 0 }) { _ in w.isHidden = true }
    }

    @MainActor private func showChip() {
        chipTimer?.invalidate()
        chipWindow?.isHidden = true
        chipWindow = nil
        guard let scene = scene() else { return }
        let w = PassthroughWindow(windowScene: scene)
        w.windowLevel = .alert - 1
        w.backgroundColor = .clear
        let host = UIHostingController(rootView: ReconnectChipView())
        host.view.backgroundColor = .clear
        w.rootViewController = host
        w.isHidden = false
        chipWindow = w
        chipTimer = Timer.scheduledTimer(withTimeInterval: 3.4, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, let cw = self.chipWindow else { return }
                UIView.animate(withDuration: 0.3, animations: { cw.alpha = 0 }) { _ in
                    cw.isHidden = true
                    self.chipWindow = nil
                }
            }
        }
    }
}

// MARK: - Views

private let bnDigits = Array("০১২৩৪৫৬৭৮৯")
private func bnNum(_ n: Int) -> String {
    String(String(n).map { c in c.isNumber ? bnDigits[Int(String(c))!] : c })
}

@available(iOS 17.0, *)
private struct OfflineBeaconView: View {
    @State private var sweep = false
    @State private var breathe = false
    @State private var countdown = 8
    @State private var checking = false
    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        ZStack {
            // Dark veil that blurs the whole app behind this window.
            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
            LinearGradient(colors: [Color.black.opacity(0.55), Color.black.opacity(0.78)],
                           startPoint: .top, endPoint: .bottom).ignoresSafeArea()

            VStack(spacing: 0) {
                beacon
                Text("সংযোগ হারিয়ে গেছে")
                    .font(.system(size: 22, weight: .heavy))
                    .foregroundStyle(.white)
                    .padding(.top, 18)
                Text("চিন্তা নেই — সব কাজ সেভ আছে।\nসিগন্যাল খোঁজা চলছে…")
                    .font(.system(size: 13))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.white.opacity(0.66))
                    .padding(.top, 7)

                Button {
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    retryNow()
                } label: {
                    Text(checking ? "চেষ্টা হচ্ছে…" : "এখনই আবার চেষ্টা করুন")
                        .font(.system(size: 14, weight: .heavy))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 30).padding(.vertical, 14)
                        .background(
                            LinearGradient(colors: [Color(red: 0.88, green: 0.48, blue: 0.37),
                                                    Color(red: 0.77, green: 0.35, blue: 0.24)],
                                           startPoint: .topLeading, endPoint: .bottomTrailing),
                            in: Capsule())
                        .shadow(color: Color(red: 0.88, green: 0.48, blue: 0.37).opacity(0.5), radius: 12, y: 6)
                }
                .disabled(checking)
                .padding(.top, 20)

                Text("নিজে-নিজে চেষ্টা হবে ")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.55))
                + Text("\(bnNum(countdown))")
                    .font(.system(size: 11.5, weight: .heavy))
                    .foregroundStyle(.white.opacity(0.85))
                + Text(" সেকেন্ডে")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.55))

                Label("অফলাইনেও ডেটা নিরাপদে সেভ থাকে", systemImage: "lock.fill")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.white.opacity(0.75))
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.white.opacity(0.08), in: Capsule())
                    .overlay(Capsule().strokeBorder(.white.opacity(0.14)))
                    .padding(.top, 20)
            }
            .padding(26)
        }
        .padding(.top, 0)
        .onAppear { sweep = true; breathe = true }
        .onReceive(ticker) { _ in
            countdown -= 1
            if countdown <= 0 {
                countdown = 8
                retryNow()
            }
        }
    }

    private func retryNow() {
        guard !checking else { return }
        checking = true
        Task {
            let ok = await ConnectivityBeacon.probe()
            await MainActor.run {
                checking = false
                countdown = 8
                if ok { ConnectivityBeacon.shared.probeSucceeded() }
            }
        }
    }

    private var beacon: some View {
        ZStack {
            // rotating lighthouse sweep
            AngularGradient(stops: [
                .init(color: Color(red: 0.96, green: 0.64, blue: 0.55).opacity(0.55), location: 0),
                .init(color: Color(red: 0.96, green: 0.64, blue: 0.55).opacity(0.12), location: 0.13),
                .init(color: .clear, location: 0.22),
                .init(color: .clear, location: 1),
            ], center: .center)
                .mask(Circle().strokeBorder(lineWidth: 54))
                .frame(width: 150, height: 150)
                .rotationEffect(.degrees(sweep ? 360 : 0))
                .animation(.linear(duration: 3.2).repeatForever(autoreverses: false), value: sweep)
                .blur(radius: 1)
            // pulsing rings
            PulseRing(delay: 0)
            PulseRing(delay: 1.3)
            // orbiting comet
            Circle()
                .fill(.white)
                .frame(width: 9, height: 9)
                .shadow(color: .white.opacity(0.7), radius: 6)
                .shadow(color: Color(red: 0.96, green: 0.64, blue: 0.55).opacity(0.5), radius: 13)
                .offset(y: -78)
                .rotationEffect(.degrees(sweep ? 360 : 0))
                .animation(.linear(duration: 8).repeatForever(autoreverses: false), value: sweep)
            // terracotta core
            Circle()
                .fill(RadialGradient(colors: [Color(red: 0.96, green: 0.64, blue: 0.55),
                                              Color(red: 0.77, green: 0.35, blue: 0.24)],
                                     center: .init(x: 0.34, y: 0.3), startRadius: 2, endRadius: 44))
                .frame(width: 64, height: 64)
                .shadow(color: Color(red: 0.88, green: 0.48, blue: 0.37).opacity(0.65), radius: 17)
                .scaleEffect(breathe ? 1.05 : 0.96)
                .animation(.easeInOut(duration: 2.6).repeatForever(autoreverses: true), value: breathe)
            Image(systemName: "wifi.slash")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(.white)
        }
        .frame(width: 150, height: 150)
    }
}

@available(iOS 17.0, *)
private struct PulseRing: View {
    let delay: Double
    @State private var on = false
    var body: some View {
        Circle()
            .strokeBorder(Color(red: 0.96, green: 0.64, blue: 0.55).opacity(0.5), lineWidth: 1)
            .frame(width: 122, height: 122)
            .scaleEffect(on ? 1.25 : 0.55)
            .opacity(on ? 0 : 0.8)
            .animation(.easeOut(duration: 2.6).repeatForever(autoreverses: false).delay(delay), value: on)
            .onAppear { on = true }
    }
}

@available(iOS 17.0, *)
private struct ReconnectChipView: View {
    @State private var shown = false
    var body: some View {
        VStack {
            HStack(spacing: 9) {
                Circle().fill(Color(red: 0.13, green: 0.77, blue: 0.37))
                    .frame(width: 8, height: 8)
                    .shadow(color: Color(red: 0.13, green: 0.77, blue: 0.37).opacity(0.7), radius: 5)
                Text("সংযোগ ফিরে এসেছে").font(.system(size: 12, weight: .bold))
                Text("সব সিংক হয়ে গেছে").font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.6))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 17).padding(.vertical, 9)
            .background(Color(red: 0.05, green: 0.05, blue: 0.07).opacity(0.92), in: Capsule())
            .shadow(color: .black.opacity(0.4), radius: 17, y: 7)
            .offset(y: shown ? 0 : -90)
            .animation(.spring(response: 0.5, dampingFraction: 0.72), value: shown)
            Spacer()
        }
        .padding(.top, 12)
        .onAppear { shown = true }
        .allowsHitTesting(false)
    }
}
