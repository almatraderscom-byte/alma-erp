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
import os.signpost

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

/// One entry of the persisted Claude-style activity timeline
/// (`t: 'think' | 'text' | 'verify' | 'tool' | 'file'`).
struct AgentTimelineEntryWire: Decodable {
    let t: String?
    let text: String?
    let state: String?  // t=="text": "superseded" = verification rewrote this draft
    let attempt: Int?   // t=="verify"
    let max: Int?       // t=="verify"
    let id: String?
    let name: String?
    let ok: Bool?
    let live: Bool?
    let input: AgentJSONValue?
    let result: String?
    let kind: String?   // t=="file": document kind (markdown/html/…)
    let shot: String?   // t=="tool": browser screenshot URL (web parity)
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
    let cacheCreation: Int?
    let cacheRead: Int?
    let apiRounds: Int?
    let roundCostsUsd: [Double]?
    let costUsd: AgentJSONValue?
    let createdAt: String?
    let presentation: AgentMessagePresentationWire?
}

/// Canonical server projection. Keep the native fallback derived from timeline,
/// but consume this explicit truth bit so a future compacted/thinner timeline
/// can never silently drop the self-verification badge.
struct AgentMessagePresentationWire: Decodable {
    let selfCorrected: Bool?
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
    let startedAt: String?
    let lastDrivenAt: String?
    let attemptCount: Int?
    let maxAttempts: Int?
    let costTaka: Double?
    var id: String { planId }
}

private struct AgentPlanDriveHistoryView: Decodable, Identifiable, Equatable {
    let planId: String
    let goal: String
    let conversationId: String?
    let status: String       // completed | failed | stopped
    let input: String
    let result: String?
    let error: String?
    let startedAt: String?
    let completedAt: String?
    let steps: [AgentPlanDriveStep]?
    let costTaka: Double?
    /// Namespace terminal rows away from live rows. A task moves between the two
    /// arrays with the same planId; sharing SwiftUI identity can retain the old
    /// Running row body after a live Running → Finished reconciliation.
    var id: String { "finished-\(planId)" }
}

private struct AgentPlanDrivePanel: Decodable, Equatable {
    let enabled: Bool?
    let drives: [AgentPlanDriveView]?
    let finished: [AgentPlanDriveHistoryView]?
}

/// Existing `/api/assistant/todos` wire shape. Office and the native Background
/// Tasks sheet deliberately share this exact source, so a scheduler/agent status
/// change is reflected in both surfaces without maintaining a second todo state.
private struct AgentDailyTodo: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let description: String?
    let priority: String?
    let status: String?
    let dueDate: String?
    let source: String?
    let dutyKey: String?
    let createdAt: String?
    let completedAt: String?
}

private struct AgentDailyTodosResponse: Decodable {
    let todos: [AgentDailyTodo]?
}

/// Exact daily-duty row rendered by the Office monitor. Background Tasks reads
/// this same payload so the compact checklist cannot drift from Office's roster.
private struct AgentOfficeDuty: Decodable, Identifiable, Equatable {
    let id: String
    let duty: String
    let label: String
    let dutyDate: String
    let status: String
    let detail: String?
    let ranAt: String?
    let time: String?
    let createdAt: String
}

private struct AgentOfficeDutyResponse: Decodable {
    let agentDuties: [AgentOfficeDuty]
}

private struct AgentHeartbeatSettings: Decodable, Equatable {
    let enabled: Bool
    let autoArm: Bool
    let dailyHeadWakeCap: Int
    let officeHoursOnly: Bool
}

private struct AgentHeartbeatPulse: Decodable, Equatable {
    let pendingApprovals: Int?
    let ownerEscalations: Int?
    let openTodos: Int?
    let csAlerts: Int?
    let moneyRequests: Int?
    let agingApprovals: Int?
}

private struct AgentHeartbeatEntry: Decodable, Identifiable, Equatable {
    let id: String
    let at: String
    let kind: String
    let pulse: AgentHeartbeatPulse?
    let headWoke: Bool
    let summary: String
    let costUsd: Double?
    let conversationId: String?
}

private struct AgentHeartbeatFeed: Decodable, Equatable {
    let settings: AgentHeartbeatSettings
    let wakesToday: Int
    let entries: [AgentHeartbeatEntry]
    let nextCheckAt: String?
}

/// Server-authoritative owner-global turns. Unlike `isStreaming`, these survive
/// switching to another chat because they are read from the durable AgentTurn row.
private struct AgentActiveBackgroundTurn: Decodable, Identifiable, Equatable {
    let id: String
    let conversationId: String
    let conversationTitle: String?
    let kind: String
    let input: String
    let startedAt: String
    let updatedAt: String?
}

private struct AgentActiveBackgroundTurnsResponse: Decodable {
    let turns: [AgentActiveBackgroundTurn]
    let count: Int
    let attention: [AgentBackgroundAttention]?
    let attentionCount: Int?
}

private struct AgentBackgroundAttention: Decodable, Identifiable, Equatable {
    let id: String
    let conversationId: String?
    let type: String
    let summary: String
    let createdAt: String
}

private struct AgentPendingActionsResponse: Decodable {
    let actions: [AgentBackgroundAttention]?
}

private struct AgentDailyTodoMutationResponse: Decodable {
    let todo: AgentDailyTodo?
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
/// One SSE event — all fields optional, switch on `type`.
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
        /// Browser screenshot URL (tool_end / persisted timeline `shot`) — web parity:
        /// renders inline under the tool row and big inside the I/O sheet.
        var screenshot: String? = nil
    }
    /// Specialist sub-agent delegation (web DelegationCard parity) — live-session
    /// state fed by subagent_start/end; the server persists only a plain tool row,
    /// exactly like the web client.
    struct Delegation: Identifiable, Equatable {
        let id: String
        var role: String
        var roleLabel: String
        var task: String
        var done: Bool = false
        var success: Bool?
        var stopped: Bool = false
        var summary: String?
        var toolsUsed: [String]?
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
        /// Set locally the moment the owner taps Approve — drives the Creative-
        /// Studio-style render % on approved image cards (owner ask 2026-07-13).
        var approvedAt: Date? = nil
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
        /// A user-visible prose segment in its true chronological slot (parity
        /// roadmap RC-1 — these were silently dropped before, so cold-load showed
        /// only the last paragraph). `superseded` = verification rewrote it: it
        /// stays visible but is never the verified final answer.
        case text(String, superseded: Bool)
        case tool(id: String, name: String, ok: Bool?, live: Bool, inputPretty: String?, resultFull: String?, shot: String?)
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
        /// Browser screenshot URL — inline preview under the settled tool row.
        var screenshot: String? = nil
    }

    /// Chronological turn content: prose and activity rows grow together, in order,
    /// exactly as the SSE events arrive (Claude interleaved composition).
    enum TurnBlock: Identifiable, Equatable {
        case prose(id: String, text: String)
        case activity(ActivityBlock)
        case file(id: String, artifactId: String, name: String)
        // Cards keep their DATA in message.confirmCards/askCards (status updates flow
        // there); these blocks only pin WHERE in the reply the card appeared, so a
        // question asked mid-turn renders mid-turn — not dumped at the bottom
        // (owner report build-70 round 4).
        case confirmCard(id: String, pendingActionId: String)
        case askCard(id: String, askCardId: String)
        var id: String {
            switch self {
            case .prose(let id, _): return id
            case .activity(let a): return a.id
            case .file(let id, _, _): return id
            case .confirmCard(let id, _): return id
            case .askCard(let id, _): return id
            }
        }
    }

    /// `var` (not `let`): the stream-tail merge keeps the local id when the server
    /// copy arrives, so the row's SwiftUI identity never changes → prose never blinks.
    var id: String
    /// Durable DB id of this message (nil until the server copy is known). The UI
    /// id may stay a local "stream-…" id after the tail merge for row-identity
    /// stability — feedback/artifact POSTs must use THIS id, never the local one.
    var serverId: String?
    let role: Role
    var text: String = ""
    var imagePaths: [String] = []
    var localImages: [UIImage] = []   // optimistic composer thumbnails (user msgs)
    var confirmCards: [ConfirmCard] = []
    var askCards: [AskCard] = []
    /// Live specialist delegations (web parity: rendered as cards, not tool rows).
    var delegations: [Delegation] = []
    /// The honesty guard superseded a draft this turn (live verification_retry, or
    /// a persisted verify/superseded timeline entry) — drives the footer badge.
    var selfCorrected = false
    /// PR 3b — model_switch_required approval (web parity): the turn paused
    /// server-side for a premium-model upgrade decision.
    struct ModelSwitch: Equatable {
        var toLabel: String
        var fromLabel: String
        var fallbackModelId: String?
        var status: String = "pending"   // pending | approved | declined
    }
    var modelSwitch: ModelSwitch?
    var tools: [Tool] = []            // flat list (live streaming + fallback)
    var timeline: [TimelineEntry] = []
    var blocks: [TurnBlock] = []      // interleaved prose ↔ activity (streaming UI)
    var phases: [Phase] = []          // Claude-style activity timeline (live + persisted)
    var thinking: String?
    var thinkingMs: Int?
    var streamStartedAt: Date?
    var tokensIn: Int?
    var tokensOut: Int?
    var cacheCreation: Int?
    var cacheRead: Int?
    /// Actual provider API rounds (billing rows) — NOT UI activity phases (RC-4).
    var apiRounds: Int?
    var roundCostsUsd: [Double]?
    var costUsd: String?
    var createdAt: String?
    var isStreaming = false
    /// Prose block ids the verification guard superseded — data-truth only; the
    /// prose stays visible in place (roadmap invariant 3/4), never blanked.
    var supersededBlockIds: Set<String> = []

    /// The heartbeat's self-wake seed renders as a divider, never as an owner bubble
    /// (web: isHeartbeatWakeText / HEARTBEAT_WAKE_SENTINEL).
    var isHeartbeatWake: Bool {
        role == .user && text.trimmingCharacters(in: .whitespaces).hasPrefix("[স্বয়ংক্রিয় হার্টবিট")
    }

    static func from(_ wire: AgentMessageWire) -> AgentChatMessage {
        var m = AgentChatMessage(id: wire.id, role: wire.role == "user" ? .user : .assistant)
        m.serverId = wire.id
        // Canonical selfCorrected (mirrors the server presentation payload's rule):
        // a verify entry or a superseded draft means the answer was rewritten.
        m.selfCorrected = wire.presentation?.selfCorrected == true
            || (wire.timeline ?? []).contains { $0.t == "verify" || ($0.t == "text" && $0.state == "superseded") }
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
        m.cacheCreation = wire.cacheCreation
        m.cacheRead = wire.cacheRead
        m.apiRounds = wire.apiRounds
        m.roundCostsUsd = wire.roundCostsUsd
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
        // No durable tool-call rows → derive the tappable Tool list from the
        // canonical timeline instead, so a persisted tool row's I/O sheet (incl.
        // its screenshot) opens by the SAME id the blocks carry.
        if m.tools.isEmpty {
            m.tools = Self.syncTools(from: Self.timelineFromWire(wire))
        }
        m.phases = Self.buildPhases(timeline: Self.timelineFromWire(wire), messageId: wire.id, live: false,
                                    fallbackTools: m.tools)
        m.timeline = Self.timelineFromWire(wire)
        // Canonical convergence (parity roadmap RC-1/RC-3): when the persisted
        // timeline carries prose segments, rebuild the SAME interleaved TurnBlock
        // composition the live stream shows — cold-load, poll and relaunch then
        // render identically to the just-streamed turn (web ChronoFlow parity).
        if m.timeline.contains(where: { if case .text = $0 { return true }; return false }) {
            Self.applyPersistedBlocks(to: &m)
        }
        return m
    }

    /// Rebuild the interleaved prose ↔ activity TurnBlocks from the persisted
    /// timeline + cards, using the SAME builders the live SSE reducer uses — so
    /// settled/cold-loaded rows converge on the live composition by construction.
    static func applyPersistedBlocks(to m: inout AgentChatMessage) {
        var blocks: [TurnBlock] = []
        var superseded: Set<String> = []
        for e in m.timeline {
            switch e {
            case .text(let t, let isSuperseded):
                // One prose segment per timeline entry (never merged into the
                // previous one — segment boundaries are canonical).
                let id = "bp-\(m.id)-\(blocks.count)"
                blocks.append(.prose(id: id, text: t))
                if isSuperseded { superseded.insert(id) }
            case .think(let t):
                blocks = appendThinkBlock(blocks, chunk: t, messageId: m.id)
            case .tool(let id, let name, let ok, _, _, _, let shot):
                blocks = appendToolBlock(blocks, toolId: id, name: name, messageId: m.id)
                blocks = finalizeToolBlock(blocks, toolId: id, ok: ok ?? true, screenshot: shot)
            case .file(let aid, let name):
                blocks.append(.file(id: "fb-\(m.id)-\(aid)", artifactId: aid, name: name))
            }
        }
        for card in m.confirmCards {
            blocks.append(.confirmCard(id: "bc-\(m.id)-\(card.id)", pendingActionId: card.id))
        }
        for card in m.askCards {
            blocks.append(.askCard(id: "bq-\(m.id)-\(card.id)", askCardId: card.id))
        }
        m.blocks = blocks
        m.supersededBlockIds = superseded
    }

    /// Live-parity label for a persisted verification event (same string the
    /// verification_retry reducer shows mid-stream).
    static func verifyLabel(attempt: Int, max: Int) -> String {
        "নিজের উত্তর যাচাই করে ঠিক করে নিচ্ছি (\(almaBn(attempt))/\(almaBn(max)))…"
    }

    static func timelineFromWire(_ wire: AgentMessageWire) -> [TimelineEntry] {
        (wire.timeline ?? []).enumerated().compactMap { idx, e -> TimelineEntry? in
            if e.t == "think" {
                let t = (e.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                return t.isEmpty ? nil : .think(t)
            }
            if e.t == "text" {
                let t = e.text ?? ""
                return t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? nil : .text(t, superseded: e.state == "superseded")
            }
            if e.t == "verify" {
                // Truthful activity row between superseded draft and replacement —
                // rendered through the existing thinking-row style (design locked).
                return .think(verifyLabel(attempt: e.attempt ?? 1, max: e.max ?? (e.attempt ?? 1)))
            }
            if e.t == "tool" {
                // Persisted tool entries carry no id — a per-ordinal fallback keeps
                // every entry unique (a shared id used to collapse them to one row).
                return .tool(id: e.id ?? "tl-\(wire.id)-\(idx)", name: e.name ?? "টুল", ok: e.ok, live: false,
                             inputPretty: e.input?.pretty(), resultFull: e.result, shot: e.shot)
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
        if let idx = next.firstIndex(where: { if case .tool(let tid, _, _, _, _, _, _) = $0 { return tid == id }; return false }) {
            if case .tool(_, let n, let ok, let live, _, let result, let shot) = next[idx] {
                next[idx] = .tool(id: id, name: n, ok: ok, live: live, inputPretty: inputPretty ?? nil, resultFull: result, shot: shot)
            }
        } else {
            next.append(.tool(id: id, name: name, ok: nil, live: true, inputPretty: inputPretty, resultFull: nil, shot: nil))
        }
        return next
    }

    static func finalizeTool(_ tl: [TimelineEntry], id: String, ok: Bool,
                             result: String?, shot: String? = nil) -> [TimelineEntry] {
        tl.map { e in
            if case .tool(let tid, let name, _, _, let input, _, let oldShot) = e, tid == id {
                return TimelineEntry.tool(id: tid, name: name, ok: ok, live: false,
                                          inputPretty: input, resultFull: result, shot: shot ?? oldShot)
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
    static func finalizeToolBlock(_ blocks: [TurnBlock], toolId: String, ok: Bool,
                                  screenshot: String? = nil) -> [TurnBlock] {
        blocks.map { b in
            if case .activity(var a) = b, a.toolId == toolId {
                a.ok = ok
                a.live = false
                if let screenshot { a.screenshot = screenshot }
                return .activity(a)
            }
            return b
        }
    }

    static func syncTools(from timeline: [TimelineEntry]) -> [Tool] {
        timeline.compactMap { e in
            if case .tool(let id, let name, let ok, let live, let input, let result, let shot) = e {
                return Tool(id: id, name: name, ok: ok, preview: result.map { String($0.prefix(160)) },
                            live: live, inputPretty: input, resultFull: result, screenshot: shot)
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
            case .tool(let id, let name, let ok, let toolLive, let input, let result, let shot):
                if cur == nil {
                    cur = Phase(id: "ph-\(messageId)-t\(n)", headline: name, detail: nil, tools: [], live: false)
                }
                cur?.tools.append(Tool(id: id, name: name, ok: ok, preview: result.map { String($0.prefix(160)) },
                                       live: toolLive, inputPretty: input, resultFull: result, screenshot: shot))
                if toolLive { cur?.live = true }
            case .text:
                // Prose renders in the message body (TurnBlocks), never as a phase step.
                continue
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
    /// Transport lost while the server turn (presumably) still runs — drives the
    /// truthful "কাজ চলছে — সংযোগ ফিরছে…" label instead of an error (Phase 1.1).
    var reconnecting = false
    /// Bumped on every owner send — the screen scrolls to the tail on THIS signal
    /// (user-initiated), while plain count changes respect the reading position.
    var ownSendTick = 0
    /// personal_mode wire event (web parity) — the head is in LISTEN/personal mode.
    var personalMode = false
    /// done.needContinue arrived — fire one bounded machine "continue" after settle.
    private var pendingAutoContinue = false
    /// The durable predecessor turn that the server marked as continuation-eligible.
    /// This must be sent as control state, never as a visible owner message.
    private var pendingAutoContinueTurnId: String?
    private var autoContinueCount = 0

    // ── PR 5: durable-turn client state ─────────────────────────────────────
    /// Roadmap 4.3 — recovery descriptor, persisted so process death can't lose
    /// the running turn. Cleared only on terminal reconcile or explicit cancel.
    struct RecoverableTurn: Codable {
        var conversationId: String
        var turnId: String?
        var clientMessageId: String
        var lastSeq: Int
        var startedAt: Date
    }
    private static let recoverableTurnKey = "alma.assistant.recoverableTurn"
    private var recoverableTurn: RecoverableTurn? = AssistantVM.loadRecoverableTurn() {
        didSet {
            if let rt = recoverableTurn, let d = try? JSONEncoder().encode(rt) {
                UserDefaults.standard.set(d, forKey: Self.recoverableTurnKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.recoverableTurnKey)
            }
        }
    }
    private static func loadRecoverableTurn() -> RecoverableTurn? {
        guard let d = UserDefaults.standard.data(forKey: recoverableTurnKey) else { return nil }
        return try? JSONDecoder().decode(RecoverableTurn.self, from: d)
    }
    /// Idempotency key of the in-flight send (goes to the server with the body).
    private var currentClientMessageId: String?
    /// Highest durable-stream seq observed (single network-task writer; monotonic
    /// int reads are race-benign) — persisted into the descriptor on background.
    final class SeqBox: @unchecked Sendable { var value: Int = -1 }
    private let seqBox = SeqBox()
    /// A terminal done/error event flowed through apply() for the current watch —
    /// distinguishes "stream closed because finished" from "replay page ended".
    private var sawTerminalEvent = false
    /// Wall-clock of the last send — recovery uses it to tell OUR turn's terminal
    /// status apart from a PREVIOUS turn's stale terminal row (until Phase 3's
    /// clientMessageId gives exact identity).
    private var lastSendAt: Date?
    private var recoveryTask: Task<Void, Never>?
    private var recoveryInFlight = false
    /// Observer tokens live in a box whose own (nonisolated) deinit unregisters
    /// them — a MainActor class deinit may not touch isolated stored state.
    private final class NotificationTokenBox {
        var tokens: [NSObjectProtocol] = []
        deinit { for t in tokens { NotificationCenter.default.removeObserver(t) } }
    }
    private let lifecycleTokens = NotificationTokenBox()
    private var backgroundedAt: Date?
    /// 4.2 — nonessential polling pauses while backgrounded.
    private var isInBackground = false
    /// 4.3 — foreground→recovery latency metric anchor.
    private var lastForegroundAt: Date?
    private var streamTask: Task<Void, Never>?
    private var understandingTask: Task<Void, Never>?
    private var requestedLiveMode = "thinking"
    private var visualLiveMode = "idle"
    /// Stall watchdog (live-found 2026-07-16): a mid-turn SSE socket can die
    /// SILENTLY — no error, no FIN — leaving isStreaming=true forever while the
    /// server finishes into the durable log. The owner sat on "কাজ করছি… · ১ ধাপ"
    /// for minutes with the reply already in Postgres. Any applied batch bumps
    /// this; the 12s poll compares against it and hands a stalled stream to the
    /// EXISTING recovery path (durable replay), which was previously unreachable
    /// here because every trigger bailed on `isStreaming && !reconnecting`.
    private var lastLiveEventAt = Date()
    /// Last thinking_delta arrival — quiet thinking drives the "almost done
    /// thinking…" status verb (Claude-Code parity, owner spec 2026-07-16).
    var lastThinkingGrowthAt = Date.distantPast
    /// No live event for this long while "streaming" ⇒ treat the socket as dead.
    /// Generous on purpose: real turns emit thinking/tool events far more often,
    /// and a false positive only costs one idempotent status GET + seq-deduped
    /// replay attach — never a duplicate turn.
    private let streamStallSeconds: TimeInterval = 45
    /// Visible retry ladder (owner spec 2026-07-17): a stalled stream shows
    /// "আবার চেষ্টা N/৫…" in the status slot — never a silent hang — and after
    /// maxStallRetries failed recovery attempts the turn is truthfully ended
    /// client-side instead of spinning forever. Reset by any applied batch.
    var stallRetryAttempt = 0
    let maxStallRetries = 5

    /// Stable visual state. Understanding (the intake bloom) holds from the send
    /// until the FIRST real progress event arrives — thinking prose, text or a
    /// tool — not a fixed timer (owner spec 2026-07-16: "thought খোলার আগ পর্যন্ত
    /// understanding-এ থাকার কথা"). A minimum keeps the bloom from being cut
    /// mid-gesture by a very fast first token.
    var liveMode: String { visualLiveMode }

    /// Shortest visible intake: the grow-in needs about this long to read as a
    /// deliberate gesture; an earlier first delta waits out the remainder.
    private let minUnderstandingSeconds: TimeInterval = 0.85
    private var understandingStartedAt = Date.distantPast

    private func beginUnderstanding() {
        understandingTask?.cancel()
        understandingTask = nil
        requestedLiveMode = "thinking"
        visualLiveMode = "understanding"
        understandingStartedAt = Date()
    }

    private func requestLiveMode(_ mode: String) {
        requestedLiveMode = mode
        guard visualLiveMode == "understanding" else {
            visualLiveMode = mode
            return
        }
        // First real progress while the intake plays: hand off now if the bloom
        // has had its minimum, else exactly when the minimum lands. The task
        // reads requestedLiveMode at fire time, so later events refine the
        // destination for free. settleLiveMode() cancels it on turn end.
        let elapsed = Date().timeIntervalSince(understandingStartedAt)
        if elapsed >= minUnderstandingSeconds {
            visualLiveMode = mode
        } else if understandingTask == nil {
            let remaining = minUnderstandingSeconds - elapsed
            understandingTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
                guard let self, !Task.isCancelled else { return }
                self.visualLiveMode = self.requestedLiveMode
            }
        }
    }

    private func settleLiveMode() {
        understandingTask?.cancel()
        understandingTask = nil
        requestedLiveMode = "thinking"
        visualLiveMode = "idle"
        understandingStartedAt = .distantPast
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

    // S8 additive — artifacts + durable Plan-Drive background work.
    fileprivate var artifacts: [AgentArtifactWire] = []
    fileprivate var planDrive: AgentPlanDrivePanel?
    fileprivate var dailyAgentTodos: [AgentDailyTodo] = []
    fileprivate var officeDailyDuties: [AgentOfficeDuty] = []
    fileprivate var heartbeatFeed: AgentHeartbeatFeed?
    fileprivate var activeBackgroundTurns: [AgentActiveBackgroundTurn] = []
    fileprivate var backgroundAttention: [AgentBackgroundAttention] = []

    /// ONE source of truth for "approvals waiting on the owner" (owner-hit
    /// 2026-07-17: the footer said "1 Approval Waiting" but the sheet showed
    /// nothing — label and sheet were reading different sources). Server list
    /// (12s poll) UNION the pending confirm cards visible in this chat, deduped
    /// by pendingActionId; a locally-decided card drops out instantly even if
    /// the server list hasn't repolled yet. Build-73 behavior, one source.
    fileprivate var mergedAttention: [AgentBackgroundAttention] {
        var items = backgroundAttention
        var ids = Set(items.map(\.id))
        var decided = Set<String>()
        for message in messages {
            for card in message.confirmCards {
                if card.status == "pending" {
                    guard !ids.contains(card.id) else { continue }
                    ids.insert(card.id)
                    items.append(.init(
                        id: card.id,
                        conversationId: conversationId,
                        type: "approval",
                        summary: card.summary.split(separator: "\n").first.map(String.init) ?? card.summary,
                        createdAt: ""))
                } else {
                    decided.insert(card.id)
                }
            }
        }
        return items.filter { !decided.contains($0.id) }
    }
    private var usesBackgroundTaskDebugFixture = false
    var planDriveBusyPlanId: String?
    var dailyTodoBusyId: String?

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
        registerObserversOnce()
        await loadModels()
        await loadActiveConversation()
        await recoverFromPersistedDescriptor()
        async let drive: Void = loadPlanDrive()
        async let todos: Void = loadDailyAgentTodos()
        async let turns: Void = loadActiveBackgroundTurns()
        _ = await (drive, todos, turns)
        startPolling()
    }

    /// PR 5 — kill/relaunch recovery: the persisted descriptor outlives the
    /// process. If it points at a still-running turn (possibly in a different
    /// conversation than the active-pointer), follow it and re-attach; a stale
    /// descriptor for a finished turn is dropped after normal reconciliation.
    private func recoverFromPersistedDescriptor() async {
        guard let rt = recoverableTurn else { return }
        if isStreaming { return }   // active-conversation recovery already took it
        if conversationId != rt.conversationId {
            let st: TurnStatusResponse? = try? await AlmaAPI.shared.get(
                "/api/assistant/conversations/\(rt.conversationId)/turn-status")
            guard st?.status == "running" else { recoverableTurn = nil; return }
            await openConversation(rt.conversationId)   // ends in recoverTurnState
        } else {
            currentTurnId = rt.turnId ?? currentTurnId
            await recoverTurnState(trigger: "relaunch")
        }
        if !isStreaming { recoverableTurn = nil }        // nothing running — stale
    }

    /// One-time observer registration (bootstrap can re-run; observers must not
    /// stack — roadmap Phase 1.2). Lifecycle recovery: a suspended SSE socket dies
    /// while the server keeps working, so the moment the owner returns the app we
    /// verify the turn NOW — never wait for the 12s quiet poll.
    private func registerObserversOnce() {
        guard lifecycleTokens.tokens.isEmpty else { return }
        let nc = NotificationCenter.default
        lifecycleTokens.tokens.append(nc.addObserver(forName: AlmaAPI.authExpiredNotification,
                                              object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.authExpired = true }
        })
        lifecycleTokens.tokens.append(nc.addObserver(forName: UIApplication.didEnterBackgroundNotification,
                                              object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.backgroundedAt = Date()
                self.isInBackground = true
                // PR 5: stamp the replay cursor into the persisted descriptor —
                // if iOS kills the process, relaunch recovers from here.
                if var rt = self.recoverableTurn {
                    rt.lastSeq = self.seqBox.value
                    self.recoverableTurn = rt
                }
                AlmaTurnLog.event("turn.background", self.isStreaming ? "streaming" : "idle")
                // Server work continues — nothing is cancelled here by design.
            }
        })
        lifecycleTokens.tokens.append(nc.addObserver(forName: UIApplication.willEnterForegroundNotification,
                                              object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.isInBackground = false
                self.lastForegroundAt = Date()
                AlmaTurnLog.event("turn.foreground")
                await self.recoverTurnState(trigger: "foreground")
            }
        })
        lifecycleTokens.tokens.append(nc.addObserver(forName: UIApplication.didBecomeActiveNotification,
                                              object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.backgroundedAt != nil else { return }   // skip launch activation
                // Self-heal a stuck background flag: didBecomeActive fires in
                // strictly more cases than willEnterForeground (which is the
                // only other place clearing it) — a missed foreground event
                // would otherwise silently disable the poll loop + stall
                // watchdog for the rest of the session.
                self.isInBackground = false
                await self.recoverTurnState(trigger: "active")               // idempotent re-check
            }
        })
    }

    private func loadActiveConversation() async {
        do {
            let ptr: ActiveConversationPointer = try await AlmaAPI.shared.get("/api/assistant/active-conversation")
            if let cid = ptr.conversationId {
                conversationId = cid
                modelId = ptr.modelId
                await loadMessages(showSpinner: messages.isEmpty)
                await loadArtifacts()
                await recoverTurnState(trigger: "bootstrap")
            }
            authExpired = false
        } catch AlmaAPIError.notAuthenticated { authExpired = true } catch {
            // Pointer is a nicety — fall through to an empty new-chat state.
        }
    }

    // ── Phase 4.1: windowed history + delta sync ───────────────────────────
    /// The 12s full-history replacement is gone: the initial load takes the LATEST
    /// window, older pages prepend on demand, and the quiet poll asks "anything
    /// new since <stamp>?" (an empty array ≈ free) — a full window refresh runs
    /// only when the delta says something changed, or every 5th tick to true-up
    /// card statuses that mutate without new rows.
    // A native chat row can contain rich text, tools and cards. Keep the initial
    // window compact like ChatGPT/Claude; older messages remain one tap away.
    static let historyWindow = 24
    /// Max createdAt seen in the last window (ISO — lexicographic order works).
    private var lastSyncStamp: String?
    /// Rows PREPENDED via "load older" — merge preserves them above the window.
    private var paginatedPrefixCount = 0
    var canLoadOlder = false
    var loadingOlder = false

    func loadMessages(showSpinner: Bool = false) async {
        guard let cid = conversationId else { return }
        if showSpinner { loadingHistory = true }
        defer { loadingHistory = false }
        do {
            let wire: [AgentMessageWire] = try await AlmaAPI.shared.get(
                "/api/assistant/conversations/\(cid)/messages",
                query: ["limit": String(Self.historyWindow)])
            // Never clobber an in-flight optimistic/streaming tail with the poll.
            guard !isStreaming else { return }
            mergeServerMessages(wire)
            canLoadOlder = wire.count >= Self.historyWindow || paginatedPrefixCount > 0
            authExpired = false
            await loadOpenTasks()
        } catch AlmaAPIError.notAuthenticated { authExpired = true } catch {
            if showSpinner { errorToast = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription }
        }
    }

    /// Cheap delta poll: only rows newer than the sync stamp come back.
    private func pollForNewMessages() async {
        guard let cid = conversationId else { return }
        guard let stamp = lastSyncStamp else { await loadMessages(); return }
        guard let fresh: [AgentMessageWire] = try? await AlmaAPI.shared.get(
            "/api/assistant/conversations/\(cid)/messages", query: ["since": stamp]) else { return }
        if !fresh.isEmpty {
            AlmaTurnLog.event("sync.deltaNew", "\(fresh.count)")
            await loadMessages()   // one windowed refresh folds them in with full pairing
        }
    }

    /// Scroll-up pagination: prepend the page ABOVE the oldest loaded row.
    func loadOlderMessages() async {
        guard !loadingOlder, canLoadOlder, let cid = conversationId,
              let oldest = messages.first,
              !oldest.id.hasPrefix("local-"), !oldest.id.hasPrefix("stream-") else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        guard let older: [AgentMessageWire] = try? await AlmaAPI.shared.get(
            "/api/assistant/conversations/\(cid)/messages",
            query: ["limit": String(Self.historyWindow), "before": oldest.id]) else { return }
        canLoadOlder = older.count >= Self.historyWindow
        // A server without cursor support echoes rows we already hold — drop them
        // (graceful against an un-upgraded backend during rollout).
        let known = Set(messages.map(\.id))
        let fresh = older.filter { !known.contains($0.id) }
        guard !fresh.isEmpty else { canLoadOlder = false; return }
        let rows = fresh.map(AgentChatMessage.from)
        var tx = Transaction()
        tx.disablesAnimations = true
        withTransaction(tx) { messages.insert(contentsOf: rows, at: 0) }
        paginatedPrefixCount += rows.count
        AlmaTurnLog.event("sync.olderPage", "\(rows.count)")
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
            // Canonical-vs-thinner rule (parity roadmap invariant 6): the server
            // projection wins when it carries the full prose composition; a thinner
            // server row (timeline not yet persisted) never wipes richer local blocks.
            if incoming[i].blocks.isEmpty {
                incoming[i].blocks = old.blocks
                incoming[i].supersededBlockIds = old.supersededBlockIds
            }
            if incoming[i].thinking == nil { incoming[i].thinking = old.thinking }
            if incoming[i].thinkingMs == nil { incoming[i].thinkingMs = old.thinkingMs }
            if old.role == .user, !old.localImages.isEmpty { incoming[i].localImages = old.localImages }
            // Delegation cards are live-session state (the server persists only a
            // plain tool row, web parity) — the settle merge must not eat them.
            if incoming[i].delegations.isEmpty { incoming[i].delegations = old.delegations }
            if old.selfCorrected { incoming[i].selfCorrected = true }
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
        // 1.4: authoritative reconciliation applies in ONE non-animated transaction —
        // height changes from server truth must not run springs mid-scroll.
        // 4.1: rows prepended by "load older" sit ABOVE the refreshed window and
        // are preserved verbatim (they are settled history — nothing to merge).
        let prefix = Array(messages.prefix(paginatedPrefixCount))
        var tx = Transaction()
        tx.disablesAnimations = true
        withTransaction(tx) { messages = prefix + incoming }
        if let maxStamp = wire.compactMap(\.createdAt).max() { lastSyncStamp = maxStamp }
        AlmaTurnLog.event("turn.messagesReconciled", "count=\(incoming.count)")
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
            async let drive: Void = loadPlanDrive()
            async let todos: Void = loadDailyAgentTodos()
            async let turns: Void = loadActiveBackgroundTurns()
            _ = await (drive, todos, turns)
        }
        // PR 5: terminal + reconciled — the descriptor has done its job.
        recoverableTurn = nil
        currentClientMessageId = nil
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
                // 4.2: nonessential polling pauses while backgrounded — the
                // foreground observer runs recovery + one sync immediately anyway.
                if self.isInBackground {
                    // Diagnostic breadcrumb (2026-07-16 no-reply hunt): a STUCK
                    // isInBackground silently disables the stall watchdog and
                    // every quiet poll — make that state observable.
                    AlmaTurnLog.event("turn.pollTick", "SKIPPED-background streaming=\(self.isStreaming)")
                    continue
                }
                tick += 1
                AlmaTurnLog.event("turn.pollTick",
                                  "streaming=\(self.isStreaming) reconnecting=\(self.reconnecting) "
                                  + "silent=\(Int(Date().timeIntervalSince(self.lastLiveEventAt)))s")
                if !self.isStreaming {
                    // 4.1: cheap delta poll; a full windowed refresh only when the
                    // delta reports news, or every 5th tick (~60s) to true-up card
                    // statuses that mutate without new rows.
                    if tick % 5 == 0 { await self.loadMessages() }
                    else { await self.pollForNewMessages() }
                }
                // Server-side work started outside this client (approval execution,
                // continuation turns) shows the live spinner within one poll tick —
                // not only on app-resume (owner ask 2026-07-13, Claude-Code parity:
                // approve → "করছি বস" line + working animation until the reply lands).
                if !self.isStreaming { await self.recoverTurnState(trigger: "poll") }
                // Stall watchdog — a silently-dead mid-turn socket (no error, no
                // events) previously hung "কাজ করছি…" forever: every recovery
                // trigger bailed because isStreaming looked healthy. Marking it
                // `reconnecting` is truthful (glyph state, never an error toast)
                // and unlocks the normal durable-replay recovery.
                // Note: no !reconnecting guard — the ladder must keep counting
                // (and stay visible) while recovery itself is struggling, or one
                // failed attach would freeze it at 1/5 forever. recoverTurnState
                // is single-flighted internally.
                if self.isStreaming,
                   Date().timeIntervalSince(self.lastLiveEventAt) > self.streamStallSeconds {
                    if self.stallRetryAttempt >= self.maxStallRetries {
                        // Ladder exhausted — end the turn truthfully instead of
                        // hanging. finalizeTurn (via cancel) fetches the server's
                        // final message state, so a late server reply still lands.
                        AlmaTurnLog.event("turn.stallGiveUp", "\(self.maxStallRetries) retries")
                        self.stallRetryAttempt = 0
                        self.errorToast = "এজেন্টের সাড়া পাওয়া যাচ্ছে না — শেষ অবস্থা এনে দিচ্ছি"
                        self.streamTask?.cancel()
                    } else {
                        self.stallRetryAttempt += 1
                        AlmaTurnLog.event("turn.stallRetry",
                                          "\(self.stallRetryAttempt)/\(self.maxStallRetries)")
                        // Kick the visual mode machine too: a stuck-idle visual
                        // reads as a frozen loader even when recovery is working.
                        self.requestLiveMode("thinking")
                        await self.recoverTurnState(trigger: "stall")
                    }
                }
                // One bounded global query keeps task count identical across
                // chat sessions. Assign-on-change prevents needless main-view
                // invalidation when the server state is unchanged.
                await self.loadActiveBackgroundTurns()
                if tick % 2 == 0 {
                    let _: OkResponse? = try? await AlmaAPI.shared.send("POST", "/api/assistant/presence",
                                                                        body: [String: String]())
                }
                // Durable background work + today's tiny progress counter refresh
                // together every ~24s. Neither request mutates business state.
                if tick % 2 == 1 {
                    async let drive: Void = self.loadPlanDrive()
                    async let todos: Void = self.loadDailyAgentTodos()
                    _ = await (drive, todos)
                }
            }
        }
    }

    /// Roadmap Phase 1.3 — immediate, idempotent turn recovery. Fetches turn-status
    /// NOW (never waits for the 12s poll), keeps a VISIBLE streaming tail while the
    /// server works, then reconciles the final message. Single-flight: concurrent
    /// triggers (foreground + didBecomeActive + poll tick + transport-drop) share
    /// one recovery loop. UI transport state is never treated as server turn state.
    func recoverTurnState(trigger: String) async {
        guard let cid = conversationId else { return }
        if isStreaming && !reconnecting {
            // "Streaming" is CLIENT belief, not proof of a live socket: a mid-turn
            // SSE connection can die silently, and this early-return made every
            // recovery trigger trust it forever (owner-hit 2026-07-16 — reply sat
            // finished in the durable log while the UI showed "কাজ করছি…" for
            // minutes). If the stream has been silent too long, stop trusting it:
            // flip to the truthful reconnect state and re-verify via turn-status.
            // False positives are cheap — one idempotent GET plus a seq-deduped
            // replay attach; a real live stream just keeps applying on top.
            // 20s floor for foreground/active: comfortably past the 15s
            // first-event watchdog, so a merely-slow first token (still covered
            // by the direct path's own fallback) never triggers a parallel
            // replay attach next to a healthy live socket.
            let silent = Date().timeIntervalSince(lastLiveEventAt)
            let limit: TimeInterval = trigger == "stall" ? 0
                : trigger == "poll" ? streamStallSeconds : 20
            if silent <= limit { return }
            reconnecting = true
            AlmaTurnLog.event("turn.streamStallDetected", "\(trigger) after \(Int(silent))s silent")
        }
        if recoveryInFlight { return }
        recoveryInFlight = true
        defer { recoveryInFlight = false }
        AlmaTurnLog.event("turn.reconnectStarted", trigger)

        // Transient status failures keep the truthful reconnect UI — never a false error.
        var st: TurnStatusResponse?
        for attempt in 0..<3 {
            st = try? await AlmaAPI.shared.get("/api/assistant/conversations/\(cid)/turn-status")
            if st != nil { break }
            try? await Task.sleep(nanoseconds: UInt64(500_000_000 * (attempt + 1)))
        }
        guard let status = st else { return }   // unreachable — next trigger retries
        // 4.3 metric: foreground-to-recovery-state latency (no content, just ms).
        if let t0 = lastForegroundAt {
            lastForegroundAt = nil
            AlmaTurnLog.event("turn.foregroundRecoveryMs", "\(Int(Date().timeIntervalSince(t0) * 1000))")
        }

        if status.status == "running" {
            currentTurnId = status.turnId
            isStreaming = true
            ensureStreamingTail()               // P0-C fix: progress needs a row to live on
            thinkingLive = true
            requestLiveMode("thinking")
            // PR 5: every turn now has a durable event log — replay the missed
            // activity and continue LIVE instead of blind status-polling. Polling
            // remains the fallback when the stream can't be attached.
            if let tid = status.turnId {
                startDurableRecoveryTail(cid: cid, turnId: tid)
            } else {
                startRecoveryPolling(cid: cid)
            }
        } else if reconnecting || isStreaming {
            // We believed a turn was live. Is this terminal row OUR turn, or a stale
            // previous one (our send may have died before the server created a turn)?
            if isTerminalForOurTurn(status) {
                // Polling is the LAST discovery path — the done event (needContinue +
                // predecessor) never reached apply() here, so arm the structured
                // continuation from the server's own snapshot. claimContinuationTurn
                // keeps the claim exactly-once even if the event path also armed it.
                if status.continuationNeeded == true, status.status == "done", let tid = status.turnId {
                    pendingAutoContinue = true
                    pendingAutoContinueTurnId = tid
                }
                await finishRecovery(terminalStatus: status.status ?? "done")
            } else if trigger == "transport-drop" {
                // Bounded proof: turn creation can lag the send by a few seconds
                // (auth, persistence, vision). Poll briefly before declaring failure.
                startRecoveryPolling(cid: cid, awaitingTurnCreation: true)
            } else {
                await finishRecovery(terminalStatus: status.status ?? "done")
            }
        }
    }

    /// True when the latest turn's terminal status plausibly belongs to the turn we
    /// were watching: it is the turn we hold an id for, or it started at/after our
    /// last send (small clock slack). Phase 3 replaces this heuristic with
    /// clientMessageId identity.
    private func isTerminalForOurTurn(_ st: TurnStatusResponse) -> Bool {
        if let tid = st.turnId, tid == currentTurnId { return true }
        guard let sentAt = lastSendAt else { return true }   // resume path: any terminal is truth
        guard let raw = st.startedAt else { return true }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let started = iso.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
        guard let started else { return true }
        return started >= sentAt.addingTimeInterval(-15)
    }

    /// PR 5 recovery transport: attach the durable stream — the full activity
    /// timeline replays (thinking/tools/cards/prose, tail rebuilt authoritatively)
    /// and then continues live until the terminal event. If the stream closes
    /// without a terminal (Redis-less replay page) we reconcile via status; if it
    /// can't be attached at all, plain status polling takes over.
    private func startDurableRecoveryTail(cid: String, turnId: String) {
        recoveryTask?.cancel()
        recoveryTask = Task { [weak self] in
            guard let self else { return }
            self.sawTerminalEvent = false
            let buffer = AgentEventBuffer { [weak self] evs in self?.apply(evs) }
            do {
                try await self.tailDurableTurn(turnId, afterSeq: -1, buffer: buffer)
                guard !Task.isCancelled else { return }
                if self.sawTerminalEvent {
                    await self.finishRecovery(terminalStatus: "stream-terminal")
                } else {
                    // Replay ended without done/error — check whether the turn is
                    // really still running before deciding anything.
                    let s: TurnStatusResponse? = try? await AlmaAPI.shared.get(
                        "/api/assistant/conversations/\(cid)/turn-status")
                    guard !Task.isCancelled else { return }
                    if s?.status == "running" {
                        self.startRecoveryPolling(cid: cid)
                    } else {
                        await self.finishRecovery(terminalStatus: s?.status ?? "done")
                    }
                }
            } catch {
                guard !Task.isCancelled else { return }
                AlmaTurnLog.event("turn.recoveryTailFailed", "\(error)")
                self.startRecoveryPolling(cid: cid)
            }
        }
    }

    /// Poll turn-status with 1s initial cadence, exponential backoff capped at 3s,
    /// plus jitter (roadmap 1.3). `awaitingTurnCreation` = we are not yet sure the
    /// server ever created our turn; if none appears within ~20s, the send truly
    /// failed and the owner gets a Bangla error instead of a silent lost message.
    private func startRecoveryPolling(cid: String, awaitingTurnCreation: Bool = false) {
        recoveryTask?.cancel()
        recoveryTask = Task { [weak self] in
            var delay = 1.0
            var elapsed = 0.0
            var sawRunning = false
            // ~7 min bound — far beyond any healthy turn gap; the server's own
            // 30-min ghost timeout is the backstop of last resort.
            while elapsed < 420 {
                try? await Task.sleep(nanoseconds: UInt64((delay + Double.random(in: 0...0.25)) * 1_000_000_000))
                guard let self, !Task.isCancelled else { return }
                elapsed += delay
                let s: TurnStatusResponse? = try? await AlmaAPI.shared.get("/api/assistant/conversations/\(cid)/turn-status")
                guard !Task.isCancelled else { return }
                if let s {
                    if s.status == "running" {
                        sawRunning = true
                        self.currentTurnId = s.turnId
                        if self.reconnecting { self.ensureStreamingTail() }
                    } else if sawRunning || !awaitingTurnCreation || self.isTerminalForOurTurn(s) {
                        await self.finishRecovery(terminalStatus: s.status ?? "done")
                        return
                    } else if elapsed > 20 {
                        // No turn was ever created for our send — real failure.
                        await self.failRecovery()
                        return
                    }
                }
                delay = min(3.0, delay * 1.6)
            }
            guard let self, !Task.isCancelled else { return }
            await self.finishRecovery(terminalStatus: "timeout")
        }
    }

    /// Terminal: settle the tail, fold in server truth, and only then drop the
    /// reconnect label (roadmap: remove it after the final row appears).
    private func finishRecovery(terminalStatus: String) async {
        recoveryTask?.cancel()
        recoveryTask = nil
        isStreaming = false
        thinkingLive = false
        settleLiveMode()
        // 1.5: never retain an empty placeholder tail; a partial tail's blocks are a
        // strict prefix of the persisted reply — clear them so server truth renders
        // whole (blocks-empty rows use the settled summary + full-prose path).
        if let i = messages.lastIndex(where: { $0.isStreaming }) {
            messages[i].isStreaming = false
            if reconnecting {
                if messages[i].text.isEmpty && messages[i].timeline.isEmpty && messages[i].blocks.isEmpty {
                    messages.remove(at: i)
                } else {
                    messages[i].blocks = []
                }
            }
        }
        let lastAssistantBefore = messages.last(where: { $0.role == .assistant })?.id
        await loadMessages()
        // "Final content within 2s": persistence can trail the terminal status by a
        // beat — one short retry before we surface whatever state we have.
        if messages.last(where: { $0.role == .assistant })?.id == lastAssistantBefore {
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            await loadMessages()
        }
        reconnecting = false
        justSettledId = messages.last(where: { $0.role == .assistant })?.id
        if terminalStatus != "error" {
            AlmaAgentTickHaptic.turnCompleted()
        }
        recoverableTurn = nil            // terminal + reconciled (PR 5)
        AlmaTurnLog.event("turn.terminal", "recovery:\(terminalStatus)")
        if terminalStatus == "error" {
            errorToast = "সমস্যা হয়েছে — আবার চেষ্টা করুন"
        }
        // A LONG turn's direct SSE routinely drops mid-flight, so its done event
        // (with needContinue + predecessor id) arrives through THIS recovery tail —
        // only the direct-stream path fired the structured continuation, stranding
        // the server's continuation_needed=true forever (live 2026-07-15: turn
        // f2dfdc5d finished eligible and unclaimed). Same guarded no-op when no
        // continuation is pending.
        fireAutoContinueIfNeeded()
    }

    /// The send never became a server turn — keep the owner's message row, drop the
    /// placeholder tail, and say so in Bangla (roadmap 1.1: bounded recovery proved
    /// no turn exists — only now may a failure surface).
    private func failRecovery() async {
        recoveryTask?.cancel()
        recoveryTask = nil
        isStreaming = false
        thinkingLive = false
        settleLiveMode()
        reconnecting = false
        if let i = messages.lastIndex(where: { $0.isStreaming }) {
            if messages[i].text.isEmpty && messages[i].blocks.isEmpty {
                messages.remove(at: i)
            } else {
                messages[i].isStreaming = false
            }
        }
        recoverableTurn = nil            // nothing recoverable exists (PR 5)
        AlmaTurnLog.event("turn.terminal", "recovery:failed-no-turn")
        errorToast = "পাঠানো যায়নি — আবার চেষ্টা করুন"
        UINotificationFeedbackGenerator().notificationOccurred(.error)
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
        localIdByServerId = [:]   // 1.5: optimistic-ID maps never leak across conversations
        lastSyncStamp = nil       // 4.1: window/delta cursors are per-conversation
        paginatedPrefixCount = 0
        canLoadOlder = false
        messages = []
        openTasks = []
        artifacts = []
        await loadMessages(showSpinner: true)
        await loadArtifacts()
        let _: OkResponse? = try? await AlmaAPI.shared.send("POST", "/api/assistant/active-conversation",
                                                            body: ["conversationId": id])
        await recoverTurnState(trigger: "openConversation")
    }

    func newChat() async {
        stopStreaming(cancelServer: false)
        conversationId = nil     // server creates one on the first send
        localIdByServerId = [:]  // 1.5: optimistic-ID maps never leak across conversations
        lastSyncStamp = nil      // 4.1: window/delta cursors are per-conversation
        paginatedPrefixCount = 0
        canLoadOlder = false
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
        guard !usesBackgroundTaskDebugFixture else { return }
        if let panel: AgentPlanDrivePanel = try? await AlmaAPI.shared.get("/api/assistant/plan-driver") {
            planDrive = panel
        }
    }

    /// Agent-owned daily work is a global day view, not conversation prose. It is
    /// deliberately fetched separately and rendered only inside Background Tasks.
    fileprivate func loadDailyAgentTodos() async {
        guard !usesBackgroundTaskDebugFixture else { return }
        if let response: AgentDailyTodosResponse = try? await AlmaAPI.shared.get(
            "/api/assistant/todos", query: ["includeCompleted": "true"]) {
            dailyAgentTodos = (response.todos ?? []).filter { todo in
                todo.source != "owner" && todo.source != "owner_action"
            }
        }
    }

    /// Office's monitor already owns the canonical morning-to-night duty roster.
    /// Decode only `agentDuties`; Decodable intentionally ignores the larger
    /// monitor payload. This is read-only and does not change the legacy route.
    fileprivate func loadOfficeDailyDuties() async {
        guard !usesBackgroundTaskDebugFixture else { return }
        if let response: AgentOfficeDutyResponse = try? await AlmaAPI.shared.get(
            "/api/agent/staff-monitor") {
            officeDailyDuties = response.agentDuties
        }
    }

    /// Autonomous heartbeat history belongs in the same Background Tasks surface
    /// as Plan-Drive; this is the existing owner-facing, read-only feed.
    fileprivate func loadHeartbeatFeed() async {
        guard !usesBackgroundTaskDebugFixture else { return }
        if let feed: AgentHeartbeatFeed = try? await AlmaAPI.shared.get(
            "/api/assistant/heartbeat", query: ["limit": "60"]) {
            heartbeatFeed = feed
        }
    }

    /// One bounded owner-global query replaces N per-conversation status polls.
    /// It is cheap enough for the existing background cadence and keeps the main
    /// chat rendering completely independent from session switching.
    fileprivate func loadActiveBackgroundTurns() async {
        guard !usesBackgroundTaskDebugFixture else { return }
        if let response: AgentActiveBackgroundTurnsResponse = try? await AlmaAPI.shared.get(
            "/api/assistant/background-tasks") {
            if response.turns != activeBackgroundTurns {
                activeBackgroundTurns = response.turns
            }
            // Build 73's endpoint predates the additive `attention` field. Fall
            // back to the already-live canonical approvals API so this native
            // feature works immediately on the simulator and during rollout.
            let attention: [AgentBackgroundAttention]
            if let bundled = response.attention {
                attention = bundled
            } else {
                let existing: AgentPendingActionsResponse? = try? await AlmaAPI.shared.get(
                    "/api/assistant/actions", query: ["status": "pending", "limit": "50"])
                attention = existing?.actions ?? []
            }
            if attention != backgroundAttention {
                backgroundAttention = attention
            }
        }
    }

    func stopBackgroundTurn(id: String) async {
        if id == currentTurnId {
            stopStreaming()
            activeBackgroundTurns.removeAll { $0.id == id }
            return
        }
        let _: OkResponse? = try? await AlmaAPI.shared.send(
            "POST", "/api/assistant/turn/\(id)/cancel")
        activeBackgroundTurns.removeAll { $0.id == id }
    }

    /// Stop an agent-owned Office todo without deleting its audit trail. The
    /// shared todo endpoint updates Office and this sheet from the same row.
    func stopDailyAgentTodo(id: String) async {
        guard dailyTodoBusyId == nil else { return }
        dailyTodoBusyId = id
        defer { dailyTodoBusyId = nil }
        do {
            let _: AgentDailyTodoMutationResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/todos", body: ["id": id, "status": "cancelled"])
            await loadDailyAgentTodos()
        } catch {
            errorToast = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
        }
    }

    /// Owner one-click Plan-Drive control (web handlePlanDriveAction):
    /// resume / add-budget / abandon → POST, then refresh the panel.
    func planDriveAct(planId: String, action: String) async {
        guard planDriveBusyPlanId == nil else { return }
        if usesBackgroundTaskDebugFixture {
            debugPlanDriveAct(planId: planId, action: action)
            return
        }
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

    /// Deterministic Simulator proof: mirrors a real stop transition locally so
    /// the open sheet can prove live Running → Finished reconciliation without
    /// ever writing a fake plan to production.
    private func debugPlanDriveAct(planId: String, action: String) {
        guard action == "abandon", let panel = planDrive,
              let drive = panel.drives?.first(where: { $0.planId == planId }) else { return }
        let history = AgentPlanDriveHistoryView(
            planId: drive.planId, goal: drive.goal ?? "Background task",
            conversationId: drive.conversationId, status: "stopped",
            input: drive.goal ?? "Background task", result: nil,
            error: "Owner task-টি বন্ধ করেছেন।", startedAt: drive.startedAt,
            completedAt: ISO8601DateFormatter().string(from: Date()),
            steps: drive.steps, costTaka: drive.costTaka)
        withAnimation(.spring(response: 0.38, dampingFraction: 0.88)) {
            planDrive = AgentPlanDrivePanel(
                enabled: panel.enabled,
                drives: (panel.drives ?? []).filter { $0.planId != planId },
                finished: [history] + (panel.finished ?? []))
        }
        errorToast = "Task বন্ধ করা হয়েছে"
    }

    // ── TTS ("শুনুন") ──────────────────────────────────────────────────────

    /// Web FeedbackButtons parity — native thumbs file the same traceable owner
    /// feedback against this exact conversation/message. Simulator fixtures stay
    /// entirely local and never write debug feedback to production data.
    func submitReplyFeedback(messageId: String, kind: String) async -> Bool {
        guard !usesBackgroundTaskDebugFixture else { return true }
        guard let conversationId else {
            errorToast = "Feedback save করার conversation পাওয়া যায়নি"
            return false
        }
        do {
            let _: OkResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/feedback",
                body: ["kind": kind, "conversationId": conversationId, "messageId": messageId])
            return true
        } catch {
            errorToast = "Feedback save করা গেল না"
            return false
        }
    }

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
        /// Roadmap PR 5 — idempotency key: one key = at most one stored message and
        /// one server turn, however many times transport makes us retry.
        var clientMessageId: String? = nil
        /// AGENT-IOS-001 — the tapped ask-card's id rides with the option text so
        /// the server binds the answer to the EXACT question (no text-match guess).
        var askCardId: String? = nil
        /// PR 3b — model-upgrade approval resume: re-runs the SAME turn on the
        /// premium model (approve) or the cheap fallback (decline). No new message.
        struct Resume: Encodable { let approve: Bool; var fallbackModelId: String? = nil }
        var resume: Resume? = nil
        /// Server-claimed continuation of a completed turn. When present, the
        /// route creates no owner message and atomically consumes the predecessor
        /// continuation flag (web parity).
        var autoContinueFromTurnId: String? = nil
    }

    /// PR 3b — owner tapped the model-switch card: resume the paused turn on the
    /// chosen model (web parity: POST /chat with resume{}, same conversation).
    func resumeModelSwitch(messageId: String, approve: Bool) {
        guard !isStreaming else { return }
        if let i = messages.firstIndex(where: { $0.id == messageId }) {
            messages[i].modelSwitch?.status = approve ? "approved" : "declined"
        }
        let fallback = messages.first(where: { $0.id == messageId })?.modelSwitch?.fallbackModelId
        AlmaAgentTickHaptic.ownerSend()
        isStreaming = true
        lastLiveEventAt = Date()
        thinkingLive = true
        beginUnderstanding()
        currentTurnId = nil
        reconnecting = false
        lastSendAt = Date()
        seqBox.value = -1
        sawTerminalEvent = false
        AlmaTurnLog.event("turn.submit", "model-switch-resume")
        ensureStreamingTail()
        let body = ChatBody(conversationId: conversationId, message: "",
                            files: [], modelId: modelId ?? "auto",
                            resume: .init(approve: approve,
                                          fallbackModelId: approve ? nil : fallback))
        streamTask = Task { [weak self] in
            await self?.runTurn(body: body)
        }
    }

    func send(_ raw: String, isAutoContinue: Bool = false, askCardId: String? = nil, autoContinueFromTurnId: String? = nil) {
        if !isAutoContinue {
            autoContinueCount = 0
            pendingAutoContinue = false
            pendingAutoContinueTurnId = nil
        }   // manual message resets the budget and cancels a queued machine turn
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let structuredAutoContinue = isAutoContinue && autoContinueFromTurnId != nil
        let readyFiles: [AgentFileRef] = pendingFiles.compactMap {
            if case .ready(let ref) = $0.state { return ref } else { return nil }
        }
        guard !text.isEmpty || !readyFiles.isEmpty || structuredAutoContinue, !isStreaming else { return }
        AlmaAgentTickHaptic.ownerSend()

        // A structured continuation is server control state, not a new owner
        // message. Rendering a bubble here was the native-only duplicate-turn bug.
        if !structuredAutoContinue {
            var userMsg = AgentChatMessage(id: "local-\(UUID().uuidString)", role: .user, text: text)
            userMsg.localImages = pendingFiles.compactMap {
                if case .failed = $0.state { return nil } else { return $0.image }
            }
            messages.append(userMsg)
        }
        pendingFiles = []
        isStreaming = true
        lastLiveEventAt = Date()   // stall clock starts at the send, not at first event
        thinkingLive = true
        beginUnderstanding()
        currentTurnId = nil
        reconnecting = false
        recoveryTask?.cancel(); recoveryTask = nil
        lastSendAt = Date()
        ownSendTick += 1
        // PR 5 — idempotency key: however transport fails, THIS send can only ever
        // become one server message + one turn + one execution.
        let clientMessageId = structuredAutoContinue ? nil : UUID().uuidString
        currentClientMessageId = clientMessageId
        seqBox.value = -1
        sawTerminalEvent = false
        AlmaTurnLog.event("turn.submit", structuredAutoContinue
                          ? "auto-continuation:\(autoContinueFromTurnId!)"
                          : (clientMessageId ?? "manual"))
        ensureStreamingTail()

        let body = ChatBody(conversationId: conversationId, message: text,
                            files: readyFiles, modelId: modelId ?? "auto",
                            clientMessageId: clientMessageId, askCardId: askCardId,
                            autoContinueFromTurnId: autoContinueFromTurnId)
        streamTask = Task { [weak self] in
            await self?.runTurn(body: body)
        }
    }

    private func runTurn(body: ChatBody) async {
        var handedToRecovery = false
        defer {
            if !handedToRecovery {
                isStreaming = false
                thinkingLive = false
                settleLiveMode()
                if let i = messages.lastIndex(where: { $0.isStreaming }) { messages[i].isStreaming = false }
            }
        }
        // Phase 2: one buffer per turn — deltas coalesce off-main and land as
        // batched reducer applies (roadmap 2.3).
        let buffer = AgentEventBuffer { [weak self] evs in self?.apply(evs) }
        do {
            await AlmaAPI.shared.syncCookies()
            var req = URLRequest(url: AssistantNet.base.appendingPathComponent("/api/assistant/chat"))
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)

            let firstEvent = AssistantNet.EventFlag()
            do {
                // Direct SSE, with a 15s first-event watchdog. PR 5: the fallback no
                // longer re-sends the prompt — it asks /turn for THE turn by
                // clientMessageId and tails its durable stream.
                try await withFirstEventWatchdog(seconds: 15, sawEvent: { firstEvent.raised }) {
                    try await AssistantNet.streamEvents(request: req, buffer: buffer, firstEvent: firstEvent)
                }
            } catch is WatchdogTimeout {
                // A continuation has already been atomically claimed by the
                // direct /chat route. The legacy worker handoff requires a
                // user message and would turn this control action into a second
                // owner-authored job, so never fall back by inventing one.
                if body.autoContinueFromTurnId != nil {
                    throw WatchdogTimeout()
                }
                try await runWorkerFallback(body: body, buffer: buffer)
            } catch AlmaAPIError.notAuthenticated {
                // One cookie refresh + retry, mirroring AlmaAPI.perform. The retry
                // carries the SAME clientMessageId — if the first attempt secretly
                // created the turn, the server answers 202 duplicate (caught below).
                AlmaAPI.shared.invalidateCookieCache()
                await AlmaAPI.shared.syncCookies()
                try await AssistantNet.streamEvents(request: req, buffer: buffer)
            }
            // Server truth (final card ids/statuses, tool rows, cost) merges into the
            // tail in place — never a wholesale replace (prose must not blink).
            await finalizeTurn()
            AlmaTurnLog.event("turn.terminal", "stream-done")
            fireAutoContinueIfNeeded()
        } catch is CancellationError {
            await finalizeTurn()
        } catch let dup as AssistantNet.DuplicateTurn {
            // A retry raced an EXISTING turn (Phase 3 idempotency) — observe it,
            // never re-run (roadmap invariant 2).
            AlmaTurnLog.event("turn.duplicateObserved", dup.turnId)
            currentTurnId = dup.turnId
            if conversationId == nil { conversationId = dup.conversationId }
            do {
                try await tailDurableTurn(dup.turnId, afterSeq: -1, buffer: buffer)
                await finalizeTurn()
            } catch {
                handedToRecovery = true
                reconnecting = true
                ensureStreamingTail()
                Task { [weak self] in await self?.recoverTurnState(trigger: "duplicate-tail-drop") }
            }
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            let kind = TurnFailureKind.classify(error)
            AlmaTurnLog.event("turn.transportDisconnected", "\(kind) turnId=\(currentTurnId ?? "nil")")
            switch kind {
            case .transportInterrupted, .offline:
                // Roadmap Phase 1.1 — the server deliberately keeps the turn alive
                // after a dropped client socket (chat route detaches from req.signal).
                // Freeze the partial reply, show the truthful Bangla reconnect state
                // and verify via turn-status; a raw English transport toast must
                // never appear while the turn may still be running.
                if conversationId != nil {
                    handedToRecovery = true
                    reconnecting = true
                    ensureStreamingTail()
                    thinkingLive = true
                    requestLiveMode("thinking")
                    Task { [weak self] in await self?.recoverTurnState(trigger: "transport-drop") }
                } else {
                    // No conversation was ever created — nothing recoverable exists.
                    errorToast = kind.banglaMessage
                    UINotificationFeedbackGenerator().notificationOccurred(.error)
                }
            case .authentication:
                authExpired = true
            case .server, .terminalAgentError:
                errorToast = kind.banglaMessage
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
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

    /// PR 5 — the first-event watchdog fallback. No longer re-sends the prompt as
    /// a fresh job (the old P0-D duplicate-work race): /turn is idempotent on
    /// clientMessageId, so the server returns the EXISTING turn when the direct
    /// run is healthy, or re-dispatches a dead one to the VPS worker. Either way
    /// we then tail ONE durable stream — the same message can never run twice.
    private func runWorkerFallback(body: ChatBody, buffer: AgentEventBuffer) async throws {
        struct TurnBody: Encodable {
            let conversationId: String?
            let message: String
            let files: [AgentFileRef]
            let clientMessageId: String?
            let askCardId: String?
        }
        let enq: TurnEnqueueResponse = try await AlmaAPI.shared.send(
            "POST", "/api/assistant/turn",
            body: TurnBody(conversationId: body.conversationId, message: body.message,
                           files: body.files, clientMessageId: body.clientMessageId,
                           askCardId: body.askCardId))
        currentTurnId = enq.turnId
        if conversationId == nil { conversationId = enq.conversationId }
        if let cid = conversationId, let cmid = body.clientMessageId {
            recoverableTurn = RecoverableTurn(conversationId: cid, turnId: enq.turnId,
                                              clientMessageId: cmid, lastSeq: -1, startedAt: Date())
        }
        try await tailDurableTurn(enq.turnId, afterSeq: -1, buffer: buffer)
    }

    /// Attach to a turn's durable stream: replay everything after `afterSeq`, then
    /// live-tail. A FULL replay (afterSeq < 0) rebuilds the tail from scratch —
    /// partial content rendered before a drop is replaced by the authoritative
    /// log, never doubled (the direct stream carries no seq to splice on). The
    /// wipe fires on the stream's `turn_snapshot` hello, NOT before the request:
    /// a failed attach must keep the frozen partial on screen.
    private var pendingReplayReset = false

    private func tailDurableTurn(_ turnId: String, afterSeq: Int, buffer: AgentEventBuffer) async throws {
        if afterSeq < 0 { pendingReplayReset = true }
        defer { pendingReplayReset = false }
        var comps = URLComponents(url: AssistantNet.base.appendingPathComponent("/api/assistant/turn/\(turnId)/stream"),
                                  resolvingAgainstBaseURL: false)!
        if afterSeq >= 0 { comps.queryItems = [URLQueryItem(name: "afterSeq", value: String(afterSeq))] }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "GET"
        let box = seqBox
        try await AssistantNet.streamEvents(request: req, buffer: buffer,
                                            onSeq: { box.value = max(box.value, $0) })
    }

    /// Wipe the streaming tail's derived content ahead of an authoritative replay.
    private func resetStreamingTailForReplay() {
        ensureStreamingTail()
        guard let i = messages.lastIndex(where: { $0.isStreaming }) else { return }
        messages[i].text = ""
        messages[i].thinking = nil
        messages[i].timeline = []
        messages[i].blocks = []
        messages[i].phases = []
        messages[i].tools = []
        messages[i].confirmCards = []
        messages[i].askCards = []
        messages[i].delegations = []
    }

    /// Phase 2 reducer — applies ONE buffered batch per MainActor hop (roadmap 2.3).
    /// Deltas arrive pre-coalesced; `refreshPhases` runs once per flush, not once
    /// per token. Every wire event has an explicit handler (roadmap 2.1) — unknown
    /// types were already telemetried at decode and are dropped knowingly.
    /// Bumped once per applied batch that grew the streaming tail — thinking,
    /// tool rows, screenshots, cards AND text alike. The scroll-follow watches
    /// THIS (owner-hit 2026-07-16: it watched `last?.text` only, so tool-heavy
    /// agentic turns grew downward without following until the final prose).
    var streamGrowthTick = 0

    private func apply(_ events: [AgentTurnEvent]) {
        // Stall watchdog heartbeat: ANY delivered batch proves the stream lives.
        lastLiveEventAt = Date()
        if stallRetryAttempt != 0 { stallRetryAttempt = 0 }   // stream is back
        var touchedStream = false
        for ev in events {
            switch ev {
            case .conversationId(let id):
                conversationId = id
            case .turnId(let id):
                currentTurnId = id
                // PR 5: the turn is now addressable — persist the recovery descriptor
                // so even process death can find its way back.
                if let cid = conversationId, let cmid = currentClientMessageId {
                    recoverableTurn = RecoverableTurn(conversationId: cid, turnId: id,
                                                      clientMessageId: cmid,
                                                      lastSeq: seqBox.value, startedAt: Date())
                }
            case .personalMode(let active):
                personalMode = active
            case .modelInfo(let label):
                if !label.isEmpty { modelLabel = label }
            case .thinkingDelta(let chunk):
                guard !chunk.isEmpty else { break }
                if reconnecting { reconnecting = false }   // live content flows again
                lastThinkingGrowthAt = Date()
                requestLiveMode("thinking")
                ensureStreamingTail()
                if let i = messages.lastIndex(where: { $0.isStreaming }) {
                    messages[i].thinking = (messages[i].thinking ?? "") + chunk
                    messages[i].timeline = AgentChatMessage.appendThink(messages[i].timeline, chunk: chunk)
                    messages[i].blocks = AgentChatMessage.appendThinkBlock(
                        messages[i].blocks, chunk: chunk, messageId: messages[i].id)
                    touchedStream = true
                }
            case .textDelta(let chunk):
                guard !chunk.isEmpty else { break }
                if reconnecting { reconnecting = false }   // live content flows again
                requestLiveMode("writing")
                ensureStreamingTail()
                if let i = messages.lastIndex(where: { $0.isStreaming }) {
                    if messages[i].text.isEmpty, let start = messages[i].streamStartedAt {
                        messages[i].thinkingMs = max(1, Int(Date().timeIntervalSince(start) * 1000))
                    }
                    messages[i].text += chunk
                    messages[i].blocks = AgentChatMessage.appendProseBlock(
                        messages[i].blocks, chunk: chunk, messageId: messages[i].id)
                    touchedStream = true
                }
            case .toolStart(let tid, let name, let inputPretty):
                requestLiveMode("searching")
                ensureStreamingTail()
                if let i = messages.lastIndex(where: { $0.isStreaming }) {
                    messages[i].timeline = AgentChatMessage.pushOrUpdateTool(
                        messages[i].timeline, id: tid, name: name, inputPretty: inputPretty)
                    messages[i].blocks = AgentChatMessage.appendToolBlock(
                        messages[i].blocks, toolId: tid, name: name, messageId: messages[i].id)
                    touchedStream = true
                }
            case .toolEnd(let tid, let ok, let preview, let screenshot):
                requestLiveMode("writing")
                if let i = messages.lastIndex(where: { $0.isStreaming }), !tid.isEmpty {
                    // Web parity: the browser screenshot renders INLINE under the
                    // tool row (and big inside the I/O sheet) — no text placeholder.
                    messages[i].timeline = AgentChatMessage.finalizeTool(
                        messages[i].timeline, id: tid, ok: ok, result: preview, shot: screenshot)
                    messages[i].blocks = AgentChatMessage.finalizeToolBlock(
                        messages[i].blocks, toolId: tid, ok: ok, screenshot: screenshot)
                    touchedStream = true
                }
            case .subagentStart(let sid, let role, let roleLabel, let task):
                // Specialist worker spun up — a dedicated delegation CARD (web
                // DelegationCard parity), not a plain tool row.
                requestLiveMode("searching")
                ensureStreamingTail()
                if let i = messages.lastIndex(where: { $0.isStreaming }),
                   !messages[i].delegations.contains(where: { $0.id == sid }) {
                    messages[i].delegations.append(.init(id: sid, role: role,
                                                         roleLabel: roleLabel, task: task ?? ""))
                    touchedStream = true
                }
            case .subagentEnd(let sid, let ok, let summary, let toolsUsed):
                if let i = messages.lastIndex(where: { $0.isStreaming }), !sid.isEmpty,
                   let j = messages[i].delegations.firstIndex(where: { $0.id == sid }) {
                    messages[i].delegations[j].done = true
                    messages[i].delegations[j].success = ok
                    messages[i].delegations[j].summary = summary
                    messages[i].delegations[j].toolsUsed = toolsUsed
                    touchedStream = true
                }
            case .artifactSaved(let aid, let title):
                // A tool filed a document (SEO report, research…) — drop a FILE CARD
                // into the reply flow, Claude-style (web AgentApp parity).
                ensureStreamingTail()
                if let i = messages.lastIndex(where: { $0.isStreaming }) {
                    messages[i].timeline.append(.file(id: aid, name: title))
                    messages[i].blocks.append(.file(id: "fb-\(messages[i].id)-\(aid)", artifactId: aid, name: title))
                }
            case .confirmCard(let pid, let summary, let actionType, let costEstimate):
                ensureStreamingTail()
                if let i = messages.lastIndex(where: { $0.isStreaming }),
                   !messages[i].confirmCards.contains(where: { $0.id == pid }) {
                    messages[i].confirmCards.append(.init(id: pid, summary: summary,
                                                          status: "pending", actionType: actionType,
                                                          costEstimate: costEstimate))
                    messages[i].blocks.append(.confirmCard(id: "bc-\(messages[i].id)-\(pid)", pendingActionId: pid))
                }
            case .askCard(let aid, let question, let options):
                ensureStreamingTail()
                if let i = messages.lastIndex(where: { $0.isStreaming }),
                   !messages[i].askCards.contains(where: { $0.id == aid }) {
                    messages[i].askCards.append(.init(id: aid, question: question,
                                                      options: options, status: "pending",
                                                      selectedOption: nil))
                    messages[i].blocks.append(.askCard(id: "bq-\(messages[i].id)-\(aid)", askCardId: aid))
                }
            case .verificationRetry(let attempt, let maxAttempts):
                // Parity roadmap RC-2: NEVER blank the reply. The draft prose stays
                // visible in place, marked superseded in data; a truthful verification
                // activity row follows it, and the rewrite streams in after that —
                // exactly the composition the server now persists (t:'verify').
                requestLiveMode("thinking")
                ensureStreamingTail()
                if let i = messages.lastIndex(where: { $0.isStreaming }) {
                    if let lastProse = messages[i].blocks.last(where: {
                        if case .prose = $0 { return true }; return false
                    }), case .prose(let pid, let draft) = lastProse {
                        messages[i].supersededBlockIds.insert(pid)
                        messages[i].timeline.append(.text(draft, superseded: true))
                    }
                    // Final-answer accumulator resets (server does the same with
                    // finalText) — the visible blocks are untouched.
                    messages[i].text = ""
                    messages[i].selfCorrected = true
                    let label = AgentChatMessage.verifyLabel(attempt: attempt, max: maxAttempts)
                    messages[i].timeline = AgentChatMessage.appendThink(messages[i].timeline, chunk: label)
                    messages[i].blocks = AgentChatMessage.appendThinkBlock(
                        messages[i].blocks, chunk: label, messageId: messages[i].id)
                    touchedStream = true
                }
            case .modelSwitchRequired(let toLabel, let fromLabel, let fallbackModelId):
                // PR 3b — the turn paused server-side for a premium-model upgrade
                // decision. Attach the native approval card (web parity) and settle
                // the tail; approve/decline resumes the SAME turn via resume{}.
                thinkingLive = false
                settleLiveMode()
                ensureStreamingTail()
                if let i = messages.lastIndex(where: { $0.isStreaming }) {
                    messages[i].modelSwitch = .init(toLabel: toLabel, fromLabel: fromLabel,
                                                    fallbackModelId: fallbackModelId)
                    messages[i].isStreaming = false
                }
                isStreaming = false
            case .conversationCompacted(let newId):
                // Server folded this thread into a fresh conversation (cost cap) —
                // follow it, exactly like the web client.
                conversationId = newId
            case .done(_, let tokensIn, let tokensOut, let costUsd, let needContinue, let apiRounds,
                       let cacheCreation, let cacheRead, let roundCostsUsd):
                if let i = messages.lastIndex(where: { $0.isStreaming }) {
                    if let tokensIn { messages[i].tokensIn = tokensIn }
                    if let tokensOut { messages[i].tokensOut = tokensOut }
                    if let cacheCreation { messages[i].cacheCreation = cacheCreation }
                    if let cacheRead { messages[i].cacheRead = cacheRead }
                    if let apiRounds { messages[i].apiRounds = apiRounds }
                    if let roundCostsUsd { messages[i].roundCostsUsd = roundCostsUsd }
                    if let costUsd, costUsd > 0 { messages[i].costUsd = String(format: "%.4f", costUsd) }
                }
                if needContinue {
                    // The server emits turn_id before done. Refuse to schedule a
                    // continuation without that durable predecessor id: a plain
                    // "continue" message is never a safe fallback.
                    if let predecessor = currentTurnId {
                        pendingAutoContinue = true
                        pendingAutoContinueTurnId = predecessor
                    } else {
                        AlmaTurnLog.event("turn.autoContinueSkipped", "missing-predecessor-turn-id")
                    }
                }
                sawTerminalEvent = true
                thinkingLive = false
                settleLiveMode()
                AlmaAgentTickHaptic.turnCompleted()
            case .turnError(let message):
                sawTerminalEvent = true
                thinkingLive = false
                settleLiveMode()
                errorToast = message
            case .turnSnapshot(let turnId, let convId, _, _):
                // Durable-stream hello (PR 5) — reconcile ids on (re)connect, and
                // NOW (stream provably attached) wipe the frozen partial so the
                // authoritative replay rebuilds the tail without doubling.
                if let turnId { currentTurnId = turnId }
                if conversationId == nil, let convId { conversationId = convId }
                if pendingReplayReset {
                    pendingReplayReset = false
                    resetStreamingTailForReplay()
                }
            case .replayContinue(let afterSeq):
                // Page-capped replay: continue from the cursor (no tail reset).
                if let tid = currentTurnId {
                    recoveryTask?.cancel()
                    recoveryTask = Task { [weak self] in
                        guard let self else { return }
                        let buffer = AgentEventBuffer { [weak self] evs in self?.apply(evs) }
                        try? await self.tailDurableTurn(tid, afterSeq: afterSeq, buffer: buffer)
                    }
                }
            case .unknown:
                break   // telemetried at decode (stream.unknownEvent)
            }
        }
        if touchedStream, let i = messages.lastIndex(where: { $0.isStreaming }) {
            AgentChatMessage.refreshPhases(on: &messages[i], live: messages[i].text.isEmpty)
            streamGrowthTick &+= 1
        }
    }

    /// Web parity (AgentApp MAX_AUTO_CONTINUES): a serverless-deadline turn ended
    /// mid-task — machine-send "continue" so long jobs finish end-to-end. Bounded;
    /// any manual owner message resets the budget (see send()).
    private static let maxAutoContinues = 8
    private static let autoContinueText = "continue — ঠিক যেখানে ছিলে সেখান থেকে কাজ চালিয়ে যাও"

    private func fireAutoContinueIfNeeded() {
        guard pendingAutoContinue else { return }
        pendingAutoContinue = false
        guard let predecessor = pendingAutoContinueTurnId else {
            AlmaTurnLog.event("turn.autoContinueSkipped", "missing-predecessor-turn-id")
            return
        }
        pendingAutoContinueTurnId = nil
        guard autoContinueCount < Self.maxAutoContinues else {
            errorToast = "কাজটা লম্বা — অটো-continue সীমা শেষ। \"continue\" লিখলে বাকিটা এগোবে।"
            return
        }
        autoContinueCount += 1
        AlmaTurnLog.event("turn.autoContinue", "\(autoContinueCount)/\(Self.maxAutoContinues)")
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            guard let self, !self.isStreaming else { return }
            self.send(Self.autoContinueText, isAutoContinue: true,
                      autoContinueFromTurnId: predecessor)
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
        // Conversation switch / Stop also ends any reconnect-recovery loop; server
        // work is only cancelled when explicitly asked (roadmap invariant 9).
        recoveryTask?.cancel()
        recoveryTask = nil
        reconnecting = false
        if cancelServer, let tid = currentTurnId {
            recoverableTurn = nil    // explicit cancel — nothing to recover (PR 5)
            Task {
                let _: OkResponse? = try? await AlmaAPI.shared.send("POST", "/api/assistant/turn/\(tid)/cancel")
            }
        }
        isStreaming = false
        thinkingLive = false
        settleLiveMode()
        if let i = messages.lastIndex(where: { $0.isStreaming }) {
            messages[i].isStreaming = false
            // Web parity: a running specialist shows the ⏹ stopped glyph, never a
            // forever-spinner, once the owner stops the turn.
            for j in messages[i].delegations.indices where !messages[i].delegations[j].done {
                messages[i].delegations[j].stopped = true
            }
        }
    }

    // ── Phase 0 stress fixture (roadmap) ───────────────────────────────────

    /// Local reproduction fixture — ALMA_ASSISTANT_FIXTURE=1. Builds 40 mixed
    /// rows (long/short Bangla + Banglish, interleaved thinking/tool/prose
    /// blocks, one 2,000+ char reply), then streams 1,000 small deltas into a
    /// live tail through the SAME mutation helpers the real SSE path uses — so
    /// scroll-gap and per-delta MainActor cost reproduce without a server.
    /// Parity roadmap visual fixture — ALMA_ASSISTANT_PARITY=1: ONLY the persisted
    /// verification-retry turn (no stress stream), decoded through the real wire
    /// path, so a screenshot shows the exact cold-load composition: progress prose →
    /// tool rows → superseded draft (visible) → verify row → corrected final +
    /// Σ/cache/ধাপ footer.
    func loadParityFixture() {
        var rows: [AgentChatMessage] = []
        rows.append(AgentChatMessage(id: "fix-u-parity", role: .user,
                                     text: "স্টকের কাজটা কি হয়েছে?"))
        let parityJSON = #"""
        {"id":"fix-a-parity","role":"assistant",
         "content":[{"type":"text","text":"যাচাই করে দেখলাম — কাজটা তখনো হয়নি, এখন আসল স্টক আপডেট করে দিয়েছি।"}],
         "tokensIn":105300,"tokensOut":2100,"cacheCreation":41000,"cacheRead":960000,
         "apiRounds":6,"roundCostsUsd":[0.03,0.03,0.03,0.03,0.03,0.033],"costUsd":0.183,
         "createdAt":"2026-07-14T10:00:00.000Z",
         "timeline":[
           {"t":"text","text":"আগে স্টকের অবস্থাটা দেখে নিচ্ছি…"},
           {"t":"tool","name":"get_inventory_status","ok":true},
           {"t":"tool","name":"live_browser_look","ok":true,"result":"পেজ দেখা হয়েছে","shot":"https://picsum.photos/seed/alma/900/560"},
           {"t":"text","text":"কাজটা করে দিয়েছি Boss!","state":"superseded"},
           {"t":"verify","attempt":1,"max":2},
           {"t":"text","text":"যাচাই করে দেখলাম — কাজটা তখনো হয়নি, এখন আসল স্টক আপডেট করে দিয়েছি।"}]}
        """#
        if let d = parityJSON.data(using: .utf8),
           var wireRow = (try? JSONDecoder().decode(AgentMessageWire.self, from: d)).map(AgentChatMessage.from) {
            // Chat-parity batch demo state: delegation cards (done + running) so a
            // fixture screenshot proves the DelegationCard composition offline.
            wireRow.delegations = [
                .init(id: "fix-d1", role: "researcher", roleLabel: "গবেষক",
                      task: "প্রতিযোগীদের ঈদ ক্যাম্পেইনের দাম যাচাই করো",
                      done: true, success: true,
                      summary: "তিনটা ব্র্যান্ড দেখা হয়েছে — গড় দাম ৳১,২৫০; আমাদের অফার প্রতিযোগিতামূলক।",
                      toolsUsed: ["web_research", "compare_to_brand"]),
                .init(id: "fix-d2", role: "cs", roleLabel: "কাস্টমার সার্ভিস",
                      task: "WhatsApp inbox-এর নতুন প্রশ্নগুলোর খসড়া উত্তর"),
            ]
            rows.append(wireRow)
        }
        // Footer-focused shot (ALMA_FEEDBACK_OPEN=1): stop at the first turn so
        // its actions/cost footer is the bottom-most content on screen.
        let footerShot = ProcessInfo.processInfo.environment["ALMA_FEEDBACK_OPEN"] == "1"
            || ProcessInfo.processInfo.arguments.contains("ALMA_FEEDBACK_OPEN=1")
        if footerShot { messages = rows; return }
        // A long structured-markdown reply — proves the manual "সংরক্ষণ" footer
        // action (detectArtifact ≥800 chars + headings) in the same fixture shot.
        rows.append(AgentChatMessage(id: "fix-u-doc", role: .user,
                                     text: "ঈদ ক্যাম্পেইনের প্ল্যানটা লিখে দাও"))
        var doc = AgentChatMessage(id: "fix-a-doc", role: .assistant)
        doc.serverId = "fix-a-doc"
        doc.createdAt = "2026-07-14T10:05:00.000Z"
        doc.text = "## ঈদ ক্যাম্পেইন প্ল্যান\n\n**লক্ষ্য:** ৭ দিনে ৳১,৫০,০০০ বিক্রি।\n\n"
            + "![অফিস ক্যামেরা — Work Room](https://picsum.photos/seed/office/800/450)\n\n"
            + (1...14).map { "**ধাপ \(almaBn($0)):** কনটেন্ট তৈরি, অডিয়েন্স বাছাই, বাজেট ভাগ, ক্রিয়েটিভ টেস্ট আর ফলোআপ — প্রতিদিন সকাল ১০টায় রিপোর্ট।" }.joined(separator: "\n\n")
            + "\n\n**নোট:** প্রতিটা ধাপের ফলাফল রাতের রিপোর্টে যোগ হবে, আর বাজেট ছাড়ানোর আগে অনুমোদন কার্ড আসবে। শেষ দিনে পুরো ক্যাম্পেইনের লাভ-ক্ষতির হিসাব একসাথে দেখানো হবে।"
        rows.append(doc)
        messages = rows
    }

    func loadDebugFixture() {
        let bnShort = "ঠিক আছে Boss, এটা এখনই দেখছি।"
        let bnLong = "আজকের সেলস রিপোর্ট অনুযায়ী ALMA Lifestyle-এর মোট বিক্রি ভালো হয়েছে। Facebook ক্যাম্পেইনের CTR বেড়েছে, আর নতুন কালেকশনের প্রি-অর্ডারও আসছে। কালকে সকালে স্টাফ মিটিংয়ে inventory নিয়ে কথা বলা দরকার — তিনটা প্রোডাক্টের স্টক কমে যাচ্ছে। "
        var rows: [AgentChatMessage] = []
        for i in 0..<38 {
            if i % 2 == 0 {
                var u = AgentChatMessage(id: "fix-u-\(i)", role: .user,
                                         text: i % 4 == 0 ? "আজকের sales koto holo? আর কালকের plan টা দাও" : bnShort)
                rows.append(u)
            } else {
                var a = AgentChatMessage(id: "fix-a-\(i)", role: .assistant,
                                         text: i % 3 == 0 ? String(repeating: bnLong, count: 4) : bnLong)
                a.thinking = "হিসাব করছি: অর্ডার টেবিল থেকে আজকের রো গুনে টাকার যোগফল বের করা দরকার।"
                a.thinkingMs = 2300
                if i % 5 == 0 {
                    a.timeline = [.think("রিপোর্ট টানছি"),
                                  .tool(id: "fix-t-\(i)", name: "get_sales_summary", ok: true,
                                        live: false, inputPretty: nil, resultFull: nil, shot: nil)]
                }
                rows.append(a)
            }
        }
        // The 2,000+ character interleaved reply the gap reproduces around.
        var big = AgentChatMessage(id: "fix-a-big", role: .assistant, text: "")
        big.thinking = "লম্বা রিপ্লাই টেস্ট।"
        var blocks: [AgentChatMessage.TurnBlock] = []
        blocks = AgentChatMessage.appendThinkBlock(blocks, chunk: "বিশ্লেষণ চলছে…", messageId: big.id)
        blocks = AgentChatMessage.appendToolBlock(blocks, toolId: "fix-t-big", name: "get_orders", messageId: big.id)
        blocks = AgentChatMessage.finalizeToolBlock(blocks, toolId: "fix-t-big", ok: true)
        blocks = AgentChatMessage.appendProseBlock(blocks, chunk: String(repeating: bnLong, count: 14), messageId: big.id)
        big.blocks = blocks
        big.text = String(repeating: bnLong, count: 14)
        rows.append(big)

        // Parity roadmap — a PERSISTED (cold-load) verification-retry turn decoded
        // through the real wire path: draft prose stays visible, truthful verify
        // row between draft and corrected final, cache/rounds in the footer.
        rows.append(AgentChatMessage(id: "fix-u-parity", role: .user,
                                     text: "স্টকের কাজটা কি হয়েছে?"))
        let parityJSON = #"""
        {"id":"fix-a-parity","role":"assistant",
         "content":[{"type":"text","text":"যাচাই করে দেখলাম — কাজটা তখনো হয়নি, এখন আসল স্টক আপডেট করে দিয়েছি।"}],
         "tokensIn":1200,"tokensOut":300,"cacheCreation":5000,"cacheRead":20000,
         "apiRounds":4,"roundCostsUsd":[0.01,0.01,0.01,0.012],"costUsd":0.042,
         "timeline":[
           {"t":"text","text":"আগে স্টকের অবস্থাটা দেখে নিচ্ছি…"},
           {"t":"tool","name":"get_inventory_status","ok":true},
           {"t":"text","text":"কাজটা করে দিয়েছি Boss!","state":"superseded"},
           {"t":"verify","attempt":1,"max":2},
           {"t":"text","text":"যাচাই করে দেখলাম — কাজটা তখনো হয়নি, এখন আসল স্টক আপডেট করে দিয়েছি।"}]}
        """#
        if let d = parityJSON.data(using: .utf8),
           let wire = try? JSONDecoder().decode(AgentMessageWire.self, from: d) {
            rows.append(AgentChatMessage.from(wire))
        }
        messages = rows

        // Live tail: 1,000 one-word deltas at ~5ms — token-rate MainActor stress.
        isStreaming = true
        thinkingLive = false
        ensureStreamingTail()
        streamTask = Task { [weak self] in
            for n in 0..<1000 {
                try? await Task.sleep(nanoseconds: 5_000_000)
                guard let self, !Task.isCancelled else { return }
                if let i = self.messages.lastIndex(where: { $0.isStreaming }) {
                    let chunk = n % 12 == 11 ? "টেস্ট \(n)।\n" : "শব্দ\(n) "
                    self.messages[i].text += chunk
                    self.messages[i].blocks = AgentChatMessage.appendProseBlock(
                        self.messages[i].blocks, chunk: chunk, messageId: self.messages[i].id)
                }
            }
            guard let self, !Task.isCancelled else { return }
            self.isStreaming = false
            if let i = self.messages.lastIndex(where: { $0.isStreaming }) { self.messages[i].isStreaming = false }
        }
    }

    /// Focused visual fixture for the Background Tasks surface. It never calls the
    /// server and is reachable only through a local simulator launch argument.
    func loadBackgroundTaskDebugFixture() {
        usesBackgroundTaskDebugFixture = true
        var first = AgentChatMessage(id: "bg-a-1", role: .assistant,
                                     text: "বুঝেছি Boss — order audit-টা background-এ চালাচ্ছি। Result ready হলে নিজে থেকেই আবার check করব।")
        first.createdAt = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-240))
        let user = AgentChatMessage(id: "bg-u-2", role: .user,
                                    text: "Courier mismatch-গুলোর reason-ও verify করো")
        var latest = AgentChatMessage(id: "bg-a-2", role: .assistant,
                                      text: "করছি Boss। Courier data মিলিয়ে final report দেব—আপনাকে আবার remind করতে হবে না।")
        latest.createdAt = ISO8601DateFormatter().string(from: Date())
        latest.tokensIn = 18420
        latest.tokensOut = 892
        latest.costUsd = "0.061869"
        messages = [first, user, latest]
        justSettledId = latest.id

        let iso = ISO8601DateFormatter()
        let wake = iso.string(from: Date().addingTimeInterval(22 * 60))
        let runningStarted = iso.string(from: Date().addingTimeInterval(-28))
        let attentionStarted = iso.string(from: Date().addingTimeInterval(-190))
        let finishedAt = iso.string(from: Date().addingTimeInterval(-420))
        heartbeatFeed = AgentHeartbeatFeed(
            settings: .init(enabled: true, autoArm: true, dailyHeadWakeCap: 6, officeHoursOnly: false),
            wakesToday: 1, entries: [],
            nextCheckAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(5_400)))
        planDrive = AgentPlanDrivePanel(enabled: true, drives: [
            AgentPlanDriveView(
                planId: "debug-running", goal: "Order ও courier audit", conversationId: "debug",
                phase: "driving",
                steps: [
                    .init(id: "s1", action: "Pending orders যাচাই", status: "done", toolName: "get_orders", detail: nil),
                    .init(id: "s2", action: "Courier mismatch re-check", status: "running", toolName: "courier_check", detail: nil),
                    .init(id: "s3", action: "Final report", status: "pending", toolName: nil, detail: nil),
                ],
                doneCount: 1, totalCount: 3, currentLine: "Courier mismatch মিলিয়ে দেখছি",
                waitingReason: nil, nextTickAt: nil, startedAt: runningStarted,
                lastDrivenAt: runningStarted, attemptCount: 1, maxAttempts: 8, costTaka: 1),
            AgentPlanDriveView(
                planId: "debug-attention", goal: "Ads performance report", conversationId: "debug",
                phase: "needs-decision",
                steps: [.init(id: "a1", action: "Meta report আনুন", status: "failed", toolName: "meta_ads", detail: "Meta access token expire হয়েছে")],
                doneCount: 0, totalCount: 1, currentLine: nil,
                waitingReason: "Meta access token expire হয়েছে—reconnect দরকার",
                nextTickAt: wake, startedAt: attentionStarted, lastDrivenAt: attentionStarted,
                attemptCount: 3, maxAttempts: 3, costTaka: 0),
        ], finished: [
            .init(planId: "history-briefing", goal: "সকালের briefing প্রস্তুত", conversationId: "debug",
                  status: "completed", input: "আজকের order, payment ও staff status থেকে verified owner briefing তৈরি করো।",
                  result: "আজকের order, payment ও staff status থেকে verified briefing তৈরি হয়েছে।",
                  error: nil, startedAt: iso.string(from: Date().addingTimeInterval(-780)),
                  completedAt: finishedAt,
                  steps: [.init(id: "h1", action: "Business data যাচাই", status: "done", toolName: "owner_briefing", detail: "Order, payment ও staff status verified")], costTaka: 1),
            .init(planId: "history-dispatch", goal: "স্টাফ task dispatch", conversationId: "debug",
                  status: "completed", input: "আজকের priority কাজগুলো staff-দের কাছে দায়িত্বসহ পাঠাও।",
                  result: "Operations team-এ ৩টি verified task dispatch করা হয়েছে।", error: nil,
                  startedAt: nil, completedAt: finishedAt, steps: nil, costTaka: 1),
            .init(planId: "history-payment", goal: "পেমেন্ট reminder যাচাই", conversationId: "debug",
                  status: "failed", input: "Overdue payment list যাচাই করে reminder ready করো।", result: nil,
                  error: "Customer contact permission পাওয়া যায়নি—reminder পাঠানো হয়নি।",
                  startedAt: nil, completedAt: finishedAt, steps: nil, costTaka: 0),
            .init(planId: "history-cost", goal: "Cost reconcile", conversationId: "debug",
                  status: "completed", input: "আজকের courier cost reconcile করো।",
                  result: "Courier cost ledger-এর সঙ্গে reconcile হয়েছে।", error: nil,
                  startedAt: nil, completedAt: finishedAt, steps: nil, costTaka: 1),
            .init(planId: "history-stock", goal: "Low-stock follow-up", conversationId: "debug",
                  status: "completed", input: "Low-stock SKU owner list update করো।",
                  result: "৩টি low-stock SKU follow-up list-এ যোগ হয়েছে।", error: nil,
                  startedAt: nil, completedAt: finishedAt, steps: nil, costTaka: 0),
            .init(planId: "history-qa", goal: "Customer reply QA", conversationId: "debug",
                  status: "completed", input: "আজকের customer replies quality check করো।",
                  result: "১২টি reply check হয়েছে; critical issue পাওয়া যায়নি।", error: nil,
                  startedAt: nil, completedAt: finishedAt, steps: nil, costTaka: 1),
            .init(planId: "history-ads", goal: "Ads report", conversationId: "debug",
                  status: "failed", input: "Meta ads performance report তৈরি করো।", result: nil,
                  error: "Meta access token expire হয়েছে—reconnect দরকার।",
                  startedAt: nil, completedAt: finishedAt, steps: nil, costTaka: 0),
            .init(planId: "history-owner", goal: "Owner follow-up", conversationId: "debug",
                  status: "stopped", input: "Pending owner follow-up review করো।", result: nil,
                  error: "Owner task-টি বন্ধ করেছেন।", startedAt: nil, completedAt: finishedAt,
                  steps: nil, costTaka: 0),
        ])
        backgroundAttention = [
            .init(id: "debug-approval", conversationId: "debug",
                  type: "expense_log", summary: "খরচ লগ: ৳৩০০ — নাস্তা (খাবার)",
                  createdAt: iso.string(from: Date().addingTimeInterval(-8 * 60)))
        ]
        dailyAgentTodos = [
            .init(id: "t1", title: "Morning order scan", description: nil, priority: "high", status: "completed", dueDate: nil, source: "agent", dutyKey: "orders", createdAt: nil, completedAt: nil),
            .init(id: "t2", title: "Staff attendance check", description: nil, priority: "normal", status: "completed", dueDate: nil, source: "agent", dutyKey: "attendance", createdAt: nil, completedAt: nil),
            .init(id: "t3", title: "Courier reconciliation", description: nil, priority: "high", status: "running", dueDate: nil, source: "agent", dutyKey: nil, createdAt: nil, completedAt: nil),
            .init(id: "t4", title: "Low-stock follow-up", description: nil, priority: "normal", status: "pending", dueDate: nil, source: "agent", dutyKey: nil, createdAt: nil, completedAt: nil),
            .init(id: "t5", title: "Customer reply quality check", description: nil, priority: "normal", status: "pending", dueDate: nil, source: "agent", dutyKey: nil, createdAt: nil, completedAt: nil),
            .init(id: "t6", title: "Ads report", description: "Meta access token expire হয়েছে", priority: "high", status: "failed", dueDate: nil, source: "agent", dutyKey: nil, createdAt: nil, completedAt: nil),
        ]
    }

    /// Simulator-only motion proof: hold the task anchor under the old reply,
    /// enter ALMA loader handoff during the new turn, then settle it under the
    /// new reply using the production matched-geometry path.
    func runBackgroundTaskMotionDebug() {
        guard messages.count >= 3 else { return }
        let user = messages[messages.count - 2]
        let reply = messages[messages.count - 1]
        messages = Array(messages.dropLast(2))
        streamTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 900_000_000)
            guard let self, !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.22)) { self.messages.append(user) }
            self.isStreaming = true
            self.thinkingLive = true
            self.beginUnderstanding()
            self.ensureStreamingTail()
            try? await Task.sleep(nanoseconds: 900_000_000)
            guard !Task.isCancelled,
                  let index = self.messages.lastIndex(where: { $0.isStreaming }) else { return }
            self.messages[index].text = reply.text
            try? await Task.sleep(nanoseconds: 1_050_000_000)
            guard !Task.isCancelled else { return }
            self.messages[index].isStreaming = false
            self.isStreaming = false
            self.thinkingLive = false
            self.settleLiveMode()
            self.justSettledId = self.messages[index].id
        }
    }

    /// Phase 2 self-test — ALMA_ASSISTANT_EVENTTEST=1: pipes a canned SSE byte
    /// stream through the REAL parser → typed enum → buffer → reducer. Exercises
    /// CRLF, no-space `data:`, comment keepalives, multi-line data, an unknown
    /// event, subagent rows, tool screenshot, ask card, and a trailing `done`
    /// with no final blank line — the whole roadmap 2.1/2.2 matrix on screen.
    func runDebugEventTest() {
        isStreaming = true
        thinkingLive = true
        ensureStreamingTail()
        let wire = [
            "data: {\"type\":\"conversation_id\",\"id\":\"evt-conv\"}", "",
            "data:{\"type\":\"personal_mode\",\"active\":false}", "",       // no space after colon
            ": ping", "",                                                   // comment keepalive
            "data: {\"type\":\"model_info\",\"modelId\":\"m\",\"label\":\"Grok 4.20\",\"variant\":\"default\",\"tier\":\"heavy\"}", "",
            "data: {\"type\":\"thinking_delta\",\"delta\":\"সেলস ডেটা মিলিয়ে দেখছি…\"}", "",
            "data: {\"type\":\"subagent_start\",\"id\":\"s1\",\"role\":\"ops\",\"roleLabel\":\"অপারেশনস\",\"task\":\"স্টক রিপোর্ট টানা\"}", "",
            "data: {\"type\":\"tool_start\",\"id\":\"t1\",\"name\":\"get_sales_summary\"}", "",
            "data: {\"type\":\"tool_end\",\"id\":\"t1\",\"name\":\"get_sales_summary\",\"success\":true,\"resultPreview\":\"মোট ৳৬,০৫২\",\"screenshot\":\"https://picsum.photos/seed/alma/900/560\"}", "",
            "data: {\"type\":\"subagent_end\",\"id\":\"s1\",\"role\":\"ops\",\"success\":true,\"summary\":\"স্টক ঠিক আছে\",\"toolsUsed\":[\"get_inventory_status\"]}", "",
            "data: {\"type\":\"future_event_xyz\",\"foo\":1}", "",          // unknown → telemetry, nonfatal
            "data: {\"type\":\"text_delta\",\"delta\":\"আজকের বিক্রি ভালো হয়েছে Boss।\"}", "",
            "data: {\"type\":\"text_delta\",",                              // multi-line data event
            "data: \"delta\":\" মাল্টি-লাইন ইভেন্টও ঠিকভাবে এসেছে।\"}", "",
            // Parity roadmap RC-2 — the draft above must STAY visible (superseded in
            // data), a truthful verify row follows, then the corrected final prose.
            "data: {\"type\":\"verification_retry\",\"attempt\":1,\"maxAttempts\":2}", "",
            "data: {\"type\":\"text_delta\",\"delta\":\"যাচাই শেষে ঠিক করা উত্তর: আজকের মোট বিক্রি ৳৬,০৫২।\"}", "",
            "data: {\"type\":\"ask_card\",\"askCardId\":\"a1\",\"question\":\"কোনটা আগে করব Boss?\",\"options\":[\"স্টক অর্ডার\",\"ক্যাম্পেইন\",\"পরে বলব\"]}", "",
            "data: {\"type\":\"done\",\"messageId\":\"evt-m1\",\"tokensIn\":1200,\"tokensOut\":86,\"cacheCreation\":0,\"cacheRead\":0,\"costUsd\":0.0123}",
            // no trailing blank line — exercises the flushTrailing() path
        ].joined(separator: "\r\n")

        let buffer = AgentEventBuffer { [weak self] evs in self?.apply(evs) }
        streamTask = Task { [weak self] in
            var parser = AlmaSSEParser()
            let decoder = JSONDecoder()
            func dispatch(_ payload: String) async {
                guard let d = payload.data(using: .utf8),
                      let dto = try? decoder.decode(AgentSSEEvent.self, from: d) else {
                    AlmaTurnLog.event("stream.malformedEvent", String(payload.prefix(80)))
                    return
                }
                let ev = AgentTurnEvent(dto: dto)
                if case .unknown(let t) = ev { AlmaTurnLog.event("stream.unknownEvent", t) }
                await buffer.push(ev)
            }
            for line in wire.components(separatedBy: "\n") {                // CR kept — parser strips
                try? await Task.sleep(nanoseconds: 120_000_000)
                if let payload = parser.consume(line: line) { await dispatch(payload) }
            }
            if let p = parser.flushTrailing() { await dispatch(p) }
            await buffer.finish()
            guard let self else { return }
            self.isStreaming = false
            if let i = self.messages.lastIndex(where: { $0.isStreaming }) { self.messages[i].isStreaming = false }
        }
    }

    /// Phase 4.4 — in-app unit assertions for the pure protocol layer (parser,
    /// typed-event mapping, transport classifier, event buffer). Runs headlessly
    /// in the simulator via ALMA_ASSISTANT_UNITTEST=1 and renders PASS/FAIL as a
    /// local message, so CI can screenshot it without an XCTest target (adding
    /// one to the shared pbxproj is an owner/Xcode decision).
    func runDebugUnitTests() {
        var results: [String] = []
        func check(_ name: String, _ cond: Bool) { results.append("\(cond ? "✅" : "❌") \(name)") }

        // AlmaSSEParser — spec matrix
        var p = AlmaSSEParser()
        check("keepalive ignored", p.consume(line: ": ping") == nil)
        check("no-space data", { _ = p.consume(line: "data:{\"a\":1}"); return p.consume(line: "") == "{\"a\":1}" }())
        check("CRLF stripped", { _ = p.consume(line: "data: x\r"); return p.consume(line: "\r") == "x" }())
        _ = p.consume(line: "data: line1")
        _ = p.consume(line: "data: line2")
        check("multi-line joined", p.consume(line: "") == "line1\nline2")
        _ = p.consume(line: "id: 42")
        check("id: captured", p.lastEventId == "42")
        _ = p.consume(line: "data: tail")
        check("trailing flush", p.flushTrailing() == "tail")

        // Typed event mapping
        func decode(_ json: String) -> AgentTurnEvent? {
            guard let d = json.data(using: .utf8),
                  let dto = try? JSONDecoder().decode(AgentSSEEvent.self, from: d) else { return nil }
            return AgentTurnEvent(dto: dto)
        }
        if case .unknown(let t)? = decode(#"{"type":"future_thing"}"#) { check("unknown telemetried", t == "future_thing") } else { check("unknown telemetried", false) }
        if case .done(let mid, let tin, _, let cost, let cont, _, _, _, _)? = decode(#"{"type":"done","messageId":"m1","tokensIn":5,"costUsd":0.1,"needContinue":true}"#) {
            check("done fields", mid == "m1" && tin == 5 && cost == 0.1 && cont)
        } else { check("done fields", false) }
        if case .turnSnapshot(let tid, _, let st, let seq)? = decode(#"{"type":"turn_snapshot","turnId":"t9","status":"running","lastSeq":7}"#) {
            check("turn_snapshot", tid == "t9" && st == "running" && seq == 7)
        } else { check("turn_snapshot", false) }

        // Presentation parity (roadmap RC-1/RC-3/RC-4) — persisted wire row must
        // decode every prose/verify segment and rebuild the SAME interleaved
        // TurnBlock composition the live stream shows, superseded marked in data.
        let parityJSON = #"""
        {"id":"m-parity","role":"assistant",
         "content":[{"type":"text","text":"ঠিক করা উত্তর।"}],
         "tokensIn":1200,"tokensOut":300,"cacheCreation":5000,"cacheRead":20000,
         "apiRounds":4,"roundCostsUsd":[0.01,0.01,0.01,0.012],"costUsd":0.042,
         "timeline":[
           {"t":"text","text":"আগে দেখে নিচ্ছি…"},
           {"t":"tool","name":"get_orders","ok":true},
           {"t":"text","text":"কাজটা করে দিয়েছি Boss!","state":"superseded"},
           {"t":"verify","attempt":1,"max":2},
           {"t":"text","text":"ঠিক করা উত্তর।"}]}
        """#
        if let d = parityJSON.data(using: .utf8),
           let wire = try? JSONDecoder().decode(AgentMessageWire.self, from: d) {
            let m = AgentChatMessage.from(wire)
            let textCount = m.timeline.reduce(0) { n, e in
                if case .text = e { return n + 1 }; return n
            }
            check("RC-1 persisted prose decoded", textCount == 3)
            check("RC-4 usage decoded", m.cacheCreation == 5000 && m.cacheRead == 20000
                  && m.apiRounds == 4 && m.roundCostsUsd?.count == 4)
            let fingerprint = m.blocks.map { b -> String in
                switch b {
                case .prose(let id, _): return m.supersededBlockIds.contains(id) ? "prose*" : "prose"
                case .activity(let a):
                    switch a.kind {
                    case .thinking: return "think"
                    case .search: return "search"
                    case .tool: return "tool"
                    }
                case .file: return "file"
                case .confirmCard: return "confirm"
                case .askCard: return "ask"
                }
            }
            check("RC-3 canonical block fingerprint",
                  fingerprint == ["prose", "search", "tool", "prose*", "think", "prose"])
            // Chat-parity batch: a verify/superseded wire row marks the message
            // self-corrected (footer badge) — same rule as the server presentation.
            check("selfCorrected derived from wire", m.selfCorrected)
            // Determinism: decoding the same wire twice yields the same composition.
            let m2 = AgentChatMessage.from(wire)
            check("RC-3 projection deterministic",
                  m2.blocks == m.blocks && m2.supersededBlockIds == m.supersededBlockIds)
        } else {
            check("parity wire decode", false)
        }

        // The server's canonical projection remains authoritative even if a
        // compact response omits its detailed timeline.
        let correctedProjectionJSON = #"""
        {"id":"m-corrected","role":"assistant",
         "content":[{"type":"text","text":"যাচাই করা উত্তর।"}],
         "presentation":{"selfCorrected":true}}
        """#
        if let d = correctedProjectionJSON.data(using: .utf8),
           let wire = try? JSONDecoder().decode(AgentMessageWire.self, from: d) {
            check("selfCorrected canonical projection", AgentChatMessage.from(wire).selfCorrected)
        } else {
            check("selfCorrected projection decode", false)
        }

        // Chat-parity batch: persisted browser screenshot (`shot`) survives the
        // wire decode into the timeline, the Tool row and the rebuilt blocks.
        let shotJSON = #"""
        {"id":"m-shot","role":"assistant",
         "content":[{"type":"text","text":"দেখা শেষ।"}],
         "timeline":[
           {"t":"text","text":"পেজটা দেখছি…"},
           {"t":"tool","name":"live_browser_look","ok":true,"shot":"https://example.com/s.png"},
           {"t":"text","text":"দেখা শেষ।"}]}
        """#
        if let d = shotJSON.data(using: .utf8),
           let wire = try? JSONDecoder().decode(AgentMessageWire.self, from: d) {
            let m = AgentChatMessage.from(wire)
            var timelineShot: String?
            for e in m.timeline { if case .tool(_, _, _, _, _, _, let s) = e { timelineShot = s } }
            let blockShot = m.blocks.compactMap { b -> String? in
                if case .activity(let a) = b { return a.screenshot }; return nil
            }.first
            check("tool shot decoded", timelineShot == "https://example.com/s.png"
                  && m.tools.first?.screenshot == "https://example.com/s.png"
                  && blockShot == "https://example.com/s.png")
        } else {
            check("tool shot decoded", false)
        }

        // Transport classifier
        if case .offline = TurnFailureKind.classify(URLError(.notConnectedToInternet)) { check("offline classified", true) } else { check("offline classified", false) }
        if case .transportInterrupted = TurnFailureKind.classify(URLError(.networkConnectionLost)) { check("drop classified", true) } else { check("drop classified", false) }
        if case .authentication = TurnFailureKind.classify(AlmaAPIError.notAuthenticated) { check("auth classified", true) } else { check("auth classified", false) }
        if case .server(let s) = TurnFailureKind.classify(AlmaAPIError.http(status: 502, body: "")) { check("server classified", s == 502) } else { check("server classified", false) }

        // Event buffer — coalescing + control-flush chronology (async)
        Task { [weak self] in
            var applied: [[AgentTurnEvent]] = []
            let buf = AgentEventBuffer { evs in applied.append(evs) }
            await buf.push(.textDelta("আ"))
            await buf.push(.textDelta("জ"))
            await buf.push(.toolStart(id: "t", name: "x", inputPretty: nil))   // control → flush
            await buf.finish()
            let flat = applied.flatMap { $0 }
            var ok = flat.count == 2
            if ok, case .textDelta(let joined) = flat[0] { ok = joined == "আজ" } else { ok = false }
            if ok, case .toolStart = flat[1] {} else { ok = false }
            guard let self else { return }
            var final = results
            final.append("\(ok ? "✅" : "❌") buffer coalesce+order")
            let passed = final.allSatisfy { $0.hasPrefix("✅") }
            var m = AgentChatMessage(id: "unittest-\(UUID().uuidString)", role: .assistant,
                                     text: (passed ? "প্রোটোকল ইউনিট টেস্ট: সব পাশ ✅" : "প্রোটোকল ইউনিট টেস্ট: FAIL ❌")
                                        + "\n\n" + final.joined(separator: "\n"))
            self.messages.append(m)
            AlmaTurnLog.event("unittest.result", passed ? "PASS \(final.count)" : "FAIL")
        }
    }

    // ── Cards ──────────────────────────────────────────────────────────────

    /// Approve timestamps survive the 12s message re-poll (which rebuilds cards
    /// from the wire and wiped card.approvedAt — the render % restarted from 1
    /// on every poll, owner bug 2026-07-13). Keyed by pendingActionId.
    var confirmApprovedAt: [String: Date] = [:]

    func approveAction(_ cardId: String, approve: Bool) async {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        if approve { confirmApprovedAt[cardId] = Date() }
        let summary = messages
            .flatMap(\.confirmCards)
            .first(where: { $0.id == cardId })?
            .summary.split(separator: "\n").first.map(String.init) ?? ""
        setConfirmStatus(cardId, approve ? "approved" : "rejected")
        do {
            let _: OkResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/actions/\(cardId)/\(approve ? "approve" : "reject")")
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            // Owner-hit 2026-07-16: a REJECT left the thread dead silent — no
            // loader, no acknowledgment (approve is covered server-side: the
            // route writes a progress note and enqueues a continuation turn,
            // so a second client message there would double the reply). For
            // reject, feed the decision into the chat exactly like an ask-card
            // answer, so the agent responds to it knowingly — "বাতিল করলাম"
            // deserves a reply, not a shrug.
            if !approve {
                // The message must carry the GROUND TRUTH, not just the verdict
                // (owner-hit 2026-07-17): "এটা বাতিল করলাম" alone read as a
                // COMMAND to a weak head — it re-dismissed the already-rejected
                // action and re-staged a fresh draft unprompted. State that the
                // rejection already happened, forbid re-action, and say what a
                // person would want next: understand why, then ask or recommend.
                let what = summary.isEmpty ? "কাজটা" : "তোমার \"\(summary.prefix(60))\" draft-টা"
                send("\(what) আমি reject করলাম — কার্ড থেকে already বাতিল হয়ে গেছে, "
                    + "নতুন করে dismiss বা আবার stage/send কিছুই কোরো না। "
                    + "এখন বুঝে নাও কেন পছন্দ হয়নি: আমাকে জিজ্ঞেস করো কী বদলাতে চাই, "
                    + "অথবা নিজে থেকে better recommendation দাও।")
                // send() owns the timeline from here (bubble + streaming tail) —
                // running loadMessages() underneath it would rebuild the array
                // mid-stream and clobber both. The reply lands via the stream.
                return
            }
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
                messages[i].confirmCards[j].approvedAt = status == "approved" ? Date() : nil
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
        // Feed the choice back into the chat so the agent continues instantly (web
        // onQuickSend parity). The card id rides along (AGENT-IOS-001) so the turn
        // binds this answer to the EXACT question — no text-match guessing.
        send(option, askCardId: cardId)
    }

    // ── Owner feedback on a settled reply (roadmap Phase 1 correction loop) ──

    /// Message ids (local UI ids) whose feedback is already filed this session.
    var feedbackSentIds: Set<String> = []

    /// One tap files a structured correction row — POST /api/assistant/feedback.
    /// Best-effort like the web client: feedback must never break the chat.
    func sendFeedback(kind: String, for message: AgentChatMessage) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        feedbackSentIds.insert(message.id)
        guard let cid = conversationId else { return }
        struct FeedbackBody: Encodable {
            let kind: String
            let conversationId: String
            let messageId: String?
        }
        let serverId = message.serverId
            ?? (message.id.hasPrefix("local-") || message.id.hasPrefix("stream-") ? nil : message.id)
        Task {
            let _: OkResponse? = try? await AlmaAPI.shared.send(
                "POST", "/api/assistant/feedback",
                body: FeedbackBody(kind: kind, conversationId: cid, messageId: serverId))
        }
    }

    // ── Manual "সংরক্ষণ" — save a reply as a conversation artifact (web parity) ──

    /// Message ids saved as artifacts this session (footer shows "সংরক্ষিত").
    var artifactSavedIds: Set<String> = []

    /// Web `detectArtifact` port: a ≥15-line fenced block becomes a code/html/svg
    /// artifact; long structured markdown (≥800 chars with ##/**) becomes a
    /// markdown document titled by its first heading.
    static func detectArtifact(in text: String) -> (type: String, title: String, content: String)? {
        if let re = try? NSRegularExpression(pattern: "```([\\w-]*)[ \\t]*\\n([\\s\\S]*?)```") {
            let ns = text as NSString
            let matches = re.matches(in: text, range: NSRange(location: 0, length: ns.length))
            for m in matches where m.numberOfRanges >= 3 {
                let lang = ns.substring(with: m.range(at: 1)).lowercased()
                let content = ns.substring(with: m.range(at: 2))
                guard content.components(separatedBy: "\n").count >= 15 else { continue }
                let looksSvg = lang == "svg" || content.range(of: "^\\s*<svg[\\s>]", options: [.regularExpression, .caseInsensitive]) != nil
                let looksHtml = lang == "html" || content.range(of: "^\\s*(<!doctype html|<html[\\s>])", options: [.regularExpression, .caseInsensitive]) != nil
                if looksSvg { return ("svg", "SVG ছবি", content) }
                if looksHtml { return ("html", "HTML প্রিভিউ", content) }
                return ("code", lang.isEmpty ? "কোড" : "\(lang) কোড", content)
            }
        }
        if text.count >= 800, text.contains("##") || text.contains("**") {
            let title = text.range(of: "#{1,3} (.+)", options: .regularExpression)
                .map { String(text[$0]).replacingOccurrences(of: "^#{1,3} ", with: "", options: .regularExpression) }
                ?? "ডকুমেন্ট"
            return ("markdown", title, text)
        }
        return nil
    }

    /// Footer "সংরক্ষণ" tap — files the detected document as an artifact and
    /// refreshes the artifacts badge (web onArtifactSave parity).
    func saveArtifactManually(from message: AgentChatMessage) async {
        guard let cid = conversationId,
              let detected = Self.detectArtifact(in: message.text) else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        struct ArtifactBody: Encodable {
            let conversationId: String
            let messageId: String?
            let type: String
            let title: String
            let content: String
        }
        let serverId = message.serverId
            ?? (message.id.hasPrefix("local-") || message.id.hasPrefix("stream-") ? nil : message.id)
        do {
            struct Created: Decodable { let id: String }
            let _: Created = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/artifacts",
                body: ArtifactBody(conversationId: cid, messageId: serverId,
                                   type: detected.type, title: detected.title,
                                   content: detected.content))
            artifactSavedIds.insert(message.id)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await loadArtifacts()
        } catch {
            errorToast = "সংরক্ষণ করা গেল না — আবার চেষ্টা করুন"
        }
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

    private struct AuroraBlob { let color: Color; let size: CGFloat; let x: CGFloat; let y: CGFloat }

    var body: some View {
        let dark = scheme == .dark
        // Premium static aurora: the colour identity stays intact, but the root
        // background never drives the entire native view graph at display-link
        // cadence. Motion belongs only to an explicit active-task indicator.
        let blobs: [AuroraBlob] = [
            .init(color: Color(red: 0.220, green: 0.502, blue: 1.000).opacity(dark ? 0.60 : 0.30), size: 380, x: 0.15, y: 0.10),
            .init(color: Color(red: 0.486, green: 0.302, blue: 1.000).opacity(dark ? 0.55 : 0.26), size: 420, x: 0.85, y: 0.25),
            .init(color: Color(red: 0.839, green: 0.200, blue: 1.000).opacity(dark ? 0.50 : 0.24), size: 360, x: 0.30, y: 0.55),
            .init(color: Color(red: 1.000, green: 0.180, blue: 0.525).opacity(dark ? 0.55 : 0.26), size: 400, x: 0.80, y: 0.80),
            .init(color: Color(red: 1.000, green: 0.431, blue: 0.314).opacity(dark ? 0.45 : 0.22), size: 340, x: 0.20, y: 0.95),
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
                        .position(x: geo.size.width * b.x,
                                  y: geo.size.height * b.y)
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

// MARK: - Markdown-lite renderer (headers / lists / code / tables / inline)

extension UIFont {
    /// System serif at the given size — UIKit twin of `.font(.system(size:design:.serif))`.
    static func almaSerif(_ size: CGFloat) -> UIFont {
        let base = UIFont.systemFont(ofSize: size)
        guard let d = base.fontDescriptor.withDesign(.serif) else { return base }
        return UIFont(descriptor: d, size: size)
    }
}

/// In-place selectable rich text (Claude-app parity, owner ask build-70 round 4):
/// a non-scrolling UITextView so long-press/double-tap marks text DIRECTLY in the
/// chat with native grabbers + the system Copy/Look Up/Translate menu — no separate
/// sheet. SwiftUI Text on iOS can only copy a whole block, which the owner rejected.
@available(iOS 17.0, *)
struct AlmaSelectableRichText: UIViewRepresentable {
    let attributed: NSAttributedString
    var tint: UIColor = UIColor(AgentPalette.coral)   // selection handles/highlight

    init(attributed: NSAttributedString) { self.attributed = attributed }

    /// Plain single-style text (the owner's coral bubble — white handles there,
    /// coral-on-coral would be invisible).
    init(plain: String, font: UIFont, color: UIColor, lineSpacing: CGFloat = 0) {
        let p = NSMutableParagraphStyle()
        p.lineSpacing = lineSpacing
        self.attributed = NSAttributedString(string: plain, attributes: [
            .font: font, .foregroundColor: color, .paragraphStyle: p,
        ])
        self.tint = .white
    }

    /// Roadmap Phase 1.4 — measurement stability. LazyVStack re-proposes rows many
    /// times (including nil-width estimation passes) while rows enter/leave the
    /// viewport; an unanswered nil proposal used to fall back to UIKit intrinsic
    /// sizing at a 0pt-wide container → one-word-per-line → a viewport-sized
    /// phantom height reserved for the row (the giant scroll gap). Every proposal
    /// is now answered from an explicit measure, cached by
    /// (content, rounded width, Dynamic Type size); a nil width reuses the last
    /// REAL layout width so a stale estimate can never stick.
    final class Coordinator {
        var cache: [String: CGSize] = [:]
        var lastRealWidth: CGFloat = 0
    }
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.isEditable = false
        tv.isSelectable = true
        tv.isScrollEnabled = false
        tv.backgroundColor = .clear
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        tv.textContainer.widthTracksTextView = true
        tv.setContentHuggingPriority(.required, for: .vertical)
        tv.setContentCompressionResistancePriority(.required, for: .vertical)
        tv.tintColor = tint
        tv.attributedText = attributed
        return tv
    }

    func updateUIView(_ tv: UITextView, context: Context) {
        if !tv.attributedText.isEqual(to: attributed) {
            tv.attributedText = attributed
            tv.invalidateIntrinsicContentSize()
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let co = context.coordinator
        let width: CGFloat
        if let w = proposal.width, w > 0, w.isFinite {
            width = w
            co.lastRealWidth = w
        } else if co.lastRealWidth > 0 {
            width = co.lastRealWidth          // estimation pass — reuse the real width
        } else {
            // First-ever pass before any real proposal: measure at a sane chat
            // width instead of letting UIKit size a 0pt-wide container.
            width = UIScreen.main.bounds.width - 32
        }
        let key = "\(attributed.hash)|\(Int(width.rounded()))|\(uiView.traitCollection.preferredContentSizeCategory.rawValue)"
        if let cached = co.cache[key] { return cached }
        let fit = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        // Hug the longest line (owner bubble must not stretch full-width for "Ok").
        let size = CGSize(width: min(width, fit.width.rounded(.up)), height: fit.height.rounded(.up))
        co.cache[key] = size
        if co.cache.count > 64 { co.cache.removeAll() }   // bound churn on live tails
        return size
    }
}

@available(iOS 17.0, *)
struct AgentMarkdownText: View {
    let text: String
    let pal: AgentPalette
    /// Settled agent prose sets this — paragraphs render as in-place selectable
    /// UITextViews. Streaming/shimmering prose keeps the SwiftUI Text path.
    var selectable = false

    private enum Segment: Identifiable {
        case paragraph(String)
        case code(lang: String, body: String)
        case table(String)
        /// Markdown image `![alt](https://…)` — web parity: the agent embeds
        /// camera snapshots / generated images as markdown; iOS used to show the
        /// raw `![…](…)` text (owner report 2026-07-15).
        case image(url: String, alt: String)
        var id: String {
            switch self {
            case .paragraph(let s): return "p\(s.hashValue)"
            case .code(let l, let b): return "c\(l.hashValue)\(b.hashValue)"
            case .table(let s): return "t\(s.hashValue)"
            case .image(let u, _): return "i\(u.hashValue)"
            }
        }
    }

    /// `![alt](https://url)` — matched over each plain-text block at flush time.
    private static let mdImageRegex = try? NSRegularExpression(
        pattern: "!\\[([^\\]]*)\\]\\((https?://[^)\\s]+)\\)")

    /// Split a prose block around its markdown images: text-image-text order is
    /// preserved; a block with no image stays one paragraph (zero extra work).
    private static func appendSplittingImages(_ s: String, into out: inout [Segment]) {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard trimmed.contains("!["), let re = mdImageRegex else {
            out.append(.paragraph(s)); return
        }
        let ns = s as NSString
        var cursor = 0
        for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            let before = ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))
            if !before.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                out.append(.paragraph(before.trimmingCharacters(in: .whitespacesAndNewlines)))
            }
            out.append(.image(url: ns.substring(with: m.range(at: 2)),
                              alt: ns.substring(with: m.range(at: 1))))
            cursor = m.range.location + m.range.length
        }
        let rest = ns.substring(from: cursor)
        if !rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            out.append(.paragraph(rest.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
    }

    private var segments: [Segment] {
        // Roadmap 2.4 fast path: in-flight prose usually has no fences/tables/
        // images — skip the split/scan work on every streaming re-render (≤25/s)
        // and return one paragraph. Settled/selectable text takes the full path.
        if !selectable && !text.contains("```"), !text.contains("!["),
           !text.contains("\n|"), !text.hasPrefix("|") {
            return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? [] : [.paragraph(text)]
        }
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
                func flushBuf() { Self.appendSplittingImages(buf.joined(separator: "\n"), into: &out); buf = [] }
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
                case .image(let url, _):
                    // Framed chat image, tap → full-screen pinch-zoom viewer
                    // (web ImageWithDownload parity).
                    AgentToolScreenshotThumb(urlString: url, maxHeight: 300, fit: true)
                }
            }
        }
    }

    @ViewBuilder private func paragraph(_ s: String) -> some View {
        if selectable {
            AlmaSelectableRichText(attributed: Self.attributedParagraph(s, pal: pal))
        } else {
            plainParagraph(s)
        }
    }

    /// Mirror of `plainParagraph`'s per-line styling as ONE NSAttributedString so a
    /// selection can span the whole paragraph: coral headers, • bullets, serif body,
    /// resolved bold/italic/code (UITextView doesn't interpret markdown intents).
    static func attributedParagraph(_ s: String, pal: AgentPalette) -> NSAttributedString {
        let body = UIFont.almaSerif(15.5)
        let ink = UIColor(pal.ink)
        let out = NSMutableAttributedString()
        let para = NSMutableParagraphStyle()
        para.lineSpacing = 3
        para.paragraphSpacing = 6
        var first = true
        for line in s.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            if !first { out.append(NSAttributedString(string: "\n")) }
            first = false
            if trimmed.hasPrefix("###") || trimmed.hasPrefix("##") || trimmed.hasPrefix("# ") {
                let title = String(trimmed.drop(while: { $0 == "#" || $0 == " " }))
                let size: CGFloat = trimmed.hasPrefix("# ") ? 18 : 16
                out.append(NSAttributedString(string: title, attributes: [
                    .font: UIFont.systemFont(ofSize: size, weight: .semibold),
                    .foregroundColor: UIColor(AgentPalette.coral),
                ]))
            } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("• ") {
                out.append(NSAttributedString(string: "•  ", attributes: [.font: body, .foregroundColor: UIColor(pal.muted)]))
                out.append(inlineNS(String(trimmed.dropFirst(2)), baseFont: body, color: ink))
            } else {
                out.append(inlineNS(line, baseFont: body, color: ink))
            }
        }
        out.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: out.length))
        return out
    }

    /// Inline markdown line → NSAttributedString with **bold** / *italic* / `code`
    /// resolved to real fonts (AttributedString keeps them as presentation intents,
    /// which UIKit ignores).
    private static func inlineNS(_ line: String, baseFont: UIFont, color: UIColor) -> NSAttributedString {
        guard let md = try? AttributedString(markdown: line,
                                             options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) else {
            return NSAttributedString(string: line, attributes: [.font: baseFont, .foregroundColor: color])
        }
        let out = NSMutableAttributedString()
        for run in md.runs {
            let sub = String(md[run.range].characters)
            var font = baseFont
            if let intent = run.inlinePresentationIntent {
                if intent.contains(.code) {
                    font = .monospacedSystemFont(ofSize: baseFont.pointSize - 1.5, weight: .regular)
                } else {
                    var traits = font.fontDescriptor.symbolicTraits
                    if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
                    if intent.contains(.emphasized) { traits.insert(.traitItalic) }
                    if let d = font.fontDescriptor.withSymbolicTraits(traits) {
                        font = UIFont(descriptor: d, size: baseFont.pointSize)
                    }
                }
            }
            out.append(NSAttributedString(string: sub, attributes: [.font: font, .foregroundColor: color]))
        }
        return out
    }

    @ViewBuilder private func plainParagraph(_ s: String) -> some View {
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
                // Tap-to-retry (owner bug 2026-07-13: a 2.6MB render on 4G failed
                // once and the tile stayed dead "ছবি নেই" forever). Retry re-signs
                // and reloads instead of leaving a permanent broken tile.
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    failed = false
                    url = nil
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: "arrow.clockwise").font(.system(size: 15))
                        Text("আবার চেষ্টা").font(.system(size: 9))
                    }
                    .foregroundStyle(pal.muted)
                    .frame(width: 80, height: 80)
                    .background(pal.card.opacity(0.4), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .buttonStyle(.plain)
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
    let showsBackgroundTaskAnchor: Bool
    let backgroundTaskHandoff: Bool
    let backgroundTaskNamespace: Namespace.ID
    let onBackgroundTasks: () -> Void
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
                    // Owner ask build-70 round 4: bubble text is DIRECTLY selectable
                    // in place (native grabbers + system Copy menu) — no context menu.
                    AlmaSelectableRichText(plain: message.text,
                                           font: .systemFont(ofSize: 15),
                                           color: .white, lineSpacing: 3.5)
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
            VStack(alignment: .leading, spacing: 8) {
                let hasTimeline = !message.timeline.isEmpty
                let hasSettledMeta = !message.phases.isEmpty || !(message.thinking ?? "").isEmpty
                    || !message.tools.isEmpty
                // LOCKED SPEC §1: NO glass card — plain on the aurora (Claude iOS).
                    // Owner iteration 2026-07-16: the separate "কাজ করছি…" pinned
                    // row is gone — the live status (Claude-Code style verb +
                    // token count, blinking) now lives beside the loader + ALMA
                    // wordmark in AgentThinkingRow, like the Claude app.
                    if !message.blocks.isEmpty {
                        // Claude composition — chronological prose ↔ compact rows;
                        // rows persist after settle (tap → sheets), prose never moves.
                        AgentTurnBlocksView(message: message, pal: pal, vm: vm, onToolTap: onToolTap) { kind, slice in
                            onActivitySheet(.init(message: message, kind: kind, slice: slice))
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
                                        // 1.4: cap ONLY the collapsed state; expanded rows size
                                        // naturally (never a greedy .infinity inside the lazy list).
                                        .frame(maxHeight: long && !expandedLong ? 340 : nil, alignment: .top)
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
                                            Button {
                                                UISelectionFeedbackGenerator().selectionChanged()
                                                onActivitySheet(.init(message: message, kind: .selectText, slice: message.text))
                                            } label: {
                                                Label("টেক্সট সিলেক্ট করুন", systemImage: "text.cursor")
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

                    // Specialist delegation cards — grouped after the activity flow,
                    // exactly where the web thread renders DelegationCard.
                    if !message.delegations.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(message.delegations) { d in
                                AgentDelegationCardView(d: d, pal: pal)
                            }
                        }
                        .padding(.vertical, 2)
                    }

                    ForEach(message.imagePaths, id: \.self) { p in
                        AgentChatImage(path: p, vm: vm)
                    }
                    // Cards already pinned in-flow by TurnBlocks render THERE; only
                    // cards with no block (persisted history turns) fall back here.
                    let inlineConfirmIds = Set(message.blocks.compactMap { b -> String? in
                        if case .confirmCard(_, let pid) = b { return pid }; return nil
                    })
                    ForEach(message.confirmCards.filter { !inlineConfirmIds.contains($0.id) }) { card in
                        AgentConfirmCardView(card: card, pal: pal, vm: vm) { approve in
                            Task { await vm.approveAction(card.id, approve: approve) }
                        }
                    }
                    let inlineAskIds = Set(message.blocks.compactMap { b -> String? in
                        if case .askCard(_, let aid) = b { return aid }; return nil
                    })
                    let bottomAskCards = message.askCards.filter { !inlineAskIds.contains($0.id) }
                    if !bottomAskCards.isEmpty {
                        AgentAskCardsPager(cards: bottomAskCards, pal: pal) { card, option in
                            Task { await vm.answerAskCard(card.id, option: option) }
                        }
                    }

                    // PR 3b — model-upgrade approval card (web parity): the turn is
                    // paused server-side until the owner picks a model.
                    if let ms = message.modelSwitch {
                        AgentModelSwitchCardView(card: ms, pal: pal) { approve in
                            vm.resumeModelSwitch(messageId: message.id, approve: approve)
                        }
                    }

                    // Single starburst — bottom-left INSIDE the card while the turn runs.
                    if showWorkingIndicator {
                        AgentThinkingRow(mode: vm.liveMode, pal: pal,
                                         message: message,
                                         lastThinkingGrowthAt: vm.lastThinkingGrowthAt,
                                         reconnecting: vm.reconnecting,
                                         stallRetryAttempt: vm.stallRetryAttempt)
                            .padding(.top, 2)
                    }

                // One reply footer: ALMA identity + background work + quiet actions.
                // Background work never renders as a second chat row.
                if !message.isStreaming && !message.text.isEmpty {
                    AgentMessageActions(
                        message: message,
                        vm: vm,
                        pal: pal,
                        showsBackgroundTaskAnchor: showsBackgroundTaskAnchor,
                        backgroundTaskHandoff: backgroundTaskHandoff,
                        backgroundTaskNamespace: backgroundTaskNamespace,
                        onBackgroundTasks: onBackgroundTasks)
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
    func body(content: Content) -> some View {
        // Never attach a display-link-sized mask to a growing paragraph. The
        // compact live summary/loader already communicates progress; prose stays
        // crisp and can grow without redrawing at 30 FPS.
        content
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
                        TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
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
                        TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                            let phase = context.date.timeIntervalSinceReferenceDate
                                .truncatingRemainder(dividingBy: Self.period) / Self.period
                            let band = max(44, g.size.width * 0.3)
                            let travel = g.size.width + band * 2
                            LinearGradient(colors: [.clear, .white.opacity(0.9), .clear],
                                           startPoint: .leading, endPoint: .trailing)
                                .frame(width: band)
                                .offset(x: -band + travel * phase)
                        }
                    }
                    .mask(content)
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
                    if tool.inputPretty == nil && tool.resultFull == nil && tool.preview == nil
                        && tool.screenshot == nil {
                        Text("এই টুলের কোনো ইনপুট/ফলাফল নেই।")
                            .font(.system(size: 12))
                            .foregroundStyle(pal.muted)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 24)
                    }
                    if let shot = tool.screenshot {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("স্ক্রিনশট · SCREENSHOT")
                                .font(.system(size: 10, weight: .semibold))
                                .tracking(0.8)
                                .foregroundStyle(pal.muted.opacity(0.7))
                            AgentToolScreenshotThumb(urlString: shot, maxHeight: 320)
                        }
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

/// UIKit-backed selectable text for the "টেক্সট সিলেক্ট করুন" sheet. SwiftUI's
/// `.textSelection(.enabled)` on iOS offers only whole-block copy — real selection
/// grabbers + partial copy + the system edit menu need a UITextView (owner ask
/// build-70 round 3, Claude-app parity).
@available(iOS 17.0, *)
struct AlmaSelectableTextView: UIViewRepresentable {
    let text: String
    let inkColor: UIColor

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.isEditable = false
        tv.isSelectable = true
        tv.isScrollEnabled = true
        tv.alwaysBounceVertical = true
        tv.backgroundColor = .clear
        tv.font = .systemFont(ofSize: 16)
        tv.textColor = inkColor
        tv.tintColor = UIColor(AgentPalette.coral)   // selection handles/highlight
        tv.textContainerInset = UIEdgeInsets(top: 14, left: 12, bottom: 28, right: 12)
        tv.text = text
        return tv
    }

    func updateUIView(_ tv: UITextView, context: Context) {
        if tv.text != text { tv.text = text }
        tv.textColor = inkColor
    }
}

/// Opens when the owner taps a compact 🕐 Thinking / 🔍 Searched / settled summary row.
@available(iOS 17.0, *)
struct AgentActivitySheetRequest: Identifiable, Equatable {
    enum Kind: Equatable { case thoughtProcess, summary, selectText }

    let message: AgentChatMessage
    let kind: Kind
    /// Row-scoped payload: a thinking row's OWN burst (owner report build-70: every
    /// row used to open the WHOLE trace from the first thought), or the text opened
    /// for manual selection (selectText). nil → whole-message fallback.
    var slice: String? = nil
    var id: String { "\(message.id)-\(kind)-\(slice?.hashValue ?? 0)" }
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
                Text(request.kind == .thoughtProcess ? "Thought process"
                     : request.kind == .selectText ? "টেক্সট সিলেক্ট করুন" : "Summary")
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

            if request.kind == .selectText {
                // Claude-app parity (owner ask build-70 round 3): REAL native text
                // selection — tap/long-press marks with grabbers, partial copy,
                // system Copy/Translate/Share menu. SwiftUI Text can only copy the
                // whole block on iOS, so this must be a UITextView.
                AlmaSelectableTextView(text: request.slice ?? message.text,
                                       inkColor: UIColor(pal.ink))
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if request.kind == .summary {
                            summaryTimelineBody(pal)
                        } else {
                            thoughtProcessBody(pal)
                        }
                    }
                    .padding(.horizontal, 16).padding(.bottom, 28)
                }
            }
        }
        .presentationDetents(request.kind == .summary ? [.medium, .large] : [.large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(22)
        .presentationBackground {
            // LOCKED §7 — glossy floating glass (model-switcher tone), aurora bleeds through.
            Color(red: 0.23, green: 0.23, blue: 0.275).opacity(0.42)
                .background(.ultraThinMaterial)
        }
    }

    @ViewBuilder private func thoughtProcessBody(_ pal: AgentPalette) -> some View {
        // Row-scoped slice first (this step's OWN thought / the tapped text);
        // whole-trace fallback for the settled-summary header path.
        let slice = request.slice?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let prose = slice.isEmpty ? combinedThinkingText : slice
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
            || (item.output?.isEmpty == false) || (item.shot?.isEmpty == false)
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
                    // The step's browser screenshot survives the collapse (owner
                    // report 2026-07-15: labels alone read as "screenshots lost").
                    if let shot = item.shot, !shot.isEmpty {
                        AgentToolScreenshotThumb(urlString: shot)
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
        /// Browser-step screenshot URL (owner report 2026-07-15: the collapsed-steps
        /// sheet listed only labels, so the earlier sites' screenshots looked lost).
        var shot: String? = nil
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
            case .tool(let id, let name, let ok, _, let input, let result, let shot):
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
                                 isThought: false, failed: ok == false,
                                 shot: shot ?? tool?.screenshot))
            case .text:
                // Prose lives in the message body — the activity summary only lists steps.
                continue
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
/// the current reply keeps its identity visible while the next turn starts.
@available(iOS 17.0, *)
struct AgentBrandWordmark: View {
    let animateReveal: Bool          // true only on the just-settled reply
    let isCurrent: Bool              // ONE burst per session — only the last settled reply has it
    let vm: AssistantVM
    @State private var shown = false
    private static let letters = ["A", "L", "M", "A"]

    /// Owner rule: ordinary chat/Plan-Drive work must not spin the ALMA identity.
    /// Only a scheduled sleep or an autonomous heartbeat wake activates it.
    private var autonomousLoaderActive: Bool {
        let sleeping = (vm.planDrive?.drives ?? []).contains { drive in
            // A retry/attention timestamp is not autonomous sleeping. Only a
            // plan that is still driving and deliberately scheduled its next
            // wake may animate the ALMA identity.
            guard drive.phase == "driving" else { return false }
            guard let raw = drive.nextTickAt, let date = scheduledDate(raw) else { return false }
            return date.timeIntervalSinceNow > 20
        }
        let globalSelfWake = vm.activeBackgroundTurns.contains { $0.kind == "self-wake" }
        let localSelfWake = vm.isStreaming
            && vm.messages.reversed().first(where: { $0.role == .user })?.isHeartbeatWake == true
        return sleeping || globalSelfWake || localSelfWake
    }

    private func scheduledDate(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
    }

    var body: some View {
        // Fade the burst⇄static swap: it now also happens the moment a NEW turn
        // starts (identity handoff to the active loader) — a hard structural
        // cut there would flicker right as the owner hits send.
        Group {
            if isCurrent { currentBody } else { staticBody }
        }
        .animation(.easeInOut(duration: 0.3), value: isCurrent)
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
        HStack(spacing: 6) {
            AlmaStarburstLoader(mode: autonomousLoaderActive ? .thinking : .idle, size: 18)
                .scaleEffect(shown ? 1 : 0.01)
                .rotationEffect(.degrees(shown ? 0 : -300))
            HStack(spacing: 0.5) {
                ForEach(Array(Self.letters.enumerated()), id: \.offset) { i, ch in
                    Text(ch)
                        .font(.system(size: 13, weight: .bold))
                        .tracking(1.75)
                        // Per-letter slice of the loader aura so the settled
                        // wordmark reads multicolour, matching the burst beside it.
                        .foregroundStyle(AlmaRayBurst.colors[min(i + 1, AlmaRayBurst.colors.count - 1)])
                        .opacity(shown ? 1 : 0)
                        .offset(x: shown ? 0 : -14)
                        .animation(.spring(response: 0.5, dampingFraction: 0.86)
                            .delay(0.12 + Double(i) * 0.07),
                                   value: shown)
                }
            }
            .clipped()
        }
        .onAppear {
            if animateReveal {
                withAnimation(.spring(response: 0.6, dampingFraction: 0.72)) { shown = true }
            } else {
                var tx = Transaction(); tx.disablesAnimations = true
                withTransaction(tx) { shown = true }
            }
        }
    }
}

/// Roadmap Phase 1 — one-tap owner corrections (web FEEDBACK_OPTIONS parity).
let almaFeedbackOptions: [(kind: String, label: String)] = [
    ("wrong_tool", "ভুল টুল"),
    ("lost_progress", "কাজ হারিয়ে ফেলেছে"),
    ("unnecessary_navigation", "অকারণ ঘোরাঘুরি"),
    ("wrong_answer", "ভুল উত্তর"),
    ("too_many_questions", "বেশি প্রশ্ন"),
]

/// ALMA wordmark + background work + quiet reply actions in one native footer.
@available(iOS 17.0, *)
struct AgentMessageActions: View {
    let message: AgentChatMessage
    let vm: AssistantVM
    let pal: AgentPalette
    let showsBackgroundTaskAnchor: Bool
    let backgroundTaskHandoff: Bool
    let backgroundTaskNamespace: Namespace.ID
    let onBackgroundTasks: () -> Void
    @State private var copied = false
    // Debug self-test hook (never set in production launches): ALMA_FEEDBACK_OPEN=1
    // pre-opens the 👎 reason chips so the fixture screenshot proves the row.
    @State private var reasonsOpen =
        ProcessInfo.processInfo.environment["ALMA_FEEDBACK_OPEN"] == "1"
        || ProcessInfo.processInfo.arguments.contains("ALMA_FEEDBACK_OPEN=1")

    private var feedbackSent: Bool { vm.feedbackSentIds.contains(message.id) }
    /// Cheap prefilter before the regex — detection only makes sense on long or
    /// fenced replies, so short prose never pays the regex cost per render.
    private var artifactDetectable: Bool {
        !message.isStreaming
            && (message.text.contains("```") || message.text.count >= 800)
            && AssistantVM.detectArtifact(in: message.text) != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Keep all existing metadata/actions above the identity/task anchor.
            // ViewThatFits prevents a long cache/cost string from pushing an
            // action off-screen on compact iPhones.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) {
                    actionButtons
                    Spacer(minLength: 10)
                    costText
                }
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) { actionButtons; Spacer(minLength: 0) }
                    costText
                }
            }
            .padding(.top, 2)
            if reasonsOpen && !feedbackSent {
                feedbackReasonsRow
            }
            if message.selfCorrected {
                // Truth badge (web parity): the honesty guard caught a false
                // completion claim and the agent verified + rewrote its answer.
                Text("🔁 নিজে যাচাই করে ঠিক করেছে")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(Color(red: 0.85, green: 0.55, blue: 0.10).opacity(0.9))
            }

            // Owner-approved Claude hierarchy: the final line belongs only to
            // loader + ALMA + the one global Background Tasks entry point.
            HStack(spacing: 8) {
                AgentBrandWordmark(
                    animateReveal: vm.justSettledId == message.id,
                    // ONE starburst on screen, ever (owner iteration 2026-07-16):
                    // while a new turn streams, the previous reply's burst hands
                    // off to the active loader below — this row collapses to the
                    // static text wordmark, so the identity reads as having MOVED
                    // down to the working position instead of duplicating.
                    isCurrent: !vm.isStreaming && vm.messages.last(where: {
                        $0.role == .assistant && !$0.isStreaming && !$0.text.isEmpty
                    })?.id == message.id,
                    vm: vm)

                if showsBackgroundTaskAnchor {
                    AgentBackgroundTasksAnchor(
                        vm: vm,
                        pal: pal,
                        handoff: backgroundTaskHandoff,
                        namespace: backgroundTaskNamespace,
                        action: onBackgroundTasks)
                }

                Spacer(minLength: 0)
            }
            .padding(.top, 3)
        }
    }

    /// One-tap structured corrections — the roadmap correction loop's input.
    private var feedbackReasonsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(almaFeedbackOptions, id: \.kind) { opt in
                    Button {
                        withAnimation(.snappy(duration: 0.2)) { reasonsOpen = false }
                        vm.sendFeedback(kind: opt.kind, for: message)
                    } label: {
                        Text(opt.label)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(pal.mutedHi)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(pal.card.opacity(0.6), in: Capsule())
                            .overlay(Capsule().strokeBorder(AgentPalette.coral.opacity(0.35), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 2)
        }
    }

    /// Time + copy/TTS/feedback/সংরক্ষণ — everything except the cost figure and
    /// final ALMA/Background Tasks line.
    @ViewBuilder private var actionButtons: some View {
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
            // 👍/👎 correction loop (web FeedbackButtons parity) — one tap files a
            // structured row in agent_owner_feedback for the weekly report.
            if feedbackSent {
                HStack(spacing: 3) {
                    Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold))
                    Text("নোট করেছি").font(.system(size: 10.5, weight: .medium))
                }
                .foregroundStyle(AgentPalette.teal.opacity(0.9))
                .padding(.horizontal, 2)
            } else {
                Button {
                    reasonsOpen = false
                    vm.sendFeedback(kind: "good", for: message)
                } label: {
                    Image(systemName: "hand.thumbsup")
                        .font(.system(size: 12))
                        .foregroundStyle(pal.muted)
                        .frame(width: 28, height: 28)
                }
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation(.snappy(duration: 0.2)) { reasonsOpen.toggle() }
                } label: {
                    Image(systemName: "hand.thumbsdown")
                        .font(.system(size: 12))
                        .foregroundStyle(reasonsOpen ? AgentPalette.coral : pal.muted)
                        .frame(width: 28, height: 28)
                }
            }
            // Manual "সংরক্ষণ" — file this reply as a conversation artifact.
            if artifactDetectable {
                if vm.artifactSavedIds.contains(message.id) {
                    Text("সংরক্ষিত")
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(AgentPalette.teal.opacity(0.9))
                } else {
                    Button {
                        Task { await vm.saveArtifactManually(from: message) }
                    } label: {
                        Text("সংরক্ষণ")
                            .font(.system(size: 10.5, weight: .medium))
                            .foregroundStyle(pal.muted)
                            .padding(.horizontal, 6)
                            .frame(height: 28)
                    }
                }
            }
    }

    /// Web-footer parity (RC-4): Σ total (incl. cache) · ↑input ⚡cache-write
    /// ♻cache-read ↓output $cost · N ধাপ — N = actual provider API rounds,
    /// the same number the web cost badge shows, never UI phase count.
    @ViewBuilder private var costText: some View {
        if let tin = message.tokensIn {
            let tout = message.tokensOut ?? 0
            let cw = message.cacheCreation ?? 0
            let cr = message.cacheRead ?? 0
            let total = tin + tout + cw + cr
            let rounds = (message.apiRounds ?? 0) > 1 ? " · \(almaBn(message.apiRounds!)) ধাপ" : ""
            Text("Σ\(almaBnCompact(total)) · ↑\(almaBnCompact(tin))"
                 + (cw > 0 ? " ⚡\(almaBnCompact(cw))" : "")
                 + (cr > 0 ? " ♻\(almaBnCompact(cr))" : "")
                 + " ↓\(almaBnCompact(tout))"
                 + (message.costUsd.map { " $\($0)\(rounds)" } ?? ""))
                .font(.system(size: 9.5, design: .monospaced))
                .foregroundStyle(pal.muted.opacity(0.8))
                .lineLimit(1)
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
/// Live render progress inside an approved image/video card — the Creative Studio
/// GeneratingTile recipe (owner ask 2026-07-13): time-eased % that approaches 95
/// and holds (typical render ~38s); the REAL artifact arriving in the thread is
/// the honest 100%. Never fakes completion.
@available(iOS 17.0, *)
struct AgentRenderProgressStrip: View {
    let startedAt: Date
    let pal: AgentPalette

    private func pct(_ now: Date) -> Int {
        let elapsed = now.timeIntervalSince(startedAt)
        guard elapsed > 0 else { return 3 }
        return max(3, min(95, Int(95 * (1 - exp(-elapsed / 38)))))
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { ctx in
            let p = pct(ctx.date)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small).tint(AgentPalette.coral)
                    Text("ছবি তৈরি হচ্ছে… \(almaBn(p))%")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(AgentPalette.coral)
                    Spacer()
                }
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.08))
                        Capsule()
                            .fill(LinearGradient(colors: [AgentPalette.coralDim, AgentPalette.coral],
                                                 startPoint: .leading, endPoint: .trailing))
                            .frame(width: g.size.width * CGFloat(p) / 100)
                            .animation(.easeOut(duration: 0.4), value: p)
                    }
                }
                .frame(height: 5)
            }
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
            } else if card.status == "approved", card.actionType == "image_gen" || card.actionType == "video_gen" {
                // Creative-Studio-style render count (owner ask 2026-07-13): a live
                // 1→95% time-eased fill while the artifact renders — the real image
                // message landing below is the 100% moment.
                AgentRenderProgressStrip(
                    startedAt: vm.confirmApprovedAt[card.id] ?? card.approvedAt ?? Date(),
                    pal: pal)
                    .padding(.horizontal, 16).padding(.bottom, 14)
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

/// Cursor-style delegation card (web DelegationCard parity): the head hands a
/// sub-task to a specialist — role icon, task line, live status, and an
/// expandable result summary + tools-used once the specialist returns.
@available(iOS 17.0, *)
struct AgentDelegationCardView: View {
    let d: AgentChatMessage.Delegation
    let pal: AgentPalette
    @State private var open = false

    private static let roleIcon: [String: String] = [
        "researcher": "🔎", "analyst": "📊", "marketer": "📣",
        "content": "✍️", "ops": "🗂️", "cs": "💬",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                guard d.summary?.isEmpty == false else { return }
                UISelectionFeedbackGenerator().selectionChanged()
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    Text(Self.roleIcon[d.role] ?? "🤝")
                        .font(.system(size: 15))
                        .padding(.top, 1)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(d.roleLabel)
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(pal.ink)
                            Text("সাব-এজেন্ট")
                                .font(.system(size: 9.5, weight: .medium))
                                .foregroundStyle(Color(red: 0.15, green: 0.47, blue: 0.85))
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Color(red: 0.15, green: 0.47, blue: 0.85).opacity(0.12),
                                            in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        }
                        if !d.task.isEmpty {
                            Text(d.task)
                                .font(.system(size: 12))
                                .foregroundStyle(pal.muted)
                                .lineLimit(open ? nil : 1)
                        }
                        if let tools = d.toolsUsed, !tools.isEmpty {
                            Text(tools.joined(separator: " · "))
                                .font(.system(size: 10))
                                .foregroundStyle(pal.muted.opacity(0.8))
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 6)
                    statusGlyph.padding(.top, 2)
                }
                .padding(.horizontal, 14).padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open, let summary = d.summary, !summary.isEmpty {
                Rectangle().fill(pal.borderSubtle).frame(height: 1)
                Text(summary)
                    .font(.system(size: 13))
                    .foregroundStyle(pal.mutedHi)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.vertical, 11)
            }
        }
        .background(pal.card.opacity(0.8), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(Color.white.opacity(0.07), lineWidth: 1))
    }

    @ViewBuilder private var statusGlyph: some View {
        if !d.done && !d.stopped {
            AlmaSparklePulse(size: 13)
        } else if d.stopped {
            Image(systemName: "stop.fill")
                .font(.system(size: 11))
                .foregroundStyle(pal.muted.opacity(0.6))
        } else if d.success != false {
            Image(systemName: "checkmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(AgentPalette.teal)
        } else {
            Image(systemName: "xmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(.red)
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

/// Inline browser-screenshot preview under a tool row (web parity: "the owner
/// sees what the agent saw"). Tap → full-screen zoomable viewer (existing
/// PortalImageViewer — pinch/double-tap zoom, ✕ to close).
@available(iOS 17.0, *)
struct AgentToolScreenshotThumb: View {
    let urlString: String
    var maxHeight: CGFloat = 190
    /// `.fit` mode for in-prose chat images (whole image visible, letterboxed);
    /// default `.fill` crop suits wide browser screenshots under tool rows.
    var fit = false
    @State private var preview: PortalImagePreview?
    @State private var failed = false

    var body: some View {
        if failed {
            EmptyView()
        } else {
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                preview = PortalImagePreview(urls: [urlString], index: 0)
            } label: {
                AsyncImage(url: URL(string: urlString)) { phase in
                    // Placeholder and loaded image render at the SAME height: a lazy
                    // chat row whose height jumps when the image arrives shifts the
                    // whole scroll geometry — that jump is one root of the 2026-07-15
                    // scroll-bounce/freeze diagnosis. Reserve the box up front.
                    switch phase {
                    case .success(let img):
                        // Fixed-size stage + overlay: the image can NEVER dictate row
                        // geometry (2026-07-15 owner report: a wide screenshot pushed
                        // the card past the screen edge when the image sized the frame).
                        Color.clear
                            .frame(maxWidth: .infinity)
                            .frame(height: maxHeight)
                            .overlay(alignment: fit ? .leading : .top) {
                                img.resizable()
                                    .aspectRatio(contentMode: fit ? .fit : .fill)
                                    .frame(maxWidth: .infinity, maxHeight: maxHeight, alignment: fit ? .leading : .top)
                            }
                            .clipped()
                    case .failure:
                        Color.clear.frame(height: 1).onAppear { failed = true }
                    default:
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Color.white.opacity(0.06))
                            .frame(height: maxHeight)
                            .redacted(reason: .placeholder)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .fullScreenCover(item: $preview) { PortalImageViewer(preview: $0, showsSave: true) }
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
/// rows grow together in SSE order. The durable model keeps every block, while
/// the chat mounts a bounded tail so a future 100-step autonomous turn cannot
/// become one enormous SwiftUI row. Older content remains available through the
/// single "আগের N ধাপ" summary row; actionable cards are always pinned visible.
@available(iOS 17.0, *)
struct AgentTurnBlocksView: View {
    let message: AgentChatMessage
    let pal: AgentPalette
    let vm: AssistantVM
    let onToolTap: (AgentChatMessage.Tool) -> Void
    let onActivitySheet: (AgentActivitySheetRequest.Kind, String?) -> Void

    private static let maxVisibleBlocks = 12

    private var displayedBlocks: [AgentChatMessage.TurnBlock] {
        guard message.blocks.count > Self.maxVisibleBlocks else { return message.blocks }
        let tailStart = message.blocks.count - Self.maxVisibleBlocks
        let pinned = message.blocks[..<tailStart].filter { block in
            switch block {
            case .file, .confirmCard, .askCard: return true
            case .prose, .activity: return false
            }
        }
        return Array(pinned) + Array(message.blocks[tailStart...])
    }

    var body: some View {
        let blocks = displayedBlocks
        let hiddenCount = max(0, message.blocks.count - blocks.count)
        let lastBlockId = message.blocks.last?.id
        VStack(alignment: .leading, spacing: 6) {
            if hiddenCount > 0 {
                AgentCompactActivityRow(icon: "clock.arrow.circlepath",
                                        label: "আগের \(almaBn(hiddenCount)) ধাপ",
                                        labelColor: pal.muted, iconColor: pal.muted) {
                    onActivitySheet(.summary, nil)
                }
            }
            ForEach(blocks) { block in
                switch block {
                case .prose(let id, let text):
                    proseBlock(text, isTail: id == lastBlockId && message.isStreaming)
                case .file(_, let artifactId, let name):
                    AgentArtifactFileCard(artifactId: artifactId, name: name, vm: vm, pal: pal)
                case .confirmCard(_, let pid):
                    // Rendered HERE, at the exact point of the reply where the head
                    // staged it (owner report build-70 round 4 — cards used to pile
                    // up at the bottom of the turn). Data/status live in the array.
                    if let card = message.confirmCards.first(where: { $0.id == pid }) {
                        AgentConfirmCardView(card: card, pal: pal, vm: vm) { approve in
                            Task { await vm.approveAction(card.id, approve: approve) }
                        }
                    }
                case .askCard(_, let aid):
                    if let card = message.askCards.first(where: { $0.id == aid }) {
                        AgentAskCardsPager(cards: [card], pal: pal) { card, option in
                            Task { await vm.answerAskCard(card.id, option: option) }
                        }
                    }
                case .activity(let a):
                    activityRow(a, isTail: block.id == lastBlockId && message.isStreaming)
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
                // Owner ask build-70 round 4 (Claude-app parity): settled prose is
                // DIRECTLY selectable in the chat — long-press/double-tap marks with
                // native grabbers and the system Copy menu. No context menu here (it
                // would swallow the long-press); whole-reply copy lives in the footer.
                AgentMarkdownText(text: text, pal: pal, selectable: true)
                    .padding(.vertical, 2)
            }
        }
    }

    @ViewBuilder private func activityRow(_ a: AgentChatMessage.ActivityBlock, isTail: Bool = false) -> some View {
        switch a.kind {
        case .thinking:
            // Tail thinking row = the LIVE changing headline → shimmer (Claude parity).
            // Tap → ONLY this step's own burst — never the whole trace from the
            // first thought (owner report build-70 round 2).
            AgentCompactActivityRow(icon: "clock", label: a.label, italic: true,
                                    labelColor: pal.muted, iconColor: pal.muted,
                                    shimmer: isTail) {
                onActivitySheet(.thoughtProcess, a.thinkFull)
            }
        case .search:
            AgentCompactActivityRow(icon: "magnifyingglass", label: a.label,
                                    labelColor: pal.muted, iconColor: pal.muted) {
                onActivitySheet(.summary, nil)
            }
        case .tool:
            // A step still RUNNING (no result yet) shimmers its icon+title while it
            // is the live tail — Claude Code's active-step headline (owner ask
            // 2026-07-12); the shimmer drops the moment tool_end lands (ok != nil).
            VStack(alignment: .leading, spacing: 6) {
                AgentCompactActivityRow(icon: "wrench.and.screwdriver", label: a.label,
                                        labelColor: pal.mutedHi, iconColor: pal.muted,
                                        failed: a.ok == false,
                                        shimmer: isTail && a.ok == nil) {
                    if let t = message.tools.first(where: { $0.id == a.toolId }) {
                        onToolTap(t)
                    } else {
                        onActivitySheet(.summary, nil)
                    }
                }
                // Browser screenshot INLINE — the owner sees what the agent saw
                // (web parity); tap opens the full-screen zoomable viewer.
                if let shot = a.screenshot {
                    AgentToolScreenshotThumb(urlString: shot)
                        .padding(.leading, 26)
                        .padding(.bottom, 4)
                }
            }
        }
    }
}

// AgentLiveWorkSummaryRow ("কাজ করছি… · ~N টোকেন · N ধাপ") retired 2026-07-16 —
// its job moved into AgentThinkingRow's Claude-Code-style live status.

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
/// PR 3b — model_switch_required approval card. The paused turn resumes on the
/// premium model (approve) or the cheap fallback (decline) — web parity.
@available(iOS 17.0, *)
struct AgentModelSwitchCardView: View {
    let card: AgentChatMessage.ModelSwitch
    let pal: AgentPalette
    let onDecide: (_ approve: Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.up.circle")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(AgentPalette.coral)
                Text("মডেল আপগ্রেড দরকার")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(pal.ink)
            }
            Text("এই কাজটা ভালোভাবে করতে \(card.toLabel) লাগবে (এখন \(card.fromLabel) চলছে)। খরচ একটু বেশি হবে Boss।")
                .font(.system(size: 13))
                .foregroundStyle(pal.muted)
                .fixedSize(horizontal: false, vertical: true)
            if card.status == "pending" {
                HStack(spacing: 10) {
                    Button {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        onDecide(true)
                    } label: {
                        Text("\(card.toLabel)-এ চালাও")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(AgentPalette.coral, in: Capsule())
                    }
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        onDecide(false)
                    } label: {
                        Text("সস্তা মডেলেই চালাও")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(pal.muted)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .overlay(Capsule().strokeBorder(pal.borderSubtle, lineWidth: 1))
                    }
                }
            } else {
                Text(card.status == "approved" ? "✅ \(card.toLabel)-এ চালানো হচ্ছে…" : "চালু মডেলেই চলছে…")
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(pal.muted)
            }
        }
        .padding(14)
        .background(pal.glassFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(AgentPalette.coral.opacity(0.35), lineWidth: 1))
        .padding(.vertical, 4)
    }
}

@available(iOS 17.0, *)
struct AgentThinkingRow: View {
    let mode: String
    let pal: AgentPalette
    /// The streaming tail — live token estimate for the status label.
    var message: AgentChatMessage? = nil
    /// Thinking-delta freshness from the VM: quiet thinking ⇒ "almost done".
    var lastThinkingGrowthAt: Date = .distantPast
    /// Transport dropped but the server turn is still running (roadmap Phase 1.1) —
    /// truthful glyph/text-only state, never an error, never a background effect.
    var reconnecting: Bool = false
    /// Stall-recovery ladder position (owner spec 2026-07-17, Claude-Code
    /// style): >0 replaces the phase verb with "আবার চেষ্টা N/৫…" so a dead
    /// stream reads as actively retrying, never as a silent hang.
    var stallRetryAttempt: Int = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phaseEnteredAt = Date()

    var body: some View {
        HStack(spacing: 8) {
            AlmaSpinnerView(mode: mode, size: 28, showVerb: false, haptics: true)
            AlmaShimmerWordmark(size: 12.5, weight: .semibold, tracking: 2.1)
            if reconnecting {
                Text("· কাজ চলছে — সংযোগ ফিরছে…")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(pal.muted)
                    .transition(.opacity)
            } else {
                // Claude-Code-style live status (owner iteration 2): token count
                // FIRST and steady; the phase verb LAST — so a growing count
                // never pushes the verb around — and ONLY the verb blinks (the
                // slow eye-open/eye-close breath). Verb changes fade softly.
                if tokenEstimate() > 0 {
                    Text("· \(almaBnCompact(tokenEstimate())) টোকেন")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(pal.muted)
                        .contentTransition(.numericText())
                        .lineLimit(1)
                }
                TimelineView(.animation(minimumInterval: 1 / 12, paused: reduceMotion)) { tl in
                    let t = tl.date.timeIntervalSinceReferenceDate
                    let blink = reduceMotion ? 1.0 : 0.38 + 0.62 * (0.5 + 0.5 * sin(t * .pi * 2 / 1.7))
                    Text("· \(statusVerb(now: tl.date))")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(pal.muted)
                        .opacity(blink)
                        .contentTransition(.opacity)
                        .animation(.easeInOut(duration: 0.35), value: statusVerb(now: tl.date))
                        .lineLimit(1)
                }
            }
            Spacer()
        }
        .padding(.leading, 0)
        .padding(.bottom, 8)
        .onChange(of: mode) { _, _ in phaseEnteredAt = Date() }
    }

    private func tokenEstimate() -> Int {
        guard let message else { return 0 }
        return max(0, ((message.thinking ?? "").count + message.text.count) / 4)
    }

    /// The Claude-Code verb ladder — EVERY working phase escalates with time
    /// and ends in its own "almost done …" (owner iteration 2: "যেখানে time
    /// বেশি লাগবে সেখানে almost হবে"), thinking additionally treats a quiet
    /// delta stream (≥3s) as the thought closing.
    private func statusVerb(now: Date) -> String {
        if stallRetryAttempt > 0 {
            return "আবার চেষ্টা \(almaBn(stallRetryAttempt))/৫…"
        }
        let inPhase = now.timeIntervalSince(phaseEnteredAt)
        switch mode {
        case "understanding":
            return "reading…"
        case "writing":
            if inPhase > 30 { return "almost done writing…" }
            if inPhase > 15 { return "still writing…" }
            return "writing…"
        case "searching", "researching":
            if inPhase > 35 { return "almost done working…" }
            if inPhase > 15 { return "still working…" }
            return "working…"
        default:
            // Thinking family. Quiet deltas for a beat ⇒ the thought is closing.
            if lastThinkingGrowthAt != .distantPast,
               now.timeIntervalSince(lastThinkingGrowthAt) > 3.0 {
                return "almost done thinking…"
            }
            if inPhase > 40 { return "almost done thinking…" }
            if inPhase > 24 { return "still thinking…" }
            if inPhase > 10 { return "thinking more…" }
            return "thinking…"
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
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .strokeBorder(
                AngularGradient(stops: [
                    .init(color: AgentPalette.coral.opacity(0.20), location: 0),
                    .init(color: AgentPalette.coral.opacity(0.80), location: 0.22),
                    .init(color: Color(red: 0.961, green: 0.784, blue: 0.471).opacity(0.85), location: 0.36),
                    .init(color: Color(red: 0.471, green: 0.784, blue: 0.961).opacity(0.75), location: 0.58),
                    .init(color: AgentPalette.coral.opacity(0.20), location: 1),
                ], center: .center, angle: .degrees(22)),
                lineWidth: 1.25)
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
/// quick-access pills, চ্যাট/স্মৃতি tabs, project filter,
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

    private var filteredConversations: [AgentConversation] {
        vm.conversations.filter { c in
            guard c.archived != true else { return false }
            // Office/day-shift conversations are background execution records,
            // not a second owner chat inbox. Their daily work continues to sync
            // into Background Tasks through loadOfficeDailyDuties().
            guard c.source != "day_shift" else { return false }
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

            // Office is intentionally not a second conversation section. Keep
            // only the project filter; Office duties surface in Background Tasks.
            HStack(spacing: 8) {
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

    @ViewBuilder private func conversationRow(_ c: AgentConversation, pal: AgentPalette) -> some View {
        let active = c.id == vm.conversationId
        Button {
            Task { await vm.openConversation(c.id) }
            close()
        } label: {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(c.title?.isEmpty == false ? c.title! : "(শিরোনাম নেই)")
                        .font(.system(size: 14, weight: active ? .semibold : .regular))
                        .foregroundStyle(active ? AgentPalette.coral : pal.ink)
                        .lineLimit(1)
                    Text(shortDate(c.updatedAt))
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

// MARK: - Background tasks — one reply anchor + native task sheet

/// Claude-Code-style inline task status. The ALMA mark belongs to the parent
/// reply footer, so this renders no duplicate icon, loader, card, or chat row.
@available(iOS 17.0, *)
private struct AgentBackgroundTasksAnchor: View {
    @Bindable var vm: AssistantVM
    let pal: AgentPalette
    let handoff: Bool
    let namespace: Namespace.ID
    let action: () -> Void

    private var drives: [AgentPlanDriveView] { vm.planDrive?.drives ?? [] }
    private var runningCount: Int {
        let selfWakes = vm.activeBackgroundTurns.filter { $0.kind == "self-wake" }
        let globalIds = Set(selfWakes.map(\.id))
        let localSelfWake = vm.isStreaming
            && vm.messages.reversed().first(where: { $0.role == .user })?.isHeartbeatWake == true
        let localWakeMissing = localSelfWake
            && (vm.currentTurnId == nil || !globalIds.contains(vm.currentTurnId!))
        // A normal owner-started foreground chat stays in the chat timeline. Only
        // autonomous self-wakes and durable Plan-Drive work belong in this count.
        return drives.count + selfWakes.count + (localWakeMissing ? 1 : 0)
    }

    /// Pending approvals count into the anchor (owner-hit 2026-07-16: an
    /// approval card appeared and the footer still said a sleepy "Background
    /// Tasks" — a decision waiting on the owner must light this label up, the
    /// sheet already lists it under "Needs attention" with its age).
    ///
    /// UNION of the server list and the pending confirm cards visible in this
    /// chat (same pendingActionId space, deduped): the server list refreshes on
    /// a 12s poll, so alone it lags the card by up to a poll tick — the owner
    /// hit exactly that gap (card on screen, label still asleep, round 2).
    /// Local card status flips instantly on approve/reject, so the label also
    /// falls back to sleep with zero lag.
    private var attentionCount: Int { vm.mergedAttention.count }

    private var label: String {
        let total = runningCount + attentionCount
        if attentionCount > 0 && runningCount == 0 {
            return attentionCount == 1 ? "1 Approval Waiting" : "\(attentionCount) Approvals Waiting"
        }
        if total > 0 {
            return total == 1 ? "1 Running Task" : "\(total) Running Tasks"
        }
        return "Background Tasks"
    }

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        } label: {
            HStack(spacing: 5) {
                Text("·")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(pal.muted.opacity(0.7))
                Text(label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(handoff ? pal.mutedHi : pal.ink.opacity(0.92))
                    .lineLimit(1)
                    .minimumScaleFactor(0.82)
                    .contentTransition(.numericText())
                Image(systemName: "chevron.right")
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(pal.muted.opacity(0.68))
            }
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .matchedGeometryEffect(id: "alma-background-task-anchor", in: namespace)
        .animation(.spring(response: 0.48, dampingFraction: 0.84), value: handoff)
        .accessibilityLabel(label)
        .accessibilityHint("Background tasks খুলুন")
    }
}

/// One presentation model over the three durable sources that can currently be
/// executing work: a Plan-Drive, an Office todo, or an autonomous self-wake.
/// Source ids remain intact so Stop always reaches the owning endpoint.
private struct AgentBackgroundRunningItem: Identifiable {
    enum Source { case plan, todo, turn }
    let id: String
    let source: Source
    let sourceId: String
    let title: String
    let detail: String?
    let phase: String
    let nextTickAt: String?
    let startedAt: String?
    let steps: [AgentPlanDriveStep]?
}

/// Compact checklist row shared by Office duties and any extra agent todo that
/// is not part of the canonical duty roster.
private struct AgentTodayWorkItem: Identifiable {
    let id: String
    let title: String
    let detail: String?
    let status: String
    let time: String?
    let dutyKey: String?
}

@available(iOS 17.0, *)
private struct AgentBackgroundTasksSheet: View {
    @Bindable var vm: AssistantVM
    @Binding var selectedDetent: PresentationDetent
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var runningExpanded = true
    @State private var todayExpanded = false
    @State private var finishedExpanded = true
    @State private var selectedFinished: AgentPlanDriveHistoryView?
    @State private var confirm: Confirm?

    private struct Confirm: Identifiable {
        let id = UUID()
        let source: AgentBackgroundRunningItem.Source
        let sourceId: String
        let title: String
        let button: String
    }

    private var drives: [AgentPlanDriveView] { vm.planDrive?.drives ?? [] }
    private var todayWork: [AgentTodayWorkItem] {
        let duties = vm.officeDailyDuties.map { duty in
            AgentTodayWorkItem(
                id: "duty-\(duty.duty)", title: duty.label, detail: duty.detail,
                status: duty.status, time: duty.time, dutyKey: duty.duty
            )
        }
        let dutyKeys = Set(vm.officeDailyDuties.map(\.duty))
        let extras = vm.dailyAgentTodos.compactMap { todo -> AgentTodayWorkItem? in
            guard todo.status != "cancelled" else { return nil }
            if let key = todo.dutyKey, dutyKeys.contains(key) { return nil }
            return .init(
                id: "todo-\(todo.id)", title: todo.title, detail: todo.description,
                status: todo.status ?? "pending", time: nil, dutyKey: todo.dutyKey
            )
        }
        return duties + extras
    }
    private var completedTodoCount: Int {
        todayWork.filter { $0.status == "completed" || $0.status == "done" }.count
    }
    private var failedTodoCount: Int {
        todayWork.filter { $0.status == "failed" || $0.status == "missed" }.count
    }
    private var todoPreview: [AgentTodayWorkItem] {
        Array(todayWork.sorted { todayRank($0) < todayRank($1) }.prefix(3))
    }
    private var runningItems: [AgentBackgroundRunningItem] {
        var items: [AgentBackgroundRunningItem] = []

        let localSelfWake = vm.isStreaming
            && vm.messages.reversed().first(where: { $0.role == .user })?.isHeartbeatWake == true
        if localSelfWake, let tail = vm.messages.last(where: { $0.isStreaming }) {
            let sourceId = vm.currentTurnId ?? tail.id
            items.append(.init(
                id: "turn-\(sourceId)", source: .turn, sourceId: sourceId,
                title: "ALMA নিজে থেকে জেগে কাজ করছে",
                detail: activeTurnDetail(tail), phase: "self-wake", nextTickAt: nil,
                startedAt: isoString(tail.streamStartedAt),
                steps: steps(from: tail)
            ))
        }

        // A server turn remains here after the owner opens another conversation.
        // Skip the current conversation's copy while its richer local stream row
        // is visible, otherwise the same execution would count twice.
        items.append(contentsOf: vm.activeBackgroundTurns.compactMap { turn in
            guard turn.kind == "self-wake" else { return nil }
            if vm.isStreaming && turn.conversationId == vm.conversationId { return nil }
            return .init(
                id: "turn-\(turn.id)", source: .turn, sourceId: turn.id,
                title: "ALMA নিজে থেকে জেগে কাজ করছে",
                detail: "Background self-wakeup চলছে",
                phase: "self-wake", nextTickAt: nil,
                startedAt: turn.startedAt, steps: nil
            )
        })

        items.append(contentsOf: drives.map { drive in
            .init(
                id: "plan-\(drive.planId)", source: .plan, sourceId: drive.planId,
                title: drive.goal ?? "Background task",
                detail: drive.waitingReason ?? drive.currentLine,
                phase: drive.phase ?? "driving", nextTickAt: drive.nextTickAt,
                startedAt: drive.startedAt ?? drive.lastDrivenAt,
                steps: drive.steps
            )
        })

        return items
    }

    private var finishedItems: [AgentPlanDriveHistoryView] {
        let combined = (vm.planDrive?.finished ?? []) + finishedHeartbeatWakes()
            + finishedOfficeDuties() + finishedTodos()
        let cutoff = Date().addingTimeInterval(-24 * 60 * 60)
        var seen = Set<String>()
        return combined
            // Rolling 24-hour recycle: preserve the durable audit in storage, but
            // keep this daily surface clean without destructive database deletes.
            .filter { item in
                guard let completed = parseISO(item.completedAt) else { return false }
                return completed >= cutoff
            }
            .filter { seen.insert($0.id).inserted }
            .sorted {
                (parseISO($0.completedAt) ?? .distantPast) > (parseISO($1.completedAt) ?? .distantPast)
            }
    }

    var body: some View {
        let pal = AgentPalette(scheme)
        let running = runningItems
        let finished = finishedItems
        NavigationStack {
            ZStack {
                AgentAuroraBackground()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        if !running.isEmpty {
                            collapsibleHeader("Running", count: running.count,
                                              isExpanded: $runningExpanded, pal: pal)
                            if runningExpanded {
                                ForEach(running) { item in
                                    // One shared visual focus row, not one display
                                    // link per task. Other running rows stay tinted.
                                    runningRow(item, pal: pal,
                                               animateSheen: item.id == running.first?.id)
                                }
                            }
                        }

                        almaSummary(pal: pal)

                        attentionSection(pal: pal)
                        todayWorkSection(pal: pal)

                        collapsibleHeader("Finished", count: finished.count,
                                          isExpanded: $finishedExpanded, pal: pal)
                        if finishedExpanded {
                            if finished.isEmpty {
                                emptyLine("Finished history এখনো নেই", icon: "clock.arrow.circlepath", pal: pal)
                            } else {
                                ForEach(finished) { finishedRow($0, pal: pal) }
                            }
                        }
                    }
                    .padding(.horizontal, 17).padding(.top, 8).padding(.bottom, 34)
                }
            }
            .navigationTitle("Background tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").font(.system(size: 12, weight: .bold))
                            .foregroundStyle(pal.ink)
                            .frame(width: 32, height: 32)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .accessibilityLabel("বন্ধ করুন")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
                            selectedDetent = selectedDetent == .large ? .medium : .large
                        }
                    } label: {
                        Image(systemName: selectedDetent == .large
                              ? "arrow.down.right.and.arrow.up.left"
                              : "arrow.up.left.and.arrow.down.right")
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(pal.mutedHi)
                            .frame(width: 30, height: 30)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .accessibilityLabel(selectedDetent == .large ? "ছোট করুন" : "বড় করুন")
                }
            }
        }
        .task {
            await refreshData(includeDuties: true)
            let detailFlag = ProcessInfo.processInfo.arguments.contains("ALMA_BACKGROUND_TASK_DETAIL=1")
                || ProcessInfo.processInfo.environment["ALMA_BACKGROUND_TASK_DETAIL"] == "1"
            if detailFlag, selectedFinished == nil {
                selectedFinished = finishedItems.first
            }
            let fixtureFlag = ProcessInfo.processInfo.arguments.contains("ALMA_BACKGROUND_TASK_FIXTURE=1")
            let autoStopFlag = ProcessInfo.processInfo.arguments.contains("ALMA_BACKGROUND_TASK_AUTOSTOP=1")
            if fixtureFlag, autoStopFlag, let planId = drives.first?.planId {
                try? await Task.sleep(nanoseconds: 1_200_000_000)
                await vm.planDriveAct(planId: planId, action: "abandon")
            }
            var refreshTick = 0
            while !Task.isCancelled {
                // Countdown labels tick locally; network-backed task state does
                // not need to rebuild the full sheet every two seconds.
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard !Task.isCancelled else { break }
                refreshTick += 1
                await refreshData(includeDuties: refreshTick % 6 == 0)
            }
        }
        .refreshable { await refreshData(includeDuties: true) }
        .sheet(item: $selectedFinished) { item in
            AgentBackgroundTaskDetailSheet(task: item)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(28)
        }
        .confirmationDialog(confirm?.title ?? "", isPresented: Binding(
            get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
            if let confirm {
                Button(confirm.button, role: .destructive) {
                    Task { await stop(confirm) }
                }
                Button("থাক", role: .cancel) {}
            }
        }
    }

    private func refreshData(includeDuties: Bool = false) async {
        async let drive: Void = vm.loadPlanDrive()
        async let turns: Void = vm.loadActiveBackgroundTurns()
        if includeDuties {
            async let todos: Void = vm.loadDailyAgentTodos()
            async let duties: Void = vm.loadOfficeDailyDuties()
            async let heartbeat: Void = vm.loadHeartbeatFeed()
            _ = await (drive, turns, todos, duties, heartbeat)
        } else {
            // Five-second live refresh is restricted to the two genuinely dynamic
            // feeds. Office roster/heartbeat history refresh every 30 seconds.
            _ = await (drive, turns)
        }
    }

    private func almaSummary(pal: AgentPalette) -> some View {
        let sleeping = runningItems.contains {
            $0.phase == "driving" && isFutureWake($0.nextTickAt)
        }
        let autonomousWakeRunning = runningItems.contains { $0.phase == "self-wake" }
            || (vm.isStreaming
            && vm.messages.reversed().first(where: { $0.role == .user })?.isHeartbeatWake == true
            )
        let loaderActive = sleeping || autonomousWakeRunning

        // Only this tiny text/card subtree ticks once per second. The main chat
        // list is outside the TimelineView, so countdown motion cannot invalidate
        // or re-layout message rows.
        return TimelineView(.periodic(from: .now, by: 1)) { timeline in
            let settings = vm.heartbeatFeed?.settings
            let selfWakeEnabled = settings?.enabled == true || settings?.autoArm == true
            let nextCheck = selfWakeEnabled ? nextHeartbeatCheck(after: timeline.date) : nil

            HStack(spacing: 11) {
                ZStack {
                    Circle()
                        .fill(AlmaRayBurst.colors[1].opacity(0.12))
                        .frame(width: 42, height: 42)
                    // A cron check alone is not an executing task. Animate only
                    // for an explicit Plan-Drive sleep or a live autonomous wake.
                    AlmaStarburstLoader(mode: loaderActive ? .thinking : .idle, size: 22)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Background execution")
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(pal.ink)
                        .lineLimit(1)
                    Text(nextCheck.map { "পরের wake check \(wakeCountdown(to: $0, now: timeline.date))" }
                         ?? "Self-wakeup বন্ধ")
                        .font(.system(size: 11.5))
                        .foregroundStyle(pal.muted)
                        .lineLimit(1)
                        .contentTransition(.numericText())
                }
                Spacer(minLength: 4)
            }
        }
        .padding(13)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 19, style: .continuous))
        .background(
            LinearGradient(colors: [AlmaRayBurst.colors[1].opacity(0.08), AgentPalette.coral.opacity(0.05)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 19, style: .continuous))
        .overlay {
            if summarySheenActive {
                TimelineView(.animation(minimumInterval: 1.0 / 12.0, paused: reduceMotion)) { timeline in
                    GeometryReader { proxy in
                        let duration = 2.4
                        let phase = timeline.date.timeIntervalSinceReferenceDate
                            .truncatingRemainder(dividingBy: duration) / duration
                        let width = max(76, proxy.size.width * 0.34)
                        LinearGradient(
                            colors: [.clear, AlmaRayBurst.colors[1].opacity(0.08),
                                     Color.white.opacity(0.12), .clear],
                            startPoint: .leading, endPoint: .trailing
                        )
                        .frame(width: width, height: proxy.size.height)
                        .offset(x: -width + (proxy.size.width + width) * phase)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 19, style: .continuous)
            .strokeBorder(AlmaRayBurst.colors[1].opacity(0.18), lineWidth: 1))
    }

    /// Sheen condition for the Background-execution card. OWNER RULE (finally
    /// verbatim, 2026-07-17): the sheen marks ONLY work the agent itself put
    /// in the background — an explicit Plan-Drive sleep or a live autonomous
    /// wake. The ambient cron wake-check countdown is NOT the agent's own
    /// task (the original comment said exactly this; overriding it was my
    /// mistake) — armed-but-idle heartbeat gets NO sheen.
    private var summarySheenActive: Bool {
        let sleeping = runningItems.contains {
            $0.phase == "driving" && isFutureWake($0.nextTickAt)
        }
        let wakeRunning = runningItems.contains { $0.phase == "self-wake" }
            || (vm.isStreaming
            && vm.messages.reversed().first(where: { $0.role == .user })?.isHeartbeatWake == true)
        return sleeping || wakeRunning
    }

    private func nextHeartbeatCheck(after now: Date) -> Date? {
        if let serverDate = parseISO(vm.heartbeatFeed?.nextCheckAt), serverDate > now {
            return serverDate
        }
        // Production may not have the additive API field until its next deploy;
        // mirror the current Vercel cron (04/07/10/13 UTC) for native continuity.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        for dayOffset in 0...1 {
            guard let day = calendar.date(byAdding: .day, value: dayOffset, to: now) else { continue }
            let parts = calendar.dateComponents([.year, .month, .day], from: day)
            for hour in [4, 7, 10, 13] {
                var candidateParts = parts
                candidateParts.hour = hour
                candidateParts.minute = 0
                candidateParts.second = 0
                if let candidate = calendar.date(from: candidateParts), candidate > now {
                    return candidate
                }
            }
        }
        return nil
    }

    private func wakeCountdown(to date: Date, now: Date) -> String {
        let seconds = max(0, Int(ceil(date.timeIntervalSince(now))))
        let hours = seconds / 3_600
        let minutes = (seconds % 3_600) / 60
        let remainder = seconds % 60
        if hours > 0 {
            return "\(almaBn(hours))ঘ \(almaBn(minutes))মি \(almaBn(remainder))সে পরে"
        }
        if minutes > 0 { return "\(almaBn(minutes))মি \(almaBn(remainder))সে পরে" }
        return "\(almaBn(remainder))সে পরে"
    }

    @ViewBuilder private func attentionSection(pal: AgentPalette) -> some View {
        let attention = vm.mergedAttention
        if !attention.isEmpty {
            attentionHeader(pal: pal, count: attention.count)
            VStack(spacing: 0) {
                ForEach(Array(attention.enumerated()), id: \.element.id) { index, item in
                    attentionRow(item, pal: pal)
                    if index < attention.count - 1 {
                        Divider().overlay(pal.borderSubtle).padding(.leading, 47)
                    }
                }
            }
            .padding(.vertical, 3)
            .background(pal.card.opacity(0.62),
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(AgentPalette.coral.opacity(0.18), lineWidth: 1))
        }
    }

    @ViewBuilder private func todayWorkSection(pal: AgentPalette) -> some View {
        todayWorkHeader(pal: pal)
        if todayWork.isEmpty {
            emptyLine("Office-এর আজকের duty load হয়নি", icon: "list.bullet.clipboard", pal: pal)
        } else {
            let displayedTodos = todayExpanded ? todayWork : todoPreview
            // This list can contain the full Office roster (30+ rows). Keep it
            // lazy and keyed directly by the durable duty/todo id so the live
            // countdown refresh cannot rebuild every row or create a SwiftUI
            // AttributeGraph/layout feedback loop.
            LazyVStack(spacing: 0) {
                ForEach(displayedTodos) { todo in
                    todayTodoRow(todo, pal: pal)
                    if todo.id != displayedTodos.last?.id {
                        Divider().overlay(pal.borderSubtle).padding(.leading, 47)
                    }
                }
                if !todayExpanded && todayWork.count > displayedTodos.count {
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        // Avoid animating the height of the entire 30+ row
                        // subtree. The header chevron still animates locally.
                        todayExpanded = true
                    } label: {
                        Text("আরও \(almaBn(todayWork.count - displayedTodos.count))টি কাজ দেখুন")
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(AlmaRayBurst.colors[1])
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                    }
                    .buttonStyle(.plain)
                    .overlay(alignment: .top) {
                        Divider().overlay(pal.borderSubtle).padding(.horizontal, 12)
                    }
                }
            }
            .padding(.vertical, 3)
            .background(pal.card.opacity(0.62),
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(AlmaRayBurst.colors[1].opacity(0.13), lineWidth: 1))
        }
    }

    private func attentionHeader(pal: AgentPalette, count: Int) -> some View {
        HStack(spacing: 7) {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(AgentPalette.coral)
            Text("Needs attention")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(pal.mutedHi)
            Text(almaBn(count))
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(AgentPalette.coral)
                .contentTransition(.numericText())
            Spacer()
            Text("Approval pending")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(AgentPalette.coral)
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(AgentPalette.coral.opacity(0.10), in: Capsule())
        }
        .accessibilityElement(children: .combine)
    }

    private func attentionRow(_ item: AgentBackgroundAttention, pal: AgentPalette) -> some View {
        HStack(alignment: .center, spacing: 11) {
            ZStack {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(AgentPalette.coral.opacity(0.11))
                    .frame(width: 34, height: 34)
                Image(systemName: "exclamationmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(AgentPalette.coral)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(item.summary.isEmpty ? "আপনার অনুমোদন দরকার" : item.summary)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(pal.ink)
                    .lineLimit(2)
                TimelineView(.periodic(from: .now, by: 60)) { timeline in
                    Text("Owner approval দরকার · \(attentionAge(item.createdAt, now: timeline.date))")
                        .font(.system(size: 11))
                        .foregroundStyle(AgentPalette.coral)
                        .contentTransition(.numericText())
                }
            }
            Spacer(minLength: 4)
            Image(systemName: "checkmark.seal")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(AgentPalette.coral.opacity(0.8))
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Approvals tab থেকে অনুমোদন বা বাতিল করুন")
    }

    private func attentionAge(_ raw: String, now: Date) -> String {
        guard let date = parseISO(raw) else { return "এখন" }
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 60 { return "এখন" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(almaBn(minutes)) মিনিট আগে" }
        let hours = minutes / 60
        if hours < 24 { return "\(almaBn(hours)) ঘণ্টা আগে" }
        return "\(almaBn(hours / 24)) দিন আগে"
    }

    private func todayWorkHeader(pal: AgentPalette) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            todayExpanded.toggle()
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "checklist")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(AlmaRayBurst.colors[1])
                Text("Today's work")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(pal.mutedHi)
                Text(almaBn(todayWork.count))
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(pal.muted)
                    .contentTransition(.numericText())
                Image(systemName: "chevron.down")
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(pal.muted)
                    .rotationEffect(.degrees(todayExpanded ? 0 : -90))
                    .animation(.spring(response: 0.30, dampingFraction: 0.88), value: todayExpanded)
                Spacer(minLength: 8)
                Text("আজ \(almaBn(completedTodoCount))/\(almaBn(todayWork.count))")
                    .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                    .foregroundStyle(failedTodoCount > 0 ? AgentPalette.coral : AlmaRayBurst.colors[1])
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background((failedTodoCount > 0 ? AgentPalette.coral : AlmaRayBurst.colors[1]).opacity(0.10),
                                in: Capsule())
                    .contentTransition(.numericText())
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("আজকের \(todayWork.count)টি কাজের মধ্যে \(completedTodoCount)টি শেষ")
    }

    private func todayTodoRow(_ todo: AgentTodayWorkItem, pal: AgentPalette) -> some View {
        let status = todo.status
        let running = status == "running" || status == "in_progress"
        let done = status == "completed" || status == "done"
        let failed = status == "failed" || status == "missed"
        let skipped = status == "skipped"
        let tint = failed ? AgentPalette.coral : done ? AgentPalette.teal
            : running ? AlmaRayBurst.colors[1] : pal.muted
        let icon = failed ? "exclamationmark" : done ? "checkmark" : running ? "waveform.path.ecg"
            : skipped ? "minus" : "circle"
        let statusText = status == "missed" ? "Missed" : failed ? "Failed" : done ? "Done"
            : running ? "Running" : skipped ? "Skipped" : "Pending"

        return HStack(alignment: .center, spacing: 11) {
            ZStack {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(tint.opacity(0.10))
                    .frame(width: 34, height: 34)
                Image(systemName: icon)
                    .font(.system(size: 10.5, weight: .bold))
                    .foregroundStyle(tint)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(todo.title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(pal.ink)
                    .lineLimit(2)
                if let detail = todo.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: 11))
                        .foregroundStyle(failed ? AgentPalette.coral : pal.muted)
                        .lineLimit(2)
                } else if let time = todo.time, !time.isEmpty {
                    Text("আজ \(time)")
                        .font(.system(size: 10.5))
                        .foregroundStyle(pal.muted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            Text(statusText)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(tint)
                .contentTransition(.numericText())
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }

    private func todayRank(_ todo: AgentTodayWorkItem) -> Int {
        switch todo.status {
        case "running", "in_progress": return 0
        case "failed", "missed": return 1
        case "pending": return 2
        case "completed", "done": return 3
        default: return 4
        }
    }

    private func collapsibleHeader(_ title: String, count: Int,
                                   isExpanded: Binding<Bool>, pal: AgentPalette) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            withAnimation(.spring(response: 0.34, dampingFraction: 0.88)) {
                isExpanded.wrappedValue.toggle()
            }
        } label: {
            HStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(pal.mutedHi)
                Text(almaBn(count))
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(pal.muted)
                    .contentTransition(.numericText())
                Image(systemName: "chevron.down")
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(pal.muted)
                    .rotationEffect(.degrees(isExpanded.wrappedValue ? 0 : -90))
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func runningRow(_ item: AgentBackgroundRunningItem, pal: AgentPalette,
                            animateSheen: Bool) -> some View {
        let attention = item.phase == "needs-decision" || item.phase == "waiting-approval"
        let sleeping = isFutureWake(item.nextTickAt)
        let tint = attention ? AgentPalette.coral : sleeping ? AlmaRayBurst.colors[1] : AgentPalette.teal
        return HStack(alignment: .center, spacing: 12) {
            Image(systemName: attention ? "exclamationmark" : sleeping ? "moon.zzz.fill" : "waveform.path.ecg")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 34, height: 34)
                .background(tint.opacity(0.11), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 5) {
                Text(item.title)
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(pal.ink)
                    .lineLimit(2)
                TimelineView(.periodic(from: .now, by: 1)) { timeline in
                    HStack(spacing: 6) {
                        Text(sourceLabel(item.source))
                        Text(elapsedLabel(item, now: timeline.date))
                            .monospacedDigit()
                            .contentTransition(.numericText())
                        if sleeping { Text(wakeLabel(item.nextTickAt)) }
                    }
                    .font(.system(size: 11.5))
                    .foregroundStyle(pal.muted)
                    .lineLimit(1)
                }
                Text(item.detail ?? (attention ? "আপনার সিদ্ধান্ত দরকার" : stepProgress(item)))
                    .font(.system(size: 11.5))
                    .foregroundStyle(attention ? AgentPalette.coral : pal.mutedHi)
                    .lineLimit(2)
            }
            Spacer(minLength: 2)
            Button {
                UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
                confirm = Confirm(source: item.source, sourceId: item.sourceId,
                                  title: "এই background task বন্ধ করবেন?", button: "Stop task")
            } label: {
                Group {
                    if runningItemBusy(item) {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 10, weight: .bold))
                    }
                }
                .foregroundStyle(pal.ink)
                .frame(width: 32, height: 32)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(pal.borderSubtle, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .disabled(runningControlBusy)
            .accessibilityLabel("\(item.title) বন্ধ করুন")
        }
        .padding(13)
        .background(pal.card.opacity(0.68), in: RoundedRectangle(cornerRadius: 17, style: .continuous))
        .overlay {
            if animateSheen {
                // No scenePhase gate (owner-hit 2026-07-16: the running task's
                // sheen simply never showed) — this sheet is UIKit-hosted, where
                // scenePhase can sit .inactive while perfectly visible, and a
                // paused-born .animation schedule may never re-arm. Same class
                // of bug as the frozen starburst; Reduce Motion is the only
                // legitimate pause.
                TimelineView(.animation(
                    minimumInterval: 1.0 / 12.0,
                    paused: reduceMotion
                )) { timeline in
                    GeometryReader { proxy in
                        let duration = 2.4
                        let phase = timeline.date.timeIntervalSinceReferenceDate
                            .truncatingRemainder(dividingBy: duration) / duration
                        let width = max(76, proxy.size.width * 0.34)
                        LinearGradient(
                            colors: [.clear, tint.opacity(0.08), Color.white.opacity(0.12), .clear],
                            startPoint: .leading, endPoint: .trailing
                        )
                        .frame(width: width, height: proxy.size.height)
                        .offset(x: -width + (proxy.size.width + width) * phase)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous)
            .strokeBorder(tint.opacity(0.16), lineWidth: 1))
    }

    private func finishedRow(_ item: AgentPlanDriveHistoryView, pal: AgentPalette) -> some View {
        let failed = item.status == "failed"
        let stopped = item.status == "stopped"
        let tint = failed ? AgentPalette.coral : stopped ? pal.muted : AgentPalette.teal
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            selectedFinished = item
        } label: {
            HStack(spacing: 12) {
                Image(systemName: failed ? "exclamationmark" : stopped ? "stop.fill" : "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(tint)
                    .frame(width: 34, height: 34)
                    .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.goal)
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(pal.ink).lineLimit(2)
                    HStack(spacing: 7) {
                        Text(failed ? "Failed" : stopped ? "Stopped" : "Completed")
                        if let stamp = completionLabel(item.completedAt) { Text(stamp) }
                    }
                    .font(.system(size: 11.5)).foregroundStyle(failed ? AgentPalette.coral : pal.muted)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold)).foregroundStyle(pal.muted)
            }
            .padding(13)
            .background(pal.card.opacity(0.60), in: RoundedRectangle(cornerRadius: 17, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous)
                .strokeBorder(tint.opacity(0.12), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityHint("Task input এবং result খুলুন")
    }

    private func emptyLine(_ text: String, icon: String, pal: AgentPalette) -> some View {
        Label(text, systemImage: icon)
            .font(.system(size: 12.5)).foregroundStyle(pal.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(pal.card.opacity(0.42), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var runningControlBusy: Bool {
        vm.planDriveBusyPlanId != nil || vm.dailyTodoBusyId != nil
    }

    private func runningItemBusy(_ item: AgentBackgroundRunningItem) -> Bool {
        switch item.source {
        case .plan: return vm.planDriveBusyPlanId == item.sourceId
        case .todo: return vm.dailyTodoBusyId == item.sourceId
        case .turn: return false
        }
    }

    private func stop(_ item: Confirm) async {
        switch item.source {
        case .plan:
            await vm.planDriveAct(planId: item.sourceId, action: "abandon")
        case .todo:
            await vm.stopDailyAgentTodo(id: item.sourceId)
        case .turn:
            if item.sourceId.hasPrefix("stream-") {
                vm.stopStreaming()
            } else {
                await vm.stopBackgroundTurn(id: item.sourceId)
            }
        }
        await refreshData()
    }

    private func sourceLabel(_ source: AgentBackgroundRunningItem.Source) -> String {
        switch source {
        case .plan: return "Plan-Drive"
        case .todo: return "Office task"
        case .turn: return "Agent turn"
        }
    }

    private func stepProgress(_ item: AgentBackgroundRunningItem) -> String {
        guard let steps = item.steps, !steps.isEmpty else { return "কাজ চলছে" }
        let done = steps.filter { $0.status == "done" }.count
        return "\(almaBn(done))/\(almaBn(steps.count)) ধাপ"
    }

    private func elapsedLabel(_ item: AgentBackgroundRunningItem, now: Date) -> String {
        guard let start = parseISO(item.startedAt) else { return "00:00" }
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        let hours = seconds / 3_600
        let minutes = (seconds % 3_600) / 60
        let remainder = seconds % 60
        if hours > 0 {
            return String(format: "%02d:%02d:%02d", hours, minutes, remainder)
        }
        return String(format: "%02d:%02d", minutes, remainder)
    }

    private func latestOwnerInput() -> String {
        vm.messages.reversed().first {
            $0.role == .user && !$0.isHeartbeatWake && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }?.text ?? "Agent task"
    }

    private func activeTurnInput() -> String {
        guard let latest = vm.messages.reversed().first(where: { $0.role == .user }) else {
            return "Agent task"
        }
        return latest.isHeartbeatWake ? "[স্বয়ংক্রিয় হার্টবিট]" : latest.text
    }

    private func activeTurnDetail(_ message: AgentChatMessage) -> String {
        if let phase = message.phases.last?.headline, !phase.isEmpty { return phase }
        if !message.text.isEmpty { return "উত্তর প্রস্তুত করছে" }
        switch vm.liveMode {
        case "searching", "researching": return "তথ্য খুঁজছে ও যাচাই করছে"
        case "writing": return "উত্তর লিখছে"
        default: return "বিশ্লেষণ করছে"
        }
    }

    private func steps(from message: AgentChatMessage) -> [AgentPlanDriveStep]? {
        guard !message.tools.isEmpty else { return nil }
        return message.tools.map { tool in
            let status = tool.live ? "running" : tool.ok == false ? "failed" : tool.ok == true ? "done" : "pending"
            return .init(
                id: "chat-\(message.id)-\(tool.id)", action: tool.name, status: status,
                toolName: tool.name, detail: tool.resultFull ?? tool.preview
            )
        }
    }

    private func finishedHeartbeatWakes() -> [AgentPlanDriveHistoryView] {
        (vm.heartbeatFeed?.entries ?? []).compactMap { entry in
            guard entry.headWoke || entry.kind == "error" else { return nil }
            let failed = entry.kind == "error"
            let stopped = entry.kind == "stopped"
            let blocked = entry.kind == "blocked"
            return .init(
                planId: "heartbeat-\(entry.id)",
                goal: failed ? "ALMA self-wakeup ব্যর্থ"
                    : stopped ? "ALMA self-wakeup বন্ধ করা হয়েছে"
                    : "ALMA নিজে থেকে জেগেছিল",
                conversationId: entry.conversationId,
                status: failed ? "failed" : stopped ? "stopped" : "completed",
                input: heartbeatInput(entry),
                result: failed || stopped ? nil : entry.summary,
                error: failed || stopped ? entry.summary : nil,
                startedAt: entry.at, completedAt: entry.at,
                steps: blocked ? [.init(id: "heartbeat-blocked-\(entry.id)", action: "Owner approval চেয়েছে", status: "done", toolName: "heartbeat", detail: entry.summary)] : nil,
                costTaka: nil
            )
        }
    }

    private func heartbeatInput(_ entry: AgentHeartbeatEntry) -> String {
        guard let pulse = entry.pulse else {
            return "Autonomous heartbeat — owner message ছাড়াই ALMA business pulse যাচাই করেছে।"
        }
        let facts = [
            (pulse.pendingApprovals ?? 0) > 0 ? "pending approvals \(pulse.pendingApprovals ?? 0)" : nil,
            (pulse.ownerEscalations ?? 0) > 0 ? "owner escalations \(pulse.ownerEscalations ?? 0)" : nil,
            (pulse.openTodos ?? 0) > 0 ? "open todos \(pulse.openTodos ?? 0)" : nil,
            (pulse.csAlerts ?? 0) > 0 ? "CS alerts \(pulse.csAlerts ?? 0)" : nil,
            (pulse.moneyRequests ?? 0) > 0 ? "money requests \(pulse.moneyRequests ?? 0)" : nil,
            (pulse.agingApprovals ?? 0) > 0 ? "aging approvals \(pulse.agingApprovals ?? 0)" : nil,
        ].compactMap { $0 }
        let trigger = facts.isEmpty ? "কোনো actionable change ছিল না" : facts.joined(separator: " · ")
        return "Autonomous heartbeat trigger\n\(trigger)"
    }

    private func finishedOfficeDuties() -> [AgentPlanDriveHistoryView] {
        vm.officeDailyDuties.compactMap { duty in
            guard ["done", "failed", "missed", "skipped"].contains(duty.status) else { return nil }
            let failed = duty.status == "failed" || duty.status == "missed"
            let stopped = duty.status == "skipped"
            let status = failed ? "failed" : stopped ? "stopped" : "completed"
            let scheduled = duty.time.map { "Scheduled: \($0)" }
            return .init(
                planId: "office-duty-\(duty.dutyDate)-\(duty.duty)",
                goal: duty.label, conversationId: nil, status: status,
                input: [duty.label, scheduled].compactMap { $0 }.joined(separator: "\n"),
                result: status == "completed" ? (duty.detail ?? "Office duty completed হয়েছে।") : nil,
                error: failed ? (duty.detail ?? "Office duty সম্পন্ন হয়নি।")
                    : stopped ? (duty.detail ?? "Office duty skipped হয়েছে।") : nil,
                startedAt: duty.createdAt, completedAt: duty.ranAt ?? duty.createdAt,
                steps: nil, costTaka: nil
            )
        }
    }

    private func finishedTodos() -> [AgentPlanDriveHistoryView] {
        let officeDutyKeys = Set(vm.officeDailyDuties.map(\.duty))
        return vm.dailyAgentTodos.compactMap { todo in
            guard todo.status == "completed" || todo.status == "failed" || todo.status == "cancelled" else {
                return nil
            }
            if let dutyKey = todo.dutyKey, officeDutyKeys.contains(dutyKey) { return nil }
            let status = todo.status == "completed" ? "completed" : todo.status == "cancelled" ? "stopped" : "failed"
            let input = [todo.title, todo.description].compactMap { $0 }.joined(separator: "\n")
            return .init(
                planId: "todo-\(todo.id)", goal: todo.title, conversationId: nil,
                status: status, input: input,
                result: status == "completed" ? "Office daily task completed হয়েছে।" : nil,
                error: status == "failed" ? (todo.description ?? "কাজটি সম্পন্ন করা যায়নি।")
                    : status == "stopped" ? "Owner task-টি বন্ধ করেছেন।" : nil,
                startedAt: todo.createdAt, completedAt: todo.completedAt ?? todo.createdAt,
                steps: nil, costTaka: nil
            )
        }
    }

    private func taskTitle(_ raw: String) -> String {
        let cleaned = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasPrefix("[স্বয়ংক্রিয় হার্টবিট") {
            return "ALMA নিজে থেকে জেগে কাজ করছে"
        }
        let firstLine = cleaned.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? "Agent task"
        guard firstLine.count > 72 else { return firstLine }
        return String(firstLine.prefix(72)) + "…"
    }

    private func isoString(_ date: Date?) -> String? {
        guard let date else { return nil }
        return ISO8601DateFormatter().string(from: date)
    }

    private func completionLabel(_ raw: String?) -> String? {
        guard let date = parseISO(raw) else { return nil }
        if abs(date.timeIntervalSinceNow) < 5 { return "just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private func isFutureWake(_ raw: String?) -> Bool {
        guard let date = parseISO(raw) else { return false }
        return date.timeIntervalSinceNow > 20
    }

    private func wakeLabel(_ raw: String?) -> String {
        guard let date = parseISO(raw) else { return "পরের wake সময় ঠিক হচ্ছে" }
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(identifier: "Asia/Dhaka")
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "h:mm a"
        let time = formatter.string(from: date)
            .replacingOccurrences(of: "AM", with: "AM")
            .replacingOccurrences(of: "PM", with: "PM")
        let digits = time.reduce(into: "") { out, char in
            if let n = char.wholeNumberValue { out += almaBn(n) } else { out.append(char) }
        }
        return "পরের wake \(digits)"
    }

    private func parseISO(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: raw) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: raw)
    }
}

@available(iOS 17.0, *)
private struct AgentBackgroundTaskDetailSheet: View {
    let task: AgentPlanDriveHistoryView
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let pal = AgentPalette(scheme)
        NavigationStack {
            ZStack {
                AgentAuroraBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        statusLine(pal)
                        detailBlock(title: "Task input", text: task.input, tint: AlmaRayBurst.colors[1], pal: pal)
                        if let result = task.result, !result.isEmpty {
                            detailBlock(title: "Result", text: result, tint: AgentPalette.teal, pal: pal)
                        }
                        if let error = task.error, !error.isEmpty {
                            detailBlock(title: task.status == "stopped" ? "Stop reason" : "Error reason",
                                        text: error, tint: AgentPalette.coral, pal: pal)
                        }
                        if let steps = task.steps, !steps.isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("Steps")
                                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(pal.mutedHi)
                                ForEach(steps) { step in
                                    detailStepRow(step, pal: pal)
                                }
                            }
                            .padding(14)
                            .background(pal.card.opacity(0.58), in: RoundedRectangle(cornerRadius: 17, style: .continuous))
                        }
                    }
                    .padding(.horizontal, 17).padding(.top, 10).padding(.bottom, 30)
                }
            }
            .navigationTitle(task.goal)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").font(.system(size: 12, weight: .bold))
                            .foregroundStyle(pal.ink).frame(width: 32, height: 32)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .accessibilityLabel("বন্ধ করুন")
                }
            }
        }
    }

    private func statusLine(_ pal: AgentPalette) -> some View {
        let failed = task.status == "failed"
        let stopped = task.status == "stopped"
        let tint = failed ? AgentPalette.coral : stopped ? pal.muted : AgentPalette.teal
        return HStack(spacing: 8) {
            Circle().fill(tint).frame(width: 7, height: 7)
            Text(failed ? "Failed" : stopped ? "Stopped" : "Completed")
                .font(.system(size: 12, weight: .semibold)).foregroundStyle(tint)
            Spacer()
            if let cost = task.costTaka, cost > 0 {
                Text("৳\(Int(cost.rounded()))")
                    .font(.system(size: 11.5, weight: .medium)).foregroundStyle(pal.muted)
            }
        }
    }

    private func detailBlock(title: String, text: String, tint: Color, pal: AgentPalette) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(pal.mutedHi)
            Text(text)
                .font(.system(size: 12.5, design: .monospaced))
                .foregroundStyle(pal.ink).lineSpacing(4).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(13)
                .background(pal.card.opacity(0.64), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .strokeBorder(tint.opacity(0.18), lineWidth: 1))
        }
    }

    private func detailStepRow(_ step: AgentPlanDriveStep, pal: AgentPalette) -> some View {
        let failed = step.status == "failed"
        let done = step.status == "done"
        let icon = done ? "checkmark.circle.fill" : failed ? "exclamationmark.circle.fill" : "circle"
        let tint = done ? AgentPalette.teal : failed ? AgentPalette.coral : pal.muted
        return HStack(alignment: .top, spacing: 9) {
            Image(systemName: icon).font(.system(size: 11)).foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 3) {
                Text(step.action ?? "Task step")
                    .font(.system(size: 12.5, weight: .medium)).foregroundStyle(pal.ink)
                if let detail = step.detail, !detail.isEmpty {
                    Text(detail).font(.system(size: 11.5)).foregroundStyle(pal.muted)
                }
            }
        }
    }
}

// MARK: - Legacy Plan-Drive card (no longer rendered in chat)

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

/// Roadmap Phase 0 — debug-only row bounds. Launch with ALMA_DEBUG_ROWS=1 to draw
/// each message row's measured height/role/id/block-count and log a
/// `message.rowHeightChanged` signpost on every height change, so the giant-gap
/// row can be identified on-device. Inert in production (flag never set).
@available(iOS 17.0, *)
struct AgentRowDebugOverlay: ViewModifier {
    static let enabled = ProcessInfo.processInfo.environment["ALMA_DEBUG_ROWS"] == "1"
        || ProcessInfo.processInfo.arguments.contains("ALMA_DEBUG_ROWS=1")
    let message: AgentChatMessage
    @State private var height: CGFloat = 0

    func body(content: Content) -> some View {
        if Self.enabled {
            content
                .background(GeometryReader { g in
                    Color.clear
                        .onChange(of: g.size.height, initial: true) { _, h in
                            guard abs(h - height) > 0.5 else { return }
                            height = h
                            AlmaTurnLog.event("message.rowHeightChanged",
                                              "\(message.id.suffix(6)) \(message.role == .user ? "U" : "A") h=\(Int(h)) blocks=\(message.blocks.count) tl=\(message.timeline.count) chars=\(message.text.count) live=\(message.isStreaming)")
                        }
                })
                .overlay(alignment: .topTrailing) {
                    Text("\(message.id.suffix(5)) \(message.role == .user ? "U" : "A") h\(Int(height)) b\(message.blocks.count)\(message.isStreaming ? " ●" : "")")
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 3).padding(.vertical, 1)
                        .background(Color.red.opacity(0.65))
                        .allowsHitTesting(false)
                }
                .border(Color.red.opacity(0.35), width: 0.5)
        } else {
            content
        }
    }
}

@available(iOS 17.0, *)
struct AssistantScreen: View {
    @State private var vm = AssistantVM()
    @Namespace private var backgroundTaskNamespace
    @Environment(\.colorScheme) private var scheme
    @State private var nearBottom = true
    /// Own-send anchors the user's message to the viewport top; tail-follow
    /// handlers stand down until this instant so they don't yank to the bottom
    /// in the same update cycle.
    @State private var followSuppressedUntil = Date.distantPast
    @State private var scrollViewportH: CGFloat = 0
    @State private var toolSheet: AgentChatMessage.Tool?
    @State private var activitySheet: AgentActivitySheetRequest?
    /// 1.4: ONE cancelable debounce task owns bottom-scrolling (the old
    /// generation-counter fan-out left every superseded task alive on MainActor).
    @State private var scrollDebounceTask: Task<Void, Never>?
    @State private var showArtifacts = false
    /// DEBUG self-test hook (ALMA_ASSISTANT_VIEWERTEST=1) — presents the zoomable
    /// image viewer with its সংরক্ষণ button for a headless fixture screenshot.
    @State private var debugViewer: PortalImagePreview?
    @State private var showBackgroundTasks = false
    @State private var backgroundTaskDetent: PresentationDetent = .medium

    let openWeb: (_ path: String, _ title: String) -> Void
    /// Wired by makeAssistantTab so the native bar buttons drive this screen.
    let barHooks: AssistantBarHooks

    private static let bottomID = "ALMA_BOTTOM"

    /// During a new streaming turn the previous settled reply keeps ownership of
    /// the task anchor. On settle this id changes once, giving SwiftUI a single
    /// spring relocation instead of a disappear/reappear jump.
    private var backgroundTaskAnchorId: String? {
        if vm.isStreaming {
            return vm.messages.last(where: {
                $0.role == .assistant && !$0.isStreaming && !$0.text.isEmpty
            })?.id
        }
        return vm.messages.last(where: {
            $0.role == .assistant && !$0.isStreaming && !$0.text.isEmpty
        })?.id
    }

    private var hasBackgroundTaskSurface: Bool {
        // The anchor is a stable entry point after every settled reply. Its label
        // alone communicates whether execution is idle or has N active jobs.
        vm.messages.contains {
            $0.role == .assistant && !$0.isStreaming
                && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

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
        // Compute tail ownership once per screen pass. Doing the same reverse
        // scans inside every ForEach row turned each stream update into O(n²).
        let streamingTailId = vm.messages.last(where: { $0.isStreaming })?.id
        let lastAssistantId = vm.messages.last(where: { $0.role == .assistant })?.id
        let taskAnchorId = backgroundTaskAnchorId
        let showsTaskSurface = hasBackgroundTaskSurface
        ZStack {
            AgentAuroraBackground()
            ScrollViewReader { proxy in
                ScrollView {
                    // The visible history is already server-windowed (24 rows).
                    // Keep that bounded window mounted so a tail jump uses measured
                    // heights. LazyVStack evicted large rich rows mid-jump, briefly
                    // blanking the viewport before correcting to an older offset.
                    VStack(alignment: .leading, spacing: 0) {
                        if vm.loadingHistory && vm.messages.isEmpty {
                            AlmaPageLoader()
                        }
                        // 4.1 — history above the loaded window, on demand. Anchor
                        // is preserved: the previous top row is scrolled back to
                        // top after the non-animated prepend.
                        if vm.canLoadOlder && !vm.messages.isEmpty {
                            Button {
                                UISelectionFeedbackGenerator().selectionChanged()
                                let anchorId = vm.messages.first?.id
                                Task {
                                    await vm.loadOlderMessages()
                                    if let anchorId {
                                        var tx = Transaction(); tx.disablesAnimations = true
                                        withTransaction(tx) { proxy.scrollTo(anchorId, anchor: .top) }
                                    }
                                }
                            } label: {
                                HStack(spacing: 6) {
                                    if vm.loadingOlder {
                                        ProgressView().controlSize(.mini)
                                    } else {
                                        Image(systemName: "arrow.up.circle").font(.system(size: 12))
                                    }
                                    Text(vm.loadingOlder ? "আনা হচ্ছে…" : "আরও পুরনো মেসেজ")
                                        .font(.system(size: 12.5, weight: .medium))
                                }
                                .foregroundStyle(pal.muted)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                            }
                            .buttonStyle(.plain)
                            .padding(.bottom, 6)
                        }
                        if !vm.loadingHistory && vm.messages.isEmpty && !vm.isStreaming {
                            AgentEmptyStateView(pal: pal) { vm.send($0) }
                        }
                        ForEach(vm.messages) { msg in
                            AgentMessageRow(
                                message: msg, vm: vm,
                                showWorkingIndicator: vm.isStreaming && msg.isStreaming
                                    && msg.id == streamingTailId,
                                isLastAssistant: msg.role == .assistant
                                    && msg.id == lastAssistantId,
                                showsBackgroundTaskAnchor: showsTaskSurface
                                    && msg.id == taskAnchorId,
                                backgroundTaskHandoff: vm.isStreaming,
                                backgroundTaskNamespace: backgroundTaskNamespace,
                                onBackgroundTasks: {
                                    backgroundTaskDetent = .medium
                                    showBackgroundTasks = true
                                },
                                onToolTap: { tool in toolSheet = tool },
                                onActivitySheet: { activitySheet = $0 })
                            .modifier(AgentRowDebugOverlay(message: msg))
                        }
                        // A brand-new chat intentionally has no reply footer.
                        // ALMA identity + Background Tasks belong to a settled
                        // assistant reply, never to the empty welcome state.
                        Color.clear.frame(height: 4).id(Self.bottomID)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
                    .background(scrollOffsetReader)
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
                // iOS 17 ONLY — on 18+ onScrollGeometryChange owns nearBottom and
                // this per-layout-pass preference channel fed the AttributeGraph
                // update cycle that froze the app (2026-07-15 hang samples).
                .background {
                    if #unavailable(iOS 18.0) {
                        GeometryReader { g in
                            Color.clear.preference(key: AgentScrollViewportKey.self, value: g.size.height)
                        }
                    }
                }
                .onPreferenceChange(AgentScrollViewportKey.self) { h in
                    if h > 0, abs(h - scrollViewportH) > 0.5 { scrollViewportH = h }
                }
                .onPreferenceChange(AgentScrollBottomKey.self) { contentMaxY in
                    // iOS 17 ONLY — on 18+ the modifier below owns nearBottom; this
                    // preference fires on layout (not scroll) and would fight it.
                    if #unavailable(iOS 18.0) {
                        let viewport = scrollViewportH > 0 ? scrollViewportH : UIScreen.main.bounds.height
                        let distance = contentMaxY - viewport
                        let next = distance < 120
                        if next != nearBottom { nearBottom = next }
                    }
                }
                // iOS 18+: the GeometryReader-preference trick above stops firing
                // DURING user scrolls under the new scroll system (sim-verified on
                // iOS 26: two screens up, no preference update → arrow never showed).
                // onScrollGeometryChange is the supported live signal; the preference
                // path stays as the iOS 17 fallback.
                .modifier(AgentNearBottomScrollModifier(nearBottom: $nearBottom))
                // Follow the GROWING tail — streamGrowthTick bumps on every
                // applied batch (thinking/tools/screenshots/cards, not just
                // prose), which is what actually grows an agentic turn
                // (owner-hit 2026-07-16: `last?.text` alone never fired during
                // tool-heavy work, so the reply ran below the fold unfollowed).
                .onChange(of: vm.streamGrowthTick) { _, _ in
                    guard nearBottom, Date() >= followSuppressedUntil else { return }
                    scheduleScrollToBottom(proxy: proxy)
                }
                .onChange(of: vm.messages.last?.text) { _, _ in
                    guard nearBottom, Date() >= followSuppressedUntil else { return }
                    scheduleScrollToBottom(proxy: proxy)
                }
                .onChange(of: vm.messages.count) { _, _ in
                    // 1.4: server merges/polls must never yank the owner away from
                    // older content he is reading — only follow when near bottom.
                    guard nearBottom, Date() >= followSuppressedUntil else { return }
                    if vm.isStreaming {
                        scheduleScrollToBottom(proxy: proxy)
                    } else {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(Self.bottomID, anchor: .bottom)
                        }
                    }
                }
                // The owner's OWN send anchors HIS message to the TOP of the
                // viewport (Claude-app feel, owner spec 2026-07-16): the reply
                // then flows beneath it, older context stays one scroll-up away.
                // A short suppress window keeps the tail-follow handlers from
                // yanking to the bottom in the same breath; after it, the
                // growth-follow keeps the advancing edge on screen.
                .onChange(of: vm.ownSendTick) { _, _ in
                    followSuppressedUntil = Date().addingTimeInterval(0.8)
                    nearBottom = true   // sending = explicit intent to follow this turn
                    if let mine = vm.messages.last(where: { $0.role == .user })?.id {
                        withAnimation(.easeOut(duration: 0.3)) {
                            proxy.scrollTo(mine, anchor: .top)
                        }
                    } else {
                        scrollToBottom(proxy: proxy)
                    }
                }
                .overlay(alignment: .bottom) {
                    // Web parity: centered 40pt frosted circle just above the composer.
                    if !nearBottom {
                        Button {
                            UISelectionFeedbackGenerator().selectionChanged()
                            scrollToBottom(proxy: proxy)
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
                // Phase 1.4 self-test — ALMA_ASSISTANT_SCROLLTEST=1 (debug launches
                // only): 100 top↔bottom round-trips during and after the fixture
                // stream; lazy rows mount/unmount at both ends while heights are
                // logged, reproducing the gap conditions deterministically.
                .task {
                    let p = ProcessInfo.processInfo
                    guard p.environment["ALMA_ASSISTANT_SCROLLTEST"] == "1"
                        || p.arguments.contains("ALMA_ASSISTANT_SCROLLTEST=1") else { return }
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    for round in 0..<100 {
                        if let top = vm.messages.first?.id {
                            withAnimation(.linear(duration: 0.05)) { proxy.scrollTo(top, anchor: .top) }
                        }
                        // First round intentionally exposes the real Down button
                        // long enough for the live simulator regression test.
                        try? await Task.sleep(for: .milliseconds(round == 0 ? 2_500 : 150))
                        scrollToBottom(proxy: proxy) // exact production button path
                        try? await Task.sleep(for: .milliseconds(320))
                        if (round + 1) % 25 == 0 { AlmaTurnLog.event("scroll.stressRound", "\(round + 1)/100") }
                    }
                    AlmaTurnLog.event("scroll.stressDone")
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
            // Roadmap Phase 0 — local scroll/streaming stress fixture; skips the
            // server entirely (no bootstrap) so layout is tested in isolation.
            if argFlag("ALMA_ASSISTANT_FIXTURE") {
                vm.loadDebugFixture()
                return
            }
            // Parity roadmap — persisted verification-retry composition only.
            if argFlag("ALMA_ASSISTANT_PARITY") {
                vm.loadParityFixture()
                return
            }
            // Chat-parity batch — full-screen image viewer incl. the ⬇ save button.
            if argFlag("ALMA_ASSISTANT_VIEWERTEST") {
                vm.loadParityFixture()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                debugViewer = PortalImagePreview(urls: ["https://picsum.photos/seed/alma/900/560"], index: 0)
                return
            }
            if argFlag("ALMA_BACKGROUND_TASK_FIXTURE") {
                vm.loadBackgroundTaskDebugFixture()
                if argFlag("ALMA_BACKGROUND_TASK_MOTION") {
                    vm.runBackgroundTaskMotionDebug()
                }
                if argFlag("ALMA_BACKGROUND_TASK_SHEET") {
                    Task {
                        try? await Task.sleep(nanoseconds: 650_000_000)
                        showBackgroundTasks = true
                    }
                }
                return
            }
            // Roadmap Phase 2 — canned SSE wire through the real parser/reducer.
            if argFlag("ALMA_ASSISTANT_EVENTTEST") {
                vm.runDebugEventTest()
                return
            }
            // Roadmap Phase 4.4 — protocol-layer unit assertions, on-screen.
            if argFlag("ALMA_ASSISTANT_UNITTEST") {
                vm.runDebugUnitTests()
                return
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
        .fullScreenCover(item: $debugViewer) { PortalImageViewer(preview: $0, showsSave: true) }
        .sheet(item: $toolSheet) { tool in
            AgentToolIOSheet(tool: tool)
        }
        .sheet(item: $activitySheet) { req in
            AgentThoughtProcessSheet(request: req)
        }
        .sheet(isPresented: $showArtifacts) {
            AgentArtifactsSheet(vm: vm, openWeb: openWeb)
        }
        .sheet(isPresented: $showBackgroundTasks) {
            AgentBackgroundTasksSheet(vm: vm, selectedDetent: $backgroundTaskDetent)
                .presentationDetents([.medium, .large], selection: $backgroundTaskDetent)
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(28)
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

    /// One owner, one measured destination. The bounded VStack above keeps the
    /// complete visible window mounted, so no correction pass can pull the owner
    /// back after the bottom button lands.
    private func scrollToBottom(proxy: ScrollViewProxy) {
        scrollDebounceTask?.cancel()
        nearBottom = true
        withAnimation(.easeOut(duration: 0.24)) {
            proxy.scrollTo(Self.bottomID, anchor: .bottom)
        }
    }

    private func scheduleScrollToBottom(proxy: ScrollViewProxy) {
        scrollDebounceTask?.cancel()
        scrollDebounceTask = Task { @MainActor in
            // Coalesce rapid SSE text_delta bursts — avoids SwiftUI
            // "onChange tried to update multiple times per frame" freeze.
            // Up to 20 scroll corrections per second matches the buffered text cadence
            // and avoids forcing a second layout pass for every SSE fragment.
            try? await Task.sleep(for: .milliseconds(50))
            guard !Task.isCancelled else { return }
            proxy.scrollTo(Self.bottomID, anchor: .bottom)
        }
    }

    @ViewBuilder private var scrollOffsetReader: some View {
        // iOS 17 ONLY — the 18+ path never reads AgentScrollBottomKey, but the
        // GeometryReader still re-emitted it on every layout pass of the giant
        // lazy thread, participating in the 2026-07-15 freeze cycle. Don't even
        // attach it where it has no consumer.
        if #unavailable(iOS 18.0) {
            GeometryReader { g in
                // Raw content maxY in the scroll view's own space; the reader above
                // subtracts the MEASURED viewport height (never UIScreen).
                Color.clear.preference(
                    key: AgentScrollBottomKey.self,
                    value: g.frame(in: .named("agentscroll")).maxY)
            }
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
            // Insets deliberately EXCLUDED: the composer's safe-area inset (~140pt
            // with the model row) does not extend the reachable contentOffset, so
            // including it left distance ≈ insetB even at rest at the true bottom —
            // the arrow lingered forever (owner report, build-70 round 2).
            content.onScrollGeometryChange(for: Bool.self) { g in
                g.contentSize.height - (g.contentOffset.y + g.containerSize.height) < 120
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
