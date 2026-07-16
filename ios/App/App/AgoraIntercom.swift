//
//  AgoraIntercom.swift
//  ALMA ERP — Office Live Intercom (native port of the web useAgoraIntercom / useAgoraCall).
//
//  One shared Agora RTC channel per business (itc_live_<businessId>): the owner joins as a
//  broadcaster and speaks live; every staff phone on the intercom screen joins as a listener
//  and hears it instantly (auto-routed to the loudspeaker). A 1:1 call reuses the same engine
//  on a per-pair channel. Tokens are minted by the SAME server route the web uses
//  (POST /api/assistant/office/intercom/call-token → { appId, token, uid }), so the app never
//  needs the Agora app-id baked in.
//
//  Audio only — no video track is ever created. The manager never throws to the UI; failures
//  land in `error`. Teardown is idempotent so we never leak a hot mic.
//

import Foundation
import AVFoundation
import AgoraRtcKit

// MARK: - Server contracts

/// POST /api/assistant/office/intercom/call-token → { appId, channel?, token, uid }
private struct IntercomTokenResp: Decodable {
    let appId: String
    let token: String
    let uid: UInt
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        appId = try c.decode(String.self, forKey: .appId)
        token = try c.decode(String.self, forKey: .token)
        uid = (try? c.decodeIfPresent(UInt.self, forKey: .uid)) ?? 0
    }
    enum CodingKeys: String, CodingKey { case appId, token, uid }
}

struct IntercomStaff: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let phone: String?
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "স্টাফ"
        phone = try? c.decodeIfPresent(String.self, forKey: .phone)
    }
    enum CodingKeys: String, CodingKey { case id, name, phone }
}

/// GET /api/assistant/office/intercom → we only need the shared live channel + roster.
struct IntercomFeedLite: Decodable {
    let liveChannel: String
    let staff: [IntercomStaff]
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        liveChannel = (try? c.decodeIfPresent(String.self, forKey: .liveChannel)) ?? ""
        staff = (try? c.decodeIfPresent([IntercomStaff].self, forKey: .staff)) ?? []
    }
    enum CodingKeys: String, CodingKey { case liveChannel, staff }
}

// MARK: - Manager

@available(iOS 17.0, *)
@Observable
final class AgoraIntercom: NSObject {
    static let shared = AgoraIntercom()

    /// `ringing` = a 1:1 call is placed/answered but the other party hasn't joined yet
    /// (WhatsApp-style — no call timer until both are actually on the channel).
    enum Mode: Equatable { case idle, listening, broadcasting, calling, ringing }

    var mode: Mode = .idle
    var connected = false
    var remoteSpeaking = false        // someone else is publishing audio right now
    var localSpeaking = false         // WE are publishing voice right now (live orb animation)
    var micMuted = false
    /// When a call is answered through CallKit (VoIP push), CallKit OWNS the audio
    /// session: it activates/deactivates it and Agora must not fight that. Set by
    /// CallKitVoIP around startCall/leave. Off = the in-app path manages the session.
    var callKitManaged = false
    var callSeconds = 0
    var statusText = ""
    var error: String? = nil
    var roster: [IntercomStaff] = []
    var recording = false             // PTT voice-note is capturing right now
    var callPeer = "স্টাফ"            // who we're talking to (shown on the call screen)

    // IOSP-4 crash fix: `engine`'s type lives in the dynamically-linked
    // AgoraRtcKit.framework. On an @Observable class, a stored property is read
    // through generated keypath machinery — and the Swift runtime cannot demangle
    // `AgoraRtcEngineKit?`'s keypath from that framework, so any tracked read
    // (e.g. CallKitVoIP.providerDidReset → leave() reading `engine`) SIGTRAPs at
    // launch when a stale CallKit reset fires (see docs/proofs/iosp0/launch-crash-
    // diagnosis.md). These are private implementation handles that never drive the
    // UI, so exclude them from Observation — no keypath codegen, no crash.
    @ObservationIgnored private var engine: AgoraRtcEngineKit?
    @ObservationIgnored private var appId: String?
    @ObservationIgnored private var channel: String?
    @ObservationIgnored private var callTimer: Timer?
    @ObservationIgnored private var ringTimer: Timer?
    @ObservationIgnored private var remoteUids = Set<UInt>()   // remote parties currently on the call channel
    private let ringtone = IntercomRingtone()   // ringback (caller) + incoming ring (callee)
    @ObservationIgnored private var handledCallIds = Set<String>()  // call broadcasts we've already surfaced
    // PTT persistent voice-note capture (separate from the ephemeral live channel).
    private var recorder: AVAudioRecorder?
    private var recordURL: URL?
    private var recordStart: Date?

    // ── Public API ──────────────────────────────────────────────────────────

    /// Load the shared live channel + staff roster (owner UI uses the roster for calls).
    @MainActor
    func loadFeed() async {
        do {
            let feed: IntercomFeedLite = try await AlmaAPI.shared.get("/api/assistant/office/intercom")
            roster = feed.staff
        } catch {
            // A missing feed shouldn't block joining — the channel is deterministic below.
        }
    }

    /// Join the shared walkie-talkie channel. Owner → broadcaster (open mic), staff → listener.
    @MainActor
    func joinLive(asBroadcaster: Bool) async {
        error = nil
        statusText = "সংযোগ হচ্ছে…"
        do {
            if asBroadcaster { try await ensureMicPermission() }
            let ch = try await resolveLiveChannel()
            try await join(channel: ch, publishMic: asBroadcaster)
            mode = asBroadcaster ? .broadcasting : .listening
            micMuted = false
            statusText = asBroadcaster ? "লাইভ — আপনি বলছেন" : "লাইভ — শুনছেন"
        } catch {
            self.error = message(for: error)
            statusText = ""
            leave()
        }
    }

    /// Start / answer a 1:1 call on a per-pair channel. Both sides join the same name.
    /// `outgoing` = we placed the call (ring until the other side joins); a call NEVER
    /// starts its timer here — the timer starts in `didJoinedOfUid` when a remote appears,
    /// exactly like WhatsApp/Messenger. `mode` is set to `.ringing` BEFORE joining so the
    /// join-completion delegate can flip us to `.calling` without a race.
    @MainActor
    func startCall(channel ch: String, outgoing: Bool) async {
        error = nil
        mode = .ringing
        remoteUids.removeAll()
        callSeconds = 0
        statusText = outgoing ? "রিং হচ্ছে…" : "কল ধরছেন…"
        ringtone.stop()                          // any incoming ring stops the moment we act
        do {
            try await ensureMicPermission()
            try await join(channel: ch, publishMic: true)
            micMuted = false
            if outgoing {
                startRingTimeout()               // "কেউ ধরেনি" if unanswered
                ringtone.play(.ringback)         // caller hears the soft ring-back tone
            }
        } catch {
            self.error = message(for: error)
            statusText = ""
            leave()
        }
    }

    /// Owner rings ONE staff: create a call broadcast (pushes the staff) then join itc_<id>.
    /// We RING (no timer) until the staff actually joins the channel.
    @MainActor
    func ownerCall(staffId: String) async {
        error = nil
        statusText = "কল দিচ্ছি…"
        struct Body: Encodable { let kind = "call"; let targetStaffId: String }
        struct Resp: Decodable { let id: String? }
        callPeer = roster.first { $0.id == staffId }?.name ?? "স্টাফ"
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/intercom", body: Body(targetStaffId: staffId))
            guard let id = r.id, !id.isEmpty else { throw IntercomError.callFailed }
            await startCall(channel: "itc_\(id)", outgoing: true)
        } catch {
            self.error = message(for: error)
            statusText = ""
        }
    }

    func toggleMute() {
        micMuted.toggle()
        engine?.muteLocalAudioStream(micMuted)
    }

    /// Set mute explicitly (CallKit's mute button routes here so the two UIs agree).
    @MainActor func setMuted(_ muted: Bool) {
        micMuted = muted
        engine?.muteLocalAudioStream(muted)
    }

    /// CallKit finished activating the shared audio session — make sure Agora routes
    /// call audio to the loud speaker (CallKit already owns activation/teardown).
    @MainActor func audioSessionActivated() {
        engine?.setEnableSpeakerphone(true)
    }

    @MainActor
    func leave() {
        engine?.leaveChannel(nil)
        stopCallTimer()
        stopRingTimeout()
        ringtone.stop()
        mode = .idle
        connected = false
        remoteSpeaking = false
        localSpeaking = false
        remoteUids.removeAll()
        channel = nil
        statusText = ""          // never leave a stale "রিং হচ্ছে…" behind the owner view
    }

    // ── App-wide incoming call (staff) ────────────────────────────────────────
    struct IncomingCall: Equatable { let broadcastId: String; let channel: String; let caller: String }

    /// How long a placed call keeps "ringing" before it's a missed call. MUST match
    /// the web side (intercom.tsx CALL_RING_MS) so a call rings for the same window
    /// on every device — a shorter native window was why native missed cross-device calls.
    static let ringWindow: TimeInterval = 60

    /// The freshest still-ringing call addressed to me that I haven't surfaced yet.
    /// FloatingChatHead polls this app-wide so a call rings on ANY screen.
    func pendingIncomingCall() async -> IncomingCall? {
        struct Mine: Decodable { let confirmedAt: String? }
        struct B: Decodable {
            let id: String; let kind: String; let createdAt: String; let mine: Mine?
            // Server-computed: this call rings ME (owner OR staff) and I didn't place it.
            let incomingForMe: Bool?
            let endedAt: String?
            let callerName: String?
        }
        struct Feed: Decodable { let broadcasts: [B]; let serverNow: String? }
        guard mode == .idle || mode == .listening,
              let feed: Feed = try? await AlmaAPI.shared.get("/api/assistant/office/intercom")
        else { return nil }
        // Server-anchored "now": a phone with a wrong clock used to never ring
        // because freshness was measured against the device clock. Mirror the web,
        // which offsets by (serverNow − deviceNow) before the freshness check.
        let skew: TimeInterval = feed.serverNow.flatMap(Self.parseISO)?.timeIntervalSinceNow ?? 0
        let nowServer = Date().addingTimeInterval(skew)
        // Newest first — ring only the most recent live call. `incomingForMe` is
        // bidirectional (owner rings for a staff→owner call too) and is false for a
        // call I placed, so I never ring myself. `endedAt` set = the caller cancelled
        // / it was answered elsewhere → don't ring. Falls back to the staff `mine`
        // receipt for older server builds that don't send incomingForMe yet.
        for b in feed.broadcasts.reversed() where b.kind == "call" {
            let forMe = b.incomingForMe ?? (b.mine != nil)
            guard forMe, b.endedAt == nil, !handledCallIds.contains(b.id), b.mine?.confirmedAt == nil else { continue }
            if let t = Self.parseISO(b.createdAt), nowServer.timeIntervalSince(t) < Self.ringWindow {
                return IncomingCall(broadcastId: b.id, channel: "itc_\(b.id)", caller: b.callerName ?? "বস — মারুফ")
            }
        }
        return nil
    }

    /// Mark a call surfaced (answered or declined) so we don't re-ring it every poll.
    @MainActor func markCallHandled(_ broadcastId: String) { handledCallIds.insert(broadcastId) }

    /// Confirm the call receipt server-side (stops the ring on the staff's OTHER
    /// devices — the web office rings the same call — and flips the owner's chat
    /// log line from "মিসড কল" to "ধরা হয়েছে"). Fire-and-forget.
    func confirmCallReceipt(_ broadcastId: String) {
        struct Body: Encodable { let broadcastId: String; let action = "confirmed" }
        struct Ok: Decodable { let ok: Bool? }
        Task {
            let _: Ok? = try? await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/intercom/receipt", body: Body(broadcastId: broadcastId))
        }
    }

    /// Server timestamps come from Prisma's toISOString() — always fractional
    /// seconds, which the bare ISO8601DateFormatter rejects. Parse both forms.
    /// (This is why incoming calls used to never ring: every date failed to parse.)
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()
    private static func parseISO(_ s: String) -> Date? {
        isoFractional.date(from: s) ?? isoPlain.date(from: s)
    }

    /// Start the loud incoming ring (callee side). Stopped by answering/declining/leave.
    @MainActor func ringIncoming() { ringtone.play(.incoming) }
    @MainActor func stopRinging() { ringtone.stop() }

    // ── PTT persistent voice-note (walkie-talkie that actually reaches staff) ──
    //
    // The old native walkie-talkie was live-Agora-ONLY: staff heard nothing unless they
    // happened to be on the intercom screen, and nothing landed in the group. The web
    // instead records the press, uploads it, and it shows as a voice message the staff
    // poll + auto-play (online or not). This mirrors that: press → record → upload.

    /// Begin recording the owner's press-and-hold voice note.
    @MainActor
    func pttStart() async {
        error = nil
        do {
            try await ensureMicPermission()
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try s.setActive(true)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("itc-\(UUID().uuidString).m4a")
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ]
            let rec = try AVAudioRecorder(url: url, settings: settings)
            guard rec.record() else { throw IntercomError.callFailed }
            recorder = rec
            recordURL = url
            recordStart = Date()
            recording = true
            localSpeaking = true
            statusText = "🔴 রেকর্ড হচ্ছে — বলুন"
        } catch {
            self.error = message(for: error)
            recording = false
        }
    }

    /// Stop the press, upload the clip as a group voice message. `minSec` guards taps.
    @MainActor
    func pttStop() async {
        guard recording, let rec = recorder, let url = recordURL else {
            recording = false; localSpeaking = false; return
        }
        rec.stop()
        recorder = nil
        recording = false
        localSpeaking = false
        let dur = max(1, Int((recordStart.map { Date().timeIntervalSince($0) } ?? 1).rounded()))
        recordURL = nil
        recordStart = nil
        // Too-short taps are noise, not messages.
        if dur < 1 { try? FileManager.default.removeItem(at: url); statusText = ""; return }
        statusText = "পাঠানো হচ্ছে…"
        do {
            guard let data = try? Data(contentsOf: url), !data.isEmpty else {
                throw IntercomError.callFailed
            }
            struct SendResp: Decodable { let ok: Bool?; let id: String? }
            let _: SendResp = try await AlmaAPI.shared.uploadMultipart(
                "/api/assistant/office/intercom",
                fileField: "audio", filename: "voice.m4a", mime: "audio/mp4", data: data,
                fields: ["durationSec": String(dur), "targetStaffId": ""])
            statusText = "✅ স্টাফদের কাছে পাঠানো হয়েছে"
        } catch {
            self.error = message(for: error)
            statusText = ""
        }
        try? FileManager.default.removeItem(at: url)
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private func resolveLiveChannel() async throws -> String {
        let feed: IntercomFeedLite = try await AlmaAPI.shared.get("/api/assistant/office/intercom")
        await MainActor.run { self.roster = feed.staff }
        if !feed.liveChannel.isEmpty { return feed.liveChannel }
        // Deterministic fallback (matches liveIntercomChannel on the server).
        return "itc_live_ALMA_LIFESTYLE"
    }

    private func token(for channel: String) async throws -> IntercomTokenResp {
        struct Body: Encodable { let channel: String }
        return try await AlmaAPI.shared.send("POST", "/api/assistant/office/intercom/call-token",
                                             body: Body(channel: channel))
    }

    @MainActor
    private func join(channel ch: String, publishMic: Bool) async throws {
        let tok = try await token(for: ch)
        try configureAudioSession()
        let e = engineFor(appId: tok.appId)
        // Under CallKit, don't let Agora deactivate the shared session on leave — CallKit
        // owns the session lifecycle and would otherwise get its audio killed under it.
        if callKitManaged { e.setAudioSessionOperationRestriction(.deactivateSession) }
        // Agora is single-channel per engine: if we were live-listening, leave that
        // channel before joining the call channel (otherwise joinChannel errors -17).
        if let prev = channel, prev != ch { e.leaveChannel(nil) }
        channel = ch
        e.setChannelProfile(.communication)
        e.enableAudio()
        e.setEnableSpeakerphone(true)                 // loud output — the walkie-talkie "blare"
        e.muteLocalAudioStream(!publishMic)           // listeners don't publish
        e.joinChannel(byToken: tok.token, channelId: ch, info: nil, uid: tok.uid, joinSuccess: nil)
    }

    private func engineFor(appId newId: String) -> AgoraRtcEngineKit {
        if let e = engine, appId == newId { return e }
        engine?.leaveChannel(nil)
        AgoraRtcEngineKit.destroy()
        let cfg = AgoraRtcEngineConfig()
        cfg.appId = newId
        let e = AgoraRtcEngineKit.sharedEngine(with: cfg, delegate: self)
        e.setChannelProfile(.communication)
        e.enableAudio()
        // HD voice — 48 kHz mono, high bitrate. Matches the web side's
        // `high_quality` mic track so both directions sound WhatsApp-clear.
        e.setAudioProfile(.musicHighQuality)
        e.enableAudioVolumeIndication(350, smooth: 3, reportVad: true)
        engine = e
        appId = newId
        return e
    }

    private func configureAudioSession() throws {
        let s = AVAudioSession.sharedInstance()
        try s.setCategory(.playAndRecord, mode: .voiceChat,
                          options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
        // Under CallKit, the framework activates the session in `didActivate` — us
        // calling setActive(true) here races/​fights it, so skip when CallKit-managed.
        if !callKitManaged {
            try s.setActive(true)
        }
    }

    private func ensureMicPermission() async throws {
        let granted = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            AVAudioApplication.requestRecordPermission { ok in cont.resume(returning: ok) }
        }
        if !granted { throw IntercomError.micDenied }
    }

    private func startCallTimer() {
        stopCallTimer()
        callSeconds = 0
        callTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.callSeconds += 1 }
        }
    }
    private func stopCallTimer() { callTimer?.invalidate(); callTimer = nil; callSeconds = 0 }

    /// While ringing, give up after the ring window if nobody answers (matches web).
    private func startRingTimeout() {
        stopRingTimeout()
        ringTimer = Timer.scheduledTimer(withTimeInterval: Self.ringWindow, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.mode == .ringing else { return }
                self.error = "কেউ কল ধরেনি"
                self.leave()
                // Clear the notice after a few seconds so it doesn't read as a live error.
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if self.error == "কেউ কল ধরেনি" { self.error = nil }
            }
        }
    }
    private func stopRingTimeout() { ringTimer?.invalidate(); ringTimer = nil }

    /// Staff poll: any voice broadcast addressed to me that I haven't played yet →
    /// its (id, audioUrl). The staff UI plays it and marks the receipt.
    struct PendingVoice { let id: String; let url: String }
    func pendingVoiceNotes() async -> [PendingVoice] {
        struct Bc: Decodable {
            let id: String; let kind: String; let audioUrl: String?
            struct Mine: Decodable { let playedAt: String? }
            let mine: Mine?
        }
        struct Feed: Decodable { let broadcasts: [Bc] }
        guard let feed: Feed = try? await AlmaAPI.shared.get("/api/assistant/office/intercom") else { return [] }
        return feed.broadcasts.compactMap { b in
            guard b.kind == "voice", b.mine?.playedAt == nil,
                  let u = b.audioUrl, !u.isEmpty else { return nil }
            return PendingVoice(id: b.id, url: u)
        }
    }

    /// Advance my receipt after auto-playing a voice note.
    func markVoicePlayed(_ broadcastId: String) async {
        struct Body: Encodable { let broadcastId: String; let action = "played" }
        struct Ok: Decodable { let ok: Bool? }
        let _: Ok? = try? await AlmaAPI.shared.send(
            "POST", "/api/assistant/office/intercom/receipt", body: Body(broadcastId: broadcastId))
    }

    private func message(for error: Error) -> String {
        if case IntercomError.micDenied = error {
            return "মাইক্রোফোন অনুমতি দিন — সেটিংস → ALMA ERP → মাইক্রোফোন।"
        }
        if let apiErr = error as? AlmaAPIError { return apiErr.errorDescription ?? "সংযোগ ব্যর্থ" }
        let raw = error.localizedDescription
        if raw.contains("agora_unconfigured") { return "Agora কনফিগার করা নেই (সার্ভার কী দরকার)।" }
        return raw
    }

    enum IntercomError: Error { case micDenied, callFailed }
}

// MARK: - Agora delegate

@available(iOS 17.0, *)
extension AgoraIntercom: AgoraRtcEngineDelegate {
    func rtcEngine(_ engine: AgoraRtcEngineKit, didJoinChannel channel: String, withUid uid: UInt, elapsed: Int) {
        Task { @MainActor in self.connected = true }
    }

    /// A REMOTE party joined the channel. For a 1:1 call this is "the other side answered" —
    /// the ONLY moment the WhatsApp-style call timer is allowed to start.
    func rtcEngine(_ engine: AgoraRtcEngineKit, didJoinedOfUid uid: UInt, elapsed: Int) {
        Task { @MainActor in
            self.remoteUids.insert(uid)
            if self.mode == .ringing {
                self.mode = .calling
                self.statusText = "কল চলছে"
                self.stopRingTimeout()
                self.ringtone.stop()          // both sides connected — silence the ring
                self.startCallTimer()
            }
        }
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, reportAudioVolumeIndicationOfSpeakers speakers: [AgoraRtcAudioVolumeInfo], totalVolume: Int) {
        // uid 0 == the local user; a remote speaker with voice-activity means "someone's talking".
        let remote = speakers.contains { $0.uid != 0 && ($0.vad == 1 || $0.volume > 8) }
        let local = speakers.contains { $0.uid == 0 && $0.volume > 12 }
        Task { @MainActor in
            if self.remoteSpeaking != remote { self.remoteSpeaking = remote }
            if self.localSpeaking != local { self.localSpeaking = local }
        }
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, remoteAudioStateChangedOfUid uid: UInt, state: AgoraAudioRemoteState, reason: AgoraAudioRemoteReason, elapsed: Int) {
        if state == .stopped || state == .failed {
            Task { @MainActor in self.remoteSpeaking = false }
        }
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, didOfflineOfUid uid: UInt, reason: AgoraUserOfflineReason) {
        Task { @MainActor in
            self.remoteUids.remove(uid)
            self.remoteSpeaking = false
            // In a 1:1 call, the other side leaving = hang up. End the call on our side too.
            if (self.mode == .calling || self.mode == .ringing), self.remoteUids.isEmpty {
                self.statusText = "কল শেষ"
                self.leave()
            }
        }
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, didOccurError errorCode: AgoraErrorCode) {
        Task { @MainActor in self.error = "Agora ত্রুটি (\(errorCode.rawValue))" }
    }
}

// MARK: - Ringtone (self-contained — synthesised in memory, no bundled audio files)

/// `.ringback` = the soft tone the CALLER hears while waiting for an answer;
/// `.incoming` = the louder double-ring the CALLEE hears. Loops until `stop()`.
final class IntercomRingtone {
    enum Kind { case ringback, incoming }
    private var player: AVAudioPlayer?

    func play(_ kind: Kind) {
        stop()
        do {
            // The incoming ring plays BEFORE any Agora session exists → own the session
            // as loud speaker playback (heard even on the silent switch). The ringback
            // plays into Agora's already-active call session, so we don't reconfigure it.
            if kind == .incoming {
                let s = AVAudioSession.sharedInstance()
                try s.setCategory(.playback, options: [.duckOthers])
                try s.setActive(true)
            }
            let p = try AVAudioPlayer(data: IntercomRingtone.wav(for: kind))
            p.numberOfLoops = -1
            p.volume = kind == .incoming ? 1.0 : 0.55
            p.prepareToPlay()
            p.play()
            player = p
        } catch {
            player = nil
        }
    }

    func stop() {
        player?.stop()
        player = nil
    }

    /// One loop of the ring cadence as a 16-bit mono PCM WAV.
    private static func wav(for kind: Kind) -> Data {
        let sr = 16_000.0
        let f1: Double, f2: Double
        let segments: [(on: Bool, dur: Double)]
        switch kind {
        case .ringback:
            f1 = 440; f2 = 480
            segments = [(true, 1.0), (false, 2.0)]                              // ring · long gap
        case .incoming:
            f1 = 480; f2 = 620
            segments = [(true, 0.4), (false, 0.2), (true, 0.4), (false, 1.4)]   // double-ring
        }
        var samples = [Int16]()
        for seg in segments {
            let n = Int(seg.dur * sr)
            for i in 0..<n {
                guard seg.on else { samples.append(0); continue }
                let t = Double(i) / sr
                // Blend two tones + a 20 ms fade at each edge so segments don't click.
                let env = min(1.0, min(Double(i), Double(n - i)) / (sr * 0.02))
                let v = (sin(2 * .pi * f1 * t) + sin(2 * .pi * f2 * t)) * 0.25 * env
                samples.append(Int16(max(-1, min(1, v)) * 32_767))
            }
        }
        return pcm16Wav(samples: samples, sampleRate: Int(sr))
    }

    private static func pcm16Wav(samples: [Int16], sampleRate: Int) -> Data {
        let dataBytes = samples.count * 2
        func u32(_ v: Int) -> [UInt8] { [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 24) & 0xff)] }
        func u16(_ v: Int) -> [UInt8] { [UInt8(v & 0xff), UInt8((v >> 8) & 0xff)] }
        var d = Data()
        d.append(contentsOf: Array("RIFF".utf8)); d.append(contentsOf: u32(36 + dataBytes))
        d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); d.append(contentsOf: u32(16))
        d.append(contentsOf: u16(1)); d.append(contentsOf: u16(1))            // PCM · mono
        d.append(contentsOf: u32(sampleRate)); d.append(contentsOf: u32(sampleRate * 2))
        d.append(contentsOf: u16(2)); d.append(contentsOf: u16(16))           // block align · bits
        d.append(contentsOf: Array("data".utf8)); d.append(contentsOf: u32(dataBytes))
        for s in samples {
            let u = UInt16(bitPattern: s)
            d.append(UInt8(u & 0xff)); d.append(UInt8((u >> 8) & 0xff))
        }
        return d
    }
}
