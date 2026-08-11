//
//  IntercomUI.swift
//  ALMA ERP — Office Live Intercom UI (walkie-talkie + 1:1 call) on the AgoraIntercom engine.
//  Owner = broadcaster (open mic to all staff) + can ring one staff; staff = live listener that
//  can also answer an incoming ring. Presented from the floating chat head's long-press menu.
//

import SwiftUI
import AVFoundation

/// A narrow lease for a downloaded intercom voice note's app-owned audio
/// session. Cleanup restores the captured configuration only while every
/// category component still matches this player, so a newer owner is never
/// deactivated or overwritten.
private struct IntercomVoiceNoteAudioSessionLease {
    let previousCategory: AVAudioSession.Category
    let previousMode: AVAudioSession.Mode
    let previousOptions: AVAudioSession.CategoryOptions
    let ownedCategory: AVAudioSession.Category
    let ownedMode: AVAudioSession.Mode
    let ownedOptions: AVAudioSession.CategoryOptions

    static func capture(
        session: AVAudioSession,
        ownedCategory: AVAudioSession.Category,
        ownedMode: AVAudioSession.Mode,
        ownedOptions: AVAudioSession.CategoryOptions
    ) -> Self {
        Self(
            previousCategory: session.category,
            previousMode: session.mode,
            previousOptions: session.categoryOptions,
            ownedCategory: ownedCategory,
            ownedMode: ownedMode,
            ownedOptions: ownedOptions)
    }

    func releaseIfStillOwned(session: AVAudioSession) {
        guard session.category == ownedCategory,
              session.mode == ownedMode,
              session.categoryOptions == ownedOptions
        else { return }
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        try? session.setCategory(
            previousCategory,
            mode: previousMode,
            options: previousOptions)
    }
}

@available(iOS 17.0, *)
struct IntercomView: View {
    private enum VoiceNoteAudioPath: Equatable {
        case appOwnedIdle
        case officeListening
    }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var vm = PortalOfficeVM()
    private let ic = AgoraIntercom.shared
    @State private var voicePlayer: AVPlayer? = nil
    @State private var voicePlayerCompletionObserver: NSObjectProtocol? = nil
    @State private var voicePlayerFailureObserver: NSObjectProtocol? = nil
    @State private var voiceAudioSessionLease: IntercomVoiceNoteAudioSessionLease? = nil
    @State private var voiceAudioClaimToken: AlmaLiveVoiceNonCallAudioRegistry.Token? = nil
    @State private var voiceAudioClaimGeneration: UUID? = nil
    @State private var voicePlaybackGeneration = 0
    @State private var voicePlaybackViewIsActive = false
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
                        communicationKinds
                        if ic.hasActiveCall {
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
                        recentCalls
                    }
                    .padding(18)
                }
            }
            .navigationTitle("অফিস কল")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(ic.hasActiveCall ? "মিনিমাইজ" : "বন্ধ") {
                        if !ic.hasActiveCall { ic.leave() }
                        dismiss()
                    }
                }
            }
        }
        .task { await ic.loadFeed() }
        .onDisappear { if !ic.hasActiveCall { ic.leave() } }
    }

    private var communicationKinds: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("যোগাযোগের ধরন").font(.footnote.weight(.bold)).foregroundStyle(accent)
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                kind("phone.fill", "App voice call", "দুইজনের private live কথা")
                kind("phone.arrow.up.right.fill", "Mobile call", "SIM/phone network")
                kind("mic.fill", "Recorded PTT", "চেপে ধরে voice message")
                kind("dot.radiowaves.left.and.right", "Live walkie-talkie", "Office group live audio")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16).portalOfficeGlass(scheme, corner: 18)
    }

    private func kind(_ icon: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).foregroundStyle(accent).frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.caption.weight(.bold))
                Text(detail).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
        .padding(9).background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var recentCalls: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label("সাম্প্রতিক কল", systemImage: "clock.arrow.circlepath")
                .font(.footnote.weight(.bold)).foregroundStyle(accent)
            if ic.recentCalls.isEmpty {
                Text("এখনো কোনো call history নেই।").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(ic.recentCalls.prefix(8)) { call in
                    HStack(spacing: 10) {
                        Image(systemName: call.outgoingByMe ? "arrow.up.right" : "arrow.down.left")
                            .foregroundStyle(callTone(call)).frame(width: 28, height: 28)
                            .background(callTone(call).opacity(0.12), in: Circle())
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(call.callerName ?? (call.outgoingByMe ? "স্টাফ" : "বস — মারুফ"))
                                .font(.subheadline.weight(.semibold)).lineLimit(1)
                            Text(callMeta(call)).font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 6)
                        Text(callOutcome(call)).font(.caption2.weight(.bold)).foregroundStyle(callTone(call))
                    }
                    .frame(minHeight: 44)
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16).portalOfficeGlass(scheme, corner: 18)
    }

    private func callOutcome(_ call: IntercomRecentCall) -> String {
        if call.endedAt == nil {
            if call.canonicalState == "CONNECTED" { return "কল চলছে" }
            if call.canonicalState == "RECONNECTING" { return "পুনঃসংযোগ" }
            return call.outgoingByMe ? "আউটগোয়িং" : "ইনকামিং"
        }
        switch call.endedReason {
        case "completed": return "সম্পন্ন"
        case "declined": return "প্রত্যাখ্যাত"
        case "busy": return "ব্যস্ত"
        case "failed", "push_unreachable": return "ব্যর্থ"
        default: return call.outgoingByMe ? "ধরা হয়নি" : "মিসড"
        }
    }

    private func callTone(_ call: IntercomRecentCall) -> Color {
        let outcome = callOutcome(call)
        if outcome == "সম্পন্ন" || outcome == "কল চলছে" { return PortalOfficePalette.emerald600 }
        if outcome == "ব্যস্ত" || outcome == "ব্যর্থ" || outcome == "পুনঃসংযোগ" { return .orange }
        return PortalOfficePalette.red500
    }

    private func callMeta(_ call: IntercomRecentCall) -> String {
        let duration = call.callDurationSec.map { $0 < 60 ? "\($0) সেকেন্ড" : "\($0 / 60) মিনিট \($0 % 60) সেকেন্ড" }
        return [call.outgoingByMe ? "আউটগোয়িং" : "ইনকামিং", duration].compactMap { $0 }.joined(separator: " · ")
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
                        if !ic.recording, ic.pttPressBegan() {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        }
                    }
                    .onEnded { _ in
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        ic.pttPressEnded()
                    }
            )
            .accessibilityLabel(ic.recording ? "রেকর্ডিং চলছে, ছেড়ে দিলে পাঠাবে" : "চেপে ধরে voice message রেকর্ড করুন")
            .accessibilityAddTraits(.isButton)
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
            bigButton("📞 বসকে কল করুন", tint: PortalOfficePalette.emerald600, filled: true) {
                Task { await ic.staffCallOwner() }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(18).portalOfficeGlass(scheme, corner: 22)
        .onAppear {
            voicePlaybackGeneration &+= 1
            voicePlaybackViewIsActive = true
        }
        .onDisappear {
            voicePlaybackViewIsActive = false
            voicePlaybackGeneration &+= 1
            stopVoiceNotePlayback()
        }
        .onReceive(NotificationCenter.default.publisher(
            for: UIApplication.willResignActiveNotification)
        ) { _ in
            voicePlaybackViewIsActive = false
            voicePlaybackGeneration &+= 1
            stopVoiceNotePlayback()
        }
        .onReceive(NotificationCenter.default.publisher(
            for: UIApplication.didEnterBackgroundNotification)
        ) { _ in
            voicePlaybackViewIsActive = false
            voicePlaybackGeneration &+= 1
            stopVoiceNotePlayback()
        }
        .task {
            await ic.joinLive(asBroadcaster: false)
            // Incoming CALLS are handled app-wide by FloatingChatHead; here we only
            // auto-play new voice notes while this screen is open.
            while !Task.isCancelled {
                if !ic.hasActiveCall { await playPendingVoiceNotes() }
                try? await Task.sleep(nanoseconds: 2_500_000_000)
            }
        }
    }

    /// Auto-play any voice note the boss sent that I haven't heard yet (online or not).
    @MainActor
    private func playPendingVoiceNotes() async {
        guard voicePlaybackViewIsActive, voicePlayer == nil else { return }
        let generation = voicePlaybackGeneration
        let pending = await ic.pendingVoiceNotes()
        guard !Task.isCancelled,
              voicePlaybackViewIsActive,
              generation == voicePlaybackGeneration,
              voicePlayer == nil
        else { return }

        for v in pending where !playedVoiceIds.contains(v.id) {
            guard let url = URL(string: v.url) else { continue }
            guard let audioPath = admittedVoiceNoteAudioPath() else { return }

            guard !Task.isCancelled,
                  voicePlaybackViewIsActive,
                  generation == voicePlaybackGeneration,
                  voicePlayer == nil
            else { return }

            // Defensive replacement cleanup also removes any observer/lease a
            // failed prior attempt may have left behind.
            stopVoiceNotePlayback(mode: audioPath == .officeListening
                ? .relinquishAfterActivatedSystemTakeover
                : .restoreBeforeNextAppMutation)
            guard admittedVoiceNoteAudioPath() == audioPath else { return }

            let claimGeneration = UUID()
            let stopForTakeover: AlmaLiveVoiceNonCallAudioRegistry.StopHandler = { mode in
                stopVoiceNotePlaybackForAudioTakeover(
                    claimGeneration: claimGeneration,
                    mode: mode)
            }
            let claimToken: AlmaLiveVoiceNonCallAudioRegistry.Token
            switch audioPath {
            case .officeListening:
                // The Office listener already owns the live Agora audio session.
                // Register the note directly only when the non-call registry is
                // empty; claiming through the relay would reject the intentional
                // Office listener, while replacing another entry could restore a
                // stale session over Agora.
                guard !AlmaLiveVoiceNonCallAudioRegistry.shared.isBusy,
                      admittedVoiceNoteAudioPath() == .officeListening
                else { return }
                claimToken = AlmaLiveVoiceNonCallAudioRegistry.shared.claim(
                    .intercomVoiceNote,
                    stop: stopForTakeover)
                // The live listener already owns an active
                // playAndRecord/voiceChat session. AVPlayer can render through
                // that session; taking a nested playback lease would deactivate
                // Agora when the note ends.
                voiceAudioSessionLease = nil

            case .appOwnedIdle:
                // This is the final suspension-free admission point. The relay
                // stops/restores an older app owner and rechecks every call owner
                // before returning the exact registry token for this note.
                guard let token = AlmaLiveVoicePreviewTakeoverRelay.shared
                    .claimNonCallAudio(.intercomVoiceNote, stop: stopForTakeover)
                else { return }
                claimToken = token
            }
            voiceAudioClaimToken = claimToken
            voiceAudioClaimGeneration = claimGeneration

            guard admittedVoiceNoteAudioPath() == audioPath,
                  voiceAudioClaimToken == claimToken,
                  voiceAudioClaimGeneration == claimGeneration
            else {
                stopVoiceNotePlayback(
                    claimGeneration: claimGeneration,
                    mode: .relinquishAfterActivatedSystemTakeover)
                return
            }

            if audioPath == .appOwnedIdle {
                let session = AVAudioSession.sharedInstance()
                let ownedCategory: AVAudioSession.Category = .playback
                let ownedMode: AVAudioSession.Mode = .default
                let ownedOptions: AVAudioSession.CategoryOptions = []
                let lease = IntercomVoiceNoteAudioSessionLease.capture(
                    session: session,
                    ownedCategory: ownedCategory,
                    ownedMode: ownedMode,
                    ownedOptions: ownedOptions)
                voiceAudioSessionLease = lease
                do {
                    try session.setCategory(
                        ownedCategory,
                        mode: ownedMode,
                        options: ownedOptions)
                    try session.setActive(true)
                } catch {
                    stopVoiceNotePlayback(
                        claimGeneration: claimGeneration,
                        mode: .restoreBeforeNextAppMutation)
                    return
                }
            }

            guard !Task.isCancelled,
                  voicePlaybackViewIsActive,
                  generation == voicePlaybackGeneration,
                  admittedVoiceNoteAudioPath() == audioPath,
                  voiceAudioClaimToken == claimToken,
                  voiceAudioClaimGeneration == claimGeneration
            else {
                stopVoiceNotePlayback(
                    claimGeneration: claimGeneration,
                    mode: admittedVoiceNoteAudioPath() == audioPath
                        ? .restoreBeforeNextAppMutation
                        : .relinquishAfterActivatedSystemTakeover)
                return
            }

            let item = AVPlayerItem(url: url)
            let p = AVPlayer(playerItem: item)
            voicePlayer = p
            installVoiceNoteObservers(for: p, item: item, generation: generation)

            // Player construction/observer installation is synchronous, but a
            // CallKit reservation can arrive on its own queue. Recheck every
            // owner plus this exact view/player/token immediately before play.
            guard !Task.isCancelled,
                  voicePlaybackViewIsActive,
                  generation == voicePlaybackGeneration,
                  voicePlayer === p,
                  admittedVoiceNoteAudioPath() == audioPath,
                  voiceAudioClaimToken == claimToken,
                  voiceAudioClaimGeneration == claimGeneration
            else {
                stopVoiceNotePlayback(
                    claimGeneration: claimGeneration,
                    mode: admittedVoiceNoteAudioPath() == audioPath
                        ? .restoreBeforeNextAppMutation
                        : .relinquishAfterActivatedSystemTakeover)
                return
            }
            p.play()

            guard await waitForVoiceNotePlaybackStart(
                    p,
                    generation: generation,
                    audioPath: audioPath,
                    claimToken: claimToken,
                    claimGeneration: claimGeneration),
                  !Task.isCancelled,
                  voicePlaybackViewIsActive,
                  generation == voicePlaybackGeneration,
                  voicePlayer === p,
                  admittedVoiceNoteAudioPath() == audioPath,
                  voiceAudioClaimToken == claimToken,
                  voiceAudioClaimGeneration == claimGeneration
            else {
                stopVoiceNotePlayback(
                    claimGeneration: claimGeneration,
                    mode: admittedVoiceNoteAudioPath() == audioPath
                        ? .restoreBeforeNextAppMutation
                        : .relinquishAfterActivatedSystemTakeover)
                return
            }

            // A receipt is advanced only after AVPlayer is actually playing and
            // this view generation still owns that exact player.
            playedVoiceIds.insert(v.id)
            await ic.markVoicePlayed(v.id)
            break   // one at a time — the next poll picks up the rest
        }
    }

    @MainActor
    private func waitForVoiceNotePlaybackStart(
        _ player: AVPlayer,
        generation: Int,
        audioPath: VoiceNoteAudioPath,
        claimToken: AlmaLiveVoiceNonCallAudioRegistry.Token,
        claimGeneration: UUID
    ) async -> Bool {
        // Remote items may spend a short period buffering. A bounded wait keeps
        // an unreachable item from owning the audio session indefinitely.
        for _ in 0..<100 {
            guard !Task.isCancelled,
                  voicePlaybackViewIsActive,
                  generation == voicePlaybackGeneration,
                  voicePlayer === player,
                  admittedVoiceNoteAudioPath() == audioPath,
                  voiceAudioClaimToken == claimToken,
                  voiceAudioClaimGeneration == claimGeneration
            else { return false }
            if player.error != nil || player.currentItem?.status == .failed { return false }
            if player.timeControlStatus == .playing { return true }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return false
    }

    @MainActor
    private func installVoiceNoteObservers(
        for player: AVPlayer,
        item: AVPlayerItem,
        generation: Int
    ) {
        removeVoiceNoteObservers()
        let center = NotificationCenter.default
        voicePlayerCompletionObserver = center.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification,
            object: item,
            queue: .main
        ) { [weak player] _ in
            MainActor.assumeIsolated {
                guard let player else { return }
                finishVoiceNotePlayback(player, generation: generation)
            }
        }
        voicePlayerFailureObserver = center.addObserver(
            forName: AVPlayerItem.failedToPlayToEndTimeNotification,
            object: item,
            queue: .main
        ) { [weak player] _ in
            MainActor.assumeIsolated {
                guard let player else { return }
                finishVoiceNotePlayback(player, generation: generation)
            }
        }
    }

    @MainActor
    private func finishVoiceNotePlayback(_ player: AVPlayer, generation: Int) {
        guard generation == voicePlaybackGeneration, voicePlayer === player else { return }
        stopVoiceNotePlayback()
    }

    @MainActor
    private func stopVoiceNotePlaybackForAudioTakeover(
        claimGeneration: UUID,
        mode: AlmaLiveVoiceNonCallAudioRegistry.StopMode
    ) {
        guard voiceAudioClaimGeneration == claimGeneration,
              voiceAudioClaimToken != nil
        else { return }
        // Invalidate the in-flight poll before touching its exact player. Any
        // post-await continuation from that poll is now permanently stale.
        voicePlaybackGeneration &+= 1
        stopVoiceNotePlayback(claimGeneration: claimGeneration, mode: mode)
    }

    @MainActor
    private func stopVoiceNotePlayback(
        claimGeneration expectedClaimGeneration: UUID? = nil,
        mode: AlmaLiveVoiceNonCallAudioRegistry.StopMode = .restoreBeforeNextAppMutation
    ) {
        if let expectedClaimGeneration {
            guard voiceAudioClaimGeneration == expectedClaimGeneration else { return }
        }
        removeVoiceNoteObservers()
        voicePlayer?.pause()
        voicePlayer?.replaceCurrentItem(with: nil)
        voicePlayer = nil
        let claimToken = voiceAudioClaimToken
        let lease = voiceAudioSessionLease
        voiceAudioClaimToken = nil
        voiceAudioClaimGeneration = nil
        voiceAudioSessionLease = nil
        if mode == .restoreBeforeNextAppMutation {
            lease?.releaseIfStillOwned(session: .sharedInstance())
        }
        if let claimToken {
            AlmaLiveVoiceNonCallAudioRegistry.shared.release(claimToken)
        }
    }

    @MainActor
    private func admittedVoiceNoteAudioPath() -> VoiceNoteAudioPath? {
        guard !CallKitVoIP.shared.hasPendingOrActiveCall,
              !AgentCallController.shared.isActive,
              !(AlmaCallBarBridge.shared.engine?.isCallRunning ?? false),
              !ic.isPTTActiveOrStarting,
              !ic.audioTeardownPending
        else { return nil }
        switch ic.mode {
        case .idle:
            return .appOwnedIdle
        case .listening:
            return .officeListening
        case .broadcasting, .calling, .ringing, .reconnecting:
            return nil
        }
    }

    @MainActor
    private func removeVoiceNoteObservers() {
        let center = NotificationCenter.default
        if let observer = voicePlayerCompletionObserver {
            center.removeObserver(observer)
            voicePlayerCompletionObserver = nil
        }
        if let observer = voicePlayerFailureObserver {
            center.removeObserver(observer)
            voicePlayerFailureObserver = nil
        }
    }

    // ── Active call bar (both sides) — ringing until the other side joins ──
    private var callBar: some View {
        let ringing = ic.mode == .ringing
        let reconnecting = ic.mode == .reconnecting
        return VStack(spacing: 14) {
            // While ringing, keep the orb pulsing so it clearly reads as "not connected yet".
            liveOrb(active: true, speaking: ringing || ic.remoteSpeaking)
            Text(reconnecting ? "পুনঃসংযোগ হচ্ছে…" :
                 (ringing ? "📞 রিং হচ্ছে…" : (ic.remoteSpeaking ? "🔊 কথা হচ্ছে" : "📞 কল চলছে")))
                .font(.title3.weight(.bold))
            // No timer until connected — WhatsApp-style.
            Text(reconnecting ? "আরও \(ic.reconnectSeconds) সেকেন্ড চেষ্টা হবে" :
                 (ringing ? "অপর পক্ষ ধরার অপেক্ষায়…" : timeStr(ic.callSeconds)))
                .font(ringing ? .subheadline : .title2.weight(.bold).monospacedDigit())
                .foregroundStyle(.secondary)
            if !ringing {
                Text(ic.audioRoute).font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                if !ringing {
                    bigButton(ic.micMuted ? "🔇 আনমিউট" : "🎙️ মিউট",
                              tint: PortalOfficePalette.violet) { ic.toggleMute() }
                    bigButton(ic.speakerEnabled ? "🔈 ইয়ারপিস" : "🔊 স্পিকার",
                              tint: PortalOfficePalette.coral) { ic.toggleSpeaker() }
                }
                bigButton(ringing ? "বাতিল" : "কল কাটুন",
                          tint: PortalOfficePalette.red500, filled: true) {
                    Task { await ic.endActiveCall() }
                }
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
        VStack(alignment: .leading, spacing: 8) {
            Label(msg, systemImage: "exclamationmark.triangle.fill")
            if msg.localizedCaseInsensitiveContains("microphone") || msg.contains("মাইক্রোফোন") {
                Button("Settings খুলুন") {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    UIApplication.shared.open(url)
                }
                .font(.footnote.weight(.bold))
                .frame(minHeight: 44)
            }
        }
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

    private var inCall: Bool { ic.hasActiveCall }

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
        if ic.mode == .reconnecting { return "পুনঃসংযোগ হচ্ছে…" }
        if answered { return "সংযোগ হচ্ছে…" }
        return "📞 অফিস কল করছে…"
    }

    @ViewBuilder private var controls: some View {
        if ic.mode == .calling || (answered && ic.mode == .ringing) {
            HStack(spacing: 12) {
                circleBtn(ic.micMuted ? "mic.slash.fill" : "mic.fill",
                          tint: .white.opacity(0.18), accessibilityLabel: ic.micMuted ? "আনমিউট" : "মিউট") { ic.toggleMute() }
                circleBtn("phone.down.fill", tint: PortalOfficePalette.red500, big: true, accessibilityLabel: "কল শেষ করুন") {
                    Task { await ic.endActiveCall(); dismiss() }
                }
            }
        } else {
            HStack(spacing: 60) {
                VStack(spacing: 8) {
                    circleBtn("phone.down.fill", tint: PortalOfficePalette.red500, big: true, accessibilityLabel: "কল প্রত্যাখ্যান করুন") {
                        ic.confirmCallReceipt(incoming.broadcastId)   // legacy answer/history acknowledgement
                        ic.stopRinging()
                        Task { await ic.endActiveCall(reason: "DECLINED"); dismiss() }
                    }
                    Text("প্রত্যাখ্যান").font(.caption).foregroundStyle(.white.opacity(0.8))
                }
                VStack(spacing: 8) {
                    circleBtn("phone.fill", tint: PortalOfficePalette.emerald600, big: true, accessibilityLabel: "কল গ্রহণ করুন") {
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

    private func circleBtn(_ icon: String, tint: Color, big: Bool = false, accessibilityLabel: String, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred(); action()
        } label: {
            Image(systemName: icon)
                .font(.system(size: big ? 28 : 22, weight: .semibold)).foregroundStyle(.white)
                .frame(width: big ? 72 : 58, height: big ? 72 : 58)
                .background(tint, in: Circle())
        }.buttonStyle(.plain).accessibilityLabel(accessibilityLabel)
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
