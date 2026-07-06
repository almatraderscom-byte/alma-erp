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
        enum Kind { case tool, approval, ask, modelSwitch }
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
    private var verificationSaid = false     // verification_retry spoken once per turn
    private var lastAudioAt = Date()
    private var ackData: [Data] = []
    private var ackIdx = 0
    private var sessionReady = false
    private var closed = false
    private var streamingActive = false      // a live-STT listen is in flight

    private let tts = AlmaTtsQueue()
    private let streamer = AlmaStreamingSTT()

    /// TRUE streaming STT (words appear as spoken) — owner-tunable escape hatch:
    /// if it ever misbehaves on device, set `alma-voice-streaming` = false and the
    /// proven record-then-transcribe path is used. Default ON (web parity).
    private var streamingEnabled: Bool {
        (UserDefaults.standard.object(forKey: "alma-voice-streaming") as? Bool) ?? true
    }

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
        streamer.cancel(); streamingActive = false
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
            if streamingActive { streamer.finishNow() }   // commit the utterance
            else { finishListening(force: true) }         // tap again = send now
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
        if streamingEnabled {
            // Try TRUE streaming STT first. start() throws on any PRE-audio
            // failure (token mint / socket / mic engine) — those fall back to the
            // proven record-then-transcribe path with NO state changed yet.
            streamer.engine = self
            Task { [weak self] in
                guard let self else { return }
                do { try await self.streamer.start() }
                catch { self.startListeningRecorder() }
            }
        } else {
            startListeningRecorder()
        }
    }

    /// The proven record → /transcribe path. Unchanged; used when streaming is
    /// off or its setup failed.
    private func startListeningRecorder() {
        guard state != .listening else { return }
        streamingActive = false
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

    // ── Streaming-STT callbacks (from AlmaStreamingSTT) ────────────────────

    /// Mic + socket are live — enter listening, exactly like the recorder path.
    func streamDidStart() {
        streamingActive = true
        state = .listening
        nowLine = ""; saidLines = []; transcript = ""
        listenSeconds = 0
        playMicChime()
        UISelectionFeedbackGenerator().selectionChanged()
    }
    func streamSeconds(_ s: Int) { listenSeconds = s }
    func streamLevel(_ l: Double) { micLevel = l }
    /// Live interim words — the owner sees his sentence build as he speaks.
    func streamPartial(_ text: String) { if state == .listening { transcript = text } }
    func streamNoSpeech() {
        streamingActive = false
        micLevel = 0
        state = .idle
        playCloseChime()
    }
    func streamFinal(_ text: String) {
        streamingActive = false
        micLevel = 0
        state = .transcribing
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        playAck()
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else {
            state = .idle
            errorToast = "শুনতে পাইনি স্যার — আরেকবার বলুন।"
            scheduleAutoListen()
            return
        }
        transcript = clean
        runTurn(clean)
    }
    func streamError(_ msg: String) {
        streamingActive = false
        micLevel = 0
        // Mid-listen socket/audio failure: recover to idle + speak (hands-free
        // owner can't read a toast), then keep the conversation loop alive.
        state = .idle
        errorToast = msg
        tts.sayNow("শুনতে পাইনি স্যার — আরেকবার বলুন।")
        scheduleAutoListen()
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

    /// A voice-turn body. The shared AssistantVM.ChatBody has no `resume` field
    /// (frozen file) and the model-switch approval needs to re-run the SAME turn
    /// with resume{approve}, so the voice console encodes its own body here.
    private struct VoiceChatBody: Encodable {
        let conversationId: String?
        let message: String
        let modelId: String?
        let voice: Bool
        let resume: Resume?
        struct Resume: Encodable { let approve: Bool }
    }

    private func runTurn(_ text: String, resume: Bool = false) {
        if !resume, !lastUserText.isEmpty { lastQ = lastUserText; lastA = replyText }
        lastUserText = text
        state = .thinking
        replyText = ""
        saidLines = []; nowLine = ""
        cards.removeAll { $0.kind == .tool }
        narratedFirstTool = false
        verificationSaid = false
        lastAudioAt = Date()
        tts.beginTurn()
        startHeartbeat()

        let body = VoiceChatBody(conversationId: chatVM?.conversationId,
                                 message: text,
                                 modelId: chatVM?.modelId ?? "auto",
                                 voice: true,
                                 resume: resume ? .init(approve: true) : nil)
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
        case "verification_retry":
            // The head is self-correcting — in voice this reads as a hang unless
            // spoken (web parity). Once per turn.
            if !verificationSaid {
                verificationSaid = true
                lastAudioAt = Date()
                tts.sayNow("একটু যাচাই করে ঠিক করে নিচ্ছি, স্যার…")
            }
        case "model_switch_required":
            // A premium head needs the owner's OK. Spoken + a tappable card;
            // approve re-runs the same turn with resume{approve}.
            cards.append(.init(id: "modelswitch-\(cards.count)", kind: .modelSwitch,
                               icon: "🧠", title: "শক্তিশালী মডেলের অনুমতি দরকার",
                               sub: "", status: "wait"))
            lastAudioAt = Date()
            tts.sayNow("এটার জন্য আরও শক্তিশালী মডেল দরকার, স্যার — অনুমতি দিলে এগিয়ে যাই।")
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
        // Answering an ask continues the conversation with the chosen option —
        // record it AND drive the next turn (web parity).
        Task { [weak self] in
            await self?.chatVM?.answerAskCard(aid, option: option)
        }
        tts.stopAll()
        runTurn(option)
    }

    /// Premium-model permission — approve re-runs the SAME question with resume.
    func resolveModelSwitch(_ card: Card, approve: Bool) {
        if let i = cards.firstIndex(where: { $0.id == card.id }) {
            cards[i].status = approve ? "অনুমোদিত" : "বাতিল"
        }
        if approve, !lastUserText.isEmpty {
            tts.stopAll()
            runTurn(lastUserText, resume: true)
        } else {
            tts.sayNow("আচ্ছা স্যার, তাহলে বাদ দিলাম।")
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

// MARK: - TRUE streaming STT (OpenAI Realtime transcription over WebSocket)
//
// Web parity for gap #12: the mic PCM streams straight to OpenAI's realtime
// transcription session and the transcript arrives WHILE the owner speaks. The
// ephemeral token is minted by our own /api/assistant/stt-session (same
// gpt-4o-transcribe + Bangla prompt). Endpointing stays OURS (server VAD off):
// the same calibrated/adaptive rules as the recorder path. ANY pre-audio
// failure throws from start() so the engine falls back to record→/transcribe —
// streaming is an upgrade, never a dependency.

enum AlmaVoiceSTTError: Error { case noToken, badURL, socket, noMic, noConverter }

@available(iOS 17.0, *)
final class AlmaStreamingSTT: NSObject, URLSessionWebSocketDelegate {
    weak var engine: AlmaVoiceEngine?    // @MainActor — UI hops through it

    private var session: URLSession?
    private var ws: URLSessionWebSocketTask?
    private let audioEngine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var outFormat: AVAudioFormat?
    private var tapInstalled = false
    private var openCont: CheckedContinuation<Void, Error>?

    // VAD state — touched on the CoreAudio tap thread (serialized by CoreAudio).
    private var elapsedMs = 0.0
    private var noiseFloor = 0.0, floorSamples = 0.0
    private var speechThresh = 0.045
    private let silenceThresh = 0.025
    private var sustainedMs = 0.0
    private var spoke = false
    private var speechStartMs = 0.0
    private var silenceMs = 0.0
    private var lastSecond = -1

    private var committed = false
    private var completedFired = false
    private var failed = false
    private var partial = ""

    private struct TokenResp: Decodable { let key: String? }

    private func reset() {
        elapsedMs = 0; noiseFloor = 0; floorSamples = 0
        speechThresh = 0.045; sustainedMs = 0; spoke = false
        speechStartMs = 0; silenceMs = 0; lastSecond = -1
        committed = false; completedFired = false; failed = false; partial = ""
    }

    /// Mint token → open socket (awaited) → start mic. Throws on any pre-audio
    /// failure (caller falls back to the recorder with no state changed yet).
    func start() async throws {
        reset()
        // 1 — ephemeral token from our server (empty body; route reads none).
        let data = try await AssistantNet.postJSONForData(path: "/api/assistant/stt-session", body: [:])
        guard let key = (try? JSONDecoder().decode(TokenResp.self, from: data))?.key, !key.isEmpty else {
            throw AlmaVoiceSTTError.noToken
        }
        // 2 — websocket. Browser-style subprotocol auth; NO ?model= query (that
        // is invalid in transcription mode — the token already binds the session).
        guard let url = URL(string: "wss://api.openai.com/v1/realtime") else { throw AlmaVoiceSTTError.badURL }
        let sess = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        session = sess
        let task = sess.webSocketTask(with: url, protocols: ["realtime", "openai-insecure-api-key.\(key)"])
        ws = task
        task.resume()
        // Wait for the actual handshake (bad auth fails the upgrade → no didOpen).
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await withCheckedThrowingContinuation { self.openCont = $0 } }
            group.addTask { try await Task.sleep(nanoseconds: 6_000_000_000); throw AlmaVoiceSTTError.socket }
            try await group.next()
            group.cancelAll()
        }
        // 3 — mic tap; if this throws, tear the socket down and fall back.
        do { try startMic() }
        catch { closeSocket(); throw error }
        receiveLoop()
        await MainActor.run { self.engine?.streamDidStart() }
    }

    // Delegate: handshake completed → resolve the open continuation.
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol proto: String?) {
        openCont?.resume(); openCont = nil
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let c = openCont { c.resume(throwing: AlmaVoiceSTTError.socket); openCont = nil }
        else { fail("সংযোগ কেটে গেছে") }
    }

    private func startMic() throws {
        let input = audioEngine.inputNode
        let inFmt = input.inputFormat(forBus: 0)
        guard inFmt.sampleRate > 0, inFmt.channelCount > 0 else { throw AlmaVoiceSTTError.noMic }
        guard let out = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000,
                                      channels: 1, interleaved: true),
              let conv = AVAudioConverter(from: inFmt, to: out) else { throw AlmaVoiceSTTError.noConverter }
        outFormat = out; converter = conv
        input.installTap(onBus: 0, bufferSize: 2_048, format: inFmt) { [weak self] buf, _ in
            self?.onAudio(buf, inFmt: inFmt)
        }
        tapInstalled = true
        audioEngine.prepare()
        try audioEngine.start()
    }

    /// Audio tap: RMS → orb + our adaptive VAD; PCM16@24k → socket append.
    private func onAudio(_ buf: AVAudioPCMBuffer, inFmt: AVAudioFormat) {
        if committed || failed { return }
        let frames = Int(buf.frameLength)
        guard frames > 0 else { return }

        // RMS from the float input (before conversion).
        var rms = 0.0
        if let ch = buf.floatChannelData?[0] {
            var sum = 0.0
            for i in 0..<frames { let v = Double(ch[i]); sum += v * v }
            rms = (sum / Double(frames)).squareRoot()
        }
        DispatchQueue.main.async { [weak self] in self?.engine?.streamLevel(min(1, rms * 6)) }

        // Adaptive VAD — mirrors the recorder path exactly.
        let dtMs = Double(frames) / inFmt.sampleRate * 1000.0
        if elapsedMs < 400 {
            noiseFloor += rms; floorSamples += 1
            if elapsedMs + dtMs >= 400 && floorSamples > 0 {
                speechThresh = max(0.045, (noiseFloor / floorSamples) * 2.5)
            }
        } else if !spoke {
            if rms > speechThresh {
                sustainedMs += dtMs
                if sustainedMs >= 250 { spoke = true; speechStartMs = elapsedMs }
            } else { sustainedMs = 0 }
            if elapsedMs > 8_000 { endUtterance(noSpeech: true); return }
        } else {
            if rms < silenceThresh {
                silenceMs += dtMs
                let span = elapsedMs - speechStartMs
                let window = span < 3_000 ? 1_400.0 : 2_600.0
                if silenceMs >= window { endUtterance(noSpeech: false); return }
            } else if rms > speechThresh {
                silenceMs = 0
            }
        }
        if elapsedMs > 180_000 { endUtterance(noSpeech: false); return }

        let sec = Int(elapsedMs / 1000)
        if sec != lastSecond { lastSecond = sec; DispatchQueue.main.async { [weak self] in self?.engine?.streamSeconds(sec) } }
        elapsedMs += dtMs

        // Convert to 24k mono int16 and stream the chunk.
        guard let conv = converter, let out = outFormat else { return }
        let ratio = out.sampleRate / inFmt.sampleRate
        let cap = AVAudioFrameCount(Double(frames) * ratio + 16)
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: out, frameCapacity: cap) else { return }
        var fed = false
        var cErr: NSError?
        conv.convert(to: outBuf, error: &cErr) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return buf
        }
        let n = Int(outBuf.frameLength)
        guard cErr == nil, n > 0, let i16 = outBuf.int16ChannelData?[0] else { return }
        let bytes = Data(bytes: i16, count: n * MemoryLayout<Int16>.size)
        let b64 = bytes.base64EncodedString()
        ws?.send(.string("{\"type\":\"input_audio_buffer.append\",\"audio\":\"\(b64)\"}")) { _ in }
    }

    /// End of speech: stop the mic (privacy), commit, await the final transcript.
    private func endUtterance(noSpeech: Bool) {
        if committed { return }
        committed = true
        stopMic()
        if noSpeech {
            closeSocket()
            DispatchQueue.main.async { [weak self] in self?.engine?.streamNoSpeech() }
            return
        }
        ws?.send(.string("{\"type\":\"input_audio_buffer.commit\"}")) { _ in }
        DispatchQueue.main.asyncAfter(deadline: .now() + 7) { [weak self] in
            guard let self, !self.completedFired, !self.failed else { return }
            self.fail("ট্রান্সক্রিপশন সময়মতো এলো না — আবার বলুন।")
        }
    }

    private func receiveLoop() {
        ws?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                self.fail("সংযোগ কেটে গেছে — আবার বলুন।")
            case .success(let msg):
                if case .string(let s) = msg { self.onWSText(s) }
                if !self.completedFired && !self.failed { self.receiveLoop() }
            }
        }
    }

    private func onWSText(_ s: String) {
        guard let d = s.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let type = obj["type"] as? String else { return }
        switch type {
        case "conversation.item.input_audio_transcription.delta":
            if let delta = obj["delta"] as? String {
                partial += delta
                let snap = partial
                DispatchQueue.main.async { [weak self] in self?.engine?.streamPartial(snap) }
            }
        case "conversation.item.input_audio_transcription.completed":
            completedFired = true
            let text = (obj["transcript"] as? String) ?? partial
            closeSocket()
            DispatchQueue.main.async { [weak self] in self?.engine?.streamFinal(text) }
        case "error":
            let msg = ((obj["error"] as? [String: Any])?["message"] as? String) ?? "স্ট্রিমিং সমস্যা।"
            fail(msg)
        default:
            break
        }
    }

    private func fail(_ msg: String) {
        if failed || completedFired { return }
        failed = true
        stopMic(); closeSocket()
        DispatchQueue.main.async { [weak self] in self?.engine?.streamError(msg) }
    }

    /// Force-send now (owner tapped the orb while listening).
    func finishNow() { endUtterance(noSpeech: false) }

    /// Hard stop with no callbacks (console closed / barge / teardown).
    func cancel() {
        failed = true
        openCont?.resume(throwing: AlmaVoiceSTTError.socket); openCont = nil
        stopMic(); closeSocket()
    }

    private func stopMic() {
        if tapInstalled { audioEngine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        if audioEngine.isRunning { audioEngine.stop() }
    }
    private func closeSocket() {
        ws?.cancel(with: .goingAway, reason: nil); ws = nil
        session?.invalidateAndCancel(); session = nil
    }
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
                path: "/api/assistant/tts",
                body: ["text": almaNormalizeForTTS(String(text.prefix(600)))]) {
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
                path: "/api/assistant/tts",
                body: ["text": almaNormalizeForTTS(String(next.prefix(600)))]) {
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
            // Previous exchange stays readable between turns — glancing away
            // must not erase the last answer (web scrollback parity).
            if engine.state == .idle && engine.nowLine.isEmpty && !engine.lastA.isEmpty {
                VStack(spacing: 2) {
                    if !engine.lastQ.isEmpty {
                        Text(engine.lastQ)
                            .font(.system(size: 12))
                            .foregroundStyle(textColor.opacity(0.4))
                            .lineLimit(1)
                    }
                    Text(engine.lastA)
                        .font(.system(size: 13))
                        .foregroundStyle(textColor.opacity(0.55))
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                }
                .padding(.horizontal, 26)
            }
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
                if card.kind == .modelSwitch && card.status == "wait" {
                    HStack(spacing: 8) {
                        Button {
                            engine.resolveModelSwitch(card, approve: true)
                        } label: {
                            Text("অনুমতি দিন")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 12).padding(.vertical, 5)
                                .background(accent, in: Capsule())
                        }
                        Button {
                            engine.resolveModelSwitch(card, approve: false)
                        } label: {
                            Text("থাক")
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

// MARK: - Deterministic pre-TTS Bangla normalizer (inlined; Swift port of src/agent/lib/tts-normalize.ts)

// Complete 0-99 Bangla word table. This is the load-bearing part — the bn
// number words are irregular and must be exact.
private let almaONES: [String] = [
    "শূন্য",
    "এক",
    "দুই",
    "তিন",
    "চার",
    "পাঁচ",
    "ছয়",
    "সাত",
    "আট",
    "নয়",
    "দশ",
    "এগারো",
    "বারো",
    "তেরো",
    "চৌদ্দ",
    "পনেরো",
    "ষোলো",
    "সতেরো",
    "আঠারো",
    "ঊনিশ",
    "বিশ",
    "একুশ",
    "বাইশ",
    "তেইশ",
    "চব্বিশ",
    "পঁচিশ",
    "ছাব্বিশ",
    "সাতাশ",
    "আটাশ",
    "ঊনত্রিশ",
    "ত্রিশ",
    "একত্রিশ",
    "বত্রিশ",
    "তেত্রিশ",
    "চৌত্রিশ",
    "পঁয়ত্রিশ",
    "ছত্রিশ",
    "সাঁইত্রিশ",
    "আটত্রিশ",
    "ঊনচল্লিশ",
    "চল্লিশ",
    "একচল্লিশ",
    "বিয়াল্লিশ",
    "তেতাল্লিশ",
    "চুয়াল্লিশ",
    "পঁয়তাল্লিশ",
    "ছেচল্লিশ",
    "সাতচল্লিশ",
    "আটচল্লিশ",
    "ঊনপঞ্চাশ",
    "পঞ্চাশ",
    "একান্ন",
    "বাহান্ন",
    "তেপ্পান্ন",
    "চুয়ান্ন",
    "পঞ্চান্ন",
    "ছাপ্পান্ন",
    "সাতান্ন",
    "আটান্ন",
    "ঊনষাট",
    "ষাট",
    "একষট্টি",
    "বাষট্টি",
    "তেষট্টি",
    "চৌষট্টি",
    "পঁয়ষট্টি",
    "ছেষট্টি",
    "সাতষট্টি",
    "আটষট্টি",
    "ঊনসত্তর",
    "সত্তর",
    "একাত্তর",
    "বাহাত্তর",
    "তিয়াত্তর",
    "চুয়াত্তর",
    "পঁচাত্তর",
    "ছিয়াত্তর",
    "সাতাত্তর",
    "আটাত্তর",
    "ঊনআশি",
    "আশি",
    "একাশি",
    "বিরাশি",
    "তিরাশি",
    "চুরাশি",
    "পঁচাশি",
    "ছিয়াশি",
    "সাতাশি",
    "আটাশি",
    "ঊননব্বই",
    "নব্বই",
    "একানব্বই",
    "বিরানব্বই",
    "তিরানব্বই",
    "চুরানব্বই",
    "পঁচানব্বই",
    "ছিয়ানব্বই",
    "সাতানব্বই",
    "আটানব্বই",
    "নিরানব্বই",
]

private let almaBANGLA_DIGITS: [Character] = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"]

// Map a single digit char (ASCII or Bangla) to its Bangla word, else nil.
private func almaDigitWord(_ ch: Character) -> String? {
    if ch >= "0" && ch <= "9" {
        guard let ascii = ch.asciiValue else { return nil }
        let idx = Int(ascii) - 48
        if idx >= 0 && idx < almaONES.count { return almaONES[idx] }
        return nil
    }
    if let idx = almaBANGLA_DIGITS.firstIndex(of: ch), idx >= 0, idx < almaONES.count {
        return almaONES[idx]
    }
    return nil
}

// Convert a string of digits to their Bangla words, space-separated.
// Handles both ASCII and Bangla numerals.
private func almaDigitsToWords(_ digits: String) -> String {
    var out: [String] = []
    for ch in digits {
        if let w = almaDigitWord(ch) {
            out.append(w)
        }
    }
    return out.joined(separator: " ")
}

// Read a 1-3 digit group (0-999) into Bangla words. Used as the building block
// for the lakh/crore grouping. 0 within a larger number contributes nothing.
private func almaBelowThousand(_ n: Int) -> String {
    var parts: [String] = []
    let hundreds = n / 100
    let rest = n % 100
    if hundreds > 0, hundreds < almaONES.count { parts.append(almaONES[hundreds] + "শো") }
    if rest > 0, rest < almaONES.count { parts.append(almaONES[rest]) }
    return parts.joined(separator: " ")
}

// Convert a non-negative integer 0 → 99,99,99,999 into Bangla words using the
// lakh/crore system. Callers guarantee the range; out-of-range values fall back
// to digit-by-digit reading.
private func almaNonNegativeToBanglaWords(_ n: Int) -> String {
    if n == 0 { return almaONES[0] }

    let crore = n / 10000000
    let lakh = (n % 10000000) / 100000
    let thousand = (n % 100000) / 1000
    let rest = n % 1000

    var parts: [String] = []
    if crore > 0 { parts.append(almaBelowThousand(crore) + " কোটি") }
    if lakh > 0, lakh < almaONES.count { parts.append(almaONES[lakh] + " লাখ") }
    if thousand > 0, thousand < almaONES.count { parts.append(almaONES[thousand] + " হাজার") }
    if rest > 0 { parts.append(almaBelowThousand(rest)) }
    return parts.joined(separator: " ")
}

// Public: convert an integer to Bangla words.
//  - Negatives are prefixed with "মাইনাস ".
//  - Non-integers read the integer part in words, then "দশমিক", then up to two
//    decimal digits read digit-by-digit.
//  - Integers of 10 digits or more are read digit-by-digit.
func numberToBanglaWords(_ n: Double) -> String {
    if !n.isFinite { return almaStringifyNumber(n) }

    let negative = n < 0
    let absVal = n < 0 ? -n : n

    let intPart = absVal.rounded(.down)
    let isDecimal = absVal != intPart

    var intWords: String
    if intPart >= 1000000000 {
        // 10+ digits: outside lakh/crore range, read digit-by-digit.
        intWords = almaDigitsToWords(almaIntString(intPart))
    } else {
        intWords = almaNonNegativeToBanglaWords(Int(intPart))
    }

    var result = intWords
    if isDecimal {
        // Up to two decimal places, digit-by-digit after "দশমিক".
        // Mirror TS: abs.toFixed(2).split('.')[1].replace(/0+$/,'') || '0'
        let fixed = String(format: "%.2f", absVal)
        var decStr = "0"
        if let dotIdx = fixed.firstIndex(of: ".") {
            let after = String(fixed[fixed.index(after: dotIdx)...])
            var trimmed = after
            while trimmed.hasSuffix("0") { trimmed.removeLast() }
            decStr = trimmed.isEmpty ? "0" : trimmed
        }
        result = intWords + " দশমিক " + almaDigitsToWords(decStr)
    }

    return negative ? "মাইনাস " + result : result
}

// Integer-friendly overload so tests can call numberToBanglaWords(21).
func numberToBanglaWords(_ n: Int) -> String {
    return numberToBanglaWords(Double(n))
}

// Render the integer part of a Double as a plain digit string (no exponent,
// no separators). Used only for the digit-by-digit 10+ digit path.
private func almaIntString(_ d: Double) -> String {
    let s = String(format: "%.0f", d)
    return s
}

// Fallback stringification matching JS String(n) closely enough for the
// non-finite / edge cases (only ever hit on NaN / Infinity here).
private func almaStringifyNumber(_ n: Double) -> String {
    if n.isNaN { return "NaN" }
    if n == Double.infinity { return "Infinity" }
    if n == -Double.infinity { return "-Infinity" }
    if n == n.rounded() { return String(format: "%.0f", n) }
    return String(n)
}

// ---------------------------------------------------------------------------
// normalizeForTts
// ---------------------------------------------------------------------------

// Known-term phonetic map. Longer/more-specific keys first so ".com" and
// "almatraders" win before generic tokens. Matched case-insensitively at word
// boundaries (see buildTermRegex).
private let almaTERM_MAP: [(String, String)] = [
    ("almatraders", "আলমাট্রেডার্স"),
    (".com", " ডট কম"),
    ("WhatsApp", "হোয়াটসঅ্যাপ"),
    ("Facebook", "ফেসবুক"),
    ("Telegram", "টেলিগ্রাম"),
    ("Instagram", "ইনস্টাগ্রাম"),
    ("Google", "গুগল"),
    ("iPhone", "আইফোন"),
    ("Android", "অ্যান্ড্রয়েড"),
    ("crypto", "ক্রিপ্টো"),
    ("Vercel", "ভার্সেল"),
    ("Okay", "ওকে"),
    ("ALMA", "আলমা"),
    ("SUI", "সুই"),
    ("BTC", "বিটিসি"),
    ("ETH", "ইথেরিয়াম"),
    ("OK", "ওকে"),
    ("Sir", "স্যার"),
    ("AI", "এআই"),
    ("API", "এপিআই"),
    ("URL", "ইউআরএল"),
    ("TTS", "টিটিএস"),
]

// Escape a literal string for use inside an NSRegularExpression pattern.
private func almaEscapeRegex(_ s: String) -> String {
    return NSRegularExpression.escapedPattern(for: s)
}

// Build a case-insensitive matcher for a term. ".com" is a suffix-style token
// (no leading boundary, matches when attached to a word); all others are
// bounded by non-letter/digit edges so "AI" doesn't fire inside "email".
private func almaBuildTermRegex(_ term: String) -> NSRegularExpression? {
    let pattern: String
    if term.hasPrefix(".") {
        pattern = almaEscapeRegex(term)
    } else {
        pattern = "(?<![A-Za-z0-9])" + almaEscapeRegex(term) + "(?![A-Za-z0-9])"
    }
    return try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
}

// Parse a numeric literal (ASCII digits, optional commas, optional decimal)
// into a Double. Returns nil if not parseable.
private func almaParseNumericLiteral(_ raw: String) -> Double? {
    let cleaned = raw.replacingOccurrences(of: ",", with: "")
    guard almaMatchesFull(cleaned, pattern: "^\\d+(\\.\\d+)?$") else { return nil }
    guard let v = Double(cleaned), v.isFinite else { return nil }
    return v
}

// Whole-string regex match helper.
private func almaMatchesFull(_ s: String, pattern: String) -> Bool {
    guard let re = try? NSRegularExpression(pattern: pattern, options: []) else { return false }
    let range = NSRange(s.startIndex..., in: s)
    return re.firstMatch(in: s, options: [], range: range) != nil
}

// Render a numeric literal to spoken Bangla. Integers with 10+ digits (or with
// grouping that yields a huge value) fall to digit-by-digit reading per spec.
private func almaSpeakNumericLiteral(_ raw: String) -> String {
    let cleaned = raw.replacingOccurrences(of: ",", with: "")
    guard let num = almaParseNumericLiteral(raw) else { return raw }

    let isInt = !cleaned.contains(".")
    // Standalone integers of more than 9 digits: digit-by-digit.
    if isInt {
        var stripped = cleaned
        if stripped.hasPrefix("-") { stripped.removeFirst() }
        if stripped.count > 9 {
            return almaDigitsToWords(cleaned)
        }
    }
    return numberToBanglaWords(num)
}

// Core regex-replace helper: applies `transform` to each match of `pattern`,
// rebuilding the string safely for multibyte Bangla. On any failure returns the
// input string unchanged.
private func almaReplace(
    _ input: String,
    pattern: String,
    options: NSRegularExpression.Options = [],
    transform: ([String]) -> String
) -> String {
    guard let re = try? NSRegularExpression(pattern: pattern, options: options) else {
        return input
    }
    let ns = input as NSString
    let fullRange = NSRange(location: 0, length: ns.length)
    let matches = re.matches(in: input, options: [], range: fullRange)
    if matches.isEmpty { return input }

    var result = ""
    var lastEnd = 0
    for m in matches {
        let mRange = m.range
        if mRange.location == NSNotFound { continue }
        // Text between previous match end and this match.
        if mRange.location > lastEnd {
            result += ns.substring(with: NSRange(location: lastEnd, length: mRange.location - lastEnd))
        }
        // Collect capture groups (index 0 = whole match).
        var groups: [String] = []
        for gi in 0..<m.numberOfRanges {
            let gr = m.range(at: gi)
            if gr.location == NSNotFound {
                groups.append("")
            } else {
                groups.append(ns.substring(with: gr))
            }
        }
        result += transform(groups)
        lastEnd = mRange.location + mRange.length
    }
    // Trailing text after the last match.
    if lastEnd < ns.length {
        result += ns.substring(with: NSRange(location: lastEnd, length: ns.length - lastEnd))
    }
    return result
}

// Public entry point. Renamed from TS normalizeForTts.
func almaNormalizeForTTS(_ input: String) -> String {
    let text = input
    if text.isEmpty { return text }

    var out = text

    // (a) Currency.
    // Taka symbol prefix: ৳1,250 / ৳1250
    out = almaReplace(out, pattern: "৳\\s*([\\d,]+(?:\\.\\d+)?)") { g in
        let num = g.count > 1 ? g[1] : ""
        return almaSpeakNumericLiteral(num) + " টাকা"
    }
    // Trailing "টাকা": 1250 টাকা -> এক হাজার দুইশো পঞ্চাশ টাকা (avoid double word)
    out = almaReplace(out, pattern: "([\\d,]+(?:\\.\\d+)?)\\s*টাকা") { g in
        let num = g.count > 1 ? g[1] : ""
        return almaSpeakNumericLiteral(num) + " টাকা"
    }
    // Dollar prefix: $3.42 -> তিন দশমিক চার দুই ডলার
    out = almaReplace(out, pattern: "\\$\\s*([\\d,]+(?:\\.\\d+)?)") { g in
        let num = g.count > 1 ? g[1] : ""
        return almaSpeakNumericLiteral(num) + " ডলার"
    }

    // (b) Percentages: 4.2% -> চার দশমিক দুই শতাংশ
    out = almaReplace(out, pattern: "([\\d,]+(?:\\.\\d+)?)\\s*%") { g in
        let num = g.count > 1 ? g[1] : ""
        return almaSpeakNumericLiteral(num) + " শতাংশ"
    }

    // (e) Phone numbers BEFORE generic digit groups: +8801XXXXXXXXX / 01XXXXXXXXX
    out = almaReplace(out, pattern: "\\+8801\\d{9}\\b") { g in
        let m = g.count > 0 ? g[0] : ""
        return almaDigitsToWords(m.replacingOccurrences(of: "+", with: ""))
    }
    out = almaReplace(out, pattern: "(?<!\\d)01\\d{9}(?!\\d)") { g in
        let m = g.count > 0 ? g[0] : ""
        return almaDigitsToWords(m)
    }

    // (f) Time like 4:50 -> চারটা পঞ্চাশ
    out = almaReplace(out, pattern: "(?<!\\d)([0-2]?\\d):([0-5]\\d)(?!\\d)") { g in
        let h = g.count > 1 ? g[1] : ""
        let mm = g.count > 2 ? g[2] : ""
        guard let hour = Int(h), let minute = Int(mm) else {
            return g.count > 0 ? g[0] : ""
        }
        let hourWord = numberToBanglaWords(hour) + "টা"
        let minuteWord = numberToBanglaWords(minute)
        return hourWord + " " + minuteWord
    }

    // (c) Standalone digit-groups (ASCII 0-9 and Bangla ০-৯, optional commas).
    out = almaReplace(out, pattern: "[\\d০-৯][\\d০-৯,]*(?:\\.[\\d০-৯]+)?") { g in
        let m = g.count > 0 ? g[0] : ""
        // Normalize Bangla numerals to ASCII for parsing.
        var ascii = ""
        for ch in m {
            if let bi = almaBANGLA_DIGITS.firstIndex(of: ch) {
                ascii += String(bi)
            } else {
                ascii.append(ch)
            }
        }
        let cleaned = ascii.replacingOccurrences(of: ",", with: "")
        var digitsOnly = cleaned.replacingOccurrences(of: ".", with: "")
        if digitsOnly.hasPrefix("-") { digitsOnly.removeFirst() }
        if digitsOnly.count > 9 {
            return almaDigitsToWords(cleaned.replacingOccurrences(of: ".", with: ""))
        }
        guard let num = almaParseNumericLiteral(ascii) else { return m }
        return numberToBanglaWords(num)
    }

    // (d) Known-term phonetic map. Applied after numbers so acronyms like "AI"
    // aren't disturbed by numeric rewrites.
    for (term, spoken) in almaTERM_MAP {
        guard let re = almaBuildTermRegex(term) else { continue }
        let ns = out as NSString
        let fullRange = NSRange(location: 0, length: ns.length)
        // Escape "$" in the replacement so it isn't treated as a group reference.
        let template = spoken.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "$", with: "\\$")
        out = re.stringByReplacingMatches(in: out, options: [], range: fullRange, withTemplate: template)
    }

    // Collapse any accidental double spaces introduced by substitutions.
    out = almaReplace(out, pattern: "[ \\t]{2,}") { _ in " " }

    return out
}
