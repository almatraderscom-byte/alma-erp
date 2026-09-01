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
import Network

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
        /// Far phone is actually ringing (gateway's ChannelStateChange), so the UI
        /// can say "রিং হচ্ছে" in sync with reality.
        var ringing = false
    }
    @Published private(set) var current: CallState?

    var activeCallId: String? { current?.callId }
    private var engine: SipCallAudioEngine?

    /// Gateway closed the media socket (caller hung up). CallKitVoIP closes the
    /// system call; set once at app start.
    var onRemoteEnded: ((_ callId: String) -> Void)?
    /// Pre-answer failure (busy/off/no-answer) — ends the CallKit call with the
    /// matching system reason.
    var onCallFailed: ((_ callId: String, _ cause: String) -> Void)?
    /// Far end answered (outgoing leg went live) — CallKit timer starts here.
    var onAnswered: ((_ callId: String) -> Void)?
    /// Why the last outgoing attempt ended without an answer — shown on the
    /// dialler in Bangla ("লাইন ব্যস্ত", "নম্বরটি বন্ধ…"), cleared on the next dial.
    @Published var lastEndNotice: String?

    static func bangla(forCause cause: String) -> String? {
        switch cause {
        case "busy": return "লাইন ব্যস্ত"
        case "noanswer": return "ধরেননি"
        case "declined": return "কল কেটে দেওয়া হয়েছে"
        case "congestion", "chanunavail": return "নম্বরটি বন্ধ বা নেটওয়ার্কের বাইরে"
        default: return nil
        }
    }

    /// Native outbound: mint the call server-side, then hand it to CallKit.
    /// Returns a Bangla error message, or nil on success.
    func placeOutbound(to number: String, display: String) async -> String? {
        guard current == nil else { return "একটা কল ইতিমধ্যে চলছে" }
        lastEndNotice = nil
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
        #if targetEnvironment(simulator)
        NSLog("[alma-sip-leg] placeOutbound: SIM HARNESS path for %@", callId)
        return startOutboundSimHarness(callId: callId, mediaURL: mediaURL, token: token, peer: display) ? nil : "sim harness start failed"
        #else
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
        #endif
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
        eng.isOutgoing = outgoing
        eng.onClosed = { [weak self] in
            Task { @MainActor in
                guard let self, self.activeCallId == id else { return }
                self.stopEngine()
                self.onRemoteEnded?(id)
            }
        }
        eng.onRinging = { [weak self] in
            Task { @MainActor in
                guard let self, self.activeCallId == id else { return }
                self.current?.ringing = true
            }
        }
        eng.onFailed = { [weak self] cause in
            Task { @MainActor in
                guard let self, self.activeCallId == id else { return }
                self.lastEndNotice = Self.bangla(forCause: cause)
                self.stopEngine()
                self.onCallFailed?(id, cause)
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
        // ROOT CAUSE of build 120's dead-air call (device test 2026-09-01): CallKit
        // only activates the audio session — and therefore only calls
        // provider(_:didActivate:) — when the app has configured a call-capable
        // category BEFORE the action is fulfilled. Every working call path in this
        // app (Agora office, agent live voice) sets .playAndRecord/.voiceChat at
        // call start; the sip leg never did, so didActivate never fired, startAudio
        // never ran, and both directions were silence while the transport was
        // perfect (gateway saw the caller's audio; app frames=0). setActive stays
        // CallKit's job — category only here.
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
            NSLog("[alma-sip-leg] audio session category configured")
        } catch {
            NSLog("[alma-sip-leg] session category failed: %@", String(describing: error))
        }
        return true
    }

    #if targetEnvironment(simulator)
    /// Simulator-only harness: the sim's callservicesd system-ends outgoing
    /// CXStartCallAction calls after ~1 s (proven 2026-09-01), so self-testing
    /// bypasses CallKit exactly the way the agent-call sim harness does — the
    /// controller configures and activates the audio session itself. Everything
    /// else (media socket, gateway leg, codec, engine) is the REAL path.
    func startOutboundSimHarness(callId: String, mediaURL: URL, token: String, peer: String) -> Bool {
        guard start(callId: callId, mediaURL: mediaURL, token: token, peer: peer, outgoing: true) else { return false }
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .defaultToSpeaker])
        try? s.setActive(true)
        NSLog("[alma-sip-leg] SIM HARNESS: session self-activated, starting audio")
        audioSessionActivated()
        return true
    }
    #endif

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

    /// Earpiece ↔ loudspeaker (the phone-app toggle the owner asked for).
    @Published private(set) var speakerOn = false
    func setSpeaker(_ on: Bool) {
        speakerOn = on
        let s = AVAudioSession.sharedInstance()
        try? s.overrideOutputAudioPort(on ? .speaker : .none)
        // The engine stops on the route change; don't wait for the notification —
        // rebuild deterministically (device bug: speaker on = one-way audio).
        engine?.rebuildAfterRouteChange(delay: 0.25)
    }

    /// CallKit ended the call locally (user hung up / declined after answer path).
    func callKitEnded(callId: String) {
        NSLog("[alma-sip-leg] callKitEnded(%@) active=%@", callId, activeCallId ?? "nil")
        guard activeCallId?.caseInsensitiveCompare(callId) == .orderedSame else { return }
        stopEngine()
    }

    private func stopEngine() {
        engine?.stop()
        engine = nil
        current = nil
        speakerOn = false
    }
}

// MARK: - Audio engine + media socket

@available(iOS 17.0, *)
final class SipCallAudioEngine: NSObject {
    private let url: URL
    private let streamId: String
    private var conn: NWConnection?
    private let sendQueue = DispatchQueue(label: "com.almatraders.erp.sip-leg-ws")
    private let audio = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var sendConverter: AVAudioConverter?
    private var playFormat: AVAudioFormat?
    private var audioRunning = false
    private var closed = false
    var muted = false
    var onClosed: (() -> Void)?
    var onAnswered: (() -> Void)?
    var onRinging: (() -> Void)?
    var onFailed: ((String) -> Void)?

    /// 8 kHz mono — the PSTN's native rate; the gateway speaks nothing else.
    private let wireFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 8000, channels: 1, interleaved: true)!

    /// Outgoing legs generate a local ringback until answer/first media —
    /// providers here signal 183 (no ARI 'Ringing'), so a server event can't be
    /// relied on and dead silence reads as a broken call.
    var isOutgoing = false
    private var answeredOrMedia = false

    init(url: URL, streamId: String) {
        self.url = url
        self.streamId = streamId
        super.init()
    }

    // MARK: socket
    //
    // Network.framework, NOT URLSessionWebSocketTask — deliberately. The gateway's
    // TLS front (Traefik) advertises h2 and `Alt-Svc: h3`; URLSession's WebSocket
    // then intermittently attempts the newer protocols and HANGS the handshake with
    // no callback at all (2 of the owner's 3 device dials never reached the gateway;
    // the Simulator reproduced it every attempt after the first). NWConnection lets
    // us pin ALPN to http/1.1, which is the only dialect a WebSocket upgrade
    // actually needs, so the connect is deterministic.

    func connect() {
        guard let host = url.host else { handleClosed(); return }
        let port = UInt16(url.port ?? (url.scheme == "wss" ? 443 : 80))
        let tlsOptions = NWProtocolTLS.Options()
        sec_protocol_options_add_tls_application_protocol(
            tlsOptions.securityProtocolOptions, "http/1.1")
        let tcpOptions = NWProtocolTCP.Options()
        tcpOptions.noDelay = true
        let params = url.scheme == "wss"
            ? NWParameters(tls: tlsOptions, tcp: tcpOptions)
            : NWParameters(tls: nil, tcp: tcpOptions)
        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        // NWProtocolWebSocket takes the path from the URL via the request handler —
        // set it explicitly so the query (the one-time token) survives.
        var path = url.path.isEmpty ? "/" : url.path
        if let q = url.query { path += "?" + q }
        wsOptions.setAdditionalHeaders([("Host", host)])
        params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)
        let endpoint = NWEndpoint.url(URL(string: "\(url.scheme ?? "wss")://\(host):\(port)\(path)")!)
        let c = NWConnection(to: endpoint, using: params)
        conn = c
        NSLog("[alma-sip-leg] ws dialing %@:%d path=%@", host, Int(port), path)
        c.stateUpdateHandler = { [weak self] state in
            NSLog("[alma-sip-leg] ws state: %@", String(describing: state))
            switch state {
            case .ready:
                NSLog("[alma-sip-leg] ws connected (http/1.1 pinned)")
                self?.receiveLoop()
            case .failed(let err):
                NSLog("[alma-sip-leg] ws failed: %@", String(describing: err))
                self?.handleClosed()
            case .cancelled:
                self?.handleClosed()
            default:
                break
            }
        }
        c.start(queue: sendQueue)
    }

    private func receiveLoop() {
        conn?.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let error {
                NSLog("[alma-sip-leg] ws receive failed: %@", String(describing: error))
                self.handleClosed()
                return
            }
            if let data, let text = String(data: data, encoding: .utf8) {
                self.handleFrame(text)
            }
            self.receiveLoop()
        }
    }

    private func handleFrame(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        switch obj["event"] as? String {
        case "ringing":
            if isOutgoing && !answeredOrMedia { startRingback() }
            DispatchQueue.main.async { self.onRinging?() }
        case "failed":
            let cause = (obj["cause"] as? String) ?? ""
            NSLog("[alma-sip-leg] call failed: %@", cause)
            stopRingback()
            DispatchQueue.main.async { self.onFailed?(cause) }
        case "answered":
            answeredOrMedia = true
            stopRingback()
            DispatchQueue.main.async { self.onAnswered?() }
        case "media":
            answeredOrMedia = true
            stopRingback()
            guard let media = obj["media"] as? [String: Any],
                  let b64 = media["payload"] as? String,
                  let mu = Data(base64Encoded: b64) else { return }
            schedule(AlmaMuLaw.decode(mu))
        default:
            break
        }
    }

    // MARK: ringback — the audible "ring… ring…" a caller expects (owner ask:
    // WhatsApp plays one; dead silence while the far phone rings reads as broken).
    // Standard 400+450 Hz, 0.4 s on / 0.2 s off / 0.4 s on / 2 s off, generated
    // locally and fed through the SAME playout path, stopped by answer/first media.
    private var ringbackTimer: DispatchSourceTimer?
    private func startRingback() {
        guard ringbackTimer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: sendQueue)
        t.schedule(deadline: .now(), repeating: 3.0)
        t.setEventHandler { [weak self] in
            guard let self, self.audioRunning, self.ringbackTimer != nil else { return }
            self.scheduleNow(self.ringbackCadence())
        }
        ringbackTimer = t
        t.resume()
    }
    private func stopRingback() {
        ringbackTimer?.cancel()
        ringbackTimer = nil
    }
    private func ringbackCadence() -> [Int16] {
        func burst(_ seconds: Double) -> [Int16] {
            let n = Int(8000 * seconds)
            return (0..<n).map { i in
                let t = Double(i) / 8000
                let v = (sin(2 * .pi * 400 * t) + sin(2 * .pi * 450 * t)) * 0.22
                return Int16(max(-1, min(1, v)) * 12000)
            }
        }
        let gapShort = [Int16](repeating: 0, count: Int(8000 * 0.2))
        return burst(0.4) + gapShort + burst(0.4)
    }

    /// Keypad tone request — injected by the gateway on the PSTN leg via ARI.
    func sendDtmf(_ digit: String) {
        guard let d = digit.first, "0123456789*#".contains(d) else { return }
        send(["event": "dtmf", "streamId": streamId, "digit": String(d)])
    }

    private func send(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
        conn?.send(content: text.data(using: .utf8), contentContext: context,
                   isComplete: true, completion: .contentProcessed { [weak self] err in
            if err != nil { self?.handleClosed() }
        })
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
        NSLog("[alma-sip-leg] startAudio: beginning graph")
        let input = audio.inputNode
        // NO setVoiceProcessingEnabled — ever. Device-proven 2026-09-01 (builds
        // 120/121 dead air): with it enabled the input tap never fires and the
        // whole audio unit goes silent BOTH ways, on the Simulator AND on a real
        // iPhone (device console: didActivate ✓, engine running ✓, 1200 play
        // frames scheduled, zero tap callbacks, owner heard nothing). Echo
        // cancellation is already provided at the session level by CallKit's
        // .voiceChat mode, so nothing is lost.

        let inFormat = input.outputFormat(forBus: 0)
        sendConverter = AVAudioConverter(from: inFormat, to: wireFormat)

        let playFmt = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: 8000, channels: 1, interleaved: false)!
        playFormat = playFmt
        audio.attach(player)
        audio.connect(player, to: audio.mainMixerNode, format: playFmt)
        // Full volume through the whole chain — the earpiece default was noticeably
        // quiet on the first device test.
        player.volume = 1.0
        audio.mainMixerNode.outputVolume = 1.0

        // ~20 ms of mic per tap at the hardware rate keeps wire frames tight.
        let tapFrames = AVAudioFrameCount(max(160, Int(inFormat.sampleRate * 0.02)))
        input.installTap(onBus: 0, bufferSize: tapFrames, format: nil) { [weak self] buffer, _ in
            self?.captured(buffer)
        }
        // Route changes (earpiece ↔ loudspeaker, bluetooth) STOP the engine and can
        // change the hardware I/O format — without rebuilding, the speaker button
        // killed audio both ways (owner device test 2026-09-01).
        NotificationCenter.default.addObserver(
            self, selector: #selector(engineConfigChanged),
            name: .AVAudioEngineConfigurationChange, object: audio)
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
        NSLog("[alma-sip-leg] startAudio: engine running, input rate=%f", audio.inputNode.outputFormat(forBus: 0).sampleRate)
        // Ringback is started ONLY by the gateway's honest 'ringing' event now —
        // a switched-off number must never sound like it is ringing (owner bug).
    }

    private var sentFrames = 0
    private var playedFrames = 0
    private var tapCalls = 0
    private var converterInFormat: AVAudioFormat?
    private func captured(_ buffer: AVAudioPCMBuffer) {
        tapCalls += 1
        if tapCalls == 1 || tapCalls % 100 == 0 {
            NSLog("[alma-sip-leg] tap fired %d (in=%d frames @%.0f) muted=%d conv=%d",
                  tapCalls, Int(buffer.frameLength), buffer.format.sampleRate,
                  muted ? 1 : 0, sendConverter != nil ? 1 : 0)
        }
        guard !muted else { return }
        // Route changes (earpiece↔speaker↔bluetooth) can change the mic format
        // under a live tap — rebuild the converter to match the buffers we are
        // actually given, never the format cached at install time.
        if sendConverter == nil || converterInFormat != buffer.format {
            sendConverter = AVAudioConverter(from: buffer.format, to: wireFormat)
            converterInFormat = buffer.format
        }
        guard let converter = sendConverter else { return }
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
        if tapCalls == 1 || tapCalls % 100 == 0 {
            NSLog("[alma-sip-leg] convert: err=%@ outFrames=%d", convError?.localizedDescription ?? "nil", Int(out.frameLength))
        }
        guard convError == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return }
        var samples = Array(UnsafeBufferPointer(start: ch[0], count: Int(out.frameLength)))
        applySendGain(&samples)
        let mu = AlmaMuLaw.encode(samples)
        sentFrames += 1
        if sentFrames == 1 || sentFrames % 100 == 0 {
            NSLog("[alma-sip-leg] mic frames sent: %d", sentFrames)
        }
        send(["event": "media", "streamId": streamId,
              "media": ["payload": mu.base64EncodedString()]])
    }

    /// Jitter cushion: 20 ms network chunks scheduled raw starve the player on any
    /// hiccup — every starve is an audible click and the call sounds muddy/quiet
    /// (owner: "sound onk kom r crystal clear na"). Hold ~160 ms before the first
    /// schedule; after that pass-through keeps latency flat while the queue keeps
    /// a standing cushion.
    private var pendingSamples: [Int16] = []
    private var cushionFilled = false
    private let cushionSamples = 8 * 160   // 8 × 20 ms @ 8 kHz

    /// Send-side AGC. Without voice processing iOS hands over the RAW mic, which on
    /// a real iPhone measured ~20 dB too quiet (device call capture: speech peaks
    /// ≈450/32767 — the far side could barely hear, and over the loudspeaker
    /// distance heard nothing). Track the recent peak and lift speech toward a
    /// healthy level, hard-clamped, with slow decay so gain doesn't pump.
    private var agcPeak: Float = 2000
    private var rxPeak: Float = 4000
    private func applySendGain(_ samples: inout [Int16]) {
        var localPeak: Float = 1
        for x in samples { localPeak = max(localPeak, abs(Float(x))) }
        // Fast attack on louder speech, slow release toward quiet.
        agcPeak = localPeak > agcPeak ? localPeak : max(200, agcPeak * 0.995)
        let target: Float = 9000
        let gain = min(14, max(1, target / agcPeak))
        if gain <= 1.05 { return }
        for i in 0..<samples.count {
            let v = Float(samples[i]) * gain
            samples[i] = Int16(max(-32000, min(32000, v)))
        }
    }

    private func schedule(_ samples: [Int16]) {
        guard audioRunning, !samples.isEmpty else { return }
        if !cushionFilled {
            pendingSamples.append(contentsOf: samples)
            if pendingSamples.count < cushionSamples { return }
            cushionFilled = true
            let held = pendingSamples
            pendingSamples = []
            scheduleNow(held)
            return
        }
        scheduleNow(samples)
    }

    private func scheduleNow(_ samples: [Int16]) {
        guard let fmt = playFormat,
              let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(samples.count))
        else { return }
        buf.frameLength = AVAudioFrameCount(samples.count)
        playedFrames += 1
        if playedFrames == 1 || playedFrames % 100 == 0 {
            NSLog("[alma-sip-leg] play frames: %d (running=%d)", playedFrames, audioRunning ? 1 : 0)
        }
        if let ch = buf.floatChannelData {
            // Receive AGC: PSTN μ-law arrives at wildly varying (often low) levels;
            // WhatsApp-loud on the speaker needs speech lifted toward a healthy
            // peak, clamped well below clipping.
            var localPeak: Float = 1
            for x in samples { localPeak = max(localPeak, abs(Float(x))) }
            rxPeak = localPeak > rxPeak ? localPeak : max(300, rxPeak * 0.995)
            // Full-volume-on-speaker loudness (owner benchmark: WhatsApp). Higher
            // target + soft tanh limiter instead of a hard clamp, so pushed speech
            // saturates gracefully instead of crackling.
            let gain = min(14, max(1, 24000 / rxPeak))
            for i in 0..<samples.count {
                let v = Float(samples[i]) * gain / 32768.0
                ch[0][i] = tanhf(v * 1.2) / tanhf(1.2)
            }
        }
        player.scheduleBuffer(buf, completionHandler: nil)
    }

    @objc private func engineConfigChanged(_ note: Notification) {
        rebuildAfterRouteChange(delay: 0.1)
    }

    private var rebuildGeneration = 0
    /// Debounced full-graph rebuild after any route/config change. Multiple
    /// notifications within the window collapse to ONE rebuild on the final route.
    func rebuildAfterRouteChange(delay: TimeInterval) {
        rebuildGeneration += 1
        let gen = rebuildGeneration
        sendQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, gen == self.rebuildGeneration,
                  self.audioRunning, !self.closed else { return }
            NSLog("[alma-sip-leg] rebuilding audio graph (gen %d)", gen)
            let input = self.audio.inputNode
            input.removeTap(onBus: 0)
            self.sendConverter = nil
            self.converterInFormat = nil
            let inFormat = input.outputFormat(forBus: 0)
            let tapFrames = AVAudioFrameCount(max(160, Int(inFormat.sampleRate * 0.02)))
            input.installTap(onBus: 0, bufferSize: tapFrames, format: nil) { [weak self] buffer, _ in
                self?.captured(buffer)
            }
            // The player node MUST be stopped across an engine restart — a node left
            // 'playing' through stop()/start() accepts schedules but renders nothing
            // (device bug: speaker on = incoming audio dead while mic flowed fine).
            self.player.stop()
            self.audio.stop()
            self.cushionFilled = false
            self.pendingSamples = []
            do {
                try self.audio.start()
                self.player.play()
                NSLog("[alma-sip-leg] graph rebuilt, input rate=%f", inFormat.sampleRate)
            } catch {
                NSLog("[alma-sip-leg] graph rebuild failed: %@", String(describing: error))
            }
        }
    }

    func stop() {
        closed = true
        stopRingback()
        NotificationCenter.default.removeObserver(self)
        conn?.cancel()
        conn = nil
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
