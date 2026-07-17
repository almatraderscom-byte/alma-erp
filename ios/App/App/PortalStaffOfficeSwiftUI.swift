//
//  PortalStaffOfficeSwiftUI.swift
//  ALMA ERP — the STAFF side of the Office tab as a premium native SwiftUI screen,
//  at full parity with the web staff app (src/app/portal/office/staff-app.tsx).
//
//  The owner already gets the native Boss Hub (PortalOwnerHubView). This file gives
//  an employee the same rich experience the web gives them, driven by the SAME
//  payload the web page renders — GET /api/assistant/office/hub now returns the full
//  getStaffOfficeData for a staff caller (today's tasks, proofs, weekly award, lunch,
//  attendance) plus the shared daily motivation.
//
//  What's here that the old basic staff list lacked:
//    • 👑 Performer-of-the-week hero + ✨ daily motivation
//    • ✅ check-in banner (office "active" follows ERP attendance)
//    • ⚠️ update-request alerts with a live 10-minute countdown + inline answer
//    • rich task cards (status badge, deadline, overdue, carried-over, redo note)
//    • 📎 NATIVE proof submission — pick/shoot up to 5 photos, upload, attach to the
//      task (no more "open the web to submit a photo")
//    • 📊 today's performance strip + progress bar
//
//  All actions reuse the existing PortalOfficeVM plumbing (/staff-action, /thread,
//  /lunch, /upload) — this file only adds the rich models, the proof-upload action,
//  and the SwiftUI surface.
//

import SwiftUI
import PhotosUI
import UIKit

// MARK: - Rich staff-office models (getStaffOfficeData / dailyMotivation)

struct PortalMotivation: Decodable, Equatable {
    let text: String
    let tag: String
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        tag = (try? c.decodeIfPresent(String.self, forKey: .tag)) ?? ""
    }
    enum K: String, CodingKey { case text, tag }
}

/// One staff task card — HubTaskCard + the staff-only fields (StaffTaskCard on the server).
struct PortalStaffTask: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let detail: String?
    let type: String
    let status: String
    let verificationStatus: String
    let reviewerNote: String?
    let redoCount: Int
    let dueAt: String?
    let needsUpdate: Bool
    let updateNote: String?
    let updateSecondsLeft: Int
    let friendlyDetail: String
    let carriedOver: Bool
    let imageUrls: [String]     // pulled out of proofData for native display

    static func == (a: PortalStaffTask, b: PortalStaffTask) -> Bool {
        a.id == b.id && a.status == b.status && a.verificationStatus == b.verificationStatus
            && a.needsUpdate == b.needsUpdate && a.imageUrls == b.imageUrls
    }
    enum K: String, CodingKey {
        case id, title, detail, type, status, verificationStatus, reviewerNote, redoCount, dueAt
        case needsUpdate, updateNote, updateSecondsLeft, friendlyDetail, carriedOver, proofData
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? "—"
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
        type = (try? c.decodeIfPresent(String.self, forKey: .type)) ?? ""
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? ""
        verificationStatus = (try? c.decodeIfPresent(String.self, forKey: .verificationStatus)) ?? ""
        reviewerNote = try? c.decodeIfPresent(String.self, forKey: .reviewerNote)
        redoCount = (try? c.decodeIfPresent(Int.self, forKey: .redoCount)) ?? 0
        dueAt = try? c.decodeIfPresent(String.self, forKey: .dueAt)
        needsUpdate = (try? c.decodeIfPresent(Bool.self, forKey: .needsUpdate)) ?? false
        updateNote = try? c.decodeIfPresent(String.self, forKey: .updateNote)
        updateSecondsLeft = (try? c.decodeIfPresent(Int.self, forKey: .updateSecondsLeft)) ?? 0
        friendlyDetail = (try? c.decodeIfPresent(String.self, forKey: .friendlyDetail)) ?? ""
        carriedOver = (try? c.decodeIfPresent(Bool.self, forKey: .carriedOver)) ?? false
        imageUrls = PortalProof.imageURLs(from: try? c.decodeIfPresent(PortalJSON.self, forKey: .proofData))
    }
}

struct PortalStaffOffice: Decodable, Equatable {
    let staffId: String
    let staffName: String
    let today: String
    var active: [PortalStaffTask]
    var done: [PortalStaffTask]
    var proposals: [PortalStaffTask]
    let isWinner: Bool
    let award: PortalAward?
    let lunchActive: Bool
    let lunchStartedAt: String?
    let checkedIn: Bool
    let checkedOut: Bool
    let checkInLabel: String?

    static func == (a: PortalStaffOffice, b: PortalStaffOffice) -> Bool {
        a.staffId == b.staffId && a.active == b.active && a.done == b.done
            && a.proposals == b.proposals && a.isWinner == b.isWinner
            && a.checkedIn == b.checkedIn && a.checkedOut == b.checkedOut
    }
    enum Root: String, CodingKey { case staffId, staffName, today, active, done, proposals, isWinner, award, lunch, attendance }
    enum LunchK: String, CodingKey { case active, startedAt }
    enum AttK: String, CodingKey { case checkedIn, checkedOut, checkInLabel }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: Root.self)
        staffId = (try? c.decodeIfPresent(String.self, forKey: .staffId)) ?? ""
        staffName = (try? c.decodeIfPresent(String.self, forKey: .staffName)) ?? "—"
        today = (try? c.decodeIfPresent(String.self, forKey: .today)) ?? ""
        active = (try? c.decode([PortalStaffTask].self, forKey: .active)) ?? []
        done = (try? c.decode([PortalStaffTask].self, forKey: .done)) ?? []
        proposals = (try? c.decode([PortalStaffTask].self, forKey: .proposals)) ?? []
        isWinner = (try? c.decodeIfPresent(Bool.self, forKey: .isWinner)) ?? false
        award = try? c.decodeIfPresent(PortalAward.self, forKey: .award)
        if let l = try? c.nestedContainer(keyedBy: LunchK.self, forKey: .lunch) {
            lunchActive = (try? l.decodeIfPresent(Bool.self, forKey: .active)) ?? false
            lunchStartedAt = try? l.decodeIfPresent(String.self, forKey: .startedAt)
        } else { lunchActive = false; lunchStartedAt = nil }
        if let a = try? c.nestedContainer(keyedBy: AttK.self, forKey: .attendance) {
            checkedIn = (try? a.decodeIfPresent(Bool.self, forKey: .checkedIn)) ?? false
            checkedOut = (try? a.decodeIfPresent(Bool.self, forKey: .checkedOut)) ?? false
            checkInLabel = try? a.decodeIfPresent(String.self, forKey: .checkInLabel)
        } else { checkedIn = false; checkedOut = false; checkInLabel = nil }
    }
}

// MARK: - VM extension: staff refresh + proof upload

@available(iOS 17.0, *)
extension PortalOfficeVM {
    /// Mirror the rich payload's open lunch onto the shared timer so it resumes.
    func syncLunch(from sd: PortalStaffOffice) {
        lunchActive = sd.lunchActive
        lunchStartedAt = sd.lunchStartedAt.flatMap { PortalOfficeFormat.parse($0) }
    }

    /// Re-fetch just the staff-office payload after an action (done/proof/update/self).
    func refreshStaff() async {
        do {
            let env: PortalHubEnvelope = try await AlmaAPI.shared.get("/api/assistant/office/hub")
            if let sd = env.staff {
                withAnimation(.snappy) { self.staffData = sd }
                syncLunch(from: sd)
            }
            if let m = env.motivation { self.motivation = m }
        } catch {
            // best-effort — leave the current board in place on a transient failure
        }
    }

    /// 📎 Submit proof: upload each image (native multipart), then staff-action 'proof'
    /// with an optional comment — exactly what the web StaffDetail composer posts.
    @discardableResult
    func submitProof(_ taskId: String, images: [Data], text: String) async -> Bool {
        guard actionBusyTaskId == nil else { return false }
        actionBusyTaskId = taskId
        defer { actionBusyTaskId = nil }
        struct UploadResp: Decodable { let url: String? }
        struct Payload: Encodable {
            let action = "proof"
            let taskId: String
            let imageUrl: String?
            let imageUrls: [String]
            let text: String?
        }
        do {
            var urls: [String] = []
            for (i, data) in images.enumerated() {
                let r: UploadResp = try await AlmaAPI.shared.uploadMultipart(
                    "/api/assistant/office/upload", fileField: "file",
                    filename: "proof-\(i).jpg", mime: "image/jpeg", data: data)
                if let u = r.url { urls.append(u) }
            }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let _: PortalStaffOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/staff-action",
                body: Payload(taskId: taskId, imageUrl: urls.first, imageUrls: urls,
                              text: trimmed.isEmpty ? nil : trimmed))
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "📎 রেজাল্ট জমা দেওয়া হয়েছে — Boss দেখে অনুমোদন দেবেন।"
            await refreshStaff()
            await loadThread(taskId)
            return true
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
            return false
        }
    }

    /// Mark done, then refresh the rich board (done drops out of `active`).
    @discardableResult
    func staffDone(_ taskId: String) async -> Bool {
        let ok = await taskAction(taskId, action: "done")
        if ok { await refreshStaff() }
        return ok
    }

    /// Answer a Boss update-request (action:'update'), then refresh the board.
    @discardableResult
    func staffUpdate(_ taskId: String, body: String) async -> Bool {
        let ok = await taskAction(taskId, action: "update", body: body)
        if ok { await refreshStaff() }
        return ok
    }
}

/// Local 2xx sentinel (the main file's PortalOfficeOk is file-private).
private struct PortalStaffOk: Decodable {}

// MARK: - Badges (web STASK_BADGE parity)

private struct StaffBadge { let label: String; let color: Color }

private func staffBadge(_ verification: String) -> StaffBadge {
    switch verification {
    case "redo_requested": return StaffBadge(label: "সংশোধন", color: PortalOfficePalette.amber600)
    case "proof_submitted", "auto_verified": return StaffBadge(label: "অপেক্ষায়", color: PortalStaffColors.sky)
    case "owner_approved": return StaffBadge(label: "সম্পন্ন ✓", color: PortalOfficePalette.emerald600)
    default: return StaffBadge(label: "চলছে", color: PortalOfficePalette.coral)
    }
}

private func staffStatusText(_ verification: String) -> String {
    switch verification {
    case "redo_requested": return "Boss সংশোধন চেয়েছেন"
    case "proof_submitted", "auto_verified": return "জমা দেওয়া হয়েছে"
    default: return "এখনো জমা দেননি"
    }
}

enum PortalStaffColors {
    static let sky = Color(red: 0.49, green: 0.83, blue: 0.99)      // #7dd3fc
    static let mint = Color(red: 0.43, green: 0.91, blue: 0.72)     // #6ee7b7
    static let gold = Color(red: 0.99, green: 0.83, blue: 0.30)     // #fcd34d
}

/// Bangla deadline label, e.g. "২৪ জুন, ৫:০০ PM".
private func staffDue(_ iso: String) -> String {
    guard let d = PortalOfficeFormat.parse(iso) else { return "" }
    let df = DateFormatter()
    df.locale = Locale(identifier: "bn-BD")
    df.timeZone = TimeZone(identifier: "Asia/Dhaka")
    df.dateFormat = "d MMMM, h:mm a"
    return df.string(from: d)
}

private func isOverdue(_ t: PortalStaffTask) -> Bool {
    guard let iso = t.dueAt, let d = PortalOfficeFormat.parse(iso), t.status != "done" else { return false }
    return d.timeIntervalSinceNow < 0
}

// MARK: - Staff app (web staff-app.tsx parity)

@available(iOS 17.0, *)
struct PortalStaffAppView: View {
    @Bindable var vm: PortalOfficeVM
    let staff: PortalStaffOffice
    let openWeb: (_ path: String, _ title: String) -> Void
    let onOpenTask: (PortalStaffTask) -> Void
    let onSelfCreate: () -> Void
    let onOpenChat: () -> Void
    @Environment(\.colorScheme) private var scheme

    private var accent: Color { PortalOfficePalette.accentText(scheme) }
    private var total: Int { staff.active.count + staff.done.count }
    private var doneN: Int { staff.done.count }
    private var remaining: Int { staff.active.count }
    private var needUpdate: [PortalStaffTask] { staff.active.filter { $0.needsUpdate } }

    var body: some View {
        VStack(spacing: 10) {
            notices
            performerHero
            motivationCard
            header
            checkInBanner
            lunchCard
            ForEach(needUpdate) { t in UpdateAlertCard(vm: vm, task: t) }
            tasksCard
            performanceCard
            bottomSection
        }
    }

    @ViewBuilder private var notices: some View {
        if let err = vm.error { strip(err, tone: .error) }
        if let ok = vm.notice { strip(ok, tone: .info) }
    }

    @ViewBuilder private var bottomSection: some View {
        chatEntry
        footerNote
    }

    // ── 👑 Performer of the week ──
    private var performerHero: some View {
        let a = staff.award
        let initial = String((a?.staffName.first ?? staff.staffName.first) ?? "?").uppercased()
        return HStack(spacing: 12) {
            ZStack(alignment: .top) {
                officeAvatar(a?.imageUrl, initial: initial, size: 52)
                Text("👑").font(.system(size: 20)).offset(y: -14)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("🏆 এই সপ্তাহের সেরা পারফরমার")
                    .font(.caption2.weight(.bold)).foregroundStyle(PortalStaffColors.gold)
                if staff.isWinner {
                    Text("আপনিই সেরা, মাশাআল্লাহ! 🎉").font(.subheadline.weight(.bold))
                    Text("টিমের #১ · অভিনন্দন!").font(.caption).foregroundStyle(.secondary)
                } else if let a {
                    Text(a.staffName).font(.subheadline.weight(.bold))
                    Text("নিজের সেরাটা দিন — পরের সপ্তাহে আপনিও হতে পারেন!")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("আজ সেরাটা দিন 💪").font(.subheadline.weight(.bold))
                    Text("প্রতিটি কাজ আপনাকে #১ এর দিকে এগিয়ে নেবে।")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(
            LinearGradient(colors: [PortalStaffColors.gold.opacity(0.16), PortalOfficePalette.coral.opacity(0.08)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(PortalStaffColors.gold.opacity(0.3), lineWidth: 1))
    }

    // ── ✨ Daily motivation ──
    @ViewBuilder private var motivationCard: some View {
        if let m = vm.motivation, !m.text.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("✨ আজকের অনুপ্রেরণা")
                    .font(.caption2.weight(.bold)).foregroundStyle(PortalOfficePalette.violet)
                Text(m.text).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                if !m.tag.isEmpty {
                    Text("— \(m.tag)").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .portalOfficeGlass(scheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("আমার অফিস · মোবাইল অ্যাপ")
                .font(.caption2.weight(.bold)).textCase(.uppercase).foregroundStyle(accent)
            Text("👷 আমার কাজ").font(.title3.weight(.bold))
            Text("আসসালামু আলাইকুম, \(staff.staffName)").font(.subheadline.weight(.semibold))
            Text("আজ \(PortalOfficeFormat.bn(total))টি কাজ · \(PortalOfficeFormat.bn(doneN))টি সম্পন্ন, \(PortalOfficeFormat.bn(remaining))টি বাকি")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 2)
    }

    // ── ✅ Check-in banner (attendance) ──
    @ViewBuilder private var checkInBanner: some View {
        if staff.checkedIn {
            bannerRow("✅ আপনি অফিসে সক্রিয়" + (staff.checkInLabel.map { " · চেক-ইন \($0)" } ?? ""),
                      tint: PortalOfficePalette.emerald600)
        } else if staff.checkedOut {
            bannerRow("🏁 আজকের চেক-আউট সম্পন্ন। আগামীকাল আবার দেখা হবে, ইনশাআল্লাহ।",
                      tint: PortalStaffColors.sky)
        } else {
            Button {
                // NP-7 (OP-07): canonical NATIVE check-in flow — My Desk's front-camera
                // + GPS sheet via the single nav path (never the web page).
                NotificationCenter.default.post(name: .almaOpenPath, object: nil,
                                                userInfo: ["path": "/portal"])
            } label: {
                bannerRow("⏳ এখনো চেক-ইন করেননি — চাপ দিয়ে চেক-ইন করুন", tint: PortalOfficePalette.amber600)
            }.buttonStyle(.plain)
        }
    }

    private func bannerRow(_ text: String, tint: Color) -> some View {
        HStack(spacing: 8) {
            Circle().fill(tint).frame(width: 8, height: 8)
            Text(text).font(.caption.weight(.semibold)).foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous).strokeBorder(tint.opacity(0.3), lineWidth: 1))
    }

    // ── 🍽️ Lunch (45-min allowance, live countdown) ──
    private static let lunchLimitSec = 45 * 60
    private var lunchCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            if vm.lunchActive, let started = vm.lunchStartedAt {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let remainingS = Self.lunchLimitSec - Int(context.date.timeIntervalSince(started))
                    let over = remainingS <= 0
                    let clock = "\(PortalOfficeFormat.bn(abs(remainingS) / 60)):\(PortalOfficeFormat.bn(String(format: "%02d", abs(remainingS) % 60)))"
                    HStack(spacing: 10) {
                        Text(over ? "🍽️ লাঞ্চ · ⚠️ \(clock) বেশি" : "🍽️ লাঞ্চ · \(clock) বাকি")
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .foregroundStyle(over ? PortalOfficePalette.red500 : PortalOfficePalette.amber600)
                        Spacer()
                        if vm.lunchBusy { ProgressView().controlSize(.small) }
                        else { pill("ফিরে এসেছি", tint: PortalOfficePalette.emerald600) { Task { await vm.lunchToggle() } } }
                    }
                }
            } else {
                HStack {
                    Label("লাঞ্চ · ৪৫ মিনিটের বিরতি", systemImage: "fork.knife")
                        .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    if vm.lunchBusy { ProgressView().controlSize(.small) }
                    else { pill("🍽️ লাঞ্চে যাচ্ছি", tint: PortalOfficePalette.coral) { Task { await vm.lunchToggle() } } }
                }
            }
        }
        .padding(14)
        .portalOfficeGlass(scheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── আজকের কাজ (active cards + self-initiated + done) ──
    private var tasksCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                badgeIcon("checklist")
                Text("আজকের কাজ").font(.footnote.weight(.semibold))
                Spacer()
                if !staff.active.isEmpty {
                    Text(PortalOfficeFormat.bn(staff.active.count))
                        .font(.caption.weight(.bold)).foregroundStyle(accent)
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background(PortalOfficePalette.coral.opacity(0.18), in: Capsule())
                }
            }

            if staff.active.isEmpty && staff.done.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("আজ কোনো কাজ নেই").font(.footnote.weight(.semibold))
                    Text("নতুন কাজ এলে এখানে দেখতে পাবেন।").font(.caption).foregroundStyle(.secondary)
                }.padding(.vertical, 6)
            }

            ForEach(staff.active) { t in taskCard(t) }

            // ✨ self-initiated composer + pending proposals
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred(); onSelfCreate()
            } label: {
                Label("✨ নিজে থেকে একটা কাজ করেছি — জমা দিন", systemImage: "plus.circle")
                    .font(.footnote.weight(.semibold)).foregroundStyle(PortalOfficePalette.violet)
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                    .background(PortalOfficePalette.violet.opacity(0.12), in: Capsule())
                    .overlay(Capsule().strokeBorder(PortalOfficePalette.violet.opacity(0.4),
                                                    style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
            }.buttonStyle(.plain)

            ForEach(staff.proposals) { p in proposalRow(p) }

            if !staff.done.isEmpty {
                Text("সম্পন্ন").font(.caption2.weight(.bold)).textCase(.uppercase)
                    .foregroundStyle(.secondary).padding(.top, 4)
                ForEach(staff.done) { t in doneRow(t) }
            }
        }
        .padding(14)
        .portalOfficeGlass(scheme, corner: AlmaSwiftTheme.rCard)
    }

    private func taskCard(_ t: PortalStaffTask) -> some View {
        let b = staffBadge(t.verificationStatus)
        let overdue = isOverdue(t)
        return Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred(); onOpenTask(t)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(t.title).font(.footnote.weight(.semibold)).foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 4)
                    if t.carriedOver { tag("↩ আগের কাজ", PortalOfficePalette.violet) }
                    tag(b.label, b.color)
                }
                Text("📦 \(t.type) · \(staffStatusText(t.verificationStatus))")
                    .font(.caption2).foregroundStyle(.secondary)
                if let due = t.dueAt {
                    Text((overdue ? "⏰ সময় পেরিয়ে গেছে · " : "⏳ সময়সীমা: ") + staffDue(due))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(overdue ? PortalOfficePalette.red500 : .secondary)
                }
                if t.needsUpdate {
                    Text("🔔 Boss আপডেট চেয়েছেন — দেখুন").font(.caption2.weight(.semibold))
                        .foregroundStyle(PortalOfficePalette.amber600)
                }
                if t.verificationStatus == "redo_requested", let n = t.reviewerNote, !n.isEmpty {
                    Text("🔄 \(n)").font(.caption2).foregroundStyle(PortalOfficePalette.amber600)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(11)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                .strokeBorder(overdue ? PortalOfficePalette.red500.opacity(0.35)
                              : (t.carriedOver ? PortalOfficePalette.violet.opacity(0.3) : Color.primary.opacity(0.06)),
                              lineWidth: 1))
        }.buttonStyle(.plain)
    }

    private func proposalRow(_ p: PortalStaffTask) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(p.title).font(.footnote.weight(.semibold))
                Spacer()
                tag("নিজ উদ্যোগে", PortalOfficePalette.violet)
            }
            Text("💡 অতিরিক্ত কাজ · Boss অনুমোদন দিলে পারফরম্যান্সে +পয়েন্ট")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(11)
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(PortalOfficePalette.violet.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
    }

    private func doneRow(_ t: PortalStaffTask) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred(); onOpenTask(t)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.seal.fill").font(.caption).foregroundStyle(PortalOfficePalette.emerald600)
                Text(t.title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    .strikethrough(color: .secondary)
                Spacer()
                Text("সম্পন্ন ✓").font(.caption2.weight(.bold)).foregroundStyle(PortalOfficePalette.emerald600)
            }
            .padding(.vertical, 5)
            .opacity(0.75)
        }.buttonStyle(.plain)
    }

    // ── 📊 Performance ──
    private var performanceCard: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                perfCell(PortalOfficeFormat.bn(doneN), "আজ সম্পন্ন", PortalStaffColors.mint)
                perfCell(PortalOfficeFormat.bn(remaining), "বাকি কাজ", PortalStaffColors.sky)
                perfCell(PortalOfficeFormat.bn(staff.proposals.count), "নিজ উদ্যোগে", PortalStaffColors.gold)
            }
            GeometryReader { geo in
                let pct = total > 0 ? CGFloat(doneN) / CGFloat(total) : 0
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.08)).frame(height: 8)
                    Capsule().fill(LinearGradient(colors: [PortalOfficePalette.coral, PortalOfficePalette.emerald600],
                                                  startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(8, geo.size.width * pct), height: 8)
                }
            }
            .frame(height: 8)
        }
        .padding(14)
        .portalOfficeGlass(scheme, corner: AlmaSwiftTheme.rCard)
    }

    private func perfCell(_ value: String, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.title3.weight(.bold).monospacedDigit()).foregroundStyle(color)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity)
    }

    // ── group chat entry ──
    private var chatEntry: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred(); onOpenChat()
        } label: {
            HStack(spacing: 10) {
                badgeIcon("bubble.left.and.bubble.right.fill")
                VStack(alignment: .leading, spacing: 1) {
                    Text("অফিস গ্রুপ চ্যাট").font(.footnote.weight(.semibold))
                    Text("টিম + Boss + Agent — সব একসাথে").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if vm.unread > 0 {
                    Text(PortalOfficeFormat.bn(vm.unread)).font(.caption2.weight(.bold)).foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(PortalOfficePalette.red500, in: Capsule())
                }
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
            .padding(14)
            .portalOfficeGlass(scheme, corner: AlmaSwiftTheme.rCard)
        }.buttonStyle(.plain)
    }

    private var footerNote: some View {
        HStack(alignment: .top, spacing: 8) {
            Text("🔔")
            Text("সব আলোচনা, ছবি ও অনুমোদন এখন Office Hub-এ। নতুন কাজ, কমেন্ট বা অনুমোদনের নোটিফিকেশন এই অ্যাপে ও টেলিগ্রামে পাবেন।")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 4).padding(.top, 2)
    }

    // ── small helpers ──
    private func badgeIcon(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 13, weight: .semibold))
            .foregroundStyle(accent).frame(width: 30, height: 30)
            .background(PortalOfficePalette.coral.opacity(0.14), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }
    private func tag(_ text: String, _ color: Color) -> some View {
        Text(text).font(.caption2.weight(.bold)).foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.14), in: Capsule())
    }
    private func pill(_ label: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button { UIImpactFeedbackGenerator(style: .soft).impactOccurred(); action() } label: {
            Text(label).font(.caption.weight(.bold)).foregroundStyle(tint)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(tint.opacity(0.14), in: Capsule())
                .overlay(Capsule().strokeBorder(tint.opacity(0.4), lineWidth: 1))
        }.buttonStyle(.plain)
    }
    private enum Tone { case error, info }
    private func strip(_ msg: String, tone: Tone) -> some View {
        let tint = tone == .error ? PortalOfficePalette.red500 : PortalOfficePalette.emerald600
        return Label(msg, systemImage: tone == .error ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
            .font(.caption.weight(.semibold)).foregroundStyle(tint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(11)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }
}

// MARK: - Update-request alert (⚠️ live 10-min countdown + inline answer)

@available(iOS 17.0, *)
private struct UpdateAlertCard: View {
    @Bindable var vm: PortalOfficeVM
    let task: PortalStaffTask
    @Environment(\.colorScheme) private var scheme
    @State private var open = false
    @State private var text = ""
    @FocusState private var focused: Bool

    private var busy: Bool { vm.actionBusyTaskId == task.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("⚠️ কাজের আপডেট চাওয়া হয়েছে").font(.footnote.weight(.bold))
                .foregroundStyle(PortalOfficePalette.amber600)
            Text("“\(task.title)” — Boss আপডেট চেয়েছেন। \(task.updateNote ?? "কাজের ছবি/আপডেট দিন।")")
                .font(.caption).foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let left = task.updateSecondsLeft - Int(context.date.timeIntervalSinceNow)
                Text("⏱ ১০ মিনিটের মধ্যে না দিলে Boss-কে জানানো হবে · " +
                     (left <= 0 ? "সময় শেষ" : "\(PortalOfficeFormat.bn(max(0, left) / 60)) মিনিট বাকি"))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if open {
                HStack(spacing: 8) {
                    TextField("অবস্থা লিখুন…", text: $text)
                        .focused($focused).font(.footnote)
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    Button {
                        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !t.isEmpty else { return }
                        Task { if await vm.staffUpdate(task.id, body: t) { text = ""; open = false } }
                    } label: {
                        if busy { ProgressView().controlSize(.small).frame(width: 46) }
                        else {
                            Text("দিন").font(.footnote.weight(.bold)).foregroundStyle(.white)
                                .padding(.horizontal, 14).padding(.vertical, 9)
                                .background(PortalOfficePalette.amber600, in: Capsule())
                        }
                    }.buttonStyle(.plain).disabled(busy || text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } else {
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred(); open = true; focused = true
                } label: {
                    Label("📤 এখনই আপডেট দিন", systemImage: "paperplane.fill")
                        .font(.caption.weight(.bold)).foregroundStyle(.white)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(PortalOfficePalette.amber600, in: Capsule())
                }.buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(13)
        .background(PortalOfficePalette.amber600.opacity(0.10), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(PortalOfficePalette.amber600.opacity(0.35), lineWidth: 1))
    }
}

// MARK: - Rich staff task detail (thread + NATIVE proof upload + comment + mark done)

@available(iOS 17.0, *)
struct PortalStaffTaskSheet: View {
    let task: PortalStaffTask
    @Bindable var vm: PortalOfficeVM
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    @State private var draft = ""
    @State private var picks: [PhotosPickerItem] = []
    @State private var shots: [Data] = []
    @State private var loadingPhotos = false
    @State private var showCamera = false
    @State private var preview: PortalImagePreview? = nil
    @FocusState private var focused: Bool

    private let maxShots = 5
    private var busy: Bool { vm.actionBusyTaskId == task.id }
    private var badge: StaffBadge { staffBadge(task.verificationStatus) }
    private var isRedo: Bool { task.verificationStatus == "redo_requested" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    // Header
                    VStack(alignment: .leading, spacing: 8) {
                        Text(task.title).font(.headline.weight(.bold))
                        HStack(spacing: 8) {
                            Text(isRedo ? "🔄 সংশোধন দরকার" : badge.label)
                                .font(.caption2.weight(.bold)).foregroundStyle(badge.color)
                                .padding(.horizontal, 9).padding(.vertical, 4)
                                .background(badge.color.opacity(0.14), in: Capsule())
                            Text("📦 \(task.type)").font(.caption2).foregroundStyle(.secondary)
                                .padding(.horizontal, 9).padding(.vertical, 4)
                                .background(Color.primary.opacity(0.05), in: Capsule())
                        }
                    }

                    if !task.friendlyDetail.isEmpty { instr("🧠 কাজটি যেভাবে করবেন", task.friendlyDetail, tint: PortalOfficePalette.violet) }
                    if isRedo, let n = task.reviewerNote, !n.isEmpty { instr("🔄 Boss যা সংশোধন চেয়েছেন", n, tint: PortalOfficePalette.amber600) }

                    // Existing submitted proof (tap → full-screen)
                    if !task.imageUrls.isEmpty { submittedProof }

                    thread
                    submitCard

                    Text("Boss অনুমোদন দিলে কাজটি সম্পন্ন হবে। নোটিফিকেশন এই অ্যাপে ও টেলিগ্রামে পাবেন।")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                .padding(16)
            }
            .background(PortalOfficeAurora())
            .navigationTitle("কাজের বিস্তারিত")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("বন্ধ") { dismiss() } } }
        }
        .task { await vm.loadThread(task.id) }
        .fullScreenCover(item: $preview) { PortalImageViewer(preview: $0) }
        .fullScreenCover(isPresented: $showCamera) {
            StaffCameraPicker { data in if let data, shots.count < maxShots { shots.append(data) } }
                .ignoresSafeArea()
        }
        .onChange(of: picks) { _, items in Task { await loadPicks(items) } }
    }

    private func instr(_ head: String, _ body: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(head).font(.caption.weight(.bold)).foregroundStyle(tint)
            Text(body).font(.footnote).foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous).strokeBorder(tint.opacity(0.25), lineWidth: 1))
    }

    private var submittedProof: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("জমা দেওয়া প্রমাণ").font(.caption.weight(.bold)).textCase(.uppercase).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(task.imageUrls.enumerated()), id: \.offset) { idx, url in
                        AsyncImage(url: URL(string: url)) { img in
                            img.resizable().aspectRatio(contentMode: .fill)
                        } placeholder: { Color.primary.opacity(0.06) }
                        .frame(width: 84, height: 84).clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                        .onTapGesture { preview = PortalImagePreview(urls: task.imageUrls, index: idx) }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12).portalOfficeGlass(scheme, corner: AlmaSwiftTheme.rControl)
    }

    private var thread: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("আলোচনা").font(.caption.weight(.bold)).textCase(.uppercase).foregroundStyle(.secondary)
            if vm.threadLoading {
                HStack { ProgressView().controlSize(.small); Text("লোড হচ্ছে…").font(.caption).foregroundStyle(.secondary) }
            } else if vm.thread.isEmpty {
                Text("এখনো কোনো মন্তব্য নেই").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(vm.thread) { c in bubble(c) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12).portalOfficeGlass(scheme, corner: AlmaSwiftTheme.rControl)
    }

    private func bubble(_ c: PortalOfficeThreadMsg) -> some View {
        let isOwner = c.authorType == "owner"
        let isAgent = c.authorType == "agent"
        let who = isOwner ? "Boss" : isAgent ? "Agent" : "আপনি"
        return HStack(alignment: .top, spacing: 8) {
            Text(isOwner ? "M" : isAgent ? "🤖" : "•").font(.caption2.weight(.bold))
                .frame(width: 24, height: 24).background(Color.primary.opacity(0.06), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(who).font(.caption2.weight(.bold))
                    Text(PortalOfficeFormat.timeAgo(c.createdAt)).font(.caption2).foregroundStyle(.secondary)
                }
                Text(c.body).font(.caption).foregroundStyle(.primary).multilineTextAlignment(.leading)
            }
            Spacer(minLength: 0)
        }
    }

    // ── 📎 Submit result — native photo proof + comment + mark done ──
    private var submitCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("📎 রেজাল্ট জমা দিন").font(.footnote.weight(.semibold))
                Spacer()
                Text("\(PortalOfficeFormat.bn(shots.count))/\(PortalOfficeFormat.bn(maxShots)) ছবি")
                    .font(.caption2).foregroundStyle(.secondary)
            }

            HStack(spacing: 10) {
                if StaffCameraPicker.available {
                    photoButton("📷 ছবি তুলুন") { showCamera = true }
                }
                PhotosPicker(selection: $picks, maxSelectionCount: maxShots, matching: .images) {
                    photoButtonLabel("🖼️ গ্যালারি")
                }
                .disabled(shots.count >= maxShots)
            }

            if !shots.isEmpty || loadingPhotos {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(shots.enumerated()), id: \.offset) { idx, data in
                            ZStack(alignment: .topTrailing) {
                                if let ui = UIImage(data: data) {
                                    Image(uiImage: ui).resizable().aspectRatio(contentMode: .fill)
                                        .frame(width: 76, height: 76)
                                        .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                                }
                                Button { shots.remove(at: idx) } label: {
                                    Image(systemName: "xmark.circle.fill").font(.system(size: 18))
                                        .foregroundStyle(.white, .black.opacity(0.5))
                                }.buttonStyle(.plain).padding(3)
                                .accessibilityLabel("ছবি সরান")
                            }
                        }
                        if loadingPhotos {
                            RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous).fill(Color.primary.opacity(0.06))
                                .frame(width: 76, height: 76).overlay(ProgressView().controlSize(.small))
                        }
                    }
                }
            }

            TextField("কমেন্ট লিখুন… (ঐচ্ছিক)", text: $draft, axis: .vertical)
                .lineLimit(1...4).focused($focused).font(.footnote)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))

            // Send proof (photos + optional comment)
            Button {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                Task {
                    if await vm.submitProof(task.id, images: shots, text: draft) { shots = []; draft = ""; dismiss() }
                }
            } label: {
                if busy { ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.vertical, 10) }
                else {
                    Label("পাঠান", systemImage: "paperplane.fill")
                        .font(.footnote.weight(.bold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 11)
                        .background(PortalOfficePalette.coral, in: Capsule())
                }
            }.buttonStyle(.plain)
             .disabled(busy || (shots.isEmpty && draft.trimmingCharacters(in: .whitespaces).isEmpty))

            HStack(spacing: 10) {
                if task.status != "done" {
                    Button {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        Task { if await vm.staffDone(task.id) { dismiss() } }
                    } label: {
                        Label("✅ সম্পন্ন", systemImage: "checkmark.seal")
                            .font(.footnote.weight(.semibold)).foregroundStyle(PortalOfficePalette.emerald600)
                            .frame(maxWidth: .infinity).padding(.vertical, 10)
                            .background(PortalOfficePalette.emerald600.opacity(0.13), in: Capsule())
                            .overlay(Capsule().strokeBorder(PortalOfficePalette.emerald600.opacity(0.35), lineWidth: 1))
                    }.buttonStyle(.plain).disabled(busy)
                }
                Button {
                    let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !t.isEmpty else { return }
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    Task { if await vm.taskAction(task.id, action: "comment", body: t) { draft = "" } }
                } label: {
                    Label("💬 কমেন্ট", systemImage: "text.bubble")
                        .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity).padding(.vertical, 10)
                        .background(Color.primary.opacity(0.05), in: Capsule())
                }.buttonStyle(.plain).disabled(busy || draft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12).portalOfficeGlass(scheme, corner: AlmaSwiftTheme.rControl)
    }

    private func photoButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: { UIImpactFeedbackGenerator(style: .soft).impactOccurred(); action() }) { photoButtonLabel(label) }
            .buttonStyle(.plain).disabled(shots.count >= maxShots)
    }
    private func photoButtonLabel(_ label: String) -> some View {
        Text(label).font(.footnote.weight(.semibold)).foregroundStyle(PortalOfficePalette.accentText(scheme))
            .frame(maxWidth: .infinity).padding(.vertical, 11)
            .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous).strokeBorder(Color.primary.opacity(0.08), lineWidth: 1))
            .opacity(shots.count >= maxShots ? 0.4 : 1)
    }

    private func loadPicks(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        loadingPhotos = true
        defer { loadingPhotos = false; picks = [] }
        for it in items {
            if shots.count >= maxShots { break }
            if let data = try? await it.loadTransferable(type: Data.self),
               let ui = UIImage(data: data),
               let jpeg = ui.jpegData(compressionQuality: 0.72) {
                shots.append(jpeg)
            }
        }
    }
}

// MARK: - Camera capture (UIImagePickerController — PhotosPicker can't shoot)

struct StaffCameraPicker: UIViewControllerRepresentable {
    static var available: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }
    let onCapture: (Data?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCapture: onCapture) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let vc = UIImagePickerController()
        vc.sourceType = .camera
        vc.delegate = context.coordinator
        return vc
    }
    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onCapture: (Data?) -> Void
        init(onCapture: @escaping (Data?) -> Void) { self.onCapture = onCapture }
        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            let img = info[.originalImage] as? UIImage
            picker.dismiss(animated: true) { self.onCapture(img?.jpegData(compressionQuality: 0.72)) }
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picker.dismiss(animated: true) { self.onCapture(nil) }
        }
    }
}
