//
//  StaffMonitorSystemSwiftUI.swift
//  ALMA ERP — NP-3: the LIVE Business Monitor's SYSTEM tab (owner control room).
//
//  Native parity for the web monitor's System blocks (roadmap §4.7):
//    · MonitorDutyTimeline   → duty rows grouped by category, status dots, per-duty
//        enable toggle (PATCH /api/agent/staff-monitor/duty-enabled) + retrigger
//        (POST /api/agent/staff-monitor/retrigger {jobName}, DUTY_TO_JOB map)
//    · MonitorSalahTimeline  → salah duty rows (waqt/status/time/reminders)
//    · AgentSalahTimesSettings → GET/POST /api/agent/salah-times (5 waqt × ৩ সময়)
//    · AgentVoiceSettings    → the NATIVE app's real voice switches (streaming +
//        wake word UserDefaults) — the web's on-device-STT flag is webview-scoped
//    · MonitorTrustEngine    → GET/PATCH /api/agent/trust-rules (tier menu)
//    · MonitorBrainCard      → GET /api/agent/brain-stats + prompt-cache line
//        (GET /api/assistant/costs/summary → promptCache)
//    · System Health         → GET /api/agent/health-scan (+ rescan), auto-fix
//        request/approve/reject via POST /api/agent/auto-fix
//    · Background services   → continuousServices chips (staff-monitor payload)
//    · Deploy                → POST /api/agent/vps/deploy with step summary and
//        target/running commit verification (web handleDeploy parity)
//
//  All fetches/mutations live on StaffMonitorControlsVM (the screen's single
//  coordinator) via the ops extension below; this file is the System tab UI.
//

import SwiftUI

// MARK: - Ops models (web shapes)

/// GET /api/agent/brain-stats.
struct SMBrainStats: Decodable {
    let memoryCount: Int
    let activePlaybookCount: Int
    let proposedPlaybookCount: Int
    let knowledgeCount: Int
    let lastKnowledgeBuild: String?
    let lastSessionSummary: String?
    let todayCostUsd: Double
    private enum Keys: String, CodingKey {
        case memoryCount, activePlaybookCount, proposedPlaybookCount, knowledgeCount
        case lastKnowledgeBuild, lastSessionSummary, todayCostUsd
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        memoryCount = (try? c.decodeIfPresent(Int.self, forKey: .memoryCount)) ?? 0
        activePlaybookCount = (try? c.decodeIfPresent(Int.self, forKey: .activePlaybookCount)) ?? 0
        proposedPlaybookCount = (try? c.decodeIfPresent(Int.self, forKey: .proposedPlaybookCount)) ?? 0
        knowledgeCount = (try? c.decodeIfPresent(Int.self, forKey: .knowledgeCount)) ?? 0
        lastKnowledgeBuild = try? c.decodeIfPresent(String.self, forKey: .lastKnowledgeBuild)
        lastSessionSummary = try? c.decodeIfPresent(String.self, forKey: .lastSessionSummary)
        todayCostUsd = (try? c.decodeIfPresent(Double.self, forKey: .todayCostUsd)) ?? 0
    }
}

/// GET /api/assistant/costs/summary → promptCache (web PromptCacheMonitorSnapshot).
struct SMPromptCache: Decodable {
    let tokensSaved: Int
    let usdSaved: Double
    let cacheReadTokens: Int
    let inputTokens: Int
    let chatTurns: Int
    let cacheHitRatio: Double
    let cachingBroken: Bool
    private enum Keys: String, CodingKey {
        case tokensSaved, usdSaved, cacheReadTokens, inputTokens, chatTurns, cacheHitRatio, cachingBroken
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        tokensSaved = (try? c.decodeIfPresent(Int.self, forKey: .tokensSaved)) ?? 0
        usdSaved = (try? c.decodeIfPresent(Double.self, forKey: .usdSaved)) ?? 0
        cacheReadTokens = (try? c.decodeIfPresent(Int.self, forKey: .cacheReadTokens)) ?? 0
        inputTokens = (try? c.decodeIfPresent(Int.self, forKey: .inputTokens)) ?? 0
        chatTurns = (try? c.decodeIfPresent(Int.self, forKey: .chatTurns)) ?? 0
        cacheHitRatio = (try? c.decodeIfPresent(Double.self, forKey: .cacheHitRatio)) ?? 0
        cachingBroken = (try? c.decodeIfPresent(Bool.self, forKey: .cachingBroken)) ?? false
    }
}

/// GET /api/agent/trust-rules row.
struct SMTrustRule: Decodable, Identifiable {
    let id: String
    let domain: String
    let actionPattern: String
    var tier: String
    let approvalCount: Int
    let rejectionCount: Int
    let consecutiveApprovals: Int
    private enum Keys: String, CodingKey {
        case id, domain, actionPattern, tier, approvalCount, rejectionCount, consecutiveApprovals
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        domain = (try? c.decodeIfPresent(String.self, forKey: .domain)) ?? ""
        actionPattern = (try? c.decodeIfPresent(String.self, forKey: .actionPattern)) ?? ""
        tier = (try? c.decodeIfPresent(String.self, forKey: .tier)) ?? "approve"
        approvalCount = (try? c.decodeIfPresent(Int.self, forKey: .approvalCount)) ?? 0
        rejectionCount = (try? c.decodeIfPresent(Int.self, forKey: .rejectionCount)) ?? 0
        consecutiveApprovals = (try? c.decodeIfPresent(Int.self, forKey: .consecutiveApprovals)) ?? 0
    }
}

/// GET /api/agent/health-scan.
struct SMHealthIssue: Decodable, Identifiable {
    let severity: String
    let area: String
    let title: String
    let detail: String
    let signal: String?
    var id: String { title }
    private enum Keys: String, CodingKey { case severity, area, title, detail, signal }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        severity = (try? c.decodeIfPresent(String.self, forKey: .severity)) ?? "low"
        area = (try? c.decodeIfPresent(String.self, forKey: .area)) ?? ""
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        detail = (try? c.decodeIfPresent(String.self, forKey: .detail)) ?? ""
        signal = try? c.decodeIfPresent(String.self, forKey: .signal)
    }

    /// Web isAutoFixEligible parity (src/lib/diagnostic/auto-fix-eligibility.ts):
    /// website/cost/approvals areas and website: signals never spawn Auto-Fix.
    var autoFixEligible: Bool {
        let a = area.lowercased()
        let s = (signal ?? "").lowercased()
        if a == "website" || s.hasPrefix("website:") { return false }
        if a == "cost" || a == "approvals" { return false }
        return true
    }
}

struct SMHealthReport: Decodable {
    let scannedAt: String?
    let ok: Bool
    let issues: [SMHealthIssue]
    let summary: String
    private enum Keys: String, CodingKey { case scannedAt, ok, issues, summary }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        scannedAt = try? c.decodeIfPresent(String.self, forKey: .scannedAt)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
        issues = (try? c.decodeIfPresent([SMHealthIssue].self, forKey: .issues)) ?? []
        summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? ""
    }
}

/// GET /api/agent/auto-fix rows.
struct SMAutoFixAction: Decodable, Identifiable {
    let id: String
    let status: String
    let title: String
    let costEstimate: Double
    private enum Keys: String, CodingKey { case id, status, costEstimate, payload }
    private enum PayloadKeys: String, CodingKey { case title }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? ""
        costEstimate = (try? c.decodeIfPresent(Double.self, forKey: .costEstimate)) ?? 0
        let p = try? c.nestedContainer(keyedBy: PayloadKeys.self, forKey: .payload)
        title = (try? p?.decodeIfPresent(String.self, forKey: .title)) ?? "Unknown"
    }

    /// Web status label/color table verbatim.
    var statusLabel: String {
        switch status {
        case "pending": return "⏳ Approval Pending"
        case "approved": return "🚀 Dispatching..."
        case "in_progress": return "🤖 Working..."
        case "completed": return "✅ Fixed"
        case "rejected": return "❌ Rejected"
        default: return "⚠️ Failed"
        }
    }
}

/// GET /api/agent/staff-capabilities row (Staff tab uses it too).
struct SMStaffCap: Decodable {
    let staffId: String
    let staffName: String
    let overallCompletionRate: Int
    let strongTypes: [String]
    let weakTypes: [String]
    private enum Keys: String, CodingKey { case staffId, staffName, overallCompletionRate, strongTypes, weakTypes }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        staffId = (try? c.decodeIfPresent(String.self, forKey: .staffId)) ?? ""
        staffName = (try? c.decodeIfPresent(String.self, forKey: .staffName)) ?? ""
        overallCompletionRate = {
            if let i = try? c.decodeIfPresent(Int.self, forKey: .overallCompletionRate) { return i }
            if let d = try? c.decodeIfPresent(Double.self, forKey: .overallCompletionRate) { return Int(d.rounded()) }
            return 0
        }()
        strongTypes = (try? c.decodeIfPresent([String].self, forKey: .strongTypes)) ?? []
        weakTypes = (try? c.decodeIfPresent([String].self, forKey: .weakTypes)) ?? []
    }
}

/// GET /api/assistant/staff-toggles.
struct SMStaffToggleDef: Decodable, Identifiable {
    let key: String
    let label: String
    let hint: String
    var id: String { key }
    private enum Keys: String, CodingKey { case key, label, hint }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        key = (try? c.decodeIfPresent(String.self, forKey: .key)) ?? UUID().uuidString
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? key
        hint = (try? c.decodeIfPresent(String.self, forKey: .hint)) ?? ""
    }
}

/// POST /api/agent/vps/deploy result (web handleDeploy shape).
struct SMDeployResult: Decodable {
    let ok: Bool?
    let verified: Bool?
    let steps: [Step]
    let message: String?
    let targetCommit: String?
    let runningCommit: String?
    struct Step: Decodable {
        let step: String
        let ok: Bool
        private enum Keys: String, CodingKey { case step, ok }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            step = (try? c.decodeIfPresent(String.self, forKey: .step)) ?? ""
            ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
        }
    }
    private enum Keys: String, CodingKey { case ok, verified, steps, message, targetCommit, runningCommit }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
        verified = try? c.decodeIfPresent(Bool.self, forKey: .verified)
        steps = (try? c.decodeIfPresent([Step].self, forKey: .steps)) ?? []
        message = try? c.decodeIfPresent(String.self, forKey: .message)
        targetCommit = try? c.decodeIfPresent(String.self, forKey: .targetCommit)
        runningCommit = try? c.decodeIfPresent(String.self, forKey: .runningCommit)
    }

    /// Web deploy summary line verbatim ("✓ Git Pull → ✓ NPM Install → …").
    var summaryLine: String {
        let labels = ["git_pull": "Git Pull", "npm_install": "NPM Install", "pm2_restart": "PM2 Restart"]
        let summary = steps.map { "\($0.ok ? "✓" : "✗") \(labels[$0.step] ?? $0.step)" }.joined(separator: " → ")
        if verified == true {
            return "✓ \(summary) · ✅ verified running \(targetCommit ?? "")"
        }
        return "⚠ \(summary) · ❌ restart NOT confirmed (running \(runningCommit ?? "?"), expected \(targetCommit ?? "?"))"
    }
}

/// GET/POST /api/agent/salah-times config — [waqt: {azan, prayer, end}].
typealias SMSalahConfig = [String: [String: String]]

/// Web WAQT_ORDER / WAQT_LABELS verbatim.
let smWaqtOrder: [(key: String, label: String)] = [
    ("fajr", "ফজর"), ("dhuhr", "যোহর"), ("asr", "আসর"), ("maghrib", "মাগরিব"), ("isha", "ইশা"),
]

/// Web DUTY_TO_JOB map (staff-monitor-types.ts) — duty key → worker job name.
let smDutyToJob: [String: String] = [
    "salah_init": "salah-init", "cs_index_products": "cs-index-products",
    "knowledge_build": "knowledge-build", "owner_briefing": "owner-briefing",
    "daily_strategist": "daily-strategist", "cost_reconcile": "cost-reconcile",
    "morning_dispatch": "morning-staff-reminder", "ads_monitor": "ads-monitor",
    "ads_optimizer": "ads-optimizer", "token_health": "token-health",
    "content_engine_1": "content-engine-1", "subscription_renewal": "subscription-renewal",
    "catchup_scan": "catchup-scan", "approval_tracker": "approval-tracker",
    "staff_presence": "staff-presence", "outcome_measure": "outcome-measure",
    "order_watch": "order-watch", "staff_morale": "staff-morale",
    "midday_checkin": "midday-checkin", "personal_midday": "personal-midday",
    "content_engine_2": "content-engine-2", "content_engine_3": "content-engine-3",
    "night_report": "night-report", "owner_task_intake": "owner-task-intake",
    "personal_checkin": "personal-checkin", "evening_proposal": "evening-proposal",
    "approval_chase": "approval-escalation", "daily_summary": "daily-summary",
    "weekly_review": "weekly-review", "weekly_reflection": "weekly-reflection",
    "customer_intel": "customer-intel", "marketing_weekly": "marketing-weekly",
]

/// Web DUTY_CATEGORY_META + DUTY_CATEGORY (agent-duties.ts) verbatim.
let smDutyCategories: [(key: String, label: String, icon: String)] = [
    ("staff", "স্টাফ", "👥"), ("sales", "সেলস ও কাস্টমার", "📦"), ("finance", "ফিন্যান্স", "💰"),
    ("marketing", "মার্কেটিং ও কন্টেন্ট", "📣"), ("reports", "রিপোর্ট ও অ্যাপ্রুভাল", "📊"),
    ("personal", "ব্যক্তিগত ও সালাহ", "🤲"), ("system", "সিস্টেম ও নলেজ", "⚙️"),
]
private let smDutyCategoryMap: [String: String] = [
    "morning_dispatch": "staff", "staff_presence": "staff", "staff_morale": "staff",
    "midday_checkin": "staff", "evening_proposal": "staff",
    "order_watch": "sales", "customer_intel": "sales",
    "cost_reconcile": "finance", "daily_cashflow": "finance", "payment_reminders": "finance",
    "subscription_renewal": "finance",
    "ads_monitor": "marketing", "ads_optimizer": "marketing", "content_engine_1": "marketing",
    "content_engine_2": "marketing", "content_engine_3": "marketing", "marketing_weekly": "marketing",
    "owner_briefing": "reports", "daily_strategist": "reports", "owner_task_intake": "reports",
    "night_report": "reports", "daily_summary": "reports", "weekly_review": "reports",
    "weekly_reflection": "reports", "approval_tracker": "reports", "approval_chase": "reports",
    "outcome_measure": "reports",
    "salah_init": "personal", "personal_midday": "personal", "personal_checkin": "personal",
    "cs_index_products": "system", "knowledge_build": "system", "token_health": "system",
    "catchup_scan": "system",
]
func smDutyCategory(_ dutyKey: String) -> String { smDutyCategoryMap[dutyKey] ?? "system" }

// MARK: - Ops data + actions (extends the screen's single coordinator)

@available(iOS 17.0, *)
@Observable
@MainActor
final class StaffMonitorOpsStore {
    var brain: SMBrainStats? = nil
    var promptCache: SMPromptCache? = nil
    var trustRules: [SMTrustRule] = []
    var health: SMHealthReport? = nil
    var healthError: String? = nil
    var healthScanning = false
    var autoFix: [SMAutoFixAction] = []
    var staffCaps: [SMStaffCap] = []
    var toggleDefs: [SMStaffToggleDef] = []
    var toggles: [String: Bool] = [:]
    var lastDeploy: String? = nil
    var deployMsg: String? = nil
    var deploying = false
    var salahConfig: SMSalahConfig? = nil
    var salahSaving = false
    var salahSavedOk = false
    var retriggering = false
    var escalatingId: String? = nil
    var approvingId: String? = nil
    var dutyToggling: String? = nil
    var geoToggling = false
    var staffTaskToggling: String? = nil
    var toast: (msg: String, ok: Bool)? = nil
}

@available(iOS 17.0, *)
extension StaffMonitorControlsVM {

    // ── Loads ──

    func loadOps(_ ops: StaffMonitorOpsStore) async {
        if let b: SMBrainStats = try? await AlmaAPI.shared.get("/api/agent/brain-stats") { ops.brain = b }
        struct CacheResp: Decodable { let promptCache: SMPromptCache? }
        if let r: CacheResp = try? await AlmaAPI.shared.get("/api/assistant/costs/summary") {
            if let pc = r.promptCache { ops.promptCache = pc }
        }
        struct RulesWrap: Decodable {
            let rules: [SMTrustRule]
            init(from decoder: Decoder) throws {
                if let arr = try? decoder.singleValueContainer().decode([SMTrustRule].self) {
                    rules = arr
                } else {
                    struct Obj: Decodable { let rules: [SMTrustRule]? }
                    let o = try? decoder.singleValueContainer().decode(Obj.self)
                    rules = o?.rules ?? []
                }
            }
        }
        if let r: RulesWrap = try? await AlmaAPI.shared.get("/api/agent/trust-rules") { ops.trustRules = r.rules }
        struct FixResp: Decodable { let actions: [SMAutoFixAction]? }
        if let f: FixResp = try? await AlmaAPI.shared.get("/api/agent/auto-fix") { ops.autoFix = f.actions ?? [] }
        if let caps: [SMStaffCap] = try? await AlmaAPI.shared.get("/api/agent/staff-capabilities") { ops.staffCaps = caps }
        struct TogglesResp: Decodable { let toggles: [String: Bool]?; let defs: [SMStaffToggleDef]? }
        if let t: TogglesResp = try? await AlmaAPI.shared.get("/api/assistant/staff-toggles") {
            if let m = t.toggles { ops.toggles = m }
            if let d = t.defs { ops.toggleDefs = d }
        }
        struct DeployInfo: Decodable {
            let ts: String?
            private enum Keys: String, CodingKey { case lastDeploy }
            private enum InnerKeys: String, CodingKey { case ts }
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: Keys.self)
                let i = try? c.nestedContainer(keyedBy: InnerKeys.self, forKey: .lastDeploy)
                ts = try? i?.decodeIfPresent(String.self, forKey: .ts)
            }
        }
        if let d: DeployInfo = try? await AlmaAPI.shared.get("/api/agent/vps/deploy") { ops.lastDeploy = d.ts }
        struct SalahResp: Decodable { let config: SMSalahConfig? }
        if let s: SalahResp = try? await AlmaAPI.shared.get("/api/agent/salah-times") { ops.salahConfig = s.config }
        await loadHealthScan(ops)
    }

    func loadHealthScan(_ ops: StaffMonitorOpsStore) async {
        ops.healthScanning = true
        defer { ops.healthScanning = false }
        // Web parity: one retry after 2s before surfacing the error.
        for attempt in 0..<2 {
            do {
                let report: SMHealthReport = try await AlmaAPI.shared.get("/api/agent/health-scan")
                ops.health = report
                ops.healthError = nil
                return
            } catch {
                if attempt == 0 {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    continue
                }
                ops.healthError = error.localizedDescription
            }
        }
    }

    // ── Actions (web handler payloads verbatim) ──

    /// POST /api/agent/staff-monitor/retrigger {jobName}.
    func retrigger(_ ops: StaffMonitorOpsStore, dutyKey: String) async {
        guard let jobName = smDutyToJob[dutyKey] else {
            ops.toast = ("Unknown duty", false)
            return
        }
        ops.retriggering = true
        defer { ops.retriggering = false }
        struct Body: Encodable { let jobName: String }
        struct Resp: Decodable { let mode: String?; let message: String? }
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/agent/staff-monitor/retrigger", body: Body(jobName: jobName))
            let mode = r.mode == "instant" ? "instantly" : "queued (~2 min)"
            ops.toast = ("✓ \(dutyKey) — \(mode)", true)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            ops.toast = ("Retrigger ব্যর্থ: \(error.localizedDescription)", false)
        }
    }

    /// POST /api/agent/staff-monitor/escalate {staffName, messageType, outboxId}.
    func escalate(_ ops: StaffMonitorOpsStore, row: StaffMonitorFeedRow) async {
        ops.escalatingId = row.id
        defer { ops.escalatingId = nil }
        struct Body: Encodable { let staffName: String?; let messageType: String; let outboxId: String }
        struct Resp: Decodable { let ok: Bool?; let actions: [String]?; let message: String? }
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/agent/staff-monitor/escalate",
                body: Body(staffName: row.staffName, messageType: row.typeLabel, outboxId: row.id))
            let acts = r.actions ?? []
            let resent = acts.contains("resent_to_staff")
            let ntfy = acts.contains("owner_ntfy_sent")
            let name = row.staffName ?? "—"
            ops.toast = (resent && ntfy ? "✅ \(name) — re-sent + NTFY"
                         : resent ? "✅ \(name) — re-sent" : "🔔 \(name) — NTFY sent", true)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            ops.toast = ("Escalation ব্যর্থ: \(error.localizedDescription)", false)
        }
    }

    /// Approve/reject a pending approval. `staff_auto_message` approve uses the
    /// dedicated staff-monitor route; everything else (and ALL rejects) hits the
    /// session-authed assistant action route — the web's exact rule.
    func decideApproval(_ ops: StaffMonitorOpsStore, id: String, type: String, approve: Bool) async {
        ops.approvingId = id
        defer { ops.approvingId = nil }
        struct Empty: Encodable {}
        struct DedicatedBody: Encodable { let actionId: String; let decision: String }
        do {
            if approve && type == "staff_auto_message" {
                struct Resp: Decodable { let ok: Bool? }
                let _: Resp = try await AlmaAPI.shared.send(
                    "POST", "/api/agent/staff-monitor/approve",
                    body: DedicatedBody(actionId: id, decision: "approve"))
            } else {
                struct Resp: Decodable { let ok: Bool?; let status: String? }
                let _: Resp = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/actions/\(id)/\(approve ? "approve" : "reject")", body: Empty())
            }
            ops.toast = (approve ? "✓ Approved" : "✗ Rejected", true)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            // Web parity: 409/410 (already resolved elsewhere) reads as success.
            let msg = error.localizedDescription
            if msg.contains("409") || msg.contains("410") {
                ops.toast = (approve ? "✓ Approved" : "✗ Rejected", true)
            } else {
                ops.toast = ("ব্যর্থ: \(msg)", false)
            }
        }
    }

    /// PATCH /api/agent/staff-monitor/duty-enabled {dutyKey, enabled} → dutyEnabled echo.
    func toggleDuty(_ ops: StaffMonitorOpsStore, dutyKey: String, enabled: Bool) async -> [String: Bool]? {
        ops.dutyToggling = dutyKey
        defer { ops.dutyToggling = nil }
        struct Body: Encodable { let dutyKey: String; let enabled: Bool }
        struct Resp: Decodable { let enabled: Bool?; let critical: Bool?; let dutyEnabled: [String: Bool]?; let error: String? }
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "PATCH", "/api/agent/staff-monitor/duty-enabled", body: Body(dutyKey: dutyKey, enabled: enabled))
            if !enabled && r.critical == true {
                ops.toast = ("⚠️ Critical duty OFF — CS/finance/scheduler coverage may be affected", false)
            } else {
                ops.toast = (enabled ? "\(dutyKey) চালু — scheduler + todo তালিকায় ফিরবে"
                                     : "\(dutyKey) বন্ধ — auto-run ও todo বাদ", enabled)
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            return r.dutyEnabled
        } catch {
            ops.toast = ("Duty toggle ব্যর্থ", false)
            return nil
        }
    }

    /// PATCH /api/agent/staff-monitor/geo-fence {enabled} → {enabled} echo.
    func toggleGeoFence(_ ops: StaffMonitorOpsStore, enabled: Bool) async -> Bool? {
        ops.geoToggling = true
        defer { ops.geoToggling = false }
        struct Body: Encodable { let enabled: Bool }
        struct Resp: Decodable { let enabled: Bool }
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "PATCH", "/api/agent/staff-monitor/geo-fence", body: Body(enabled: enabled))
            ops.toast = (r.enabled ? "Geo-Fence tracking চালু"
                                   : "Geo-Fence tracking বন্ধ — attendance-এ location এখনও লাগবে", true)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            return r.enabled
        } catch {
            ops.toast = ("Geo-Fence toggle ব্যর্থ", false)
            return nil
        }
    }

    /// PATCH /api/assistant/staff-toggles {key, enabled} → toggles echo.
    func toggleStaffTask(_ ops: StaffMonitorOpsStore, key: String, enabled: Bool) async {
        ops.staffTaskToggling = key
        defer { ops.staffTaskToggling = nil }
        struct Body: Encodable { let key: String; let enabled: Bool }
        struct Resp: Decodable { let toggles: [String: Bool]?; let error: String? }
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/staff-toggles", body: Body(key: key, enabled: enabled))
            if let m = r.toggles { ops.toggles = m }
            ops.toast = (enabled ? "চালু করা হলো" : "বন্ধ করা হলো", enabled)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            ops.toast = ("Toggle ব্যর্থ", false)
        }
    }

    /// PATCH /api/agent/trust-rules {ruleId, tier}.
    func updateTrustTier(_ ops: StaffMonitorOpsStore, ruleId: String, tier: String) async {
        struct Body: Encodable { let ruleId: String; let tier: String }
        struct Resp: Decodable { let ok: Bool? }
        do {
            let _: Resp = try await AlmaAPI.shared.send("PATCH", "/api/agent/trust-rules", body: Body(ruleId: ruleId, tier: tier))
            ops.toast = ("Trust tier updated", true)
            if let idx = ops.trustRules.firstIndex(where: { $0.id == ruleId }) {
                ops.trustRules[idx].tier = tier
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            ops.toast = ("Update failed", false)
        }
    }

    /// POST /api/agent/auto-fix — request ({issue}) or decision ({actionId, decision}).
    func requestAutoFix(_ ops: StaffMonitorOpsStore, issue: SMHealthIssue) async {
        struct Body: Encodable {
            struct Issue: Encodable { let severity: String; let area: String; let title: String; let detail: String; let signal: String? }
            let issue: Issue
        }
        struct Resp: Decodable { let ok: Bool?; let costEstimate: Double? }
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/agent/auto-fix",
                body: Body(issue: .init(severity: issue.severity, area: issue.area,
                                        title: issue.title, detail: issue.detail, signal: issue.signal)))
            if r.ok == true {
                ops.toast = (String(format: "Auto-fix request created · ~$%.2f", r.costEstimate ?? 0), true)
            } else {
                ops.toast = ("Auto-fix request failed", false)
            }
        } catch {
            ops.toast = ("Auto-fix request failed", false)
        }
        struct FixResp: Decodable { let actions: [SMAutoFixAction]? }
        if let f: FixResp = try? await AlmaAPI.shared.get("/api/agent/auto-fix") { ops.autoFix = f.actions ?? [] }
    }

    func decideAutoFix(_ ops: StaffMonitorOpsStore, actionId: String, approve: Bool) async {
        struct Body: Encodable { let actionId: String; let decision: String }
        struct Resp: Decodable { let ok: Bool? }
        do {
            let _: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/agent/auto-fix", body: Body(actionId: actionId, decision: approve ? "approve" : "reject"))
            ops.toast = (approve ? "✅ Auto-Fix শুরু হচ্ছে..." : "❌ বাতিল", true)
        } catch {
            ops.toast = ("Failed", false)
        }
        struct FixResp: Decodable { let actions: [SMAutoFixAction]? }
        if let f: FixResp = try? await AlmaAPI.shared.get("/api/agent/auto-fix") { ops.autoFix = f.actions ?? [] }
    }

    /// POST /api/agent/vps/deploy — web handleDeploy parity (3 attempts, 207 ok).
    func deployWorker(_ ops: StaffMonitorOpsStore) async {
        guard !ops.deploying else { return }
        ops.deploying = true
        defer { ops.deploying = false }
        struct Empty: Encodable {}
        for attempt in 0..<3 {
            do {
                let r: SMDeployResult = try await AlmaAPI.shared.send("POST", "/api/agent/vps/deploy", body: Empty())
                ops.deployMsg = r.summaryLine
                ops.lastDeploy = ISO8601DateFormatter().string(from: Date())
                UINotificationFeedbackGenerator().notificationOccurred(r.verified == true ? .success : .warning)
                return
            } catch {
                if attempt < 2 {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    continue
                }
                ops.deployMsg = "✗ \(error.localizedDescription)"
            }
        }
    }

    /// POST /api/agent/salah-times {config} → {config} echo.
    func saveSalahConfig(_ ops: StaffMonitorOpsStore) async {
        guard let cfg = ops.salahConfig, !ops.salahSaving else { return }
        ops.salahSaving = true
        defer { ops.salahSaving = false }
        struct Body: Encodable { let config: SMSalahConfig }
        struct Resp: Decodable { let config: SMSalahConfig? }
        do {
            let r: Resp = try await AlmaAPI.shared.send("POST", "/api/agent/salah-times", body: Body(config: cfg))
            if let c = r.config { ops.salahConfig = c }
            ops.salahSavedOk = true
            ops.toast = ("✓ নামাজের সময় সেভ হয়েছে", true)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            ops.toast = ("সেভ ব্যর্থ: \(error.localizedDescription)", false)
        }
    }
}

// MARK: - System tab view

@available(iOS 17.0, *)
struct StaffMonitorSystemTab: View {
    let vm: StaffMonitorControlsVM
    let ops: StaffMonitorOpsStore
    let duties: [StaffMonitorDuty]
    let salahDuties: [StaffMonitorSalah]
    let services: [StaffMonitorService]
    let dutyEnabled: [String: Bool]
    let dutyTimeOverrides: [String: String]
    let isLive: Bool
    let onDutyEnabledEcho: ([String: Bool]) -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var expandedDuty: String? = nil
    @State private var salahSettingsOpen = false
    @State private var voiceOpen = false
    @AppStorage("alma-voice-streaming") private var voiceStreaming = true
    @AppStorage("alma-wake-word") private var wakeWord = true

    private let emerald = Color(red: 0.020, green: 0.588, blue: 0.412)
    private let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)
    private let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)
    private let coral = AlmaSwiftTheme.coral
    private let gold = Color(red: 0.831, green: 0.659, blue: 0.294)

    /// Owner feedback 2026-07-17: the stacked System cards read like the web's
    /// clutter. iOS composition — compact grouped rows, each drilling into a
    /// focused sheet (same language as the Agents tab control room).
    enum SystemSheet: String, Identifiable {
        case duty, salah, voice, trust, brain, health, autofix, services, deploy
        var id: String { rawValue }
    }
    @State private var sheet: SystemSheet? = nil

    var body: some View {
        let dutyDone = duties.filter { $0.status == "done" }.count
        let dutyFailed = duties.filter { $0.status == "failed" || $0.status == "missed" }.count
        let salahDone = salahDuties.filter { $0.status == "done" }.count
        let healthySvc = services.filter(\.healthy).count
        let pendingFix = ops.autoFix.filter { $0.status == "pending" }.count
        VStack(spacing: 10) {
            VStack(spacing: 0) {
                sysRow("🤖", "Agent ডিউটি",
                       duties.isEmpty ? "ডেটা নেই" : "\(dutyDone)/\(duties.count) done\(dutyFailed > 0 ? " · \(dutyFailed) failed" : "")",
                       tint: dutyFailed > 0 ? red500 : emerald, sheet: .duty)
                divider
                if isLive {
                    sysRow("🕌", "সালাহ",
                           salahDuties.isEmpty ? "সময় ও রিমাইন্ডার" : "\(salahDone)/\(salahDuties.count) ওয়াক্ত হয়েছে",
                           tint: emerald, sheet: .salah)
                    divider
                    sysRow("🎙️", "ভয়েস সেটিংস", "স্ট্রিমিং · ওয়েক ওয়ার্ড", tint: coral, sheet: .voice)
                    divider
                    sysRow("🛡️", "ট্রাস্ট ইঞ্জিন",
                           ops.trustRules.isEmpty ? "কোনো rule নেই" : "\(ops.trustRules.count)টা rule",
                           tint: Color(red: 0.506, green: 0.698, blue: 0.604), sheet: .trust)
                    divider
                    sysRow("🧠", "এজেন্ট ব্রেইন",
                           ops.brain.map { "\($0.memoryCount) memories · $\(String(format: "%.2f", $0.todayCostUsd)) আজ" } ?? "লোড হচ্ছে…",
                           tint: coral, sheet: .brain)
                    divider
                    sysRow("🔍", "System Health",
                           ops.health.map { $0.ok ? "✅ Healthy" : "⚠️ \($0.issues.count)টা issue" } ?? "স্ক্যান হচ্ছে…",
                           tint: (ops.health?.ok ?? true) ? emerald : red500, sheet: .health)
                    if !ops.autoFix.isEmpty {
                        divider
                        sysRow("🛠️", "Auto-Fix",
                               pendingFix > 0 ? "\(pendingFix)টা অনুমোদনের অপেক্ষায়" : "\(ops.autoFix.count)টা অ্যাকশন",
                               tint: pendingFix > 0 ? gold : .secondary, sheet: .autofix)
                    }
                    if !services.isEmpty {
                        divider
                        sysRow("⚡", "Background Services", "\(healthySvc)/\(services.count) সুস্থ",
                               tint: healthySvc == services.count ? emerald : red500, sheet: .services)
                    }
                    divider
                    sysRow("🚀", "VPS Worker",
                           ops.deployMsg.map { String($0.prefix(40)) } ?? (smClock(ops.lastDeploy).map { "Last deploy \($0)" } ?? "Deploy + verify"),
                           tint: Color(red: 0.506, green: 0.698, blue: 0.604), sheet: .deploy)
                }
            }
            .sysGlass(scheme)
            buildBadge
        }
        .sheet(item: $sheet) { which in
            NavigationStack {
                ScrollView {
                    VStack(spacing: 10) {
                        switch which {
                        case .duty: dutyTimelineCard
                        case .salah:
                            salahCard
                            salahSettingsCard
                        case .voice: voiceSettingsCard
                        case .trust: trustCard
                        case .brain: brainCard
                        case .health: healthCard
                        case .autofix: autoFixCard
                        case .services: servicesCard
                        case .deploy: deployCard
                        }
                    }
                    .padding(14)
                }
                .scrollContentBackground(.hidden)
                .navigationTitle(sysSheetTitle(which))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button("বন্ধ") { sheet = nil } }
                }
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            // Aurora, not flat near-black — same look as the tab (owner feedback 2026-07-17).
            .presentationBackground { StaffMonitorAurora() }
        }
        #if DEBUG
        .onAppear {
            // Headless sim proof hook: SIMCTL_CHILD_ALMA_SM_SHEET=trust|health|brain|…
            // auto-opens that control-room sheet so its aurora background can be
            // screenshot-verified without a tap. DEBUG only — never ships.
            if sheet == nil, let raw = ProcessInfo.processInfo.environment["ALMA_SM_SHEET"],
               let s = SystemSheet(rawValue: raw) { sheet = s }
        }
        #endif
    }

    private var divider: some View {
        Divider().opacity(0.25).padding(.leading, 56)
    }

    private func sysSheetTitle(_ s: SystemSheet) -> String {
        switch s {
        case .duty: return "Agent ডিউটি"
        case .salah: return "সালাহ"
        case .voice: return "ভয়েস"
        case .trust: return "ট্রাস্ট ইঞ্জিন"
        case .brain: return "এজেন্ট ব্রেইন"
        case .health: return "System Health"
        case .autofix: return "Auto-Fix"
        case .services: return "Services"
        case .deploy: return "VPS Worker"
        }
    }

    private func sysRow(_ icon: String, _ title: String, _ subtitle: String,
                        tint: Color, sheet target: SystemSheet) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            sheet = target
        } label: {
            HStack(spacing: 12) {
                Text(icon)
                    .font(.system(size: 17))
                    .frame(width: 38, height: 38)
                    .background(tint.opacity(0.13),
                                in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                    Text(subtitle).font(.caption2).foregroundStyle(tint).lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("\(title) — \(subtitle)"))
    }

    // ── 🤖 Agent Duties: category-grouped rows + per-duty toggle + retrigger ──

    private var dutyTimelineCard: some View {
        let done = duties.filter { $0.status == "done" }.count
        let failed = duties.filter { $0.status == "failed" || $0.status == "missed" }.count
        let enabledCount = duties.filter { dutyEnabled[$0.duty] != false }.count
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text("🤖 Agent Duties")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                pill("\(done)/\(enabledCount) done", coral)
                if failed > 0 { pill("\(failed) failed", red500) }
                Spacer()
            }
            if duties.isEmpty {
                Text("আজকের ডিউটি ডেটা নেই।").font(.caption2).foregroundStyle(.secondary)
            }
            ForEach(smDutyCategories, id: \.key) { cat in
                let catDuties = duties.filter { smDutyCategory($0.duty) == cat.key }
                if !catDuties.isEmpty {
                    let catEnabled = catDuties.filter { dutyEnabled[$0.duty] != false }.count
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 5) {
                            Text("\(cat.icon) \(cat.label)")
                                .font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary)
                            Text("\(catEnabled)/\(catDuties.count) চালু")
                                .font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                        }
                        ForEach(catDuties) { d in
                            dutyRow(d)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .sysGlass(scheme)
    }

    @ViewBuilder private func dutyRow(_ d: StaffMonitorDuty) -> some View {
        let enabled = dutyEnabled[d.duty] != false
        let isFailed = d.status == "failed" || d.status == "missed"
        let isOpen = expandedDuty == d.duty
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Button {
                    UISelectionFeedbackGenerator().selectionChanged()
                    withAnimation(.easeOut(duration: 0.15)) { expandedDuty = isOpen ? nil : d.duty }
                } label: {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(!enabled ? Color.secondary.opacity(0.5)
                                  : d.status == "done" ? emerald
                                  : isFailed ? red500
                                  : d.status == "skipped" ? Color.secondary.opacity(0.5)
                                  : amber600)
                            .frame(width: 8, height: 8)
                        Text(d.label)
                            .font(.caption)
                            .foregroundStyle(enabled ? .primary : .secondary)
                            .lineLimit(1)
                        if !enabled {
                            Text("OFF").font(.system(size: 8, weight: .bold)).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 4)
                        Text(dutyTimeOverrides[d.duty] ?? smClock(d.ranAt) ?? d.time ?? "")
                            .font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if isLive {
                    if ops.dutyToggling == d.duty {
                        ProgressView().controlSize(.mini)
                    } else if d.duty != "salah_init" {  // web LOCKED_DUTIES
                        Toggle("", isOn: Binding(get: { enabled }, set: { on in
                            UISelectionFeedbackGenerator().selectionChanged()
                            Task {
                                if let echo = await vm.toggleDuty(ops, dutyKey: d.duty, enabled: on) {
                                    onDutyEnabledEcho(echo)
                                }
                            }
                        }))
                        .labelsHidden()
                        .controlSize(.mini)
                        .tint(emerald)
                        .frame(width: 40)
                    }
                }
            }
            if isOpen {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        pill(d.status, d.status == "done" ? emerald : isFailed ? red500 : amber600)
                        if let t = smClock(d.ranAt) {
                            Text("at \(t)").font(.system(size: 9)).foregroundStyle(.secondary)
                        }
                    }
                    if let detail = d.detail, !detail.isEmpty {
                        Text(detail).font(.caption2)
                            .foregroundStyle(isFailed ? red500 : .secondary)
                    }
                    if isLive, smDutyToJob[d.duty] != nil {
                        Button {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            Task { await vm.retrigger(ops, dutyKey: d.duty) }
                        } label: {
                            Text(ops.retriggering ? "⏳ Running…" : "⟳ Retrigger")
                                .font(.system(size: 10, weight: .bold))
                                .padding(.horizontal, 10).padding(.vertical, 5)
                                .background(coral.opacity(0.12), in: Capsule())
                                .foregroundStyle(coral)
                        }
                        .buttonStyle(.plain)
                        .disabled(ops.retriggering)
                    }
                }
                .padding(8)
                .background((isFailed ? red500 : Color.primary).opacity(0.05),
                            in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    // ── 🕌 Salah timeline + time settings ──

    @ViewBuilder private var salahCard: some View {
        if !salahDuties.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("🕌 Salah Reminders")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                ForEach(salahDuties) { s in
                    HStack(spacing: 8) {
                        Circle()
                            .fill(s.status == "done" ? emerald : s.status == "missed" ? red500 : amber600)
                            .frame(width: 8, height: 8)
                        Text(s.label).font(.caption)
                        if s.reminders > 0 {
                            Text("(\(s.reminders)×)").font(.system(size: 9)).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(s.status == "done" ? (s.doneTime ?? s.scheduledTime) : s.scheduledTime)
                            .font(.system(size: 10).monospacedDigit()).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .sysGlass(scheme)
        }
    }

    private var salahSettingsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                UISelectionFeedbackGenerator().selectionChanged()
                withAnimation { salahSettingsOpen.toggle() }
            } label: {
                HStack {
                    Text("🕌 নামাজের সময় (৩×৫ ওয়াক্ত)")
                        .font(.caption.weight(.bold)).foregroundStyle(.primary)
                    Spacer()
                    Image(systemName: salahSettingsOpen ? "chevron.up" : "chevron.down")
                        .font(.caption2).foregroundStyle(coral)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if salahSettingsOpen {
                Text("আযান · জামাত · ওয়াক্ত শেষ — HH:MM (২৪ঘ) Dhaka। জুম্মায় যোহর আযান ১:০০ কোডে থাকে।")
                    .font(.system(size: 9)).foregroundStyle(.secondary)
                if ops.salahConfig == nil {
                    Text("লোড হচ্ছে…").font(.caption2).foregroundStyle(.secondary)
                } else {
                    ForEach(smWaqtOrder, id: \.key) { waqt in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(waqt.label).font(.caption.weight(.bold))
                            HStack(spacing: 6) {
                                salahField(waqt.key, "azan", "আযান")
                                salahField(waqt.key, "prayer", "জামাত")
                                salahField(waqt.key, "end", "শেষ")
                            }
                        }
                        .padding(.vertical, 3)
                    }
                    HStack(spacing: 8) {
                        Button {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            Task { await vm.saveSalahConfig(ops) }
                        } label: {
                            Text(ops.salahSaving ? "সেভ…" : "💾 সেভ করুন")
                                .font(.caption.weight(.bold))
                                .padding(.horizontal, 14).padding(.vertical, 8)
                                .background(coral.opacity(0.12), in: Capsule())
                                .foregroundStyle(coral)
                        }
                        .buttonStyle(.plain)
                        .disabled(ops.salahSaving)
                        if ops.salahSavedOk {
                            Text("✓ সেভ হয়েছে").font(.caption2).foregroundStyle(emerald)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .sysGlass(scheme)
    }

    private func salahField(_ waqt: String, _ field: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 8)).foregroundStyle(.secondary)
            TextField("HH:MM", text: Binding(
                get: { ops.salahConfig?[waqt]?[field] ?? "" },
                set: { newValue in
                    var cfg = ops.salahConfig ?? [:]
                    var w = cfg[waqt] ?? [:]
                    w[field] = newValue
                    cfg[waqt] = w
                    ops.salahConfig = cfg
                    ops.salahSavedOk = false
                }))
                .font(.caption.monospacedDigit())
                .keyboardType(.numbersAndPunctuation)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: .infinity)
        }
    }

    // ── 🎙️ Voice settings (native app's real switches) ──

    private var voiceSettingsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                UISelectionFeedbackGenerator().selectionChanged()
                withAnimation { voiceOpen.toggle() }
            } label: {
                HStack {
                    Text("🎙️ ভয়েস সেটিংস")
                        .font(.caption.weight(.bold)).foregroundStyle(.primary)
                    Spacer()
                    Image(systemName: voiceOpen ? "chevron.up" : "chevron.down")
                        .font(.caption2).foregroundStyle(coral)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if voiceOpen {
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("ভয়েস স্ট্রিমিং").font(.caption.weight(.medium))
                        Text("কথা বলতে বলতে সাথে সাথে ট্রান্সক্রাইব").font(.system(size: 9)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Toggle("", isOn: $voiceStreaming).labelsHidden().tint(emerald)
                }
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("ওয়েক ওয়ার্ড").font(.caption.weight(.medium))
                        Text("ভয়েস কনসোলে নাম ধরে ডাকলে জাগবে").font(.system(size: 9)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Toggle("", isOn: $wakeWord).labelsHidden().tint(emerald)
                }
                Text("ওয়েবের অন-ডিভাইস STT ফ্ল্যাগ (alma_native_stt) ওয়েবভিউ-স্কোপড — সেটা /agent Monitor-এর ওয়েব সেটিংসে।")
                    .font(.system(size: 8)).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .sysGlass(scheme)
    }

    // ── 🛡️ Trust engine ──

    private var trustCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("🛡️ ট্রাস্ট ইঞ্জিন")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                if !ops.trustRules.isEmpty { pill("\(ops.trustRules.count) rules", Color(red: 0.506, green: 0.698, blue: 0.604)) }
                Spacer()
            }
            if ops.trustRules.isEmpty {
                Text("কোনো trust rule নেই — agent approve হতে থাকলে auto-promote হবে")
                    .font(.caption2).foregroundStyle(.secondary)
            } else {
                ForEach(ops.trustRules) { rule in
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(rule.domain) / \(rule.actionPattern)")
                                .font(.caption.weight(.semibold)).lineLimit(1)
                            HStack(spacing: 8) {
                                Text("✅ \(rule.approvalCount)").font(.system(size: 9)).foregroundStyle(.secondary)
                                Text("❌ \(rule.rejectionCount)").font(.system(size: 9)).foregroundStyle(.secondary)
                                if rule.consecutiveApprovals >= 3 {
                                    Text("🔥 \(rule.consecutiveApprovals)")
                                        .font(.system(size: 9, weight: .bold)).foregroundStyle(coral)
                                }
                            }
                        }
                        Spacer()
                        Menu {
                            Button("🔒 Approve") { Task { await vm.updateTrustTier(ops, ruleId: rule.id, tier: "approve") } }
                            Button("📢 Notify") { Task { await vm.updateTrustTier(ops, ruleId: rule.id, tier: "notify") } }
                            Button("⚡ Auto") { Task { await vm.updateTrustTier(ops, ruleId: rule.id, tier: "auto") } }
                        } label: {
                            let (icon, label, color): (String, String, Color) =
                                rule.tier == "auto" ? ("⚡", "Auto", Color(red: 0.506, green: 0.698, blue: 0.604))
                                : rule.tier == "notify" ? ("📢", "Notify", gold)
                                : ("🔒", "Approve", coral)
                            Text("\(icon) \(label)")
                                .font(.system(size: 10, weight: .bold))
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(color.opacity(0.12), in: Capsule())
                                .foregroundStyle(color)
                        }
                    }
                    .padding(.vertical, 2)
                    if rule.id != ops.trustRules.last?.id { Divider().opacity(0.3) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .sysGlass(scheme)
    }

    // ── 🧠 Brain stats + prompt cache ──

    private var brainCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("🧠 এজেন্ট ব্রেইন")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            if let pc = ops.promptCache {
                if pc.cachingBroken {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("⚠️ caching হিট করছে না").font(.caption.weight(.semibold)).foregroundStyle(amber600)
                        Text("আজ \(pc.chatTurns) টার্ন · cache read \(smTokens(pc.cacheReadTokens)) · hit \(Int((pc.cacheHitRatio * 100).rounded()))%")
                            .font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                    }
                    .padding(8)
                    .background(amber600.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("💾 ক্যাশ থেকে বাঁচানো: \(smTokens(pc.tokensSaved)) টোকেন · ~$\(String(format: "%.2f", pc.usdSaved)) আজ")
                            .font(.caption2.weight(.medium)).foregroundStyle(emerald)
                        Text("hit \(Int((pc.cacheHitRatio * 100).rounded()))% · read \(smTokens(pc.cacheReadTokens)) · fresh \(smTokens(pc.inputTokens)) · \(pc.chatTurns) turns")
                            .font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                    }
                    .padding(8)
                    .background(emerald.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                }
            }
            if let b = ops.brain {
                HStack(spacing: 8) {
                    brainNode("Memories", "\(b.memoryCount)", coral)
                    brainNode("Active Rules", "\(b.activePlaybookCount)", Color(red: 0.506, green: 0.698, blue: 0.604))
                    brainNode("Knowledge", "\(b.knowledgeCount)", gold)
                }
                HStack(spacing: 8) {
                    brainNode("Last Session", smClock(b.lastSessionSummary) ?? "—", .secondary)
                    brainNode("Knowledge Build", smClock(b.lastKnowledgeBuild) ?? "—", .secondary)
                    brainNode("AI Cost আজ", String(format: "$%.2f", b.todayCostUsd), coral)
                }
                if b.proposedPlaybookCount > 0 {
                    Text("💡 \(b.proposedPlaybookCount) proposed rule\(b.proposedPlaybookCount > 1 ? "s" : "") — awaiting approval")
                        .font(.caption2.weight(.semibold)).foregroundStyle(gold)
                }
            } else {
                Text("Loading brain stats…").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .sysGlass(scheme)
    }

    private func brainNode(_ label: String, _ value: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 8, weight: .bold)).textCase(.uppercase).foregroundStyle(.secondary)
            Text(value).font(.footnote.weight(.black).monospacedDigit()).foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 10))
    }

    // ── 🔍 System health + auto-fix ──

    private var healthCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("🔍 System Health")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                if let h = ops.health {
                    pill(h.ok ? "✅ Healthy" : "⚠️ \(h.issues.count) issues", h.ok ? emerald : red500)
                }
                Spacer()
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    Task { await vm.loadHealthScan(ops) }
                } label: {
                    Text(ops.healthScanning ? "⏳ Scanning…" : "🔍 Scan Now")
                        .font(.system(size: 10, weight: .bold))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(coral.opacity(0.12), in: Capsule())
                        .foregroundStyle(coral)
                }
                .buttonStyle(.plain)
                .disabled(ops.healthScanning)
            }
            if let err = ops.healthError, ops.health == nil {
                Text("⚠️ Scan failed: \(err). Tap Scan Now to retry.")
                    .font(.caption2).foregroundStyle(red500)
            } else if let h = ops.health {
                if h.ok {
                    Label(h.summary, systemImage: "checkmark.circle")
                        .font(.caption2).foregroundStyle(emerald)
                } else {
                    ForEach(h.issues) { issue in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                pill(issue.severity.uppercased(),
                                     issue.severity == "high" ? red500 : issue.severity == "medium" ? amber600 : .secondary)
                                Text(issue.title).font(.caption.weight(.semibold)).lineLimit(2)
                            }
                            HStack(alignment: .top) {
                                Text(issue.detail).font(.system(size: 10)).foregroundStyle(.secondary)
                                Spacer(minLength: 6)
                                if issue.severity == "high" {
                                    if issue.autoFixEligible {
                                        Button {
                                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                            Task { await vm.requestAutoFix(ops, issue: issue) }
                                        } label: {
                                            Text("🤖 Fix This")
                                                .font(.system(size: 9, weight: .bold))
                                                .padding(.horizontal, 8).padding(.vertical, 4)
                                                .background(Color(red: 0.506, green: 0.698, blue: 0.604).opacity(0.14), in: Capsule())
                                                .foregroundStyle(Color(red: 0.506, green: 0.698, blue: 0.604))
                                        }
                                        .buttonStyle(.plain)
                                    } else {
                                        Text("Agent tool দিয়ে ঠিক করুন")
                                            .font(.system(size: 9)).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                        .padding(8)
                        .background((issue.severity == "high" ? red500 : issue.severity == "medium" ? amber600 : Color.primary).opacity(0.05),
                                    in: RoundedRectangle(cornerRadius: 10))
                    }
                }
            } else {
                Text(ops.healthScanning ? "Scanning…" : "Loading health scan…")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .sysGlass(scheme)
    }

    private var autoFixCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("🤖 Auto-Fix Pipeline (\(ops.autoFix.count))")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            ForEach(ops.autoFix) { a in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        pill(a.statusLabel,
                             a.status == "completed" ? emerald
                             : a.status == "rejected" ? .secondary
                             : a.status == "pending" ? gold
                             : a.status == "approved" || a.status == "in_progress" ? Color(red: 0.506, green: 0.698, blue: 0.604)
                             : red500)
                        Text(a.title).font(.caption.weight(.semibold)).lineLimit(1)
                        Spacer()
                        Text(String(format: "$%.2f", a.costEstimate))
                            .font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                    }
                    if a.status == "pending" {
                        HStack(spacing: 8) {
                            Button {
                                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                Task { await vm.decideAutoFix(ops, actionId: a.id, approve: true) }
                            } label: {
                                Text("✅ Approve").font(.system(size: 9, weight: .bold))
                                    .padding(.horizontal, 8).padding(.vertical, 4)
                                    .background(emerald.opacity(0.12), in: Capsule()).foregroundStyle(emerald)
                            }
                            .buttonStyle(.plain)
                            Button {
                                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                Task { await vm.decideAutoFix(ops, actionId: a.id, approve: false) }
                            } label: {
                                Text("❌ Reject").font(.system(size: 9, weight: .bold))
                                    .padding(.horizontal, 8).padding(.vertical, 4)
                                    .background(red500.opacity(0.12), in: Capsule()).foregroundStyle(red500)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.vertical, 2)
                if a.id != ops.autoFix.last?.id { Divider().opacity(0.3) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .sysGlass(scheme)
    }

    // ── ⚡ Background services + deploy + build ──

    private var servicesCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("⚡ Background Services (\(services.count))")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            FlowLayoutSM(spacing: 6) {
                ForEach(services) { s in
                    HStack(spacing: 4) {
                        Circle().fill(s.healthy ? emerald : red500).frame(width: 6, height: 6)
                        Text(s.label).font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Color.primary.opacity(0.04), in: Capsule())
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .sysGlass(scheme)
    }

    private var deployCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("🚀 VPS Worker")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            Button {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                Task { await vm.deployWorker(ops) }
            } label: {
                Text(ops.deploying ? "Deploying…" : "🚀 Deploy Worker")
                    .font(.footnote.weight(.bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(Color(red: 0.506, green: 0.698, blue: 0.604).opacity(0.14), in: Capsule())
                    .foregroundStyle(Color(red: 0.506, green: 0.698, blue: 0.604))
            }
            .buttonStyle(.plain)
            .disabled(ops.deploying)
            if let msg = ops.deployMsg {
                Text(msg).font(.system(size: 10))
                    .foregroundStyle(msg.hasPrefix("✓") ? emerald : msg.hasPrefix("⚠") ? amber600 : red500)
            }
            if let t = smClock(ops.lastDeploy) {
                Text("Last deploy: \(t)").font(.system(size: 9)).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .sysGlass(scheme)
    }

    private var buildBadge: some View {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        let commit = Bundle.main.object(forInfoDictionaryKey: "ALMAGitCommit") as? String
        return Text("ALMA ERP v\(version) (\(build))\(commit.map { " · \(String($0.prefix(7)))" } ?? "")")
            .font(.system(size: 9).monospacedDigit())
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.top, 2)
    }

    private func pill(_ text: String, _ color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(color.opacity(0.10), in: Capsule())
            .overlay(Capsule().strokeBorder(color.opacity(0.30), lineWidth: 0.8))
    }
}

/// Tokens formatter (web fmtTokens verbatim).
func smTokens(_ n: Int) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
    if n >= 1_000 { return "\(Int((Double(n) / 1_000).rounded()))k" }
    return "\(n)"
}

/// Minimal wrapping flow layout for the service chips.
@available(iOS 17.0, *)
struct FlowLayoutSM: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 320
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for sub in subviews {
            let size = sub.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 { x = 0; y += rowH + spacing; rowH = 0 }
            x += size.width + spacing
            rowH = max(rowH, size.height)
        }
        return CGSize(width: width, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for sub in subviews {
            let size = sub.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            sub.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += size.width + spacing
            rowH = max(rowH, size.height)
        }
    }
}

// MARK: - Glass (file-owned copy per parallel-session rule)

@available(iOS 17.0, *)
private extension View {
    func sysGlass(_ scheme: ColorScheme) -> some View {
        self
            .background(.ultraThinMaterial,
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}
