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
import UIKit

// MARK: - Server contracts

/// POST /api/assistant/office/intercom/call-token → { appId, channel?, token, uid }
private struct IntercomTokenResp: Decodable {
    let appId: String
    let token: String
    let uid: UInt
    let expiresAt: String?
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        appId = try c.decode(String.self, forKey: .appId)
        token = try c.decode(String.self, forKey: .token)
        uid = (try? c.decodeIfPresent(UInt.self, forKey: .uid)) ?? 0
        expiresAt = try? c.decodeIfPresent(String.self, forKey: .expiresAt)
    }
    enum CodingKeys: String, CodingKey { case appId, token, uid, expiresAt }
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
    let recentCalls: [IntercomRecentCall]
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        liveChannel = (try? c.decodeIfPresent(String.self, forKey: .liveChannel)) ?? ""
        staff = (try? c.decodeIfPresent([IntercomStaff].self, forKey: .staff)) ?? []
        let broadcasts = (try? c.decodeIfPresent([IntercomRecentCall].self, forKey: .broadcasts)) ?? []
        recentCalls = Array(broadcasts.filter { $0.kind == "call" }.suffix(12).reversed())
    }
    enum CodingKeys: String, CodingKey { case liveChannel, staff, broadcasts }
}

struct IntercomRecentCall: Decodable, Identifiable {
    let id: String
    let kind: String
    let callerName: String?
    let outgoingByMe: Bool
    let createdAt: String
    let endedAt: String?
    let endedReason: String?
    let canonicalState: String?
    let callDurationSec: Int?
}

private struct CanonicalCallEnvelope: Decodable { let call: CanonicalCallSnapshot }
private struct CanonicalCallSnapshot: Decodable {
    let id: String
    let state: String
    let version: Int
    let terminalReason: String?
    let direction: String
    let channel: String
    let uid: UInt?
    let ringExpiresAt: String
    let maxEndsAt: String
}

private struct CanonicalTransitionResponse: Decodable {
    let ok: Bool?
    let state: String?
    let version: Int?
    let alreadyApplied: Bool?
    let terminalReason: String?
}

/// A narrow lease for app-owned, non-CallKit AVAudioSession mutations. Cleanup
/// restores the captured configuration only while the session still exactly
/// matches this owner, so a newer CallKit/Agora owner is never overwritten.
private struct IntercomAudioSessionLease {
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

    func updatingOwnedConfiguration(
        category: AVAudioSession.Category,
        mode: AVAudioSession.Mode,
        options: AVAudioSession.CategoryOptions
    ) -> Self {
        Self(
            previousCategory: previousCategory,
            previousMode: previousMode,
            previousOptions: previousOptions,
            ownedCategory: category,
            ownedMode: mode,
            ownedOptions: options)
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

/// Immutable authority carried by one logical Agora join. Agora's engine
/// delegate does not put a channel on most callbacks, so a channel string in
/// mutable coordinator state is not enough to distinguish a late callback from
/// the channel that produced it. Every delegate proxy captures one of these.
struct AlmaAgoraJoinIdentity: Equatable {
    let epoch: UInt64
    let engineIdentity: ObjectIdentifier
    let channel: String
    let admissionToken: AlmaCallAudioAdmission.Token
    let operationGeneration: UInt64
}

/// Small, deterministic epoch fence kept separate from the SDK so its stale
/// callback and same-channel idempotence rules can be unit tested.
struct AlmaAgoraJoinEpochFence {
    private(set) var active: AlmaAgoraJoinIdentity?
    private var nextEpoch: UInt64 = 0

    mutating func activate(
        engineIdentity: ObjectIdentifier,
        channel: String,
        admissionToken: AlmaCallAudioAdmission.Token,
        operationGeneration: UInt64
    ) -> AlmaAgoraJoinIdentity {
        if let active,
           active.engineIdentity == engineIdentity,
           active.channel == channel,
           active.admissionToken == admissionToken,
           active.operationGeneration == operationGeneration {
            return active
        }
        precondition(active == nil, "Agora channel replacement must finish leave before rejoin")
        nextEpoch &+= 1
        let identity = AlmaAgoraJoinIdentity(
            epoch: nextEpoch,
            engineIdentity: engineIdentity,
            channel: channel,
            admissionToken: admissionToken,
            operationGeneration: operationGeneration)
        active = identity
        return identity
    }

    @discardableResult
    mutating func retire(_ identity: AlmaAgoraJoinIdentity) -> Bool {
        guard active == identity else { return false }
        active = nil
        return true
    }

    func requiresSerializedLeave(
        engineIdentity: ObjectIdentifier,
        channel: String,
        admissionToken: AlmaCallAudioAdmission.Token,
        operationGeneration: UInt64
    ) -> Bool {
        guard let active else { return false }
        return active.engineIdentity != engineIdentity
            || active.channel != channel
            || active.admissionToken != admissionToken
            || active.operationGeneration != operationGeneration
    }

    func accepts(
        _ identity: AlmaAgoraJoinIdentity,
        engineIdentity: ObjectIdentifier,
        reportedChannel: String? = nil
    ) -> Bool {
        guard active == identity,
              identity.engineIdentity == engineIdentity
        else { return false }
        return reportedChannel == nil || reportedChannel == identity.channel
    }
}

enum AlmaAgoraJoinSubmissionDisposition: Equatable {
    case accepted
    case failedRetired
    case staleFailureIgnored
}

struct AlmaAgoraJoinSubmissionTransition {
    static func apply(
        result: Int32,
        identity: AlmaAgoraJoinIdentity,
        fence: inout AlmaAgoraJoinEpochFence
    ) -> AlmaAgoraJoinSubmissionDisposition {
        guard result < 0 else { return .accepted }
        return fence.retire(identity) ? .failedRetired : .staleFailureIgnored
    }
}

enum AlmaAgoraChannelSwitchOperation: Equatable {
    case mutePublication
    case retireAuthority
    case leaveChannel
}

struct AlmaAgoraChannelSwitchOperationPlan {
    static let privacyOrdered: [AlmaAgoraChannelSwitchOperation] = [
        .mutePublication,
        .retireAuthority,
        .leaveChannel,
    ]

    static func performPrivacyBoundary(
        _ operation: (AlmaAgoraChannelSwitchOperation) -> Void
    ) {
        privacyOrdered.forEach(operation)
    }
}

/// `leaveChannel` is asynchronous in Agora 4.6.2. The completion block and the
/// SDK's disconnected/did-leave callbacks race legitimately, so this one-shot
/// barrier accepts the first confirmation and supports concurrent join callers
/// waiting on the same in-flight channel switch.
private final class AgoraChannelLeaveBarrier: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Bool?
    private var waiters: [CheckedContinuation<Bool, Never>] = []

    func wait() async -> Bool {
        await withCheckedContinuation { continuation in
            let completed: Bool? = lock.withLock {
                if let result { return result }
                waiters.append(continuation)
                return nil
            }
            if let completed { continuation.resume(returning: completed) }
        }
    }

    func finish(confirmed: Bool) {
        let continuations: [CheckedContinuation<Bool, Never>] = lock.withLock {
            guard result == nil else { return [] }
            result = confirmed
            defer { waiters.removeAll() }
            return waiters
        }
        continuations.forEach { $0.resume(returning: confirmed) }
    }
}

// MARK: - Manager

@available(iOS 17.0, *)
@Observable
final class OfficeCallCoordinator: NSObject {
    static let shared = OfficeCallCoordinator()

    /// `ringing` = a 1:1 call is placed/answered but the other party hasn't joined yet
    /// (WhatsApp-style — no call timer until both are actually on the channel).
    enum Mode: Equatable { case idle, listening, broadcasting, calling, ringing, reconnecting }
    enum Direction: Equatable { case incoming, outgoing }
    private enum AudioTeardownOwner { case appOwned, callKit }
    private struct PendingAgoraChannelSwitch {
        let identity: AlmaAgoraJoinIdentity
        let barrier: AgoraChannelLeaveBarrier
    }

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
    var recentCalls: [IntercomRecentCall] = []
    var recording = false             // PTT voice-note is capturing right now
    var callPeer = "স্টাফ"            // who we're talking to (shown on the call screen)
    var activeCallId: String?
    var callDirection: Direction?
    var canonicalState = ""
    var speakerEnabled = false
    var audioRoute = "iPhone"
    var reconnectSeconds = 0

    var hasActiveCall: Bool {
        activeCallId != nil && (mode == .ringing || mode == .calling || mode == .reconnecting)
    }

    var isPTTActiveOrStarting: Bool { recording || pttStarting || pttPressActive }
    private(set) var audioTeardownPending = false

    // IOSP-4 crash fix: `engine`'s type lives in the dynamically-linked
    // AgoraRtcKit.framework. On an @Observable class, a stored property is read
    // through generated keypath machinery — and the Swift runtime cannot demangle
    // `AgoraRtcEngineKit?`'s keypath from that framework, so any tracked read
    // (e.g. CallKitVoIP.providerDidReset → leave() reading `engine`) SIGTRAPs at
    // launch when a stale CallKit reset fires (see docs/proofs/iosp0/launch-crash-
    // diagnosis.md). These are private implementation handles that never drive the
    // UI, so exclude them from Observation — no keypath codegen, no crash.
    // (main's build-75 landed the same fix for `engine` only — this is the superset.)
    @ObservationIgnored private var engine: AgoraRtcEngineKit?
    @ObservationIgnored private var appId: String?
    @ObservationIgnored private var channel: String?
    @ObservationIgnored private var currentCallVersion: Int?
    @ObservationIgnored private var callTimer: Timer?
    @ObservationIgnored private var ringTimer: Timer?
    @ObservationIgnored private var reconcileTimer: Timer?
    @ObservationIgnored private var reconnectTimer: Timer?
    @ObservationIgnored private var reconnectDeadline: Date?
    @ObservationIgnored private var tokenExpiry: Date?
    @ObservationIgnored private var joinStartedAt: Date?
    @ObservationIgnored private var lastQualityTelemetryAt: Date?
    @ObservationIgnored private var reconnectCount = 0
    @ObservationIgnored private var remoteUids = Set<UInt>()   // remote parties currently on the call channel
    private let ringtone = IntercomRingtone()   // ringback (caller) + incoming ring (callee)
    @ObservationIgnored private var handledCallIds = Set<String>()  // call broadcasts we've already surfaced
    // PTT persistent voice-note capture (separate from the ephemeral live channel).
    private var recorder: AVAudioRecorder?
    private var recordURL: URL?
    private var recordStart: Date?
    private var pttAudioSessionLease: IntercomAudioSessionLease?
    private var officeAudioSessionLease: IntercomAudioSessionLease?
    @ObservationIgnored private var pttRequestGeneration: UInt64 = 0
    @ObservationIgnored private var pttStarting = false
    @ObservationIgnored private var pttPressActive = false
    @ObservationIgnored private var safetyObserverTokens: [NSObjectProtocol] = []
    @ObservationIgnored private var mediaOperationGeneration: UInt64 = 0
    @ObservationIgnored private var audioTeardownGeneration: UInt64 = 0
    @ObservationIgnored private var audioTeardownOwner: AudioTeardownOwner?
    @ObservationIgnored private var officeAudioConfigured = false
    @ObservationIgnored private var agoraJoinSubmitted = false
    @ObservationIgnored private var agoraJoinFence = AlmaAgoraJoinEpochFence()
    @ObservationIgnored private var agoraDelegateProxy: AgoraJoinDelegateProxy?
    @ObservationIgnored private var pendingAgoraChannelSwitch: PendingAgoraChannelSwitch?
    @ObservationIgnored private var officeCallAudioAdmissionToken: AlmaCallAudioAdmission.Token?
    @ObservationIgnored private var officeCallAudioAdmissionOperation: UInt64?
    @ObservationIgnored private var appOwnedAudioTeardownAdmissionToken: AlmaCallAudioAdmission.Token?
    @ObservationIgnored private var pttCallAudioAdmissionToken: AlmaCallAudioAdmission.Token?
    @ObservationIgnored private var systemAudioPreemptionPending = false
    @ObservationIgnored private var systemAudioPreemptionEndReceipt: CallKitEndReceipt?
    @ObservationIgnored private var callKitAudioTeardownAdmissionToken: AlmaCallAudioAdmission.Token?
    @ObservationIgnored private var callKitAudioTeardownCallID: String?

    private override init() {
        super.init()
        let center = NotificationCenter.default
        safetyObserverTokens.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] note in
            MainActor.assumeIsolated { self?.handleAudioRouteChanged(note) }
        })
        safetyObserverTokens.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            MainActor.assumeIsolated { self?.handleAudioInterruption(note) }
        })
        for name in [
            UIApplication.willResignActiveNotification,
            UIApplication.didEnterBackgroundNotification,
            AVAudioSession.mediaServicesWereLostNotification,
            AVAudioSession.mediaServicesWereResetNotification,
        ] {
            safetyObserverTokens.append(center.addObserver(
                forName: name, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.cancelPTTWithoutUpload() }
            })
        }
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /// Load the shared live channel + staff roster (owner UI uses the roster for calls).
    @MainActor
    func loadFeed() async {
        do {
            let feed: IntercomFeedLite = try await AlmaAPI.shared.get("/api/assistant/office/intercom")
            roster = feed.staff
            recentCalls = feed.recentCalls
        } catch {
            // A missing feed shouldn't block joining — the channel is deterministic below.
        }
    }

    /// Join the shared walkie-talkie channel. Owner → broadcaster (open mic), staff → listener.
    @MainActor
    func joinLive(asBroadcaster: Bool) async {
        guard !audioTeardownPending else {
            error = "আগের অডিও সেশন বন্ধ হচ্ছে — একটু পরে আবার চেষ্টা করুন"
            return
        }
        let operationGeneration = mediaOperationGeneration &+ 1
        guard AlmaLiveVoicePreviewTakeoverRelay.shared.stopAndRestoreBeforeAudioTakeover() else {
            error = "আগের অডিও সেশন বন্ধ হচ্ছে — একটু পরে আবার চেষ্টা করুন"
            return
        }
        guard let admissionToken = claimOfficeCallAudio(
            .officeMedia(operation: operationGeneration, callID: nil))
        else {
            error = "আরেকটি কল বা অডিও সেশন চলছে"
            return
        }
        mediaOperationGeneration = operationGeneration
        error = nil
        statusText = "সংযোগ হচ্ছে…"
        do {
            if asBroadcaster {
                try await ensureMicPermission()
                try requireCurrentMediaOperation(
                    operationGeneration,
                    admissionToken: admissionToken)
            }
            let ch = try await resolveLiveChannel()
            try requireCurrentMediaOperation(
                operationGeneration,
                admissionToken: admissionToken)
            try await join(
                channel: ch,
                publishMic: asBroadcaster,
                operationGeneration: operationGeneration,
                admissionToken: admissionToken)
            try requireCurrentMediaOperation(
                operationGeneration,
                admissionToken: admissionToken)
            mode = asBroadcaster ? .broadcasting : .listening
            micMuted = false
            statusText = asBroadcaster ? "লাইভ — আপনি বলছেন" : "লাইভ — শুনছেন"
        } catch is CancellationError {
            stopOfficeCallAudioIfOwned(admissionToken)
            return
        } catch {
            guard operationGeneration == mediaOperationGeneration else {
                stopOfficeCallAudioIfOwned(admissionToken)
                return
            }
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
    func startCall(
        channel ch: String,
        outgoing: Bool,
        admissionToken suppliedAdmissionToken: AlmaCallAudioAdmission.Token? = nil
    ) async {
        guard !audioTeardownPending else { return }
        guard let callId = Self.callId(from: ch) else { return }
        let candidateOperationGeneration = mediaOperationGeneration &+ 1
        if let suppliedAdmissionToken {
            guard AlmaCallAudioAdmission.shared.acceptsMediaMutation(
                    suppliedAdmissionToken),
                  officeCallAudioAdmissionToken == nil
                    || officeCallAudioAdmissionToken == suppliedAdmissionToken
            else { return }
            // Adopt the system reservation before any fallible local handoff so
            // a pre-media failure can still clear the exact CallKit teardown.
            officeCallAudioAdmissionToken = suppliedAdmissionToken
            officeCallAudioAdmissionOperation = candidateOperationGeneration
            mediaOperationGeneration = candidateOperationGeneration
            activeCallId = callId
            callDirection = outgoing ? .outgoing : .incoming
        }
        guard AlmaLiveVoicePreviewTakeoverRelay.shared.stopAndRestoreBeforeAudioTakeover() else {
            if let suppliedAdmissionToken {
                stopOfficeCallAudioIfOwned(suppliedAdmissionToken)
            }
            error = "আগের অডিও সেশন বন্ধ হচ্ছে — একটু পরে আবার চেষ্টা করুন"
            return
        }
        let admissionToken: AlmaCallAudioAdmission.Token
        let operationGeneration: UInt64
        if let suppliedAdmissionToken {
            admissionToken = suppliedAdmissionToken
            operationGeneration = candidateOperationGeneration
            officeCallAudioAdmissionOperation = operationGeneration
        } else if let existingToken = officeCallAudioAdmissionToken,
                  let existingOperation = officeCallAudioAdmissionOperation,
                  AlmaCallAudioAdmission.shared.acceptsMediaMutation(existingToken),
                  AlmaCallAudioAdmission.shared.activeOwner == .officeMedia(
                    operation: existingOperation,
                    callID: callId) {
            // Legacy in-app ringing already owns the exact call media token.
            // Answering advances that same operation without releasing a gap in
            // which preview/another call could mutate AVAudioSession.
            admissionToken = existingToken
            operationGeneration = existingOperation
        } else {
            guard let claimed = claimOfficeCallAudio(
                .officeMedia(operation: candidateOperationGeneration, callID: callId))
            else {
                error = "আরেকটি কল বা অডিও সেশন চলছে"
                return
            }
            admissionToken = claimed
            operationGeneration = candidateOperationGeneration
        }
        mediaOperationGeneration = operationGeneration
        activeCallId = callId
        callDirection = outgoing ? .outgoing : .incoming
        joinStartedAt = Date()
        emitTelemetry(outgoing ? "client.join_started" : "client.answer_pressed", state: "connecting")
        if !outgoing { emitTelemetry("client.join_started", state: "connecting") }
        error = nil
        mode = .ringing
        remoteUids.removeAll()
        callSeconds = 0
        statusText = outgoing ? "রিং হচ্ছে…" : "কল ধরছেন…"
        ringtone.stop()                          // any incoming ring stops the moment we act
        do {
            try await ensureMicPermission()
            try requireCurrentMediaOperation(
                operationGeneration,
                expectedCallID: callId,
                admissionToken: admissionToken)
            if !outgoing {
                guard await transitionCanonical(to: "ANSWERED") else {
                    throw IntercomError.canonicalRejected
                }
                try requireCurrentMediaOperation(
                    operationGeneration,
                    expectedCallID: callId,
                    admissionToken: admissionToken)
                guard await transitionCanonical(to: "CONNECTING") else {
                    throw IntercomError.canonicalRejected
                }
                try requireCurrentMediaOperation(
                    operationGeneration,
                    expectedCallID: callId,
                    admissionToken: admissionToken)
            }
            try await join(
                channel: ch,
                publishMic: true,
                operationGeneration: operationGeneration,
                expectedCallID: callId,
                admissionToken: admissionToken)
            try requireCurrentMediaOperation(
                operationGeneration,
                expectedCallID: callId,
                admissionToken: admissionToken)
            micMuted = false
            startCanonicalReconciliation()
            if outgoing {
                startRingTimeout()               // "কেউ ধরেনি" if unanswered
                ringtone.play(.ringback)         // caller hears the soft ring-back tone
            }
        } catch is CancellationError {
            stopOfficeCallAudioIfOwned(admissionToken)
            return
        } catch {
            guard operationGeneration == mediaOperationGeneration,
                  activeCallId?.caseInsensitiveCompare(callId) == .orderedSame
            else {
                stopOfficeCallAudioIfOwned(admissionToken)
                return
            }
            self.error = message(for: error)
            emitTelemetry("client.media_error", state: "error", detail: message(for: error))
            statusText = ""
            let receipt = CallKitEndReceipt(
                callId: callId,
                reason: "FAILED",
                expectedVersion: currentCallVersion)
            leave()
            if suppliedAdmissionToken != nil {
                // CXStart/CXAnswer must resolve without waiting on canonical
                // network latency. The immutable receipt was captured only after
                // the local mic/Agora graph crossed its terminal boundary.
                Task { @MainActor [weak self] in
                    await self?.finishCallKitEndOnServer(receipt)
                }
            } else {
                await finishCallKitEndOnServer(receipt)
            }
        }
    }

    /// Owner rings ONE staff: create a call broadcast (pushes the staff) then join itc_<id>.
    /// We RING (no timer) until the staff actually joins the channel.
    @MainActor
    func ownerCall(staffId: String) async {
        let operationGeneration = mediaOperationGeneration &+ 1
        guard AlmaLiveVoicePreviewTakeoverRelay.shared.stopAndRestoreBeforeAudioTakeover() else {
            error = "আগের অডিও সেশন বন্ধ হচ্ছে — একটু পরে আবার চেষ্টা করুন"
            return
        }
        guard let admissionToken = claimOfficeCallAudio(
            .officeIntent(operation: operationGeneration, callID: nil))
        else {
            error = "আরেকটি কল বা অডিও সেশন চলছে"
            return
        }
        mediaOperationGeneration = operationGeneration
        error = nil
        statusText = "কল দিচ্ছি…"
        struct Body: Encodable {
            let kind = "call"
            let targetStaffId: String
            let idempotencyKey: String
        }
        struct Resp: Decodable { let id: String? }
        callPeer = roster.first { $0.id == staffId }?.name ?? "স্টাফ"
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/intercom",
                body: Body(targetStaffId: staffId, idempotencyKey: UUID().uuidString))
            guard let id = r.id, !id.isEmpty else { throw IntercomError.callFailed }
            guard !Task.isCancelled,
                  operationGeneration == mediaOperationGeneration,
                  AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken),
                  AlmaCallAudioAdmission.shared.transition(
                    admissionToken,
                    to: .officeIntent(
                        operation: operationGeneration,
                        callID: id.lowercased()))
            else {
                stopOfficeCallAudioIfOwned(admissionToken)
                await finishCallKitEndOnServer(.init(
                    callId: id.lowercased(),
                    reason: "CANCELLED",
                    expectedVersion: nil))
                return
            }
            activeCallId = id.lowercased()
            callDirection = .outgoing
            canonicalState = "RINGING"
            guard await refreshCanonical(
                callId: id,
                expectedMediaOperationGeneration: operationGeneration)
            else { throw IntercomError.canonicalRejected }
            try requireCurrentMediaOperation(
                operationGeneration,
                expectedCallID: id,
                admissionToken: admissionToken)
            try await CallKitVoIP.shared.startOutgoing(
                callId: id,
                channel: "itc_\(id)",
                peer: callPeer,
                admissionToken: admissionToken)
            guard !Task.isCancelled,
                  activeCallId?.caseInsensitiveCompare(id) == .orderedSame,
                  AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken)
            else {
                CallKitVoIP.shared.cancelReservedOutgoingCall(callId: id)
                stopOfficeCallAudioIfOwned(admissionToken)
                await finishCallKitEndOnServer(.init(
                    callId: id.lowercased(),
                    reason: "CANCELLED",
                    expectedVersion: currentCallVersion))
                return
            }
        } catch is CancellationError {
            stopOfficeCallAudioIfOwned(admissionToken)
            return
        } catch {
            guard operationGeneration == mediaOperationGeneration else {
                stopOfficeCallAudioIfOwned(admissionToken)
                return
            }
            self.error = message(for: error)
            statusText = ""
            if let callId = activeCallId {
                let receipt = CallKitEndReceipt(
                    callId: callId,
                    reason: "FAILED",
                    expectedVersion: currentCallVersion)
                leave()
                await finishCallKitEndOnServer(receipt)
            } else {
                leave()
            }
        }
    }

    /// Staff → owner uses the same canonical create route; the server resolves the
    /// business owner and the native CallKit path owns the complete lifecycle.
    @MainActor
    func staffCallOwner() async {
        let operationGeneration = mediaOperationGeneration &+ 1
        guard AlmaLiveVoicePreviewTakeoverRelay.shared.stopAndRestoreBeforeAudioTakeover() else {
            error = "আগের অডিও সেশন বন্ধ হচ্ছে — একটু পরে আবার চেষ্টা করুন"
            return
        }
        guard let admissionToken = claimOfficeCallAudio(
            .officeIntent(operation: operationGeneration, callID: nil))
        else {
            error = "আরেকটি কল বা অডিও সেশন চলছে"
            return
        }
        mediaOperationGeneration = operationGeneration
        error = nil
        statusText = "কল দিচ্ছি…"
        callPeer = "বস — মারুফ"
        struct Body: Encodable { let kind = "call"; let idempotencyKey: String }
        struct Resp: Decodable { let id: String? }
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/intercom",
                body: Body(idempotencyKey: UUID().uuidString))
            guard let id = r.id, !id.isEmpty else { throw IntercomError.callFailed }
            guard !Task.isCancelled,
                  operationGeneration == mediaOperationGeneration,
                  AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken),
                  AlmaCallAudioAdmission.shared.transition(
                    admissionToken,
                    to: .officeIntent(
                        operation: operationGeneration,
                        callID: id.lowercased()))
            else {
                stopOfficeCallAudioIfOwned(admissionToken)
                await finishCallKitEndOnServer(.init(
                    callId: id.lowercased(),
                    reason: "CANCELLED",
                    expectedVersion: nil))
                return
            }
            activeCallId = id.lowercased()
            callDirection = .outgoing
            canonicalState = "RINGING"
            guard await refreshCanonical(
                callId: id,
                expectedMediaOperationGeneration: operationGeneration)
            else { throw IntercomError.canonicalRejected }
            try requireCurrentMediaOperation(
                operationGeneration,
                expectedCallID: id,
                admissionToken: admissionToken)
            try await CallKitVoIP.shared.startOutgoing(
                callId: id,
                channel: "itc_\(id)",
                peer: callPeer,
                admissionToken: admissionToken)
            guard !Task.isCancelled,
                  activeCallId?.caseInsensitiveCompare(id) == .orderedSame,
                  AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken)
            else {
                CallKitVoIP.shared.cancelReservedOutgoingCall(callId: id)
                stopOfficeCallAudioIfOwned(admissionToken)
                await finishCallKitEndOnServer(.init(
                    callId: id.lowercased(),
                    reason: "CANCELLED",
                    expectedVersion: currentCallVersion))
                return
            }
        } catch is CancellationError {
            stopOfficeCallAudioIfOwned(admissionToken)
            return
        } catch {
            guard operationGeneration == mediaOperationGeneration else {
                stopOfficeCallAudioIfOwned(admissionToken)
                return
            }
            self.error = message(for: error)
            statusText = ""
            if let callId = activeCallId {
                let receipt = CallKitEndReceipt(
                    callId: callId,
                    reason: "FAILED",
                    expectedVersion: currentCallVersion)
                leave()
                await finishCallKitEndOnServer(receipt)
            } else {
                leave()
            }
        }
    }

    @MainActor
    func toggleMute() {
        let nextMuted = !micMuted
        if !nextMuted, !acceptsOfficeMediaMutation() {
            micMuted = true
            engine?.muteLocalAudioStream(true)
            return
        }
        micMuted = nextMuted
        engine?.muteLocalAudioStream(nextMuted)
    }

    /// Set mute explicitly (CallKit's mute button routes here so the two UIs agree).
    @MainActor func setMuted(_ muted: Bool) {
        if !muted, !acceptsOfficeMediaMutation() {
            micMuted = true
            engine?.muteLocalAudioStream(true)
            return
        }
        micMuted = muted
        engine?.muteLocalAudioStream(muted)
    }

    @MainActor
    func ownsCallIntent(callId: String, channel expectedChannel: String) -> Bool {
        guard activeCallId?.caseInsensitiveCompare(callId) == .orderedSame else {
            return false
        }
        return channel == nil || channel == expectedChannel
    }

    struct CallKitEndReceipt: Sendable {
        let callId: String
        let reason: String
        let expectedVersion: Int?
    }

    /// End local media synchronously for a CallKit end action. Network truth is
    /// posted separately so an offline request can never keep the mic/Agora graph
    /// alive or delay CXEndCallAction fulfilment.
    @MainActor
    func takeCallKitEnd(
        callId: String,
        requestedReason: String?
    ) -> CallKitEndReceipt? {
        guard activeCallId?.caseInsensitiveCompare(callId) == .orderedSame else {
            return nil
        }
        let receipt = CallKitEndReceipt(
            callId: callId.lowercased(),
            reason: requestedReason ?? localEndReason(),
            expectedVersion: currentCallVersion)
        engine?.muteLocalAudioStream(true)
        leave()
        return receipt
    }

    @MainActor
    func finishCallKitEndOnServer(_ receipt: CallKitEndReceipt) async {
        struct Body: Encodable {
            let state: String
            let reason: String?
            let expectedVersion: Int?
        }
        let _: CanonicalTransitionResponse? = try? await AlmaAPI.shared.send(
            "POST", "/api/assistant/office/calls/\(receipt.callId)/transition",
            body: Body(
                state: "ENDED",
                reason: receipt.reason,
                expectedVersion: receipt.expectedVersion))
    }

    /// Remote cancel must stop the matching local media path immediately; the
    /// canonical reconciliation leg remains best-effort and must not gate privacy.
    @MainActor
    func remoteCallEndedLocally(callId: String) {
        guard activeCallId?.caseInsensitiveCompare(callId) == .orderedSame else { return }
        engine?.muteLocalAudioStream(true)
        leave()
    }

    /// CallKit finished activating the shared audio session — make sure Agora routes
    /// call audio to the loud speaker (CallKit already owns activation/teardown).
    @MainActor func audioSessionActivated() {
        guard acceptsOfficeMediaMutation() else { return }
        engine?.setEnableSpeakerphone(speakerEnabled)
        updateAudioRoute()
    }

    @MainActor
    func audioSessionDeactivated(
        admissionToken: AlmaCallAudioAdmission.Token
    ) {
        guard audioTeardownPending,
              audioTeardownOwner == .callKit,
              mode == .idle,
              activeCallId == nil,
              callKitAudioTeardownAdmissionToken == admissionToken
        else { return }
        audioTeardownPending = false
        audioTeardownOwner = nil
        callKitManaged = false
        callKitAudioTeardownAdmissionToken = nil
        callKitAudioTeardownCallID = nil
    }

    /// Provider reset is the sole force path. The caller first snapshots any
    /// canonical receipt, then this method synchronously closes the exact local
    /// graph and completes whichever teardown owner `leave()` established.
    @MainActor
    func finishAudioTeardownAfterProviderReset() {
        // `providerDidReset` snapshots and posts its own canonical receipt after
        // local teardown, so a displaced app-owned call must not post a duplicate
        // from the normal post-report completion path.
        systemAudioPreemptionPending = false
        systemAudioPreemptionEndReceipt = nil
        invalidateAgoraJoinAuthority()
        if let engine {
            engine.muteLocalAudioStream(true)
            engine.leaveChannel(nil)
            self.engine = nil
            appId = nil
            AgoraRtcEngineKit.destroy()
        }
        connected = false
        switch audioTeardownOwner {
        case .appOwned:
            finishAppOwnedAudioTeardown(generation: audioTeardownGeneration)
        case .callKit:
            audioTeardownPending = false
            audioTeardownOwner = nil
            callKitManaged = false
            callKitAudioTeardownAdmissionToken = nil
            callKitAudioTeardownCallID = nil
        case nil:
            break
        }
    }

    /// CXStart/CXAnswer can fail before CallKit ever activates AVAudioSession, so
    /// no didDeactivate callback is guaranteed. Clear only the exact terminal
    /// call/token after its local graph has already been stopped.
    @MainActor
    func callKitAudioNeverActivatedAndEnded(
        callID: String,
        admissionToken: AlmaCallAudioAdmission.Token
    ) {
        guard audioTeardownPending,
              audioTeardownOwner == .callKit,
              mode == .idle,
              activeCallId == nil,
              AlmaCallKitPreActivationTerminalFence.accepts(
                pendingCallID: callKitAudioTeardownCallID,
                pendingToken: callKitAudioTeardownAdmissionToken,
                terminalCallID: callID,
                terminalToken: admissionToken)
        else { return }
        audioTeardownPending = false
        audioTeardownOwner = nil
        callKitManaged = false
        callKitAudioTeardownAdmissionToken = nil
        callKitAudioTeardownCallID = nil
    }

    /// A new app-owned audio owner is about to mutate the shared session. Finish
    /// a pending standalone Agora lease now; no delayed callback may touch it later.
    @MainActor func finishPendingAudioTeardownBeforeNewOwner() -> Bool {
        guard audioTeardownPending else { return true }
        guard audioTeardownOwner == .appOwned else { return false }
        let generation = audioTeardownGeneration
        finishAppOwnedAudioTeardown(generation: generation)
        return !audioTeardownPending
    }

    /// CallKit has already activated the shared session, so only invalidate stale
    /// app-owned callbacks; never restore/deactivate underneath the OS owner.
    @MainActor func relinquishPendingAudioTeardownWithoutMutation() {
        guard audioTeardownPending else { return }
        audioTeardownGeneration &+= 1
        audioTeardownPending = false
        audioTeardownOwner = nil
        officeAudioSessionLease = nil
        if let admissionToken = appOwnedAudioTeardownAdmissionToken {
            appOwnedAudioTeardownAdmissionToken = nil
            AlmaCallAudioAdmission.shared.release(admissionToken)
        }
    }

    @MainActor func prepareForSystemAudioTakeover() {
        if mode != .idle || channel != nil || connected {
            engine?.muteLocalAudioStream(true)
            leave()
        }
        cancelPTTWithoutUpload()
        ringtone.stop()
        _ = finishPendingAudioTeardownBeforeNewOwner()
    }

    @MainActor func toggleSpeaker() {
        guard acceptsOfficeMediaMutation() else { return }
        speakerEnabled.toggle()
        engine?.setEnableSpeakerphone(speakerEnabled)
        updateAudioRoute()
    }

    @MainActor
    func leave() {
        // Canonical ENDED may re-enter through CallKit after the first local
        // stop has already established an exact teardown receipt. Preserve that
        // call/token/owner identity until didDeactivate (or the explicit
        // never-activated/reset terminal hook) consumes it.
        guard !(audioTeardownPending && mode == .idle && activeCallId == nil) else {
            engine?.muteLocalAudioStream(true)
            ringtone.stop()
            return
        }
        mediaOperationGeneration &+= 1
        cancelPTTWithoutUpload()
        emitTelemetry("client.leave_started", state: "leaving")
        // Privacy boundary: silence publication synchronously. Agora's
        // `leaveChannel` completion is asynchronous and must never define when
        // the microphone stops carrying user audio.
        engine?.muteLocalAudioStream(true)
        audioTeardownGeneration &+= 1
        let teardownGeneration = audioTeardownGeneration
        let wasCallKitManaged = callKitManaged
        let endingCallID = activeCallId?.lowercased()
        let endingAdmissionToken = officeCallAudioAdmissionToken
        officeCallAudioAdmissionToken = nil
        officeCallAudioAdmissionOperation = nil
        let hadAgoraMedia = agoraJoinSubmitted || connected
        let hadOfficeAudioConfiguration = officeAudioConfigured
            || officeAudioSessionLease != nil
        audioTeardownPending = hadAgoraMedia || hadOfficeAudioConfiguration
            || wasCallKitManaged
        audioTeardownOwner = audioTeardownPending
            ? (wasCallKitManaged ? .callKit : .appOwned)
            : nil
        if audioTeardownPending, wasCallKitManaged {
            callKitAudioTeardownAdmissionToken = endingAdmissionToken
            callKitAudioTeardownCallID = endingCallID
        } else if !wasCallKitManaged {
            callKitAudioTeardownAdmissionToken = nil
            callKitAudioTeardownCallID = nil
        }
        if let endingAdmissionToken, !wasCallKitManaged,
           AlmaCallAudioAdmission.shared.beginTeardown(endingAdmissionToken),
           audioTeardownPending {
            appOwnedAudioTeardownAdmissionToken = endingAdmissionToken
        }
        officeAudioConfigured = false
        invalidateAgoraJoinAuthority()
        if let engine {
            engine.setAudioSessionOperationRestriction(.deactivateSession)
            if wasCallKitManaged {
                // didDeactivate is an AVAudioSession barrier, not an Agora
                // socket/engine barrier. Destroy synchronously so releasing the
                // CallKit token later can never overlap a replacement channel.
                // Destroy even if join was not submitted: a failed preflight may
                // already have created/configured an SDK audio graph.
                engine.leaveChannel(nil)
                self.engine = nil
                appId = nil
                AgoraRtcEngineKit.destroy()
            } else if hadAgoraMedia {
                engine.leaveChannel { [weak self] _ in
                    Task { @MainActor in
                        self?.finishAppOwnedAudioTeardown(generation: teardownGeneration)
                    }
                }
            }
        } else if !wasCallKitManaged, officeAudioSessionLease == nil {
            audioTeardownPending = false
            audioTeardownOwner = nil
        }
        if audioTeardownPending, !wasCallKitManaged {
            // Restricting SDK deactivation makes this bounded fallback safe if
            // Agora never invokes its normal leave completion.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                self?.finishAppOwnedAudioTeardown(generation: teardownGeneration)
            }
        }
        stopCallTimer()
        stopRingTimeout()
        stopCanonicalReconciliation()
        stopReconnectGrace()
        ringtone.stop()
        mode = .idle
        connected = false
        remoteSpeaking = false
        localSpeaking = false
        remoteUids.removeAll()
        channel = nil
        statusText = ""          // never leave a stale "রিং হচ্ছে…" behind the owner view
        emitTelemetry("client.local_left", state: "ended")
        activeCallId = nil
        callDirection = nil
        canonicalState = ""
        currentCallVersion = nil
        speakerEnabled = false
        reconnectSeconds = 0
        joinStartedAt = nil
        lastQualityTelemetryAt = nil
        reconnectCount = 0
        UIDevice.current.isProximityMonitoringEnabled = false
        NotificationCenter.default.post(name: .officeCallCoordinatorDidChange, object: nil)
        if let endingAdmissionToken,
           !wasCallKitManaged,
           appOwnedAudioTeardownAdmissionToken != endingAdmissionToken {
            AlmaCallAudioAdmission.shared.release(endingAdmissionToken)
        }
    }

    @MainActor
    private func finishAppOwnedAudioTeardown(generation: UInt64) {
        guard audioTeardownPending,
              generation == audioTeardownGeneration,
              mode == .idle,
              activeCallId == nil
        else { return }
        if let lease = officeAudioSessionLease {
            officeAudioSessionLease = nil
            lease.releaseIfStillOwned(session: .sharedInstance())
        } else {
            try? AVAudioSession.sharedInstance().setActive(
                false, options: .notifyOthersOnDeactivation)
        }
        audioTeardownPending = false
        audioTeardownOwner = nil
        if let admissionToken = appOwnedAudioTeardownAdmissionToken {
            appOwnedAudioTeardownAdmissionToken = nil
            AlmaCallAudioAdmission.shared.release(admissionToken)
        }
    }

    @MainActor
    func reconcileIncoming(callId: String, channel: String, caller: String) async -> Bool {
        let expectedGeneration = mediaOperationGeneration
        guard await refreshCanonical(
            callId: callId,
            expectedMediaOperationGeneration: expectedGeneration),
              expectedGeneration == mediaOperationGeneration,
              activeCallId == callId.lowercased(),
              canonicalState == "RINGING",
              callDirection == .incoming,
              self.channel == nil || self.channel == channel
        else { return false }
        activeCallId = callId.lowercased()
        callPeer = caller
        mode = .ringing
        statusText = "ইনকামিং কল…"
        markCallHandled(callId)
        startCanonicalReconciliation()
        NotificationCenter.default.post(name: .officeCallCoordinatorDidChange, object: nil)
        return true
    }

    @MainActor
    func endActiveCall(reason explicitReason: String? = nil, requestSystemEnd: Bool = true) async {
        mediaOperationGeneration &+= 1
        guard let callId = activeCallId else { leave(); return }
        let reason = explicitReason ?? localEndReason()
        let receipt = CallKitEndReceipt(
            callId: callId.lowercased(),
            reason: reason,
            expectedVersion: currentCallVersion)
        let hasSystemCall = requestSystemEnd && CallKitVoIP.shared.hasCall(callId: callId)
        // Local privacy is terminal and synchronous. The immutable receipt owns
        // all later network work, so offline/canonical latency cannot retain a
        // microphone, ringtone, or Agora graph.
        engine?.muteLocalAudioStream(true)
        leave()
        if hasSystemCall {
            let accepted = await CallKitVoIP.shared.requestEnd(callId: callId, reason: reason)
            await finishCallKitEndOnServer(receipt)
            if accepted { return }
        } else {
            await finishCallKitEndOnServer(receipt)
        }
        CallKitVoIP.shared.finishReportedCall(callId: callId, reason: .remoteEnded)
    }

    @MainActor
    func callKitEnded(callId: String, requestedReason: String?) async {
        guard activeCallId?.caseInsensitiveCompare(callId) == .orderedSame else { return }
        await endActiveCall(reason: requestedReason, requestSystemEnd: false)
    }

    /// Provider reset is a local privacy boundary, not a network transaction.
    /// Capture the exact canonical call/version first, then invalidate every
    /// in-flight media operation and leave Agora synchronously. The immutable
    /// receipt can be posted after CallKit's audio ownership has been cleared.
    @MainActor
    func systemReset() -> CallKitEndReceipt? {
        guard let callId = activeCallId else {
            leave()
            return nil
        }
        return takeCallKitEnd(callId: callId, requestedReason: "FAILED")
    }

    private func localEndReason() -> String {
        if canonicalState == "RINGING" {
            return callDirection == .incoming ? "DECLINED" : "CANCELLED"
        }
        return "COMPLETED"
    }

    @MainActor
    @discardableResult
    private func refreshCanonical(
        callId: String? = nil,
        expectedMediaOperationGeneration: UInt64? = nil,
        expectedAgoraJoin: AlmaAgoraJoinIdentity? = nil
    ) async -> Bool {
        guard acceptsExpectedAgoraJoin(expectedAgoraJoin) else { return false }
        guard let id = (callId ?? activeCallId)?.lowercased() else { return false }
        let expectedGeneration = expectedMediaOperationGeneration ?? mediaOperationGeneration
        let expectedActiveCallID = activeCallId?.lowercased()
        guard expectedActiveCallID == nil || expectedActiveCallID == id else { return false }
        do {
            let envelope: CanonicalCallEnvelope = try await AlmaAPI.shared.get(
                "/api/assistant/office/calls/\(id)")
            guard expectedGeneration == mediaOperationGeneration,
                  activeCallId?.lowercased() == expectedActiveCallID,
                  acceptsExpectedAgoraJoin(expectedAgoraJoin)
            else { return false }
            let call = envelope.call
            guard call.id.caseInsensitiveCompare(id) == .orderedSame else { return false }
            activeCallId = call.id.lowercased()
            currentCallVersion = call.version
            canonicalState = call.state
            callDirection = call.direction == "incoming" ? .incoming : .outgoing
            if channel == nil { channel = call.channel }
            if call.state == "ENDED" {
                CallKitVoIP.shared.finishReportedCall(
                    callId: id, canonicalReason: call.terminalReason)
                leave()
                return false
            }
            return true
        } catch {
            guard expectedGeneration == mediaOperationGeneration,
                  activeCallId?.lowercased() == expectedActiveCallID,
                  acceptsExpectedAgoraJoin(expectedAgoraJoin)
            else { return false }
            emitTelemetry("client.reconcile_failed", state: canonicalState.lowercased(), detail: message(for: error))
            return false
        }
    }

    @MainActor
    @discardableResult
    private func transitionCanonical(
        to state: String,
        reason: String? = nil,
        expectedAgoraJoin: AlmaAgoraJoinIdentity? = nil
    ) async -> Bool {
        guard acceptsExpectedAgoraJoin(expectedAgoraJoin) else { return false }
        guard let callId = activeCallId else { return false }
        let expectedGeneration = mediaOperationGeneration
        let expectedCallID = callId.lowercased()
        struct Body: Encodable {
            let state: String
            let reason: String?
            let expectedVersion: Int?
        }
        do {
            let response: CanonicalTransitionResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/calls/\(callId)/transition",
                body: Body(state: state, reason: reason, expectedVersion: currentCallVersion))
            guard expectedGeneration == mediaOperationGeneration,
                  activeCallId?.lowercased() == expectedCallID,
                  acceptsExpectedAgoraJoin(expectedAgoraJoin)
            else { return false }
            canonicalState = response.state ?? state
            currentCallVersion = response.version ?? currentCallVersion
            return response.ok ?? true
        } catch {
            guard expectedGeneration == mediaOperationGeneration,
                  activeCallId?.lowercased() == expectedCallID,
                  acceptsExpectedAgoraJoin(expectedAgoraJoin)
            else { return false }
            // Version conflicts and duplicate actions reconcile against server truth.
            guard await refreshCanonical(
                callId: callId,
                expectedMediaOperationGeneration: expectedGeneration,
                expectedAgoraJoin: expectedAgoraJoin)
            else { return state == "ENDED" && activeCallId == nil }
            guard expectedGeneration == mediaOperationGeneration,
                  activeCallId?.lowercased() == expectedCallID,
                  acceptsExpectedAgoraJoin(expectedAgoraJoin)
            else { return false }
            if canonicalState == state || (state == "ENDED" && canonicalState == "ENDED") { return true }
            do {
                let retry: CanonicalTransitionResponse = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/office/calls/\(callId)/transition",
                    body: Body(state: state, reason: reason, expectedVersion: currentCallVersion))
                guard expectedGeneration == mediaOperationGeneration,
                      activeCallId?.lowercased() == expectedCallID,
                      acceptsExpectedAgoraJoin(expectedAgoraJoin)
                else { return false }
                canonicalState = retry.state ?? state
                currentCallVersion = retry.version ?? currentCallVersion
                return retry.ok ?? true
            } catch {
                guard expectedGeneration == mediaOperationGeneration,
                      activeCallId?.lowercased() == expectedCallID,
                      acceptsExpectedAgoraJoin(expectedAgoraJoin)
                else { return false }
                emitTelemetry("client.transition_failed", state: state.lowercased(), detail: message(for: error))
                return false
            }
        }
    }

    /// Agora peer presence can beat the callee's ANSWERED write by a few hundred
    /// milliseconds. Promote only through legal server states instead of attempting
    /// RINGING → CONNECTED and leaving the two clients with different truths.
    @MainActor
    private func promoteCanonicalToConnected(
        expectedAgoraJoin: AlmaAgoraJoinIdentity
    ) async -> Bool {
        for attempt in 0..<8 {
            guard acceptsExpectedAgoraJoin(expectedAgoraJoin),
                  await refreshCanonical(expectedAgoraJoin: expectedAgoraJoin),
                  acceptsExpectedAgoraJoin(expectedAgoraJoin)
            else { return false }
            if canonicalState == "CONNECTED" { return true }
            if canonicalState == "ANSWERED" {
                guard await transitionCanonical(
                    to: "CONNECTING",
                    expectedAgoraJoin: expectedAgoraJoin),
                      acceptsExpectedAgoraJoin(expectedAgoraJoin)
                else { return false }
            }
            if canonicalState == "CONNECTING" || canonicalState == "RECONNECTING" {
                return await transitionCanonical(
                    to: "CONNECTED",
                    expectedAgoraJoin: expectedAgoraJoin)
            }
            guard canonicalState == "RINGING", attempt < 7 else { return false }
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard acceptsExpectedAgoraJoin(expectedAgoraJoin) else { return false }
        }
        return false
    }

    @MainActor
    private func startCanonicalReconciliation() {
        guard reconcileTimer == nil else { return }
        reconcileTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.hasActiveCall else { return }
                _ = await self.refreshCanonical()
            }
        }
    }

    private func stopCanonicalReconciliation() {
        reconcileTimer?.invalidate()
        reconcileTimer = nil
    }

    @MainActor
    private func beginReconnectGrace(
        expectedAgoraJoin: AlmaAgoraJoinIdentity? = nil
    ) async {
        guard acceptsExpectedAgoraJoin(expectedAgoraJoin) else { return }
        guard activeCallId != nil else { return }
        // Agora may emit several reconnecting/failed callbacks for one outage. Never
        // restart the deadline on each callback or a broken call can live forever.
        guard reconnectDeadline == nil else { return }
        reconnectCount += 1
        mode = .reconnecting
        statusText = "পুনঃসংযোগ হচ্ছে…"
        reconnectSeconds = 15
        reconnectDeadline = Date().addingTimeInterval(15)
        emitTelemetry("client.reconnect_started", state: "reconnecting",
                      metrics: ["reconnectCount": Double(reconnectCount)])
        _ = await transitionCanonical(
            to: "RECONNECTING",
            expectedAgoraJoin: expectedAgoraJoin)
        // A connected callback may have won while the server write was in flight.
        guard acceptsExpectedAgoraJoin(expectedAgoraJoin),
              reconnectDeadline != nil,
              hasActiveCall,
              mode == .reconnecting
        else { return }
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) {
            [weak self, expectedAgoraJoin] timer in
            Task { @MainActor in
                guard let self,
                      self.acceptsExpectedAgoraJoin(expectedAgoraJoin),
                      let deadline = self.reconnectDeadline
                else { timer.invalidate(); return }
                self.reconnectSeconds = max(0, Int(ceil(deadline.timeIntervalSinceNow)))
                if Date() >= deadline {
                    timer.invalidate()
                    self.reconnectTimer = nil
                    await self.endActiveCall(reason: "FAILED")
                }
            }
        }
        NotificationCenter.default.post(name: .officeCallCoordinatorDidChange, object: nil)
    }

    @MainActor
    private func stopReconnectGrace() {
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        reconnectDeadline = nil
        reconnectSeconds = 0
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
    @MainActor func markCallHandled(_ broadcastId: String) {
        handledCallIds.insert(broadcastId)
        activeCallId = broadcastId.lowercased()
        emitTelemetry("client.ring_received", state: "ringing")
    }

    /// Confirm the legacy receipt server-side so the owner's chat history can show
    /// "ধরা হয়েছে". This is history/ack metadata only; canonical end/cancel events,
    /// not a receipt, are responsible for dismissing rings on other devices.
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
    @MainActor
    func ringIncoming() {
        guard AlmaLiveVoicePreviewTakeoverRelay.shared.stopAndRestoreBeforeAudioTakeover() else {
            return
        }
        guard let callID = activeCallId?.lowercased() else { return }
        if officeCallAudioAdmissionToken == nil {
            let operation = mediaOperationGeneration &+ 1
            guard claimOfficeCallAudio(
                .officeMedia(operation: operation, callID: callID)) != nil
            else {
                // A native CallKit reservation already owns this or another
                // call; its system ringtone is the only ring allowed.
                return
            }
            mediaOperationGeneration = operation
        }
        guard let admissionToken = officeCallAudioAdmissionToken,
              AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken)
        else { return }
        ringtone.play(.incoming)
    }
    @MainActor func stopRinging() { ringtone.stop() }

    // ── PTT persistent voice-note (walkie-talkie that actually reaches staff) ──
    //
    // The old native walkie-talkie was live-Agora-ONLY: staff heard nothing unless they
    // happened to be on the intercom screen, and nothing landed in the group. The web
    // instead records the press, uploads it, and it shows as a voice message the staff
    // poll + auto-play (online or not). This mirrors that: press → record → upload.

    /// Reserve the press synchronously before permission can suspend. SwiftUI's
    /// DragGesture may emit many onChanged callbacks; only this reservation may
    /// launch a recorder, and release invalidates it before any deferred work runs.
    @discardableResult
    @MainActor
    func pttPressBegan() -> Bool {
        guard !pttPressActive, !pttStarting, !recording else { return false }
        // Complete the previous preview owner's restore before publishing PTT
        // admission. Otherwise a preview finishing in this tiny gap can abandon
        // its lease and make PTT snapshot the preview category as the prior state.
        guard AlmaLiveVoicePreviewTakeoverRelay.shared
            .stopAndRestoreBeforeAudioTakeover()
        else {
            error = "আগের অডিও সেশন বন্ধ হচ্ছে — একটু পরে আবার চেষ্টা করুন"
            return false
        }
        pttPressActive = true
        pttStarting = true
        pttRequestGeneration &+= 1
        let requestGeneration = pttRequestGeneration
        guard let admissionToken = AlmaCallAudioAdmission.shared.claimNormal(
            .ptt(generation: requestGeneration),
            stop: { [weak self] in self?.cancelPTTWithoutUpload() })
        else {
            pttPressActive = false
            pttStarting = false
            error = "আরেকটি কল বা অডিও সেশন চলছে"
            return false
        }
        pttCallAudioAdmissionToken = admissionToken
        Task { @MainActor [weak self] in
            await self?.startPTT(
                requestGeneration: requestGeneration,
                admissionToken: admissionToken)
        }
        return true
    }

    @MainActor
    func pttPressEnded() {
        guard pttPressActive || pttStarting || recording else { return }
        pttPressActive = false
        pttStarting = false
        pttRequestGeneration &+= 1
        let endGeneration = pttRequestGeneration
        Task { @MainActor [weak self] in
            await self?.pttStop(expectedGeneration: endGeneration)
        }
    }

    /// Begin recording the owner's press-and-hold voice note.
    @MainActor
    private func startPTT(
        requestGeneration: UInt64,
        admissionToken: AlmaCallAudioAdmission.Token
    ) async {
        guard pttPressActive,
              pttStarting,
              requestGeneration == pttRequestGeneration,
              pttCallAudioAdmissionToken == admissionToken,
              AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken)
        else { return }
        guard AlmaLiveVoicePreviewTakeoverRelay.shared.stopAndRestoreBeforeAudioTakeover() else {
            cancelPTTWithoutUpload()
            error = "আগের অডিও সেশন বন্ধ হচ্ছে — একটু পরে আবার চেষ্টা করুন"
            return
        }
        error = nil
        do {
            try await ensureMicPermission()
            guard pttPressActive,
                  pttStarting,
                  requestGeneration == pttRequestGeneration,
                  pttCallAudioAdmissionToken == admissionToken,
                  AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken)
            else { return }
            // Permission can suspend long enough for a preview to start after the
            // first admission check. Relinquish again at the actual session handoff.
            guard AlmaLiveVoicePreviewTakeoverRelay.shared.stopAndRestoreBeforeAudioTakeover() else {
                cancelPTTWithoutUpload()
                error = "আগের অডিও সেশন বন্ধ হচ্ছে — একটু পরে আবার চেষ্টা করুন"
                return
            }
            guard pttCallAudioAdmissionToken == admissionToken,
                  AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken)
            else { throw CancellationError() }
            let s = AVAudioSession.sharedInstance()
            let ownedOptions: AVAudioSession.CategoryOptions = [.defaultToSpeaker]
            pttAudioSessionLease = .capture(
                session: s,
                ownedCategory: .playAndRecord,
                ownedMode: .default,
                ownedOptions: ownedOptions)
            do {
                try s.setCategory(.playAndRecord, mode: .default, options: ownedOptions)
                try s.setActive(true)
            } catch {
                releasePTTAudioSession()
                throw error
            }
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
            pttStarting = false
            localSpeaking = true
            statusText = "🔴 রেকর্ড হচ্ছে — বলুন"
        } catch {
            guard requestGeneration == pttRequestGeneration else { return }
            releasePTTAudioSession()
            releasePTTCallAudioAdmission()
            self.error = message(for: error)
            pttStarting = false
            pttPressActive = false
            recording = false
        }
    }

    /// Stop the press, upload the clip as a group voice message. `minSec` guards taps.
    @MainActor
    private func pttStop(expectedGeneration: UInt64) async {
        guard expectedGeneration == pttRequestGeneration else { return }
        pttPressActive = false
        pttStarting = false
        guard recording, let rec = recorder, let url = recordURL else {
            recording = false
            localSpeaking = false
            releasePTTAudioSession()
            releasePTTCallAudioAdmission()
            return
        }
        rec.stop()
        recorder = nil
        recording = false
        localSpeaking = false
        // Release microphone/session ownership before the potentially long upload.
        releasePTTAudioSession()
        releasePTTCallAudioAdmission()
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

    @MainActor
    private func releasePTTAudioSession() {
        guard let lease = pttAudioSessionLease else { return }
        pttAudioSessionLease = nil
        lease.releaseIfStillOwned(session: .sharedInstance())
    }

    @MainActor
    private func cancelPTTWithoutUpload() {
        pttRequestGeneration &+= 1
        pttPressActive = false
        pttStarting = false
        recorder?.stop()
        recorder = nil
        recording = false
        localSpeaking = false
        releasePTTAudioSession()
        releasePTTCallAudioAdmission()
        if let recordURL { try? FileManager.default.removeItem(at: recordURL) }
        recordURL = nil
        recordStart = nil
        if statusText.hasPrefix("🔴") { statusText = "" }
    }

    @MainActor
    private func releasePTTCallAudioAdmission() {
        guard let admissionToken = pttCallAudioAdmissionToken else { return }
        pttCallAudioAdmissionToken = nil
        _ = AlmaCallAudioAdmission.shared.beginTeardown(admissionToken)
        AlmaCallAudioAdmission.shared.release(admissionToken)
    }

    // ── Internals ───────────────────────────────────────────────────────────

    @MainActor
    private func claimOfficeCallAudio(
        _ owner: AlmaCallAudioAdmission.Owner
    ) -> AlmaCallAudioAdmission.Token? {
        guard officeCallAudioAdmissionToken == nil,
              appOwnedAudioTeardownAdmissionToken == nil,
              pttCallAudioAdmissionToken == nil
        else { return nil }
        let token = AlmaCallAudioAdmission.shared.claimNormal(
            owner,
            stop: { [weak self] in
                // System preemption installs its owner before this callback.
                // Meet the privacy boundary immediately, while deferring the
                // blocking Agora destruction until after PushKit reports.
                self?.stopAdmittedOfficeCallAudio()
            },
            finishTeardown: { [weak self] in
                self?.finishSystemAudioPreemptionAfterRequiredReport()
            })
        officeCallAudioAdmissionToken = token
        switch owner {
        case let .officeIntent(operation, _), let .officeMedia(operation, _):
            officeCallAudioAdmissionOperation = operation
        default:
            officeCallAudioAdmissionOperation = nil
        }
        return token
    }

    @MainActor
    private func stopAdmittedOfficeCallAudio() {
        guard officeCallAudioAdmissionToken != nil else { return }
        // PushKit must report the incoming system call immediately. The
        // reservation callback therefore performs only the privacy boundary;
        // CallKitVoIP invokes the blocking graph teardown immediately after its
        // required report call returns.
        engine?.muteLocalAudioStream(true)
        mediaOperationGeneration &+= 1
        if systemAudioPreemptionEndReceipt == nil, let callID = activeCallId {
            systemAudioPreemptionEndReceipt = CallKitEndReceipt(
                callId: callID.lowercased(),
                reason: "FAILED",
                expectedVersion: currentCallVersion)
        }
        systemAudioPreemptionPending = true
    }

    /// Complete an Office graph displaced by a system reservation. For incoming
    /// PushKit calls this is invoked immediately *after* reportNewIncomingCall;
    /// outgoing calls have no reporting deadline and invoke it before requesting
    /// the CX transaction. Return only after the old Agora resources are gone.
    @MainActor
    func finishSystemAudioPreemptionAfterRequiredReport() {
        guard systemAudioPreemptionPending else { return }
        systemAudioPreemptionPending = false
        let endReceipt = systemAudioPreemptionEndReceipt
        systemAudioPreemptionEndReceipt = nil
        ringtone.stop()
        invalidateAgoraJoinAuthority()
        if let engine {
            engine.muteLocalAudioStream(true)
            engine.leaveChannel(nil)
            self.engine = nil
            appId = nil
            AgoraRtcEngineKit.destroy()
        }
        connected = false
        if let lease = officeAudioSessionLease {
            officeAudioSessionLease = nil
            lease.releaseIfStillOwned(session: .sharedInstance())
        }
        officeAudioConfigured = false
        audioTeardownPending = false
        audioTeardownOwner = nil
        leave()
        if let endReceipt {
            // The local mic/socket graph is already terminal. Post canonical
            // truth asynchronously so neither PushKit reporting nor admission
            // mutation ever waits on the network.
            Task { @MainActor [weak self] in
                await self?.finishCallKitEndOnServer(endReceipt)
            }
        }
    }

    @MainActor
    private func stopOfficeCallAudioIfOwned(
        _ admissionToken: AlmaCallAudioAdmission.Token
    ) {
        guard officeCallAudioAdmissionToken == admissionToken else { return }
        engine?.muteLocalAudioStream(true)
        leave()
    }

    private func resolveLiveChannel() async throws -> String {
        let feed: IntercomFeedLite = try await AlmaAPI.shared.get("/api/assistant/office/intercom")
        await MainActor.run { self.roster = feed.staff }
        if !feed.liveChannel.isEmpty { return feed.liveChannel }
        // Deterministic fallback (matches liveIntercomChannel on the server).
        return "itc_live_ALMA_LIFESTYLE"
    }

    private func token(for channel: String, renewal: Bool = false) async throws -> IntercomTokenResp {
        struct Body: Encodable { let channel: String; let renewal: Bool }
        return try await AlmaAPI.shared.send("POST", "/api/assistant/office/intercom/call-token",
                                             body: Body(channel: channel, renewal: renewal))
    }

    @MainActor
    private func join(
        channel ch: String,
        publishMic: Bool,
        operationGeneration: UInt64,
        expectedCallID: String? = nil,
        admissionToken: AlmaCallAudioAdmission.Token
    ) async throws {
        try await awaitPendingAgoraChannelSwitch(
            operationGeneration: operationGeneration,
            expectedCallID: expectedCallID,
            admissionToken: admissionToken)
        if applyIdempotentAgoraJoinIfCurrent(
            channel: ch,
            publishMic: publishMic,
            admissionToken: admissionToken) {
            return
        }

        let tok = try await token(for: ch)
        try requireCurrentMediaOperation(
            operationGeneration,
            expectedCallID: expectedCallID,
            admissionToken: admissionToken)
        tokenExpiry = tok.expiresAt.flatMap(Self.parseISO)
        // Token acquisition suspends; make the shared-session handoff atomic with
        // the mutation below instead of relying only on the public entry check.
        guard AlmaLiveVoicePreviewTakeoverRelay.shared.stopAndRestoreBeforeAudioTakeover() else {
            throw CancellationError()
        }
        try requireCurrentMediaOperation(
            operationGeneration,
            expectedCallID: expectedCallID,
            admissionToken: admissionToken)

        // A different join may have advanced while token acquisition was in
        // flight. Await its SDK-confirmed leave and then inspect the exact epoch
        // again before touching the singleton engine.
        try await awaitPendingAgoraChannelSwitch(
            operationGeneration: operationGeneration,
            expectedCallID: expectedCallID,
            admissionToken: admissionToken)
        if applyIdempotentAgoraJoinIfCurrent(
            channel: ch,
            publishMic: publishMic,
            admissionToken: admissionToken) {
            return
        }
        if let currentJoin = agoraJoinFence.active {
            try await retireAgoraJoinForChannelSwitch(
                currentJoin,
                operationGeneration: operationGeneration,
                expectedCallID: expectedCallID,
                admissionToken: admissionToken)
            try requireCurrentMediaOperation(
                operationGeneration,
                expectedCallID: expectedCallID,
                admissionToken: admissionToken)
        }

        try configureAudioSession()
        try requireCurrentMediaOperation(
            operationGeneration,
            expectedCallID: expectedCallID,
            admissionToken: admissionToken)
        let e = engineFor(appId: tok.appId)
        // The coordinator owns deactivation. A delayed Agora leave must never
        // deactivate a newer preview/call after admission turns idle.
        e.setAudioSessionOperationRestriction(.deactivateSession)
        let joinIdentity = agoraJoinFence.activate(
            engineIdentity: ObjectIdentifier(e),
            channel: ch,
            admissionToken: admissionToken,
            operationGeneration: operationGeneration)
        let delegateProxy = AgoraJoinDelegateProxy(
            coordinator: self,
            identity: joinIdentity)
        agoraDelegateProxy = delegateProxy
        e.delegate = delegateProxy
        channel = ch
        e.setChannelProfile(.communication)
        e.enableAudio()
        let privateCall = Self.callId(from: ch) != nil
        speakerEnabled = !privateCall
        e.setEnableSpeakerphone(speakerEnabled)       // private calls default to earpiece
        UIDevice.current.isProximityMonitoringEnabled = privateCall && !speakerEnabled
        e.muteLocalAudioStream(!publishMic)           // listeners don't publish
        let submissionResult = e.joinChannel(
            byToken: tok.token,
            channelId: ch,
            info: nil,
            uid: tok.uid,
            joinSuccess: nil)
        let submissionDisposition = AlmaAgoraJoinSubmissionTransition.apply(
            result: submissionResult,
            identity: joinIdentity,
            fence: &agoraJoinFence)
        guard submissionDisposition == .accepted else {
            rollbackFailedAgoraJoinSubmission(
                joinIdentity,
                sourceEngine: e,
                delegateProxy: delegateProxy,
                disposition: submissionDisposition)
            throw CancellationError()
        }
        agoraJoinSubmitted = true
    }

    @MainActor
    private func rollbackFailedAgoraJoinSubmission(
        _ identity: AlmaAgoraJoinIdentity,
        sourceEngine: AgoraRtcEngineKit,
        delegateProxy: AgoraJoinDelegateProxy,
        disposition: AlmaAgoraJoinSubmissionDisposition
    ) {
        // `failedRetired` proves this exact identity owned the fence at the
        // submission boundary. Recheck every mutable SDK/coordinator handle so
        // a stale failure can never clear a replacement installed later.
        guard disposition == .failedRetired,
              engine === sourceEngine,
              identity.engineIdentity == ObjectIdentifier(sourceEngine),
              agoraDelegateProxy === delegateProxy,
              delegateProxy.identity == identity,
              channel == identity.channel
        else { return }
        sourceEngine.muteLocalAudioStream(true)
        if sourceEngine.delegate === delegateProxy {
            sourceEngine.delegate = nil
        }
        agoraDelegateProxy = nil
        channel = nil
        agoraJoinSubmitted = false
        connected = false
        remoteSpeaking = false
        localSpeaking = false
        remoteUids.removeAll()
    }

    @MainActor
    private func applyIdempotentAgoraJoinIfCurrent(
        channel expectedChannel: String,
        publishMic: Bool,
        admissionToken: AlmaCallAudioAdmission.Token
    ) -> Bool {
        guard let currentJoin = agoraJoinFence.active,
              currentJoin.channel == expectedChannel,
              currentJoin.admissionToken == admissionToken,
              let sourceEngine = engine,
              agoraJoinFence.accepts(
                currentJoin,
                engineIdentity: ObjectIdentifier(sourceEngine),
                reportedChannel: expectedChannel),
              currentJoin.operationGeneration == mediaOperationGeneration,
              agoraJoinSubmitted,
              !audioTeardownPending,
              officeCallAudioAdmissionToken == admissionToken,
              AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken)
        else { return false }
        sourceEngine.muteLocalAudioStream(!publishMic)
        return true
    }

    @MainActor
    private func awaitPendingAgoraChannelSwitch(
        operationGeneration: UInt64,
        expectedCallID: String?,
        admissionToken: AlmaCallAudioAdmission.Token
    ) async throws {
        guard let pending = pendingAgoraChannelSwitch else { return }
        let confirmed = await pending.barrier.wait()
        try requireCurrentMediaOperation(
            operationGeneration,
            expectedCallID: expectedCallID,
            admissionToken: admissionToken)
        guard confirmed else { throw CancellationError() }
        finishPendingAgoraChannelSwitchIfCurrent(pending.identity)
    }

    @MainActor
    private func retireAgoraJoinForChannelSwitch(
        _ identity: AlmaAgoraJoinIdentity,
        operationGeneration: UInt64,
        expectedCallID: String?,
        admissionToken: AlmaCallAudioAdmission.Token
    ) async throws {
        guard let sourceEngine = engine,
              agoraJoinFence.accepts(
                identity,
                engineIdentity: ObjectIdentifier(sourceEngine))
        else { throw CancellationError() }

        let barrier = AgoraChannelLeaveBarrier()
        pendingAgoraChannelSwitch = .init(identity: identity, barrier: barrier)
        var leaveSubmissionFailed = false
        // Meet the microphone privacy boundary first, synchronously. Only then
        // retire callback authority and submit Agora's asynchronous leave for
        // this exact epoch.
        AlmaAgoraChannelSwitchOperationPlan.performPrivacyBoundary { operation in
            switch operation {
            case .mutePublication:
                sourceEngine.muteLocalAudioStream(true)
            case .retireAuthority:
                _ = agoraJoinFence.retire(identity)
            case .leaveChannel:
                let result = sourceEngine.leaveChannel { _ in
                    barrier.finish(confirmed: true)
                }
                if result < 0 {
                    leaveSubmissionFailed = true
                    barrier.finish(confirmed: false)
                }
            }
        }
        agoraJoinSubmitted = false
        connected = false
        remoteSpeaking = false
        localSpeaking = false
        remoteUids.removeAll()
        stopCallTimer()
        stopRingTimeout()
        stopReconnectGrace()
        ringtone.stop()
        channel = nil
        if leaveSubmissionFailed { throw CancellationError() }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 2) {
            // A timeout fails the replacement join closed; it never authorizes
            // overlapping channels on the singleton engine.
            barrier.finish(confirmed: false)
        }

        let confirmed = await barrier.wait()
        try requireCurrentMediaOperation(
            operationGeneration,
            expectedCallID: expectedCallID,
            admissionToken: admissionToken)
        guard confirmed else { throw CancellationError() }
        finishPendingAgoraChannelSwitchIfCurrent(identity)
    }

    @MainActor
    private func finishPendingAgoraChannelSwitchIfCurrent(
        _ identity: AlmaAgoraJoinIdentity
    ) {
        guard pendingAgoraChannelSwitch?.identity == identity else { return }
        pendingAgoraChannelSwitch = nil
        if agoraDelegateProxy?.identity == identity {
            agoraDelegateProxy = nil
            if let sourceEngine = engine,
               ObjectIdentifier(sourceEngine) == identity.engineIdentity {
                sourceEngine.delegate = nil
            }
        }
    }

    @MainActor
    private func confirmAgoraChannelSwitchLeave(
        identity: AlmaAgoraJoinIdentity,
        sourceEngine: AgoraRtcEngineKit
    ) {
        guard let pending = pendingAgoraChannelSwitch,
              pending.identity == identity,
              identity.engineIdentity == ObjectIdentifier(sourceEngine),
              engine === sourceEngine
        else { return }
        pending.barrier.finish(confirmed: true)
    }

    @MainActor
    private func requireCurrentMediaOperation(
        _ generation: UInt64,
        expectedCallID: String? = nil,
        admissionToken: AlmaCallAudioAdmission.Token? = nil
    ) throws {
        try Task.checkCancellation()
        guard generation == mediaOperationGeneration else { throw CancellationError() }
        if let admissionToken {
            guard officeCallAudioAdmissionToken == admissionToken,
                  AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken)
            else { throw CancellationError() }
        }
        if let expectedCallID {
            guard activeCallId?.caseInsensitiveCompare(expectedCallID) == .orderedSame else {
                throw CancellationError()
            }
        }
    }

    @MainActor
    private func acceptsOfficeMediaMutation() -> Bool {
        guard let admissionToken = officeCallAudioAdmissionToken else { return false }
        return AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken)
    }

    @MainActor
    private func acceptsAgoraCallback(
        _ identity: AlmaAgoraJoinIdentity,
        from sourceEngine: AgoraRtcEngineKit,
        reportedChannel: String? = nil
    ) -> Bool {
        guard engine === sourceEngine,
              agoraJoinFence.accepts(
                identity,
                engineIdentity: ObjectIdentifier(sourceEngine),
                reportedChannel: reportedChannel),
              channel == identity.channel,
              mediaOperationGeneration == identity.operationGeneration,
              agoraJoinSubmitted,
              !audioTeardownPending,
              officeCallAudioAdmissionToken == identity.admissionToken,
              AlmaCallAudioAdmission.shared.acceptsMediaMutation(identity.admissionToken)
        else { return false }
        return true
    }

    @MainActor
    private func acceptsExpectedAgoraJoin(
        _ identity: AlmaAgoraJoinIdentity?
    ) -> Bool {
        guard let identity else { return true }
        guard let sourceEngine = engine else { return false }
        return acceptsAgoraCallback(identity, from: sourceEngine)
    }

    @MainActor
    private func invalidateAgoraJoinAuthority() {
        if let current = agoraJoinFence.active { _ = agoraJoinFence.retire(current) }
        pendingAgoraChannelSwitch?.barrier.finish(confirmed: false)
        pendingAgoraChannelSwitch = nil
        agoraDelegateProxy = nil
        engine?.delegate = nil
        agoraJoinSubmitted = false
    }

    private func engineFor(appId newId: String) -> AgoraRtcEngineKit {
        if let e = engine, appId == newId { return e }
        engine?.delegate = nil
        engine?.leaveChannel(nil)
        AgoraRtcEngineKit.destroy()
        let cfg = AgoraRtcEngineConfig()
        cfg.appId = newId
        let e = AgoraRtcEngineKit.sharedEngine(with: cfg, delegate: nil)
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

    @MainActor
    private func configureAudioSession() throws {
        let s = AVAudioSession.sharedInstance()
        // `.allowBluetoothHFP` is the current spelling of `.allowBluetooth` — same
        // raw option (0x4), available since iOS 1.0, so this is a rename only.
        var options: AVAudioSession.CategoryOptions = [.allowBluetoothHFP]
        if activeCallId == nil { options.insert(.defaultToSpeaker) }
        if callKitManaged, let lease = officeAudioSessionLease {
            officeAudioSessionLease = nil
            lease.releaseIfStillOwned(session: s)
        }
        if !callKitManaged {
            if let lease = officeAudioSessionLease {
                officeAudioSessionLease = lease.updatingOwnedConfiguration(
                    category: .playAndRecord,
                    mode: .voiceChat,
                    options: options)
            } else {
                officeAudioSessionLease = .capture(
                    session: s,
                    ownedCategory: .playAndRecord,
                    ownedMode: .voiceChat,
                    ownedOptions: options)
            }
        }
        do {
            try s.setCategory(.playAndRecord, mode: .voiceChat, options: options)
        } catch {
            if !callKitManaged, let lease = officeAudioSessionLease {
                officeAudioSessionLease = nil
                lease.releaseIfStillOwned(session: s)
            }
            throw error
        }
        // Under CallKit, the framework activates the session in `didActivate` — us
        // calling setActive(true) here races/​fights it, so skip when CallKit-managed.
        if !callKitManaged {
            do {
                try s.setActive(true)
            } catch {
                if let lease = officeAudioSessionLease {
                    officeAudioSessionLease = nil
                    lease.releaseIfStillOwned(session: s)
                }
                throw error
            }
        }
        officeAudioConfigured = true
        updateAudioRoute()
    }

    @MainActor
    private func renewAgoraToken(
        expectedJoin: AlmaAgoraJoinIdentity,
        sourceEngine: AgoraRtcEngineKit
    ) async {
        guard acceptsAgoraCallback(expectedJoin, from: sourceEngine) else { return }
        let expectedGeneration = mediaOperationGeneration
        let expectedCallID = activeCallId?.lowercased()
        do {
            let renewed = try await token(for: expectedJoin.channel, renewal: true)
            guard expectedGeneration == mediaOperationGeneration,
                  activeCallId?.lowercased() == expectedCallID,
                  acceptsAgoraCallback(expectedJoin, from: sourceEngine)
            else { return }
            sourceEngine.renewToken(renewed.token)
            tokenExpiry = renewed.expiresAt.flatMap(Self.parseISO)
            emitTelemetry("client.token_renewed", state: canonicalState.lowercased())
        } catch {
            guard expectedGeneration == mediaOperationGeneration,
                  activeCallId?.lowercased() == expectedCallID,
                  acceptsAgoraCallback(expectedJoin, from: sourceEngine)
            else { return }
            emitTelemetry("client.token_renew_failed", state: canonicalState.lowercased(), detail: message(for: error))
        }
    }

    @MainActor
    private func handleAudioRouteChanged(_ notification: Notification) {
        if let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
           let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
           reason == .oldDeviceUnavailable || reason == .noSuitableRouteForCategory {
                cancelPTTWithoutUpload()
        }
        updateAudioRoute()
    }

    @MainActor
    private func handleAudioInterruption(_ notification: Notification) {
        guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began { cancelPTTWithoutUpload() }
        Task { @MainActor [weak self] in
            guard let self else { return }
            if type == .began, self.hasActiveCall {
                self.emitTelemetry("client.audio_interrupted", state: "reconnecting")
                await self.beginReconnectGrace()
            } else if type == .ended, self.hasActiveCall {
                if !self.callKitManaged {
                    try? AVAudioSession.sharedInstance().setActive(true)
                }
                self.updateAudioRoute()
                if self.mode == .reconnecting, !self.remoteUids.isEmpty {
                    self.stopReconnectGrace()
                    if await self.transitionCanonical(to: "CONNECTED") {
                        self.mode = .calling
                        self.statusText = "কল চলছে"
                    }
                }
            }
        }
    }

    @MainActor
    private func updateAudioRoute() {
        let previous = audioRoute
        let output = AVAudioSession.sharedInstance().currentRoute.outputs.first
        audioRoute = output?.portName ?? (speakerEnabled ? "Speaker" : "iPhone")
        UIDevice.current.isProximityMonitoringEnabled = activeCallId != nil && !speakerEnabled
        if activeCallId != nil, audioRoute != previous {
            emitTelemetry("client.audio_route_changed", state: canonicalState.lowercased(),
                          detail: audioRoute)
        }
    }

    private func ensureMicPermission() async throws {
        let granted = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            AVAudioApplication.requestRecordPermission { ok in cont.resume(returning: ok) }
        }
        if !granted { throw IntercomError.micDenied }
    }

    private func startCallTimer(expectedAgoraJoin: AlmaAgoraJoinIdentity) {
        stopCallTimer()
        callSeconds = 0
        callTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) {
            [weak self, expectedAgoraJoin] timer in
            Task { @MainActor in
                guard let self,
                      self.acceptsExpectedAgoraJoin(expectedAgoraJoin)
                else {
                    timer.invalidate()
                    return
                }
                self.callSeconds += 1
            }
        }
    }
    private func stopCallTimer() { callTimer?.invalidate(); callTimer = nil; callSeconds = 0 }

    /// While ringing, give up after the ring window if nobody answers (matches web).
    private func startRingTimeout() {
        stopRingTimeout()
        ringTimer = Timer.scheduledTimer(withTimeInterval: Self.ringWindow, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.mode == .ringing else { return }
                self.ringTimer = nil
                let timedOutCallId = self.activeCallId
                // The server is authoritative for MISSED and expires RINGING on read.
                // A client must never silently leave while the canonical session remains
                // active, which previously produced a ghost ring on the other device.
                let stillLive = await self.refreshCanonical()
                if stillLive, self.canonicalState == "RINGING" {
                    self.ringTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { [weak self] _ in
                        Task { @MainActor in
                            self?.ringTimer = nil
                            self?.startRingTimeoutFromCanonicalDeadline()
                        }
                    }
                    return
                }
                if self.activeCallId == nil || self.activeCallId != timedOutCallId {
                    self.error = "কেউ কল ধরেনি"
                }
                // Clear the notice after a few seconds so it doesn't read as a live error.
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if self.error == "কেউ কল ধরেনি" { self.error = nil }
            }
        }
    }

    @MainActor
    private func startRingTimeoutFromCanonicalDeadline() {
        guard mode == .ringing else { return }
        Task { @MainActor in
            let callId = activeCallId
            let stillLive = await refreshCanonical()
            if stillLive, canonicalState == "RINGING" {
                ringTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { [weak self] _ in
                    Task { @MainActor in
                        self?.ringTimer = nil
                        self?.startRingTimeoutFromCanonicalDeadline()
                    }
                }
            } else if activeCallId == nil || activeCallId != callId {
                error = "কেউ কল ধরেনি"
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
        if case IntercomError.canonicalRejected = error { return "কলটি আর সক্রিয় নেই।" }
        let raw = error.localizedDescription
        if raw.contains("agora_unconfigured") { return "Agora কনফিগার করা নেই (সার্ভার কী দরকার)।" }
        return raw
    }

    enum IntercomError: Error { case micDenied, callFailed, canonicalRejected }

    private static func callId(from channel: String) -> String? {
        guard channel.hasPrefix("itc_") && !channel.hasPrefix("itc_live_") else { return nil }
        let candidate = String(channel.dropFirst(4))
        return UUID(uuidString: candidate) == nil ? nil : candidate.lowercased()
    }

    private func emitTelemetry(_ event: String, state: String, detail: String? = nil,
                               latencyMs: Int? = nil, metrics: [String: Double] = [:]) {
        guard let callId = activeCallId else { return }
        struct Body: Encodable {
            let callId: String
            let event: String
            let platform: String
            let deviceId: String?
            let appBuild: String
            let buildSha: String?
            let state: String
            let latencyMs: Int?
            let metadata: [String: String]?
            let occurredAt: String
        }
        struct Ack: Decodable { let ok: Bool? }
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "unknown"
        let build = info?["CFBundleVersion"] as? String ?? "unknown"
        let provenance = AlmaBuildProvenanceLoader.current
        var metadata = metrics.mapValues { String($0) }
        if let detail { metadata["code"] = String(detail.prefix(160)) }
        let body = Body(
            callId: callId,
            event: event,
            platform: "ios",
            deviceId: UIDevice.current.identifierForVendor?.uuidString,
            appBuild: "\(version) (\(build))",
            buildSha: provenance.trustedCommit,
            state: state,
            latencyMs: latencyMs,
            metadata: metadata.isEmpty ? nil : metadata,
            occurredAt: ISO8601DateFormatter().string(from: Date())
        )
        Task {
            let _: Ack? = try? await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/calls/events", body: body)
        }
    }
}

/// Compatibility name for the existing Office UI while the implementation is
/// now explicitly one process-level call coordinator.
@available(iOS 17.0, *)
typealias AgoraIntercom = OfficeCallCoordinator

// MARK: - Agora delegate

@available(iOS 17.0, *)
private extension OfficeCallCoordinator {
final class AgoraJoinDelegateProxy: NSObject, AgoraRtcEngineDelegate {
    weak var coordinator: OfficeCallCoordinator?
    let identity: AlmaAgoraJoinIdentity

    init(coordinator: OfficeCallCoordinator, identity: AlmaAgoraJoinIdentity) {
        self.coordinator = coordinator
        self.identity = identity
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, didJoinChannel channel: String, withUid uid: UInt, elapsed: Int) {
        Task { @MainActor [weak coordinator, identity] in
            guard let coordinator,
                  coordinator.acceptsAgoraCallback(
                    identity, from: engine, reportedChannel: channel)
            else { return }
            coordinator.connected = true
            let latency = coordinator.joinStartedAt.map {
                max(0, Int(Date().timeIntervalSince($0) * 1_000))
            }
            coordinator.emitTelemetry("client.local_joined", state: "connecting", latencyMs: latency)
        }
    }

    /// A REMOTE party joined the channel. For a 1:1 call this is "the other side answered" —
    /// the ONLY moment the WhatsApp-style call timer is allowed to start.
    func rtcEngine(_ engine: AgoraRtcEngineKit, didJoinedOfUid uid: UInt, elapsed: Int) {
        Task { @MainActor [weak coordinator, identity] in
            guard let coordinator,
                  coordinator.acceptsAgoraCallback(identity, from: engine)
            else { return }
            coordinator.remoteUids.insert(uid)
            coordinator.stopReconnectGrace()
            if coordinator.reconnectCount > 0 {
                coordinator.emitTelemetry(
                    "client.reconnect_recovered",
                    state: "in-call",
                    metrics: ["reconnectCount": Double(coordinator.reconnectCount)])
            }
            if coordinator.mode == .ringing || coordinator.mode == .reconnecting {
                let promoted = await coordinator.promoteCanonicalToConnected(
                    expectedAgoraJoin: identity)
                guard coordinator.acceptsAgoraCallback(identity, from: engine) else { return }
                guard promoted else {
                    coordinator.emitTelemetry(
                        "client.transition_failed",
                        state: "connected",
                        detail: "peer_join_before_answer")
                    return
                }
                coordinator.mode = .calling
                coordinator.statusText = "কল চলছে"
                coordinator.stopRingTimeout()
                coordinator.ringtone.stop()
                coordinator.startCallTimer(expectedAgoraJoin: identity)
                if let callId = coordinator.activeCallId {
                    CallKitVoIP.shared.reportConnected(callId: callId)
                }
                NotificationCenter.default.post(name: .officeCallCoordinatorDidChange, object: nil)
            }
            guard coordinator.acceptsAgoraCallback(identity, from: engine) else { return }
            coordinator.emitTelemetry("client.peer_joined", state: "in-call")
        }
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, reportAudioVolumeIndicationOfSpeakers speakers: [AgoraRtcAudioVolumeInfo], totalVolume: Int) {
        // uid 0 == the local user; a remote speaker with voice-activity means "someone's talking".
        let remote = speakers.contains { $0.uid != 0 && ($0.vad == 1 || $0.volume > 8) }
        let local = speakers.contains { $0.uid == 0 && $0.volume > 12 }
        Task { @MainActor [weak coordinator, identity] in
            guard let coordinator,
                  coordinator.acceptsAgoraCallback(identity, from: engine)
            else { return }
            if coordinator.remoteSpeaking != remote { coordinator.remoteSpeaking = remote }
            if coordinator.localSpeaking != local { coordinator.localSpeaking = local }
        }
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, remoteAudioStateChangedOfUid uid: UInt, state: AgoraAudioRemoteState, reason: AgoraAudioRemoteReason, elapsed: Int) {
        if state == .stopped || state == .failed {
            Task { @MainActor [weak coordinator, identity] in
                guard let coordinator,
                      coordinator.acceptsAgoraCallback(identity, from: engine)
                else { return }
                coordinator.remoteSpeaking = false
            }
        }
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, didOfflineOfUid uid: UInt, reason: AgoraUserOfflineReason) {
        Task { @MainActor [weak coordinator, identity] in
            guard let coordinator,
                  coordinator.acceptsAgoraCallback(identity, from: engine)
            else { return }
            coordinator.remoteUids.remove(uid)
            coordinator.remoteSpeaking = false
            // Agora presence is not call truth. Give transient network loss a bounded
            // reconnect window; canonical reconciliation decides remote hang-up.
            if (coordinator.mode == .calling || coordinator.mode == .ringing),
               coordinator.remoteUids.isEmpty {
                coordinator.emitTelemetry("client.peer_left", state: "reconnecting")
                await coordinator.beginReconnectGrace(expectedAgoraJoin: identity)
                guard coordinator.acceptsAgoraCallback(identity, from: engine) else { return }
            }
        }
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, tokenPrivilegeWillExpire token: String) {
        Task { @MainActor [weak coordinator, identity] in
            guard let coordinator,
                  coordinator.acceptsAgoraCallback(identity, from: engine)
            else { return }
            await coordinator.renewAgoraToken(expectedJoin: identity, sourceEngine: engine)
        }
    }

    func rtcEngineRequestToken(_ engine: AgoraRtcEngineKit) {
        Task { @MainActor [weak coordinator, identity] in
            guard let coordinator,
                  coordinator.acceptsAgoraCallback(identity, from: engine)
            else { return }
            await coordinator.renewAgoraToken(expectedJoin: identity, sourceEngine: engine)
        }
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, didLeaveChannelWith stats: AgoraChannelStats) {
        Task { @MainActor [weak coordinator, identity] in
            coordinator?.confirmAgoraChannelSwitchLeave(
                identity: identity,
                sourceEngine: engine)
        }
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit,
                   connectionChangedTo state: AgoraConnectionState,
                   reason: AgoraConnectionChangedReason) {
        Task { @MainActor [weak coordinator, identity] in
            guard let coordinator else { return }
            if state == .disconnected {
                coordinator.confirmAgoraChannelSwitchLeave(
                    identity: identity,
                    sourceEngine: engine)
            }
            guard coordinator.acceptsAgoraCallback(identity, from: engine) else { return }
            switch state {
            case .reconnecting:
                if coordinator.hasActiveCall {
                    await coordinator.beginReconnectGrace(expectedAgoraJoin: identity)
                    guard coordinator.acceptsAgoraCallback(identity, from: engine) else { return }
                }
            case .connected:
                if coordinator.mode == .reconnecting && !coordinator.remoteUids.isEmpty {
                    coordinator.stopReconnectGrace()
                    _ = await coordinator.transitionCanonical(
                        to: "CONNECTED",
                        expectedAgoraJoin: identity)
                    guard coordinator.acceptsAgoraCallback(identity, from: engine) else { return }
                    coordinator.mode = .calling
                    coordinator.emitTelemetry(
                        "client.reconnect_recovered",
                        state: "in-call",
                        metrics: ["reconnectCount": Double(coordinator.reconnectCount)])
                }
            case .failed:
                if coordinator.hasActiveCall {
                    await coordinator.beginReconnectGrace(expectedAgoraJoin: identity)
                    guard coordinator.acceptsAgoraCallback(identity, from: engine) else { return }
                }
            default:
                break
            }
            guard coordinator.acceptsAgoraCallback(identity, from: engine) else { return }
            coordinator.emitTelemetry(
                "client.connection_changed",
                state: String(describing: state),
                detail: String(describing: reason))
        }
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, reportRtcStats stats: AgoraChannelStats) {
        Task { @MainActor [weak coordinator, identity] in
            guard let coordinator,
                  coordinator.acceptsAgoraCallback(identity, from: engine),
                  coordinator.hasActiveCall
            else { return }
            let now = Date()
            if let last = coordinator.lastQualityTelemetryAt,
               now.timeIntervalSince(last) < 10 { return }
            coordinator.lastQualityTelemetryAt = now
            coordinator.emitTelemetry(
                "client.quality_sample",
                state: coordinator.canonicalState.lowercased(),
                metrics: [
                    "rttMs": Double(stats.lastmileDelay),
                    "packetLossPct": Double(max(stats.txPacketLossRate, stats.rxPacketLossRate)),
                    "txAudioKbps": Double(stats.txAudioKBitrate),
                    "rxAudioKbps": Double(stats.rxAudioKBitrate),
                    "reconnectCount": Double(coordinator.reconnectCount),
                ]
            )
        }
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, didOccurError errorCode: AgoraErrorCode) {
        Task { @MainActor [weak coordinator, identity] in
            guard let coordinator,
                  coordinator.acceptsAgoraCallback(identity, from: engine)
            else { return }
            coordinator.error = "Agora ত্রুটি (\(errorCode.rawValue))"
            coordinator.emitTelemetry(
                "client.media_error",
                state: "error",
                detail: "agora_\(errorCode.rawValue)")
        }
    }
}
}

extension Notification.Name {
    static let officeCallCoordinatorDidChange = Notification.Name("officeCallCoordinatorDidChange")
}

// MARK: - Ringtone (self-contained — synthesised in memory, no bundled audio files)

/// `.ringback` = the soft tone the CALLER hears while waiting for an answer;
/// `.incoming` = the louder double-ring the CALLEE hears. Loops until `stop()`.
final class IntercomRingtone {
    enum Kind { case ringback, incoming }
    private var player: AVAudioPlayer?
    private var incomingAudioSessionLease: IntercomAudioSessionLease?

    func play(_ kind: Kind) {
        stop()
        do {
            // The incoming ring plays BEFORE any Agora session exists → own the session
            // as loud speaker playback (heard even on the silent switch). The ringback
            // plays into Agora's already-active call session, so we don't reconfigure it.
            if kind == .incoming {
                let s = AVAudioSession.sharedInstance()
                let ownedOptions = AlmaOwnedAudioSessionOptions.duckingPlayback
                incomingAudioSessionLease = .capture(
                    session: s,
                    ownedCategory: .playback,
                    ownedMode: .default,
                    ownedOptions: ownedOptions)
                do {
                    try s.setCategory(.playback, mode: .default, options: ownedOptions)
                    try s.setActive(true)
                } catch {
                    releaseIncomingAudioSession()
                    throw error
                }
            }
            let p = try AVAudioPlayer(data: IntercomRingtone.wav(for: kind))
            p.numberOfLoops = -1
            p.volume = kind == .incoming ? 1.0 : 0.55
            p.prepareToPlay()
            guard p.play() else {
                releaseIncomingAudioSession()
                return
            }
            player = p
        } catch {
            player = nil
            releaseIncomingAudioSession()
        }
    }

    func stop() {
        player?.stop()
        player = nil
        releaseIncomingAudioSession()
    }

    private func releaseIncomingAudioSession() {
        guard let lease = incomingAudioSessionLease else { return }
        incomingAudioSessionLease = nil
        lease.releaseIfStillOwned(session: .sharedInstance())
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
