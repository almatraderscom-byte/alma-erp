//
//  CallKitVoIP.swift
//  ALMA ERP — WhatsApp-style incoming calls (Stage 1).
//
//  A live office call must ring this phone as a NATIVE full-screen call even when the app
//  is backgrounded or killed. That is only possible on iOS with a PushKit **VoIP** push
//  turned into a CallKit call:
//
//    server (apns-voip.ts) ──VoIP push──▶ PKPushRegistry ──report──▶ CXProvider (CallKit)
//                                                             │
//                                          answer ────────────┼──▶ AgoraIntercom.startCall(join)
//                                          end/decline ───────┴──▶ AgoraIntercom.leave()
//
//  The device's VoIP token is registered with the server (POST /api/assistant/internal/
//  call-push/register) so the call route knows where to send the push. Registration is
//  best-effort and retried when the app becomes active (the web login cookie AlmaAPI needs
//  may not exist yet at first launch).
//
//  Dedupe: when a VoIP push arrives we mark the call handled in AgoraIntercom so the
//  poll-based FloatingChatHead ring (the fallback when VoIP isn't configured) doesn't
//  ALSO pop for the same call. CallKit is the primary path; the poll is the safety net.
//

import Foundation
import PushKit
import CallKit
import AVFoundation
import UIKit
import Network

/// AlmaAPI remains the sole authenticated HTTP stack. The ordinary generic
/// `send` API throws for non-2xx responses, so this adapter recovers both the
/// exact status code and the route's rich conflict receipt from AlmaAPIError.
private final class AlmaAgentCallStatusAPITransport: AlmaAgentCallStatusTransport {
    private let decoder = JSONDecoder()

    func send(
        callId: String,
        request: AlmaAgentCallStatusRequest
    ) async throws -> AlmaAgentCallStatusHTTPResult {
        do {
            let response: AlmaAgentCallStatusServerResponse = try await AlmaAPI.shared.send(
                "POST",
                "/api/assistant/agent-call/\(callId)/status",
                body: request)
            // The status route's successful contract is HTTP 200. AlmaAPI has
            // already validated that this was a 2xx response before decoding.
            return AlmaAgentCallStatusHTTPResult(
                statusCode: 200,
                response: response)
        } catch AlmaAPIError.http(let status, let body) {
            return AlmaAgentCallStatusHTTPResult(
                statusCode: status,
                response: body.data(using: .utf8).flatMap {
                    try? decoder.decode(AlmaAgentCallStatusServerResponse.self, from: $0)
                })
        }
    }
}

// Agent-call answer hand-off lives in AgentCallController (AgentCallUI.swift) —
// a screen-independent controller with its own engine, per the owner's
// WhatsApp-parity spec: talk starts on answer, no app section is opened.

@available(iOS 17.0, *)
final class CallKitVoIP: NSObject {
    static let shared = CallKitVoIP()

    private var voipRegistry: PKPushRegistry?
    private let provider: CXProvider
    private let callController = CXCallController()
    private let agentLifecycleEvidence = AlmaLiveVoiceLifecycleEvidenceRelay()

    private enum CallDirection: Equatable { case incoming, outgoing }
    /// 'office' = staff↔owner Agora call (OfficeCallCoordinator). 'agent' = the AI
    /// agent ringing the owner — answered into the Gemini Live voice console.
    private enum CallKind: Equatable { case office, agent }
    /// CallKit is an OS adapter; OfficeCallCoordinator remains the sole source of
    /// call truth. This map only correlates CallKit action UUIDs to canonical IDs.
    private struct ActiveCall {
        let broadcastId: String
        let channel: String
        let peer: String
        let direction: CallDirection
        var kind: CallKind = .office
        /// Bearer proof delivered only in this exact agent ring push. Never log
        /// it and never copy it into a user-facing diagnostic.
        var agentClaimReceipt: String? = nil
        var admissionToken: AlmaCallAudioAdmission.Token? = nil
        /// `answered` means the user initiated an answer and suppresses a
        /// multi-device cancel race. Only `answerFulfilled` is durable server
        /// truth and may make a terminal transition depend on `answered`.
        var answered = false
        var answerFulfilled = false
        var agentSessionGeneration: UInt64?
    }
    private struct ActivatedAudioOwner {
        let uuid: UUID
        let call: ActiveCall
        let admissionToken: AlmaCallAudioAdmission.Token
    }
    private var calls: [UUID: ActiveCall] = [:]
    private var requestedEndReasons: [UUID: String] = [:]
    private var placeholderReportsInFlight = 0
    private var activatedAudioOwners: [ActivatedAudioOwner] = []
    /// A timed-out CXStart/CXAnswer action is already terminal from CallKit's
    /// perspective. Its suspended task must still clean up, but must not call
    /// `fail()` after the provider has delivered the timeout callback.
    private var timedOutActionUUIDs = Set<UUID>()
    private let callStateLock = NSLock()
    private let agentStatusOutbox = CallKitVoIP.makeAgentStatusOutbox()
    private let agentStatusReplayMonitor = NWPathMonitor()
    private let agentStatusReplayQueue = DispatchQueue(
        label: "com.almatraders.erp.agent-call-status-replay",
        qos: .utility)

    var hasPendingOrActiveCall: Bool {
        callStateLock.lock()
        defer { callStateLock.unlock() }
        // A reported call can leave `calls` before CXProvider delivers the
        // matching didDeactivate. Keep admission closed until that exact audio
        // owner is consumed (or providerDidReset clears the queue).
        return !calls.isEmpty
            || placeholderReportsInFlight > 0
            || !activatedAudioOwners.isEmpty
    }

    private func withCallState<T>(
        _ body: (inout [UUID: ActiveCall], inout [UUID: String]) -> T
    ) -> T {
        callStateLock.lock()
        defer { callStateLock.unlock() }
        return body(&calls, &requestedEndReasons)
    }

    private func stillOwnsCall(_ expected: ActiveCall, uuid: UUID) -> Bool {
        withCallState { calls, _ in
            guard let current = calls[uuid] else { return false }
            return current.broadcastId == expected.broadcastId
                && current.channel == expected.channel
                && current.direction == expected.direction
                && current.kind == expected.kind
                && current.admissionToken == expected.admissionToken
        }
    }

    private func reserveSystemCall(
        uuid: UUID,
        call: ActiveCall,
        existingAdmissionToken: AlmaCallAudioAdmission.Token? = nil
    ) -> (inserted: Bool, duplicate: Bool) {
        let reserve: @MainActor () -> (inserted: Bool, duplicate: Bool) = {
            let canReserve = self.withCallState { calls, _ -> (Bool, Bool) in
                if calls[uuid] != nil { return (false, true) }
                return (
                    calls.isEmpty
                        && self.placeholderReportsInFlight == 0
                        && self.activatedAudioOwners.isEmpty,
                    false)
            }
            if canReserve.1 { return (false, true) }
            guard canReserve.0 else { return (false, false) }

            let phase: AlmaCallAudioAdmission.CallKitPhase =
                call.direction == .incoming ? .reported : .reservation
            let owner = AlmaCallAudioAdmission.Owner.callKit(
                uuid: uuid,
                callID: call.broadcastId.lowercased(),
                kind: call.kind == .agent ? .agent : .office,
                phase: phase)
            let admissionToken: AlmaCallAudioAdmission.Token?
            if let existingAdmissionToken {
                admissionToken = AlmaCallAudioAdmission.shared.transition(
                    existingAdmissionToken,
                    to: owner) ? existingAdmissionToken : nil
            } else {
                admissionToken = AlmaCallAudioAdmission.shared.claimSystem(
                    owner,
                    preempt: {})
            }
            guard let admissionToken else { return (false, false) }

            var reservedCall = call
            reservedCall.admissionToken = admissionToken
            let insertion = self.withCallState { calls, _ -> (Bool, Bool) in
                if let duplicate = calls[uuid] {
                    return (false, duplicate.admissionToken == admissionToken)
                }
                guard calls.isEmpty,
                      self.placeholderReportsInFlight == 0,
                      self.activatedAudioOwners.isEmpty
                else { return (false, false) }
                calls[uuid] = reservedCall
                return (true, false)
            }
            if !insertion.0, !insertion.1 {
                AlmaCallAudioAdmission.shared.release(admissionToken)
            }
            return insertion
        }
        if Thread.isMainThread {
            return MainActor.assumeIsolated { reserve() }
        }
        return DispatchQueue.main.sync {
            MainActor.assumeIsolated { reserve() }
        }
    }

    /// Last VoIP token we obtained; re-POSTed when the app becomes active (login race).
    private var pendingToken: String?
    private var registered = false

    private lazy var installationId: String = {
        let key = "office-call-installation-id"
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty { return existing }
        let created = UUID().uuidString.lowercased()
        UserDefaults.standard.set(created, forKey: key)
        return created
    }()

    private static func makeAgentStatusOutbox() -> AlmaAgentCallStatusOutbox? {
        let transport = AlmaAgentCallStatusAPITransport()
        do {
            return try AlmaAgentCallStatusOutbox(transport: transport)
        } catch {
            // A partially-written UserDefaults value must not permanently turn
            // off all future lifecycle delivery. The bounded queue is already
            // unrecoverable if its JSON cannot decode; reset only its exact key.
            UserDefaults.standard.removeObject(
                forKey: AlmaAgentCallStatusUserDefaultsStore.defaultKey)
            return try? AlmaAgentCallStatusOutbox(transport: transport)
        }
    }

    private static func safeAgentDiagnosticCode(
        for raw: String?,
        fallback: String = "live_startup_failed"
    ) -> String {
        let value = raw?.lowercased() ?? ""
        if value.contains("microphone") || value.contains("mic permission") {
            return "microphone_permission_denied"
        }
        if value.contains("auth") || value.contains("session") || value.contains("login") {
            return "live_authentication_failed"
        }
        if value.contains("time out") || value.contains("timed out")
            || value.contains("সময় শেষ") {
            return "live_connection_timed_out"
        }
        if value.contains("end transaction") { return "callkit_end_transaction_failed" }
        if value.contains("preflight") { return "audio_preflight_failed" }
        if value.contains("admission") { return "audio_admission_failed" }
        if value.contains("route") || value.contains("speaker") {
            return "audio_route_recovered"
        }
        return fallback
    }

    private func agentCallSnapshot(callId: String) -> ActiveCall? {
        withCallState { calls, _ in
            calls.values.first {
                $0.kind == .agent
                    && $0.broadcastId.caseInsensitiveCompare(callId) == .orderedSame
            }
        }
    }

    @discardableResult
    private func persistAgentStatus(
        callId: String,
        deviceId: String,
        claimReceipt: String?,
        status: AlmaAgentCallStatus,
        diagnosticCode: String? = nil,
        requiresAnswered: Bool,
        stageUntilReleased: Bool = false
    ) async -> AlmaAgentCallStatusOutbox.EnqueueResult? {
        guard let agentStatusOutbox else { return nil }
        let note = diagnosticCode.flatMap {
            try? AlmaAgentCallDiagnosticNote($0)
        }
        do {
            return try await agentStatusOutbox.enqueue(.init(
                callId: callId,
                deviceId: deviceId,
                // Once a fulfilled answer owns the row, terminal events need
                // no bearer receipt. This also minimizes its durable lifetime.
                claimReceipt: requiresAnswered ? nil : claimReceipt,
                status: status,
                note: note,
                requiresAnswered: requiresAnswered,
                stageUntilReleased: stageUntilReleased))
        } catch {
            // The durable queue deliberately retries transport/server failures.
            // Validation/storage failures contain no actionable user content and
            // must never be replaced by an unsafe free-form diagnostic POST.
            return nil
        }
    }

    private func persistAndDrainAgentStatus(
        callId: String,
        deviceId: String,
        claimReceipt: String?,
        status: AlmaAgentCallStatus,
        diagnosticCode: String? = nil,
        requiresAnswered: Bool
    ) async {
        guard await persistAgentStatus(
            callId: callId,
            deviceId: deviceId,
            claimReceipt: claimReceipt,
            status: status,
            diagnosticCode: diagnosticCode,
            requiresAnswered: requiresAnswered) != nil
        else { return }
        // enqueue() has durably completed before replay can issue HTTP.
        _ = try? await agentStatusOutbox?.replay(.manual)
    }

    private func persistAgentStatusLocally(
        _ call: ActiveCall,
        status: AlmaAgentCallStatus,
        diagnosticCode: String? = nil,
        requiresAnswered: Bool? = nil
    ) async -> AlmaAgentCallStatusOutbox.EnqueueResult? {
        guard call.kind == .agent else { return nil }
        let dependsOnAnswer = status == .completed
            || (status == .failed && (requiresAnswered ?? call.answerFulfilled))
        let stableDeviceId = installationId
        return await persistAgentStatus(
            callId: call.broadcastId,
            deviceId: stableDeviceId,
            claimReceipt: call.agentClaimReceipt,
            status: status,
            diagnosticCode: diagnosticCode,
            requiresAnswered: dependsOnAnswer,
            stageUntilReleased: true)
    }

    /// CallKit paths invoke this only after the bounded local enqueue and their
    /// OS completion. The resulting Task may perform HTTP, so it must never be
    /// placed before action.fulfill()/fail(), PushKit completion, or ended report.
    private func replayPersistedAgentStatus(
        _ persisted: AlmaAgentCallStatusOutbox.EnqueueResult?
    ) {
        guard let persisted, let agentStatusOutbox else { return }
        Task {
            if let eventId = persisted.eventId {
                _ = try? await agentStatusOutbox.releaseForReplay(eventId: eventId)
            }
            _ = try? await agentStatusOutbox.replay(.manual)
        }
    }

    private func replayPersistedAgentStatuses(
        _ persisted: [AlmaAgentCallStatusOutbox.EnqueueResult]
    ) {
        guard !persisted.isEmpty, let agentStatusOutbox else { return }
        Task {
            for eventId in persisted.compactMap(\.eventId) {
                _ = try? await agentStatusOutbox.releaseForReplay(eventId: eventId)
            }
            _ = try? await agentStatusOutbox.replay(.manual)
        }
    }

    private func replayAgentStatusOutbox(
        _ trigger: AlmaAgentCallStatusOutbox.ReplayTrigger
    ) {
        guard let agentStatusOutbox else { return }
        Task { _ = try? await agentStatusOutbox.replay(trigger) }
    }

    private static let isoFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let isoPlain = ISO8601DateFormatter()

    private static func validatedAgentClaimReceipt(_ value: Any?) -> String? {
        guard let value = value as? String,
              value.count == 43,
              value.range(
                of: #"^[A-Za-z0-9_-]{43}$"#,
                options: .regularExpression) != nil
        else { return nil }
        return value
    }

    private override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallsPerCallGroup = 1
        config.maximumCallGroups = 1
        config.supportedHandleTypes = [.generic]
        // System DEFAULT ringtone (owner 2026-07-30: "iOS default ring tone
        // rakho" — the custom alma_urgent.caf is out). Leaving ringtoneSound
        // unset makes CallKit play the user's own iOS ringtone. The ringer
        // switch / Focus still silences CallKit rings — that is iOS policy.
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    /// Bind only after the engine has minted its local evidence-session ID.
    /// CallKit delegate callbacks then retain callback-time/session attribution
    /// without waiting for the MainActor hand-off that controls media behavior.
    @discardableResult
    func bindAgentLifecycleEvidence(
        _ source: AlmaGeminiLiveSession
    ) -> AlmaLiveVoiceLifecycleSourceToken {
        agentLifecycleEvidence.bind(source)
    }

    func clearAgentLifecycleEvidence(_ source: AlmaGeminiLiveSession) {
        agentLifecycleEvidence.clear(source)
    }

    @discardableResult
    func deferAgentLifecycleEvidenceFinalization(
        _ source: AlmaGeminiLiveSession,
        token: AlmaLiveVoiceLifecycleSourceToken,
        finalizer: AlmaLiveVoiceTerminalEvidenceFinalizer
    ) -> Bool {
        agentLifecycleEvidence.deferFinalization(
            source,
            token: token,
            finalizer: finalizer)
    }

    /// Call once at launch (AppDelegate). Sets up the VoIP registry + retries token upload
    /// whenever the app becomes active (so a token minted before login still reaches the server).
    func start() {
        guard voipRegistry == nil else { return }
        let reg = PKPushRegistry(queue: .main)
        reg.delegate = self
        reg.desiredPushTypes = [.voIP]
        voipRegistry = reg
        NotificationCenter.default.addObserver(
            self, selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification, object: nil)
        agentStatusReplayMonitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            self?.replayAgentStatusOutbox(.networkBecameReachable)
        }
        agentStatusReplayMonitor.start(queue: agentStatusReplayQueue)
        replayAgentStatusOutbox(.applicationDidBecomeActive)
    }

    @objc private func appDidBecomeActive() {
        if !registered, let t = pendingToken { uploadToken(t) }
        replayAgentStatusOutbox(.applicationDidBecomeActive)
    }

    // MARK: - Token registration

    private func uploadToken(_ token: String) {
        pendingToken = token
        struct Body: Encodable {
            let platform = "ios"
            let environment: String
            let installationId: String
            let voipToken: String
            let appBuild: String?
            let buildSha: String?
        }
        struct Resp: Decodable { let ok: Bool? }
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        let info = Bundle.main.infoDictionary
        let provenance = AlmaBuildProvenanceLoader.current
        let body = Body(
            environment: environment,
            installationId: installationId,
            voipToken: token,
            appBuild: info?["CFBundleVersion"] as? String,
            buildSha: provenance.trustedCommit
        )
        Task {
            do {
                let r: Resp = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/internal/call-push/register", body: body)
                if r.ok == true { registered = true }
            } catch {
                // Not logged in yet / offline — retried on next didBecomeActive.
            }
        }
    }

    /// Remove this installation while the current account cookie is still
    /// valid. Sign-out calls this before NextAuth clears the session.
    func unregisterCurrentInstallation() async {
        struct Body: Encodable { let installationId: String }
        struct Resp: Decodable { let ok: Bool? }
        let _: Resp? = try? await AlmaAPI.shared.send(
            "DELETE", "/api/assistant/internal/call-push/register",
            body: Body(installationId: installationId))
        registered = false
    }

    // MARK: - Report an incoming call to CallKit

    /// Turn a VoIP payload into a native ringing call. MUST be called synchronously from the
    /// push handler (iOS terminates the app if a VoIP push doesn't report a call).
    private func reportIncoming(broadcastId: String, channel: String, caller: String,
                                kind: CallKind = .office,
                                agentClaimReceipt: String? = nil,
                                completion: @escaping () -> Void) {
        guard let uuid = UUID(uuidString: broadcastId) else {
            reportPlaceholderAndEnd(caller: caller, completion: completion)
            return
        }
        let insertion = reserveSystemCall(
            uuid: uuid,
            call: ActiveCall(
                broadcastId: broadcastId.lowercased(), channel: channel,
                peer: caller, direction: .incoming, kind: kind,
                agentClaimReceipt: kind == .agent ? agentClaimReceipt : nil))
        if insertion.duplicate {
            completion() // duplicate PushKit/poll delivery: one deterministic system call
            return
        }
        guard insertion.inserted else {
            reportPlaceholderAndEnd(caller: caller, completion: completion)
            return
        }
        // Tell the poll-based ring to skip this one — CallKit owns it now.
        if kind == .office {
            Task { @MainActor in AgoraIntercom.shared.markCallHandled(broadcastId) }
        }

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: caller)
        update.localizedCallerName = caller
        update.hasVideo = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsHolding = false

        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if error != nil {
                let failedCall = self?.withCallState { calls, _ in
                    calls.removeValue(forKey: uuid)
                }
                if let self, let failedCall {
                    self.stopCallLocally(failedCall)
                    self.retireAdmissionAfterLocalStop(
                        failedCall,
                        uuid: uuid)
                    if failedCall.kind == .agent {
                        Task { @MainActor in
                            let persisted = await self.persistAgentStatusLocally(
                                failedCall,
                                status: .failed,
                                diagnosticCode: "callkit_report_failed",
                                requiresAnswered: false)
                            completion()
                            self.replayPersistedAgentStatus(persisted)
                        }
                        return
                    }
                }
            } else if kind == .agent {
                // No Agora reconcile for agent calls — the server row IS the truth
                // and the ring window is enforced by expiresAt at parse time.
            } else {
                Task { @MainActor in
                    let valid = await OfficeCallCoordinator.shared.reconcileIncoming(
                        callId: broadcastId.lowercased(), channel: channel, caller: caller)
                    if !valid {
                        // The user can answer from CallKit before this post-report fetch
                        // finishes. In that case the coordinator is already advancing
                        // ANSWERED/CONNECTING; never interpret "not RINGING" as stale.
                        let coordinator = OfficeCallCoordinator.shared
                        let sameActiveCall = coordinator.activeCallId?.caseInsensitiveCompare(broadcastId) == .orderedSame
                        if !(sameActiveCall && coordinator.hasActiveCall) {
                            self?.finishReportedCall(callId: broadcastId, reason: .remoteEnded)
                        }
                    }
                }
            }
            completion()
        }
        completeSystemPreemptionForCall(uuid: uuid)
        // PushKit's mandatory report has now been submitted. Any displaced
        // Office graph can be synchronously destroyed without delaying that OS
        // deadline, and preview/non-call audio can relinquish underneath the
        // already-published CallKit owner.
        stopPreviewBeforeSystemCallReport()
    }

    func showIncomingFromPoll(callId: String, channel: String, caller: String) {
        reportIncoming(broadcastId: callId, channel: channel, caller: caller, completion: {})
    }

    func startOutgoing(
        callId: String,
        channel: String,
        peer: String,
        admissionToken: AlmaCallAudioAdmission.Token
    ) async throws {
        guard let uuid = UUID(uuidString: callId) else { throw CallKitError.invalidCallId }
        let insertion = reserveSystemCall(
            uuid: uuid,
            call: ActiveCall(
                broadcastId: callId.lowercased(), channel: channel,
                peer: peer, direction: .outgoing),
            existingAdmissionToken: admissionToken)
        if !insertion.inserted {
            finishDeferredOfficePreemptionOnly()
            throw CallKitError.callBusy
        }
        completeSystemPreemptionForCall(uuid: uuid)
        stopPreviewBeforeSystemCallReport()
        let handle = CXHandle(type: .generic, value: peer)
        let action = CXStartCallAction(call: uuid, handle: handle)
        action.isVideo = false
        let transaction = CXTransaction(action: action)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            callController.request(transaction) { [weak self] error in
                if let error {
                    let failedCall = self?.withCallState { calls, _ in
                        calls.removeValue(forKey: uuid)
                    }
                    if let failedCall {
                        self?.stopCallLocally(failedCall)
                        self?.retireAdmissionAfterLocalStop(
                            failedCall,
                            uuid: uuid)
                    }
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    func hasCall(callId: String) -> Bool {
        withCallState { calls, _ in
            calls.values.contains {
                $0.broadcastId.caseInsensitiveCompare(callId) == .orderedSame
            }
        }
    }

    func requestEnd(callId: String, reason: String) async -> Bool {
        guard let uuid = withCallState({ calls, reasons -> UUID? in
            guard let (uuid, _) = calls.first(where: {
                $0.value.broadcastId.caseInsensitiveCompare(callId) == .orderedSame
            }) else { return nil }
            reasons[uuid] = reason
            return uuid
        }) else { return false }
        let transaction = CXTransaction(action: CXEndCallAction(call: uuid))
        return await withCheckedContinuation { continuation in
            callController.request(transaction) { [weak self] error in
                if error != nil {
                    self?.withCallState { _, reasons in reasons[uuid] = nil }
                }
                continuation.resume(returning: error == nil)
            }
        }
    }

    func reportConnected(callId: String) {
        guard let uuid = withCallState({ calls, _ -> UUID? in
            guard let (uuid, call) = calls.first(where: {
                $0.value.broadcastId.caseInsensitiveCompare(callId) == .orderedSame
            }), call.direction == .outgoing else { return nil }
            return uuid
        }) else { return }
        provider.reportOutgoingCall(with: uuid, connectedAt: Date())
    }

    func finishReportedCall(callId: String, reason: CXCallEndedReason) {
        guard let retired = withCallState({ calls, reasons -> (UUID, ActiveCall)? in
            guard let (uuid, call) = calls.first(where: {
                $0.value.broadcastId.caseInsensitiveCompare(callId) == .orderedSame
            }) else { return nil }
            calls[uuid] = nil
            reasons[uuid] = nil
            return (uuid, call)
        }) else { return }
        stopCallLocally(retired.1)
        retireAdmissionAfterLocalStop(retired.1, uuid: retired.0)
        provider.reportCall(with: retired.0, endedAt: Date(), reason: reason)
    }

    /// Terminal failure after an Agent answer has already been fulfilled. The
    /// OS UUID and canonical id must still identify the same map entry; otherwise
    /// this is a stale engine callback and cannot affect a replacement call.
    @discardableResult
    func finishFailedAgentStartup(
        callId: String,
        callUUID: UUID,
        expectedGeneration: UInt64? = nil,
        note: String
    ) -> Bool {
        guard let terminal = retireFailedAgentStartup(
            callId: callId,
            callUUID: callUUID,
            expectedGeneration: expectedGeneration)
        else { return false }
        Task { @MainActor in
            let persisted = await self.persistFailedAgentStartupLocally(
                terminal,
                note: note)
            self.provider.reportCall(
                with: callUUID,
                endedAt: Date(),
                reason: .failed)
            self.replayPersistedAgentStatus(persisted)
        }
        return true
    }

    private func retireFailedAgentStartup(
        callId: String,
        callUUID: UUID,
        expectedGeneration: UInt64?
    ) -> ActiveCall? {
        let terminal = withCallState { calls, reasons -> ActiveCall? in
            guard let call = calls[callUUID],
                  call.kind == .agent,
                  call.broadcastId.caseInsensitiveCompare(callId) == .orderedSame,
                  call.agentSessionGeneration == expectedGeneration
            else { return nil }
            calls[callUUID] = nil
            reasons[callUUID] = nil
            return call
        }
        guard let terminal else { return nil }
        stopCallLocally(terminal)
        retireAdmissionAfterLocalStop(terminal, uuid: callUUID)
        return terminal
    }

    private func persistFailedAgentStartupLocally(
        _ terminal: ActiveCall,
        note: String
    ) async -> AlmaAgentCallStatusOutbox.EnqueueResult? {
        await persistAgentStatusLocally(
            terminal,
            status: .failed,
            diagnosticCode: Self.safeAgentDiagnosticCode(for: note),
            requiresAnswered: terminal.answerFulfilled)
    }

    /// Cancel an outgoing reservation even if CXStartCallAction has not reached
    /// the provider delegate yet. Removing the exact map entry makes a queued
    /// stale action fail; reporting it ended also closes an already-presented UI.
    func cancelReservedOutgoingCall(callId: String) {
        guard let retired = withCallState({ calls, reasons -> (UUID, ActiveCall)? in
            guard let (uuid, call) = calls.first(where: {
                $0.value.broadcastId.caseInsensitiveCompare(callId) == .orderedSame
                    && $0.value.direction == .outgoing
            }) else { return nil }
            _ = call
            calls[uuid] = nil
            reasons[uuid] = nil
            return (uuid, call)
        }) else { return }
        stopCallLocally(retired.1)
        retireAdmissionAfterLocalStop(retired.1, uuid: retired.0)
        provider.reportCall(with: retired.0, endedAt: Date(), reason: .failed)
    }

    /// Convert canonical server truth to the closest CallKit history reason.
    /// Local end actions are removed by CXProvider before reaching this path;
    /// this method therefore represents remote/server termination only.
    func finishReportedCall(callId: String, canonicalReason: String?) {
        let reason: CXCallEndedReason
        switch canonicalReason?.uppercased() {
        case "MISSED": reason = .unanswered
        case "DECLINED", "BUSY": reason = .declinedElsewhere
        case "FAILED", "PUSH_UNREACHABLE": reason = .failed
        default: reason = .remoteEnded
        }
        finishReportedCall(callId: callId, reason: reason)
    }

    private func reportPlaceholderAndEnd(caller: String, completion: @escaping () -> Void) {
        let uuid = UUID()
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: caller)
        update.localizedCallerName = caller
        update.hasVideo = false
        beginPlaceholderReport()
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] _ in
            self?.provider.reportCall(with: uuid, endedAt: Date(), reason: .failed)
            self?.finishPlaceholderReport()
            completion()
        }
    }

    private enum CallKitError: Error { case invalidCallId, callBusy }

    /// Call only after PushKit has submitted `reportNewIncomingCall` (or, for an
    /// outgoing reservation, before its CX transaction). This synchronously
    /// consumes the exact displaced-owner receipt; admission remains media-closed
    /// until the receipt has completed.
    private func completeSystemPreemptionForCall(uuid: UUID) {
        guard let token = withCallState({ calls, _ in
            calls[uuid]?.admissionToken
        }) else { return }
        let complete: @MainActor () -> Void = {
            _ = AlmaCallAudioAdmission.shared.completeSystemPreemption(token)
        }
        if Thread.isMainThread {
            MainActor.assumeIsolated { complete() }
        } else {
            DispatchQueue.main.sync {
                MainActor.assumeIsolated { complete() }
            }
        }
    }

    private func failActionUnlessProviderTimedOut(
        _ action: CXAction,
        uuid: UUID
    ) {
        callStateLock.lock()
        let providerAlreadyResolved = timedOutActionUUIDs.remove(uuid) != nil
        callStateLock.unlock()
        if !providerAlreadyResolved { action.fail() }
    }

    private func transitionCallAdmission(
        uuid: UUID,
        expectedCall: ActiveCall,
        phase: AlmaCallAudioAdmission.CallKitPhase
    ) -> AlmaCallAudioAdmission.Token? {
        let transition: @MainActor () -> AlmaCallAudioAdmission.Token? = {
            guard self.stillOwnsCall(expectedCall, uuid: uuid),
                  let token = expectedCall.admissionToken,
                  AlmaCallAudioAdmission.shared.transition(
                    token,
                    to: .callKit(
                        uuid: uuid,
                        callID: expectedCall.broadcastId.lowercased(),
                        kind: expectedCall.kind == .agent ? .agent : .office,
                        phase: phase)),
                  AlmaCallAudioAdmission.shared.acceptsMediaMutation(token)
            else { return nil }
            return token
        }
        if Thread.isMainThread {
            return MainActor.assumeIsolated { transition() }
        }
        return DispatchQueue.main.sync {
            MainActor.assumeIsolated { transition() }
        }
    }

    /// Called only after the matching local media path has been synchronously
    /// muted/stopped. Activated owners stay admitted through exact didDeactivate;
    /// reservations that never activated can be released immediately.
    private func retireAdmissionAfterLocalStop(_ call: ActiveCall, uuid: UUID) {
        guard let token = call.admissionToken else { return }
        let hasActivatedOwner = withCallState { _, _ in
            activatedAudioOwners.contains {
                $0.uuid == uuid && $0.admissionToken == token
            }
        }
        let retire: @MainActor () -> Void = {
            _ = AlmaCallAudioAdmission.shared.beginTeardown(token)
            if !hasActivatedOwner {
                if call.kind == .office {
                    OfficeCallCoordinator.shared
                        .callKitAudioNeverActivatedAndEnded(
                            callID: call.broadcastId,
                            admissionToken: token)
                }
                AlmaCallAudioAdmission.shared.release(token)
            }
        }
        if Thread.isMainThread {
            MainActor.assumeIsolated { retire() }
        } else {
            DispatchQueue.main.sync {
                MainActor.assumeIsolated { retire() }
            }
        }
    }

    private func stopCallLocally(_ call: ActiveCall) {
        let stop: @MainActor () -> Void = {
            if call.kind == .agent {
                AgentCallController.shared.callKitEnded(callId: call.broadcastId)
            } else {
                OfficeCallCoordinator.shared.remoteCallEndedLocally(
                    callId: call.broadcastId)
            }
        }
        if Thread.isMainThread {
            MainActor.assumeIsolated { stop() }
        } else {
            DispatchQueue.main.sync {
                MainActor.assumeIsolated { stop() }
            }
        }
    }

    /// PKPushRegistry is configured on `.main`, but poll/debug callers and future
    /// adapters must not rely on that detail. Finish the preview handoff before
    /// CallKit can ring or change the shared session.
    private func stopPreviewBeforeSystemCallReport() {
        if Thread.isMainThread {
            MainActor.assumeIsolated {
                OfficeCallCoordinator.shared
                    .finishSystemAudioPreemptionAfterRequiredReport()
                OfficeCallCoordinator.shared.prepareForSystemAudioTakeover()
                AlmaLiveVoiceNonCallAudioRegistry.shared.stopAll(
                    .restoreBeforeNextAppMutation)
                if !AlmaLiveVoicePreviewTakeoverRelay.shared
                    .stopAndRestoreBeforeAudioTakeover() {
                    AlmaLiveVoicePreviewTakeoverRelay.shared.stopBeforeAudioTakeover()
                }
            }
        } else {
            DispatchQueue.main.sync {
                MainActor.assumeIsolated {
                    OfficeCallCoordinator.shared
                        .finishSystemAudioPreemptionAfterRequiredReport()
                    OfficeCallCoordinator.shared.prepareForSystemAudioTakeover()
                    AlmaLiveVoiceNonCallAudioRegistry.shared.stopAll(
                        .restoreBeforeNextAppMutation)
                    if !AlmaLiveVoicePreviewTakeoverRelay.shared
                        .stopAndRestoreBeforeAudioTakeover() {
                        AlmaLiveVoicePreviewTakeoverRelay.shared.stopBeforeAudioTakeover()
                    }
                }
            }
        }
    }

    /// Reservation races are fail-closed. If a displaced Office owner was
    /// already muted before insertion lost a race, finish only that exact local
    /// teardown; never stop the unrelated system call that won the map.
    private func finishDeferredOfficePreemptionOnly() {
        let finish: @MainActor () -> Void = {
            OfficeCallCoordinator.shared
                .finishSystemAudioPreemptionAfterRequiredReport()
        }
        if Thread.isMainThread {
            MainActor.assumeIsolated { finish() }
        } else {
            DispatchQueue.main.sync {
                MainActor.assumeIsolated { finish() }
            }
        }
    }

    private func beginPlaceholderReport() {
        if Thread.isMainThread {
            MainActor.assumeIsolated {
                self.callStateLock.lock()
                self.placeholderReportsInFlight += 1
                self.callStateLock.unlock()
            }
        } else {
            DispatchQueue.main.sync {
                MainActor.assumeIsolated {
                    self.callStateLock.lock()
                    self.placeholderReportsInFlight += 1
                    self.callStateLock.unlock()
                }
            }
        }
    }

    private func finishPlaceholderReport() {
        callStateLock.lock()
        placeholderReportsInFlight = max(0, placeholderReportsInFlight - 1)
        callStateLock.unlock()
    }

    private func stopOfficeCallLocallyIfMatching(_ callId: String) {
        if Thread.isMainThread {
            MainActor.assumeIsolated {
                OfficeCallCoordinator.shared.remoteCallEndedLocally(callId: callId)
            }
        } else {
            DispatchQueue.main.sync {
                MainActor.assumeIsolated {
                    OfficeCallCoordinator.shared.remoteCallEndedLocally(callId: callId)
                }
            }
        }
    }
}

// MARK: - PKPushRegistryDelegate (VoIP token + incoming push)

@available(iOS 17.0, *)
extension CallKitVoIP: PKPushRegistryDelegate {
    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        registered = false
        uploadToken(token)
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        registered = false
        pendingToken = nil
        Task { await unregisterCurrentInstallation() }
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
                      for type: PKPushType, completion: @escaping () -> Void) {
        guard type == .voIP else { completion(); return }
        let d = payload.dictionaryPayload
        let broadcastId = (d["broadcastId"] as? String) ?? ""
        let caller0 = (d["caller"] as? String) ?? "বস — মারুফ"
        let event = (d["event"] as? String) ?? "ring"

        // Agent → owner call (plan C2): the AI agent ringing this phone. Same
        // envelope discipline as office calls (schema, UUID, live expiresAt) but
        // its own channel namespace and no Agora/coordinator involvement.
        if (d["type"] as? String) == "agent_call" {
            let schema = (d["schemaVersion"] as? NSNumber)?.intValue ?? (d["schemaVersion"] as? Int) ?? 0
            let expiresAt = (d["expiresAt"] as? String).flatMap {
                Self.isoFractional.date(from: $0) ?? Self.isoPlain.date(from: $0)
            }
            if event == "cancel" {
                // A cancel lands on EVERY device when one device answers
                // (multi-device stop-ring). The device that answered keeps its
                // live call — only un-answered rings are torn down.
                if !broadcastId.isEmpty {
                    let answeredHere = withCallState { calls, _ in
                        calls.contains {
                            $0.value.broadcastId.caseInsensitiveCompare(broadcastId) == .orderedSame
                                && $0.value.answered
                        }
                    }
                    if !answeredHere {
                        finishReportedCall(callId: broadcastId, reason: .remoteEnded)
                    }
                }
                reportPlaceholderAndEnd(caller: caller0, completion: completion)
                return
            }
            guard schema == 1,
                  let callId = UUID(uuidString: broadcastId)?.uuidString.lowercased(),
                  let claimReceipt = Self.validatedAgentClaimReceipt(d["claimReceipt"]),
                  let expiresAt, expiresAt > Date()
            else {
                reportPlaceholderAndEnd(caller: caller0, completion: completion)
                return
            }
            reportIncoming(broadcastId: callId, channel: "agent_\(callId)",
                           caller: "ALMA", kind: .agent,
                           agentClaimReceipt: claimReceipt,
                           completion: completion)
            // Mint the Gemini ephemeral token WHILE the phone rings — answering
            // then skips the whole Vercel round trip (abroad latency fix).
            AlmaGeminiLiveSession.prewarm()
            // Missed-call UX: if the ring window passes unanswered, close the
            // system call as UNANSWERED (shows as a missed call, WhatsApp-style)
            // instead of waiting for the server's cancel push to race in.
            let deadline = expiresAt.timeIntervalSinceNow + 2
            DispatchQueue.main.asyncAfter(deadline: .now() + max(5, deadline)) { [weak self] in
                guard let self,
                      let call = self.withCallState({ calls, _ in
                          calls.first(where: {
                              $0.value.broadcastId.caseInsensitiveCompare(callId) == .orderedSame
                          })?.value
                      }),
                      call.kind == .agent, !call.answered else { return }
                self.finishReportedCall(callId: callId, reason: .unanswered)
            }
            return
        }

        let channel = (d["channel"] as? String) ?? (broadcastId.isEmpty ? "" : "itc_\(broadcastId)")
        let caller = caller0

        // Cancel push: the caller hung up / the call was answered elsewhere before we
        // picked up. End the real ring so this phone stops instantly (WhatsApp-style).
        // iOS still requires a report on EVERY VoIP push, so satisfy that with a
        // transient placeholder call reported-and-immediately-ended (no lasting ring).
        if event == "cancel" {
            if !broadcastId.isEmpty {
                stopOfficeCallLocallyIfMatching(broadcastId)
                finishReportedCall(callId: broadcastId, reason: .remoteEnded)
            }
            reportPlaceholderAndEnd(caller: caller, completion: completion)
            return
        }

        let schema = (d["schemaVersion"] as? NSNumber)?.intValue ?? (d["schemaVersion"] as? Int) ?? 0
        let callUUID = (d["callUUID"] as? String) ?? broadcastId
        let expiresAt = (d["expiresAt"] as? String).flatMap {
            Self.isoFractional.date(from: $0) ?? Self.isoPlain.date(from: $0)
        }
        guard schema == 1,
              let callId = UUID(uuidString: broadcastId)?.uuidString.lowercased(),
              UUID(uuidString: callUUID)?.uuidString.lowercased() == callId,
              channel == "itc_\(callId)",
              let expiresAt, expiresAt > Date()
        else {
            reportPlaceholderAndEnd(caller: caller, completion: completion)
            return
        }
        reportIncoming(broadcastId: callId, channel: channel, caller: caller, completion: completion)
    }
}

// MARK: - CXProviderDelegate (answer / end / audio)

@available(iOS 17.0, *)
extension CallKitVoIP: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        callStateLock.lock()
        let resetCalls = Array(calls.values)
        let resetAdmissionTokens = Set(
            calls.values.compactMap(\.admissionToken)
                + activatedAudioOwners.map(\.admissionToken))
        calls.removeAll()
        requestedEndReasons.removeAll()
        placeholderReportsInFlight = 0
        activatedAudioOwners.removeAll()
        timedOutActionUUIDs.removeAll()
        callStateLock.unlock()

        let resetLocalMedia: @MainActor () -> OfficeCallCoordinator.CallKitEndReceipt? = {
            AgentCallController.shared.systemReset()
            let officeEndReceipt = OfficeCallCoordinator.shared.systemReset()
            OfficeCallCoordinator.shared.finishAudioTeardownAfterProviderReset()
            return officeEndReceipt
        }
        let officeEndReceipt: OfficeCallCoordinator.CallKitEndReceipt?
        if Thread.isMainThread {
            officeEndReceipt = MainActor.assumeIsolated { resetLocalMedia() }
        } else {
            officeEndReceipt = DispatchQueue.main.sync {
                MainActor.assumeIsolated { resetLocalMedia() }
            }
        }

        let releaseResetAdmissions: @MainActor () -> Void = {
            for token in resetAdmissionTokens {
                _ = AlmaCallAudioAdmission.shared.beginTeardown(token)
                AlmaCallAudioAdmission.shared.release(token)
            }
        }
        if Thread.isMainThread {
            MainActor.assumeIsolated { releaseResetAdmissions() }
        } else {
            DispatchQueue.main.sync {
                MainActor.assumeIsolated { releaseResetAdmissions() }
            }
        }

        let resetAgentCalls = resetCalls.filter { $0.kind == .agent }
        if !resetAgentCalls.isEmpty {
            Task { @MainActor in
                var persistedStatuses: [AlmaAgentCallStatusOutbox.EnqueueResult] = []
                for call in resetAgentCalls {
                    if let persisted = await self.persistAgentStatusLocally(
                        call,
                        status: .failed,
                        diagnosticCode: "callkit_provider_reset",
                        requiresAnswered: call.answerFulfilled) {
                        persistedStatuses.append(persisted)
                    }
                }
                self.replayPersistedAgentStatuses(persistedStatuses)
            }
        }

        if let officeEndReceipt {
            Task { @MainActor in
                await OfficeCallCoordinator.shared
                    .finishCallKitEndOnServer(officeEndReceipt)
            }
        }
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        guard let call = withCallState({ calls, _ in calls[action.callUUID] }),
              call.direction == .outgoing else {
            action.fail(); return
        }
        guard let admissionToken = transitionCallAdmission(
            uuid: action.callUUID,
            expectedCall: call,
            phase: .activating)
        else {
            let removed = withCallState { calls, _ in
                calls.removeValue(forKey: action.callUUID)
            }
            if let removed {
                stopCallLocally(removed)
                retireAdmissionAfterLocalStop(
                    removed,
                    uuid: action.callUUID)
                action.fail()
            } else {
                failActionUnlessProviderTimedOut(
                    action,
                    uuid: action.callUUID)
            }
            return
        }
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
        Task { @MainActor in
            guard self.stillOwnsCall(call, uuid: action.callUUID),
                  AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken)
            else {
                guard let removed = self.withCallState({ calls, _ in
                    calls.removeValue(forKey: action.callUUID)
                }) else {
                    self.failActionUnlessProviderTimedOut(
                        action,
                        uuid: action.callUUID)
                    return
                }
                self.stopCallLocally(removed)
                self.retireAdmissionAfterLocalStop(
                    removed,
                    uuid: action.callUUID)
                action.fail()
                return
            }
            guard OfficeCallCoordinator.shared.ownsCallIntent(
                callId: call.broadcastId,
                channel: call.channel)
            else {
                let removed = self.withCallState { calls, _ in
                    calls.removeValue(forKey: action.callUUID)
                }
                if let removed {
                    self.stopCallLocally(removed)
                    self.retireAdmissionAfterLocalStop(
                        removed,
                        uuid: action.callUUID)
                    action.fail()
                } else {
                    self.failActionUnlessProviderTimedOut(
                        action,
                        uuid: action.callUUID)
                }
                return
            }
            OfficeCallCoordinator.shared.callKitManaged = true
            await OfficeCallCoordinator.shared.startCall(
                channel: call.channel,
                outgoing: true,
                admissionToken: admissionToken)
            if self.stillOwnsCall(call, uuid: action.callUUID),
               AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken),
               OfficeCallCoordinator.shared.activeCallId?
                .caseInsensitiveCompare(call.broadcastId) == .orderedSame,
               OfficeCallCoordinator.shared.hasActiveCall {
                action.fulfill()
            }
            else {
                guard let removed = self.withCallState({ calls, _ in
                    calls.removeValue(forKey: action.callUUID)
                }) else {
                    self.failActionUnlessProviderTimedOut(
                        action,
                        uuid: action.callUUID)
                    return
                }
                _ = OfficeCallCoordinator.shared.takeCallKitEnd(
                    callId: call.broadcastId,
                    requestedReason: "FAILED")
                self.retireAdmissionAfterLocalStop(
                    removed,
                    uuid: action.callUUID)
                action.fail()
            }
        }
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let call = withCallState({ calls, _ in calls[action.callUUID] }) else {
            action.fail()
            return
        }
        guard let admissionToken = transitionCallAdmission(
            uuid: action.callUUID,
            expectedCall: call,
            phase: .activating)
        else {
            let removed = withCallState { calls, _ in
                calls.removeValue(forKey: action.callUUID)
            }
            if let removed {
                stopCallLocally(removed)
                retireAdmissionAfterLocalStop(
                    removed,
                    uuid: action.callUUID)
                if removed.kind == .agent {
                    Task { @MainActor in
                        let persisted = await self.persistAgentStatusLocally(
                            removed,
                            status: .failed,
                            diagnosticCode: "audio_admission_failed",
                            requiresAnswered: false)
                        action.fail()
                        self.replayPersistedAgentStatus(persisted)
                    }
                } else {
                    action.fail()
                }
            } else {
                failActionUnlessProviderTimedOut(
                    action,
                    uuid: action.callUUID)
            }
            return
        }
        if call.kind == .agent {
            withCallState { calls, _ in calls[action.callUUID]?.answered = true }
            // Start the engine immediately, durably enqueue the answer locally,
            // then fulfil. CallKit never waits on network; the brief and HTTP
            // replay remain background work after the OS action is complete.
            Task { @MainActor in
                guard self.stillOwnsCall(call, uuid: action.callUUID),
                      AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken)
                else {
                    guard let removed = self.withCallState({ calls, _ in
                        calls.removeValue(forKey: action.callUUID)
                    }) else {
                        self.failActionUnlessProviderTimedOut(
                            action,
                            uuid: action.callUUID)
                        return
                    }
                    self.stopCallLocally(removed)
                    self.retireAdmissionAfterLocalStop(
                        removed,
                        uuid: action.callUUID)
                    let persisted = await self.persistAgentStatusLocally(
                        removed,
                        status: .failed,
                        diagnosticCode: "audio_admission_failed",
                        requiresAnswered: false)
                    action.fail()
                    self.replayPersistedAgentStatus(persisted)
                    return
                }
                guard let agentSession = AgentCallController.shared.start(
                    callId: call.broadcastId,
                    purpose: "",
                    callKitUUID: action.callUUID,
                    admissionToken: admissionToken)
                else {
                    guard let terminal = self.retireFailedAgentStartup(
                        callId: call.broadcastId,
                        callUUID: action.callUUID,
                        expectedGeneration: nil)
                    else {
                        self.failActionUnlessProviderTimedOut(
                            action,
                            uuid: action.callUUID)
                        return
                    }
                    let persisted = await self.persistFailedAgentStartupLocally(
                        terminal,
                        note: "agent audio preflight failed")
                    action.fail()
                    self.provider.reportCall(
                        with: action.callUUID,
                        endedAt: Date(),
                        reason: .failed)
                    self.replayPersistedAgentStatus(persisted)
                    return
                }
                let boundGeneration = self.withCallState { calls, _ -> Bool in
                    guard let current = calls[action.callUUID],
                          current.kind == .agent,
                          current.broadcastId.caseInsensitiveCompare(call.broadcastId) == .orderedSame,
                          current.agentSessionGeneration == nil
                    else { return false }
                    calls[action.callUUID]?.agentSessionGeneration = agentSession.generation
                    return true
                }
                guard boundGeneration,
                      self.stillOwnsCall(call, uuid: action.callUUID),
                      AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken),
                      AgentCallController.shared.owns(agentSession)
                else {
                    _ = AgentCallController.shared.cancelCallKitOperation(
                        callId: call.broadcastId,
                        callKitUUID: action.callUUID,
                        expectedGeneration: agentSession.generation)
                    guard let removed = self.withCallState({ calls, _ in
                        calls.removeValue(forKey: action.callUUID)
                    }) else {
                        self.failActionUnlessProviderTimedOut(
                            action,
                            uuid: action.callUUID)
                        return
                    }
                    self.retireAdmissionAfterLocalStop(
                        removed,
                        uuid: action.callUUID)
                    let persisted = await self.persistAgentStatusLocally(
                        removed,
                        status: .failed,
                        diagnosticCode: "agent_session_binding_failed",
                        requiresAnswered: false)
                    action.fail()
                    self.replayPersistedAgentStatus(persisted)
                    return
                }
                // Write the answer intent to the local outbox before publishing
                // success to CallKit. This is a bounded UserDefaults write only;
                // HTTP is released strictly after action.fulfill().
                var answerSnapshot = call
                answerSnapshot.answered = true
                answerSnapshot.agentSessionGeneration = agentSession.generation
                let answeredPersistence = await self.persistAgentStatusLocally(
                    answerSnapshot,
                    status: .answered,
                    requiresAnswered: false)
                let answerCanComplete = answeredPersistence.map {
                    $0.disposition == .inserted || $0.disposition == .duplicatePending
                } == true
                guard answerCanComplete,
                      self.stillOwnsCall(call, uuid: action.callUUID),
                      AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken),
                      AgentCallController.shared.owns(agentSession)
                else {
                    if let terminal = self.retireFailedAgentStartup(
                        callId: call.broadcastId,
                        callUUID: action.callUUID,
                        expectedGeneration: agentSession.generation) {
                        let failedPersisted = await self.persistFailedAgentStartupLocally(
                            terminal,
                            note: answerCanComplete
                                ? "agent answer ownership changed before fulfil"
                                : "agent answer could not be persisted")
                        action.fail()
                        self.provider.reportCall(
                            with: action.callUUID,
                            endedAt: Date(),
                            reason: .failed)
                        self.replayPersistedAgentStatus(failedPersisted)
                    } else {
                        self.failActionUnlessProviderTimedOut(
                            action,
                            uuid: action.callUUID)
                    }
                    return
                }

                action.fulfill()
                let fulfilledCall = self.withCallState { calls, _ -> ActiveCall? in
                    guard var current = calls[action.callUUID],
                          current.kind == .agent,
                          current.broadcastId.caseInsensitiveCompare(call.broadcastId) == .orderedSame,
                          current.agentSessionGeneration == agentSession.generation
                    else { return nil }
                    current.answerFulfilled = true
                    calls[action.callUUID] = current
                    return current
                }
                self.replayPersistedAgentStatus(answeredPersistence)
                guard fulfilledCall != nil,
                      self.stillOwnsCall(call, uuid: action.callUUID),
                      AgentCallController.shared.owns(agentSession)
                else { return }
                let purpose = await Self.fetchAgentCallPurpose(call.broadcastId)
                if !purpose.isEmpty,
                   self.stillOwnsCall(call, uuid: action.callUUID),
                   AgentCallController.shared.owns(agentSession) {
                    AgentCallController.shared.deliverBrief(callId: call.broadcastId, purpose: purpose)
                }
            }
            return
        }
        Task { @MainActor in
            guard self.stillOwnsCall(call, uuid: action.callUUID),
                  AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken)
            else {
                guard let removed = self.withCallState({ calls, _ in
                    calls.removeValue(forKey: action.callUUID)
                }) else {
                    self.failActionUnlessProviderTimedOut(
                        action,
                        uuid: action.callUUID)
                    return
                }
                self.stopCallLocally(removed)
                self.retireAdmissionAfterLocalStop(
                    removed,
                    uuid: action.callUUID)
                action.fail()
                return
            }
            // CallKit owns the audio session — Agora must not activate/deactivate it.
            OfficeCallCoordinator.shared.callKitManaged = true
            OfficeCallCoordinator.shared.confirmCallReceipt(call.broadcastId)
            await OfficeCallCoordinator.shared.startCall(
                channel: call.channel,
                outgoing: false,
                admissionToken: admissionToken)
            if self.stillOwnsCall(call, uuid: action.callUUID),
               AlmaCallAudioAdmission.shared.acceptsMediaMutation(admissionToken),
               OfficeCallCoordinator.shared.activeCallId?
                .caseInsensitiveCompare(call.broadcastId) == .orderedSame,
               OfficeCallCoordinator.shared.hasActiveCall {
                action.fulfill()
            }
            else {
                guard let removed = self.withCallState({ calls, _ in
                    calls.removeValue(forKey: action.callUUID)
                }) else {
                    self.failActionUnlessProviderTimedOut(
                        action,
                        uuid: action.callUUID)
                    return
                }
                _ = OfficeCallCoordinator.shared.takeCallKitEnd(
                    callId: call.broadcastId,
                    requestedReason: "FAILED")
                self.retireAdmissionAfterLocalStop(
                    removed,
                    uuid: action.callUUID)
                action.fail()
            }
        }
    }

    func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        guard action is CXStartCallAction || action is CXAnswerCallAction,
              let callAction = action as? CXCallAction
        else { return }

        let callUUID = callAction.callUUID
        guard let call = withCallState({ calls, reasons -> ActiveCall? in
            guard let call = calls.removeValue(forKey: callUUID) else { return nil }
            reasons[callUUID] = nil
            timedOutActionUUIDs.insert(callUUID)
            return call
        }) else { return }

        // Remove the reservation first: every suspended start/answer task checks
        // this map after its await. Then synchronously invalidate the concrete
        // media owner so permission/network completion cannot open a late mic.
        let stopLocalMedia: @MainActor () -> OfficeCallCoordinator.CallKitEndReceipt? = {
            if call.kind == .agent {
                _ = AgentCallController.shared.cancelCallKitOperation(
                    callId: call.broadcastId,
                    callKitUUID: callUUID,
                    expectedGeneration: call.agentSessionGeneration)
                return nil
            }
            return OfficeCallCoordinator.shared.takeCallKitEnd(
                callId: call.broadcastId,
                requestedReason: "FAILED")
        }
        let officeReceipt: OfficeCallCoordinator.CallKitEndReceipt?
        if Thread.isMainThread {
            officeReceipt = MainActor.assumeIsolated { stopLocalMedia() }
        } else {
            officeReceipt = DispatchQueue.main.sync {
                MainActor.assumeIsolated { stopLocalMedia() }
            }
        }

        retireAdmissionAfterLocalStop(call, uuid: callUUID)

        if call.kind == .agent {
            Task { @MainActor in
                let persisted = await self.persistAgentStatusLocally(
                    call,
                    status: .failed,
                    diagnosticCode: action is CXAnswerCallAction
                        ? "callkit_answer_timed_out"
                        : "callkit_start_timed_out",
                    requiresAnswered: call.answerFulfilled)
                self.provider.reportCall(
                    with: callUUID,
                    endedAt: Date(),
                    reason: .failed)
                self.replayPersistedAgentStatus(persisted)
            }
        } else {
            provider.reportCall(with: callUUID, endedAt: Date(), reason: .failed)
            if let officeReceipt {
                Task { @MainActor in
                    await OfficeCallCoordinator.shared.finishCallKitEndOnServer(officeReceipt)
                }
            }
        }
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let (call, reason) = withCallState { calls, reasons in
            let call = calls.removeValue(forKey: action.callUUID)
            let reason = reasons.removeValue(forKey: action.callUUID)
            return (call, reason)
        }
        if let call, call.kind == .agent {
            Task { @MainActor in
                // Ring-stage end = decline; answered end = hang-up/complete.
                AgentCallController.shared.callKitEnded(callId: call.broadcastId)
                self.retireAdmissionAfterLocalStop(call, uuid: action.callUUID)
                let persisted = await self.persistAgentStatusLocally(
                    call,
                    status: call.answerFulfilled ? .completed : .declined,
                    requiresAnswered: call.answerFulfilled)
                action.fulfill()
                self.replayPersistedAgentStatus(persisted)
            }
            return
        }
        Task { @MainActor in
            let receipt = call.flatMap {
                OfficeCallCoordinator.shared.takeCallKitEnd(
                    callId: $0.broadcastId,
                    requestedReason: reason)
            }
            if let call {
                self.retireAdmissionAfterLocalStop(call, uuid: action.callUUID)
            }
            action.fulfill()
            if let receipt {
                await OfficeCallCoordinator.shared.finishCallKitEndOnServer(receipt)
            }
        }
    }

    // MARK: - Agent-call server leg

    private struct AgentCallDiagnosticBody: Encodable {
        let contractVersion = 2
        let deviceId: String
        let note: String
    }
    private struct AgentCallBriefResponse: Decodable {
        let status: String?
        let purpose: String?
    }

    /// Compatibility facade retained for the engine/simulator callers. Lifecycle
    /// statuses now always enter the same durable v2 queue. Note-only diagnostics
    /// remain direct because they do not advance lifecycle truth, but are reduced
    /// to a closed privacy-safe code before leaving the device.
    static func postAgentCallStatus(_ callId: String, status: String?, note: String? = nil) async {
        if let status, let lifecycle = AlmaAgentCallStatus(rawValue: status) {
            let call = shared.agentCallSnapshot(callId: callId)
            let requiresAnswered = lifecycle == .completed
                || (lifecycle == .failed && call?.answerFulfilled == true)
            let stableDeviceId = shared.installationId
            await shared.persistAndDrainAgentStatus(
                callId: callId,
                deviceId: stableDeviceId,
                claimReceipt: call?.agentClaimReceipt,
                status: lifecycle,
                diagnosticCode: note.map {
                    safeAgentDiagnosticCode(for: $0)
                },
                requiresAnswered: requiresAnswered)
            return
        }
        guard let note else { return }
        let code = safeAgentDiagnosticCode(
            for: note,
            fallback: "live_runtime_diagnostic")
        let _: AlmaAgentCallStatusServerResponse? = try? await AlmaAPI.shared.send(
            "POST",
            "/api/assistant/agent-call/\(callId)/status",
            body: AgentCallDiagnosticBody(
                deviceId: shared.installationId,
                note: code))
    }

    private static func fetchAgentCallPurpose(_ callId: String) async -> String {
        let r: AgentCallBriefResponse? = try? await AlmaAPI.shared.send(
            "GET", "/api/assistant/agent-call/\(callId)/status")
        return r?.purpose ?? ""
    }

    #if DEBUG
    /// Simulator harness: VoIP pushes can't reach the simulator, so the deep link
    /// almaerp://agent-call-test?id=<uuid> drives the exact same incoming path.
    func debugSimulateAgentRing(callId: String) {
        reportIncoming(broadcastId: callId.lowercased(),
                       channel: "agent_\(callId.lowercased())",
                       caller: "ALMA", kind: .agent, completion: {})
        AlmaGeminiLiveSession.prewarm()
    }
    #endif

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        guard let call = withCallState({ calls, _ in calls[action.callUUID] }) else {
            action.fail()
            return
        }
        Task { @MainActor in
            guard self.stillOwnsCall(call, uuid: action.callUUID) else {
                action.fail()
                return
            }
            if call.kind == .agent,
               AgentCallController.shared.activeCallId?
                .caseInsensitiveCompare(call.broadcastId) == .orderedSame {
                AgentCallController.shared.setMuted(action.isMuted)
            } else if call.kind == .office,
                      OfficeCallCoordinator.shared.activeCallId?
                        .caseInsensitiveCompare(call.broadcastId) == .orderedSame {
                OfficeCallCoordinator.shared.setMuted(action.isMuted)
            } else {
                action.fail()
                return
            }
            action.fulfill()
        }
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        let lifecycleObservation = agentLifecycleEvidence.record(.callKitAudioActivated)
        let candidate = withCallState { calls, _ in
            calls.count == 1 ? calls.first : nil
        }
        let sourceCall: ActivatedAudioOwner?
        if let candidate,
           let admissionToken = transitionCallAdmission(
                uuid: candidate.key,
                expectedCall: candidate.value,
                phase: .media) {
            sourceCall = withCallState { calls, _ in
                guard calls[candidate.key]?.admissionToken == admissionToken,
                      !activatedAudioOwners.contains(where: {
                          $0.uuid == candidate.key
                              && $0.admissionToken == admissionToken
                      })
                else {
                    return nil
                }
                let owner = ActivatedAudioOwner(
                    uuid: candidate.key,
                    call: candidate.value,
                    admissionToken: admissionToken)
                activatedAudioOwners.append(owner)
                return owner
            }
        } else {
            sourceCall = nil
        }
        AlmaVoiceAudioTrace.event(
            "callkit.didActivate",
            "category=\(audioSession.category.rawValue) mode=\(audioSession.mode.rawValue) "
                + "route=\(audioSession.currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: "+"))"
        )
        // CallKit activated the shared session — hand it to whoever owns the call
        // (Agora for office calls, the live voice engine for agent calls). Neither
        // may activate the session itself.
        Task { @MainActor in
            guard let sourceCall,
                  self.stillOwnsCall(sourceCall.call, uuid: sourceCall.uuid),
                  AlmaCallAudioAdmission.shared.acceptsMediaMutation(
                    sourceCall.admissionToken)
            else { return }
            AlmaLiveVoicePreviewTakeoverRelay.shared.stopBeforeAudioTakeover()
            if sourceCall.call.kind == .agent, let lifecycleObservation {
                AgentCallController.shared.audioSessionActivated(lifecycleObservation)
            } else if sourceCall.call.kind == .office {
                OfficeCallCoordinator.shared.audioSessionActivated()
            }
        }
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        let lifecycleObservation = agentLifecycleEvidence.record(.callKitAudioDeactivated)
        let sourceCall = withCallState { _, _ -> ActivatedAudioOwner? in
            guard !activatedAudioOwners.isEmpty else { return nil }
            return activatedAudioOwners.removeFirst()
        }
        AlmaVoiceAudioTrace.event("callkit.didDeactivate")
        // Deactivation can also be an interruption/route hand-off while the
        // call is still alive. Pause the matching graph and require the next
        // didActivate before rendering resumes.
        Task { @MainActor in
            let callStillExists = sourceCall.map {
                self.stillOwnsCall($0.call, uuid: $0.uuid)
            } ?? false
            if let sourceCall {
                if sourceCall.call.kind == .agent,
                   callStillExists,
                   let lifecycleObservation {
                    AgentCallController.shared.audioSessionDeactivated(
                        lifecycleObservation)
                } else if sourceCall.call.kind == .office {
                    OfficeCallCoordinator.shared.audioSessionDeactivated(
                        admissionToken: sourceCall.admissionToken)
                }
            }
            if let sourceCall, !callStillExists {
                _ = AlmaCallAudioAdmission.shared.beginTeardown(
                    sourceCall.admissionToken)
                AlmaCallAudioAdmission.shared.release(
                    sourceCall.admissionToken)
            }
        }
    }
}
