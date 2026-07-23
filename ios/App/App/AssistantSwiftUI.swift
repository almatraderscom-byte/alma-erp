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
import UniformTypeIdentifiers
import VisionKit
import QuickLook
import ObjectiveC
import os.signpost
import CoreText

// MARK: - Parity v2 subsystem rollout controls

enum AgentParitySubsystem: String, CaseIterable {
    case library = "library"
    case conversationMenu = "conversation-menu"
    case hugeSession = "huge-session"
}

enum AgentParityFlags {
    private static let prefix = "alma.assistant.parity-v2."

    /// Defaults ON inside the feature branch. Internal/dogfood builds can stage
    /// each presentation subsystem independently through launch environment or
    /// UserDefaults, while the existing `AlmaSwiftUIFlag` remains the immediate
    /// whole-screen rollback. Reliability state schemas are deliberately not
    /// switchable off after data has been written.
    static func isEnabled(_ subsystem: AgentParitySubsystem) -> Bool {
        let key = prefix + subsystem.rawValue
        let envKey = "ALMA_PARITY_V2_" + subsystem.rawValue
            .replacingOccurrences(of: "-", with: "_").uppercased()
        if let raw = ProcessInfo.processInfo.environment[envKey], !raw.isEmpty {
            return raw != "0" && raw.lowercased() != "false"
        }
        return UserDefaults.standard.object(forKey: key) as? Bool ?? true
    }

    static func set(_ enabled: Bool, for subsystem: AgentParitySubsystem) {
        UserDefaults.standard.set(enabled, forKey: prefix + subsystem.rawValue)
    }
}

// MARK: - Palette (web token parity: globals.css / agent-ambient.css)

@available(iOS 17.0, *)
struct AgentPalette {
    let dark: Bool
    init(_ scheme: ColorScheme) { dark = scheme == .dark }

    static var coral: Color { AlmaSwiftTheme.coral }
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

// MARK: - Shared ALMA Agent interaction foundation

/// Behaviour-only press grammar. Labels keep their existing shape, color and
/// layout; the style adds the same immediate depth response everywhere.
@available(iOS 17.0, *)
struct AlmaAgentPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.86 : 1)
            .brightness(configuration.isPressed ? 0.035 : 0)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.975 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.11), value: configuration.isPressed)
            .contentShape(Rectangle())
    }
}

@available(iOS 17.0, *)
private struct AlmaAgentMinimumHitTarget: ViewModifier {
    func body(content: Content) -> some View {
        content.frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
    }
}

@available(iOS 17.0, *)
extension View {
    func almaAgentHitTarget() -> some View { modifier(AlmaAgentMinimumHitTarget()) }
}

/// One semantic haptic policy for Agent interactions. The wrapper keeps direct
/// UIKit generator choices out of action code and can evolve without restyling UI.
@MainActor
enum AlmaAgentHaptics {
    static func selection() { UISelectionFeedbackGenerator().selectionChanged() }
    static func light() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func commit() { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
    static func rigid() { UIImpactFeedbackGenerator(style: .rigid).impactOccurred() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
}

/// Material fallback used by newly-added Agent surfaces and adopted incrementally
/// by existing cards. Reduce Transparency gets a solid ALMA card, never clear text.
@available(iOS 17.0, *)
struct AlmaAgentGlassBackground<S: Shape>: ViewModifier {
    let shape: S
    let pal: AgentPalette
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        content.background {
            if reduceTransparency {
                shape.fill(pal.card)
            } else {
                shape.fill(.ultraThinMaterial)
            }
        }
    }
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
    var pinned: Bool?
    var updatedAt: String?
}

struct ActiveConversationPointer: Decodable {
    let conversationId: String?
    let projectId: String?
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
    let clientMessageId: String?
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
    let version: Int?
    let messageId: String?
    let blocks: [AgentPresentationBlockWire]?
    let usage: AgentPresentationUsageWire?
    let selfCorrected: Bool?
}

struct AgentPresentationBlockWire: Decodable {
    let id: String
    let type: String
    let text: String?
    let state: String?
    let activityType: String?
    let label: String?
    let detail: String?
    let status: String?
    let toolName: String?
    let result: String?
    let screenshot: String?
    let artifactId: String?
    let title: String?
    let kind: String?
    let pendingActionId: String?
    let askCardId: String?
}

struct AgentPresentationUsageWire: Decodable {
    let tokensIn: Int?
    let tokensOut: Int?
    let cacheCreation: Int?
    let cacheRead: Int?
    let costUsd: Double?
    let apiRounds: Int?
    let roundCostsUsd: [Double]?
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

enum AgentConversationExportFormat {
    case share, plainText, markdown, pdf
}

private enum AgentConversationExportError: Error { case pageLimitExceeded }

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

struct AgentFileRef: Codable, Hashable {
    let bucket: String
    let path: String
    let mediaType: String
}

struct AgentSessionFile: Identifiable, Equatable {
    enum Origin: String { case uploaded, generated }
    let id: String
    let origin: Origin
    let name: String
    let mediaType: String
    let createdAt: String?
    let messageId: String?
    let fileRef: AgentFileRef?
    let artifactId: String?
    let artifactContent: String?

    var typeLabel: String {
        if mediaType == "application/pdf" { return "PDF" }
        if mediaType == "text/markdown" { return "Markdown" }
        if mediaType.hasPrefix("image/") { return "Image" }
        return URL(fileURLWithPath: name).pathExtension.uppercased().nilIfEmpty ?? "File"
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

struct OkResponse: Decodable { let ok: Bool?; let success: Bool?; let message: String? }
struct SignedURLResponse: Decodable { let url: String? }
struct TranscribeResponse: Decodable { let text: String? }
/// One SSE event — all fields optional, switch on `type`.
// MARK: - UI models

@available(iOS 17.0, *)
struct AgentChatMessage: Identifiable, Equatable {
    enum Role { case user, assistant }
    enum OutgoingState: String, Codable, Equatable {
        case waitingForAttachments
        case queued
        case submitting
        case checking
        case accepted
        case failed
        case cancelled
    }
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
        /// Raw prose emitted during a model round. `superseded` means verification
        /// rejected it; raw entries remain auditable but only the settled answer
        /// becomes an owner-facing prose block.
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
    /// Gate 1: a locally-authored owner intent remains inspectable until the
    /// server assigns durable identity. Settled server rows leave these nil.
    var clientMessageId: String?
    var outgoingState: OutgoingState?
    var text: String = ""
    var imagePaths: [String] = []
    var fileRefs: [AgentFileRef] = []
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
    /// Legacy projection metadata. New projections never expose superseded prose
    /// as a visible block; selfCorrected carries the owner-facing signal instead.
    var supersededBlockIds: Set<String> = []

    /// The heartbeat's self-wake seed renders as a divider, never as an owner bubble
    /// (web: isHeartbeatWakeText / HEARTBEAT_WAKE_SENTINEL).
    var isHeartbeatWake: Bool {
        role == .user && text.trimmingCharacters(in: .whitespaces).hasPrefix("[স্বয়ংক্রিয় হার্টবিট")
    }

    static func from(_ wire: AgentMessageWire) -> AgentChatMessage {
        var m = AgentChatMessage(id: wire.id, role: wire.role == "user" ? .user : .assistant)
        m.serverId = wire.id
        m.clientMessageId = wire.clientMessageId
        if wire.role == "user", wire.clientMessageId != nil { m.outgoingState = .accepted }
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
                if let bucket = block.bucket, let path = block.path {
                    let ref = AgentFileRef(bucket: bucket, path: path,
                                           mediaType: block.mediaType ?? "application/octet-stream")
                    m.fileRefs.append(ref)
                    if ref.mediaType.hasPrefix("image") { m.imagePaths.append(path) }
                }
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
        // Prefer the server's canonical, versioned projection whenever present.
        // Its stable block ids make cold-load, poll and reconnect byte-for-byte
        // equivalent; legacy timeline/content remain the forward-compatible fallback.
        if let presentation = wire.presentation,
           presentation.version == 1,
           presentation.messageId == nil || presentation.messageId == wire.id,
           presentation.blocks?.isEmpty == false {
            Self.applyCanonicalPresentation(presentation, to: &m)
        }
        return m
    }

    static func applyCanonicalPresentation(_ presentation: AgentMessagePresentationWire,
                                           to message: inout AgentChatMessage) {
        var projected: [TurnBlock] = []
        var projectedTools: [Tool] = []
        var sawSupersededDraft = false
        for block in presentation.blocks ?? [] {
            switch block.type {
            case "prose":
                // Defense in depth for older/cached server projections: progress
                // and superseded drafts are audit data, never separate replies.
                if block.state == "superseded" { sawSupersededDraft = true }
                guard block.state == nil || block.state == "final" else { continue }
                projected.append(.prose(id: block.id, text: block.text ?? ""))
            case "activity":
                let isTool = block.activityType == "tool"
                let toolId = isTool ? block.id : nil
                let ok = block.status == "failed" ? false : true
                projected.append(.activity(.init(
                    id: block.id,
                    kind: isTool ? .tool : .thinking,
                    label: block.label ?? (isTool ? "টুল" : "যাচাই"),
                    thinkFull: block.detail ?? "",
                    toolId: toolId,
                    ok: ok,
                    live: false,
                    screenshot: block.screenshot)))
                if isTool {
                    projectedTools.append(.init(
                        id: block.id, name: block.toolName ?? block.label ?? "টুল", ok: ok,
                        preview: block.result.map { String($0.prefix(160)) }, live: false,
                        inputPretty: nil, resultFull: block.result, screenshot: block.screenshot))
                }
            case "file":
                if let artifactId = block.artifactId {
                    projected.append(.file(
                        id: block.id, artifactId: artifactId,
                        name: block.title ?? "ডকুমেন্ট"))
                }
            case "confirm_card":
                if let id = block.pendingActionId {
                    projected.append(.confirmCard(id: block.id, pendingActionId: id))
                }
            case "ask_card":
                if let id = block.askCardId {
                    projected.append(.askCard(id: block.id, askCardId: id))
                }
            default:
                continue
            }
        }
        message.blocks = projected
        message.supersededBlockIds = []
        if !projectedTools.isEmpty { message.tools = projectedTools }
        message.selfCorrected = presentation.selfCorrected == true || sawSupersededDraft
        if let usage = presentation.usage {
            message.tokensIn = usage.tokensIn ?? message.tokensIn
            message.tokensOut = usage.tokensOut ?? message.tokensOut
            message.cacheCreation = usage.cacheCreation ?? message.cacheCreation
            message.cacheRead = usage.cacheRead ?? message.cacheRead
            message.apiRounds = usage.apiRounds ?? message.apiRounds
            message.roundCostsUsd = usage.roundCostsUsd ?? message.roundCostsUsd
            if let cost = usage.costUsd { message.costUsd = String(format: "%.4f", cost) }
        }
    }

    /// Rebuild the interleaved prose ↔ activity TurnBlocks from the persisted
    /// timeline + cards, using the SAME builders the live SSE reducer uses — so
    /// settled/cold-loaded rows converge on the live composition by construction.
    static func applyPersistedBlocks(to m: inout AgentChatMessage) {
        var blocks: [TurnBlock] = []
        var lastSettledTimelineText = ""
        for e in m.timeline {
            switch e {
            case .text(let t, let isSuperseded):
                // Timeline prose remains audit data. Only the final verified
                // segment becomes owner-visible after all activity rows.
                if !isSuperseded && !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    lastSettledTimelineText = t.trimmingCharacters(in: .whitespacesAndNewlines)
                }
            case .think(let t):
                blocks = appendThinkBlock(blocks, chunk: t, messageId: m.id)
            case .tool(let id, let name, let ok, _, _, _, let shot):
                blocks = appendToolBlock(blocks, toolId: id, name: name, messageId: m.id)
                blocks = finalizeToolBlock(blocks, toolId: id, ok: ok ?? true, screenshot: shot)
            case .file(let aid, let name):
                blocks.append(.file(id: "fb-\(m.id)-\(aid)", artifactId: aid, name: name))
            }
        }
        let stored = m.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let settledText: String
        if lastSettledTimelineText.isEmpty {
            settledText = stored
        } else if stored.isEmpty || stored.hasSuffix(lastSettledTimelineText) {
            settledText = lastSettledTimelineText
        } else {
            // Preserve deadline/continuation suffixes that exist only in stored
            // content and therefore cannot be recovered from the raw timeline.
            settledText = stored
        }
        if !settledText.isEmpty {
            blocks.append(.prose(id: "bp-\(m.id)-final", text: settledText))
        }
        for card in m.confirmCards {
            blocks.append(.confirmCard(id: "bc-\(m.id)-\(card.id)", pendingActionId: card.id))
        }
        for card in m.askCards {
            blocks.append(.askCard(id: "bq-\(m.id)-\(card.id)", askCardId: card.id))
        }
        m.blocks = blocks
        m.supersededBlockIds = []
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
    enum ActionLifecycleState: String, Codable {
        case pending, submitting, checking, accepted, executing
        case approved, rejected, answered, expired, cancelled, failed

        var isTerminal: Bool {
            switch self {
            case .approved, .rejected, .answered, .expired, .cancelled: return true
            default: return false
            }
        }
    }

    struct ActionRegistryRecord: Codable {
        var kind: String
        var state: ActionLifecycleState
        var selectedOption: String?
        var updatedAt: Date
    }

    private struct ActionRegistrySnapshot: Codable {
        var records: [String: ActionRegistryRecord] = [:]
        var askDraftText: [String: String] = [:]
        var askChosenOption: [String: String] = [:]
        var askOtherActiveIds: Set<String> = []
        var opinionDraftText: [String: String] = [:]
        var opinionOpenIds: Set<String> = []
    }

    /// The server action decision and the owner-authored chat continuation are
    /// two network operations. Bind the second one to a persisted idempotency key
    /// so a 409, lost response, double tap, or relaunch can only create one turn.
    private struct ActionContinuation: Codable {
        let clientMessageId: String
        var text: String
        var askCardId: String?
        var dispatchedAt: Date? = nil
        var acceptedAt: Date? = nil
    }

    private static let actionRegistryKey = "alma.assistant.actionRegistry.v2"
    private static let actionContinuationsKey = "alma.assistant.actionContinuations.v1"
    private static func loadActionRegistry() -> ActionRegistrySnapshot {
        guard let data = UserDefaults.standard.data(forKey: actionRegistryKey),
              var value = try? JSONDecoder().decode(ActionRegistrySnapshot.self, from: data)
        else { return .init() }
        // A process can die after the tap but before its response. Relaunch must
        // show truthful reconciliation, never resurrect an indefinite spinner.
        for id in value.records.keys where value.records[id]?.state == .submitting {
            value.records[id]?.state = .checking
        }
        return value
    }
    private static func loadActionContinuations() -> [String: ActionContinuation] {
        guard let data = UserDefaults.standard.data(forKey: actionContinuationsKey) else { return [:] }
        return (try? JSONDecoder().decode([String: ActionContinuation].self, from: data)) ?? [:]
    }

    // Thread state
    var conversationId: String?
    var conversationTitle: String = "ALMA AI"
    var currentProjectId: String?
    var messages: [AgentChatMessage] = []
    var loadingHistory = false
    /// Gate 1 source of truth. The composer no longer owns an ephemeral @State
    /// string that disappears on navigation/process death.
    var composerDraft = "" {
        didSet { persistCurrentComposerDraft() }
    }
    private var restoringComposerDraft = false
    /// VM-level duplicate-submit guard. UI disabled states are secondary; this is
    /// the canonical protection shared by chat cards, sheets and voice actions.
    private var submittingActionKeys: Set<String> = []
    private var actionRegistry: [String: ActionRegistryRecord] = AssistantVM.loadActionRegistry().records
    private var actionContinuations = AssistantVM.loadActionContinuations()
    private var resumedActionContinuationKeys: Set<String> = []
    func isSubmittingAction(_ key: String) -> Bool { submittingActionKeys.contains(key) }
    @discardableResult private func beginSubmitting(_ key: String) -> Bool {
        guard submittingActionKeys.insert(key).inserted else { return false }
        if let descriptor = actionDescriptor(for: key) {
            setActionState(descriptor.id, kind: descriptor.kind, state: .submitting)
        }
        return true
    }
    private func finishSubmitting(_ key: String) {
        submittingActionKeys.remove(key)
        guard let descriptor = actionDescriptor(for: key),
              actionRegistry[descriptor.id]?.state == .submitting else { return }
        setActionState(descriptor.id, kind: descriptor.kind, state: .pending)
    }
    /// Ask-card input belongs to the conversation state, not the transient card
    /// view. A reconciliation refresh may rebuild the row after a failed POST;
    /// retaining these values keeps the owner's answer visible and retryable.
    var askDraftText: [String: String] = AssistantVM.loadActionRegistry().askDraftText {
        didSet { persistActionRegistry() }
    }
    var askChosenOption: [String: String] = AssistantVM.loadActionRegistry().askChosenOption {
        didSet { persistActionRegistry() }
    }
    var askOtherActiveIds: Set<String> = AssistantVM.loadActionRegistry().askOtherActiveIds {
        didSet { persistActionRegistry() }
    }
    var opinionDraftText: [String: String] = AssistantVM.loadActionRegistry().opinionDraftText {
        didSet { persistActionRegistry() }
    }
    var opinionOpenIds: Set<String> = AssistantVM.loadActionRegistry().opinionOpenIds {
        didSet { persistActionRegistry() }
    }

    func actionState(_ id: String) -> ActionLifecycleState? { actionRegistry[id]?.state }

    private func actionDescriptor(for key: String) -> (id: String, kind: String)? {
        if key.hasPrefix("action:") { return (String(key.dropFirst(7)), "approval") }
        if key.hasPrefix("ask:") { return (String(key.dropFirst(4)), "ask") }
        return nil
    }

    private func persistActionRegistry() {
        let snapshot = ActionRegistrySnapshot(
            records: actionRegistry, askDraftText: askDraftText,
            askChosenOption: askChosenOption, askOtherActiveIds: askOtherActiveIds,
            opinionDraftText: opinionDraftText, opinionOpenIds: opinionOpenIds)
        if let data = try? JSONEncoder().encode(snapshot) {
            UserDefaults.standard.set(data, forKey: Self.actionRegistryKey)
        }
    }

    private func persistActionContinuations() {
        guard let data = try? JSONEncoder().encode(actionContinuations) else { return }
        UserDefaults.standard.set(data, forKey: Self.actionContinuationsKey)
    }

    /// Cancel/edit is an explicit owner decision. Remove any durable action
    /// continuation bound to that outgoing intent so reconciliation cannot
    /// resurrect and auto-send it after a reload.
    private func discardActionContinuation(clientMessageId: String) {
        let keys = actionContinuations.compactMap { key, value in
            value.clientMessageId == clientMessageId ? key : nil
        }
        guard !keys.isEmpty else { return }
        for key in keys {
            actionContinuations.removeValue(forKey: key)
            resumedActionContinuationKeys.insert(key)
        }
        persistActionContinuations()
    }

    private func setActionState(_ id: String, kind: String,
                                state: ActionLifecycleState, selectedOption: String? = nil) {
        var record = actionRegistry[id]
            ?? .init(kind: kind, state: .pending, selectedOption: nil, updatedAt: Date())
        record.kind = kind
        record.state = state
        if let selectedOption { record.selectedOption = selectedOption }
        record.updatedAt = Date()
        actionRegistry[id] = record
        persistActionRegistry()
    }
    private func clearAskDraft(_ cardId: String) {
        askDraftText.removeValue(forKey: cardId)
        askChosenOption.removeValue(forKey: cardId)
        askOtherActiveIds.remove(cardId)
    }
    private func clearOpinionDraft(_ cardId: String) {
        opinionDraftText.removeValue(forKey: cardId)
        opinionOpenIds.remove(cardId)
    }

    @discardableResult
    private func resolvedActionContinuation(key: String, text: String,
                                            askCardId: String?) -> ActionContinuation {
        let continuation: ActionContinuation
        if var existing = actionContinuations[key] {
            if existing.dispatchedAt == nil, existing.acceptedAt == nil,
               existing.text != text || existing.askCardId != askCardId {
                existing.text = text
                existing.askCardId = askCardId
                actionContinuations[key] = existing
                persistActionContinuations()
            }
            continuation = existing
        } else {
            continuation = .init(
                clientMessageId: UUID().uuidString, text: text, askCardId: askCardId)
            actionContinuations[key] = continuation
            persistActionContinuations()       // durable before any local/network dispatch
        }
        return continuation
    }

    @discardableResult
    private func dispatchActionContinuation(key: String, text: String,
                                            askCardId: String?) -> Bool {
        var continuation = resolvedActionContinuation(
            key: key, text: text, askCardId: askCardId)
        if continuation.acceptedAt != nil { return true }
        if continuation.dispatchedAt == nil {
            // Reconciliation may reveal the server's already-accepted ask option.
            // Freeze that authoritative text before the idempotent chat dispatch.
            continuation.text = text
            continuation.askCardId = askCardId
            continuation.dispatchedAt = Date()
            actionContinuations[key] = continuation
            persistActionContinuations()
        }

        let clientMessageId = continuation.clientMessageId
        if queuedOwnerMessages.contains(where: { $0.id == clientMessageId })
            || recoverableTurn?.clientMessageId == clientMessageId
            || pendingAttachmentSend?.clientMessageId == clientMessageId
            || messages.contains(where: {
                $0.clientMessageId == clientMessageId && $0.outgoingState != .cancelled
            }) {
            return true
        }

        if isStreaming || recoverableTurn != nil {
            queueOwnerMessage(
                text: continuation.text, files: [], askCardId: continuation.askCardId,
                sentPendingIds: [], clientMessageId: clientMessageId)
        } else {
            startPreparedTurn(
                text: continuation.text, files: [], askCardId: continuation.askCardId,
                clientMessageId: clientMessageId)
        }
        return true
    }

    private func resumeAcceptedActionContinuations() {
        for (key, continuation) in actionContinuations
        where continuation.acceptedAt == nil
            && !resumedActionContinuationKeys.contains(key) {
            let terminal: Bool
            if key.hasPrefix("ask:") {
                let cardId = String(key.dropFirst(4))
                terminal = messages.lazy.flatMap(\.askCards).contains {
                    $0.id == cardId && $0.status == "answered"
                }
            } else if key.hasPrefix("opinion:") {
                let cardId = String(key.dropFirst(8))
                terminal = messages.lazy.flatMap(\.confirmCards).contains {
                    $0.id == cardId && $0.status == "rejected"
                }
            } else {
                terminal = false
            }
            guard terminal else { continue }
            resumedActionContinuationKeys.insert(key)
            dispatchActionContinuation(
                key: key, text: continuation.text, askCardId: continuation.askCardId)
        }
    }

    #if DEBUG
    func debugStableActionContinuationId(key: String, text: String,
                                         askCardId: String?) -> String {
        resolvedActionContinuation(key: key, text: text, askCardId: askCardId).clientMessageId
    }
    func debugRemoveActionContinuation(key: String) {
        actionContinuations.removeValue(forKey: key)
        persistActionContinuations()
    }
    func debugActionContinuationText(key: String) -> String? {
        actionContinuations[key]?.text
    }
    func debugMarkActionContinuationAccepted(clientMessageId: String) {
        markOutgoingAccepted(clientMessageId: clientMessageId)
    }
    func debugActionContinuationIsAccepted(key: String) -> Bool {
        actionContinuations[key]?.acceptedAt != nil
    }
    func debugHasActionContinuation(key: String) -> Bool {
        actionContinuations[key] != nil
    }
    #endif
    // Awakening animation bridge (spec): bumped when a DIFFERENT conversation is
    // opened from the drawer so the screen replays the session-opening character;
    // readyTick fires once its history has loaded (success is gated on this).
    private(set) var restoreTick = 0
    private(set) var restoreReadyTick = 0

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

    /// Owner-authored follow-ups are never dropped just because another turn is
    /// still streaming. The queue is persisted so a process kill cannot erase an
    /// ask answer, rejection explanation, opinion, or manually typed next message.
    struct QueuedOwnerMessage: Codable, Identifiable, Equatable {
        let id: String
        var conversationId: String?
        /// A queued follow-up written before the server assigns a conversation id
        /// belongs to the exact first owner send that opened that chat. Never use
        /// nil as a wildcard: after a chat switch that could deliver into a wholly
        /// unrelated conversation.
        let newConversationClientMessageId: String?
        let text: String
        let files: [AgentFileRef]
        var attachmentIds: [UUID]? = nil
        let askCardId: String?
        let createdAt: Date
        /// Distinguishes separate server-unassigned chats. Two provisional chats
        /// both have a nil conversationId, so nil must never be their identity.
        var sessionIdentity: String? = nil
    }
    private static let queuedOwnerMessagesKey = "alma.assistant.queuedOwnerMessages"
    private var steeringSubmissions: Set<String> = []
    private(set) var queuedOwnerMessages: [QueuedOwnerMessage] = AssistantVM.loadQueuedOwnerMessages() {
        didSet {
            if queuedOwnerMessages.isEmpty {
                UserDefaults.standard.removeObject(forKey: Self.queuedOwnerMessagesKey)
            } else if let data = try? JSONEncoder().encode(queuedOwnerMessages) {
                UserDefaults.standard.set(data, forKey: Self.queuedOwnerMessagesKey)
            }
        }
    }
    private static func loadQueuedOwnerMessages() -> [QueuedOwnerMessage] {
        guard let data = UserDefaults.standard.data(forKey: queuedOwnerMessagesKey) else { return [] }
        return (try? JSONDecoder().decode([QueuedOwnerMessage].self, from: data)) ?? []
    }
    var queuedOwnerMessageCount: Int {
        let activeNewConversationSendId = currentClientMessageId ?? recoverableTurn?.clientMessageId
        return queuedOwnerMessages.filter { queued in
            if let queuedConversationId = queued.conversationId {
                return queuedConversationId == conversationId
            }
            guard conversationId == nil else { return false }
            if let queuedSessionIdentity = queued.sessionIdentity {
                return queuedSessionIdentity == selectedSessionIdentity
            }
            return queued.newConversationClientMessageId == activeNewConversationSendId
        }.count
    }

    // ── PR 5: durable-turn client state ─────────────────────────────────────
    /// Roadmap 4.3 — recovery descriptor, persisted so process death can't lose
    /// the running turn. Cleared only on terminal reconcile or explicit cancel.
    struct RecoverableTurn: Codable {
        var conversationId: String?
        var turnId: String?
        var clientMessageId: String
        var lastSeq: Int
        var startedAt: Date
        var message: String? = nil
        var files: [AgentFileRef]? = nil
        var modelId: String? = nil
        var projectId: String? = nil
        var askCardId: String? = nil
        /// Local attachment transaction identities bound to this exact request.
        /// They are removed from the composer only after server acceptance.
        var attachmentIds: [UUID]? = nil
        /// Stable identity for the locally selected chat before the server has
        /// assigned a conversation id. Persisted for kill/relaunch recovery.
        var sessionIdentity: String? = nil
        /// A proxy can repeatedly close a POST before returning any identity.
        /// Persist the bounded clean-EOF retry ladder so relaunch/poll cannot
        /// turn that acceptance-unknown request into a tight network loop.
        var preTurnEOFRetryCount: Int? = nil
        var preTurnRetryNotBefore: Date? = nil
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
    private static let maxPreTurnEOFRetries = 3
    static func preTurnEOFRetryDelay(for attempt: Int) -> TimeInterval? {
        guard attempt > 0, attempt < maxPreTurnEOFRetries else { return nil }
        return pow(2.0, Double(attempt - 1))
    }

    static func terminalStartedAtMatchesSend(startedAt raw: String?, sentAt: Date?) -> Bool {
        guard let sentAt, let raw else { return false }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let started = iso.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
        guard let started else { return false }
        return started >= sentAt.addingTimeInterval(-15)
    }
    /// Explicit transport ownership handoff. Some control turns intentionally
    /// have no recovery descriptor, so descriptor existence cannot identify a
    /// direct-SSE cancellation that durable replay now owns.
    private static let selectedSessionIdentityKey = "alma.assistant.selectedSessionIdentity.v2"
    private static func loadOrCreateSelectedSessionIdentity() -> String {
        let defaults = UserDefaults.standard
        if let value = defaults.string(forKey: selectedSessionIdentityKey), !value.isEmpty {
            return value
        }
        let value = UUID().uuidString
        defaults.set(value, forKey: selectedSessionIdentityKey)
        return value
    }
    /// The locally-selected provisional chat must survive process death. Without
    /// this stable identity, its draft and attachment transaction remain safely
    /// stored but become unreachable after bootstrap adopts the server pointer.
    private var selectedSessionIdentity = AssistantVM.loadOrCreateSelectedSessionIdentity() {
        didSet {
            UserDefaults.standard.set(selectedSessionIdentity,
                                      forKey: Self.selectedSessionIdentityKey)
        }
    }
    private var streamTaskGeneration: UUID?
    private var durableHandoffGenerations: Set<UUID> = []
    private var statusRecoveryFailureCount = 0
    private let maxStatusRecoveryFailures = 5
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
    // One engine survives the full-screen Call UI being minimized to chat. A
    // view-owned engine would tear down the WebSocket on dismiss and make the
    // "চ্যাট" control silently end the call.
    let voiceEngine = AlmaVoiceEngine()
    var showVoice = false
    var conversations: [AgentConversation] = []
    private var pinnedOverrides: [String: Bool] = [:]
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
    private var indexedSessionFileMessages: [AgentChatMessage] = []
    private var sessionFileIndexConversationId: String?
    var sessionFilesIndexLoading = false
    var sessionFiles: [AgentSessionFile] {
        var rows: [AgentSessionFile] = []
        var seen = Set<String>()
        for message in searchableMessages + indexedSessionFileMessages {
            for ref in message.fileRefs where seen.insert("\(ref.bucket)/\(ref.path)").inserted {
                let rawName = URL(fileURLWithPath: ref.path).lastPathComponent
                let origin: AgentSessionFile.Origin = message.role == .assistant ? .generated : .uploaded
                rows.append(.init(
                    id: "\(origin.rawValue):\(ref.bucket):\(ref.path)", origin: origin,
                    name: rawName.removingPercentEncoding ?? rawName,
                    mediaType: ref.mediaType, createdAt: message.createdAt,
                    messageId: message.id, fileRef: ref, artifactId: nil, artifactContent: nil))
            }
        }
        for artifact in artifacts {
            let kind = artifact.type?.lowercased() ?? "file"
            let media = kind == "markdown" ? "text/markdown"
                : (kind == "pdf" ? "application/pdf"
                    : (["jpeg", "jpg"].contains(kind) ? "image/jpeg"
                        : (["png", "webp", "gif"].contains(kind) ? "image/\(kind)"
                            : (kind == "html" ? "text/html" : "text/plain"))))
            var name = artifact.title?.isEmpty == false ? artifact.title! : "ALMA file"
            if URL(fileURLWithPath: name).pathExtension.isEmpty {
                name += kind == "markdown" ? ".md" : (kind == "pdf" ? ".pdf" : ".txt")
            }
            rows.append(.init(
                id: "generated:\(artifact.id)", origin: .generated, name: name,
                mediaType: media, createdAt: artifact.createdAt,
                messageId: artifact.messageId, fileRef: nil, artifactId: artifact.id,
                artifactContent: artifact.content))
        }
        return rows.sorted { ($0.createdAt ?? "") > ($1.createdAt ?? "") }
    }
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
        return items.filter {
            !decided.contains($0.id) && actionRegistry[$0.id]?.state.isTerminal != true
        }
    }
    private var usesBackgroundTaskDebugFixture = false
    var planDriveBusyPlanId: String?
    var dailyTodoBusyId: String?

    // TTS playback ("শুনুন")
    var ttsPlayingId: String?
    var ttsLoadingId: String?
    private var ttsPlayer: AVAudioPlayer?
    private var ttsDelegate: AssistantTTSDelegate?
    private var ttsChunks: [String] = []
    private var ttsGeneration = UUID()

    // Composer attachments
    struct PendingFile: Identifiable, Equatable {
        enum State: Equatable { case uploading, waitingForNetwork, ready(AgentFileRef), failed }
        let id: UUID
        let name: String
        let mediaType: String
        let data: Data
        let image: UIImage?
        let cacheFileName: String
        var state: State = .uploading

        init(id: UUID = UUID(), name: String, mediaType: String, data: Data,
             image: UIImage?, cacheFileName: String? = nil, state: State = .uploading) {
            self.id = id
            self.name = name
            self.mediaType = mediaType
            self.data = data
            self.image = image
            self.cacheFileName = cacheFileName ?? "\(id.uuidString).attachment"
            self.state = state
        }
    }
    var pendingFiles: [PendingFile] = [] {
        didSet { persistCurrentComposerDraft() }
    }

    private struct PendingFileSnapshot: Codable {
        let id: UUID
        let name: String
        let mediaType: String
        let cacheFileName: String
        let state: String
        let fileRef: AgentFileRef?
    }

    private struct ComposerDraftSnapshot: Codable {
        var text: String
        var files: [PendingFileSnapshot]
    }

    private struct PendingAttachmentSend: Codable {
        let clientMessageId: String
        var conversationId: String?
        let sessionIdentity: String
        let text: String
        let attachmentIds: [UUID]
        let askCardId: String?
        let createdAt: Date
    }

    private static let composerDraftsKey = "alma.assistant.composerDrafts.v2"
    private static let pendingAttachmentSendKey = "alma.assistant.pendingAttachmentSend.v2"
    private var pendingAttachmentSend: PendingAttachmentSend? = AssistantVM.loadPendingAttachmentSend() {
        didSet {
            if let pendingAttachmentSend,
               let data = try? JSONEncoder().encode(pendingAttachmentSend) {
                UserDefaults.standard.set(data, forKey: Self.pendingAttachmentSendKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.pendingAttachmentSendKey)
            }
        }
    }

    var hasPendingAttachmentSend: Bool { pendingAttachmentSend != nil }
    var composerSubmissionPending: Bool {
        if let pendingAttachmentSend,
           pendingAttachmentSend.sessionIdentity == selectedSessionIdentity { return true }
        if let recoverableTurn,
           recoverableTurn.sessionIdentity == selectedSessionIdentity,
           recoverableTurn.message == composerDraft { return true }
        return queuedOwnerMessages.contains { queued in
            let sameConversation = queued.conversationId != nil
                ? queued.conversationId == conversationId
                : queued.sessionIdentity == selectedSessionIdentity
            return sameConversation && queued.text == composerDraft
        }
    }

    private var composerDraftKey: String {
        if let conversationId { return "conversation:\(conversationId)" }
        return "session:\(selectedSessionIdentity)"
    }

    private static func loadComposerDrafts() -> [String: ComposerDraftSnapshot] {
        guard let data = UserDefaults.standard.data(forKey: composerDraftsKey) else { return [:] }
        return (try? JSONDecoder().decode([String: ComposerDraftSnapshot].self, from: data)) ?? [:]
    }

    private static func loadPendingAttachmentSend() -> PendingAttachmentSend? {
        guard let data = UserDefaults.standard.data(forKey: pendingAttachmentSendKey) else { return nil }
        return try? JSONDecoder().decode(PendingAttachmentSend.self, from: data)
    }

    private static func attachmentCacheDirectory() -> URL? {
        guard let root = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let directory = root.appendingPathComponent("ALMAAgentAttachmentTransactions", isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            return directory
        } catch {
            return nil
        }
    }

    private func persistCurrentComposerDraft() {
        guard !restoringComposerDraft else { return }
        var store = Self.loadComposerDrafts()
        let files = pendingFiles.map { file -> PendingFileSnapshot in
            let state: String
            let ref: AgentFileRef?
            switch file.state {
            case .uploading: state = "uploading"; ref = nil
            case .waitingForNetwork: state = "waitingForNetwork"; ref = nil
            case .ready(let value): state = "ready"; ref = value
            case .failed: state = "failed"; ref = nil
            }
            return .init(id: file.id, name: file.name, mediaType: file.mediaType,
                         cacheFileName: file.cacheFileName, state: state, fileRef: ref)
        }
        if composerDraft.isEmpty && files.isEmpty {
            store.removeValue(forKey: composerDraftKey)
        } else {
            store[composerDraftKey] = .init(text: composerDraft, files: files)
        }
        if let data = try? JSONEncoder().encode(store) {
            UserDefaults.standard.set(data, forKey: Self.composerDraftsKey)
        }
    }

    private func restoreCurrentComposerDraft() {
        restoringComposerDraft = true
        defer { restoringComposerDraft = false }
        let snapshot = Self.loadComposerDrafts()[composerDraftKey]
        composerDraft = snapshot?.text ?? ""
        let directory = Self.attachmentCacheDirectory()
        pendingFiles = (snapshot?.files ?? []).compactMap { item in
            guard let directory,
                  let data = try? Data(contentsOf: directory.appendingPathComponent(item.cacheFileName))
            else { return nil }
            let state: PendingFile.State
            switch item.state {
            case "ready":
                guard let ref = item.fileRef else { return nil }
                state = .ready(ref)
            case "failed": state = .failed
            default: state = .waitingForNetwork
            }
            return PendingFile(
                id: item.id, name: item.name, mediaType: item.mediaType, data: data,
                image: item.mediaType.hasPrefix("image/") ? UIImage(data: data) : nil,
                cacheFileName: item.cacheFileName, state: state)
        }
        Task { [weak self] in
            guard let self else { return }
            for file in self.pendingFiles where file.state == .waitingForNetwork {
                self.retryPendingFile(file.id)
            }
            self.tryStartPendingAttachmentSend()
        }
    }

    private func migrateComposerDraft(from oldKey: String, to newKey: String) {
        guard oldKey != newKey else { return }
        var store = Self.loadComposerDrafts()
        if let value = store.removeValue(forKey: oldKey) { store[newKey] = value }
        if let data = try? JSONEncoder().encode(store) {
            UserDefaults.standard.set(data, forKey: Self.composerDraftsKey)
        }
    }

    // Mic (recording bar: waveform + timer, web VoiceWaveform parity)
    var isRecording = false
    /// Claude-style LIVE dictation: words appear as spoken (gpt-4o-transcribe
    /// realtime over the shared AlmaStreamingSTT; falls back to the recorder +
    /// upload path if the streaming mic fails to start).
    var liveDictation = ""
    private var usingStreamDictation = false
    private let dictationStreamer = AlmaStreamingSTT()
    var transcribing = false
    var micLevel: Double = 0.06         // 0.06…1, mirrors the web's clamped RMS level
    var recordingSeconds: Int = 0
    private var recorder: AVAudioRecorder?
    private var meterTask: Task<Void, Never>?
    /// Text the mic transcription appends — the composer view observes this.
    var dictatedText: String = ""
    private static let dictationFailureKey = "alma.assistant.dictationFailure.v2"
    var dictationFailure: String? = UserDefaults.standard.string(forKey: AssistantVM.dictationFailureKey) {
        didSet {
            if let dictationFailure {
                UserDefaults.standard.set(dictationFailure, forKey: Self.dictationFailureKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.dictationFailureKey)
            }
        }
    }
    var canRetryDictation: Bool {
        dictationFailure != nil && FileManager.default.fileExists(atPath: recordingURL.path)
    }

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
        AlmaAgentHaptics.selection()
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
    var exportingConversation = false

    // Signed image URLs (path → url), resolved lazily per thumbnail
    var signedURLs: [String: URL] = [:]

    private var pollTask: Task<Void, Never>?
    private static let parityLocalMigrationKey = "alma.assistant.parity-v2.local-migration"

    // ── Bootstrap + polling ────────────────────────────────────────────────

    func bootstrap() async {
        migrateParityLocalStateIfNeeded()
        restoreDurableDictationRecoveryIfNeeded()
        registerObserversOnce()
        await loadModels()
        if !shouldRestoreProvisionalSession {
            await loadActiveConversation()
        } else {
            conversationId = nil
            AlmaTurnLog.event("composer.provisionalRestored", selectedSessionIdentity)
        }
        restoreCurrentComposerDraft()
        await recoverFromPersistedDescriptor()
        async let drive: Void = loadPlanDrive()
        async let todos: Void = loadDailyAgentTodos()
        async let turns: Void = loadActiveBackgroundTurns()
        _ = await (drive, todos, turns)
        startPolling()
        // A queued follow-up may outlive the process after the preceding turn
        // became terminal while the app was dead. Recovery clears that stale
        // descriptor; this drain then resumes the exact scoped conversation.
        scheduleQueuedOwnerMessage()
    }

    /// One-way, non-lossy migration. Earlier builds kept an unfinished dictation
    /// only in NSTemporaryDirectory; copy it into the durable Application Support
    /// location before bootstrap. Existing queue/recoverable-turn keys retain
    /// their original names and are therefore read in place without rewriting.
    private func migrateParityLocalStateIfNeeded() {
        let defaults = UserDefaults.standard
        guard defaults.integer(forKey: Self.parityLocalMigrationKey) < 2 else { return }
        let legacyDictation = FileManager.default.temporaryDirectory
            .appendingPathComponent("alma-dictation.m4a")
        let durableDictation = recordingURL
        if FileManager.default.fileExists(atPath: legacyDictation.path),
           !FileManager.default.fileExists(atPath: durableDictation.path) {
            do {
                try FileManager.default.copyItem(at: legacyDictation, to: durableDictation)
                dictationFailure = "আগের অসমাপ্ত voice recording রাখা আছে — Retry করুন"
                AlmaTurnLog.event("migration.dictation", "legacy-to-durable")
            } catch {
                AlmaTurnLog.event("migration.dictationFailed", String(describing: error))
            }
        }
        defaults.set(2, forKey: Self.parityLocalMigrationKey)
        AlmaTurnLog.event("migration.localState", "v2")
    }

    /// This check deliberately runs on every launch, not only during the one-time
    /// temp-file migration. A kill can happen after the durable file is written
    /// but before transcription returns; the remaining bytes are themselves the
    /// recovery source of truth.
    private func restoreDurableDictationRecoveryIfNeeded() {
        guard FileManager.default.fileExists(atPath: recordingURL.path) else { return }
        if dictationFailure == nil {
            dictationFailure = "অসমাপ্ত voice recording রাখা আছে — Retry করুন"
        }
        AlmaTurnLog.event("dictation.recoveryReady", "durable-audio-present")
    }

    private var shouldRestoreProvisionalSession: Bool {
        guard !selectedSessionIdentity.hasPrefix("server:") else { return false }
        if let pendingAttachmentSend,
           pendingAttachmentSend.conversationId == nil,
           pendingAttachmentSend.sessionIdentity == selectedSessionIdentity { return true }
        guard let snapshot = Self.loadComposerDrafts()["session:\(selectedSessionIdentity)"] else {
            return false
        }
        return !snapshot.text.isEmpty || !snapshot.files.isEmpty
    }

    /// PR 5 — kill/relaunch recovery: the persisted descriptor outlives the
    /// process. If it points at a still-running turn (possibly in a different
    /// conversation than the active-pointer), follow it and re-attach; a stale
    /// descriptor for a finished turn is dropped after normal reconciliation.
    private func recoverFromPersistedDescriptor() async {
        guard let rt = recoverableTurn else { return }
        if isStreaming { return }   // active-conversation recovery already took it
        // The process can die after POST begins but before conversation_id/turn_id
        // arrives. Re-submit the exact body with the same idempotency key; the
        // server either returns the existing turn or creates the one missing turn.
        if rt.turnId == nil {
            if (rt.preTurnEOFRetryCount ?? 0) >= Self.maxPreTurnEOFRetries {
                await failRecovery(
                    preserveDescriptor: true,
                    ownerRetryable: true,
                    message: "Server গ্রহণ নিশ্চিত করা যায়নি — বার্তাটি নিরাপদ আছে, Retry করুন")
                return
            }
            var descriptor = rt
            let identity = rt.sessionIdentity ?? "recovered:\(rt.clientMessageId)"
            // The active pointer may have loaded an older server conversation
            // first. A persisted pre-ID send belongs to its own provisional chat;
            // restore that surface explicitly instead of coalescing nil onto the
            // unrelated active conversation.
            conversationId = nil
            selectedSessionIdentity = identity
            currentProjectId = rt.projectId
            modelId = rt.modelId == "auto" ? nil : rt.modelId
            conversationTitle = "ALMA AI"
            localIdByServerId = [:]
            lastSyncStamp = nil
            resetHistoryWindowState()
            messages = []
            openTasks = []
            artifacts = []
            descriptor.sessionIdentity = identity
            recoverableTurn = descriptor
            resumePreTurnDescriptor(descriptor)
            return
        }
        guard let recoverConversationId = rt.conversationId else {
            recoverableTurn = nil
            scheduleQueuedOwnerMessage()
            return
        }
        if conversationId != recoverConversationId {
            let st: TurnStatusResponse? = try? await AlmaAPI.shared.get(
                "/api/assistant/conversations/\(recoverConversationId)/turn-status")
            guard st?.status == "running" else {
                recoverableTurn = nil
                scheduleQueuedOwnerMessage()
                return
            }
            await openConversation(recoverConversationId, recoveringPersistedTurn: true)
        } else {
            currentTurnId = rt.turnId ?? currentTurnId
            await recoverTurnState(trigger: "relaunch")
        }
        if !isStreaming {
            recoverableTurn = nil        // nothing running — stale
            scheduleQueuedOwnerMessage()
        }
    }

    private func resumePreTurnDescriptor(_ rt: RecoverableTurn) {
        let text = rt.message ?? ""
        let files = rt.files ?? []
        guard !text.isEmpty || !files.isEmpty else {
            recoverableTurn = nil
            scheduleQueuedOwnerMessage()
            return
        }
        conversationId = rt.conversationId
        if !messages.contains(where: { $0.role == .user && $0.text == text }) {
            var owner = AgentChatMessage(
                id: "local-recovered-\(rt.clientMessageId)", role: .user,
                clientMessageId: rt.clientMessageId, outgoingState: .checking, text: text)
            owner.fileRefs = files
            messages.append(owner)
        }
        isStreaming = true
        thinkingLive = true
        reconnecting = true
        lastLiveEventAt = Date()
        lastSendAt = rt.startedAt
        currentClientMessageId = rt.clientMessageId
        seqBox.value = rt.lastSeq
        ensureStreamingTail()
        let body = ChatBody(
            conversationId: rt.conversationId, message: text, files: files,
            modelId: rt.modelId ?? "auto", projectId: rt.projectId,
            clientMessageId: rt.clientMessageId, askCardId: rt.askCardId)
        startDirectTurn(body)
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
                self.resumePendingAttachmentUploads()
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
                self.resumePendingAttachmentUploads()
                await self.recoverTurnState(trigger: "active")               // idempotent re-check
            }
        })
    }

    private func loadActiveConversation() async {
        do {
            let ptr: ActiveConversationPointer = try await AlmaAPI.shared.get("/api/assistant/active-conversation")
            if let cid = ptr.conversationId {
                conversationId = cid
                selectedSessionIdentity = "server:\(cid)"
                currentProjectId = ptr.projectId
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
    /// Keep the mounted SwiftUI tree bounded even after many "older" pages.
    /// Rich agent rows can contain markdown, media and action cards, so mounting
    /// an entire multi-year conversation is materially more expensive than
    /// keeping a small reversible viewport cache.
    static let mountedHistoryLimit = historyWindow * 3
    static let historyCacheLimit = historyWindow * 12
    /// Max createdAt seen in the last window (ISO — lexicographic order works).
    private var lastSyncStamp: String?
    /// Rows evicted from either side of the mounted window. They remain ordered
    /// and searchable, and can be promoted back without another network hop.
    private var olderHistoryCache: [AgentChatMessage] = []
    private var newerHistoryCache: [AgentChatMessage] = []
    private var serverHasOlder = false
    private var serverHasNewer = false
    var canLoadOlder = false
    var loadingOlder = false
    var canLoadNewer: Bool { !newerHistoryCache.isEmpty || serverHasNewer }

    /// Bounded local index used by Search in this chat. Dedupe is important while
    /// an optimistic row is being replaced by its canonical server row.
    var searchableMessages: [AgentChatMessage] {
        var seen = Set<String>()
        return (olderHistoryCache + messages + newerHistoryCache).filter { seen.insert($0.id).inserted }
    }

    private func resetHistoryWindowState() {
        olderHistoryCache = []
        newerHistoryCache = []
        serverHasOlder = false
        serverHasNewer = false
        canLoadOlder = false
    }

    private func trimHistoryCaches() {
        if olderHistoryCache.count > Self.historyCacheLimit {
            olderHistoryCache.removeFirst(olderHistoryCache.count - Self.historyCacheLimit)
            serverHasOlder = true
        }
        if newerHistoryCache.count > Self.historyCacheLimit {
            newerHistoryCache.removeLast(newerHistoryCache.count - Self.historyCacheLimit)
            // Trimmed rows are recoverable through the additive `after` cursor.
            serverHasNewer = true
        }
    }

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
            serverHasOlder = wire.count >= Self.historyWindow
            canLoadOlder = !olderHistoryCache.isEmpty || serverHasOlder
            authExpired = false
            await loadOpenTasks()
            resumeAcceptedActionContinuations()
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
        let started = Date()
        AlmaTurnLog.event("sync.olderPage.begin", "mounted=\(messages.count)")
        loadingOlder = true
        defer { loadingOlder = false }
        let rows: [AgentChatMessage]
        if !olderHistoryCache.isEmpty {
            let count = min(Self.historyWindow, olderHistoryCache.count)
            rows = Array(olderHistoryCache.suffix(count))
            olderHistoryCache.removeLast(count)
        } else {
            guard let older: [AgentMessageWire] = try? await AlmaAPI.shared.get(
                "/api/assistant/conversations/\(cid)/messages",
                query: ["limit": String(Self.historyWindow), "before": oldest.id]) else { return }
            serverHasOlder = older.count >= Self.historyWindow
            // A server without cursor support echoes rows we already hold — drop them
            // (graceful against an un-upgraded backend during rollout).
            let known = Set((olderHistoryCache + messages + newerHistoryCache).map(\.id))
            rows = older.filter { !known.contains($0.id) }.map(AgentChatMessage.from)
            guard !rows.isEmpty else {
                serverHasOlder = false
                canLoadOlder = !olderHistoryCache.isEmpty
                return
            }
        }
        var tx = Transaction()
        tx.disablesAnimations = true
        withTransaction(tx) {
            messages.insert(contentsOf: rows, at: 0)
            if messages.count > Self.mountedHistoryLimit {
                let overflow = messages.count - Self.mountedHistoryLimit
                newerHistoryCache.insert(contentsOf: messages.suffix(overflow), at: 0)
                messages.removeLast(overflow)
            }
        }
        if !newerHistoryCache.isEmpty { serverHasNewer = true }
        canLoadOlder = !olderHistoryCache.isEmpty || serverHasOlder
        trimHistoryCaches()
        AlmaTurnLog.event(
            "sync.olderPage.end",
            "added=\(rows.count) mounted=\(messages.count) cachedOlder=\(olderHistoryCache.count) cachedNewer=\(newerHistoryCache.count) ms=\(Int(Date().timeIntervalSince(started) * 1000))")
    }

    /// Reverse of `loadOlderMessages`: restores an evicted newer page and moves
    /// the opposite edge into the older cache. No row disappears from the local
    /// session index and the mounted tree never exceeds the fixed budget.
    func loadNewerMessages() async {
        guard canLoadNewer else { return }
        let rows: [AgentChatMessage]
        if !newerHistoryCache.isEmpty {
            let count = min(Self.historyWindow, newerHistoryCache.count)
            rows = Array(newerHistoryCache.prefix(count))
            newerHistoryCache.removeFirst(count)
        } else {
            guard serverHasNewer, let cid = conversationId, let newest = messages.last,
                  let newer: [AgentMessageWire] = try? await AlmaAPI.shared.get(
                    "/api/assistant/conversations/\(cid)/messages",
                    query: ["limit": String(Self.historyWindow), "after": newest.serverId ?? newest.id])
            else { return }
            let known = Set((olderHistoryCache + messages + newerHistoryCache).map { $0.serverId ?? $0.id })
            rows = newer.filter { !known.contains($0.id) }.map(AgentChatMessage.from)
            serverHasNewer = newer.count >= Self.historyWindow
            guard !rows.isEmpty else { serverHasNewer = false; return }
        }
        var tx = Transaction(); tx.disablesAnimations = true
        withTransaction(tx) {
            messages.append(contentsOf: rows)
            if messages.count > Self.mountedHistoryLimit {
                let overflow = messages.count - Self.mountedHistoryLimit
                olderHistoryCache.append(contentsOf: messages.prefix(overflow))
                messages.removeFirst(overflow)
            }
        }
        canLoadOlder = !olderHistoryCache.isEmpty || serverHasOlder
        trimHistoryCaches()
        AlmaTurnLog.event("sync.newerPage", "mounted=\(messages.count) cachedOlder=\(olderHistoryCache.count) cachedNewer=\(newerHistoryCache.count)")
    }

    /// Promote a cached search hit into the mounted window while preserving its
    /// exact id. The caller can then scroll to it using the normal ScrollView id.
    @discardableResult
    func focusCachedMessage(_ id: String) -> Bool {
        guard !messages.contains(where: { $0.id == id }) else { return true }
        guard !isStreaming, recoverableTurn == nil else {
            errorToast = "চলতি উত্তর শেষ হলে পুরোনো message খুলুন — বর্তমান stream অক্ষত আছে"
            return false
        }
        let all = searchableMessages
        guard let hit = all.firstIndex(where: { $0.id == id }) else { return false }
        let half = Self.mountedHistoryLimit / 2
        let start = max(0, min(hit - half, max(0, all.count - Self.mountedHistoryLimit)))
        let end = min(all.count, start + Self.mountedHistoryLimit)
        olderHistoryCache = Array(all[..<start])
        messages = Array(all[start..<end])
        newerHistoryCache = Array(all[end...])
        canLoadOlder = !olderHistoryCache.isEmpty || serverHasOlder
        trimHistoryCaches()
        AlmaTurnLog.event("search.promote", "id=\(id) mounted=\(messages.count)")
        return true
    }

    /// Library may index a source far outside the bounded chat cache. Materialize
    /// a small server-backed window around that exact durable message before the
    /// view scrolls; scrolling to an unmounted id is intentionally never treated
    /// as success.
    @discardableResult
    func focusSessionFileSource(_ id: String) async -> Bool {
        if focusCachedMessage(id) { return true }
        guard !isStreaming, recoverableTurn == nil else { return false }
        guard let cid = conversationId,
              let target = indexedSessionFileMessages.first(where: { $0.id == id }) else {
            errorToast = "File-এর source message পাওয়া যায়নি"
            return false
        }
        let identity = selectedSessionIdentity
        async let olderWire: [AgentMessageWire]? = try? await AlmaAPI.shared.get(
            "/api/assistant/conversations/\(cid)/messages",
            query: ["limit": String(Self.historyWindow), "before": id])
        async let newerWire: [AgentMessageWire]? = try? await AlmaAPI.shared.get(
            "/api/assistant/conversations/\(cid)/messages",
            query: ["limit": String(Self.historyWindow), "after": id])
        let (olderValue, newerValue) = await (olderWire, newerWire)
        guard conversationId == cid, selectedSessionIdentity == identity,
              !isStreaming, recoverableTurn == nil else {
            AlmaTurnLog.event("library.sourcePromotionDiscarded", "selection-or-turn-changed")
            return false
        }
        guard let olderValue, let newerValue else {
            errorToast = "Source message লোড হয়নি — নেটওয়ার্ক দেখে Retry করুন"
            return false
        }
        var seen = Set<String>()
        let window = (olderValue.map(AgentChatMessage.from) + [target] + newerValue.map(AgentChatMessage.from))
            .filter { seen.insert($0.id).inserted }
        olderHistoryCache = []
        newerHistoryCache = []
        messages = Array(window.suffix(Self.mountedHistoryLimit))
        serverHasOlder = olderValue.count >= Self.historyWindow
        serverHasNewer = newerValue.count >= Self.historyWindow
        canLoadOlder = serverHasOlder
        AlmaTurnLog.event("library.sourcePromoted", "id=\(id) mounted=\(messages.count)")
        return messages.contains(where: { $0.id == id })
    }

    /// Local ("stream-…" / "local-…") id per server message id — keeps SwiftUI row
    /// identity stable when the server copy of a just-streamed turn replaces the tail.
    private var localIdByServerId: [String: String] = [:]

    /// Keep the server-id -> local-row-id bridge one-to-one. Recovery can observe a
    /// newer canonical row while an older row is still inside the 24-message window;
    /// assigning both rows to the same optimistic id used to create duplicate keys
    /// below and hard-crash Swift's `Dictionary(uniqueKeysWithValues:)` initializer.
    private func claimLocalRowId(serverId: String, localId: String,
                                 activeServerIds: Set<String>) -> Bool {
        if localIdByServerId[serverId] == localId { return true }
        let otherClaims = localIdByServerId.filter { $0.key != serverId && $0.value == localId }
        for (otherServerId, _) in otherClaims where !activeServerIds.contains(otherServerId) {
            localIdByServerId.removeValue(forKey: otherServerId)
        }
        guard !localIdByServerId.contains(where: { $0.key != serverId && $0.value == localId }) else {
            AlmaTurnLog.event("sync.identityCollisionAvoided", "local=\(localId.suffix(8))")
            return false
        }
        localIdByServerId[serverId] = localId
        return true
    }

    /// Collision-safe identity index. Upstream rows should be unique, but recovery
    /// is deliberately at-least-once and UI identity remapping is local state. A
    /// duplicate therefore degrades to deterministic last-row-wins reconciliation
    /// instead of terminating the process with a Swift assertion.
    static func identityIndex(_ rows: [AgentChatMessage]) -> [String: AgentChatMessage] {
        rows.reduce(into: [:]) { index, row in index[row.id] = row }
    }

    /// Server truth replaces the thread WITHOUT clobbering the freshly streamed tail:
    /// the tail keeps its id (no remove+insert animation) and its richer streamed
    /// content wherever the server copy is thinner. Fixes "prose vanishes at stream end".
    private func mergeServerMessages(_ wire: [AgentMessageWire]) {
        var incoming = wire.map(AgentChatMessage.from)
        let activeServerIds = Set(incoming.map(\.id))

        // Exact idempotency identity wins. A positional "last local ↔ last
        // server user" fallback used to pair a newly queued follow-up with the
        // previous owner message and silently retire the wrong queue item.
        for serverUser in incoming where serverUser.role == .user {
            guard let clientMessageId = serverUser.clientMessageId,
                  let localUser = messages.first(where: {
                      $0.role == .user && $0.id.hasPrefix("local-")
                          && $0.clientMessageId == clientMessageId
                  }) else { continue }
            _ = claimLocalRowId(serverId: serverUser.id, localId: localUser.id,
                                activeServerIds: activeServerIds)
        }

        // Pair the optimistic user message + streamed assistant tail with their
        // server rows (last user / last assistant AFTER that user message).
        let lastServerUser = incoming.lastIndex(where: { $0.role == .user })
        if let localUser = messages.last(where: {
               $0.role == .user && $0.id.hasPrefix("local-")
                   && $0.outgoingState != .queued
           }),
           let uIdx = lastServerUser, localIdByServerId[incoming[uIdx].id] == nil {
            _ = claimLocalRowId(serverId: incoming[uIdx].id, localId: localUser.id,
                                activeServerIds: activeServerIds)
        }
        var pairedTail = false
        if let localTail = messages.last(where: { $0.role == .assistant && $0.id.hasPrefix("stream-") }) {
            if let aIdx = incoming.lastIndex(where: { $0.role == .assistant }),
               aIdx > (lastServerUser ?? -1) {
                if localIdByServerId[incoming[aIdx].id] == nil {
                    _ = claimLocalRowId(serverId: incoming[aIdx].id, localId: localTail.id,
                                        activeServerIds: activeServerIds)
                }
                pairedTail = localIdByServerId[incoming[aIdx].id] == localTail.id
                    || localIdByServerId.contains { activeServerIds.contains($0.key) && $0.value == localTail.id }
            } else if localIdByServerId.contains(where: {
                activeServerIds.contains($0.key) && $0.value == localTail.id
            }) {
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
            if old.role == .user, incoming[i].fileRefs.isEmpty { incoming[i].fileRefs = old.fileRefs }
            if old.role == .user {
                incoming[i].clientMessageId = old.clientMessageId
                incoming[i].outgoingState = old.outgoingState == .failed ? .failed : .accepted
            }
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
        // Reconcile in place while keeping the mounted tree bounded. When the
        // owner is browsing older history, genuinely newer rows go into the
        // reversible forward cache rather than duplicating the mounted prefix.
        let browsingOlder = !newerHistoryCache.isEmpty || serverHasNewer
        let incomingById = Self.identityIndex(incoming)
        if incomingById.count != incoming.count {
            AlmaTurnLog.event("sync.duplicateIdentityCoalesced",
                              "rows=\(incoming.count) unique=\(incomingById.count)")
        }
        var reconciled = messages.map { incomingById[$0.id] ?? $0 }
        var known = Set(reconciled.map(\.id))
        let additions = incoming.filter { known.insert($0.id).inserted }
        if browsingOlder {
            var cachedKnown = Set(newerHistoryCache.map(\.id))
            newerHistoryCache.append(contentsOf: additions.filter { cachedKnown.insert($0.id).inserted })
        } else {
            reconciled.append(contentsOf: additions)
            if reconciled.count > Self.mountedHistoryLimit {
                let overflow = reconciled.count - Self.mountedHistoryLimit
                let evicted = Array(reconciled.prefix(overflow))
                var olderKnown = Set(olderHistoryCache.map(\.id))
                olderHistoryCache.append(contentsOf: evicted.filter { olderKnown.insert($0.id).inserted })
                reconciled.removeFirst(overflow)
            }
        }
        trimHistoryCaches()
        var tx = Transaction()
        tx.disablesAnimations = true
        withTransaction(tx) { messages = reconciled }
        reconcileVisibleActionsWithRegistry()
        if let maxStamp = wire.compactMap(\.createdAt).max() { lastSyncStamp = maxStamp }
        AlmaTurnLog.event("turn.messagesReconciled", "count=\(incoming.count)")
    }

    /// Fold server cards into the one durable action registry, then project any
    /// locally-known terminal state back into every mounted copy of that card.
    /// This prevents history refresh, sheets and pending counters from drifting.
    private func reconcileVisibleActionsWithRegistry() {
        for i in messages.indices {
            for j in messages[i].confirmCards.indices {
                let card = messages[i].confirmCards[j]
                if card.status != "pending",
                   let state = ActionLifecycleState(rawValue: card.status) {
                    setActionState(card.id, kind: "approval", state: state)
                } else if let record = actionRegistry[card.id], record.state.isTerminal {
                    messages[i].confirmCards[j].status = record.state.rawValue
                } else if actionRegistry[card.id] == nil {
                    setActionState(card.id, kind: "approval", state: .pending)
                }
            }
            for j in messages[i].askCards.indices {
                let card = messages[i].askCards[j]
                if card.status == "answered" {
                    setActionState(card.id, kind: "ask", state: .answered,
                                   selectedOption: card.selectedOption)
                } else if let record = actionRegistry[card.id], record.state == .answered {
                    messages[i].askCards[j].status = "answered"
                    messages[i].askCards[j].selectedOption = record.selectedOption
                } else if actionRegistry[card.id] == nil {
                    setActionState(card.id, kind: "ask", state: .pending)
                }
            }
        }
    }

    /// Stream ended: settle the tail in place FIRST (prose stays on screen), then
    /// fold in server truth (card ids/statuses, tokens, cost) via the merge.
    private func finalizeTurn(expectedGeneration: UUID,
                              expectedSessionIdentity: String) async -> Bool {
        guard streamTaskGeneration == expectedGeneration,
              selectedSessionIdentity == expectedSessionIdentity else { return false }
        let started = Date()
        AlmaTurnLog.event("turn.finalize.begin", "mounted=\(messages.count)")
        defer {
            AlmaTurnLog.event(
                "turn.finalize.end",
                "mounted=\(messages.count) ms=\(Int(Date().timeIntervalSince(started) * 1000))")
        }
        if let i = messages.lastIndex(where: { $0.isStreaming }) { messages[i].isStreaming = false }
        isStreaming = false
        thinkingLive = false
        settleLiveMode()
        justSettledId = messages.last(where: { $0.role == .assistant })?.id
        guard let cid = conversationId else { return false }
        if let wire: [AgentMessageWire] = try? await AlmaAPI.shared.get("/api/assistant/conversations/\(cid)/messages") {
            guard streamTaskGeneration == expectedGeneration,
                  selectedSessionIdentity == expectedSessionIdentity,
                  conversationId == cid else { return false }
            mergeServerMessages(wire)
            justSettledId = messages.last(where: { $0.role == .assistant })?.id
        }
        guard streamTaskGeneration == expectedGeneration,
              selectedSessionIdentity == expectedSessionIdentity,
              conversationId == cid else { return false }
        // PR 5: terminal + reconciled — the descriptor has done its job.
        recoverableTurn = nil
        currentClientMessageId = nil
        // Open tasks/artifacts/global counters are refreshed by the existing quiet
        // poll. Keeping them out of this suspended ownership boundary prevents an
        // old chat's async result from landing after navigation.
        return true
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
                        self.streamTask?.cancel()
                        await self.failRecovery(
                            preserveDescriptor: true,
                            message: "সংযোগ পাওয়া যাচ্ছে না — বার্তাটি সুরক্ষিত আছে, পরে আবার যাচাই হবে")
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
        // A pre-ID request is still fully addressable by its idempotency key.
        // Foreground/poll reconnect retries that exact body; it must not wait for
        // a conversation id that the dropped first response never delivered.
        if let recoverableTurn,
           recoverableTurn.turnId == nil,
           recoverableTurn.conversationId == conversationId,
           recoverableTurn.sessionIdentity == selectedSessionIdentity,
           !isStreaming {
            guard (recoverableTurn.preTurnEOFRetryCount ?? 0) < Self.maxPreTurnEOFRetries else {
                return
            }
            if let notBefore = recoverableTurn.preTurnRetryNotBefore,
               notBefore > Date() {
                return
            }
            resumePreTurnDescriptor(recoverableTurn)
            return
        }
        guard let cid = conversationId else { return }
        let matchingDescriptor = recoverableTurn.flatMap {
            $0.conversationId == cid ? $0 : nil
        }
        if let descriptorTurnId = matchingDescriptor?.turnId {
            currentTurnId = descriptorTurnId
        }
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
        guard let status = st else {
            statusRecoveryFailureCount += 1
            if statusRecoveryFailureCount >= maxStatusRecoveryFailures {
                statusRecoveryFailureCount = 0
                await failRecovery(
                    preserveDescriptor: true,
                    message: "সংযোগ পাওয়া যাচ্ছে না — বার্তাটি সুরক্ষিত আছে, পরে আবার যাচাই হবে")
            }
            return
        }
        statusRecoveryFailureCount = 0
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
        } else if reconnecting || isStreaming || matchingDescriptor != nil {
            // The POST already yielded this conversation id, but no turn id yet.
            // An idle/terminal row may still describe the PREVIOUS turn while our
            // accepted request is between conversation creation and turn creation.
            // Only terminalize when the status carries positive identity/time
            // evidence for this send; otherwise keep the descriptor and perform
            // the bounded awaiting-creation reconciliation.
            if matchingDescriptor?.turnId == nil {
                if status.turnId != nil, isTerminalForOurTurn(status, requireEvidence: true) {
                    currentTurnId = status.turnId
                    if var descriptor = recoverableTurn {
                        descriptor.turnId = status.turnId
                        recoverableTurn = descriptor
                        markOutgoingAccepted(clientMessageId: descriptor.clientMessageId)
                    }
                    await finishRecovery(terminalStatus: status.status ?? "done")
                } else {
                    startRecoveryPolling(cid: cid, awaitingTurnCreation: true)
                }
                return
            }
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
    private func isTerminalForOurTurn(_ st: TurnStatusResponse,
                                      requireEvidence: Bool = false) -> Bool {
        if let tid = st.turnId, tid == currentTurnId { return true }
        let matched = Self.terminalStartedAtMatchesSend(
            startedAt: st.startedAt, sentAt: lastSendAt)
        return matched || !requireEvidence && (lastSendAt == nil || st.startedAt == nil)
    }

    /// PR 5 recovery transport: attach the durable stream — the full activity
    /// timeline replays (thinking/tools/cards/prose, tail rebuilt authoritatively)
    /// and then continues live until the terminal event. If the stream closes
    /// without a terminal (Redis-less replay page) we reconcile via status; if it
    /// can't be attached at all, plain status polling takes over.
    private func startDurableRecoveryTail(cid: String, turnId: String) {
        // Recovery becomes the single transport owner. Without this handoff a
        // stalled direct SSE could resume beside the full replay and both buffers
        // would apply the same prose/tools/done events.
        if let directStream = streamTask, let generation = streamTaskGeneration {
            durableHandoffGenerations.insert(generation)
            streamTask = nil
            streamTaskGeneration = nil
            directStream.cancel()
            AlmaTurnLog.event("turn.streamHandoff", "direct-to-durable:\(turnId)")
        }
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
            // A dead network must not hold a generic loader for minutes. After a
            // bounded 45s recovery window we settle the UI but keep the durable
            // descriptor so a later poll/relaunch can resume the exact turn.
            while elapsed < 45 {
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
                    } else if sawRunning || !awaitingTurnCreation
                                || self.isTerminalForOurTurn(s, requireEvidence: true) {
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
            await self.failRecovery(
                preserveDescriptor: true,
                message: "সংযোগ পাওয়া যাচ্ছে না — বার্তাটি সুরক্ষিত আছে, পরে আবার যাচাই হবে")
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
        scheduleQueuedOwnerMessage()
    }

    /// The send never became a server turn — keep the owner's message row, drop the
    /// placeholder tail, and say so in Bangla (roadmap 1.1: bounded recovery proved
    /// no turn exists — only now may a failure surface).
    private func failRecovery(preserveDescriptor: Bool = false,
                              ownerRetryable: Bool = false,
                              message: String = "পাঠানো যায়নি — আবার চেষ্টা করুন") async {
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
        if !preserveDescriptor { recoverableTurn = nil }
        if let clientMessageId = currentClientMessageId {
            for index in messages.indices where messages[index].clientMessageId == clientMessageId {
                messages[index].outgoingState = ownerRetryable
                    ? .failed : preserveDescriptor ? .checking : .failed
            }
        }
        AlmaTurnLog.event("turn.terminal", preserveDescriptor
                          ? "recovery:paused-offline" : "recovery:failed-no-turn")
        errorToast = message
        AlmaAgentHaptics.error()
        if !preserveDescriptor { scheduleQueuedOwnerMessage() }
    }

    // ── Conversations + sidebar data (web AgentSidebar parity) ────────────

    func loadConversations() async {
        loadingConversations = conversations.isEmpty
        defer { loadingConversations = false }
        do {
            let page: AgentConversationsPage = try await AlmaAPI.shared.get(
                "/api/assistant/conversations", query: ["paginated": "true", "limit": "30"])
            conversations = page.conversations.filter { $0.archived != true }
            if let cid = conversationId,
               let active = conversations.first(where: { $0.id == cid }) {
                conversationTitle = active.title?.isEmpty == false ? active.title! : "ALMA AI"
                currentProjectId = active.projectId
            }
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

    @discardableResult
    func renameConversation(_ id: String, title: String) async -> Bool {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, beginSubmitting("conversation:\(id)") else { return false }
        defer { finishSubmitting("conversation:\(id)") }
        do {
            let updated: AgentConversation = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/conversations/\(id)", body: ["title": t])
            if let i = conversations.firstIndex(where: { $0.id == id }) { conversations[i] = updated }
            if conversationId == id { conversationTitle = updated.title ?? "ALMA AI" }
            AlmaAgentHaptics.success()
            return true
        } catch {
            errorToast = "নাম বদলানো গেল না — আবার চেষ্টা করুন"
            AlmaAgentHaptics.error()
            return false
        }
    }

    @discardableResult
    func archiveConversation(_ id: String) async -> Bool {
        guard !conversationMutationBlocked(for: id) else {
            errorToast = "চলতি কাজ শেষ বা Cancel করার পর Archive করুন"
            AlmaAgentHaptics.warning()
            return false
        }
        guard beginSubmitting("conversation:\(id)") else { return false }
        defer { finishSubmitting("conversation:\(id)") }
        do {
            let _: AgentConversation = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/conversations/\(id)", body: ["archived": true])
            conversations.removeAll { $0.id == id }
            if conversationId == id { await newChat() }
            AlmaAgentHaptics.success()
            return true
        } catch {
            errorToast = "আর্কাইভ করা গেল না — আবার চেষ্টা করুন"
            AlmaAgentHaptics.error()
            return false
        }
    }

    @discardableResult
    func toggleConversationPin() async -> Bool {
        guard let cid = conversationId,
              beginSubmitting("conversation:\(cid)") else { return false }
        defer { finishSubmitting("conversation:\(cid)") }
        let old = conversations.first(where: { $0.id == cid })?.pinned ?? false
        do {
            let updated: AgentConversation = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/conversations/\(cid)", body: ["pinned": !old])
            if let index = conversations.firstIndex(where: { $0.id == cid }) {
                conversations[index] = updated
            }
            pinnedOverrides[cid] = updated.pinned ?? !old
            AlmaAgentHaptics.success()
            return true
        } catch {
            errorToast = "পিন বদলানো গেল না — আবার চেষ্টা করুন"
            AlmaAgentHaptics.error()
            return false
        }
    }

    var currentConversationPinned: Bool {
        guard let conversationId else { return false }
        if let pinned = pinnedOverrides[conversationId] { return pinned }
        return conversations.first(where: { $0.id == conversationId })?.pinned ?? false
    }

    var conversationMutationBlocked: Bool {
        conversationId.map { conversationMutationBlocked(for: $0) } ?? false
    }

    func conversationMutationBlocked(for id: String) -> Bool {
        (conversationId == id && (isStreaming || recoverableTurn != nil))
            || activeBackgroundTurns.contains(where: { $0.conversationId == id })
    }

    @discardableResult
    func assignConversationProject(_ projectId: String?) async -> Bool {
        guard let cid = conversationId,
              beginSubmitting("conversation:\(cid)") else { return false }
        defer { finishSubmitting("conversation:\(cid)") }
        struct Body: Encodable { let projectId: String? }
        do {
            let updated: AgentConversation = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/conversations/\(cid)", body: Body(projectId: projectId))
            currentProjectId = updated.projectId
            if let i = conversations.firstIndex(where: { $0.id == cid }) { conversations[i] = updated }
            AlmaAgentHaptics.success()
            return true
        } catch {
            errorToast = "প্রজেক্ট বদলানো গেল না — আবার চেষ্টা করুন"
            AlmaAgentHaptics.error()
            return false
        }
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

    func openConversation(_ id: String, recoveringPersistedTurn: Bool = false) async {
        guard id != conversationId else { return }
        if !recoveringPersistedTurn, isStreaming || recoverableTurn != nil {
            errorToast = "চলতি উত্তর শেষ হলে অন্য কথোপকথন খুলুন — বর্তমান কাজটি সুরক্ষিত আছে"
            return
        }
        persistCurrentComposerDraft()
        restoreTick += 1     // screen replays the session-opening awakening
        stopStreaming(cancelServer: false)
        currentClientMessageId = nil
        conversationId = id
        selectedSessionIdentity = "server:\(id)"
        let selected = conversations.first { $0.id == id }
        modelId = selected?.modelId   // pinned model follows the chat
        currentProjectId = selected?.projectId
        conversationTitle = selected?.title?.isEmpty == false ? selected!.title! : "ALMA AI"
        localIdByServerId = [:]   // 1.5: optimistic-ID maps never leak across conversations
        lastSyncStamp = nil       // 4.1: window/delta cursors are per-conversation
        resetHistoryWindowState()
        messages = []
        openTasks = []
        artifacts = []
        indexedSessionFileMessages = []
        sessionFileIndexConversationId = nil
        // Restore only after the old timeline is gone. A persisted attachment
        // transaction may re-create its waiting owner intent; it must land in
        // the destination conversation, never briefly in the previous one.
        restoreCurrentComposerDraft()
        await loadMessages(showSpinner: true)
        restoreReadyTick += 1   // history loaded → awakening may resolve to success
        await loadArtifacts()
        let _: OkResponse? = try? await AlmaAPI.shared.send("POST", "/api/assistant/active-conversation",
                                                            body: ["conversationId": id])
        await recoverTurnState(trigger: "openConversation")
        scheduleQueuedOwnerMessage()
    }

    func newChat() async {
        if isStreaming || recoverableTurn != nil {
            errorToast = "চলতি উত্তর শেষ হলে নতুন কথোপকথন খুলুন — বর্তমান কাজটি সুরক্ষিত আছে"
            return
        }
        persistCurrentComposerDraft()
        stopStreaming(cancelServer: false)
        currentClientMessageId = nil
        conversationId = nil     // server creates one on the first send
        selectedSessionIdentity = UUID().uuidString
        currentProjectId = nil
        conversationTitle = "ALMA AI"
        localIdByServerId = [:]  // 1.5: optimistic-ID maps never leak across conversations
        lastSyncStamp = nil      // 4.1: window/delta cursors are per-conversation
        resetHistoryWindowState()
        // Owner rule 2026-07-12: a NEW chat always starts on Auto (router picks) —
        // it must not inherit the previous conversation's pinned model (the picker
        // was silently carrying over e.g. Sonnet 4.6 from the last-opened chat).
        modelId = nil
        messages = []
        restoreCurrentComposerDraft()
        openTasks = []
        artifacts = []
        indexedSessionFileMessages = []
        sessionFileIndexConversationId = nil
        AlmaAgentHaptics.light()
    }

    @discardableResult
    func deleteConversation(_ id: String) async -> Bool {
        guard !conversationMutationBlocked(for: id) else {
            errorToast = "চলতি কাজ শেষ বা Cancel করার পর Delete করুন"
            AlmaAgentHaptics.warning()
            return false
        }
        guard beginSubmitting("conversation:\(id)") else { return false }
        defer { finishSubmitting("conversation:\(id)") }
        do {
            try await AlmaAPI.shared.sendNoContent("DELETE", "/api/assistant/conversations/\(id)")
            conversations.removeAll { $0.id == id }
            if conversationId == id { await newChat() }
            AlmaAgentHaptics.success()
            return true
        } catch {
            errorToast = "কথোপকথন মুছতে পারিনি — আবার চেষ্টা করুন"
            AlmaAgentHaptics.error()
            return false
        }
    }

    /// Builds a complete, server-backed transcript in bounded 50-row pages. The
    /// mounted chat window and composer draft are left untouched.
    func exportConversation(_ format: AgentConversationExportFormat) async -> URL? {
        guard let cid = conversationId, !exportingConversation else { return nil }
        exportingConversation = true
        defer { exportingConversation = false }
        do {
            var wire: [AgentMessageWire] = []
            var before: String?
            var reachedBeginning = false
            for _ in 0..<200 {
                var query: [String: String?] = ["limit": "50"]
                query["before"] = before
                let page: [AgentMessageWire] = try await AlmaAPI.shared.get(
                    "/api/assistant/conversations/\(cid)/messages", query: query)
                guard !page.isEmpty else { reachedBeginning = true; break }
                wire.insert(contentsOf: page, at: 0)
                if page.count < 50 { reachedBeginning = true; break }
                let next = page.first?.id
                guard next != before else { break }
                before = next
            }
            guard reachedBeginning else { throw AgentConversationExportError.pageLimitExceeded }
            let rows = wire.map(AgentChatMessage.from)
            let title = conversationTitle.isEmpty ? "ALMA AI" : conversationTitle
            let plain = rows.map { row in
                let speaker = row.role == .user ? "আপনি" : "ALMA"
                return "\(speaker)\n\(row.text.trimmingCharacters(in: .whitespacesAndNewlines))"
            }.joined(separator: "\n\n")
            let markdown = "# \(title)\n\n" + rows.map { row in
                let speaker = row.role == .user ? "আপনি" : "ALMA"
                return "## \(speaker)\n\n\(row.text.trimmingCharacters(in: .whitespacesAndNewlines))"
            }.joined(separator: "\n\n")
            let safeTitle = title.replacingOccurrences(of: "/", with: "-").prefix(70)
            let base = FileManager.default.temporaryDirectory.appendingPathComponent(String(safeTitle))
            let url: URL
            switch format {
            case .share, .plainText:
                url = base.appendingPathExtension("txt")
                try plain.data(using: .utf8)?.write(to: url, options: .atomic)
            case .markdown:
                url = base.appendingPathExtension("md")
                try markdown.data(using: .utf8)?.write(to: url, options: .atomic)
            case .pdf:
                url = base.appendingPathExtension("pdf")
                try Self.writeTranscriptPDF(title: title, body: plain, to: url)
            }
            AlmaAgentHaptics.success()
            return url
        } catch {
            errorToast = "কথোপকথন এক্সপোর্ট করা গেল না — আবার চেষ্টা করুন"
            AlmaAgentHaptics.error()
            return nil
        }
    }

    private static func writeTranscriptPDF(title: String, body: String, to url: URL) throws {
        let page = CGRect(x: 0, y: 0, width: 595, height: 842)
        let margin: CGFloat = 48
        let text = "\(title)\n\n\(body)"
        let attributed = NSAttributedString(string: text, attributes: [
            .font: UIFont.systemFont(ofSize: 12),
            .foregroundColor: UIColor.black,
        ])
        let framesetter = CTFramesetterCreateWithAttributedString(attributed)
        let renderer = UIGraphicsPDFRenderer(bounds: page)
        try renderer.writePDF(to: url) { context in
            var location = 0
            while location < attributed.length {
                context.beginPage()
                let cg = context.cgContext
                cg.saveGState()
                cg.translateBy(x: 0, y: page.height)
                cg.scaleBy(x: 1, y: -1)
                let path = CGPath(rect: CGRect(
                    x: margin, y: margin, width: page.width - margin * 2,
                    height: page.height - margin * 2), transform: nil)
                let frame = CTFramesetterCreateFrame(
                    framesetter, CFRange(location: location, length: 0), path, nil)
                CTFrameDraw(frame, cg)
                let visible = CTFrameGetVisibleStringRange(frame)
                cg.restoreGState()
                guard visible.length > 0 else { break }
                location += visible.length
            }
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

    /// Library indexes the complete session independently of the mounted chat
    /// viewport. Each page is released after extracting file-bearing rows, so a
    /// huge conversation does not turn into a huge SwiftUI tree or memory spike.
    func loadFullSessionFileIndex() async {
        guard let cid = conversationId,
              sessionFileIndexConversationId != cid,
              !sessionFilesIndexLoading else { return }
        sessionFilesIndexLoading = true
        defer { sessionFilesIndexLoading = false }
        var fileRows: [AgentChatMessage] = []
        var before: String?
        var seenAnchors = Set<String>()
        for _ in 0..<200 {
            var query: [String: String?] = ["limit": "200"]
            if let before { query["before"] = before }
            guard let wire: [AgentMessageWire] = try? await AlmaAPI.shared.get(
                "/api/assistant/conversations/\(cid)/messages", query: query) else {
                errorToast = "Library-এর পুরোনো file index পুরোটা লোড হয়নি — Retry করুন"
                return
            }
            let page = wire.map(AgentChatMessage.from)
            fileRows.append(contentsOf: page.filter { !$0.fileRefs.isEmpty })
            guard wire.count == 200, let anchor = wire.first?.id,
                  seenAnchors.insert(anchor).inserted else { break }
            before = anchor
        }
        var ids = Set<String>()
        indexedSessionFileMessages = fileRows.filter { ids.insert($0.id).inserted }
        sessionFileIndexConversationId = cid
        AlmaTurnLog.event("library.indexReady", "messagesWithFiles=\(indexedSessionFileMessages.count)")
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
        if ttsPlayingId == message.id || ttsLoadingId == message.id {
            ttsGeneration = UUID()
            ttsPlayer?.stop()
            ttsPlayer = nil
            ttsPlayingId = nil
            ttsLoadingId = nil
            ttsChunks = []
            return
        }
        guard ttsLoadingId == nil else { return }
        ttsGeneration = UUID()
        let generation = ttsGeneration
        ttsChunks = Self.ttsChunks(for: message.text)
        guard !ttsChunks.isEmpty else { return }
        ttsLoadingId = message.id
        AlmaAgentHaptics.light()
        Task { [weak self] in
            await self?.playNextTTSChunk(messageId: message.id, generation: generation)
        }
    }

    private static func ttsChunks(for text: String, limit: Int = 550) -> [String] {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return [] }
        let units = normalized.components(separatedBy: "\n")
            .flatMap { line in
                line.split(whereSeparator: { ".!?।!?".contains($0) })
                    .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            }
            .filter { !$0.isEmpty }
        var result: [String] = []
        var current = ""
        for unit in units {
            if unit.count > limit {
                if !current.isEmpty { result.append(current); current = "" }
                var start = unit.startIndex
                while start < unit.endIndex {
                    let end = unit.index(start, offsetBy: limit, limitedBy: unit.endIndex) ?? unit.endIndex
                    result.append(String(unit[start..<end]))
                    start = end
                }
            } else if current.isEmpty {
                current = unit
            } else if current.count + unit.count + 2 <= limit {
                current += "। " + unit
            } else {
                result.append(current)
                current = unit
            }
        }
        if !current.isEmpty { result.append(current) }
        return result
    }

    private func playNextTTSChunk(messageId: String, generation: UUID) async {
        guard generation == ttsGeneration else { return }
        guard !ttsChunks.isEmpty else {
            ttsLoadingId = nil
            ttsPlayingId = nil
            ttsPlayer = nil
            return
        }
        let chunk = ttsChunks.removeFirst()
        ttsLoadingId = messageId
        do {
            let mp3 = try await AssistantNet.postJSONForData(
                path: "/api/assistant/tts", body: ["text": chunk])
            guard generation == ttsGeneration else { return }
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
            let player = try AVAudioPlayer(data: mp3)
            let delegate = AssistantTTSDelegate { [weak self] in
                Task { @MainActor in
                    guard let self, generation == self.ttsGeneration else { return }
                    self.ttsPlayer = nil
                    await self.playNextTTSChunk(messageId: messageId, generation: generation)
                }
            }
            player.delegate = delegate
            ttsDelegate = delegate
            ttsPlayer = player
            ttsLoadingId = nil
            ttsPlayingId = messageId
            player.play()
        } catch {
            guard generation == ttsGeneration else { return }
            ttsLoadingId = nil
            ttsPlayingId = nil
            ttsChunks = []
            errorToast = "ভয়েস চালানো গেল না — আবার চেষ্টা করুন"
        }
    }

    // ── Send + stream ──────────────────────────────────────────────────────

    struct ChatBody: Encodable {
        let conversationId: String?
        let message: String
        let files: [AgentFileRef]
        let modelId: String?
        var projectId: String? = nil
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

    private struct SteeringBody: Encodable {
        let clientMessageId: String
        let message: String
        let files: [AgentFileRef]
    }

    private struct SteeringResponse: Decodable {
        let success: Bool?
        let messageId: String?
        let duplicate: Bool?
        let turnId: String?
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
                            projectId: currentProjectId,
                            resume: .init(approve: approve,
                                          fallbackModelId: approve ? nil : fallback))
        startDirectTurn(body)
    }

    func send(_ raw: String, isAutoContinue: Bool = false, askCardId: String? = nil, autoContinueFromTurnId: String? = nil) {
        if !isAutoContinue {
            autoContinueCount = 0
            pendingAutoContinue = false
            pendingAutoContinueTurnId = nil
        }   // manual message resets the budget and cancels a queued machine turn
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let structuredAutoContinue = isAutoContinue && autoContinueFromTurnId != nil
        if !structuredAutoContinue, pendingAttachmentSend != nil {
            errorToast = "আগের attachment-সহ বার্তাটি প্রস্তুত হচ্ছে — লেখা ও ফাইল নিরাপদ আছে"
            return
        }
        if !structuredAutoContinue, pendingFiles.contains(where: { $0.state == .failed }) {
            errorToast = "ব্যর্থ attachment-টি Retry বা Remove না করা পর্যন্ত Send হবে না"
            AlmaAgentHaptics.warning()
            return
        }
        let attachmentIds = structuredAutoContinue ? [] : pendingFiles.map(\.id)
        let readyPendingFiles = pendingFiles.filter {
            if case .ready = $0.state { return true } else { return false }
        }
        let readyFiles: [AgentFileRef] = readyPendingFiles.compactMap {
            if case .ready(let ref) = $0.state { return ref } else { return nil }
        }
        guard !text.isEmpty || !pendingFiles.isEmpty || structuredAutoContinue else { return }
        if !structuredAutoContinue, readyPendingFiles.count != pendingFiles.count {
            let clientMessageId = UUID().uuidString
            pendingAttachmentSend = .init(
                clientMessageId: clientMessageId, conversationId: conversationId,
                sessionIdentity: selectedSessionIdentity, text: text,
                attachmentIds: attachmentIds, askCardId: askCardId, createdAt: Date())
            upsertLocalOwnerIntent(
                clientMessageId: clientMessageId, text: text, files: readyFiles,
                attachmentIds: attachmentIds, state: .waitingForAttachments)
            errorToast = "Attachment upload হচ্ছে — শেষ হলেই এই বার্তাটি পাঠানো হবে"
            AlmaAgentTickHaptic.ownerSend()
            AlmaTurnLog.event("turn.waitingForAttachments", "count=\(attachmentIds.count)")
            return
        }
        let clientMessageId = structuredAutoContinue ? nil : UUID().uuidString
        if isStreaming || recoverableTurn != nil {
            guard !structuredAutoContinue else { return }
            queueOwnerMessage(text: text, files: readyFiles, askCardId: askCardId,
                              sentPendingIds: [], clientMessageId: clientMessageId,
                              attachmentIds: attachmentIds)
            return
        }
        startPreparedTurn(text: text, files: readyFiles,
                          localImages: readyPendingFiles.compactMap(\.image),
                          isAutoContinue: isAutoContinue, askCardId: askCardId,
                          autoContinueFromTurnId: autoContinueFromTurnId,
                          clientMessageId: clientMessageId,
                          attachmentIds: attachmentIds)
    }

    private func queueOwnerMessage(text: String, files: [AgentFileRef], askCardId: String?,
                                   sentPendingIds: Set<UUID>,
                                   clientMessageId: String? = nil,
                                   attachmentIds: [UUID] = []) {
        let intentId = clientMessageId ?? UUID().uuidString
        let queued = QueuedOwnerMessage(
            id: intentId, conversationId: conversationId,
            newConversationClientMessageId: conversationId == nil
                ? (currentClientMessageId ?? recoverableTurn?.clientMessageId) : nil,
            text: text,
            files: files, attachmentIds: attachmentIds,
            askCardId: askCardId, createdAt: Date(),
            sessionIdentity: conversationId == nil ? selectedSessionIdentity : nil)
        queuedOwnerMessages.append(queued)
        let queuedAttachmentIds = Set(attachmentIds)
        pendingFiles.removeAll {
            sentPendingIds.contains($0.id) || queuedAttachmentIds.contains($0.id)
        }
        upsertLocalOwnerIntent(
            clientMessageId: intentId, text: text, files: files,
            attachmentIds: attachmentIds, state: .queued)
        // Send means accepted by the local durable queue: clear the composer at
        // once. The visible owner bubble carries the queued state separately.
        if composerDraft.trimmingCharacters(in: .whitespacesAndNewlines) == text {
            composerDraft = ""
        }
        errorToast = "বার্তাটি চলতি কাজে যোগ হচ্ছে"
        AlmaAgentTickHaptic.ownerSend()
        AlmaTurnLog.event("turn.ownerMessageQueued", "count=\(queuedOwnerMessages.count)")
        Task { [weak self] in await self?.submitQueuedSteeringIfPossible() }
    }

    /// Persist queued follow-ups against the active server turn. The unique
    /// clientMessageId makes retries safe; only a 2xx removes the local fallback.
    private func submitQueuedSteeringIfPossible() async {
        guard isStreaming, let turnId = currentTurnId, let cid = conversationId else { return }
        let eligible = queuedOwnerMessages.filter { queued in
            queued.conversationId == cid && !steeringSubmissions.contains(queued.id)
        }
        for queued in eligible {
            guard isStreaming, currentTurnId == turnId, conversationId == cid else { return }
            steeringSubmissions.insert(queued.id)
            defer { steeringSubmissions.remove(queued.id) }
            do {
                let response: SteeringResponse = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/turn/\(turnId)/steer",
                    body: SteeringBody(clientMessageId: queued.id,
                                       message: queued.text, files: queued.files))
                guard response.success == true else { continue }
                queuedOwnerMessages.removeAll { $0.id == queued.id }
                for index in messages.indices where messages[index].clientMessageId == queued.id {
                    messages[index].outgoingState = .accepted
                }
                let ids = Set(queued.attachmentIds ?? [])
                if !ids.isEmpty { removeAttachmentCacheFiles(ids) }
                AlmaTurnLog.event("turn.ownerSteeringAccepted", queued.id)
            } catch {
                // The turn may have settled between the local tap and this POST.
                // Keep the durable local item; terminal drain starts one ordinary
                // follow-up turn so the owner's instruction is still never lost.
                AlmaTurnLog.event("turn.ownerSteeringDeferred", "\(error)")
            }
        }
    }

    private func startPreparedTurn(text: String, files: [AgentFileRef], localImages: [UIImage] = [],
                                   isAutoContinue: Bool = false, askCardId: String? = nil,
                                   autoContinueFromTurnId: String? = nil,
                                   clientMessageId: String?, attachmentIds: [UUID] = []) {
        let structuredAutoContinue = isAutoContinue && autoContinueFromTurnId != nil
        guard !isStreaming, recoverableTurn == nil else { return }
        AlmaAgentTickHaptic.ownerSend()
        // A structured continuation is server control state, not a new owner
        // message. Rendering a bubble here was the native-only duplicate-turn bug.
        if !structuredAutoContinue {
            let intentId = clientMessageId ?? UUID().uuidString
            upsertLocalOwnerIntent(
                clientMessageId: intentId, text: text, files: files,
                attachmentIds: attachmentIds, state: .submitting)
            if let index = messages.firstIndex(where: { $0.clientMessageId == intentId }),
               !localImages.isEmpty {
                messages[index].localImages = localImages
            }
        }
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
        currentClientMessageId = clientMessageId
        seqBox.value = -1
        sawTerminalEvent = false
        AlmaTurnLog.event("turn.submit", structuredAutoContinue
                          ? "auto-continuation:\(autoContinueFromTurnId!)"
                          : (clientMessageId ?? "manual"))
        ensureStreamingTail()

        let body = ChatBody(conversationId: conversationId, message: text,
                            files: files, modelId: modelId ?? "auto",
                            projectId: currentProjectId,
                            clientMessageId: clientMessageId, askCardId: askCardId,
                            autoContinueFromTurnId: autoContinueFromTurnId)
        if let clientMessageId {
            // Persist BEFORE starting network work. Process death between POST and
            // conversation_id/turn_id can now replay the exact idempotent request.
            recoverableTurn = RecoverableTurn(
                conversationId: conversationId, turnId: nil,
                clientMessageId: clientMessageId, lastSeq: -1, startedAt: Date(),
                message: text, files: files, modelId: modelId ?? "auto",
                projectId: currentProjectId, askCardId: askCardId,
                attachmentIds: attachmentIds,
                sessionIdentity: selectedSessionIdentity)
        }
        startDirectTurn(body)
    }

    private func scheduleQueuedOwnerMessage() {
        Task { [weak self] in
            await Task.yield()
            self?.drainQueuedOwnerMessageIfPossible()
        }
    }

    /// Bind only follow-ups belonging to THIS first send when the server reveals
    /// its newly-created conversation id. Other nil-scoped queues remain parked
    /// instead of leaking into whichever chat happens to be open next.
    private func bindQueuedOwnerMessages(to conversationId: String,
                                         clientMessageId: String?) {
        guard let clientMessageId else { return }
        for index in queuedOwnerMessages.indices
        where queuedOwnerMessages[index].conversationId == nil
            && queuedOwnerMessages[index].newConversationClientMessageId == clientMessageId {
            queuedOwnerMessages[index].conversationId = conversationId
        }
    }

    private func adoptNewConversationId(_ id: String) {
        let previousDraftKey = composerDraftKey
        bindQueuedOwnerMessages(
            to: id,
            clientMessageId: currentClientMessageId ?? recoverableTurn?.clientMessageId)
        conversationId = id
        migrateComposerDraft(from: previousDraftKey, to: composerDraftKey)
        if var pendingAttachmentSend,
           pendingAttachmentSend.sessionIdentity == selectedSessionIdentity {
            pendingAttachmentSend.conversationId = id
            self.pendingAttachmentSend = pendingAttachmentSend
        }
    }

    private func drainQueuedOwnerMessageIfPossible() {
        let activeNewConversationSendId = currentClientMessageId ?? recoverableTurn?.clientMessageId
        guard !isStreaming, recoverableTurn == nil,
              let index = queuedOwnerMessages.firstIndex(where: {
                  if let queuedConversationId = $0.conversationId {
                      return queuedConversationId == conversationId
                  }
                  guard conversationId == nil else { return false }
                  if let queuedSessionIdentity = $0.sessionIdentity {
                      return queuedSessionIdentity == selectedSessionIdentity
                  }
                  return $0.newConversationClientMessageId == activeNewConversationSendId
              }) else { return }
        let queued = queuedOwnerMessages.remove(at: index)
        startPreparedTurn(text: queued.text, files: queued.files,
                          askCardId: queued.askCardId,
                          clientMessageId: queued.id,
                          attachmentIds: queued.attachmentIds ?? [])
    }

    private func startDirectTurn(_ body: ChatBody) {
        let generation = UUID()
        let sessionIdentity = selectedSessionIdentity
        streamTaskGeneration = generation
        streamTask = Task { [weak self] in
            await self?.runTurn(body: body, generation: generation,
                                sessionIdentity: sessionIdentity)
        }
    }

    private func ownsDirectTurn(generation: UUID, sessionIdentity: String) -> Bool {
        streamTaskGeneration == generation && selectedSessionIdentity == sessionIdentity
    }

    /// Pure policy seam used by the native regression suite. A network task ending
    /// is transport state; only a typed terminal event is agent-turn state.
    static func directStreamEndRequiresRecovery(sawTerminalEvent: Bool) -> Bool {
        !sawTerminalEvent
    }

    private func runTurn(body: ChatBody, generation: UUID,
                         sessionIdentity: String) async {
        var handedToRecovery = false
        defer {
            let stillOwnsDirectTransport = streamTaskGeneration == generation
            if !handedToRecovery, stillOwnsDirectTransport {
                isStreaming = false
                thinkingLive = false
                settleLiveMode()
                if let i = messages.lastIndex(where: { $0.isStreaming }) { messages[i].isStreaming = false }
                scheduleQueuedOwnerMessage()
            }
            if stillOwnsDirectTransport {
                streamTask = nil
                streamTaskGeneration = nil
            }
            durableHandoffGenerations.remove(generation)
        }
        // Phase 2: one buffer per turn — deltas coalesce off-main and land as
        // batched reducer applies (roadmap 2.3).
        let buffer = AgentEventBuffer { [weak self] evs in self?.apply(evs) }
        do {
            await AlmaAPI.shared.syncCookies()
            var req = URLRequest(url: AssistantNet.base.appendingPathComponent("/api/assistant/chat"))
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            #if DEBUG
            if AlmaMergeReadinessURLProtocol.scenario == "attachmentAtomic" {
                req.setValue(String(body.files.count), forHTTPHeaderField: "X-ALMA-Fixture-File-Count")
                req.setValue(body.files.first?.path ?? "", forHTTPHeaderField: "X-ALMA-Fixture-File-Path")
                req.setValue(body.clientMessageId ?? "", forHTTPHeaderField: "X-ALMA-Fixture-Client-Message")
            }
            #endif
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
                guard ownsDirectTurn(generation: generation, sessionIdentity: sessionIdentity) else {
                    throw CancellationError()
                }
                // A continuation has already been atomically claimed by the
                // direct /chat route. The legacy worker handoff requires a
                // user message and would turn this control action into a second
                // owner-authored job, so never fall back by inventing one.
                if body.autoContinueFromTurnId != nil {
                    throw WatchdogTimeout()
                }
                try await runWorkerFallback(body: body, buffer: buffer)
            } catch AlmaAPIError.notAuthenticated {
                guard ownsDirectTurn(generation: generation, sessionIdentity: sessionIdentity) else {
                    throw CancellationError()
                }
                // One cookie refresh + retry, mirroring AlmaAPI.perform. The retry
                // carries the SAME clientMessageId — if the first attempt secretly
                // created the turn, the server answers 202 duplicate (caught below).
                AlmaAPI.shared.invalidateCookieCache()
                await AlmaAPI.shared.syncCookies()
                guard ownsDirectTurn(generation: generation, sessionIdentity: sessionIdentity) else {
                    throw CancellationError()
                }
                try await AssistantNet.streamEvents(request: req, buffer: buffer)
            }
            // Cancellation is cooperative. A socket may return normally just after
            // durable replay took ownership; the old generation must not finalize
            // or settle beside its successor.
            guard ownsDirectTurn(generation: generation, sessionIdentity: sessionIdentity) else {
                handedToRecovery = durableHandoffGenerations.remove(generation) != nil
                return
            }
            // A clean socket EOF is not proof that the agent turn completed. In
            // practice the POST stream can be closed by a proxy while the server
            // keeps running and persists the final reply a little later. Treating
            // that EOF as success used to settle the loader, clear the durable
            // descriptor, and leave the reply invisible until navigation caused a
            // history reload. Only a typed done/error event may finalize directly;
            // every other EOF is handed to the existing status + durable replay
            // recovery owner.
            guard !Self.directStreamEndRequiresRecovery(sawTerminalEvent: sawTerminalEvent) else {
                handedToRecovery = true
                handoffUnexpectedStreamEnd(
                    generation: generation,
                    sessionIdentity: sessionIdentity,
                    trigger: "direct-eof-without-terminal")
                return
            }
            // Server truth (final card ids/statuses, tool rows, cost) merges into the
            // tail in place — never a wholesale replace (prose must not blink).
            guard await finalizeTurn(expectedGeneration: generation,
                                     expectedSessionIdentity: sessionIdentity) else {
                handedToRecovery = recoverableTurn != nil
                return
            }
            AlmaTurnLog.event("turn.terminal", "stream-done")
            fireAutoContinueIfNeeded()
        } catch is CancellationError {
            // stopStreaming already owns visible settlement. A conversation switch
            // must never let this cancelled OLD task finalize against the newly
            // selected mutable conversationId. Preserve only a deliberately
            // recoverable server turn; explicit Stop clears it before cancelling.
            let transportWasHandedOff = durableHandoffGenerations.remove(generation) != nil
            handedToRecovery = transportWasHandedOff || recoverableTurn != nil
            AlmaTurnLog.event("turn.streamCancelled", handedToRecovery ? "preserved" : "stopped")
        } catch let dup as AssistantNet.DuplicateTurn {
            guard ownsDirectTurn(generation: generation, sessionIdentity: sessionIdentity) else {
                durableHandoffGenerations.remove(generation)
                handedToRecovery = true
                return
            }
            // A retry raced an EXISTING turn (Phase 3 idempotency) — observe it,
            // never re-run (roadmap invariant 2).
            AlmaTurnLog.event("turn.duplicateObserved", dup.turnId)
            currentTurnId = dup.turnId
            if conversationId == nil, let duplicateConversationId = dup.conversationId {
                adoptNewConversationId(duplicateConversationId)
            }
            if var descriptor = recoverableTurn {
                descriptor.conversationId = conversationId
                descriptor.turnId = dup.turnId
                recoverableTurn = descriptor
                markOutgoingAccepted(clientMessageId: descriptor.clientMessageId)
            }
            do {
                try await tailDurableTurn(dup.turnId, afterSeq: -1, buffer: buffer)
                guard !Self.directStreamEndRequiresRecovery(sawTerminalEvent: sawTerminalEvent) else {
                    handedToRecovery = true
                    handoffUnexpectedStreamEnd(
                        generation: generation,
                        sessionIdentity: sessionIdentity,
                        trigger: "duplicate-tail-eof-without-terminal")
                    return
                }
                guard ownsDirectTurn(generation: generation, sessionIdentity: sessionIdentity),
                      await finalizeTurn(expectedGeneration: generation,
                                         expectedSessionIdentity: sessionIdentity) else {
                    handedToRecovery = true
                    return
                }
            } catch {
                guard !Task.isCancelled,
                      ownsDirectTurn(generation: generation,
                                     sessionIdentity: sessionIdentity) else {
                    handedToRecovery = durableHandoffGenerations.remove(generation) != nil
                        || recoverableTurn != nil
                    return
                }
                handedToRecovery = true
                reconnecting = true
                ensureStreamingTail()
                Task { [weak self] in await self?.recoverTurnState(trigger: "duplicate-tail-drop") }
            }
        } catch AlmaAPIError.notAuthenticated {
            guard ownsDirectTurn(generation: generation, sessionIdentity: sessionIdentity) else {
                durableHandoffGenerations.remove(generation)
                handedToRecovery = true
                return
            }
            authExpired = true
        } catch {
            if !ownsDirectTurn(generation: generation, sessionIdentity: sessionIdentity) {
                durableHandoffGenerations.remove(generation)
                handedToRecovery = true
                AlmaTurnLog.event("turn.streamCancelled", "durable-generation-handoff")
                return
            }
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
                    // The response may have dropped before the server returned its
                    // conversation/turn ids. The pre-POST descriptor + idempotency
                    // key is still the only truth; settle visibly but preserve it.
                    handedToRecovery = true
                    await failRecovery(
                        preserveDescriptor: true,
                        message: "সংযোগ পাওয়া যাচ্ছে না — বার্তাটি সুরক্ষিত আছে, পরে আবার যাচাই হবে")
                }
            case .authentication:
                authExpired = true
            case .server(let status):
                // A 5xx can arrive after the server accepted the idempotency key,
                // so it remains acceptance-unknown and is reconciled/retried with
                // that same key. A 4xx is a definite rejection and may expose the
                // normal failed-message actions.
                await failRecovery(
                    preserveDescriptor: status >= 500,
                    message: status >= 500
                        ? "Server status নিশ্চিত নয় — বার্তাটি নিরাপদ আছে, আবার যাচাই করুন"
                        : kind.banglaMessage)
            case .terminalAgentError:
                await failRecovery(preserveDescriptor: false, message: kind.banglaMessage)
            }
        }
    }

    /// Release the direct transport before asking recovery to attach. The yield is
    /// intentional: it lets `runTurn` unwind first, preventing the recovery tail
    /// from cancelling the task that is currently handing ownership over.
    private func handoffUnexpectedStreamEnd(generation: UUID,
                                            sessionIdentity: String,
                                            trigger: String) {
        guard ownsDirectTurn(generation: generation, sessionIdentity: sessionIdentity) else { return }
        AlmaTurnLog.event("turn.streamEOFWithoutTerminal", trigger)
        streamTask = nil
        streamTaskGeneration = nil
        if conversationId == nil {
            // Pre-ID recovery replays the exact persisted idempotent request. It is
            // a durable queued intent, not an endlessly spinning anonymous turn.
            isStreaming = false
            thinkingLive = false
            settleLiveMode()
            if let i = messages.lastIndex(where: { $0.isStreaming }) {
                messages[i].isStreaming = false
            }
            var delay: TimeInterval?
            if var descriptor = recoverableTurn {
                let attempt = (descriptor.preTurnEOFRetryCount ?? 0) + 1
                descriptor.preTurnEOFRetryCount = attempt
                if let seconds = Self.preTurnEOFRetryDelay(for: attempt) {
                    descriptor.preTurnRetryNotBefore = Date().addingTimeInterval(seconds)
                    delay = seconds
                } else {
                    descriptor.preTurnRetryNotBefore = nil
                }
                recoverableTurn = descriptor
                AlmaTurnLog.event("turn.preIdEOFRetry", "\(attempt)/\(Self.maxPreTurnEOFRetries)")
            }
            guard let delay else {
                Task { [weak self] in
                    await self?.failRecovery(
                        preserveDescriptor: true,
                        ownerRetryable: true,
                        message: "Server গ্রহণ নিশ্চিত করা যায়নি — বার্তাটি নিরাপদ আছে, Retry করুন")
                }
                return
            }
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled else { return }
                await self?.recoverTurnState(trigger: "pre-id-eof-retry")
            }
            return
        } else {
            reconnecting = true
            isStreaming = true
            thinkingLive = true
            ensureStreamingTail()
            requestLiveMode("thinking")
        }
        Task { [weak self] in
            await Task.yield()
            await self?.recoverTurnState(trigger: "stream-eof")
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
        if conversationId == nil, let enqueuedConversationId = enq.conversationId {
            adoptNewConversationId(enqueuedConversationId)
        }
        if let cid = conversationId, let cmid = body.clientMessageId {
            var descriptor = recoverableTurn ?? RecoverableTurn(
                conversationId: cid, turnId: enq.turnId,
                clientMessageId: cmid, lastSeq: -1, startedAt: Date(),
                sessionIdentity: selectedSessionIdentity)
            descriptor.conversationId = cid
            descriptor.turnId = enq.turnId
            recoverableTurn = descriptor
            markOutgoingAccepted(clientMessageId: cmid)
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
                adoptNewConversationId(id)
                if var rt = recoverableTurn {
                    rt.conversationId = id
                    recoverableTurn = rt
                    markOutgoingAccepted(clientMessageId: rt.clientMessageId)
                }
            case .turnId(let id):
                currentTurnId = id
                // PR 5: the turn is now addressable — persist the recovery descriptor
                // so even process death can find its way back.
                if let cid = conversationId, let cmid = currentClientMessageId {
                    var descriptor = recoverableTurn ?? RecoverableTurn(
                        conversationId: cid, turnId: id, clientMessageId: cmid,
                        lastSeq: seqBox.value, startedAt: Date(),
                        sessionIdentity: selectedSessionIdentity)
                    descriptor.conversationId = cid
                    descriptor.turnId = id
                    descriptor.lastSeq = seqBox.value
                    descriptor.sessionIdentity = selectedSessionIdentity
                    recoverableTurn = descriptor
                    markOutgoingAccepted(clientMessageId: cmid)
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
                    // Pre-tool prose is progress narration. Keep the activity/tool
                    // evidence, but let the post-tool settled answer replace the
                    // visible prose instead of stacking as a second reply.
                    messages[i].text = ""
                    messages[i].blocks.removeAll { block in
                        if case .prose = block { return true }
                        return false
                    }
                    messages[i].supersededBlockIds = []
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
                // Preserve the rejected draft in audit data, but remove it from the
                // owner-facing blocks. The verified replacement will be the only
                // prose rendered when its text deltas arrive.
                requestLiveMode("thinking")
                ensureStreamingTail()
                if let i = messages.lastIndex(where: { $0.isStreaming }) {
                    if let lastProse = messages[i].blocks.last(where: {
                        if case .prose = $0 { return true }; return false
                    }), case .prose(let pid, let draft) = lastProse {
                        messages[i].supersededBlockIds.insert(pid)
                        messages[i].timeline.append(.text(draft, superseded: true))
                    }
                    messages[i].text = ""
                    messages[i].blocks.removeAll { block in
                        if case .prose = block { return true }
                        return false
                    }
                    messages[i].supersededBlockIds = []
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
                // follow it, and migrate every queued follow-up/recovery descriptor
                // so terminal drain cannot strand work under the predecessor id.
                let oldId = conversationId
                if let oldId {
                    for index in queuedOwnerMessages.indices
                    where queuedOwnerMessages[index].conversationId == oldId {
                        queuedOwnerMessages[index].conversationId = newId
                    }
                    if var rt = recoverableTurn, rt.conversationId == oldId {
                        rt.conversationId = newId
                        recoverableTurn = rt
                    }
                    conversationId = newId
                } else {
                    adoptNewConversationId(newId)
                }
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
                if conversationId == nil, let convId { adoptNewConversationId(convId) }
                if let clientMessageId = recoverableTurn?.clientMessageId {
                    markOutgoingAccepted(clientMessageId: clientMessageId)
                }
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
        if isStreaming, queuedOwnerMessageCount > 0 {
            Task { [weak self] in await self?.submitQueuedSteeringIfPossible() }
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
        streamTaskGeneration = nil
        // Conversation switch / Stop also ends any reconnect-recovery loop; server
        // work is only cancelled when explicitly asked (roadmap invariant 9).
        recoveryTask?.cancel()
        recoveryTask = nil
        reconnecting = false
        if cancelServer {
            // Explicit Stop is authoritative even before conversation_id/turn_id.
            // Never resurrect that pre-ID request on relaunch.
            recoverableTurn = nil
            currentClientMessageId = nil
            durableHandoffGenerations.removeAll()
            if let tid = currentTurnId {
                Task {
                    let _: OkResponse? = try? await AlmaAPI.shared.send(
                        "POST", "/api/assistant/turn/\(tid)/cancel")
                }
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
        scheduleQueuedOwnerMessage()
    }

    // ── Phase 0 stress fixture (roadmap) ───────────────────────────────────

    #if DEBUG
    /// Gate 1 proof: make a real local image transaction, immediately press Send
    /// while its mocked upload is still delayed, then let the normal VM bind and
    /// submit it. The URLProtocol rejects the chat request unless the file ref and
    /// stable clientMessageId arrive together.
    func runAttachmentAtomicFixture() {
        conversationId = nil
        selectedSessionIdentity = "fixture:attachment-atomic"
        conversationTitle = "ALMA AI"
        messages = []
        composerDraft = "এই ছবির স্টক গুনে দাও"
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 220, height: 150))
        let image = renderer.image { context in
            UIColor(red: 0.12, green: 0.18, blue: 0.30, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 220, height: 150))
            UIColor(red: 1.00, green: 0.43, blue: 0.31, alpha: 1).setFill()
            context.fill(CGRect(x: 28, y: 34, width: 164, height: 82))
        }
        attachImage(image)
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard let self else { return }
            self.send(self.composerDraft)
            AlmaTurnLog.event("attachment.atomic.waiting", "send-during-upload")
        }
    }
    #endif

    /// Local reproduction fixture — ALMA_ASSISTANT_FIXTURE=1. Builds 40 mixed
    /// rows (long/short Bangla + Banglish, interleaved thinking/tool/prose
    /// blocks, one 2,000+ char reply), then streams 1,000 small deltas into a
    /// live tail through the SAME mutation helpers the real SSE path uses — so
    /// scroll-gap and per-delta MainActor cost reproduce without a server.
    /// Parity roadmap visual fixture — ALMA_ASSISTANT_PARITY=1: ONLY the persisted
    /// verification-retry turn (no stress stream), decoded through the real wire
    /// path, so a screenshot proves progress/superseded drafts stay audit-only and
    /// exactly one corrected final prose remains visible with the activity/footer.
    func loadParityFixture() {
        // Simulator proof fixtures must be visually deterministic. Do not let an
        // unrelated persisted queue/dictation warning from an earlier recovery
        // journey cover the card or attachment state currently under review.
        queuedOwnerMessages = []
        dictationFailure = nil
        pendingFiles = []
        var rows: [AgentChatMessage] = []
        var fixtureOwner = AgentChatMessage(id: "fix-u-parity", role: .user,
                                            text: "স্টকের কাজটা কি হয়েছে?")
        fixtureOwner.createdAt = "2026-07-14T09:58:00.000Z"
        fixtureOwner.fileRefs = [
            .init(bucket: "agent-files", path: "fixture/stock-input.pdf", mediaType: "application/pdf"),
            .init(bucket: "agent-files", path: "fixture/showroom.jpg", mediaType: "image/jpeg"),
        ]
        rows.append(fixtureOwner)
        let parityJSON = #"""
        {"id":"fix-a-parity","role":"assistant",
         "content":[
           {"type":"text","text":"যাচাই করে দেখলাম — কাজটা তখনো হয়নি, এখন আসল স্টক আপডেট করে দিয়েছি।"},
           {"type":"confirm_card","pendingActionId":"fix-approval","summary":"ঈদ ক্যাম্পেইনের জন্য ৳৫,০০০ বাজেট অনুমোদন","status":"pending","actionType":"campaign_budget"},
           {"type":"ask_card","askCardId":"fix-ask","question":"কোন রিপোর্ট format দরকার Boss?","options":["PDF","Markdown","দুটোই"],"status":"pending"}],
         "tokensIn":105300,"tokensOut":2100,"cacheCreation":41000,"cacheRead":960000,
         "apiRounds":6,"roundCostsUsd":[0.03,0.03,0.03,0.03,0.03,0.033],"costUsd":0.183,
         "createdAt":"2026-07-14T10:00:00.000Z",
         "timeline":[
           {"t":"text","text":"আগে স্টকের অবস্থাটা দেখে নিচ্ছি…"},
           {"t":"tool","name":"get_inventory_status","ok":true},
           {"t":"tool","name":"live_browser_look","ok":true,"result":"পেজ দেখা হয়েছে","shot":"https://picsum.photos/seed/alma/900/560"},
           {"t":"file","id":"fix-artifact","name":"স্টক-অডিট.md","kind":"markdown"},
           {"t":"text","text":"কাজটা করে দিয়েছি Boss!","state":"superseded"},
           {"t":"verify","attempt":1,"max":2},
           {"t":"text","text":"যাচাই করে দেখলাম — কাজটা তখনো হয়নি, এখন আসল স্টক আপডেট করে দিয়েছি।"}]}
        """#
        if let d = parityJSON.data(using: .utf8),
           var wireRow = (try? JSONDecoder().decode(AgentMessageWire.self, from: d)).map(AgentChatMessage.from) {
            let singleReplyProof = ProcessInfo.processInfo.environment["ALMA_SINGLE_REPLY_PROOF"] == "1"
                || ProcessInfo.processInfo.arguments.contains("ALMA_SINGLE_REPLY_PROOF=1")
            if singleReplyProof {
                // Focused regression screenshot: keep the real three-round
                // persisted timeline, but remove unrelated action/delegation
                // cards so the one settled prose block fits in one viewport.
                wireRow.confirmCards = []
                wireRow.askCards = []
                wireRow.blocks.removeAll {
                    if case .confirmCard = $0 { return true }
                    if case .askCard = $0 { return true }
                    return false
                }
            }
            // Chat-parity batch demo state: delegation cards (done + running) so a
            // fixture screenshot proves the DelegationCard composition offline.
            if !singleReplyProof {
                wireRow.delegations = [
                    .init(id: "fix-d1", role: "researcher", roleLabel: "গবেষক",
                          task: "প্রতিযোগীদের ঈদ ক্যাম্পেইনের দাম যাচাই করো",
                          done: true, success: true,
                          summary: "তিনটা ব্র্যান্ড দেখা হয়েছে — গড় দাম ৳১,২৫০; আমাদের অফার প্রতিযোগিতামূলক।",
                          toolsUsed: ["web_research", "compare_to_brand"]),
                    .init(id: "fix-d2", role: "cs", roleLabel: "কাস্টমার সার্ভিস",
                          task: "WhatsApp inbox-এর নতুন প্রশ্নগুলোর খসড়া উত্তর"),
                ]
            }
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
        artifacts = [
            .init(id: "fix-artifact", messageId: "fix-a-parity", type: "markdown",
                  title: "স্টক-অডিট.md", content: "# স্টক অডিট\n\nযাচাই করা রিপোর্ট।",
                  version: 1, createdAt: "2026-07-14T10:00:00.000Z"),
            .init(id: "fix-generated-jpeg", messageId: "fix-a-parity", type: "jpeg",
                  title: "ALMA-campaign.jpg", content: "https://picsum.photos/seed/alma-library/900/700",
                  version: 1, createdAt: "2026-07-14T10:03:00.000Z"),
            .init(id: "fix-generated-pdf", messageId: "fix-a-parity", type: "pdf",
                  title: "স্টক-সারাংশ.pdf", content: "ALMA stock summary\n\nGenerated PDF fixture preview.",
                  version: 1, createdAt: "2026-07-14T10:04:00.000Z"),
            .init(id: "fix-plan-artifact", messageId: "fix-a-doc", type: "markdown",
                  title: "ঈদ-ক্যাম্পেইন-প্ল্যান.md", content: doc.text,
                  version: 1, createdAt: "2026-07-14T10:05:00.000Z"),
        ]
        messages = rows
    }

    /// Focused native reading-surface proof. It reproduces the owner's reported
    /// dense answer (tool trace + Bangla prose + Markdown table + code) without a
    /// network dependency, while exercising the same production message views.
    func loadReadingSurfaceFixture() {
        queuedOwnerMessages = []
        pendingFiles = []
        dictationFailure = nil
        var owner = AgentChatMessage(id: "reading-owner", role: .user,
                                     text: "Real-time voice API গুলোর দাম ও ভালো setup তুলনা করো")
        owner.createdAt = "2026-07-21T06:30:00.000Z"

        var answer = AgentChatMessage(id: "reading-answer", role: .assistant)
        answer.serverId = answer.id
        answer.createdAt = "2026-07-21T06:31:00.000Z"
        let prose = """
        ## সবচেয়ে practical setup

        Boss, বাংলা voice agent-এর জন্য **Deepgram STT → আপনার agent → Google TTS** সবচেয়ে ভারসাম্যপূর্ণ setup। এতে latency কম থাকে এবং provider বদলালেও conversation state ALMA-তেই থাকে।

        | API | আনুমানিক মূল্য | সবচেয়ে ভালো ব্যবহার |
        | --- | --- | --- |
        | Deepgram | ~$0.005/min | দ্রুত speech-to-text |
        | Google Cloud TTS | ~$0.000004/character | স্বাভাবিক বাংলা voice |
        | ElevenLabs | ~$0.015/min | premium expressive voice |

        > Live price বদলাতে পারে—production চালুর আগে provider dashboard থেকে আবার যাচাই করব।

        **প্রস্তাবিত flow**

        - ফোনের audio stream Deepgram-এ যাবে
        - transcript ALMA agent বুঝে উত্তর তৈরি করবে
        - Google TTS উত্তরটি স্বাভাবিক বাংলায় বলবে

        ```swift
        let pipeline = VoicePipeline(stt: .deepgram, tts: .google)
        try await pipeline.start(language: "bn-BD")
        ```
        """
        answer.text = prose
        answer.blocks = [
            .activity(.init(id: "reading-search", kind: .search,
                            label: "Searched available tools")),
            .activity(.init(id: "reading-tool", kind: .tool,
                            label: "live_browser_look", toolId: "reading-tool", ok: true)),
            .activity(.init(id: "reading-thought", kind: .thinking,
                            label: "Let me be honest about this.",
                            thinkFull: "Pricing claims need a fresh source check.")),
            .prose(id: "reading-prose", text: prose),
        ]
        answer.tools = [.init(id: "reading-tool", name: "live_browser_look", ok: true,
                              preview: nil, live: false, inputPretty: nil,
                              resultFull: "Voice provider pricing page checked.")]
        answer.tokensIn = 18800
        answer.tokensOut = 2100
        answer.cacheRead = 9600
        answer.apiRounds = 3
        answer.costUsd = "0.078765"
        messages = [owner, answer]
        conversationId = "fixture-reading-surface"
        conversationTitle = "Voice API comparison"
    }

    #if DEBUG
    /// Merge-readiness-only held stream. It uses the production composer/send
    /// queue path but never touches a server, so the simulator can prove that an
    /// owner follow-up becomes a visible, persisted queue entry while busy.
    func loadMergeReadinessQueueFixture() {
        loadParityFixture()
        conversationId = "fixture-conversation"
        isStreaming = true
        thinkingLive = true
        currentTurnId = "fixture-held-turn"
        ensureStreamingTail()
        if let i = messages.lastIndex(where: { $0.isStreaming }) {
            messages[i].thinking = "চলতি কাজ শেষ করছি…"
        }
    }

    /// Keeps the real parity approval and ask cards at the bottom of the
    /// transcript so deterministic 409/410/lost-response journeys can operate
    /// the actual production views without scrolling through the long fixture.
    func loadMergeReadinessActionFixture() {
        loadParityFixture()
        messages = Array(messages.prefix(2))
        let scenario = ProcessInfo.processInfo.environment["ALMA_MERGE_MOCK"]
            ?? ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("ALMA_MERGE_MOCK=") })?
                .replacingOccurrences(of: "ALMA_MERGE_MOCK=", with: "")
            ?? "default"
        let suffix = scenario.replacingOccurrences(of: "[^A-Za-z0-9_-]", with: "-",
                                                    options: .regularExpression)
        for messageIndex in messages.indices {
            messages[messageIndex].confirmCards = messages[messageIndex].confirmCards.map { card in
                .init(id: "fix-approval-\(suffix)", summary: card.summary, status: card.status,
                      actionType: card.actionType, costEstimate: card.costEstimate,
                      approvedAt: card.approvedAt)
            }
            messages[messageIndex].askCards = messages[messageIndex].askCards.map { card in
                .init(id: "fix-ask-\(suffix)", question: card.question, options: card.options,
                      status: card.status, selectedOption: card.selectedOption)
            }
            // Proof-only views keep one real production card on screen at a
            // time; normal action fixtures continue to exercise both together.
            if scenario == "approvalProof" {
                messages[messageIndex].askCards = []
            } else if scenario == "askProof" {
                messages[messageIndex].confirmCards = []
            }
        }
        conversationId = "fixture-conversation"
    }

    func loadMergeReadinessMultiApprovalFixture() {
        let json = #"""
        {"id":"fix-a-multi","role":"assistant","content":[
          {"type":"confirm_card","pendingActionId":"fix-approval-1","summary":"প্রথম অনুমোদন","status":"pending"},
          {"type":"confirm_card","pendingActionId":"fix-approval-2","summary":"দ্বিতীয় অনুমোদন","status":"pending"},
          {"type":"confirm_card","pendingActionId":"fix-approval-3","summary":"তৃতীয় অনুমোদন","status":"pending"}
        ]}
        """#
        if let data = json.data(using: .utf8),
           let row = (try? JSONDecoder().decode(AgentMessageWire.self, from: data)).map(AgentChatMessage.from) {
            messages = [row]
        }
        conversationId = "fixture-conversation"
    }

    /// Seeds the same durable descriptor and rich pending state a real running
    /// turn owns, then returns without networking so the process can be killed.
    /// Relaunch uses the turnRecovery URLProtocol scenario to reattach by turn id.
    func loadMergeReadinessRecoverySeed() {
        let json = #"""
        {"id":"fixture-recovery-assistant","role":"assistant","content":[
          {"type":"text","text":"স্টক sync চলছে…"},
          {"type":"confirm_card","pendingActionId":"fixture-recovery-approval","summary":"পুনরুদ্ধার হওয়া অনুমোদন","status":"pending"}
        ],"timeline":[
          {"t":"tool","id":"fixture-recovery-tool","name":"inventory_sync"}
        ]}
        """#
        var owner = AgentChatMessage(id: "fixture-recovery-owner", role: .user,
                                     text: "স্টক sync চালাও")
        owner.createdAt = "2026-07-20T12:00:00.000Z"
        messages = [owner]
        if let data = json.data(using: .utf8),
           var assistant = (try? JSONDecoder().decode(AgentMessageWire.self, from: data))
            .map(AgentChatMessage.from) {
            let tool = AgentChatMessage.Tool(
                id: "fixture-recovery-tool", name: "inventory_sync", ok: nil,
                preview: nil, live: true, inputPretty: nil, resultFull: nil)
            assistant.tools = [tool]
            assistant.phases = [.init(id: "fixture-recovery-phase", headline: "স্টক sync চলছে…",
                                      tools: [tool], live: true)]
            assistant.blocks.append(.activity(.init(
                id: "fixture-recovery-activity", kind: .tool,
                label: "inventory_sync", toolId: tool.id, live: true)))
            assistant.isStreaming = true
            messages.append(assistant)
        }
        conversationId = "fixture-recovery-conversation"
        currentTurnId = "fixture-recovery-turn"
        isStreaming = true
        thinkingLive = true
        currentClientMessageId = "fixture-recovery-client"
        recoverableTurn = RecoverableTurn(
            conversationId: conversationId, turnId: currentTurnId,
            clientMessageId: "fixture-recovery-client", lastSeq: 0,
            startedAt: Date(), message: "স্টক sync চালাও", files: [], modelId: "auto",
            sessionIdentity: selectedSessionIdentity)
    }

    func runMergeReadinessReconnect() async {
        lastLiveEventAt = .distantPast
        await recoverTurnState(trigger: "stall")
    }

    func runMergeReadinessOfflineSettle() async {
        lastLiveEventAt = .distantPast
        for _ in 0..<maxStatusRecoveryFailures {
            await recoverTurnState(trigger: "stall")
            if !isStreaming { break }
        }
    }

    /// Real send/stream path for the clean-EOF regression. The URLProtocol sends
    /// partial content and closes without done; production recovery must attach to
    /// the same durable turn and finish without navigation or relaunch.
    func runUnexpectedStreamEOFFixture() {
        queuedOwnerMessages = []
        dictationFailure = nil
        pendingFiles = []
        messages = []
        conversationId = nil
        composerDraft = ""
        send("আজকের স্টক রিপোর্ট দাও")
    }
    #endif

    func loadDebugFixture() {
        let bnShort = "ঠিক আছে Boss, এটা এখনই দেখছি।"
        let bnLong = "আজকের সেলস রিপোর্ট অনুযায়ী ALMA Lifestyle-এর মোট বিক্রি ভালো হয়েছে। Facebook ক্যাম্পেইনের CTR বেড়েছে, আর নতুন কালেকশনের প্রি-অর্ডারও আসছে। কালকে সকালে স্টাফ মিটিংয়ে inventory নিয়ে কথা বলা দরকার — তিনটা প্রোডাক্টের স্টক কমে যাচ্ছে। "
        var rows: [AgentChatMessage] = []
        for i in 0..<38 {
            if i % 2 == 0 {
                let u = AgentChatMessage(id: "fix-u-\(i)", role: .user,
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

        // Persisted verification-retry turn decoded through the real wire path:
        // raw draft remains in timeline, but only one corrected prose is visible.
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

    /// Gate 8 deterministic fixture: six hundred logical rich rows with only a
    /// fixed-size middle window mounted. It exercises cache promotion, search
    /// targeting, a 60k-character response and media rows without touching the
    /// server. Available only to local DEBUG Simulator launches.
    func loadHugeSessionFixture(logicalCount: Int = 600) {
        let started = Date()
        // A DEBUG fixture must be independent of whatever durable turn the same
        // Simulator exercised immediately before it. Otherwise a persisted
        // recovery descriptor correctly blocks history promotion and makes this
        // deterministic Gate 8 fixture order-dependent.
        streamTask?.cancel()
        streamTask = nil
        streamTaskGeneration = nil
        recoveryTask?.cancel()
        recoveryTask = nil
        recoverableTurn = nil
        currentClientMessageId = nil
        currentTurnId = nil
        reconnecting = false
        isStreaming = false
        thinkingLive = false
        let rowCount = max(600, logicalCount)
        let sentence = "ALMA সেশন যাচাই: বিক্রয়, স্টক, approval, generated file এবং follow-up একই ক্রমে রাখা হয়েছে। "
        var rows: [AgentChatMessage] = []
        rows.reserveCapacity(rowCount)
        for index in 0..<rowCount {
            if index % 2 == 0 {
                rows.append(AgentChatMessage(
                    id: "huge-u-\(index)", role: .user,
                    text: "সেশন বার্তা \(index): আগের কাজের exact অবস্থা দেখাও।"))
            } else {
                var reply = AgentChatMessage(
                    id: "huge-a-\(index)", role: .assistant,
                    text: index == 301 ? String(repeating: sentence, count: 700) : String(repeating: sentence, count: 2))
                if index % 17 == 1 {
                    reply.timeline = [.tool(id: "huge-tool-\(index)", name: "get_session_state", ok: true,
                                            live: false, inputPretty: nil, resultFull: nil, shot: nil)]
                }
                rows.append(reply)
            }
        }
        conversationId = "fixture-huge-session"
        selectedSessionIdentity = "server:fixture-huge-session"
        conversationTitle = "Huge session proof"
        let middleStart = (rows.count - Self.mountedHistoryLimit) / 2
        let middleEnd = middleStart + Self.mountedHistoryLimit
        olderHistoryCache = Array(rows[..<middleStart])
        messages = Array(rows[middleStart..<middleEnd])
        newerHistoryCache = Array(rows[middleEnd...])
        serverHasOlder = false
        canLoadOlder = true
        isStreaming = false
        trimHistoryCaches()
        AlmaTurnLog.event(
            "hugeSession.ready",
            "logical=\(rows.count) mounted=\(messages.count) indexed=\(searchableMessages.count) giant=\(rows[301].text.count) ms=\(Int(Date().timeIntervalSince(started) * 1000))")
    }

    /// Gate 5 relaunch fixture. The bytes are intentionally not valid speech: the
    /// proof surface is the durable recovery contract (draft + audio + Retry),
    /// while the real transcription request remains covered by the upload path.
    func loadDictationRecoveryFixture() {
        loadParityFixture()
        composerDraft = "এই draft-টি voice retry-এর পরও থাকবে"
        do {
            try Data(repeating: 0x41, count: 4_096).write(to: recordingURL, options: .atomic)
            dictationFailure = "ভয়েস বোঝা যায়নি — রেকর্ডিং রাখা আছে"
            AlmaTurnLog.event("dictation.fixture", "durable-retry-ready")
        } catch {
            errorToast = "Dictation fixture তৈরি করা যায়নি"
        }
    }

    #if DEBUG
    var debugSelectedSessionIdentity: String { selectedSessionIdentity }
    var debugShouldRestoreProvisionalSession: Bool { shouldRestoreProvisionalSession }
    func debugRestoreComposerDraft() { restoreCurrentComposerDraft() }
    func debugRestoreDurableDictationRecovery() { restoreDurableDictationRecoveryIfNeeded() }
    func debugSetActiveBackgroundConversation(_ id: String) {
        activeBackgroundTurns = [.init(
            id: "debug-background-turn", conversationId: id,
            conversationTitle: "Background", kind: "owner", input: "work",
            startedAt: "2026-07-20T00:00:00Z", updatedAt: nil)]
    }

    /// More rows than the reversible in-memory forward cache can hold. The
    /// excess intentionally represents rows recoverable from the server `after`
    /// cursor; the debug assertions prove the mount stays bounded and the forward
    /// affordance remains available rather than silently declaring end-of-chat.
    func loadHistoryCacheOverflowFixture() {
        let rows = (0..<500).map {
            AgentChatMessage(id: "overflow-\($0)", role: $0.isMultiple(of: 2) ? .user : .assistant,
                             text: "row \($0)")
        }
        conversationId = "fixture-cache-overflow"
        selectedSessionIdentity = "server:fixture-cache-overflow"
        olderHistoryCache = []
        messages = Array(rows.prefix(Self.mountedHistoryLimit))
        newerHistoryCache = Array(rows.dropFirst(Self.mountedHistoryLimit))
        serverHasNewer = false
        trimHistoryCaches()
    }
    #endif

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
            // The draft is retained as audit data but removed from visible prose;
            // the truthful verify row remains before the corrected final.
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

        // Presentation parity — persisted wire keeps the raw prose/verify audit
        // entries, while owner-facing blocks contain exactly one settled prose.
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
            check("RC-3 single-reply block fingerprint",
                  fingerprint == ["search", "tool", "think", "prose"])
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
            let m = AgentChatMessage(id: "unittest-\(UUID().uuidString)", role: .assistant,
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
    /// Server-authoritative terminal status also covers cards outside the mounted
    /// 24-row history window (Pending Tasks is an independent endpoint).
    private var confirmTerminalStatus: [String: String] = [:]

    @discardableResult
    func approveAction(_ cardId: String, approve: Bool) async -> Bool {
        // A very fast first response can finish between the two events of a
        // physical double-tap. The in-flight set blocks overlap; this terminal
        // guard blocks the immediately-following second mutation as well.
        if let knownStatus = currentConfirmStatus(cardId),
           ["approved", "executed", "rejected", "expired", "cancelled"].contains(knownStatus) {
            return true
        }
        guard beginSubmitting("action:\(cardId)") else { return false }
        defer { finishSubmitting("action:\(cardId)") }
        AlmaAgentHaptics.commit()
        let summary = messages
            .flatMap(\.confirmCards)
            .first(where: { $0.id == cardId })?
            .summary.split(separator: "\n").first.map(String.init) ?? ""
        do {
            let _: OkResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/actions/\(cardId)/\(approve ? "approve" : "reject")")
            if approve { confirmApprovedAt[cardId] = Date() }
            setConfirmStatus(cardId, approve ? "approved" : "rejected")
            AlmaAgentHaptics.success()
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
                return true
            }
        } catch {
            return await reconcileActionFailure(cardId: cardId, error: error)
        }
        await loadMessages()
        return true
    }

    private func currentConfirmStatus(_ cardId: String) -> String? {
        actionRegistry[cardId].map { record in
            record.state == .accepted || record.state == .executing ? "approved" : record.state.rawValue
        }
            ?? confirmTerminalStatus[cardId]
            ?? messages.lazy.flatMap(\.confirmCards).first(where: { $0.id == cardId })?.status
    }

    private func serverConfirmStatus(_ cardId: String) -> String? {
        confirmTerminalStatus[cardId]
            ?? messages.lazy.flatMap(\.confirmCards).first(where: { $0.id == cardId })?.status
    }

    private func statusFromErrorBody(_ body: String) -> String? {
        guard let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json["status"] as? String
    }

    private func selectedOptionFromErrorBody(_ body: String) -> String? {
        guard let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json["selectedOption"] as? String
    }

    /// A lost response is not proof that a mutation failed. Re-read server truth
    /// before deciding whether the card remains actionable. 409 and 410 receive
    /// explicit terminal presentation instead of a generic transient toast.
    @discardableResult
    private func reconcileActionFailure(cardId: String, error: Error) async -> Bool {
        setActionState(cardId, kind: "approval", state: .checking)
        if case AlmaAPIError.http(let status, let body) = error {
            if status == 410 {
                setConfirmStatus(cardId, "expired")
                await loadMessages()
                errorToast = "এই অনুমোদনের মেয়াদ শেষ হয়েছে"
                AlmaAgentHaptics.warning()
                return true
            }
            if status == 409 {
                if let serverStatus = statusFromErrorBody(body), serverStatus != "pending" {
                    setConfirmStatus(cardId, serverStatus)
                }
                await loadMessages()
                if let resolved = serverConfirmStatus(cardId), resolved != "pending" {
                    errorToast = resolved == "expired"
                        ? "এই অনুমোদনের মেয়াদ শেষ হয়েছে"
                        : "সিদ্ধান্তটি আগেই সংরক্ষিত হয়েছে"
                    AlmaAgentHaptics.selection()
                    return true
                }
                errorToast = "সার্ভারের অবস্থা বদলেছে — কার্ডটি রেখে আবার যাচাই করুন"
                AlmaAgentHaptics.warning()
                return false
            }
        }
        await loadMessages()
        if let resolved = serverConfirmStatus(cardId), resolved != "pending" {
            errorToast = "সিদ্ধান্তটি সার্ভারে সংরক্ষিত ছিল — অবস্থা মিলিয়ে নেওয়া হয়েছে"
            AlmaAgentHaptics.selection()
            return true
        }
        errorToast = "সিদ্ধান্ত নিশ্চিত করা যায়নি — কার্ডটি রাখা হয়েছে, আবার চেষ্টা করুন"
        setActionState(cardId, kind: "approval", state: .failed)
        AlmaAgentHaptics.error()
        return false
    }

    func checkActionStatus(_ cardId: String) async {
        setActionState(cardId, kind: "approval", state: .checking)
        await loadMessages()
        if let status = serverConfirmStatus(cardId), status != "pending" {
            setConfirmStatus(cardId, status)
            errorToast = status == "expired"
                ? "এই অনুমোদনের মেয়াদ শেষ হয়েছে"
                : "সার্ভারের সিদ্ধান্ত মিলিয়ে নেওয়া হয়েছে"
        } else {
            setActionState(cardId, kind: "approval", state: .pending)
            errorToast = "সিদ্ধান্ত এখনো অপেক্ষায় আছে"
        }
    }

    private func setConfirmStatus(_ cardId: String, _ status: String) {
        if status == "pending" { confirmTerminalStatus.removeValue(forKey: cardId) }
        else { confirmTerminalStatus[cardId] = status }
        let state: ActionLifecycleState
        switch status {
        case "approved": state = .approved
        case "executed": state = .approved
        case "rejected": state = .rejected
        case "expired": state = .expired
        case "cancelled": state = .cancelled
        case "failed": state = .failed
        default: state = .pending
        }
        setActionState(cardId, kind: "approval", state: state)
        for i in messages.indices {
            if let j = messages[i].confirmCards.firstIndex(where: { $0.id == cardId }) {
                messages[i].confirmCards[j].status = status
                messages[i].confirmCards[j].approvedAt = status == "approved" ? Date() : nil
            }
        }
    }

    @discardableResult
    func answerAskCard(_ cardId: String, option: String, continueInChat: Bool = true) async -> Bool {
        if actionRegistry[cardId]?.state == .answered {
            let acceptedOption = actionRegistry[cardId]?.selectedOption ?? option
            if continueInChat {
                dispatchActionContinuation(
                    key: "ask:\(cardId)", text: acceptedOption, askCardId: cardId)
            }
            clearAskDraft(cardId)
            return true
        }
        if continueInChat {
            _ = resolvedActionContinuation(
                key: "ask:\(cardId)", text: option, askCardId: cardId)
        }
        guard beginSubmitting("ask:\(cardId)") else { return false }
        defer { finishSubmitting("ask:\(cardId)") }
        AlmaAgentHaptics.light()
        do {
            let _: OkResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/ask-cards/\(cardId)/answer", body: ["option": option])
            for i in messages.indices {
                if let j = messages[i].askCards.firstIndex(where: { $0.id == cardId }) {
                    messages[i].askCards[j].status = "answered"
                    messages[i].askCards[j].selectedOption = option
                }
            }
            setActionState(cardId, kind: "ask", state: .answered, selectedOption: option)
            AlmaAgentHaptics.success()
            clearAskDraft(cardId)
            // Voice owns its own spoken continuation, so it persists here with
            // continueInChat=false and starts exactly one voice turn itself.
            if continueInChat {
                dispatchActionContinuation(key: "ask:\(cardId)", text: option, askCardId: cardId)
            }
            return true
        } catch AlmaAPIError.http(let status, let body) where status == 409 {
            let selected = selectedOptionFromErrorBody(body)
            if selected == option {
                for i in messages.indices {
                    if let j = messages[i].askCards.firstIndex(where: { $0.id == cardId }) {
                        messages[i].askCards[j].status = "answered"
                        messages[i].askCards[j].selectedOption = option
                    }
                }
                setActionState(cardId, kind: "ask", state: .answered, selectedOption: option)
                errorToast = "উত্তরটি আগেই সংরক্ষিত হয়েছে"
                AlmaAgentHaptics.selection()
                clearAskDraft(cardId)
                if continueInChat {
                    dispatchActionContinuation(key: "ask:\(cardId)", text: option, askCardId: cardId)
                }
                return true
            }
            await loadMessages()
            let serverCard = messages.lazy.flatMap(\.askCards).first(where: { $0.id == cardId })
            if serverCard?.status == "answered" {
                let acceptedOption = serverCard?.selectedOption
                errorToast = "উত্তরটি আগেই সংরক্ষিত হয়েছে"
                AlmaAgentHaptics.selection()
                if continueInChat, let acceptedOption, !acceptedOption.isEmpty {
                    setActionState(cardId, kind: "ask", state: .answered,
                                   selectedOption: acceptedOption)
                    dispatchActionContinuation(
                        key: "ask:\(cardId)", text: acceptedOption, askCardId: cardId)
                }
                clearAskDraft(cardId)
                return true
            }
            errorToast = selected == nil
                ? "প্রশ্নটির অবস্থা বদলেছে — আবার দেখে চেষ্টা করুন"
                : "এই প্রশ্নের অন্য উত্তর আগেই সংরক্ষিত হয়েছে"
            setActionState(cardId, kind: "ask", state: .failed)
            AlmaAgentHaptics.warning()
            return false
        } catch {
            setActionState(cardId, kind: "ask", state: .checking)
            await loadMessages()
            if let serverCard = messages.lazy.flatMap(\.askCards).first(where: { $0.id == cardId }),
               serverCard.status == "answered" {
                errorToast = "উত্তরটি সার্ভারে সংরক্ষিত ছিল — অবস্থা মিলিয়ে নেওয়া হয়েছে"
                AlmaAgentHaptics.selection()
                let acceptedOption = serverCard.selectedOption ?? option
                setActionState(cardId, kind: "ask", state: .answered,
                               selectedOption: acceptedOption)
                if continueInChat {
                    dispatchActionContinuation(
                        key: "ask:\(cardId)", text: acceptedOption, askCardId: cardId)
                }
                clearAskDraft(cardId)
                return true
            }
            errorToast = "উত্তর সংরক্ষণ করা গেল না — আবার চেষ্টা করুন"
            setActionState(cardId, kind: "ask", state: .failed)
            AlmaAgentHaptics.error()
            return false
        }
    }

    // ── Owner feedback on a settled reply (roadmap Phase 1 correction loop) ──

    /// Message ids (local UI ids) whose feedback is already filed this session.
    var feedbackSentIds: Set<String> = []
    var feedbackSubmittingIds: Set<String> = []
    var feedbackFailedIds: Set<String> = []

    /// One tap files a structured correction row — POST /api/assistant/feedback.
    /// The icon settles only after server acceptance; a failed request remains
    /// actionable so the owner can retry without the row shifting underneath.
    func sendFeedback(kind: String, for message: AgentChatMessage) {
        guard !feedbackSubmittingIds.contains(message.id) else { return }
        AlmaAgentHaptics.light()
        guard let cid = conversationId else {
            feedbackFailedIds.insert(message.id)
            return
        }
        feedbackSubmittingIds.insert(message.id)
        feedbackFailedIds.remove(message.id)
        struct FeedbackBody: Encodable {
            let kind: String
            let conversationId: String
            let messageId: String?
        }
        let serverId = message.serverId
            ?? (message.id.hasPrefix("local-") || message.id.hasPrefix("stream-") ? nil : message.id)
        Task {
            do {
                let _: OkResponse = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/feedback",
                    body: FeedbackBody(kind: kind, conversationId: cid, messageId: serverId))
                feedbackSubmittingIds.remove(message.id)
                feedbackSentIds.insert(message.id)
                AlmaAgentHaptics.success()
            } catch {
                feedbackSubmittingIds.remove(message.id)
                feedbackFailedIds.insert(message.id)
                errorToast = "মতামত সংরক্ষণ হয়নি — আবার চেষ্টা করুন"
                AlmaAgentHaptics.error()
            }
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
        let actionKey = "artifact:\(message.id)"
        guard beginSubmitting(actionKey) else { return }
        defer { finishSubmitting(actionKey) }
        AlmaAgentHaptics.light()
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
            AlmaAgentHaptics.success()
            await loadArtifacts()
        } catch {
            errorToast = "সংরক্ষণ করা গেল না — আবার চেষ্টা করুন"
            AlmaAgentHaptics.error()
        }
    }

    /// "আমার মত" — reject pending action, then send owner's correction as a new turn.
    @discardableResult
    func submitOpinion(_ cardId: String, note: String) async -> Bool {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if currentConfirmStatus(cardId) == "rejected"
            || actionRegistry[cardId]?.state == .rejected {
            dispatchActionContinuation(key: "opinion:\(cardId)", text: trimmed, askCardId: nil)
            clearOpinionDraft(cardId)
            return true
        }
        _ = resolvedActionContinuation(
            key: "opinion:\(cardId)", text: trimmed, askCardId: nil)
        guard beginSubmitting("action:\(cardId)") else { return false }
        defer { finishSubmitting("action:\(cardId)") }
        AlmaAgentHaptics.commit()
        do {
            let _: OkResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/actions/\(cardId)/reject")
            setConfirmStatus(cardId, "rejected")
            AlmaAgentHaptics.success()
            dispatchActionContinuation(key: "opinion:\(cardId)", text: trimmed, askCardId: nil)
            clearOpinionDraft(cardId)
            return true
        } catch {
            let reconciled = await reconcileActionFailure(cardId: cardId, error: error)
            if reconciled, currentConfirmStatus(cardId) == "rejected" {
                dispatchActionContinuation(key: "opinion:\(cardId)", text: trimmed, askCardId: nil)
                clearOpinionDraft(cardId)
            }
            return reconciled
        }
    }

    // ── Attachments ────────────────────────────────────────────────────────

    func attachImage(_ image: UIImage) {
        guard let jpeg = image.jpegData(compressionQuality: 0.85) else { return }
        enqueueAttachment(data: jpeg,
                          name: "photo-\(Int(Date().timeIntervalSince1970)).jpg",
                          mediaType: "image/jpeg", image: image)
    }

    func attachDocument(data: Data, name: String, mediaType: String) {
        guard data.count <= 10 * 1024 * 1024 else {
            errorToast = "ফাইলটি ১০ MB-এর বেশি"
            AlmaAgentHaptics.error()
            return
        }
        let serverAcceptedTypes: Set<String> = [
            "application/pdf", "image/jpeg", "image/png", "image/webp",
            "image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence",
        ]
        guard serverAcceptedTypes.contains(mediaType.lowercased()) else {
            errorToast = "এখন JPEG, PNG, WebP, HEIC ও PDF যোগ করা যায়"
            AlmaAgentHaptics.warning()
            return
        }
        enqueueAttachment(data: data, name: name, mediaType: mediaType, image: UIImage(data: data))
    }

    private func enqueueAttachment(data: Data, name: String, mediaType: String, image: UIImage?) {
        let file = PendingFile(name: name, mediaType: mediaType, data: data, image: image)
        guard let directory = Self.attachmentCacheDirectory() else {
            errorToast = "ফাইলটি নিরাপদে প্রস্তুত করা যায়নি — আবার চেষ্টা করুন"
            AlmaAgentHaptics.error()
            return
        }
        do {
            try data.write(
                to: directory.appendingPathComponent(file.cacheFileName),
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            errorToast = "ফাইলটি নিরাপদে প্রস্তুত করা যায়নি — আবার চেষ্টা করুন"
            AlmaAgentHaptics.error()
            return
        }
        pendingFiles.append(file)
        uploadPendingFile(file.id)
    }

    func retryPendingFile(_ id: UUID) {
        guard let i = pendingFiles.firstIndex(where: { $0.id == id }),
              pendingFiles[i].state == .failed || pendingFiles[i].state == .waitingForNetwork
        else { return }
        pendingFiles[i].state = .uploading
        uploadPendingFile(id)
    }

    private func uploadPendingFile(_ fileId: UUID) {
        guard let file = pendingFiles.first(where: { $0.id == fileId }) else { return }
        Task { [weak self] in
            do {
                #if DEBUG
                if AlmaMergeReadinessURLProtocol.scenario == "attachmentAtomic" {
                    // Deterministic visual hold: prove the production Send path
                    // creates a durable waiting intent before upload can finish.
                    try await Task.sleep(for: .seconds(8))
                }
                #endif
                struct UploadResponse: Decodable { let bucket: String; let path: String; let mediaType: String }
                let data = try await AssistantNet.uploadMultipart(
                    path: "/api/assistant/upload", fileField: "file",
                    filename: file.name,
                    mime: file.mediaType, data: file.data,
                    extraFields: ["conversationId": self?.conversationId ?? "general"])
                let up = try JSONDecoder().decode(UploadResponse.self, from: data)
                guard let self, let i = self.pendingFiles.firstIndex(where: { $0.id == fileId }) else { return }
                self.pendingFiles[i].state = .ready(.init(
                    bucket: up.bucket, path: up.path, mediaType: up.mediaType))
                AlmaAgentHaptics.success()
                self.tryStartPendingAttachmentSend()
            } catch {
                guard let self, let i = self.pendingFiles.firstIndex(where: { $0.id == fileId }) else { return }
                if case .offline = TurnFailureKind.classify(error) {
                    self.pendingFiles[i].state = .waitingForNetwork
                    self.errorToast = "অফলাইন — \(file.name) নিরাপদে আছে, সংযোগ এলে আবার পাঠানো হবে"
                    AlmaAgentHaptics.warning()
                } else {
                    self.pendingFiles[i].state = .failed
                    self.errorToast = "\(file.name) আপলোড হয়নি — কার্ডে চাপ দিয়ে আবার চেষ্টা করুন"
                    AlmaAgentHaptics.error()
                }
            }
        }
    }

    private func removeAttachmentCacheFiles(_ ids: Set<UUID>) {
        guard !ids.isEmpty, let directory = Self.attachmentCacheDirectory() else { return }
        let names = pendingFiles.compactMap { ids.contains($0.id) ? $0.cacheFileName : nil }
        for name in names {
            let url = directory.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            do {
                try FileManager.default.removeItem(at: url)
            } catch {
                AlmaTurnLog.event("attachment.cacheCleanupFailed", name)
            }
        }
    }

    func removePendingFile(_ id: UUID) {
        if pendingAttachmentSend?.attachmentIds.contains(id) == true {
            let clientMessageId = pendingAttachmentSend?.clientMessageId
            pendingAttachmentSend = nil
            if let clientMessageId {
                messages.removeAll { $0.clientMessageId == clientMessageId && $0.outgoingState == .waitingForAttachments }
            }
            errorToast = "অপেক্ষার Send বাতিল হয়েছে — লেখা অক্ষত আছে"
        }
        removeAttachmentCacheFiles([id])
        pendingFiles.removeAll { $0.id == id }
    }

    func retryOutgoingMessage(_ message: AgentChatMessage) {
        guard let clientMessageId = message.clientMessageId,
              message.role == .user, !isStreaming else { return }
        if let pending = pendingAttachmentSend,
           pending.clientMessageId == clientMessageId {
            for id in pending.attachmentIds { retryPendingFile(id) }
            tryStartPendingAttachmentSend()
            return
        }
        if queuedOwnerMessages.contains(where: { $0.id == clientMessageId }) {
            scheduleQueuedOwnerMessage()
            return
        }
        if let descriptor = recoverableTurn,
           descriptor.clientMessageId == clientMessageId {
            for index in messages.indices where messages[index].clientMessageId == clientMessageId {
                messages[index].outgoingState = .checking
            }
            var retryDescriptor = descriptor
            retryDescriptor.preTurnEOFRetryCount = 0
            retryDescriptor.preTurnRetryNotBefore = nil
            recoverableTurn = retryDescriptor
            resumePreTurnDescriptor(retryDescriptor)
            return
        }
        // A definite pre-acceptance failure has no recovery descriptor. Reuse
        // the original idempotency key and exact bound refs so a late server
        // acceptance still reconciles to one message rather than duplicating it.
        startPreparedTurn(
            text: message.text, files: message.fileRefs,
            localImages: message.localImages, clientMessageId: clientMessageId)
    }

    func editOutgoingMessage(_ message: AgentChatMessage) {
        guard let clientMessageId = message.clientMessageId,
              message.role == .user,
              message.outgoingState == .waitingForAttachments
                || message.outgoingState == .queued
                || message.outgoingState == .failed else { return }
        queuedOwnerMessages.removeAll { $0.id == clientMessageId }
        if pendingAttachmentSend?.clientMessageId == clientMessageId {
            pendingAttachmentSend = nil
        }
        if recoverableTurn?.clientMessageId == clientMessageId {
            // `.failed` means bounded reconciliation proved no accepted turn;
            // unknown acceptance is represented by `.checking` and cannot edit.
            recoverableTurn = nil
        }
        discardActionContinuation(clientMessageId: clientMessageId)
        composerDraft = message.text
        for index in messages.indices where messages[index].clientMessageId == clientMessageId {
            messages[index].outgoingState = .cancelled
        }
        errorToast = "বার্তাটি composer-এ ফিরেছে — সম্পাদনা করে আবার পাঠান"
        AlmaAgentHaptics.selection()
    }

    func cancelOutgoingMessage(_ message: AgentChatMessage) {
        guard let clientMessageId = message.clientMessageId,
              message.role == .user,
              message.outgoingState != .accepted,
              message.outgoingState != .cancelled else { return }
        queuedOwnerMessages.removeAll { $0.id == clientMessageId }
        if pendingAttachmentSend?.clientMessageId == clientMessageId {
            pendingAttachmentSend = nil
        }
        if recoverableTurn?.clientMessageId == clientMessageId {
            stopStreaming(cancelServer: true)
        }
        discardActionContinuation(clientMessageId: clientMessageId)
        for index in messages.indices where messages[index].clientMessageId == clientMessageId {
            messages[index].outgoingState = .cancelled
        }
        if composerDraft.isEmpty { composerDraft = message.text }
        errorToast = "Send বাতিল হয়েছে — লেখা ও attachment composer-এ আছে"
        AlmaAgentHaptics.warning()
    }

    private func upsertLocalOwnerIntent(clientMessageId: String, text: String,
                                        files: [AgentFileRef], attachmentIds: [UUID],
                                        state: AgentChatMessage.OutgoingState) {
        let selected = attachmentIds.compactMap { id in pendingFiles.first { $0.id == id } }
        if let index = messages.firstIndex(where: { $0.clientMessageId == clientMessageId }) {
            messages[index].text = text
            messages[index].fileRefs = files
            messages[index].localImages = selected.compactMap(\.image)
            messages[index].outgoingState = state
            return
        }
        var owner = AgentChatMessage(
            id: "local-\(clientMessageId)", role: .user,
            clientMessageId: clientMessageId, outgoingState: state, text: text)
        owner.fileRefs = files
        owner.localImages = selected.compactMap(\.image)
        messages.append(owner)
    }

    private func tryStartPendingAttachmentSend() {
        guard let pending = pendingAttachmentSend,
              pending.sessionIdentity == selectedSessionIdentity,
              pending.conversationId == conversationId else { return }
        let selected = pending.attachmentIds.compactMap { id in
            pendingFiles.first { $0.id == id }
        }
        guard selected.count == pending.attachmentIds.count else {
            errorToast = "একটি attachment পাওয়া যাচ্ছে না — লেখা অক্ষত আছে"
            return
        }
        if selected.contains(where: { $0.state == .failed }) {
            errorToast = "একটি attachment upload হয়নি — Retry বা Remove করুন"
            return
        }
        guard selected.allSatisfy({ if case .ready = $0.state { return true }; return false }) else {
            return
        }
        let refs = selected.compactMap { file -> AgentFileRef? in
            if case .ready(let ref) = file.state { return ref }
            return nil
        }
        upsertLocalOwnerIntent(
            clientMessageId: pending.clientMessageId, text: pending.text,
            files: refs, attachmentIds: pending.attachmentIds, state: .queued)
        pendingAttachmentSend = nil
        if isStreaming || recoverableTurn != nil {
            queueOwnerMessage(
                text: pending.text, files: refs, askCardId: pending.askCardId,
                sentPendingIds: [], clientMessageId: pending.clientMessageId,
                attachmentIds: pending.attachmentIds)
        } else {
            startPreparedTurn(
                text: pending.text, files: refs,
                localImages: selected.compactMap(\.image), askCardId: pending.askCardId,
                clientMessageId: pending.clientMessageId,
                attachmentIds: pending.attachmentIds)
        }
    }

    private func resumePendingAttachmentUploads() {
        let ids = pendingFiles.compactMap { file -> UUID? in
            file.state == .waitingForNetwork ? file.id : nil
        }
        for id in ids { retryPendingFile(id) }
        tryStartPendingAttachmentSend()
    }

    private func markOutgoingAccepted(clientMessageId: String) {
        let descriptor = recoverableTurn.flatMap {
            $0.clientMessageId == clientMessageId ? $0 : nil
        }
        let text = descriptor?.message
        let attachmentIds = Set(descriptor?.attachmentIds ?? [])
        for index in messages.indices where messages[index].clientMessageId == clientMessageId {
            messages[index].outgoingState = .accepted
        }
        if let text, composerDraft == text { composerDraft = "" }
        if !attachmentIds.isEmpty {
            removeAttachmentCacheFiles(attachmentIds)
            pendingFiles.removeAll { attachmentIds.contains($0.id) }
        }
        if pendingAttachmentSend?.clientMessageId == clientMessageId {
            pendingAttachmentSend = nil
        }
        var retiredContinuation = false
        for key in Array(actionContinuations.keys)
        where actionContinuations[key]?.clientMessageId == clientMessageId {
            actionContinuations[key]?.acceptedAt = Date()
            resumedActionContinuationKeys.insert(key)
            retiredContinuation = true
        }
        if retiredContinuation { persistActionContinuations() }
        AlmaTurnLog.event("turn.ownerIntentAccepted", clientMessageId)
    }

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
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ALMAAssistant", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
                                                 attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        return root.appendingPathComponent("pending-dictation.m4a")
    }

    func toggleRecording() {
        if isRecording { finishRecording() } else { startRecording() }
    }

    private func startRecording() {
        let session = AVAudioSession.sharedInstance()
        session.requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                guard granted, let self else { return }
                // LIVE dictation first (Claude-app parity): realtime words while
                // speaking. Any start failure falls through to the recorder path.
                self.dictationStreamer.dictationMode = true
                self.dictationStreamer.onPartialSink = { [weak self] text in
                    NSLog("ALMA-DICTATE partial %d chars", text.count)
                    self?.liveDictation = text
                }
                self.dictationStreamer.onLevelSink = { [weak self] level in
                    guard let self, self.isRecording else { return }
                    self.micLevel = max(0.06, level)
                }
                self.dictationStreamer.onFinalSink = { [weak self] text in
                    guard let self, self.usingStreamDictation else { return }
                    self.usingStreamDictation = false
                    self.isRecording = false
                    self.liveDictation = ""
                    let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !clean.isEmpty else {
                        self.dictationFailure = "কথা বোঝা যায়নি"
                        return
                    }
                    // Owner pipeline (2026-07-23): raw realtime STT → mini-LLM polish
                    // into clean Bangla. Best-effort with a hard cap — the raw text
                    // always lands if the polish is slow or fails.
                    self.transcribing = true
                    Task { [weak self] in
                        guard let self else { return }
                        defer { self.transcribing = false }
                        var finalText = clean
                        struct PolishResp: Decodable { let text: String? }
                        do {
                            let resp: PolishResp = try await withThrowingTaskGroup(of: PolishResp.self) { group in
                                group.addTask {
                                    try await AlmaAPI.shared.send("POST", "/api/assistant/dictation-polish",
                                                                  body: ["text": clean])
                                }
                                group.addTask {
                                    try await Task.sleep(nanoseconds: 4_000_000_000)
                                    throw CancellationError()
                                }
                                let first = try await group.next()!
                                group.cancelAll()
                                return first
                            }
                            if let polished = resp.text?.trimmingCharacters(in: .whitespacesAndNewlines),
                               !polished.isEmpty { finalText = polished }
                        } catch { /* keep raw */ }
                        self.composerDraft = self.composerDraft.isEmpty
                            ? finalText : self.composerDraft + " " + finalText
                        self.dictationFailure = nil
                        AlmaAgentHaptics.commit()
                    }
                }
                self.dictationStreamer.onNoSpeechSink = { [weak self] in
                    guard let self, self.usingStreamDictation else { return }
                    self.usingStreamDictation = false
                    self.isRecording = false
                    self.liveDictation = ""
                    self.dictationFailure = "কথা বোঝা যায়নি"
                }
                self.dictationStreamer.onErrorSink = { [weak self] _ in
                    guard let self, self.usingStreamDictation else { return }
                    self.usingStreamDictation = false
                    self.isRecording = false
                    self.liveDictation = ""
                    self.dictationFailure = "ভয়েস বোঝা যায়নি — আবার চেষ্টা করুন"
                }
                Task { [weak self] in
                    guard let self else { return }
                    do {
                        // The streamer reads the input node's format — without an
                        // active playAndRecord session the sim/device reports 0 Hz
                        // and start() throws noMic (owner hit: no live words).
                        try? session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
                        try? session.setActive(true)
                        try await self.dictationStreamer.start()
                        await MainActor.run {
                            NSLog("ALMA-DICTATE streaming started")
                            self.usingStreamDictation = true
                            self.isRecording = true
                            self.dictationFailure = nil
                            self.liveDictation = ""
                            self.recordingSeconds = 0
                            self.micLevel = 0.06
                            AlmaAgentHaptics.commit()
                            self.meterTask?.cancel()
                            self.meterTask = Task { [weak self] in
                                var secs = 0
                                while let self, self.isRecording, !Task.isCancelled {
                                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                                    secs += 1
                                    self.recordingSeconds = secs
                                }
                            }
                        }
                    } catch {
                        NSLog("ALMA-DICTATE streamer failed to start (%@) — recorder fallback", String(describing: error))
                        await MainActor.run { self.startRecorderFallback() }
                    }
                }
            }
        }
    }

    /// Legacy path: AVAudioRecorder + upload-after-stop. Used only when the
    /// realtime streamer cannot start (mic contention etc.).
    private func startRecorderFallback() {
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
                    self.dictationFailure = nil
                    self.recordingSeconds = 0
                    self.micLevel = 0.06
                    AlmaAgentHaptics.commit()
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
        if usingStreamDictation {
            usingStreamDictation = false
            dictationStreamer.cancel()
            isRecording = false
            liveDictation = ""
            dictationFailure = nil
            AlmaAgentHaptics.light()
            return
        }
        recorder?.stop()
        recorder = nil
        isRecording = false
        try? FileManager.default.removeItem(at: recordingURL)
        dictationFailure = nil
        AlmaAgentHaptics.light()
    }

    private func finishRecording() {
        meterTask?.cancel()
        if usingStreamDictation {
            // Realtime path: commit the utterance; onFinalSink fills the composer
            // (or the streamer's built-in WAV fallback upload resolves it).
            AlmaAgentHaptics.light()
            dictationStreamer.finishNow()
            return
        }
        recorder?.stop()
        recorder = nil
        isRecording = false
        AlmaAgentHaptics.light()
        transcribePendingDictation()
    }

    func retryDictation() {
        guard FileManager.default.fileExists(atPath: recordingURL.path) else {
            dictationFailure = nil
            return
        }
        AlmaAgentHaptics.light()
        transcribePendingDictation()
    }

    func discardPendingDictation() {
        try? FileManager.default.removeItem(at: recordingURL)
        dictationFailure = nil
        transcribing = false
    }

    private func transcribePendingDictation() {
        guard !transcribing else { return }
        transcribing = true
        // Persist a visible recovery marker before starting the async request.
        // If iOS kills the process here, bootstrap finds both marker + audio and
        // offers the exact Retry instead of hiding the surviving recording.
        dictationFailure = "Voice transcription চলছে — বন্ধ হলেও Retry করা যাবে"
        Task { [weak self] in
            guard let self else { return }
            defer { self.transcribing = false }
            guard let audio = try? Data(contentsOf: self.recordingURL), audio.count > 1_000 else {
                self.dictationFailure = "রেকর্ডিংটি পাওয়া যায়নি"
                return
            }
            do {
                let data = try await AssistantNet.uploadMultipart(
                    path: "/api/assistant/transcribe", fileField: "audio",
                    filename: "dictation.m4a", mime: "audio/mp4", data: audio)
                let t = try JSONDecoder().decode(TranscribeResponse.self, from: data)
                if let text = t.text, !text.isEmpty {
                    self.composerDraft = self.composerDraft.isEmpty
                        ? text : self.composerDraft + " " + text
                    try? FileManager.default.removeItem(at: self.recordingURL)
                    self.dictationFailure = nil
                } else {
                    self.dictationFailure = "কথা বোঝা যায়নি"
                }
            } catch {
                self.dictationFailure = "ভয়েস বোঝা যায়নি — রেকর্ডিং রাখা আছে"
                self.errorToast = "ভয়েস বোঝা যায়নি — আবার চেষ্টা করুন"
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
        tv.adjustsFontForContentSizeCategory = true
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
struct AgentMarkdownTable: Equatable {
    let header: [String]
    let rows: [[String]]
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

    /// GitHub-style pipe table → semantic rows. The delimiter row is structural
    /// metadata and must never leak into the owner-facing answer as raw dashes.
    static func parseTable(_ source: String) -> AgentMarkdownTable? {
        func cells(_ line: String) -> [String] {
            var parts = line.split(separator: "|", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            if parts.first?.isEmpty == true { parts.removeFirst() }
            if parts.last?.isEmpty == true { parts.removeLast() }
            return parts
        }
        func isDelimiter(_ value: String) -> Bool {
            let core = value.trimmingCharacters(in: CharacterSet(charactersIn: ":- "))
            let dashCount = value.filter { $0 == "-" }.count
            return core.isEmpty && dashCount >= 3
        }
        let lines = source.components(separatedBy: "\n").filter {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard lines.count >= 2 else { return nil }
        let parsed = lines.map(cells)
        guard parsed[0].count >= 2, parsed[1].count == parsed[0].count,
              parsed[1].allSatisfy(isDelimiter) else { return nil }
        let width = parsed[0].count
        let rows = parsed.dropFirst(2).map { row in
            Array((row + Array(repeating: "", count: width)).prefix(width))
        }
        return .init(header: parsed[0], rows: rows)
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
    /// selection can span the whole paragraph: clear headers, lists and quiet body,
    /// resolved bold/italic/code (UITextView doesn't interpret markdown intents).
    static func attributedParagraph(_ s: String, pal: AgentPalette) -> NSAttributedString {
        let body = UIFontMetrics(forTextStyle: .body).scaledFont(
            for: UIFont.systemFont(ofSize: 16.5, weight: .regular))
        let ink = UIColor(pal.ink)
        let out = NSMutableAttributedString()
        let para = NSMutableParagraphStyle()
        para.lineSpacing = 4
        para.paragraphSpacing = 9
        var first = true
        for line in s.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            if !first { out.append(NSAttributedString(string: "\n")) }
            first = false
            if trimmed.hasPrefix("###") || trimmed.hasPrefix("##") || trimmed.hasPrefix("# ") {
                let title = String(trimmed.drop(while: { $0 == "#" || $0 == " " }))
                let size: CGFloat = trimmed.hasPrefix("# ") ? 18 : 16
                let heading = UIFontMetrics(forTextStyle: .headline)
                    .scaledFont(for: UIFont.systemFont(ofSize: size, weight: .semibold))
                out.append(NSAttributedString(string: title, attributes: [
                    .font: heading,
                    .foregroundColor: ink,
                ]))
            } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("• ") {
                out.append(NSAttributedString(string: "•  ", attributes: [.font: body, .foregroundColor: UIColor(pal.muted)]))
                out.append(inlineNS(String(trimmed.dropFirst(2)), baseFont: body, color: ink))
            } else if trimmed.hasPrefix("> ") {
                out.append(NSAttributedString(string: "│  ", attributes: [
                    .font: body, .foregroundColor: UIColor(AgentPalette.coral.opacity(0.75))]))
                out.append(inlineNS(String(trimmed.dropFirst(2)), baseFont: body, color: UIColor(pal.mutedHi)))
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
            var attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
            if let link = run.link {
                attrs[.link] = link
                attrs[.foregroundColor] = UIColor(AgentPalette.teal)
                attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            }
            out.append(NSAttributedString(string: sub, attributes: attrs))
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
                        .font(.system(trimmed.hasPrefix("# ") ? .title3 : .headline, weight: .semibold))
                        .foregroundStyle(pal.ink)
                        .padding(.top, 2)
                } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("• ") {
                    HStack(alignment: .top, spacing: 7) {
                        Text("•").foregroundStyle(pal.muted)
                        inline(String(trimmed.dropFirst(2)))
                    }
                } else if trimmed.hasPrefix("> ") {
                    HStack(alignment: .top, spacing: 9) {
                        Capsule().fill(AgentPalette.coral.opacity(0.65)).frame(width: 3)
                        inline(String(trimmed.dropFirst(2))).foregroundStyle(pal.mutedHi)
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
                .font(.system(.body, design: .default))
                .foregroundStyle(pal.ink)
        }
        return Text(s).font(.system(.body, design: .default)).foregroundStyle(pal.ink)
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
                    AlmaAgentHaptics.light()
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
            if isCopyCard {
                Text(body)
                    .font(.system(size: 15.5))
                    .foregroundStyle(pal.ink)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ScrollView(.horizontal, showsIndicators: true) {
                    Text(body)
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(Color.white.opacity(0.92))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.bottom, 3)
                }
            }
        }
        .padding(12)
        .background(isCopyCard ? AgentPalette.coral.opacity(0.06) : pal.codeBg,
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(isCopyCard ? AgentPalette.coral.opacity(0.25) : Color.white.opacity(0.08), lineWidth: 1))
    }

    @ViewBuilder private func tableCard(_ s: String) -> some View {
        if let table = Self.parseTable(s) {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Label("তথ্য", systemImage: "tablecells")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(pal.mutedHi)
                    Spacer()
                    Button {
                        UIPasteboard.general.string = s
                        AlmaAgentHaptics.light()
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(pal.muted)
                            .frame(width: 36, height: 36)
                    }
                    .accessibilityLabel("টেবিল কপি করুন")
                }
                .padding(.leading, 12).padding(.trailing, 5)

                Divider().overlay(pal.borderSubtle)
                ScrollView(.horizontal, showsIndicators: true) {
                    Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                        GridRow {
                            ForEach(Array(table.header.enumerated()), id: \.offset) { index, value in
                                tableCell(value, header: true, column: index)
                            }
                        }
                        ForEach(Array(table.rows.enumerated()), id: \.offset) { rowIndex, row in
                            Divider().gridCellColumns(max(1, table.header.count))
                                .overlay(pal.borderSubtle.opacity(0.65))
                            GridRow {
                                ForEach(Array(row.enumerated()), id: \.offset) { index, value in
                                    tableCell(value, header: false, column: index)
                                        .background(rowIndex.isMultiple(of: 2)
                                            ? Color.clear : pal.card.opacity(0.22))
                                }
                            }
                        }
                    }
                    .padding(.bottom, 8)
                }
            }
            .background(.ultraThinMaterial,
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(pal.borderSubtle, lineWidth: 1))
        } else {
            Text(s).font(.system(.caption, design: .monospaced)).foregroundStyle(pal.ink)
                .padding(12)
                .background(pal.card.opacity(0.65), in: RoundedRectangle(cornerRadius: 14))
        }
    }

    private func tableCell(_ value: String, header: Bool, column: Int) -> some View {
        let content = (try? AttributedString(markdown: value,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            .map(Text.init) ?? Text(value)
        return content
            .font(.system(size: header ? 12.5 : 13.5,
                          weight: header ? .semibold : .regular))
            .foregroundStyle(header ? pal.mutedHi : pal.ink)
            .lineLimit(3)
            .frame(minWidth: column == 0 ? 112 : 96, maxWidth: 190,
                   minHeight: 42, alignment: .leading)
            .padding(.horizontal, 11).padding(.vertical, 7)
            .overlay(alignment: .trailing) {
                Rectangle().fill(pal.borderSubtle).frame(width: 1)
            }
    }
}

/// A single generated response can be tens of thousands of characters. Parse a
/// bounded first slice initially, then opt into the full markdown tree only when
/// the owner asks. Copy/share/TTS continue to use the original complete string.
@available(iOS 17.0, *)
private struct AgentProgressiveMarkdownText: View {
    let text: String
    let pal: AgentPalette
    var selectable = false
    @State private var expanded = false
    private static let initialCharacterBudget = 12_000

    private var isGiant: Bool {
        AgentParityFlags.isEnabled(.hugeSession) && text.count > Self.initialCharacterBudget
    }
    private var visibleText: String {
        guard isGiant, !expanded else { return text }
        return String(text.prefix(Self.initialCharacterBudget))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            AgentMarkdownText(text: visibleText, pal: pal, selectable: selectable)
            if isGiant {
                Button {
                    AlmaAgentHaptics.selection()
                    withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
                } label: {
                    Label(expanded ? "বড় উত্তরটি সংক্ষিপ্ত করুন" : "পুরো বড় উত্তরটি দেখুন",
                          systemImage: expanded ? "rectangle.compress.vertical" : "rectangle.expand.vertical")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(AgentPalette.coral)
                        .frame(minHeight: 44)
                }
                .accessibilityHint(expanded
                    ? "প্রথম বারো হাজার অক্ষরে ফিরবে"
                    : "সম্পূর্ণ উত্তর render করবে")
            }
        }
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
                    AlmaAgentHaptics.light()
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
                .buttonStyle(AlmaAgentPressStyle())
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
                        // The settled server row contains the same file_ref as
                        // the optimistic local preview. Prefer the local pixels
                        // while they exist; after relaunch (no local UIImage) the
                        // signed remote thumbnail remains the authoritative view.
                        if message.localImages.isEmpty {
                            ForEach(message.imagePaths, id: \.self) { p in
                                AgentChatImage(path: p, vm: vm)
                            }
                        }
                    }
                }
                ForEach(message.fileRefs.filter { !$0.mediaType.hasPrefix("image/") },
                        id: \.self) { ref in
                    AgentInlineUploadedFileCard(ref: ref, messageId: message.id, vm: vm)
                }
                if !message.text.isEmpty {
                    // Owner ask build-70 round 4: bubble text is DIRECTLY selectable
                    // in place (native grabbers + system Copy menu) — no context menu.
                    AlmaSelectableRichText(plain: message.text,
                                           font: UIFontMetrics(forTextStyle: .body)
                                            .scaledFont(for: .systemFont(ofSize: 15)),
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
                if let state = message.outgoingState, state != .accepted {
                    VStack(alignment: .trailing, spacing: 7) {
                        HStack(spacing: 5) {
                            if state == .submitting || state == .checking {
                                ProgressView().controlSize(.mini)
                            } else {
                                Image(systemName: outgoingStateIcon(state))
                                    .font(.system(size: 10, weight: .semibold))
                            }
                            Text(outgoingStateLabel(state))
                                .font(.system(size: 10.5, weight: .semibold))
                        }
                        .foregroundStyle(state == .failed ? Color.red : pal.mutedHi)
                        .accessibilityElement(children: .combine)
                        if state == .waitingForAttachments || state == .queued || state == .failed {
                            HStack(spacing: 14) {
                                Button("আবার চেষ্টা") { vm.retryOutgoingMessage(message) }
                                Button("সম্পাদনা") { vm.editOutgoingMessage(message) }
                                Button("বাতিল", role: .destructive) { vm.cancelOutgoingMessage(message) }
                            }
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(pal.mutedHi)
                            .buttonStyle(.plain)
                        } else if state == .checking {
                            Button("বাতিল", role: .destructive) { vm.cancelOutgoingMessage(message) }
                                .font(.system(size: 11, weight: .semibold))
                                .buttonStyle(.plain)
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
                                    AgentProgressiveMarkdownText(text: message.text, pal: pal)
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
                                                AlmaAgentHaptics.commit()
                                            } label: {
                                                Label("কপি করুন", systemImage: "doc.on.doc")
                                            }
                                            Button {
                                                AlmaAgentHaptics.selection()
                                                onActivitySheet(.init(message: message, kind: .selectText, slice: message.text))
                                            } label: {
                                                Label("টেক্সট সিলেক্ট করুন", systemImage: "text.cursor")
                                            }
                                        }
                                }
                                if long {
                                    Button {
                                        AlmaAgentHaptics.selection()
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
                        AgentAskCardsPager(cards: bottomAskCards, pal: pal, vm: vm) { card, option in
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
                        onBackgroundTasks: onBackgroundTasks,
                        onSelectText: {
                            onActivitySheet(.init(message: message, kind: .selectText, slice: message.text))
                        },
                        onShowActivity: {
                            onActivitySheet(.init(message: message, kind: .summary))
                        })
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 26)
        }
    }

    private func outgoingStateLabel(_ state: AgentChatMessage.OutgoingState) -> String {
        switch state {
        case .waitingForAttachments: return "Attachment প্রস্তুত হচ্ছে"
        case .queued: return "অপেক্ষায় আছে"
        case .submitting: return "পাঠানো হচ্ছে"
        case .checking: return "Server status যাচাই হচ্ছে"
        case .accepted: return "পাঠানো হয়েছে"
        case .failed: return "পাঠানো যায়নি — লেখা ও ফাইল রাখা আছে"
        case .cancelled: return "বাতিল — composer-এ রাখা আছে"
        }
    }

    private func outgoingStateIcon(_ state: AgentChatMessage.OutgoingState) -> String {
        switch state {
        case .waitingForAttachments: return "paperclip"
        case .queued: return "clock.arrow.circlepath"
        case .submitting, .checking: return "arrow.triangle.2.circlepath"
        case .accepted: return "checkmark"
        case .failed: return "exclamationmark.circle.fill"
        case .cancelled: return "xmark.circle"
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
                        .accessibilityLabel("বন্ধ করুন")
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
                .font(.system(size: 16))
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
                    AlmaAgentHaptics.selection()
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
                .buttonStyle(AlmaAgentPressStyle())
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
    let onSelectText: () -> Void
    let onShowActivity: () -> Void
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
            HStack(spacing: 2) {
                actionButtons
                Spacer(minLength: 0)
            }
            costText
            .padding(.top, 2)
            if reasonsOpen && !feedbackSent {
                feedbackReasonsRow
            }
            if vm.feedbackFailedIds.contains(message.id) {
                Text("মতামত সংরক্ষণ হয়নি — আবার চাপুন")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(AgentPalette.coral)
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
                    .buttonStyle(AlmaAgentPressStyle())
                }
            }
            .padding(.vertical, 2)
        }
    }

    /// Quiet primary row. Less-frequent capabilities remain in the native More
    /// menu so compact iPhones never turn an answer footer into a toolbar wall.
    @ViewBuilder private var actionButtons: some View {
            if let rel = relativeTime(message.createdAt) {
                Text(rel).font(.system(size: 10)).foregroundStyle(pal.muted)
            }
            Button {
                UIPasteboard.general.string = message.text
                AlmaAgentHaptics.light()
                withAnimation(.spring(response: 0.25, dampingFraction: 0.6)) { copied = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { copied = false }
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 12))
                    .foregroundStyle(copied ? AgentPalette.teal : pal.muted)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Copy")
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
                .frame(width: 44, height: 44)
                .background(vm.ttsPlayingId == message.id ? AgentPalette.coral.opacity(0.1) : .clear,
                            in: RoundedRectangle(cornerRadius: 8))
            }
            .accessibilityLabel(vm.ttsPlayingId == message.id ? "Read aloud বন্ধ করুন" : "Read aloud")
            Button {
                reasonsOpen = false
                vm.sendFeedback(kind: "good", for: message)
            } label: {
                Group {
                    if vm.feedbackSubmittingIds.contains(message.id) {
                        AlmaMiniLoader(mode: .thinking, size: 13)
                    } else {
                        Image(systemName: feedbackSent ? "checkmark" : "hand.thumbsup")
                            .font(.system(size: 12))
                    }
                }
                .foregroundStyle(feedbackSent ? AgentPalette.teal : pal.muted)
                .frame(width: 44, height: 44)
            }
            .disabled(feedbackSent || vm.feedbackSubmittingIds.contains(message.id))
            .accessibilityLabel("Helpful")
            Button {
                AlmaAgentHaptics.light()
                withAnimation(.snappy(duration: 0.2)) { reasonsOpen.toggle() }
            } label: {
                Image(systemName: "hand.thumbsdown")
                    .font(.system(size: 12))
                    .foregroundStyle(reasonsOpen ? AgentPalette.coral : pal.muted)
                    .frame(width: 44, height: 44)
            }
            .disabled(feedbackSent || vm.feedbackSubmittingIds.contains(message.id))
            .accessibilityLabel("Not helpful")
            Menu {
                ShareLink(item: message.text,
                          preview: SharePreview("ALMA response", image: Image(systemName: "sparkles"))) {
                    Label("শেয়ার করুন", systemImage: "square.and.arrow.up")
                }
                Button(action: onSelectText) {
                    Label("টেক্সট সিলেক্ট করুন", systemImage: "text.cursor")
                }
                Button(action: onShowActivity) {
                    Label("কাজের বিবরণ", systemImage: "list.bullet.rectangle")
                }
                if artifactDetectable {
                    Button {
                        Task { await vm.saveArtifactManually(from: message) }
                    } label: {
                        Label(vm.artifactSavedIds.contains(message.id) ? "সংরক্ষিত" : "ফাইল হিসেবে সংরক্ষণ",
                              systemImage: vm.artifactSavedIds.contains(message.id)
                                ? "checkmark" : "tray.and.arrow.down")
                    }
                    .disabled(vm.artifactSavedIds.contains(message.id))
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(pal.muted)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("More")
    }

    /// Human-readable usage summary. Detailed activity remains one tap away;
    /// cryptic cache arrows no longer compete with the response itself.
    @ViewBuilder private var costText: some View {
        if let tin = message.tokensIn {
            let tout = message.tokensOut ?? 0
            let cw = message.cacheCreation ?? 0
            let cr = message.cacheRead ?? 0
            let total = tin + tout + cw + cr
            let rounds = (message.apiRounds ?? 0) > 1 ? " · \(almaBn(message.apiRounds!)) ধাপ" : ""
            let cost = message.costUsd.map {
                " · $" + (Double($0).map { String(format: "%.4f", $0) } ?? $0)
            } ?? ""
            Text("\(almaBnCompact(total)) tokens\(cost)\(rounds)")
                .font(.caption2)
                .foregroundStyle(pal.muted.opacity(0.76))
                .lineLimit(1)
                .accessibilityLabel(
                    "মোট \(total) টোকেন; ইনপুট \(tin); আউটপুট \(tout); cache write \(cw); cache read \(cr)")
            HStack(spacing: 0) {
                usageMetric("Input", value: tin)
                usageMetric("Output", value: tout)
                usageMetric("Cache write", value: cw)
                usageMetric("Cache read", value: cr)
            }
            .padding(.top, 3)
        }
    }

    private func usageMetric(_ title: String, value: Int) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title)
                .font(.system(size: 8.5, weight: .medium))
                .foregroundStyle(pal.muted.opacity(0.66))
                .lineLimit(1)
                .minimumScaleFactor(0.82)
            Text(almaBnCompact(value))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(pal.mutedHi.opacity(0.82))
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion // IOSP-5
    var body: some View {
        HStack(spacing: 2.5) {
            Capsule().fill(AgentPalette.coral).frame(width: 3, height: up ? 13 : 6)
            Capsule().fill(AgentPalette.coral).frame(width: 3, height: up ? 6 : 13)
        }
        .onAppear {
            // IOSP-5: Reduce Motion → hold the equalizer still (no perpetual loop).
            guard !reduceMotion else { return }
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
    private var submitting: Bool { vm.isSubmittingAction("action:\(card.id)") }
    private var showOpinion: Bool { vm.opinionOpenIds.contains(card.id) }
    private var opinionText: String { vm.opinionDraftText[card.id, default: ""] }
    private var opinionTextBinding: Binding<String> {
        Binding(get: { vm.opinionDraftText[card.id, default: ""] },
                set: { vm.opinionDraftText[card.id] = $0 })
    }
    private var recoveryState: AssistantVM.ActionLifecycleState? { vm.actionState(card.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 11) {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(AgentPalette.coral)
                    .frame(width: 36, height: 36)
                    .background(AgentPalette.coral.opacity(0.12), in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text("এই কাজটি চালাব?")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(pal.ink)
                    Text(actionLabel)
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(pal.muted)
                }
                Spacer(minLength: 6)
                if let c = card.costEstimate, c > 0 {
                    Text(String(format: "~$%.2f", c))
                        .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                        .foregroundStyle(pal.mutedHi)
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(Color.white.opacity(0.07), in: Capsule())
                }
            }

            Text(card.summary)
                .font(.system(size: 14.5, weight: .regular))
                .foregroundStyle(pal.ink)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)

            if card.status == "pending", recoveryState == .failed || recoveryState == .checking {
                HStack(spacing: 8) {
                    Image(systemName: recoveryState == .checking
                          ? "arrow.triangle.2.circlepath" : "exclamationmark.circle.fill")
                    Text(recoveryState == .checking
                         ? "সিদ্ধান্তের server status যাচাই হচ্ছে" : "সিদ্ধান্ত নিশ্চিত হয়নি")
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    Button("Check status") { Task { await vm.checkActionStatus(card.id) } }
                        .fontWeight(.semibold)
                }
                .font(.system(size: 11.5))
                .foregroundStyle(recoveryState == .failed ? Color.red : pal.mutedHi)
                .padding(10)
                .background((recoveryState == .failed ? Color.red : AgentPalette.coral).opacity(0.08),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }

            if card.status == "pending" {
                if showOpinion { opinionComposer }
                else { decisionControls }
            } else if card.status == "approved", card.actionType == "image_gen" || card.actionType == "video_gen" {
                // Creative-Studio-style render count (owner ask 2026-07-13): a live
                // 1→95% time-eased fill while the artifact renders — the real image
                // message landing below is the 100% moment.
                AgentRenderProgressStrip(
                    startedAt: vm.confirmApprovedAt[card.id] ?? card.approvedAt ?? Date(),
                    pal: pal)
            } else {
                HStack(spacing: 5) {
                    Image(systemName: statusIcon).font(.system(size: 11))
                    Text(statusLabel).font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(statusColor)
            }
        }
        .padding(16)
        .modifier(AlmaAgentGlassBackground(
            shape: RoundedRectangle(cornerRadius: 22, style: .continuous), pal: pal))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous)
            .strokeBorder(Color.white.opacity(0.13), lineWidth: 1))
        .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var decisionControls: some View {
        VStack(spacing: 8) {
            Button { onDecide(true) } label: {
                HStack(spacing: 7) {
                    if submitting { ProgressView().tint(.white).controlSize(.small) }
                    else { Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)) }
                    Text(submitting ? "নিশ্চিত করছি…" : "অনুমোদন দিন")
                }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(AgentPalette.coral, in: Capsule())
            }
            .disabled(submitting)
            .accessibilityLabel("অনুমোদন দিন")
            .accessibilityHint("এই Agent action চালু করবে")

            HStack(spacing: 10) {
                Button { onDecide(false) } label: {
                    Label("অনুমোদন দেব না", systemImage: "xmark")
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(pal.mutedHi)
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(Color.white.opacity(0.045), in: Capsule())
                        .overlay(Capsule().strokeBorder(pal.borderSubtle, lineWidth: 1))
                }
                .accessibilityLabel("অনুমোদন দেব না")
                Button {
                    AlmaAgentHaptics.light()
                    vm.opinionOpenIds.insert(card.id)
                } label: {
                    Label("আমার মত লিখি", systemImage: "text.bubble")
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(pal.mutedHi)
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(Color.white.opacity(0.045), in: Capsule())
                        .overlay(Capsule().strokeBorder(pal.borderSubtle, lineWidth: 1))
                }
                .accessibilityLabel("আমার মত লিখি")
            }
            .disabled(submitting)
        }
    }

    @ViewBuilder private var opinionComposer: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("কীভাবে বদলাবেন?")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(pal.mutedHi)
            TextField("আপনার মতামত লিখুন…", text: opinionTextBinding, axis: .vertical)
                .font(.system(size: 14)).lineLimit(2...4)
                .padding(12)
                .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(pal.borderSubtle))
            HStack(spacing: 8) {
                Button {
                    Task { await vm.submitOpinion(card.id, note: opinionText) }
                } label: {
                    Text(submitting ? "পাঠাচ্ছি…" : "মতামত পাঠান")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity, minHeight: 42)
                        .background(AgentPalette.coral, in: Capsule())
                }
                .disabled(submitting || opinionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button { vm.opinionOpenIds.remove(card.id) } label: {
                    Text("ফিরে যান")
                        .font(.system(size: 13, weight: .medium)).foregroundStyle(pal.muted)
                        .frame(minHeight: 42)
                        .padding(.horizontal, 10)
                }
            }
        }
    }

    private var actionLabel: String {
        switch card.actionType {
        case "image_gen": return "ছবি তৈরি"
        case "video_gen": return "ভিডিও তৈরি"
        case "email", "send_email": return "ইমেইল পাঠানো"
        case "facebook_post": return "Facebook প্রকাশ"
        case "delete": return "পরিবর্তনযোগ্য নয় এমন কাজ"
        case .some(let value) where !value.isEmpty:
            return value.replacingOccurrences(of: "_", with: " ").capitalized
        default: return "Agent action · আপনার নিয়ন্ত্রণে"
        }
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
        if card.actionType == "agent_voice_call" {
            if card.status == "approved" { return "কল চলছে — রিপোর্টের অপেক্ষা" }
            if card.status == "executed" { return "কল শেষ — রিপোর্ট পাওয়া গেছে" }
        }
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
        "researcher": "magnifyingglass", "analyst": "chart.bar.xaxis",
        "marketer": "megaphone", "content": "pencil.line",
        "ops": "tray.full", "cs": "message",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                guard d.summary?.isEmpty == false else { return }
                AlmaAgentHaptics.selection()
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: Self.roleIcon[d.role] ?? "person.2")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(AgentPalette.coral.opacity(0.86))
                        .frame(width: 22, height: 22)
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
            .buttonStyle(AlmaAgentPressStyle())
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
        .background(pal.card.opacity(0.42), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(pal.borderSubtle.opacity(0.8), lineWidth: 1))
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
    var submitting = false
    @Binding var chosen: String?
    @Binding var otherActive: Bool
    @Binding var otherText: String
    let onAnswer: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if card.status == "pending" {
                HStack(spacing: 10) {
                    Image(systemName: "questionmark.bubble.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(AgentPalette.coral)
                        .frame(width: 36, height: 36)
                        .background(AgentPalette.coral.opacity(0.12), in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Agent-এর প্রশ্ন")
                            .font(.system(size: 14.5, weight: .semibold))
                            .foregroundStyle(pal.ink)
                        if let idx = pageIndex, pageCount > 1 {
                            Text("\(almaBn(idx + 1)) / \(almaBn(pageCount))")
                                .font(.system(size: 11.5, weight: .medium))
                                .foregroundStyle(pal.muted)
                        } else {
                            Text("উত্তর না দেওয়া পর্যন্ত কাজটি অপেক্ষায় থাকবে")
                                .font(.system(size: 10.5)).foregroundStyle(pal.muted)
                        }
                    }
                    Spacer(minLength: 4)
                    if let idx = pageIndex, pageCount > 1 {
                        Button { onPrev?() } label: {
                            Image(systemName: "chevron.left").frame(width: 30, height: 30)
                        }.disabled(idx == 0).accessibilityLabel("আগের প্রশ্ন")
                        Button { onNext?() } label: {
                            Image(systemName: "chevron.right").frame(width: 30, height: 30)
                        }.disabled(idx >= pageCount - 1).accessibilityLabel("পরের প্রশ্ন")
                    }
                    if let onClose {
                        Button { AlmaAgentHaptics.light(); onClose() } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 11, weight: .semibold))
                                .frame(width: 30, height: 30)
                                .background(Color.white.opacity(0.06), in: Circle())
                        }
                        .accessibilityLabel("প্রশ্ন কার্ড বন্ধ করুন")
                    }
                }
                .foregroundStyle(pal.muted)

                Text(card.question)
                    .font(.system(size: 15.5, weight: .semibold))
                    .foregroundStyle(pal.ink)
                    .lineSpacing(4)

                VStack(spacing: 8) {
                    ForEach(Array(card.options.enumerated()), id: \.offset) { idx, opt in
                        let active = !otherActive && chosen == opt
                        Button {
                            AlmaAgentHaptics.light()
                            chosen = opt; otherActive = false
                        } label: {
                            HStack(spacing: 11) {
                                Image(systemName: active ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 18, weight: .medium))
                                    .foregroundStyle(active ? AgentPalette.coral : pal.muted.opacity(0.6))
                                Text(opt)
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(pal.ink)
                                    .multilineTextAlignment(.leading)
                                Spacer()
                                Text(almaBn(idx + 1))
                                    .font(.system(size: 10.5, weight: .semibold))
                                    .foregroundStyle(pal.muted)
                            }
                            .padding(.horizontal, 13).frame(minHeight: 46)
                            .background(active ? AgentPalette.coral.opacity(0.09) : Color.white.opacity(0.035),
                                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .strokeBorder(active ? AgentPalette.coral.opacity(0.45) : pal.borderSubtle,
                                              lineWidth: 1))
                        }
                        .buttonStyle(AlmaAgentPressStyle())
                        .disabled(submitting)
                    }
                    Button {
                        AlmaAgentHaptics.light()
                        otherActive = true; chosen = nil
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "pencil")
                                .font(.system(size: 13))
                                .foregroundStyle(otherActive ? AgentPalette.coral : pal.muted)
                                .frame(width: 18, alignment: .center)
                            Text("নিজের উত্তর লিখুন")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(otherActive ? pal.ink : pal.muted)
                            Spacer()
                        }
                        .padding(.horizontal, 13).frame(minHeight: 44)
                        .background(Color.white.opacity(0.035),
                                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(otherActive ? AgentPalette.coral.opacity(0.45) : pal.borderSubtle))
                    }
                    .buttonStyle(AlmaAgentPressStyle())
                    .disabled(submitting)
                    if otherActive {
                        TextField("উত্তর লিখুন…", text: $otherText, axis: .vertical)
                            .font(.system(size: 14)).lineLimit(2...4)
                            .padding(12)
                            .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 14))
                            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(pal.borderSubtle))
                    }
                }

                Button { submitAnswer() } label: {
                    HStack(spacing: 7) {
                        if submitting { ProgressView().tint(.white).controlSize(.small) }
                        else { Image(systemName: "arrow.up").font(.system(size: 12, weight: .bold)) }
                        Text(submitting ? "পাঠাচ্ছি…" : "উত্তর পাঠান")
                    }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(answerReady ? AgentPalette.coral : pal.muted.opacity(0.25), in: Capsule())
                }
                .disabled(submitting || !answerReady)
                .accessibilityLabel("উত্তর পাঠান")
            } else if let sel = card.selectedOption {
                VStack(alignment: .leading, spacing: 6) {
                    Text(card.question).font(.system(size: 13)).foregroundStyle(pal.muted)
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark.circle.fill").font(.system(size: 12))
                        Text(sel).font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(AgentPalette.coral)
                }
            }
        }
        .padding(16)
        .modifier(AlmaAgentGlassBackground(
            shape: RoundedRectangle(cornerRadius: 22, style: .continuous), pal: pal))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous)
            .strokeBorder(Color.white.opacity(0.13), lineWidth: 1))
        .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
        .accessibilityElement(children: .contain)
    }

    private var answerReady: Bool {
        if otherActive {
            return !otherText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return chosen?.isEmpty == false
    }

    private func submitAnswer() {
        let answer = otherActive
            ? otherText.trimmingCharacters(in: .whitespacesAndNewlines)
            : (chosen ?? "")
        guard !answer.isEmpty else { return }
        onAnswer(answer)
    }
}

/// Multiple ask cards → Claude "1 of N" pager: one card at a time, ‹ › to flip,
/// ✕ collapses into a small reopen chip (the composer still works regardless).
@available(iOS 17.0, *)
struct AgentAskCardsPager: View {
    let cards: [AgentChatMessage.AskCard]
    let pal: AgentPalette
    let vm: AssistantVM
    let onAnswer: (AgentChatMessage.AskCard, String) -> Void
    @State private var index = 0
    @State private var closed = false

    var body: some View {
        let idx = min(index, max(0, cards.count - 1))
        let card = cards[idx]
        Group {
            if closed {
                Button {
                    AlmaAgentHaptics.light()
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
                .buttonStyle(AlmaAgentPressStyle())
            } else {
                VStack(spacing: 8) {
                    AgentAskCardView(
                        card: card, pal: pal,
                        pageIndex: cards.count > 1 ? idx : nil,
                        pageCount: cards.count,
                        onPrev: { withAnimation(.snappy(duration: 0.22)) { index = max(0, idx - 1) } },
                        onNext: { withAnimation(.snappy(duration: 0.22)) { index = min(cards.count - 1, idx + 1) } },
                        onClose: card.status == "pending"
                            ? { withAnimation(.snappy(duration: 0.22)) { closed = true } } : nil,
                        submitting: vm.isSubmittingAction("ask:\(card.id)"),
                        chosen: Binding(
                            get: { vm.askChosenOption[card.id] },
                            set: { option in
                                if let option { vm.askChosenOption[card.id] = option }
                                else { vm.askChosenOption.removeValue(forKey: card.id) }
                            }),
                        otherActive: Binding(
                            get: { vm.askOtherActiveIds.contains(card.id) },
                            set: { active in
                                if active { vm.askOtherActiveIds.insert(card.id) }
                                else { vm.askOtherActiveIds.remove(card.id) }
                            }),
                        otherText: Binding(
                            get: { vm.askDraftText[card.id, default: ""] },
                            set: { vm.askDraftText[card.id] = $0 })
                    ) { option in
                        onAnswer(card, option)
                    }

                    if vm.actionState(card.id) == .failed {
                        HStack(spacing: 10) {
                            Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                                .foregroundStyle(AgentPalette.coral)
                            Text("উত্তর রাখা আছে — পাঠানো হয়নি")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(pal.muted)
                            Spacer(minLength: 0)
                            Button("আবার চেষ্টা") {
                                let answer: String
                                if vm.askOtherActiveIds.contains(card.id) {
                                    answer = vm.askDraftText[card.id, default: ""]
                                        .trimmingCharacters(in: .whitespacesAndNewlines)
                                } else {
                                    answer = vm.askChosenOption[card.id] ?? ""
                                }
                                guard !answer.isEmpty else { return }
                                onAnswer(card, answer)
                            }
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(AgentPalette.coral)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(AgentPalette.coral.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    }
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
                AlmaAgentHaptics.light()
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
            .buttonStyle(AlmaAgentPressStyle())
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

    private var displayLabel: String {
        let known: [String: String] = [
            "Searched available tools": "উপযুক্ত টুল খুঁজেছে",
            "Let me be honest about this.": "উত্তর দেওয়ার আগে সত্যতা যাচাই করেছে",
            "live_browser_look": "লাইভ browser যাচাই করেছে",
            "get_inventory_status": "স্টকের বর্তমান অবস্থা দেখেছে",
            "inventory_sync": "স্টক sync করছে",
        ]
        if let value = known[label] { return value }
        guard label.contains("_") else { return label }
        return label.replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.capitalized }
            .joined(separator: " ")
    }

    var body: some View {
        Button {
            AlmaAgentHaptics.light()
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
                    Text(displayLabel)
                        .font(.subheadline.weight(italic ? .regular : .medium))
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
            .padding(.trailing, 20)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(AlmaAgentPressStyle())
        .accessibilityValue(displayLabel == label ? "" : label)
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
                        AgentAskCardsPager(cards: [card], pal: pal, vm: vm) { card, option in
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
                AgentProgressiveMarkdownText(text: text, pal: pal, selectable: true)
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
            AlmaAgentHaptics.light()
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
        .buttonStyle(AlmaAgentPressStyle())
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
                        AlmaAgentHaptics.commit()
                        onDecide(true)
                    } label: {
                        Text("\(card.toLabel)-এ চালাও")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(AgentPalette.coral, in: Capsule())
                    }
                    Button {
                        AlmaAgentHaptics.selection()
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
private struct AgentCameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let parent: AgentCameraPicker
        init(_ parent: AgentCameraPicker) { self.parent = parent }
        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onImage(image) }
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
}

@available(iOS 17.0, *)
private struct AgentDocumentScanner: UIViewControllerRepresentable {
    let onImages: ([UIImage]) -> Void
    @Environment(\.dismiss) private var dismiss

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let parent: AgentDocumentScanner
        init(_ parent: AgentDocumentScanner) { self.parent = parent }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                          didFinishWith scan: VNDocumentCameraScan) {
            parent.onImages((0..<scan.pageCount).map { scan.imageOfPage(at: $0) })
            parent.dismiss()
        }
        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            parent.dismiss()
        }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                          didFailWithError error: Error) {
            parent.dismiss()
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}
}

/// NP-3 (AG-07.staff): staff quick actions on the LIVE Business Monitor prefill
/// the chat composer — the web's `/agent?draft=…` deep link, natively. The
/// pending text survives even if the composer isn't mounted yet (tab not built).
enum AlmaComposerPrefill {
    static var pending: String? = nil
    static let note = Notification.Name("almaComposerPrefill")
    @MainActor static func set(_ text: String) {
        pending = text
        NotificationCenter.default.post(name: note, object: nil)
    }
}

enum AlmaAssistantLibraryRequest {
    static let note = Notification.Name("almaAssistantOpenSessionLibrary")
}

@available(iOS 17.0, *)
struct AgentComposerView: View {
    @Bindable var vm: AssistantVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var photoItem: PhotosPickerItem?
    @State private var showAttachmentChoices = false
    @State private var showPhotoPicker = false
    @State private var showDocumentPicker = false
    @State private var showCamera = false
    @State private var showScanner = false
    @FocusState private var focused: Bool

    private var hasComposerPresentation: Bool {
        showAttachmentChoices || showPhotoPicker || showDocumentPicker
            || showCamera || showScanner
    }

    var body: some View {
        let pal = AgentPalette(scheme)
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                if vm.queuedOwnerMessageCount > 0 {
                    HStack(spacing: 6) {
                        Image(systemName: "clock.arrow.circlepath")
                        Text("অপেক্ষায় \(almaBn(vm.queuedOwnerMessageCount))টি বার্তা")
                    }
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(AgentPalette.coral)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                }
                if vm.hasPendingAttachmentSend {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Attachment প্রস্তুত হচ্ছে — Send নিরাপদে অপেক্ষায়")
                    }
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(AgentPalette.coral)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                } else if vm.composerSubmissionPending {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("বার্তাটি server-এ নিশ্চিত হচ্ছে…")
                    }
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(pal.mutedHi)
                    .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10)
                }
                if let failure = vm.dictationFailure, vm.canRetryDictation, !vm.isRecording {
                    HStack(spacing: 8) {
                        Image(systemName: "waveform.badge.exclamationmark")
                        Text(failure).lineLimit(1)
                        Spacer(minLength: 0)
                        Button("Retry") { vm.retryDictation() }
                            .fontWeight(.semibold)
                        Button { vm.discardPendingDictation() } label: {
                            Image(systemName: "xmark")
                        }
                        .accessibilityLabel("রেকর্ডিং বাতিল")
                    }
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(AgentPalette.coral)
                    .padding(.horizontal, 10)
                }
                if !vm.pendingFiles.isEmpty && !vm.isRecording { attachmentsRow(pal) }
                if vm.isRecording {
                    recordingBar(pal)
                } else {
                    composerInputRow(pal)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(pal.glassFill)
            .modifier(AlmaAgentGlassBackground(
                shape: RoundedRectangle(cornerRadius: 30, style: .continuous), pal: pal))
            .clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
            .overlay {
                ZStack {
                    RoundedRectangle(cornerRadius: 30, style: .continuous)
                        .strokeBorder(focused
                            ? Color.white.opacity(pal.dark ? 0.28 : 0.62)
                            : pal.borderSubtle.opacity(0.95),
                            lineWidth: focused ? 1.1 : 0.8)
                    AgentNeonBorder(cornerRadius: 30)
                        .opacity(focused ? 0.72 : 0.22)
                }
                .animation(.easeOut(duration: 0.2), value: focused)
            }
            .shadow(color: Color.black.opacity(pal.dark ? 0.28 : 0.10), radius: 18, y: 8)
            .shadow(color: AgentPalette.coral.opacity(focused ? 0.12 : 0.04), radius: 18, y: 2)
            .padding(.horizontal, 10)
            .padding(.bottom, 7)
        }
        .padding(.top, 8)
        .onChange(of: vm.dictatedText) { _, newValue in
            guard !newValue.isEmpty else { return }
            vm.composerDraft = vm.composerDraft.isEmpty
                ? newValue : vm.composerDraft + " " + newValue
            Task { @MainActor in vm.dictatedText = "" }
        }
        // NP-3: Monitor staff quick actions prefill the composer (web /agent?draft=…).
        .onAppear { consumePrefill() }
        .onReceive(NotificationCenter.default.publisher(for: AlmaComposerPrefill.note)
            .receive(on: DispatchQueue.main)) { _ in consumePrefill() }
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
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoItem, matching: .images)
        .fileImporter(isPresented: $showDocumentPicker,
                      allowedContentTypes: [.pdf, .image], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls {
                let accessed = url.startAccessingSecurityScopedResource()
                defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url) else { continue }
                let type = (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType)?
                    .preferredMIMEType ?? "application/octet-stream"
                vm.attachDocument(data: data, name: url.lastPathComponent, mediaType: type)
            }
        }
        .sheet(isPresented: $showCamera) {
            AgentCameraPicker { image in vm.attachImage(image) }
                .ignoresSafeArea()
        }
        .sheet(isPresented: $showScanner) {
            AgentDocumentScanner { images in images.forEach(vm.attachImage) }
                .ignoresSafeArea()
        }
        .onChange(of: hasComposerPresentation) { _, shown in
            FloatingChatHead.shared.setSuppressed(shown, reason: "assistant-composer-presentation")
        }
        .onDisappear {
            FloatingChatHead.shared.setSuppressed(false, reason: "assistant-composer-presentation")
        }
        .task {
            let process = ProcessInfo.processInfo
            let demo = process.environment["ALMA_ASSISTANT_ATTACHMENT_MENU"] == "1"
                || process.arguments.contains("ALMA_ASSISTANT_ATTACHMENT_MENU=1")
            if demo {
                try? await Task.sleep(for: .milliseconds(900))
                showAttachmentChoices = true
            }
        }
    }

    /// Recording bar — web parity: ✕ cancel, live 34-bar waveform, mm:ss, ✓ confirm.
    /// Pull a pending Monitor quick-action command into the composer (NP-3).
    private func consumePrefill() {
        guard let text = AlmaComposerPrefill.pending else { return }
        AlmaComposerPrefill.pending = nil
        vm.composerDraft = text
        focused = true
    }

    @ViewBuilder private func recordingBar(_ pal: AgentPalette) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // Claude-app parity: the words appear LIVE while speaking, right
            // above the waveform (gpt-4o-transcribe realtime stream).
            if !vm.liveDictation.isEmpty {
                Text(vm.liveDictation)
                    .font(.system(size: 15))
                    .foregroundStyle(pal.ink)
                    .lineLimit(3)
                    .truncationMode(.head)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                    .animation(.easeOut(duration: 0.12), value: vm.liveDictation)
            }
            recordingControlsRow(pal)
        }
        .padding(.vertical, 3)
    }

    @ViewBuilder private func recordingControlsRow(_ pal: AgentPalette) -> some View {
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
    }

    @ViewBuilder private func attachmentsRow(_ pal: AgentPalette) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(vm.pendingFiles) { f in
                    HStack(spacing: 9) {
                        ZStack {
                            if let image = f.image {
                                Image(uiImage: image).resizable().scaledToFill()
                            } else {
                                RoundedRectangle(cornerRadius: 11, style: .continuous)
                                    .fill(AgentPalette.coral.opacity(0.10))
                                    .overlay {
                                        Image(systemName: f.mediaType == "application/pdf"
                                              ? "doc.richtext.fill" : "doc.fill")
                                            .font(.system(size: 20, weight: .medium))
                                            .foregroundStyle(AgentPalette.coral)
                                    }
                            }
                        }
                        .frame(width: 50, height: 50)
                        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))

                        VStack(alignment: .leading, spacing: 4) {
                            Text(f.name)
                                .font(.system(size: 11.5, weight: .semibold))
                                .foregroundStyle(pal.ink)
                                .lineLimit(1)
                            HStack(spacing: 5) {
                                attachmentStateGlyph(f)
                                Text(attachmentStateLabel(f))
                                    .font(.system(size: 10.5, weight: .medium))
                                    .foregroundStyle(attachmentStateColor(f, pal: pal))
                                    .lineLimit(1)
                            }
                            if f.state == .failed || f.state == .waitingForNetwork {
                                Button("Retry") { vm.retryPendingFile(f.id) }
                                    .font(.system(size: 10.5, weight: .semibold))
                                    .foregroundStyle(AgentPalette.coral)
                            }
                        }
                        .frame(width: 92, alignment: .leading)
                        Button { vm.removePendingFile(f.id) } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(pal.muted)
                                .frame(width: 28, height: 28)
                                .background(Color.white.opacity(0.06), in: Circle())
                        }
                        .accessibilityLabel("\(f.name) সরান")
                    }
                    .padding(7)
                    .background(Color.white.opacity(0.055),
                                in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous)
                        .strokeBorder(f.state == .failed
                                      ? Color.red.opacity(0.35) : pal.borderSubtle, lineWidth: 1))
                }
            }
            .padding(.horizontal, 4).padding(.vertical, 3)
        }
        .frame(height: 70)
    }

    @ViewBuilder private func attachmentStateGlyph(_ file: AssistantVM.PendingFile) -> some View {
        switch file.state {
        case .uploading: ProgressView().controlSize(.mini).tint(AgentPalette.coral)
        case .waitingForNetwork: Image(systemName: "wifi.slash").font(.system(size: 9))
        case .ready: Image(systemName: "checkmark.circle.fill").font(.system(size: 10))
        case .failed: Image(systemName: "exclamationmark.circle.fill").font(.system(size: 10))
        }
    }

    private func attachmentStateLabel(_ file: AssistantVM.PendingFile) -> String {
        switch file.state {
        case .uploading: return "Uploading…"
        case .waitingForNetwork: return "Offline · saved"
        case .ready: return "Ready"
        case .failed: return "Upload failed"
        }
    }

    private func attachmentStateColor(_ file: AssistantVM.PendingFile, pal: AgentPalette) -> Color {
        switch file.state {
        case .ready: return AgentPalette.teal
        case .failed: return .red
        case .uploading: return AgentPalette.coral
        case .waitingForNetwork: return pal.muted
        }
    }

    @ViewBuilder private func composerInputRow(_ pal: AgentPalette) -> some View {
        HStack(alignment: .bottom, spacing: 2) {
            Button {
                showAttachmentChoices = true
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(pal.muted)
                    .frame(width: 36, height: 36)
                    .almaAgentHitTarget()
            }
            .accessibilityLabel("ফাইল যোগ করুন")
            .popover(isPresented: $showAttachmentChoices, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
                attachmentMenu(pal)
                    .presentationCompactAdaptation(.popover)
                    .presentationBackground(.ultraThinMaterial)
            }
            TextField(vm.transcribing ? "বুঝে নিচ্ছি…" : "বার্তা লিখুন…",
                      text: $vm.composerDraft, axis: .vertical)
                .font(.system(size: 17))
                .foregroundStyle(pal.ink)
                .lineLimit(1...5)
                .focused($focused)
                .disabled(vm.composerSubmissionPending)
                .padding(.horizontal, 7)
                .padding(.vertical, 10)
                .frame(minHeight: 46, alignment: .center)
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
                .almaAgentHitTarget()
            }
            .accessibilityLabel(vm.isRecording ? "রেকর্ডিং বন্ধ করুন" : "কণ্ঠে লিখুন")
            // voice-to-voice — the NATIVE orb console (AssistantVoiceSwiftUI.swift)
            Button {
                AlmaAgentHaptics.light()
                vm.showVoice = true
            } label: {
                Image(systemName: "waveform")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(AgentPalette.teal)
                    .frame(width: 36, height: 36)
                    .almaAgentHitTarget()
            }
            .accessibilityLabel("ভয়েস কথোপকথন")
            // Kimi/iOS grammar: no inert send button in the empty state. It slides
            // in only when text/file input is actionable; Stop still remains visible.
            if showSendControl {
                Button {
                    if vm.isStreaming && sendEnabled {
                        send()
                    } else if vm.isStreaming {
                        vm.stopStreaming()
                    } else {
                        send()
                    }
                } label: {
                    Image(systemName: vm.isStreaming && !sendEnabled ? "stop.fill" : "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 38, height: 38)
                        .background(
                            LinearGradient(colors: [AgentPalette.coral, AgentPalette.coralDim],
                                           startPoint: .topLeading, endPoint: .bottomTrailing),
                            in: Circle())
                        .overlay(Circle().strokeBorder(Color.white.opacity(0.22), lineWidth: 0.7))
                        .shadow(color: AgentPalette.coral.opacity(0.32), radius: 7, y: 3)
                        .almaAgentHitTarget()
                }
                .accessibilityLabel(vm.isStreaming && sendEnabled
                                    ? "বার্তাটি অপেক্ষায় রাখুন"
                                    : (vm.isStreaming ? "উত্তর থামান" : "বার্তা পাঠান"))
                .transition(reduceMotion ? .opacity : .asymmetric(
                    insertion: .move(edge: .trailing).combined(with: .opacity).combined(with: .scale(scale: 0.72)),
                    removal: .move(edge: .trailing).combined(with: .opacity).combined(with: .scale(scale: 0.72))))
            }
        }
        .frame(minHeight: 48)
        .animation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.78),
                   value: showSendControl)
    }

    private var showSendControl: Bool { sendEnabled || vm.isStreaming }

    private var sendEnabled: Bool {
        !vm.composerSubmissionPending
            && (!vm.composerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !vm.pendingFiles.isEmpty)
    }

    @ViewBuilder private func attachmentMenu(_ pal: AgentPalette) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("যোগ করুন")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(pal.muted)
                .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 3)
            attachmentChoice("Photo Library", icon: "photo.on.rectangle.angled", pal: pal) {
                presentAttachmentDestination { showPhotoPicker = true }
            }
            attachmentChoice("Camera", icon: "camera", pal: pal,
                             enabled: UIImagePickerController.isSourceTypeAvailable(.camera)) {
                presentAttachmentDestination { showCamera = true }
            }
            attachmentChoice("Files", icon: "folder", pal: pal) {
                presentAttachmentDestination { showDocumentPicker = true }
            }
            attachmentChoice("Scan Document", icon: "doc.viewfinder", pal: pal,
                             enabled: VNDocumentCameraViewController.isSupported) {
                presentAttachmentDestination { showScanner = true }
            }
            Rectangle().fill(pal.borderSubtle).frame(height: 1).padding(.vertical, 3)
            attachmentChoice("Recent Library", icon: "square.grid.2x2", pal: pal) {
                showAttachmentChoices = false
                NotificationCenter.default.post(name: AlmaAssistantLibraryRequest.note, object: nil)
            }
        }
        .padding(6)
        .frame(width: 228)
    }

    @ViewBuilder private func attachmentChoice(_ title: String, icon: String, pal: AgentPalette,
                                               enabled: Bool = true,
                                               action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(enabled ? AgentPalette.coral : pal.muted.opacity(0.35))
                    .frame(width: 22)
                Text(title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(enabled ? pal.ink : pal.muted.opacity(0.45))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).frame(minHeight: 43)
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(AlmaAgentPressStyle())
        .disabled(!enabled)
    }

    private func presentAttachmentDestination(_ action: @escaping () -> Void) {
        showAttachmentChoices = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: action)
    }

    private func send() {
        vm.send(vm.composerDraft)
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
            Capsule()
                .fill(pal.muted.opacity(0.35))
                .frame(width: 36, height: 4.5)
                .frame(maxWidth: .infinity)
                .padding(.top, 10)
            sectionShortcuts(pal)
                .padding(.top, 12)
            tabsBar(pal)
                .padding(.horizontal, 14)
                .padding(.top, 12)
            if tab == 0 { chatsTab(pal) } else { memoryTab(pal) }
        }
    }

    private func divider(_ pal: AgentPalette) -> some View {
        Rectangle().fill(pal.borderSubtle).frame(height: 1)
    }

    /// Every Agent destination previously exposed by the floating AssistiveTouch
    /// control remains available here. Keeping navigation in the drawer gives the
    /// conversation a collision-free reading plane and a predictable home.
    @ViewBuilder private func sectionShortcuts(_ pal: AgentPalette) -> some View {
        let destinations: [(String, String, String?)] = [
            ("Chat", "bubble.left.and.text.bubble.right", nil),
            ("Studio", "wand.and.stars", "/agent/creative-studio"),
            ("WhatsApp", "message.fill", "/agent/whatsapp"),
            ("Monitor", "chart.bar.xaxis", "/agent/staff-monitor"),
            ("Costs", "dollarsign.circle", "/agent/costs"),
            ("Hub", "square.grid.2x2.fill", "/agent/hub"),
        ]
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(destinations.enumerated()), id: \.offset) { _, item in
                    Button {
                        AlmaAgentHaptics.selection()
                        if let path = item.2 {
                            closeThen { openWeb(path, item.0) }
                        } else {
                            close()
                        }
                    } label: {
                        VStack(spacing: 5) {
                            Image(systemName: item.1)
                                .font(.system(size: 15, weight: .medium))
                            Text(item.0).font(.caption2.weight(.medium))
                        }
                        .foregroundStyle(item.2 == nil ? AgentPalette.coral : pal.mutedHi)
                        .frame(width: 58, height: 52)
                        .background(pal.card.opacity(0.44),
                                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(item.2 == nil
                                ? AgentPalette.coral.opacity(0.35) : pal.borderSubtle,
                                lineWidth: 1))
                    }
                    .buttonStyle(AlmaAgentPressStyle())
                    .accessibilityLabel(item.0)
                }
            }
            .padding(.horizontal, 14)
        }
    }

    /// চ্যাট / স্মৃতি — a native pill segmented control with the app's coral accent.
    @ViewBuilder private func tabsBar(_ pal: AgentPalette) -> some View {
        HStack(spacing: 4) {
            tabButton("চ্যাট", icon: "bubble.left", index: 0, pal: pal)
            tabButton("স্মৃতি", icon: "brain.head.profile", index: 1, pal: pal)
        }
        .padding(4)
        .background(Color.white.opacity(scheme == .dark ? 0.05 : 0.35), in: Capsule())
        .overlay(Capsule().strokeBorder(pal.borderSubtle, lineWidth: 1))
    }

    private func tabButton(_ label: String, icon: String, index: Int, pal: AgentPalette) -> some View {
        Button {
            AlmaAgentHaptics.selection()
            withAnimation(.snappy(duration: 0.2)) { tab = index }
            if index == 1 { Task { await vm.loadMemories(scope: memScope) } }
        } label: {
            Label(label, systemImage: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tab == index ? .white : pal.muted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .background(tab == index ? AnyShapeStyle(AgentPalette.coral) : AnyShapeStyle(.clear),
                            in: Capsule())
        }
        .buttonStyle(AlmaAgentPressStyle())
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
                AlmaAgentHaptics.light()
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
            .buttonStyle(AlmaAgentPressStyle())
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
                            .accessibilityLabel("সার্চ মুছুন")
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
                            .disabled(vm.conversationMutationBlocked(for: c.id))
                            Button {
                                Task { await vm.archiveConversation(c.id) }
                            } label: {
                                Label("আর্কাইভ", systemImage: "archivebox")
                            }
                            .tint(.orange)
                            .disabled(vm.conversationMutationBlocked(for: c.id))
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
        .buttonStyle(AlmaAgentPressStyle())
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
                    AlmaAgentHaptics.selection()
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
        ["শুভ সকাল — দিনটা শুরু করি",
         "শুভ দুপুর — কীভাবে সাহায্য করতে পারি",
         "শুভ সন্ধ্যা — দিনটা গুছিয়ে নিই",
         "শুভ রাত্রি — কী দেখে নেবো"][dayPart]
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
        VStack(spacing: 8) {
            AgentNewSessionHero(pal: pal)
                .frame(height: 150)
            Text("আস্সালামু আলাইকুম, Boss")
                .font(.system(size: 20, weight: .semibold, design: .rounded))
                .foregroundStyle(pal.ink)
            Text(subtitle)
                .font(.system(size: 13.5))
                .foregroundStyle(pal.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 58)
        .padding(.horizontal, 24)
    }
}

/// LOCKED §9 — "N কাজ বাকি": chat shows ONLY a small collapsed glossy chip;
/// tap → glossy bottom sheet with THREE actions per task: অনুমোদন · বাতিল · আমার মত.
/// (Owner rule 2026-07-07: every approval ask = 3 buttons, never 2 — everywhere.)
@available(iOS 17.0, *)
struct AgentOpenTasksChipView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion // IOSP-5
    @Bindable var vm: AssistantVM
    let pal: AgentPalette
    @State private var showSheet = false
    @State private var ping = false

    var body: some View {
        Button {
            AlmaAgentHaptics.light()
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
                    guard !reduceMotion else { return } // IOSP-5: no perpetual ping under Reduce Motion
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
        .buttonStyle(AlmaAgentPressStyle())
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
                        .accessibilityLabel("বন্ধ করুন")
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
            || task.pendingActionId.map { vm.isSubmittingAction("action:\($0)") } == true
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
                    AlmaAgentHaptics.commit()
                    Task { if await approve(task) { dismiss() } }
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
                    AlmaAgentHaptics.light()
                    Task { if await reject(task) { dismiss() } }
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
                AlmaAgentHaptics.light()
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
            .buttonStyle(AlmaAgentPressStyle())
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
                        AlmaAgentHaptics.commit()
                        Task { if await opine(task, note: t) { dismiss() } }
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

    private func approve(_ task: AgentOpenTask) async -> Bool {
        if task.kind == "approval_pending", let pid = task.pendingActionId {
            return await vm.approveAction(pid, approve: true)
        } else {
            await vm.continueOpenTask(task)
            return true
        }
    }

    private func reject(_ task: AgentOpenTask) async -> Bool {
        if task.kind == "approval_pending", let pid = task.pendingActionId {
            return await vm.approveAction(pid, approve: false)
        } else {
            await vm.cancelOpenTask(task)
            return true
        }
    }

    /// আমার মত — reject/park the pending work, then send the owner's note so the
    /// agent self-corrects (LOCKED: the 3rd option, everywhere).
    private func opine(_ task: AgentOpenTask, note: String) async -> Bool {
        if task.kind == "approval_pending", let pid = task.pendingActionId {
            let saved = await vm.submitOpinion(pid, note: note)
            if saved { await vm.loadOpenTasks() }
            return saved
        } else {
            vm.send(note)
            await vm.loadOpenTasks()
            return true
        }
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
            AlmaAgentHaptics.light()
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
        .buttonStyle(AlmaAgentPressStyle())
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
                        AlmaAgentHaptics.light()
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
                        AlmaAgentHaptics.selection()
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
                    .buttonStyle(AlmaAgentPressStyle())
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
            AlmaAgentHaptics.selection()
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
        .buttonStyle(AlmaAgentPressStyle())
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
            AlmaAgentHaptics.selection()
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
        .buttonStyle(AlmaAgentPressStyle())
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
                AlmaAgentHaptics.rigid()
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
            .buttonStyle(AlmaAgentPressStyle())
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
            AlmaAgentHaptics.light()
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
        .buttonStyle(AlmaAgentPressStyle())
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion // IOSP-5
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
                    AlmaAgentHaptics.commit()
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
                guard !reduceMotion else { return } // IOSP-5: no perpetual ping under Reduce Motion
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
                AlmaAgentHaptics.selection()
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
            .buttonStyle(AlmaAgentPressStyle())
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
            AlmaAgentHaptics.light()
            action()
        } label: {
            Text(label)
                .font(.system(size: 10.5, weight: .bold))
                .foregroundStyle(color)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(color.opacity(0.1), in: Capsule())
                .overlay(Capsule().strokeBorder(color.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(AlmaAgentPressStyle())
    }
}

// MARK: - Unified session Files (roadmap Phase 3)

@available(iOS 17.0, *)
private struct AgentQuickLookPreview: UIViewControllerRepresentable {
    let url: URL
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController,
                               previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}
}

@available(iOS 17.0, *)
private struct AgentUploadedFileViewerSheet: View {
    let file: AgentSessionFile
    let vm: AssistantVM
    @Environment(\.dismiss) private var dismiss
    @State private var localURL: URL?
    @State private var loadError: String?

    var body: some View {
        NavigationStack {
            Group {
                if let localURL {
                    AgentQuickLookPreview(url: localURL)
                } else if let loadError {
                    ContentUnavailableView {
                        Label("ফাইল খোলা যায়নি", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(loadError)
                    } actions: {
                        Button("আবার চেষ্টা করুন") { self.loadError = nil; Task { await load() } }
                    }
                } else {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("ফাইল প্রস্তুত হচ্ছে…").font(.system(size: 13)).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(file.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("বন্ধ করুন") { dismiss() } }
                if let localURL {
                    ToolbarItem(placement: .topBarTrailing) {
                        ShareLink(item: localURL) {
                            Image(systemName: "square.and.arrow.up")
                                .frame(minWidth: 44, minHeight: 44)
                                .accessibilityLabel("শেয়ার বা Files-এ সেভ")
                        }
                    }
                }
            }
            .task { if localURL == nil && loadError == nil { await load() } }
        }
        .onDisappear {
            guard let localURL,
                  localURL.lastPathComponent.hasPrefix("alma-file-") else { return }
            try? FileManager.default.removeItem(at: localURL)
        }
    }

    private func load() async {
        if let content = file.artifactContent {
            do {
                let safe = file.name.replacingOccurrences(of: "/", with: "-")
                let target = FileManager.default.temporaryDirectory
                    .appendingPathComponent("alma-file-\(file.id.hashValue)-\(safe)")
                if file.mediaType.hasPrefix("image/"),
                   let remote = URL(string: content), remote.scheme != nil {
                    let (data, response) = try await URLSession.shared.data(from: remote)
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 200
                    guard status < 300 else { throw URLError(.badServerResponse) }
                    try data.write(to: target, options: .atomic)
                } else {
                    try Data(content.utf8).write(to: target, options: .atomic)
                }
                localURL = target
                AlmaAgentHaptics.success()
            } catch {
                loadError = "ফাইল প্রস্তুত করা যায়নি — আবার চেষ্টা করুন"
            }
            return
        }
        guard let ref = file.fileRef, let signed = await vm.signedURL(for: ref.path) else {
            loadError = "ডাউনলোড লিংক পাওয়া যায়নি"
            return
        }
        do {
            let (data, response) = try await URLSession.shared.data(from: signed)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 200
            guard status < 300 else {
                throw URLError(.badServerResponse)
            }
            let safe = file.name.replacingOccurrences(of: "/", with: "-")
            let target = FileManager.default.temporaryDirectory
                .appendingPathComponent("alma-file-\(file.id.hashValue)-\(safe)")
            try data.write(to: target, options: .atomic)
            localURL = target
            AlmaAgentHaptics.success()
        } catch {
            loadError = "ডাউনলোড ব্যর্থ — নেটওয়ার্ক দেখে আবার চেষ্টা করুন"
            AlmaAgentHaptics.error()
        }
    }
}

// MARK: - Unified session Library (v2 screenshot-locked large surface)

@available(iOS 17.0, *)
private struct AgentLibrarySheet: View {
    enum Filter: String, CaseIterable { case all = "All", uploaded = "Uploaded", generated = "Generated" }

    @Bindable var vm: AssistantVM
    let onShowInConversation: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var filter: Filter = .all
    @State private var selected: AgentSessionFile?

    private var files: [AgentSessionFile] {
        switch filter {
        case .all: return vm.sessionFiles
        case .uploaded: return vm.sessionFiles.filter { $0.origin == .uploaded }
        case .generated: return vm.sessionFiles.filter { $0.origin == .generated }
        }
    }

    var body: some View {
        let pal = AgentPalette(scheme)
        NavigationStack {
            ZStack {
                AgentAuroraBackground()
                VStack(spacing: 0) {
                    Picker("Library filter", selection: $filter) {
                        ForEach(Filter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 18).padding(.vertical, 12)

                    if vm.sessionFilesIndexLoading && files.isEmpty {
                        VStack(spacing: 12) {
                            ProgressView()
                            Text("পুরো কথোপকথনের file index লোড হচ্ছে…")
                                .font(.footnote)
                                .foregroundStyle(pal.muted)
                        }
                        .frame(maxHeight: .infinity)
                    } else if files.isEmpty {
                        ContentUnavailableView {
                            Label("Library খালি", systemImage: "square.grid.2x2")
                        } description: {
                            Text(vm.sessionFiles.isEmpty
                                 ? "এই কথোপকথনে এখনো uploaded বা generated file নেই"
                                 : "এই filter-এ কোনো file নেই")
                        }
                        .frame(maxHeight: .infinity)
                    } else {
                        ScrollView {
                            LazyVGrid(columns: [
                                GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12),
                            ], spacing: 14) {
                                ForEach(files) { file in
                                    AgentLibraryTile(file: file, vm: vm, pal: pal) {
                                        selected = file
                                    }
                                    .contextMenu {
                                        Button { selected = file } label: {
                                            Label("Open / Preview", systemImage: "eye")
                                        }
                                        if let messageId = file.messageId {
                                            Button {
                                                dismiss()
                                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                                                    onShowInConversation(messageId)
                                                }
                                            } label: {
                                                Label("Show in conversation", systemImage: "text.bubble")
                                            }
                                        }
                                    }
                                }
                            }
                            .padding(.horizontal, 16).padding(.bottom, 30)
                        }
                    }
                }
            }
            .navigationTitle("Library")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(pal.ink)
                            .frame(width: 38, height: 38)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .accessibilityLabel("Close Library")
                }
            }
        }
        .sheet(item: $selected) { AgentUploadedFileViewerSheet(file: $0, vm: vm) }
        .task { await vm.loadFullSessionFileIndex() }
        .presentationDetents([.large])
        .presentationDragIndicator(.hidden)
        .presentationCornerRadius(30)
        .presentationBackground(.ultraThinMaterial)
    }
}

@available(iOS 17.0, *)
private struct AgentLibraryTile: View {
    let file: AgentSessionFile
    let vm: AssistantVM
    let pal: AgentPalette
    let action: () -> Void
    @State private var thumbnailURL: URL?

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 9) {
                ZStack {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(pal.card.opacity(0.72))
                    if file.mediaType.hasPrefix("image/"), let thumbnailURL {
                        AsyncImage(url: thumbnailURL) { phase in
                            if let image = phase.image {
                                image.resizable().scaledToFill()
                            } else {
                                semanticPreview
                            }
                        }
                    } else if file.mediaType == "text/markdown", let text = file.artifactContent {
                        Text(String(text.prefix(180)))
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(pal.mutedHi)
                            .lineLimit(8)
                            .padding(12)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    } else {
                        semanticPreview
                    }
                }
                .frame(height: 132)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.white.opacity(0.1)))

                Text(file.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(pal.ink).lineLimit(1)
                HStack(spacing: 5) {
                    Text(file.typeLabel)
                    Text("·")
                    Text(file.origin == .uploaded ? "Uploaded" : "Generated")
                }
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(pal.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(AlmaAgentPressStyle())
        .task {
            guard file.mediaType.hasPrefix("image/") else { return }
            if let ref = file.fileRef {
                thumbnailURL = await vm.signedURL(for: ref.path)
            } else if let content = file.artifactContent,
                      let url = URL(string: content), url.scheme != nil {
                thumbnailURL = url
            }
        }
    }

    @ViewBuilder private var semanticPreview: some View {
        VStack(spacing: 9) {
            Image(systemName: icon)
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(AgentPalette.coral)
            Text(file.typeLabel)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(pal.mutedHi)
        }
    }

    private var icon: String {
        if file.mediaType == "application/pdf" { return "doc.richtext.fill" }
        if file.mediaType == "text/markdown" { return "text.document.fill" }
        if file.mediaType.hasPrefix("image/") { return "photo.fill" }
        return "doc.fill"
    }
}

@available(iOS 17.0, *)
private struct AgentConversationProjectPicker: View {
    @Bindable var vm: AssistantVM
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    private var rows: [AgentProject] {
        search.isEmpty ? vm.projects : vm.projects.filter { $0.name.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        NavigationStack {
            List {
                Button {
                    Task { if await vm.assignConversationProject(nil) { dismiss() } }
                } label: {
                    Label("কোনো Project নয়", systemImage: vm.currentProjectId == nil ? "checkmark.circle.fill" : "circle")
                }
                ForEach(rows) { project in
                    Button {
                        Task { if await vm.assignConversationProject(project.id) { dismiss() } }
                    } label: {
                        HStack {
                            Label(project.name, systemImage: "folder")
                            Spacer()
                            if vm.currentProjectId == project.id { Image(systemName: "checkmark") }
                        }
                    }
                }
            }
            .searchable(text: $search, prompt: "Project খুঁজুন")
            .navigationTitle(vm.currentProjectId == nil ? "Add to Project" : "Move to Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Close") { dismiss() } } }
            .task { await vm.loadProjects() }
        }
        .presentationDetents([.medium, .large])
    }
}

@available(iOS 17.0, *)
private struct AgentConversationSearchSheet: View {
    @Bindable var vm: AssistantVM
    let onSelect: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var matches: [AgentChatMessage] {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        return vm.searchableMessages.filter { $0.text.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            List(matches) { message in
                Button {
                    guard vm.focusCachedMessage(message.id) else { return }
                    dismiss()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { onSelect(message.id) }
                } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(message.role == .user ? "আপনি" : "ALMA")
                            .font(.caption.weight(.semibold)).foregroundStyle(AgentPalette.coral)
                        Text(message.text).lineLimit(3)
                    }
                }
            }
            .overlay {
                if !query.isEmpty && matches.isEmpty {
                    ContentUnavailableView.search(text: query)
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: "এই chat-এ খুঁজুন")
            .navigationTitle("Search in this chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Close") { dismiss() } } }
        }
        .presentationDetents([.large])
    }
}

@available(iOS 17.0, *)
private struct AgentConversationShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

@available(iOS 17.0, *)
private struct AgentInlineUploadedFileCard: View {
    let ref: AgentFileRef
    let messageId: String
    let vm: AssistantVM
    @Environment(\.colorScheme) private var scheme
    @State private var selected: AgentSessionFile?

    var body: some View {
        let pal = AgentPalette(scheme)
        let rawName = URL(fileURLWithPath: ref.path).lastPathComponent
        let name = rawName.removingPercentEncoding ?? rawName
        Button {
            selected = .init(id: "uploaded:\(ref.bucket):\(ref.path)", origin: .uploaded,
                             name: name, mediaType: ref.mediaType, createdAt: nil,
                             messageId: messageId, fileRef: ref, artifactId: nil, artifactContent: nil)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: ref.mediaType == "application/pdf" ? "doc.richtext.fill" : "doc.fill")
                    .font(.system(size: 20)).foregroundStyle(AgentPalette.coral)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.system(size: 13, weight: .semibold)).foregroundStyle(pal.ink).lineLimit(1)
                    Text(ref.mediaType == "application/pdf" ? "PDF" : "File")
                        .font(.system(size: 10)).foregroundStyle(pal.muted)
                }
                Spacer()
                Image(systemName: "arrow.down.circle").foregroundStyle(pal.muted)
            }
            .padding(12)
            .frame(maxWidth: 280, minHeight: 52)
            .modifier(AlmaAgentGlassBackground(
                shape: RoundedRectangle(cornerRadius: 14, style: .continuous), pal: pal))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(pal.borderSubtle))
        }
        .sheet(item: $selected) { AgentUploadedFileViewerSheet(file: $0, vm: vm) }
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
                    AlmaAgentHaptics.selection()
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
                .buttonStyle(AlmaAgentPressStyle())
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
                    AlmaAgentHaptics.light()
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { copied = false }
                } label: {
                    Label(copied ? "কপি হয়েছে ✓" : "কপি", systemImage: "doc.on.doc")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(pal.mutedHi)
                        .padding(.horizontal, 11).padding(.vertical, 7)
                        .background(Color.white.opacity(0.08), in: Capsule())
                }
                .buttonStyle(AlmaAgentPressStyle())
                Spacer()
            }
            if isWebOnly(a) {
                // Live HTML/SVG preview stays a web feature — offer the escape.
                Button {
                    AlmaAgentHaptics.light()
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
                .buttonStyle(AlmaAgentPressStyle())
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion // IOSP-5
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
    @State private var showLibrary = false
    @State private var showProjectPicker = false
    @State private var showConversationSearch = false
    @State private var showRenameConversation = false
    @State private var showDeleteConversation = false
    @State private var renameConversationText = ""
    @State private var conversationShareURL: URL?
    @State private var timelineScrollTarget: String?
    /// DEBUG self-test hook (ALMA_ASSISTANT_VIEWERTEST=1) — presents the zoomable
    /// image viewer with its সংরক্ষণ button for a headless fixture screenshot.
    @State private var debugViewer: PortalImagePreview?
    @State private var showBackgroundTasks = false
    @State private var backgroundTaskDetent: PresentationDetent = .medium
    // Agent animations (spec ALMA_NATIVE_IOS_AGENT_ANIMATIONS_SPEC.md): session-
    // opening awakening overlay + hidden pull-to-refresh. Pure additive layers.
    @State private var awakening = AgentAwakeningModel()
    @State private var agentPull = AgentPullState()

    let openWeb: (_ path: String, _ title: String) -> Void
    /// Wired by makeAssistantTab so the native bar buttons drive this screen.
    let barHooks: AssistantBarHooks

    private static let bottomID = "ALMA_BOTTOM"

    private var hasBlockingPresentation: Bool {
        vm.showSidebar || vm.showVoice || debugViewer != nil || toolSheet != nil
            || activitySheet != nil || showArtifacts || showLibrary || showProjectPicker
            || showConversationSearch || showBackgroundTasks
    }

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
                                AlmaAgentHaptics.selection()
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
                            .buttonStyle(AlmaAgentPressStyle())
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
                            // IOSP-5: Reduce Motion → new rows appear without the
                            // slide/offset (a plain fade), calmer for motion-sensitive users.
                            .transition(reduceMotion
                                ? .opacity
                                : .asymmetric(insertion: .opacity.combined(with: .offset(y: 12)),
                                              removal: .opacity))
                        }
                        if vm.canLoadNewer {
                            Button {
                                AlmaAgentHaptics.selection()
                                let anchorId = vm.messages.last?.id
                                Task {
                                    await vm.loadNewerMessages()
                                    if let anchorId {
                                        var tx = Transaction(); tx.disablesAnimations = true
                                        withTransaction(tx) { proxy.scrollTo(anchorId, anchor: .top) }
                                    }
                                }
                            } label: {
                                Label("আরও নতুন মেসেজ", systemImage: "arrow.down.circle")
                                    .font(.system(size: 12.5, weight: .medium))
                                    .foregroundStyle(pal.muted)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 9)
                            }
                            .buttonStyle(AlmaAgentPressStyle())
                            .accessibilityHint("পরের cached page দেখাবে; বর্তমান জায়গা অপরিবর্তিত থাকবে")
                        }
                        // A brand-new chat intentionally has no reply footer.
                        // ALMA identity + Background Tasks belong to a settled
                        // assistant reply, never to the empty welcome state.
                        Color.clear.frame(height: 4).id(Self.bottomID)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
                    .background(scrollOffsetReader)
                    // IOSP-5: no spring on message-count change under Reduce Motion.
                    .animation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.8), value: vm.messages.count)
                }
                .coordinateSpace(name: "agentscroll")
                // Hidden pull-to-refresh (spec §3): exactly 0pt at idle, revealed
                // only by top-edge overscroll; release above threshold reloads the
                // REAL conversation once. Off while the awakening overlay owns the
                // screen. iOS 18+ scroll APIs; on 17 the modifier is inert.
                .modifier(AgentPullToRefreshModifier(
                    state: agentPull,
                    isEnabled: !awakening.isActive,
                    refresh: { @MainActor in await vm.loadMessages() }))
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
                .onChange(of: timelineScrollTarget) { _, target in
                    guard let target else { return }
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { proxy.scrollTo(target, anchor: .center) }
                    timelineScrollTarget = nil
                }
                .overlay(alignment: .bottom) {
                    // Web parity: centered 40pt frosted circle just above the composer.
                    if !nearBottom {
                        Button {
                            AlmaAgentHaptics.selection()
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
        .buttonStyle(AlmaAgentPressStyle())
        .claudeTopFade()
        // Pull stage ABOVE the top fade (under it, the fade's blur washes it out).
        .overlay(alignment: .top) { AgentPullStage(state: agentPull) }
        // Session-opening awakening (spec §2): centered in the content area only —
        // the ZStack's frame already excludes the composer inset below and the
        // native header above, so neither is ever covered.
        .overlay { AgentAwakeningOverlay(model: awakening) }
        // Opening a DIFFERENT existing conversation from the drawer replays the
        // awakening (owner 2026-07-17: not only on app launch). Success stays
        // gated on the real history load (restoreReadyTick).
        .onChange(of: vm.restoreTick) { _, _ in awakening.restart(sessionNeedsRestore: true) }
        .onChange(of: vm.restoreReadyTick) { _, _ in awakening.markReady(hasContent: !vm.messages.isEmpty) }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            AgentComposerView(vm: vm, openWeb: openWeb)
        }
        .task {
            AlmaTurnLog.event("assistant.open.begin")
            AlmaTurnLog.event(
                "accessibility.settings",
                "reduceMotion=\(UIAccessibility.isReduceMotionEnabled) reduceTransparency=\(UIAccessibility.isReduceTransparencyEnabled) contentSize=\(UIApplication.shared.preferredContentSizeCategory.rawValue)")
            barHooks.onMenu = { Self.presentDrawer(vm) }
            barHooks.onNewChat = { Task { await vm.newChat() } }
            barHooks.provideModelMenu = { completion in
                Task { @MainActor in
                    await vm.loadModels()
                    completion(AssistantBarHooks.modelMenuElements(
                        models: vm.models,
                        selectedId: vm.modelId,
                        onSelect: { vm.selectModel($0) }
                    ))
                }
            }
            barHooks.installModelMenu()
            barHooks.updateModelLabel(vm.modelPillLabel, enabled: !vm.isStreaming)
            barHooks.isPinned = { vm.currentConversationPinned }
            barHooks.hasProject = { vm.currentProjectId != nil }
            barHooks.canMutateConversation = { !vm.conversationMutationBlocked }
            barHooks.onShare = {
                Task { conversationShareURL = await vm.exportConversation(.share) }
            }
            barHooks.onPin = { Task { await vm.toggleConversationPin() } }
            barHooks.onProject = { showProjectPicker = true }
            barHooks.onLibrary = { showLibrary = true }
            barHooks.onSearch = { showConversationSearch = true }
            barHooks.onExport = { format in
                Task { conversationShareURL = await vm.exportConversation(format) }
            }
            barHooks.onRename = {
                renameConversationText = vm.conversationTitle
                showRenameConversation = true
            }
            barHooks.onArchive = {
                guard let id = vm.conversationId else { return }
                Task { await vm.archiveConversation(id) }
            }
            barHooks.onDelete = { showDeleteConversation = true }
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
            #if DEBUG
            // Headless visual proof for the new-session hero + floating composer.
            // This never ships an alternate production path; it only avoids a
            // network/login dependency while simulator screenshots are captured.
            if argFlag("ALMA_ASSISTANT_NEW_SESSION_UI") {
                vm.messages = []
                vm.conversationId = nil
                vm.conversationTitle = "ALMA AI"
                vm.modelId = nil
                vm.composerDraft = rawEnv["ALMA_ASSISTANT_COMPOSER_TEXT"] ?? ""
                AlmaTurnLog.event("assistant.contentReady", "fixture=new-session-ui")
                return
            }
            #endif
            // Roadmap Phase 0 — local scroll/streaming stress fixture; skips the
            // server entirely (no bootstrap) so layout is tested in isolation.
            if argFlag("ALMA_ASSISTANT_HUGE_SESSION") {
                vm.loadHugeSessionFixture()
                AlmaTurnLog.event("assistant.contentReady", "fixture=huge mounted=\(vm.messages.count) indexed=\(vm.searchableMessages.count)")
                return
            }
            if argFlag("ALMA_ASSISTANT_DICTATION_RECOVERY") {
                vm.loadDictationRecoveryFixture()
                AlmaTurnLog.event("assistant.contentReady", "fixture=dictation-recovery")
                return
            }
            if argFlag("ALMA_ASSISTANT_FIXTURE") {
                vm.loadDebugFixture()
                AlmaTurnLog.event("assistant.contentReady", "fixture=stress count=\(vm.messages.count)")
                return
            }
            if argFlag("ALMA_ASSISTANT_READING_FIXTURE") {
                vm.loadReadingSurfaceFixture()
                AlmaTurnLog.event("assistant.contentReady", "fixture=reading-surface")
                if !argFlag("ALMA_ASSISTANT_READING_BOTTOM") {
                    Task {
                        try? await Task.sleep(for: .milliseconds(750))
                        timelineScrollTarget = "reading-owner"
                    }
                }
                return
            }
            #if DEBUG
            if argFlag("ALMA_ASSISTANT_ATTACHMENT_ATOMIC") {
                vm.runAttachmentAtomicFixture()
                AlmaTurnLog.event("assistant.contentReady", "fixture=attachment-atomic")
                return
            }
            if argFlag("ALMA_ASSISTANT_QUEUE_HOLD") {
                vm.loadMergeReadinessQueueFixture()
                AlmaTurnLog.event("assistant.contentReady", "fixture=queue-hold")
                return
            }
            if argFlag("ALMA_ASSISTANT_ACTION_FIXTURE") {
                vm.loadMergeReadinessActionFixture()
                AlmaTurnLog.event("assistant.contentReady", "fixture=actions")
                return
            }
            if argFlag("ALMA_ASSISTANT_MULTI_APPROVAL") {
                vm.loadMergeReadinessMultiApprovalFixture()
                AlmaTurnLog.event("assistant.contentReady", "fixture=multi-approval")
                return
            }
            if argFlag("ALMA_ASSISTANT_RECOVERY_SEED") {
                vm.loadMergeReadinessRecoverySeed()
                AlmaTurnLog.event("assistant.contentReady", "fixture=recovery-seed")
                if argFlag("ALMA_ASSISTANT_RECOVERY_TRIGGER") {
                    Task {
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        await vm.runMergeReadinessReconnect()
                    }
                } else if argFlag("ALMA_ASSISTANT_OFFLINE_SETTLE") {
                    Task {
                        try? await Task.sleep(nanoseconds: 1_000_000_000)
                        await vm.runMergeReadinessOfflineSettle()
                    }
                }
                return
            }
            if argFlag("ALMA_ASSISTANT_STREAM_EOF") {
                vm.runUnexpectedStreamEOFFixture()
                AlmaTurnLog.event("assistant.contentReady", "fixture=stream-eof")
                return
            }
            #endif
            // Parity roadmap — persisted verification-retry composition only.
            if argFlag("ALMA_ASSISTANT_PARITY") {
                vm.loadParityFixture()
                if rawEnv["ALMA_MERGE_MOCK"] != nil
                    || args.contains(where: { $0.hasPrefix("ALMA_MERGE_MOCK=") }) {
                    vm.conversationId = "fixture-conversation"
                }
                if argFlag("ALMA_ASSISTANT_FILE_CARD") {
                    vm.messages = Array(vm.messages.prefix(1))
                } else if argFlag("ALMA_ASSISTANT_UPLOAD_FAILED") {
                    vm.pendingFiles = [
                        .init(name: "supplier-price-list.pdf", mediaType: "application/pdf",
                              data: Data("fixture".utf8), image: nil, state: .failed),
                    ]
                }
                AlmaTurnLog.event("assistant.contentReady", "fixture=parity count=\(vm.messages.count)")
                if argFlag("ALMA_ASSISTANT_LIBRARY") {
                    Task {
                        try? await Task.sleep(nanoseconds: 650_000_000)
                        showLibrary = true
                    }
                }
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
            #if DEBUG
            // Animation logic selftest (pull math / hysteresis / reducer gating).
            AgentAnimSelfTest.runIfRequested()
            // ALMA_ANIM_DEMO=1 — hold readiness ~9s so every awakening phase can
            // be screenshotted headlessly, then hand over to the real session.
            if argFlag("ALMA_ANIM_DEMO") {
                awakening.begin(sessionNeedsRestore: true)
                await vm.bootstrap()
                try? await Task.sleep(nanoseconds: 9_000_000_000)
                awakening.markReady(hasContent: true)
                return
            }
            // ALMA_ANIM_OPENDEMO=1 — headless proof of the drawer path: after
            // bootstrap, open a DIFFERENT existing conversation via the SAME
            // vm.openConversation the drawer row calls → the awakening must
            // replay over it (owner feedback 2026-07-17).
            if argFlag("ALMA_ANIM_OPENDEMO") {
                await vm.bootstrap()
                await vm.loadConversations()   // the drawer loads this list on open
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                if let other = vm.conversations.first(where: { $0.id != vm.conversationId })
                    ?? vm.conversations.first {
                    await vm.openConversation(other.id)
                }
                return
            }
            // ALMA_ANIM_PULLDEMO=1 — drive the REAL pull state machine headlessly
            // (scrub ramp → armed → release → real loadMessages → celebrate) so the
            // stage can be screenshotted without a finger. Gesture wiring itself is
            // owner-verified by a live drag in the sim.
            if argFlag("ALMA_ANIM_PULLDEMO") {
                await vm.bootstrap()
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                for step in stride(from: CGFloat(0), through: 195, by: 6.5) {
                    agentPull.dragChanged(rawPull: step)
                    try? await Task.sleep(nanoseconds: 90_000_000)
                }
                try? await Task.sleep(nanoseconds: 2_200_000_000)   // armed hold
                agentPull.dragEnded { @MainActor in await vm.loadMessages() }
                return
            }
            #endif
            // Awakening overlay: only when an existing session must restore (the
            // message list is still empty at first appear). Success is gated on
            // the REAL bootstrap finishing below.
            awakening.begin(sessionNeedsRestore: vm.messages.isEmpty)
            await vm.bootstrap()
            awakening.markReady(hasContent: !vm.messages.isEmpty)
            AlmaTurnLog.event("assistant.contentReady", "live count=\(vm.messages.count)")
        }
        .fullScreenCover(isPresented: $vm.showSidebar) {
            AgentSideDrawer(vm: vm, openWeb: openWeb)
                .presentationBackground(.clear)
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("almaVoiceDebugOpen"))) { _ in
            #if DEBUG
            vm.showVoice = true
            #endif
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("almaDictateToggle"))) { _ in
            #if DEBUG
            vm.toggleRecording()
            #endif
        }
        .fullScreenCover(isPresented: $vm.showVoice) {
            AlmaVoiceConsoleView(vm: vm)
        }
        .overlay(alignment: .top) {
            if !vm.showVoice && vm.voiceEngine.isCallRunning {
                AlmaVoiceCallMiniBar(
                    engine: vm.voiceEngine,
                    reopen: { vm.showVoice = true },
                    end: { vm.voiceEngine.end() }
                )
                .transition(.move(edge: .top).combined(with: .opacity))
                .zIndex(50)
            }
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
        .sheet(isPresented: $showLibrary) {
            AgentLibrarySheet(vm: vm) { messageId in
                Task {
                    if await vm.focusSessionFileSource(messageId) {
                        timelineScrollTarget = messageId
                    }
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: AlmaAssistantLibraryRequest.note)) { _ in
            showLibrary = true
        }
        .sheet(isPresented: $showProjectPicker) {
            AgentConversationProjectPicker(vm: vm)
        }
        .sheet(isPresented: $showConversationSearch) {
            AgentConversationSearchSheet(vm: vm) { messageId in timelineScrollTarget = messageId }
        }
        .sheet(item: $conversationShareURL) { url in
            AgentConversationShareSheet(url: url)
        }
        .sheet(isPresented: $showBackgroundTasks) {
            AgentBackgroundTasksSheet(vm: vm, selectedDetent: $backgroundTaskDetent)
                .presentationDetents([.medium, .large], selection: $backgroundTaskDetent)
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(28)
        }
        .alert("Rename conversation", isPresented: $showRenameConversation) {
            TextField("নাম", text: $renameConversationText)
            Button("Save") {
                guard let id = vm.conversationId else { return }
                Task { await vm.renameConversation(id, title: renameConversationText) }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Delete this conversation?", isPresented: $showDeleteConversation) {
            Button("Delete", role: .destructive) {
                guard let id = vm.conversationId else { return }
                Task { await vm.deleteConversation(id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("এই conversation ও এর message স্থায়ীভাবে মুছে যাবে।")
        }
        .onChange(of: hasBlockingPresentation) { _, shown in
            FloatingChatHead.shared.setSuppressed(shown, reason: "assistant-presentation")
        }
        .onChange(of: vm.modelPillLabel) { _, label in
            barHooks.updateModelLabel(label, enabled: !vm.isStreaming)
        }
        .onChange(of: vm.isStreaming) { _, streaming in
            barHooks.updateModelLabel(vm.modelPillLabel, enabled: !streaming)
        }
        .onAppear {
            // The Assistant already has its own conversation controls; the
            // app-wide office chat head obscures long answers and the composer.
            FloatingChatHead.shared.setSuppressed(true, reason: "assistant-screen")
        }
        .onDisappear {
            FloatingChatHead.shared.setSuppressed(false, reason: "assistant-presentation")
            FloatingChatHead.shared.setSuppressed(false, reason: "assistant-screen")
        }
        .overlay(alignment: .top) {
            if vm.authExpired { authBanner(pal) }
        }
        // Artifacts badge — web header-badge parity: appears only when this
        // conversation actually has artifacts; tap → glossy list/detail sheet.
        .overlay(alignment: .topTrailing) {
            if !vm.artifacts.isEmpty && !vm.authExpired {
                Button {
                    AlmaAgentHaptics.light()
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
                .buttonStyle(AlmaAgentPressStyle())
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
@MainActor
final class AssistantModelPillButton: UIButton {
    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterial))
    private let modelText = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        blur.translatesAutoresizingMaskIntoConstraints = false
        blur.isUserInteractionEnabled = false
        blur.layer.cornerRadius = 18
        blur.clipsToBounds = true
        addSubview(blur)

        modelText.translatesAutoresizingMaskIntoConstraints = false
        modelText.font = .systemFont(ofSize: 12.5, weight: .semibold)
        modelText.textColor = .secondaryLabel
        modelText.lineBreakMode = .byTruncatingTail
        let chevron = UIImageView(image: UIImage(systemName: "chevron.down",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 8.5, weight: .bold)))
        chevron.translatesAutoresizingMaskIntoConstraints = false
        chevron.tintColor = .tertiaryLabel
        let stack = UIStackView(arrangedSubviews: [modelText, chevron])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 5
        blur.contentView.addSubview(stack)

        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 108),
            heightAnchor.constraint(equalToConstant: 36),
            blur.leadingAnchor.constraint(equalTo: leadingAnchor),
            blur.trailingAnchor.constraint(equalTo: trailingAnchor),
            blur.topAnchor.constraint(equalTo: topAnchor),
            blur.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: blur.contentView.leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: blur.contentView.trailingAnchor, constant: -10),
            stack.centerYAnchor.constraint(equalTo: blur.contentView.centerYAnchor),
        ])
        layer.cornerRadius = 18
        layer.borderWidth = 0.75
        layer.borderColor = UIColor.separator.withAlphaComponent(0.35).cgColor
        accessibilityLabel = "মডেল বাছাই"
        accessibilityTraits = .button
        showsMenuAsPrimaryAction = true
        changesSelectionAsPrimaryAction = false
        update(label: "Auto", enabled: true)
    }

    required init?(coder: NSCoder) { nil }

    func update(label: String, enabled: Bool) {
        modelText.text = label
        isEnabled = enabled
        alpha = enabled ? 1 : 0.48
        accessibilityValue = label
    }

    override var isHighlighted: Bool {
        didSet {
            UIView.animate(withDuration: 0.12) {
                self.transform = self.isHighlighted
                    ? CGAffineTransform(scaleX: 0.96, y: 0.96) : .identity
                self.blur.alpha = self.isHighlighted ? 0.76 : 1
            }
        }
    }
}

@MainActor
final class AssistantBarHooks: NSObject {
    var onMenu: (() -> Void)?
    var onNewChat: (() -> Void)?
    /// Supplies a fresh model snapshot whenever the system asks to open the
    /// source-anchored menu. A deferred menu lets the API load finish without
    /// falling back to an iPhone bottom sheet.
    var provideModelMenu: ((@escaping ([UIMenuElement]) -> Void) -> Void)?
    weak var modelButton: AssistantModelPillButton?
    var isPinned: (() -> Bool)?
    var hasProject: (() -> Bool)?
    var canMutateConversation: (() -> Bool)?
    var onShare: (() -> Void)?
    var onPin: (() -> Void)?
    var onProject: (() -> Void)?
    var onLibrary: (() -> Void)?
    var onSearch: (() -> Void)?
    var onExport: ((AgentConversationExportFormat) -> Void)?
    var onRename: (() -> Void)?
    var onArchive: (() -> Void)?
    var onDelete: (() -> Void)?
    @objc func menuTapped() {
        AlmaAgentHaptics.selection()
        onMenu?()
    }
    @objc func newChatTapped() {
        AlmaAgentHaptics.light()
        onNewChat?()
    }
    func updateModelLabel(_ label: String, enabled: Bool) {
        modelButton?.update(label: label, enabled: enabled)
    }

    func installModelMenu() {
        let deferred = UIDeferredMenuElement.uncached { [weak self] completion in
            Task { @MainActor in
                guard let provider = self?.provideModelMenu else {
                    completion([])
                    return
                }
                AlmaAgentHaptics.selection()
                provider(completion)
            }
        }
        modelButton?.menu = UIMenu(children: [deferred])
    }

    static func modelMenuElements(
        models: [AgentModelInfo], selectedId: String?,
        onSelect: @escaping (String?) -> Void
    ) -> [UIMenuElement] {
        let isAuto = selectedId == nil || selectedId == "auto"
        let auto = UIAction(
            title: "Auto", image: UIImage(systemName: "bolt.fill"),
            state: isAuto ? .on : .off
        ) { _ in onSelect(nil) }

        let providers: [(key: String, label: String)] = [
            ("anthropic", "Anthropic"), ("google", "Google"),
            ("openai", "OpenAI"), ("openrouter", "OpenRouter"),
        ]
        var sections: [UIMenuElement] = [
            UIMenu(options: .displayInline, children: [auto])
        ]
        for provider in providers {
            let children = models.filter { $0.provider == provider.key }.map { model in
                UIAction(
                    title: model.label,
                    state: selectedId == model.id ? .on : .off
                ) { _ in onSelect(model.id) }
            }
            if !children.isEmpty {
                sections.append(UIMenu(
                    title: provider.label, options: .displayInline, children: children))
            }
        }
        let knownProviders = Set(providers.map(\.key))
        let other = models.filter { model in
            guard let provider = model.provider else { return true }
            return !knownProviders.contains(provider)
        }.map { model in
            UIAction(title: model.label, state: selectedId == model.id ? .on : .off) { _ in
                onSelect(model.id)
            }
        }
        if !other.isEmpty {
            sections.append(UIMenu(title: "Other", options: .displayInline, children: other))
        }
        return sections
    }

    func conversationMenu() -> UIMenu {
        UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
            guard let self else { completion([]); return }
            let share = UIAction(title: "Share", image: UIImage(systemName: "square.and.arrow.up")) { _ in
                self.onShare?()
            }
            let pin = UIAction(title: self.isPinned?() == true ? "Unpin" : "Pin",
                               image: UIImage(systemName: self.isPinned?() == true ? "pin.slash" : "pin")) { _ in
                self.onPin?()
            }
            let project = UIAction(title: self.hasProject?() == true ? "Move to Project" : "Add to Project",
                                   image: UIImage(systemName: "folder")) { _ in self.onProject?() }
            let library = UIAction(title: "Uploaded files", image: UIImage(systemName: "square.grid.2x2")) { _ in
                self.onLibrary?()
            }
            var primaryItems: [UIMenuElement] = [share, pin, project]
            if AgentParityFlags.isEnabled(.library) { primaryItems.append(library) }
            let primary = UIMenu(options: .displayInline, children: primaryItems)

            let search = UIAction(title: "Search in this chat", image: UIImage(systemName: "magnifyingglass")) { _ in
                self.onSearch?()
            }
            let export = UIMenu(title: "Export", image: UIImage(systemName: "arrow.down.doc"), children: [
                UIAction(title: "Plain text", image: UIImage(systemName: "doc.plaintext")) { _ in self.onExport?(.plainText) },
                UIAction(title: "Markdown", image: UIImage(systemName: "text.document")) { _ in self.onExport?(.markdown) },
                UIAction(title: "PDF", image: UIImage(systemName: "doc.richtext")) { _ in self.onExport?(.pdf) },
            ])
            let rename = UIAction(title: "Rename", image: UIImage(systemName: "pencil")) { _ in self.onRename?() }
            let conflictAttributes: UIMenuElement.Attributes = self.canMutateConversation?() == false ? .disabled : []
            let archive = UIAction(title: "Archive", image: UIImage(systemName: "archivebox"),
                                   attributes: conflictAttributes) { _ in self.onArchive?() }
            let managementItems: [UIMenuElement] = AgentParityFlags.isEnabled(.conversationMenu)
                ? [search, export, rename, archive]
                : [archive]
            let management = UIMenu(options: .displayInline, children: managementItems)
            var deleteAttributes: UIMenuElement.Attributes = [.destructive]
            deleteAttributes.formUnion(conflictAttributes)
            let delete = UIAction(title: "Delete", image: UIImage(systemName: "trash"), attributes: deleteAttributes) { _ in
                self.onDelete?()
            }
            completion([primary, management, UIMenu(options: .displayInline, children: [delete])])
        }])
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
            // Cold first launches swap the root VC late — re-assert a few times.
            for delay in [0.8, 2.5, 5.0] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    self?.selectedIndex = 2
                }
            }
        }
        if AlmaSwiftUIFlag.isActive, #available(iOS 17.0, *) {
            let navRef = WeakRef<UINavigationController>()
            let hooks = AssistantBarHooks()
            // IOSP-1: the Assistant screen's link-outs go through the same smartOpen
            // as every other tab root — its auth card's openWeb("/login") now lands
            // on the NATIVE login screen (owner decision 2026-07-11) instead of the
            // web login this closure used to force.
            let screen = AssistantScreen(
                openWeb: smartOpen(origin: "/agent", navRef: navRef, icon: "sparkles"),
                barHooks: hooks)
            let host = AlmaHostingController(rootView: screen)
            host.title = "ALMA AI"
            // Kimi-style top-left model chip: the composer now stays dedicated to
            // composing, while model choice lives beside the session drawer.
            let history = AlmaWebTabViewController.glassBarButton(
                icon: "line.3.horizontal", label: "চ্যাট হিস্টরি", target: hooks, action: #selector(AssistantBarHooks.menuTapped),
                light: !AlmaTheme.isDark)
            let modelButton = AssistantModelPillButton()
            hooks.modelButton = modelButton
            host.navigationItem.leftBarButtonItems = [history, UIBarButtonItem(customView: modelButton)]
            let plus = AlmaWebTabViewController.coralBarButton(
                icon: "plus", label: "নতুন চ্যাট", target: hooks,
                action: #selector(AssistantBarHooks.newChatTapped))
            let more = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: hooks.conversationMenu())
            more.accessibilityLabel = "Conversation menu"
            more.tintColor = AlmaTheme.isDark ? .white : .label
            // The system menu is a compact source-anchored frosted popover. It
            // never adapts to a bottom sheet and does not resign the composer.
            host.navigationItem.rightBarButtonItems = [more, plus]
            objc_setAssociatedObject(host, &assistantBarHooksKey, hooks, .OBJC_ASSOCIATION_RETAIN)
            let nav = Self.darkNav(root: host, tabTitle: "Assistant", icon: "sparkles", largeTitles: false)
            navRef.value = nav

            return nav
        }

        // Web fallback — the pre-S6b Assistant tab, unchanged.
        func agentURL(_ p: String) -> URL { URL(string: Self.base + p)! }
        let assistant = AlmaWebTabViewController(
            url: agentURL("/agent"),
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
            AlmaAgentHaptics.selection()
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
        .buttonStyle(AlmaAgentPressStyle())
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
                        AlmaAgentHaptics.success()
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
        let started = Date()
        AlmaTurnLog.event("artifact.preview.begin", artifactId)
        guard let cid = vm.conversationId else {
            loadError = "কথোপকথন পাওয়া যায়নি"
            AlmaTurnLog.event("artifact.preview.fail", "missing-conversation")
            return
        }
        do {
            let rows: [AgentArtifactWire] = try await AlmaAPI.shared.get("/api/assistant/conversations/\(cid)/artifacts")
            guard let a = rows.first(where: { $0.id == artifactId }) else {
                loadError = "ফাইলটা আর নেই"
                return
            }
            artifact = a
            AlmaTurnLog.event(
                "artifact.preview.ready",
                "type=\(a.type ?? "unknown") ms=\(Int(Date().timeIntervalSince(started) * 1000))")
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
            AlmaTurnLog.event("artifact.preview.fail", "network")
        }
    }
}
