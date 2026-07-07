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
    var callSeconds = 0
    var statusText = ""
    var error: String? = nil
    var roster: [IntercomStaff] = []
    var recording = false             // PTT voice-note is capturing right now

    private var engine: AgoraRtcEngineKit?
    private var appId: String?
    private var channel: String?
    private var callTimer: Timer?
    private var ringTimer: Timer?
    private var remoteUids = Set<UInt>()   // remote parties currently on the call channel
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
        do {
            try await ensureMicPermission()
            try await join(channel: ch, publishMic: true)
            micMuted = false
            if outgoing { startRingTimeout() }   // "কেউ ধরেনি" if unanswered
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

    /// Staff side: the most recent still-ringing call addressed to me → its channel, else nil.
    func pendingCallChannel() async -> String? {
        struct B: Decodable { let id: String; let kind: String; let createdAt: String }
        struct Feed: Decodable { let broadcasts: [B] }
        guard let feed: Feed = try? await AlmaAPI.shared.get("/api/assistant/office/intercom") else { return nil }
        let iso = ISO8601DateFormatter()
        for b in feed.broadcasts where b.kind == "call" {
            if let t = iso.date(from: b.createdAt), Date().timeIntervalSince(t) < 45 {
                return "itc_\(b.id)"
            }
        }
        return nil
    }

    func toggleMute() {
        micMuted.toggle()
        engine?.muteLocalAudioStream(micMuted)
    }

    @MainActor
    func leave() {
        engine?.leaveChannel(nil)
        stopCallTimer()
        stopRingTimeout()
        mode = .idle
        connected = false
        remoteSpeaking = false
        localSpeaking = false
        remoteUids.removeAll()
        channel = nil
    }

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
        e.enableAudioVolumeIndication(350, smooth: 3, reportVad: true)
        engine = e
        appId = newId
        return e
    }

    private func configureAudioSession() throws {
        let s = AVAudioSession.sharedInstance()
        try s.setCategory(.playAndRecord, mode: .voiceChat,
                          options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
        try s.setActive(true)
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

    /// While ringing, give up after 45s if nobody answers.
    private func startRingTimeout() {
        stopRingTimeout()
        ringTimer = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.mode == .ringing else { return }
                self.error = "কেউ কল ধরেনি"
                self.leave()
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
