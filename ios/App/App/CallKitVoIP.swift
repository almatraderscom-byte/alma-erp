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

    /// Live CallKit calls: our CallKit UUID → the office call it represents.
    private struct ActiveCall { let broadcastId: String; let channel: String }
    private var calls: [UUID: ActiveCall] = [:]

    /// Last VoIP token we obtained; re-POSTed when the app becomes active (login race).
    private var pendingToken: String?
    private var registered = false

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
        struct Body: Encodable { let platform = "ios"; let voipToken: String }
        struct Resp: Decodable { let ok: Bool? }
        Task {
            do {
                let r: Resp = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/internal/call-push/register", body: Body(voipToken: token))
                if r.ok == true { registered = true }
            } catch {
                // Not logged in yet / offline — retried on next didBecomeActive.
            }
        }
    }

    // MARK: - Report an incoming call to CallKit

    /// Turn a VoIP payload into a native ringing call. MUST be called synchronously from the
    /// push handler (iOS terminates the app if a VoIP push doesn't report a call).
    private func reportIncoming(broadcastId: String, channel: String, caller: String, completion: @escaping () -> Void) {
        let uuid = UUID()
        calls[uuid] = ActiveCall(broadcastId: broadcastId, channel: channel)
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
            if error != nil { self?.calls[uuid] = nil }
            completion()
        }
    }

    /// End a CallKit call we surfaced (e.g. the caller hung up before we answered).
    func endCallKitCall(broadcastId: String) {
        guard let (uuid, _) = calls.first(where: { $0.value.broadcastId == broadcastId }) else { return }
        provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
        calls[uuid] = nil
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
            if !broadcastId.isEmpty { endCallKitCall(broadcastId: broadcastId) }
            let uuid = UUID()
            let update = CXCallUpdate()
            update.remoteHandle = CXHandle(type: .generic, value: caller)
            update.localizedCallerName = caller
            update.hasVideo = false
            provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] _ in
                self?.provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
                completion()
            }
            return
        }

        guard !broadcastId.isEmpty, !channel.isEmpty else {
            // Still MUST report SOMETHING or iOS penalises the app — report + immediately end.
            reportIncoming(broadcastId: "unknown", channel: "", caller: caller) { [weak self] in
                self?.endCallKitCall(broadcastId: "unknown"); completion()
            }
            return
        }
        reportIncoming(broadcastId: broadcastId, channel: channel, caller: caller, completion: completion)
    }
}

// MARK: - CXProviderDelegate (answer / end / audio)

@available(iOS 17.0, *)
extension CallKitVoIP: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        calls.removeAll()
        Task { @MainActor in AgoraIntercom.shared.leave() }
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let call = calls[action.callUUID] else { action.fail(); return }
        Task { @MainActor in
            // CallKit owns the audio session — Agora must not activate/deactivate it.
            AgoraIntercom.shared.callKitManaged = true
            AgoraIntercom.shared.confirmCallReceipt(call.broadcastId)   // owner log: ধরা হয়েছে
            await AgoraIntercom.shared.startCall(channel: call.channel, outgoing: false)
            action.fulfill()
        }
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let call = calls[action.callUUID]
        calls[action.callUUID] = nil
        Task { @MainActor in
            if let call, AgoraIntercom.shared.mode == .idle {
                // Legacy receipt acknowledgement; endCall/cancel is what stops other devices.
                AgoraIntercom.shared.confirmCallReceipt(call.broadcastId)
            }
            AgoraIntercom.shared.leave()
            AgoraIntercom.shared.callKitManaged = false
            action.fulfill()
        }
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor in AgoraIntercom.shared.setMuted(action.isMuted) }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // CallKit activated the shared session — hand it to Agora (it won't re-activate).
        Task { @MainActor in AgoraIntercom.shared.audioSessionActivated() }
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        // Nothing to do — the call already tore down on CXEndCallAction.
    }
}
