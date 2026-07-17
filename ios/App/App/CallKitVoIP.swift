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

@available(iOS 17.0, *)
final class CallKitVoIP: NSObject {
    static let shared = CallKitVoIP()

    private var voipRegistry: PKPushRegistry?
    private let provider: CXProvider
    private let callController = CXCallController()

    private enum CallDirection { case incoming, outgoing }
    /// CallKit is an OS adapter; OfficeCallCoordinator remains the sole source of
    /// call truth. This map only correlates CallKit action UUIDs to canonical IDs.
    private struct ActiveCall {
        let broadcastId: String
        let channel: String
        let peer: String
        let direction: CallDirection
    }
    private var calls: [UUID: ActiveCall] = [:]
    private var requestedEndReasons: [UUID: String] = [:]

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

    private static let isoFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let isoPlain = ISO8601DateFormatter()

    private override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallsPerCallGroup = 1
        config.maximumCallGroups = 1
        config.supportedHandleTypes = [.generic]
        // Ringtone: system default (a bundled .caf could be set here later).
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
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
    }

    @objc private func appDidBecomeActive() {
        if !registered, let t = pendingToken { uploadToken(t) }
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
        let body = Body(
            environment: environment,
            installationId: installationId,
            voipToken: token,
            appBuild: info?["CFBundleVersion"] as? String,
            buildSha: info?["ALMAGitCommit"] as? String
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
                                completion: @escaping () -> Void) {
        guard let uuid = UUID(uuidString: broadcastId) else {
            reportPlaceholderAndEnd(caller: caller, completion: completion)
            return
        }
        if calls[uuid] != nil {
            completion() // duplicate PushKit/poll delivery: one deterministic system call
            return
        }
        calls[uuid] = ActiveCall(
            broadcastId: broadcastId.lowercased(), channel: channel,
            peer: caller, direction: .incoming)
        // Tell the poll-based ring to skip this one — CallKit owns it now.
        Task { @MainActor in AgoraIntercom.shared.markCallHandled(broadcastId) }

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: caller)
        update.localizedCallerName = caller
        update.hasVideo = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsHolding = false

        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if error != nil {
                self?.calls[uuid] = nil
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
    }

    func showIncomingFromPoll(callId: String, channel: String, caller: String) {
        reportIncoming(broadcastId: callId, channel: channel, caller: caller, completion: {})
    }

    func startOutgoing(callId: String, channel: String, peer: String) async throws {
        guard let uuid = UUID(uuidString: callId) else { throw CallKitError.invalidCallId }
        if calls[uuid] != nil { return }
        calls[uuid] = ActiveCall(
            broadcastId: callId.lowercased(), channel: channel,
            peer: peer, direction: .outgoing)
        let handle = CXHandle(type: .generic, value: peer)
        let action = CXStartCallAction(call: uuid, handle: handle)
        action.isVideo = false
        let transaction = CXTransaction(action: action)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            callController.request(transaction) { [weak self] error in
                if let error {
                    self?.calls[uuid] = nil
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    func hasCall(callId: String) -> Bool {
        calls.values.contains { $0.broadcastId.caseInsensitiveCompare(callId) == .orderedSame }
    }

    func requestEnd(callId: String, reason: String) async -> Bool {
        guard let (uuid, _) = calls.first(where: {
            $0.value.broadcastId.caseInsensitiveCompare(callId) == .orderedSame
        }) else { return false }
        requestedEndReasons[uuid] = reason
        let transaction = CXTransaction(action: CXEndCallAction(call: uuid))
        return await withCheckedContinuation { continuation in
            callController.request(transaction) { [weak self] error in
                if error != nil { self?.requestedEndReasons[uuid] = nil }
                continuation.resume(returning: error == nil)
            }
        }
    }

    func reportConnected(callId: String) {
        guard let (uuid, call) = calls.first(where: {
            $0.value.broadcastId.caseInsensitiveCompare(callId) == .orderedSame
        }), call.direction == .outgoing else { return }
        provider.reportOutgoingCall(with: uuid, connectedAt: Date())
    }

    func finishReportedCall(callId: String, reason: CXCallEndedReason) {
        guard let (uuid, _) = calls.first(where: {
            $0.value.broadcastId.caseInsensitiveCompare(callId) == .orderedSame
        }) else { return }
        provider.reportCall(with: uuid, endedAt: Date(), reason: reason)
        calls[uuid] = nil
        requestedEndReasons[uuid] = nil
        Task { @MainActor in OfficeCallCoordinator.shared.callKitManaged = false }
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
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] _ in
            self?.provider.reportCall(with: uuid, endedAt: Date(), reason: .failed)
            completion()
        }
    }

    private enum CallKitError: Error { case invalidCallId }
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
        let channel = (d["channel"] as? String) ?? (broadcastId.isEmpty ? "" : "itc_\(broadcastId)")
        let caller = (d["caller"] as? String) ?? "বস — মারুফ"
        let event = (d["event"] as? String) ?? "ring"

        // Cancel push: the caller hung up / the call was answered elsewhere before we
        // picked up. End the real ring so this phone stops instantly (WhatsApp-style).
        // iOS still requires a report on EVERY VoIP push, so satisfy that with a
        // transient placeholder call reported-and-immediately-ended (no lasting ring).
        if event == "cancel" {
            if !broadcastId.isEmpty { finishReportedCall(callId: broadcastId, reason: .remoteEnded) }
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
        calls.removeAll()
        requestedEndReasons.removeAll()
        Task { @MainActor in await OfficeCallCoordinator.shared.systemReset() }
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        guard let call = calls[action.callUUID], call.direction == .outgoing else {
            action.fail(); return
        }
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
        Task { @MainActor in
            OfficeCallCoordinator.shared.callKitManaged = true
            await OfficeCallCoordinator.shared.startCall(channel: call.channel, outgoing: true)
            if OfficeCallCoordinator.shared.hasActiveCall { action.fulfill() }
            else {
                self.calls[action.callUUID] = nil
                OfficeCallCoordinator.shared.callKitManaged = false
                action.fail()
            }
        }
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let call = calls[action.callUUID] else { action.fail(); return }
        Task { @MainActor in
            // CallKit owns the audio session — Agora must not activate/deactivate it.
            OfficeCallCoordinator.shared.callKitManaged = true
            OfficeCallCoordinator.shared.confirmCallReceipt(call.broadcastId)
            await OfficeCallCoordinator.shared.startCall(channel: call.channel, outgoing: false)
            if OfficeCallCoordinator.shared.hasActiveCall { action.fulfill() }
            else {
                self.calls[action.callUUID] = nil
                OfficeCallCoordinator.shared.callKitManaged = false
                action.fail()
            }
        }
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let call = calls[action.callUUID]
        let reason = requestedEndReasons.removeValue(forKey: action.callUUID)
        calls[action.callUUID] = nil
        Task { @MainActor in
            if let call {
                await OfficeCallCoordinator.shared.callKitEnded(
                    callId: call.broadcastId, requestedReason: reason)
            }
            OfficeCallCoordinator.shared.callKitManaged = false
            action.fulfill()
        }
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor in OfficeCallCoordinator.shared.setMuted(action.isMuted) }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // CallKit activated the shared session — hand it to Agora (it won't re-activate).
        Task { @MainActor in OfficeCallCoordinator.shared.audioSessionActivated() }
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        // Nothing to do — the call already tore down on CXEndCallAction.
    }
}
