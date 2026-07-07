//
//  IntercomUI.swift
//  ALMA ERP — Office Live Intercom UI (walkie-talkie + 1:1 call) on the AgoraIntercom engine.
//  Owner = broadcaster (open mic to all staff) + can ring one staff; staff = live listener that
//  can also answer an incoming ring. Presented from the floating chat head's long-press menu.
//

import SwiftUI

@available(iOS 17.0, *)
struct IntercomView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var vm = PortalOfficeVM()
    private let ic = AgoraIntercom.shared
    @State private var incomingChannel: String? = nil

    private var isOwner: Bool { vm.selfRole == "owner" }
    private var accent: Color { PortalOfficePalette.accentText(scheme) }

    var body: some View {
        NavigationStack {
            ZStack {
                PortalOfficeAurora()
                ScrollView {
                    VStack(spacing: 16) {
                        if let e = ic.error { errorStrip(e) }
                        if ic.mode == .calling {
                            callBar
                        } else if !vm.roleResolved {
                            ProgressView().tint(.white).padding(.top, 70)
                                .task { await vm.loadHub() }
                        } else if isOwner {
                            ownerBroadcast
                            callRoster
                        } else {
                            staffListen
                        }
                    }
                    .padding(18)
                }
            }
            .navigationTitle("অফিস ইন্টারকম")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("বন্ধ") { ic.leave(); dismiss() }
                }
            }
        }
        .task { await ic.loadFeed() }
        .onDisappear { ic.leave() }
    }

    // ── Owner: live broadcast ──
    private var ownerBroadcast: some View {
        VStack(spacing: 14) {
            liveOrb(active: ic.mode == .broadcasting, speaking: ic.mode == .broadcasting)
            Text(ic.mode == .broadcasting ? "🔴 লাইভ — আপনি বলছেন" : "🎙️ লাইভ ওয়াকি-টকি")
                .font(.title3.weight(.bold))
            Text(ic.mode == .broadcasting
                 ? "সব স্টাফের ফোনে এখনই আপনার কথা শোনা যাচ্ছে।"
                 : "চালু করলে আপনার কথা সরাসরি সব স্টাফের ফোনে শোনা যাবে।")
                .font(.subheadline).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if ic.mode == .broadcasting {
                HStack(spacing: 10) {
                    bigButton(ic.micMuted ? "🔇 আনমিউট" : "🎙️ মিউট",
                              tint: PortalOfficePalette.violet) { ic.toggleMute() }
                    bigButton("বন্ধ করুন", tint: PortalOfficePalette.red500, filled: true) { ic.leave() }
                }
            } else {
                bigButton("লাইভ শুরু করুন", tint: PortalOfficePalette.coral, filled: true) {
                    Task { await ic.joinLive(asBroadcaster: true) }
                }
            }
            if !ic.statusText.isEmpty {
                Text(ic.statusText).font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(18).portalOfficeGlass(scheme, corner: 22)
    }

    // ── Owner: per-staff 1:1 call ──
    private var callRoster: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("সরাসরি কল", systemImage: "phone.fill")
                .font(.footnote.weight(.bold)).foregroundStyle(accent)
            if ic.roster.isEmpty {
                Text("সক্রিয় স্টাফ পাওয়া যায়নি।").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(ic.roster) { s in
                HStack(spacing: 10) {
                    officeAvatar(nil, initial: s.name.first.map { String($0).uppercased() } ?? "•", size: 32)
                    Text(s.name).font(.subheadline.weight(.semibold))
                    Spacer()
                    Button {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        Task { await ic.ownerCall(staffId: s.id) }
                    } label: {
                        Label("কল", systemImage: "phone.fill")
                            .font(.caption.weight(.bold)).foregroundStyle(.white)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(PortalOfficePalette.emerald600, in: Capsule())
                    }.buttonStyle(.plain)
                }
                .padding(.vertical, 3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16).portalOfficeGlass(scheme, corner: 18)
    }

    // ── Staff: listen live + answer a ring ──
    private var staffListen: some View {
        VStack(spacing: 14) {
            liveOrb(active: ic.connected, speaking: ic.remoteSpeaking)
            Text(ic.remoteSpeaking ? "🔊 বস বলছেন" : (ic.connected ? "শুনছেন… (লাইভ)" : "সংযোগ হচ্ছে…"))
                .font(.title3.weight(.bold))
            Text("বস লাইভ বললে এখানে সাথে সাথে শোনা যাবে।")
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if let ch = incomingChannel {
                VStack(spacing: 8) {
                    Text("📞 বস কল করছেন").font(.subheadline.weight(.bold))
                    bigButton("কল ধরুন", tint: PortalOfficePalette.emerald600, filled: true) {
                        incomingChannel = nil
                        Task { await ic.startCall(channel: ch) }
                    }
                }
                .padding(12)
                .background(PortalOfficePalette.emerald600.opacity(0.14),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(18).portalOfficeGlass(scheme, corner: 22)
        .task {
            await ic.joinLive(asBroadcaster: false)
            while !Task.isCancelled {                // poll for an incoming ring
                if ic.mode != .calling { incomingChannel = await ic.pendingCallChannel() }
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }

    // ── Active call bar (both sides) ──
    private var callBar: some View {
        VStack(spacing: 14) {
            liveOrb(active: true, speaking: ic.remoteSpeaking)
            Text(ic.remoteSpeaking ? "🔊 কথা হচ্ছে" : "📞 কল চলছে").font(.title3.weight(.bold))
            Text(timeStr(ic.callSeconds)).font(.title2.weight(.bold).monospacedDigit()).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                bigButton(ic.micMuted ? "🔇 আনমিউট" : "🎙️ মিউট",
                          tint: PortalOfficePalette.violet) { ic.toggleMute() }
                bigButton("কল কাটুন", tint: PortalOfficePalette.red500, filled: true) { ic.leave() }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(18).portalOfficeGlass(scheme, corner: 22)
    }

    // ── Bits ──
    private func liveOrb(active: Bool, speaking: Bool) -> some View {
        ZStack {
            Circle()
                .fill(LinearGradient(colors: [PortalOfficePalette.coral, PortalOfficePalette.violet],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 116, height: 116)
                .shadow(color: (speaking ? PortalOfficePalette.coral : .clear).opacity(0.6), radius: 22)
                .scaleEffect(speaking ? 1.06 : 1)
                .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: speaking)
            Image(systemName: speaking ? "waveform" : (active ? "dot.radiowaves.left.and.right" : "mic.slash"))
                .font(.system(size: 40, weight: .semibold)).foregroundStyle(.white)
        }
        .padding(.top, 6)
    }

    private func bigButton(_ label: String, tint: Color, filled: Bool = false, action: @escaping () -> Void) -> some View {
        Button { UIImpactFeedbackGenerator(style: .soft).impactOccurred(); action() } label: {
            Text(label).font(.subheadline.weight(.bold))
                .foregroundStyle(filled ? .white : tint)
                .frame(maxWidth: .infinity).padding(.vertical, 14)
                .background(filled ? AnyShapeStyle(tint) : AnyShapeStyle(tint.opacity(0.14)),
                            in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(tint.opacity(filled ? 0 : 0.4), lineWidth: 1))
        }.buttonStyle(.plain)
    }

    private func errorStrip(_ msg: String) -> some View {
        Label(msg, systemImage: "exclamationmark.triangle.fill")
            .font(.footnote).foregroundStyle(PortalOfficePalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).background(PortalOfficePalette.red500.opacity(0.12),
                                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func timeStr(_ s: Int) -> String {
        String(format: "%02d:%02d", s / 60, s % 60)
    }
}

// MARK: - Chat-head long-press quick actions

@available(iOS 17.0, *)
struct ChatHeadQuickActions: View {
    let onChat: () -> Void
    let onWalkie: () -> Void
    let onDismiss: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.28).ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { onDismiss() }
            VStack(spacing: 10) {
                Capsule().fill(Color.secondary.opacity(0.4)).frame(width: 38, height: 5).padding(.top, 8)
                Text("দ্রুত অ্যাকশন").font(.footnote.weight(.bold)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18)
                row("গ্রুপ চ্যাট", "bubble.left.and.bubble.right.fill", PortalOfficePalette.coral, onChat)
                row("লাইভ ওয়াকি-টকি / কল", "dot.radiowaves.left.and.right", PortalOfficePalette.violet, onWalkie)
                row("বন্ধ করুন", "xmark", .secondary, onDismiss)
                Color.clear.frame(height: 8)
            }
            .padding(.bottom, 8)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .padding(.horizontal, 12).padding(.bottom, 12)
        }
    }

    private func row(_ label: String, _ icon: String, _ tint: Color, _ action: @escaping () -> Void) -> some View {
        Button { UIImpactFeedbackGenerator(style: .soft).impactOccurred(); action() } label: {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(.white).frame(width: 40, height: 40)
                    .background(tint, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                Text(label).font(.body.weight(.semibold)).foregroundStyle(.primary)
                Spacer()
            }
            .padding(.horizontal, 16).padding(.vertical, 6)
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}
