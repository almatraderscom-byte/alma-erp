//
//  PortalOfficeSwiftUI.swift
//  ALMA ERP — the staff Office tab (/portal/office) as a native SwiftUI screen.
//
//  Full ACTION PARITY with the web office app (owner instruction 2026-07-06):
//  every staff action the web offers that is NOT camera/GPS/file-upload dependent
//  is wired natively here. Same endpoints, same Bangla strings, same colours:
//    GET  /api/assistant/office/my-tasks       → today's still-open tasks {tasks:[{id,title,type,serial}]}
//    GET  /api/assistant/office/thread?taskId= → {task,comments:[{id,authorType,body,createdAt}],events}
//    POST /api/assistant/office/staff-action   → task actions (see below)
//         · {action:'done', taskId}                              → mark done
//         · {action:'comment', taskId, body}                     → text comment
//         · {action:'update', taskId, body}                      → answer Boss's update request
//         · {action:'self_create', title, detail}                → propose self-initiated work
//    GET  /api/assistant/office/chat           → group feed {businessId, messages:[…]}
//    POST /api/assistant/office/chat           → send a text message {body, attachments:[]}
//    POST /api/assistant/office/chat/explain   → {taskId} — agent explains one task in the group
//    GET  /api/assistant/office/notifications  → {unread, items:[…]}
//    POST /api/assistant/office/notifications  → mark read ({} = all, {id} = one)
//    POST /api/assistant/office/lunch          → {action:'start'|'end'} (45-min allowance)
//  Blocks: header · lunch card · আজকের কাজ (tap → native detail sheet: thread + ✅ done +
//  💬 comment + update answer) · নিজে থেকে কাজ composer · গ্রুপ চ্যাট sheet (send text +
//  explain a task) · নোটিফিকেশন feed with mark-read · small web links for photo proof only.
//  NOT native (web escape — needs the camera / file upload): proof-photo submission and
//  chat image attachments. A small labeled link opens exactly those in the web app.
//  Carried lessons: ONE spinner per action, never a global overlay. Chat sends don't confirm.
//

import SwiftUI
import PhotosUI
import UIKit

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

enum PortalOfficePalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    static let violet = AlmaSwiftTheme.violet

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Models (same field names the office routes return)

/// One row of GET /api/assistant/office/my-tasks — TodayTaskBrief on the server.
struct PortalOfficeTask: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let type: String?
    let serial: Int?

    private enum Keys: String, CodingKey { case id, title, type, serial }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        title = (try? c.decode(String.self, forKey: .title)) ?? "—"
        type = try? c.decodeIfPresent(String.self, forKey: .type)
        serial = Self.flexInt(c, .serial)
    }
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
}

struct PortalOfficeTasksResponse: Decodable {
    let tasks: [PortalOfficeTask]
    private enum Keys: String, CodingKey { case ok, data, tasks }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        tasks = (try? c.decode([PortalOfficeTask].self, forKey: .tasks)) ?? []
    }
}

/// One OfficeNotice row from the notifications feed.
struct PortalOfficeNotice: Decodable, Identifiable, Equatable {
    let id: String
    let taskId: String?
    let kind: String?
    let title: String
    let body: String?
    var read: Bool
    let createdAt: String?

    private enum Keys: String, CodingKey { case id, taskId, kind, title, body, read, createdAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        taskId = try? c.decodeIfPresent(String.self, forKey: .taskId)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        title = (try? c.decode(String.self, forKey: .title)) ?? "—"
        body = try? c.decodeIfPresent(String.self, forKey: .body)
        read = (try? c.decodeIfPresent(Bool.self, forKey: .read)) ?? true
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

struct PortalOfficeNotifFeed: Decodable {
    let unread: Int
    let items: [PortalOfficeNotice]
    private enum Keys: String, CodingKey { case ok, data, unread, items }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        if let i = try? c.decodeIfPresent(Int.self, forKey: .unread) { unread = i }
        else if let d = try? c.decodeIfPresent(Double.self, forKey: .unread) { unread = Int(d.rounded()) }
        else { unread = 0 }
        items = (try? c.decode([PortalOfficeNotice].self, forKey: .items)) ?? []
    }
}

/// POST /api/assistant/office/lunch — start: {ok,status,startedAt} · end: {ok,status,durationMin}.
struct PortalOfficeLunchResponse: Decodable {
    let ok: Bool?
    let status: String?
    let startedAt: String?
    let durationMin: Int?

    private enum Keys: String, CodingKey { case ok, status, startedAt, durationMin }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        startedAt = try? c.decodeIfPresent(String.self, forKey: .startedAt)
        if let i = try? c.decodeIfPresent(Int.self, forKey: .durationMin) { durationMin = i }
        else if let d = try? c.decodeIfPresent(Double.self, forKey: .durationMin) { durationMin = Int(d.rounded()) }
        else { durationMin = nil }
    }
}

/// One comment row of GET /api/assistant/office/thread — ThreadMessage on the server.
struct PortalOfficeThreadMsg: Decodable, Identifiable, Equatable {
    let id: String
    let authorType: String
    let body: String
    let createdAt: String?

    private enum Keys: String, CodingKey { case id, authorType, body, createdAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        authorType = (try? c.decode(String.self, forKey: .authorType)) ?? "staff"
        body = (try? c.decode(String.self, forKey: .body)) ?? ""
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

/// GET /api/assistant/office/thread → {task, comments:[…], events:[…]}.
struct PortalOfficeThread: Decodable {
    let comments: [PortalOfficeThreadMsg]
    private enum Keys: String, CodingKey { case comments }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        comments = (try? c.decode([PortalOfficeThreadMsg].self, forKey: .comments)) ?? []
    }
}

/// One group-chat message — ChatMessage on the server. `status == "pending"` rows
/// are owner-only agent drafts; the native staff screen never receives them.
struct PortalOfficeChatMsg: Decodable, Identifiable, Equatable {
    let id: String
    let authorType: String
    let authorName: String
    let authorImageUrl: String?
    let body: String
    let imageURLs: [String]          // real attachment URLs → rendered as image bubbles
    let status: String?              // "posted" | "pending" (owner-only draft) | "dismissed"
    let isAgentReply: Bool
    let createdAt: String?
    var attachmentCount: Int { imageURLs.count }

    static func == (a: PortalOfficeChatMsg, b: PortalOfficeChatMsg) -> Bool {
        a.id == b.id && a.status == b.status && a.body == b.body
    }

    private enum Keys: String, CodingKey {
        case id, authorType, authorName, authorImageUrl, body, attachments, status, isAgentReply, createdAt
    }
    private struct Attachment: Decodable { let url: String?; let type: String? }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        authorType = (try? c.decode(String.self, forKey: .authorType)) ?? "staff"
        authorName = (try? c.decodeIfPresent(String.self, forKey: .authorName)) ?? "—"
        authorImageUrl = try? c.decodeIfPresent(String.self, forKey: .authorImageUrl)
        body = (try? c.decode(String.self, forKey: .body)) ?? ""
        let atts = (try? c.decodeIfPresent([Attachment].self, forKey: .attachments)) ?? []
        imageURLs = (atts ?? []).compactMap { $0.url }.filter { $0.hasPrefix("http") }
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        isAgentReply = (try? c.decodeIfPresent(Bool.self, forKey: .isAgentReply)) ?? false
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

struct PortalOfficeChatFeed: Decodable {
    let messages: [PortalOfficeChatMsg]
    private enum Keys: String, CodingKey { case messages }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        messages = (try? c.decode([PortalOfficeChatMsg].self, forKey: .messages)) ?? []
    }
}

/// staff-action responses only carry {ok, status, …}; we just need the success flag.
private struct PortalOfficeOk: Decodable {}

// MARK: - Owner Hub models (GET /api/assistant/office/hub → getOwnerHubData JSON)

/// Envelope: `self` tells the app which role the logged-in user is, so the SAME Office
/// tab shows the BOSS dashboard to the owner and the staff app to employees.
struct PortalHubEnvelope: Decodable {
    let selfRole: String       // "owner" | "staff" | "none"
    let hub: PortalOwnerHub?
    let staff: PortalStaffOffice?     // full staff-office payload (getStaffOfficeData)
    let motivation: PortalMotivation? // shared daily motivation quote
    private enum Keys: String, CodingKey { case ok, hub, staff, motivation; case selfRole = "self" }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        selfRole = (try? c.decodeIfPresent(String.self, forKey: .selfRole)) ?? "none"
        hub = try? c.decodeIfPresent(PortalOwnerHub.self, forKey: .hub)
        staff = try? c.decodeIfPresent(PortalStaffOffice.self, forKey: .staff)
        motivation = try? c.decodeIfPresent(PortalMotivation.self, forKey: .motivation)
    }
}

struct PortalOwnerHub: Decodable {
    var kpis: Kpis
    var pendingApproval: [PortalHubTask]
    var activeTasks: [PortalHubTask]
    var doneTodayTasks: [PortalHubTask]
    var selfInitiated: [PortalHubTask]
    var overdueUpdates: [PortalOverdue]
    var activity: [PortalActivity]
    var award: PortalAward?
    var awardStats: PortalAwardStats?
    var team: [PortalTeamMember]
    var leaderboard: [PortalLeader]
    var performance: [PortalPerf]
    var proposals: [PortalProposal]

    struct Kpis: Decodable {
        var pending = 0, active = 0, overdue = 0, doneToday = 0, online = 0, staffTotal = 0
        init() {}
        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: K.self)
            func i(_ k: K) -> Int { (try? c.decodeIfPresent(Int.self, forKey: k)) ?? 0 }
            pending = i(.pending); active = i(.active); overdue = i(.overdue)
            doneToday = i(.doneToday); online = i(.online); staffTotal = i(.staffTotal)
        }
        enum K: String, CodingKey { case pending, active, overdue, doneToday, online, staffTotal }
    }

    private enum Keys: String, CodingKey {
        case kpis, pendingApproval, activeTasks, doneTodayTasks, selfInitiated
        case overdueUpdates, activity, award, awardStats, team, leaderboard, performance, proposals
    }
    // TEMP-PROOF sample (prod lacks /office/hub) so the boss dashboard can be shown. Remove before ship.
    static let sampleJSON = """
    {"kpis":{"pending":2,"active":3,"overdue":1,"doneToday":6,"online":2,"staffTotal":3},
     "pendingApproval":[
       {"id":"t1","title":"১৩৩ কালেকশনের নতুন ছবি","type":"ফটোগ্রাফি","status":"awaiting_owner","verificationStatus":"proof_submitted","staffId":"s1","staffName":"মোহাম্মদ ইয়াফি","needsOwner":true,"redoCount":0,"source":"assigned","createdAt":"2026-07-07T04:00:00Z","proofData":{"imageUrls":["https://picsum.photos/seed/alma133a/700","https://picsum.photos/seed/alma133b/700","https://picsum.photos/seed/alma133c/700"]}},
       {"id":"t2","title":"ফেসবুক পোস্টের ক্যাপশন","type":"কনটেন্ট","status":"awaiting_owner","verificationStatus":"auto_verified","staffId":"s2","staffName":"সাদিয়া","needsOwner":false,"redoCount":1,"source":"assigned","createdAt":"2026-07-07T03:00:00Z","proofData":{"imageUrl":"https://picsum.photos/seed/almafbpost/700"}}],
     "activeTasks":[
       {"id":"t3","title":"দুপুরের ডেলিভারি হ্যান্ডওভার","type":"সেলস","status":"active","verificationStatus":"in_progress","staffId":"s1","staffName":"মোহাম্মদ ইয়াফি","needsOwner":false,"redoCount":0,"source":"assigned","createdAt":"2026-07-07T02:00:00Z","dueAt":"2026-07-07T12:00:00Z"},
       {"id":"a1","title":"ফেসবুক পোস্টের ক্যাপশন লেখা","type":"কনটেন্ট","status":"active","verificationStatus":"in_progress","staffId":"s2","staffName":"সাদিয়া","needsOwner":false,"redoCount":0,"source":"assigned","createdAt":"2026-07-07T01:30:00Z"},
       {"id":"a2","title":"২টা রিটার্ন অর্ডার ফলোআপ","type":"সাপোর্ট","status":"active","verificationStatus":"in_progress","staffId":"s2","staffName":"সাদিয়া","needsOwner":false,"redoCount":0,"source":"assigned","createdAt":"2026-07-07T01:00:00Z"}],
     "doneTodayTasks":[
       {"id":"d1","title":"১৩৩ কালেকশনের ছবি তোলা","type":"ফটোগ্রাফি","status":"done","verificationStatus":"owner_approved","staffId":"s1","staffName":"মোহাম্মদ ইয়াফি","needsOwner":false,"redoCount":0,"source":"assigned","createdAt":"2026-07-07T05:00:00Z"},
       {"id":"d2","title":"সকালের ৩টা অর্ডার প্যাকিং","type":"অপস","status":"done","verificationStatus":"owner_approved","staffId":"s1","staffName":"মোহাম্মদ ইয়াফি","needsOwner":false,"redoCount":0,"source":"assigned","createdAt":"2026-07-07T05:10:00Z"},
       {"id":"d3","title":"নতুন কাস্টমার মেসেজের রিপ্লাই","type":"সাপোর্ট","status":"done","verificationStatus":"owner_approved","staffId":"s2","staffName":"সাদিয়া","needsOwner":false,"redoCount":0,"source":"assigned","createdAt":"2026-07-07T05:20:00Z"}],
     "selfInitiated":[{"id":"t5","title":"দোকান গুছিয়ে রেখেছি","type":"অন্যান্য","status":"proposed","verificationStatus":"proposed","staffId":"s3","staffName":"রফিক","needsOwner":false,"redoCount":0,"source":"staff_initiated","createdAt":"2026-07-07T05:00:00Z"}],
     "overdueUpdates":[{"id":"t6","title":"কুরিয়ার বুকিং","staffId":"s2","staffName":"সাদিয়া","phone":"01712345678","requestedAt":"2026-07-07T05:30:00Z","note":"আপডেট দিন — কয়টা বুক হলো?","secondsLeft":-120,"escalated":false}],
     "activity":[
       {"id":"ac1","taskId":"d1","kind":"completed","summary":"মোহাম্মদ ইয়াফি একটি কাজ সম্পন্ন করেছেন","actorType":"staff","createdAt":"2026-07-07T05:40:00Z"},
       {"id":"ac2","taskId":"t5","kind":"self_initiated","summary":"রফিক নিজ উদ্যোগে কাজ প্রস্তাব করেছেন","actorType":"staff","createdAt":"2026-07-07T05:20:00Z"}],
     "award":{"staffId":"s1","staffName":"মোহাম্মদ ইয়াফি","imageUrl":null,"score":92,"auto":true,"pinnedByOwner":false,"note":null,"weekStart":"2026-07-05"},
     "awardStats":{"done":18,"approvalRate":94,"avgQc":88,"selfInitiated":3},
     "team":[
       {"staffId":"s1","name":"মোহাম্মদ ইয়াফি","initial":"M","imageUrl":null,"status":"on","sub":"অফিসে · চেক-ইন ৯:০৫ AM","doneToday":4,"totalToday":6,"checkedIn":true,"checkInLabel":"৯:০৫ AM"},
       {"staffId":"s2","name":"সাদিয়া","initial":"S","imageUrl":null,"status":"lunch","sub":"লাঞ্চে · ২৪ মিনিট বাকি","doneToday":2,"totalToday":5,"checkedIn":true,"checkInLabel":"৯:১৫ AM"},
       {"staffId":"s3","name":"রফিক","initial":"R","imageUrl":null,"status":"off","sub":"এখনো চেক-ইন করেননি","doneToday":0,"totalToday":3,"checkedIn":false,"checkInLabel":null}],
     "leaderboard":[
       {"staffId":"s1","name":"মোহাম্মদ ইয়াফি","initial":"M","imageUrl":null,"score":92,"pct":100},
       {"staffId":"s2","name":"সাদিয়া","initial":"S","imageUrl":null,"score":74,"pct":80},
       {"staffId":"s3","name":"রফিক","initial":"R","imageUrl":null,"score":51,"pct":55}],
     "performance":[
       {"staffId":"s1","staffName":"মোহাম্মদ ইয়াফি","assigned":22,"done":18,"onTime":16,"late":2,"onTimeRate":89,"redo":1,"escalated":2,"score":92},
       {"staffId":"s2","staffName":"সাদিয়া","assigned":15,"done":11,"onTime":8,"late":3,"onTimeRate":73,"redo":3,"escalated":1,"score":74}],
     "proposals":[{"id":"p1","staffId":"s2","staffName":"সাদিয়া","taskTitle":"কুরিয়ার বুকিং","kind":"penalty","amount":100,"reason":"বারবার আপডেট চাওয়ার পরও দেরি","createdAt":"2026-07-07T05:35:00Z"}]}
    """

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: Keys.self)
        kpis = (try? c.decode(Kpis.self, forKey: .kpis)) ?? Kpis()
        pendingApproval = (try? c.decode([PortalHubTask].self, forKey: .pendingApproval)) ?? []
        activeTasks = (try? c.decode([PortalHubTask].self, forKey: .activeTasks)) ?? []
        doneTodayTasks = (try? c.decode([PortalHubTask].self, forKey: .doneTodayTasks)) ?? []
        selfInitiated = (try? c.decode([PortalHubTask].self, forKey: .selfInitiated)) ?? []
        overdueUpdates = (try? c.decode([PortalOverdue].self, forKey: .overdueUpdates)) ?? []
        activity = (try? c.decode([PortalActivity].self, forKey: .activity)) ?? []
        award = try? c.decodeIfPresent(PortalAward.self, forKey: .award)
        awardStats = try? c.decodeIfPresent(PortalAwardStats.self, forKey: .awardStats)
        team = (try? c.decode([PortalTeamMember].self, forKey: .team)) ?? []
        leaderboard = (try? c.decode([PortalLeader].self, forKey: .leaderboard)) ?? []
        performance = (try? c.decode([PortalPerf].self, forKey: .performance)) ?? []
        proposals = (try? c.decode([PortalProposal].self, forKey: .proposals)) ?? []
    }
}

struct PortalHubTask: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let detail: String?
    let type: String
    let status: String
    let verificationStatus: String
    let reviewerNote: String?
    let redoCount: Int
    let staffId: String
    let staffName: String
    let createdAt: String?
    let dueAt: String?
    let needsOwner: Bool
    let alwaysEscalate: Bool
    let source: String
    let imageUrls: [String]     // pulled out of proofData for native display

    static func == (a: PortalHubTask, b: PortalHubTask) -> Bool { a.id == b.id && a.status == b.status && a.verificationStatus == b.verificationStatus }

    private enum Keys: String, CodingKey {
        case id, title, detail, type, status, verificationStatus, reviewerNote
        case redoCount, staffId, staffName, createdAt, dueAt, needsOwner, alwaysEscalate, source, proofData
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        title = (try? c.decode(String.self, forKey: .title)) ?? "—"
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
        type = (try? c.decodeIfPresent(String.self, forKey: .type)) ?? ""
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? ""
        verificationStatus = (try? c.decodeIfPresent(String.self, forKey: .verificationStatus)) ?? ""
        reviewerNote = try? c.decodeIfPresent(String.self, forKey: .reviewerNote)
        redoCount = (try? c.decodeIfPresent(Int.self, forKey: .redoCount)) ?? 0
        staffId = (try? c.decodeIfPresent(String.self, forKey: .staffId)) ?? ""
        staffName = (try? c.decodeIfPresent(String.self, forKey: .staffName)) ?? "অজানা"
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        dueAt = try? c.decodeIfPresent(String.self, forKey: .dueAt)
        needsOwner = (try? c.decodeIfPresent(Bool.self, forKey: .needsOwner)) ?? false
        alwaysEscalate = (try? c.decodeIfPresent(Bool.self, forKey: .alwaysEscalate)) ?? false
        source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? ""
        imageUrls = PortalProof.imageURLs(from: try? c.decodeIfPresent(PortalJSON.self, forKey: .proofData))
    }
}

struct PortalOverdue: Decodable, Identifiable, Equatable {
    let id: String, title: String, staffId: String, staffName: String
    let phone: String?, requestedAt: String?, note: String?
    let secondsLeft: Int, escalated: Bool
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? "—"
        staffId = (try? c.decodeIfPresent(String.self, forKey: .staffId)) ?? ""
        staffName = (try? c.decodeIfPresent(String.self, forKey: .staffName)) ?? "—"
        phone = try? c.decodeIfPresent(String.self, forKey: .phone)
        requestedAt = try? c.decodeIfPresent(String.self, forKey: .requestedAt)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        secondsLeft = (try? c.decodeIfPresent(Int.self, forKey: .secondsLeft)) ?? 0
        escalated = (try? c.decodeIfPresent(Bool.self, forKey: .escalated)) ?? false
    }
    enum K: String, CodingKey { case id, title, staffId, staffName, phone, requestedAt, note, secondsLeft, escalated }
}

struct PortalActivity: Decodable, Identifiable {
    let id: String, taskId: String, kind: String, summary: String, actorType: String, createdAt: String?
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        taskId = (try? c.decodeIfPresent(String.self, forKey: .taskId)) ?? ""
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? ""
        summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? ""
        actorType = (try? c.decodeIfPresent(String.self, forKey: .actorType)) ?? ""
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
    enum K: String, CodingKey { case id, taskId, kind, summary, actorType, createdAt }
}

struct PortalAward: Decodable {
    let staffId: String, staffName: String, imageUrl: String?, score: Int
    let auto: Bool, pinnedByOwner: Bool, note: String?, weekStart: String?
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        staffId = (try? c.decodeIfPresent(String.self, forKey: .staffId)) ?? ""
        staffName = (try? c.decodeIfPresent(String.self, forKey: .staffName)) ?? "—"
        imageUrl = try? c.decodeIfPresent(String.self, forKey: .imageUrl)
        score = (try? c.decodeIfPresent(Int.self, forKey: .score)) ?? 0
        auto = (try? c.decodeIfPresent(Bool.self, forKey: .auto)) ?? true
        pinnedByOwner = (try? c.decodeIfPresent(Bool.self, forKey: .pinnedByOwner)) ?? false
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        weekStart = try? c.decodeIfPresent(String.self, forKey: .weekStart)
    }
    enum K: String, CodingKey { case staffId, staffName, imageUrl, score, auto, pinnedByOwner, note, weekStart }
}

struct PortalAwardStats: Decodable {
    let done: Int, approvalRate: Int?, avgQc: Int?, selfInitiated: Int
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        done = (try? c.decodeIfPresent(Int.self, forKey: .done)) ?? 0
        approvalRate = try? c.decodeIfPresent(Int.self, forKey: .approvalRate)
        avgQc = try? c.decodeIfPresent(Int.self, forKey: .avgQc)
        selfInitiated = (try? c.decodeIfPresent(Int.self, forKey: .selfInitiated)) ?? 0
    }
    enum K: String, CodingKey { case done, approvalRate, avgQc, selfInitiated }
}

struct PortalTeamMember: Decodable, Identifiable {
    let staffId: String, name: String, initial: String, imageUrl: String?
    let status: String, sub: String, doneToday: Int, totalToday: Int
    let checkedIn: Bool, checkInLabel: String?
    var id: String { staffId }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        staffId = (try? c.decode(String.self, forKey: .staffId)) ?? UUID().uuidString
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "—"
        initial = (try? c.decodeIfPresent(String.self, forKey: .initial)) ?? "?"
        imageUrl = try? c.decodeIfPresent(String.self, forKey: .imageUrl)
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "off"
        sub = (try? c.decodeIfPresent(String.self, forKey: .sub)) ?? ""
        doneToday = (try? c.decodeIfPresent(Int.self, forKey: .doneToday)) ?? 0
        totalToday = (try? c.decodeIfPresent(Int.self, forKey: .totalToday)) ?? 0
        checkedIn = (try? c.decodeIfPresent(Bool.self, forKey: .checkedIn)) ?? false
        checkInLabel = try? c.decodeIfPresent(String.self, forKey: .checkInLabel)
    }
    enum K: String, CodingKey { case staffId, name, initial, imageUrl, status, sub, doneToday, totalToday, checkedIn, checkInLabel }
}

struct PortalLeader: Decodable, Identifiable {
    let staffId: String, name: String, initial: String, imageUrl: String?, score: Int, pct: Int
    var id: String { staffId }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        staffId = (try? c.decode(String.self, forKey: .staffId)) ?? UUID().uuidString
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "—"
        initial = (try? c.decodeIfPresent(String.self, forKey: .initial)) ?? "?"
        imageUrl = try? c.decodeIfPresent(String.self, forKey: .imageUrl)
        score = (try? c.decodeIfPresent(Int.self, forKey: .score)) ?? 0
        pct = (try? c.decodeIfPresent(Int.self, forKey: .pct)) ?? 0
    }
    enum K: String, CodingKey { case staffId, name, initial, imageUrl, score, pct }
}

struct PortalPerf: Decodable, Identifiable {
    let staffId: String, staffName: String
    let assigned: Int, done: Int, onTime: Int, late: Int
    let onTimeRate: Int?, redo: Int, escalated: Int, score: Int
    var id: String { staffId }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        staffId = (try? c.decode(String.self, forKey: .staffId)) ?? UUID().uuidString
        staffName = (try? c.decodeIfPresent(String.self, forKey: .staffName)) ?? "—"
        func i(_ k: K) -> Int { (try? c.decodeIfPresent(Int.self, forKey: k)) ?? 0 }
        assigned = i(.assigned); done = i(.done); onTime = i(.onTime); late = i(.late)
        onTimeRate = try? c.decodeIfPresent(Int.self, forKey: .onTimeRate)
        redo = i(.redo); escalated = i(.escalated); score = i(.score)
    }
    enum K: String, CodingKey { case staffId, staffName, assigned, done, onTime, late, onTimeRate, redo, escalated, score }
}

struct PortalProposal: Decodable, Identifiable {
    let id: String, staffId: String, staffName: String
    let taskTitle: String?, kind: String, amount: Int?, reason: String, createdAt: String?
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        staffId = (try? c.decodeIfPresent(String.self, forKey: .staffId)) ?? ""
        staffName = (try? c.decodeIfPresent(String.self, forKey: .staffName)) ?? "—"
        taskTitle = try? c.decodeIfPresent(String.self, forKey: .taskTitle)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? ""
        amount = try? c.decodeIfPresent(Int.self, forKey: .amount)
        reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? ""
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
    enum K: String, CodingKey { case id, staffId, staffName, taskTitle, kind, amount, reason, createdAt }
}

/// Minimal permissive JSON value — just enough to walk proofData for image URLs.
indirect enum PortalJSON: Decodable {
    case str(String), num(Double), bool(Bool), arr([PortalJSON]), obj([String: PortalJSON]), null
    init(from d: Decoder) throws {
        let c = try d.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .num(n) }
        else if let s = try? c.decode(String.self) { self = .str(s) }
        else if let a = try? c.decode([PortalJSON].self) { self = .arr(a) }
        else if let o = try? c.decode([String: PortalJSON].self) { self = .obj(o) }
        else { self = .null }
    }
    var stringValue: String? { if case .str(let s) = self { return s }; return nil }
}

enum PortalProof {
    /// Pull image URLs out of proofData: imageUrls[] first, then single imageUrl/image/photo/url.
    static func imageURLs(from json: PortalJSON?) -> [String] {
        guard case .obj(let o)? = json else { return [] }
        var urls: [String] = []
        if case .arr(let a)? = o["imageUrls"] { urls += a.compactMap { $0.stringValue } }
        for k in ["imageUrl", "image", "photo", "url"] {
            if let s = o[k]?.stringValue, !s.isEmpty { urls.append(s) }
        }
        // De-dupe, keep https only.
        var seen = Set<String>()
        return urls.filter { $0.hasPrefix("http") && seen.insert($0).inserted }
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class PortalOfficeVM {
    var tasks: [PortalOfficeTask] = []
    var unread = 0
    var notices: [PortalOfficeNotice] = []
    var loading = false
    var error: String? = nil
    var notice: String? = nil            // one-line info strip (lunch / action results)
    var authExpired = false

    // Lunch — web LunchControl parity (45-min allowance, live countdown)
    var lunchActive = false
    var lunchStartedAt: Date? = nil
    var lunchBusy = false
    var markingRead = false

    // Task detail thread (web StaffDetail parity)
    var thread: [PortalOfficeThreadMsg] = []
    var threadLoading = false
    var actionBusyTaskId: String? = nil  // per-task spinner (done / comment / update)

    // Self-initiated proposal (web SelfInitiated parity)
    var creatingSelf = false

    // Group chat (web GroupChat parity)
    var chat: [PortalOfficeChatMsg] = []
    var chatLoading = false
    var chatSending = false
    var explainingTaskId: String? = nil

    // ── Owner Hub (GET /api/assistant/office/hub) — the BOSS dashboard ──
    var selfRole = ""                // "owner" | "staff" | "none" | "" (unresolved)
    var roleResolved = false
    var hub: PortalOwnerHub? = nil
    var ownerBusyId: String? = nil    // per-task owner action spinner
    var proposalBusyId: String? = nil
    var isSampleData = false          // true when the hub route is absent and we fell back to demo data

    // ── Staff office (GET /api/assistant/office/hub → getStaffOfficeData) — the rich
    //    staff app (performer hero, motivation, check-in, task cards, proof upload). ──
    var staffData: PortalStaffOffice? = nil
    var motivation: PortalMotivation? = nil

    /// First call decides the whole screen: owner → boss hub, staff → staff app.
    func loadHub() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let env: PortalHubEnvelope = try await AlmaAPI.shared.get("/api/assistant/office/hub")
            selfRole = env.selfRole
            hub = env.hub
            isSampleData = false
            roleResolved = true
            authExpired = false
            if env.selfRole == "staff" {
                staffData = env.staff
                motivation = env.motivation
                if let sd = env.staff { syncLunch(from: sd) }   // resume the 45-min timer
                await load()                 // notices + the chat "আজকের কাজ" picker (my-tasks)
            } else if env.selfRole == "owner" {
                await loadNotifsOnly()       // owner's bell (my-tasks is staff-only, 403s)
            }
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true; roleResolved = true
        } catch {
            if Self.isCancellation(error) { return }
            // TEMP-PROOF: prod lacks /office/hub — show the redesigned boss dashboard with sample data.
            if let s = try? JSONDecoder().decode(PortalOwnerHub.self, from: Data(PortalOwnerHub.sampleJSON.utf8)) {
                selfRole = "owner"; hub = s; isSampleData = true; roleResolved = true; return
            }
            self.error = error.localizedDescription
            roleResolved = true
        }
    }

    /// Owner task/proposal action → POST /api/assistant/office/action, then refresh the hub.
    struct OwnerAct: Encodable {
        let action: String
        var taskId: String? = nil
        var proposalId: String? = nil
        var decision: String? = nil
        var note: String? = nil
        var body: String? = nil
        var on: Bool? = nil
        var dueAt: String? = nil
    }

    @discardableResult
    func ownerAct(_ body: OwnerAct, taskId: String? = nil, proposalId: String? = nil) async -> Bool {
        if let taskId { ownerBusyId = taskId }
        if let proposalId { proposalBusyId = proposalId }
        defer { ownerBusyId = nil; proposalBusyId = nil }
        do {
            let _: PortalOfficeOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/action", body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await loadHub()
            return true
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
            return false
        }
    }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            async let t: PortalOfficeTasksResponse = AlmaAPI.shared.get("/api/assistant/office/my-tasks")
            async let n: PortalOfficeNotifFeed = AlmaAPI.shared.get("/api/assistant/office/notifications")
            let (taskResp, feed) = try await (t, n)
            tasks = taskResp.tasks
            unread = feed.unread
            notices = feed.items
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

    /// Start/end lunch — the exact toggle the web LunchControl posts. Start is
    /// idempotent server-side: if a lunch is already open (e.g. started on the web),
    /// it returns the ORIGINAL startedAt, so the native timer resumes correctly.
    func lunchToggle() async {
        guard !lunchBusy else { return }
        lunchBusy = true
        notice = nil
        defer { lunchBusy = false }
        do {
            if lunchActive {
                let r: PortalOfficeLunchResponse = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/office/lunch", body: ["action": "end"])
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                withAnimation(.snappy) {
                    lunchActive = false
                    lunchStartedAt = nil
                }
                if let d = r.durationMin {
                    notice = "🍽️ লাঞ্চ শেষ — \(PortalOfficeFormat.bn(d)) মিনিট"
                }
            } else {
                let r: PortalOfficeLunchResponse = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/office/lunch", body: ["action": "start"])
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                withAnimation(.snappy) {
                    lunchStartedAt = PortalOfficeFormat.parse(r.startedAt ?? "") ?? Date()
                    lunchActive = true
                }
            }
        } catch AlmaAPIError.notAuthenticated {
            // The GET loads succeed for ANY logged-in user, so landing here while the
            // rest of the screen works means the route's 403 `not_staff` branch (AlmaAPI
            // folds 403 into notAuthenticated) — the owner has no lunch row to open.
            if authExpired {
                // genuinely logged out — the auth card is already showing
            } else {
                notice = "লাঞ্চ টাইমার শুধু স্টাফ অ্যাকাউন্টের জন্য।"
            }
        } catch AlmaAPIError.http(let status, _) where status == 404 {
            // `no_open_lunch` — our local state was stale (ended elsewhere); reset quietly.
            withAnimation(.snappy) {
                lunchActive = false
                lunchStartedAt = nil
            }
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            if Self.isCancellation(error) { return }
            self.error = error.localizedDescription
        }
    }

    /// Owner's notifications (bell) — the owner's my-tasks is staff-only, so this is
    /// loaded on its own alongside the hub.
    func loadNotifsOnly() async {
        do {
            let feed: PortalOfficeNotifFeed = try await AlmaAPI.shared.get("/api/assistant/office/notifications")
            unread = feed.unread
            notices = feed.items
        } catch { /* best-effort */ }
    }

    /// Web bell's "সব পড়া হয়েছে" — POST {} marks everything in scope read.
    func markAllRead() async {
        guard !markingRead else { return }
        markingRead = true
        defer { markingRead = false }
        do {
            let _: PortalOfficeOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/notifications", body: [String: String]())
            withAnimation(.snappy) {
                for i in notices.indices { notices[i].read = true }
                unread = 0
            }
        } catch {
            // best-effort, like the web bell
        }
    }

    /// Tap one notice → mark just that one read (web onItem parity).
    func markRead(_ n: PortalOfficeNotice) async {
        guard !n.read else { return }
        do {
            let _: PortalOfficeOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/notifications", body: ["id": n.id])
            withAnimation(.snappy) {
                if let i = notices.firstIndex(where: { $0.id == n.id }) { notices[i].read = true }
                unread = max(0, unread - 1)
            }
        } catch {
            // best-effort
        }
    }

    // ── Task detail thread (web StaffDetail — GET thread) ──

    func loadThread(_ taskId: String) async {
        threadLoading = true
        thread = []
        defer { threadLoading = false }
        do {
            let t: PortalOfficeThread = try await AlmaAPI.shared.get(
                "/api/assistant/office/thread", query: ["taskId": taskId])
            thread = t.comments
        } catch {
            if Self.isCancellation(error) { return }
            // leave the thread empty; the sheet shows "এখনো কোনো মন্তব্য নেই"
        }
    }

    /// One staff-action POST — mark done / text comment / update answer.
    /// `action` is 'done' | 'comment' | 'update'. Body carried in the web's `body` field.
    /// Returns success so the caller can clear its composer.
    @discardableResult
    func taskAction(_ taskId: String, action: String, body: String = "") async -> Bool {
        guard actionBusyTaskId == nil else { return false }
        actionBusyTaskId = taskId
        defer { actionBusyTaskId = nil }
        do {
            var payload: [String: String] = ["action": action, "taskId": taskId]
            if !body.isEmpty { payload["body"] = body }
            let _: PortalOfficeOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/staff-action", body: payload)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            switch action {
            case "done":
                notice = "✅ কাজটি সম্পন্ন হিসেবে পাঠানো হয়েছে — Boss অনুমোদন দিলে চূড়ান্ত হবে।"
                await load()   // done drops it from the open list
            case "comment": notice = "💬 কমেন্ট পাঠানো হয়েছে।"
            case "update":  notice = "📤 আপডেট পাঠানো হয়েছে।"
            default: break
            }
            await loadThread(taskId)   // reflect the new comment in the open sheet
            return true
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
            return false
        }
    }

    /// Web SelfInitiated — propose an extra task the staff did on their own initiative.
    @discardableResult
    func createSelfInitiated(title: String, detail: String) async -> Bool {
        guard !creatingSelf else { return false }
        creatingSelf = true
        defer { creatingSelf = false }
        do {
            var payload: [String: String] = ["action": "self_create", "title": title]
            if !detail.isEmpty { payload["detail"] = detail }
            let _: PortalOfficeOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/staff-action", body: payload)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "✨ নিজ উদ্যোগের কাজ পাঠানো হয়েছে — Boss অনুমোদন দিলে পারফরম্যান্সে +পয়েন্ট।"
            return true
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
            return false
        }
    }

    // ── Group chat (web GroupChat — GET/POST chat, POST chat/explain) ──

    func loadChat() async {
        chatLoading = true
        defer { chatLoading = false }
        do {
            let feed: PortalOfficeChatFeed = try await AlmaAPI.shared.get("/api/assistant/office/chat")
            // Drop dismissed always; keep 'pending' agent drafts only for the owner (who
            // approves/dismisses them). The server already scopes pending to the owner.
            chat = feed.messages.filter { $0.status != "dismissed" && ($0.status != "pending" || selfRole == "owner") }
        } catch {
            if Self.isCancellation(error) { return }
            // best-effort; keep whatever we had
        }
    }

    /// Send a TEXT message to the group. Images stay web (needs the file picker).
    @discardableResult
    func sendChat(_ text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !chatSending else { return false }
        chatSending = true
        defer { chatSending = false }
        do {
            // Web posts { body, attachments: [] }; native sends text only.
            struct Payload: Encodable { let body: String; let attachments: [String] }
            let _: PortalOfficeOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/chat", body: Payload(body: trimmed, attachments: []))
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await loadChat()
            return true
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return false
        }
    }

    /// Web "বুঝিয়ে দিন" — staff asks the agent to explain one task in the group.
    func explainTask(_ taskId: String) async {
        guard explainingTaskId == nil else { return }
        explainingTaskId = taskId
        defer { explainingTaskId = nil }
        do {
            let _: PortalOfficeOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/chat/explain", body: ["taskId": taskId])
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await loadChat()
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    // ── Owner-only: approve / dismiss the agent's draft reply in the group ──
    var chatDecidingId: String? = nil
    func chatAgentDecide(_ id: String, approve: Bool, editedBody: String? = nil) async {
        guard chatDecidingId == nil else { return }
        chatDecidingId = id
        defer { chatDecidingId = nil }
        struct Body: Encodable { let action: String; let id: String; let body: String? }
        do {
            let _: PortalOfficeOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/chat/agent",
                body: Body(action: approve ? "approve" : "dismiss", id: id,
                           body: approve ? (editedBody?.isEmpty == false ? editedBody : nil) : nil))
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await loadChat()
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    /// Send a group message with optional images — uploads each image first (native,
    /// no web escape) then posts { body, attachments:[{type:'image',url}] }.
    private struct ChatAttachment: Encodable { let type = "image"; let url: String }
    private struct UploadResp: Decodable { let url: String? }
    @discardableResult
    func sendChatFull(_ text: String, images: [Data]) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!trimmed.isEmpty || !images.isEmpty), !chatSending else { return false }
        chatSending = true
        defer { chatSending = false }
        do {
            var atts: [ChatAttachment] = []
            for (i, data) in images.enumerated() {
                let r: UploadResp = try await AlmaAPI.shared.uploadMultipart(
                    "/api/assistant/office/upload", fileField: "file",
                    filename: "chat-\(i).jpg", mime: "image/jpeg", data: data)
                if let url = r.url { atts.append(ChatAttachment(url: url)) }
            }
            struct Payload: Encodable { let body: String; let attachments: [ChatAttachment] }
            let _: PortalOfficeOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/chat", body: Payload(body: trimmed, attachments: atts))
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await loadChat()
            return true
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
            return false
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct PortalOfficeScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = PortalOfficeVM()
    @State private var detailTask: PortalOfficeTask? = nil
    @State private var detailStaffTask: PortalStaffTask? = nil   // rich staff-task detail
    @State private var showSelfCreate = false
    @State private var showChat = false
    @State private var ownerTask: PortalHubTask? = nil
    @State private var showHistory = false
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if !vm.roleResolved {
                    loadingRows
                } else if vm.authExpired {
                    header; authCard
                } else if vm.selfRole == "owner" {
                    PortalOwnerHubView(vm: vm, openWeb: openWeb,
                                       showChat: $showChat, ownerTask: $ownerTask, showHistory: $showHistory)
                } else if let sd = vm.staffData {
                    PortalStaffAppView(vm: vm, staff: sd, openWeb: openWeb,
                                       onOpenTask: { detailStaffTask = $0 },
                                       onSelfCreate: { showSelfCreate = true },
                                       onOpenChat: { showChat = true })
                } else {
                    staffContent
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(PortalOfficeAurora())
        .claudeTopFade()
        .dismissKeyboardOnTap()
        .refreshable { await vm.loadHub() }
        .task { if !vm.roleResolved { await vm.loadHub() } }
        .sheet(item: $detailTask) { t in
            PortalTaskDetailSheet(task: t, vm: vm, openWeb: openWeb)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $detailStaffTask) { t in
            PortalStaffTaskSheet(task: t, vm: vm)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $ownerTask) { t in
            PortalOwnerTaskSheet(task: t, vm: vm, openWeb: openWeb)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showSelfCreate) {
            PortalSelfInitiatedSheet(vm: vm)
                .presentationDetents([.height(360)])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showChat) {
            PortalGroupChatSheet(vm: vm, isOwner: vm.selfRole == "owner", openWeb: openWeb)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showHistory) {
            PortalOfficeHistorySheet(openWeb: openWeb)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    /// The staff app (unchanged) — shown when the logged-in user is an employee.
    @ViewBuilder private var staffContent: some View {
        header
        if let err = vm.error { noticeCard(err, tone: .error) }
        if let ok = vm.notice { noticeCard(ok, tone: .info) }
        lunchCard
        if vm.loading && vm.tasks.isEmpty && vm.notices.isEmpty {
            loadingRows
        } else {
            tasksCard
            chatCard
            noticesCard
        }
    }

    // ── Header (web .phead parity: kicker + title + sub + Bangla date) ──

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("আমার অফিস · মোবাইল অ্যাপ")
                .font(.caption2.weight(.bold)).textCase(.uppercase)
                .foregroundStyle(PortalOfficePalette.accentText(colorScheme))
            Text("👷 আমার কাজ")
                .font(.title3.weight(.bold))
            Text("কাজ দেখুন, রেজাল্ট জমা দিন, আর Boss-এর ফিডব্যাক সাথে সাথে পান।")
                .font(.caption).foregroundStyle(.secondary)
            Text(PortalOfficeFormat.headerDate())
                .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }

    // ── Lunch card (web LunchControl — 45-min allowance, live countdown) ──

    private static let lunchLimitSec = 45 * 60

    private var lunchCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                officeBadge("fork.knife")
                VStack(alignment: .leading, spacing: 1) {
                    Text("লাঞ্চ").font(.footnote.weight(.semibold))
                    Text("৪৫ মিনিটের বিরতি").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
            }
            if vm.lunchActive, let started = vm.lunchStartedAt {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let elapsed = Int(context.date.timeIntervalSince(started))
                    let remaining = Self.lunchLimitSec - elapsed
                    let over = remaining <= 0
                    let mm = abs(remaining) / 60
                    let ss = abs(remaining) % 60
                    let clock = "\(PortalOfficeFormat.bn(mm)):\(PortalOfficeFormat.bn(String(format: "%02d", ss)))"
                    HStack(spacing: 10) {
                        // Web strings verbatim: "🍽️ লাঞ্চ · X:XX বাকি" / "⚠️ X:XX বেশি"
                        Text(over ? "🍽️ লাঞ্চ · ⚠️ \(clock) বেশি" : "🍽️ লাঞ্চ · \(clock) বাকি")
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .foregroundStyle(over ? PortalOfficePalette.red500 : PortalOfficePalette.amber600)
                        Spacer()
                        if vm.lunchBusy {
                            ProgressView().controlSize(.small)
                        } else {
                            chipButton("ফিরে এসেছি", icon: "checkmark",
                                       tint: PortalOfficePalette.emerald600,
                                       text: PortalOfficePalette.emerald600) {
                                Task { await vm.lunchToggle() }
                            }
                            .frame(width: 140)
                        }
                    }
                }
            } else if vm.lunchBusy {
                ProgressView().controlSize(.small)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            } else {
                chipButton("🍽️ লাঞ্চে যাচ্ছি", icon: nil,
                           tint: PortalOfficePalette.coral,
                           text: PortalOfficePalette.accentText(colorScheme)) {
                    Task { await vm.lunchToggle() }
                }
            }
        }
        .padding(14)
        .portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── আজকের কাজ (GET my-tasks — today's still-open tasks, serial order) ──

    private var tasksCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                officeBadge("checklist")
                VStack(alignment: .leading, spacing: 1) {
                    Text("আজকের কাজ").font(.footnote.weight(.semibold))
                    Text("আমার কাজ · \(PortalOfficeFormat.headerDate())")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if !vm.tasks.isEmpty {
                    Text(PortalOfficeFormat.bn(vm.tasks.count))
                        .font(.caption.weight(.bold))
                        .foregroundStyle(PortalOfficePalette.accentText(colorScheme))
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background(PortalOfficePalette.coral.opacity(0.18), in: Capsule())
                        .overlay(Capsule().strokeBorder(PortalOfficePalette.coral.opacity(0.4), lineWidth: 1))
                }
            }
            if vm.tasks.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("আজ কোনো কাজ নেই").font(.footnote.weight(.semibold))
                    Text("নতুন কাজ এলে এখানে দেখতে পাবেন।").font(.caption).foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            } else {
                ForEach(vm.tasks) { t in
                    taskRow(t)
                }
                Text("রেজাল্ট জমা দিতে, কমেন্ট করতে বা ✅ সম্পন্ন দিতে কাজটিতে চাপ দিন।")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            // ── নিজে থেকে একটা কাজ (web SelfInitiated composer) ──
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                showSelfCreate = true
            } label: {
                Label("✨ নিজে থেকে একটা কাজ করেছি — জমা দিন", systemImage: "plus.circle")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(PortalOfficePalette.violet)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(PortalOfficePalette.violet.opacity(0.12), in: Capsule())
                    .overlay(Capsule().strokeBorder(PortalOfficePalette.violet.opacity(0.4),
                                                    style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
            }
            .buttonStyle(.plain)
            .padding(.top, 2)
        }
        .padding(14)
        .portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func taskRow(_ t: PortalOfficeTask) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            detailTask = t
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(PortalOfficeFormat.bn(t.serial ?? 0))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(PortalOfficePalette.accentText(colorScheme))
                    .frame(width: 26, height: 26)
                    .background(PortalOfficePalette.coral.opacity(0.16), in: Circle())
                    .overlay(Circle().strokeBorder(PortalOfficePalette.coral.opacity(0.35), lineWidth: 1))
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.title)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                    if let type = t.type, !type.isEmpty {
                        Text("📦 \(type)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 4)
                if vm.actionBusyTaskId == t.id {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }

    // ── গ্রুপ চ্যাট (web GroupChat — open the native chat sheet) ──

    private var chatCard: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            showChat = true
        } label: {
            HStack(spacing: 10) {
                officeBadge("bubble.left.and.bubble.right")
                VStack(alignment: .leading, spacing: 1) {
                    Text("অফিস গ্রুপ চ্যাট").font(.footnote.weight(.semibold))
                    Text("● Agent, আপনি, টিম").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .padding(14)
        .portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── নোটিফিকেশন (GET/POST notifications — web NotifBell parity) ──

    private var noticesCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                officeBadge("bell")
                Text("নোটিফিকেশন").font(.footnote.weight(.semibold))
                if vm.unread > 0 {
                    Text(vm.unread > 9 ? "৯+" : PortalOfficeFormat.bn(vm.unread))
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2.5)
                        .background(PortalOfficePalette.red500, in: Capsule())
                }
                Spacer()
                if vm.unread > 0 {
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        Task { await vm.markAllRead() }
                    } label: {
                        Text("সব পড়া হয়েছে")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(PortalOfficePalette.accentText(colorScheme))
                    }
                    .buttonStyle(.plain)
                    .disabled(vm.markingRead)
                }
            }
            if vm.notices.isEmpty {
                Text("কোনো নোটিফিকেশন নেই।")
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(.vertical, 6)
            } else {
                ForEach(vm.notices) { n in
                    noticeRow(n)
                }
            }
        }
        .padding(14)
        .portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func noticeRow(_ n: PortalOfficeNotice) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            Task { await vm.markRead(n) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Text(PortalOfficeFormat.kindIcon(n.kind))
                    .font(.footnote)
                    .frame(width: 26, height: 26)
                    .background(Color.primary.opacity(0.05), in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(n.title)
                        .font(.caption.weight(n.read ? .regular : .bold))
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                    if let body = n.body, !body.isEmpty {
                        Text(body).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Text(PortalOfficeFormat.timeAgo(n.createdAt))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if !n.read {
                    Circle().fill(PortalOfficePalette.coral).frame(width: 7, height: 7)
                        .padding(.top, 5)
                }
            }
            .padding(.vertical, 3)
        }
        .buttonStyle(.plain)
    }

    // ── Shared bits ──

    /// Squircle SF-symbol badge — coral→violet gradient, the app's card-header mark.
    private func officeBadge(_ systemName: String) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 34, height: 34)
            .background(
                LinearGradient(colors: [PortalOfficePalette.coral, AlmaSwiftTheme.violet],
                               startPoint: .topLeading, endPoint: .bottomTrailing),
                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .shadow(color: PortalOfficePalette.coral.opacity(0.35), radius: 5, y: 2)
    }

    private func chipButton(_ label: String, icon: String?, tint: Color, text: Color,
                            action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            action()
        } label: {
            Group {
                if let icon {
                    Label(label, systemImage: icon)
                } else {
                    Text(label)
                }
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(text)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(tint.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private enum NoticeTone { case error, success, info }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", PortalOfficePalette.red500)
        case .success: ("checkmark.circle", PortalOfficePalette.emerald600)
        case .info: ("info.circle", Color.secondary)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<3, id: \.self) { _ in
            Color.clear.frame(height: 110)
                .portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .portalOfficeShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/portal/office", "Office")
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

// MARK: - Task detail sheet (web StaffDetail — thread + ✅ done + 💬 comment + update)

@available(iOS 17.0, *)
private struct PortalTaskDetailSheet: View {
    let task: PortalOfficeTask
    @Bindable var vm: PortalOfficeVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var busy: Bool { vm.actionBusyTaskId == task.id }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    // Task header
                    VStack(alignment: .leading, spacing: 6) {
                        Text(task.title).font(.headline.weight(.bold))
                        if let type = task.type, !type.isEmpty {
                            Text("📦 \(type)")
                                .font(.caption).foregroundStyle(.secondary)
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background(Color.primary.opacity(0.05), in: Capsule())
                        }
                    }

                    // Thread (web .msgs)
                    VStack(alignment: .leading, spacing: 10) {
                        Text("আলোচনা").font(.caption.weight(.bold)).textCase(.uppercase)
                            .foregroundStyle(.secondary)
                        if vm.threadLoading {
                            HStack { ProgressView().controlSize(.small); Text("লোড হচ্ছে…").font(.caption).foregroundStyle(.secondary) }
                        } else if vm.thread.isEmpty {
                            Text("এখনো কোনো মন্তব্য নেই")
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            ForEach(vm.thread) { c in threadBubble(c) }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rControl)

                    // Compose: comment / update answer
                    VStack(alignment: .leading, spacing: 10) {
                        Text("📎 রেজাল্ট / কমেন্ট জমা দিন").font(.footnote.weight(.semibold))
                        HStack(spacing: 8) {
                            TextField("কমেন্ট লিখুন…", text: $draft, axis: .vertical)
                                .lineLimit(1...4)
                                .focused($focused)
                                .font(.footnote)
                                .padding(.horizontal, 12).padding(.vertical, 9)
                                .background(Color.primary.opacity(0.05),
                                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                            Button {
                                let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                                guard !text.isEmpty else { return }
                                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                                Task {
                                    // Answer a Boss update request as 'update'; a plain note as 'comment'.
                                    if await vm.taskAction(task.id, action: "comment", body: text) { draft = "" }
                                }
                            } label: {
                                if busy {
                                    ProgressView().controlSize(.small).frame(width: 60)
                                } else {
                                    Text("পাঠান").font(.footnote.weight(.semibold))
                                        .foregroundStyle(PortalOfficePalette.accentText(colorScheme))
                                        .padding(.horizontal, 14).padding(.vertical, 9)
                                        .background(PortalOfficePalette.coral.opacity(0.14), in: Capsule())
                                        .overlay(Capsule().strokeBorder(PortalOfficePalette.coral.opacity(0.35), lineWidth: 1))
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(busy || draft.trimmingCharacters(in: .whitespaces).isEmpty)
                        }

                        // ✅ Mark done (web "✅ সম্পন্ন হিসেবে চিহ্নিত করুন")
                        Button {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            Task {
                                if await vm.taskAction(task.id, action: "done") { dismiss() }
                            }
                        } label: {
                            if busy {
                                ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.vertical, 9)
                            } else {
                                Label("✅ সম্পন্ন হিসেবে চিহ্নিত করুন", systemImage: "checkmark.seal")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(PortalOfficePalette.emerald600)
                                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                                    .background(PortalOfficePalette.emerald600.opacity(0.13), in: Capsule())
                                    .overlay(Capsule().strokeBorder(PortalOfficePalette.emerald600.opacity(0.35), lineWidth: 1))
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(busy)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rControl)

                    // Photo proof stays web (needs the camera / file upload).
                    Button {
                        openWeb("/portal/office", "Office")
                    } label: {
                        Label("📷 ছবি জমা দিতে ওয়েবে খুলুন", systemImage: "safari")
                            .font(.caption).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 2)

                    Text("Boss অনুমোদন দিলে কাজটি সম্পন্ন হবে। নোটিফিকেশন এই অ্যাপে ও টেলিগ্রামে পাবেন।")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                .padding(16)
            }
            .background(PortalOfficeAurora())
            .navigationTitle("কাজের বিস্তারিত")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("বন্ধ") { dismiss() }
                }
            }
        }
        .task { await vm.loadThread(task.id) }
    }

    private func threadBubble(_ c: PortalOfficeThreadMsg) -> some View {
        let isOwner = c.authorType == "owner"
        let isAgent = c.authorType == "agent"
        let who = isOwner ? "Boss" : isAgent ? "Agent" : "আপনি"
        return HStack(alignment: .top, spacing: 8) {
            Text(isOwner ? "M" : isAgent ? "🤖" : "•")
                .font(.caption2.weight(.bold))
                .frame(width: 24, height: 24)
                .background(Color.primary.opacity(0.06), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(who).font(.caption2.weight(.bold))
                    Text(PortalOfficeFormat.timeAgo(c.createdAt)).font(.caption2).foregroundStyle(.secondary)
                }
                Text(c.body).font(.caption).foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Self-initiated sheet (web SelfInitiated — title + optional detail)

@available(iOS 17.0, *)
private struct PortalSelfInitiatedSheet: View {
    @Bindable var vm: PortalOfficeVM
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var detail = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                Text("✨ নিজে থেকে একটা কাজ করেছি")
                    .font(.headline.weight(.bold))
                Text("Boss অনুমোদন দিলে পারফরম্যান্সে +পয়েন্ট।")
                    .font(.caption).foregroundStyle(.secondary)

                TextField("কাজের শিরোনাম", text: $title)
                    .focused($focused)
                    .font(.footnote)
                    .padding(.horizontal, 12).padding(.vertical, 11)
                    .background(Color.primary.opacity(0.05),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))

                TextField("বিস্তারিত (ঐচ্ছিক)", text: $detail, axis: .vertical)
                    .lineLimit(2...5)
                    .font(.footnote)
                    .padding(.horizontal, 12).padding(.vertical, 11)
                    .background(Color.primary.opacity(0.05),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))

                Button {
                    let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !t.isEmpty else { return }
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    Task {
                        if await vm.createSelfInitiated(title: t,
                                                        detail: detail.trimmingCharacters(in: .whitespacesAndNewlines)) {
                            dismiss()
                        }
                    }
                } label: {
                    if vm.creatingSelf {
                        ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.vertical, 10)
                    } else {
                        Text("পাঠান").font(.footnote.weight(.semibold))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 12)
                            .background(PortalOfficePalette.violet, in: Capsule())
                    }
                }
                .buttonStyle(.plain)
                .disabled(vm.creatingSelf || title.trimmingCharacters(in: .whitespaces).isEmpty)

                Spacer()
            }
            .padding(18)
            .background(PortalOfficeAurora())
            .navigationTitle("নতুন কাজ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("বাতিল") { dismiss() } }
            }
        }
        .onAppear { focused = true }
    }
}

// MARK: - Group chat sheet (web GroupChat — send text + explain a task)

/// Standalone entry point for the group chat when opened from the app-wide floating chat
/// head (not from inside the office screen). Owns its own VM, resolves the viewer's role,
/// then shows the same messenger sheet.
@available(iOS 17.0, *)
struct OfficeChatStandalone: View {
    var openWeb: (_ path: String, _ title: String) -> Void = { _, _ in }
    @State private var vm = PortalOfficeVM()

    var body: some View {
        Group {
            if vm.roleResolved {
                PortalGroupChatSheet(vm: vm, isOwner: vm.selfRole == "owner", openWeb: openWeb)
            } else {
                ZStack {
                    PortalOfficeAurora()
                    ProgressView().tint(.white)
                }
                .task { await vm.loadHub() }
            }
        }
    }
}

@available(iOS 17.0, *)
struct PortalGroupChatSheet: View {
    @Bindable var vm: PortalOfficeVM
    let isOwner: Bool
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var tasksOpen = false
    @State private var picks: [PhotosPickerItem] = []
    @State private var staged: [Data] = []
    @State private var editText: [String: String] = [:]   // owner edits of agent drafts
    @State private var preview: PortalImagePreview? = nil  // tapped image → full-screen viewer
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            if vm.chatLoading && vm.chat.isEmpty {
                                HStack { ProgressView().controlSize(.small); Text("লোড হচ্ছে…").font(.caption).foregroundStyle(.secondary) }
                                    .padding(.top, 20)
                            } else if vm.chat.isEmpty {
                                Text("— এখনো কোনো বার্তা নেই। প্রথম বার্তাটি লিখুন। —")
                                    .font(.caption).foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity).padding(.top, 24)
                            } else {
                                ForEach(vm.chat) { m in
                                    if m.status == "pending" { draftBubble(m) } else { bubble(m) }
                                }
                            }
                            Color.clear.frame(height: 1).id("bottom")
                        }
                        .padding(.horizontal, 12).padding(.vertical, 10)
                    }
                    .onChange(of: vm.chat.count) { _, _ in
                        withAnimation(.snappy) { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                    .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
                }

                if tasksOpen && !isOwner { staffTaskPicker }
                if !staged.isEmpty { stagedTray }
                composer
            }
            .background(PortalOfficeAurora())
            .navigationTitle("অফিস গ্রুপ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 6) {
                        Text("🤖").font(.footnote)
                        VStack(alignment: .leading, spacing: 0) {
                            Text("অফিস গ্রুপ").font(.footnote.weight(.bold))
                            Text("● Agent · আপনি · টিম").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                ToolbarItem(placement: .cancellationAction) { Button("বন্ধ") { dismiss() } }
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("সম্পন্ন") { hideKeyboard() } }
            }
        }
        .task {
            await vm.loadChat()
            while !Task.isCancelled {   // live poll, messenger-style (15s)
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                if Task.isCancelled { break }
                await vm.loadChat()
            }
        }
        .onChange(of: picks) { _, items in
            Task {
                var out: [Data] = []
                for it in items {
                    if let d = try? await it.loadTransferable(type: Data.self),
                       let ui = UIImage(data: d), let jpg = ui.jpegData(compressionQuality: 0.8) {
                        out.append(jpg)
                    }
                }
                staged.append(contentsOf: out)
                picks = []
            }
        }
        .fullScreenCover(item: $preview) { PortalImageViewer(preview: $0) }
    }

    // ── One message bubble (own = right coral, others = left with avatar) ──
    @ViewBuilder private func bubble(_ m: PortalOfficeChatMsg) -> some View {
        let mine = isOwner && m.authorType == "owner"
        let isAgent = m.authorType == "agent"
        let name = isAgent ? "Agent" : m.authorType == "owner" ? "Boss" : m.authorName
        HStack(alignment: .bottom, spacing: 6) {
            if mine { Spacer(minLength: 40) }
            if !mine {
                officeAvatar(m.authorImageUrl, initial: isAgent ? "🤖" : (m.authorName.first.map { String($0).uppercased() } ?? "•"), size: 28)
            }
            VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
                if !mine {
                    Text(name).font(.caption2.weight(.bold))
                        .foregroundStyle(isAgent ? PortalOfficePalette.violet : PortalOfficePalette.accentText(colorScheme))
                }
                ForEach(Array(m.imageURLs.enumerated()), id: \.offset) { idx, s in
                    if let u = URL(string: s) {
                        AsyncImage(url: u) { i in i.resizable().scaledToFill() } placeholder: {
                            Color.primary.opacity(0.06).frame(height: 150)
                        }
                        .frame(maxWidth: 210, maxHeight: 210)
                        .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                        .contentShape(Rectangle())
                        .onTapGesture { preview = PortalImagePreview(urls: m.imageURLs, index: idx) }
                    }
                }
                if !m.body.trimmingCharacters(in: .whitespaces).isEmpty {
                    Text(m.body)
                        .font(.footnote)
                        .foregroundStyle(mine ? .white : .primary)
                        .multilineTextAlignment(.leading)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(bubbleBg(mine: mine, agent: isAgent),
                                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
                }
                Text(PortalOfficeFormat.timeAgo(m.createdAt)).font(.caption2).foregroundStyle(.secondary)
            }
            if !mine { Spacer(minLength: 40) }
        }
    }

    private func bubbleBg(mine: Bool, agent: Bool) -> AnyShapeStyle {
        if mine { return AnyShapeStyle(PortalOfficePalette.coral) }
        if agent { return AnyShapeStyle(PortalOfficePalette.violet.opacity(0.15)) }
        return AnyShapeStyle(Color.primary.opacity(colorScheme == .dark ? 0.10 : 0.06))
    }

    // ── Owner-only agent draft: edit, approve, dismiss ──
    private func draftBubble(_ m: PortalOfficeChatMsg) -> some View {
        let text = Binding(get: { editText[m.id] ?? m.body }, set: { editText[m.id] = $0 })
        return VStack(alignment: .leading, spacing: 8) {
            Label("Agent · খসড়া · শুধু আপনি দেখছেন", systemImage: "sparkles")
                .font(.caption2.weight(.bold)).foregroundStyle(PortalOfficePalette.violet)
            TextField("খসড়া…", text: text, axis: .vertical)
                .font(.footnote).lineLimit(1...6)
                .padding(10).background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            HStack(spacing: 8) {
                Spacer()
                if vm.chatDecidingId == m.id {
                    ProgressView().controlSize(.small)
                } else {
                    Button("❌ খারিজ") { Task { await vm.chatAgentDecide(m.id, approve: false) } }
                        .font(.caption2.weight(.bold)).foregroundStyle(PortalOfficePalette.red500)
                    Button {
                        Task { await vm.chatAgentDecide(m.id, approve: true, editedBody: text.wrappedValue) }
                    } label: {
                        Text("✅ অনুমোদন").font(.caption2.weight(.bold)).foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(PortalOfficePalette.emerald600, in: Capsule())
                    }.buttonStyle(.plain)
                }
            }
        }
        .padding(12)
        .background(PortalOfficePalette.violet.opacity(0.08), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(PortalOfficePalette.violet.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
    }

    private var stagedTray: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(staged.enumerated()), id: \.offset) { idx, data in
                    if let ui = UIImage(data: data) {
                        Image(uiImage: ui).resizable().scaledToFill()
                            .frame(width: 54, height: 54)
                            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                            .overlay(alignment: .topTrailing) {
                                Button { staged.remove(at: idx) } label: {
                                    Image(systemName: "xmark.circle.fill").foregroundStyle(.white, .black.opacity(0.5))
                                }.offset(x: 4, y: -4)
                            }
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
        .background(.ultraThinMaterial)
    }

    private var staffTaskPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("আজকের কাজ — যেটা বুঝছেন না, সেটায় চাপ দিন")
                .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            if vm.tasks.isEmpty {
                Text("আজ আপনার কোনো বাকি কাজ নেই।").font(.caption2).foregroundStyle(.secondary)
            } else {
                ForEach(vm.tasks) { t in
                    Button {
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        Task { await vm.explainTask(t.id); tasksOpen = false }
                    } label: {
                        HStack(spacing: 8) {
                            Text(PortalOfficeFormat.bn(t.serial ?? 0))
                                .font(.caption2.weight(.bold)).foregroundStyle(PortalOfficePalette.accentText(colorScheme))
                                .frame(width: 22, height: 22).background(PortalOfficePalette.coral.opacity(0.16), in: Circle())
                            Text(t.title).font(.caption).foregroundStyle(.primary).lineLimit(1)
                            Spacer(minLength: 4)
                            if vm.explainingTaskId == t.id { ProgressView().controlSize(.small) }
                            else { Text("বুঝিয়ে দিন").font(.caption2.weight(.semibold)).foregroundStyle(PortalOfficePalette.accentText(colorScheme)) }
                        }
                    }
                    .buttonStyle(.plain).disabled(vm.explainingTaskId != nil)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12).background(.ultraThinMaterial)
    }

    private var composer: some View {
        HStack(spacing: 8) {
            PhotosPicker(selection: $picks, maxSelectionCount: 6, matching: .images) {
                Image(systemName: "photo.on.rectangle")
                    .font(.footnote.weight(.semibold)).foregroundStyle(PortalOfficePalette.violet)
                    .frame(width: 36, height: 36).background(Color.primary.opacity(0.05), in: Circle())
            }
            if !isOwner {
                Button {
                    UISelectionFeedbackGenerator().selectionChanged()
                    withAnimation(.snappy) { tasksOpen.toggle() }
                } label: {
                    Image(systemName: "list.bullet.clipboard")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(tasksOpen ? PortalOfficePalette.accentText(colorScheme) : .secondary)
                        .frame(width: 36, height: 36).background(Color.primary.opacity(0.05), in: Circle())
                }.buttonStyle(.plain)
            }
            TextField("গ্রুপে মেসেজ লিখুন…", text: $draft, axis: .vertical)
                .lineLimit(1...4).focused($focused).font(.footnote)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
            Button {
                let text = draft; let imgs = staged
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                Task { if await vm.sendChatFull(text, images: imgs) { draft = ""; staged = [] } }
            } label: {
                if vm.chatSending {
                    ProgressView().controlSize(.small).frame(width: 44)
                } else {
                    Image(systemName: "paperplane.fill")
                        .font(.footnote.weight(.bold)).foregroundStyle(.white)
                        .frame(width: 36, height: 36).background(PortalOfficePalette.coral, in: Circle())
                }
            }
            .buttonStyle(.plain)
            .disabled(vm.chatSending || (draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && staged.isEmpty))
        }
        .padding(12).background(.ultraThinMaterial)
    }
}

// MARK: - Owner Hub (the BOSS dashboard — role-detected, full web parity)

/// Shared coral→violet squircle badge for card headers (both screens use it).
@available(iOS 17.0, *)
private func officeGradBadge(_ systemName: String) -> some View {
    Image(systemName: systemName)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(.white)
        .frame(width: 34, height: 34)
        .background(
            LinearGradient(colors: [PortalOfficePalette.coral, AlmaSwiftTheme.violet],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .shadow(color: PortalOfficePalette.coral.opacity(0.35), radius: 5, y: 2)
}

/// Circular avatar — real ERP profile photo when present, else a tinted initial.
@available(iOS 17.0, *)
func officeAvatar(_ url: String?, initial: String, size: CGFloat = 34) -> some View {
    Group {
        if let url, let u = URL(string: url) {
            AsyncImage(url: u) { img in img.resizable().scaledToFill() } placeholder: {
                Text(initial).font(.footnote.weight(.bold)).foregroundStyle(.white)
            }
        } else {
            Text(initial).font(.footnote.weight(.bold)).foregroundStyle(.white)
        }
    }
    .frame(width: size, height: size)
    .background(LinearGradient(colors: [PortalOfficePalette.violet, PortalOfficePalette.coral],
                               startPoint: .topLeading, endPoint: .bottomTrailing))
    .clipShape(Circle())
}

/// Identifiable payload so `.fullScreenCover(item:)` can open the zoomable viewer.
struct PortalImagePreview: Identifiable {
    let id = UUID()
    let urls: [String]
    let index: Int
}

/// Full-screen image viewer — swipe between images, pinch/double-tap to zoom, tap ✕
/// to dismiss. Lets the Boss actually read a staff proof photo (was capped at a thumbnail).
@available(iOS 17.0, *)
struct PortalImageViewer: View {
    let preview: PortalImagePreview
    @Environment(\.dismiss) private var dismiss
    @State private var selection: Int
    @State private var scale: CGFloat = 1

    init(preview: PortalImagePreview) {
        self.preview = preview
        _selection = State(initialValue: preview.index)
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            TabView(selection: $selection) {
                ForEach(Array(preview.urls.enumerated()), id: \.offset) { i, s in
                    if let u = URL(string: s) {
                        AsyncImage(url: u) { img in
                            img.resizable().scaledToFit()
                                .scaleEffect(i == selection ? scale : 1)
                                .gesture(
                                    MagnificationGesture()
                                        .onChanged { scale = max(1, min($0, 4)) }
                                        .onEnded { _ in withAnimation(.snappy) { scale = 1 } }
                                )
                                .onTapGesture(count: 2) {
                                    withAnimation(.snappy) { scale = scale > 1 ? 1 : 2.5 }
                                }
                        } placeholder: {
                            ProgressView().tint(.white)
                        }
                        .tag(i)
                    }
                }
            }
            .tabViewStyle(.page(indexDisplayMode: preview.urls.count > 1 ? .automatic : .never))
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.headline.weight(.bold)).foregroundStyle(.white)
                    .padding(11).background(.ultraThinMaterial, in: Circle())
            }
            .padding(.horizontal, 18).padding(.top, 8)
        }
    }
}

@available(iOS 17.0, *)
struct PortalOwnerHubView: View {
    @Bindable var vm: PortalOfficeVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Binding var showChat: Bool
    @Binding var ownerTask: PortalHubTask?
    @Binding var showHistory: Bool
    @Environment(\.colorScheme) private var colorScheme
    @State private var segment = 0
    @State private var expanded: Set<String> = []   // team members whose todolist is open

    private var accent: Color { PortalOfficePalette.accentText(colorScheme) }

    var body: some View {
        if let hub = vm.hub {
            header(hub)
            if vm.isSampleData { demoStrip }
            if let err = vm.error { errorStrip(err) }
            kpiGrid(hub.kpis)
            if let award = hub.award { awardHero(award, stats: hub.awardStats) }
            if !hub.proposals.isEmpty { proposalsCard(hub.proposals) }
            approvalCard(hub)
            teamCard(hub)                    // team status + each staff's todolist nested
            chatEntry
            // "আপডেট ট্র্যাকিং" (overdueUpdates) + "টিম অ্যাক্টিভিটি" (activity feed) removed —
            // owner found them cluttered/unprofessional; keep the leaner board.
            leaderboardCard(hub.leaderboard)
            performanceCard(hub.performance)
            noticesCard
            historyButton
        } else {
            ForEach(0..<3, id: \.self) { _ in
                Color.clear.frame(height: 110).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard).portalOfficeShimmer()
            }
        }
    }

    // ── Native large-title header + segmented + greeting ──
    private func header(_ hub: PortalOwnerHub) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("বস ড্যাশবোর্ড")
                .font(.caption.weight(.semibold)).textCase(.uppercase).tracking(0.6)
                .foregroundStyle(.secondary).padding(.bottom, 5)
            Text("Office")
                .font(.system(size: 33, weight: .bold, design: .default)).tracking(-0.6)
            Picker("", selection: $segment) {
                Text("আজ").tag(0); Text("সপ্তাহ").tag(1); Text("মাস").tag(2)
            }
            .pickerStyle(.segmented)
            .padding(.top, 14)
            VStack(alignment: .leading, spacing: 4) {
                Text("আসসালামু আলাইকুম, Boss").font(.title3.weight(.bold))
                Text("আজকের অফিস এক নজরে — কাজ, সাবমিশন আর অনুমোদন।")
                    .font(.subheadline).foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    Circle().fill(PortalOfficePalette.green400).frame(width: 7, height: 7)
                    Text("\(PortalOfficeFormat.bn(hub.kpis.online)) জন অনলাইন · \(PortalOfficeFormat.headerDate())")
                        .font(.caption.weight(.medium)).foregroundStyle(.secondary)
                }
                .padding(.top, 4)
            }
            .padding(.top, 18)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 6)
    }

    /// Shown only in the demo/sample state (the /hub route isn't on production yet), so the
    /// Boss knows these names/numbers aren't his real staff until the route is deployed.
    private var demoStrip: some View {
        Label("ডেমো ডেটা দেখানো হচ্ছে — লাইভ অফিস ডেটার জন্য hub রুট প্রোডাকশনে ডিপ্লয় হলে আসল স্টাফ ও টাস্ক দেখাবে।",
              systemImage: "info.circle.fill")
            .font(.caption2.weight(.medium)).foregroundStyle(PortalOfficePalette.amber600)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(11)
            .background(PortalOfficePalette.amber500.opacity(0.12),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                .strokeBorder(PortalOfficePalette.amber500.opacity(0.3), lineWidth: 1))
    }

    private func errorStrip(_ msg: String) -> some View {
        Label(msg, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(PortalOfficePalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── KPI tiles (SF Symbols, not emoji — native polish) ──
    private func kpiGrid(_ k: PortalOwnerHub.Kpis) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
            kpiTile("hourglass", "অনুমোদনের অপেক্ষায়", PortalOfficeFormat.bn(k.pending), PortalOfficePalette.amber500)
            kpiTile("arrow.triangle.2.circlepath", "চলমান কাজ", PortalOfficeFormat.bn(k.active), PortalOfficePalette.violet)
            kpiTile("checkmark.circle.fill", "আজ সম্পন্ন", PortalOfficeFormat.bn(k.doneToday), PortalOfficePalette.emerald600)
            kpiTile("person.2.fill", "স্টাফ অনলাইন", "\(PortalOfficeFormat.bn(k.online))/\(PortalOfficeFormat.bn(k.staffTotal))", PortalOfficePalette.coral)
        }
    }
    private func kpiTile(_ symbol: String, _ label: String, _ value: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: symbol).font(.system(size: 20, weight: .semibold)).foregroundStyle(tint)
                .frame(height: 26).padding(.bottom, 8)
            Text(value).font(.system(size: 29, weight: .bold)).monospacedDigit()
                .foregroundStyle(.primary).lineLimit(1).minimumScaleFactor(0.6)
            Text(label).font(.caption).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(15).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Performer of the week ──
    private func awardHero(_ a: PortalAward, stats: PortalAwardStats?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                officeAvatar(a.imageUrl, initial: a.staffName.first.map { String($0).uppercased() } ?? "★", size: 44)
                    .overlay(Text("👑").font(.title3).offset(y: -26))
                VStack(alignment: .leading, spacing: 2) {
                    Text("🏆 এই সপ্তাহের সেরা পারফরমার").font(.caption2.weight(.bold)).foregroundStyle(accent)
                    Text("\(a.staffName) — মাশাআল্লাহ!").font(.subheadline.weight(.bold))
                }
                Spacer()
            }
            if let s = stats {
                HStack(spacing: 8) {
                    awardStat("সম্পন্ন", PortalOfficeFormat.bn(s.done))
                    awardStat("অনুমোদন", s.approvalRate.map { "\(PortalOfficeFormat.bn($0))%" } ?? "—")
                    awardStat("QC", s.avgQc.map { PortalOfficeFormat.bn($0) } ?? "—")
                    awardStat("নিজ উদ্যোগে", PortalOfficeFormat.bn(s.selfInitiated))
                }
            }
        }
        .padding(14)
        .background(LinearGradient(colors: [PortalOfficePalette.amber500.opacity(0.20), PortalOfficePalette.coral.opacity(0.12)],
                                   startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(PortalOfficePalette.amber500.opacity(0.4), lineWidth: 1))
    }
    private func awardStat(_ label: String, _ value: String) -> some View {
        VStack(spacing: 1) {
            Text(value).font(.footnote.weight(.bold))
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }

    // ── Update tracking (calling lives here) ──
    private func updateTracking(_ rows: [PortalOverdue]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            cardHeader("clock.badge.exclamationmark", "আপডেট ট্র্যাকিং",
                       "সাড়া পাওয়া যায়নি \(PortalOfficeFormat.bn(rows.count)) জন", tint: PortalOfficePalette.amber600)
            ForEach(rows) { r in overdueRow(r) }
        }
        .padding(14).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }
    private func overdueRow(_ r: PortalOverdue) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                officeAvatar(nil, initial: r.staffName.first.map { String($0).uppercased() } ?? "•", size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text(r.staffName).font(.footnote.weight(.semibold))
                    Text(r.title).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
            }
            if let note = r.note, !note.isEmpty {
                Text(note).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack(spacing: 8) {
                if r.escalated {
                    Label("অটো-রিমাইন্ডার পাঠানো হয়েছে", systemImage: "bell.badge.fill")
                        .font(.caption2.weight(.semibold)).foregroundStyle(PortalOfficePalette.red500)
                } else {
                    Text("⏱ \(overdueClock(r.secondsLeft))")
                        .font(.caption2.weight(.semibold).monospacedDigit()).foregroundStyle(PortalOfficePalette.amber600)
                }
                Spacer()
                if let phone = r.phone, !phone.isEmpty, let u = URL(string: "tel://\(phone)") {
                    Link(destination: u) {
                        Label("কল", systemImage: "phone.fill")
                            .font(.caption2.weight(.bold)).foregroundStyle(PortalOfficePalette.emerald600)
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(PortalOfficePalette.emerald600.opacity(0.14), in: Capsule())
                    }
                }
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    Task { await vm.ownerAct(.init(action: "request_update", taskId: r.id, note: "Boss আবার আপডেট চাইছেন"), taskId: r.id) }
                } label: {
                    if vm.ownerBusyId == r.id {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("মনে করান", systemImage: "bell")
                            .font(.caption2.weight(.bold)).foregroundStyle(accent)
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(PortalOfficePalette.coral.opacity(0.14), in: Capsule())
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 4)
    }
    private func overdueClock(_ secondsLeft: Int) -> String {
        let over = secondsLeft <= 0
        let m = abs(secondsLeft) / 60, s = abs(secondsLeft) % 60
        let clock = "\(PortalOfficeFormat.bn(m)):\(PortalOfficeFormat.bn(String(format: "%02d", s)))"
        return over ? "\(clock) — এসকেলেট হচ্ছে" : "\(clock)-এ Boss-কে জানানো হবে"
    }

    // ── Proposals ──
    private func proposalsCard(_ rows: [PortalProposal]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            cardHeader("doc.text.magnifyingglass", "এজেন্টের প্রস্তাব",
                       "আপনার সিদ্ধান্ত দরকার \(PortalOfficeFormat.bn(rows.count))টি", tint: PortalOfficePalette.violet)
            Text("💡 এজেন্ট শুধু প্রস্তাব করে — টাকা/পেরোলে পরিবর্তন হয় না। অনুমোদন করলে আপনি নিজে ERP-তে প্রয়োগ করবেন।")
                .font(.caption2).foregroundStyle(.secondary)
            ForEach(rows) { p in proposalRow(p) }
        }
        .padding(14).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }
    private func proposalRow(_ p: PortalProposal) -> some View {
        let reward = p.kind.lowercased().contains("reward") || p.kind.lowercased().contains("award")
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(reward ? "🎁" : "⚠️")
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(p.staffName) · \(reward ? "রিওয়ার্ড" : "জরিমানা")\(p.amount.map { " ৳\(PortalOfficeFormat.bn($0))" } ?? "")")
                        .font(.footnote.weight(.semibold))
                    if let t = p.taskTitle, !t.isEmpty { Text(t).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                }
                Spacer()
            }
            if !p.reason.isEmpty { Text(p.reason).font(.caption2).foregroundStyle(.secondary).lineLimit(2) }
            HStack(spacing: 8) {
                Spacer()
                if vm.proposalBusyId == p.id {
                    ProgressView().controlSize(.small)
                } else {
                    pillButton("খারিজ", tint: PortalOfficePalette.red500) {
                        Task { await vm.ownerAct(.init(action: "proposal_decide", proposalId: p.id, decision: "dismiss"), proposalId: p.id) }
                    }
                    pillButton("অনুমোদন", tint: PortalOfficePalette.emerald600, filled: true) {
                        Task { await vm.ownerAct(.init(action: "proposal_decide", proposalId: p.id, decision: "approve"), proposalId: p.id) }
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    // ── Approval queue ──
    private func approvalCard(_ hub: PortalOwnerHub) -> some View {
        let count = hub.pendingApproval.count + hub.selfInitiated.count
        return VStack(alignment: .leading, spacing: 10) {
            cardHeader("checkmark.seal", "অনুমোদনের অপেক্ষায়",
                       count > 0 ? "\(PortalOfficeFormat.bn(count))টি" : "সব ক্লিয়ার ✓", tint: PortalOfficePalette.amber500)
            if count == 0 {
                Text("এই মুহূর্তে অনুমোদনের কিছু নেই।").font(.caption).foregroundStyle(.secondary).padding(.vertical, 4)
            }
            ForEach(hub.pendingApproval) { t in approvalRow(t) }
            ForEach(hub.selfInitiated) { t in selfRow(t) }
        }
        .padding(14).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }
    private func approvalRow(_ t: PortalHubTask) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.title).font(.footnote.weight(.semibold)).lineLimit(2)
                    HStack(spacing: 6) {
                        Text("👤 \(t.staffName)").font(.caption2).foregroundStyle(.secondary)
                        if !t.type.isEmpty { Text("· \(t.type)").font(.caption2).foregroundStyle(.secondary) }
                        if t.needsOwner {
                            Text("📌 রিভিউ দরকার").font(.caption2.weight(.bold)).foregroundStyle(PortalOfficePalette.red500)
                        }
                    }
                }
                Spacer()
            }
            if !t.imageUrls.isEmpty {
                proofStrip(t.imageUrls) { ownerTask = t }
                Label("ছবিতে চাপ দিন — বড় দেখুন, কমেন্ট করুন ও অনুমোদন দিন",
                      systemImage: "hand.tap.fill")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                Button { ownerTask = t } label: {
                    Text("বিস্তারিত").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }.buttonStyle(.plain)
                Spacer()
                if vm.ownerBusyId == t.id {
                    ProgressView().controlSize(.small)
                } else {
                    pillButton("🔄 সংশোধন", tint: PortalOfficePalette.amber600) { ownerTask = t }
                    pillButton("✅ অনুমোদন", tint: PortalOfficePalette.emerald600, filled: true) {
                        Task { await vm.ownerAct(.init(action: "approve", taskId: t.id), taskId: t.id) }
                    }
                }
            }
        }
        .padding(10)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }
    private func selfRow(_ t: PortalHubTask) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("✨").font(.footnote)
                VStack(alignment: .leading, spacing: 1) {
                    Text(t.title).font(.footnote.weight(.semibold)).lineLimit(2)
                    Text("নিজ উদ্যোগে · \(t.staffName)").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
            }
            HStack(spacing: 8) {
                Spacer()
                if vm.ownerBusyId == t.id {
                    ProgressView().controlSize(.small)
                } else {
                    pillButton("প্রত্যাখ্যান", tint: PortalOfficePalette.red500) {
                        Task { await vm.ownerAct(.init(action: "self_reject", taskId: t.id), taskId: t.id) }
                    }
                    pillButton("অনুমোদন", tint: PortalOfficePalette.emerald600, filled: true) {
                        Task { await vm.ownerAct(.init(action: "self_approve", taskId: t.id), taskId: t.id) }
                    }
                }
            }
        }
        .padding(10)
        .background(PortalOfficePalette.violet.opacity(0.06), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }
    private func proofStrip(_ urls: [String], onTap: @escaping () -> Void) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(urls.enumerated()), id: \.offset) { _, s in
                    if let u = URL(string: s) {
                        AsyncImage(url: u) { i in i.resizable().scaledToFill() } placeholder: {
                            Color.primary.opacity(0.06)
                        }
                        .frame(width: 84, height: 84)
                        .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
                        .contentShape(Rectangle())
                        .onTapGesture { onTap() }
                    }
                }
            }
        }
    }

    // ── Active tasks (grouped by staff) ──
    // ── Team status + each staff's todolist nested (accordion) ──
    private func teamCard(_ hub: PortalOwnerHub) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            cardHeader("person.3.fill", "টিম স্ট্যাটাস ও টাস্ক", "\(PortalOfficeFormat.bn(hub.team.count)) জন", tint: PortalOfficePalette.coral)
                .padding(.bottom, 4)
            ForEach(Array(hub.team.enumerated()), id: \.element.staffId) { idx, m in
                if idx > 0 { Divider().overlay(Color.primary.opacity(colorScheme == .dark ? 0.10 : 0.06)) }
                teamMemberRow(m, hub: hub)
            }
        }
        .padding(14).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    @ViewBuilder
    private func teamMemberRow(_ m: PortalTeamMember, hub: PortalOwnerHub) -> some View {
        let doneItems = hub.doneTodayTasks.filter { $0.staffId == m.staffId }
        let activeItems = hub.activeTasks.filter { $0.staffId == m.staffId }
        let isOpen = expanded.contains(m.staffId)
        VStack(spacing: 0) {
            Button {
                UISelectionFeedbackGenerator().selectionChanged()
                if isOpen { expanded.remove(m.staffId) } else { expanded.insert(m.staffId) }
            } label: {
                HStack(spacing: 11) {
                    officeAvatar(m.imageUrl, initial: m.initial, size: 36)
                        .overlay(alignment: .bottomTrailing) {
                            Circle().fill(statusColor(m.status)).frame(width: 11, height: 11)
                                .overlay(Circle().strokeBorder(.background, lineWidth: 2))
                        }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(m.name).font(.subheadline.weight(.semibold))
                        HStack(spacing: 6) {
                            Circle().fill(statusColor(m.status)).frame(width: 6, height: 6)
                            Text(m.sub).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 4)
                    Text("\(PortalOfficeFormat.bn(m.doneToday))/\(PortalOfficeFormat.bn(m.totalToday))")
                        .font(.subheadline.weight(.semibold)).monospacedDigit().foregroundStyle(.secondary)
                    Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                }
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if isOpen {
                VStack(spacing: 0) {
                    if doneItems.isEmpty && activeItems.isEmpty {
                        HStack(spacing: 8) {
                            Circle().fill(statusColor(m.status)).frame(width: 6, height: 6)
                            Text(m.checkedIn ? "আজ কোনো টাস্ক অ্যাসাইন করা হয়নি।"
                                             : "চেক-ইন করলে আজকের অ্যাসাইন করা টাস্ক এখানে দেখাবে।")
                                .font(.caption).foregroundStyle(.secondary)
                            Spacer()
                        }
                        .padding(.leading, 47).padding(.vertical, 8)
                    } else {
                        ForEach(doneItems) { t in taskLine(t, done: true) }
                        ForEach(activeItems) { t in taskLine(t, done: false) }
                    }
                }
                .padding(.bottom, 6)
            }
        }
        .animation(.snappy(duration: 0.28), value: isOpen)
    }

    private func taskLine(_ t: PortalHubTask, done: Bool) -> some View {
        Button { ownerTask = t } label: {
            HStack(spacing: 12) {
                ZStack {
                    Circle().strokeBorder(done ? Color.clear : PortalOfficePalette.violet.opacity(0.5), lineWidth: 1.8)
                        .background(Circle().fill(done ? PortalOfficePalette.emerald600 : Color.clear))
                        .frame(width: 20, height: 20)
                    if done { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white) }
                }
                Text(t.title).font(.footnote).foregroundStyle(done ? .secondary : .primary)
                    .strikethrough(done, color: .secondary).lineLimit(1)
                Spacer(minLength: 4)
                if !done && (t.needsOwner || t.verificationStatus == "redo_requested") {
                    Text("রিভিউ").font(.caption2.weight(.bold)).foregroundStyle(PortalOfficePalette.red500)
                } else if !t.type.isEmpty {
                    Text(t.type).font(.caption2).foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
            .padding(.leading, 47).padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
    private func statusColor(_ s: String) -> Color {
        switch s { case "on": return PortalOfficePalette.green400
        case "lunch": return PortalOfficePalette.amber500
        default: return Color.gray }
    }

    // ── Group chat entry (opens the messenger sheet) ──
    private var chatEntry: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            showChat = true
        } label: {
            HStack(spacing: 10) {
                officeGradBadge("bubble.left.and.bubble.right.fill")
                VStack(alignment: .leading, spacing: 1) {
                    Text("অফিস গ্রুপ চ্যাট").font(.footnote.weight(.semibold))
                    Text("🤖 Agent · আপনি · টিম — মেসেঞ্জারের মতো").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .padding(14).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Activity feed ──
    private func activityCard(_ items: [PortalActivity]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            cardHeader("dot.radiowaves.left.and.right", "টিম অ্যাক্টিভিটি", "", tint: PortalOfficePalette.violet)
            if items.isEmpty {
                Text("এখনো কোনো অ্যাক্টিভিটি নেই।").font(.caption).foregroundStyle(.secondary).padding(.vertical, 4)
            }
            ForEach(items.prefix(8)) { a in
                HStack(alignment: .top, spacing: 8) {
                    Text(PortalOfficeFormat.kindIcon(a.kind)).font(.footnote).frame(width: 22)
                    Text(a.summary).font(.caption).foregroundStyle(.primary).lineLimit(2)
                    Spacer(minLength: 4)
                    Text(PortalOfficeFormat.timeAgo(a.createdAt)).font(.caption2).foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
            }
        }
        .padding(14).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Leaderboard ──
    private func leaderboardCard(_ rows: [PortalLeader]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            cardHeader("trophy", "সাপ্তাহিক পারফরম্যান্স", "", tint: PortalOfficePalette.amber500)
            if rows.isEmpty {
                Text("এখনো ডেটা নেই।").font(.caption).foregroundStyle(.secondary).padding(.vertical, 4)
            }
            ForEach(Array(rows.enumerated()), id: \.element.id) { idx, r in
                HStack(spacing: 10) {
                    Text("\(PortalOfficeFormat.bn(idx + 1))").font(.caption.weight(.bold)).foregroundStyle(accent).frame(width: 18)
                    officeAvatar(r.imageUrl, initial: r.initial, size: 26)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(r.name).font(.caption.weight(.semibold)).lineLimit(1)
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Color.primary.opacity(0.08))
                                Capsule().fill(LinearGradient(colors: [PortalOfficePalette.coral, PortalOfficePalette.amber500],
                                                              startPoint: .leading, endPoint: .trailing))
                                    .frame(width: max(6, geo.size.width * CGFloat(max(6, r.pct)) / 100))
                            }
                        }.frame(height: 6)
                    }
                    Text(PortalOfficeFormat.bn(r.score)).font(.caption.weight(.bold)).foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
            }
        }
        .padding(14).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Staff performance table ──
    private func performanceCard(_ rows: [PortalPerf]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            cardHeader("chart.bar", "স্টাফ পারফরম্যান্স", "সপ্তাহ", tint: PortalOfficePalette.emerald600)
            if rows.isEmpty {
                Text("এখনো ডেটা নেই।").font(.caption).foregroundStyle(.secondary).padding(.vertical, 4)
            } else {
                HStack {
                    Text("স্টাফ").frame(maxWidth: .infinity, alignment: .leading)
                    Text("সম্পন্ন").frame(width: 52); Text("সময়মতো").frame(width: 56)
                    Text("সংশোধন").frame(width: 56); Text("স্কোর").frame(width: 44)
                }
                .font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                ForEach(rows) { p in
                    HStack {
                        Text(p.staffName).font(.caption).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                        Text(PortalOfficeFormat.bn(p.done)).font(.caption).frame(width: 52)
                        Text(p.onTimeRate.map { "\(PortalOfficeFormat.bn($0))%" } ?? "—").font(.caption).frame(width: 56)
                        Text(PortalOfficeFormat.bn(p.redo)).font(.caption).frame(width: 56)
                        Text(PortalOfficeFormat.bn(p.score)).font(.caption.weight(.bold)).foregroundStyle(accent).frame(width: 44)
                    }
                    .padding(.vertical, 3)
                    Divider().overlay(Color.primary.opacity(0.06))
                }
            }
        }
        .padding(14).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Notifications (owner bell) ──
    private var noticesCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                officeGradBadge("bell")
                Text("নোটিফিকেশন").font(.footnote.weight(.semibold))
                if vm.unread > 0 {
                    Text(vm.unread > 9 ? "৯+" : PortalOfficeFormat.bn(vm.unread))
                        .font(.caption2.weight(.bold)).foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2.5)
                        .background(PortalOfficePalette.red500, in: Capsule())
                }
                Spacer()
                if vm.unread > 0 {
                    Button { Task { await vm.markAllRead() } } label: {
                        Text("সব পড়া হয়েছে").font(.caption2.weight(.semibold)).foregroundStyle(accent)
                    }.buttonStyle(.plain)
                }
            }
            if vm.notices.isEmpty {
                Text("কোনো নোটিফিকেশন নেই।").font(.caption).foregroundStyle(.secondary).padding(.vertical, 4)
            } else {
                ForEach(vm.notices.prefix(6)) { n in
                    HStack(alignment: .top, spacing: 10) {
                        Text(PortalOfficeFormat.kindIcon(n.kind)).font(.footnote).frame(width: 22)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(n.title).font(.caption.weight(n.read ? .regular : .bold)).lineLimit(2)
                            Text(PortalOfficeFormat.timeAgo(n.createdAt)).font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if !n.read { Circle().fill(PortalOfficePalette.coral).frame(width: 7, height: 7) }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .padding(14).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── History ──
    private var historyButton: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            showHistory = true
        } label: {
            HStack(spacing: 10) {
                officeGradBadge("calendar")
                VStack(alignment: .leading, spacing: 1) {
                    Text("অফিসের ইতিহাস").font(.footnote.weight(.semibold))
                    Text("আগের দিনগুলোর বোর্ড").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .padding(14).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Shared bits ──
    private func cardHeader(_ icon: String, _ title: String, _ sub: String, tint: Color) -> some View {
        HStack(spacing: 10) {
            officeGradBadge(icon)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.footnote.weight(.semibold))
                if !sub.isEmpty { Text(sub).font(.caption2).foregroundStyle(.secondary) }
            }
            Spacer()
        }
    }
    private func pillButton(_ label: String, tint: Color, filled: Bool = false, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            action()
        } label: {
            Text(label)
                .font(.caption2.weight(.bold))
                .foregroundStyle(filled ? .white : tint)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(filled ? AnyShapeStyle(tint) : AnyShapeStyle(tint.opacity(0.14)), in: Capsule())
                .overlay(Capsule().strokeBorder(tint.opacity(filled ? 0 : 0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Owner task sheet (approve · redo · comment · set-due · always-escalate)

@available(iOS 17.0, *)
private struct PortalOwnerTaskSheet: View {
    let task: PortalHubTask
    @Bindable var vm: PortalOfficeVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var showRedo = false
    @State private var showDue = false
    @State private var due = Date()
    @State private var preview: PortalImagePreview? = nil   // tapped proof → full-screen zoom
    private var busy: Bool { vm.ownerBusyId == task.id }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    taskHeader
                    if !task.imageUrls.isEmpty { imagesRow }
                    threadSection
                    commentComposer
                    actionsSection
                }
                .padding(16)
            }
            .background(PortalOfficeAurora())
            .dismissKeyboardOnTap()
            .navigationTitle("কাজের বিস্তারিত")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("বন্ধ") { dismiss() } } }
            .fullScreenCover(item: $preview) { PortalImageViewer(preview: $0) }
            .alert("সংশোধনের নোট", isPresented: $showRedo) {
                TextField("কী ঠিক করতে হবে…", text: $note)
                Button("ফেরত দিন") { Task { if await vm.ownerAct(.init(action: "redo", taskId: task.id, note: note.isEmpty ? nil : note), taskId: task.id) { dismiss() } } }
                Button("বাতিল", role: .cancel) {}
            }
            .sheet(isPresented: $showDue) {
                NavigationStack {
                    DatePicker("ডিউ ডেট", selection: $due).datePickerStyle(.graphical).padding()
                        .navigationTitle("ডিউ সেট করুন").navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("সেট") {
                                    let iso = ISO8601DateFormatter().string(from: due)
                                    Task { await vm.ownerAct(.init(action: "set_due", taskId: task.id, dueAt: iso), taskId: task.id) }
                                    showDue = false
                                }
                            }
                            ToolbarItem(placement: .cancellationAction) { Button("বাতিল") { showDue = false } }
                        }
                }.presentationDetents([.medium])
            }
        }
        .task { await vm.loadThread(task.id) }
    }

    private var taskHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(task.title).font(.headline.weight(.bold))
            HStack(spacing: 8) {
                Text("👤 \(task.staffName)").font(.caption).foregroundStyle(.secondary)
                if !task.type.isEmpty {
                    Text(task.type).font(.caption)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Color.primary.opacity(0.05), in: Capsule())
                }
            }
            if let d = task.detail, !d.isEmpty { Text(d).font(.subheadline).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var imagesRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("কাজের প্রমাণ — বড় করে দেখতে ছবিতে চাপ দিন", systemImage: "photo.stack")
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(Array(task.imageUrls.enumerated()), id: \.offset) { idx, s in
                        if let u = URL(string: s) {
                            AsyncImage(url: u) { i in i.resizable().scaledToFill() } placeholder: {
                                ZStack { Color.primary.opacity(0.06); ProgressView() }
                            }
                            .frame(width: 230, height: 230)
                            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                                .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
                            .contentShape(Rectangle())
                            .onTapGesture { preview = PortalImagePreview(urls: task.imageUrls, index: idx) }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private var threadSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("আলোচনা").font(.caption.weight(.bold)).textCase(.uppercase).foregroundStyle(.secondary)
            if vm.threadLoading {
                ProgressView().controlSize(.small)
            } else if vm.thread.isEmpty {
                Text("এখনো কোনো মন্তব্য নেই").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(vm.thread) { c in threadRow(c) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func threadRow(_ c: PortalOfficeThreadMsg) -> some View {
        let who = c.authorType == "owner" ? "Boss" : c.authorType == "agent" ? "Agent" : task.staffName
        return VStack(alignment: .leading, spacing: 2) {
            Text("\(who) · \(PortalOfficeFormat.timeAgo(c.createdAt))")
                .font(.caption2.weight(.bold)).foregroundStyle(.secondary)
            Text(c.body).font(.caption)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var commentComposer: some View {
        HStack(spacing: 8) {
            TextField("কমেন্ট / নির্দেশনা…", text: $note, axis: .vertical)
                .lineLimit(1...4).font(.footnote)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            Button("পাঠান") {
                let t = note.trimmingCharacters(in: .whitespacesAndNewlines); guard !t.isEmpty else { return }
                Task { if await vm.ownerAct(.init(action: "comment", taskId: task.id, body: t), taskId: task.id) { note = ""; await vm.loadThread(task.id) } }
            }
            .font(.footnote.weight(.semibold))
            .disabled(busy || note.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    private var actionsSection: some View {
        VStack(spacing: 8) {
            actionBtn("✅ অনুমোদন করুন", tint: PortalOfficePalette.emerald600, filled: true) {
                Task { if await vm.ownerAct(.init(action: "approve", taskId: task.id), taskId: task.id) { dismiss() } }
            }
            actionBtn("🔄 সংশোধনে ফেরত দিন", tint: PortalOfficePalette.amber600) { showRedo = true }
            actionBtn("⏰ আপডেট চান", tint: PortalOfficePalette.violet) {
                Task { await vm.ownerAct(.init(action: "request_update", taskId: task.id, note: note.isEmpty ? nil : note), taskId: task.id) }
            }
            actionBtn("📅 ডিউ ডেট সেট করুন", tint: PortalOfficePalette.coral) { showDue = true }
            HStack {
                Text("সবসময় Boss-এ পাঠাও").font(.caption)
                Spacer()
                Toggle("", isOn: Binding(get: { task.alwaysEscalate }, set: { on in
                    Task { await vm.ownerAct(.init(action: "set_always_escalate", taskId: task.id, on: on), taskId: task.id) }
                })).labelsHidden().tint(PortalOfficePalette.coral)
            }
            .padding(.top, 2)
        }
    }

    private func actionBtn(_ label: String, tint: Color, filled: Bool = false, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred(); action()
        } label: {
            HStack { Spacer()
                if busy { ProgressView().controlSize(.small) } else { Text(label).font(.footnote.weight(.bold)) }
                Spacer() }
                .foregroundStyle(filled ? .white : tint)
                .padding(.vertical, 12)
                .background(filled ? AnyShapeStyle(tint) : AnyShapeStyle(tint.opacity(0.13)), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous).strokeBorder(tint.opacity(filled ? 0 : 0.35), lineWidth: 1))
        }
        .buttonStyle(.plain).disabled(busy)
    }
}

// MARK: - Office history sheet (owner — past boards)

struct PortalArchiveDay: Decodable, Identifiable {
    let date: String, label: String
    let total: Int, done: Int, approved: Int, staffCount: Int
    var id: String { date }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        date = (try? c.decode(String.self, forKey: .date)) ?? ""
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? date
        func i(_ k: K) -> Int { (try? c.decodeIfPresent(Int.self, forKey: k)) ?? 0 }
        total = i(.total); done = i(.done); approved = i(.approved); staffCount = i(.staffCount)
    }
    enum K: String, CodingKey { case date, label, total, done, approved, staffCount }
}
private struct PortalArchiveIndex: Decodable { let days: [PortalArchiveDay] }

@available(iOS 17.0, *)
private struct PortalOfficeHistorySheet: View {
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var days: [PortalArchiveDay] = []
    @State private var loading = true

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 10) {
                    if loading {
                        ForEach(0..<4, id: \.self) { _ in
                            Color.clear.frame(height: 64).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rControl).portalOfficeShimmer()
                        }
                    } else if days.isEmpty {
                        Text("এখনো কোনো ইতিহাস নেই। দিন শেষে আজকের বোর্ড এখানে জমা হবে।")
                            .font(.caption).foregroundStyle(.secondary).padding(.top, 40)
                    } else {
                        ForEach(days) { d in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(d.label).font(.subheadline.weight(.bold))
                                Text("\(PortalOfficeFormat.bn(d.total))টি কাজ · \(PortalOfficeFormat.bn(d.done))টি সম্পন্ন · \(PortalOfficeFormat.bn(d.approved))টি অনুমোদিত · \(PortalOfficeFormat.bn(d.staffCount)) জন স্টাফ")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14).portalOfficeGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                        }
                    }
                }
                .padding(14)
            }
            .background(PortalOfficeAurora())
            .navigationTitle("অফিসের ইতিহাস")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("বন্ধ") { dismiss() } } }
        }
        .task {
            loading = true
            defer { loading = false }
            if let idx: PortalArchiveIndex = try? await AlmaAPI.shared.get("/api/assistant/office/history") {
                days = idx.days
            }
        }
    }
}

// MARK: - Formatting helpers (web util parity)

enum PortalOfficeFormat {
    /// ASCII digits → Bangla numerals — the web's `bn()` helper.
    private static let bnDigits: [Character] = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"]
    static func bn(_ n: Int) -> String { bn(String(n)) }
    static func bn(_ s: String) -> String {
        String(s.map { c -> Character in
            if c.isASCII, let v = c.wholeNumberValue, (0...9).contains(v) { return bnDigits[v] }
            return c
        })
    }

    static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }

    /// Bangla long date for the header, e.g. "২৪ জুন, মঙ্গলবার" (web dhakaHeaderDate).
    static func headerDate() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "bn_BD")
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        f.dateFormat = "d MMMM, EEEE"
        return f.string(from: Date())
    }

    /// Bangla relative time — the web bell's exact strings (Bangla digits).
    static func timeAgo(_ iso: String?) -> String {
        guard let iso, let date = parse(iso) else { return "" }
        let m = Int(Date().timeIntervalSince(date) / 60)
        if m < 1 { return "এইমাত্র" }
        if m < 60 { return "\(bn(m)) মিনিট আগে" }
        let h = m / 60
        if h < 24 { return "\(bn(h)) ঘণ্টা আগে" }
        return "\(bn(h / 24)) দিন আগে"
    }

    /// Web KIND_ICON table verbatim.
    static func kindIcon(_ kind: String?) -> String {
        switch kind {
        case "completed": return "✅"
        case "comment": return "💬"
        case "approved": return "👍"
        case "redo": return "🔄"
        case "update_request": return "⏰"
        case "escalation": return "🚨"
        case "self_initiated": return "✨"
        case "award": return "🏆"
        case "group_message": return "👥"
        case "task_assigned": return "📋"
        default: return "🔔"
        }
    }
}

// MARK: - Aurora background + glass (PortalOffice-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
struct PortalOfficeAurora: View {
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
                        .fill(b.color)
                        .frame(width: b.size, height: b.size)
                        .position(x: geo.size.width * b.x + (drift ? b.dx : -b.dx),
                                  y: geo.size.height * b.y + (drift ? b.dy : -b.dy))
                        .blur(radius: 70)
                }
            }
            .onAppear { updateDrift() }
            .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)
                .receive(on: DispatchQueue.main)) { _ in updateDrift() }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    /// Battery guard: drift only when the owner allows motion — Reduce Motion and
    /// Low Power Mode both freeze the aurora to a static wash (blobs at rest).
    private func updateDrift() {
        if reduceMotion || ProcessInfo.processInfo.isLowPowerModeEnabled {
            var tx = Transaction(); tx.disablesAnimations = true
            withTransaction(tx) { drift = false }
        } else if !drift {
            withAnimation(.easeInOut(duration: 26).repeatForever(autoreverses: true)) { drift = true }
        }
    }
}

@available(iOS 17.0, *)
extension View {
    func portalOfficeGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct PortalOfficeShimmer: ViewModifier {
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
    func portalOfficeShimmer() -> some View { modifier(PortalOfficeShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Office — Light") {
    PortalOfficeScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
