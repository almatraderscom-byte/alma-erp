//
//  PhoneCallKitLeg.swift
//  ALMA ERP — native audio leg for an answered CUSTOMER call (phone program step 2).
//
//  A customer call rings this phone through CallKit (VoIP push, type "sip_call").
//  Answering does NOT need the web softphone or even the app UI: this controller
//  opens a WebSocket back to the SIP gateway (wss://…/app-media?token=…) and speaks
//  the exact NGS media dialect the gateway's Gemini bot speaks — μ-law 8 kHz base64
//  `media` frames both ways — so on the VPS the app simply takes the seat the bot
//  would have taken. First connection wins the call; the token is one-time.
//
//  Audio: CallKit owns the AVAudioSession (start rendering only after
//  provider(_:didActivate:)). AVAudioEngine mic tap → resample to 8 kHz Int16 →
//  μ-law → ws; ws media → μ-law → Int16 8 kHz → player node. Echo cancellation via
//  the input node's voice processing.
//

import Foundation
import AVFoundation
import CryptoKit

// MARK: - G.711 μ-law codec (algorithmic, no tables to get wrong)

enum AlmaMuLaw {
    static func encode(_ samples: [Int16]) -> Data {
        var out = Data(capacity: samples.count)
        for s in samples { out.append(encodeSample(s)) }
        return out
    }
    static func decode(_ data: Data) -> [Int16] {
        data.map { decodeSample($0) }
    }
    private static func encodeSample(_ sample: Int16) -> UInt8 {
        let BIAS: Int32 = 0x84
        let CLIP: Int32 = 32635
        var s = Int32(sample)
        let sign: UInt8 = s < 0 ? 0x80 : 0
        if s < 0 { s = -s }
        if s > CLIP { s = CLIP }
        s += BIAS
        var exponent: UInt8 = 7
        var mask: Int32 = 0x4000
        while exponent > 0 && (s & mask) == 0 { exponent -= 1; mask >>= 1 }
        let mantissa = UInt8((s >> (Int32(exponent) + 3)) & 0x0F)
        return ~(sign | (exponent << 4) | mantissa)
    }
    private static func decodeSample(_ byte: UInt8) -> Int16 {
        let b = ~byte
        let sign = b & 0x80
        let exponent = (b >> 4) & 0x07
        let mantissa = b & 0x0F
        var s = (Int32(mantissa) << 3) + 0x84
        s <<= Int32(exponent)
        s -= 0x84
        return Int16(clamping: sign != 0 ? -s : s)
    }
}

// MARK: - Controller (CallKit adapter calls in; owns the engine)

@available(iOS 17.0, *)
@MainActor
final class SipCallController: ObservableObject {
    static let shared = SipCallController()

    /// Mirrors the live call for the native phone screen (CallKit's own UI is the
    /// primary surface; this keeps the in-app screen honest too).
    struct CallState: Equatable {
        var callId: String
        var peer: String
        var outgoing: Bool
        var connectedAt: Date?
    }
    @Published private(set) var current: CallState?

    var activeCallId: String? { current?.callId }
    private var engine: SipCallAudioEngine?

    /// Gateway closed the media socket (caller hung up). CallKitVoIP closes the
    /// system call; set once at app start.
    var onRemoteEnded: ((_ callId: String) -> Void)?
    /// Far end answered (outgoing leg went live) — CallKit timer starts here.
    var onAnswered: ((_ callId: String) -> Void)?

    /// Native outbound: mint the call server-side, then hand it to CallKit.
    /// Returns a Bangla error message, or nil on success.
    func placeOutbound(to number: String, display: String) async -> String? {
        guard current == nil else { return "একটা কল ইতিমধ্যে চলছে" }
        struct Req: Encodable { let to: String }
        struct Resp: Decodable { let ok: Bool?; let callId: String?; let token: String?; let wsUrl: String?; let error: String? }
        let resp: Resp
        do {
            resp = try await AlmaAPI.shared.send("POST", "/api/assistant/phone/app-dial", body: Req(to: number))
        } catch {
            return "কল দেওয়া গেল না — নেটওয়ার্ক সমস্যা"
        }
        guard resp.ok == true, let callId = resp.callId, let token = resp.token,
              let wsUrl = resp.wsUrl, let mediaURL = URL(string: wsUrl) else {
            return resp.error ?? "কল দেওয়া গেল না"
        }
        do {
            NSLog("[alma-sip-leg] placeOutbound: starting CallKit for %@", callId)
            try await CallKitVoIP.shared.startOutgoingSip(
                callId: callId, peer: display, mediaURL: mediaURL, token: token)
            NSLog("[alma-sip-leg] placeOutbound: CallKit transaction accepted for %@", callId)
            return nil
        } catch {
            NSLog("[alma-sip-leg] placeOutbound: startOutgoingSip threw: %@", String(describing: error))
            return "কল শুরু করা গেল না"
        }
    }

    /// CallKit answer (incoming) or start (outgoing) → open the media socket NOW
    /// (audio starts on didActivate). Returns false when a call is already active.
    func start(callId: String, mediaURL: URL, token: String,
               peer: String = "", outgoing: Bool = false) -> Bool {
        guard current == nil else { NSLog("[alma-sip-leg] start: busy"); return false }
        guard var comps = URLComponents(url: mediaURL, resolvingAgainstBaseURL: false) else { return false }
        let existing = comps.queryItems ?? []
        comps.queryItems = existing + [URLQueryItem(name: "token", value: token)]
        guard let url = comps.url, url.scheme == "wss" || url.scheme == "ws" else { NSLog("[alma-sip-leg] start: bad url"); return false }
        NSLog("[alma-sip-leg] start: opening media socket for %@", callId)
        let id = callId
        // An incoming answer is live the moment the socket opens; outgoing waits
        // for the gateway's `answered` event.
        current = CallState(callId: id, peer: peer, outgoing: outgoing,
                            connectedAt: outgoing ? nil : Date())
        let eng = SipCallAudioEngine(url: url, streamId: callId)
        eng.onClosed = { [weak self] in
            Task { @MainActor in
                guard let self, self.activeCallId == id else { return }
                self.stopEngine()
                self.onRemoteEnded?(id)
            }
        }
        eng.onAnswered = { [weak self] in
            Task { @MainActor in
                guard let self, self.activeCallId == id else { return }
                if self.current?.connectedAt == nil { self.current?.connectedAt = Date() }
                self.onAnswered?(id)
            }
        }
        engine = eng
        eng.connect()
        return true
    }

    /// Mid-call keypad tone — the gateway injects it on the PSTN leg.
    func sendDtmf(_ digit: String) {
        engine?.sendDtmf(digit)
    }

    func audioSessionActivated() {
        engine?.startAudio()
    }

    func setMuted(_ muted: Bool) {
        engine?.muted = muted
    }

    /// CallKit ended the call locally (user hung up / declined after answer path).
    func callKitEnded(callId: String) {
        guard activeCallId?.caseInsensitiveCompare(callId) == .orderedSame else { return }
        stopEngine()
    }

    private func stopEngine() {
        engine?.stop()
        engine = nil
        current = nil
    }
}

// MARK: - Audio engine + media socket

@available(iOS 17.0, *)
final class SipCallAudioEngine: NSObject {
    private let url: URL
    private let streamId: String
    private var task: URLSessionWebSocketTask?
    private let audio = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var sendConverter: AVAudioConverter?
    private var playFormat: AVAudioFormat?
    private var audioRunning = false
    private var closed = false
    var muted = false
    var onClosed: (() -> Void)?
    var onAnswered: (() -> Void)?

    /// 8 kHz mono — the PSTN's native rate; the gateway speaks nothing else.
    private let wireFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 8000, channels: 1, interleaved: true)!

    init(url: URL, streamId: String) {
        self.url = url
        self.streamId = streamId
        super.init()
    }

    // MARK: socket

    func connect() {
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()
        receiveLoop()
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let err):
                NSLog("[alma-sip-leg] ws receive failed: %@", String(describing: err))
                self.handleClosed()
            case .success(let message):
                if case .string(let text) = message { self.handleFrame(text) }
                else if case .data(let data) = message,
                        let text = String(data: data, encoding: .utf8) { self.handleFrame(text) }
                self.receiveLoop()
            }
        }
    }

    private func handleFrame(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        switch obj["event"] as? String {
        case "answered":
            DispatchQueue.main.async { self.onAnswered?() }
        case "media":
            guard let media = obj["media"] as? [String: Any],
                  let b64 = media["payload"] as? String,
                  let mu = Data(base64Encoded: b64) else { return }
            schedule(AlmaMuLaw.decode(mu))
        default:
            break
        }
    }

    /// Keypad tone request — injected by the gateway on the PSTN leg via ARI.
    func sendDtmf(_ digit: String) {
        guard let d = digit.first, "0123456789*#".contains(d) else { return }
        send(["event": "dtmf", "streamId": streamId, "digit": String(d)])
    }

    private func send(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { [weak self] err in
            if err != nil { self?.handleClosed() }
        }
    }

    private func handleClosed() {
        guard !closed else { return }
        closed = true
        NSLog("[alma-sip-leg] media socket closed (call %@)", streamId)
        DispatchQueue.main.async { self.onClosed?() }
    }

    // MARK: audio graph (started only once CallKit activates the session)

    func startAudio() {
        guard !audioRunning else { return }
        audioRunning = true
        let input = audio.inputNode
        // Echo cancellation: without it the caller hears themselves back from the
        // speakerphone path. Best-effort — a failure must not kill the call.
        try? input.setVoiceProcessingEnabled(true)

        let inFormat = input.outputFormat(forBus: 0)
        sendConverter = AVAudioConverter(from: inFormat, to: wireFormat)

        let playFmt = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: 8000, channels: 1, interleaved: false)!
        playFormat = playFmt
        audio.attach(player)
        audio.connect(player, to: audio.mainMixerNode, format: playFmt)

        // ~20 ms of mic per tap at the hardware rate keeps wire frames tight.
        let tapFrames = AVAudioFrameCount(max(160, Int(inFormat.sampleRate * 0.02)))
        input.installTap(onBus: 0, bufferSize: tapFrames, format: inFormat) { [weak self] buffer, _ in
            self?.captured(buffer)
        }
        do {
            try audio.start()
        } catch {
            // Voice processing regularly refuses to start on the Simulator (and on
            // some route changes). A call without echo-cancel beats no call at all —
            // retry once plain before giving up.
            try? input.setVoiceProcessingEnabled(false)
            sendConverter = AVAudioConverter(from: input.outputFormat(forBus: 0), to: wireFormat)
            do {
                try audio.start()
            } catch {
                NSLog("[alma-sip-leg] audio engine start failed twice: %@", String(describing: error))
                handleClosed()
                return
            }
        }
        player.play()
    }

    private func captured(_ buffer: AVAudioPCMBuffer) {
        guard !muted, let converter = sendConverter else { return }
        let ratio = wireFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }
        var fed = false
        var convError: NSError?
        converter.convert(to: out, error: &convError) { _, outStatus in
            if fed { outStatus.pointee = .noDataNow; return nil }
            fed = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard convError == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return }
        let samples = Array(UnsafeBufferPointer(start: ch[0], count: Int(out.frameLength)))
        let mu = AlmaMuLaw.encode(samples)
        send(["event": "media", "streamId": streamId,
              "media": ["payload": mu.base64EncodedString()]])
    }

    private func schedule(_ samples: [Int16]) {
        guard audioRunning, let fmt = playFormat, !samples.isEmpty,
              let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(samples.count))
        else { return }
        buf.frameLength = AVAudioFrameCount(samples.count)
        if let ch = buf.floatChannelData {
            for i in 0..<samples.count { ch[0][i] = Float(samples[i]) / 32768.0 }
        }
        player.scheduleBuffer(buf, completionHandler: nil)
    }

    func stop() {
        closed = true
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        if audioRunning {
            audio.inputNode.removeTap(onBus: 0)
            player.stop()
            audio.stop()
            audioRunning = false
        }
    }
}

// MARK: - Deterministic CallKit UUID for non-UUID call ids

/// Asterisk channel ids ("1725….123") are not UUIDs, but duplicate push delivery
/// must still map to ONE system call — so the CallKit UUID is derived from the id.
func almaDeterministicCallUUID(_ callId: String) -> UUID {
    let digest = SHA256.hash(data: Data(callId.lowercased().utf8))
    let bytes = Array(digest.prefix(16))
    return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5],
                       bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11],
                       bytes[12], bytes[13], bytes[14], bytes[15]))
}
