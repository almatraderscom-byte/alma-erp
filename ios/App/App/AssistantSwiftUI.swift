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
    /// slightly brighter muted — tool labels / secondary emphasis
    var mutedHi: Color { dark ? Color(red: 0.820, green: 0.835, blue: 0.878)   // #d1d5e0
                              : Color(red: 0.278, green: 0.333, blue: 0.412) } // #475569
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
    var projectId: String?
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

/// Arbitrary JSON (tool inputs vary per tool) — decoded losslessly for the I/O sheet.
enum AgentJSONValue: Decodable {
    case string(String), number(Double), bool(Bool)
    case object([String: AgentJSONValue]), array([AgentJSONValue]), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let o = try? c.decode([String: AgentJSONValue].self) { self = .object(o) }
        else if let a = try? c.decode([AgentJSONValue].self) { self = .array(a) }
        else { self = .null }
    }

    /// Pretty text for the tool I/O sheet (2-space indent, stable key order).
    func pretty(indent: Int = 0) -> String {
        let pad = String(repeating: "  ", count: indent)
        let padIn = String(repeating: "  ", count: indent + 1)
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let n):
            return n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .string(let s): return s.contains("\n") || indent == 0 ? s : "\"\(s)\""
        case .array(let a):
            if a.isEmpty { return "[]" }
            return "[\n" + a.map { padIn + $0.pretty(indent: indent + 1) }.joined(separator: ",\n") + "\n\(pad)]"
        case .object(let o):
            if o.isEmpty { return "{}" }
            return "{\n" + o.keys.sorted().map { "\(padIn)\($0): \(o[$0]!.pretty(indent: indent + 1))" }
                .joined(separator: ",\n") + "\n\(pad)}"
        }
    }
}

/// One entry of the persisted Claude-style activity timeline (`t: 'think' | 'tool' | 'file'`).
struct AgentTimelineEntryWire: Decodable {
    let t: String?
    let text: String?
    let id: String?
    let name: String?
    let ok: Bool?
    let live: Bool?
    let input: AgentJSONValue?
    let result: String?
    let kind: String?   // t=="file": document kind (markdown/html/…)
}

struct AgentMessageWire: Decodable {
    let id: String
    let role: String
    let content: [AgentContentBlock]?
    let thinking: String?
    let thinkingMs: Int?
    let toolCalls: [AgentToolCallWire]?
    let timeline: [AgentTimelineEntryWire]?
    let tokensIn: Int?
    let tokensOut: Int?
    let costUsd: AgentJSONValue?
    let createdAt: String?
}

// Sidebar data (web AgentSidebar parity)

struct AgentProject: Decodable, Identifiable, Equatable {
    let id: String
    var name: String
    var description: String?
    var systemInstructions: String?
    var businessId: String?
}

struct AgentConversationsPage: Decodable {
    let conversations: [AgentConversation]
    let nextCursor: String?
}

struct AgentMemoryRow: Decodable, Identifiable, Equatable {
    let id: String
    var scope: String
    var key: String?
    var content: String
    var pinned: Bool
    var createdAt: String?
}

struct AgentLearnedRule: Decodable, Identifiable, Equatable {
    let id: String
    var domain: String?
    var text: String
    var timesApplied: Int?
}
struct AgentLearnedRulesResponse: Decodable { let rules: [AgentLearnedRule]? }

struct AgentFinanceSummary: Decodable, Equatable {
    struct Balance: Decodable, Equatable { let person: String; let display: String? }
    struct Expense: Decodable, Equatable { let display: String?; let currency: String?; let category: String? }
    let balances: [Balance]?
    let monthExpensesByCategory: [Expense]?
}

struct AgentOpenTask: Decodable, Identifiable, Equatable {
    let id: String
    let kind: String            // chat_followup | approval_pending
    let title: String?
    let note: String?
    let ageMinutes: Int?
    let pendingActionId: String?
}
struct AgentOpenTasksResponse: Decodable { let tasks: [AgentOpenTask]? }
struct AgentOpenTaskActionResponse: Decodable { let ok: Bool?; let action: String?; let resumeNote: String?; let title: String? }

/// S8 additive — per-conversation artifacts (web AgentArtifactsPanel wire shape).
/// GET /api/assistant/conversations/[id]/artifacts returns a plain array.
private struct AgentArtifactWire: Decodable, Identifiable, Equatable {
    let id: String
    let messageId: String?
    let type: String?
    let title: String?
    let content: String?
    let version: Int?
    let createdAt: String?
}

/// S8 additive — Plan-Drive "Live Desk" (web PlanDriveTimeline wire shapes).
/// GET /api/assistant/plan-driver; everything optional — lenient decoding.
private struct AgentPlanDriveStep: Decodable, Identifiable, Equatable {
    let id: String
    let action: String?
    let status: String?      // pending | running | done | failed | skipped
    let toolName: String?
    let detail: String?
}

private struct AgentPlanDriveView: Decodable, Identifiable, Equatable {
    let planId: String
    let goal: String?
    let conversationId: String?
    let phase: String?        // driving | waiting-approval | needs-decision | done
    let steps: [AgentPlanDriveStep]?
    let doneCount: Int?
    let totalCount: Int?
    let currentLine: String?
    let waitingReason: String?
    let nextTickAt: String?
    let attemptCount: Int?
    let maxAttempts: Int?
    let costTaka: Double?
    var id: String { planId }
}

private struct AgentPlanDrivePanel: Decodable, Equatable {
    let enabled: Bool?
    let drives: [AgentPlanDriveView]?
}

// Model picker (web AgentModelSelector parity)
struct AgentModelInfo: Decodable, Identifiable, Equatable {
    let id: String
    let label: String
    let provider: String?
    let enabled: Bool?
    let isDefault: Bool?
    enum CodingKeys: String, CodingKey { case id, label, provider, enabled, isDefault = "default" }
}
struct AgentModelsResponse: Decodable {
    let defaultModelId: String?
    let models: [AgentModelInfo]?
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
        var inputPretty: String?    // for the tool I/O sheet
        var resultFull: String?
    }
    /// One Claude-style activity phase (a `think` headline + the tools that ran under it).
    struct Phase: Identifiable, Equatable {
        let id: String
        var headline: String
        var detail: String?          // full reasoning text (accordion)
        var tools: [Tool] = []
        var live: Bool = false
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
    /// Ordered SSE timeline — mirrors web `TimelineEntry` / server `usage.timeline`.
    enum TimelineEntry: Equatable {
        case think(String)
        case tool(id: String, name: String, ok: Bool?, live: Bool, inputPretty: String?, resultFull: String?)
        /// A tool filed a document as a conversation artifact (id = artifact id).
        case file(id: String, name: String)
    }

    /// One compact 44pt activity row inside the streaming turn (Claude parity).
    struct ActivityBlock: Identifiable, Equatable {
        enum Kind: Equatable { case thinking, search, tool }
        let id: String
        var kind: Kind
        var label: String
        var thinkFull: String = ""
        var toolId: String? = nil
        var ok: Bool? = nil
        var live: Bool = false
    }

    /// Chronological turn content: prose and activity rows grow together, in order,
    /// exactly as the SSE events arrive (Claude interleaved composition).
    enum TurnBlock: Identifiable, Equatable {
        case prose(id: String, text: String)
        case activity(ActivityBlock)
        case file(id: String, artifactId: String, name: String)
        var id: String {
            switch self {
            case .prose(let id, _): return id
            case .activity(let a): return a.id
            case .file(let id, _, _): return id
            }
        }
    }

    /// `var` (not `let`): the stream-tail merge keeps the local id when the server
    /// copy arrives, so the row's SwiftUI identity never changes → prose never blinks.
    var id: String
    let role: Role
    var text: String = ""
    var imagePaths: [String] = []
    var localImages: [UIImage] = []   // optimistic composer thumbnails (user msgs)
    var confirmCards: [ConfirmCard] = []
    var askCards: [AskCard] = []
    var tools: [Tool] = []            // flat list (live streaming + fallback)
    var timeline: [TimelineEntry] = []
    var blocks: [TurnBlock] = []      // interleaved prose ↔ activity (streaming UI)
    var phases: [Phase] = []          // Claude-style activity timeline (live + persisted)
    var thinking: String?
    var thinkingMs: Int?
    var streamStartedAt: Date?
    var tokensIn: Int?
    var tokensOut: Int?
    var costUsd: String?
    var createdAt: String?
    var isStreaming = false

    /// The heartbeat's self-wake seed renders as a divider, never as an owner bubble
    /// (web: isHeartbeatWakeText / HEARTBEAT_WAKE_SENTINEL).
    var isHeartbeatWake: Bool {
        role == .user && text.trimmingCharacters(in: .whitespaces).hasPrefix("[স্বয়ংক্রিয় হার্টবিট")
    }

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
        m.tokensIn = wire.tokensIn
        m.tokensOut = wire.tokensOut
        m.createdAt = wire.createdAt
        if let c = wire.costUsd {
            switch c {
            case .string(let s): m.costUsd = s
            case .number(let n): m.costUsd = String(format: "%.4f", n)
            default: break
            }
        }
        m.tools = (wire.toolCalls ?? []).enumerated().map { i, t in
            .init(id: t.id ?? "tool-\(wire.id)-\(i)", name: t.name ?? "?", ok: t.success,
                  preview: t.result, live: false, inputPretty: nil, resultFull: t.result)
        }
        m.phases = Self.buildPhases(timeline: Self.timelineFromWire(wire), messageId: wire.id, live: false,
                                    fallbackTools: m.tools)
        m.timeline = Self.timelineFromWire(wire)
        return m
    }

    static func timelineFromWire(_ wire: AgentMessageWire) -> [TimelineEntry] {
        (wire.timeline ?? []).compactMap { e -> TimelineEntry? in
            if e.t == "think" {
                let t = (e.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                return t.isEmpty ? nil : .think(t)
            }
            if e.t == "tool" {
                return .tool(id: e.id ?? "tl-\(wire.id)", name: e.name ?? "টুল", ok: e.ok, live: false,
                             inputPretty: e.input?.pretty(), resultFull: e.result)
            }
            if e.t == "file", let aid = e.id {
                return .file(id: aid, name: e.name ?? "ডকুমেন্ট")
            }
            return nil
        }
    }

    // MARK: Live SSE timeline builders (web AgentApp parity)

    static func appendThink(_ tl: [TimelineEntry], chunk: String) -> [TimelineEntry] {
        var next = tl
        if case .think(let prev)? = next.last {
            next[next.count - 1] = .think(prev + chunk)
        } else {
            next.append(.think(chunk))
        }
        return next
    }

    static func pushOrUpdateTool(_ tl: [TimelineEntry], id: String, name: String,
                                 inputPretty: String?) -> [TimelineEntry] {
        var next = tl
        if let idx = next.firstIndex(where: { if case .tool(let tid, _, _, _, _, _) = $0 { return tid == id }; return false }) {
            if case .tool(_, let n, let ok, let live, _, let result) = next[idx] {
                next[idx] = .tool(id: id, name: n, ok: ok, live: live, inputPretty: inputPretty ?? nil, resultFull: result)
            }
        } else {
            next.append(.tool(id: id, name: name, ok: nil, live: true, inputPretty: inputPretty, resultFull: nil))
        }
        return next
    }

    static func finalizeTool(_ tl: [TimelineEntry], id: String, ok: Bool,
                             result: String?) -> [TimelineEntry] {
        tl.map { e in
            if case .tool(let tid, let name, _, _, let input, _) = e, tid == id {
                return TimelineEntry.tool(id: tid, name: name, ok: ok, live: false,
                                          inputPretty: input, resultFull: result)
            }
            return e
        }
    }

    // MARK: Interleaved TurnBlock builders (Claude composition — v3 demo parity)

    /// Claude-app parity (owner 2026-07-12): the row label is the headline of the
    /// LATEST thought step — never the frozen first line. While the model thinks,
    /// the label keeps advancing with the newest paragraph (which reasons about the
    /// PREVIOUS step's result), so every step shows a fresh, distinct headline
    /// exactly like Claude iOS. Mirrors web AgentThread.parseThoughtSteps (last step).
    static func thinkLabel(_ full: String) -> String {
        let text = full.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "Thinking" }
        // Latest blank-line paragraph; a single unbroken blob falls back to lines.
        var blocks = text.components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if blocks.count <= 1 {
            let byLine = text.components(separatedBy: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            if byLine.count > 1 { blocks = byLine }
        }
        return thoughtHeadline(blocks.last ?? text)
    }

    /// One thought block → one clean headline: markdown-header / bold lead wins,
    /// else the block's first sentence (Bangla danda ।, or . ! ? followed by space).
    /// Mirrors web AgentThread.stripThoughtMd + parseThoughtSteps block handling.
    static func thoughtHeadline(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return "Thinking" }
        if s.hasPrefix("**"),
           let close = s.range(of: "**", range: s.index(s.startIndex, offsetBy: 2)..<s.endIndex) {
            // Bold lead "**Title** rest" → Title
            s = String(s[s.index(s.startIndex, offsetBy: 2)..<close.lowerBound])
        } else if !s.hasPrefix("#") {
            // First sentence: terminator must be followed by whitespace / end so
            // decimals ("1.5k") and dotted names never cut the headline short.
            let terms: Set<Character> = ["।", ".", "!", "?"]
            var idx = s.startIndex
            while idx < s.endIndex {
                if terms.contains(s[idx]) {
                    let next = s.index(after: idx)
                    if next == s.endIndex || s[next].isWhitespace || s[next].isNewline {
                        s = String(s[..<next])
                        break
                    }
                }
                idx = s.index(after: idx)
            }
        }
        s = s.replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "__", with: "")
            .replacingOccurrences(of: "`", with: "")
        while s.hasPrefix("#") || s.hasPrefix("-") || s.hasPrefix("*") || s.hasPrefix("•") {
            s = String(s.dropFirst()).trimmingCharacters(in: .whitespaces)
        }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return "Thinking" }
        if s.count > 96 {
            return String(s.prefix(94)).trimmingCharacters(in: .whitespaces) + "…"
        }
        return s
    }

    /// text_delta → extend the last prose block, or open a new one after activity.
    static func appendProseBlock(_ blocks: [TurnBlock], chunk: String, messageId: String) -> [TurnBlock] {
        var next = blocks
        if case .prose(let id, let text)? = next.last {
            next[next.count - 1] = .prose(id: id, text: text + chunk)
        } else {
            next.append(.prose(id: "bp-\(messageId)-\(next.count)", text: chunk))
        }
        return next
    }

    /// thinking_delta → merge into the pending thinking row (ONE row per think burst;
    /// a new burst starts only after prose or a tool interrupted the previous one).
    static func appendThinkBlock(_ blocks: [TurnBlock], chunk: String, messageId: String) -> [TurnBlock] {
        var next = blocks
        if case .activity(var a)? = next.last, a.kind == .thinking {
            a.thinkFull += chunk
            a.label = thinkLabel(a.thinkFull)
            next[next.count - 1] = .activity(a)
        } else {
            next.append(.activity(.init(id: "ba-\(messageId)-\(next.count)", kind: .thinking,
                                        label: thinkLabel(chunk), thinkFull: chunk, live: true)))
        }
        return next
    }

    /// tool_start → one "Searched available tools" row before the first tool, then a tool row.
    static func appendToolBlock(_ blocks: [TurnBlock], toolId: String, name: String,
                                messageId: String) -> [TurnBlock] {
        var next = blocks
        let hasSearch = next.contains { if case .activity(let a) = $0 { return a.kind == .search }; return false }
        if !hasSearch {
            next.append(.activity(.init(id: "bs-\(messageId)", kind: .search,
                                        label: "Searched available tools")))
        }
        let hasTool = next.contains { if case .activity(let a) = $0 { return a.toolId == toolId }; return false }
        if !hasTool {
            next.append(.activity(.init(id: "bt-\(messageId)-\(toolId)", kind: .tool,
                                        label: name, toolId: toolId, live: true)))
        }
        return next
    }

    /// tool_end → settle the matching tool row.
    static func finalizeToolBlock(_ blocks: [TurnBlock], toolId: String, ok: Bool) -> [TurnBlock] {
        blocks.map { b in
            if case .activity(var a) = b, a.toolId == toolId {
                a.ok = ok
                a.live = false
                return .activity(a)
            }
            return b
        }
    }

    static func syncTools(from timeline: [TimelineEntry]) -> [Tool] {
        timeline.compactMap { e in
            if case .tool(let id, let name, let ok, let live, let input, let result) = e {
                return Tool(id: id, name: name, ok: ok, preview: result.map { String($0.prefix(160)) },
                            live: live, inputPretty: input, resultFull: result)
            }
            return nil
        }
    }

    static func refreshPhases(on message: inout AgentChatMessage, live: Bool) {
        message.phases = buildPhases(timeline: message.timeline, messageId: message.id, live: live,
                                     fallbackTools: message.tools)
        message.tools = syncTools(from: message.timeline)
    }

    /// Web parity: derive phases from the ordered timeline stream.
    static func buildPhases(timeline: [TimelineEntry], messageId: String, live: Bool,
                            fallbackTools: [Tool]) -> [Phase] {
        var phases: [Phase] = []
        var cur: Phase?
        var n = 0
        for (idx, e) in timeline.enumerated() {
            n += 1
            let isLast = idx == timeline.count - 1
            switch e {
            case .think(let fullRaw):
                let full = fullRaw.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !full.isEmpty else { continue }
                // Same latest-step headline as the live rows (Claude parity) — the
                // settled phase title reflects where that step ENDED, not its opener.
                let headline = thinkLabel(full)
                let detail = full == headline ? nil : full
                if let c = cur, !c.tools.isEmpty { phases.append(c); cur = nil }
                if var c = cur {
                    c.detail = c.detail.map { $0 + "\n\n" + full } ?? full
                    c.headline = headline
                    if live && isLast { c.live = true }
                    cur = c
                } else {
                    cur = Phase(id: "ph-\(messageId)-\(n)", headline: headline, detail: detail,
                                tools: [], live: live && isLast)
                }
            case .tool(let id, let name, let ok, let toolLive, let input, let result):
                if cur == nil {
                    cur = Phase(id: "ph-\(messageId)-t\(n)", headline: name, detail: nil, tools: [], live: false)
                }
                cur?.tools.append(Tool(id: id, name: name, ok: ok, preview: result.map { String($0.prefix(160)) },
                                       live: toolLive, inputPretty: input, resultFull: result))
                if toolLive { cur?.live = true }
            case .file:
                // File cards render as their own row in the message body, not as a phase step.
                continue
            }
        }
        if let c = cur { phases.append(c) }
        if phases.isEmpty && !fallbackTools.isEmpty {
            phases = [Phase(id: "ph-\(messageId)-flat", headline: "কাজের ধাপ", detail: nil,
                            tools: fallbackTools, live: live)]
        }
        return phases
    }

    /// Legacy wire builder — delegates to the unified timeline path.
    static func buildPhases(wire: AgentMessageWire, fallbackTools: [Tool]) -> [Phase] {
        buildPhases(timeline: timelineFromWire(wire), messageId: wire.id, live: false, fallbackTools: fallbackTools)
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
    /// The reply that just settled THIS session — its ALMA wordmark animates in (LOCKED §4).
    var justSettledId: String?
    var thinkingLive = false        // spinner row before the first text token
    var currentTurnId: String?
    private var streamTask: Task<Void, Never>?
    private var understandingTask: Task<Void, Never>?
    private var requestedLiveMode = "thinking"
    private var visualLiveMode = "idle"

    /// Stable visual state, including a minimum 2.08s understanding intake.
    /// Later SSE states are queued during that intake, then handed off smoothly.
    var liveMode: String { visualLiveMode }

    private func beginUnderstanding() {
        understandingTask?.cancel()
        requestedLiveMode = "thinking"
        visualLiveMode = "understanding"
        understandingTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_080_000_000)
            guard let self, !Task.isCancelled, self.isStreaming else { return }
            self.visualLiveMode = self.requestedLiveMode
        }
    }

    private func requestLiveMode(_ mode: String) {
        requestedLiveMode = mode
        if visualLiveMode != "understanding" { visualLiveMode = mode }
    }

    private func settleLiveMode() {
        understandingTask?.cancel()
        understandingTask = nil
        requestedLiveMode = "thinking"
        visualLiveMode = "idle"
    }

    // Sidebar / conversations (web AgentSidebar parity)
    var showSidebar = false
    // Native voice-to-voice console
    var showVoice = false
    var conversations: [AgentConversation] = []
    var conversationsCursor: String?
    var loadingConversations = false
    var loadingMoreConversations = false
    var projects: [AgentProject] = []
    var memories: [AgentMemoryRow] = []
    var memoriesLoading = false
    var financeSummary: AgentFinanceSummary?
    var learnedRules: [AgentLearnedRule] = []

    // Open-loop tasks ("N কাজ বাকি" chip)
    var openTasks: [AgentOpenTask] = []
    var openTaskBusyId: String?

    // S8 additive — artifacts (display-only) + Plan-Drive Live Desk
    fileprivate var artifacts: [AgentArtifactWire] = []
    fileprivate var planDrive: AgentPlanDrivePanel?
    var planDriveBusyPlanId: String?

    // TTS playback ("শুনুন")
    var ttsPlayingId: String?
    var ttsLoadingId: String?
    private var ttsPlayer: AVAudioPlayer?
    private var ttsDelegate: AssistantTTSDelegate?

    // Composer attachments
    struct PendingFile: Identifiable, Equatable {
        enum State: Equatable { case uploading, ready(AgentFileRef), failed }
        let id = UUID()
        let image: UIImage
        var state: State = .uploading
    }
    var pendingFiles: [PendingFile] = []

    // Mic (recording bar: waveform + timer, web VoiceWaveform parity)
    var isRecording = false
    var transcribing = false
    var micLevel: Double = 0.06         // 0.06…1, mirrors the web's clamped RMS level
    var recordingSeconds: Int = 0
    private var recorder: AVAudioRecorder?
    private var meterTask: Task<Void, Never>?
    /// Text the mic transcription appends — the composer view observes this.
    var dictatedText: String = ""

    // Model pill + picker (web AgentModelSelector parity)
    var modelLabel: String?          // live label from the stream's model_info event
    var modelId: String?             // nil or "auto" = Auto (router picks per turn)
    var models: [AgentModelInfo] = []

    var isAutoModel: Bool { modelId == nil || modelId == "auto" }
    /// What the pill shows: Auto, or the pinned model's label.
    var modelPillLabel: String {
        if isAutoModel { return modelLabel.map { "Auto · \($0)" } ?? "Auto" }
        return models.first { $0.id == modelId }?.label ?? modelId ?? "Auto"
    }

    func loadModels() async {
        guard models.isEmpty else { return }
        if let resp: AgentModelsResponse = try? await AlmaAPI.shared.get("/api/assistant/models") {
            models = (resp.models ?? []).filter { $0.enabled != false }
        }
    }

    /// Owner picks a model (nil = Auto). Web parity: update the pill instantly,
    /// persist on the conversation row when one exists, revert on failure; a new
    /// chat simply carries it in the next send's body.
    func selectModel(_ id: String?) {
        let previous = modelId
        modelId = id
        UISelectionFeedbackGenerator().selectionChanged()
        guard let cid = conversationId else { return }
        Task { [weak self] in
            do {
                let _: AgentConversation = try await AlmaAPI.shared.send(
                    "PATCH", "/api/assistant/conversations/\(cid)",
                    body: ["modelId": id ?? "auto"])
            } catch {
                await MainActor.run {
                    self?.modelId = previous
                    self?.errorToast = "মডেল বদলানো গেল না"
                }
            }
        }
    }

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
        await loadModels()
        await loadActiveConversation()
        await loadPlanDrive()
        startPolling()
    }

    private func loadActiveConversation() async {
        do {
            let ptr: ActiveConversationPointer = try await AlmaAPI.shared.get("/api/assistant/active-conversation")
            if let cid = ptr.conversationId {
                conversationId = cid
                modelId = ptr.modelId
                await loadMessages(showSpinner: messages.isEmpty)
                await loadArtifacts()
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
            mergeServerMessages(wire)
            authExpired = false
            await loadOpenTasks()
        } catch AlmaAPIError.notAuthenticated { authExpired = true } catch {
            if showSpinner { errorToast = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription }
        }
    }

    /// Local ("stream-…" / "local-…") id per server message id — keeps SwiftUI row
    /// identity stable when the server copy of a just-streamed turn replaces the tail.
    private var localIdByServerId: [String: String] = [:]

    /// Server truth replaces the thread WITHOUT clobbering the freshly streamed tail:
    /// the tail keeps its id (no remove+insert animation) and its richer streamed
    /// content wherever the server copy is thinner. Fixes "prose vanishes at stream end".
    private func mergeServerMessages(_ wire: [AgentMessageWire]) {
        var incoming = wire.map(AgentChatMessage.from)

        // Pair the optimistic user message + streamed assistant tail with their
        // server rows (last user / last assistant AFTER that user message).
        let lastServerUser = incoming.lastIndex(where: { $0.role == .user })
        if let localUser = messages.last(where: { $0.role == .user && $0.id.hasPrefix("local-") }),
           let uIdx = lastServerUser, localIdByServerId[incoming[uIdx].id] == nil {
            localIdByServerId[incoming[uIdx].id] = localUser.id
        }
        var pairedTail = false
        if let localTail = messages.last(where: { $0.role == .assistant && $0.id.hasPrefix("stream-") }) {
            if let aIdx = incoming.lastIndex(where: { $0.role == .assistant }),
               aIdx > (lastServerUser ?? -1) {
                if localIdByServerId[incoming[aIdx].id] == nil {
                    localIdByServerId[incoming[aIdx].id] = localTail.id
                }
                pairedTail = true
            } else if localIdByServerId.values.contains(localTail.id) {
                pairedTail = true   // paired on an earlier merge
            }
        }

        for i in incoming.indices {
            guard let lid = localIdByServerId[incoming[i].id],
                  let old = messages.first(where: { $0.id == lid }) else { continue }
            // Keep the richer streamed content when the server copy is thinner.
            if incoming[i].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                incoming[i].text = old.text
            }
            if incoming[i].timeline.isEmpty && !old.timeline.isEmpty {
                incoming[i].timeline = old.timeline
                incoming[i].phases = old.phases
                incoming[i].tools = old.tools
            }
            incoming[i].blocks = old.blocks
            if incoming[i].thinking == nil { incoming[i].thinking = old.thinking }
            if incoming[i].thinkingMs == nil { incoming[i].thinkingMs = old.thinkingMs }
            if old.role == .user, !old.localImages.isEmpty { incoming[i].localImages = old.localImages }
            incoming[i].id = lid
        }

        // Server hasn't persisted the streamed reply yet → keep the local tail
        // appended (it merges on the next poll). Prose must never disappear.
        if !pairedTail,
           let tail = messages.last(where: { $0.role == .assistant && $0.id.hasPrefix("stream-") }),
           !tail.text.isEmpty {
            var kept = tail
            kept.isStreaming = false
            incoming.append(kept)
        }
        messages = incoming
    }

    /// Stream ended: settle the tail in place FIRST (prose stays on screen), then
    /// fold in server truth (card ids/statuses, tokens, cost) via the merge.
    private func finalizeTurn() async {
        if let i = messages.lastIndex(where: { $0.isStreaming }) { messages[i].isStreaming = false }
        isStreaming = false
        thinkingLive = false
        settleLiveMode()
        justSettledId = messages.last(where: { $0.role == .assistant })?.id
        guard let cid = conversationId else { return }
        if let wire: [AgentMessageWire] = try? await AlmaAPI.shared.get("/api/assistant/conversations/\(cid)/messages") {
            mergeServerMessages(wire)
            justSettledId = messages.last(where: { $0.role == .assistant })?.id
            await loadOpenTasks()
            await loadArtifacts()   // the turn may have just produced one
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
                // Plan-Drive Live Desk — web polls every 30s; every other 12s
                // tick (~24s) keeps the in-thread timeline fresh.
                if tick % 2 == 1 { await self.loadPlanDrive() }
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
        requestLiveMode("thinking")
        currentTurnId = st.turnId
        streamTask = Task { [weak self] in
            for _ in 0..<100 {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard !Task.isCancelled else { return }
                let s: TurnStatusResponse? = try? await AlmaAPI.shared.get("/api/assistant/conversations/\(cid)/turn-status")
                if s?.status != "running" { break }
            }
            guard let self, !Task.isCancelled else { return }
            self.isStreaming = false
            self.thinkingLive = false
            self.settleLiveMode()
            await self.loadMessages()
        }
    }

    // ── Conversations + sidebar data (web AgentSidebar parity) ────────────

    func loadConversations() async {
        loadingConversations = conversations.isEmpty
        defer { loadingConversations = false }
        do {
            let page: AgentConversationsPage = try await AlmaAPI.shared.get(
                "/api/assistant/conversations", query: ["paginated": "true", "limit": "30"])
            conversations = page.conversations.filter { $0.archived != true }
            conversationsCursor = page.nextCursor
            authExpired = false
        } catch AlmaAPIError.notAuthenticated { authExpired = true } catch {
            errorToast = error.localizedDescription
        }
    }

    func loadMoreConversations() async {
        guard let cursor = conversationsCursor, !loadingMoreConversations else { return }
        loadingMoreConversations = true
        defer { loadingMoreConversations = false }
        if let page: AgentConversationsPage = try? await AlmaAPI.shared.get(
            "/api/assistant/conversations",
            query: ["paginated": "true", "limit": "30", "cursor": cursor]) {
            let known = Set(conversations.map(\.id))
            conversations += page.conversations.filter { $0.archived != true && !known.contains($0.id) }
            conversationsCursor = page.nextCursor
        }
    }

    func loadProjects() async {
        if let list: [AgentProject] = try? await AlmaAPI.shared.get("/api/assistant/projects") {
            projects = list
        }
    }

    func loadMemories(scope: String) async {
        memoriesLoading = memories.isEmpty
        defer { memoriesLoading = false }
        let query: [String: String?] = scope == "all" ? [:] : ["scope": scope]
        if let rows: [AgentMemoryRow] = try? await AlmaAPI.shared.get("/api/assistant/memory", query: query) {
            memories = rows
        }
        if financeSummary == nil {
            financeSummary = try? await AlmaAPI.shared.get("/api/assistant/memory/finance-summary")
        }
        if learnedRules.isEmpty {
            let resp: AgentLearnedRulesResponse? = try? await AlmaAPI.shared.get("/api/assistant/learned-rules")
            learnedRules = resp?.rules ?? []
        }
    }

    func toggleMemoryPin(_ id: String, pinned: Bool) async {
        if let i = memories.firstIndex(where: { $0.id == id }) { memories[i].pinned = !pinned }
        let _: OkResponse? = try? await AlmaAPI.shared.send("PATCH", "/api/assistant/memory/\(id)",
                                                            body: ["pinned": !pinned])
    }

    func deleteMemory(_ id: String) async {
        memories.removeAll { $0.id == id }
        struct Empty: Decodable {}
        let _: Empty? = try? await AlmaAPI.shared.send("DELETE", "/api/assistant/memory/\(id)")
    }

    func renameConversation(_ id: String, title: String) async {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        if let i = conversations.firstIndex(where: { $0.id == id }) { conversations[i].title = t }
        let _: OkResponse? = try? await AlmaAPI.shared.send("PATCH", "/api/assistant/conversations/\(id)",
                                                            body: ["title": t])
    }

    func archiveConversation(_ id: String) async {
        conversations.removeAll { $0.id == id }
        let _: OkResponse? = try? await AlmaAPI.shared.send("PATCH", "/api/assistant/conversations/\(id)",
                                                            body: ["archived": true])
        if conversationId == id { await newChat() }
    }

    func saveProject(id: String?, name: String, description: String,
                     instructions: String, businessId: String?) async -> Bool {
        struct Body: Encodable {
            let name: String; let description: String
            let systemInstructions: String; let businessId: String?
        }
        let body = Body(name: name, description: description,
                        systemInstructions: instructions, businessId: businessId)
        do {
            if let id {
                let _: AgentProject = try await AlmaAPI.shared.send("PATCH", "/api/assistant/projects/\(id)", body: body)
            } else {
                let _: AgentProject = try await AlmaAPI.shared.send("POST", "/api/assistant/projects", body: body)
            }
            await loadProjects()
            return true
        } catch {
            errorToast = error.localizedDescription
            return false
        }
    }

    func openConversation(_ id: String) async {
        guard id != conversationId else { return }
        stopStreaming(cancelServer: false)
        conversationId = id
        modelId = conversations.first { $0.id == id }?.modelId   // pinned model follows the chat
        messages = []
        openTasks = []
        artifacts = []
        await loadMessages(showSpinner: true)
        await loadArtifacts()
        let _: OkResponse? = try? await AlmaAPI.shared.send("POST", "/api/assistant/active-conversation",
                                                            body: ["conversationId": id])
        await resumeRunningTurnIfAny()
    }

    func newChat() async {
        stopStreaming(cancelServer: false)
        conversationId = nil     // server creates one on the first send
        // Owner rule 2026-07-12: a NEW chat always starts on Auto (router picks) —
        // it must not inherit the previous conversation's pinned model (the picker
        // was silently carrying over e.g. Sonnet 4.6 from the last-opened chat).
        modelId = nil
        messages = []
        pendingFiles = []
        openTasks = []
        artifacts = []
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

    // ── Open tasks ("N কাজ বাকি") ──────────────────────────────────────────

    func loadOpenTasks() async {
        guard let cid = conversationId else { openTasks = []; return }
        let resp: AgentOpenTasksResponse? = try? await AlmaAPI.shared.get(
            "/api/assistant/open-tasks", query: ["conversationId": cid])
        openTasks = resp?.tasks ?? []
    }

    /// Web parity: continue = POST → take resumeNote → send it as the next message.
    func continueOpenTask(_ task: AgentOpenTask) async {
        openTaskBusyId = task.id
        defer { openTaskBusyId = nil }
        let resp: AgentOpenTaskActionResponse? = try? await AlmaAPI.shared.send(
            "POST", "/api/assistant/open-tasks",
            body: ["id": task.id, "action": "continue"])
        await loadOpenTasks()
        if let note = resp?.resumeNote ?? task.note, !note.isEmpty { send(note) }
    }

    func cancelOpenTask(_ task: AgentOpenTask) async {
        openTaskBusyId = task.id
        defer { openTaskBusyId = nil }
        let _: AgentOpenTaskActionResponse? = try? await AlmaAPI.shared.send(
            "POST", "/api/assistant/open-tasks",
            body: ["id": task.id, "action": "cancel"])
        await loadOpenTasks()
    }

    // ── Artifacts + Plan-Drive (S8 additive; web AgentApp parity) ──────────

    /// Web parity: artifacts are fetched alongside the conversation's messages
    /// (AgentApp loadConversation) and again when a turn settles — a turn may
    /// have just produced one.
    fileprivate func loadArtifacts() async {
        guard let cid = conversationId else { artifacts = []; return }
        if let rows: [AgentArtifactWire] = try? await AlmaAPI.shared.get(
            "/api/assistant/conversations/\(cid)/artifacts") {
            artifacts = rows
        }
    }

    /// Web parity: GET /api/assistant/plan-driver, polled while the chat is open
    /// (web polls every 30s). Read-only; safe to poll.
    fileprivate func loadPlanDrive() async {
        if let panel: AgentPlanDrivePanel = try? await AlmaAPI.shared.get("/api/assistant/plan-driver") {
            planDrive = panel
        }
    }

    /// Owner one-click Plan-Drive control (web handlePlanDriveAction):
    /// resume / add-budget / abandon → POST, then refresh the panel.
    func planDriveAct(planId: String, action: String) async {
        guard planDriveBusyPlanId == nil else { return }
        planDriveBusyPlanId = planId
        defer { planDriveBusyPlanId = nil }
        do {
            let _: OkResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/plan-driver/action",
                body: ["planId": planId, "action": action])
            errorToast = action == "abandon" ? "প্ল্যান বাদ দেওয়া হলো"
                : action == "add-budget" ? "বাজেট বাড়িয়ে আবার চালু করা হলো"
                : "আবার চালু করা হলো"
            await loadPlanDrive()
        } catch {
            errorToast = "কাজটি করা গেল না"
        }
    }

    // ── TTS ("শুনুন") ──────────────────────────────────────────────────────

    func toggleTTS(for message: AgentChatMessage) {
        if ttsPlayingId == message.id {
            ttsPlayer?.stop()
            ttsPlayer = nil
            ttsPlayingId = nil
            return
        }
        guard ttsLoadingId == nil else { return }
        ttsLoadingId = message.id
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task { [weak self] in
            guard let self else { return }
            defer { self.ttsLoadingId = nil }
            do {
                let mp3 = try await AssistantNet.postJSONForData(
                    path: "/api/assistant/tts", body: ["text": String(message.text.prefix(600))])
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
                try AVAudioSession.sharedInstance().setActive(true)
                let player = try AVAudioPlayer(data: mp3)
                let delegate = AssistantTTSDelegate { [weak self] in
                    Task { @MainActor in
                        self?.ttsPlayingId = nil
                        self?.ttsPlayer = nil
                    }
                }
                player.delegate = delegate
                self.ttsDelegate = delegate
                self.ttsPlayer = player
                self.ttsPlayingId = message.id
                player.play()
            } catch {
                self.errorToast = "ভয়েস চালানো গেল না"
            }
        }
    }

    // ── Send + stream ──────────────────────────────────────────────────────

    struct ChatBody: Encodable {
        let conversationId: String?
        let message: String
        let files: [AgentFileRef]
        let modelId: String?
        var voice: Bool? = nil    // voice console turns: TTS-friendly replies
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
        beginUnderstanding()
        currentTurnId = nil
        ensureStreamingTail()

        let body = ChatBody(conversationId: conversationId, message: text,
                            files: readyFiles, modelId: modelId ?? "auto")
        streamTask = Task { [weak self] in
            await self?.runTurn(body: body)
        }
    }

    private func runTurn(body: ChatBody) async {
        defer {
            isStreaming = false
            thinkingLive = false
            settleLiveMode()
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
            // Server truth (final card ids/statuses, tool rows, cost) merges into the
            // tail in place — never a wholesale replace (prose must not blink).
            await finalizeTurn()
        } catch is CancellationError {
            await finalizeTurn()
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
            requestLiveMode("thinking")
            ensureStreamingTail()
            if let i = messages.lastIndex(where: { $0.isStreaming }) {
                let chunk = ev.delta ?? ""
                messages[i].thinking = (messages[i].thinking ?? "") + chunk
                messages[i].timeline = AgentChatMessage.appendThink(messages[i].timeline, chunk: chunk)
                messages[i].blocks = AgentChatMessage.appendThinkBlock(
                    messages[i].blocks, chunk: chunk, messageId: messages[i].id)
                let live = messages[i].text.isEmpty
                AgentChatMessage.refreshPhases(on: &messages[i], live: live)
            }
        case "text_delta":
            requestLiveMode("writing")
            ensureStreamingTail()
            if let i = messages.lastIndex(where: { $0.isStreaming }) {
                if messages[i].text.isEmpty {
                    if let start = messages[i].streamStartedAt {
                        messages[i].thinkingMs = max(1, Int(Date().timeIntervalSince(start) * 1000))
                    }
                    AgentChatMessage.refreshPhases(on: &messages[i], live: false)
                }
                messages[i].text += ev.delta ?? ""
                messages[i].blocks = AgentChatMessage.appendProseBlock(
                    messages[i].blocks, chunk: ev.delta ?? "", messageId: messages[i].id)
            }
        case "tool_start":
            requestLiveMode("searching")
            ensureStreamingTail()
            if let i = messages.lastIndex(where: { $0.isStreaming }) {
                let tid = ev.id ?? UUID().uuidString
                messages[i].timeline = AgentChatMessage.pushOrUpdateTool(
                    messages[i].timeline, id: tid, name: ev.name ?? "টুল",
                    inputPretty: ev.input?.pretty())
                messages[i].blocks = AgentChatMessage.appendToolBlock(
                    messages[i].blocks, toolId: tid, name: ev.name ?? "টুল",
                    messageId: messages[i].id)
                AgentChatMessage.refreshPhases(on: &messages[i], live: messages[i].text.isEmpty)
            }
        case "tool_end":
            requestLiveMode("writing")
            if let i = messages.lastIndex(where: { $0.isStreaming }),
               let tid = ev.id {
                messages[i].timeline = AgentChatMessage.finalizeTool(
                    messages[i].timeline, id: tid, ok: ev.success ?? true,
                    result: ev.resultPreview)
                messages[i].blocks = AgentChatMessage.finalizeToolBlock(
                    messages[i].blocks, toolId: tid, ok: ev.success ?? true)
                AgentChatMessage.refreshPhases(on: &messages[i], live: messages[i].text.isEmpty)
            }
        case "artifact_saved":
            // A tool filed a document (SEO report, research…) — drop a FILE CARD
            // into the reply flow, Claude-style (web AgentApp parity).
            ensureStreamingTail()
            if let i = messages.lastIndex(where: { $0.isStreaming }), let aid = ev.id {
                let name = ev.title ?? "ডকুমেন্ট"
                messages[i].timeline.append(.file(id: aid, name: name))
                messages[i].blocks.append(.file(id: "fb-\(messages[i].id)-\(aid)", artifactId: aid, name: name))
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
            settleLiveMode()
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case "error":
            thinkingLive = false
            settleLiveMode()
            errorToast = ev.message ?? ev.error ?? "সমস্যা হয়েছে — আবার চেষ্টা করুন"
        default:
            break
        }
    }

    private func ensureStreamingTail() {
        if messages.last?.isStreaming != true {
            var m = AgentChatMessage(id: "stream-\(UUID().uuidString)", role: .assistant)
            m.isStreaming = true
            m.streamStartedAt = Date()
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
        settleLiveMode()
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
        // Feed the choice back into the chat so the agent continues instantly (web onQuickSend parity).
        send(option)
    }

    /// "আমার মত" — reject pending action, then send owner's correction as a new turn.
    func submitOpinion(_ cardId: String, note: String) async {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        setConfirmStatus(cardId, "rejected")
        let _: OkResponse? = try? await AlmaAPI.shared.send(
            "POST", "/api/assistant/actions/\(cardId)/reject")
        send(trimmed)
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
                    let rec = try AVAudioRecorder(url: self.recordingURL, settings: settings)
                    rec.isMeteringEnabled = true
                    rec.record()
                    self.recorder = rec
                    self.isRecording = true
                    self.recordingSeconds = 0
                    self.micLevel = 0.06
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    // Web VoiceWaveform parity: live RMS level drives the 34-bar wave.
                    self.meterTask?.cancel()
                    self.meterTask = Task { [weak self] in
                        while let self, self.isRecording, !Task.isCancelled {
                            if let r = self.recorder {
                                r.updateMeters()
                                let db = r.averagePower(forChannel: 0)          // -160…0 dB
                                let linear = pow(10.0, Double(db) / 20.0)       // 0…1
                                self.micLevel = max(0.06, min(1.0, linear * 3.2))
                                self.recordingSeconds = Int(r.currentTime)
                            }
                            try? await Task.sleep(nanoseconds: 66_000_000)      // ~15 fps
                        }
                    }
                } catch {
                    self.errorToast = "মাইক্রোফোন চালু করা গেল না"
                }
            }
        }
    }

    /// ✕ on the recording bar — discard the take, no transcription.
    func cancelRecording() {
        meterTask?.cancel()
        recorder?.stop()
        recorder = nil
        isRecording = false
        try? FileManager.default.removeItem(at: recordingURL)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func finishRecording() {
        meterTask?.cancel()
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

/// AVAudioPlayer completion → clear the "playing" state on the TTS button.
final class AssistantTTSDelegate: NSObject, AVAudioPlayerDelegate {
    private let onFinish: () -> Void
    init(onFinish: @escaping () -> Void) { self.onFinish = onFinish }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { onFinish() }
}

// MARK: - Aurora background (web .ambient-bg-root parity)

@available(iOS 17.0, *)
struct AgentAuroraBackground: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift = false

    private struct AuroraBlob { let color: Color; let size: CGFloat; let x: CGFloat; let y: CGFloat; let dx: CGFloat; let dy: CGFloat }

    var body: some View {
        let dark = scheme == .dark
        // Agent-parity living aurora (web --aurora-blob-1…5): five blurred colour blobs
        // drifting corner-to-corner over the page canvas. Owner directive 2026-07-08:
        // every native page shares the Assistant tab's moving aurora.
        let blobs: [AuroraBlob] = [
            .init(color: Color(red: 0.220, green: 0.502, blue: 1.000).opacity(dark ? 0.60 : 0.30), size: 380, x: 0.15, y: 0.10, dx: 60, dy: 40),
            .init(color: Color(red: 0.486, green: 0.302, blue: 1.000).opacity(dark ? 0.55 : 0.26), size: 420, x: 0.85, y: 0.25, dx: -50, dy: 60),
            .init(color: Color(red: 0.839, green: 0.200, blue: 1.000).opacity(dark ? 0.50 : 0.24), size: 360, x: 0.30, y: 0.55, dx: 70, dy: -40),
            .init(color: Color(red: 1.000, green: 0.180, blue: 0.525).opacity(dark ? 0.55 : 0.26), size: 400, x: 0.80, y: 0.80, dx: -60, dy: -50),
            .init(color: Color(red: 1.000, green: 0.431, blue: 0.314).opacity(dark ? 0.45 : 0.22), size: 340, x: 0.20, y: 0.95, dx: 50, dy: -60),
        ]
        GeometryReader { geo in
            ZStack {
                (dark ? Color(red: 0.078, green: 0.078, blue: 0.094)
                      : Color(red: 0.980, green: 0.976, blue: 0.965))
                RadialGradient(colors: [Color(red: 0.388, green: 0.400, blue: 0.945).opacity(dark ? 0.22 : 0.10), .clear],
                               center: .init(x: 0.5, y: -0.1), startRadius: 0, endRadius: geo.size.height * 0.8)
                RadialGradient(colors: [Color(red: 0.925, green: 0.282, blue: 0.600).opacity(dark ? 0.28 : 0.12), .clear],
                               center: .init(x: 0.5, y: 1.15), startRadius: 0, endRadius: geo.size.height * 0.9)
                ForEach(Array(blobs.enumerated()), id: \.offset) { _, b in
                    Circle()
                        // Radial-gradient falloff reads the same as the old blur(70)
                        // but costs ZERO gaussian passes — the live blurs were the
                        // app-wide transition/scroll jank source (perf audit 2026-07-08).
                        .fill(RadialGradient(colors: [b.color, b.color.opacity(0)],
                                             center: .center,
                                             startRadius: b.size * 0.10,
                                             endRadius: b.size * 0.62))
                        .frame(width: b.size * 1.35, height: b.size * 1.35)
                        .position(x: geo.size.width * b.x + (drift ? b.dx : -b.dx),
                                  y: geo.size.height * b.y + (drift ? b.dy : -b.dy))
                }
            }
            .onAppear { updateDrift() }
            // Covered/backgrounded screens must not keep animating — pausing here means
            // a stack of pushed pages costs nothing while hidden.
            .onDisappear { pauseDrift() }
            .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)
                .receive(on: DispatchQueue.main)) { _ in updateDrift() }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    /// Battery guard: drift only when the owner allows motion — Reduce Motion and
    /// Low Power Mode both freeze the aurora to a static wash (blobs at rest).
    private func pauseDrift() {
        var tx = Transaction(); tx.disablesAnimations = true
        withTransaction(tx) { drift = false }
    }

    private func updateDrift() {
        if reduceMotion || ProcessInfo.processInfo.isLowPowerModeEnabled {
            var tx = Transaction(); tx.disablesAnimations = true
            withTransaction(tx) { drift = false }
        } else if !drift {
            // Start the drift AFTER the push/present transition settles — kicking a
            // repeatForever animation mid-transition made every slide-in stutter.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                guard !drift, !reduceMotion,
                      !ProcessInfo.processInfo.isLowPowerModeEnabled else { return }
                withAnimation(.easeInOut(duration: 26).repeatForever(autoreverses: true)) { drift = true }
            }
        }
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
                .font(.system(size: 15.5, design: .serif))
                .foregroundStyle(pal.ink)
        }
        return Text(s).font(.system(size: 15.5, design: .serif)).foregroundStyle(pal.ink)
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
                        .padding(.horizontal, isCopyCard ? 10 : 0)
                        .padding(.vertical, isCopyCard ? 5 : 0)
                        .background(isCopyCard ? AgentPalette.coral.opacity(0.13) : .clear, in: Capsule())
                        .overlay(Capsule().strokeBorder(
                            isCopyCard ? AgentPalette.coral.opacity(0.45) : .clear, lineWidth: 1))
                }
            }
            Text(body)
                .font(.system(size: 13.5, design: isCopyCard ? .serif : .monospaced))
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
    let showWorkingIndicator: Bool
    let isLastAssistant: Bool
    let onToolTap: (AgentChatMessage.Tool) -> Void
    let onActivitySheet: (AgentActivitySheetRequest) -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var expandedLong = false

    var body: some View {
        let pal = AgentPalette(scheme)
        if message.isHeartbeatWake {
            // Autonomous self-wake — an inline divider, never a fake owner bubble.
            HStack(spacing: 10) {
                Rectangle().fill(pal.borderSubtle).frame(height: 1)
                HStack(spacing: 5) {
                    Text("💓").font(.system(size: 10))
                    Text("ALMA নিজে থেকে জাগল")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(AgentPalette.coral.opacity(0.9))
                }
                .padding(.horizontal, 12).padding(.vertical, 4)
                .background(AgentPalette.coral.opacity(0.06), in: Capsule())
                .overlay(Capsule().strokeBorder(AgentPalette.coral.opacity(0.25), lineWidth: 1))
                .fixedSize()
                Rectangle().fill(pal.borderSubtle).frame(height: 1)
            }
            .padding(.vertical, 6)
            .padding(.bottom, 12)
        } else if message.role == .user {
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
                        // Owner issue #6 (build 69): long-press → copy + haptic.
                        .contextMenu {
                            Button {
                                UIPasteboard.general.string = message.text
                                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            } label: {
                                Label("কপি করুন", systemImage: "doc.on.doc")
                            }
                        }
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 44)   // ~85% max width feel
            .padding(.bottom, 18)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                let hasTimeline = !message.timeline.isEmpty
                let hasSettledMeta = !message.phases.isEmpty || !(message.thinking ?? "").isEmpty
                    || !message.tools.isEmpty
                // LOCKED SPEC §1: NO glass card — plain on the aurora (Claude iOS).
                    // Live pinned summary — running token estimate + step count
                    // while the turn works (web parity; owner issue #3 build 69).
                    if message.isStreaming {
                        AgentLiveWorkSummaryRow(message: message, pal: pal)
                    }
                    if !message.blocks.isEmpty {
                        // Claude composition — chronological prose ↔ compact rows;
                        // rows persist after settle (tap → sheets), prose never moves.
                        AgentTurnBlocksView(message: message, pal: pal, vm: vm, onToolTap: onToolTap) { kind in
                            onActivitySheet(.init(message: message, kind: kind))
                        }
                    } else {
                        // Persisted history turn — one collapsed summary row above the prose.
                        if !message.isStreaming && (hasTimeline || hasSettledMeta) {
                            AgentSettledSummaryRow(message: message, pal: pal) {
                                onActivitySheet(.init(message: message, kind: .summary))
                            }
                        }
                        if !message.text.isEmpty {
                            let long = message.text.count > 1500 && !message.isStreaming
                            VStack(alignment: .leading, spacing: 4) {
                                if message.isStreaming {
                                    HStack(alignment: .bottom, spacing: 2) {
                                        AgentMarkdownText(text: message.text, pal: pal)
                                            .modifier(AgentShimmerModifier())
                                        AgentTypingCursor()
                                    }
                                } else {
                                    AgentMarkdownText(text: message.text, pal: pal)
                                        .frame(maxHeight: long && !expandedLong ? 340 : .infinity, alignment: .top)
                                        .clipped()
                                        .mask(
                                            LinearGradient(stops: long && !expandedLong
                                                ? [.init(color: .black, location: 0), .init(color: .black, location: 0.78),
                                                   .init(color: .clear, location: 1)]
                                                : [.init(color: .black, location: 0), .init(color: .black, location: 1)],
                                                startPoint: .top, endPoint: .bottom))
                                        .contentShape(Rectangle())
                                        // Owner issue #6 (build 69): long-press → copy + haptic.
                                        .contextMenu {
                                            Button {
                                                UIPasteboard.general.string = message.text
                                                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                            } label: {
                                                Label("কপি করুন", systemImage: "doc.on.doc")
                                            }
                                        }
                                }
                                if long {
                                    Button {
                                        UISelectionFeedbackGenerator().selectionChanged()
                                        withAnimation(.easeOut(duration: 0.3)) { expandedLong.toggle() }
                                    } label: {
                                        HStack(spacing: 4) {
                                            Text(expandedLong ? "কম দেখুন" : "বিস্তারিত দেখুন")
                                                .font(.system(size: 12, weight: .medium))
                                            Image(systemName: "chevron.down")
                                                .font(.system(size: 10))
                                                .rotationEffect(.degrees(expandedLong ? 180 : 0))
                                        }
                                        .foregroundStyle(AgentPalette.coral.opacity(0.85))
                                    }
                                }
                            }
                        }
                    }

                    // File cards for persisted turns (streaming turns render them
                    // in-flow via TurnBlocks — skip here to avoid doubling).
                    if message.blocks.isEmpty {
                        ForEach(Array(message.timeline.enumerated()), id: \.offset) { _, e in
                            if case .file(let aid, let name) = e {
                                AgentArtifactFileCard(artifactId: aid, name: name, vm: vm, pal: pal)
                            }
                        }
                    }

                    ForEach(message.imagePaths, id: \.self) { p in
                        AgentChatImage(path: p, vm: vm)
                    }
                    ForEach(message.confirmCards) { card in
                        AgentConfirmCardView(card: card, pal: pal, vm: vm) { approve in
                            Task { await vm.approveAction(card.id, approve: approve) }
                        }
                    }
                    if !message.askCards.isEmpty {
                        AgentAskCardsPager(cards: message.askCards, pal: pal) { card, option in
                            Task { await vm.answerAskCard(card.id, option: option) }
                        }
                    }

                    // Single starburst — bottom-left INSIDE the card while the turn runs.
                    if showWorkingIndicator {
                        AgentThinkingRow(mode: vm.liveMode, pal: pal)
                            .padding(.top, 2)
                    }

                // ALMA wordmark footer + copy / listen / cost (LOCKED §4).
                if !message.isStreaming && !message.text.isEmpty {
                    AgentMessageActions(message: message, vm: vm, pal: pal)
                }
                // "N কাজ বাকি" — end of last assistant reply (web AgentOpenTasksChip parity)
                if isLastAssistant && !message.isStreaming && !vm.openTasks.isEmpty {
                    AgentOpenTasksChipView(vm: vm, pal: pal)
                        .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 26)
        }
    }
}

/// LOCKED §3 — Claude text-shimmer: base opacity .35, white highlight sweeps
/// left→right on a 1.8s loop while streaming; settle = normal full-color text.
@available(iOS 17.0, *)
struct AgentShimmerModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let period: Double = 1.6

    // TimelineView-driven (2026-07-12): the old repeatForever @State sweep froze
    // whenever the streaming content re-rendered (every text_delta), leaving the
    // highlight stuck mid-sweep. Visual spec unchanged — same dim base, same
    // white band, same 1.6s left→right loop.
    func body(content: Content) -> some View {
        if reduceMotion {
            content
        } else {
            content
                .opacity(0.28)
                .overlay(
                    // Only the gradient band re-evaluates per frame; the content and
                    // its mask stay put (cheap even on a long streaming reply).
                    GeometryReader { g in
                        TimelineView(.animation) { context in
                            let phase = context.date.timeIntervalSinceReferenceDate
                                .truncatingRemainder(dividingBy: Self.period) / Self.period
                            let band = max(70, g.size.width * 0.5)
                            let travel = g.size.width + band * 2
                            LinearGradient(colors: [.clear, .white, .clear],
                                           startPoint: .leading, endPoint: .trailing)
                                .frame(width: band)
                                .offset(x: -band + travel * phase)
                        }
                    }
                    .mask(content)
                    .allowsHitTesting(false)
                )
        }
    }
}

/// Blinking coral caret at the end of a streaming reply (web parity: 2px bar, 0.8s).
@available(iOS 17.0, *)
struct AgentTypingCursor: View {
    @State private var on = true
    var body: some View {
        Capsule()
            .fill(AgentPalette.coral.opacity(0.6))
            .frame(width: 2.5, height: 16)
            .opacity(on ? 1 : 0)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.4).repeatForever(autoreverses: true)) { on = false }
            }
    }
}

// MARK: - Claude-style activity timeline

/// The web SparkleGlyph — a 4-point star with concave sides.
@available(iOS 17.0, *)
struct AlmaSparkleShape: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let w = rect.width, h = rect.height
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let top = CGPoint(x: rect.midX, y: rect.minY)
        let right = CGPoint(x: rect.maxX, y: rect.midY)
        let bottom = CGPoint(x: rect.midX, y: rect.maxY)
        let left = CGPoint(x: rect.minX, y: rect.midY)
        let pull: CGFloat = 0.18
        p.move(to: top)
        p.addQuadCurve(to: right, control: CGPoint(x: c.x + w * pull, y: c.y - h * pull))
        p.addQuadCurve(to: bottom, control: CGPoint(x: c.x + w * pull, y: c.y + h * pull))
        p.addQuadCurve(to: left, control: CGPoint(x: c.x - w * pull, y: c.y + h * pull))
        p.addQuadCurve(to: top, control: CGPoint(x: c.x - w * pull, y: c.y - h * pull))
        p.closeSubpath()
        return p
    }
}

/// alma-sparkle-pulse: scale 0.8↔1.2 + opacity 0.55↔1, 1.6s ease-in-out.
@available(iOS 17.0, *)
struct AlmaSparklePulse: View {
    var size: CGFloat = 13
    var color: Color = AgentPalette.coral
    @State private var up = false
    var body: some View {
        AlmaSparkleShape()
            .fill(color)
            .frame(width: size, height: size)
            .scaleEffect(up ? 1.2 : 0.8)
            .opacity(up ? 1 : 0.55)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { up = true }
            }
    }
}

/// Claude-app text shimmer for the LIVE process headline (owner spec 2026-07-12:
/// "fully highlight shimmering effect, continuous, like Claude"). The text sits
/// dimmed (0.35) and a bright highlight band sweeps across the glyphs on a steady
/// 1.8s loop. Driven by TimelineView — a state-driven repeatForever animation
/// froze whenever the streaming label text changed mid-sweep, which is exactly
/// why the old effect read as unclear/unprofessional.
@available(iOS 17.0, *)
struct AlmaShimmerText: View {
    let text: String
    var font: Font = .system(size: 12.5, weight: .semibold)
    var base: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    private static let period: Double = 1.8

    var body: some View {
        if reduceMotion {
            Text(text).font(font).foregroundStyle(base)
        } else {
            Text(text)
                .font(font)
                .foregroundStyle(base.opacity(0.35))
                .overlay(
                    GeometryReader { g in
                        TimelineView(.animation) { context in
                            let phase = context.date.timeIntervalSinceReferenceDate
                                .truncatingRemainder(dividingBy: Self.period) / Self.period
                            let band = max(56, g.size.width * 0.5)
                            let travel = g.size.width + band * 2
                            LinearGradient(
                                colors: [.clear,
                                         scheme == .dark ? .white : Color.black.opacity(0.9),
                                         .clear],
                                startPoint: .leading, endPoint: .trailing)
                                .frame(width: band)
                                .offset(x: -band + travel * phase)
                        }
                    }
                    .mask(Text(text).font(font))
                    .allowsHitTesting(false)
                )
        }
    }
}

/// Glyph-only shimmer for the LIVE process row (approved demo, 2026-07-12).
/// The wrapped content — leading SF Symbol, headline text, trailing chevron —
/// keeps its normal muted colors; a narrow brighter band sweeps left→right and
/// is MASKED to the rendered glyphs, so the gaps between icon/text/chevron and
/// everything behind the row stay fully transparent. Never a background, never
/// an unmasked overlay. Inactive (settled) rows and Reduce Motion render the
/// content untouched.
@available(iOS 17.0, *)
struct AgentGlyphShimmerModifier: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let period: Double = 1.8

    func body(content: Content) -> some View {
        if active && !reduceMotion {
            content
                .overlay(
                    GeometryReader { g in
                        TimelineView(.animation) { context in
                            let phase = context.date.timeIntervalSinceReferenceDate
                                .truncatingRemainder(dividingBy: Self.period) / Self.period
                            let band = max(44, g.size.width * 0.3)   // narrow highlight
                            let travel = g.size.width + band * 2
                            LinearGradient(colors: [.clear, .white.opacity(0.9), .clear],
                                           startPoint: .leading, endPoint: .trailing)
                                .frame(width: band)
                                .offset(x: -band + travel * phase)
                        }
                    }
                    .mask(content)          // gradient exists ONLY inside the glyphs
                    .allowsHitTesting(false)
                )
        } else {
            content
        }
    }
}

/// The glossy tool I/O sheet — glides up from the bottom (web GlassSheet parity).
@available(iOS 17.0, *)
struct AgentToolIOSheet: View {
    let tool: AgentChatMessage.Tool
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let pal = AgentPalette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "wrench.and.screwdriver")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(AgentPalette.coral)
                Text(tool.name)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(pal.ink)
                    .lineLimit(1)
                if tool.ok == false {
                    badge("ব্যর্থ", fg: Color(red: 0.73, green: 0.11, blue: 0.11),
                          bg: Color.red.opacity(0.12), border: Color.red.opacity(0.3))
                } else if !tool.live {
                    badge("সম্পন্ন", fg: Color(red: 0.08, green: 0.50, blue: 0.24),
                          bg: AgentPalette.teal.opacity(0.14), border: AgentPalette.teal.opacity(0.3))
                }
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(pal.muted)
                        .frame(width: 30, height: 30)
                        .background(Color.white.opacity(0.06), in: Circle())
                }
            }
            .padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 10)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if tool.inputPretty == nil && tool.resultFull == nil && tool.preview == nil {
                        Text("এই টুলের কোনো ইনপুট/ফলাফল নেই।")
                            .font(.system(size: 12))
                            .foregroundStyle(pal.muted)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 24)
                    }
                    if let input = tool.inputPretty, !input.isEmpty {
                        ioBlock(label: "ইনপুট · INPUT", body: input, pal: pal, failed: false)
                    }
                    if let out = tool.resultFull ?? tool.preview, !out.isEmpty {
                        ioBlock(label: "ফলাফল · OUTPUT", body: out, pal: pal, failed: tool.ok == false)
                    }
                }
                .padding(.horizontal, 20).padding(.bottom, 24)
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(26)
        .presentationBackground {
            Color(red: 0.23, green: 0.23, blue: 0.275).opacity(0.42)
                .background(.ultraThinMaterial)
        }
    }

    private func badge(_ text: String, fg: Color, bg: Color, border: Color) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(fg)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(bg, in: Capsule())
            .overlay(Capsule().strokeBorder(border, lineWidth: 1))
    }

    @ViewBuilder private func ioBlock(label: String, body text: String, pal: AgentPalette, failed: Bool) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.8)
                .foregroundStyle(pal.muted.opacity(0.7))
            ScrollView {
                Text(text)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(failed ? Color.red.opacity(0.85) : pal.ink.opacity(0.85))
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .frame(maxHeight: 300)
            .background(Color.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.white.opacity(0.06), lineWidth: 1))
        }
    }
}

// MARK: - Thought process / Summary bottom sheet (Claude iOS parity)

/// Opens when the owner taps a compact 🕐 Thinking / 🔍 Searched / settled summary row.
@available(iOS 17.0, *)
struct AgentActivitySheetRequest: Identifiable, Equatable {
    enum Kind: Equatable { case thoughtProcess, summary }

    let message: AgentChatMessage
    let kind: Kind
    var id: String { "\(message.id)-\(kind == .thoughtProcess ? "thought" : "summary")" }
}

@available(iOS 17.0, *)
struct AgentThoughtProcessSheet: View {
    let request: AgentActivitySheetRequest
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @State private var openItems: Set<Int> = []

    private var message: AgentChatMessage { request.message }

    var body: some View {
        let pal = AgentPalette(scheme)
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(pal.muted)
                        .frame(width: 32, height: 32)
                        .background(Color.white.opacity(0.06), in: Circle())
                }
                Spacer()
                Text(request.kind == .thoughtProcess ? "Thought process" : "Summary")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(pal.ink)
                Spacer()
                Color.clear.frame(width: 32, height: 32)
            }
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 10)
            // Claude iOS: hair-thin coral rule under the sheet header.
            Rectangle()
                .fill(AgentPalette.coral.opacity(0.35))
                .frame(height: 1)
                .padding(.bottom, 2)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if request.kind == .thoughtProcess {
                        thoughtProcessBody(pal)
                    } else {
                        summaryTimelineBody(pal)
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 28)
            }
        }
        .presentationDetents(request.kind == .thoughtProcess ? [.large] : [.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(22)
        .presentationBackground {
            // LOCKED §7 — glossy floating glass (model-switcher tone), aurora bleeds through.
            Color(red: 0.23, green: 0.23, blue: 0.275).opacity(0.42)
                .background(.ultraThinMaterial)
        }
    }

    @ViewBuilder private func thoughtProcessBody(_ pal: AgentPalette) -> some View {
        let prose = combinedThinkingText
        if prose.isEmpty {
            Text("এখনো কোনো চিন্তার বিবরণ নেই।")
                .font(.system(size: 13))
                .foregroundStyle(pal.muted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
        } else {
            // Claude iOS: the thought is plain prose on the sheet — no box around it.
            Text(prose)
                .font(.system(size: 15, design: .serif))
                .foregroundStyle(pal.ink.opacity(0.92))
                .lineSpacing(6)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 10)
        }
    }

    @ViewBuilder private func summaryTimelineBody(_ pal: AgentPalette) -> some View {
        if summaryItems.isEmpty {
            Text("এই টার্নে কোনো কার্যকলাপ নেই।")
                .font(.system(size: 13))
                .foregroundStyle(pal.muted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
        } else {
            summaryHeader(pal)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(summaryItems.enumerated()), id: \.offset) { idx, item in
                    summaryItemRow(item, index: idx, isLast: idx == summaryItems.count - 1, pal: pal)
                }
            }
        }
    }

    @ViewBuilder private func summaryHeader(_ pal: AgentPalette) -> some View {
        let steps = max(message.tools.count, message.phases.count, 1)
        let tok = max(1, combinedThinkingText.count / 4)
        HStack(spacing: 8) {
            Image(systemName: "clock")
                .font(.system(size: 13))
                .foregroundStyle(pal.muted)
            Text(summaryHeaderText(steps: steps, tokens: tok))
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(pal.muted)
            Spacer()
            Text("\(almaBn(steps)) ধাপ")
                .font(.system(size: 10))
                .foregroundStyle(pal.muted.opacity(0.8))
                .padding(.horizontal, 8).padding(.vertical, 2)
                .background(pal.muted.opacity(0.10), in: Capsule())
        }
        .padding(.top, 10)
        .padding(.bottom, 14)
    }

    private func summaryHeaderText(steps: Int, tokens: Int) -> String {
        if let ms = message.thinkingMs, ms > 0 {
            return "\(almaBn(max(1, ms / 1000))) সেকেন্ড ধরে ভেবেছে · ~\(almaBn(tokens)) টোকেন"
        }
        return "\(almaBn(steps)) ধাপ · কাজ সম্পন্ন"
    }

    /// Claude iOS Summary row: SF icon on a thin connector line, title, trailing
    /// chevron; the detail (thought text / tool I/O) expands on tap.
    @ViewBuilder private func summaryItemRow(_ item: SummaryItem, index: Int, isLast: Bool, pal: AgentPalette) -> some View {
        let open = openItems.contains(index)
        let hasDetail = (item.body?.isEmpty == false) || (item.input?.isEmpty == false)
            || (item.output?.isEmpty == false)
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 2) {
                Image(systemName: item.icon)
                    .font(.system(size: 13))
                    .foregroundStyle(item.tint)
                    .frame(width: 22, height: 22)
                if !isLast {
                    Rectangle()
                        .fill(Color.white.opacity(0.10))
                        .frame(width: 1.5)
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(width: 22)
            VStack(alignment: .leading, spacing: 6) {
                Button {
                    guard hasDetail else { return }
                    UISelectionFeedbackGenerator().selectionChanged()
                    withAnimation(.easeOut(duration: 0.18)) {
                        if open { openItems.remove(index) } else { openItems.insert(index) }
                    }
                } label: {
                    HStack(spacing: 8) {
                        Text(item.title)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(pal.ink)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 4)
                        if hasDetail {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(pal.muted.opacity(0.55))
                                .rotationEffect(.degrees(open ? 90 : 0))
                        }
                    }
                    .padding(.vertical, 2)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if open {
                    if let body = item.body, !body.isEmpty {
                        Text(body)
                            .font(.system(size: 13))
                            .foregroundStyle(pal.mutedHi)
                            .lineSpacing(5)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if let input = item.input, !input.isEmpty {
                        sheetIOBlock(label: "ইনপুট · INPUT", text: input, pal: pal, failed: false)
                    }
                    if let output = item.output, !output.isEmpty {
                        sheetIOBlock(label: "ফলাফল · OUTPUT", text: output, pal: pal, failed: item.failed)
                    }
                }
            }
            .padding(.bottom, isLast ? 0 : 18)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private func sheetIOBlock(label: String, text: String, pal: AgentPalette, failed: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.8)
                .foregroundStyle(pal.muted.opacity(0.7))
            Text(text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(failed ? Color.red.opacity(0.85) : pal.ink.opacity(0.85))
                .lineSpacing(3)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Color.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    private var combinedThinkingText: String {
        if let t = message.thinking?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
            return t
        }
        let chunks = message.timeline.compactMap { e -> String? in
            if case .think(let t) = e {
                let s = t.trimmingCharacters(in: .whitespacesAndNewlines)
                return s.isEmpty ? nil : s
            }
            return nil
        }
        return chunks.joined(separator: "\n\n")
    }

    private struct SummaryItem {
        let icon: String            // SF Symbol name — never emoji
        let title: String
        let body: String?
        let input: String?
        let output: String?
        let isThought: Bool
        let failed: Bool
        var tint: Color {
            if failed { return .red }
            if icon == "magnifyingglass" { return Color(red: 0.831, green: 0.659, blue: 0.294) } // gold
            if icon == "wrench.and.screwdriver" { return AgentPalette.teal }
            return Color.gray.opacity(0.7)
        }
    }

    private var summaryItems: [SummaryItem] {
        var out: [SummaryItem] = []
        var sawSearch = false
        var pendingThink: String?

        func flushThink() {
            guard let t = pendingThink else { return }
            out.append(.init(icon: "clock", title: AgentChatMessage.thinkLabel(t),
                             body: t, input: nil, output: nil, isThought: true, failed: false))
            pendingThink = nil
        }

        for e in message.timeline {
            switch e {
            case .think(let t):
                let line = t.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !line.isEmpty else { continue }
                if pendingThink == nil { pendingThink = line }
                else { pendingThink! += "\n\n" + line }
            case .tool(let id, let name, let ok, _, let input, let result):
                flushThink()
                if !sawSearch {
                    out.append(.init(icon: "magnifyingglass", title: "Searched available tools",
                                     body: nil, input: nil, output: nil,
                                     isThought: false, failed: false))
                    sawSearch = true
                }
                let tool = message.tools.first { $0.id == id }
                out.append(.init(icon: "wrench.and.screwdriver", title: name,
                                 body: nil,
                                 input: input ?? tool?.inputPretty,
                                 output: result ?? tool?.resultFull ?? tool?.preview,
                                 isThought: false, failed: ok == false))
            case .file(_, let name):
                flushThink()
                out.append(.init(icon: "doc.text", title: name, body: nil, input: nil, output: nil,
                                 isThought: false, failed: false))
            }
        }
        flushThink()

        if out.isEmpty, !message.phases.isEmpty {
            for p in message.phases {
                if let d = p.detail, !d.isEmpty {
                    out.append(.init(icon: "clock", title: p.headline, body: d,
                                     input: nil, output: nil, isThought: true, failed: false))
                }
                for t in p.tools {
                    out.append(.init(icon: "wrench.and.screwdriver", title: t.name, body: nil,
                                     input: t.inputPretty, output: t.resultFull ?? t.preview,
                                     isThought: false, failed: t.ok == false))
                }
            }
        }
        return out
    }
}

/// LOCKED §4 — ALMA wordmark (Claude Lottie parity): reply settles → burst pop-in
/// (scale 0→1 + spin) → A·L·M·A letters stagger-slide out from behind it and STAY;
/// next send → letters retract INTO the burst while the loader takes over.
@available(iOS 17.0, *)
struct AgentBrandWordmark: View {
    let animateReveal: Bool          // true only on the just-settled reply
    let isCurrent: Bool              // ONE burst per session — only the last settled reply has it
    let vm: AssistantVM
    @State private var shown = false
    @State private var retracted = false
    private static let letters = ["A", "L", "M", "A"]

    var body: some View {
        if isCurrent { currentBody } else { staticBody }
    }

    /// Idle/settled wordmark colours — the SAME loader aura (blue→violet→magenta→
    /// coral), but STATIC: owner rule 2026-07-12, "idle-এ শুধু রংটা বদলাবে" (no
    /// animation once the reply has settled).
    static let idleGradient = LinearGradient(
        colors: AlmaRayBurst.colors,
        startPoint: .leading, endPoint: .trailing)

    /// Older replies: the burst has moved on — small multicolour ALMA text only.
    private var staticBody: some View {
        Text("ALMA")
            .font(.system(size: 11, weight: .bold))
            .tracking(1.4)
            .foregroundStyle(Self.idleGradient)
            .opacity(0.75)
    }

    private var currentBody: some View {
        HStack(spacing: 5) {
            AlmaStarburstLoader(mode: .idle, size: 15)
                .scaleEffect(shown ? 1 : 0.01)
                .rotationEffect(.degrees(shown ? 0 : -300))
            HStack(spacing: 0.5) {
                ForEach(Array(Self.letters.enumerated()), id: \.offset) { i, ch in
                    Text(ch)
                        .font(.system(size: 11.5, weight: .bold))
                        .tracking(1.6)
                        // Per-letter slice of the loader aura so the settled
                        // wordmark reads multicolour, matching the burst beside it.
                        .foregroundStyle(AlmaRayBurst.colors[min(i + 1, AlmaRayBurst.colors.count - 1)])
                        .opacity(shown && !retracted ? 1 : 0)
                        .offset(x: shown && !retracted ? 0 : -14)
                        .animation(.spring(response: 0.5, dampingFraction: 0.86)
                            .delay(retracted ? Double(3 - i) * 0.06 : 0.12 + Double(i) * 0.07),
                                   value: shown && !retracted)
                }
            }
            .clipped()
        }
        .onAppear {
            if animateReveal {
                withAnimation(.spring(response: 0.6, dampingFraction: 0.72)) { shown = true }
                AlmaAgentTickHaptic.settleThud()
            } else {
                var tx = Transaction(); tx.disablesAnimations = true
                withTransaction(tx) { shown = true }
            }
        }
        .onChange(of: vm.isStreaming) { _, streaming in
            // পরের message → letters উল্টো stagger-এ burst-এর ভিতরে ঢুকে যায়।
            if streaming && animateReveal { retracted = true }
        }
    }
}

/// ALMA wordmark + relative time + copy + listen + token cost (web action row).
@available(iOS 17.0, *)
struct AgentMessageActions: View {
    let message: AgentChatMessage
    let vm: AssistantVM
    let pal: AgentPalette
    @State private var copied = false

    var body: some View {
        HStack(spacing: 6) {
            AgentBrandWordmark(
                animateReveal: vm.justSettledId == message.id,
                isCurrent: vm.messages.last(where: {
                    $0.role == .assistant && !$0.isStreaming && !$0.text.isEmpty
                })?.id == message.id,
                vm: vm)
            if let rel = relativeTime(message.createdAt) {
                Text(rel).font(.system(size: 10)).foregroundStyle(pal.muted)
            }
            Button {
                UIPasteboard.general.string = message.text
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                withAnimation(.spring(response: 0.25, dampingFraction: 0.6)) { copied = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { copied = false }
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 12))
                    .foregroundStyle(copied ? AgentPalette.teal : pal.muted)
                    .frame(width: 28, height: 28)
            }
            Button {
                vm.toggleTTS(for: message)
            } label: {
                Group {
                    if vm.ttsLoadingId == message.id {
                        AlmaMiniLoader(mode: .thinking, size: 14)
                    } else if vm.ttsPlayingId == message.id {
                        AgentPlayingBars()
                    } else {
                        Image(systemName: "speaker.wave.2")
                            .font(.system(size: 12))
                            .foregroundStyle(pal.muted)
                    }
                }
                .frame(width: 28, height: 28)
                .background(vm.ttsPlayingId == message.id ? AgentPalette.coral.opacity(0.1) : .clear,
                            in: RoundedRectangle(cornerRadius: 8))
            }
            Spacer()
            if let tin = message.tokensIn {
                Text("↑\(tin)\(message.tokensOut.map { " ↓\($0)" } ?? "")\(message.costUsd.map { " $\($0)" } ?? "")")
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(pal.muted.opacity(0.8))
                    .lineLimit(1)
            }
        }
        .padding(.top, 2)
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
        if mins < 1440 { return "\(almaBn(mins / 60)) ঘণ্টা আগে" }
        return "\(almaBn(mins / 1440)) দিন আগে"
    }
}

/// Two dancing bars while TTS is playing (web parity).
@available(iOS 17.0, *)
struct AgentPlayingBars: View {
    @State private var up = false
    var body: some View {
        HStack(spacing: 2.5) {
            Capsule().fill(AgentPalette.coral).frame(width: 3, height: up ? 13 : 6)
            Capsule().fill(AgentPalette.coral).frame(width: 3, height: up ? 6 : 13)
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.35).repeatForever(autoreverses: true)) { up = true }
        }
    }
}

@available(iOS 17.0, *)
struct AgentConfirmCardView: View {
    let card: AgentChatMessage.ConfirmCard
    let pal: AgentPalette
    let vm: AssistantVM
    let onDecide: (Bool) -> Void
    @State private var showOpinion = false
    @State private var opinionText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "bell.badge.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(AgentPalette.coral)
                Text("অনুমোদন দরকার")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(AgentPalette.coral)
                Spacer()
                if let c = card.costEstimate, c > 0 {
                    Text(String(format: "~$%.2f", c)).font(.system(size: 10.5)).foregroundStyle(pal.muted)
                }
            }
            .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 8)
            Text(card.summary)
                .font(.system(size: 14)).foregroundStyle(pal.ink).lineSpacing(3)
                .padding(.horizontal, 16).padding(.bottom, 12)
            if card.status == "pending" {
                if showOpinion {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 6) {
                            Image(systemName: "pencil.line")
                                .font(.system(size: 12))
                                .foregroundStyle(pal.mutedHi)
                            Text("আপনার মত লিখুন")
                                .font(.system(size: 12, weight: .semibold)).foregroundStyle(pal.mutedHi)
                        }
                        TextField("আপনার মতামত…", text: $opinionText, axis: .vertical)
                            .font(.system(size: 14)).lineLimit(2...4)
                            .padding(10)
                            .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(pal.borderSubtle))
                        HStack(spacing: 8) {
                            Button {
                                Task { await vm.submitOpinion(card.id, note: opinionText) }
                            } label: {
                                Text("পাঠান")
                                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                                    .padding(.horizontal, 16).padding(.vertical, 8)
                                    .background(AgentPalette.coral, in: Capsule())
                            }
                            .disabled(opinionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            Button { showOpinion = false } label: {
                                Text("বাতিল").font(.system(size: 13)).foregroundStyle(pal.muted)
                            }
                        }
                    }
                    .padding(.horizontal, 16).padding(.bottom, 14)
                } else {
                    VStack(spacing: 0) {
                        HStack(spacing: 8) {
                            Button { onDecide(true) } label: {
                                Text("অনুমোদন")
                                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                                    .background(AgentPalette.coral, in: RoundedRectangle(cornerRadius: 12))
                            }
                            Button { onDecide(false) } label: {
                                Text("বাতিল")
                                    .font(.system(size: 13, weight: .medium)).foregroundStyle(pal.muted)
                                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                                    .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(pal.borderSubtle))
                            }
                        }
                        .padding(.horizontal, 16).padding(.bottom, 10)
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            showOpinion = true
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "text.bubble")
                                    .font(.system(size: 13))
                                    .foregroundStyle(AgentPalette.coral.opacity(0.9))
                                Text("আমার মত")
                                    .font(.system(size: 14, weight: .medium)).foregroundStyle(pal.ink)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(pal.muted.opacity(0.5))
                            }
                            .padding(.horizontal, 16).padding(.vertical, 12)
                        }
                        .buttonStyle(.plain)
                        .overlay(alignment: .top) { Rectangle().fill(pal.borderSubtle).frame(height: 1) }
                    }
                }
            } else {
                HStack(spacing: 5) {
                    Image(systemName: statusIcon).font(.system(size: 11))
                    Text(statusLabel).font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(statusColor)
                .padding(.horizontal, 16).padding(.bottom, 14)
            }
        }
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
            .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
        .shadow(color: .black.opacity(0.25), radius: 16, y: 6)
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
    var pageIndex: Int? = nil          // 0-based; nil = single card, no pager header
    var pageCount: Int = 1
    var onPrev: (() -> Void)? = nil
    var onNext: (() -> Void)? = nil
    var onClose: (() -> Void)? = nil
    let onAnswer: (String) -> Void
    @State private var chosen: String?
    @State private var otherActive = false
    @State private var otherText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if card.status == "pending" {
                // Claude header: ‹ 1 of 3 › left, circular ✕ right.
                if pageIndex != nil || onClose != nil {
                    HStack(spacing: 4) {
                        if let idx = pageIndex, pageCount > 1 {
                            Button { onPrev?() } label: {
                                Image(systemName: "chevron.left")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(idx > 0 ? pal.ink : pal.muted.opacity(0.35))
                                    .frame(width: 28, height: 28)
                            }
                            .disabled(idx == 0)
                            Text("\(almaBn(idx + 1)) / \(almaBn(pageCount))")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(pal.muted)
                            Button { onNext?() } label: {
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(idx < pageCount - 1 ? pal.ink : pal.muted.opacity(0.35))
                                    .frame(width: 28, height: 28)
                            }
                            .disabled(idx >= pageCount - 1)
                        }
                        Spacer()
                        if let onClose {
                            Button {
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                onClose()
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(pal.muted)
                                    .frame(width: 28, height: 28)
                                    .background(Color.white.opacity(0.06), in: Circle())
                            }
                        }
                    }
                    .padding(.horizontal, 12).padding(.top, 10)
                }
                Text(card.question)
                    .font(.system(size: 15.5, weight: .semibold, design: .serif))
                    .foregroundStyle(pal.ink)
                    .lineSpacing(3)
                    .padding(.horizontal, 18)
                    .padding(.top, pageIndex != nil || onClose != nil ? 6 : 18)
                    .padding(.bottom, 10)
                VStack(spacing: 0) {
                    ForEach(Array(card.options.enumerated()), id: \.offset) { idx, opt in
                        let active = !otherActive && chosen == opt
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            chosen = opt; otherActive = false
                            onAnswer(opt)
                        } label: {
                            HStack(spacing: 12) {
                                // Claude: option number sits in a small frosted circle.
                                Text("\(almaBn(idx + 1))")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(active ? .white : pal.mutedHi)
                                    .frame(width: 26, height: 26)
                                    .background(active ? AnyShapeStyle(AgentPalette.coral)
                                                       : AnyShapeStyle(Color.white.opacity(0.07)),
                                                in: Circle())
                                    .overlay(Circle().strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
                                Text(opt)
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(pal.ink)
                                    .multilineTextAlignment(.leading)
                                Spacer()
                            }
                            .padding(.horizontal, 16).padding(.vertical, 12)
                        }
                        .buttonStyle(.plain)
                        if idx < card.options.count - 1 {
                            Rectangle().fill(Color.white.opacity(0.06)).frame(height: 1).padding(.leading, 18)
                        }
                    }
                    Rectangle().fill(Color.white.opacity(0.06)).frame(height: 1)
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        otherActive = true; chosen = nil
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "pencil")
                                .font(.system(size: 13))
                                .foregroundStyle(pal.muted)
                                .frame(width: 26, alignment: .center)
                            Text("Type your answer…")
                                .font(.system(size: 14)).foregroundStyle(otherActive ? pal.ink : pal.muted)
                            Spacer()
                        }
                        .padding(.horizontal, 16).padding(.vertical, 13)
                    }
                    .buttonStyle(.plain)
                    if otherActive {
                        HStack(spacing: 8) {
                            TextField("আপনার মতামত…", text: $otherText)
                                .font(.system(size: 14))
                                .padding(10)
                                .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                            Button {
                                let t = otherText.trimmingCharacters(in: .whitespacesAndNewlines)
                                guard !t.isEmpty else { return }
                                onAnswer(t)
                            } label: {
                                Image(systemName: "arrow.up.circle.fill")
                                    .font(.system(size: 28))
                                    .foregroundStyle(AgentPalette.coral)
                            }
                        }
                        .padding(.horizontal, 18).padding(.bottom, 14)
                    }
                }
            } else if let sel = card.selectedOption {
                VStack(alignment: .leading, spacing: 6) {
                    Text(card.question).font(.system(size: 13)).foregroundStyle(pal.muted)
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark.circle.fill").font(.system(size: 12))
                        Text(sel).font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(AgentPalette.coral)
                }
                .padding(18)
            }
        }
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous)
            .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
        .shadow(color: .black.opacity(0.28), radius: 18, y: 8)
    }
}

/// Multiple ask cards → Claude "1 of N" pager: one card at a time, ‹ › to flip,
/// ✕ collapses into a small reopen chip (the composer still works regardless).
@available(iOS 17.0, *)
struct AgentAskCardsPager: View {
    let cards: [AgentChatMessage.AskCard]
    let pal: AgentPalette
    let onAnswer: (AgentChatMessage.AskCard, String) -> Void
    @State private var index = 0
    @State private var closed = false

    var body: some View {
        let idx = min(index, max(0, cards.count - 1))
        let card = cards[idx]
        Group {
            if closed {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation(.snappy(duration: 0.22)) { closed = false }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "questionmark.circle")
                            .font(.system(size: 12, weight: .medium))
                        Text(cards.count > 1 ? "প্রশ্ন কার্ড · \(almaBn(cards.count))টি" : "প্রশ্ন কার্ড")
                            .font(.system(size: 12, weight: .semibold))
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .opacity(0.6)
                    }
                    .foregroundStyle(AgentPalette.coral)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(AgentPalette.coral.opacity(0.08), in: Capsule())
                    .overlay(Capsule().strokeBorder(AgentPalette.coral.opacity(0.3), lineWidth: 1))
                }
                .buttonStyle(.plain)
            } else {
                AgentAskCardView(
                    card: card, pal: pal,
                    pageIndex: cards.count > 1 ? idx : nil,
                    pageCount: cards.count,
                    onPrev: { withAnimation(.snappy(duration: 0.22)) { index = max(0, idx - 1) } },
                    onNext: { withAnimation(.snappy(duration: 0.22)) { index = min(cards.count - 1, idx + 1) } },
                    onClose: card.status == "pending"
                        ? { withAnimation(.snappy(duration: 0.22)) { closed = true } } : nil
                ) { option in
                    onAnswer(card, option)
                }
                .id("\(card.id)-\(idx)")
                .transition(.asymmetric(
                    insertion: .move(edge: .trailing).combined(with: .opacity),
                    removal: .opacity))
            }
        }
        .onChange(of: cards.map(\.status)) { _, statuses in
            // Answered → jump to the next still-pending card automatically.
            if statuses.indices.contains(idx), statuses[idx] != "pending",
               let next = statuses.firstIndex(of: "pending") {
                withAnimation(.snappy(duration: 0.22)) { index = next }
            }
        }
    }
}

/// One compact Claude-iOS activity row: small outline SF icon + muted label +
/// trailing chevron. No emoji, no spinner — just like the Claude app rows.
@available(iOS 17.0, *)
struct AgentCompactActivityRow: View {
    let icon: String
    let label: String
    var italic = false
    var labelColor: Color
    var iconColor: Color
    var failed = false
    var shimmer = false            // live headline while the model is thinking (Claude)
    let onTap: () -> Void

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            onTap()
        } label: {
            HStack(spacing: 8) {
                // Icon + headline + chevron grouped so the live glyph-shimmer band
                // is masked to exactly these shapes — never the row bounds.
                // (Approved build-70 demo — supersedes build-68's AlmaShimmerText row.)
                HStack(spacing: 8) {
                    Image(systemName: failed ? "xmark.circle" : icon)
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(failed ? Color.red.opacity(0.8) : iconColor)
                        .frame(width: 18, alignment: .center)
                    // Claude: chevron hugs the text; long labels truncate well before the
                    // screen edge (trailing gap keeps the row ending ~mid-right, never edge).
                    Text(label)
                        .font(.system(size: 14, weight: italic ? .regular : .medium))
                        .italic(italic && !shimmer)   // live row was never italic (AlmaShimmerText parity)
                        .foregroundStyle(labelColor)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(labelColor.opacity(0.45))
                }
                .modifier(AgentGlyphShimmerModifier(active: shimmer))
                Spacer(minLength: 0)
            }
            .padding(.trailing, 96)
            .frame(minHeight: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Interleaved chronological turn content (Claude iOS): prose ↔ compact activity
/// rows grow together in SSE order, and the rows STAY after the turn settles
/// (tap → Thought process / Summary / tool I/O). Max 4 visible activity rows —
/// older ones collapse into a single "আগের N ধাপ" row.
@available(iOS 17.0, *)
struct AgentTurnBlocksView: View {
    let message: AgentChatMessage
    let pal: AgentPalette
    let vm: AssistantVM
    let onToolTap: (AgentChatMessage.Tool) -> Void
    let onActivitySheet: (AgentActivitySheetRequest.Kind) -> Void

    private static let maxVisibleRows = 4

    var body: some View {
        let activityIds: [String] = message.blocks.compactMap {
            if case .activity = $0 { return $0.id }
            return nil
        }
        let hiddenCount = max(0, activityIds.count - Self.maxVisibleRows)
        let hidden = Set(activityIds.prefix(hiddenCount))
        let lastBlockId = message.blocks.last?.id
        VStack(alignment: .leading, spacing: 6) {
            ForEach(message.blocks) { block in
                switch block {
                case .prose(let id, let text):
                    proseBlock(text, isTail: id == lastBlockId && message.isStreaming)
                case .file(_, let artifactId, let name):
                    AgentArtifactFileCard(artifactId: artifactId, name: name, vm: vm, pal: pal)
                case .activity(let a):
                    if hidden.contains(a.id) {
                        if a.id == activityIds[hiddenCount - 1] {
                            AgentCompactActivityRow(icon: "clock.arrow.circlepath",
                                                    label: "আগের \(almaBn(hiddenCount)) ধাপ",
                                                    labelColor: pal.muted, iconColor: pal.muted) {
                                onActivitySheet(.summary)
                            }
                        }
                    } else {
                        activityRow(a, isTail: block.id == lastBlockId && message.isStreaming)
                    }
                }
            }
        }
    }

    @ViewBuilder private func proseBlock(_ text: String, isTail: Bool) -> some View {
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if isTail {
                HStack(alignment: .bottom, spacing: 2) {
                    AgentMarkdownText(text: text, pal: pal)
                        .modifier(AgentShimmerModifier())
                    AgentTypingCursor()
                }
                .padding(.vertical, 2)
            } else {
                AgentMarkdownText(text: text, pal: pal)
                    .padding(.vertical, 2)
                    .contentShape(Rectangle())
                    // Owner issue #6 (build 69): tap-and-hold anywhere on agent
                    // prose → Copy with haptic, Claude-app style.
                    .contextMenu {
                        Button {
                            UIPasteboard.general.string = text
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        } label: {
                            Label("কপি করুন", systemImage: "doc.on.doc")
                        }
                        if message.text.trimmingCharacters(in: .whitespacesAndNewlines) != text
                            .trimmingCharacters(in: .whitespacesAndNewlines), !message.text.isEmpty {
                            Button {
                                UIPasteboard.general.string = message.text
                                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            } label: {
                                Label("পুরো উত্তর কপি করুন", systemImage: "doc.on.doc.fill")
                            }
                        }
                    }
            }
        }
    }

    @ViewBuilder private func activityRow(_ a: AgentChatMessage.ActivityBlock, isTail: Bool = false) -> some View {
        switch a.kind {
        case .thinking:
            // Tail thinking row = the LIVE changing headline → shimmer (Claude parity).
            AgentCompactActivityRow(icon: "clock", label: a.label, italic: true,
                                    labelColor: pal.muted, iconColor: pal.muted,
                                    shimmer: isTail) {
                onActivitySheet(.thoughtProcess)
            }
        case .search:
            AgentCompactActivityRow(icon: "magnifyingglass", label: a.label,
                                    labelColor: pal.muted, iconColor: pal.muted) {
                onActivitySheet(.summary)
            }
        case .tool:
            // A step still RUNNING (no result yet) shimmers its icon+title while it
            // is the live tail — Claude Code's active-step headline (owner ask
            // 2026-07-12); the shimmer drops the moment tool_end lands (ok != nil).
            AgentCompactActivityRow(icon: "wrench.and.screwdriver", label: a.label,
                                    labelColor: pal.mutedHi, iconColor: pal.muted,
                                    failed: a.ok == false,
                                    shimmer: isTail && a.ok == nil) {
                if let t = message.tools.first(where: { $0.id == a.toolId }) {
                    onToolTap(t)
                } else {
                    onActivitySheet(.summary)
                }
            }
        }
    }
}

/// Live pinned work summary while the turn streams (web ActivityTimeline parity,
/// restored for iOS 2026-07-12): "কাজ করছি… · ~N টোকেন · N ধাপ" with the token
/// estimate advancing live (thinking+text chars / 4), settling into the real
/// ↑in ↓out counts on the message actions row once the turn finishes.
@available(iOS 17.0, *)
struct AgentLiveWorkSummaryRow: View {
    let message: AgentChatMessage
    let pal: AgentPalette

    private static let gold = Color(red: 0.831, green: 0.659, blue: 0.294)

    var body: some View {
        HStack(spacing: 6) {
            // Slim rotating arc (web: border-gold spinner), time-driven.
            TimelineView(.animation) { context in
                let angle = context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: 0.8) / 0.8 * 360
                Circle()
                    .trim(from: 0, to: 0.72)
                    .stroke(Self.gold.opacity(0.85), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    .frame(width: 11, height: 11)
                    .rotationEffect(.degrees(angle))
            }
            .frame(width: 12, height: 12)
            Text(liveSummary)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(pal.muted)
                .lineLimit(1)
                .contentTransition(.numericText())
            Spacer(minLength: 0)
        }
        .padding(.bottom, 2)
    }

    private var liveSummary: String {
        let chars = (message.thinking ?? "").count + message.text.count
        let tok = max(0, chars / 4)
        let steps = message.blocks.reduce(into: 0) { n, b in
            if case .activity = b { n += 1 }
        }
        var s = "কাজ করছি…"
        if tok > 0 { s += " · ~\(almaBnCompact(tok)) টোকেন" }
        if steps > 0 { s += " · \(almaBn(steps)) ধাপ" }
        return s
    }
}

/// Compact Bangla token figure — web fmtTok parity: 36100 → "৩৬.১k", 681 → "৬৮১".
func almaBnCompact(_ n: Int) -> String {
    guard n >= 1000 else { return almaBn(n) }
    let whole = n / 1000
    let tenth = (n % 1000) / 100
    let head = tenth > 0 ? "\(almaBn(whole)).\(almaBn(tenth))" : almaBn(whole)
    return "\(head)k"
}

/// One-line settled summary when timeline metadata exists but rows are collapsed.
@available(iOS 17.0, *)
struct AgentSettledSummaryRow: View {
    let message: AgentChatMessage
    let pal: AgentPalette
    let onTap: () -> Void

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            onTap()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "clock")
                    .font(.system(size: 13))
                    .foregroundStyle(pal.muted)
                    .frame(width: 18, alignment: .center)
                Text(summaryText)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(pal.muted)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(pal.muted.opacity(0.5))
            }
            .frame(minHeight: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var summaryText: String {
        let steps = max(message.tools.count, message.phases.count)
        if let ms = message.thinkingMs, ms > 0 {
            let tok = max(1, ((message.thinking ?? "").count) / 4)
            return "\(almaBn(max(1, ms / 1000))) সেকেন্ড ধরে ভেবেছে · ~\(almaBn(tok)) টোকেন · \(almaBn(max(1, steps))) ধাপ"
        }
        if steps > 0 { return "\(almaBn(steps)) ধাপ · কাজ সম্পন্ন" }
        return "কাজ সম্পন্ন"
    }
}

/// Live indicator — approved multi-colour burst with the existing ALMA wordmark.
@available(iOS 17.0, *)
struct AgentThinkingRow: View {
    let mode: String
    let pal: AgentPalette

    var body: some View {
        HStack(spacing: 8) {
            AlmaSpinnerView(mode: mode, size: 28, showVerb: false, haptics: true)
            AlmaShimmerWordmark(size: 12.5, weight: .semibold, tracking: 2.1)
            Spacer()
        }
        .padding(.leading, 0)
        .padding(.bottom, 8)
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
    @State private var showModelPicker = false
    @FocusState private var focused: Bool

    var body: some View {
        let pal = AgentPalette(scheme)
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                if !vm.pendingFiles.isEmpty && !vm.isRecording { attachmentsRow(pal) }
                if vm.isRecording {
                    recordingBar(pal)
                } else {
                    TextField(vm.transcribing ? "বুঝে নিচ্ছি…" : "বার্তা লিখুন…",
                              text: $draft, axis: .vertical)
                        .font(.system(size: 16))
                        .foregroundStyle(pal.ink)
                        .lineLimit(1...5)
                        .focused($focused)
                        .padding(.horizontal, 10)
                        .padding(.top, 8)
                    controlsRow(pal)
                }
            }
            .padding(8)
            .background(pal.glassFill)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(AgentNeonBorder(cornerRadius: 24))   // web agent-neon-input parity
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
        }
        .onChange(of: vm.dictatedText) { _, newValue in
            guard !newValue.isEmpty else { return }
            draft = draft.isEmpty ? newValue : draft + " " + newValue
            Task { @MainActor in vm.dictatedText = "" }
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

    /// Recording bar — web parity: ✕ cancel, live 34-bar waveform, mm:ss, ✓ confirm.
    @ViewBuilder private func recordingBar(_ pal: AgentPalette) -> some View {
        HStack(spacing: 8) {
            Button {
                vm.cancelRecording()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(pal.muted)
                    .frame(width: 36, height: 36)
            }
            AgentVoiceWaveform(vm: vm)
                .frame(height: 36)
                .frame(maxWidth: .infinity)
            Text(String(format: "%d:%02d", vm.recordingSeconds / 60, vm.recordingSeconds % 60))
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(pal.muted)
            Button {
                vm.toggleRecording()   // finish → Whisper
            } label: {
                Image(systemName: "checkmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(AgentPalette.coral, in: Circle())
            }
        }
        .padding(.vertical, 3)
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
                                    AlmaMiniLoader(mode: .thinking, size: 18)
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
            // Model picker pill — opens the native sheet with EVERY enabled model.
            Button {
                UISelectionFeedbackGenerator().selectionChanged()
                showModelPicker = true
            } label: {
                HStack(spacing: 3) {
                    Text(vm.modelPillLabel)
                        .font(.system(size: 10.5, weight: .medium))
                        .lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 7, weight: .semibold))
                }
                .foregroundStyle(vm.isAutoModel ? pal.muted : AgentPalette.coral)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(pal.card.opacity(0.5), in: Capsule())
                .overlay(Capsule().strokeBorder(
                    vm.isAutoModel ? pal.borderSubtle : AgentPalette.coral.opacity(0.35), lineWidth: 1))
                .frame(maxWidth: 150)
            }
            .disabled(vm.isStreaming)
            .sheet(isPresented: $showModelPicker) {
                AgentModelPickerSheet(vm: vm)
            }
            Spacer(minLength: 4)
            // mic → Whisper dictation
            Button { vm.toggleRecording() } label: {
                Group {
                    if vm.transcribing {
                        AlmaMiniLoader(mode: .thinking, size: 16)
                    } else {
                        Image(systemName: vm.isRecording ? "stop.fill" : "mic")
                            .font(.system(size: 15, weight: .medium))
                    }
                }
                .foregroundStyle(vm.isRecording ? .white : pal.muted)
                .frame(width: 36, height: 36)
                .background(vm.isRecording ? AnyShapeStyle(AgentPalette.coral) : AnyShapeStyle(.clear), in: Circle())
            }
            // voice-to-voice — the NATIVE orb console (AssistantVoiceSwiftUI.swift)
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                vm.showVoice = true
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

/// The composer's slowly-rotating conic "neon" border (web agent-neon-input:
/// coral → warm gold → cool blue arc sweeping 360° every 4.5s, 1.5px stroke).
@available(iOS 17.0, *)
struct AgentNeonBorder: View {
    var cornerRadius: CGFloat = 24
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 4.5) / 4.5
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(
                    AngularGradient(stops: [
                        .init(color: AgentPalette.coral.opacity(0), location: 0),
                        .init(color: AgentPalette.coral.opacity(0.85), location: 0.18),
                        .init(color: Color(red: 0.961, green: 0.784, blue: 0.471).opacity(0.95), location: 0.30),
                        .init(color: Color(red: 0.471, green: 0.784, blue: 0.961).opacity(0.85), location: 0.45),
                        .init(color: AgentPalette.coral.opacity(0), location: 0.62),
                        .init(color: AgentPalette.coral.opacity(0), location: 1),
                    ], center: .center, angle: .degrees(t * 360)),
                    lineWidth: 1.5)
        }
        .allowsHitTesting(false)
    }
}

/// Live recording waveform — 34 bars, 3px wide, coral, driven by the mic RMS level
/// (web VoiceWaveform parity: shift left, append the newest level each frame).
@available(iOS 17.0, *)
struct AgentVoiceWaveform: View {
    let vm: AssistantVM
    @State private var bars = [Double](repeating: 0.06, count: 34)
    private let timer = Timer.publish(every: 0.066, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: 3) {
            ForEach(bars.indices, id: \.self) { i in
                Capsule()
                    .fill(AgentPalette.coral)
                    .frame(width: 3, height: max(2.5, bars[i] * 34))
                    .opacity(0.3 + bars[i] * 0.7)
            }
        }
        .frame(maxWidth: .infinity)
        .clipped()
        .onReceive(timer) { _ in
            bars.removeFirst()
            bars.append(vm.micLevel)
        }
    }
}

/// Native model picker sheet — Auto + every enabled model, grouped by provider,
/// checkmark on the current pick. (Owner call: no explainer text — clean iOS list.)
@available(iOS 17.0, *)
struct AgentModelPickerSheet: View {
    @Bindable var vm: AssistantVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    private static let providers: [(key: String, label: String)] = [
        ("anthropic", "Anthropic"), ("google", "Google"),
        ("openai", "OpenAI"), ("openrouter", "OpenRouter"),
    ]

    var body: some View {
        let pal = AgentPalette(scheme)
        NavigationStack {
            List {
                Section {
                    row(label: "⚡ Auto", selected: vm.isAutoModel, pal: pal) {
                        vm.selectModel(nil)
                        dismiss()
                    }
                }
                ForEach(Self.providers, id: \.key) { provider in
                    let group = vm.models.filter { $0.provider == provider.key }
                    if !group.isEmpty {
                        Section(provider.label) {
                            ForEach(group) { m in
                                row(label: m.label, selected: vm.modelId == m.id, pal: pal) {
                                    vm.selectModel(m.id)
                                    dismiss()
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("মডেল")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("বন্ধ") { dismiss() }.font(.system(size: 14, weight: .medium))
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task { await vm.loadModels() }
    }

    @ViewBuilder private func row(label: String, selected: Bool, pal: AgentPalette,
                                  action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(label)
                    .font(.system(size: 15, weight: selected ? .semibold : .regular))
                    .foregroundStyle(selected ? AgentPalette.coral : pal.ink)
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(AgentPalette.coral)
                }
            }
        }
    }
}

// MARK: - Sidebar (conversation list + web escape hatches)

/// The chat-history drawer — slides in from the LEFT over a dimmed scrim, exactly
/// like the web AgentSidebar (w-72, rounded-r-24, spring 280/28): header with the
/// quick-access pills, চ্যাট/স্মৃতি tabs, project filter, চ্যাট/অফিস view switch,
/// search, conversation rows with rename/archive/delete, load-more, and the full
/// Memory tab (learned rules + finance summary + scoped memories with pin/delete).
@available(iOS 17.0, *)
struct AgentSideDrawer: View {
    @Bindable var vm: AssistantVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var scheme

    @State private var visible = false
    @State private var dragX: CGFloat = 0      // swipe-left-to-close (iOS drawer feel)
    @State private var tab = 0                 // 0 = চ্যাট, 1 = স্মৃতি
    @State private var chatView = 0            // 0 = regular, 1 = অফিস (day_shift)
    @State private var search = ""
    @State private var activeProject: String?  // nil = সব কথোপকথন
    @State private var memScope = "all"
    @State private var renameTarget: AgentConversation?
    @State private var renameText = ""
    @State private var deleteTarget: AgentConversation?
    @State private var deleteMemTarget: AgentMemoryRow?
    @State private var showProjectForm = false

    private static let drawerWidth: CGFloat = 288   // web w-72

    var body: some View {
        let pal = AgentPalette(scheme)
        ZStack(alignment: .leading) {
            Color.black.opacity(visible ? 0.30 : 0)
                .ignoresSafeArea()
                .onTapGesture { close() }
            drawer(pal)
                .frame(width: Self.drawerWidth)
                .frame(maxHeight: .infinity)
                .background(pal.glassFill)
                .background(.ultraThinMaterial)
                .clipShape(UnevenRoundedRectangle(topLeadingRadius: 0, bottomLeadingRadius: 0,
                                                  bottomTrailingRadius: 24, topTrailingRadius: 24,
                                                  style: .continuous))
                .shadow(color: .black.opacity(0.10), radius: 24, y: 4)
                .offset(x: (visible ? 0 : -(Self.drawerWidth + 40)) + min(0, dragX))
                .ignoresSafeArea(edges: .bottom)
                .gesture(
                    DragGesture()
                        .onChanged { v in dragX = v.translation.width }
                        .onEnded { v in
                            if v.translation.width < -60 { dragX = 0; close() }
                            else { withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { dragX = 0 } }
                        }
                )
        }
        .onAppear {
            withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) { visible = true }
            // conversations/projects are prefetched by presentDrawer BEFORE this
            // cover mounts — loading here made the open spring stutter.
            // DEBUG self-test hook (env only set by local simctl self-tests).
            if ProcessInfo.processInfo.environment["ALMA_ASSISTANT_MEMTAB"] == "1" {
                tab = 1
                Task { await vm.loadMemories(scope: memScope) }
            }
        }
        .alert("নাম পরিবর্তন", isPresented: .init(
            get: { renameTarget != nil }, set: { if !$0 { renameTarget = nil } })) {
            TextField("শিরোনাম", text: $renameText)
            Button("সংরক্ষণ") {
                if let t = renameTarget { Task { await vm.renameConversation(t.id, title: renameText) } }
                renameTarget = nil
            }
            Button("বাতিল", role: .cancel) { renameTarget = nil }
        }
        .alert("কথোপকথন মুছবেন?", isPresented: .init(
            get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } })) {
            Button("মুছুন", role: .destructive) {
                if let t = deleteTarget { Task { await vm.deleteConversation(t.id) } }
                deleteTarget = nil
            }
            Button("বাতিল", role: .cancel) { deleteTarget = nil }
        } message: {
            Text("এই কথোপকথন এবং সকল বার্তা স্থায়ীভাবে মুছে যাবে।")
        }
        .alert("স্মৃতি মুছবেন?", isPresented: .init(
            get: { deleteMemTarget != nil }, set: { if !$0 { deleteMemTarget = nil } })) {
            Button("মুছুন", role: .destructive) {
                if let t = deleteMemTarget { Task { await vm.deleteMemory(t.id) } }
                deleteMemTarget = nil
            }
            Button("বাতিল", role: .cancel) { deleteMemTarget = nil }
        } message: {
            Text("এই তথ্য স্থায়ীভাবে মুছে যাবে।")
        }
        .sheet(isPresented: $showProjectForm) {
            AgentProjectFormSheet(vm: vm)
        }
    }

    private func close() {
        withAnimation(.spring(response: 0.32, dampingFraction: 0.9)) { visible = false }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) {
            var tx = Transaction(); tx.disablesAnimations = true
            withTransaction(tx) { vm.showSidebar = false }
        }
    }

    private func closeThen(_ action: @escaping () -> Void) {
        close()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.34, execute: action)
    }

    // ── Drawer body ────────────────────────────────────────────────────────

    @ViewBuilder private func drawer(_ pal: AgentPalette) -> some View {
        VStack(spacing: 0) {
            // No web-style header — the sub-page shortcuts live on the AssistiveTouch
            // button (owner call), so the drawer opens straight into content, iOS-style.
            Capsule()
                .fill(pal.muted.opacity(0.35))
                .frame(width: 36, height: 4.5)
                .frame(maxWidth: .infinity)
                .padding(.top, 10)
            tabsBar(pal)
                .padding(.horizontal, 14)
                .padding(.top, 12)
            if tab == 0 { chatsTab(pal) } else { memoryTab(pal) }
        }
    }

    private func divider(_ pal: AgentPalette) -> some View {
        Rectangle().fill(pal.borderSubtle).frame(height: 1)
    }

    /// চ্যাট / স্মৃতি — a native pill segmented control with the app's coral accent.
    @ViewBuilder private func tabsBar(_ pal: AgentPalette) -> some View {
        HStack(spacing: 4) {
            tabButton("💬 চ্যাট", index: 0, pal: pal)
            tabButton("🧠 স্মৃতি", index: 1, pal: pal)
        }
        .padding(4)
        .background(Color.white.opacity(scheme == .dark ? 0.05 : 0.35), in: Capsule())
        .overlay(Capsule().strokeBorder(pal.borderSubtle, lineWidth: 1))
    }

    private func tabButton(_ label: String, index: Int, pal: AgentPalette) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            withAnimation(.snappy(duration: 0.2)) { tab = index }
            if index == 1 { Task { await vm.loadMemories(scope: memScope) } }
        } label: {
            Text(label)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tab == index ? .white : pal.muted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .background(tab == index ? AnyShapeStyle(AgentPalette.coral) : AnyShapeStyle(.clear),
                            in: Capsule())
        }
        .buttonStyle(.plain)
    }

    // ── চ্যাট tab ──────────────────────────────────────────────────────────

    private var officeCount: Int {
        vm.conversations.filter { $0.archived != true && $0.source == "day_shift" }.count
    }

    private var filteredConversations: [AgentConversation] {
        vm.conversations.filter { c in
            guard c.archived != true else { return false }
            if chatView == 1 { if c.source != "day_shift" { return false } }
            else if c.source == "day_shift" { return false }
            if let p = activeProject, c.projectId != p { return false }
            if !search.isEmpty {
                return (c.title ?? "").localizedCaseInsensitiveContains(search)
            }
            return true
        }
    }

    @ViewBuilder private func chatsTab(_ pal: AgentPalette) -> some View {
        VStack(spacing: 10) {
            // নতুন চ্যাট — one clear primary action, iOS-style filled capsule.
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                Task { await vm.newChat() }
                close()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "square.and.pencil").font(.system(size: 13, weight: .semibold))
                    Text("নতুন চ্যাট").font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
                .background(AgentPalette.coral, in: Capsule())
                .shadow(color: AgentPalette.coral.opacity(0.3), radius: 6, y: 2)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 14)
            .padding(.top, 12)

            // Search — native look: magnifier + rounded quiet field.
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13))
                    .foregroundStyle(pal.muted)
                TextField("খুঁজুন…", text: $search)
                    .font(.system(size: 15))
                    .foregroundStyle(pal.ink)
                if !search.isEmpty {
                    Button { search = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 13)).foregroundStyle(pal.muted.opacity(0.7))
                    }
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(Color.white.opacity(scheme == .dark ? 0.06 : 0.5),
                        in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .padding(.horizontal, 14)

            // চ্যাট / অফিস + প্রজেক্ট ফিল্টার — one compact control row.
            HStack(spacing: 8) {
                HStack(spacing: 3) {
                    chatViewButton("চ্যাট", index: 0, pal: pal)
                    chatViewButton(officeCount > 0 ? "🏢 \(almaBn(officeCount))" : "🏢", index: 1, pal: pal)
                }
                .padding(3)
                .background(Color.white.opacity(scheme == .dark ? 0.05 : 0.35), in: Capsule())
                .overlay(Capsule().strokeBorder(pal.borderSubtle, lineWidth: 1))
                Spacer()
                Menu {
                    Button("সব কথোপকথন") { activeProject = nil }
                    ForEach(vm.projects) { p in
                        Button(projectLabel(p)) { activeProject = p.id }
                    }
                    Divider()
                    Button { showProjectForm = true } label: {
                        Label("নতুন প্রজেক্ট", systemImage: "plus")
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "folder")
                            .font(.system(size: 11))
                        Text(activeProject.flatMap { id in vm.projects.first { $0.id == id } }
                            .map { String($0.name.prefix(12)) } ?? "সব")
                            .font(.system(size: 12, weight: .medium))
                            .lineLimit(1)
                        Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
                    }
                    .foregroundStyle(activeProject == nil ? pal.muted : AgentPalette.coral)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(Color.white.opacity(scheme == .dark ? 0.05 : 0.35), in: Capsule())
                    .overlay(Capsule().strokeBorder(pal.borderSubtle, lineWidth: 1))
                }
            }
            .padding(.horizontal, 14)

            // Conversations — a real List: inset rows, iOS swipe actions, no web chrome.
            List {
                if vm.loadingConversations {
                    Text("লোড হচ্ছে…")
                        .font(.system(size: 12)).foregroundStyle(pal.muted)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                } else if filteredConversations.isEmpty {
                    Text("কোনো কথোপকথন নেই — নতুন চ্যাট শুরু করুন")
                        .font(.system(size: 12)).foregroundStyle(pal.muted)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 24)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
                ForEach(filteredConversations) { c in
                    conversationRow(c, pal: pal)
                        .listRowBackground(
                            c.id == vm.conversationId
                                ? AnyView(RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .fill(AgentPalette.coral.opacity(0.10))
                                    .padding(.vertical, 2).padding(.horizontal, 6))
                                : AnyView(Color.clear))
                        .listRowSeparatorTint(pal.borderSubtle)
                        .listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 8, trailing: 14))
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) { deleteTarget = c } label: {
                                Label("মুছুন", systemImage: "trash")
                            }
                            Button {
                                Task { await vm.archiveConversation(c.id) }
                            } label: {
                                Label("আর্কাইভ", systemImage: "archivebox")
                            }
                            .tint(.orange)
                            Button {
                                renameText = c.title ?? ""
                                renameTarget = c
                            } label: {
                                Label("নাম", systemImage: "pencil")
                            }
                            .tint(.blue)
                        }
                }
                if vm.conversationsCursor != nil {
                    Button {
                        Task { await vm.loadMoreConversations() }
                    } label: {
                        Text(vm.loadingMoreConversations ? "লোড হচ্ছে…" : "আরও দেখুন")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(pal.muted)
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .scrollIndicators(.hidden)
        }
    }

    private func projectLabel(_ p: AgentProject) -> String {
        let badge = p.businessId == "ALMA_TRADING" ? " · Trading"
                  : p.businessId == "ALMA_LIFESTYLE" ? " · Lifestyle" : ""
        return p.name + badge
    }

    private func chatViewButton(_ label: String, index: Int, pal: AgentPalette) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            withAnimation(.snappy(duration: 0.18)) { chatView = index }
        } label: {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(chatView == index ? .white : pal.muted)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(chatView == index ? AnyShapeStyle(AgentPalette.coral) : AnyShapeStyle(.clear),
                            in: Capsule())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private func conversationRow(_ c: AgentConversation, pal: AgentPalette) -> some View {
        let active = c.id == vm.conversationId
        Button {
            Task { await vm.openConversation(c.id) }
            close()
        } label: {
            HStack(spacing: 8) {
                if c.source == "day_shift" { Text("🏢").font(.system(size: 13)) }
                VStack(alignment: .leading, spacing: 3) {
                    Text(c.title?.isEmpty == false ? c.title! : "(শিরোনাম নেই)")
                        .font(.system(size: 14, weight: active ? .semibold : .regular))
                        .foregroundStyle(active ? AgentPalette.coral : pal.ink)
                        .lineLimit(1)
                    Text("\(c.source == "day_shift" ? "অফিস লাইভ · " : "")\(shortDate(c.updatedAt))")
                        .font(.system(size: 11))
                        .foregroundStyle(pal.muted)
                }
                Spacer(minLength: 0)
                if active {
                    Circle().fill(AgentPalette.coral).frame(width: 6, height: 6)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func shortDate(_ iso: String?) -> String {
        guard let iso else { return "" }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = f.date(from: iso) ?? {
            f.formatOptions = [.withInternetDateTime]
            return f.date(from: iso)
        }()
        guard let date else { return "" }
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_BD")
        df.dateFormat = "dd MMM"
        return df.string(from: date)
    }

    // ── স্মৃতি tab ─────────────────────────────────────────────────────────

    @ViewBuilder private func memoryTab(_ pal: AgentPalette) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if !vm.learnedRules.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("শেখা নিয়ম")
                            .font(.system(size: 10, weight: .semibold))
                            .tracking(1)
                            .foregroundStyle(AgentPalette.coral)
                        ForEach(vm.learnedRules.prefix(12)) { r in
                            (Text("[\(r.domain ?? "সব")] ").foregroundColor(AgentPalette.coral.opacity(0.7))
                             + Text(String(r.text.prefix(100)))
                             + Text((r.timesApplied ?? 0) > 0 ? " · \(almaBn(r.timesApplied!))×" : "")
                                .foregroundColor(pal.muted))
                                .font(.system(size: 10))
                                .foregroundStyle(pal.ink)
                                .padding(.horizontal, 8).padding(.vertical, 6)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                    }
                    divider(pal)
                }
                // Scope filter
                Menu {
                    Button("সব ক্যাটাগরি") { memScope = "all"; Task { await vm.loadMemories(scope: "all") } }
                    Button("ব্যক্তিগত") { memScope = "personal"; Task { await vm.loadMemories(scope: "personal") } }
                    Button("ব্যবসা") { memScope = "business"; Task { await vm.loadMemories(scope: "business") } }
                    Button("স্টাফ") { memScope = "staff"; Task { await vm.loadMemories(scope: "staff") } }
                } label: {
                    HStack {
                        Text(memScope == "all" ? "সব ক্যাটাগরি" : scopeLabel(memScope))
                            .font(.system(size: 12)).foregroundStyle(pal.ink)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 9)).foregroundStyle(pal.muted)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(pal.borderSubtle, lineWidth: 1))
                }
                // Finance summary (💰, gold tone — web parity)
                if let fin = vm.financeSummary,
                   (fin.balances?.isEmpty == false || fin.monthExpensesByCategory?.isEmpty == false) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("💰 আর্থিক সারসংক্ষেপ")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Color(red: 0.831, green: 0.659, blue: 0.294)) // #D4A84B
                        if let bals = fin.balances, !bals.isEmpty {
                            Text("পাওনা/দেনা (ব্যক্তি অনুযায়ী)").font(.system(size: 10)).foregroundStyle(pal.muted)
                            ForEach(Array(bals.prefix(8).enumerated()), id: \.offset) { _, b in
                                Text(b.display ?? b.person).font(.system(size: 11)).foregroundStyle(pal.ink)
                            }
                        }
                        if let exp = fin.monthExpensesByCategory, !exp.isEmpty {
                            Text("এই মাসের খরচ (ক্যাটাগরি)").font(.system(size: 10)).foregroundStyle(pal.muted)
                            ForEach(Array(exp.prefix(6).enumerated()), id: \.offset) { _, e in
                                Text(e.display ?? "").font(.system(size: 11)).foregroundStyle(pal.ink)
                            }
                        }
                        Text("সংশোধন শুধু চ্যাটে — এখানে শুধু দেখা")
                            .font(.system(size: 9)).foregroundStyle(pal.muted)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(red: 0.831, green: 0.659, blue: 0.294).opacity(0.04),
                                in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color(red: 0.831, green: 0.659, blue: 0.294).opacity(0.2), lineWidth: 1))
                }
                // Memory rows
                if vm.memoriesLoading {
                    Text("লোড হচ্ছে…").font(.system(size: 11)).foregroundStyle(pal.muted)
                        .frame(maxWidth: .infinity).padding(.vertical, 24)
                } else if vm.memories.isEmpty {
                    Text("কোনো স্মৃতি নেই").font(.system(size: 11)).foregroundStyle(pal.muted)
                        .frame(maxWidth: .infinity).padding(.vertical, 32)
                }
                ForEach(vm.memories) { m in
                    memoryRow(m, pal: pal)
                }
            }
            .padding(12)
        }
        .task { await vm.loadMemories(scope: memScope) }
    }

    private func scopeLabel(_ s: String) -> String {
        switch s {
        case "personal": return "ব্যক্তিগত"
        case "business": return "ব্যবসা"
        case "staff": return "স্টাফ"
        default: return s
        }
    }

    private func scopeTone(_ s: String) -> Color {
        switch s {
        case "personal": return Color(red: 0.231, green: 0.510, blue: 0.965)   // blue
        case "business": return Color(red: 0.961, green: 0.620, blue: 0.043)   // amber
        case "staff": return Color(red: 0.659, green: 0.333, blue: 0.969)      // purple
        default: return AgentPalette.coral
        }
    }

    @ViewBuilder private func memoryRow(_ m: AgentMemoryRow, pal: AgentPalette) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(scopeLabel(m.scope))
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(scopeTone(m.scope))
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(scopeTone(m.scope).opacity(0.12), in: Capsule())
                if let k = m.key {
                    Text(k).font(.system(size: 10)).foregroundStyle(pal.muted).lineLimit(1)
                }
                Spacer()
                Button {
                    UISelectionFeedbackGenerator().selectionChanged()
                    Task { await vm.toggleMemoryPin(m.id, pinned: m.pinned) }
                } label: {
                    Text("📌").font(.system(size: 11))
                        .opacity(m.pinned ? 1 : 0.35)
                }
                Button {
                    deleteMemTarget = m
                } label: {
                    Text("🗑️").font(.system(size: 11)).opacity(0.6)
                }
            }
            Text(m.content)
                .font(.system(size: 11))
                .foregroundStyle(pal.ink)
                .lineLimit(3)
                .lineSpacing(2)
            Text(shortDate(m.createdAt))
                .font(.system(size: 9)).foregroundStyle(pal.muted)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(m.pinned ? AgentPalette.coral.opacity(0.04) : Color.white.opacity(0.04),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(m.pinned ? AgentPalette.coral.opacity(0.2) : pal.borderSubtle, lineWidth: 1))
    }
}

/// Native "নতুন প্রজেক্ট" form (web ProjectDialog parity: name/description/business/instructions).
@available(iOS 17.0, *)
struct AgentProjectFormSheet: View {
    @Bindable var vm: AssistantVM
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var desc = ""
    @State private var businessId = ""
    @State private var instructions = ""
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                Section("নাম *") {
                    TextField("ALMA Trading", text: $name)
                }
                Section("বিবরণ") {
                    TextField("সংক্ষিপ্ত বিবরণ", text: $desc)
                }
                Section("ব্যবসা (business scope)") {
                    Picker("ব্যবসা", selection: $businessId) {
                        Text("— Personal / cross-business —").tag("")
                        Text("ALMA Lifestyle").tag("ALMA_LIFESTYLE")
                        Text("ALMA Trading (Binance P2P)").tag("ALMA_TRADING")
                    }
                    .pickerStyle(.menu)
                }
                Section("সিস্টেম নির্দেশনা") {
                    TextField("এই প্রজেক্টের জন্য বিশেষ নির্দেশনা…", text: $instructions, axis: .vertical)
                        .lineLimit(3...6)
                }
            }
            .navigationTitle("নতুন প্রজেক্ট")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("বাতিল") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(saving ? "…" : "সংরক্ষণ") {
                        saving = true
                        Task {
                            let ok = await vm.saveProject(id: nil, name: name, description: desc,
                                                          instructions: instructions,
                                                          businessId: businessId.isEmpty ? nil : businessId)
                            saving = false
                            if ok { dismiss() }
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
        }
        .presentationDetents([.large])
    }
}

/// Empty new-chat state — greeting + time-of-day suggestion chips (web AgentEmptyState).
@available(iOS 17.0, *)
struct AgentEmptyStateView: View {
    let pal: AgentPalette
    let onPick: (String) -> Void
    @State private var breathe = false

    private var dayPart: Int {
        var cal = Calendar.current
        cal.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        let h = cal.component(.hour, from: Date())
        if h >= 5 && h < 12 { return 0 }      // সকাল
        if h >= 12 && h < 17 { return 1 }     // দুপুর
        if h >= 17 && h < 21 { return 2 }     // সন্ধ্যা
        return 3                              // রাত
    }

    private var subtitle: String {
        ["শুভ সকাল, Boss — দিনটা শুরু করি",
         "শুভ দুপুর, Boss — কীভাবে সাহায্য করতে পারি",
         "শুভ সন্ধ্যা, Boss — দিনটা গুছিয়ে নিই",
         "শুভ রাত্রি, Boss — কী দেখে নেবো"][dayPart]
    }

    private var suggestions: [(String, String)] {
        switch dayPart {
        case 0: return [("📦", "আজকের অর্ডার সারাংশ দাও"),
                        ("👥", "স্টাফদের আজকের টাস্ক রিভিউ করো"),
                        ("📊", "স্টক কম আছে কি চেক করো"),
                        ("🗒️", "আজকের জন্য একটা প্ল্যান বানাও")]
        case 1: return [("💰", "এখন পর্যন্ত আজকের বিক্রি কেমন?"),
                        ("✅", "অনুমোদনের জন্য কী কী পেন্ডিং আছে?"),
                        ("✍️", "একটা Facebook পোস্ট ড্রাফট করো"),
                        ("📊", "স্টক কম আছে কি চেক করো")]
        case 2: return [("📈", "আজকের দিনের বিক্রির রিপোর্ট দাও"),
                        ("👥", "কালকের জন্য স্টাফ টাস্ক প্রস্তাব করো"),
                        ("✍️", "একটা Facebook পোস্ট ড্রাফট করো"),
                        ("🧾", "আজকের খরচ রিভিউ করো")]
        default: return [("🌙", "আজকের দিনের সারাংশ দাও"),
                         ("💹", "ব্যবসার আর্থিক অবস্থা কেমন?"),
                         ("🗒️", "কালকের জন্য কী কী ঠিক করা দরকার?"),
                         ("🔔", "কোনো রিমাইন্ডার বা ফলো-আপ বাকি আছে?")]
        }
    }

    var body: some View {
        // Owner call (2026-07-06): no orb, no suggestion chips — the clean greeting only.
        VStack(spacing: 10) {
            Text("✨").font(.system(size: 40))
            Text("আস্সালামু আলাইকুম")
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(pal.ink)
            Text(subtitle)
                .font(.system(size: 13.5))
                .foregroundStyle(pal.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 110)
        .padding(.horizontal, 24)
        .onAppear { breathe = true }   // state kept for API stability
    }
}

/// LOCKED §9 — "N কাজ বাকি": chat shows ONLY a small collapsed glossy chip;
/// tap → glossy bottom sheet with THREE actions per task: অনুমোদন · বাতিল · আমার মত.
/// (Owner rule 2026-07-07: every approval ask = 3 buttons, never 2 — everywhere.)
@available(iOS 17.0, *)
struct AgentOpenTasksChipView: View {
    @Bindable var vm: AssistantVM
    let pal: AgentPalette
    @State private var showSheet = false
    @State private var ping = false

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            showSheet = true
        } label: {
            HStack(spacing: 7) {
                ZStack {
                    Circle()
                        .fill(AgentPalette.coral.opacity(0.6))
                        .frame(width: 7, height: 7)
                        .scaleEffect(ping ? 2.2 : 1)
                        .opacity(ping ? 0 : 0.7)
                    Circle().fill(AgentPalette.coral).frame(width: 7, height: 7)
                }
                .onAppear {
                    withAnimation(.easeOut(duration: 1.1).repeatForever(autoreverses: false)) { ping = true }
                }
                Text("\(almaBn(vm.openTasks.count))টা কাজ বাকি")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(AgentPalette.coral)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(AgentPalette.coral.opacity(0.6))
            }
            .padding(.horizontal, 13).padding(.vertical, 8)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(AgentPalette.coral.opacity(0.4), lineWidth: 1))
            .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
        .padding(.bottom, 16)
        .sheet(isPresented: $showSheet) {
            AgentPendingTasksSheet(vm: vm)
        }
    }
}

/// The glossy pending-tasks sheet — same glass language as every other sheet.
@available(iOS 17.0, *)
struct AgentPendingTasksSheet: View {
    @Bindable var vm: AssistantVM
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @State private var opineForId: String?
    @State private var opineText = ""

    var body: some View {
        let pal = AgentPalette(scheme)
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(pal.muted)
                        .frame(width: 32, height: 32)
                        .background(Color.white.opacity(0.08), in: Circle())
                }
                Spacer()
                Text(vm.openTasks.count == 1 ? "১টা কাজ বাকি" : "\(almaBn(vm.openTasks.count))টা কাজ বাকি")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(pal.ink)
                Spacer()
                Color.clear.frame(width: 32, height: 32)
            }
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 10)
            Rectangle().fill(AgentPalette.coral.opacity(0.35)).frame(height: 1)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(vm.openTasks) { task in
                        taskBlock(task, pal: pal)
                    }
                    if vm.openTasks.isEmpty {
                        Text("সব কাজ শেষ ✓")
                            .font(.system(size: 13)).foregroundStyle(pal.muted)
                            .frame(maxWidth: .infinity).padding(.vertical, 28)
                    }
                }
                .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 26)
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(26)
        .presentationBackground {
            Color(red: 0.23, green: 0.23, blue: 0.275).opacity(0.42)
                .background(.ultraThinMaterial)
        }
        .onChange(of: vm.openTasks.isEmpty) { _, empty in
            if empty { dismiss() }
        }
    }

    @ViewBuilder private func taskBlock(_ task: AgentOpenTask, pal: AgentPalette) -> some View {
        let busy = vm.openTaskBusyId == task.id
        VStack(alignment: .leading, spacing: 10) {
            Text(task.title ?? task.note ?? "কাজ")
                .font(.system(size: 14.5, design: .serif))
                .foregroundStyle(pal.ink)
                .lineSpacing(3)
            if let age = task.ageMinutes {
                Text(age < 60 ? "\(almaBn(age)) মিনিট আগে" : "\(almaBn(age / 60)) ঘণ্টা আগে")
                    .font(.system(size: 11)).foregroundStyle(pal.muted)
            }
            HStack(spacing: 8) {
                Button {
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    Task { await approve(task); dismiss() }
                } label: {
                    Group {
                        if busy { ProgressView().controlSize(.mini).tint(.white) }
                        else { Text("অনুমোদন").font(.system(size: 13, weight: .semibold)) }
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                    .background(
                        LinearGradient(colors: [AgentPalette.coral, AgentPalette.coralDim],
                                       startPoint: .topLeading, endPoint: .bottomTrailing),
                        in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                    .shadow(color: AgentPalette.coral.opacity(0.3), radius: 6, y: 2)
                }
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    Task { await reject(task); dismiss() }
                } label: {
                    Text("বাতিল")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(pal.mutedHi)
                        .frame(maxWidth: .infinity).padding(.vertical, 10)
                        .background(Color.white.opacity(0.08),
                                    in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
                }
            }
            .disabled(busy)
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                withAnimation(.snappy(duration: 0.2)) {
                    opineForId = opineForId == task.id ? nil : task.id
                }
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: "text.bubble")
                        .font(.system(size: 13))
                        .foregroundStyle(AgentPalette.coral.opacity(0.9))
                    Text("আমার মত")
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(pal.ink)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(pal.muted.opacity(0.5))
                        .rotationEffect(.degrees(opineForId == task.id ? 90 : 0))
                }
                .padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if opineForId == task.id {
                HStack(spacing: 8) {
                    TextField("আপনার মতামত লিখুন — ALMA সেই অনুযায়ী ঠিক করবে…",
                              text: $opineText, axis: .vertical)
                        .font(.system(size: 14)).lineLimit(2...4)
                        .padding(10)
                        .background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 13))
                        .overlay(RoundedRectangle(cornerRadius: 13)
                            .strokeBorder(Color.white.opacity(0.14), lineWidth: 1))
                    Button {
                        let t = opineText.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !t.isEmpty else { return }
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        Task { await opine(task, note: t); dismiss() }
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 38, height: 38)
                            .background(
                                LinearGradient(colors: [AgentPalette.coral, AgentPalette.coralDim],
                                               startPoint: .topLeading, endPoint: .bottomTrailing),
                                in: Circle())
                    }
                }
                .transition(.opacity)
            }
        }
        .padding(14)
        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
            .strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
    }

    private func approve(_ task: AgentOpenTask) async {
        if task.kind == "approval_pending", let pid = task.pendingActionId {
            await vm.approveAction(pid, approve: true)
        } else {
            await vm.continueOpenTask(task)
        }
    }

    private func reject(_ task: AgentOpenTask) async {
        if task.kind == "approval_pending", let pid = task.pendingActionId {
            await vm.approveAction(pid, approve: false)
        } else {
            await vm.cancelOpenTask(task)
        }
    }

    /// আমার মত — reject/park the pending work, then send the owner's note so the
    /// agent self-corrects (LOCKED: the 3rd option, everywhere).
    private func opine(_ task: AgentOpenTask, note: String) async {
        if task.kind == "approval_pending", let pid = task.pendingActionId {
            await vm.submitOpinion(pid, note: note)
        } else {
            vm.send(note)
        }
        await vm.loadOpenTasks()
    }
}

// MARK: - Plan-Drive Live Desk card (S8 additive; web PlanDriveTimeline parity, compact)

/// In-thread compact timeline for in-flight autonomous plans: attention cards
/// (needs-decision / needs-approval) first, then working step ladders. Renders
/// only while a plan exists — this is a chat surface, not a page.
@available(iOS 17.0, *)
private struct AgentPlanDriveCard: View {
    @Bindable var vm: AssistantVM
    let pal: AgentPalette
    @State private var expanded: Set<String> = []
    @State private var confirm: Confirm?
    @State private var ping = false

    private struct Confirm: Identifiable {
        let id = UUID()
        let planId: String
        let action: String
        let question: String
        let button: String
    }

    private var drives: [AgentPlanDriveView] { vm.planDrive?.drives ?? [] }
    private var attention: [AgentPlanDriveView] {
        drives.filter { $0.phase == "needs-decision" || $0.phase == "waiting-approval" }
    }
    private var working: [AgentPlanDriveView] { drives.filter { $0.phase == "driving" } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            ForEach(attention) { attentionRow($0) }
            ForEach(working) { workingRow($0) }
        }
        .padding(13)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
            .strokeBorder(AgentPalette.coral.opacity(0.22), lineWidth: 1))
        .confirmationDialog(
            confirm?.question ?? "",
            isPresented: Binding(get: { confirm != nil },
                                 set: { if !$0 { confirm = nil } }),
            titleVisibility: .visible
        ) {
            if let c = confirm {
                Button(c.button, role: c.action == "abandon" ? .destructive : nil) {
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    Task { await vm.planDriveAct(planId: c.planId, action: c.action) }
                }
                Button("থাক", role: .cancel) {}
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            ZStack {
                Circle().fill(AgentPalette.teal.opacity(0.55))
                    .frame(width: 7, height: 7)
                    .scaleEffect(ping ? 2.1 : 1)
                    .opacity(ping ? 0 : 0.7)
                Circle().fill(working.isEmpty ? pal.muted.opacity(0.6) : AgentPalette.teal)
                    .frame(width: 7, height: 7)
            }
            .onAppear {
                withAnimation(.easeOut(duration: 1.2).repeatForever(autoreverses: false)) { ping = true }
            }
            Text("এজেন্ট লাইভ ডেস্ক")
                .font(.system(size: 12.5, weight: .bold)).foregroundStyle(pal.ink)
            Text("Plan-Drive").font(.system(size: 9.5)).foregroundStyle(pal.muted)
            Spacer()
            if !attention.isEmpty {
                Text("\(almaBn(attention.count)) অপেক্ষায়")
                    .font(.system(size: 9, weight: .bold)).foregroundStyle(.red)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(Color.red.opacity(0.12), in: Capsule())
            }
            if !working.isEmpty {
                Text("\(almaBn(working.count)) চলছে")
                    .font(.system(size: 9, weight: .bold)).foregroundStyle(AgentPalette.teal)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(AgentPalette.teal.opacity(0.14), in: Capsule())
            }
        }
    }

    /// ⚠️ Waiting on the owner — loud card; one-click decisions for needs-decision
    /// (web AttentionCard parity: resume / add-budget / abandon, Bangla confirm first).
    @ViewBuilder private func attentionRow(_ d: AgentPlanDriveView) -> some View {
        let isDecision = d.phase == "needs-decision"
        let tint: Color = isDecision ? Color(red: 0.937, green: 0.267, blue: 0.267)
                                     : Color(red: 0.851, green: 0.600, blue: 0.110)
        let busy = vm.planDriveBusyPlanId == d.planId
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Text(isDecision ? "🛑" : "✋").font(.system(size: 13))
                Text(isDecision ? "সিদ্ধান্ত দরকার" : "অনুমোদন দরকার")
                    .font(.system(size: 8.5, weight: .heavy))
                    .foregroundStyle(tint)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(tint.opacity(0.13), in: Capsule())
                Text(d.goal ?? "প্ল্যান")
                    .font(.system(size: 12, weight: .bold)).foregroundStyle(pal.ink)
                    .lineLimit(1)
            }
            if let why = d.waitingReason, !why.isEmpty {
                Text(why).font(.system(size: 11)).foregroundStyle(pal.mutedHi)
                    .lineLimit(3).lineSpacing(2)
            }
            HStack(spacing: 5) {
                Text("\(almaBn(d.doneCount ?? 0))/\(almaBn(d.totalCount ?? d.steps?.count ?? 0)) ধাপ শেষ")
                if let taka = d.costTaka, taka > 0 { Text("· ৳\(almaBn(Int(taka))) খরচ") }
            }
            .font(.system(size: 9.5)).foregroundStyle(pal.muted)
            if isDecision {
                HStack(spacing: 7) {
                    actBtn(busy ? "⏳" : "▶ আবার চালাও", AgentPalette.teal) {
                        confirm = Confirm(planId: d.planId, action: "resume",
                                          question: "প্ল্যানটা আবার চালু করবেন?", button: "হ্যাঁ, চালাও")
                    }
                    actBtn(busy ? "⏳" : "৳ বাজেট বাড়াও", AgentPalette.coral) {
                        confirm = Confirm(planId: d.planId, action: "add-budget",
                                          question: "বাজেট বাড়িয়ে আবার চালু করবেন?", button: "হ্যাঁ, বাড়াও")
                    }
                    actBtn(busy ? "⏳" : "✕ বাদ দাও", pal.mutedHi) {
                        confirm = Confirm(planId: d.planId, action: "abandon",
                                          question: "প্ল্যানটা কি একেবারে বাদ দেবেন?", button: "হ্যাঁ, বাদ দাও")
                    }
                }
                .disabled(busy)
                .opacity(busy ? 0.55 : 1)
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(tint.opacity(0.3), lineWidth: 1))
    }

    /// ▶ Actively driving — goal + live line + progress rail; tap to unfold the
    /// step ladder (status-coloured nodes, web WorkingPlan parity).
    @ViewBuilder private func workingRow(_ d: AgentPlanDriveView) -> some View {
        let steps = d.steps ?? []
        let done = d.doneCount ?? steps.filter { $0.status == "done" }.count
        let total = max(d.totalCount ?? steps.count, 1)
        let open = expanded.contains(d.planId)
        VStack(alignment: .leading, spacing: 7) {
            Button {
                UISelectionFeedbackGenerator().selectionChanged()
                withAnimation(.snappy(duration: 0.22)) {
                    if open { expanded.remove(d.planId) } else { expanded.insert(d.planId) }
                }
            } label: {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 7) {
                        Circle().fill(AgentPalette.coral).frame(width: 7, height: 7)
                        Text(d.goal ?? "প্ল্যান")
                            .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(pal.ink)
                            .lineLimit(1)
                        Spacer()
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(pal.muted)
                            .rotationEffect(.degrees(open ? 180 : 0))
                    }
                    if let line = d.currentLine, !line.isEmpty {
                        Text(line).font(.system(size: 10.5)).foregroundStyle(pal.muted).lineLimit(1)
                    }
                    HStack(spacing: 8) {
                        ProgressView(value: Double(min(done, total)), total: Double(total))
                            .tint(AgentPalette.coral)
                        Text("\(almaBn(done))/\(almaBn(total))")
                            .font(.system(size: 10, weight: .semibold)).monospacedDigit()
                            .foregroundStyle(pal.muted)
                        if let taka = d.costTaka, taka > 0 {
                            Text("৳\(almaBn(Int(taka)))")
                                .font(.system(size: 9.5)).foregroundStyle(pal.muted)
                        }
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(steps.enumerated()), id: \.element.id) { i, s in
                        HStack(alignment: .top, spacing: 8) {
                            stepDot(s.status).padding(.top, 3.5)
                            Text("\(almaBn(i + 1)). \(s.action ?? "")")
                                .font(.system(size: 11))
                                .foregroundStyle(stepInk(s.status))
                                .strikethrough(s.status == "done", color: AgentPalette.teal.opacity(0.5))
                        }
                    }
                }
                .padding(.leading, 2)
                .transition(.opacity)
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(pal.card.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(pal.borderSubtle, lineWidth: 1))
    }

    private func stepDot(_ status: String?) -> some View {
        let color: Color
        switch status ?? "pending" {
        case "done": color = AgentPalette.teal
        case "running": color = AgentPalette.coral
        case "failed": color = .red
        default: color = pal.muted.opacity(0.35)
        }
        return Circle().fill(color).frame(width: 7, height: 7)
    }

    private func stepInk(_ status: String?) -> Color {
        switch status ?? "pending" {
        case "done": return pal.muted
        case "running": return pal.ink
        case "failed": return .red
        default: return pal.mutedHi
        }
    }

    private func actBtn(_ label: String, _ color: Color, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        } label: {
            Text(label)
                .font(.system(size: 10.5, weight: .bold))
                .foregroundStyle(color)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(color.opacity(0.1), in: Capsule())
                .overlay(Capsule().strokeBorder(color.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Artifacts sheet (S8 additive; web AgentArtifactsPanel parity, display-only)

/// Glossy list → detail sheet for the conversation's artifacts. Text/markdown/code
/// render natively; HTML/SVG get an "ওয়েবে খুলুন" escape (no native editing/saving).
@available(iOS 17.0, *)
private struct AgentArtifactsSheet: View {
    @Bindable var vm: AssistantVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @State private var selected: AgentArtifactWire?
    @State private var copied = false

    var body: some View {
        let pal = AgentPalette(scheme)
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button {
                    if selected != nil {
                        withAnimation(.snappy(duration: 0.2)) { selected = nil }
                    } else { dismiss() }
                } label: {
                    Image(systemName: selected != nil ? "chevron.left" : "xmark")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(pal.muted)
                        .frame(width: 32, height: 32)
                        .background(Color.white.opacity(0.08), in: Circle())
                }
                Spacer()
                Text(selected?.title ?? "আর্টিফ্যাক্ট (\(almaBn(vm.artifacts.count)))")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(pal.ink)
                    .lineLimit(1)
                Spacer()
                Color.clear.frame(width: 32, height: 32)
            }
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 10)
            Rectangle().fill(AgentPalette.coral.opacity(0.35)).frame(height: 1)

            ScrollView {
                if let art = selected { detail(art, pal: pal) } else { list(pal: pal) }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(26)
        .presentationBackground {
            Color(red: 0.23, green: 0.23, blue: 0.275).opacity(0.42)
                .background(.ultraThinMaterial)
        }
    }

    // ── List ───────────────────────────────────────────────────────────────

    @ViewBuilder private func list(pal: AgentPalette) -> some View {
        VStack(spacing: 10) {
            ForEach(vm.artifacts) { a in
                Button {
                    UISelectionFeedbackGenerator().selectionChanged()
                    withAnimation(.snappy(duration: 0.2)) { selected = a }
                } label: {
                    HStack(spacing: 11) {
                        Image(systemName: icon(a))
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(AgentPalette.coral)
                            .frame(width: 34, height: 34)
                            .background(AgentPalette.coral.opacity(0.12),
                                        in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(a.title ?? "শিরোনামহীন")
                                .font(.system(size: 13.5, weight: .semibold))
                                .foregroundStyle(pal.ink).lineLimit(1)
                            HStack(spacing: 6) {
                                Text((a.type ?? "text").uppercased())
                                    .font(.system(size: 8, weight: .heavy))
                                    .foregroundStyle(pal.mutedHi)
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(Color.white.opacity(0.08), in: Capsule())
                                if let v = a.version, v > 1 {
                                    Text("v\(almaBn(v))").font(.system(size: 9.5)).foregroundStyle(pal.muted)
                                }
                                if let d = a.createdAt, d.count >= 10 {
                                    Text(String(d.prefix(10))).font(.system(size: 9.5)).foregroundStyle(pal.muted)
                                }
                            }
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(pal.muted.opacity(0.5))
                    }
                    .padding(12)
                    .background(Color.white.opacity(0.05),
                                in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            if vm.artifacts.isEmpty {
                Text("এই চ্যাটে কোনো আর্টিফ্যাক্ট নেই")
                    .font(.system(size: 13)).foregroundStyle(pal.muted)
                    .frame(maxWidth: .infinity).padding(.vertical, 28)
            }
        }
        .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 26)
    }

    // ── Detail ─────────────────────────────────────────────────────────────

    @ViewBuilder private func detail(_ a: AgentArtifactWire, pal: AgentPalette) -> some View {
        let content = a.content ?? ""
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Button {
                    UIPasteboard.general.string = content
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { copied = false }
                } label: {
                    Label(copied ? "কপি হয়েছে ✓" : "কপি", systemImage: "doc.on.doc")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(pal.mutedHi)
                        .padding(.horizontal, 11).padding(.vertical, 7)
                        .background(Color.white.opacity(0.08), in: Capsule())
                }
                .buttonStyle(.plain)
                Spacer()
            }
            if isWebOnly(a) {
                // Live HTML/SVG preview stays a web feature — offer the escape.
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    let open = openWeb
                    dismiss()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                        open("/agent", "ALMA AI")
                    }
                } label: {
                    HStack(spacing: 9) {
                        Image(systemName: "safari")
                            .font(.system(size: 14)).foregroundStyle(AgentPalette.coral)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("ওয়েবে খুলুন")
                                .font(.system(size: 13, weight: .semibold)).foregroundStyle(pal.ink)
                            Text("এই ধরনের আর্টিফ্যাক্টের লাইভ প্রিভিউ ওয়েবে দেখা যায়")
                                .font(.system(size: 10.5)).foregroundStyle(pal.muted)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(pal.muted.opacity(0.5))
                    }
                    .padding(12)
                    .background(Color.white.opacity(0.05),
                                in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(AgentPalette.coral.opacity(0.3), lineWidth: 1))
                }
                .buttonStyle(.plain)
                AgentMarkdownText(text: "```\n\(content)\n```", pal: pal)
            } else if (a.type ?? "").lowercased() == "code", !content.contains("```") {
                AgentMarkdownText(text: "```\n\(content)\n```", pal: pal)
            } else {
                AgentMarkdownText(text: content, pal: pal)
            }
        }
        .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 26)
    }

    private func icon(_ a: AgentArtifactWire) -> String {
        switch (a.type ?? "").lowercased() {
        case "html", "svg": return "globe"
        case "code": return "chevron.left.forwardslash.chevron.right"
        default: return "doc.richtext"
        }
    }

    /// Web isPreviewable parity: explicit html/svg type, or html-looking content.
    private func isWebOnly(_ a: AgentArtifactWire) -> Bool {
        let t = (a.type ?? "").lowercased()
        if t == "html" || t == "svg" { return true }
        let c = (a.content ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return c.hasPrefix("<!doctype html") || c.hasPrefix("<html") || c.hasPrefix("<svg")
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct AssistantScreen: View {
    @State private var vm = AssistantVM()
    @Environment(\.colorScheme) private var scheme
    @State private var nearBottom = true
    @State private var scrollViewportH: CGFloat = 0
    @State private var toolSheet: AgentChatMessage.Tool?
    @State private var activitySheet: AgentActivitySheetRequest?
    @State private var bottomScrollGeneration: UInt = 0
    @State private var showArtifacts = false

    let openWeb: (_ path: String, _ title: String) -> Void
    /// Wired by makeAssistantTab so the native bar buttons drive this screen.
    let barHooks: AssistantBarHooks

    private static let bottomID = "ALMA_BOTTOM"

    /// The drawer animates itself (slide-from-left) — the system cover must not.
    private static func presentDrawer(_ vm: AssistantVM) {
        // Prefetch the lists BEFORE the cover mounts so the slide-in spring never
        // shares its frames with request setup + JSON decode (perf audit 2026-07-08):
        // the drawer opens on cached content and the fresh data lands mid-slide.
        Task {
            await vm.loadConversations()
            await vm.loadProjects()
        }
        var tx = Transaction(); tx.disablesAnimations = true
        withTransaction(tx) { vm.showSidebar = true }
    }

    var body: some View {
        let pal = AgentPalette(scheme)
        ZStack {
            AgentAuroraBackground()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if vm.loadingHistory && vm.messages.isEmpty {
                            AlmaPageLoader()
                        }
                        // Plan-Drive Live Desk — in-thread only while a plan is in flight.
                        if !(vm.planDrive?.drives ?? []).isEmpty {
                            AgentPlanDriveCard(vm: vm, pal: pal)
                                .padding(.bottom, 12)
                        }
                        if !vm.loadingHistory && vm.messages.isEmpty && !vm.isStreaming {
                            AgentEmptyStateView(pal: pal) { vm.send($0) }
                        }
                        ForEach(vm.messages) { msg in
                            AgentMessageRow(
                                message: msg, vm: vm,
                                showWorkingIndicator: vm.isStreaming && msg.isStreaming
                                    && msg.id == vm.messages.last(where: { $0.isStreaming })?.id,
                                isLastAssistant: msg.role == .assistant
                                    && msg.id == vm.messages.last(where: { $0.role == .assistant })?.id,
                                onToolTap: { tool in toolSheet = tool },
                                onActivitySheet: { activitySheet = $0 })
                            .transition(.asymmetric(
                                insertion: .opacity.combined(with: .offset(y: 12)),
                                removal: .opacity))
                        }
                        Color.clear.frame(height: 4).id(Self.bottomID)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
                    .background(scrollOffsetReader)
                    .animation(.spring(response: 0.32, dampingFraction: 0.8), value: vm.messages.count)
                }
                .coordinateSpace(name: "agentscroll")
                // Owner 2026-07-07: tap on any empty spot dismisses the keyboard
                // (buttons/rows inside still win their own taps).
                .onTapGesture {
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder),
                                                    to: nil, from: nil, for: nil)
                }
                // Real viewport height (owner issue #2 build 69): the old check
                // compared content maxY against UIScreen height, but the scroll
                // viewport is ~200pt shorter (composer + tab bar + header), so the
                // arrow only appeared after a long scroll-up — it read as missing.
                .background(GeometryReader { g in
                    Color.clear.preference(key: AgentScrollViewportKey.self, value: g.size.height)
                })
                .onPreferenceChange(AgentScrollViewportKey.self) { h in
                    if h > 0, abs(h - scrollViewportH) > 0.5 { scrollViewportH = h }
                }
                .onPreferenceChange(AgentScrollBottomKey.self) { contentMaxY in
                    let viewport = scrollViewportH > 0 ? scrollViewportH : UIScreen.main.bounds.height
                    let distance = contentMaxY - viewport
                    let next = distance < 120
                    if next != nearBottom { nearBottom = next }
                }
                // iOS 18+: the GeometryReader-preference trick above stops firing
                // DURING user scrolls under the new scroll system (sim-verified on
                // iOS 26: two screens up, no preference update → arrow never showed).
                // onScrollGeometryChange is the supported live signal; the preference
                // path stays as the iOS 17 fallback.
                .modifier(AgentNearBottomScrollModifier(nearBottom: $nearBottom))
                .onChange(of: vm.messages.last?.text) { _, _ in
                    guard nearBottom else { return }
                    scheduleScrollToBottom(proxy: proxy)
                }
                .onChange(of: vm.messages.count) { _, _ in
                    if vm.isStreaming {
                        scheduleScrollToBottom(proxy: proxy)
                    } else {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(Self.bottomID, anchor: .bottom)
                        }
                    }
                }
                .overlay(alignment: .bottom) {
                    // Web parity: centered 40pt frosted circle just above the composer.
                    if !nearBottom {
                        Button {
                            UISelectionFeedbackGenerator().selectionChanged()
                            withAnimation { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                        } label: {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(pal.muted)
                                .frame(width: 40, height: 40)
                                .background(.ultraThinMaterial, in: Circle())
                                .overlay(Circle().strokeBorder(Color.white.opacity(0.2), lineWidth: 1))
                        }
                        .padding(.bottom, 10)
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
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
            barHooks.onMenu = { Self.presentDrawer(vm) }
            barHooks.onNewChat = { Task { await vm.newChat() } }
            // DEBUG self-test hooks (never fire in production — the env vars are only
            // set by the local `simctl launch` self-test, same pattern as
            // ALMA_OPEN_COMPANION / ALMA_FADE_DEMO):
            // Read from env OR launch arguments — `simctl launch <bundle> KEY=val`
            // delivers KEY=val as a positional ARGUMENT, not an env var, so the
            // headless self-tests must check both.
            let rawEnv = ProcessInfo.processInfo.environment
            let args = ProcessInfo.processInfo.arguments
            func argFlag(_ k: String) -> Bool {
                rawEnv[k] == "1" || args.contains("\(k)=1")
            }
            let env = rawEnv
            if argFlag("ALMA_ASSISTANT_VOICE") {
                Task { try? await Task.sleep(nanoseconds: 2_500_000_000); vm.showVoice = true }
            }
            if env["ALMA_ASSISTANT_SIDEBAR"] == "1" {
                Task { try? await Task.sleep(nanoseconds: 1_500_000_000); Self.presentDrawer(vm) }
            }
            if let say = env["ALMA_ASSISTANT_SAY"], !say.isEmpty {
                Task { try? await Task.sleep(nanoseconds: 4_000_000_000); vm.send(say) }
            }
            if env["ALMA_ASSISTANT_NEWCHAT"] == "1" {
                Task { try? await Task.sleep(nanoseconds: 3_000_000_000); await vm.newChat() }
            }
            if env["ALMA_ASSISTANT_VOICE"] == "1" {
                Task { try? await Task.sleep(nanoseconds: 3_000_000_000); vm.showVoice = true }
            }
            if env["ALMA_ASSISTANT_TOOLSHEET"] == "1" {
                Task {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    toolSheet = vm.messages.flatMap(\.phases).flatMap(\.tools)
                        .first { $0.inputPretty != nil || $0.resultFull != nil }
                }
            }
            await vm.bootstrap()
        }
        .fullScreenCover(isPresented: $vm.showSidebar) {
            AgentSideDrawer(vm: vm, openWeb: openWeb)
                .presentationBackground(.clear)
        }
        .fullScreenCover(isPresented: $vm.showVoice) {
            AlmaVoiceConsoleView(vm: vm)
        }
        .sheet(item: $toolSheet) { tool in
            AgentToolIOSheet(tool: tool)
        }
        .sheet(item: $activitySheet) { req in
            AgentThoughtProcessSheet(request: req)
        }
        .sheet(isPresented: $showArtifacts) {
            AgentArtifactsSheet(vm: vm, openWeb: openWeb)
        }
        .overlay(alignment: .top) {
            if vm.authExpired { authBanner(pal) }
        }
        // Artifacts badge — web header-badge parity: appears only when this
        // conversation actually has artifacts; tap → glossy list/detail sheet.
        .overlay(alignment: .topTrailing) {
            if !vm.artifacts.isEmpty && !vm.authExpired {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    showArtifacts = true
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "doc.richtext")
                            .font(.system(size: 11, weight: .semibold))
                        Text(almaBn(vm.artifacts.count))
                            .font(.system(size: 11.5, weight: .bold))
                    }
                    .foregroundStyle(AgentPalette.coral)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(.ultraThinMaterial, in: Capsule())
                    .overlay(Capsule().strokeBorder(AgentPalette.coral.opacity(0.4), lineWidth: 1))
                    .shadow(color: .black.opacity(0.15), radius: 8, y: 3)
                }
                .buttonStyle(.plain)
                .padding(.trailing, 14).padding(.top, 6)
                .transition(.scale(scale: 0.8).combined(with: .opacity))
            }
        }
        .overlay(alignment: .bottom) {
            if let toast = vm.errorToast { toastView(toast, pal) }
        }
    }

    private func scheduleScrollToBottom(proxy: ScrollViewProxy) {
        bottomScrollGeneration &+= 1
        let gen = bottomScrollGeneration
        Task { @MainActor in
            // Coalesce rapid SSE text_delta bursts — avoids SwiftUI
            // "onChange tried to update multiple times per frame" freeze.
            try? await Task.sleep(for: .milliseconds(48))
            guard gen == bottomScrollGeneration else { return }
            proxy.scrollTo(Self.bottomID, anchor: .bottom)
        }
    }

    private var scrollOffsetReader: some View {
        GeometryReader { g in
            // Raw content maxY in the scroll view's own space; the reader above
            // subtracts the MEASURED viewport height (never UIScreen).
            Color.clear.preference(
                key: AgentScrollBottomKey.self,
                value: g.frame(in: .named("agentscroll")).maxY)
        }
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

/// iOS 18+ live near-bottom tracking for the assistant thread. The old
/// GeometryReader/PreferenceKey pattern does not deliver updates while the user
/// is dragging under the iOS 18/26 scroll system, so the scroll-down arrow never
/// appeared (build-70 sim finding). `onScrollGeometryChange` fires continuously.
struct AgentNearBottomScrollModifier: ViewModifier {
    @Binding var nearBottom: Bool
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { g in
                g.contentSize.height + g.contentInsets.bottom
                    - (g.contentOffset.y + g.containerSize.height) < 120
            } action: { _, isNear in
                if isNear != nearBottom { nearBottom = isNear }
            }
        } else {
            content
        }
    }
}

/// Measured height of the assistant scroll viewport (issue #2 build 69).
struct AgentScrollViewportKey: PreferenceKey {
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

    /// SF Symbols for the AssistiveTouch radial items (mirrors SpikeNativeShell's
    /// private agentIcon, which is file-scoped there).
    private static func assistantSectionIcon(_ title: String) -> String {
        switch title {
        case "Chat": return "bubble.left.and.text.bubble.right"
        case "Studio": return "wand.and.stars"
        case "WhatsApp": return "message.fill"
        case "Monitor": return "chart.bar.xaxis"
        case "Costs": return "dollarsign.circle"
        default: return "sparkles"
        }
    }

    /// Assistant tab: native SwiftUI chat when the S6 flag is on (iOS 17+), else the
    /// pre-S6b web construction (segmented Chat/Studio/WhatsApp/Monitor/Costs), verbatim.
    func makeAssistantTab() -> UINavigationController {
        // DEBUG self-test hook (never fires in production): ALMA_OPEN_ASSISTANT=1
        // (set only by the local `simctl launch` self-test) jumps straight to this
        // tab so either variant can be screenshotted headlessly — same pattern as
        // ALMA_OPEN_COMPANION in SpikeNativeShell.
        if ProcessInfo.processInfo.environment["ALMA_OPEN_ASSISTANT"] == "1" {
            // Cold first launches swap the root VC late — re-assert a few times.
            for delay in [0.8, 2.5, 5.0] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    self?.selectedIndex = 2
                }
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

            // The AssistiveTouch-style floating sub-page nav the web Assistant tab had
            // (owner: it must survive the native migration) — the proven UIKit
            // AgentAssistiveNav, overlaid on the hosting view. "Chat" returns to the
            // native chat (pops any pushed web screen); the rest push web sub-pages.
            func webPushItem(_ title: String, _ path: String) -> AgentAssistiveNav.Item {
                AgentAssistiveNav.Item(title: title, icon: Self.assistantSectionIcon(title)) {
                    let vc = AlmaWebTabViewController(url: URL(string: Self.base + path)!,
                                                      processPool: pool,
                                                      tabTitle: title, systemImage: "sparkles",
                                                      hideWebHeader: true)
                    vc.hidesBottomBarWhenPushed = false
                    navRef.value?.pushViewController(vc, animated: true)
                }
            }
            // Prefer the NATIVE screen (AlmaNativeRouter) when SwiftUI screens are on;
            // fall back to the web tab exactly like webPushItem otherwise. Without this the
            // assistive "Studio" tab always opened the web page even though the native
            // Creative Studio ships in the build (owner report, build 62).
            func nativePushItem(_ title: String, _ path: String) -> AgentAssistiveNav.Item {
                AgentAssistiveNav.Item(title: title, icon: Self.assistantSectionIcon(title)) {
                    let pushWeb: (_ p: String, _ t: String) -> Void = { p, t in
                        let vc = AlmaWebTabViewController(url: URL(string: Self.base + p)!,
                                                          processPool: pool, tabTitle: t,
                                                          systemImage: "sparkles", hideWebHeader: true)
                        vc.hidesBottomBarWhenPushed = false
                        navRef.value?.pushViewController(vc, animated: true)
                    }
                    if AlmaSwiftUIFlag.isActive, #available(iOS 17.0, *),
                       let native = AlmaNativeRouter.screen(for: path, openWebForced: pushWeb) {
                        native.hidesBottomBarWhenPushed = false
                        navRef.value?.pushViewController(native, animated: true)
                    } else {
                        pushWeb(path, title)
                    }
                }
            }
            let assistive = AgentAssistiveNav(items: [
                AgentAssistiveNav.Item(title: "Chat", icon: Self.assistantSectionIcon("Chat")) {
                    navRef.value?.popToRootViewController(animated: true)
                },
                nativePushItem("Studio", "/agent/creative-studio"),
                // S8 audit: these three have native screens (AlmaNativeRouter cases
                // /agent/whatsapp, /agent/staff-monitor, /agent/costs) — push them
                // natively like Studio; nativePushItem still falls back to web.
                nativePushItem("WhatsApp", "/agent/whatsapp"),
                nativePushItem("Monitor", "/agent/staff-monitor"),
                nativePushItem("Costs", "/agent/costs"),
            ])
            host.view.addSubview(assistive)
            assistive.attach(to: host.view, tabBarHeight: 49)

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

// MARK: - Artifact file card + viewer (web AgentArtifactsPanel parity)

/// Claude-style FILE CARD — a tool filed a document (SEO report, research…);
/// tap to open the native viewer with rendered markdown + share/copy.
@available(iOS 17.0, *)
struct AgentArtifactFileCard: View {
    let artifactId: String
    let name: String
    let vm: AssistantVM
    let pal: AgentPalette
    @State private var showViewer = false

    var body: some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            showViewer = true
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(AgentPalette.coral.opacity(0.14))
                        .frame(width: 38, height: 38)
                    Image(systemName: "doc.text")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(AgentPalette.coral)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(.system(size: 13.5, weight: .bold))
                        .foregroundStyle(pal.ink)
                        .lineLimit(1)
                    Text("ডকুমেন্ট · খুলতে চাপুন")
                        .font(.system(size: 11))
                        .foregroundStyle(pal.muted)
                }
                Spacer(minLength: 8)
                Text("খুলুন ›")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(AgentPalette.coral)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(pal.card.opacity(pal.dark ? 0.75 : 0.9),
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(pal.borderSubtle, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .padding(.vertical, 2)
        .sheet(isPresented: $showViewer) {
            AgentArtifactViewerSheet(artifactId: artifactId, fallbackTitle: name, vm: vm)
        }
    }
}

/// Native artifact viewer — fetches the conversation's artifacts, renders the
/// document (markdown), and offers the iOS share sheet (as a real .md file the
/// owner can send a client) + copy.
@available(iOS 17.0, *)
struct AgentArtifactViewerSheet: View {
    let artifactId: String
    let fallbackTitle: String
    let vm: AssistantVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var artifact: AgentArtifactWire?
    @State private var loadError: String?
    @State private var shareURL: URL?
    @State private var copied = false

    var body: some View {
        let pal = AgentPalette(scheme)
        NavigationStack {
            Group {
                if let a = artifact, let content = a.content {
                    ScrollView {
                        AgentMarkdownText(text: content, pal: pal)
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else if let err = loadError {
                    ContentUnavailableView("ফাইল খোলা গেল না", systemImage: "doc.questionmark",
                                           description: Text(err))
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(pal.bg0)
            .navigationTitle(artifact?.title ?? fallbackTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("বন্ধ") { dismiss() }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        UIPasteboard.general.string = artifact?.content ?? ""
                        copied = true
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    } label: {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    }
                    .disabled(artifact?.content == nil)
                    if let url = shareURL {
                        ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
                    }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard let cid = vm.conversationId else {
            loadError = "কথোপকথন পাওয়া যায়নি"
            return
        }
        do {
            let rows: [AgentArtifactWire] = try await AlmaAPI.shared.get("/api/assistant/conversations/\(cid)/artifacts")
            guard let a = rows.first(where: { $0.id == artifactId }) ?? rows.last else {
                loadError = "ফাইলটা আর নেই"
                return
            }
            artifact = a
            // Write a real .md file so the share sheet hands the client a document.
            if let content = a.content {
                let safe = (a.title ?? fallbackTitle)
                    .replacingOccurrences(of: "/", with: "-")
                    .prefix(80)
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent("\(safe).md")
                try? content.data(using: .utf8)?.write(to: url)
                shareURL = url
            }
        } catch {
            loadError = "লোড ব্যর্থ — নেটওয়ার্ক দেখে আবার চেষ্টা করুন"
        }
    }
}
