//
//  SipCallPill.swift
//  ALMA ERP — floating live-call pill (owner ask 2026-09-01, item 5).
//
//  Minimising the call screen must feel like WhatsApp/the agent live-voice dock:
//  a small green pill with a breathing waveform stays on top of EVERY screen while
//  a native customer call is live and the phone screen is not visible. Tapping it
//  returns to /agent/phone through the app's single routing path (.almaOpenPath).
//
//  Same PassthroughWindow pattern as FloatingChatHead — no screen is touched, and
//  touches outside the pill fall through.
//

import SwiftUI
import UIKit
import Combine

@available(iOS 17.0, *)
@MainActor
final class SipCallPillCoordinator {
    static let shared = SipCallPillCoordinator()
    private var window: PassthroughWindow?
    private var bag = Set<AnyCancellable>()
    /// Set by PhoneScreen's appear/disappear — the pill only shows elsewhere.
    var phoneScreenVisible = false { didSet { refresh() } }

    private init() {
        SipCallController.shared.$current
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refresh() }
            .store(in: &bag)
    }

    /// Idempotent: call once anywhere (PhoneScreen onAppear does).
    func install() { refresh() }

    private func refresh() {
        let shouldShow = SipCallController.shared.current != nil && !phoneScreenVisible
        if shouldShow { show() } else { hide() }
    }

    private func show() {
        guard window == nil,
              let scene = AlmaOverlayCoordinator.shared.foregroundScene() else { return }
        let w = PassthroughWindow(windowScene: scene)
        w.windowLevel = AlmaOverlayCoordinator.Level.chatHead
        w.backgroundColor = .clear
        let host = UIHostingController(rootView: SipCallPillView())
        host.view.backgroundColor = .clear
        w.rootViewController = host
        w.isHidden = false
        window = w
    }

    private func hide() {
        window?.isHidden = true
        window = nil
    }
}

@available(iOS 17.0, *)
private struct SipCallPillView: View {
    @ObservedObject private var sipCall = SipCallController.shared

    var body: some View {
        VStack {
            if let call = sipCall.current {
                Button {
                    NotificationCenter.default.post(
                        name: .almaOpenPath, object: nil, userInfo: ["path": "/agent/phone"])
                } label: {
                    HStack(spacing: 8) {
                        SipPillWave()
                        Text(call.peer.isEmpty ? "কল চলছে" : call.peer)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        if let since = call.connectedAt {
                            TimelineView(.periodic(from: since, by: 1)) { ctx in
                                let t = Int(ctx.date.timeIntervalSince(since))
                                Text("\(t / 60):" + String(format: "%02d", t % 60))
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.white.opacity(0.85))
                            }
                        }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Capsule().fill(Color.green.opacity(0.92)))
                    .shadow(color: .black.opacity(0.35), radius: 8, y: 3)
                }
                .padding(.top, 4)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}

/// Tiny breathing waveform — the "live" cue, matching the agent voice dock's feel.
@available(iOS 17.0, *)
private struct SipPillWave: View {
    @State private var up = false
    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<4, id: \.self) { i in
                Capsule()
                    .fill(.white)
                    .frame(width: 3, height: up ? [12, 7, 14, 9][i] : [6, 12, 8, 13][i])
            }
        }
        .frame(height: 14)
        .animation(.easeInOut(duration: 0.45).repeatForever(autoreverses: true), value: up)
        .onAppear { up = true }
    }
}
