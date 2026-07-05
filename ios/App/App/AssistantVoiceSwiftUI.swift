//
//  AssistantVoiceSwiftUI.swift
//  ALMA ERP — S6b: the voice-to-voice console (orb page), fully native.
//
//  A 100% clone of the web VoiceConsole (src/agent/components/voice/) — same
//  near-black canvas, state-hued aurora + dot grid, fluid orb with a 72-bar
//  reactive ring, status badge, transcript pill, live spoken-subtitle caption,
//  action-card feed, and the কথোপকথন dock — but running on native audio, which
//  also fixes the owner's two live complaints about the web orb:
//
//    • "tap করলে 2–5s পরে কাজ করে" — the web paid getUserMedia + AudioWorklet +
//      OpenAI session-mint latency on every tap. Natively the audio session is
//      prewarmed when the console opens; tapping the orb just starts an
//      AVAudioRecorder → the mic is hot in tens of milliseconds.
//    • "voice dewar agei nij thekei kaj shuru kore" — the web VAD used a fixed
//      0.045 RMS speech threshold with no ambient calibration, so room noise
//      could count as speech. The native VAD calibrates a noise floor for the
//      first 400ms, requires 250ms of SUSTAINED speech above max(0.045, floor×2.5)
//      before arming, and only then starts the end-of-utterance silence timer.
//
//  Voice turn: record (m4a) → /api/assistant/transcribe (Whisper) → /api/assistant/chat
//  {voice:true} SSE → sentence-chunked /api/assistant/tts playback (prefetch next
//  chunk while one plays) → auto-relisten in কথোপকথন mode. Same web constants:
//  silence 2600ms (1400ms for <3s utterances), 8s no-speech abort, 180s cap,
//  barge-in 0.08 RMS held 600ms, ack pool, 4s heartbeat after 14s silence.
//

import SwiftUI
import UIKit
import AVFoundation

// MARK: - State + strings (web STATUS dict parity)

enum AlmaVoiceState: String {
    case idle, listening, transcribing, thinking, speaking, error

    var statusText: String {
        switch self {
        case .idle: return "ট্যাপ করে বলুন"
        case .listening: return "শুনছি…"
        case .transcribing: return "বুঝে নিচ্ছি…"
        case .thinking: return "ভাবছি…"
        case .speaking: return "বলছি"
        case .error: return "আবার চেষ্টা করুন"
        }
    }

    /// FluidOrb hue per state (degrees, web FluidOrb.tsx).
    var hue: Double {
        switch self {
        case .idle: return 168        // cyan
        case .listening: return 145   // emerald
        case .transcribing, .thinking: return 265 // violet
        case .speaking: return 210    // azure
        case .error: return 8         // red-orange
        }
    }

    var tint: Color { Color(hue: hue / 360.0, saturation: 0.75, brightness: 0.95) }
}

// MARK: - Voice engine (recorder + VAD + TTS chunk player + turn runner)

@available(iOS 17.0, *)
@Observable
@MainActor
final class AlmaVoiceEngine {
    weak var chatVM: AssistantVM?

    var state: AlmaVoiceState = .idle
    var transcript = ""              // what the owner said (final)
    var replyText = ""               // full streamed reply
    var saidLines: [String] = []     // spoken sentences (dim)
    var nowLine = ""                 // sentence being spoken (bright)
    var lastQ = ""                   // previous exchange (history block)
    var lastA = ""
    var convoMode = true             // কথোপকথন চালু (auto-relisten)
    var listenSeconds = 0
    var micLevel: Double = 0         // 0…1 for the orb/ring
    var ttsLevel: Double = 0
    var errorToast: String?

    struct Card: Identifiable, Equatable {
        enum Kind { case tool, approval, ask }
        let id: String
        let kind: Kind
        var icon: String
        var title: String
        var sub: String
        var status: String           // run | ok | fail | wait | resolved-label
        var options: [String] = []   // ask cards
        var pendingActionId: String?
        var askCardId: String?
    }
    var cards: [Card] = []

    // internals
    private var recorder: AVAudioRecorder?
    private var vadTask: Task<Void, Never>?
    private var turnTask: Task<Void, Never>?
    private var bargeRecorder: AVAudioRecorder?
    private var bargeTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var lastUserText = ""
    private var lastToolNarration = Date.distantPast
    private var narratedFirstTool = false
    private var lastAudioAt = Date()
    private var ackData: [Data] = []
    private var ackIdx = 0
    private var sessionReady = false
    private var closed = false

    private let tts = AlmaTtsQueue()

    private var recURL: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("alma-voice-turn.m4a")
    }
    private var bargeURL: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("alma-voice-barge.m4a")
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    /// Prewarm on console open: audio session active + mic permission + ack cache +
    /// time-of-day greeting. This is what kills the web's 2–5s first-tap latency.
    func begin() {
        closed = false
        tts.engine = self
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                guard granted else {
                    self.errorToast = "মাইক্রোফোনের অনুমতি দিন — Settings থেকে Allow করুন।"
                    self.state = .error
                    return
                }
                do {
                    let s = AVAudioSession.sharedInstance()
                    try s.setCategory(.playAndRecord, mode: .voiceChat,
                                      options: [.defaultToSpeaker, .allowBluetooth])
                    try s.setActive(true)
                    self.sessionReady = true
                } catch {
                    self.errorToast = "অডিও চালু করা গেল না"
                }
                Task { await self.prefetchAcks() }
                // Greeting, exactly like the web (500ms after open).
                Task {
                    try? await Task.sleep(nanoseconds: 500_000_000)
                    guard !self.closed else { return }
                    self.tts.sayNow(self.greeting())
                }
            }
        }
    }

    func end() {
        closed = true
        vadTask?.cancel(); vadTask = nil
        turnTask?.cancel(); turnTask = nil
        stopBargeMonitor()
        heartbeatTask?.cancel(); heartbeatTask = nil
        recorder?.stop(); recorder = nil
        tts.stopAll()
        state = .idle
        Task { await chatVM?.loadMessages() }   // the voice turn lands in the thread
    }

    private func greeting() -> String {
        var cal = Calendar.current
        cal.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        let h = cal.component(.hour, from: Date())
        let word = h >= 5 && h < 12 ? "সুপ্রভাত" : h < 17 ? "শুভ দুপুর" : h < 21 ? "শুভ সন্ধ্যা" : "শুভ রাত্রি"
        return "\(word) স্যার — বলুন, কী করতে হবে।"
    }

    /// Pre-synthesize the rotating acknowledgements ("জি স্যার।"…) for instant playback.
    private func prefetchAcks() async {
        let acks = ["জি স্যার।", "আচ্ছা স্যার, দেখছি।", "ঠিক আছে স্যার।", "জি, এক্ষুনি দেখছি।"]
        for a in acks.shuffled().prefix(2) {
            if let d = try? await AssistantNet.postJSONForData(path: "/api/assistant/tts", body: ["text": a]) {
                ackData.append(d)
            }
        }
    }

    /// DEBUG self-test entry (never fires in production — used only by the local
    /// simctl hook): inject a "transcribed" utterance to exercise the full
    /// thinking → SSE → chunked-TTS → speaking → auto-relisten loop headlessly
    /// (this Mac mini has no microphone, so the mic leg can't be simulated).
    func debugInjectUtterance(_ text: String) {
        transcript = text
        runTurn(text)
    }

    // ── Orb tap (web handleTapOrb parity) ──────────────────────────────────

    func tapOrb() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        switch state {
        case .listening:
            finishListening(force: true)         // tap again = send now
        case .speaking:
            tts.stopAll()                        // tap = stop reply and talk
            startListening()
        case .idle, .error:
            tts.stopAll()
            startListening()
        case .transcribing, .thinking:
            break
        }
    }

    // ── Listening + calibrated VAD ─────────────────────────────────────────

    func startListening() {
        guard sessionReady, state != .listening else { return }
        stopBargeMonitor()
        tts.stopAll()
        do {
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 24_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            ]
            let rec = try AVAudioRecorder(url: recURL, settings: settings)
            rec.isMeteringEnabled = true
            rec.record()
            recorder = rec
            state = .listening
            nowLine = ""; saidLines = []   // fresh listen — stale caption gone
            transcript = ""
            listenSeconds = 0
            playMicChime()
            UISelectionFeedbackGenerator().selectionChanged()
            runVAD()
        } catch {
            errorToast = "মাইক্রোফোন ব্যবহার করা যাচ্ছে না — orb-এ ট্যাপ করে আবার চেষ্টা করুন।"
            state = .error
        }
    }

    /// The calibrated VAD loop — the core fix for "starts before I speak".
    private func runVAD() {
        vadTask?.cancel()
        vadTask = Task { [weak self] in
            guard let self else { return }
            let tickMs = 33.0
            var elapsed = 0.0
            var noiseFloor = 0.0, floorSamples = 0.0
            var speechThresh = 0.045                 // web default; raised by calibration
            let silenceThresh = 0.025
            var sustainedMs = 0.0                    // continuous speech accumulator
            var spoke = false
            var speechStartAt = 0.0
            var silenceMs = 0.0

            while !Task.isCancelled, let rec = self.recorder, self.state == .listening {
                rec.updateMeters()
                let db = rec.averagePower(forChannel: 0)
                let rms = pow(10.0, Double(db) / 20.0)
                self.micLevel = min(1, rms * 6)
                self.listenSeconds = Int(elapsed / 1000)

                if elapsed < 400 {
                    // Calibration window: learn the room's noise floor, never
                    // treat this window as speech.
                    noiseFloor += rms; floorSamples += 1
                    if elapsed + tickMs >= 400 && floorSamples > 0 {
                        let floor = noiseFloor / floorSamples
                        speechThresh = max(0.045, floor * 2.5)
                    }
                } else if !spoke {
                    if rms > speechThresh {
                        sustainedMs += tickMs
                        if sustainedMs >= 250 {      // must SUSTAIN speech to arm
                            spoke = true
                            speechStartAt = elapsed
                        }
                    } else {
                        sustainedMs = 0
                    }
                    // No-speech abort (web: 8s in convo mode)
                    if elapsed > 8_000 {
                        self.cancelListening(playChime: true)
                        return
                    }
                } else {
                    if rms < silenceThresh {
                        silenceMs += tickMs
                        let span = elapsed - speechStartAt
                        let window = span < 3_000 ? 1_400.0 : 2_600.0   // web adaptive window
                        if silenceMs >= window {
                            self.finishListening(force: false)
                            return
                        }
                    } else if rms > speechThresh {
                        silenceMs = 0
                    }
                }
                if elapsed > 180_000 {               // web hard cap
                    self.finishListening(force: false)
                    return
                }
                elapsed += tickMs
                try? await Task.sleep(nanoseconds: UInt64(tickMs * 1_000_000))
            }
        }
    }

    private func cancelListening(playChime: Bool) {
        vadTask?.cancel()
        recorder?.stop(); recorder = nil
        micLevel = 0
        state = .idle
        if playChime { playCloseChime() }
    }

    private func finishListening(force: Bool) {
        vadTask?.cancel()
        recorder?.stop(); recorder = nil
        micLevel = 0
        state = .transcribing
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        playAck()                                    // instant "জি স্যার।"
        Task { [weak self] in
            guard let self else { return }
            guard let audio = try? Data(contentsOf: self.recURL), audio.count > 3_000 else {
                self.state = .idle
                if !force { self.errorToast = "অডিও খুব ছোট — আবার বলুন।" }
                return
            }
            do {
                let data = try await AssistantNet.uploadMultipart(
                    path: "/api/assistant/transcribe", fileField: "file",
                    filename: "voice.m4a", mime: "audio/mp4", data: audio)
                let t = try JSONDecoder().decode(TranscribeResponse.self, from: data)
                let text = (t.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else {
                    self.state = .idle
                    self.errorToast = "শুনতে পাইনি স্যার — আরেকবার বলুন।"
                    self.scheduleAutoListen()
                    return
                }
                self.transcript = text
                self.runTurn(text)
            } catch {
                self.state = .error
                self.errorToast = "ট্রান্সক্রিপশন ব্যর্থ।"
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if self.state == .error { self.state = .idle }
            }
        }
    }

    // ── Turn (chat voice:true → chunked TTS) ───────────────────────────────

    private func runTurn(_ text: String) {
        if !lastUserText.isEmpty { lastQ = lastUserText; lastA = replyText }
        lastUserText = text
        state = .thinking
        replyText = ""
        saidLines = []; nowLine = ""
        cards.removeAll { $0.kind == .tool }
        narratedFirstTool = false
        lastAudioAt = Date()
        tts.beginTurn()
        startHeartbeat()

        let body = AssistantVM.ChatBody(conversationId: chatVM?.conversationId,
                                        message: text, files: [],
                                        modelId: chatVM?.modelId ?? "auto",
                                        voice: true)
        turnTask?.cancel()
        turnTask = Task { [weak self] in
            guard let self else { return }
            defer { self.heartbeatTask?.cancel() }
            do {
                await AlmaAPI.shared.syncCookies()
                var req = URLRequest(url: AssistantNet.base.appendingPathComponent("/api/assistant/chat"))
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = try JSONEncoder().encode(body)
                try await AssistantNet.streamEvents(request: req) { [weak self] ev in
                    self?.handle(ev)
                }
                self.tts.finishFeed()
            } catch is CancellationError {
            } catch {
                self.tts.sayNow("দুঃখিত স্যার, একটা সমস্যা হয়েছে — একটু পরে আরেকবার বলুন।")
                self.errorToast = "উত্তর পেতে ব্যর্থ"
                self.tts.finishFeed()
            }
        }
    }

    private func handle(_ ev: AgentSSEEvent) {
        switch ev.type {
        case "conversation_id":
            if let id = ev.id { chatVM?.conversationId = id }
        case "text_delta":
            replyText += ev.delta ?? ""
            tts.feed(ev.delta ?? "")
        case "tool_start":
            let name = ev.name ?? "টুল"
            cards.append(.init(id: ev.id ?? UUID().uuidString, kind: .tool, icon: "🔧",
                               title: name, sub: "", status: "run"))
            // Web: narrate the first tool immediately, then max ~1/6s.
            if !narratedFirstTool || Date().timeIntervalSince(lastToolNarration) > 6 {
                narratedFirstTool = true
                lastToolNarration = Date()
                tts.sayNow("\(name), স্যার…")
            }
        case "tool_end":
            if let i = cards.firstIndex(where: { $0.id == ev.id }) {
                cards[i].status = ev.success == false ? "fail" : "ok"
                cards[i].sub = String((ev.resultPreview ?? "").prefix(80))
            }
        case "ask_card":
            if let aid = ev.askCardId {
                let q = ev.question ?? ""
                let opts = ev.options ?? []
                cards.append(.init(id: aid, kind: .ask, icon: "❓", title: q, sub: "",
                                   status: "wait", options: opts, askCardId: aid))
                tts.sayNow(q)
                if !opts.isEmpty { tts.sayNow("\(opts.joined(separator: ", নাকি ")) — কোনটা, স্যার?") }
            }
        case "confirm_card":
            if let pid = ev.pendingActionId {
                cards.append(.init(id: pid, kind: .approval, icon: "🛡️",
                                   title: "আপনার অনুমোদন দরকার",
                                   sub: ev.summary ?? "", status: "wait", pendingActionId: pid))
                tts.sayNow("স্যার, একটা অনুমোদন দরকার — \(String((ev.summary ?? "").prefix(120)))")
            }
        case "done":
            break
        case "error":
            tts.sayNow("দুঃখিত স্যার, একটা সমস্যা হয়েছে — একটু পরে আরেকবার বলুন।")
        default:
            break
        }
    }

    /// Web heartbeat: every 4s while thinking, if silent for 14s say "এখনো কাজ চলছে…".
    private func startHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                guard let self, self.state == .thinking else { continue }
                if Date().timeIntervalSince(self.lastAudioAt) > 14 {
                    self.lastAudioAt = Date()
                    self.tts.sayNow("এখনো কাজ চলছে স্যার, একটু সময় দিন…")
                }
            }
        }
    }

    // ── Card actions ───────────────────────────────────────────────────────

    func approve(_ card: Card, yes: Bool) {
        guard let pid = card.pendingActionId else { return }
        if let i = cards.firstIndex(where: { $0.id == card.id }) {
            cards[i].status = yes ? "অনুমোদিত" : "বাতিল"
        }
        Task { [weak self] in
            await self?.chatVM?.approveAction(pid, approve: yes)
            self?.tts.sayNow(yes ? "অনুমোদন করে দিয়েছি স্যার, কাজ এগোচ্ছে।" : "বাতিল করে দিয়েছি, স্যার।")
        }
    }

    func answer(_ card: Card, option: String) {
        guard let aid = card.askCardId else { return }
        if let i = cards.firstIndex(where: { $0.id == card.id }) {
            cards[i].status = option
        }
        Task { [weak self] in
            await self?.chatVM?.answerAskCard(aid, option: option)
        }
    }

    // ── TTS callbacks (from AlmaTtsQueue) ──────────────────────────────────

    func ttsDidStartFirstChunk() {
        lastAudioAt = Date()
        if state == .thinking || state == .transcribing { state = .speaking }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        startBargeMonitor()
    }

    func ttsDidStartChunk(_ text: String) {
        lastAudioAt = Date()
        if !nowLine.isEmpty { saidLines.append(nowLine) }
        if saidLines.count > 2 { saidLines.removeFirst(saidLines.count - 2) }
        nowLine = text
    }

    func ttsLevelChanged(_ level: Double) { ttsLevel = level }

    func ttsAllDone() {
        stopBargeMonitor()
        ttsLevel = 0
        if !nowLine.isEmpty { saidLines.append(nowLine); nowLine = "" }
        if state == .speaking || state == .thinking {
            state = .idle
            scheduleAutoListen()
        }
    }

    private func scheduleAutoListen() {
        guard convoMode, !closed else { return }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 450_000_000)   // web: 450ms
            guard let self, !self.closed, self.state == .idle else { return }
            self.startListening()
        }
    }

    // ── Barge-in (talk over the reply) ─────────────────────────────────────

    private func startBargeMonitor() {
        guard convoMode else { return }
        stopBargeMonitor()
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
        ]
        guard let rec = try? AVAudioRecorder(url: bargeURL, settings: settings) else { return }
        rec.isMeteringEnabled = true
        rec.record()
        bargeRecorder = rec
        bargeTask = Task { [weak self] in
            var heldMs = 0.0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 50_000_000)
                guard let self, let r = self.bargeRecorder, self.state == .speaking else { continue }
                r.updateMeters()
                let rms = pow(10.0, Double(r.averagePower(forChannel: 0)) / 20.0)
                if rms > 0.08 { heldMs += 50 } else { heldMs = 0 }   // web: 0.08 held 600ms
                if heldMs >= 600 {
                    self.tts.stopAll()
                    self.startListening()
                    return
                }
            }
        }
    }

    private func stopBargeMonitor() {
        bargeTask?.cancel(); bargeTask = nil
        bargeRecorder?.stop(); bargeRecorder = nil
        try? FileManager.default.removeItem(at: bargeURL)
    }

    // ── Chimes + acks ──────────────────────────────────────────────────────

    private func playAck() {
        guard !ackData.isEmpty else { return }
        let d = ackData[ackIdx % ackData.count]; ackIdx += 1
        tts.playRaw(d)
    }
    private func playMicChime() { AudioServicesPlaySystemSound(1113) }   // begin-record
    private func playCloseChime() { AudioServicesPlaySystemSound(1114) } // end-record
}

// MARK: - Sentence-chunked TTS queue (web tts-chunk-player parity)

/// Cuts streamed text on Bangla sentence boundaries ([।?!\n], min 24 chars),
/// synthesizes each via /api/assistant/tts, plays sequentially on AVAudioPlayer
/// (metering drives the orb) and prefetches the next chunk while one plays.
@available(iOS 17.0, *)
@MainActor
final class AlmaTtsQueue: NSObject, AVAudioPlayerDelegate {
    weak var engine: AlmaVoiceEngine?

    private var buffer = ""
    private var queue: [String] = []
    private var prefetched: [String: Data] = [:]
    private var player: AVAudioPlayer?
    private var currentText = ""
    private var fedAnything = false
    private var startedFirst = false
    private var feedFinished = false
    private var meterTask: Task<Void, Never>?
    private var pumping = false

    /// Reset the per-turn flags (greeting/acks must not count as the reply's
    /// first chunk — that kept the state stuck on "ভাবছি" during playback).
    func beginTurn() {
        startedFirst = false
        fedAnything = false
        feedFinished = false
        buffer = ""
    }

    func feed(_ delta: String) {
        fedAnything = true
        feedFinished = false
        buffer += delta
        cutSentences(flush: false)
        pump()
    }

    /// Speak a line immediately after whatever is playing (narrations, acks).
    func sayNow(_ text: String) {
        fedAnything = true
        queue.append(text)
        pump()
    }

    func finishFeed() {
        feedFinished = true
        cutSentences(flush: true)
        pump()
        if !fedAnything && player == nil { engine?.ttsAllDone() }
    }

    func stopAll() {
        buffer = ""; queue.removeAll(); prefetched.removeAll()
        meterTask?.cancel()
        player?.stop(); player = nil
        startedFirst = false
        fedAnything = false
        feedFinished = false
    }

    func playRaw(_ data: Data) {
        guard player == nil else { return }   // never talk over a reply chunk
        if let p = try? AVAudioPlayer(data: data) {
            player = p
            p.delegate = self
            p.isMeteringEnabled = true
            p.play()
            runMeter()
        }
    }

    private func cutSentences(flush: Bool) {
        while let r = buffer.rangeOfCharacter(from: CharacterSet(charactersIn: "।?!\n")) {
            let chunk = String(buffer[..<r.upperBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            let rest = String(buffer[r.upperBound...])
            if chunk.count >= 24 || flush {
                buffer = rest
                if !chunk.isEmpty { queue.append(chunk) }
            } else if rest.isEmpty {
                break            // crumb — wait for more text
            } else {
                // Short sentence followed by more text: merge forward.
                buffer = chunk + " " + rest
                if let r2 = rest.rangeOfCharacter(from: CharacterSet(charactersIn: "।?!\n")) {
                    _ = r2 // keep looping
                } else { break }
            }
        }
        if flush {
            let tail = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
            if !tail.isEmpty { queue.append(tail) }
            buffer = ""
        }
    }

    private func pump() {
        guard player == nil, !pumping else { prefetchNext(); return }
        guard !queue.isEmpty else {
            if feedFinished && player == nil && fedAnything { engine?.ttsAllDone() }
            return
        }
        pumping = true
        let text = queue.removeFirst()
        Task { [weak self] in
            guard let self else { return }
            defer { self.pumping = false }
            let data: Data
            if let d = self.prefetched.removeValue(forKey: text) {
                data = d
            } else if let d = try? await AssistantNet.postJSONForData(
                path: "/api/assistant/tts", body: ["text": String(text.prefix(600))]) {
                data = d
            } else {
                self.pump(); return   // skip a failed chunk, keep going
            }
            guard let p = try? AVAudioPlayer(data: data) else { self.pump(); return }
            self.player = p
            p.delegate = self
            p.isMeteringEnabled = true
            self.currentText = text
            if !self.startedFirst {
                self.startedFirst = true
                self.engine?.ttsDidStartFirstChunk()
            }
            self.engine?.ttsDidStartChunk(text)
            p.play()
            self.runMeter()
            self.prefetchNext()
        }
    }

    private func prefetchNext() {
        guard let next = queue.first, prefetched[next] == nil else { return }
        Task { [weak self] in
            if let d = try? await AssistantNet.postJSONForData(
                path: "/api/assistant/tts", body: ["text": String(next.prefix(600))]) {
                self?.prefetched[next] = d
            }
        }
    }

    private func runMeter() {
        meterTask?.cancel()
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 50_000_000)
                guard let self, let p = self.player, p.isPlaying else { continue }
                p.updateMeters()
                let rms = pow(10.0, Double(p.averagePower(forChannel: 0)) / 20.0)
                self.engine?.ttsLevelChanged(min(1, rms * 4))
            }
        }
    }

    nonisolated func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.meterTask?.cancel()
            self.player = nil
            self.engine?.ttsLevelChanged(0)
            self.pump()
        }
    }
}


// MARK: - The console view — the owner's Voice Orb bundle, reproduced 1:1
//
// Source of truth: voiceorbbundle/voice-orb-react.html + HANDOFF.md (owner
// supplied, 2026-07-06): light-theme GLASS orb page — radial sky background,
// uppercase status line (idle: "মাইকে ট্যাপ করে বলুন" with the verb in accent
// blue #2f7fe0), sliders glyph top-right toggling light/dark, the layered glass
// orb center (halo → contact shadow → sphere → subsurface → two counter-rotating
// iridescent conic fluids → gloss → specular hotspots → fresnel ring, breathing
// 6s idle / 2.6s thinking, floaty ±2.5% 6.5s, listening scale = 1 + level×0.10),
// and two 64px white circle buttons at the bottom (mic — solid #2f7fe0 while
// listening — and ✕). Functional extras kept subtle: transcript/subtitle lines
// under the orb and the approval/ask cards, styled to the same light design.

@available(iOS 17.0, *)
struct AlmaVoiceConsoleView: View {
    let vm: AssistantVM
    @State private var engine = AlmaVoiceEngine()
    @State private var darkMode = false
    @Environment(\.dismiss) private var dismiss

    private var accent: Color { Color(red: 0.184, green: 0.498, blue: 0.878) }      // #2f7fe0
    private var textColor: Color {
        darkMode ? Color(red: 0.859, green: 0.902, blue: 0.969)                      // #dbe6f7
                 : Color(red: 0.169, green: 0.227, blue: 0.322)                      // #2b3a52
    }

    var body: some View {
        ZStack {
            background.ignoresSafeArea()
            VStack(spacing: 0) {
                topBar
                Spacer(minLength: 6)
                AlmaGlassOrbView(state: engine.state,
                                 micLevel: engine.micLevel,
                                 ttsLevel: engine.ttsLevel,
                                 dark: darkMode)
                    .frame(width: orbSide, height: orbSide)
                    .contentShape(Circle())
                    .onTapGesture { engine.tapOrb() }
                statusLine
                    .padding(.top, 26)
                transcriptAndCaption
                cardsFeed
                Spacer(minLength: 6)
                controls
            }
        }
        .preferredColorScheme(darkMode ? .dark : .light)
        .onAppear {
            engine.chatVM = vm
            engine.begin()
            // DEBUG self-test hook (env set only by local simctl self-tests).
            if let say = ProcessInfo.processInfo.environment["ALMA_VOICE_SAY"], !say.isEmpty {
                DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                    engine.debugInjectUtterance(say)
                }
            }
        }
        .onDisappear { engine.end() }
        .overlay(alignment: .top) {
            if let t = engine.errorToast {
                Text(t)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(textColor)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.top, 54)
                    .onAppear {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) {
                            if engine.errorToast == t { engine.errorToast = nil }
                        }
                    }
            }
        }
    }

    private var orbSide: CGFloat {
        // clamp(220px, 60vw, 320px)
        min(320, max(220, UIScreen.main.bounds.width * 0.60))
    }

    /// Screen bg — radial-gradient(130% 120% at 50% 22%): light #ffffff→#eef4fc→#dde8f5,
    /// dark #121826→#0a0e17→#04060c.
    private var background: some View {
        GeometryReader { geo in
            RadialGradient(stops: darkMode
                ? [.init(color: Color(red: 0.071, green: 0.094, blue: 0.149), location: 0),
                   .init(color: Color(red: 0.039, green: 0.055, blue: 0.090), location: 0.55),
                   .init(color: Color(red: 0.016, green: 0.024, blue: 0.047), location: 1)]
                : [.init(color: .white, location: 0),
                   .init(color: Color(red: 0.933, green: 0.957, blue: 0.988), location: 0.52),
                   .init(color: Color(red: 0.867, green: 0.910, blue: 0.961), location: 1)],
                center: .init(x: 0.5, y: 0.22),
                startRadius: 0,
                endRadius: max(geo.size.width, geo.size.height) * 1.25)
        }
    }

    private var topBar: some View {
        HStack {
            Button {
                engine.end()
                dismiss()
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color(red: 0.624, green: 0.690, blue: 0.784)) // #9fb0c8
                    .frame(width: 44, height: 44)
            }
            Spacer()
            Button {
                UISelectionFeedbackGenerator().selectionChanged()
                withAnimation(.easeInOut(duration: 0.35)) { darkMode.toggle() }
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Color(red: 0.624, green: 0.690, blue: 0.784)) // #9fb0c8
                    .frame(width: 44, height: 44)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 6)
    }

    /// Uppercase-styled status: idle shows "মাইকে ট্যাপ করে বলুন" with the verb in blue.
    private var statusLine: some View {
        Group {
            if engine.state == .idle {
                (Text("মাইকে ট্যাপ করে ").foregroundColor(textColor.opacity(0.55))
                 + Text("বলুন").foregroundColor(accent))
            } else {
                Text(engine.state.statusText)
                    .foregroundColor(engine.state == .error
                                     ? Color(red: 0.878, green: 0.478, blue: 0.373)
                                     : textColor.opacity(0.55))
            }
        }
        .font(.system(size: 13, weight: .semibold))
        .tracking(1.8)
    }

    @ViewBuilder private var transcriptAndCaption: some View {
        VStack(spacing: 7) {
            if !engine.transcript.isEmpty && engine.state != .idle {
                Text(engine.transcript)
                    .font(.system(size: 13))
                    .foregroundStyle(textColor.opacity(0.55))
                    .lineLimit(1)
                    .padding(.horizontal, 30)
            }
            if !engine.nowLine.isEmpty {
                Text(engine.nowLine)
                    .font(.system(size: 15.5, weight: .medium))
                    .foregroundStyle(textColor)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 26)
            } else if engine.state == .listening {
                Text("চুপ করলেই পাঠিয়ে দেব — তাড়া নেই, \(engine.listenSeconds / 60):\(String(format: "%02d", engine.listenSeconds % 60))")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(textColor.opacity(0.45))
            }
        }
        .padding(.top, 12)
        .frame(minHeight: 56, alignment: .top)
    }

    @ViewBuilder private var cardsFeed: some View {
        if !engine.cards.isEmpty {
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(engine.cards) { card in
                        cardView(card)
                    }
                }
                .padding(.horizontal, 22)
            }
            .frame(maxHeight: 150)
        }
    }

    @ViewBuilder private func cardView(_ card: AlmaVoiceEngine.Card) -> some View {
        HStack(spacing: 10) {
            Text(card.icon).font(.system(size: 14))
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(textColor)
                    .lineLimit(2)
                if !card.sub.isEmpty {
                    Text(card.sub)
                        .font(.system(size: 11))
                        .foregroundStyle(textColor.opacity(0.55))
                        .lineLimit(1)
                }
                if card.kind == .ask && card.status == "wait" {
                    HStack(spacing: 6) {
                        ForEach(card.options.prefix(4), id: \.self) { opt in
                            Button {
                                engine.answer(card, option: opt)
                            } label: {
                                Text(opt)
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(accent)
                                    .padding(.horizontal, 10).padding(.vertical, 4)
                                    .background(accent.opacity(0.10), in: Capsule())
                            }
                        }
                    }
                    .padding(.top, 3)
                }
                if card.kind == .approval && card.status == "wait" {
                    HStack(spacing: 8) {
                        Button {
                            engine.approve(card, yes: true)
                        } label: {
                            Text("অনুমোদন")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 12).padding(.vertical, 5)
                                .background(accent, in: Capsule())
                        }
                        Button {
                            engine.approve(card, yes: false)
                        } label: {
                            Text("বাতিল")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(textColor.opacity(0.6))
                                .padding(.horizontal, 12).padding(.vertical, 5)
                                .background(textColor.opacity(0.06), in: Capsule())
                        }
                    }
                    .padding(.top, 3)
                }
            }
            Spacer(minLength: 0)
            if card.kind == .tool {
                if card.status == "run" { ProgressView().controlSize(.mini) }
                else if card.status == "fail" {
                    Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(.red)
                } else {
                    Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(.green)
                }
            }
        }
        .padding(11)
        .background((darkMode ? Color.white.opacity(0.06) : Color.white.opacity(0.9)),
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(Color(red: 0.078, green: 0.157, blue: 0.314).opacity(darkMode ? 0.0 : 0.08), lineWidth: 1))
        .shadow(color: Color(red: 0.275, green: 0.431, blue: 0.667).opacity(darkMode ? 0 : 0.10), radius: 10, y: 5)
    }

    /// Bottom controls: mic (left, solid blue while listening) + ✕ (right) — 64px
    /// white circles, black icons, exactly like the bundle.
    private var controls: some View {
        VStack(spacing: 10) {
            HStack {
                circleButton(icon: engine.state == .listening ? "mic.fill" : "mic",
                             on: engine.state == .listening) {
                    engine.tapOrb()
                }
                Spacer()
                circleButton(icon: "xmark", on: false) {
                    engine.end()
                    dismiss()
                }
            }
            .frame(maxWidth: 320)
            .padding(.horizontal, 42)
            // কথোপকথন mode — the one functional extra (auto-relisten), kept discreet.
            Button {
                engine.convoMode.toggle()
                UISelectionFeedbackGenerator().selectionChanged()
            } label: {
                HStack(spacing: 5) {
                    Circle().fill(engine.convoMode ? accent : textColor.opacity(0.3))
                        .frame(width: 6, height: 6)
                    Text(engine.convoMode ? "কথোপকথন চালু" : "কথোপকথন বন্ধ")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(textColor.opacity(0.5))
                }
            }
        }
        .padding(.bottom, 24)
    }

    private func circleButton(icon: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            action()
        } label: {
            Image(systemName: icon)
                .font(.system(size: 21, weight: .medium))
                .foregroundStyle(on ? .white : Color(red: 0.063, green: 0.082, blue: 0.122)) // #10151f
                .frame(width: 64, height: 64)
                .background(on ? accent : Color.white.opacity(0.9), in: Circle())
                .overlay(Circle().strokeBorder(Color(red: 0.078, green: 0.157, blue: 0.314).opacity(0.08), lineWidth: 1))
                .shadow(color: on ? accent.opacity(0.45) : Color(red: 0.275, green: 0.431, blue: 0.667).opacity(0.22),
                        radius: on ? 15 : 13, y: on ? 12 : 10)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - The glass orb — bundle layer stack, 1:1
//
// halo → contact shadow → [circle-clipped: sphere → subsurf → fluid c1/c2 →
// gloss → spec + spec.small → ring] with breathe (stage) + floaty (orb) motion.

@available(iOS 17.0, *)
struct AlmaGlassOrbView: View {
    let state: AlmaVoiceState
    let micLevel: Double
    let ttsLevel: Double
    let dark: Bool

    /// Bundle timings.
    private var breatheDuration: Double? {
        switch state {
        case .idle, .error: return 6.0
        case .transcribing, .thinking: return 2.6
        case .listening, .speaking: return nil       // JS drives scale from audio
        }
    }
    private var c1Duration: Double {
        switch state {
        case .listening, .speaking: return 10
        case .transcribing, .thinking: return 4.5
        default: return 18
        }
    }
    private var c2Duration: Double {
        switch state {
        case .transcribing, .thinking: return 6
        default: return 26
        }
    }

    var body: some View {
        GeometryReader { geo in
            let side = min(geo.size.width, geo.size.height)
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                // breathe: scale 1→1.04 ease-in-out; listening/speaking: 1 + level*0.10
                let level = state == .speaking ? ttsLevel : micLevel
                let scale: Double = {
                    if let d = breatheDuration {
                        return 1 + 0.02 * (1 - cos(2 * .pi * t / d))       // 1 ↔ 1.04
                    }
                    return 1 + min(1, max(0, level)) * 0.10
                }()
                // floaty: translateY -2.5% ↔ +2.5%, 6.5s
                let floatY = -0.025 * cos(2 * .pi * t / 6.5) * side
                // shadowPulse runs opposite the float
                let shadowK = (1 - cos(2 * .pi * t / 6.5)) / 2              // 0…1
                ZStack {
                    // ── halo (inset -40%, blur 26) ─────────────────────────
                    ZStack {
                        RadialGradient(colors: dark
                            ? [Color(red: 0.392, green: 0.706, blue: 1.0).opacity(0.7),
                               Color(red: 0.314, green: 0.588, blue: 1.0).opacity(0.24), .clear]
                            : [Color(red: 0.353, green: 0.667, blue: 1.0).opacity(0.5),
                               Color(red: 0.314, green: 0.588, blue: 1.0).opacity(0.16), .clear],
                            center: .init(x: 0.5, y: 0.46), startRadius: 0, endRadius: side * 0.9)
                        RadialGradient(colors: dark
                            ? [Color(red: 0.549, green: 0.471, blue: 1.0).opacity(0.4), .clear]
                            : [Color(red: 0.471, green: 0.431, blue: 1.0).opacity(0.28), .clear],
                            center: .init(x: 0.62, y: 0.60), startRadius: 0, endRadius: side * 0.72)
                    }
                    .frame(width: side * 1.8, height: side * 1.8)
                    .clipShape(Circle())
                    .blur(radius: 26)

                    // ── contact shadow (below, pulses opposite the float) ──
                    Ellipse()
                        .fill(RadialGradient(colors: dark
                            ? [Color.black.opacity(0.55), .clear]
                            : [Color(red: 0.118, green: 0.275, blue: 0.588).opacity(0.32), .clear],
                            center: .center, startRadius: 0, endRadius: side * 0.32))
                        .frame(width: side * 0.62, height: side * 0.08)
                        .blur(radius: 9)
                        .offset(y: side * 0.52)
                        .scaleEffect(1 - 0.18 * shadowK)
                        .opacity(0.85 - 0.30 * shadowK)

                    // ── the orb (floaty) ───────────────────────────────────
                    ZStack {
                        // sphere — volumetric radial + inner shadows
                        Circle().fill(
                            RadialGradient(stops: [
                                .init(color: .white, location: 0),
                                .init(color: Color(red: 0.894, green: 0.949, blue: 1.0), location: 0.07),   // #e4f2ff
                                .init(color: Color(red: 0.718, green: 0.867, blue: 1.0), location: 0.19),   // #b7ddff
                                .init(color: Color(red: 0.494, green: 0.761, blue: 0.984), location: 0.36), // #7ec2fb
                                .init(color: Color(red: 0.290, green: 0.596, blue: 0.933), location: 0.56), // #4a98ee
                                .init(color: Color(red: 0.169, green: 0.451, blue: 0.847), location: 0.74), // #2b73d8
                                .init(color: Color(red: 0.102, green: 0.337, blue: 0.741), location: 0.88), // #1a56bd
                                .init(color: Color(red: 0.063, green: 0.247, blue: 0.573), location: 1),    // #103f92
                            ], center: .init(x: 0.36, y: 0.28), startRadius: 0, endRadius: side * 0.72))
                        // inset core shadow (bottom-right volume)
                        Circle().fill(
                            RadialGradient(colors: [.clear, Color(red: 0.035, green: 0.149, blue: 0.376).opacity(0.55)],
                                           center: .init(x: 0.30, y: 0.24), startRadius: side * 0.30, endRadius: side * 0.62))
                        // inset fill light (top-left)
                        Circle().fill(
                            RadialGradient(colors: [Color.white.opacity(0.5), .clear],
                                           center: .init(x: 0.22, y: 0.18), startRadius: 0, endRadius: side * 0.42))
                        // subsurface scattering
                        Circle().fill(
                            RadialGradient(colors: [Color(red: 0.588, green: 0.843, blue: 1.0).opacity(0.7),
                                                    Color(red: 0.353, green: 0.667, blue: 1.0).opacity(0.2), .clear],
                                           center: .init(x: 0.54, y: 0.68), startRadius: 0, endRadius: side * 0.42))
                            .blendMode(.screen)
                            .opacity(0.6)
                        // fluid c1 — iridescent conic, screen, spin 18s (10/4.5 by state)
                        Circle()
                            .fill(AngularGradient(colors: [
                                Color(red: 0.561, green: 0.878, blue: 1.0),   // #8fe0ff
                                Color(red: 0.290, green: 0.639, blue: 1.0),   // #4aa3ff
                                Color(red: 0.416, green: 0.482, blue: 1.0),   // #6a7bff
                                Color(red: 0.349, green: 0.902, blue: 1.0),   // #59e6ff
                                Color(red: 0.247, green: 0.553, blue: 1.0),   // #3f8dff
                                Color(red: 0.655, green: 0.769, blue: 1.0),   // #a7c4ff
                                Color(red: 0.561, green: 0.878, blue: 1.0),   // wrap
                            ], center: .center, angle: .degrees(t / c1Duration * 360)))
                            .frame(width: side * 1.28, height: side * 1.28)
                            .blur(radius: 16)
                            .blendMode(.screen)
                            .opacity(state == .thinking || state == .transcribing ? 0.7 : 0.55)
                        // fluid c2 — counter-rotating, overlay
                        Circle()
                            .fill(AngularGradient(stops: [
                                .init(color: .clear, location: 0),
                                .init(color: Color(red: 0.498, green: 0.847, blue: 1.0).opacity(0.53), location: 0.22),
                                .init(color: Color(red: 0.416, green: 0.482, blue: 1.0).opacity(0.40), location: 0.42),
                                .init(color: .clear, location: 0.58),
                                .init(color: Color(red: 0.341, green: 0.878, blue: 1.0).opacity(0.53), location: 0.78),
                                .init(color: .clear, location: 1),
                            ], center: .center, angle: .degrees(120 - t / c2Duration * 360)))
                            .frame(width: side * 1.28, height: side * 1.28)
                            .blur(radius: 16)
                            .blendMode(.overlay)
                            .opacity(0.45)
                        // gloss — broad top reflection
                        Ellipse().fill(
                            RadialGradient(colors: [Color.white.opacity(0.55), .clear],
                                           center: .center, startRadius: 0, endRadius: side * 0.37))
                            .frame(width: side * 0.74, height: side * 0.42)
                            .offset(y: -side * 0.38)
                            .blendMode(.screen)
                        // spec — tight hotspot (rotated ellipse, blur 2)
                        Ellipse().fill(
                            RadialGradient(colors: [Color.white.opacity(0.98),
                                                    Color.white.opacity(0.5), .clear],
                                           center: .init(x: 0.42, y: 0.40),
                                           startRadius: 0, endRadius: side * 0.17))
                            .frame(width: side * 0.34, height: side * 0.22)
                            .rotationEffect(.degrees(-18))
                            .offset(x: -side * 0.07, y: -side * 0.22)
                            .blur(radius: 2)
                        // spec.small
                        Ellipse().fill(
                            RadialGradient(colors: [.white, .clear], center: .center,
                                           startRadius: 0, endRadius: side * 0.06))
                            .frame(width: side * 0.12, height: side * 0.08)
                            .offset(x: -side * 0.14, y: -side * 0.26)
                        // fresnel ring just inside the edge
                        Circle().fill(
                            RadialGradient(stops: [
                                .init(color: .clear, location: 0.66),
                                .init(color: Color(red: 0.706, green: 0.863, blue: 1.0).opacity(0.35), location: 0.82),
                                .init(color: Color.white.opacity(0.5), location: 0.90),
                                .init(color: .clear, location: 0.96),
                            ], center: .center, startRadius: 0, endRadius: side * 0.5))
                            .blendMode(.screen)
                    }
                    .frame(width: side, height: side)
                    .clipShape(Circle())
                    .shadow(color: Color(red: 0.235, green: 0.471, blue: 1.0).opacity(0.30), radius: 35, y: 26)
                    .offset(y: floatY)
                }
                .scaleEffect(scale)
                .frame(width: geo.size.width, height: geo.size.height)
            }
        }
    }
}
