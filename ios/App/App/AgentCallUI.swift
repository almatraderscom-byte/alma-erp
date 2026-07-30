//
//  AgentCallUI.swift
//  ALMA ERP — agent → owner in-app call, WhatsApp-parity experience (plan C2 v2).
//
//  Owner spec (2026-07-29): answering an agent call must feel EXACTLY like a
//  WhatsApp call — talk starts the moment the call is answered (lock screen
//  included, app UI not required), and when the owner looks at the app he sees a
//  dedicated full-screen CALL UI (avatar, name, timer, mute/speaker/end), NOT the
//  assistant voice section.
//
//  Pieces:
//    • AgentCallController — global (screen-independent) owner of the call. Runs
//      its OWN AlmaVoiceEngine instance headlessly, so audio flows even when no
//      screen exists (background/lock-screen answer). CallKit manages the audio
//      session; the engine's Gemini Live socket carries the conversation.
//    • AgentCallWindow — a dedicated UIWindow above the app that hosts
//      AgentCallScreen while the call is live and the app is foreground.
//    • AgentCallScreen — the WhatsApp-style in-call UI (ALMA design system).
//

import SwiftUI
import UIKit

// MARK: - Controller

@available(iOS 17.0, *)
@MainActor
final class AgentCallController: NSObject {
    static let shared = AgentCallController()

    /// Dedicated engine so an agent call never depends on the assistant tab
    /// having been built. chatVM stays nil — the engine treats it as optional
    /// everywhere (conversation defaults to "general").
    private(set) var engine: AlmaVoiceEngine?
    private(set) var activeCallId: String?
    private(set) var startedAt: Date?
    private var window: UIWindow?

    var isActive: Bool { activeCallId != nil }

    /// CallKit answer → start talking NOW. Safe to call from a background
    /// answer: no UI is required; the window appears when the app foregrounds.
    /// `callKitManaged` = a real CallKit call owns the audio session (device
    /// path). The sim harness has no CallKit, so it must configure the session
    /// itself — passing true there would wait forever for didActivate.
    func start(callId: String, purpose: String, callKitManaged: Bool = true) {
        guard activeCallId == nil else { return }
        activeCallId = callId
        startedAt = Date()
        let eng = AlmaVoiceEngine()
        engine = eng
        eng.callKitManaged = callKitManaged
        eng.activeAgentCallId = callId
        // Empty purpose = brief still in flight (deliverBrief will inject it,
        // pre- or post-connect). Never seed an empty note.
        if !purpose.isEmpty { eng.pendingAgentCallBrief = purpose }
        eng.begin()
        presentWindowIfForeground()
        NotificationCenter.default.addObserver(
            self, selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    /// CallKit activated the shared audio session — the live engine can start
    /// capture/playback now (it must never activate the session itself).
    func audioSessionActivated() {
        engine?.callKitAudioActivated()
    }

    /// Live voice could not start on THIS device — record why on the call row so
    /// the failure is diagnosable without a console (owner builds 89/90).
    func reportLiveFailure(_ reason: String) {
        guard let callId = activeCallId else { return }
        // Note-only: never replay a status transition just to carry a diagnostic.
        Task { await CallKitVoIP.postAgentCallStatus(callId, status: nil, note: reason) }
    }

    /// The brief arrives AFTER start() (answer fulfills before any network call —
    /// review-bot P1). The engine injects it now if the live socket is already
    /// connected, else on connect.
    func deliverBrief(callId: String, purpose: String) {
        guard activeCallId?.caseInsensitiveCompare(callId) == .orderedSame else { return }
        engine?.deliverAgentBrief(purpose)
    }

    /// End from OUR UI (red button) — engine.end() closes the CallKit call too,
    /// and its CXEndCallAction posts 'completed' to the server.
    func endFromUI() {
        engine?.end()
        teardown()
    }

    /// CallKit ended the call (system UI / remote cancel) — engine may still be
    /// live; close it WITHOUT asking CallKit again (activeAgentCallId cleared
    /// first so engine.end() skips its requestEnd).
    func callKitEnded(callId: String) {
        guard activeCallId?.caseInsensitiveCompare(callId) == .orderedSame else { return }
        engine?.activeAgentCallId = nil
        engine?.end()
        teardown()
    }

    private func teardown() {
        activeCallId = nil
        startedAt = nil
        engine = nil
        NotificationCenter.default.removeObserver(
            self, name: UIApplication.didBecomeActiveNotification, object: nil)
        dismissWindow()
    }

    @objc private func appDidBecomeActive() {
        presentWindowIfForeground()
    }

    private func presentWindowIfForeground() {
        guard isActive, window == nil, let engine,
              let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive })
        else { return }
        let w = UIWindow(windowScene: scene)
        w.windowLevel = .alert - 1   // above app UI + FloatingChatHead, below system alerts
        w.backgroundColor = .clear
        w.rootViewController = UIHostingController(
            rootView: AgentCallScreen(engine: engine, startedAt: startedAt ?? Date()) { [weak self] in
                self?.endFromUI()
            })
        w.rootViewController?.view.backgroundColor = .clear
        w.isHidden = false   // visible but NOT key — the app window keeps focus
        window = w
    }

    private func dismissWindow() {
        window?.isHidden = true
        window = nil
    }
}

// MARK: - The WhatsApp-style call screen

@available(iOS 17.0, *)
struct AgentCallScreen: View {
    let engine: AlmaVoiceEngine
    let startedAt: Date
    let onEnd: () -> Void

    var body: some View {
        ZStack {
            // ALMA aurora-dark call backdrop.
            LinearGradient(
                colors: [Color(red: 0.05, green: 0.09, blue: 0.09),
                         Color(red: 0.03, green: 0.05, blue: 0.06)],
                startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            RadialGradient(
                colors: [Color(red: 0.88, green: 0.48, blue: 0.37).opacity(0.16), .clear],
                center: .init(x: 0.5, y: 0.22), startRadius: 10, endRadius: 380)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer().frame(height: 64)

                Text(statusLine)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.55))

                Spacer().frame(height: 26)

                // Avatar — pulsing ring while the agent speaks.
                ZStack {
                    Circle()
                        .stroke(Color(red: 0.88, green: 0.48, blue: 0.37).opacity(0.35),
                                lineWidth: engine.ttsLevel > 0.02 || engine.state == .speaking ? 8 : 2)
                        .frame(width: 148, height: 148)
                        .animation(.easeInOut(duration: 0.25), value: engine.state)
                    Circle()
                        .fill(LinearGradient(
                            colors: [Color(red: 0.88, green: 0.48, blue: 0.37),
                                     Color(red: 0.72, green: 0.34, blue: 0.28)],
                            startPoint: .topLeading, endPoint: .bottomTrailing))
                        .frame(width: 128, height: 128)
                    Text("A")
                        .font(.system(size: 56, weight: .heavy, design: .rounded))
                        .foregroundStyle(.white)
                }

                Spacer().frame(height: 22)

                Text("ALMA")
                    .font(.system(size: 30, weight: .bold))
                    .foregroundStyle(.white)
                Text("আপনার এজেন্ট")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.white.opacity(0.55))
                    .padding(.top, 2)

                TimelineView(.periodic(from: startedAt, by: 1)) { _ in
                    Text(elapsedText)
                        .font(.system(size: 15, weight: .semibold).monospacedDigit())
                        .foregroundStyle(.white.opacity(0.7))
                        .padding(.top, 10)
                }

                // Live line: what's being said right now (one line, WhatsApp-lean).
                if !engine.nowLine.isEmpty || !engine.transcript.isEmpty {
                    Text(engine.nowLine.isEmpty ? engine.transcript : engine.nowLine)
                        .font(.system(size: 14))
                        .foregroundStyle(.white.opacity(0.75))
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 36)
                        .padding(.top, 18)
                }

                Spacer()

                // Controls — WhatsApp order: mute · speaker · end.
                HStack(spacing: 34) {
                    roundButton(
                        icon: engine.isMuted ? "mic.slash.fill" : "mic.fill",
                        label: "মিউট",
                        active: engine.isMuted,
                    ) { engine.toggleMute() }

                    roundButton(
                        icon: "speaker.wave.2.fill",
                        label: "স্পিকার",
                        active: engine.speakerOn,
                    ) { engine.toggleSpeaker() }

                    Button(action: onEnd) {
                        VStack(spacing: 8) {
                            ZStack {
                                Circle().fill(Color(red: 0.92, green: 0.26, blue: 0.21))
                                    .frame(width: 68, height: 68)
                                Image(systemName: "phone.down.fill")
                                    .font(.system(size: 26, weight: .semibold))
                                    .foregroundStyle(.white)
                            }
                            Text("শেষ")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.white.opacity(0.7))
                        }
                    }
                }
                .padding(.bottom, 54)
            }
        }
    }

    private var statusLine: String {
        switch engine.callConnection {
        case .idle, .connecting: return "সংযোগ হচ্ছে…"
        case .reconnecting: return "পুনঃসংযোগ হচ্ছে…"
        case .failed: return engine.connectionFailureText.isEmpty ? "সংযোগ হয়নি" : engine.connectionFailureText
        case .live:
            switch engine.state {
            case .speaking: return "ALMA বলছে…"
            case .thinking, .transcribing: return "ভাবছে…"
            default: return "শুনছে…"
            }
        }
    }

    private var elapsedText: String {
        let s = max(0, Int(Date().timeIntervalSince(startedAt)))
        return String(format: "%02d:%02d", s / 60, s % 60)
    }

    @ViewBuilder
    private func roundButton(icon: String, label: String, active: Bool,
                             action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 8) {
                ZStack {
                    Circle()
                        .fill(active ? Color.white : Color.white.opacity(0.14))
                        .frame(width: 68, height: 68)
                    Image(systemName: icon)
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(active ? Color.black : Color.white)
                }
                Text(label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.white.opacity(0.7))
            }
        }
    }
}

// MARK: - Call history (WhatsApp-style call log — owner request 2026-07-29)

@available(iOS 17.0, *)
struct AgentCallHistoryScreen: View {
    struct CallRow: Decodable, Identifiable {
        let id: String
        let purpose: String
        let source: String
        let status: String
        let createdAt: String
        let answeredAt: String?
        let endedAt: String?
    }
    private struct Resp: Decodable { let calls: [CallRow] }

    @State private var calls: [CallRow] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        Group {
            if loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error {
                VStack(spacing: 10) {
                    Text("হিস্টরি আনা যায়নি").font(.headline)
                    Text(error).font(.caption).foregroundStyle(.secondary)
                    Button("আবার চেষ্টা") { Task { await load() } }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if calls.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "phone.badge.waveform.fill")
                        .font(.system(size: 42))
                        .foregroundStyle(Color(red: 0.88, green: 0.48, blue: 0.37))
                    Text("এখনো কোনো কল নেই")
                        .font(.system(size: 15, weight: .semibold))
                    Text("ALMA আপনাকে কল দিলে এখানে দেখা যাবে।")
                        .font(.system(size: 13)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(calls) { row in callRow(row) }
                    .listStyle(.insetGrouped)
                    .refreshable { await load() }
            }
        }
        .task { await load() }
    }

    private func load() async {
        loading = calls.isEmpty
        error = nil
        do {
            let r: Resp = try await AlmaAPI.shared.send("GET", "/api/assistant/agent-call/history")
            calls = r.calls
        } catch {
            self.error = "নেটওয়ার্ক সমস্যা — একটু পরে দেখুন।"
        }
        loading = false
    }

    @ViewBuilder
    private func callRow(_ row: CallRow) -> some View {
        let missed = row.status == "unanswered" || row.status == "failed"
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(missed ? Color.red.opacity(0.12) : Color(red: 0.88, green: 0.48, blue: 0.37).opacity(0.14))
                    .frame(width: 42, height: 42)
                Image(systemName: missed
                      ? "phone.arrow.down.left.fill"
                      : row.status == "declined" ? "phone.down.fill" : "phone.fill.arrow.up.right")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(missed ? Color.red : Color(red: 0.82, green: 0.42, blue: 0.32))
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(row.purpose.isEmpty ? "ALMA কল" : row.purpose)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(statusLabel(row))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(missed ? Color.red : .secondary)
                    Text(timeLabel(row.createdAt))
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func statusLabel(_ row: CallRow) -> String {
        switch row.status {
        case "completed": return "কথা হয়েছে" + durationSuffix(row)
        case "answered": return "চলছিল"
        case "declined": return "কেটে দিয়েছেন"
        case "unanswered": return "মিসড কল"
        case "failed": return "যায়নি"
        case "ringing": return "রিং হচ্ছে…"
        default: return row.status
        }
    }

    private func durationSuffix(_ row: CallRow) -> String {
        guard let a = Self.parse(row.answeredAt), let e = Self.parse(row.endedAt) else { return "" }
        let s = max(0, Int(e.timeIntervalSince(a)))
        return String(format: " · %d:%02d", s / 60, s % 60)
    }

    private func timeLabel(_ iso: String) -> String {
        guard let d = Self.parse(iso) else { return "" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "bn_BD")
        if Calendar.current.isDateInToday(d) { f.dateFormat = "h:mm a" }
        else { f.dateFormat = "d MMM, h:mm a" }
        return f.string(from: d)
    }

    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()
    private static func parse(_ s: String?) -> Date? {
        guard let s else { return nil }
        return isoFrac.date(from: s) ?? isoPlain.date(from: s)
    }
}
