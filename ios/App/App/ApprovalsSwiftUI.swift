//
//  ApprovalsSwiftUI.swift
//  ALMA ERP — S6: the Approvals tab as a native SwiftUI screen (v2 — web parity).
//
//  Mirrors the web /approvals page 1:1 — same endpoints, same colours, same blocks:
//    GET   /api/approvals?status=…&limit=80                   → list + KPI counts
//    PATCH /api/approvals/{id}  {action, note, operation_id, transactionId?}
//    GET   /api/assistant/actions?status=pending|all&limit=50 → Agent view
//    POST  /api/assistant/actions/{id}/approve|reject         (410=expired, 409=done)
//  Web-parity blocks: Business/Agent views · status filters (incl. ALL) · 5 KPI cards
//  (Pending/Critical/High/Normal/Low, web hexes) · rows with requester + leave info +
//  payout summary + salary-correction digest + linkage warnings + "via" audit source ·
//  detail sheet · reject note (server enforces ≥5 chars) · WALLET_WITHDRAWAL approve
//  collects the Transaction ID first (SMS to staff) — the v1 gap.
//  Carried lessons: ONE spinner per row, never a global overlay.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum ApprovalPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let red400 = Color(red: 0.973, green: 0.443, blue: 0.443)         // #F87171
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// Web: CRITICAL text-red-500 · HIGH text-amber-600 · else text-muted-hi.
    static func priority(_ p: String?) -> Color {
        switch p {
        case "CRITICAL": return red500
        case "HIGH": return amber600
        default: return .secondary
        }
    }
    /// Web: PENDING text-gold-lt · APPROVED text-emerald-600 · REJECTED/EXPIRED red.
    static func status(_ s: String) -> Color {
        switch s {
        case "PENDING": return goldLt
        case "APPROVED": return emerald600
        default: return red500
        }
    }
    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Models (same field names the web page types declare)

struct AlmaApproval: Decodable, Identifiable, Equatable {
    let id: String
    let module: String?
    let type: String?
    let businessId: String?
    let entityId: String?
    let entityLabel: String?
    var status: String
    let priority: String?
    let reason: String?
    let actionUrl: String?
    let createdAt: String?
    let businessName: String?
    let executable: Bool?
    let linkageStatus: String?
    let sourceStatus: String?
    let requestedBy: String?
    let requester: Requester?
    let payoutSummary: Payout?
    let payload: Payload?
    /// Last resolved audit source (telegram / attendance / erp) — the web's "via …".
    let auditSource: String?

    struct Requester: Decodable, Equatable {
        let id: String?
        let name: String?
        let role: String?
        let employeeIdGas: String?
    }

    struct Payout: Decodable, Equatable {
        let label: String?
        let accountHolder: String?
        let accountNumber: String?
        let accountNumberMasked: String?
        let isVerified: Bool?
        let status: String?
    }

    /// The slice of payloadSnapshot the web renders: leave duration/times
    /// (ATTENDANCE_LEAVE) and the salary-correction digest (SALARY_CORRECTION).
    struct Payload: Decodable, Equatable {
        // Leave
        let kind: String?
        let startDate: String?
        let endDate: String?
        let startMinutes: Int?
        let endMinutes: Int?
        let days: Int?
        // Salary correction
        let employeeId: String?
        let periodYm: String?
        let currentAmount: Int?
        let proposedAmount: Int?
        let reversalCount: Int?

        private enum Keys: String, CodingKey {
            case kind, startDate, endDate, startMinutes, endMinutes, days
            case employeeId, periodYm, currentAmount, proposedAmount, reversals
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            kind = try? c.decodeIfPresent(String.self, forKey: .kind)
            startDate = try? c.decodeIfPresent(String.self, forKey: .startDate)
            endDate = try? c.decodeIfPresent(String.self, forKey: .endDate)
            startMinutes = Self.flexInt(c, .startMinutes)
            endMinutes = Self.flexInt(c, .endMinutes)
            days = Self.flexInt(c, .days)
            employeeId = try? c.decodeIfPresent(String.self, forKey: .employeeId)
            periodYm = try? c.decodeIfPresent(String.self, forKey: .periodYm)
            currentAmount = Self.flexInt(c, .currentAmount)
            proposedAmount = Self.flexInt(c, .proposedAmount)
            reversalCount = (try? c.decodeIfPresent([LenientBlob].self, forKey: .reversals))?.count
        }
        private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
            if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
            if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
            if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
            return nil
        }
    }

    private enum Keys: String, CodingKey {
        case id, module, type, businessId, entityId, entityLabel, status, priority, reason
        case actionUrl, createdAt, businessName, executable, linkageStatus, sourceStatus
        case requestedBy, requester, payoutSummary, payloadSnapshot, auditHistory
    }
    private struct AuditEntry: Decodable {
        let action: String?
        let source: String?
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        module = try? c.decodeIfPresent(String.self, forKey: .module)
        type = try? c.decodeIfPresent(String.self, forKey: .type)
        businessId = try? c.decodeIfPresent(String.self, forKey: .businessId)
        entityId = try? c.decodeIfPresent(String.self, forKey: .entityId)
        entityLabel = try? c.decodeIfPresent(String.self, forKey: .entityLabel)
        status = (try? c.decode(String.self, forKey: .status)) ?? "PENDING"
        priority = try? c.decodeIfPresent(String.self, forKey: .priority)
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        actionUrl = try? c.decodeIfPresent(String.self, forKey: .actionUrl)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        businessName = try? c.decodeIfPresent(String.self, forKey: .businessName)
        executable = try? c.decodeIfPresent(Bool.self, forKey: .executable)
        linkageStatus = try? c.decodeIfPresent(String.self, forKey: .linkageStatus)
        sourceStatus = try? c.decodeIfPresent(String.self, forKey: .sourceStatus)
        requestedBy = try? c.decodeIfPresent(String.self, forKey: .requestedBy)
        requester = try? c.decodeIfPresent(Requester.self, forKey: .requester)
        payoutSummary = try? c.decodeIfPresent(Payout.self, forKey: .payoutSummary)
        payload = try? c.decodeIfPresent(Payload.self, forKey: .payloadSnapshot)
        let audit = (try? c.decodeIfPresent([AuditEntry].self, forKey: .auditHistory)) ?? nil
        auditSource = audit?.reversed()
            .first { $0.action == "APPROVED" || $0.action == "REJECTED" }?.source
    }

    static func == (a: AlmaApproval, b: AlmaApproval) -> Bool { a.id == b.id && a.status == b.status }
}

/// Decodes any JSON value and keeps nothing — used to count array entries leniently.
private struct LenientBlob: Decodable {
    init(from decoder: Decoder) throws {}
}

struct ApprovalModuleCount: Decodable, Equatable {
    let module: String
    let count: Int
}
struct ApprovalPriorityCount: Decodable, Equatable {
    let priority: String
    let count: Int
}

/// The approvals routes wrap payloads via apiDataSuccess → `{ ok, data: {…} }`
/// (unlike orders, which returns the payload flat) — decode both shapes.
struct ApprovalsListResponse: Decodable {
    let approvals: [AlmaApproval]
    let totalPending: Int?
    let byModule: [ApprovalModuleCount]
    let byPriority: [ApprovalPriorityCount]

    private enum Keys: String, CodingKey { case ok, data, approvals, totalPending, byModule, byPriority }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        approvals = (try? c.decode([AlmaApproval].self, forKey: .approvals)) ?? []
        totalPending = try? c.decodeIfPresent(Int.self, forKey: .totalPending)
        byModule = (try? c.decode([ApprovalModuleCount].self, forKey: .byModule)) ?? []
        byPriority = (try? c.decode([ApprovalPriorityCount].self, forKey: .byPriority)) ?? []
    }
}

struct ApprovalActionResponse: Decodable {
    let ok: Bool?
    let warning: String?
    let reconciled: Bool?

    private enum Keys: String, CodingKey { case ok, data, warning, reconciled }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        ok = try? root.decodeIfPresent(Bool.self, forKey: .ok)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        warning = try? c.decodeIfPresent(String.self, forKey: .warning)
        reconciled = try? c.decodeIfPresent(Bool.self, forKey: .reconciled)
    }
}

// MARK: - Agent actions (the web page's "Agent" view)

struct AlmaAgentAction: Decodable, Identifiable, Equatable {
    let id: String
    let type: String?
    var status: String?
    let summary: String?
    let costEstimate: Int?
    let createdAt: String?
    let expired: Bool?

    private enum Keys: String, CodingKey { case id, type, status, summary, costEstimate, createdAt, expired }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        type = try? c.decodeIfPresent(String.self, forKey: .type)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
        if let i = try? c.decodeIfPresent(Int.self, forKey: .costEstimate) { costEstimate = i }
        else if let d = try? c.decodeIfPresent(Double.self, forKey: .costEstimate) { costEstimate = Int(d.rounded()) }
        else { costEstimate = nil }
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        expired = try? c.decodeIfPresent(Bool.self, forKey: .expired)
    }

    /// Same labels the web TYPE_LABELS table uses.
    var typeLabel: String {
        switch type {
        case "agent_voice_call": return "Voice call (two-way)"
        case "outbound_call": return "Voice call (one-way)"
        case "dispatch_staff_tasks": return "Dispatch tasks"
        default: return (type ?? "—").replacingOccurrences(of: "_", with: " ")
        }
    }

    /// Card types where "আমার মত" hands the owner's opinion to the head, which
    /// re-edits THIS card in place (POST .../revise). Mirrors the server-side
    /// REVISABLE_ACTION_TYPES (src/agent/lib/revise-pending.ts).
    static let revisableTypes: Set<String> = [
        "dispatch_staff_tasks", "delegation", "send_customer_message", "staff_announcement",
        "fb_post", "instagram_post", "marketing_plan", "content_gate1", "content_gate2", "ad_creative_gate",
    ]
    var isRevisable: Bool { type.map { Self.revisableTypes.contains($0) } ?? false }
}

struct AgentActionsResponse: Decodable {
    let actions: [AlmaAgentAction]
    private enum Keys: String, CodingKey { case ok, data, actions }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        actions = (try? c.decode([AlmaAgentAction].self, forKey: .actions)) ?? []
    }
}

/// Response of POST /api/assistant/actions/[id]/revise — the head's one-line Bangla
/// confirmation of what it changed, plus the re-read (still-pending) card.
struct AgentReviseResponse: Decodable {
    let reply: String?
    let action: AlmaAgentAction?
}

// MARK: - Integrity (web Integrity Monitor parity)

struct ApprovalIntegrityReport: Decodable, Equatable {
    let scanned: Int
    let pendingWaivers: Int
    let walletOrphans: Int
    let penaltyOrphans: Int
    let orphans: [Orphan]

    struct Orphan: Decodable, Equatable {
        let approvalId: String?
        let waiverId: String?
        let kind: String?
    }

    private enum Keys: String, CodingKey {
        case ok, data, scanned, pendingWaivers, walletOrphans
        case penaltyApprovalOrphans, penaltyWaiverOrphans, orphans
    }
    private struct Blob: Decodable { init(from decoder: Decoder) throws {} }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        scanned = (try? c.decodeIfPresent(Int.self, forKey: .scanned)) ?? 0
        pendingWaivers = (try? c.decodeIfPresent(Int.self, forKey: .pendingWaivers)) ?? 0
        walletOrphans = ((try? c.decodeIfPresent([Blob].self, forKey: .walletOrphans)) ?? [])?.count ?? 0
        let pa = ((try? c.decodeIfPresent([Blob].self, forKey: .penaltyApprovalOrphans)) ?? [])?.count ?? 0
        let pw = ((try? c.decodeIfPresent([Blob].self, forKey: .penaltyWaiverOrphans)) ?? [])?.count ?? 0
        penaltyOrphans = pa + pw
        orphans = (try? c.decodeIfPresent([Orphan].self, forKey: .orphans)) ?? []
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class ApprovalsVM {
    // Business view
    var approvals: [AlmaApproval] = []
    var totalPending = 0
    var byModule: [ApprovalModuleCount] = []
    var priorityCounts: [String: Int] = [:]
    var statusFilter = "PENDING"          // PENDING | APPROVED | REJECTED | ALL
    var loading = false
    var busyIds: Set<String> = []         // per-row spinners, never a global one
    var error: String? = nil
    var notice: String? = nil             // success/warning line (the web's toast)
    var resultFx: ApprovalResultFx? = nil // approve/reject WOW medallion toast (owner design)
    var authExpired = false

    // Integrity monitor (web parity)
    var showIntegrity = false
    var integrity: ApprovalIntegrityReport? = nil
    var integrityLoading = false
    var repairing = false

    // Agent view
    var agentActions: [AlmaAgentAction] = []
    var agentFilter = "pending"           // pending | all
    var agentLoading = false
    var agentBusyId: String? = nil
    var agentNotice: String? = nil
    var agentError: String? = nil

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: ApprovalsListResponse = try await AlmaAPI.shared.get(
                "/api/approvals", query: ["status": statusFilter, "limit": "80"])
            approvals = resp.approvals
            totalPending = resp.totalPending ?? 0
            byModule = resp.byModule
            priorityCounts = Dictionary(uniqueKeysWithValues: resp.byPriority.map { ($0.priority, $0.count) })
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = error.localizedDescription
        }
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    /// APPROVE/REJECT one item — same PATCH body the web tracker sends
    /// ({action, note, operation_id, transactionId?}); row animates out on success.
    func act(_ approval: AlmaApproval, action: String, note: String = "",
             transactionId: String? = nil) async {
        guard !busyIds.contains(approval.id) else { return }
        busyIds.insert(approval.id)
        notice = nil
        defer { busyIds.remove(approval.id) }
        do {
            var body: [String: String] = [
                "action": action,
                "note": note,
                "operation_id": "ios-\(UUID().uuidString.lowercased())",
            ]
            if let transactionId, !transactionId.isEmpty { body["transactionId"] = transactionId }
            let resp: ApprovalActionResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/approvals/\(approval.id)", body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            // Result feedback = the owner-approved WOW medallion toast (green medal +
            // self-drawing check + glint + confetti / red cross), replacing the old
            // plain "Approval committed" strip (owner report 2026-07-12).
            let approved = action == "APPROVE"
            if resp.reconciled == true {
                resultFx = ApprovalResultFx(
                    approved: approved,
                    title: approved ? "অনুমোদন সম্পন্ন" : "বাতিল করা হয়েছে",
                    detail: resp.warning ?? "আগের সিদ্ধান্তের সাথে মিলিয়ে নেওয়া হয়েছে")
            } else {
                resultFx = ApprovalResultFx(
                    approved: approved,
                    title: approved ? "অনুমোদন সম্পন্ন" : "বাতিল করা হয়েছে",
                    detail: resp.warning)
            }
            withAnimation(.snappy) { approvals.removeAll { $0.id == approval.id } }
            totalPending = max(0, totalPending - 1)
            NotificationCenter.default.post(name: .almaApprovalsChanged, object: nil)
            await load()   // refresh counts/by-module, keep numbers honest
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
        }
    }

    // ── Integrity monitor (web GET/POST /api/approvals/integrity parity) ──

    func loadIntegrity() async {
        integrityLoading = true
        defer { integrityLoading = false }
        do {
            let report: ApprovalIntegrityReport = try await AlmaAPI.shared.get("/api/approvals/integrity")
            integrity = report
        } catch {
            if Self.isCancellation(error) { return }
            self.error = "Integrity scan failed"
        }
    }

    func repairIntegrity() async {
        repairing = true
        defer { repairing = false }
        do {
            struct RepairResponse: Decodable {
                let repaired: Int
                private enum Keys: String, CodingKey { case ok, data, repaired }
                private struct Blob: Decodable { init(from decoder: Decoder) throws {} }
                init(from decoder: Decoder) throws {
                    let root = try decoder.container(keyedBy: Keys.self)
                    let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
                    repaired = ((try? c.decodeIfPresent([Blob].self, forKey: .repaired)) ?? [])?.count ?? 0
                }
            }
            let resp: RepairResponse = try await AlmaAPI.shared.send("POST", "/api/approvals/integrity", body: [String: String]())
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "Repaired \(resp.repaired) item(s)"
            await loadIntegrity()
            await load()
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
        }
    }

    // ── Agent view (web AgentApprovalsTab parity) ──

    func loadAgent() async {
        agentLoading = true
        agentError = nil
        defer { agentLoading = false }
        do {
            let resp: AgentActionsResponse = try await AlmaAPI.shared.get(
                "/api/assistant/actions", query: ["status": agentFilter, "limit": "50"])
            agentActions = resp.actions
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }
            agentError = "তালিকা লোড করা যায়নি।"
        }
    }

    func agentAct(_ action: AlmaAgentAction, kind: String) async {
        agentBusyId = action.id
        agentNotice = nil
        defer { agentBusyId = nil }
        do {
            struct Ok: Decodable {}
            let _: Ok = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/actions/\(action.id)/\(kind)", body: [String: String]())
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            agentNotice = kind == "approve" ? "✓ অনুমোদিত হয়েছে।" : "✓ বাতিল করা হয়েছে।"
        } catch AlmaAPIError.http(let status, _) {
            // Same wording the web tab shows for these two server verdicts.
            if status == 410 { agentNotice = "অনুমোদনের সময় শেষ — কার্ডটি মেয়াদোত্তীর্ণ।" }
            else if status == 409 { agentNotice = "এই অ্যাকশনটি ইতিমধ্যে সম্পন্ন হয়েছে।" }
            else { agentNotice = kind == "approve" ? "অনুমোদন ব্যর্থ হয়েছে।" : "বাতিল ব্যর্থ হয়েছে।" }
        } catch {
            agentNotice = "নেটওয়ার্ক সমস্যা — আবার চেষ্টা করুন।"
        }
        NotificationCenter.default.post(name: .almaApprovalsChanged, object: nil)
        await loadAgent()
    }

    /// The third option: the owner typed his opinion on a pending card. Hand it to
    /// the head, which re-edits THIS card in place and replies with a one-line
    /// confirmation — the card stays pending for a final Approve. No chat restart.
    func agentRevise(_ action: AlmaAgentAction, feedback: String) async {
        let note = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
        guard note.count >= 2 else { return }
        agentBusyId = action.id
        agentNotice = nil
        defer { agentBusyId = nil }
        do {
            let resp: AgentReviseResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/actions/\(action.id)/revise", body: ["feedback": note])
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            agentNotice = resp.reply?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                ? resp.reply! : "✓ মত অনুযায়ী কার্ডটা আপডেট করা হয়েছে।"
        } catch AlmaAPIError.http(let status, _) {
            if status == 410 { agentNotice = "অনুমোদনের সময় শেষ — কার্ডটি মেয়াদোত্তীর্ণ।" }
            else if status == 409 { agentNotice = "এই অ্যাকশনটি ইতিমধ্যে সম্পন্ন হয়েছে।" }
            else if status == 400 { agentNotice = "এই কার্ডে মতামত দিয়ে রিভাইজ করা যায় না — Approve বা Reject করুন।" }
            else { agentNotice = "রিভাইজ ব্যর্থ হয়েছে — আবার চেষ্টা করুন।" }
        } catch {
            agentNotice = "নেটওয়ার্ক সমস্যা — আবার চেষ্টা করুন।"
        }
        NotificationCenter.default.post(name: .almaApprovalsChanged, object: nil)
        await loadAgent()
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct ApprovalsScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = ApprovalsVM()
    @State private var view = "business"                 // business | agent (web toggle)
    @State private var selected: AlmaApproval? = nil
    @State private var rejecting: AlmaApproval? = nil
    @State private var withdrawing: AlmaApproval? = nil  // WALLET_WITHDRAWAL → txn id first
    @State private var revising: AlmaAgentAction? = nil  // agent card → "আমার মত" opinion
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                viewToggle
                if vm.authExpired { authCard }
                if let err = vm.error, view == "business" { noticeCard(err, tone: .error) }
                if let ok = vm.notice, view == "business" { noticeCard(ok, tone: .success) }
                if view == "business" { businessBody } else { agentBody }
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(ApprovalsAurora())
        .claudeTopFade()
        // Approve/reject result → WOW medallion toast drops over the list (owner
        // design: green medal + self-drawing check + glint + confetti; red cross
        // on reject). `.id(fx.id)` restarts the animation for back-to-back acts.
        .overlay(alignment: .top) {
            if let fx = vm.resultFx {
                ApprovalResultToast(fx: fx) { vm.resultFx = nil }
                    .id(fx.id)
            }
        }
        .refreshable {
            if view == "business" { await vm.load() } else { await vm.loadAgent() }
        }
        .task { await vm.load() }
        .sheet(item: $selected) { ap in
            ApprovalDetailSheet(
                approval: ap, vm: vm,
                onApprove: { requestApprove(ap, dismissFirst: true) },
                onReject: { selected = nil; rejecting = ap },
                openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $rejecting) { ap in
            RejectNoteSheet(approval: ap) { note in
                Task { await vm.act(ap, action: "REJECT", note: note) }
            }
            .presentationDetents([.height(300)])
        }
        .sheet(item: $withdrawing) { ap in
            WithdrawTxnSheet(approval: ap) { txn in
                Task { await vm.act(ap, action: "APPROVE", transactionId: txn) }
            }
            .presentationDetents([.height(320)])
        }
        .sheet(item: $revising) { ac in
            ReviseNoteSheet(action: ac) { feedback in
                Task { await vm.agentRevise(ac, feedback: feedback) }
            }
            .presentationDetents([.height(340)])
        }
    }

    /// Wallet withdrawals need a transaction id (sent to staff via SMS) — collect it
    /// first, exactly like the web's withdraw modal. Everything else approves directly.
    private func requestApprove(_ ap: AlmaApproval, dismissFirst: Bool = false) {
        if dismissFirst { selected = nil }
        if ap.type == "WALLET_WITHDRAWAL" {
            withdrawing = ap
        } else {
            Task { await vm.act(ap, action: "APPROVE") }
        }
    }

    // ── View toggle (web header: Business | Agent) ──

    private var viewToggle: some View {
        HStack(spacing: 8) {
            approvalChip("Business", active: view == "business") {
                view = "business"
                Task { await vm.load() }
            }
            approvalChip("Agent", active: view == "agent") {
                view = "agent"
                Task { await vm.loadAgent() }
            }
            Spacer()
            if vm.totalPending > 0 {
                Text("\(vm.totalPending)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(ApprovalPalette.accentText(colorScheme))
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(ApprovalPalette.coral.opacity(0.18), in: Capsule())
                    .overlay(Capsule().strokeBorder(ApprovalPalette.coral.opacity(0.4), lineWidth: 1))
            }
        }
        .padding(.top, 4)
    }

    // ── Business view ──

    @ViewBuilder private var businessBody: some View {
        statusChips
        if vm.showIntegrity { integrityCard }
        bentoBoard
        if vm.loading && vm.approvals.isEmpty { loadingRows }
        ForEach(vm.approvals) { ap in
            ApprovalCard(
                approval: ap,
                busy: vm.busyIds.contains(ap.id),
                showStatusLine: vm.statusFilter != "PENDING",
                onTap: { selected = ap },
                onApprove: { requestApprove(ap) },
                onReject: { rejecting = ap },
                openWeb: openWeb)
        }
        if !vm.loading && vm.approvals.isEmpty && vm.error == nil && !vm.authExpired {
            emptyState
        }
        if !vm.byModule.isEmpty { moduleSummary }
        webEscape
    }

    /// Status filter chips — the web's Pending/Approved/Rejected/All buttons as one
    /// edge-to-edge scrollable row (the app's native chip pattern).
    private var statusChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(["PENDING", "APPROVED", "REJECTED", "ALL"], id: \.self) { s in
                    approvalChip(s == "ALL" ? "All" : s.capitalized, active: vm.statusFilter == s) {
                        vm.statusFilter = s
                        Task { await vm.load() }
                    }
                }
                approvalChip("Integrity", active: vm.showIntegrity) {
                    vm.showIntegrity.toggle()
                    if vm.showIntegrity && vm.integrity == nil {
                        Task { await vm.loadIntegrity() }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    /// Web Integrity Monitor parity — scan + repair, amber card.
    @State private var confirmRepair = false
    private var integrityCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Integrity Monitor").font(.footnote.weight(.bold))
                    Text("Detects orphan approvals, hidden penalty appeals, and stale pending rows.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
            }
            if let r = vm.integrity {
                HStack(spacing: 10) {
                    integrityStat("Scanned", r.scanned)
                    integrityStat("Waivers", r.pendingWaivers)
                    integrityStat("Wallet", r.walletOrphans, warn: r.walletOrphans > 0)
                    integrityStat("Penalty", r.penaltyOrphans, warn: r.penaltyOrphans > 0)
                }
                if r.orphans.isEmpty && !vm.integrityLoading {
                    Text("No linkage issues detected in scan window.")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(ApprovalPalette.emerald600)
                } else if !r.orphans.isEmpty {
                    ForEach(Array(r.orphans.prefix(8).enumerated()), id: \.offset) { _, o in
                        Text("\((o.kind ?? "").replacingOccurrences(of: "_", with: " "))\(o.approvalId.map { " · approval \(String($0.prefix(8)))…" } ?? "")\(o.waiverId.map { " · waiver \(String($0.prefix(8)))…" } ?? "")")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            HStack(spacing: 10) {
                if vm.integrityLoading || vm.repairing {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.vertical, 7)
                } else {
                    Button {
                        Task { await vm.loadIntegrity() }
                    } label: {
                        Text("Scan").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity).padding(.vertical, 8)
                            .background(Color.primary.opacity(0.06), in: Capsule())
                            .overlay(Capsule().strokeBorder(Color.primary.opacity(0.15), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    Button {
                        confirmRepair = true
                    } label: {
                        Text("Repair (\(vm.integrity?.orphans.count ?? 0))")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(ApprovalPalette.accentText(colorScheme))
                            .frame(maxWidth: .infinity).padding(.vertical, 8)
                            .background(ApprovalPalette.coral.opacity(0.13), in: Capsule())
                            .overlay(Capsule().strokeBorder(ApprovalPalette.coral.opacity(0.35), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .disabled((vm.integrity?.orphans.count ?? 0) == 0)
                    .confirmationDialog("অরফান রেকর্ডগুলো ঠিক করবেন?", isPresented: $confirmRepair, titleVisibility: .visible) {
                        Button("হ্যাঁ, Repair চালাও") { Task { await vm.repairIntegrity() } }
                        Button("বাতিল", role: .cancel) {}
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(ApprovalPalette.amber500.opacity(0.08), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(ApprovalPalette.amber500.opacity(0.30), lineWidth: 1))
    }

    private func integrityStat(_ label: String, _ value: Int, warn: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
            Text("\(value)").font(.subheadline.weight(.bold))
                .foregroundStyle(warn ? ApprovalPalette.amber600 : .primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Bento board — the Dashboard's glass-board language on Approvals. Owner cut
    /// 2026-07-09: the 2×2 priority-tile grid duplicated the hero's counts, so the
    /// hero card is the whole board now (pending total + critical/high split).
    private var bentoBoard: some View {
        ApvBentoHeroCard(pending: vm.totalPending,
                         critical: vm.priorityCounts["CRITICAL"] ?? 0,
                         high: vm.priorityCounts["HIGH"] ?? 0)
    }

    /// "Pending by module" — the web's side card, after the list on phone.
    private var moduleSummary: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Pending by module")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            ForEach(vm.byModule, id: \.module) { row in
                HStack {
                    Text(row.module.replacingOccurrences(of: "_", with: " "))
                        .font(.footnote.weight(.semibold))
                    Spacer()
                    Text("\(row.count)")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(ApprovalPalette.accentText(colorScheme))
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(ApprovalPalette.coral.opacity(0.14), in: Capsule())
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .approvalsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "checkmark.seal").font(.largeTitle).foregroundStyle(.secondary)
            Text(vm.statusFilter == "PENDING" ? "সব অনুমোদন সম্পন্ন ✅" : "কিছু নেই")
                .foregroundStyle(.secondary)
        }
        .padding(.top, 70)
        .padding(.bottom, 30)
    }

    // ── Agent view (web AgentApprovalsTab parity) ──

    @ViewBuilder private var agentBody: some View {
        HStack(spacing: 8) {
            approvalChip("Pending", active: vm.agentFilter == "pending") {
                vm.agentFilter = "pending"
                Task { await vm.loadAgent() }
            }
            approvalChip("All", active: vm.agentFilter == "all") {
                vm.agentFilter = "all"
                Task { await vm.loadAgent() }
            }
            Spacer()
            Button {
                Task { await vm.loadAgent() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    .frame(width: 34, height: 34)
                    .approvalsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            }
            .buttonStyle(.plain)
            .disabled(vm.agentLoading)
        }
        if let n = vm.agentNotice { noticeCard(n, tone: .info) }
        if let e = vm.agentError { noticeCard(e, tone: .error) }
        if vm.agentLoading && vm.agentActions.isEmpty { loadingRows }
        ForEach(vm.agentActions) { action in
            AgentActionCard(
                action: action,
                busy: vm.agentBusyId == action.id,
                onApprove: { Task { await vm.agentAct(action, kind: "approve") } },
                onReject: { Task { await vm.agentAct(action, kind: "reject") } },
                onOpinion: { revising = action })
        }
        if !vm.agentLoading && vm.agentActions.isEmpty && vm.agentError == nil {
            VStack(spacing: 6) {
                Text("🤖").font(.largeTitle)
                Text(vm.agentFilter == "pending" ? "কোনো অপেক্ষমাণ অ্যাকশন নেই" : "কোনো অ্যাকশন নেই")
                    .foregroundStyle(.secondary)
                Text("এজেন্ট কোনো অনুমোদনের অনুরোধ পাঠালে এখানে দেখা যাবে।")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(.top, 60)
        }
    }

    // ── Shared bits ──

    /// The web's accent chip (Button variant "gold": bg-gold/10 · border-gold/30 ·
    /// text-gold-dim) on the app's glass surface.
    private func approvalChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? ApprovalPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? ApprovalPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? ApprovalPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private enum NoticeTone { case error, success, info }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", ApprovalPalette.red500)
        case .success: ("checkmark.circle", ApprovalPalette.emerald600)
        case .info: ("info.circle", Color.secondary)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).approvalsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .approvalsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 120)
                .approvalsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .approvalsShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/approvals", "Approvals")
        } label: {
            Label("ওয়েব ভার্সন", systemImage: "safari")
                .font(.caption2)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary.opacity(0.7))
        .padding(.vertical, 4)
    }
}

// MARK: - Row card (mirrors one web table row / mobile card)

@available(iOS 17.0, *)
private struct ApprovalCard: View {
    let approval: AlmaApproval
    let busy: Bool
    let showStatusLine: Bool
    let onTap: () -> Void
    let onApprove: () -> Void
    let onReject: () -> Void
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text((approval.type ?? "—").replacingOccurrences(of: "_", with: " "))
                    .font(.subheadline.weight(.bold))
                Spacer()
                if let p = approval.priority {
                    Text(p).font(.caption2.weight(.heavy))
                        .foregroundStyle(ApprovalPalette.priority(p))
                }
            }
            Text(metaLine).font(.caption).foregroundStyle(.secondary)

            requesterLine

            if approval.type == "SALARY_CORRECTION", let p = approval.payload {
                SalaryCorrectionDigest(payload: p)
            } else {
                if let entity = approval.entityLabel ?? approval.entityId, !entity.isEmpty {
                    Text(entity).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                }
                if approval.type == "ATTENDANCE_LEAVE", let p = approval.payload {
                    LeaveInfoBox(payload: p)
                }
                if let reason = approval.reason, !reason.isEmpty {
                    Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }

            if ["WALLET_ADVANCE", "WALLET_WITHDRAWAL", "SALARY_ADVANCE"].contains(approval.type ?? "") {
                PayoutSummaryBox(payout: approval.payoutSummary)
            }

            linkageWarnings

            HStack(spacing: 6) {
                if showStatusLine {
                    Text(approval.status)
                        .font(.caption2.weight(.heavy))
                        .foregroundStyle(ApprovalPalette.status(approval.status))
                }
                if let via = approval.auditSource, !via.isEmpty {
                    Text("via \(via)")
                        .font(.caption2.weight(.semibold)).textCase(.uppercase)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if approval.status == "PENDING" && approval.executable == false {
                    Text("Manual review")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(ApprovalPalette.amber600)
                }
            }

            if approval.status == "PENDING" {
                actionRow
            }
        }
        .padding(14)
        .approvalsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        }
    }

    private var metaLine: String {
        var bits: [String] = []
        if let m = approval.module { bits.append(m.replacingOccurrences(of: "_", with: " ")) }
        bits.append(approval.businessName ?? approval.businessId ?? "Global")
        if let d = ApprovalFormat.dateTime(approval.createdAt) { bits.append(d) }
        return bits.joined(separator: " · ")
    }

    /// Web parity: the requester links to /employees/{employeeIdGas} when linked.
    @ViewBuilder private var requesterLine: some View {
        let gasId = approval.requester?.employeeIdGas ?? ""
        if gasId.isEmpty {
            requesterRow(linked: false)
        } else {
            requesterRow(linked: true)
                .contentShape(Rectangle())
                .onTapGesture {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    openWeb("/employees/\(gasId)", "Employee")
                }
        }
    }

    private func requesterRow(linked: Bool) -> some View {
        let name = approval.requester?.name ?? approval.requestedBy ?? "—"
        let role = (approval.requester?.role ?? "Requester").replacingOccurrences(of: "_", with: " ")
        return HStack(spacing: 8) {
            Text(ApprovalFormat.initials(name))
                .font(.caption.weight(.bold))
                .foregroundStyle(ApprovalPalette.accentText(colorScheme))
                .frame(width: 30, height: 30)
                .background(ApprovalPalette.coral.opacity(0.16), in: Circle())
                .overlay(Circle().strokeBorder(ApprovalPalette.coral.opacity(0.35), lineWidth: 1))
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(.footnote.weight(.semibold))
                Text(role).font(.caption2).foregroundStyle(.secondary)
            }
            if linked {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary.opacity(0.7))
            }
        }
    }

    @ViewBuilder private var linkageWarnings: some View {
        if approval.linkageStatus == "orphan_source_already_resolved" {
            Text("Payroll already \(approval.sourceStatus ?? "resolved") — reject will sync queue")
                .font(.caption2.weight(.bold)).foregroundStyle(ApprovalPalette.amber600)
        }
        if approval.linkageStatus == "orphan_missing_source" {
            Text("Source record missing")
                .font(.caption2.weight(.bold)).foregroundStyle(ApprovalPalette.red500)
        }
        if approval.linkageStatus == "orphan_missing_approval" {
            Text("Central approval missing — run Integrity repair")
                .font(.caption2.weight(.bold)).foregroundStyle(ApprovalPalette.red500)
        }
    }

    /// Web action buttons: Approve (gold variant) · Reject (danger variant), same
    /// subtle tinted-capsule look, one row. Row shows ONE spinner while busy.
    private var actionRow: some View {
        HStack(spacing: 10) {
            if busy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Processing…").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
            } else {
                if approval.executable != false {
                    approvalActionButton("Approve", icon: "checkmark",
                                         tint: ApprovalPalette.coral,
                                         text: ApprovalPalette.accentText(colorScheme),
                                         action: onApprove)
                }
                approvalActionButton("Reject", icon: "xmark",
                                     tint: ApprovalPalette.red500,
                                     text: ApprovalPalette.red500,
                                     action: onReject)
            }
        }
        .padding(.top, 2)
    }

    private func approvalActionButton(_ label: String, icon: String, tint: Color,
                                      text: Color, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            action()
        } label: {
            Label(label, systemImage: icon)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(text)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
                .background(tint.opacity(0.13), in: Capsule())
                .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Leave / payout / salary blocks (web component parity)

/// Web LeaveInfo: amber box — 📅 date range + duration line (Bangla), exact strings.
@available(iOS 17.0, *)
private struct LeaveInfoBox: View {
    let payload: AlmaApproval.Payload

    var body: some View {
        if payload.startDate != nil || payload.kind != nil {
            VStack(alignment: .leading, spacing: 2) {
                if let range = dateRange, !range.isEmpty {
                    Text("📅 \(range)").font(.footnote.weight(.bold))
                }
                Text(duration)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(ApprovalPalette.amber500)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(ApprovalPalette.amber500.opacity(0.07),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                .strokeBorder(ApprovalPalette.amber500.opacity(0.25), lineWidth: 1))
        }
    }

    private var dateRange: String? {
        guard let s = payload.startDate else { return nil }
        if let e = payload.endDate, e != s { return "\(s) – \(e)" }
        return s
    }

    private var duration: String {
        switch payload.kind {
        case "HOURS":
            return "⏰ \(ApprovalFormat.leaveTime(payload.startMinutes)) – \(ApprovalFormat.leaveTime(payload.endMinutes)) (ঘণ্টাভিত্তিক ছুটি)"
        case "SHIFTED_START":
            return "⏰ \(ApprovalFormat.leaveTime(payload.startMinutes)) থেকে দেরিতে শুরু"
        default:
            return "🗓️ \(payload.days ?? 1) দিন\(payload.kind == "DATE_RANGE" ? " (কয়েকদিন)" : "")"
        }
    }
}

/// Web PayoutSummaryBlock: "Preferred payout" gold box, or the amber "No payout
/// method on file" strip when missing.
@available(iOS 17.0, *)
private struct PayoutSummaryBox: View {
    let payout: AlmaApproval.Payout?
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if payout == nil || payout?.status == "MISSING" {
            Text("No payout method on file")
                .font(.caption2.weight(.bold))
                .foregroundStyle(ApprovalPalette.amber600)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(ApprovalPalette.amber500.opacity(0.10), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                    .strokeBorder(ApprovalPalette.amber500.opacity(0.30), lineWidth: 1))
        } else if let p = payout {
            VStack(alignment: .leading, spacing: 2) {
                Text("PREFERRED PAYOUT")
                    .font(.caption2.weight(.heavy))
                    .foregroundStyle(ApprovalPalette.accentText(colorScheme))
                if let label = p.label { Text(label).font(.caption.weight(.bold)) }
                if let holder = p.accountHolder { Text(holder).font(.caption2).foregroundStyle(.secondary) }
                Text(p.accountNumber ?? p.accountNumberMasked ?? "—")
                    .font(.footnote.monospaced())
                    .foregroundStyle(ApprovalPalette.accentText(colorScheme))
                Text(p.isVerified == true ? "Verified" : "Not verified")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(p.isVerified == true ? ApprovalPalette.green400 : ApprovalPalette.amber600)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(ApprovalPalette.coral.opacity(0.05), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                .strokeBorder(ApprovalPalette.coral.opacity(0.25), lineWidth: 1))
        }
    }
}

/// Web SalaryCorrectionCard (compact): employee · period, current → proposed (Δ).
@available(iOS 17.0, *)
private struct SalaryCorrectionDigest: View {
    let payload: AlmaApproval.Payload
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("SALARY CORRECTION")
                .font(.caption2.weight(.heavy))
                .foregroundStyle(ApprovalPalette.accentText(colorScheme))
            Text("\(payload.employeeId ?? "—") · \(payload.periodYm ?? "—")")
                .font(.caption.weight(.bold))
            if let cur = payload.currentAmount, let prop = payload.proposedAmount {
                let delta = prop - cur
                HStack(spacing: 4) {
                    Text("৳\(cur.formatted()) → ৳\(prop.formatted())")
                        .font(.footnote.monospaced())
                        .foregroundStyle(.secondary)
                    Text("(\(delta >= 0 ? "+" : "−")৳\(abs(delta).formatted()))")
                        .font(.footnote.monospaced().weight(.bold))
                        .foregroundStyle(delta >= 0 ? ApprovalPalette.green400 : ApprovalPalette.red400)
                }
            }
            if let n = payload.reversalCount, n > 0 {
                Text("\(n) reversal\(n == 1 ? "" : "s")").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(ApprovalPalette.coral.opacity(0.05), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(ApprovalPalette.goldDim.opacity(0.25), lineWidth: 1))
    }
}

// MARK: - Agent action card (web AgentApprovalsTab, re-set as a native iOS card:
// gradient icon badge · compact typography · 5-line clamp with fade + spring expand)

@available(iOS 17.0, *)
private struct AgentActionCard: View {
    let action: AlmaAgentAction
    let busy: Bool
    let onApprove: () -> Void
    let onReject: () -> Void
    let onOpinion: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var expanded = false

    private var isPending: Bool { action.status == "pending" }
    /// Dispatch briefs run hundreds of Bangla lines — clamp unless the owner expands.
    private var isLong: Bool { (action.summary ?? "").count > 220 }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                iconBadge
                VStack(alignment: .leading, spacing: 2) {
                    Text(action.typeLabel)
                        .font(.footnote.weight(.semibold))
                    HStack(spacing: 6) {
                        Text(ApprovalFormat.timeAgo(action.createdAt))
                            .font(.caption2).foregroundStyle(.secondary)
                        if !isPending {
                            Text((action.status ?? "").uppercased())
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 5).padding(.vertical, 1.5)
                                .background(Color.primary.opacity(0.06), in: Capsule())
                        }
                        if action.expired == true && isPending {
                            Text("মেয়াদ শেষ")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(ApprovalPalette.red500)
                                .padding(.horizontal, 5).padding(.vertical, 1.5)
                                .background(ApprovalPalette.red500.opacity(0.12), in: Capsule())
                        }
                    }
                }
                Spacer(minLength: 4)
                if let cost = action.costEstimate, cost > 0 {
                    Text("৳\(cost.formatted())")
                        .font(.caption2.weight(.bold).monospacedDigit())
                        .foregroundStyle(ApprovalPalette.accentText(colorScheme))
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(ApprovalPalette.coral.opacity(0.12), in: Capsule())
                        .overlay(Capsule().strokeBorder(ApprovalPalette.coral.opacity(0.30), lineWidth: 0.8))
                }
            }

            summaryBlock

            if isPending {
                if busy {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.vertical, 7)
                } else if action.expired == true {
                    // Expired: only "সরান" (clear) — hits reject, server marks expired.
                    HStack(spacing: 8) {
                        chipButton("সরান", icon: "trash", tint: .secondary, action: onReject)
                    }
                } else {
                    VStack(spacing: 8) {
                        HStack(spacing: 8) {
                            chipButton("Approve", icon: "checkmark", tint: ApprovalPalette.coral,
                                       text: ApprovalPalette.accentText(colorScheme), action: onApprove)
                            chipButton("Reject", icon: "xmark", tint: ApprovalPalette.red500, action: onReject)
                        }
                        // The third option: type an opinion → the head re-edits this card
                        // in place and confirms. Only where an in-place revise is safe.
                        if action.isRevisable {
                            chipButton("আমার মত দিন", icon: "bubble.left.and.text.bubble.right",
                                       tint: AlmaSwiftTheme.violet, action: onOpinion)
                        }
                    }
                }
            }
        }
        .padding(14)
        .approvalsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
    }

    /// Squircle icon badge — coral→violet gradient, one SF symbol per action type.
    private var iconBadge: some View {
        Image(systemName: iconName)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 34, height: 34)
            .background(
                LinearGradient(colors: [ApprovalPalette.coral, AlmaSwiftTheme.violet],
                               startPoint: .topLeading, endPoint: .bottomTrailing),
                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .shadow(color: ApprovalPalette.coral.opacity(0.35), radius: 5, y: 2)
    }

    private var iconName: String {
        switch action.type {
        case "agent_voice_call": return "phone.bubble.fill"
        case "outbound_call": return "phone.arrow.up.right.fill"
        case "dispatch_staff_tasks": return "checklist"
        default: return "sparkles"
        }
    }

    /// Small, calm body text — clamped to 5 lines with a bottom fade; tapping
    /// "আরো দেখুন" springs the full brief open (iOS Mail-style).
    private var summaryBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(action.summary ?? "বিস্তারিত নেই")
                .font(.caption)
                .lineSpacing(2.5)
                .foregroundStyle(.primary.opacity(0.85))
                .lineLimit(expanded || !isLong ? nil : 5)
                .mask(
                    // Fade the last clamped line so the cut reads intentional.
                    VStack(spacing: 0) {
                        Rectangle()
                        if isLong && !expanded {
                            LinearGradient(colors: [.black, .clear],
                                           startPoint: .top, endPoint: .bottom)
                                .frame(height: 18)
                        }
                    }
                )
            if isLong {
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    withAnimation(.spring(duration: 0.35, bounce: 0.15)) { expanded.toggle() }
                } label: {
                    HStack(spacing: 3) {
                        Text(expanded ? "কম দেখান" : "আরো দেখুন")
                        Image(systemName: "chevron.down")
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(ApprovalPalette.accentText(colorScheme))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func chipButton(_ label: String, icon: String, tint: Color, text: Color? = nil,
                            action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            action()
        } label: {
            Label(label, systemImage: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(text ?? tint)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(tint.opacity(0.13), in: Capsule())
                .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Detail sheet (web "View Details" modal parity)

@available(iOS 17.0, *)
private struct ApprovalDetailSheet: View {
    let approval: AlmaApproval
    let vm: ApprovalsVM
    let onApprove: () -> Void
    let onReject: () -> Void
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    private var busy: Bool { vm.busyIds.contains(approval.id) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                requesterCard
                infoRows
                if approval.status == "PENDING" { actions }
                webLink
            }
            .padding(18)
        }
        .presentationBackground { ApprovalsAurora() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text((approval.type ?? "—").replacingOccurrences(of: "_", with: " "))
                .font(.headline)
            Text("\(approval.module ?? "—") · \(ApprovalFormat.dateTime(approval.createdAt) ?? "—")")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    /// Web parity: the requester links to /employees/{employeeIdGas} when linked.
    private var requesterCard: some View {
        let name = approval.requester?.name ?? approval.requestedBy ?? "—"
        let role = (approval.requester?.role ?? "Requester").replacingOccurrences(of: "_", with: " ")
        let gasId = approval.requester?.employeeIdGas ?? ""
        return HStack(spacing: 10) {
            Text(ApprovalFormat.initials(name))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(ApprovalPalette.accentText(colorScheme))
                .frame(width: 42, height: 42)
                .background(ApprovalPalette.coral.opacity(0.16), in: Circle())
                .overlay(Circle().strokeBorder(ApprovalPalette.coral.opacity(0.35), lineWidth: 1))
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.subheadline.weight(.bold))
                Text(role).font(.caption).foregroundStyle(.secondary)
            }
            if !gasId.isEmpty {
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary.opacity(0.7))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .approvalsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .onTapGesture {
            guard !gasId.isEmpty else { return }
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            dismiss()
            openWeb("/employees/\(gasId)", "Employee")
        }
    }

    private var infoRows: some View {
        VStack(alignment: .leading, spacing: 10) {
            infoRow("Status", approval.status, color: ApprovalPalette.status(approval.status))
            infoRow("Priority", approval.priority ?? "—",
                    color: ApprovalPalette.priority(approval.priority))
            infoRow("Business", approval.businessName ?? approval.businessId ?? "Global")
            if approval.type == "SALARY_CORRECTION", let p = approval.payload {
                SalaryCorrectionDigest(payload: p)
            } else {
                infoRow("Entity / account affected", approval.entityLabel ?? approval.entityId ?? "—")
                if approval.type == "ATTENDANCE_LEAVE", let p = approval.payload {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("ছুটির সময়কাল").font(.caption2.weight(.heavy))
                            .textCase(.uppercase).foregroundStyle(.secondary)
                        LeaveInfoBox(payload: p)
                    }
                }
                infoRow("Reason", approval.reason ?? "—")
            }
            if ["WALLET_ADVANCE", "WALLET_WITHDRAWAL", "SALARY_ADVANCE"].contains(approval.type ?? "") {
                PayoutSummaryBox(payout: approval.payoutSummary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .approvalsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func infoRow(_ label: String, _ value: String, color: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(value).font(.footnote.weight(.semibold)).foregroundStyle(color)
        }
    }

    private var actions: some View {
        VStack(spacing: 8) {
            if busy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Processing approval…").font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 10)
            } else {
                if approval.executable != false {
                    Button {
                        dismiss()
                        onApprove()
                    } label: {
                        Label("Approve", systemImage: "checkmark")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity).padding(.vertical, 4)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(ApprovalPalette.coral)
                }
                Button {
                    dismiss()
                    onReject()
                } label: {
                    Label("Reject", systemImage: "xmark")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.bordered)
                .tint(ApprovalPalette.red500)
                if approval.status == "PENDING" && approval.executable == false {
                    Text("Manual review").font(.caption.weight(.bold))
                        .foregroundStyle(ApprovalPalette.amber600)
                }
            }
        }
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb(approval.actionUrl ?? "/approvals", "Approvals")
        } label: {
            Label(approval.actionUrl != nil ? "Open related record" : "সব অপশন — ওয়েবে খুলুন",
                  systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Reject sheet (web reject modal parity — live ≥5-char counter)

@available(iOS 17.0, *)
private struct RejectNoteSheet: View {
    let approval: AlmaApproval
    let onConfirm: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var note = ""
    @FocusState private var focused: Bool

    private var trimmed: String { note.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Reject Approval").font(.headline)
            Text("\((approval.type ?? "—").replacingOccurrences(of: "_", with: " ")) · \(approval.requester?.name ?? approval.requestedBy ?? "—")")
                .font(.caption).foregroundStyle(.secondary)
            TextField("Rejection reason required (min. 5 characters)", text: $note, axis: .vertical)
                .lineLimit(3...5)
                .focused($focused)
                .padding(12)
                .approvalsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            Text(trimmed.count < 5
                 ? "\(5 - trimmed.count) more character(s) required"
                 : "Reason will be stored on the approval record.")
                .font(.caption2)
                .foregroundStyle(trimmed.count < 5 ? ApprovalPalette.amber600 : Color.secondary)
            Button {
                dismiss()
                onConfirm(trimmed)
            } label: {
                Text("Reject request")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .tint(ApprovalPalette.red500)
            .disabled(trimmed.count < 5)
            Spacer(minLength: 0)
        }
        .padding(18)
        .presentationBackground { ApprovalsAurora() }
        .onAppear { focused = true }
    }
}

// MARK: - Withdrawal transaction-id sheet (web withdraw modal parity)

@available(iOS 17.0, *)
private struct WithdrawTxnSheet: View {
    let approval: AlmaApproval
    let onConfirm: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var txn = ""
    @FocusState private var focused: Bool

    private var trimmed: String { txn.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Approve withdrawal").font(.headline)
            Text("\(approval.requester?.name ?? approval.requestedBy ?? "—") · \(approval.businessName ?? approval.businessId ?? "Global")")
                .font(.caption).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 6) {
                Text("TRANSACTION ID").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                TextField("যে নম্বর/ID থেকে টাকা পাঠালেন", text: $txn)
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(12)
                    .approvalsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            }
            Text(trimmed.isEmpty ? "Transaction ID আবশ্যক" : "এই ID সহ staff-কে SMS পাঠানো হবে।")
                .font(.caption2)
                .foregroundStyle(trimmed.isEmpty ? ApprovalPalette.amber600 : Color.secondary)
            Button {
                dismiss()
                onConfirm(trimmed)
            } label: {
                Text("Confirm approval")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .tint(ApprovalPalette.coral)
            .disabled(trimmed.isEmpty)
            Spacer(minLength: 0)
        }
        .padding(18)
        .presentationBackground { ApprovalsAurora() }
        .onAppear { focused = true }
    }
}

// MARK: - Revise sheet ("আমার মত" — opinion feeds the head, card revised in place)

@available(iOS 17.0, *)
private struct ReviseNoteSheet: View {
    let action: AlmaAgentAction
    let onConfirm: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var note = ""
    @FocusState private var focused: Bool

    private var trimmed: String { note.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("আপনার মত দিন").font(.headline)
            Text("\(action.typeLabel) · এজেন্ট আপনার মত অনুযায়ী কার্ডটা ঠিক করে দেবে, তারপর আপনি Approve করবেন।")
                .font(.caption).foregroundStyle(.secondary)
            TextField("যেমন: দুইজনকে না, শুধু রাকিবকে দিন…", text: $note, axis: .vertical)
                .lineLimit(3...6)
                .focused($focused)
                .padding(12)
                .approvalsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            Text(trimmed.count < 2
                 ? "আপনার মতামত লিখুন…"
                 : "এজেন্ট এই কার্ডটাই আপনার কথামতো রিভাইজ করবে।")
                .font(.caption2)
                .foregroundStyle(trimmed.count < 2 ? ApprovalPalette.amber600 : Color.secondary)
            Button {
                dismiss()
                onConfirm(trimmed)
            } label: {
                Label("এজেন্টকে পাঠান", systemImage: "paperplane.fill")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .tint(AlmaSwiftTheme.violet)
            .disabled(trimmed.count < 2)
            Spacer(minLength: 0)
        }
        .padding(18)
        .presentationBackground { ApprovalsAurora() }
        .onAppear { focused = true }
    }
}

// MARK: - Formatting helpers (web util parity)

private enum ApprovalFormat {
    /// createdAt → "5/7/2026, 8:50 PM" style (web: new Date(...).toLocaleString()).
    static func dateTime(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }

    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }

    /// Minutes-since-midnight → "2:00 PM" (web fmtLeaveTime).
    static func leaveTime(_ minutes: Int?) -> String {
        guard let m = minutes else { return "" }
        let h = m / 60, mm = m % 60
        let ap = h >= 12 ? "PM" : "AM"
        let h12 = ((h + 11) % 12) + 1
        return "\(h12):\(String(format: "%02d", mm)) \(ap)"
    }

    /// Bangla relative time — the web agent tab's exact strings.
    static func timeAgo(_ iso: String?) -> String {
        guard let iso, let date = parse(iso) else { return "" }
        let mins = Int(Date().timeIntervalSince(date) / 60)
        if mins < 1 { return "এইমাত্র" }
        if mins < 60 { return "\(mins) মিনিট আগে" }
        let hrs = mins / 60
        if hrs < 24 { return "\(hrs) ঘণ্টা আগে" }
        return "\(hrs / 24) দিন আগে"
    }

    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}

// MARK: - Aurora background + glass (Approvals-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct ApprovalsAurora: View {
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

@available(iOS 17.0, *)
private extension View {
    func approvalsGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct ApprovalsShimmer: ViewModifier {
    @State private var phase: CGFloat = -1
    func body(content: Content) -> some View {
        content
            .overlay(
                LinearGradient(colors: [.clear, .white.opacity(0.25), .clear],
                               startPoint: .leading, endPoint: .trailing)
                    .offset(x: phase * 320)
                    .clipped()
            )
            .onAppear {
                withAnimation(.linear(duration: 1.15).repeatForever(autoreverses: false)) { phase = 1.5 }
            }
    }
}

@available(iOS 17.0, *)
private extension View {
    func approvalsShimmer() -> some View { modifier(ApprovalsShimmer()) }
}

// MARK: - Bento components (Approvals-owned copies of the Dashboard board language —
// per-file copies are this repo's parallel-session convention, no cross-file imports)

/// Central motion gate — count-ups and washes freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func apvMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct ApvCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        ApvCountUpText(value: shown)
            .animation(apvMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if apvMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct ApvCountUpText: View, Animatable {
    var value: Double
    var animatableData: Double {
        get { value }
        set { value = newValue }
    }
    var body: some View {
        Text("\(Int(value.rounded()))")
    }
}

/// The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe:
/// deep indigo base + violet/coral washes + a sage hint). Pending total count-up plus
/// the critical/high split; no shimmer, no chart — approvals is a queue, keep it calm.
@available(iOS 17.0, *)
private struct ApvBentoHeroCard: View {
    let pending: Int
    let critical: Int
    let high: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("অনুমোদন বাকি · PENDING").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(ApprovalPalette.goldLt)
            ApvCountUp(target: pending)
                .font(.system(size: 40, weight: .heavy)).monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1).minimumScaleFactor(0.6)
                .padding(.top, 8)
            Text(pending == 0 ? "সব অনুমোদন শেষ — সারি খালি" : "আপনার সিদ্ধান্তের অপেক্ষায়")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Critical", value: critical,
                         tint: critical > 0 ? ApprovalPalette.red400 : .white, sub: "জরুরি")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "High", value: high,
                         tint: high > 0 ? ApprovalPalette.amber500 : .white, sub: "উচ্চ অগ্রাধিকার")
                Spacer(minLength: 0)
            }
            .padding(.top, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .fill(Color(red: 0.094, green: 0.082, blue: 0.157))
                LinearGradient(colors: [AlmaSwiftTheme.violet.opacity(0.32), .clear],
                               startPoint: .topLeading, endPoint: .center)
                LinearGradient(colors: [AlmaSwiftTheme.coral.opacity(0.30), .clear],
                               startPoint: .bottomTrailing, endPoint: .center)
                RadialGradient(colors: [AlmaSwiftTheme.sage.opacity(0.14), .clear],
                               center: .init(x: 0.85, y: 0.05), startRadius: 0, endRadius: 220)
            }
            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(.white.opacity(0.16), lineWidth: 1))
        // Always the board's dark anchor — force dark traits inside the card.
        .environment(\.colorScheme, .dark)
    }

    private func heroStat(label: String, value: Int, tint: Color, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.5)
                .foregroundStyle(.white.opacity(0.55))
            ApvCountUp(target: value)
                .font(.system(size: 20, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Approvals — Light") {
    ApprovalsScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}

// MARK: - Approve/Reject result toast (owner-approved WOW design, 2026-07-12)
//
// Native twin of the web notification medallions (notif-bell.tsx): a dark pill
// drops over the list with a tone medallion — APPROVE = green medal (gradient +
// glow) whose check DRAWS itself, then a light glint sweeps across, plus a brand
// confetti burst; REJECT = red medallion with a self-drawing cross. Springs in,
// auto-folds after ~3.4s.

struct ApprovalResultFx: Equatable {
    let approved: Bool
    let title: String
    let detail: String?
    let id = UUID()   // fresh identity per act() so back-to-back results re-animate
}

/// Checkmark in a 24×24 design space (same path as the web `.onx-ck`).
@available(iOS 17.0, *)
private struct ApprovalCheckShape: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width / 24, h = rect.height / 24
        var p = Path()
        p.move(to: CGPoint(x: 5 * w, y: 12.5 * h))
        p.addLine(to: CGPoint(x: 10 * w, y: 17.5 * h))
        p.addLine(to: CGPoint(x: 19 * w, y: 7 * h))
        return p
    }
}

/// Cross in the same 24×24 space — reject's medallion glyph.
@available(iOS 17.0, *)
private struct ApprovalCrossShape: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width / 24, h = rect.height / 24
        var p = Path()
        p.move(to: CGPoint(x: 7 * w, y: 7 * h))
        p.addLine(to: CGPoint(x: 17 * w, y: 17 * h))
        p.move(to: CGPoint(x: 17 * w, y: 7 * h))
        p.addLine(to: CGPoint(x: 7 * w, y: 17 * h))
        return p
    }
}

@available(iOS 17.0, *)
struct ApprovalResultToast: View {
    let fx: ApprovalResultFx
    let onDone: () -> Void

    @State private var shown = false
    @State private var drawn = false
    @State private var glint = false
    @State private var confetti = false

    private var tone: Color {
        fx.approved ? Color(red: 0.13, green: 0.77, blue: 0.37)   // #22c55e
                    : Color(red: 0.94, green: 0.27, blue: 0.27)   // #ef4444
    }
    private var stroke: Color {
        fx.approved ? Color(red: 0.29, green: 0.87, blue: 0.5)    // #4ade80
                    : Color(red: 0.99, green: 0.44, blue: 0.44)
    }

    var body: some View {
        ZStack(alignment: .top) {
            if confetti { ApprovalConfettiBurst().allowsHitTesting(false) }
            HStack(spacing: 12) {
                medallion
                VStack(alignment: .leading, spacing: 2) {
                    Text(fx.title)
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    if let d = fx.detail, !d.isEmpty {
                        Text(d)
                            .font(.system(size: 11.5))
                            .foregroundStyle(.white.opacity(0.62))
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color(red: 0.05, green: 0.05, blue: 0.07).opacity(0.94),
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(tone.opacity(0.35)))
            .shadow(color: tone.opacity(0.28), radius: 18, y: 8)
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .offset(y: shown ? 0 : -22)
            .scaleEffect(shown ? 1 : 0.9, anchor: .top)
            .opacity(shown ? 1 : 0)
        }
        .onAppear {
            withAnimation(.spring(response: 0.5, dampingFraction: 0.68)) { shown = true }
            withAnimation(.easeOut(duration: 0.5).delay(0.35)) { drawn = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.85) {
                withAnimation(.easeOut(duration: 1.0)) { glint = true }
            }
            if fx.approved {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { confetti = true }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.4) {
                withAnimation(.easeIn(duration: 0.3)) { shown = false }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.75) { onDone() }
        }
    }

    /// Green medal / red cross — gradient fill, tone border+glow, self-drawing
    /// glyph (path trim) and a light glint that sweeps once (web `.onx-glint`).
    private var medallion: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(LinearGradient(colors: [tone.opacity(0.28), tone.opacity(0.10)],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(tone.opacity(0.45))
            Group {
                if fx.approved {
                    ApprovalCheckShape()
                        .trim(from: 0, to: drawn ? 1 : 0)
                        .stroke(stroke, style: StrokeStyle(lineWidth: 2.8, lineCap: .round, lineJoin: .round))
                } else {
                    ApprovalCrossShape()
                        .trim(from: 0, to: drawn ? 1 : 0)
                        .stroke(stroke, style: StrokeStyle(lineWidth: 2.8, lineCap: .round, lineJoin: .round))
                }
            }
            .frame(width: 22, height: 22)
            GeometryReader { g in
                LinearGradient(colors: [.clear, .white.opacity(0.5), .clear],
                               startPoint: .leading, endPoint: .trailing)
                    .frame(width: g.size.width * 0.7)
                    .rotationEffect(.degrees(18))
                    .offset(x: glint ? g.size.width * 1.2 : -g.size.width * 0.9)
            }
            .allowsHitTesting(false)
        }
        .frame(width: 44, height: 44)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: tone.opacity(0.35), radius: 10, y: 4)
    }
}

/// Compact one-shot confetti for the approve toast — brand palette Canvas burst
/// (same recipe as the ALMA Island's, scoped to the toast area).
@available(iOS 17.0, *)
private struct ApprovalConfettiBurst: View {
    private struct Bit {
        let x0: CGFloat, vx: CGFloat, vy: CGFloat, size: CGFloat, spin: Double, hue: Color
    }
    private let bits: [Bit]
    private let born = Date()

    init() {
        let palette: [Color] = [
            Color(red: 0.88, green: 0.48, blue: 0.37), Color(red: 0.96, green: 0.64, blue: 0.55),
            Color(red: 0.95, green: 0.77, blue: 0.55), Color(red: 0.29, green: 0.87, blue: 0.5),
            Color(red: 0.55, green: 0.36, blue: 0.96), .white,
        ]
        bits = (0..<64).map { _ in
            Bit(x0: CGFloat.random(in: 0.25...0.75),
                vx: CGFloat.random(in: -80...80),
                vy: CGFloat.random(in: 50...190),
                size: CGFloat.random(in: 4...7),
                spin: Double.random(in: -4...4),
                hue: palette.randomElement()!)
        }
    }

    var body: some View {
        TimelineView(.animation) { tl in
            Canvas { ctx, size in
                let t = tl.date.timeIntervalSince(born)
                guard t < 2.2 else { return }
                for b in bits {
                    let x = b.x0 * size.width + b.vx * t
                    let y = 42 + b.vy * t + 130 * t * t
                    guard y < size.height else { continue }
                    let alpha = max(0, 1 - t / 2.0)
                    var bit = ctx
                    bit.translateBy(x: x, y: y)
                    bit.rotate(by: .radians(b.spin * t))
                    bit.opacity = alpha
                    bit.fill(Path(CGRect(x: -b.size / 2, y: -b.size / 4, width: b.size, height: b.size / 2)),
                             with: .color(b.hue))
                }
            }
        }
        .frame(maxHeight: 340, alignment: .top)
    }
}
