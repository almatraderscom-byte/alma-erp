//
//  MacRemoteControl.swift
//  RC-1 — driving the Mac by touch, from the phone.
//
//  L9 gave the owner live VIDEO of his Mac in the dock. This adds the uplink:
//  his finger becomes the Mac's mouse. The touches ride the SAME Agora
//  connection the video is already on (a data stream), so a tap costs no new
//  infrastructure and arrives with video-grade latency.
//
//  The owner's requirement, in his words: the Mac screen is big, the phone is
//  small, and a WRONG CLICK IS NOT ACCEPTABLE. Three decisions follow from it,
//  and none of them are polish to be added later:
//
//    1. TRACKPAD MODE IS THE DEFAULT. The finger moves the Mac's cursor
//       relative to where it already is, and a tap clicks WHERE THE CURSOR IS
//       — never under the finger. The finger never covers the target, and a
//       10-point slip on a phone is not a 90-point slip on a 3440-wide Mac.
//       This is what Screens, Jump and Chrome Remote Desktop all default to.
//    2. DIRECT (touch-where-you-look) TAPS ARE ZOOM-GATED. They are allowed
//       only at ≥2× magnification, where a fingertip really is smaller than a
//       button. Zoomed out, a direct tap is refused with an error haptic
//       rather than being silently approximated.
//    3. THE MAC ITSELF SHOWS THE AIM. The broadcaster snaps to the nearest
//       clickable element and paints a ring around it, so the owner sees the
//       target in the video before he commits. That half lives in
//       mac-agent/ScreenBroadcaster; this file is the hand.
//
//  Safety is not implicit: control is a separate switch from viewing, backed
//  by a separate short-lived token (join + data-stream only — it cannot push
//  audio or video), pinned to one uid the server minted, and dropped whenever
//  the stream stops, the lease lapses, or the owner stops touching.
//

import SwiftUI
import UIKit
import AgoraRtcKit

// MARK: - Wire types

private struct ControlTokenResponse: Decodable {
    let ok: Bool?
    let appId: String?
    let channel: String?
    let uid: Int?
    let token: String?
    let sessionId: String?
    let ttlSec: Int?
    /// The server explains refusals in Bangla (another device holds control,
    /// the kill-switch is off, the stream is not running). Show ITS words
    /// rather than a generic failure — the owner can act on the specific one.
    let messageBn: String?
}

private struct VideoTokenResponse: Decodable {
    let appId: String
    let channel: String
    let uid: Int
    let token: String
}

/// Typed bodies rather than dictionaries: `[String: Any]` is not Encodable,
/// and a typo in a key would fail silently at runtime instead of at build time.
private struct VideoTokenRequest: Encodable {
    let deviceId: String
    var uid: Int?
}

private struct ControlTokenRequest: Encodable {
    let deviceId: String
    var uid: Int?
    let on: Bool
}

// MARK: - Session: one Agora connection carrying video down and touch up

/// Owns the joined connection for a Mac's screen channel. Split out of
/// `MacScreenVideoPlayer` so the video canvas and the touch layer are two
/// views over ONE connection — a second join for control would double the
/// Agora minutes and could collide with the intercom's connection.
final class MacScreenSession: NSObject, AgoraRtcEngineDelegate {
    var engine: AgoraRtcEngineKit?
    /// Which device this join belongs to — the stage rejoins when the feed
    /// switches Macs mid-sheet (Codex P2 on L9).
    var joinedDeviceId: String?
    /// Our OWN connection (joinChannelEx), never the app's main channel.
    var connection: AgoraRtcConnection?
    weak var canvasView: UIView?
    var joined = false
    /// Per-join generation: leave() bumps it so a stale token request cannot
    /// join, or tear down the new join (Codex P2 round 6 on L9).
    var joinGeneration = 0
    private(set) var uid: Int = 0

    /// Native size of the Mac's video, needed to map a touch to a fraction of
    /// the DISPLAY rather than of the letterboxed view.
    private(set) var videoSize: CGSize = .zero
    var onVideoSize: ((CGSize) -> Void)?
    var onConnectionLost: (() -> Void)?
    /// RC-3: Agora warns ~30s before a token dies. Whoever owns the switch
    /// decides which token to renew — control if armed, view-only if not.
    var onTokenExpiring: (() -> Void)?
    /// Rejoin attempts after a FAILED connection, so a lift-dropout does not
    /// leave the owner staring at a black rectangle.
    private var healAttempts = 0

    // Control. TWO data streams, deliberately:
    //   • motion (unordered) — moves and scrolls are high-rate and
    //     loss-tolerant; a late one should be dropped, not waited for.
    //   • state (ordered) — clicks, drag down/up and keys CHANGE STATE, and
    //     the monotonic-sequence gate on the Mac drops anything that arrives
    //     out of order. A reordered `du` before its `dd` would leave the
    //     button held; a reordered click would fire at the old cursor.
    private var motionStreamId: Int = -1
    private var stateStreamId: Int = -1
    private var seq: Int64 = 0
    private(set) var controlArmed = false

    // MARK: Join / leave (L9 behaviour, unchanged)

    func join(deviceId: String, into view: UIView) {
        guard !joined else { return }
        joined = true
        joinedDeviceId = deviceId
        let gen = joinGeneration
        Task { @MainActor in
            guard let resp: VideoTokenResponse = try? await AlmaAPI.shared.send(
                "POST", "/api/assistant/mac-agent/screen-video-token",
                body: VideoTokenRequest(deviceId: deviceId)) else {
                // A transient token failure must not wedge the view in a
                // joined-but-black state (Codex P2 round 8 on L9).
                if gen == self.joinGeneration {
                    self.joined = false
                    self.joinedDeviceId = nil
                }
                return
            }
            if gen != self.joinGeneration { return }
            let engine = AgoraRtcEngineKit.sharedEngine(withAppId: resp.appId, delegate: nil)
            self.engine = engine
            self.uid = resp.uid
            engine.enableVideo()
            let conn = AgoraRtcConnection(channelId: resp.channel, localUid: resp.uid)
            self.connection = conn
            let options = AgoraRtcChannelMediaOptions()
            options.clientRoleType = .audience
            options.autoSubscribeVideo = true
            options.autoSubscribeAudio = false
            options.publishCameraTrack = false
            options.publishMicrophoneTrack = false
            engine.joinChannelEx(byToken: resp.token, connection: conn,
                                 delegate: self, mediaOptions: options)
            // The broadcaster uid is FIXED (1) — bind the canvas immediately
            // rather than waiting on a delegate whose connection-routing
            // varies by SDK minor (Codex P1 on L9).
            if let view = self.canvasView {
                let canvas = AgoraRtcVideoCanvas()
                canvas.uid = 1
                canvas.view = view
                canvas.renderMode = .fit
                engine.setupRemoteVideoEx(canvas, connection: conn)
            }
            if gen != self.joinGeneration {
                engine.leaveChannelEx(conn, leaveChannelBlock: nil)
                if self.connection === conn { self.connection = nil }
            }
        }
    }

    /// Point the remote video at a different canvas without leaving the
    /// channel — the full-screen view and the sheet share ONE join, so the
    /// video must simply move between their two canvases.
    @MainActor
    func rebindCanvas(_ view: UIView) {
        canvasView = view
        guard let engine, let conn = connection else { return }
        let canvas = AgoraRtcVideoCanvas()
        canvas.uid = 1
        canvas.view = view
        canvas.renderMode = .fit
        engine.setupRemoteVideoEx(canvas, connection: conn)
    }

    func leave() {
        joinGeneration += 1
        controlArmed = false
        motionStreamId = -1
        stateStreamId = -1
        resolveRole(false)
        if let conn = connection {
            engine?.leaveChannelEx(conn, leaveChannelBlock: nil)
            connection = nil
        }
        joined = false
    }

    // MARK: Agora delegate

    func rtcEngine(_ engine: AgoraRtcEngineKit, didJoinedOfUid uid: UInt, elapsed: Int) {
        guard uid == 1, let view = canvasView, let conn = connection else { return } // 1 = the Mac
        let canvas = AgoraRtcVideoCanvas()
        canvas.uid = uid
        canvas.view = view
        canvas.renderMode = .fit
        engine.setupRemoteVideoEx(canvas, connection: conn)
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, videoSizeChangedOf sourceType: AgoraVideoSourceType,
                   uid: UInt, size: CGSize, rotation: Int) {
        guard uid == 1, size.width > 0, size.height > 0 else { return }
        videoSize = size
        DispatchQueue.main.async { self.onVideoSize?(size) }
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, connectionChangedTo state: AgoraConnectionState,
                   reason: AgoraConnectionChangedReason) {
        // Losing the connection silently disarms control on this side too —
        // the Mac drops it on its own lease, but the UI must not keep claiming
        // the owner is driving something.
        if state == .failed || state == .disconnected {
            controlArmed = false
            motionStreamId = -1
            stateStreamId = -1
            DispatchQueue.main.async { self.onConnectionLost?() }
        }
        // .reconnecting is Agora healing itself — leave it alone. Only a hard
        // FAILED needs us to rebuild the join with a fresh token.
        if state == .failed { scheduleHeal() }
        if state == .connected { healAttempts = 0 }
    }

    /// Resolved the moment Agora confirms the broadcaster role — armControl
    /// awaits this rather than sleeping a fixed 400ms, because a fixed sleep
    /// does not establish the role actually changed and a data stream created
    /// while still an audience goes nowhere (Codex P1). `true` = became
    /// broadcaster, `false` = the change failed.
    private var roleContinuation: CheckedContinuation<Bool, Never>?
    /// Bumped on every arm attempt so a stale watchdog cannot resolve a newer
    /// arm's continuation (Codex P2).
    private var roleWaitToken = 0

    private func resolveRole(_ ok: Bool) {
        let cont = roleContinuation
        roleContinuation = nil
        cont?.resume(returning: ok)
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, didClientRoleChanged oldRole: AgoraClientRole,
                   newRole: AgoraClientRole, newRoleOptions: AgoraClientRoleOptions?) {
        DispatchQueue.main.async {
            #if DEBUG
            self.onAgoraEvent?("role\(newRole.rawValue)")
            #endif
            if newRole == .broadcaster { self.roleWaitToken += 1; self.resolveRole(true) }
        }
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, didClientRoleChangeFailed reason: AgoraClientRoleChangeFailedReason,
                   currentRole: AgoraClientRole) {
        DispatchQueue.main.async {
            #if DEBUG
            self.onAgoraEvent?("roleFail\(reason.rawValue)")
            #endif
            self.roleWaitToken += 1
            self.resolveRole(false)
        }
    }

    #if DEBUG
    var onAgoraEvent: ((String) -> Void)?
    func rtcEngine(_ engine: AgoraRtcEngineKit, didOccurError errorCode: AgoraErrorCode) {
        DispatchQueue.main.async { self.onAgoraEvent?("err\(errorCode.rawValue)") }
    }
    #endif

    func rtcEngine(_ engine: AgoraRtcEngineKit, tokenPrivilegeWillExpire token: String) {
        DispatchQueue.main.async { self.onTokenExpiring?() }
    }

    private func scheduleHeal() {
        guard healAttempts < 3, let deviceId = joinedDeviceId, let view = canvasView else { return }
        healAttempts += 1
        let delay = Double(healAttempts) * 2.0
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.joinedDeviceId == deviceId else { return }
            self.leave()
            self.join(deviceId: deviceId, into: view)
        }
    }

    // MARK: Control

    /// Upgrade this connection so it may SEND (and only send) data-stream
    /// messages. Publishing audio/video stays impossible: the control token
    /// carries no publish privilege for either.
    @MainActor
    func armControl(token: String) async -> Bool {
        guard let engine, let conn = connection else { return false }
        let options = AgoraRtcChannelMediaOptions()
        options.token = token
        options.clientRoleType = .broadcaster // required to send a data stream
        options.publishCameraTrack = false
        options.publishMicrophoneTrack = false
        options.autoSubscribeVideo = true
        options.autoSubscribeAudio = false
        guard engine.updateChannelEx(with: options, connection: conn) == 0 else { return false }
        // Wait for Agora to CONFIRM the broadcaster role before creating the
        // data streams — a stream made while still an audience is accepted
        // locally and then goes nowhere (Codex P1; measured live). A 3s
        // watchdog resolves false so a stuck transition fails cleanly instead
        // of hanging the arm.
        roleWaitToken += 1
        let myToken = roleWaitToken
        let became: Bool = await withCheckedContinuation { cont in
            self.roleContinuation = cont
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                // Only fire for the arm that armed THIS watchdog.
                guard let self, self.roleWaitToken == myToken else { return }
                self.resolveRole(false)
            }
        }
        guard became else { return false }
        // Create the streams ONCE per join and keep them across arm/disarm.
        // Agora keeps created streams for the life of the connection and caps
        // how many a client may create, so re-creating a pair on every toggle
        // eventually fails and control can never be armed again (Codex P2).
        if motionStreamId < 0 || stateStreamId < 0 {
            var motion: Int = -1
            let motionConfig = AgoraDataStreamConfig()
            motionConfig.ordered = false // a late move is worse than a lost one
            motionConfig.syncWithAudio = false
            guard engine.createDataStreamEx(&motion, config: motionConfig, connection: conn) == 0 else {
                return false
            }
            var state: Int = -1
            let stateConfig = AgoraDataStreamConfig()
            stateConfig.ordered = true // clicks and drag edges must not overtake
            stateConfig.syncWithAudio = false
            guard engine.createDataStreamEx(&state, config: stateConfig, connection: conn) == 0 else {
                return false
            }
            motionStreamId = motion
            stateStreamId = state
        }
        controlArmed = true
        return true
    }

    /// Step back down to view-only. The subscriber token is re-minted for the
    /// SAME uid so the video never blinks.
    @MainActor
    func disarmControl(viewToken: String?) {
        // Keep the stream IDs: they belong to the JOIN, not to the grant.
        controlArmed = false
        guard let engine, let conn = connection else { return }
        let options = AgoraRtcChannelMediaOptions()
        options.clientRoleType = .audience
        options.autoSubscribeVideo = true
        options.autoSubscribeAudio = false
        options.publishCameraTrack = false
        options.publishMicrophoneTrack = false
        if let viewToken { options.token = viewToken }
        _ = engine.updateChannelEx(with: options, connection: conn)
    }

    /// Fire-and-forget one control message. Sequence numbers are monotonic so
    /// the Mac can drop replays; `ordered` picks the stream that guarantees a
    /// packet cannot overtake the one before it.
    @discardableResult
    func send(_ action: [String: Any], ordered: Bool = true) -> Bool {
        let stream = ordered ? stateStreamId : motionStreamId
        guard controlArmed, stream >= 0, let engine, let conn = connection else { return false }
        seq += 1
        var payload = action
        payload["v"] = 1
        payload["s"] = seq
        payload["q"] = ordered ? 1 : 0
        payload["t"] = Int(Date().timeIntervalSince1970 * 1000)
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return false }
        return engine.sendStreamMessageEx(stream, data: data, connection: conn) == 0
    }
}

// MARK: - Haptics

/// RC-3 — the shared `AlmaAgentHaptics` builds a generator per call, which
/// costs tens of milliseconds the first time. For remote control the tap
/// feedback IS the confirmation that a click left the phone, so the engines are
/// kept warm while control is armed.
@MainActor
enum RemoteHaptics {
    private static let click = UIImpactFeedbackGenerator(style: .light)
    private static let commit = UIImpactFeedbackGenerator(style: .medium)
    private static let secondary = UIImpactFeedbackGenerator(style: .rigid)
    private static let notice = UINotificationFeedbackGenerator()

    static func prepare() {
        click.prepare()
        commit.prepare()
        secondary.prepare()
        notice.prepare()
    }

    static func tap() { click.impactOccurred(); click.prepare() }
    static func drag() { commit.impactOccurred(); commit.prepare() }
    static func rightTap() { secondary.impactOccurred(); secondary.prepare() }
    static func refused() { notice.notificationOccurred(.error); notice.prepare() }
    static func armed() { notice.notificationOccurred(.success); notice.prepare() }
}

// MARK: - Store: the owner's control switch, its lease, and its idle death

@available(iOS 17.0, *)
@MainActor
@Observable
final class MacRemoteControlStore {
    enum Mode: String {
        case trackpad
        /// Press where you are looking: the spot under the finger magnifies,
        /// you adjust while it is big, and the click lands on release. The
        /// owner asked for exactly this after driving it once — a tap that
        /// lands "somewhere near" is the failure this whole design is about.
        case aim
        case direct
    }

    var armed = false
    var busy = false
    var mode: Mode = .aim
    /// Direct taps need magnification; below this they are refused outright.
    static let directTapMinZoom: CGFloat = 2.0
    var zoom: CGFloat = 1.0
    /// Landscape, edge-to-edge control. The owner asked for it in the first
    /// live session: a 3440-wide Mac inside a 230pt strip is not something you
    /// can drive smoothly — full screen makes the target big enough to aim at.
    var fullScreen = false
    /// A finger is on the video right now — the full-screen chrome hides so it
    /// can never sit on top of what is being aimed at.
    var interacting = false
    /// RC-2.5: first tap aims (the Mac paints a solid ring), second commits.
    /// Off by default — the snap already makes ordinary targets safe; this is
    /// the brake for the small ones, and the owner decides when he wants it.
    var twoStepConfirm = false
    var statusBn: String?
    /// Native Mac video size, for mapping a touch onto the display.
    var videoSize: CGSize = .zero

    @ObservationIgnored private var deviceId: String?
    @ObservationIgnored private weak var session: MacScreenSession?
    @ObservationIgnored private var renewTask: Task<Void, Never>?
    @ObservationIgnored private var lastTouchAt = Date()
    /// True between `dd` and `du`. While a drag is held, MOVES must travel on
    /// the same ordered lane as its edges — otherwise a move can be applied
    /// before the down or after the up, and part of the drag degrades into
    /// plain cursor motion (Codex P1).
    @ObservationIgnored private var dragging = false
    @ObservationIgnored private var sendFailures = 0
    #if DEBUG
    /// Temporary instrumentation for the first live run: what the touch layer
    /// saw versus what actually left the phone.
    var debugCounters = "began=0 moved=0 sent=0 failed=0"
    var agoraEvents = ""
    var began = 0
    var moved = 0
    var sent = 0
    var failed = 0
    #endif
    /// The lease the server hands out is 120s; the phone renews well inside it.
    private let renewEvery: TimeInterval = 45
    /// Cost guard: an armed-but-untouched control session stops renewing, so
    /// a phone left in a pocket cannot keep the Mac streaming (and billing).
    private let idleDisarmAfter: TimeInterval = 120

    init() {
        #if DEBUG
        // Simulator layout check: show the armed UI without a server. Nothing
        // can actually be sent — there is no joined session behind it.
        let p = ProcessInfo.processInfo
        if p.environment["ALMA_RC_FIXTURE"] == "1"
            || p.arguments.contains("ALMA_RC_FIXTURE=1") {
            armed = true
        }
        #endif
    }

    func attach(session: MacScreenSession, deviceId: String) {
        self.session = session
        self.deviceId = deviceId
        session.onConnectionLost = { [weak self, weak session] in
            guard let self, self.armed else { return }
            self.armed = false
            self.dragging = false
            self.statusBn = "সংযোগ কেটে গেছে — কন্ট্রোল বন্ধ।"
            self.renewTask?.cancel()
            // The heal rejoins with a NEW uid, so the old pin would hold the
            // Mac for the rest of its lease and answer the next arm with
            // control_held (Codex P2). Hand it back explicitly.
            let staleUid = session?.uid
            Task {
                _ = try? await AlmaAPI.shared.send(
                    "POST", "/api/assistant/mac-agent/screen-control-token",
                    body: ControlTokenRequest(deviceId: deviceId, uid: staleUid, on: false)
                ) as ControlTokenResponse
            }
        }
        session.onVideoSize = { [weak self] size in self?.videoSize = size }
        #if DEBUG
        session.onAgoraEvent = { [weak self] event in
            guard let self else { return }
            self.agoraEvents = (self.agoraEvents + " " + event).suffix(60).description
        }
        #endif
        session.onTokenExpiring = { [weak self] in
            guard let self else { return }
            Task { await self.armed ? self.renew() : self.renewViewToken() }
        }
    }

    func toggle() async {
        if armed { await disarm(reason: nil) } else { await arm() }
    }

    func arm() async {
        guard !busy, let session, let deviceId, session.connection != nil else { return }
        busy = true
        defer { busy = false }
        let resp: ControlTokenResponse
        do {
            resp = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/mac-agent/screen-control-token",
                body: ControlTokenRequest(deviceId: deviceId, uid: session.uid, on: true))
        } catch let AlmaAPIError.http(_, body) {
            // The route refuses for specific, actionable reasons — another
            // device holds control, the kill-switch is off, the live view is
            // not running. Show ITS sentence, not a generic failure.
            statusBn = Self.messageBn(from: body) ?? "কন্ট্রোল চালু করা গেল না।"
            RemoteHaptics.refused()
            return
        } catch {
            statusBn = "কন্ট্রোল চালু করা গেল না।"
            RemoteHaptics.refused()
            return
        }
        guard let token = resp.token, await session.armControl(token: token) else {
            // The server already pinned this uid. Leaving it pinned would keep
            // the daemon armed for a phone that thinks control is off, and lock
            // out the owner's other device for the whole lease (Codex P2).
            _ = try? await AlmaAPI.shared.send(
                "POST", "/api/assistant/mac-agent/screen-control-token",
                body: ControlTokenRequest(deviceId: deviceId, uid: session.uid, on: false)
            ) as ControlTokenResponse
            statusBn = resp.messageBn ?? "কন্ট্রোল চালু করা গেল না।"
            RemoteHaptics.refused()
            return
        }
        armed = true
        lastTouchAt = Date()
        statusBn = nil
        RemoteHaptics.prepare()
        RemoteHaptics.armed()
        startRenewLoop()
    }

    func disarm(reason: String?) async {
        renewTask?.cancel()
        renewTask = nil
        armed = false
        dragging = false
        statusBn = reason
        guard let session, let deviceId else { return }
        // Re-mint a view-only token for the SAME uid before dropping the role,
        // so the video does not blink when control ends.
        let viewToken: String? = (try? await AlmaAPI.shared.send(
            "POST", "/api/assistant/mac-agent/screen-video-token",
            body: VideoTokenRequest(deviceId: deviceId, uid: session.uid)
        ) as VideoTokenResponse)?.token
        await session.disarmControl(viewToken: viewToken)
        _ = try? await AlmaAPI.shared.send(
            "POST", "/api/assistant/mac-agent/screen-control-token",
            body: ControlTokenRequest(deviceId: deviceId, uid: session.uid, on: false)
        ) as ControlTokenResponse
    }

    private func startRenewLoop() {
        renewTask?.cancel()
        renewTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(45 * 1_000_000_000))
                guard let self, self.armed, !Task.isCancelled else { return }
                if Date().timeIntervalSince(self.lastTouchAt) > self.idleDisarmAfter {
                    await self.disarm(reason: "নিষ্ক্রিয় থাকায় কন্ট্রোল বন্ধ হয়েছে।")
                    return
                }
                await self.renew()
            }
        }
    }

    func renew() async {
        guard let session, let deviceId else { return }
        guard let resp: ControlTokenResponse = try? await AlmaAPI.shared.send(
            "POST", "/api/assistant/mac-agent/screen-control-token",
            body: ControlTokenRequest(deviceId: deviceId, uid: session.uid, on: true)
        ), resp.token != nil else {
            await disarm(reason: "কন্ট্রোলের মেয়াদ নবায়ন হয়নি।")
            return
        }
        // The lease is renewed server-side by the same call; the Agora token
        // only needs replacing as it nears expiry. Restate the WHOLE option
        // set rather than just the token — an options object carrying defaults
        // for everything else is not obviously a no-op for the fields it does
        // not mention, and a silent role flip mid-session would be ugly to
        // diagnose.
        if let token = resp.token, let engine = session.engine, let conn = session.connection {
            let options = AgoraRtcChannelMediaOptions()
            options.token = token
            options.clientRoleType = .broadcaster
            options.publishCameraTrack = false
            options.publishMicrophoneTrack = false
            options.autoSubscribeVideo = true
            options.autoSubscribeAudio = false
            _ = engine.updateChannelEx(with: options, connection: conn)
        }
    }

    /// Refresh the view-only token in place (same uid, no rejoin, no blink).
    private func renewViewToken() async {
        guard let session, let deviceId, let engine = session.engine,
              let conn = session.connection else { return }
        guard let resp: VideoTokenResponse = try? await AlmaAPI.shared.send(
            "POST", "/api/assistant/mac-agent/screen-video-token",
            body: VideoTokenRequest(deviceId: deviceId, uid: session.uid)) else { return }
        let options = AgoraRtcChannelMediaOptions()
        options.token = resp.token
        options.clientRoleType = .audience
        options.publishCameraTrack = false
        options.publishMicrophoneTrack = false
        options.autoSubscribeVideo = true
        options.autoSubscribeAudio = false
        _ = engine.updateChannelEx(with: options, connection: conn)
    }

    // MARK: Sending (called from the touch surface)

    /// Pull the server's Bangla explanation out of an error body.
    private static func messageBn(from body: String?) -> String? {
        guard let data = body?.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return obj["messageBn"] as? String
    }

    func touched() { lastTouchAt = Date() }

    func sendMove(dx: Double, dy: Double) {
        guard armed else { return }
        touched()
        let ok = session?.send(["a": "m", "dx": dx, "dy": dy], ordered: dragging) == true
        #if DEBUG
        if ok { sent += 1 } else { failed += 1 }
        debugCounters = "began=\(began) moved=\(moved) sent=\(sent) failed=\(failed)"
        #endif
        // A silent no-op is the worst failure here: the owner drags and the
        // Mac does nothing, with no way to tell why.
        if !ok {
            sendFailures += 1
            if sendFailures == 3 { statusBn = "কন্ট্রোল বার্তা যাচ্ছে না — বন্ধ করে আবার চালু করুন।" }
        } else if sendFailures > 0 {
            sendFailures = 0
            if statusBn?.hasPrefix("কন্ট্রোল বার্তা") == true { statusBn = nil }
        }
    }

    func sendClick(count: Int, right: Bool) {
        guard armed else { return }
        touched()
        var payload: [String: Any] = ["a": "c", "b": right ? "r" : "l", "n": count]
        // A right-click is a deliberate two-finger act and a double-click is
        // already a repeat — neither needs the confirm brake.
        if twoStepConfirm, !right, count == 1 { payload["cf"] = 1 }
        if session?.send(payload) == true {
            right ? RemoteHaptics.rightTap() : RemoteHaptics.tap()
        } else {
            RemoteHaptics.refused()
        }
    }

    func sendScroll(dx: Double, dy: Double) {
        guard armed else { return }
        touched()
        _ = session?.send(["a": "w", "dx": dx, "dy": dy], ordered: false)
    }

    func sendDrag(down: Bool) {
        guard armed else { return }
        touched()
        dragging = down
        _ = session?.send(["a": down ? "dd" : "du"])
        RemoteHaptics.drag()
    }

    /// Direct (absolute) tap — only meaningful when magnified, so the refusal
    /// is part of the contract rather than an error path.
    func sendDirectTap(x: Double, y: Double) {
        guard armed else { return }
        // Without the real video size the fitted rect is a guess, and a guess
        // is exactly what an absolute tap must not be built on.
        guard videoSize.width > 0, videoSize.height > 0 else {
            RemoteHaptics.refused()
            statusBn = "ভিডিও এখনো আসেনি — একটু পরে চেষ্টা করুন।"
            return
        }
        guard zoom >= Self.directTapMinZoom else {
            RemoteHaptics.refused()
            statusBn = "সরাসরি ট্যাপের জন্য অন্তত ২× জুম করুন।"
            return
        }
        touched()
        // One packet, not two: a separate position-then-click pair can be
        // reordered or half-lost, and a click at the OLD cursor is exactly the
        // wrong-click this whole design exists to prevent.
        var payload: [String: Any] = ["a": "c", "b": "l", "n": 1, "x": x, "y": y]
        if twoStepConfirm { payload["cf"] = 1 }
        _ = session?.send(payload)
        RemoteHaptics.tap()
    }

    /// AIM mode: the finger is down and the view is magnified — keep the Mac's
    /// cursor under it so the snap ring shows the target before the commit.
    func sendAimMove(x: Double, y: Double) {
        guard armed else { return }
        touched()
        // While a drag is held the position must ride the SAME ordered lane as
        // dd/du, or a move can overtake mouse-down/up and part of the drag
        // becomes a plain jump (Codex P1). A free aim move stays unordered.
        _ = session?.send(["a": "p", "x": x, "y": y], ordered: dragging)
    }

    /// AIM mode commit: position and click in ONE ordered packet.
    func sendAimClick(x: Double, y: Double, right: Bool = false) {
        guard armed else { return }
        // Without the real video size the fitted rect (and therefore this
        // fraction) is guessed from a 16:9 fallback, and on the ultrawide Mac
        // that lands the click far from the target (Codex P1).
        guard videoSize.width > 0, videoSize.height > 0 else {
            RemoteHaptics.refused()
            statusBn = "ভিডিও এখনো আসেনি — একটু পরে।"
            return
        }
        touched()
        var payload: [String: Any] = ["a": "c", "b": right ? "r" : "l", "n": 1, "x": x, "y": y]
        if twoStepConfirm { payload["cf"] = 1 }
        if session?.send(payload) == true {
            right ? RemoteHaptics.rightTap() : RemoteHaptics.tap()
        } else {
            RemoteHaptics.refused()
        }
    }

    /// Right-click at an absolute point (direct-mode long press).
    func sendDirectRightClick(x: Double, y: Double) {
        guard armed, videoSize.width > 0, videoSize.height > 0 else { return }
        guard zoom >= Self.directTapMinZoom else {
            RemoteHaptics.refused()
            statusBn = "সরাসরি মোডে অন্তত ২× জুম করুন।"
            return
        }
        touched()
        _ = session?.send(["a": "c", "b": "r", "n": 1, "x": x, "y": y])
        RemoteHaptics.rightTap()
    }

    /// Returns false if nothing could be sent, so the composer keeps the text
    /// rather than swallowing it.
    @discardableResult
    func sendText(_ text: String) -> Bool {
        guard armed, !text.isEmpty else { return false }
        touched()
        var ok = true
        for chunk in Self.wireChunks(text) {
            if session?.send(["a": "k", "txt": chunk]) != true { ok = false; break }
        }
        return ok
    }

    /// Split on the tighter of the two wire limits: 240 characters, and a
    /// UTF-8 budget that leaves room for the JSON envelope inside 1 KB.
    static func wireChunks(_ text: String, maxChars: Int = 200, maxBytes: Int = 700) -> [String] {
        var chunks: [String] = []
        var current = ""
        var bytes = 0
        for character in text {
            let size = String(character).utf8.count
            if current.count >= maxChars || bytes + size > maxBytes {
                chunks.append(current)
                current = ""
                bytes = 0
            }
            current.append(character)
            bytes += size
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }

    func sendKey(_ name: String, mods: [String] = []) {
        guard armed else { return }
        touched()
        _ = session?.send(["a": "kc", "key": name, "mods": mods])
        AlmaAgentHaptics.light()
    }
}

// MARK: - The touch surface

/// Raw touch handling rather than gesture recognizers: a trackpad needs one
/// state machine over "how many fingers, how far, how long", and four
/// recognizers fighting each other is exactly how a remote control develops a
/// wrong-click problem.
@available(iOS 17.0, *)
final class TrackpadSurfaceView: UIView {
    weak var store: MacRemoteControlStore?
    /// Aspect (w/h) of the Mac display, so the fitted video rect is exact.
    var videoAspect: CGFloat = 16.0 / 9.0
    var directMode = false
    /// AIM mode: magnify under the finger, commit on release.
    var aimMode = false
    private var lastAimSendAt: TimeInterval = 0
    /// Called with the touch point when the aim magnifier should show/move/hide.
    var onAimZoom: ((CGPoint?) -> Void)?
    /// Called with the point the click would land on (in this view's space), so
    /// a reticle can be drawn there. The finger sits BELOW it.
    var onAimTarget: ((CGPoint?) -> Void)?
    /// True while a finger is down — the chrome hides so it never covers the
    /// thing being aimed at.
    var onInteracting: ((Bool) -> Void)?

    /// How far ABOVE the finger the aimed point sits. A fingertip is ~50pt of
    /// opaque flesh; aiming at something you cannot see is the whole problem.
    static let aimLift: CGFloat = 78

    /// The point being aimed at for a touch at `touch`.
    private func aimPoint(for touch: CGPoint) -> CGPoint {
        CGPoint(x: touch.x, y: max(videoRect.minY + 2, touch.y - Self.aimLift))
    }

    private enum Phase { case idle, undecided, moving, dragging, twoFinger, aiming }
    private var phase: Phase = .idle
    private var startPoint: CGPoint = .zero
    private var lastPoint: CGPoint = .zero
    private var startedAt: Date = .init()
    private var lastTwoFingerPoint: CGPoint = .zero
    /// Where the two-finger gesture STARTED (its midpoint). Comparing against
    /// the first finger's touch-down point instead made every two-finger tap
    /// look like a swipe, so the right-click never fired (Codex P2).
    private var twoFingerStart: CGPoint = .zero
    private var longPressWork: DispatchWorkItem?
    private var lastClickAt: Date = .distantPast
    private var lastClickPoint: CGPoint = .zero
    /// Accumulated motion, flushed on a timer — Agora allows ~60 data messages
    /// a second and a finger generates far more touch callbacks than that.
    private var pendingDX: Double = 0
    private var pendingDY: Double = 0
    private var flushTimer: Timer?

    private let moveThreshold: CGFloat = 7
    private let tapMaxDuration: TimeInterval = 0.4
    private let doubleTapWindow: TimeInterval = 0.32
    private let longPressDelay: TimeInterval = 0.45

    /// Exists only to CLAIM the drag. The stage lives inside the sheet's
    /// scroll view, whose pan recogniser would otherwise swallow every finger
    /// movement on the video and scroll the sheet instead of driving the Mac
    /// (found on the first live run — nothing reached the Mac at all).
    private lazy var claim: UIPanGestureRecognizer = {
        let g = UIPanGestureRecognizer(target: self, action: #selector(claimed(_:)))
        g.minimumNumberOfTouches = 1
        g.maximumNumberOfTouches = 2
        g.cancelsTouchesInView = false // our raw touch handling still runs
        g.delaysTouchesBegan = false
        g.delegate = self
        return g
    }()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isMultipleTouchEnabled = true
        backgroundColor = .clear
        addGestureRecognizer(claim)
    }

    @objc private func claimed(_ g: UIPanGestureRecognizer) { /* claiming is the point */ }

    /// Enabled only while control is armed — an unarmed stage must still let
    /// the owner scroll the sheet with a finger on the video.
    var claimsDrag: Bool {
        get { claim.isEnabled }
        set { claim.isEnabled = newValue }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // Make the enclosing scroll view yield to us rather than the reverse.
        var view: UIView? = superview
        while let current = view {
            if let scroll = current as? UIScrollView {
                scroll.panGestureRecognizer.require(toFail: claim)
                break
            }
            view = current.superview
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }

    deinit { flushTimer?.invalidate() }

    /// Where the letterboxed video actually sits inside our bounds.
    var videoRect: CGRect {
        guard videoAspect > 0, bounds.width > 0, bounds.height > 0 else { return bounds }
        let boxAspect = bounds.width / bounds.height
        if boxAspect > videoAspect { // pillarboxed
            let w = bounds.height * videoAspect
            return CGRect(x: bounds.midX - w / 2, y: 0, width: w, height: bounds.height)
        }
        let h = bounds.width / videoAspect
        return CGRect(x: 0, y: bounds.midY - h / 2, width: bounds.width, height: h)
    }

    // MARK: Touches

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        #if DEBUG
        store?.began += 1
        store?.debugCounters = "began=\(store?.began ?? 0) moved=\(store?.moved ?? 0) sent=\(store?.sent ?? 0) failed=\(store?.failed ?? 0)"
        #endif
        guard store?.armed == true else { return }
        let all = event?.allTouches?.filter { $0.phase != .ended && $0.phase != .cancelled } ?? touches
        if all.count >= 2 {
            // A second finger arriving during an aim cancels the aim — the
            // owner is scrolling, not clicking.
            if phase == .aiming {
                onAimZoom?(nil)
                onAimTarget?(nil)
                onInteracting?(false)
            }
            cancelLongPress()
            phase = .twoFinger
            // Motion the first finger had already banked is not part of this
            // gesture — flushing it would jog the cursor as the scroll starts.
            pendingDX = 0
            pendingDY = 0
            lastTwoFingerPoint = midpoint(of: all)
            twoFingerStart = lastTwoFingerPoint
            startedAt = Date()
            return
        }
        guard let touch = touches.first else { return }
        startPoint = touch.location(in: self)
        lastPoint = startPoint
        startedAt = Date()
        if aimMode {
            // Magnify immediately: the owner is aiming at something he can see,
            // and a delay would make the first tap feel unresponsive.
            let rect = videoRect
            // The FINGER must be on the video, not only its lifted target — a
            // touch that starts in the black letterbox but whose 78pt-lifted
            // point falls inside would otherwise commit a real click on empty
            // space (Codex P1).
            guard rect.contains(startPoint) else { phase = .idle; return }
            phase = .aiming
            let target = aimPoint(for: startPoint)
            onInteracting?(true)
            onAimZoom?(target)
            onAimTarget?(target)
            RemoteHaptics.tap()
            store?.sendAimMove(x: Double((target.x - rect.minX) / rect.width),
                               y: Double((target.y - rect.minY) / rect.height))
            scheduleLongPress() // hold in aim mode = pick the thing up (drag)
            return
        }
        phase = .undecided
        scheduleLongPress()
        startFlushTimer()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        #if DEBUG
        store?.moved += 1
        #endif
        guard store?.armed == true else { return }
        let all = event?.allTouches?.filter { $0.phase != .ended && $0.phase != .cancelled } ?? touches
        if phase == .twoFinger || all.count >= 2 {
            if phase != .twoFinger {
                phase = .twoFinger
                pendingDX = 0
                pendingDY = 0
                lastTwoFingerPoint = midpoint(of: all)
                twoFingerStart = lastTwoFingerPoint
                startedAt = Date()
                cancelLongPress()
                return
            }
            cancelLongPress()
            // One finger lifting early must not drag the tracked midpoint to
            // the survivor's position — that alone would exceed the tap
            // threshold and swallow the right-click.
            guard all.count >= 2 else { return }
            let now = midpoint(of: all)
            let dx = now.x - lastTwoFingerPoint.x
            let dy = now.y - lastTwoFingerPoint.y
            lastTwoFingerPoint = now
            let rect = videoRect
            guard rect.width > 0, rect.height > 0 else { return }
            // Natural scrolling: content follows the fingers, as on the Mac.
            store?.sendScroll(dx: Double(-dx / rect.width), dy: Double(dy / rect.height))
            return
        }
        guard let touch = touches.first else { return }
        let p = touch.location(in: self)
        if phase == .aiming || phase == .dragging, aimMode {
            // While magnified the finger is fine-tuning: the Mac's cursor (and
            // therefore its snap ring) follows, so the target is visible before
            // the click is committed. A drag in progress keeps the same
            // mapping, it just has the button held.
            if phase == .aiming, hypot(p.x - startPoint.x, p.y - startPoint.y) > 4 { cancelLongPress() }
            lastPoint = p
            let rect = videoRect
            guard rect.width > 0, rect.height > 0 else { return }
            let target = aimPoint(for: p)
            onAimZoom?(target)   // visual: every frame, smooth
            onAimTarget?(target)
            // Network: capped near the wire rate (~45/s). The Mac's position
            // bucket refills at 90/s and a 120Hz finger would blow past it,
            // producing rate-limited drops (Codex P2). The commit on release
            // carries the exact final point, so throttling costs no accuracy.
            let now = Date().timeIntervalSince1970
            if now - lastAimSendAt >= 0.022 {
                lastAimSendAt = now
                store?.sendAimMove(x: Double(min(max(0, (target.x - rect.minX) / rect.width), 1)),
                                   y: Double(min(max(0, (target.y - rect.minY) / rect.height), 1)))
            }
            return
        }
        let moved = hypot(p.x - startPoint.x, p.y - startPoint.y)
        if phase == .undecided, moved > moveThreshold {
            phase = .moving
            cancelLongPress()
        }
        guard phase == .moving || phase == .dragging else { return }
        let rect = videoRect
        guard rect.width > 0, rect.height > 0 else { return }
        // 1:1 by default with a gentle acceleration: a slow finger is precise,
        // a fast flick crosses an ultrawide screen without a dozen swipes.
        let rawDX = Double((p.x - lastPoint.x) / rect.width)
        let rawDY = Double((p.y - lastPoint.y) / rect.height)
        let speed = hypot(rawDX, rawDY)
        let accel = min(2.2, 1.0 + speed * 22)
        pendingDX += rawDX * accel
        pendingDY += rawDY * accel
        lastPoint = p
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard store?.armed == true else { phase = .idle; return }
        let remaining = event?.allTouches?.filter { $0.phase != .ended && $0.phase != .cancelled }.count ?? 0
        cancelLongPress()
        flushPendingMotion()
        switch phase {
        case .aiming:
            let target = aimPoint(for: touches.first?.location(in: self) ?? lastPoint)
            let rect = videoRect
            onAimZoom?(nil)
            onAimTarget?(nil)
            onInteracting?(false)
            if rect.contains(target) {
                store?.sendAimClick(x: Double((target.x - rect.minX) / rect.width),
                                    y: Double((target.y - rect.minY) / rect.height))
            }
        case .dragging:
            if aimMode {
                // The throttle can drop the last aim move, so send the exact
                // release point before mouse-up or the item lands where the
                // previous packet was, not where the finger let go (Codex P2).
                let rect = videoRect
                let target = aimPoint(for: touches.first?.location(in: self) ?? lastPoint)
                if rect.width > 0, rect.height > 0 {
                    store?.sendAimMove(x: Double(min(max(0, (target.x - rect.minX) / rect.width), 1)),
                                       y: Double(min(max(0, (target.y - rect.minY) / rect.height), 1)))
                }
            }
            store?.sendDrag(down: false)
            if aimMode {
                onAimZoom?(nil)
                onAimTarget?(nil)
                onInteracting?(false)
            }
        case .twoFinger:
            // A two-finger tap (no travel, short) is a right-click.
            if remaining == 0, Date().timeIntervalSince(startedAt) < tapMaxDuration,
               hypot(lastTwoFingerPoint.x - twoFingerStart.x,
                     lastTwoFingerPoint.y - twoFingerStart.y) < moveThreshold * 2 {
                store?.sendClick(count: 1, right: true)
            }
        case .undecided:
            handleTap(at: touches.first?.location(in: self) ?? startPoint)
        case .moving, .idle:
            break
        }
        if remaining == 0 {
            phase = .idle
            stopFlushTimer()
        }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        if phase == .aiming || (aimMode && phase == .dragging) {
            onAimZoom?(nil)
            onAimTarget?(nil)
            onInteracting?(false)
        }
        cancelLongPress()
        flushPendingMotion()
        if phase == .dragging { store?.sendDrag(down: false) }
        phase = .idle
        stopFlushTimer()
    }

    private func handleTap(at point: CGPoint) {
        guard Date().timeIntervalSince(startedAt) < tapMaxDuration else { return }
        if directMode {
            let rect = videoRect
            guard rect.contains(point) else {
                AlmaAgentHaptics.error()
                return
            }
            store?.sendDirectTap(
                x: Double((point.x - rect.minX) / rect.width),
                y: Double((point.y - rect.minY) / rect.height))
            return
        }
        let now = Date()
        // The first tap already fired a real click. A double-tap therefore
        // sends only the SECOND click of the pair (clickState 2), which is
        // what macOS reads as a double-click — sending a `count: 2` burst on
        // top of the first click would fire three times (Codex P1).
        // With two-step confirm on there is no first click to pair with, so
        // every tap stays a single.
        let confirmOn = store?.twoStepConfirm == true
        let isDouble = !confirmOn
            && now.timeIntervalSince(lastClickAt) < doubleTapWindow
            && hypot(point.x - lastClickPoint.x, point.y - lastClickPoint.y) < 24
        lastClickAt = isDouble ? .distantPast : now // a triple tap starts over
        lastClickPoint = point
        store?.sendClick(count: isDouble ? 2 : 1, right: false)
    }

    // MARK: Long press → drag

    private func scheduleLongPress() {
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if self.aimMode, self.phase == .aiming {
                // Held still while magnified: PICK IT UP. Dragging a file or a
                // window is the other half of using a Mac, and switching modes
                // to do it would break the flow. Right-click stays on the
                // two-finger tap, the same as everywhere else.
                self.phase = .dragging
                self.store?.sendDrag(down: true)
                return
            }
            guard self.phase == .undecided else { return }
            if self.directMode {
                // Zoomed in, touch-where-you-look: a long press is the natural
                // right-click, and a drag there would fight the pan gesture.
                self.phase = .idle
                let rect = self.videoRect
                let p = self.startPoint
                guard rect.contains(p) else { return }
                self.store?.sendDirectRightClick(
                    x: Double((p.x - rect.minX) / rect.width),
                    y: Double((p.y - rect.minY) / rect.height))
                return
            }
            self.phase = .dragging
            self.store?.sendDrag(down: true)
        }
        longPressWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + longPressDelay, execute: work)
    }

    private func cancelLongPress() {
        longPressWork?.cancel()
        longPressWork = nil
    }

    // MARK: Motion flushing

    private func startFlushTimer() {
        guard flushTimer == nil else { return }
        let timer = Timer(timeInterval: 0.022, repeats: true) { [weak self] _ in
            self?.flushPendingMotion()
        }
        RunLoop.main.add(timer, forMode: .common)
        flushTimer = timer
    }

    private func stopFlushTimer() {
        flushTimer?.invalidate()
        flushTimer = nil
    }

    private func flushPendingMotion() {
        guard pendingDX != 0 || pendingDY != 0 else { return }
        // Clamp to the wire contract: the Mac drops anything past half a screen.
        let dx = max(-0.45, min(0.45, pendingDX))
        let dy = max(-0.45, min(0.45, pendingDY))
        pendingDX = 0
        pendingDY = 0
        store?.sendMove(dx: dx, dy: dy)
    }

    private func midpoint(of touches: Set<UITouch>) -> CGPoint {
        var sum = CGPoint.zero
        for t in touches {
            let p = t.location(in: self)
            sum.x += p.x
            sum.y += p.y
        }
        let n = CGFloat(max(1, touches.count))
        return CGPoint(x: sum.x / n, y: sum.y / n)
    }
}

/// The aiming cross-hair: a ring with a centre dot at the exact point the
/// click will land. Drawn in ALMA coral, same as the Mac-side snap ring, so
/// the two read as one system.
final class ReticleView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        let coral = UIColor(red: 0.878, green: 0.478, blue: 0.373, alpha: 1)
        let c = CGPoint(x: bounds.midX, y: bounds.midY)
        ctx.setStrokeColor(coral.cgColor)
        ctx.setLineWidth(2)
        ctx.strokeEllipse(in: CGRect(x: c.x - 13, y: c.y - 13, width: 26, height: 26))
        ctx.setFillColor(coral.cgColor)
        ctx.fillEllipse(in: CGRect(x: c.x - 2.5, y: c.y - 2.5, width: 5, height: 5))
        // Four ticks so the centre reads even over busy video.
        for (dx, dy, dx2, dy2) in [(0.0, -13.0, 0.0, -19.0), (0.0, 13.0, 0.0, 19.0),
                                   (-13.0, 0.0, -19.0, 0.0), (13.0, 0.0, 19.0, 0.0)] {
            ctx.move(to: CGPoint(x: c.x + dx, y: c.y + dy))
            ctx.addLine(to: CGPoint(x: c.x + dx2, y: c.y + dy2))
        }
        ctx.strokePath()
    }
}

// MARK: - The stage: video canvas + touch surface as one view

@available(iOS 17.0, *)
struct MacScreenStage: UIViewRepresentable {
    let deviceId: String
    let session: MacScreenSession
    var store: MacRemoteControlStore
    /// True for the landscape presentation. Only the stage that matches the
    /// current mode owns the canvas, so the two never fight over it.
    var isFullScreen = false

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .black
        container.clipsToBounds = true

        // Only the VIDEO is magnified, never the touch surface. Codex P1: a
        // touch read through a transformed surface returns magnified
        // coordinates, so the click committed above the previewed reticle. The
        // aim magnifier is purely cosmetic — the click target is always the
        // finger's position in the STABLE, untransformed frame.
        let zoomLayer = UIView()
        zoomLayer.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(zoomLayer)

        let canvas = UIView()
        canvas.backgroundColor = .black
        canvas.translatesAutoresizingMaskIntoConstraints = false
        zoomLayer.addSubview(canvas)

        // Touch surface is a STABLE sibling on top of the zoom layer — it never
        // scales, so its coordinates are the real ones.
        let surface = TrackpadSurfaceView(frame: .zero)
        surface.translatesAutoresizingMaskIntoConstraints = false
        surface.store = store
        surface.backgroundColor = .clear
        container.addSubview(surface)

        NSLayoutConstraint.activate([
            zoomLayer.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            zoomLayer.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            zoomLayer.topAnchor.constraint(equalTo: container.topAnchor),
            zoomLayer.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            canvas.leadingAnchor.constraint(equalTo: zoomLayer.leadingAnchor),
            canvas.trailingAnchor.constraint(equalTo: zoomLayer.trailingAnchor),
            canvas.topAnchor.constraint(equalTo: zoomLayer.topAnchor),
            canvas.bottomAnchor.constraint(equalTo: zoomLayer.bottomAnchor),
            surface.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            surface.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            surface.topAnchor.constraint(equalTo: container.topAnchor),
            surface.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])

        surface.onAimZoom = { [weak coordinator = context.coordinator] point in
            coordinator?.magnify(around: point)
        }
        surface.onAimTarget = { [weak coordinator = context.coordinator] point in
            coordinator?.showReticle(at: point)
        }
        surface.onInteracting = { [weak store] active in
            store?.interacting = active
        }

        // The reticle lives on the STABLE surface at the exact stable point the
        // click will land — because the zoom is anchored on that point, its
        // screen position does not move when the video magnifies, so it stays
        // glued to the target without inheriting the transform.
        let reticle = ReticleView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        reticle.isHidden = true
        reticle.isUserInteractionEnabled = false
        surface.addSubview(reticle)
        context.coordinator.reticle = reticle
        context.coordinator.surface = surface
        context.coordinator.canvas = canvas
        context.coordinator.zoomLayer = zoomLayer
        context.coordinator.store = store
        store.attach(session: session, deviceId: deviceId)
        if session.joined {
            // Already in the channel (the sheet joined): this new stage simply
            // takes the video. Without this the full-screen view came up black,
            // because join() short-circuits and nothing rebound the canvas.
            session.rebindCanvas(canvas)
        } else {
            session.canvasView = canvas
            session.join(deviceId: deviceId, into: canvas)
        }
        return container
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        if session.joinedDeviceId != deviceId, let canvas = session.canvasView {
            session.leave()
            store.attach(session: session, deviceId: deviceId)
            session.join(deviceId: deviceId, into: canvas)
        }
        // Whichever stage matches the current mode takes the video — and it
        // must be re-bound once the canvas actually HAS a size. Binding a
        // zero-sized view renders nothing and never recovers, which is what
        // made the landscape view come up black.
        if store.fullScreen == isFullScreen, let canvas = context.coordinator.canvas {
            let size = canvas.bounds.size
            if size.width > 1, size.height > 1,
               session.canvasView !== canvas || context.coordinator.boundSize != size {
                context.coordinator.boundSize = size
                session.rebindCanvas(canvas)
            }
        }
        if let surface = context.coordinator.surface {
            surface.claimsDrag = store.armed
            surface.aimMode = store.mode == .aim
            if store.videoSize.width > 0, store.videoSize.height > 0 {
                surface.videoAspect = store.videoSize.width / store.videoSize.height
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject {
        weak var surface: TrackpadSurfaceView?
        weak var canvas: UIView?
        weak var reticle: ReticleView?
        /// Size the video was last bound at; a change means re-bind.
        var boundSize: CGSize = .zero

        func showReticle(at point: CGPoint?) {
            guard let reticle else { return }
            guard let point else {
                reticle.isHidden = true
                return
            }
            reticle.isHidden = false
            reticle.center = point
        }
        weak var zoomLayer: UIView?
        var store: MacRemoteControlStore?

        /// AIM magnifier: scale the whole stage about the touched point, so the
        /// thing under the finger becomes big enough to hit. Nothing is
        /// snapshotted — it is the same live video, just enlarged, which keeps
        /// it working with Agora's Metal-backed view.
        static let aimScale: CGFloat = 2.6

        func magnify(around point: CGPoint?) {
            guard let layer = zoomLayer else { return }
            guard let point else {
                UIView.animate(withDuration: 0.16) { layer.transform = .identity }
                store?.zoom = 1
                return
            }
            let k = Self.aimScale
            // Anchor the scale on the touched point: what is under the finger
            // stays under the finger, everything else grows away from it.
            let tx = (1 - k) * (point.x - layer.bounds.midX)
            let ty = (1 - k) * (point.y - layer.bounds.midY)
            let transform = CGAffineTransform(translationX: tx, y: ty).scaledBy(x: k, y: k)
            if layer.transform == .identity {
                UIView.animate(withDuration: 0.12) { layer.transform = transform }
            } else {
                layer.transform = transform
            }
            store?.zoom = k
        }

    }

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        // The session is owned by the sheet, not by this view: leaving is the
        // sheet's job on disappear, so a SwiftUI re-layout cannot drop the call.
    }
}

// MARK: - Control bar

/// Deliberately BELOW the video and finger-sized (≥44pt): the one thing worse
/// than a mis-aimed Mac click is a Mac click that was meant to be a button in
/// our own UI, so the two never share an edge.
@available(iOS 17.0, *)
struct MacControlBar: View {
    @Bindable var control: MacRemoteControlStore
    let pal: AgentPalette

    private var hintBn: String {
        switch control.mode {
        case .aim:
            return "আঙুল রাখুন — জায়গাটা বড় হবে, সরিয়ে ঠিক করুন, ছাড়লেই ক্লিক। চেপে ধরে রাখলে জিনিসটা তুলে টানা যায় (ড্র্যাগ) · দুই আঙুলে ট্যাপ = রাইট-ক্লিক।"
        case .trackpad:
            return "আঙুল সরালে কার্সার সরবে · ট্যাপ = কার্সারের জায়গায় ক্লিক · দুই আঙুল = স্ক্রল · দুই আঙুলে ট্যাপ = রাইট-ক্লিক · চেপে ধরে টানলে ড্র্যাগ"
        case .direct:
            return "সরাসরি মোড: অন্তত ২× জুম করে তবেই ট্যাপ করা যাবে।"
        }
    }

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Button {
                    AlmaAgentHaptics.commit()
                    Task { await control.toggle() }
                } label: {
                    HStack(spacing: 7) {
                        if control.busy {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: control.armed ? "hand.raised.slash.fill" : "hand.point.up.left.fill")
                                .font(.system(size: 13, weight: .semibold))
                        }
                        Text(control.armed ? "কন্ট্রোল বন্ধ" : "কন্ট্রোল চালু")
                            .font(.system(size: 13.5, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .foregroundStyle(control.armed ? Color.red : pal.mutedHi)
                    .background(
                        control.armed ? Color.red.opacity(0.10) : pal.ink.opacity(0.04),
                        in: RoundedRectangle(cornerRadius: 11))
                    .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(
                        control.armed ? Color.red.opacity(0.35) : pal.borderSubtle, lineWidth: 1))
                }
                .disabled(control.busy)
                .accessibilityLabel("Mac রিমোট কন্ট্রোল")

                Button {
                    AlmaAgentHaptics.commit()
                    control.fullScreen = true
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(width: 50, height: 44)
                        .foregroundStyle(pal.mutedHi)
                        .background(pal.ink.opacity(0.04), in: RoundedRectangle(cornerRadius: 11))
                        .overlay(RoundedRectangle(cornerRadius: 11)
                            .strokeBorder(pal.borderSubtle, lineWidth: 1))
                }
                .accessibilityLabel("ফুল স্ক্রিন")

                if control.armed {
                    Picker("", selection: Binding(
                        get: { control.mode },
                        set: { control.mode = $0; AlmaAgentHaptics.selection() })) {
                        Text("নিশানা").tag(MacRemoteControlStore.Mode.aim)
                        Text("ট্র্যাকপ্যাড").tag(MacRemoteControlStore.Mode.trackpad)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 168, height: 44)
                }
            }

            if control.armed {
                HStack(spacing: 10) {
                    Toggle(isOn: Binding(
                        get: { control.twoStepConfirm },
                        set: { control.twoStepConfirm = $0; AlmaAgentHaptics.selection() })) {
                        Text("দুই ধাপে ক্লিক (ছোট টার্গেটে নিরাপদ)")
                            .font(.system(size: 12))
                            .foregroundStyle(pal.mutedHi)
                    }
                    .toggleStyle(.switch)
                    .tint(Color(red: 0.878, green: 0.478, blue: 0.373))
                }
                .frame(minHeight: 44)

                if control.mode == .direct {
                    Text(control.zoom >= MacRemoteControlStore.directTapMinZoom
                         ? String(format: "জুম %.1f× — ট্যাপ করা যাবে", control.zoom)
                         : String(format: "জুম %.1f× — ট্যাপের জন্য ২× দরকার", control.zoom))
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(control.zoom >= MacRemoteControlStore.directTapMinZoom
                                         ? Color.green : pal.muted)
                }

                Text(hintBn)
                    .font(.system(size: 11.5))
                    .foregroundStyle(pal.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            #if DEBUG
            if !control.debugCounters.isEmpty {
                Text(control.debugCounters + " | " + control.agoraEvents)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(pal.mutedHi)
            }
            #endif

            if let status = control.statusBn {
                Text(status)
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(Color.red.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }

            if control.armed {
                MacKeyboardBar(control: control, pal: pal)
            }
        }
    }
}

// MARK: - Keyboard (RC-2)

/// Text goes over as UNICODE, not as keycodes — the owner types Bangla, and a
/// keycode map cannot express it. Whole-field-at-once rather than per
/// keystroke: an IME composes Bangla over several taps, and streaming those
/// half-formed characters to the Mac would garble every word.
@available(iOS 17.0, *)
struct MacKeyboardBar: View {
    @Bindable var control: MacRemoteControlStore
    let pal: AgentPalette
    @State private var text = ""
    @FocusState private var focused: Bool

    private struct Shortcut: Identifiable {
        let id = UUID()
        let label: String
        let key: String
        let mods: [String]
    }

    private let shortcuts: [Shortcut] = [
        .init(label: "⏎", key: "enter", mods: []),
        .init(label: "esc", key: "esc", mods: []),
        .init(label: "⇥", key: "tab", mods: []),
        .init(label: "⌘C", key: "c", mods: ["cmd"]),
        .init(label: "⌘V", key: "v", mods: ["cmd"]),
        .init(label: "⌘Z", key: "z", mods: ["cmd"]),
        .init(label: "◀︎", key: "left", mods: []),
        .init(label: "▶︎", key: "right", mods: []),
        .init(label: "▲", key: "up", mods: []),
        .init(label: "▼", key: "down", mods: []),
    ]

    var body: some View {
        VStack(spacing: 7) {
            HStack(spacing: 7) {
                TextField("Mac-এ লিখুন…", text: $text, axis: .horizontal)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focused)
                    .font(.system(size: 13.5))
                    .padding(.horizontal, 11)
                    .frame(minHeight: 44)
                    .background(pal.ink.opacity(0.04), in: RoundedRectangle(cornerRadius: 11))
                    .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(pal.borderSubtle, lineWidth: 1))
                    .onSubmit(send)

                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 21, weight: .semibold))
                        .frame(width: 44, height: 44)
                        .foregroundStyle(text.isEmpty ? pal.muted : Color(red: 0.878, green: 0.478, blue: 0.373))
                }
                .disabled(text.isEmpty)
                .accessibilityLabel("Mac-এ লেখা পাঠান")
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 7) {
                    ForEach(shortcuts) { s in
                        Button {
                            control.sendKey(s.key, mods: s.mods)
                        } label: {
                            Text(s.label)
                                .font(.system(size: 13, weight: .semibold))
                                .frame(minWidth: 46, minHeight: 44)
                                .foregroundStyle(pal.mutedHi)
                                .background(pal.ink.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10)
                                    .strokeBorder(pal.borderSubtle, lineWidth: 1))
                        }
                        .accessibilityLabel(s.label)
                    }
                }
                .padding(.horizontal, 1)
            }
        }
    }

    private func send() {
        let payload = text
        guard !payload.isEmpty else { return }
        // The wire caps a message at 240 characters and 1 KB; Bangla is three
        // UTF-8 bytes a character, so a pasted paragraph would be silently
        // dropped by the Mac's decoder. Split it and only clear the field for
        // the parts that actually left (Codex P2).
        text = ""
        Task {
            let sent = await control.sendText(payload)
            if !sent {
                text = payload // nothing was lost silently — it comes back
                AlmaAgentHaptics.error()
            } else {
                AlmaAgentHaptics.light()
            }
        }
    }
}

@available(iOS 17.0, *)
extension TrackpadSurfaceView: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ g: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        // Direct mode's pinch/pan live on the container and must still work.
        true
    }
}

// MARK: - Landscape full-screen control

/// The owner's ask, live on the first session: "let me see it like a full
/// video, landscape, so I can drive the big screen smoothly." A 3440-wide Mac
/// rendered into a 230pt strip is not a surface you can aim at — here the same
/// stage fills the phone, the chrome shrinks to one translucent bar, and the
/// bar sits along the bottom edge so it never competes with the video.
@available(iOS 17.0, *)
struct MacScreenFullScreen: View {
    let deviceId: String
    let session: MacScreenSession
    @Bindable var control: MacRemoteControlStore
    @Environment(\.dismiss) private var dismiss
    @State private var showKeys = false
    @State private var typed = ""
    @FocusState private var typing: Bool

    var body: some View {
        GeometryReader { geo in
            // Trust the BOX, not the system. If iOS rotated the window we are
            // already landscape and rotate nothing; if it refused (a presented
            // SwiftUI controller can keep its cached orientations, and the
            // simulator reports landscape while still drawing portrait), we
            // turn the content ourselves. Either way the owner gets the wide
            // view he asked for.
            let rotate = geo.size.width < geo.size.height
            ZStack {
                Color.black.ignoresSafeArea()

                stack(size: rotate ? CGSize(width: geo.size.height, height: geo.size.width) : geo.size)
                    .frame(width: rotate ? geo.size.height : geo.size.width,
                           height: rotate ? geo.size.width : geo.size.height)
                    // -90, not +90: with the phone turned the natural way for
                    // video (home indicator to the right) this is the upright
                    // direction — checked on screen, not reasoned about.
                    .rotationEffect(rotate ? .degrees(-90) : .zero)
                    .position(x: geo.size.width / 2, y: geo.size.height / 2)
            }
            .ignoresSafeArea()
        }
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .onAppear {
            control.fullScreen = true
            // The APP does not rotate — only this view's content does. The
            // owner was explicit: he wants the Mac wide, not his chat, his
            // dashboard and everything else turning sideways with it. Pinning
            // the window to portrait also makes the rotation deterministic:
            // the content is always turned exactly once, by us.
            AppDelegate.orientationLock = .portrait
        }
        .onDisappear {
            control.fullScreen = false
            AppDelegate.orientationLock = .allButUpsideDown
        }
    }

    /// The rotatable content: video plus its chrome, laid out for a landscape
    /// box whatever the system decided to do with the window.
    private func stack(size: CGSize) -> some View {
        ZStack {
            MacScreenStage(deviceId: deviceId, session: session, store: control, isFullScreen: true)
            VStack {
                Spacer()
                if showKeys { keyboardStrip }
                controlStrip
            }
            .padding(.bottom, 14)
            // The bar gets out of the way the moment a finger touches the
            // video: nothing of ours may cover what the owner is aiming at.
            .opacity(control.interacting ? 0 : 1)
            .animation(.easeOut(duration: 0.15), value: control.interacting)
        }
    }

    private var controlStrip: some View {
        HStack(spacing: 10) {
            barButton(systemName: "xmark", label: "বন্ধ") {
                dismiss()
            }
            barButton(systemName: control.armed ? "hand.raised.slash.fill" : "hand.point.up.left.fill",
                      label: control.armed ? "কন্ট্রোল বন্ধ" : "কন্ট্রোল চালু",
                      tint: control.armed ? .red : nil) {
                Task { await control.toggle() }
            }
            if control.armed {
                barButton(systemName: "keyboard", label: "কীবোর্ড", tint: showKeys ? .orange : nil) {
                    showKeys.toggle()
                    typing = showKeys
                }
                barButton(systemName: control.mode == .aim ? "scope" : "rectangle.and.hand.point.up.left",
                          label: control.mode == .aim ? "নিশানা" : "ট্র্যাকপ্যাড") {
                    control.mode = control.mode == .aim ? .trackpad : .aim
                }
            }
            if let status = control.statusBn {
                Text(status)
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(.red)
                    .lineLimit(2)
                    .frame(maxWidth: 220)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(.white.opacity(0.12), lineWidth: 1))
    }

    private var keyboardStrip: some View {
        HStack(spacing: 8) {
            TextField("Mac-এ লিখুন…", text: $typed)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($typing)
                .font(.system(size: 14))
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
                .frame(maxWidth: 420)
                .onSubmit(sendTyped)
            Button(action: sendTyped) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .frame(width: 44, height: 44)
            }
            .disabled(typed.isEmpty)
            ForEach(["enter", "esc"], id: \.self) { key in
                Button {
                    control.sendKey(key)
                } label: {
                    Text(key == "enter" ? "⏎" : "esc")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(width: 50, height: 44)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 11))
                }
            }
        }
        .padding(.bottom, 8)
    }

    private func sendTyped() {
        let payload = typed
        guard !payload.isEmpty else { return }
        typed = ""
        Task {
            if await !control.sendText(payload) { typed = payload }
        }
    }

    private func barButton(systemName: String, label: String, tint: Color? = nil,
                           action: @escaping () -> Void) -> some View {
        Button {
            AlmaAgentHaptics.light()
            action()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: systemName).font(.system(size: 14, weight: .semibold))
                Text(label).font(.system(size: 12.5, weight: .semibold))
            }
            .frame(minHeight: 44)
            .padding(.horizontal, 10)
            .foregroundStyle(tint ?? .primary)
        }
        .accessibilityLabel(label)
    }

}
