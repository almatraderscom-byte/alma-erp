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
//  ack pool, 4s heartbeat after 14s silence.
//
//  HALF-DUPLEX (2026-07-06): the mic is open ONLY in `.listening`. While the agent
//  speaks, a `ttsActive` gate keeps EVERY mic shut — STT, auto-listen, and the wake
//  word — so the agent can never hear (and re-transcribe) its own TTS. The old
//  auto barge-in mic did exactly that on the loud, no-echo-cancellation speaker
//  route, so it is gone; interrupting mid-reply is now a deliberate orb TAP.
//

import SwiftUI
import UIKit
import AVFoundation
import MetalKit
import Speech
import PhotosUI

// MARK: - State + strings (web STATUS dict parity)

enum AlmaVoiceState: String {
    case idle, listening, transcribing, thinking, speaking, error

    var statusText: String {
        switch self {
        case .idle: return "নিষ্ক্রিয়"
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

    private var thinkHeartbeat: Task<Void, Never>?
    var state: AlmaVoiceState = .idle {
        didSet {
            // LOCKED-ADJ: silence-filler heartbeat — soft haptic every 1.6s while thinking.
            thinkHeartbeat?.cancel()
            if state == .thinking || state == .transcribing {
                thinkHeartbeat = Task { @MainActor in
                    let gen = UIImpactFeedbackGenerator(style: .soft)
                    gen.prepare()
                    while !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: 1_600_000_000)
                        guard !Task.isCancelled else { return }
                        gen.impactOccurred(intensity: 0.45)
                        gen.prepare()
                    }
                }
            }
            guard oldValue != state else { return }
            if state == .error { keepAliveStop() }   // dead turn = release the hold
            refreshWake()
            liveActivity.phaseChanged()
            tr("state \(oldValue) → \(state)")
        }
    }

    /// The wake word is the ONLY ambient mic, and it may run ONLY when the console is
    /// idle AND no TTS is playing. Gating it on `ttsActive` too means the agent's own
    /// greeting / narration can never trip the wake recogniser. Any non-idle state (or
    /// live TTS) stops it, so it never fights the STT mic.
    private func refreshWake() {
        let on = state == .idle && !ttsActive && !closed && !startingListen
        if on { wake.start() } else { wake.stop() }
        tr(on ? "wake→ON" : "wake→off")
    }

    // Sim self-test tracing (launch-arg / env ALMA_VOICE_TRACE only; silent in prod).
    private static let trace =
        ProcessInfo.processInfo.arguments.contains { $0.hasPrefix("ALMA_VOICE_TRACE") } ||
        ProcessInfo.processInfo.environment["ALMA_VOICE_TRACE"] != nil
    private func tr(_ m: String) {
        guard Self.trace else { return }
        NSLog("ALMA-VOICE %@  [state=%@ ttsActive=%d]", m, "\(state)", ttsActive ? 1 : 0)
    }
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
        var big: String = ""         // data cards: big number line
        var delta: String = ""       //   …its delta caption
        var spark: [Double] = []     //   …sparkline points
    }
    var cards: [Card] = []

    // internals
    private var recorder: AVAudioRecorder?
    private var vadTask: Task<Void, Never>?
    private var turnTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var lastUserText = ""
    private var lastToolNarration = Date.distantPast
    private var narratedFirstTool = false
    private var verificationSaid = false     // verification_retry spoken once per turn
    private var lastAudioAt = Date()
    private var lastEventAt = Date()          // stall watchdog: last SSE event received
    private var emptyListens = 0              // consecutive silent auto-listens (convo re-arm)
    private var ackData: [Data] = []
    private var ackIdx = 0
    private var sessionReady = false
    private var closed = false
    private var streamingActive = false      // a live-STT listen is in flight
    // MIC GATE (half-duplex): true from the moment ANY TTS chunk starts until the
    // queue goes fully silent. While true, NO mic opens — not the STT listen, not
    // auto-listen, not the wake word. This is the guard that stops the agent from
    // hearing its own voice (the barge-in mic used to do exactly that on the loud,
    // no-echo-cancellation speaker session). Tap-to-interrupt on the orb still works.
    private var ttsActive = false

    private let tts = AlmaTtsQueue()
    private let streamer = AlmaStreamingSTT()
    let wake = AlmaWakeWord()
    // Dynamic Island / Lock Screen Live Activity (docs/alma-live-activity-PLAN.md)
    private let liveActivity = VoiceLiveActivityController()
    private var liveActivityEndObserver: NSObjectProtocol?
    // Conversation keep-alive + audio self-heal (owner bugs 2026-07-08: background
    // re-listen died, foreground return needed an app kill)
    private var keepAlive: AVAudioPlayer?
    private var recoveryObservers: [NSObjectProtocol] = []
    fileprivate var startingListen = false   // a listen is spinning up (double-tap guard)

    // Image attachments — voice parity with the chat composer. Photograph a
    // product / paste a poster and the SAME multimodal turn the chat runs fires
    // by voice. Uses the shared AgentFileRef + /api/assistant/upload.
    struct PendingImage: Identifiable, Equatable {
        enum State: Equatable { case uploading, ready(AgentFileRef), failed }
        let id = UUID()
        let image: UIImage
        var state: State = .uploading
    }
    var pendingImages: [PendingImage] = []
    private var readyImageFiles: [AgentFileRef] {
        pendingImages.compactMap { if case .ready(let f) = $0.state { return f } else { return nil } }
    }

    /// TRUE streaming STT (gpt-4o-transcribe realtime, live words as spoken). Back ON
    /// by default: it transcribed the owner's Bangla correctly on device in build 44 —
    /// the crash there was the .voiceChat VPIO session (now .default), NOT the streaming
    /// itself. Its transcription is markedly better than the record→Whisper fallback,
    /// which mis-heard/failed on 4G. ANY pre-audio failure still falls back to the
    /// recorder. Escape hatch: `alma-voice-streaming` = false.
    private var streamingEnabled: Bool {
        (UserDefaults.standard.object(forKey: "alma-voice-streaming") as? Bool) ?? true
    }

    private var recURL: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("alma-voice-turn.m4a")
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    /// Prewarm on console open: audio session active + mic permission + ack cache +
    /// time-of-day greeting. This is what kills the web's 2–5s first-tap latency.
    func begin() {
        closed = false
        tts.engine = self
        // Island up for the whole session; the island's End button posts
        // almaVoiceEndRequested (AlmaVoiceEndIntent runs in this process).
        liveActivity.engine = self
        liveActivity.start()
        if liveActivityEndObserver == nil {
            liveActivityEndObserver = NotificationCenter.default.addObserver(
                forName: .almaVoiceEndRequested, object: nil, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.end() }
            }
        }
        // Self-heal wiring (owner bugs 2026-07-08): foreground return, call/other-app
        // interruption, media-services reset — and the island's "শুনুন" orb button.
        if recoveryObservers.isEmpty {
            let nc = NotificationCenter.default
            recoveryObservers.append(nc.addObserver(
                forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
            ) { [weak self] _ in Task { @MainActor in self?.recoverAudio("foreground") } })
            recoveryObservers.append(nc.addObserver(
                forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
            ) { [weak self] note in Task { @MainActor in self?.handleInterruption(note) } })
            recoveryObservers.append(nc.addObserver(
                forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main
            ) { [weak self] _ in Task { @MainActor in self?.recoverAudio("mediaReset") } })
            recoveryObservers.append(nc.addObserver(
                forName: .almaVoiceListenRequested, object: nil, queue: .main
            ) { [weak self] _ in Task { @MainActor in self?.islandListen() } })
        }
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
                    // .default mode (NOT .voiceChat): voiceChat routes TTS to the
                    // quiet earpiece AND enables Voice-Processing I/O, which fights
                    // the AVAudioEngine mic tap (owner hit both live on device: near-
                    // silent replies + crashes). .default + defaultToSpeaker + a forced
                    // speaker route = loud playback and a plain, stable input tap.
                    try s.setCategory(.playAndRecord, mode: .default,
                                      options: [.defaultToSpeaker, .allowBluetoothA2DP])
                    try s.setActive(true)
                    try? s.overrideOutputAudioPort(.speaker)
                    self.sessionReady = true
                } catch {
                    self.errorToast = "অডিও চালু করা গেল না"
                }
                Task { await self.prefetchAcks() }
                self.wake.engine = self
                self.refreshWake()
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
        keepAliveStop()
        for ob in recoveryObservers { NotificationCenter.default.removeObserver(ob) }
        recoveryObservers = []
        liveActivity.end()
        if let ob = liveActivityEndObserver {
            NotificationCenter.default.removeObserver(ob)
            liveActivityEndObserver = nil
        }
        wake.stop()
        vadTask?.cancel(); vadTask = nil
        turnTask?.cancel(); turnTask = nil
        heartbeatTask?.cancel(); heartbeatTask = nil
        recorder?.stop(); recorder = nil
        streamer.cancel(); streamingActive = false
        tts.stopAll()
        state = .idle
        Task { await chatVM?.loadMessages() }   // the voice turn lands in the thread
    }

    // ── Conversation keep-alive + audio self-heal ──────────────────────────
    // Keep-alive: a looping SILENT player runs ONLY while a conversation is
    // actively cycling (owner: never always-on). With the `audio` background
    // mode it stops iOS suspending the app between turns, so backgrounded
    // re-listen works and a mid-question exit can't truncate the mic. Released
    // when the conversation goes idle, on error, on শেষ, on console close.

    private static let silentWav: Data = {
        var d = Data()
        func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let samples = 8000                                    // 1s mono 8kHz 16-bit
        d.append("RIFF".data(using: .ascii)!); le32(UInt32(36 + samples * 2))
        d.append("WAVEfmt ".data(using: .ascii)!); le32(16); le16(1); le16(1)
        le32(8000); le32(16000); le16(2); le16(16)
        d.append("data".data(using: .ascii)!); le32(UInt32(samples * 2))
        d.append(Data(count: samples * 2))
        return d
    }()

    private func keepAliveStart() {
        guard keepAlive == nil else { return }
        keepAlive = try? AVAudioPlayer(data: Self.silentWav)
        keepAlive?.numberOfLoops = -1
        keepAlive?.volume = 0
        keepAlive?.play()
        tr("keepAlive ON")
    }

    private func keepAliveStop() {
        guard keepAlive != nil else { return }
        keepAlive?.stop(); keepAlive = nil
        tr("keepAlive off")
    }

    /// Post-background / post-interruption self-heal: reactivate the session and
    /// clear stuck half-state, so the console NEVER needs an app kill again.
    private func recoverAudio(_ why: String) {
        guard !closed else { return }
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playAndRecord, mode: .default,
                           options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try? s.setActive(true)
        try? s.overrideOutputAudioPort(.speaker)
        sessionReady = true
        startingListen = false
        if ttsActive && !tts.isAudiblyPlaying { ttsActive = false; ttsLevel = 0 }
        if state == .listening && recorder == nil && !streamingActive { state = .idle }
        if state == .speaking && !tts.isAudiblyPlaying { state = .idle }
        refreshWake()
        tr("recoverAudio(\(why))")
    }

    private func handleInterruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            tr("audio INTERRUPTED")
            keepAlive?.pause()
        } else {
            recoverAudio("interruption-ended")
            keepAlive?.play()
        }
    }

    /// Island orb button (AlmaVoiceListenIntent) — start listening WITHOUT
    /// bringing the app forward; the intent runs in this process in background.
    private func islandListen() {
        guard !closed else { return }
        recoverAudio("islandListen")
        switch state {
        case .speaking: tts.stopAll(); startListening()
        case .idle, .error: startListening()
        default: break
        }
    }

    private func greeting() -> String {
        var cal = Calendar.current
        cal.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        let h = cal.component(.hour, from: Date())
        let word = h >= 5 && h < 12 ? "সুপ্রভাত" : h < 17 ? "শুভ দুপুর" : h < 21 ? "শুভ সন্ধ্যা" : "শুভ রাত্রি"
        return "\(word) বস — বলুন, কী করতে হবে।"
    }

    /// Pre-synthesize the rotating acknowledgements ("জি বস।"…) for instant playback.
    private func prefetchAcks() async {
        let acks = ["জি বস।", "আচ্ছা বস, দেখছি।", "ঠিক আছে বস।", "জি, এক্ষুনি দেখছি।"]
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

    /// Sim-only (launch-arg gated): feed a canned reply through the TTS queue exactly
    /// as SSE deltas would, and log each sentence chunk it produces — proves the
    /// newline-split fix without needing backend auth. Never runs in production.
    func debugTtsChunks(_ reply: String) {
        tts.debugChunkLog(reply)
    }

    /// Sim-only: reproduce the feedback-loop scenario WITHOUT the backend — the agent
    /// starts speaking, then (as the old barge-in mic did) something tries to open the
    /// mic mid-speech. The gate MUST block it. Then silence opens the gate. Pure state
    /// machine, opens no real mic. Watch the ALMA-VOICE trace for BLOCKED then PASS.
    func debugGateTest() {
        tr("GATE-TEST begin")
        state = .thinking
        ttsDidStartFirstChunk()      // agent begins speaking → gate closes
        startListening()             // the old barge fired here → must log BLOCKED now
        startListening()             // twice, to be sure
        ttsDidGoSilent()             // agent finished → gate opens
        tr(ttsActive ? "GATE-TEST FAIL: gate still closed" : "GATE-TEST PASS: gate open after silence")
    }

    /// Attach a photo (chat composer parity) — optimistic thumbnail, uploads to
    /// /api/assistant/upload, becomes a ready AgentFileRef sent with the next turn.
    func attachImage(_ image: UIImage) {
        guard let jpeg = image.jpegData(compressionQuality: 0.85) else { return }
        let item = PendingImage(image: image)
        pendingImages.append(item)
        let fileId = item.id
        Task { [weak self] in
            struct UploadResponse: Decodable { let bucket: String; let path: String; let mediaType: String }
            do {
                let data = try await AssistantNet.uploadMultipart(
                    path: "/api/assistant/upload", fileField: "file",
                    filename: "photo-\(Int(Date().timeIntervalSince1970)).jpg",
                    mime: "image/jpeg", data: jpeg,
                    extraFields: ["conversationId": self?.chatVM?.conversationId ?? "general"])
                let up = try JSONDecoder().decode(UploadResponse.self, from: data)
                await MainActor.run {
                    guard let self, let i = self.pendingImages.firstIndex(where: { $0.id == fileId }) else { return }
                    self.pendingImages[i].state = .ready(.init(bucket: up.bucket, path: up.path, mediaType: up.mediaType))
                }
            } catch {
                await MainActor.run {
                    guard let self, let i = self.pendingImages.firstIndex(where: { $0.id == fileId }) else { return }
                    self.pendingImages[i].state = .failed
                }
            }
        }
    }
    func removeImage(_ id: UUID) { pendingImages.removeAll { $0.id == id } }

    /// Suggestion chips (design dock): run a normal voice turn from a canned prompt.
    func runChip(_ text: String) {
        guard state == .idle || state == .error else { return }
        tts.stopAll()
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
        guard sessionReady, state != .listening, !startingListen else { return }
        // HALF-DUPLEX GATE: never open the mic while the agent is still speaking. If a
        // caller (auto-listen, wake, a stray tap) reaches here mid-TTS, refuse — the
        // owner taps the orb to interrupt (that path stops TTS first, clearing the gate).
        guard !ttsActive else { tr("startListening BLOCKED (ttsActive)"); return }
        tr("startListening ALLOWED")
        startingListen = true
        keepAliveStart()                 // conversation live → survive backgrounding
        wake.stop()                      // free the mic for the STT engine
        tts.stopAll()
        if streamingEnabled {
            // Try TRUE streaming STT first. start() throws on any PRE-audio
            // failure (token mint / socket / mic engine) — those fall back to the
            // proven record-then-transcribe path with NO state changed yet.
            streamer.engine = self
            Task { [weak self] in
                guard let self else { return }
                do { try await self.streamer.start() }
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
            startingListen = false
            runVAD()
        } catch {
            startingListen = false
            errorToast = "মাইক্রোফোন ব্যবহার করা যাচ্ছে না — orb-এ ট্যাপ করে আবার চেষ্টা করুন।"
            state = .error
        }
    }

    // ── Streaming-STT callbacks (from AlmaStreamingSTT) ────────────────────

    /// Mic + socket are live — enter listening, exactly like the recorder path.
    func streamDidStart() {
        streamingActive = true
        startingListen = false
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
        noSpeechEnded()
    }

    /// A listen window opened but the owner said nothing. In কথোপকথন mode we keep the
    /// conversation ALIVE across a couple of natural pauses — re-arm listening instead
    /// of dead-ending, so the owner can fire question after question hands-free. After
    /// a few empty windows we stop (chime) so the mic isn't held open forever.
    private func noSpeechEnded() {
        guard convoMode, !closed, emptyListens < 2 else {
            emptyListens = 0
            keepAliveStop()              // conversation idle — release the audio hold
            playCloseChime()
            return
        }
        emptyListens += 1
        scheduleAutoListen()
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
            errorToast = "শুনতে পাইনি বস — আরেকবার বলুন।"
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
        tts.sayNow("শুনতে পাইনি বস — আরেকবার বলুন।")
        scheduleAutoListen()
    }

    /// Streaming socket never came up (or died) AFTER the owner spoke — the
    /// mic-first buffer arrives here as a WAV and goes through the proven
    /// /transcribe path, so connection latency can never eat his words.
    func streamFallbackUpload(_ wav: Data) {
        streamingActive = false
        micLevel = 0
        state = .transcribing
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        playAck()
        Task { [weak self] in
            guard let self else { return }
            do {
                let data = try await AssistantNet.uploadMultipart(
                    path: "/api/assistant/transcribe", fileField: "file",
                    filename: "voice.wav", mime: "audio/wav", data: wav)
                let t = try JSONDecoder().decode(TranscribeResponse.self, from: data)
                let text = (t.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else {
                    self.state = .idle
                    self.errorToast = "শুনতে পাইনি বস — আরেকবার বলুন।"
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

    /// The calibrated VAD loop — the core fix for "starts before I speak".
    private func runVAD() {
        vadTask?.cancel()
        vadTask = Task { [weak self] in
            guard let self else { return }
            let tickMs = 33.0
            var elapsed = 0.0
            var noiseFloor = 0.0, floorSamples = 0.0
            var speechThresh = 0.022                 // lowered: owner speech peaked ~0.047, old 0.045 dropped softer speech
            let silenceThresh = 0.014
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
                        // Clamp BOTH ends: never below 0.022 (soft speech), never above
                        // 0.06 — else if the owner is already mid-word when the listen
                        // window opens, his voice poisons the floor and the threshold
                        // climbs past his own speech → nothing arms → the turn dies and
                        // conversation "freezes" though he's clearly talking.
                        speechThresh = min(0.06, max(0.022, floor * 2.0))
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
                    // No-speech abort (web: 8s in convo mode). In কথোপকথন mode this
                    // re-arms for a couple of pauses instead of dead-ending the loop.
                    if elapsed > 8_000 {
                        self.cancelListening(playChime: false)
                        self.noSpeechEnded()
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
        playAck()                                    // instant "জি বস।"
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
                    self.errorToast = "শুনতে পাইনি বস — আরেকবার বলুন।"
                    self.scheduleAutoListen()
                    return
                }
                self.transcript = text
                self.runTurn(text)
            } catch {
                // A transient upload/transcribe failure must NOT dead-end on a scary
                // error orb — recover to idle and (in convo mode) re-listen so the
                // owner just speaks again. Speak the retry so a hands-free owner hears it.
                self.state = .idle
                self.errorToast = "একটু গোলমাল হলো বস — আরেকবার বলুন।"
                self.tts.sayNow("শুনতে একটু সমস্যা হলো বস, আরেকবার বলুন।")
                self.scheduleAutoListen()
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
        let files: [AgentFileRef]
        let resume: Resume?
        struct Resume: Encodable { let approve: Bool }
    }

    private func runTurn(_ text: String, resume: Bool = false) {
        emptyListens = 0                 // real turn — reset the silent-window counter
        if !resume, !lastUserText.isEmpty { lastQ = lastUserText; lastA = replyText }
        lastUserText = text
        state = .thinking
        replyText = ""
        saidLines = []; nowLine = ""
        cards.removeAll { $0.kind == .tool }
        narratedFirstTool = false
        verificationSaid = false
        lastAudioAt = Date()
        lastEventAt = Date()
        tts.beginTurn()
        startHeartbeat()

        let files = resume ? [] : readyImageFiles
        let body = VoiceChatBody(conversationId: chatVM?.conversationId,
                                 message: text,
                                 modelId: chatVM?.modelId ?? "auto",
                                 voice: true,
                                 files: files,
                                 resume: resume ? .init(approve: true) : nil)
        if !resume { pendingImages.removeAll() }
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
                self.tts.sayNow("দুঃখিত বস, একটা সমস্যা হয়েছে — একটু পরে আরেকবার বলুন।")
                self.errorToast = "উত্তর পেতে ব্যর্থ"
                self.tts.finishFeed()
            }
        }
    }

    private func handle(_ ev: AgentSSEEvent) {
        lastEventAt = Date()   // stall watchdog: any event keeps the turn alive
        switch ev.type {
        case "conversation_id":
            if let id = ev.id { chatVM?.conversationId = id }
        case "text_delta":
            replyText += ev.delta ?? ""
            tts.feed(ev.delta ?? "")
        case "tool_start":
            // Humanise the raw tool id for the step chip (get_pending_approvals →
            // "Get Pending Approvals") — never show snake_case to the owner.
            let raw = ev.name ?? "টুল"
            let label = raw.contains("_")
                ? raw.replacingOccurrences(of: "_", with: " ").capitalized
                : raw
            cards.append(.init(id: ev.id ?? UUID().uuidString, kind: .tool, icon: "🔧",
                               title: label, sub: "", status: "run"))
            // Speak a friendly, GENERIC "working on it" once per turn — never the raw
            // tool name (owner heard "get_pending_approvals, বস" spoken aloud).
            if !narratedFirstTool {
                narratedFirstTool = true
                lastToolNarration = Date()
                tts.sayNow("একটু দেখে নিচ্ছি, বস…")
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
                if !opts.isEmpty { tts.sayNow("\(opts.joined(separator: ", নাকি ")) — কোনটা, বস?") }
            }
        case "confirm_card":
            if let pid = ev.pendingActionId {
                cards.append(.init(id: pid, kind: .approval, icon: "🛡️",
                                   title: "আপনার অনুমোদন দরকার",
                                   sub: ev.summary ?? "", status: "wait", pendingActionId: pid))
                tts.sayNow("বস, একটা অনুমোদন দরকার — \(String((ev.summary ?? "").prefix(120)))")
            }
        case "verification_retry":
            // The head is self-correcting — in voice this reads as a hang unless
            // spoken (web parity). Once per turn.
            if !verificationSaid {
                verificationSaid = true
                lastAudioAt = Date()
                tts.sayNow("একটু যাচাই করে ঠিক করে নিচ্ছি, বস…")
            }
        case "model_switch_required":
            // A premium head needs the owner's OK. Spoken + a tappable card;
            // approve re-runs the same turn with resume{approve}.
            cards.append(.init(id: "modelswitch-\(cards.count)", kind: .modelSwitch,
                               icon: "🧠", title: "শক্তিশালী মডেলের অনুমতি দরকার",
                               sub: "", status: "wait"))
            lastAudioAt = Date()
            tts.sayNow("এটার জন্য আরও শক্তিশালী মডেল দরকার, বস — অনুমতি দিলে এগিয়ে যাই।")
        case "done":
            break
        case "error":
            tts.sayNow("দুঃখিত বস, একটা সমস্যা হয়েছে — একটু পরে আরেকবার বলুন।")
        default:
            break
        }
    }

    /// Web heartbeat: every 4s while thinking, if silent for 14s say "এখনো কাজ চলছে…".
    /// STALL WATCHDOG: if NO SSE event arrives for 30s while thinking/speaking, the turn
    /// stream is dead (dropped connection) — never leave the orb frozen: cancel, apologise,
    /// and (in convo mode) re-listen so the owner can just speak again.
    private func startHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                guard let self else { continue }
                if (self.state == .thinking || self.state == .speaking),
                   Date().timeIntervalSince(self.lastEventAt) > 30 {
                    self.turnTask?.cancel()
                    self.tts.stopAll()
                    self.state = .idle
                    self.tts.sayNow("দুঃখিত বস, উত্তরটা আটকে গেল — আরেকবার বলুন।")
                    self.scheduleAutoListen()
                    continue
                }
                guard self.state == .thinking else { continue }
                if Date().timeIntervalSince(self.lastAudioAt) > 14 {
                    self.lastAudioAt = Date()
                    self.tts.sayNow("এখনো কাজ চলছে বস, একটু সময় দিন…")
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
            self?.tts.sayNow(yes ? "অনুমোদন করে দিয়েছি বস, কাজ এগোচ্ছে।" : "বাতিল করে দিয়েছি, বস।")
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
            tts.sayNow("আচ্ছা বস, তাহলে বাদ দিলাম।")
        }
    }

    // ── TTS callbacks (from AlmaTtsQueue) ──────────────────────────────────

    func ttsDidStartFirstChunk() {
        lastAudioAt = Date()
        ttsActive = true                 // MIC GATE closes: agent is speaking
        tr("TTS first chunk — gate CLOSED")
        refreshWake()                    // ...so the wake mic can't hear the agent
        // Recording can flip the route to the receiver; force the loud speaker back
        // for the spoken reply (owner: replies were near-silent on device).
        try? AVAudioSession.sharedInstance().overrideOutputAudioPort(.speaker)
        if state == .thinking || state == .transcribing { state = .speaking }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    func ttsDidStartChunk(_ text: String) {
        ttsActive = true                 // stays closed for every chunk of the reply
        // Keep every spoken chunk on the loud speaker.
        try? AVAudioSession.sharedInstance().overrideOutputAudioPort(.speaker)
        lastAudioAt = Date()
        if !nowLine.isEmpty { saidLines.append(nowLine) }
        if saidLines.count > 2 { saidLines.removeFirst(saidLines.count - 2) }
        nowLine = text
    }

    func ttsLevelChanged(_ level: Double) { ttsLevel = level }

    /// The queue drained and playback stopped — the agent is SILENT now. Clear the mic
    /// gate. If this is a mid-turn gap (narration finished, reply not started yet) drop
    /// the orb back to «ভাবছি»; the real end-of-turn (ttsAllDone) flips it to idle+listen.
    func ttsDidGoSilent() {
        ttsActive = false
        ttsLevel = 0
        tr("TTS silent — gate OPEN")
        if state == .speaking { state = .thinking }
        refreshWake()
    }

    func ttsAllDone() {
        ttsActive = false                // gate open — safe to re-listen
        ttsLevel = 0
        tr("TTS all done — turn complete")
        if !nowLine.isEmpty { saidLines.append(nowLine); nowLine = "" }
        if state == .speaking || state == .thinking {
            state = .idle
            if convoMode { scheduleAutoListen() } else { keepAliveStop() }
        }
    }

    /// Re-open the mic AFTER the agent has fully finished speaking (half-duplex). The
    /// 700ms gap lets the speaker route settle so the very tail of the reply can't leak
    /// into the fresh listen. Guards on `!ttsActive` in case a new line started speaking.
    private func scheduleAutoListen() {
        guard convoMode, !closed else { return }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard let self, !self.closed, self.state == .idle, !self.ttsActive else { return }
            self.startListening()
        }
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
    private var connectTask: Task<Void, Never>?
    private let audioEngine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var outFormat: AVAudioFormat?
    private var tapInstalled = false
    private var openCont: CheckedContinuation<Void, Error>?

    // VAD state — touched on the CoreAudio tap thread (serialized by CoreAudio).
    private var elapsedMs = 0.0
    private var noiseFloor = 0.0, floorSamples = 0.0
    private var speechThresh = 0.022
    private let silenceThresh = 0.014
    private var sustainedMs = 0.0
    private var spoke = false
    private var speechStartMs = 0.0
    private var silenceMs = 0.0
    private var lastSecond = -1

    private var committed = false
    private var completedFired = false
    private var failed = false
    private var partial = ""

    // MIC-FIRST plumbing ("tap korle 3-4 sec por start hoy" fix): the mic starts
    // the instant the owner taps; PCM buffers locally while the token + socket
    // connect in the background, then flushes. If the socket never comes up, the
    // buffered audio uploads to /transcribe as a WAV — the owner's words are
    // NEVER lost to connection latency.
    private let lock = NSLock()
    private var pending: [Data] = []      // chunks awaiting the socket
    private var fullAudio = Data()        // whole utterance (fallback upload)
    private var socketOpen = false
    private var connectFailed = false
    private var wantCommit = false        // VAD ended before the socket was ready

    private struct TokenResp: Decodable { let key: String? }

    private func reset() {
        elapsedMs = 0; noiseFloor = 0; floorSamples = 0
        speechThresh = 0.022; sustainedMs = 0; spoke = false
        speechStartMs = 0; silenceMs = 0; lastSecond = -1
        committed = false; completedFired = false; failed = false; partial = ""
        pending = []; fullAudio = Data()
        socketOpen = false; connectFailed = false; wantCommit = false
    }

    /// MIC FIRST: start capturing immediately (throws only on a mic failure —
    /// caller falls back to the recorder path with no state changed yet), then
    /// mint the token + open the socket in the background.
    func start() async throws {
        reset()
        try startMic()
        await MainActor.run { self.engine?.streamDidStart() }
        connectTask = Task { [weak self] in await self?.connect() }
    }

    /// Token mint → socket handshake → force OUR endpointing → flush the buffer.
    private func connect() async {
        do {
            let data = try await AssistantNet.postJSONForData(path: "/api/assistant/stt-session", body: [:])
            guard let key = (try? JSONDecoder().decode(TokenResp.self, from: data))?.key, !key.isEmpty else {
                throw AlmaVoiceSTTError.noToken
            }
            guard let url = URL(string: "wss://api.openai.com/v1/realtime") else { throw AlmaVoiceSTTError.badURL }
            let sess = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
            session = sess
            let task = sess.webSocketTask(with: url, protocols: ["realtime", "openai-insecure-api-key.\(key)"])
            ws = task
            task.resume()
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask { try await withCheckedThrowingContinuation { self.openCont = $0 } }
                group.addTask { try await Task.sleep(nanoseconds: 8_000_000_000); throw AlmaVoiceSTTError.socket }
                try await group.next()
                group.cancelAll()
            }
            if failed { closeSocket(); return }
            // NOTE: no session.update is sent — the GA realtime API rejects the
            // old transcription_session.update type (owner hit this live: the
            // server error killed every listen). turn_detection:null is already
            // baked into the session by /api/assistant/stt-session, and the
            // "only OUR VAD commit fires a turn" guard covers the rest.
            receiveLoop()
            let drained = markSocketOpenAndDrain()
            if drained.abort { closeSocket(); return }   // no-speech already ended it
            for c in drained.chunks { sendChunk(c) }
            if drained.commitNow { ws?.send(.string(#"{"type":"input_audio_buffer.commit"}"#)) { _ in } }
        } catch {
            let doUpload = markConnectFailed()
            closeSocket()
            if doUpload { uploadBufferedWav() }
            // else: mic keeps listening locally; endUtterance will upload the WAV.
        }
    }

    /// Lock-guarded transitions for connect() (NSLock is not async-safe inline).
    private func markSocketOpenAndDrain() -> (chunks: [Data], commitNow: Bool, abort: Bool) {
        lock.lock(); defer { lock.unlock() }
        if committed && !wantCommit { return ([], false, true) }
        let c = pending
        pending = []
        socketOpen = true
        return (c, wantCommit, false)
    }
    private func markConnectFailed() -> Bool {
        lock.lock(); defer { lock.unlock() }
        connectFailed = true
        return wantCommit && !completedFired && !failed
    }

    // Delegate: handshake completed → resolve the open continuation.
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol proto: String?) {
        openCont?.resume(); openCont = nil
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let c = openCont { c.resume(throwing: AlmaVoiceSTTError.socket); openCont = nil }
        else if !completedFired { degradeToLocal() }
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

    /// Audio tap: RMS → orb + our adaptive VAD; PCM16@24k → socket (or buffer).
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
                // Clamp both ends (see recorder runVAD): a floor poisoned by the owner
                // already speaking must not push the threshold above his own voice.
                speechThresh = min(0.06, max(0.022, (noiseFloor / floorSamples) * 2.0))
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

        // Convert to 24k mono int16; stream if the socket is live, buffer if not.
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
        lock.lock()
        if fullAudio.count < 9_200_000 { fullAudio.append(bytes) }   // ~190s cap
        let open = socketOpen
        if !open { pending.append(bytes) }
        lock.unlock()
        if open { sendChunk(bytes) }
    }

    private func sendChunk(_ bytes: Data) {
        let b64 = bytes.base64EncodedString()
        ws?.send(.string("{\"type\":\"input_audio_buffer.append\",\"audio\":\"\(b64)\"}")) { _ in }
    }

    /// End of speech: stop the mic (privacy), commit (or fall back), await text.
    private func endUtterance(noSpeech: Bool) {
        if committed { return }
        committed = true
        stopMic()
        if noSpeech {
            connectTask?.cancel()
            closeSocket()
            DispatchQueue.main.async { [weak self] in self?.engine?.streamNoSpeech() }
            return
        }
        lock.lock()
        wantCommit = true
        let open = socketOpen
        let dead = connectFailed
        lock.unlock()
        if open {
            ws?.send(.string(#"{"type":"input_audio_buffer.commit"}"#)) { _ in }
        } else if dead {
            uploadBufferedWav()
            return
        }
        // else: connect() commits (or uploads) when it resolves.
        // Salvage watchdog: whatever happens to the socket, the owner's words
        // reach /transcribe within 10s.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self, !self.completedFired, !self.failed else { return }
            self.failed = true
            self.closeSocket()
            self.uploadBufferedWav()
        }
    }

    /// Any socket trouble mid-listen: degrade SILENTLY to local capture — the
    /// mic keeps running, and the utterance completes via the WAV upload path.
    /// The owner never sees a raw API error for a transport hiccup.
    private func degradeToLocal() {
        lock.lock()
        let mustUpload = committed && wantCommit && !completedFired && !failed
        socketOpen = false
        connectFailed = true
        lock.unlock()
        closeSocket()
        if mustUpload { uploadBufferedWav() }
    }

    /// Socket path failed after speech — upload the buffered utterance as WAV.
    private func uploadBufferedWav() {
        lock.lock(); let pcm = fullAudio; lock.unlock()
        guard pcm.count > 6_000 else {
            DispatchQueue.main.async { [weak self] in self?.engine?.streamNoSpeech() }
            return
        }
        let wav = Self.wavData(pcm: pcm)
        DispatchQueue.main.async { [weak self] in self?.engine?.streamFallbackUpload(wav) }
    }

    /// Minimal WAV container: PCM16 mono 24k.
    static func wavData(pcm: Data, rate: Int = 24_000) -> Data {
        var d = Data()
        func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(Data("RIFF".utf8)); le32(UInt32(36 + pcm.count)); d.append(Data("WAVE".utf8))
        d.append(Data("fmt ".utf8)); le32(16); le16(1); le16(1)
        le32(UInt32(rate)); le32(UInt32(rate * 2)); le16(2); le16(16)
        d.append(Data("data".utf8)); le32(UInt32(pcm.count)); d.append(pcm)
        return d
    }

    private func receiveLoop() {
        ws?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                if !self.completedFired { self.degradeToLocal() }
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
            // Guard for "nije nije kaj kore": a completed transcript only ends
            // the turn when OUR VAD committed it. A server-initiated commit
            // (should never happen with turn_detection null) just updates the
            // partial instead of firing a turn.
            lock.lock(); let ours = committed && wantCommit; lock.unlock()
            guard ours else {
                if let t = obj["transcript"] as? String { partial = t }
                return
            }
            completedFired = true
            let text = (obj["transcript"] as? String) ?? partial
            closeSocket()
            DispatchQueue.main.async { [weak self] in self?.engine?.streamFinal(text) }
        case "error":
            degradeToLocal()
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

    /// Force-send now (owner tapped the orb while listening). If the VAD never
    /// armed — nothing was said — the tap CANCELS instead of committing ambient
    /// noise into a bogus turn.
    func finishNow() { endUtterance(noSpeech: !spoke) }

    /// Hard stop with no callbacks (console closed / barge / teardown).
    func cancel() {
        failed = true
        connectTask?.cancel()
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

// MARK: - "ALMA" wake word (owner feature, 2026-07-06)
//
// While the console is OPEN and IDLE, an SFSpeechRecognizer listens for the
// wake word — saying «ALMA» starts a listen exactly like tapping the orb.
// It runs ONLY in idle (never while listening / thinking / speaking, so it
// can't fight the STT mic or hear ALMA's own TTS), recycles its recognition
// task every 50s (Apple's ~1min cap), and prefers on-device recognition.
// Escape hatch: UserDefaults "alma-wake-word" = false.

@available(iOS 17.0, *)
@MainActor
final class AlmaWakeWord {
    weak var engine: AlmaVoiceEngine?

    private let audioEngine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var tapOn = false
    private var recycleTask: Task<Void, Never>?
    private(set) var active = false

    // DEFAULT ON (owner request, 2026-07-06): saying «ALMA» while the console is idle
    // starts a listen. It runs ONLY in idle — `startListening()` calls `wake.stop()`
    // before touching the STT mic, so the two mic taps never overlap (the earlier
    // crash surface). Escape hatch: set `alma-wake-word` = false.
    private var enabled: Bool {
        (UserDefaults.standard.object(forKey: "alma-wake-word") as? Bool) ?? true
    }

    /// The transcript tail counts as a wake hit on any close rendering of
    /// "ALMA" (en_US recognizer; the owner may say it inside a Bangla stream).
    static func hit(_ transcript: String) -> Bool {
        let tail = String(transcript.lowercased().suffix(28))
        return ["alma", "almah", "aalma", "aluma", "alema", "আলমা"].contains { tail.contains($0) }
    }

    func start() {
        guard enabled, !active else { return }
        SFSpeechRecognizer.requestAuthorization { [weak self] auth in
            DispatchQueue.main.async {
                guard auth == .authorized else { return }
                self?.begin()
            }
        }
    }

    private func begin() {
        guard enabled, !active, let e = engine, e.state == .idle, !e.startingListen else { return }
        let rec = SFSpeechRecognizer(locale: Locale(identifier: "en_US"))
        guard let rec, rec.isAvailable else { return }
        recognizer = rec
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        let input = audioEngine.inputNode
        let fmt = input.inputFormat(forBus: 0)
        guard fmt.sampleRate > 0, fmt.channelCount > 0 else { return }
        input.installTap(onBus: 0, bufferSize: 2_048, format: fmt) { [weak self] buf, _ in
            self?.request?.append(buf)
        }
        tapOn = true
        audioEngine.prepare()
        do { try audioEngine.start() } catch { teardown(); return }
        active = true
        task = rec.recognitionTask(with: req) { [weak self] result, err in
            if let r = result, Self.hit(r.bestTranscription.formattedString) {
                DispatchQueue.main.async { self?.wakeHit() }
            } else if err != nil {
                DispatchQueue.main.async { self?.recycle() }
            }
        }
        recycleTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 50_000_000_000)
            guard !Task.isCancelled else { return }
            self?.recycle()
        }
    }

    private func wakeHit() {
        guard let e = engine, e.state == .idle, active else { return }
        stop()
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        e.startListening()
    }

    /// Apple caps continuous recognition (~1min) — tear down and re-arm.
    private func recycle() {
        guard active else { return }
        teardown()
        begin()
    }

    func stop() { teardown() }

    private func teardown() {
        recycleTask?.cancel(); recycleTask = nil
        task?.cancel(); task = nil
        request?.endAudio(); request = nil
        if tapOn { audioEngine.inputNode.removeTap(onBus: 0); tapOn = false }
        if audioEngine.isRunning { audioEngine.stop() }
        active = false
    }

    /// SIM self-test hook (no mic on the build Mac): recognize a spoken-word
    /// audio FILE through the same hit() gate and surface the verdict visibly.
    /// Never fires in production — only the local simctl launch passes the arg.
    func debugRecognizeFile(_ url: URL) {
        SFSpeechRecognizer.requestAuthorization { [weak self] auth in
            DispatchQueue.main.async {
                guard let self else { return }
                guard auth == .authorized else {
                    self.engine?.errorToast = "WAKE TEST: speech auth denied (\(auth.rawValue))"
                    return
                }
                guard let rec = SFSpeechRecognizer(locale: Locale(identifier: "en_US")), rec.isAvailable else {
                    self.engine?.errorToast = "WAKE TEST: recognizer unavailable"
                    return
                }
                let req = SFSpeechURLRecognitionRequest(url: url)
                rec.recognitionTask(with: req) { result, err in
                    DispatchQueue.main.async {
                        if let r = result, r.isFinal {
                            let t = r.bestTranscription.formattedString
                            let ok = AlmaWakeWord.hit(t)
                            self.engine?.errorToast = ok ? "WAKE ✓ শুনেছি: «\(t)»" : "WAKE ✗ শুনেছি: «\(t)»"
                            if ok { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
                        } else if let err {
                            self.engine?.errorToast = "WAKE TEST: \(err.localizedDescription)"
                        }
                    }
                }
            }
        }
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
    private var wasSilent = true             // fire ttsDidGoSilent once per silence edge

    /// Recovery probe: is a chunk actually sounding right now? (Stuck-flag repair.)
    var isAudiblyPlaying: Bool { player?.isPlaying ?? false }

    /// Reset the per-turn flags (greeting/acks must not count as the reply's
    /// first chunk — that kept the state stuck on "ভাবছি" during playback).
    func beginTurn() {
        startedFirst = false
        fedAnything = false
        feedFinished = false
        buffer = ""
    }

    /// Sim self-test: run `reply` through cutSentences in small deltas (like SSE) and
    /// NSLog every chunk so a mid-sentence split would be visible. Does not hit TTS.
    func debugChunkLog(_ reply: String) {
        buffer = ""; queue.removeAll()
        var i = reply.startIndex
        while i < reply.endIndex {
            let j = reply.index(i, offsetBy: 7, limitedBy: reply.endIndex) ?? reply.endIndex
            buffer += String(reply[i..<j]); cutSentences(flush: false); i = j
        }
        cutSentences(flush: true)
        NSLog("ALMA-TTS-TEST chunks=%d", queue.count)
        for (n, c) in queue.enumerated() { NSLog("ALMA-TTS-TEST [%d] «%@»", n, c) }
        queue.removeAll()
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
        // We are now silent (deliberate stop / tap-to-interrupt). Clear the engine's
        // mic gate so a follow-on startListening() is allowed. Does NOT auto-listen.
        if !wasSilent {
            wasSilent = true
            engine?.ttsDidGoSilent()
        }
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

    /// Cut `buffer` into WHOLE-sentence chunks for TTS. A chunk may end ONLY at a real
    /// sentence terminator — «।», «?», «!», or an English «.» that isn't a decimal —
    /// NEVER at a bare newline. The model emits `\n` for formatting (and mid-stream
    /// soft-wraps), and the old code cut on it: a sentence got sliced in half and its
    /// tail bled into the next TTS clip — the owner heard "আমি এখন স্কু" … pause …
    /// "লে যাব সেখানে…". Newlines inside a chunk are collapsed to a single space so the
    /// whole sentence is synthesised in one smooth breath. Tiny sentences merge forward
    /// to ~24 chars so we don't fire a TTS call per clause. `end` is monotonic → always
    /// terminates (no re-scan of the same boundary → no main-thread spin).
    private func cutSentences(flush: Bool) {
        func isTerminator(_ i: String.Index) -> Bool {
            let ch = buffer[i]
            if ch == "।" || ch == "?" || ch == "!" { return true }
            if ch == "." {
                // English full stop, but not a decimal ("5.5") or an initial ("A."):
                // only a real end when the next char is whitespace / end-of-buffer.
                if i > buffer.startIndex, buffer[buffer.index(before: i)].isNumber { return false }
                let next = buffer.index(after: i)
                if next == buffer.endIndex { return true }
                return buffer[next] == " " || buffer[next] == "\n"
            }
            return false
        }
        func firstTerminator(from start: String.Index) -> String.Index? {
            var i = start
            while i < buffer.endIndex {
                if isTerminator(i) { return buffer.index(after: i) }
                i = buffer.index(after: i)
            }
            return nil
        }
        while true {
            guard var end = firstTerminator(from: buffer.startIndex) else { break }
            // Too short? Extend to the NEXT terminator so tiny sentences merge into one
            // TTS chunk. `end` only moves forward → guaranteed to terminate.
            while !flush,
                  buffer.distance(from: buffer.startIndex, to: end) < 24,
                  let next = firstTerminator(from: end) {
                end = next
            }
            if !flush, buffer.distance(from: buffer.startIndex, to: end) < 24 {
                break   // still short and no further terminator — wait for more text
            }
            let chunk = String(buffer[..<end])
                .replacingOccurrences(of: "\n", with: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            buffer = String(buffer[end...])
            if !chunk.isEmpty { queue.append(chunk) }
        }
        if flush {
            let tail = buffer
                .replacingOccurrences(of: "\n", with: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !tail.isEmpty { queue.append(tail) }
            buffer = ""
        }
    }

    private func pump() {
        guard player == nil, !pumping else { prefetchNext(); return }
        guard !queue.isEmpty else {
            // Nothing left to play → the queue is now SILENT. Tell the engine once per
            // silence edge so it can clear the mic gate (and, if a reply turn finished,
            // re-open the mic). This is what lets auto-listen wait for true silence.
            if !wasSilent {
                wasSilent = true
                engine?.ttsDidGoSilent()
            }
            if feedFinished && player == nil && fedAnything { engine?.ttsAllDone() }
            return
        }
        wasSilent = false
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


// MARK: - The console view — the owner-confirmed v2 design (DESIGN-REFERENCE.html), 1:1
//
// Pixel target: docs/voice-console-native/DESIGN-REFERENCE.html + the v2 preview
// the owner confirmed 2026-07-06. Every component of that page exists here:
// near-black #04070D canvas, state-hued aurora, twinkling STARFIELD with comets,
// dot grid, top bar (ALMA. · এজেন্ট কনসোল · ঢাকা clock · ● LIVE), glass state
// badge, the WebGL FLUID ORB ported 1:1 to Metal (runtime-compiled — no pbxproj
// entry needed), 72-bar reactive waveform ring OUTSIDE the orb with a clear gap,
// spinning conic accent ring, 5 orbiting energy motes, thinking satellites,
// floor reflection, glowing caption (Sir in gold), checkmark steps, suggestion
// chips, live action-card feed (header + count + border-sweep pop), কথোপকথন
// dock. Tokens: ink #EAF2FB, muted #7C92A9, faint #55708C, gold #E2B366,
// line rgba(160,200,240,.13), good #3BE08F; hues idle 168 / listening 145 /
// thinking·transcribing 265 / speaking 210 / error 8. No mock/demo data — the
// feed and cards populate only from real SSE events (owner rule: production
// builds carry no placeholder content).

/// HSL → Color (the web uses HSL; SwiftUI's Color(hue:) is HSB). Faithful port.
@available(iOS 17.0, *)
func almaHSL(_ h: Double, _ s: Double, _ l: Double, _ a: Double = 1) -> Color {
    let c = (1 - abs(2 * l - 1)) * s
    let hp = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 60
    let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
    var r = 0.0, g = 0.0, b = 0.0
    switch hp {
    case 0..<1: (r, g, b) = (c, x, 0)
    case 1..<2: (r, g, b) = (x, c, 0)
    case 2..<3: (r, g, b) = (0, c, x)
    case 3..<4: (r, g, b) = (0, x, c)
    case 4..<5: (r, g, b) = (x, 0, c)
    default:    (r, g, b) = (c, 0, x)
    }
    let m = l - c / 2
    return Color(red: r + m, green: g + m, blue: b + m, opacity: a)
}

// MARK: - Edge glow (LOCKED owner demo 2026-07-08) — screen rim breathes with speech

@available(iOS 17.0, *)
struct AlmaVoiceEdgeGlow: View {
    var hue: Double
    var level: Double
    var active: Bool

    var body: some View {
        let tint = Color(hue: hue / 360.0, saturation: 0.9, brightness: 0.95)
        let strength = active ? 0.22 + level * 0.78 : 0
        ZStack {
            // tight bright rim
            Rectangle()
                .strokeBorder(tint.opacity(0.85), lineWidth: 3)
                .blur(radius: 7)
            // mid bloom
            Rectangle()
                .strokeBorder(tint.opacity(0.5), lineWidth: 14)
                .blur(radius: 24)
            // deep wash
            Rectangle()
                .strokeBorder(tint.opacity(0.3), lineWidth: 44)
                .blur(radius: 60)
        }
        .opacity(strength)
        .animation(.easeOut(duration: 0.12), value: level)
        .animation(.easeInOut(duration: 0.5), value: active)
    }
}

@available(iOS 17.0, *)
struct AlmaVoiceConsoleView: View {
    let vm: AssistantVM
    @State private var engine = AlmaVoiceEngine()
    @Environment(\.dismiss) private var dismiss
    @State private var liveBlink = false
    @State private var photoItem: PhotosPickerItem?

    /// DEBUG launch values (sim self-test only — simctl passes them as launch
    /// arguments; production launches carry neither env nor these args).
    private static func launchValue(_ key: String) -> String? {
        if let v = ProcessInfo.processInfo.environment[key], !v.isEmpty { return v }
        let prefix = key + "="
        if let a = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix(prefix) }) {
            let v = String(a.dropFirst(prefix.count))
            return v.isEmpty ? nil : v
        }
        return nil
    }

    // Web palette tokens.
    private let ink   = Color(red: 0.918, green: 0.949, blue: 0.984)   // #EAF2FB
    private let muted = Color(red: 0.486, green: 0.573, blue: 0.663)   // #7C92A9
    private let faint = Color(red: 0.333, green: 0.439, blue: 0.549)   // #55708C
    private let gold  = Color(red: 0.886, green: 0.702, blue: 0.400)   // #E2B366
    private let line  = Color(red: 0.627, green: 0.784, blue: 0.941).opacity(0.13)
    private let good  = Color(red: 0.231, green: 0.878, blue: 0.561)   // #3BE08F
    private let bg0   = Color(red: 0.016, green: 0.027, blue: 0.051)   // #04070D
    private let glass = Color(red: 0.549, green: 0.745, blue: 0.941)   // rgba(140,190,240,…) base

    private var hue: Double { engine.state.hue }
    private var toolSteps: [AlmaVoiceEngine.Card] { engine.cards.filter { $0.kind == .tool } }
    private var feedCards: [AlmaVoiceEngine.Card] { engine.cards.filter { $0.kind != .tool } }

    private static let dhakaClock: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "bn_BD@numbers=beng")
        f.timeZone = TimeZone(identifier: "Asia/Dhaka")
        f.dateFormat = "h:mm a"
        return f
    }()

    var body: some View {
        ZStack {
            bg0.ignoresSafeArea()
            aurora.ignoresSafeArea()
            AlmaStarfieldView().ignoresSafeArea().allowsHitTesting(false)
            dotGrid.ignoresSafeArea().allowsHitTesting(false)

            VStack(spacing: 0) {
                topBar
                Spacer(minLength: 4)
                stateBadge
                    .padding(.bottom, 10)
                AlmaFluidOrbView(state: engine.state,
                                 micLevel: engine.micLevel,
                                 ttsLevel: engine.ttsLevel)
                    .frame(width: orbSide, height: orbSide)
                    .contentShape(Circle())
                    .onTapGesture { engine.tapOrb() }
                voiceZone
                    .padding(.top, 16)
                feedSection
                Spacer(minLength: 4)
                dock
            }

            // LOCKED (owner demo 2026-07-08): speech-synced edge glow — the whole
            // screen's rim breathes with the live mic/TTS level in the state hue.
            AlmaVoiceEdgeGlow(hue: hue,
                              level: max(engine.micLevel, engine.ttsLevel),
                              active: engine.state != .idle)
                .ignoresSafeArea()
                .allowsHitTesting(false)
        }
        .preferredColorScheme(.dark)
        .onAppear {
            engine.chatVM = vm
            engine.begin()
            if let say = Self.launchValue("ALMA_VOICE_SAY") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 4) { engine.debugInjectUtterance(say) }
            }
            if let reply = Self.launchValue("ALMA_TTS_TEST") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { engine.debugTtsChunks(reply) }
            }
            if Self.launchValue("ALMA_GATE_TEST") != nil {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { engine.debugGateTest() }
            }
            if let wav = Self.launchValue("ALMA_WAKE_TEST") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    engine.wake.debugRecognizeFile(URL(fileURLWithPath: wav))
                }
            }
            // SIM MIC self-test: auto-start a real listen ~3s after the console opens,
            // so the record→transcribe→reply flow can be exercised headlessly by playing
            // known speech into the Mac mic. Never fires in production (launch-arg only).
            if Self.launchValue("ALMA_VOICE_LISTEN") != nil {
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { engine.startListening() }
            }
        }
        .onDisappear { engine.end() }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self),
                   let img = UIImage(data: data) {
                    await MainActor.run { engine.attachImage(img); photoItem = nil }
                }
            }
        }
        .overlay(alignment: .top) {
            if let t = engine.errorToast {
                Text(t)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(muted)
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

    private var orbSide: CGFloat { min(300, max(220, UIScreen.main.bounds.width * 0.72)) }

    // ── Background: state-hued aurora + dot grid (web .aurora / .dotgrid) ──
    private var aurora: some View {
        GeometryReader { geo in
            ZStack {
                RadialGradient(colors: [almaHSL(hue, 0.80, 0.55, 0.13), .clear],
                               center: .init(x: 0.5, y: 0.18),
                               startRadius: 0, endRadius: max(geo.size.width, geo.size.height) * 0.7)
                RadialGradient(colors: [almaHSL(hue + 40, 0.70, 0.45, 0.06), .clear],
                               center: .init(x: 0.85, y: 0.95),
                               startRadius: 0, endRadius: max(geo.size.width, geo.size.height) * 0.9)
            }
            .animation(.easeInOut(duration: 0.6), value: hue)
        }
    }

    private var dotGrid: some View {
        GeometryReader { geo in
            Canvas { ctx, size in
                let step: CGFloat = 26
                let dot = Color(red: 0.588, green: 0.784, blue: 0.961).opacity(0.10)
                var y: CGFloat = 0
                while y < size.height {
                    var x: CGFloat = 0
                    while x < size.width {
                        ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1.4, height: 1.4)), with: .color(dot))
                        x += step
                    }
                    y += step
                }
            }
            .mask(
                RadialGradient(colors: [.black, .black.opacity(0.0)],
                               center: .init(x: 0.5, y: 0.22),
                               startRadius: 0, endRadius: max(geo.size.width, geo.size.height) * 0.6)
            )
        }
    }

    // ── Top bar: ALMA. wordmark · এজেন্ট কনসোল | ঢাকা clock · ● LIVE · ✕ ──
    private var topBar: some View {
        HStack(spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                HStack(spacing: 0) {
                    Text("ALMA").font(.system(size: 19, weight: .heavy)).kerning(4.2).foregroundStyle(ink)
                    Text(".").font(.system(size: 19, weight: .heavy)).foregroundStyle(gold)
                }
                Text("এজেন্ট কনসোল").font(.system(size: 12.5)).foregroundStyle(muted)
            }
            Spacer(minLength: 8)
            TimelineView(.periodic(from: .now, by: 30)) { _ in
                Text("ঢাকা " + Self.dhakaClock.string(from: Date()))
                    .font(.system(size: 13)).monospacedDigit().foregroundStyle(muted)
            }
            HStack(spacing: 6) {
                Circle().fill(good).frame(width: 7, height: 7)
                    .shadow(color: good, radius: 5)
                    .opacity(liveBlink ? 0.35 : 1)
                    .onAppear {
                        guard !UIAccessibility.isReduceMotionEnabled else { return }
                        withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { liveBlink = true }
                    }
                Text("LIVE").font(.system(size: 10.5, weight: .semibold)).kerning(1.9).foregroundStyle(good)
            }
            Button {
                engine.end(); dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(muted)
                    .frame(width: 34, height: 34)
                    .background(glass.opacity(0.06), in: Circle())
                    .overlay(Circle().strokeBorder(line, lineWidth: 1))
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    // ── State badge: glass pill + glowing state-hued dot (web .statebadge) ──
    private var stateBadge: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(almaHSL(hue, 0.85, 0.62))
                .frame(width: 8, height: 8)
                .shadow(color: almaHSL(hue, 0.85, 0.62), radius: 6)
            Text(engine.state.statusText)
                .font(.system(size: 13))
                .foregroundStyle(engine.state == .error ? Color(red: 0.949, green: 0.627, blue: 0.557) : muted)
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .background(
            LinearGradient(colors: [glass.opacity(0.08), glass.opacity(0.02)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: Capsule())
        .overlay(Capsule().strokeBorder(line, lineWidth: 1))
        .animation(.easeInOut(duration: 0.4), value: hue)
    }

    // ── Transcript pill + glowing caption + checkmark steps (web voicezone) ──
    @ViewBuilder private var voiceZone: some View {
        VStack(spacing: 10) {
            // last exchange stays readable between turns
            if engine.state == .idle && engine.nowLine.isEmpty && !engine.lastA.isEmpty {
                VStack(spacing: 2) {
                    if !engine.lastQ.isEmpty {
                        Text(engine.lastQ).font(.system(size: 12)).foregroundStyle(faint).lineLimit(1)
                    }
                    Text(engine.lastA).font(.system(size: 13)).foregroundStyle(muted)
                        .multilineTextAlignment(.center).lineLimit(2)
                }
                .padding(.horizontal, 26)
            }
            if !engine.transcript.isEmpty && engine.state != .idle {
                HStack(spacing: 8) {
                    Text("MIC").font(.system(size: 10.5, weight: .bold)).foregroundStyle(good)
                    Text(engine.transcript).font(.system(size: 13.5)).foregroundStyle(muted).lineLimit(1)
                }
                .padding(.horizontal, 16).padding(.vertical, 7)
                .background(glass.opacity(0.06), in: Capsule())
                .overlay(Capsule().strokeBorder(line, lineWidth: 1))
                .padding(.horizontal, 24)
            }
            // caption: glowing current line + dim said; else greeting/reply; idle hint
            Group {
                if engine.state == .speaking && !engine.nowLine.isEmpty {
                    (Text(engine.saidLines.suffix(2).joined(separator: " ") + (engine.saidLines.isEmpty ? "" : " "))
                        .foregroundStyle(faint)
                     + Text(engine.nowLine).foregroundStyle(ink))
                        .font(.system(size: 16.5, weight: .medium))
                        .multilineTextAlignment(.center)
                        .lineLimit(7)
                        .truncationMode(.head)
                } else if !engine.replyText.isEmpty {
                    // Full reply readable: head-truncate → পুরনো লেখা সরে যায়, শেষটা সবসময় দেখা যায়।
                    goldSir(engine.replyText)
                        .font(.system(size: 16.5))
                        .multilineTextAlignment(.center)
                        .lineLimit(7)
                        .truncationMode(.head)
                } else if engine.state == .idle {
                    (Text("আসসালামু আলাইকুম, ").foregroundStyle(muted)
                     + Text("Boss").foregroundStyle(gold)
                     + Text("। অর্বে ট্যাপ করে বলুন।").foregroundStyle(muted))
                        .font(.system(size: 15))
                        .multilineTextAlignment(.center)
                } else if engine.state == .listening {
                    Text("চুপ করলেই পাঠিয়ে দেব — তাড়া নেই, \(engine.listenSeconds / 60):\(String(format: "%02d", engine.listenSeconds % 60))")
                        .font(.system(size: 12, design: .monospaced)).foregroundStyle(faint)
                }
            }
            .shadow(color: almaHSL(hue, 0.80, 0.60, 0.28), radius: 13)
            .padding(.horizontal, 26)
            // checkmark steps (web .steps) — tool progress for the current turn
            if !toolSteps.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(toolSteps) { s in stepRow(s) }
                }
            }
        }
        .frame(minHeight: 66, alignment: .top)
    }

    /// Web caption parity: "Sir"/"স্যার" render in gold inside the reply text.
    private func goldSir(_ text: String) -> Text {
        var out = Text("")
        var rest = Substring(text)
        while true {
            let rs = ["Boss", "বস", "Sir", "স্যার"].compactMap { rest.range(of: $0) }.min { $0.lowerBound < $1.lowerBound }
            guard let r = rs else { break }
            out = out + Text(String(rest[..<r.lowerBound])).foregroundStyle(ink)
            out = out + Text(String(rest[r])).foregroundStyle(gold)
            rest = rest[r.upperBound...]
        }
        return out + Text(String(rest)).foregroundStyle(ink)
    }

    @ViewBuilder private func stepRow(_ s: AlmaVoiceEngine.Card) -> some View {
        HStack(spacing: 8) {
            ZStack {
                Circle().strokeBorder(s.status == "ok" ? good : faint, lineWidth: 1.5)
                    .frame(width: 15, height: 15)
                if s.status == "ok" {
                    Image(systemName: "checkmark").font(.system(size: 7.5, weight: .bold)).foregroundStyle(good)
                } else if s.status == "fail" {
                    Image(systemName: "xmark").font(.system(size: 7.5, weight: .bold))
                        .foregroundStyle(Color(red: 0.949, green: 0.494, blue: 0.494))
                }
            }
            Text(s.title).font(.system(size: 13.5))
                .foregroundStyle(s.status == "ok" ? muted : faint)
                .lineLimit(1)
        }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    // ── Live action feed: header + count + glass cards (web .feed-col) ──
    @ViewBuilder private var feedSection: some View {
        if !feedCards.isEmpty {
            VStack(spacing: 10) {
                HStack {
                    Text("লাইভ অ্যাকশন ফিড")
                        .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(muted)
                    Spacer()
                    Text("\(feedCards.count)")
                        .font(.system(size: 11)).monospacedDigit().foregroundStyle(faint)
                        .padding(.horizontal, 10).padding(.vertical, 3)
                        .overlay(Capsule().strokeBorder(line, lineWidth: 1))
                }
                .padding(.horizontal, 22)
                ScrollView {
                    VStack(spacing: 10) {
                        ForEach(feedCards) { card in
                            AlmaFeedCard(card: card, engine: engine, hue: hue)
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .frame(maxHeight: 200)
            }
            .padding(.top, 10)
        }
    }

    // ── Dock: suggestion chips + কথোপকথন + চ্যাটে ফিরুন (web dock) ──
    private var dock: some View {
        VStack(spacing: 10) {
            if engine.state == .speaking {
                Text("ট্যাপ করে থামান ও কথা বলুন").font(.system(size: 12)).foregroundStyle(faint)
            }
            // attached-image thumbnails (chat composer parity)
            if !engine.pendingImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(engine.pendingImages) { img in
                            ZStack(alignment: .topTrailing) {
                                Image(uiImage: img.image).resizable().scaledToFill()
                                    .frame(width: 52, height: 52)
                                    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(line, lineWidth: 1))
                                    .overlay {
                                        if case .uploading = img.state {
                                            ZStack { Color.black.opacity(0.35); ProgressView().controlSize(.mini).tint(.white) }
                                                .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                                        } else if case .failed = img.state {
                                            RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Color.red.opacity(0.25))
                                        }
                                    }
                                Button { engine.removeImage(img.id) } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .accessibilityLabel("ছবি সরান")
                                        .font(.system(size: 15)).foregroundStyle(.white, .black.opacity(0.5))
                                }
                                .offset(x: 5, y: -5)
                            }
                        }
                    }
                    .padding(.horizontal, 22)
                }
            }
            // (demo chips removed — owner 2026-07-07: dead taps, cleaner console)
            HStack(spacing: 10) {
                PhotosPicker(selection: $photoItem, matching: .images) {
                    Image(systemName: "photo")
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(muted)
                        .frame(width: 38, height: 38)
                        .background(glass.opacity(0.06), in: Circle())
                        .overlay(Circle().strokeBorder(line, lineWidth: 1))
                }
                Button {
                    engine.convoMode.toggle()
                    UISelectionFeedbackGenerator().selectionChanged()
                } label: {
                    HStack(spacing: 7) {
                        Circle().fill(engine.convoMode ? good : faint)
                            .frame(width: 7, height: 7)
                            .shadow(color: engine.convoMode ? good : .clear, radius: 5)
                        Text(engine.convoMode ? "কথোপকথন চালু" : "কথোপকথন বন্ধ")
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(engine.convoMode ? muted : faint)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 9)
                    .background(glass.opacity(0.06), in: Capsule())
                    .overlay(Capsule().strokeBorder(engine.convoMode ? good.opacity(0.3) : line, lineWidth: 1))
                }
                Button { engine.end(); dismiss() } label: {
                    Text("চ্যাটে ফিরুন").font(.system(size: 13, weight: .medium))
                        .foregroundStyle(muted)
                        .padding(.horizontal, 20).padding(.vertical, 9)
                        .background(glass.opacity(0.06), in: Capsule())
                        .overlay(Capsule().strokeBorder(line, lineWidth: 1))
                }
            }
        }
        .padding(.bottom, 22)
    }

    private func chip(_ label: String, _ utterance: String, enabled: Bool) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            engine.runChip(utterance)
        } label: {
            Text(label)
                .font(.system(size: 13.5))
                .foregroundStyle(ink)
                .padding(.horizontal, 18).padding(.vertical, 9)
                .background(
                    LinearGradient(colors: [glass.opacity(0.09), glass.opacity(0.03)],
                                   startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: Capsule())
                .overlay(Capsule().strokeBorder(line, lineWidth: 1))
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }

}

// MARK: - Feed card (web .card): glass, icon box, status pill, big number +
// sparkline, approve/ask buttons, pop entrance + v2 border-sweep.

@available(iOS 17.0, *)
struct AlmaFeedCard: View {
    let card: AlmaVoiceEngine.Card
    let engine: AlmaVoiceEngine
    let hue: Double
    @State private var appeared = false

    private let ink   = Color(red: 0.918, green: 0.949, blue: 0.984)
    private let muted = Color(red: 0.486, green: 0.573, blue: 0.663)
    private let faint = Color(red: 0.333, green: 0.439, blue: 0.549)
    private let gold  = Color(red: 0.886, green: 0.702, blue: 0.400)
    private let line  = Color(red: 0.627, green: 0.784, blue: 0.941).opacity(0.13)
    private let good  = Color(red: 0.231, green: 0.878, blue: 0.561)
    private let glass = Color(red: 0.549, green: 0.745, blue: 0.941)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text(card.icon).font(.system(size: 15))
                    .frame(width: 34, height: 34)
                    .background(glass.opacity(0.07), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(line, lineWidth: 1))
                VStack(alignment: .leading, spacing: 1) {
                    Text(card.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(ink).lineLimit(2)
                    if !card.sub.isEmpty {
                        Text(card.sub).font(.system(size: 11.5)).foregroundStyle(faint).lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                statusPill
            }
            if !card.big.isEmpty {
                HStack(alignment: .center, spacing: 14) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(card.big)
                            .font(.system(size: 26, weight: .bold)).monospacedDigit()
                            .foregroundStyle(ink)
                        if !card.delta.isEmpty {
                            Text(card.delta).font(.system(size: 12.5)).foregroundStyle(good)
                        }
                    }
                    Spacer(minLength: 0)
                    if card.spark.count > 1 { sparkline }
                }
            }
            if card.kind == .ask && card.status == "wait" {
                HStack(spacing: 6) {
                    ForEach(card.options.prefix(4), id: \.self) { opt in
                        Button { engine.answer(card, option: opt) } label: {
                            Text(opt).font(.system(size: 12, weight: .medium))
                                .foregroundStyle(muted)
                                .padding(.horizontal, 11).padding(.vertical, 5)
                                .background(glass.opacity(0.07), in: Capsule())
                                .overlay(Capsule().strokeBorder(line, lineWidth: 1))
                        }
                    }
                }
            }
            if card.kind == .approval && card.status == "wait" {
                HStack(spacing: 8) {
                    pillButton("অনুমোদন দিন", solid: true) { engine.approve(card, yes: true) }
                    pillButton("বাতিল", solid: false) { engine.approve(card, yes: false) }
                }
            }
            if card.kind == .modelSwitch && card.status == "wait" {
                HStack(spacing: 8) {
                    pillButton("অনুমতি দিন", solid: true) { engine.resolveModelSwitch(card, approve: true) }
                    pillButton("থাক", solid: false) { engine.resolveModelSwitch(card, approve: false) }
                }
            }
        }
        .padding(.horizontal, 17).padding(.vertical, 15)
        .background(
            LinearGradient(colors: [glass.opacity(0.085), glass.opacity(0.028)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
            .strokeBorder(card.kind == .approval || card.kind == .modelSwitch
                          ? gold.opacity(0.35) : line, lineWidth: 1))
        // v2 border-sweep: a conic light runs the border once when the card pops
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(
                    AngularGradient(stops: [
                        .init(color: .clear, location: 0.08),
                        .init(color: almaHSL(hue, 0.85, 0.68, 0.65), location: 0.22),
                        .init(color: .clear, location: 0.42),
                        .init(color: .clear, location: 0.58),
                        .init(color: almaHSL(hue, 0.85, 0.68, 0.30), location: 0.74),
                        .init(color: .clear, location: 0.90),
                    ], center: .center, angle: .degrees(210)),
                    lineWidth: 1)
                .opacity(appeared ? 0 : 1)
        )
        .shadow(color: .black.opacity(0.45), radius: 14, y: 7)
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 16)
        .scaleEffect(appeared ? 1 : 0.965)
        .onAppear {
            withAnimation(.spring(duration: 0.55)) { appeared = true }
        }
    }

    private var statusPill: some View {
        let (label, color): (String, Color) = {
            switch card.status {
            case "run":  return ("চলছে", Color(red: 0.957, green: 0.784, blue: 0.416))   // #F4C86A
            case "wait": return ("অপেক্ষায়", Color(red: 0.435, green: 0.698, blue: 1.0)) // #6FB2FF
            case "ok":   return ("সম্পন্ন", good)
            case "fail": return ("ব্যর্থ", Color(red: 0.949, green: 0.494, blue: 0.494))
            default:     return (card.status, good)
            }
        }()
        return Text(label)
            .font(.system(size: 11.5)).foregroundStyle(color)
            .padding(.horizontal, 11).padding(.vertical, 4)
            .background(color.opacity(0.08), in: Capsule())
            .overlay(Capsule().strokeBorder(color.opacity(0.35), lineWidth: 1))
    }

    private var sparkline: some View {
        Canvas { ctx, size in
            let pts = card.spark
            guard let maxV = pts.max(), maxV > 0, pts.count > 1 else { return }
            var p = Path()
            for (i, v) in pts.enumerated() {
                let x = CGFloat(i) / CGFloat(pts.count - 1) * (size.width - 8) + 4
                let y = size.height - 5 - CGFloat(v / maxV) * (size.height - 12)
                if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
            }
            ctx.stroke(p, with: .color(good.opacity(0.9)), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
            // soft fill under the line
            var fill = p
            fill.addLine(to: CGPoint(x: size.width - 4, y: size.height))
            fill.addLine(to: CGPoint(x: 4, y: size.height))
            fill.closeSubpath()
            ctx.fill(fill, with: .linearGradient(
                Gradient(colors: [good.opacity(0.22), .clear]),
                startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)))
        }
        .frame(width: 120, height: 38)
    }

    private func pillButton(_ text: String, solid: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text).font(.system(size: 12.5, weight: solid ? .semibold : .medium))
                .foregroundStyle(solid ? Color(red: 0.016, green: 0.063, blue: 0.094) : muted)
                .padding(.horizontal, 16).padding(.vertical, 7)
                .background(solid
                    ? AnyShapeStyle(LinearGradient(colors: [Color(red: 0.486, green: 0.890, blue: 0.784),
                                                            Color(red: 0.306, green: 0.639, blue: 1.0)],
                                                   startPoint: .topLeading, endPoint: .bottomTrailing))
                    : AnyShapeStyle(glass.opacity(0.07)),
                    in: Capsule())
                .overlay(solid ? nil : Capsule().strokeBorder(line, lineWidth: 1))
        }
    }
}

// MARK: - Starfield (v2): twinkling micro-stars + occasional comet, deterministic
// (no stored state — star fields derive from hash functions, comets from a 13s cycle).

@available(iOS 17.0, *)
struct AlmaStarfieldView: View {
    private func rnd(_ i: Int, _ k: Double) -> Double {
        let v = sin(Double(i) * 127.1 + k * 311.7) * 43758.5453
        return v - v.rounded(.down)
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            Canvas { ctx, size in
                let starColor = Color(red: 0.745, green: 0.863, blue: 0.980)
                let n = min(170, Int(size.width * size.height / 14000))
                for i in 0..<max(0, n) {
                    let x = rnd(i, 1) * size.width
                    let y = rnd(i, 2) * size.height
                    let r = 0.3 + 1.1 * rnd(i, 3)
                    let ph = rnd(i, 4) * 6.283
                    let sp = 0.4 + 1.4 * rnd(i, 5)
                    let tw = 0.35 + 0.65 * abs(sin(t * sp + ph))
                    let rr = r * (0.7 + 0.5 * tw)
                    ctx.fill(Path(ellipseIn: CGRect(x: x - rr, y: y - rr, width: rr * 2, height: rr * 2)),
                             with: .color(starColor.opacity(0.08 + 0.20 * tw)))
                }
                // comet: one every ~13s, 2.2s flight, path from the cycle hash
                let cycle = Int(t / 13)
                let ct = t - Double(cycle) * 13
                if ct < 2.2 {
                    let life = 1 - ct / 2.2
                    let x0 = size.width * (0.15 + 0.75 * rnd(cycle, 7))
                    let y0 = size.height * 0.30 * rnd(cycle, 8)
                    let vx = -(130 + 150 * rnd(cycle, 9))
                    let vy = 55 + 55 * rnd(cycle, 10)
                    let hx = x0 + vx * ct, hy = y0 + vy * ct
                    let tx = hx - vx * 0.35, ty = hy - vy * 0.35
                    var p = Path()
                    p.move(to: CGPoint(x: hx, y: hy))
                    p.addLine(to: CGPoint(x: tx, y: ty))
                    ctx.stroke(p, with: .linearGradient(
                        Gradient(colors: [Color(red: 0.843, green: 0.933, blue: 1.0).opacity(0.65 * life), .clear]),
                        startPoint: CGPoint(x: hx, y: hy), endPoint: CGPoint(x: tx, y: ty)),
                        style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                }
            }
        }
    }
}

// MARK: - The fluid orb — WebGL FRAG ported 1:1 to Metal + ring/motes/sats
//
// Proportions match the web exactly: the SPHERE is 62% of the component frame
// (Metal canvas = 124% of frame, shader R≈0.5), the 72-bar waveform ring's base
// radius is 45.6% of the frame (canvas 136%, base 0.335) — so the ring sits
// clearly OUTSIDE the orb with a visible gap. Idle bars read as a clean dotted
// ring; listening/speaking grow them into reactive bars (glow via shadow filter).
// Plus: breathing bloom, spinning conic accent ring, 5 orbiting energy motes,
// 3 thinking satellites, and the v2 floor reflection.

@available(iOS 17.0, *)
struct AlmaFluidOrbView: View {
    let state: AlmaVoiceState
    let micLevel: Double
    let ttsLevel: Double

    private var breathe: Double {
        switch state {
        case .idle: return 4.6
        case .error: return 1.2
        case .transcribing, .thinking: return 1.7
        case .listening, .speaking: return 2.8
        }
    }

    private func activity(t: Double, level: Double) -> Double {
        switch state {
        case .transcribing, .thinking: return 0.85
        case .listening: return 0.45 + level * 0.3
        case .speaking:
            let env = max(0, sin(t * 3.4)) * max(0, sin(t * 1.24 + 1.6))
            return 0.25 + max(env * 0.65, level * 0.5)
        case .error: return 0.32
        case .idle: return 0.12
        }
    }

    var body: some View {
        GeometryReader { geo in
            let side = min(geo.size.width, geo.size.height)
            let h = state.hue
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                let level = state == .speaking ? ttsLevel : micLevel
                let act = activity(t: t, level: level)
                let scale = 1 + 0.028 * (1 - cos(2 * .pi * t / breathe))
                ZStack {
                    // breathing bloom (web .orb-bloom)
                    Circle()
                        .fill(RadialGradient(colors: [almaHSL(h, 0.90, 0.60, 0.34),
                                                      almaHSL(h, 0.90, 0.50, 0.10), .clear],
                                             center: .init(x: 0.5, y: 0.45),
                                             startRadius: 0, endRadius: side * 0.85))
                        .frame(width: side * 1.5, height: side * 1.5)
                        .blur(radius: 18)
                        .scaleEffect(scale)

                    // v2 floor reflection (web .orb-reflection)
                    Ellipse()
                        .fill(RadialGradient(colors: [almaHSL(h, 0.90, 0.60, 0.20), .clear],
                                             center: .init(x: 0.5, y: 0.1),
                                             startRadius: 0, endRadius: side * 0.38))
                        .frame(width: side * 0.76, height: side * 0.15)
                        .blur(radius: 10)
                        .offset(y: side * 0.60)

                    // spinning conic accent ring (web .orb-ring, 14s)
                    Circle()
                        .stroke(AngularGradient(stops: [
                            .init(color: .clear, location: 0),
                            .init(color: almaHSL(h, 0.90, 0.70, 0.55), location: 80.0 / 360),
                            .init(color: .clear, location: 160.0 / 360),
                            .init(color: .clear, location: 200.0 / 360),
                            .init(color: almaHSL(h, 0.90, 0.70, 0.28), location: 290.0 / 360),
                            .init(color: .clear, location: 1),
                        ], center: .center), lineWidth: 1)
                        .frame(width: side * 0.92, height: side * 0.92)
                        .rotationEffect(.degrees(t.truncatingRemainder(dividingBy: 14) / 14 * 360))

                    // 72-bar reactive waveform ring + 5 energy motes (one canvas)
                    Canvas { ctx, size in
                        let cx = size.width / 2, cy = size.height / 2
                        let base = size.width * 0.335
                        let barsVisible = state == .idle || state == .listening || state == .speaking
                        if barsVisible {
                            ctx.drawLayer { layer in
                                layer.addFilter(.shadow(color: almaHSL(h, 0.90, 0.65, 0.55), radius: 5))
                                for i in 0..<72 {
                                    let a = Double(i) / 72 * 2 * .pi - .pi / 2
                                    var amp = 1.5
                                    switch state {
                                    case .listening:
                                        amp = 3 + abs(sin(t * 2.1 + Double(i) * 0.7)) * 9
                                            + Double.random(in: 0...7) + level * 10
                                    case .speaking:
                                        let env = max(0, sin(t * 3.4)) * max(0, sin(t * 1.24 + 1.6))
                                        amp = 2 + max(env, level) * (7 + abs(sin(Double(i) * 1.3 + t * 5)) * 13)
                                    default:
                                        amp = 1.2 + sin(t * 0.9 + Double(i) * 0.35) * 0.8
                                    }
                                    let r1 = base, r2 = base + amp
                                    var p = Path()
                                    p.move(to: CGPoint(x: cx + cos(a) * r1, y: cy + sin(a) * r1))
                                    p.addLine(to: CGPoint(x: cx + cos(a) * r2, y: cy + sin(a) * r2))
                                    layer.stroke(p, with: .color(almaHSL(h, 0.90, 0.68, 0.22 + amp / 40)),
                                                 style: StrokeStyle(lineWidth: 2.2, lineCap: .round))
                                }
                            }
                        }
                        // v2 energy motes
                        ctx.drawLayer { layer in
                            layer.addFilter(.shadow(color: almaHSL(h, 0.95, 0.72, 0.8), radius: 9))
                            for mi in 0..<5 {
                                let ma = t * (0.22 + Double(mi) * 0.06) + Double(mi) * 2.51
                                let mr = base * (1.16 + 0.09 * sin(t * 0.7 + Double(mi) * 1.7))
                                let ms = 1.3 + act * 1.9
                                let mx = cx + cos(ma) * mr, my = cy + sin(ma) * mr
                                layer.fill(Path(ellipseIn: CGRect(x: mx - ms, y: my - ms, width: ms * 2, height: ms * 2)),
                                           with: .color(almaHSL(h, 0.95, 0.80, 0.22 + act * 0.38)))
                            }
                        }
                    }
                    .frame(width: side * 1.36, height: side * 1.36)

                    // THE ORB — Metal port of the exact WebGL fluid shader;
                    // SwiftUI-gradient fallback if Metal is unavailable.
                    if AlmaOrbRenderer.shared != nil {
                        AlmaMetalOrbView(hue: h, stateKey: state.rawValue, level: level)
                            .frame(width: side * 1.24, height: side * 1.24)
                            .allowsHitTesting(false)
                    } else {
                        fallbackSphere(side: side, h: h, t: t)
                            .frame(width: side * 0.62, height: side * 0.62)
                            .clipShape(Circle())
                            .shadow(color: almaHSL(h, 0.90, 0.45, 0.35), radius: 30, y: 18)
                            .scaleEffect(scale)
                    }

                    // thinking satellites (web .sats, 3.6s spin)
                    ZStack {
                        satDot(h).offset(y: -side * 0.58)
                        satDot(h).offset(x: -side * 0.44, y: side * 0.40)
                        satDot(h).offset(x: side * 0.44, y: side * 0.40)
                    }
                    .rotationEffect(.degrees(t.truncatingRemainder(dividingBy: 3.6) / 3.6 * 360))
                    .opacity(state == .thinking || state == .transcribing ? 1 : 0)
                }
                .frame(width: geo.size.width, height: geo.size.height)
                .animation(.easeInOut(duration: 0.5), value: h)
            }
        }
    }

    private func satDot(_ h: Double) -> some View {
        Circle()
            .fill(almaHSL(h, 0.95, 0.78))
            .frame(width: 7, height: 7)
            .shadow(color: almaHSL(h, 0.95, 0.70), radius: 6)
    }

    /// Non-Metal fallback: the previous multi-layer gradient approximation,
    /// sized to the correct 62% sphere proportion.
    @ViewBuilder private func fallbackSphere(side: CGFloat, h: Double, t: Double) -> some View {
        let d = side * 0.62
        ZStack {
            Circle().fill(RadialGradient(stops: [
                .init(color: almaHSL(h, 0.95, 0.88), location: 0),
                .init(color: almaHSL(h, 0.92, 0.60), location: 0.42),
                .init(color: almaHSL(h, 0.88, 0.40), location: 0.74),
                .init(color: almaHSL(h + 18, 0.80, 0.16), location: 1),
            ], center: .init(x: 0.36, y: 0.28), startRadius: 0, endRadius: d * 0.6))
            Circle()
                .fill(AngularGradient(colors: [
                    almaHSL(h, 0.88, 0.62), almaHSL(h + 40, 0.85, 0.50),
                    almaHSL(h - 30, 0.90, 0.66), almaHSL(h, 0.88, 0.62),
                ], center: .center, angle: .degrees(t / 10 * 360)))
                .frame(width: d * 1.2, height: d * 1.2)
                .blur(radius: 14).blendMode(.screen)
                .opacity(0.42)
            Circle()
                .fill(RadialGradient(colors: [almaHSL(h, 1.0, 0.92, 0.9),
                                              almaHSL(h, 0.95, 0.70, 0.25), .clear],
                                     center: .center, startRadius: 0, endRadius: d * 0.16))
                .frame(width: d * 0.4, height: d * 0.4)
                .blur(radius: 3)
            Ellipse().fill(RadialGradient(colors: [.white.opacity(0.5), .clear],
                                          center: .center, startRadius: 0, endRadius: d * 0.16))
                .frame(width: d * 0.28, height: d * 0.18)
                .offset(x: -d * 0.10, y: -d * 0.16)
                .blendMode(.screen)
            Circle().fill(RadialGradient(stops: [
                .init(color: .clear, location: 0.66),
                .init(color: almaHSL(h + 18, 0.90, 0.72, 0.35), location: 0.86),
                .init(color: almaHSL(h + 18, 0.90, 0.80, 0.55), location: 0.94),
                .init(color: .clear, location: 1),
            ], center: .center, startRadius: 0, endRadius: d * 0.5))
                .blendMode(.screen)
        }
    }
}

// MARK: - Metal orb: the DESIGN-REFERENCE WebGL fragment shader, 1:1 in MSL,
// runtime-compiled (no .metal file → no pbxproj registration needed).

struct AlmaOrbUniforms {
    var resX: Float
    var resY: Float
    var time: Float
    var hue: Float
    var amp: Float
}

final class AlmaOrbRenderer {
    static let shared: AlmaOrbRenderer? = AlmaOrbRenderer()

    let device: MTLDevice
    let queue: MTLCommandQueue
    let pipeline: MTLRenderPipelineState

    private init?() {
        guard let dev = MTLCreateSystemDefaultDevice(), let q = dev.makeCommandQueue() else { return nil }
        device = dev
        queue = q
        do {
            let lib = try dev.makeLibrary(source: AlmaOrbRenderer.msl, options: nil)
            guard let vfn = lib.makeFunction(name: "almaOrbVertex"),
                  let ffn = lib.makeFunction(name: "almaOrbFragment") else { return nil }
            let pd = MTLRenderPipelineDescriptor()
            pd.vertexFunction = vfn
            pd.fragmentFunction = ffn
            pd.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipeline = try dev.makeRenderPipelineState(descriptor: pd)
        } catch {
            return nil
        }
    }

    /// The exact FRAG from DESIGN-REFERENCE.html translated GLSL→MSL (incl. the
    /// two v2 additions: second rim light + iridescent shimmer). GLSL mod() is
    /// euclidean, MSL fmod() is not — hsl2rgb uses x-6·floor(x/6) instead.
    static let msl = """
    #include <metal_stdlib>
    using namespace metal;

    struct AlmaU { float resX; float resY; float time; float hue; float amp; };

    static float ahash(float2 p) {
        p = fract(p * float2(123.34, 345.45));
        p += dot(p, p + 34.345);
        return fract(p.x * p.y);
    }
    static float anoise(float2 p) {
        float2 i = floor(p), f = fract(p);
        float2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(ahash(i), ahash(i + float2(1.0, 0.0)), u.x),
                   mix(ahash(i + float2(0.0, 1.0)), ahash(i + float2(1.0, 1.0)), u.x), u.y);
    }
    static float afbm(float2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { v += a * anoise(p); p = p * 2.03 + float2(7.3, 3.1); a *= 0.5; }
        return v;
    }
    static float3 ahsl(float h, float s, float l) {
        float3 k = h / 60.0 + float3(0.0, 4.0, 2.0);
        k = k - 6.0 * floor(k / 6.0);
        float3 rgb = clamp(fabs(k - 3.0) - 1.0, 0.0, 1.0);
        float c = (1.0 - fabs(2.0 * l - 1.0)) * s;
        return (rgb - 0.5) * c + l;
    }

    vertex float4 almaOrbVertex(uint vid [[vertex_id]]) {
        float2 pos[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
        return float4(pos[vid], 0.0, 1.0);
    }

    fragment float4 almaOrbFragment(float4 fragPos [[position]], constant AlmaU& u [[buffer(0)]]) {
        float2 res = float2(u.resX, u.resY);
        float2 fc = float2(fragPos.x, u.resY - fragPos.y);   // GL is y-up
        float2 p = (fc * 2.0 - res) / min(res.x, res.y);
        float t = u.time;
        float breath = sin(t * 1.37) * 0.5 + 0.5;
        float R = 0.50 + 0.016 * breath + 0.05 * u.amp;
        float r = length(p);
        float ang = t * 0.10;
        float2x2 rot = float2x2(float2(cos(ang), -sin(ang)), float2(sin(ang), cos(ang)));
        float2 q = rot * p;
        float spd = 0.16 + u.amp * 0.6;
        float2 w = q * 1.9;
        float n1 = afbm(w + float2(t * spd, -t * spd * 0.7));
        float n2 = afbm(w * 1.6 + 4.0 * float2(n1, n1 * 0.7) + float2(-t * spd * 0.8, t * spd * 0.5));
        float3 c1 = ahsl(u.hue,        0.88, 0.55);
        float3 c2 = ahsl(u.hue + 46.0, 0.85, 0.46);
        float3 c3 = ahsl(u.hue - 38.0, 0.90, 0.62);
        float3 col = mix(c1, c2, smoothstep(0.25, 0.75, n1));
        col = mix(col, c3, smoothstep(0.42, 0.9, n2) * 0.6);
        float nz = sqrt(max(0.0, 1.0 - (r * r) / (R * R)));
        col *= 0.26 + 0.72 * nz;
        col *= 1.0 - 0.30 * smoothstep(0.0, 1.0, (-p.y / R) * 0.5 + 0.5) * (1.0 - nz * 0.6);
        float core = exp(-r * r * 6.0);
        col += ahsl(u.hue, 0.55, 0.85) * core * (0.10 + 0.28 * u.amp * (0.55 + 0.45 * sin(t * 8.0)));
        float fres = pow(1.0 - nz, 2.6);
        col += ahsl(u.hue + 18.0, 0.9, 0.68) * fres * 0.85;
        col += ahsl(u.hue - 42.0, 0.85, 0.58) * pow(1.0 - nz, 4.2) * 0.4;
        col += 0.05 * float3(sin(n2 * 14.0 + t * 0.5), sin(n2 * 14.0 + 2.1 + t * 0.5), sin(n2 * 14.0 + 4.2 + t * 0.5)) * nz;
        float2 hp = p - float2(-0.42, 0.46) * R;
        col += float3(1.0) * exp(-dot(hp, hp) * 52.0) * 0.5;
        float inside = smoothstep(R, R - 0.012, r);
        float halo = exp(-max(r - R, 0.0) * 6.5);
        float3 haloCol = ahsl(u.hue, 0.9, 0.60) * halo * (0.30 + 0.35 * u.amp);
        float3 outCol = col * inside + haloCol * (1.0 - inside);
        float alpha = max(inside, halo * (0.5 + 0.3 * u.amp) * (1.0 - inside));
        return float4(outCol * alpha, alpha);   // premultiplied for CA compositing
    }
    """
}

struct AlmaMetalOrbView: UIViewRepresentable {
    var hue: Double
    var stateKey: String
    var level: Double

    func makeCoordinator() -> Coord { Coord() }

    func makeUIView(context: Context) -> MTKView {
        let v = MTKView(frame: .zero, device: AlmaOrbRenderer.shared?.device)
        v.delegate = context.coordinator
        v.preferredFramesPerSecond = 30
        v.isOpaque = false
        v.backgroundColor = .clear
        v.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        v.isUserInteractionEnabled = false
        context.coordinator.apply(hue: hue, state: stateKey, level: level)
        return v
    }

    func updateUIView(_ v: MTKView, context: Context) {
        context.coordinator.apply(hue: hue, state: stateKey, level: level)
    }

    final class Coord: NSObject, MTKViewDelegate {
        private let start = CACurrentMediaTime()
        private var last = CACurrentMediaTime()
        private var hue: Float = 168
        private var hueTarget: Float = 168
        private var amp: Float = 0.12
        private var state = "idle"
        private var level: Float = 0

        func apply(hue: Double, state: String, level: Double) {
            hueTarget = Float(hue)
            self.state = state
            self.level = Float(level)
        }

        func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

        func draw(in view: MTKView) {
            guard let r = AlmaOrbRenderer.shared,
                  let drawable = view.currentDrawable,
                  let rpd = view.currentRenderPassDescriptor,
                  let cb = r.queue.makeCommandBuffer(),
                  let enc = cb.makeRenderCommandEncoder(descriptor: rpd) else { return }
            let now = CACurrentMediaTime()
            let dt = Float(min(0.05, now - last))
            last = now
            let t = Float(now - start)
            // web frame(): hue eases at 4.2/s, activity at 5.5/s
            hue += (hueTarget - hue) * min(1, dt * 4.2)
            let env = max(0, sin(t * 3.4)) * max(0, sin(t * 1.24 + 1.6))
            let target: Float
            switch state {
            case "thinking", "transcribing": target = 0.85
            case "listening": target = 0.45 + level * 0.3
            case "speaking": target = 0.25 + max(env * 0.65, level * 0.5)
            case "error": target = 0.32
            default: target = 0.12
            }
            amp += (target - amp) * min(1, dt * 5.5)
            var u = AlmaOrbUniforms(resX: Float(view.drawableSize.width),
                                    resY: Float(view.drawableSize.height),
                                    time: t, hue: hue, amp: amp)
            enc.setRenderPipelineState(r.pipeline)
            enc.setFragmentBytes(&u, length: MemoryLayout<AlmaOrbUniforms>.stride, index: 0)
            enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            enc.endEncoding()
            cb.present(drawable)
            cb.commit()
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
    ("Sir", "বস"),
    ("বস", "বস"),
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

    // Boss rule: TTS must never speak emoji descriptions — drop all emoji scalars.
    out = String(out.unicodeScalars.filter { sc in
        !(sc.properties.isEmojiPresentation
          || (sc.properties.isEmoji && sc.value > 0x238C)
          || sc.value == 0xFE0F || sc.value == 0x200D)
    })

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
