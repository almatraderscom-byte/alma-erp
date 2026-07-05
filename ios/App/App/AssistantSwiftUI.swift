//
//  AssistantSwiftUI.swift
//  ALMA ERP — S6b: the Assistant tab as a fully native SwiftUI chat screen.
//
//  Talks to the SAME /api/assistant/* endpoints the web agent page uses (via the
//  AlmaAPI cookie bridge — no new server routes):
//    GET  /api/assistant/active-conversation            → last-open thread pointer
//    GET  /api/assistant/conversations[?limit]          → sidebar list
//    POST /api/assistant/conversations {title?}         → new chat
//    GET  /api/assistant/conversations/:id/messages     → history (blocks + cards + tools)
//    POST /api/assistant/chat  (SSE)                    → send + stream the reply
//    POST /api/assistant/turn  + GET /turn/:id/stream   → A2 worker fallback (slow turns)
//    POST /api/assistant/turn/:id/cancel                → Stop button
//    POST /api/assistant/upload (multipart)             → image attachments
//    POST /api/assistant/transcribe (multipart)         → mic → text (Whisper)
//    GET  /api/assistant/files?path=…                   → signed URL for chat images
//    POST /api/assistant/actions/:id/approve|reject     → confirm cards
//    POST /api/assistant/ask-cards/:id/answer           → ask cards
//
//  Design: pixel-parity with the CURRENT web agent UI (owner rule — same colors,
//  same components): aurora background, coral #E07A5F→#C45A3C user bubbles
//  (rounded-2xl, cut bottom-right), full-width ink assistant text (15pt / 1.7),
//  frosted 24pt composer with plus/model-pill/mic/orb/send, "🔧 Nটি টুল" pill,
//  coral confirm/ask cards, thinking shimmer "কাজ করছি…", Bangla labels + digits.
//
//  v1 scope: chat thread + streaming + images + mic-to-text + cards + sidebar.
//  Voice-to-voice, Creative Studio, WhatsApp, Monitor, Costs stay web — reachable
//  from the sidebar as escape hatches (same set the old segmented control had).
//

import SwiftUI
import UIKit
import WebKit
import AVFoundation
import PhotosUI
import ObjectiveC

// MARK: - Palette (web token parity: globals.css / agent-ambient.css)

@available(iOS 17.0, *)
struct AgentPalette {
    let dark: Bool
    init(_ scheme: ColorScheme) { dark = scheme == .dark }

    static let coral    = Color(red: 0.878, green: 0.478, blue: 0.373) // #E07A5F
    static let coralDim = Color(red: 0.769, green: 0.353, blue: 0.235) // #C45A3C
    static let coralLt  = Color(red: 0.957, green: 0.635, blue: 0.549) // #F4A28C
    static let teal     = Color(red: 0.506, green: 0.698, blue: 0.604) // #81B29A

    /// --bg-0: page canvas behind the aurora
    var bg0: Color   { dark ? Color(red: 0.078, green: 0.078, blue: 0.094)   // #141418
                            : Color(red: 0.980, green: 0.976, blue: 0.965) } // #FAF9F6
    /// --c-ink: message text
    var ink: Color   { dark ? Color(red: 0.969, green: 0.973, blue: 0.988)   // #f7f8fc
                            : Color(red: 0.102, green: 0.102, blue: 0.180) } // #1a1a2e
    var muted: Color { dark ? Color(red: 0.682, green: 0.698, blue: 0.753)   // #aeb2c0
                            : Color(red: 0.392, green: 0.455, blue: 0.545) } // #64748b
    var card: Color  { dark ? Color(red: 0.125, green: 0.125, blue: 0.153)   // #202027
                            : .white }
    var borderSubtle: Color { dark ? Color.white.opacity(0.08) : Color.black.opacity(0.06) }
    /// composer glass fill (web: rgba(250,249,246,.72) / rgba(28,28,34,.55) + blur)
    var glassFill: Color { dark ? Color(red: 0.110, green: 0.110, blue: 0.133).opacity(0.55)
                                : Color(red: 0.980, green: 0.976, blue: 0.965).opacity(0.72) }
    var codeBg: Color { dark ? Color.black.opacity(0.45) : Color(red: 0.118, green: 0.118, blue: 0.157) }
}

/// Bangla digits — same convention as the web `toBn()`.
func almaBn(_ n: Int) -> String {
    let bn = ["০","১","২","৩","৪","৫","৬","৭","৮","৯"]
    return String(n).map { c in c.isNumber ? bn[Int(String(c))!] : String(c) }.joined()
}

// MARK: - Wire models (JS camelCase; dates kept as strings — shapes vary)

struct AgentConversation: Decodable, Identifiable, Equatable {
    let id: String
    var title: String?
    var modelId: String?
    var source: String?
    var archived: Bool?
    var updatedAt: String?
}

struct ActiveConversationPointer: Decodable {
    let conversationId: String?
    let modelId: String?
}

/// One heterogeneous content block — flat optionals instead of an enum so any
/// new server block type degrades to "unknown" instead of failing the decode.
struct AgentContentBlock: Decodable {
    let type: String?
    let text: String?
    let bucket: String?
    let path: String?
    let mediaType: String?
    let pendingActionId: String?
    let summary: String?
    let status: String?
    let actionType: String?
    let failReason: String?
    let askCardId: String?
    let question: String?
    let options: [String]?
    let selectedOption: String?
}

struct AgentToolCallWire: Decodable {
    let id: String?
    let name: String?
    let success: Bool?
    let result: String?
}

struct AgentMessageWire: Decodable {
    let id: String
    let role: String
    let content: [AgentContentBlock]?
    let thinking: String?
    let thinkingMs: Int?
    let toolCalls: [AgentToolCallWire]?
    let createdAt: String?
}

struct AgentFileRef: Codable, Equatable {
    let bucket: String
    let path: String
    let mediaType: String
}

struct OkResponse: Decodable { let ok: Bool?; let success: Bool?; let message: String? }
struct SignedURLResponse: Decodable { let url: String? }
struct TranscribeResponse: Decodable { let text: String? }
struct TurnEnqueueResponse: Decodable { let turnId: String; let conversationId: String? }
struct TurnStatusResponse: Decodable { let status: String?; let turnId: String? }

/// One SSE event — all fields optional, switch on `type`.
struct AgentSSEEvent: Decodable {
    let type: String
    let id: String?
    let delta: String?
    let label: String?
    let name: String?
    let success: Bool?
    let resultPreview: String?
    let pendingActionId: String?
    let summary: String?
    let actionType: String?
    let costEstimate: Double?
    let askCardId: String?
    let question: String?
    let options: [String]?
    let message: String?
    let error: String?
}

// MARK: - UI models

@available(iOS 17.0, *)
struct AgentChatMessage: Identifiable, Equatable {
    enum Role { case user, assistant }
    struct Tool: Identifiable, Equatable {
        let id: String
        var name: String
        var ok: Bool?
        var preview: String?
        var live: Bool
    }
    struct ConfirmCard: Identifiable, Equatable {
        let id: String            // pendingActionId
        var summary: String
        var status: String        // pending | approved | executed | failed | expired | rejected
        var actionType: String?
        var costEstimate: Double?
    }
    struct AskCard: Identifiable, Equatable {
        let id: String            // askCardId
        var question: String
        var options: [String]
        var status: String        // pending | answered | superseded
        var selectedOption: String?
    }

    let id: String
    let role: Role
    var text: String = ""
    var imagePaths: [String] = []
    var localImages: [UIImage] = []   // optimistic composer thumbnails (user msgs)
    var confirmCards: [ConfirmCard] = []
    var askCards: [AskCard] = []
    var tools: [Tool] = []
    var thinking: String?
    var thinkingMs: Int?
    var isStreaming = false

    static func from(_ wire: AgentMessageWire) -> AgentChatMessage {
        var m = AgentChatMessage(id: wire.id, role: wire.role == "user" ? .user : .assistant)
        for block in wire.content ?? [] {
            switch block.type {
            case "text":
                let t = block.text ?? ""
                m.text = m.text.isEmpty ? t : m.text + "\n" + t
            case "file_ref":
                if let p = block.path, (block.mediaType ?? "").hasPrefix("image") { m.imagePaths.append(p) }
            case "confirm_card":
                if let pid = block.pendingActionId {
                    m.confirmCards.append(.init(id: pid, summary: block.summary ?? "",
                                                status: block.status ?? "pending",
                                                actionType: block.actionType, costEstimate: nil))
                }
            case "ask_card":
                if let aid = block.askCardId {
                    m.askCards.append(.init(id: aid, question: block.question ?? "",
                                            options: block.options ?? [],
                                            status: block.status ?? "pending",
                                            selectedOption: block.selectedOption))
                }
            default: break
            }
        }
        m.thinking = wire.thinking
        m.thinkingMs = wire.thinkingMs
        m.tools = (wire.toolCalls ?? []).enumerated().map { i, t in
            .init(id: t.id ?? "tool-\(wire.id)-\(i)", name: t.name ?? "?", ok: t.success,
                  preview: t.result, live: false)
        }
        return m
    }
}

// MARK: - Networking (SSE + multipart; JSON goes through AlmaAPI)

/// Streaming + multipart companion to AlmaAPI (which is JSON-only). Shares the
/// same cookie bridge: HTTPCookieStorage.shared, refreshed via AlmaAPI.syncCookies().
enum AssistantNet {
    static let base = AlmaAPI.baseURL

    /// Long-lived session for SSE turns (a turn may legitimately run ~5 minutes).
    static let streamSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 330
        cfg.timeoutIntervalForResource = 660
        cfg.httpShouldSetCookies = true
        cfg.httpAdditionalHeaders = ["Accept": "text/event-stream",
                                     "X-Requested-With": "XMLHttpRequest"]
        return URLSession(configuration: cfg, delegate: AssistantRedirectBlocker(), delegateQueue: nil)
    }()

    /// Multipart upload (images / mic audio). Returns the raw response data on 2xx.
    static func uploadMultipart(path: String, fileField: String, filename: String,
                                mime: String, data: Data,
                                extraFields: [String: String] = [:]) async throws -> Data {
        await AlmaAPI.shared.syncCookies()
        let boundary = "alma-\(UUID().uuidString)"
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.timeoutInterval = 120
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        func append(_ s: String) { body.append(s.data(using: .utf8)!) }
        for (k, v) in extraFields {
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n")
        }
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(filename)\"\r\nContent-Type: \(mime)\r\n\r\n")
        body.append(data)
        append("\r\n--\(boundary)--\r\n")
        req.httpBody = body
        let (respData, resp) = try await streamSession.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw AlmaAPIError.transport(URLError(.badServerResponse)) }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 || http.statusCode == 403 { throw AlmaAPIError.notAuthenticated }
            throw AlmaAPIError.http(status: http.statusCode, body: String(data: respData, encoding: .utf8) ?? "")
        }
        return respData
    }

    /// Open an SSE stream and yield parsed events. Caller cancels via Task cancellation.
    static func streamEvents(request: URLRequest,
                             onEvent: @MainActor @escaping (AgentSSEEvent) -> Void) async throws {
        let (bytes, resp) = try await streamSession.bytes(for: request)
        guard let http = resp as? HTTPURLResponse else { throw AlmaAPIError.transport(URLError(.badServerResponse)) }
        if http.statusCode == 401 || http.statusCode == 403 || (300..<400).contains(http.statusCode) {
            throw AlmaAPIError.notAuthenticated
        }
        guard (200..<300).contains(http.statusCode) else {
            throw AlmaAPIError.http(status: http.statusCode, body: "stream")
        }
        for try await line in bytes.lines {
            try Task.checkCancellation()
            guard line.hasPrefix("data: ") else { continue }   // skip ": ping" keepalives
            guard let d = line.dropFirst(6).data(using: .utf8),
                  let ev = try? JSONDecoder().decode(AgentSSEEvent.self, from: d) else { continue }
            await onEvent(ev)
        }
    }
}

/// Same policy as AlmaAPI's RedirectBlocker (private there): a 307 → /login must
/// surface as a status code, not a silently-followed login HTML page.
final class AssistantRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
@MainActor
final class AssistantVM {
    // Thread state
    var conversationId: String?
    var conversationTitle: String = "ALMA AI"
    var messages: [AgentChatMessage] = []
    var loadingHistory = false

    // Streaming state
    var isStreaming = false
    var thinkingLive = false        // spinner row before the first text token
    var currentTurnId: String?
    private var streamTask: Task<Void, Never>?

    // Sidebar / conversations
    var showSidebar = false
    var conversations: [AgentConversation] = []

    // Composer attachments
    struct PendingFile: Identifiable, Equatable {
        enum State: Equatable { case uploading, ready(AgentFileRef), failed }
        let id = UUID()
        let image: UIImage
        var state: State = .uploading
    }
    var pendingFiles: [PendingFile] = []

    // Mic
    var isRecording = false
    var transcribing = false
    private var recorder: AVAudioRecorder?
    /// Text the mic transcription appends — the composer view observes this.
    var dictatedText: String = ""

    // Model pill
    var modelLabel: String?
    var modelId: String?

    // Errors / auth
    var authExpired = false
    var errorToast: String?

    // Signed image URLs (path → url), resolved lazily per thumbnail
    var signedURLs: [String: URL] = [:]

    private var pollTask: Task<Void, Never>?

    // ── Bootstrap + polling ────────────────────────────────────────────────

    func bootstrap() async {
        NotificationCenter.default.addObserver(forName: AlmaAPI.authExpiredNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.authExpired = true }
        }
        await loadActiveConversation()
        startPolling()
    }

    private func loadActiveConversation() async {
        do {
            let ptr: ActiveConversationPointer = try await AlmaAPI.shared.get("/api/assistant/active-conversation")
            if let cid = ptr.conversationId {
                conversationId = cid
                modelId = ptr.modelId
                await loadMessages(showSpinner: messages.isEmpty)
                await resumeRunningTurnIfAny()
            }
            authExpired = false
        } catch AlmaAPIError.notAuthenticated { authExpired = true } catch {
            // Pointer is a nicety — fall through to an empty new-chat state.
        }
    }

    func loadMessages(showSpinner: Bool = false) async {
        guard let cid = conversationId else { return }
        if showSpinner { loadingHistory = true }
        defer { loadingHistory = false }
        do {
            let wire: [AgentMessageWire] = try await AlmaAPI.shared.get("/api/assistant/conversations/\(cid)/messages")
            // Never clobber an in-flight optimistic/streaming tail with the poll.
            guard !isStreaming else { return }
            messages = wire.map(AgentChatMessage.from)
            authExpired = false
        } catch AlmaAPIError.notAuthenticated { authExpired = true } catch {
            if showSpinner { errorToast = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription }
        }
    }

    /// Web parity: quiet message re-poll every 12s (day-shift lines, Telegram echoes)
    /// + a presence ping (~20s) that suppresses redundant push notifications.
    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 12_000_000_000)
                guard let self, !Task.isCancelled else { return }
                if !self.isStreaming { await self.loadMessages() }
                tick += 1
                if tick % 2 == 0 {
                    let _: OkResponse? = try? await AlmaAPI.shared.send("POST", "/api/assistant/presence",
                                                                        body: [String: String]())
                }
            }
        }
    }

    /// If a turn was still running when the app was backgrounded/killed, show the
    /// spinner and poll turn-status until it settles (web does the same on resume).
    private func resumeRunningTurnIfAny() async {
        guard let cid = conversationId else { return }
        guard let st: TurnStatusResponse = try? await AlmaAPI.shared.get("/api/assistant/conversations/\(cid)/turn-status"),
              st.status == "running" else { return }
        isStreaming = true
        thinkingLive = true
        currentTurnId = st.turnId
        streamTask = Task { [weak self] in
            for _ in 0..<100 {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard let self, !Task.isCancelled else { return }
                let s: TurnStatusResponse? = try? await AlmaAPI.shared.get("/api/assistant/conversations/\(cid)/turn-status")
                if s?.status != "running" { break }
            }
            guard let self, !Task.isCancelled else { return }
            self.isStreaming = false
            self.thinkingLive = false
            await self.loadMessages()
        }
    }

    // ── Conversations (sidebar) ────────────────────────────────────────────

    func loadConversations() async {
        do {
            let list: [AgentConversation] = try await AlmaAPI.shared.get("/api/assistant/conversations",
                                                                         query: ["limit": "50"])
            conversations = list.filter { $0.archived != true }
            authExpired = false
        } catch AlmaAPIError.notAuthenticated { authExpired = true } catch {
            errorToast = error.localizedDescription
        }
    }

    func openConversation(_ id: String) async {
        guard id != conversationId else { return }
        stopStreaming(cancelServer: false)
        conversationId = id
        messages = []
        await loadMessages(showSpinner: true)
        let _: OkResponse? = try? await AlmaAPI.shared.send("POST", "/api/assistant/active-conversation",
                                                            body: ["conversationId": id])
        await resumeRunningTurnIfAny()
    }

    func newChat() async {
        stopStreaming(cancelServer: false)
        conversationId = nil     // server creates one on the first send
        messages = []
        pendingFiles = []
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    func deleteConversation(_ id: String) async {
        do {
            struct Empty: Decodable {}
            let _: Empty? = try? await AlmaAPI.shared.send("DELETE", "/api/assistant/conversations/\(id)")
            conversations.removeAll { $0.id == id }
            if conversationId == id { await newChat() }
        }
    }

    // ── Send + stream ──────────────────────────────────────────────────────

    struct ChatBody: Encodable {
        let conversationId: String?
        let message: String
        let files: [AgentFileRef]
        let modelId: String?
    }

    func send(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let readyFiles: [AgentFileRef] = pendingFiles.compactMap {
            if case .ready(let ref) = $0.state { return ref } else { return nil }
        }
        guard !text.isEmpty || !readyFiles.isEmpty, !isStreaming else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()

        var userMsg = AgentChatMessage(id: "local-\(UUID().uuidString)", role: .user, text: text)
        userMsg.localImages = pendingFiles.compactMap {
            if case .failed = $0.state { return nil } else { return $0.image }
        }
        messages.append(userMsg)
        pendingFiles = []
        isStreaming = true
        thinkingLive = true
        currentTurnId = nil

        let body = ChatBody(conversationId: conversationId, message: text,
                            files: readyFiles, modelId: modelId)
        streamTask = Task { [weak self] in
            await self?.runTurn(body: body)
        }
    }

    private func runTurn(body: ChatBody) async {
        defer {
            isStreaming = false
            thinkingLive = false
            if let i = messages.lastIndex(where: { $0.isStreaming }) { messages[i].isStreaming = false }
        }
        do {
            await AlmaAPI.shared.syncCookies()
            var req = URLRequest(url: AssistantNet.base.appendingPathComponent("/api/assistant/chat"))
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)

            var sawEvent = false
            do {
                // Direct SSE, with a 15s first-event watchdog (web parity: a hung
                // serverless run is handed to the VPS worker via /turn).
                try await withFirstEventWatchdog(seconds: 15, sawEvent: { sawEvent }) {
                    try await AssistantNet.streamEvents(request: req) { [weak self] ev in
                        sawEvent = true
                        self?.handle(ev)
                    }
                }
            } catch is WatchdogTimeout {
                try await runWorkerFallback(body: body)
            } catch AlmaAPIError.notAuthenticated {
                // One cookie refresh + retry, mirroring AlmaAPI.perform.
                AlmaAPI.shared.invalidateCookieCache()
                await AlmaAPI.shared.syncCookies()
                try await AssistantNet.streamEvents(request: req) { [weak self] ev in
                    self?.handle(ev)
                }
            }
            // Server truth (final card ids/statuses, tool rows, cost) replaces the tail.
            await loadMessages()
        } catch is CancellationError {
            await loadMessages()
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            errorToast = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    private struct WatchdogTimeout: Error {}

    /// Race `work` against a first-event timeout. If no event arrived in time the
    /// work task is cancelled and WatchdogTimeout is thrown.
    private func withFirstEventWatchdog(seconds: UInt64, sawEvent: @escaping () -> Bool,
                                        work: @escaping () async throws -> Void) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await work() }
            group.addTask {
                try await Task.sleep(nanoseconds: seconds * 1_000_000_000)
                if !sawEvent() { throw WatchdogTimeout() }
                // Events flowing — park until the work task finishes (group cancel).
                while true { try await Task.sleep(nanoseconds: 3_600_000_000_000) }
            }
            do {
                try await group.next()          // first finisher: work (done) or watchdog (timeout)
                group.cancelAll()
            } catch {
                group.cancelAll()
                throw error
            }
        }
    }

    /// A2 fallback: enqueue on the VPS worker queue and tail its durable stream.
    private func runWorkerFallback(body: ChatBody) async throws {
        struct TurnBody: Encodable {
            let conversationId: String?
            let message: String
            let files: [AgentFileRef]
        }
        let enq: TurnEnqueueResponse = try await AlmaAPI.shared.send(
            "POST", "/api/assistant/turn",
            body: TurnBody(conversationId: body.conversationId, message: body.message, files: body.files))
        currentTurnId = enq.turnId
        if conversationId == nil { conversationId = enq.conversationId }
        var req = URLRequest(url: AssistantNet.base.appendingPathComponent("/api/assistant/turn/\(enq.turnId)/stream"))
        req.httpMethod = "GET"
        try await AssistantNet.streamEvents(request: req) { [weak self] ev in
            self?.handle(ev)
        }
    }

    /// Apply one SSE event to the streaming tail message.
    private func handle(_ ev: AgentSSEEvent) {
        switch ev.type {
        case "conversation_id":
            if let id = ev.id { conversationId = id }
        case "turn_id":
            currentTurnId = ev.id
        case "model_info":
            if let l = ev.label { modelLabel = l }
        case "thinking_delta":
            thinkingLive = true
        case "text_delta":
            thinkingLive = false
            ensureStreamingTail()
            if let i = messages.lastIndex(where: { $0.isStreaming }) {
                messages[i].text += ev.delta ?? ""
            }
        case "tool_start":
            ensureStreamingTail()
            if let i = messages.lastIndex(where: { $0.isStreaming }) {
                messages[i].tools.append(.init(id: ev.id ?? UUID().uuidString,
                                               name: ev.name ?? "টুল", ok: nil, preview: nil, live: true))
            }
        case "tool_end":
            if let i = messages.lastIndex(where: { $0.isStreaming }),
               let j = messages[i].tools.firstIndex(where: { $0.id == ev.id }) {
                messages[i].tools[j].ok = ev.success
                messages[i].tools[j].preview = ev.resultPreview
                messages[i].tools[j].live = false
            }
        case "confirm_card":
            ensureStreamingTail()
            if let i = messages.lastIndex(where: { $0.isStreaming }), let pid = ev.pendingActionId {
                messages[i].confirmCards.append(.init(id: pid, summary: ev.summary ?? "",
                                                      status: "pending", actionType: ev.actionType,
                                                      costEstimate: ev.costEstimate))
            }
        case "ask_card":
            ensureStreamingTail()
            if let i = messages.lastIndex(where: { $0.isStreaming }), let aid = ev.askCardId {
                messages[i].askCards.append(.init(id: aid, question: ev.question ?? "",
                                                  options: ev.options ?? [], status: "pending",
                                                  selectedOption: nil))
            }
        case "done":
            thinkingLive = false
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case "error":
            thinkingLive = false
            errorToast = ev.message ?? ev.error ?? "সমস্যা হয়েছে — আবার চেষ্টা করুন"
        default:
            break
        }
    }

    private func ensureStreamingTail() {
        if messages.last?.isStreaming != true {
            var m = AgentChatMessage(id: "stream-\(UUID().uuidString)", role: .assistant)
            m.isStreaming = true
            messages.append(m)
        }
    }

    func stopStreaming(cancelServer: Bool = true) {
        streamTask?.cancel()
        streamTask = nil
        if cancelServer, let tid = currentTurnId {
            Task {
                let _: OkResponse? = try? await AlmaAPI.shared.send("POST", "/api/assistant/turn/\(tid)/cancel")
            }
        }
        isStreaming = false
        thinkingLive = false
        if let i = messages.lastIndex(where: { $0.isStreaming }) { messages[i].isStreaming = false }
    }

    // ── Cards ──────────────────────────────────────────────────────────────

    func approveAction(_ cardId: String, approve: Bool) async {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        setConfirmStatus(cardId, approve ? "approved" : "rejected")
        do {
            let _: OkResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/actions/\(cardId)/\(approve ? "approve" : "reject")")
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            setConfirmStatus(cardId, "pending")
            errorToast = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
        await loadMessages()
    }

    private func setConfirmStatus(_ cardId: String, _ status: String) {
        for i in messages.indices {
            if let j = messages[i].confirmCards.firstIndex(where: { $0.id == cardId }) {
                messages[i].confirmCards[j].status = status
            }
        }
    }

    func answerAskCard(_ cardId: String, option: String) async {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        for i in messages.indices {
            if let j = messages[i].askCards.firstIndex(where: { $0.id == cardId }) {
                messages[i].askCards[j].status = "answered"
                messages[i].askCards[j].selectedOption = option
            }
        }
        let _: OkResponse? = try? await AlmaAPI.shared.send(
            "POST", "/api/assistant/ask-cards/\(cardId)/answer", body: ["option": option])
        await loadMessages()
    }

    // ── Attachments ────────────────────────────────────────────────────────

    func attachImage(_ image: UIImage) {
        guard let jpeg = image.jpegData(compressionQuality: 0.85) else { return }
        var file = PendingFile(image: image)
        pendingFiles.append(file)
        let fileId = file.id
        Task { [weak self] in
            do {
                struct UploadResponse: Decodable { let bucket: String; let path: String; let mediaType: String }
                let data = try await AssistantNet.uploadMultipart(
                    path: "/api/assistant/upload", fileField: "file",
                    filename: "photo-\(Int(Date().timeIntervalSince1970)).jpg",
                    mime: "image/jpeg", data: jpeg,
                    extraFields: ["conversationId": self?.conversationId ?? "general"])
                let up = try JSONDecoder().decode(UploadResponse.self, from: data)
                await MainActor.run {
                    guard let self, let i = self.pendingFiles.firstIndex(where: { $0.id == fileId }) else { return }
                    self.pendingFiles[i].state = .ready(.init(bucket: up.bucket, path: up.path, mediaType: up.mediaType))
                }
            } catch {
                await MainActor.run {
                    guard let self, let i = self.pendingFiles.firstIndex(where: { $0.id == fileId }) else { return }
                    self.pendingFiles[i].state = .failed
                }
            }
        }
        _ = file // silence "never mutated" on some toolchains
    }

    func removePendingFile(_ id: UUID) { pendingFiles.removeAll { $0.id == id } }

    func signedURL(for path: String) async -> URL? {
        if let u = signedURLs[path] { return u }
        guard let resp: SignedURLResponse = try? await AlmaAPI.shared.get(
            "/api/assistant/files", query: ["path": path]),
              let s = resp.url, let u = URL(string: s) else { return nil }
        signedURLs[path] = u
        return u
    }

    // ── Mic → text (Whisper) ───────────────────────────────────────────────

    private var recordingURL: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("alma-dictation.m4a")
    }

    func toggleRecording() {
        if isRecording { finishRecording() } else { startRecording() }
    }

    private func startRecording() {
        let session = AVAudioSession.sharedInstance()
        session.requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                guard granted, let self else { return }
                do {
                    try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
                    try session.setActive(true)
                    let settings: [String: Any] = [
                        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                        AVSampleRateKey: 16_000,
                        AVNumberOfChannelsKey: 1,
                        AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
                    ]
                    self.recorder = try AVAudioRecorder(url: self.recordingURL, settings: settings)
                    self.recorder?.record()
                    self.isRecording = true
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                } catch {
                    self.errorToast = "মাইক্রোফোন চালু করা গেল না"
                }
            }
        }
    }

    private func finishRecording() {
        recorder?.stop()
        recorder = nil
        isRecording = false
        transcribing = true
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task { [weak self] in
            guard let self else { return }
            defer { self.transcribing = false }
            guard let audio = try? Data(contentsOf: self.recordingURL), audio.count > 1_000 else { return }
            do {
                let data = try await AssistantNet.uploadMultipart(
                    path: "/api/assistant/transcribe", fileField: "file",
                    filename: "dictation.m4a", mime: "audio/mp4", data: audio)
                let t = try JSONDecoder().decode(TranscribeResponse.self, from: data)
                if let text = t.text, !text.isEmpty {
                    self.dictatedText = text
                }
            } catch {
                self.errorToast = "ভয়েস বোঝা যায়নি — আবার বলুন"
            }
        }
    }
}

// MARK: - Aurora background (web .ambient-bg-root parity)

@available(iOS 17.0, *)
struct AgentAuroraBackground: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift = false

    private struct Blob { let color: Color; let size: CGFloat; let x: CGFloat; let y: CGFloat; let dx: CGFloat; let dy: CGFloat }

    var body: some View {
        let pal = AgentPalette(scheme)
        let dark = scheme == .dark
        // globals.css --aurora-blob-1…5 (light 0.32–0.40 / dark 0.70–0.85 alphas)
        let blobs: [Blob] = [
            .init(color: Color(red: 0.220, green: 0.502, blue: 1.000).opacity(dark ? 0.60 : 0.30), size: 380, x: 0.15, y: 0.10, dx: 60, dy: 40),
            .init(color: Color(red: 0.486, green: 0.302, blue: 1.000).opacity(dark ? 0.55 : 0.26), size: 420, x: 0.85, y: 0.25, dx: -50, dy: 60),
            .init(color: Color(red: 0.839, green: 0.200, blue: 1.000).opacity(dark ? 0.50 : 0.24), size: 360, x: 0.30, y: 0.55, dx: 70, dy: -40),
            .init(color: Color(red: 1.000, green: 0.180, blue: 0.525).opacity(dark ? 0.55 : 0.26), size: 400, x: 0.80, y: 0.80, dx: -60, dy: -50),
            .init(color: Color(red: 1.000, green: 0.431, blue: 0.314).opacity(dark ? 0.45 : 0.22), size: 340, x: 0.20, y: 0.95, dx: 50, dy: -60),
        ]
        GeometryReader { geo in
            ZStack {
                pal.bg0
                // --aurora-base: indigo wash from the top, pink wash from the bottom
                RadialGradient(colors: [Color(red: 0.388, green: 0.400, blue: 0.945).opacity(dark ? 0.22 : 0.10), .clear],
                               center: .init(x: 0.5, y: -0.1), startRadius: 0, endRadius: geo.size.height * 0.8)
                RadialGradient(colors: [Color(red: 0.925, green: 0.282, blue: 0.600).opacity(dark ? 0.28 : 0.12), .clear],
                               center: .init(x: 0.5, y: 1.15), startRadius: 0, endRadius: geo.size.height * 0.9)
                ForEach(Array(blobs.enumerated()), id: \.offset) { _, b in
                    Circle()
                        .fill(b.color)
                        .frame(width: b.size, height: b.size)
                        .position(x: geo.size.width * b.x + (drift ? b.dx : -b.dx),
                                  y: geo.size.height * b.y + (drift ? b.dy : -b.dy))
                        .blur(radius: 70)
                }
            }
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 26).repeatForever(autoreverses: true)) { drift = true }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

// MARK: - Markdown-lite renderer (headers / lists / code / tables / inline)

@available(iOS 17.0, *)
struct AgentMarkdownText: View {
    let text: String
    let pal: AgentPalette

    private enum Segment: Identifiable {
        case paragraph(String)
        case code(lang: String, body: String)
        case table(String)
        var id: String {
            switch self {
            case .paragraph(let s): return "p\(s.hashValue)"
            case .code(let l, let b): return "c\(l.hashValue)\(b.hashValue)"
            case .table(let s): return "t\(s.hashValue)"
            }
        }
    }

    private var segments: [Segment] {
        var out: [Segment] = []
        let parts = text.components(separatedBy: "```")
        for (i, part) in parts.enumerated() {
            if i % 2 == 1 {
                // fenced block: first line = language tag
                var lines = part.components(separatedBy: "\n")
                let lang = lines.first?.trimmingCharacters(in: .whitespaces) ?? ""
                if !lines.isEmpty { lines.removeFirst() }
                out.append(.code(lang: lang, body: lines.joined(separator: "\n").trimmingCharacters(in: .newlines)))
            } else {
                // plain text — pull out contiguous table blocks
                var buf: [String] = []
                var tbl: [String] = []
                func flushBuf() { let s = buf.joined(separator: "\n"); if !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append(.paragraph(s)) }; buf = [] }
                func flushTbl() { if !tbl.isEmpty { out.append(.table(tbl.joined(separator: "\n"))); tbl = [] } }
                for line in part.components(separatedBy: "\n") {
                    if line.trimmingCharacters(in: .whitespaces).hasPrefix("|") { flushBuf(); tbl.append(line) }
                    else { flushTbl(); buf.append(line) }
                }
                flushBuf(); flushTbl()
            }
        }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(segments) { seg in
                switch seg {
                case .paragraph(let s): paragraph(s)
                case .code(let lang, let body): codeCard(lang: lang, body: body)
                case .table(let s): tableCard(s)
                }
            }
        }
    }

    @ViewBuilder private func paragraph(_ s: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(s.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty {
                    EmptyView()
                } else if trimmed.hasPrefix("###") || trimmed.hasPrefix("##") || trimmed.hasPrefix("# ") {
                    Text(trimmed.drop(while: { $0 == "#" || $0 == " " }))
                        .font(.system(size: trimmed.hasPrefix("# ") ? 18 : 16, weight: .semibold))
                        .foregroundStyle(AgentPalette.coral)
                        .padding(.top, 2)
                } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("• ") {
                    HStack(alignment: .top, spacing: 7) {
                        Text("•").foregroundStyle(pal.muted)
                        inline(String(trimmed.dropFirst(2)))
                    }
                } else {
                    inline(line)
                }
            }
        }
    }

    private func inline(_ s: String) -> Text {
        if let a = try? AttributedString(markdown: s,
                                         options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return Text(a)
                .font(.system(size: 15))
                .foregroundStyle(pal.ink)
        }
        return Text(s).font(.system(size: 15)).foregroundStyle(pal.ink)
    }

    /// Web parity: fenced ```copy/caption/post/text = the branded coral copy card;
    /// any other language = dark code card with a copy button.
    @ViewBuilder private func codeCard(lang: String, body: String) -> some View {
        let isCopyCard = ["copy", "caption", "post", "text", ""].contains(lang.lowercased())
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(isCopyCard ? "কপি করার জন্য" : lang.uppercased())
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(isCopyCard ? AgentPalette.coral : Color.white.opacity(0.55))
                Spacer()
                Button {
                    UIPasteboard.general.string = body
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                } label: {
                    Label("কপি করুন", systemImage: "doc.on.doc")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(isCopyCard ? AgentPalette.coral : Color.white.opacity(0.8))
                }
            }
            Text(body)
                .font(.system(size: 13, design: isCopyCard ? .default : .monospaced))
                .foregroundStyle(isCopyCard ? pal.ink : Color.white.opacity(0.92))
                .lineSpacing(3)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(isCopyCard ? AgentPalette.coral.opacity(0.06) : pal.codeBg,
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(isCopyCard ? AgentPalette.coral.opacity(0.25) : Color.white.opacity(0.08), lineWidth: 1))
    }

    @ViewBuilder private func tableCard(_ s: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(s)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(pal.ink)
                .padding(12)
        }
        .background(pal.card.opacity(0.75), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(pal.borderSubtle, lineWidth: 1))
    }
}

// MARK: - Message rows

@available(iOS 17.0, *)
struct AgentChatImage: View {
    let path: String
    let vm: AssistantVM
    @State private var url: URL?
    @State private var failed = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let pal = AgentPalette(scheme)
        Group {
            if failed {
                VStack(spacing: 3) {
                    Image(systemName: "photo").font(.system(size: 16))
                    Text("ছবি নেই").font(.system(size: 9))
                }
                .foregroundStyle(pal.muted)
                .frame(width: 80, height: 80)
                .background(pal.card.opacity(0.4), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else if let url {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let img):
                        img.resizable().scaledToFill()
                    case .failure:
                        Color.clear.onAppear { failed = true }
                    default:
                        shimmer
                    }
                }
                .frame(width: 80, height: 80)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                shimmer.task {
                    if let u = await vm.signedURL(for: path) { url = u } else { failed = true }
                }
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(pal.borderSubtle, lineWidth: 1))
    }

    private var shimmer: some View {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(Color.white.opacity(0.06))
            .frame(width: 80, height: 80)
            .redacted(reason: .placeholder)
    }
}

@available(iOS 17.0, *)
struct AgentMessageRow: View {
    let message: AgentChatMessage
    let vm: AssistantVM
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let pal = AgentPalette(scheme)
        if message.role == .user {
            VStack(alignment: .trailing, spacing: 6) {
                if !message.localImages.isEmpty || !message.imagePaths.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(Array(message.localImages.enumerated()), id: \.offset) { _, img in
                            Image(uiImage: img).resizable().scaledToFill()
                                .frame(width: 80, height: 80)
                                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }
                        ForEach(message.imagePaths, id: \.self) { p in
                            AgentChatImage(path: p, vm: vm)
                        }
                    }
                }
                if !message.text.isEmpty {
                    Text(message.text)
                        .font(.system(size: 15))
                        .lineSpacing(3.5)
                        .foregroundStyle(.white)
                        .textSelection(.enabled)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .background(
                            LinearGradient(colors: [AgentPalette.coral, AgentPalette.coralDim],
                                           startPoint: .topLeading, endPoint: .bottomTrailing),
                            in: UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20,
                                                       bottomTrailingRadius: 6, topTrailingRadius: 20,
                                                       style: .continuous))
                        .shadow(color: AgentPalette.coral.opacity(0.20), radius: 4, y: 1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 44)   // ~85% max width feel
            .padding(.bottom, 18)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                if let thinking = message.thinking, !thinking.isEmpty {
                    AgentThinkingDisclosure(trace: thinking, ms: message.thinkingMs, pal: pal)
                }
                if !message.tools.isEmpty {
                    AgentToolPill(tools: message.tools, pal: pal)
                }
                if !message.text.isEmpty {
                    AgentMarkdownText(text: message.text, pal: pal)
                }
                if message.isStreaming && message.text.isEmpty && message.tools.isEmpty {
                    EmptyView() // the global thinking row covers this state
                }
                ForEach(message.imagePaths, id: \.self) { p in
                    AgentChatImage(path: p, vm: vm)
                }
                ForEach(message.confirmCards) { card in
                    AgentConfirmCardView(card: card, pal: pal) { approve in
                        Task { await vm.approveAction(card.id, approve: approve) }
                    }
                }
                ForEach(message.askCards) { card in
                    AgentAskCardView(card: card, pal: pal) { option in
                        Task { await vm.answerAskCard(card.id, option: option) }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 26)
        }
    }
}

@available(iOS 17.0, *)
struct AgentThinkingDisclosure: View {
    let trace: String
    let ms: Int?
    let pal: AgentPalette
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "brain").font(.system(size: 11))
                    Text(ms.map { "ভেবেছে \(almaBn(max(1, $0 / 1000))) সেকেন্ড" } ?? "ভাবনা")
                        .font(.system(size: 11.5, weight: .medium))
                    Image(systemName: open ? "chevron.up" : "chevron.down").font(.system(size: 9))
                }
                .foregroundStyle(pal.muted)
            }
            if open {
                Text(trace)
                    .font(.system(size: 12))
                    .foregroundStyle(pal.muted)
                    .lineSpacing(2.5)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(pal.borderSubtle).frame(width: 2)
                    }
            }
        }
    }
}

@available(iOS 17.0, *)
struct AgentToolPill: View {
    let tools: [AgentChatMessage.Tool]
    let pal: AgentPalette
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } label: {
                HStack(spacing: 6) {
                    if tools.contains(where: { $0.live }) {
                        ProgressView().controlSize(.mini)
                    } else {
                        Text("🔧").font(.system(size: 11))
                    }
                    Text("\(almaBn(tools.count))টি টুল")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(pal.muted)
                    Image(systemName: open ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8.5)).foregroundStyle(pal.muted)
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(pal.card.opacity(0.6), in: Capsule())
                .overlay(Capsule().strokeBorder(pal.borderSubtle, lineWidth: 1))
            }
            if open {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(tools) { t in
                        HStack(alignment: .top, spacing: 6) {
                            if t.live {
                                Image(systemName: "sparkle").font(.system(size: 10)).foregroundStyle(AgentPalette.coral)
                            } else if t.ok == false {
                                Image(systemName: "xmark").font(.system(size: 10)).foregroundStyle(.red)
                            } else {
                                Image(systemName: "checkmark").font(.system(size: 10)).foregroundStyle(AgentPalette.teal)
                            }
                            VStack(alignment: .leading, spacing: 1) {
                                Text(t.name).font(.system(size: 12, weight: .medium)).foregroundStyle(pal.ink)
                                if let p = t.preview, !p.isEmpty {
                                    Text(p).font(.system(size: 11)).foregroundStyle(pal.muted).lineLimit(2)
                                }
                            }
                        }
                    }
                }
                .padding(.leading, 6)
            }
        }
    }
}

@available(iOS 17.0, *)
struct AgentConfirmCardView: View {
    let card: AgentChatMessage.ConfirmCard
    let pal: AgentPalette
    let onDecide: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.shield").font(.system(size: 12)).foregroundStyle(AgentPalette.coral)
                Text("অনুমোদন দরকার")
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(AgentPalette.coral)
                Spacer()
                if let c = card.costEstimate, c > 0 {
                    Text(String(format: "~$%.2f", c)).font(.system(size: 10.5)).foregroundStyle(pal.muted)
                }
            }
            Text(card.summary)
                .font(.system(size: 13.5)).foregroundStyle(pal.ink).lineSpacing(2.5)
            if card.status == "pending" {
                HStack(spacing: 8) {
                    Button { onDecide(true) } label: {
                        Text("অনুমোদন")
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                            .padding(.horizontal, 16).padding(.vertical, 8)
                            .background(AgentPalette.coral, in: Capsule())
                    }
                    Button { onDecide(false) } label: {
                        Text("বাতিল")
                            .font(.system(size: 13, weight: .medium)).foregroundStyle(pal.muted)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(pal.card.opacity(0.6), in: Capsule())
                            .overlay(Capsule().strokeBorder(pal.borderSubtle, lineWidth: 1))
                    }
                }
            } else {
                HStack(spacing: 5) {
                    Image(systemName: statusIcon).font(.system(size: 11))
                    Text(statusLabel).font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(statusColor)
            }
        }
        .padding(13)
        .background(AgentPalette.coral.opacity(0.06), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(AgentPalette.coral.opacity(0.25), lineWidth: 1))
    }

    private var statusIcon: String {
        switch card.status {
        case "approved", "executed": return "checkmark.circle.fill"
        case "failed": return "exclamationmark.triangle.fill"
        case "expired": return "clock.badge.xmark"
        default: return "xmark.circle.fill"
        }
    }
    private var statusLabel: String {
        switch card.status {
        case "approved": return "অনুমোদিত"
        case "executed": return "সম্পন্ন হয়েছে"
        case "failed": return "ব্যর্থ হয়েছে"
        case "expired": return "মেয়াদ শেষ"
        default: return "বাতিল করা হয়েছে"
        }
    }
    private var statusColor: Color {
        switch card.status {
        case "approved", "executed": return AgentPalette.teal
        case "failed": return .red
        default: return pal.muted
        }
    }
}

@available(iOS 17.0, *)
struct AgentAskCardView: View {
    let card: AgentChatMessage.AskCard
    let pal: AgentPalette
    let onAnswer: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.bubble").font(.system(size: 12)).foregroundStyle(AgentPalette.coral)
                Text("আপনার সিদ্ধান্ত").font(.system(size: 11, weight: .semibold)).foregroundStyle(AgentPalette.coral)
            }
            Text(card.question).font(.system(size: 13.5)).foregroundStyle(pal.ink).lineSpacing(2.5)
            if card.status == "pending" {
                FlowishOptions(options: card.options, pal: pal, onAnswer: onAnswer)
            } else if let sel = card.selectedOption {
                HStack(spacing: 5) {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 11))
                    Text(sel).font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(AgentPalette.teal)
            }
        }
        .padding(13)
        .background(AgentPalette.coral.opacity(0.06), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(AgentPalette.coral.opacity(0.25), lineWidth: 1))
    }

    private struct FlowishOptions: View {
        let options: [String]
        let pal: AgentPalette
        let onAnswer: (String) -> Void
        var body: some View {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(options, id: \.self) { opt in
                    Button { onAnswer(opt) } label: {
                        Text(opt)
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(pal.ink)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(pal.card.opacity(0.65), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous)
                                .strokeBorder(pal.borderSubtle, lineWidth: 1))
                    }
                }
            }
        }
    }
}

/// The live "কাজ করছি…" row — spinner + shimmer, web AgentThinkingIndicator parity.
@available(iOS 17.0, *)
struct AgentThinkingRow: View {
    let pal: AgentPalette
    @State private var spin = false
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkle")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(AgentPalette.coral)
                .rotationEffect(.degrees(spin ? 360 : 0))
                .scaleEffect(pulse ? 1.15 : 0.85)
            Text("কাজ করছি…")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(pal.muted)
                .opacity(pulse ? 1 : 0.55)
        }
        .padding(.bottom, 22)
        .onAppear {
            withAnimation(.linear(duration: 2.4).repeatForever(autoreverses: false)) { spin = true }
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { pulse = true }
        }
    }
}

// MARK: - Composer (web AgentComposer parity)

@available(iOS 17.0, *)
struct AgentComposerView: View {
    @Bindable var vm: AssistantVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var draft = ""
    @State private var photoItem: PhotosPickerItem?
    @FocusState private var focused: Bool

    var body: some View {
        let pal = AgentPalette(scheme)
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                if !vm.pendingFiles.isEmpty { attachmentsRow(pal) }
                TextField(vm.isRecording ? "শুনছি…" : (vm.transcribing ? "বুঝে নিচ্ছি…" : "বার্তা লিখুন…"),
                          text: $draft, axis: .vertical)
                    .font(.system(size: 16))
                    .foregroundStyle(pal.ink)
                    .lineLimit(1...5)
                    .focused($focused)
                    .padding(.horizontal, 10)
                    .padding(.top, 8)
                controlsRow(pal)
            }
            .padding(8)
            .background(pal.glassFill)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(pal.borderSubtle, lineWidth: 1))
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
        }
        .onChange(of: vm.dictatedText) { _, newValue in
            guard !newValue.isEmpty else { return }
            draft = draft.isEmpty ? newValue : draft + " " + newValue
            vm.dictatedText = ""
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self),
                   let img = UIImage(data: data) {
                    vm.attachImage(img)
                }
                photoItem = nil
            }
        }
    }

    @ViewBuilder private func attachmentsRow(_ pal: AgentPalette) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(vm.pendingFiles) { f in
                    ZStack(alignment: .topTrailing) {
                        Image(uiImage: f.image)
                            .resizable().scaledToFill()
                            .frame(width: 64, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay {
                                if f.state == .uploading {
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .fill(Color.black.opacity(0.45))
                                    ProgressView().tint(.white)
                                } else if f.state == .failed {
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .fill(Color.red.opacity(0.4))
                                    Image(systemName: "exclamationmark.triangle").foregroundStyle(.white)
                                }
                            }
                        Button { vm.removePendingFile(f.id) } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 18, height: 18)
                                .background(Color.black.opacity(0.65), in: Circle())
                        }
                        .offset(x: 5, y: -5)
                    }
                }
            }
            .padding(.horizontal, 6).padding(.top, 6)
        }
        .frame(height: 72)
    }

    @ViewBuilder private func controlsRow(_ pal: AgentPalette) -> some View {
        HStack(spacing: 4) {
            PhotosPicker(selection: $photoItem, matching: .images) {
                Image(systemName: "plus")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(pal.muted)
                    .frame(width: 36, height: 36)
            }
            if let label = vm.modelLabel {
                Text(label)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(pal.muted)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(pal.card.opacity(0.5), in: Capsule())
                    .overlay(Capsule().strokeBorder(pal.borderSubtle, lineWidth: 1))
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            // mic → Whisper dictation
            Button { vm.toggleRecording() } label: {
                Group {
                    if vm.transcribing {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: vm.isRecording ? "stop.fill" : "mic")
                            .font(.system(size: 15, weight: .medium))
                    }
                }
                .foregroundStyle(vm.isRecording ? .white : pal.muted)
                .frame(width: 36, height: 36)
                .background(vm.isRecording ? AnyShapeStyle(AgentPalette.coral) : AnyShapeStyle(.clear), in: Circle())
            }
            // voice-to-voice — stays web (escape hatch, same as old segmented tab)
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                openWeb("/agent", "ভয়েস টু ভয়েস")
            } label: {
                Image(systemName: "waveform")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(AgentPalette.teal)
                    .frame(width: 36, height: 36)
            }
            // send / stop
            Button {
                if vm.isStreaming { vm.stopStreaming() } else {
                    send()
                }
            } label: {
                Image(systemName: vm.isStreaming ? "stop.fill" : "arrow.up")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(sendEnabled || vm.isStreaming ? .white : pal.muted)
                    .frame(width: 36, height: 36)
                    .background(sendEnabled || vm.isStreaming
                                ? AnyShapeStyle(AgentPalette.coral)
                                : AnyShapeStyle(pal.card.opacity(0.5)),
                                in: Circle())
                    .shadow(color: sendEnabled ? AgentPalette.coral.opacity(0.35) : .clear, radius: 5, y: 2)
            }
            .disabled(!sendEnabled && !vm.isStreaming)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: vm.isStreaming)
        }
    }

    private var sendEnabled: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || vm.pendingFiles.contains { if case .ready = $0.state { return true } else { return false } }
    }

    private func send() {
        let text = draft
        draft = ""
        vm.send(text)
    }
}

// MARK: - Sidebar (conversation list + web escape hatches)

@available(iOS 17.0, *)
struct AgentSidebarSheet: View {
    @Bindable var vm: AssistantVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var deleteTarget: AgentConversation?

    var body: some View {
        let pal = AgentPalette(scheme)
        NavigationStack {
            List {
                Section {
                    Button {
                        Task { await vm.newChat() }
                        dismiss()
                    } label: {
                        Label("নতুন কথোপকথন", systemImage: "plus.circle.fill")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(AgentPalette.coral)
                    }
                }
                Section("চ্যাট") {
                    if vm.conversations.isEmpty {
                        Text("কোনো কথোপকথন নেই")
                            .font(.system(size: 13)).foregroundStyle(pal.muted)
                    }
                    ForEach(vm.conversations) { c in
                        Button {
                            Task { await vm.openConversation(c.id) }
                            dismiss()
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(c.title?.isEmpty == false ? c.title! : "নতুন কথোপকথন")
                                        .font(.system(size: 14, weight: c.id == vm.conversationId ? .semibold : .regular))
                                        .foregroundStyle(pal.ink)
                                        .lineLimit(1)
                                    if let rel = relativeTime(c.updatedAt) {
                                        Text(rel).font(.system(size: 11)).foregroundStyle(pal.muted)
                                    }
                                }
                                Spacer()
                                if c.id == vm.conversationId {
                                    Circle().fill(AgentPalette.coral).frame(width: 7, height: 7)
                                }
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { deleteTarget = c } label: {
                                Label("মুছুন", systemImage: "trash")
                            }
                        }
                    }
                }
                Section("অন্যান্য") {
                    escapeRow("paintpalette", "Creative Studio", "/agent/creative-studio")
                    escapeRow("bubble.left.and.bubble.right", "WhatsApp", "/agent/whatsapp")
                    escapeRow("eye", "Monitor", "/agent/staff-monitor")
                    escapeRow("dollarsign.circle", "Costs", "/agent/costs")
                }
            }
            .navigationTitle("ALMA Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("বন্ধ") { dismiss() }.font(.system(size: 14, weight: .medium))
                }
            }
        }
        .task { await vm.loadConversations() }
        .alert("কথোপকথনটি মুছবেন?", isPresented: .init(
            get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } })) {
            Button("মুছুন", role: .destructive) {
                if let t = deleteTarget { Task { await vm.deleteConversation(t.id) } }
                deleteTarget = nil
            }
            Button("থাক", role: .cancel) { deleteTarget = nil }
        } message: {
            Text("সব মেসেজ স্থায়ীভাবে মুছে যাবে।")
        }
    }

    @ViewBuilder private func escapeRow(_ icon: String, _ title: String, _ path: String) -> some View {
        Button {
            dismiss()
            openWeb(path, title)
        } label: {
            Label(title, systemImage: icon).font(.system(size: 14))
        }
    }

    private func relativeTime(_ iso: String?) -> String? {
        guard let iso else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = f.date(from: iso) ?? {
            f.formatOptions = [.withInternetDateTime]
            return f.date(from: iso)
        }()
        guard let date else { return nil }
        let mins = max(0, Int(-date.timeIntervalSinceNow / 60))
        if mins < 1 { return "এইমাত্র" }
        if mins < 60 { return "\(almaBn(mins)) মিনিট আগে" }
        let hours = mins / 60
        if hours < 24 { return "\(almaBn(hours)) ঘণ্টা আগে" }
        return "\(almaBn(hours / 24)) দিন আগে"
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct AssistantScreen: View {
    @State private var vm = AssistantVM()
    @Environment(\.colorScheme) private var scheme
    @State private var nearBottom = true

    let openWeb: (_ path: String, _ title: String) -> Void
    /// Wired by makeAssistantTab so the native bar buttons drive this screen.
    let barHooks: AssistantBarHooks

    private static let bottomID = "ALMA_BOTTOM"

    var body: some View {
        let pal = AgentPalette(scheme)
        ZStack {
            AgentAuroraBackground()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if vm.loadingHistory && vm.messages.isEmpty {
                            ProgressView().frame(maxWidth: .infinity).padding(.top, 80)
                        }
                        if !vm.loadingHistory && vm.messages.isEmpty && !vm.isStreaming {
                            emptyState(pal)
                        }
                        ForEach(vm.messages) { msg in
                            AgentMessageRow(message: msg, vm: vm)
                        }
                        if vm.thinkingLive {
                            AgentThinkingRow(pal: pal)
                        }
                        Color.clear.frame(height: 4).id(Self.bottomID)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
                    .background(scrollOffsetReader)
                }
                .coordinateSpace(name: "agentscroll")
                .onPreferenceChange(AgentScrollBottomKey.self) { distance in
                    nearBottom = distance < 160
                }
                .onChange(of: vm.messages.last?.text) { _, _ in
                    if nearBottom { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                }
                .onChange(of: vm.messages.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                }
                .overlay(alignment: .bottomTrailing) {
                    if !nearBottom {
                        Button {
                            withAnimation { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                        } label: {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(pal.ink)
                                .frame(width: 34, height: 34)
                                .background(.ultraThinMaterial, in: Circle())
                                .overlay(Circle().strokeBorder(pal.borderSubtle, lineWidth: 1))
                        }
                        .padding(.trailing, 14)
                        .padding(.bottom, 8)
                    }
                }
            }
        }
        .claudeTopFade()
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            AgentComposerView(vm: vm, openWeb: openWeb)
        }
        .task {
            barHooks.onMenu = { vm.showSidebar = true }
            barHooks.onNewChat = { Task { await vm.newChat() } }
            // DEBUG self-test hooks (never fire in production — the env vars are only
            // set by the local `simctl launch` self-test, same pattern as
            // ALMA_OPEN_COMPANION / ALMA_FADE_DEMO):
            let env = ProcessInfo.processInfo.environment
            if env["ALMA_ASSISTANT_SIDEBAR"] == "1" {
                Task { try? await Task.sleep(nanoseconds: 1_500_000_000); vm.showSidebar = true }
            }
            if let say = env["ALMA_ASSISTANT_SAY"], !say.isEmpty {
                Task { try? await Task.sleep(nanoseconds: 4_000_000_000); vm.send(say) }
            }
            await vm.bootstrap()
        }
        .sheet(isPresented: $vm.showSidebar) {
            AgentSidebarSheet(vm: vm, openWeb: openWeb)
                .presentationDetents([.large, .medium])
                .presentationDragIndicator(.visible)
        }
        .overlay(alignment: .top) {
            if vm.authExpired { authBanner(pal) }
        }
        .overlay(alignment: .bottom) {
            if let toast = vm.errorToast { toastView(toast, pal) }
        }
    }

    private var scrollOffsetReader: some View {
        GeometryReader { g in
            Color.clear.preference(
                key: AgentScrollBottomKey.self,
                value: g.frame(in: .named("agentscroll")).maxY - UIScreen.main.bounds.height)
        }
    }

    @ViewBuilder private func emptyState(_ pal: AgentPalette) -> some View {
        VStack(spacing: 10) {
            Text("✨")
                .font(.system(size: 40))
            Text("আসসালামু আলাইকুম, বস")
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(pal.ink)
            Text("কী করতে পারি বলুন — ব্যবসা, রিপোর্ট, মার্কেটিং, যা দরকার।")
                .font(.system(size: 13.5))
                .foregroundStyle(pal.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 110)
        .padding(.horizontal, 24)
    }

    @ViewBuilder private func authBanner(_ pal: AgentPalette) -> some View {
        Button {
            openWeb("/login", "লগইন")
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "person.crop.circle.badge.exclamationmark").font(.system(size: 13))
                Text("লগইন দরকার — এখানে চাপুন").font(.system(size: 13, weight: .semibold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(AgentPalette.coral, in: Capsule())
        }
        .padding(.top, 6)
    }

    @ViewBuilder private func toastView(_ text: String, _ pal: AgentPalette) -> some View {
        Text(text)
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(pal.ink)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(AgentPalette.coral.opacity(0.5), lineWidth: 1))
            .padding(.bottom, 92)
            .onAppear {
                DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                    if vm.errorToast == text { vm.errorToast = nil }
                }
            }
            .onTapGesture { vm.errorToast = nil }
    }
}

struct AgentScrollBottomKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// Bridges the UIKit nav-bar buttons (glass hamburger / coral compose — the exact
/// Claude-style buttons the web Assistant tab already had) into the SwiftUI screen.
final class AssistantBarHooks: NSObject {
    var onMenu: (() -> Void)?
    var onNewChat: (() -> Void)?
    @objc func menuTapped() {
        UISelectionFeedbackGenerator().selectionChanged()
        onMenu?()
    }
    @objc func newChatTapped() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        onNewChat?()
    }
}

// MARK: - Tab builder (S6b wiring — mirrors SwiftUIShell's makeOrdersTab pattern)

private var assistantBarHooksKey: UInt8 = 0

extension AlmaTabBarController {

    /// Assistant tab: native SwiftUI chat when the S6 flag is on (iOS 17+), else the
    /// pre-S6b web construction (segmented Chat/Studio/WhatsApp/Monitor/Costs), verbatim.
    func makeAssistantTab() -> UINavigationController {
        // DEBUG self-test hook (never fires in production): ALMA_OPEN_ASSISTANT=1
        // (set only by the local `simctl launch` self-test) jumps straight to this
        // tab so either variant can be screenshotted headlessly — same pattern as
        // ALMA_OPEN_COMPANION in SpikeNativeShell.
        if ProcessInfo.processInfo.environment["ALMA_OPEN_ASSISTANT"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                self?.selectedIndex = 2
            }
        }
        if AlmaSwiftUIFlag.isActive, #available(iOS 17.0, *) {
            let navRef = WeakRef<UINavigationController>()
            let pool = contentPool
            let hooks = AssistantBarHooks()
            let screen = AssistantScreen(
                openWeb: { [weak self] path, title in
                    guard let self else { return }
                    let vc = AlmaWebTabViewController(url: URL(string: Self.base + path)!,
                                                      processPool: pool,
                                                      tabTitle: title, systemImage: "sparkles",
                                                      hideWebHeader: true)
                    vc.hidesBottomBarWhenPushed = false
                    navRef.value?.pushViewController(vc, animated: true)
                    _ = self // keep the capture list shape consistent with SwiftUIShell
                },
                barHooks: hooks)
            let host = AlmaHostingController(rootView: screen)
            host.title = "ALMA AI"
            // The exact Claude bar the web Assistant had: glass hamburger + coral compose.
            host.navigationItem.leftBarButtonItem = AlmaWebTabViewController.glassBarButton(
                icon: "line.3.horizontal", target: hooks, action: #selector(AssistantBarHooks.menuTapped),
                light: !AlmaTheme.isDark)
            host.navigationItem.rightBarButtonItem = AlmaWebTabViewController.coralBarButton(
                icon: "plus", target: hooks, action: #selector(AssistantBarHooks.newChatTapped))
            objc_setAssociatedObject(host, &assistantBarHooksKey, hooks, .OBJC_ASSOCIATION_RETAIN)
            let nav = Self.darkNav(root: host, tabTitle: "Assistant", icon: "sparkles", largeTitles: false)
            navRef.value = nav
            return nav
        }

        // Web fallback — the pre-S6b Assistant tab, unchanged.
        func agentURL(_ p: String) -> URL { URL(string: Self.base + p)! }
        let assistant = AlmaWebTabViewController(
            url: agentURL("/agent"), processPool: contentPool,
            tabTitle: "Assistant", systemImage: "sparkles",
            hideWebHeader: true,
            agentSegments: [
                ("Chat", agentURL("/agent")),
                ("Studio", agentURL("/agent/creative-studio")),
                ("WhatsApp", agentURL("/agent/whatsapp")),
                ("Monitor", agentURL("/agent/staff-monitor")),
                ("Costs", agentURL("/agent/costs")),
            ])
        return Self.darkNav(root: assistant, tabTitle: "Assistant", icon: "sparkles", largeTitles: false)
    }
}
