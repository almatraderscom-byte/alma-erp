//
//  AgentLiveDockView.swift
//  Watching the agent work, from the native app.
//
//  The owner asked for what Codex and the ChatGPT app do: while the agent is
//  working on his Mac or in Chrome, a small live view sits inside the chat —
//  and when he wants a proper look he expands it, like a YouTube mini-player,
//  without losing his place in the conversation.
//
//  This is the SwiftUI half of the web `AgentLiveDock.tsx`; the rules are
//  copied from there deliberately, so both surfaces behave the same:
//    idle       → renders NOTHING at all. A player parked on an idle chat is
//                 clutter, and the owner has said so about other panels.
//    strip      → one line above the composer: what it is doing right now,
//                 plus a thumbnail when there is a screenshot to show.
//    sheet      → screenshot large, step list under it, each step with its
//                 policy badge; collapsing returns to the strip.
//
//  Polling, not a socket: 3s while work is live, 15s idle, with a 20s linger
//  after work ends so the last frame does not vanish mid-glance. A dismiss is
//  remembered per step id — closing it during a running job must not re-open
//  it three seconds later (the web dock hit exactly that in Codex review).
//
//  NOT the ActivityKit Dynamic Island feature — `live-activity-push.ts` and
//  `/api/assistant/internal/live-activity/register` are a different thing that
//  happens to share the words "live activity". Do not merge them.
//

import SwiftUI

// MARK: - Wire types (mirror src/app/api/assistant/live-activity/route.ts)

struct AgentLiveActivityStep: Decodable, Identifiable, Equatable {
    let id: String
    /// mac | session | browser
    let surface: String
    /// One short Bangla line the owner reads at a glance.
    let labelBn: String
    /// The literal command / action, for the expanded view.
    let detail: String?
    /// queued | running | done | failed
    let status: String
    /// green = ran by itself, amber = he approved it. Mac only.
    let policy: String?
    let at: String
    /// L4: present on session-event steps — the session a reply would go to.
    let sessionId: String?
    /// claude | codex — codex is one-shot, so no reply composer for it.
    let sessionTool: String?
    /// Raw event kind — "ended"/"error" means the session cannot take a reply.
    let sessionKind: String?

    var surfaceBn: String {
        switch surface {
        case "mac": return "আপনার Mac"
        case "session": return "Claude সেশন"
        case "browser": return "ব্রাউজার"
        default: return surface
        }
    }
}

/// L5: one row per CLI session in the window — its own status and cost.
struct AgentLiveSession: Decodable, Identifiable, Equatable {
    let sessionId: String
    let tool: String
    let lastBn: String
    let status: String
    let costUsd: Double
    let at: String
    var id: String { sessionId }
}

struct AgentLiveActivityFeed: Decodable, Equatable {
    let active: Bool
    let current: AgentLiveActivityStep?
    let steps: [AgentLiveActivityStep]
    /// L7 — server truth: frames are flowing right now (optional for old servers).
    let streaming: Bool?
    /// L5 — optional so older servers still decode.
    let sessions: [AgentLiveSession]?
    /// data:image/… URI, newest across every surface.
    let screenshot: String?
    let screenshotAt: String?
    /// L9-B — non-nil while the Mac's Agora VIDEO broadcaster is live.
    let videoDeviceId: String?
}

// MARK: - Store

@available(iOS 17.0, *)
@MainActor
@Observable
final class AgentLiveDockStore {
    var feed: AgentLiveActivityFeed?
    var expanded = false
    /// He closed it by hand — respect that until genuinely NEW work starts.
    var dismissedStepId: String?

    private var lastActiveAt: Date = .distantPast
    /// Staff phones get 403 from this owner-only feed; two in a row means this
    /// user will never see the dock, so stop asking instead of polling forever.
    private var authFailures = 0

    static let lingerSeconds: TimeInterval = 20
    static let pollActiveSeconds: TimeInterval = 3
    static let pollIdleSeconds: TimeInterval = 15
    /// L9-A: while the Mac screen is actually STREAMING, frames land every
    /// ~600ms — a 3s poll wasted most of them. 1s keeps motion feeling live
    /// without hammering the server outside streaming windows.
    static let pollStreamingSeconds: TimeInterval = 1

    var recentlyActive: Bool { Date().timeIntervalSince(lastActiveAt) < Self.lingerSeconds }

    var show: Bool {
        guard let feed else { return false }
        if let dismissedStepId, dismissedStepId == (feed.current?.id ?? "") { return false }
        return feed.active || recentlyActive
    }

    /// The screenshot we HOLD. The poll sends `screenshotAfter` so the server
    /// answers an unchanged frame with metadata only — without this, an active
    /// dock re-downloaded the same multi-MB base64 payload every 3 seconds
    /// (Codex P1). `screenshotAt` is the cache key on both sides.
    private var screenshotURI: String?
    private var screenshotAt: String?

    /// The strip's thumbnail / sheet image, decoded from the data URI once per change.
    private var decodedFor: String?
    private var decoded: UIImage?
    var screenshotImage: UIImage? {
        guard let uri = screenshotURI else { return nil }
        let key = String(uri.suffix(64)) + String(uri.count)
        if decodedFor == key { return decoded }
        decodedFor = key
        decoded = Self.decodeDataURI(uri)
        return decoded
    }

    static func decodeDataURI(_ uri: String) -> UIImage? {
        guard uri.hasPrefix("data:image"),
              let comma = uri.firstIndex(of: ",") else { return nil }
        let b64 = String(uri[uri.index(after: comma)...])
        guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else { return nil }
        return UIImage(data: data)
    }

    func run() async {
        if applyFixtureIfRequested() { return }
        while !Task.isCancelled {
            await poll()
            if authFailures >= 2 { return }
            let streamingNow = feed?.streaming == true
            let delay = streamingNow
                ? Self.pollStreamingSeconds
                : (feed?.active == true || recentlyActive)
                    ? Self.pollActiveSeconds : Self.pollIdleSeconds
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    }

    private func poll() async {
        do {
            let fresh: AgentLiveActivityFeed = try await AlmaAPI.shared.getQuietAuth(
                "/api/assistant/live-activity",
                query: ["screenshotAfter": screenshotAt])
            authFailures = 0
            if let uri = fresh.screenshot {
                screenshotURI = uri
                screenshotAt = fresh.screenshotAt
            } else if fresh.screenshotAt == nil {
                // Nothing recent on any surface — drop the stale frame.
                screenshotURI = nil
                screenshotAt = nil
            }
            // else: unchanged frame, payload omitted by the server — keep ours.
            if fresh.active { lastActiveAt = Date() }
            // Only a DIFFERENT step brings the dock back after a dismiss.
            if let dismissed = dismissedStepId, let current = fresh.current, current.id != dismissed {
                dismissedStepId = nil
            }
            feed = fresh
            reconcileStreamState()
            // Never trap his screen: the sheet closes itself when work is gone.
            if !show { expanded = false }
        } catch AlmaAPIError.notAuthenticated {
            // AlmaAPI normalizes 401/403 to .notAuthenticated (and posts the
            // login banner) — this is the case the two-failure shutdown exists
            // for, so staff phones stop hitting the owner-only feed (Codex P2).
            authFailures += 1
        } catch let AlmaAPIError.http(status, _) where status == 401 || status == 403 {
            authFailures += 1
        } catch {
            // A dropped poll is not worth telling him about.
        }
    }

    func dismiss() {
        dismissedStepId = feed?.current?.id ?? "none"
        expanded = false
    }

    // MARK: L4 tap-to-reply

    /// The composer belongs to the NEWEST session, and only when it can take a
    /// reply. Searching for "any Claude event" paired the composer with session
    /// B's activity while sending to older session A (Codex round 5); a Codex
    /// or ended/errored newest session simply gets no composer.
    var replySessionId: String? {
        guard let newest = feed?.steps.first(where: { $0.surface == "session" && $0.sessionId != nil })
        else { return nil }
        guard newest.sessionTool != "codex",
              newest.sessionKind != "ended", newest.sessionKind != "error" else { return nil }
        return newest.sessionId
    }

    /// Where this composition is going, locked at the FIRST keystroke — a poll
    /// landing mid-typing must not silently retarget the owner's answer to a
    /// different session (Codex round 4).
    var pinnedReplySessionId: String?

    func pinReplyTargetIfNeeded(textNowEmpty: Bool) {
        if textNowEmpty {
            pinnedReplySessionId = nil
        } else if pinnedReplySessionId == nil {
            pinnedReplySessionId = replySessionId
        }
    }

    var replyState: ReplyState = .idle
    enum ReplyState: Equatable { case idle, sending, sent, queued, failed }

    // MARK: L7 live screen streaming (explicit owner start; daemon self-stops)

    /// The SERVER is the truth (fresh frames = streaming) — a remounted app
    /// mid-stream must show STOP, not a second start. The optimistic value
    /// bridges the seconds until frames appear, then releases.
    private var streamOptimistic: Bool?
    var streamBusy = false
    var streamOn: Bool { streamOptimistic ?? (feed?.streaming ?? false) }

    func reconcileStreamState() {
        if let opt = streamOptimistic, (feed?.streaming ?? false) == opt {
            streamOptimistic = nil
        }
    }

    private struct StreamBody: Encodable { let on: Bool }
    private struct StreamResponse: Decodable { let ok: Bool? }

    func toggleStream() async {
        guard !streamBusy else { return }
        streamBusy = true
        defer { streamBusy = false }
        do {
            let next = !streamOn
            let _: StreamResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/mac-agent/stream", body: StreamBody(on: next))
            streamOptimistic = next
        } catch {
            // The button simply stays where it was.
        }
    }

    private struct ReplyBody: Encodable { let sessionId: String; let text: String }
    private struct ReplyResponse: Decodable { let ok: Bool?; let delivered: Bool? }

    func sendReply(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, replyState != .sending,
              let sessionId = pinnedReplySessionId ?? replySessionId else { return }
        replyState = .sending
        do {
            let res: ReplyResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/mac-agent/session-reply",
                body: ReplyBody(sessionId: sessionId, text: trimmed))
            pinnedReplySessionId = nil
            // delivered == false means queued, not confirmed by the Mac yet —
            // claiming "reached" would invite a duplicate send.
            let landed: ReplyState = res.delivered == false ? .queued : .sent
            replyState = landed
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if self?.replyState == landed { self?.replyState = .idle }
            }
        } catch {
            replyState = .failed
        }
    }

    // MARK: DEBUG fixture — deterministic three-state sim proof, never in prod.

    private func applyFixtureIfRequested() -> Bool {
        #if DEBUG
        let p = ProcessInfo.processInfo
        func flag(_ k: String) -> String? {
            if let v = p.environment[k], !v.isEmpty { return v }
            return p.arguments.first { $0.hasPrefix("\(k)=") }?
                .replacingOccurrences(of: "\(k)=", with: "")
        }
        guard let mode = flag("ALMA_LIVE_DOCK_FIXTURE") else { return false }
        let now = ISO8601DateFormatter().string(from: Date())
        let steps = [
            AgentLiveActivityStep(id: "fx-1", surface: "mac",
                                  labelBn: "💻 git status", detail: "git status",
                                  status: "running", policy: "green", at: now, sessionId: nil, sessionTool: nil, sessionKind: nil),
            AgentLiveActivityStep(id: "fx-2", surface: "mac",
                                  labelBn: "💻 echo hello > /tmp/alma-live-dock-proof",
                                  detail: "echo hello > /tmp/alma-live-dock-proof",
                                  status: "done", policy: "amber", at: now, sessionId: nil, sessionTool: nil, sessionKind: nil),
            AgentLiveActivityStep(id: "fx-3", surface: "session",
                                  labelBn: "🧠 বুঝেছি — orders পেজের bug টা দেখছি, আগে টেস্ট চালাই",
                                  detail: "বুঝেছি — orders পেজের bug টা দেখছি, আগে টেস্ট চালাই",
                                  status: "running", policy: nil, at: now, sessionId: "fx-session", sessionTool: "claude", sessionKind: "text"),
            AgentLiveActivityStep(id: "fx-4", surface: "browser",
                                  labelBn: "🌐 পেজ খুলছে", detail: "https://alma-erp-six.vercel.app",
                                  status: "done", policy: nil, at: now, sessionId: nil, sessionTool: nil, sessionKind: nil),
        ]
        let fixtureSessions = [
            AgentLiveSession(sessionId: "fx-session", tool: "claude",
                             lastBn: "🧠 বুঝেছি — orders পেজের bug টা দেখছি",
                             status: "working", costUsd: 0.0421, at: now),
        ]
        feed = AgentLiveActivityFeed(active: true, current: steps.first,
                                     steps: steps, streaming: false, sessions: fixtureSessions,
                                     screenshot: nil, screenshotAt: nil, videoDeviceId: nil)
        lastActiveAt = Date()
        if mode == "sheet" { expanded = true }
        return true
        #else
        return false
        #endif
    }
}

// MARK: - View

@available(iOS 17.0, *)
struct AgentLiveDockView: View {
    @State private var store = AgentLiveDockStore()
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let pal = AgentPalette(scheme)
        // A VStack, never `Group { if … }`: when the dock is hidden the Group
        // resolves to EmptyView and SwiftUI never fires `.task` on it — so the
        // poll loop that would MAKE it visible never starts (sim-caught).
        // An empty VStack is still a real, installed view; its task runs.
        VStack(spacing: 0) {
            if store.show, let feed = store.feed {
                strip(feed: feed, pal: pal)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: store.show)
        .sheet(isPresented: $store.expanded) {
            if let feed = store.feed {
                AgentLiveDockSheet(store: store, feed: feed)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(28)
            }
        }
        .task { await store.run() }
    }

    private func statusDot(_ status: String, active: Bool) -> some View {
        let color: Color = switch status {
        case "running": .green
        case "queued": .orange
        case "failed": .red
        default: Color.black.opacity(0.25)
        }
        return Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .modifier(AgentLiveDockPulse(animate: active))
    }

    private func strip(feed: AgentLiveActivityFeed, pal: AgentPalette) -> some View {
        HStack(spacing: 10) {
            statusDot(feed.current?.status ?? "done", active: feed.active)

            if let shot = store.screenshotImage {
                Image(uiImage: shot)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 56, height: 36)
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                    .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(pal.borderSubtle, lineWidth: 1))
            }

            Button {
                AlmaAgentHaptics.light()
                store.expanded = true
            } label: {
                VStack(alignment: .leading, spacing: 1.5) {
                    Text(feed.current?.labelBn ?? "কাজ চলছে")
                        .font(.system(size: 13.5, weight: .medium))
                        .foregroundStyle(pal.ink)
                        .lineLimit(1)
                    Text("\(feed.current?.surfaceBn ?? "") · দেখতে ট্যাপ করুন")
                        .font(.system(size: 11))
                        .foregroundStyle(pal.muted)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button {
                AlmaAgentHaptics.light()
                store.expanded = true
            } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(pal.mutedHi)
                    .frame(width: 30, height: 30)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .accessibilityLabel("বড় করে দেখুন")

            Button {
                AlmaAgentHaptics.selection()
                store.dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(pal.muted.opacity(0.8))
                    .frame(width: 26, height: 26)
            }
            .accessibilityLabel("বন্ধ করুন")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .modifier(AlmaAgentGlassBackground(shape: RoundedRectangle(cornerRadius: 18), pal: AgentPalette(scheme)))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(pal.borderSubtle, lineWidth: 1))
        .shadow(color: .black.opacity(0.10), radius: 12, y: 4)
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .buttonStyle(AlmaAgentPressStyle())
        .accessibilityElement(children: .contain)
        .accessibilityLabel("এজেন্ট লাইভ কাজ")
    }
}

/// The gentle "work is live" pulse, honoring Reduce Motion.
@available(iOS 17.0, *)
private struct AgentLiveDockPulse: ViewModifier {
    let animate: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    func body(content: Content) -> some View {
        content
            .opacity(animate && dim ? 0.35 : 1)
            .animation(animate && !reduceMotion
                       ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true)
                       : .default, value: dim)
            .onAppear { if animate && !reduceMotion { dim = true } }
            .onChange(of: animate) { _, now in dim = now && !reduceMotion }
    }
}

// MARK: - Expanded sheet

@available(iOS 17.0, *)
struct AgentLiveDockSheet: View {
    @Bindable var store: AgentLiveDockStore
    let feed: AgentLiveActivityFeed
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @State private var replyText = ""

    var body: some View {
        let pal = AgentPalette(scheme)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let videoDevice = store.feed?.videoDeviceId {
                        // L9-B — TRUE live video (ScreenCaptureKit → Agora),
                        // cursor and clicks in real time. Frames stay the
                        // fallback the moment the broadcaster dies.
                        MacScreenVideoPlayer(deviceId: videoDevice)
                            .frame(height: 230)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                            .overlay(RoundedRectangle(cornerRadius: 14)
                                .strokeBorder(pal.borderSubtle, lineWidth: 1))
                    } else if let shot = store.screenshotImage {
                        Image(uiImage: shot)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxWidth: .infinity)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                            .overlay(RoundedRectangle(cornerRadius: 14)
                                .strokeBorder(pal.borderSubtle, lineWidth: 1))
                    } else {
                        RoundedRectangle(cornerRadius: 14)
                            .strokeBorder(pal.borderSubtle, style: StrokeStyle(lineWidth: 1.2, dash: [5, 4]))
                            .frame(height: 110)
                            .overlay {
                                Text("এখনো কোনো ছবি নেই — কাজের ধাপগুলো নিচে দেখুন।")
                                    .font(.system(size: 12.5))
                                    .foregroundStyle(pal.muted)
                                    .multilineTextAlignment(.center)
                                    .padding(.horizontal, 20)
                            }
                    }

                    Button {
                        AlmaAgentHaptics.commit()
                        Task { await store.toggleStream() }
                    } label: {
                        HStack(spacing: 7) {
                            if store.streamBusy {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: store.streamOn ? "stop.circle.fill" : "video.fill")
                                    .font(.system(size: 13, weight: .semibold))
                            }
                            Text(store.streamOn ? "লাইভ ভিউ বন্ধ করুন" : "Mac-এর লাইভ ভিউ দেখুন")
                                .font(.system(size: 13.5, weight: .semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .foregroundStyle(store.streamOn ? Color.red : pal.mutedHi)
                        .background(
                            (store.streamOn ? Color.red.opacity(0.10) : pal.ink.opacity(0.04)),
                            in: RoundedRectangle(cornerRadius: 11))
                        .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(
                            store.streamOn ? Color.red.opacity(0.35) : pal.borderSubtle, lineWidth: 1))
                    }
                    .disabled(store.streamBusy)
                    .accessibilityLabel("লাইভ স্ক্রিন ভিউ")

                    if let sessions = feed.sessions, !sessions.isEmpty {
                        VStack(spacing: 6) {
                            ForEach(sessions) { s in sessionRow(s, pal: pal) }
                        }
                    }

                    if store.replySessionId != nil {
                        replyRow(pal: pal)
                    }

                    VStack(spacing: 6) {
                        ForEach(feed.steps) { step in stepRow(step, pal: pal) }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 28)
            }
            .background(pal.bg0)
            .navigationTitle(feed.current?.labelBn ?? "কাজ চলছে")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(feed.current?.surfaceBn ?? "")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(pal.muted)
                        Text(feed.active ? "এখন চলছে" : "শেষ")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(feed.active ? .green : pal.muted)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        AlmaAgentHaptics.light()
                        dismiss()
                    } label: {
                        Text("ছোট করুন")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(pal.mutedHi)
                            .padding(.horizontal, 11)
                            .padding(.vertical, 6)
                            .background(.ultraThinMaterial, in: Capsule())
                    }
                    .accessibilityLabel("ছোট করুন")
                }
            }
        }
    }

    /// L5: one card per session — its own pulse, last line and running cost.
    private func sessionRow(_ s: AgentLiveSession, pal: AgentPalette) -> some View {
        HStack(spacing: 9) {
            Circle()
                .fill(s.status == "working" ? Color.green : s.status == "failed" ? Color.red : Color.primary.opacity(0.25))
                .frame(width: 8, height: 8)
                .modifier(AgentLiveDockPulse(animate: s.status == "working"))
            VStack(alignment: .leading, spacing: 1.5) {
                Text("\(s.tool == "codex" ? "Codex" : "Claude") সেশন")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(pal.ink)
                    .lineLimit(1)
                Text(s.lastBn)
                    .font(.system(size: 11))
                    .foregroundStyle(pal.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if s.costUsd > 0 {
                Text(String(format: "$%.4f", s.costUsd))
                    .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(pal.mutedHi)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(pal.ink.opacity(0.06), in: RoundedRectangle(cornerRadius: 5))
            }
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(pal.ink.opacity(0.04), in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(pal.borderSubtle, lineWidth: 1))
    }

    /// L4 tap-to-reply: answer the session without leaving the chat.
    @ViewBuilder
    private func replyRow(pal: AgentPalette) -> some View {
        HStack(spacing: 8) {
            TextField("সেশনকে উত্তর দিন…", text: $replyText)
                .font(.system(size: 13.5))
                .padding(.horizontal, 11)
                .padding(.vertical, 8)
                .background(pal.card, in: RoundedRectangle(cornerRadius: 11))
                .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(pal.borderSubtle, lineWidth: 1))
                .onSubmit { submitReply() }
                // Lock the target at the first keystroke — a poll mid-typing
                // must not retarget the answer to a newer session.
                .onChange(of: replyText) { _, next in
                    store.pinReplyTargetIfNeeded(
                        textNowEmpty: next.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            Button {
                AlmaAgentHaptics.commit()
                submitReply()
            } label: {
                Group {
                    if store.replyState == .sending {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "paperplane.fill")
                            .font(.system(size: 13, weight: .semibold))
                    }
                }
                .foregroundStyle(.white)
                .frame(width: 38, height: 34)
                .background(AgentPalette.coral, in: RoundedRectangle(cornerRadius: 11))
            }
            .disabled(store.replyState == .sending
                      || replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("সেশনে পাঠান")
        }
        .overlay(alignment: .bottomLeading) {
            if store.replyState == .sent {
                Text("সেশনে পৌঁছে গেছে ✓")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.green)
                    .offset(y: 16)
            } else if store.replyState == .queued {
                Text("কিউতে আছে — Mac নিশ্চিত করলেই পৌঁছাবে")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.orange)
                    .offset(y: 16)
            } else if store.replyState == .failed {
                Text("পাঠানো যায়নি — সেশনটা কি শেষ?")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.red)
                    .offset(y: 16)
            }
        }
        .padding(.bottom, store.replyState == .idle || store.replyState == .sending ? 0 : 10)
    }

    private func submitReply() {
        let text = replyText
        Task {
            await store.sendReply(text)
            if store.replyState == .sent || store.replyState == .queued { replyText = "" }
        }
    }

    private func stepRow(_ step: AgentLiveActivityStep, pal: AgentPalette) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Circle()
                .fill(stepColor(step.status))
                .frame(width: 6, height: 6)
                .padding(.top, 5.5)
            VStack(alignment: .leading, spacing: 2) {
                Text(step.labelBn)
                    .font(.system(size: 13.5))
                    .foregroundStyle(pal.ink)
                    .lineLimit(1)
                if let detail = step.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(pal.muted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if step.policy == "amber" {
                Text("আপনি অনুমতি দিয়েছেন")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Color.orange.opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
            }
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(pal.ink.opacity(0.03), in: RoundedRectangle(cornerRadius: 11))
    }

    private func stepColor(_ status: String) -> Color {
        switch status {
        case "running": return .green
        case "queued": return .orange
        case "failed": return .red
        default: return Color.primary.opacity(0.25)
        }
    }
}

// MARK: - L9-B: Mac screen live VIDEO (Agora subscriber)

import AgoraRtcKit

/// Joins `mac-screen-<deviceId>` as audience and renders the broadcaster
/// (uid 1). Its OWN lifetime is the join lifetime — disappearing leaves the
/// channel, so a closed sheet never keeps subscribing in the background.
/// Constraint (v1): shares the app-wide Agora engine with the intercom, so
/// watching while ON an intercom call is unsupported — the call wins.
@available(iOS 17.0, *)
struct MacScreenVideoPlayer: UIViewRepresentable {
    let deviceId: String

    final class Coordinator: NSObject, AgoraRtcEngineDelegate {
        var engine: AgoraRtcEngineKit?
        /// Which device this join belongs to — updateUIView compares to rejoin
        /// when the feed switches Macs mid-sheet (Codex P2).
        var joinedDeviceId: String?
        /// Our OWN Agora connection (joinChannelEx) — never the app's main
        /// channel, so watching the screen during an intercom call neither
        /// collides with it nor tears it down on dismantle (Codex P1).
        var connection: AgoraRtcConnection?
        weak var canvasView: UIView?
        var joined = false
        /// Sheet closed while the token request was in flight: the resumed
        /// task must NOT join a channel nobody will ever leave (Codex P2).
        var cancelled = false

        func join(deviceId: String, into view: UIView) {
            guard !joined else { return }
            joined = true
            joinedDeviceId = deviceId
            cancelled = false
            Task { @MainActor in
                struct TokenResp: Decodable {
                    let appId: String; let channel: String; let uid: Int; let token: String
                }
                guard let resp: TokenResp = try? await AlmaAPI.shared.send(
                    "POST", "/api/assistant/mac-agent/screen-video-token",
                    body: ["deviceId": deviceId]) else { return }
                if self.cancelled { return }
                let engine = AgoraRtcEngineKit.sharedEngine(withAppId: resp.appId, delegate: nil)
                self.engine = engine
                engine.enableVideo()
                let conn = AgoraRtcConnection(channelId: resp.channel, localUid: resp.uid)
                self.connection = conn
                let options = AgoraRtcChannelMediaOptions()
                options.clientRoleType = .audience
                options.autoSubscribeVideo = true
                options.autoSubscribeAudio = false
                options.publishCameraTrack = false
                options.publishMicrophoneTrack = false
                engine.joinChannelEx(byToken: resp.token, connection: conn,
                                     delegate: self, mediaOptions: options)
                // The broadcaster uid is FIXED (1) — bind the canvas right
                // away instead of waiting on a delegate callback whose
                // connection-routing varies by SDK minor (Codex P1); Agora
                // renders as soon as the remote stream arrives.
                if let view = self.canvasView {
                    let canvas = AgoraRtcVideoCanvas()
                    canvas.uid = 1
                    canvas.view = view
                    canvas.renderMode = .fit
                    engine.setupRemoteVideoEx(canvas, connection: conn)
                }
                // The view can have been dismantled between the await points —
                // never linger in the channel behind a closed sheet.
                if self.cancelled { self.leave() }
            }
        }

        func rtcEngine(_ engine: AgoraRtcEngineKit, didJoinedOfUid uid: UInt, elapsed: Int) {
            guard uid == 1, let view = canvasView, let conn = connection else { return } // 1 = the Mac
            let canvas = AgoraRtcVideoCanvas()
            canvas.uid = uid
            canvas.view = view
            canvas.renderMode = .fit
            engine.setupRemoteVideoEx(canvas, connection: conn)
        }

        func leave() {
            cancelled = true
            if let conn = connection {
                engine?.leaveChannelEx(conn, leaveChannelBlock: nil)
                connection = nil
            }
            joined = false
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .black
        context.coordinator.canvasView = view
        context.coordinator.join(deviceId: deviceId, into: view)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        // Feed switched to another Mac while the sheet stayed open: leave the
        // old channel and join the new one (Codex P2).
        if context.coordinator.joinedDeviceId != deviceId {
            context.coordinator.leave()
            context.coordinator.join(deviceId: deviceId, into: uiView)
        }
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        coordinator.leave()
    }
}
