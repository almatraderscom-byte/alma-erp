//
//  AssistantTransport.swift
//  ALMA ERP — assistant protocol + transport layer (roadmap Phase 2.5 split).
//
//  First extraction from the AssistantSwiftUI.swift monolith: everything between
//  the wire and the reducer — turn diagnostics/signposts, transport error
//  classification, the SSE wire DTO + typed AgentTurnEvent contract, the
//  spec-shaped SSE parser, the delta-coalescing event buffer, and the streaming
//  URLSession layer. No UI code lives here. AssistantSwiftUI.swift keeps the
//  view model + views until the next extraction PR (each must compile alone).
//

import Foundation
import UIKit
import os.signpost

// MARK: - Turn diagnostics + transport classification (roadmap Phase 0 / 1.1)

/// os_signpost timeline for the agent turn lifecycle (Instruments/log-visible).
/// Carries lifecycle timing only — never prompt, reply or tool contents.
enum AlmaTurnLog {
    static let log = OSLog(subsystem: "com.almatraders.erp.agent", category: "AgentTurn")
    static func event(_ name: StaticString, _ info: String = "") {
        os_signpost(.event, log: log, name: name, "%{public}s", info)
    }
}

/// Typed classification of a thrown stream/request error (roadmap Phase 1.1).
/// A backgrounded/suspended SSE socket is an EXPECTED interruption while the
/// server deliberately keeps the turn alive — it must never surface as a raw
/// English failure toast. Only real terminal conditions may show an error.
enum TurnFailureKind {
    case transportInterrupted   // socket dropped/suspended/timed out — turn may still run
    case offline                // no network path at all — turn may STILL be running server-side
    case authentication
    case server(status: Int)
    case terminalAgentError     // the server itself reported the turn failed

    static func classify(_ error: Error) -> TurnFailureKind {
        if let api = error as? AlmaAPIError {
            switch api {
            case .notAuthenticated: return .authentication
            case .http(let status, _): return .server(status: status)
            case .decoding: return .transportInterrupted
            case .transport(let inner): return classify(inner)
            }
        }
        if let url = error as? URLError {
            switch url.code {
            case .notConnectedToInternet, .dataNotAllowed: return .offline
            default: return .transportInterrupted   // connectionLost/cancelled/timedOut/suspension…
            }
        }
        return .transportInterrupted
    }

    /// Owner-facing Bangla copy for REAL failures (transport interruptions never toast).
    var banglaMessage: String {
        switch self {
        case .transportInterrupted: return "সংযোগে সমস্যা হয়েছে — আবার চেষ্টা করুন"
        case .offline: return "ইন্টারনেট নেই — সংযোগ ফিরলে আবার চেষ্টা করুন"
        case .authentication: return "লগইন লাগবে — আবার সাইন ইন করুন"
        case .server(let s): return "সার্ভার সমস্যা (\(s)) — একটু পরে চেষ্টা করুন"
        case .terminalAgentError: return "সমস্যা হয়েছে — আবার চেষ্টা করুন"
        }
    }
}

struct TurnEnqueueResponse: Decodable { let turnId: String; let conversationId: String? }
struct TurnStatusResponse: Decodable {
    let status: String?
    let turnId: String?
    let startedAt: String?
    /// Terminal turn ended continuation-eligible — the ONLY signal left when both
    /// the direct SSE and the durable tail are gone and polling finds the terminal.
    let continuationNeeded: Bool?
}

struct AgentSSEEvent: Decodable {
    let type: String
    let id: String?
    let delta: String?
    let label: String?
    let name: String?
    let success: Bool?
    let resultPreview: String?
    let input: AgentJSONValue?
    let pendingActionId: String?
    let summary: String?
    let actionType: String?
    let costEstimate: Double?
    let askCardId: String?
    let question: String?
    let options: [String]?
    let message: String?
    let error: String?
    let title: String?          // artifact_saved
    let artifactType: String?   // artifact_saved
    // Phase 2 (roadmap 2.1) — full wire parity; every field the server emits:
    let active: Bool?           // personal_mode
    let screenshot: String?     // tool_end (browser tools)
    let role: String?           // subagent_start/end
    let roleLabel: String?      // subagent_start
    let task: String?           // subagent_start
    let toolsUsed: [String]?    // subagent_end
    let attempt: Int?           // verification_retry
    let maxAttempts: Int?       // verification_retry
    let toLabel: String?        // model_switch_required
    let fromLabel: String?      // model_switch_required
    let fallbackModelId: String?// model_switch_required
    let messageId: String?      // done
    let tokensIn: Int?          // done
    let tokensOut: Int?         // done
    let cacheCreation: Int?     // done
    let cacheRead: Int?         // done
    let costUsd: Double?        // done
    let needContinue: Bool?     // done — serverless deadline hit mid-task
    let apiRounds: Int?         // done
    let roundCostsUsd: [Double]?// done
    let conversationId: String? // conversation_compacted + turn_snapshot
    let status: String?         // turn_snapshot
    let lastSeq: Int?           // turn_snapshot
    let assistantMessageId: String? // turn_snapshot
    let afterSeq: Int?          // replay_continue
    let turnId: String?         // turn_snapshot
}

/// Roadmap 2.1 — the typed native event contract. Mirrors `src/agent/lib/core.ts`
/// `AgentEvent` plus the route-level envelope events. `.unknown` keeps protocol
/// drift OBSERVABLE (telemetry) instead of silently dropped rows.
enum AgentTurnEvent: Sendable {
    case conversationId(String)
    case turnId(String)
    case personalMode(Bool)
    case modelInfo(label: String)
    case modelSwitchRequired(toLabel: String, fromLabel: String, fallbackModelId: String?)
    case thinkingDelta(String)
    case textDelta(String)
    case toolStart(id: String, name: String, inputPretty: String?)
    case toolEnd(id: String, ok: Bool, resultPreview: String?, screenshot: String?)
    case subagentStart(id: String, role: String, roleLabel: String, task: String?)
    case subagentEnd(id: String, ok: Bool, summary: String?, toolsUsed: [String]?)
    case artifactSaved(id: String, title: String)
    case confirmCard(pendingActionId: String, summary: String, actionType: String?, costEstimate: Double?)
    case askCard(id: String, question: String, options: [String])
    case verificationRetry(attempt: Int, maxAttempts: Int)
    case conversationCompacted(newConversationId: String)
    case done(messageId: String?, tokensIn: Int?, tokensOut: Int?, costUsd: Double?,
              needContinue: Bool, apiRounds: Int?, cacheCreation: Int?, cacheRead: Int?,
              roundCostsUsd: [Double]?)
    case turnError(message: String)
    /// Durable-stream hello (roadmap 3.5/PR 5): current turn state on (re)connect.
    case turnSnapshot(turnId: String?, conversationId: String?, status: String?, lastSeq: Int?)
    /// Page-capped replay ended early — reconnect from this cursor.
    case replayContinue(afterSeq: Int)
    case unknown(type: String)

    /// True for events that must flush buffered deltas FIRST (exact chronology).
    var isControl: Bool {
        switch self {
        case .textDelta, .thinkingDelta: return false
        default: return true
        }
    }

    init(dto ev: AgentSSEEvent) {
        switch ev.type {
        case "conversation_id":
            self = ev.id.map(AgentTurnEvent.conversationId) ?? .unknown(type: "conversation_id/noid")
        case "turn_id":
            self = ev.id.map(AgentTurnEvent.turnId) ?? .unknown(type: "turn_id/noid")
        case "personal_mode":
            self = .personalMode(ev.active == true)
        case "model_info":
            self = .modelInfo(label: ev.label ?? "")
        case "model_switch_required":
            self = .modelSwitchRequired(toLabel: ev.toLabel ?? "প্রিমিয়াম মডেল", fromLabel: ev.fromLabel ?? "",
                                        fallbackModelId: ev.fallbackModelId)
        case "thinking_delta":
            self = .thinkingDelta(ev.delta ?? "")
        case "text_delta":
            self = .textDelta(ev.delta ?? "")
        case "tool_start":
            self = .toolStart(id: ev.id ?? UUID().uuidString, name: ev.name ?? "টুল",
                              inputPretty: ev.input?.pretty())
        case "tool_end":
            self = .toolEnd(id: ev.id ?? "", ok: ev.success ?? true,
                            resultPreview: ev.resultPreview, screenshot: ev.screenshot)
        case "subagent_start":
            self = .subagentStart(id: ev.id ?? UUID().uuidString,
                                  role: ev.role ?? "",
                                  roleLabel: ev.roleLabel ?? ev.role ?? "সহকারী",
                                  task: ev.task)
        case "subagent_end":
            self = .subagentEnd(id: ev.id ?? "", ok: ev.success ?? true, summary: ev.summary,
                                toolsUsed: ev.toolsUsed)
        case "artifact_saved":
            self = ev.id.map { .artifactSaved(id: $0, title: ev.title ?? "ডকুমেন্ট") }
                ?? .unknown(type: "artifact_saved/noid")
        case "confirm_card":
            self = ev.pendingActionId.map {
                .confirmCard(pendingActionId: $0, summary: ev.summary ?? "",
                             actionType: ev.actionType, costEstimate: ev.costEstimate)
            } ?? .unknown(type: "confirm_card/noid")
        case "ask_card":
            self = ev.askCardId.map {
                .askCard(id: $0, question: ev.question ?? "", options: ev.options ?? [])
            } ?? .unknown(type: "ask_card/noid")
        case "verification_retry":
            self = .verificationRetry(attempt: ev.attempt ?? 1, maxAttempts: ev.maxAttempts ?? 1)
        case "conversation_compacted":
            self = ev.conversationId.map(AgentTurnEvent.conversationCompacted)
                ?? .unknown(type: "conversation_compacted/noid")
        case "done":
            self = .done(messageId: ev.messageId, tokensIn: ev.tokensIn, tokensOut: ev.tokensOut,
                         costUsd: ev.costUsd, needContinue: ev.needContinue == true, apiRounds: ev.apiRounds,
                         cacheCreation: ev.cacheCreation, cacheRead: ev.cacheRead,
                         roundCostsUsd: ev.roundCostsUsd)
        case "error":
            self = .turnError(message: ev.message ?? ev.error ?? "সমস্যা হয়েছে — আবার চেষ্টা করুন")
        case "turn_snapshot":
            self = .turnSnapshot(turnId: ev.turnId, conversationId: ev.conversationId,
                                 status: ev.status, lastSeq: ev.lastSeq)
        case "replay_continue":
            self = .replayContinue(afterSeq: ev.afterSeq ?? -1)
        default:
            self = .unknown(type: ev.type)
        }
    }
}

/// Roadmap 2.2 — spec-shaped SSE line parser. Handles `data:` with/without the
/// space, CRLF and LF, multi-line data joined with \n, `:` comment keepalives,
/// `id:`/`retry:`/`event:` fields, and a trailing event with no final blank line.
/// Pure + synchronous so it is testable without a network.
struct AlmaSSEParser {
    private var dataLines: [String] = []
    /// Last `id:` field seen — the durable stream stamps each frame with its seq,
    /// so this is the client's replay cursor (`?afterSeq=`) after a drop (PR 5).
    private(set) var lastEventId: String?

    /// Feed one line (no trailing \n). Returns a complete event payload when a
    /// blank line closes the pending event.
    mutating func consume(line rawLine: String) -> String? {
        var line = rawLine
        if line.hasSuffix("\r") { line.removeLast() }          // CRLF wire
        if line.isEmpty {
            guard !dataLines.isEmpty else { return nil }
            defer { dataLines = [] }
            return dataLines.joined(separator: "\n")
        }
        if line.hasPrefix(":") { return nil }                  // ": ping" keepalive
        guard let colon = line.firstIndex(of: ":") else {
            if line == "data" { dataLines.append("") }         // field, empty value
            return nil
        }
        let field = String(line[..<colon])
        var value = String(line[line.index(after: colon)...])
        if value.hasPrefix(" ") { value.removeFirst() }        // exactly one optional space
        if field == "data" { dataLines.append(value) }
        if field == "id" { lastEventId = value }
        return nil
    }

    /// Stream ended without a final blank line — emit what is pending.
    mutating func flushTrailing() -> String? {
        guard !dataLines.isEmpty else { return nil }
        defer { dataLines = [] }
        return dataLines.joined(separator: "\n")
    }
}

/// Roadmap 2.3 — event batching between the network task and MainActor. Adjacent
/// text/thinking deltas coalesce for ~40ms; control events flush the pending batch
/// FIRST so chronology stays exact. Up to 25 visual updates per second keeps the
/// reply visibly live while still avoiding one MainActor/layout pass per raw SSE
/// fragment. Tool/card/control events still land immediately.
actor AgentEventBuffer {
    private var batch: [AgentTurnEvent] = []
    private var flushScheduled = false
    private var flushCount = 0
    private let apply: @MainActor ([AgentTurnEvent]) -> Void

    init(apply: @escaping @MainActor ([AgentTurnEvent]) -> Void) {
        self.apply = apply
    }

    func push(_ ev: AgentTurnEvent) async {
        if ev.isControl {
            batch.append(ev)
            await flushNow()                       // deltas before it already queued in order
            return
        }
        switch (ev, batch.last) {
        case (.textDelta(let d), .textDelta(let prev)):
            batch[batch.count - 1] = .textDelta(prev + d)
        case (.thinkingDelta(let d), .thinkingDelta(let prev)):
            batch[batch.count - 1] = .thinkingDelta(prev + d)
        default:
            batch.append(ev)
        }
        scheduleFlush()
    }

    private func scheduleFlush() {
        guard !flushScheduled else { return }
        flushScheduled = true
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 40_000_000)     // 25 flushes/s ceiling
            await self?.flushNow()
        }
    }

    func flushNow() async {
        flushScheduled = false
        guard !batch.isEmpty else { return }
        let out = batch
        batch = []
        flushCount += 1
        if flushCount == 1 || flushCount % 25 == 0 {
            AlmaTurnLog.event("stream.bufferFlush", "n=\(flushCount) batch=\(out.count)")
        }
        await apply(out)
    }

    /// Stream closed — deliver whatever is left.
    func finish() async { await flushNow() }
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

    /// POST a small JSON body and return raw bytes (the TTS endpoint answers audio/mpeg).
    static func postJSONForData(path: String, body: [String: String]) async throws -> Data {
        await AlmaAPI.shared.syncCookies()
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await streamSession.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw AlmaAPIError.http(status: (resp as? HTTPURLResponse)?.statusCode ?? 0, body: "tts")
        }
        return data
    }

    /// Open an SSE stream and yield parsed events. Caller cancels via Task cancellation.
    /// Monotonic one-way flag, safely readable across tasks (first-event watchdog).
    final class EventFlag: @unchecked Sendable {
        private(set) var raised = false
        func raise() { raised = true }
    }

    /// The server answered a (retried) send with a JSON duplicate-turn snapshot
    /// instead of SSE (Phase 3 idempotency) — the caller attaches to the existing
    /// turn's durable stream instead of executing anything again.
    struct DuplicateTurn: Error, Decodable {
        let turnId: String
        let conversationId: String?
        let status: String?
        let lastSeq: Int?
    }

    /// Phase 2 (roadmap 2.2/2.3): bytes are split + parsed + JSON-decoded OFF the
    /// main actor, then batched through `AgentEventBuffer` — MainActor sees at most
    /// ~25 applies/second, not one per token. Malformed payloads are telemetry,
    /// never a stream kill; cancellation propagates as CancellationError.
    /// `onSeq` fires with each durable frame's `id:` seq (replay cursor, PR 5).
    static func streamEvents(request: URLRequest,
                             buffer: AgentEventBuffer,
                             firstEvent: EventFlag? = nil,
                             onSeq: (@Sendable (Int) -> Void)? = nil) async throws {
        let (bytes, resp) = try await streamSession.bytes(for: request)
        guard let http = resp as? HTTPURLResponse else { throw AlmaAPIError.transport(URLError(.badServerResponse)) }
        if http.statusCode == 401 || http.statusCode == 403 || (300..<400).contains(http.statusCode) {
            throw AlmaAPIError.notAuthenticated
        }
        // Idempotent duplicate: 202 + JSON body carrying the existing turn.
        if http.statusCode == 202,
           (http.value(forHTTPHeaderField: "Content-Type") ?? "").contains("application/json") {
            var body = Data()
            for try await byte in bytes { body.append(byte) }
            if let dup = try? JSONDecoder().decode(DuplicateTurn.self, from: body) { throw dup }
            throw AlmaAPIError.http(status: 202, body: "duplicate")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw AlmaAPIError.http(status: http.statusCode, body: "stream")
        }
        var parser = AlmaSSEParser()
        let decoder = JSONDecoder()

        func dispatch(_ payload: String) async {
            guard let d = payload.data(using: .utf8) else { return }
            guard let dto = try? decoder.decode(AgentSSEEvent.self, from: d) else {
                AlmaTurnLog.event("stream.malformedEvent", String(payload.prefix(80)))
                return                                   // one bad frame never kills the rest
            }
            firstEvent?.raise()
            let ev = AgentTurnEvent(dto: dto)
            if case .unknown(let t) = ev { AlmaTurnLog.event("stream.unknownEvent", t) }
            await buffer.push(ev)
        }

        var lineBuf: [UInt8] = []
        lineBuf.reserveCapacity(1024)
        for try await byte in bytes {
            if byte == 0x0A {                            // \n — CR handled by the parser
                let line = String(decoding: lineBuf, as: UTF8.self)
                lineBuf.removeAll(keepingCapacity: true)
                try Task.checkCancellation()
                if let payload = parser.consume(line: line) {
                    await dispatch(payload)
                    if let onSeq, let idStr = parser.lastEventId, let seq = Int(idStr) { onSeq(seq) }
                }
            } else {
                lineBuf.append(byte)
            }
        }
        // Trailing event without the final blank line (roadmap 2.2).
        if !lineBuf.isEmpty, let p = parser.consume(line: String(decoding: lineBuf, as: UTF8.self)) {
            await dispatch(p)
        }
        if let p = parser.flushTrailing() { await dispatch(p) }
        await buffer.finish()
    }

    /// DTO-callback variant on the SAME robust parser — the voice console needs
    /// per-event delivery (each text_delta feeds TTS immediately; batching would
    /// add spoken latency). Chat uses the buffered variant above.
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
        var parser = AlmaSSEParser()
        let decoder = JSONDecoder()
        func dispatch(_ payload: String) async {
            guard let d = payload.data(using: .utf8),
                  let ev = try? decoder.decode(AgentSSEEvent.self, from: d) else {
                AlmaTurnLog.event("stream.malformedEvent", String(payload.prefix(80)))
                return
            }
            await onEvent(ev)
        }
        var lineBuf: [UInt8] = []
        lineBuf.reserveCapacity(1024)
        for try await byte in bytes {
            if byte == 0x0A {
                let line = String(decoding: lineBuf, as: UTF8.self)
                lineBuf.removeAll(keepingCapacity: true)
                try Task.checkCancellation()
                if let payload = parser.consume(line: line) { await dispatch(payload) }
            } else {
                lineBuf.append(byte)
            }
        }
        if !lineBuf.isEmpty, let p = parser.consume(line: String(decoding: lineBuf, as: UTF8.self)) {
            await dispatch(p)
        }
        if let p = parser.flushTrailing() { await dispatch(p) }
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
