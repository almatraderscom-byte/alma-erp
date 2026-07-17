//
//  IntercomUI.swift
//  ALMA ERP — Office Live Intercom UI (walkie-talkie + 1:1 call) on the AgoraIntercom engine.
//  Owner = broadcaster (open mic to all staff) + can ring one staff; staff = live listener that
//  can also answer an incoming ring. Presented from the floating chat head's long-press menu.
//

import SwiftUI
import AVFoundation

@available(iOS 17.0, *)
struct IntercomView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var vm = PortalOfficeVM()
    private let ic = AgoraIntercom.shared
    @State private var voicePlayer: AVPlayer? = nil
    @State private var playedVoiceIds = Set<String>()

    private var isOwner: Bool { vm.selfRole == "owner" }
    private var accent: Color { PortalOfficePalette.accentText(scheme) }

    var body: some View {
        NavigationStack {
            ZStack {
                PortalOfficeAurora()
                ScrollView {
                    VStack(spacing: 16) {
                        if let e = ic.error { errorStrip(e) }
                        if ic.mode == .calling || ic.mode == .ringing {
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

    // ── Owner: press-and-hold voice note (reaches ALL staff, lands in the group) ──
    private var ownerBroadcast: some View {
        VStack(spacing: 14) {
            liveOrb(active: ic.recording, speaking: ic.recording || ic.localSpeaking)
            Text(ic.recording ? "🔴 রেকর্ড হচ্ছে — বলুন" : "🎙️ চেপে ধরে বলুন")
                .font(.title3.weight(.bold))
            Text(ic.recording
                 ? "ছেড়ে দিলে সব স্টাফের ফোনে ভয়েস চলে যাবে।"
                 : "মাইক চেপে ধরে বলুন — ছাড়লেই সব স্টাফ গ্রুপে ভয়েসটি পাবে (অনলাইন না থাকলেও)।")
                .font(.subheadline).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            // Press-and-hold PTT — record on press, upload on release.
            pttButton

            if !ic.statusText.isEmpty {
                Text(ic.statusText).font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(18).portalOfficeGlass(scheme, corner: 22)
    }

    private var pttButton: some View {
        let tint = ic.recording ? PortalOfficePalette.red500 : PortalOfficePalette.coral
        return Text(ic.recording ? "ছেড়ে দিন — পাঠাতে" : "🎙️ চেপে ধরুন")
            .font(.headline.weight(.bold)).foregroundStyle(.white)
            .frame(maxWidth: .infinity).padding(.vertical, 20)
            .background(tint, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .scaleEffect(ic.recording ? 1.03 : 1)
            .animation(.easeInOut(duration: 0.2), value: ic.recording)
            .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        if !ic.recording {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            Task { await ic.pttStart() }
                        }
                    }
                    .onEnded { _ in
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        Task { await ic.pttStop() }
                    }
            )
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
            Text("বস ভয়েস পাঠালে এখানে সাথে সাথে বেজে উঠবে।")
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(18).portalOfficeGlass(scheme, corner: 22)
        .task {
            await ic.joinLive(asBroadcaster: false)
            // Incoming CALLS are handled app-wide by FloatingChatHead; here we only
            // auto-play new voice notes while this screen is open.
            while !Task.isCancelled {
                if ic.mode != .calling && ic.mode != .ringing { await playPendingVoiceNotes() }
                try? await Task.sleep(nanoseconds: 2_500_000_000)
            }
        }
    }

    /// Auto-play any voice note the boss sent that I haven't heard yet (online or not).
    @MainActor
    private func playPendingVoiceNotes() async {
        let pending = await ic.pendingVoiceNotes()
        for v in pending where !playedVoiceIds.contains(v.id) {
            guard let url = URL(string: v.url) else { continue }
            playedVoiceIds.insert(v.id)
            try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.defaultToSpeaker])
            try? AVAudioSession.sharedInstance().setActive(true)
            let p = AVPlayer(url: url)
            voicePlayer = p
            p.play()
            await ic.markVoicePlayed(v.id)
            break   // one at a time — the next poll picks up the rest
        }
    }

    // ── Active call bar (both sides) — ringing until the other side joins ──
    private var callBar: some View {
        let ringing = ic.mode == .ringing
        return VStack(spacing: 14) {
            // While ringing, keep the orb pulsing so it clearly reads as "not connected yet".
            liveOrb(active: true, speaking: ringing || ic.remoteSpeaking)
            Text(ringing ? "📞 রিং হচ্ছে…" : (ic.remoteSpeaking ? "🔊 কথা হচ্ছে" : "📞 কল চলছে"))
                .font(.title3.weight(.bold))
            // No timer until connected — WhatsApp-style.
            Text(ringing ? "অপর পক্ষ ধরার অপেক্ষায়…" : timeStr(ic.callSeconds))
                .font(ringing ? .subheadline : .title2.weight(.bold).monospacedDigit())
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                if !ringing {
                    bigButton(ic.micMuted ? "🔇 আনমিউট" : "🎙️ মিউট",
                              tint: PortalOfficePalette.violet) { ic.toggleMute() }
                }
                bigButton(ringing ? "বাতিল" : "কল কাটুন",
                          tint: PortalOfficePalette.red500, filled: true) { ic.leave() }
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
                .scaleEffect(speaking && !UIAccessibility.isReduceMotionEnabled ? 1.06 : 1)
                .animation(UIAccessibility.isReduceMotionEnabled ? nil
                           : .easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: speaking)
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

// MARK: - Incoming call (full-screen, app-wide — presented by FloatingChatHead)

@available(iOS 17.0, *)
struct IncomingCallView: View {
    let incoming: AgoraIntercom.IncomingCall
    @Environment(\.dismiss) private var dismiss
    private let ic = AgoraIntercom.shared
    @State private var answered = false
    @State private var pulse = false

    private var inCall: Bool { ic.mode == .calling || ic.mode == .ringing }

    var body: some View {
        ZStack {
            LinearGradient(colors: [.black, PortalOfficePalette.violet.opacity(0.45)],
                           startPoint: .top, endPoint: .bottom).ignoresSafeArea()
            VStack(spacing: 20) {
                Spacer()
                officeAvatar(nil, initial: "M", size: 104)
                    .scaleEffect(pulse && !UIAccessibility.isReduceMotionEnabled ? 1.06 : 1)
                    .shadow(color: PortalOfficePalette.emerald600.opacity(0.5), radius: pulse ? 26 : 10)
                    .animation(UIAccessibility.isReduceMotionEnabled ? nil
                               : .easeInOut(duration: 0.7).repeatForever(autoreverses: true), value: pulse)
                Text(incoming.caller).font(.title.weight(.bold)).foregroundStyle(.white)
                Text(statusLine).font(.subheadline).foregroundStyle(.white.opacity(0.75))
                if ic.mode == .calling {
                    Text(timeStr(ic.callSeconds))
                        .font(.title3.weight(.bold).monospacedDigit()).foregroundStyle(.white)
                }
                Spacer()
                controls
                Spacer().frame(height: 34)
            }
            .padding(24)
        }
        .onAppear {
            pulse = true
            ic.markCallHandled(incoming.broadcastId)   // don't re-ring this one
            ic.ringIncoming()                          // loud incoming ring
        }
        .onChange(of: ic.mode) { _, m in
            if answered && m == .idle { dismiss() }    // call ended / hung up
        }
        .onDisappear { if !inCall { ic.stopRinging() } }
        .interactiveDismissDisabled(true)
    }

    private var statusLine: String {
        if ic.mode == .calling { return ic.remoteSpeaking ? "🔊 কথা হচ্ছে" : "কল চলছে" }
        if answered { return "সংযোগ হচ্ছে…" }
        return "📞 অফিস কল করছে…"
    }

    @ViewBuilder private var controls: some View {
        if ic.mode == .calling || (answered && ic.mode == .ringing) {
            HStack(spacing: 12) {
                circleBtn(ic.micMuted ? "mic.slash.fill" : "mic.fill",
                          tint: .white.opacity(0.18)) { ic.toggleMute() }
                circleBtn("phone.down.fill", tint: PortalOfficePalette.red500, big: true) {
                    ic.leave(); dismiss()
                }
            }
        } else {
            HStack(spacing: 60) {
                VStack(spacing: 8) {
                    circleBtn("phone.down.fill", tint: PortalOfficePalette.red500, big: true) {
                        ic.confirmCallReceipt(incoming.broadcastId)   // stop other devices' ring
                        ic.stopRinging(); ic.leave(); dismiss()
                    }
                    Text("প্রত্যাখ্যান").font(.caption).foregroundStyle(.white.opacity(0.8))
                }
                VStack(spacing: 8) {
                    circleBtn("phone.fill", tint: PortalOfficePalette.emerald600, big: true) {
                        answered = true
                        ic.confirmCallReceipt(incoming.broadcastId)   // owner log: ধরা হয়েছে
                        ic.stopRinging()
                        Task { await ic.startCall(channel: incoming.channel, outgoing: false) }
                    }
                    Text("গ্রহণ").font(.caption).foregroundStyle(.white.opacity(0.8))
                }
            }
        }
    }

    private func circleBtn(_ icon: String, tint: Color, big: Bool = false, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred(); action()
        } label: {
            Image(systemName: icon)
                .font(.system(size: big ? 28 : 22, weight: .semibold)).foregroundStyle(.white)
                .frame(width: big ? 72 : 58, height: big ? 72 : 58)
                .background(tint, in: Circle())
        }.buttonStyle(.plain)
    }

    private func timeStr(_ s: Int) -> String { String(format: "%02d:%02d", s / 60, s % 60) }
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
