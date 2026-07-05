//
//  ApprovalsSwiftUI.swift
//  ALMA ERP — S6: the Approvals tab as a native SwiftUI screen.
//
//  Same endpoints as the web page (via AlmaAPI's cookie bridge):
//    GET   /api/approvals?status=PENDING&limit=100          → list + counts
//    PATCH /api/approvals/{id}  {action: APPROVE|REJECT, note?}
//  Lessons carried over from the web fixes (build 33): ONE spinner per row (never a
//  global overlay), and REJECT requires a note (server enforces ≥5 chars).
//

import SwiftUI

// MARK: - Model

struct AlmaApproval: Decodable, Identifiable, Equatable {
    let id: String
    let module: String?
    let type: String?
    let entityLabel: String?
    var status: String
    let priority: String?
    let reason: String?
    let createdAt: String?
    let businessName: String?
    let executable: Bool?
    let requester: Requester?

    struct Requester: Decodable, Equatable {
        let name: String?
        let role: String?
    }

    static func == (a: AlmaApproval, b: AlmaApproval) -> Bool { a.id == b.id && a.status == b.status }
}

/// The approvals routes wrap payloads via apiDataSuccess → `{ ok, data: {…} }`
/// (unlike orders, which returns the payload flat) — decode both shapes.
struct ApprovalsListResponse: Decodable {
    let approvals: [AlmaApproval]
    let totalPending: Int?

    private enum Keys: String, CodingKey { case ok, data, approvals, totalPending }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        approvals = (try? c.decode([AlmaApproval].self, forKey: .approvals)) ?? []
        totalPending = try? c.decodeIfPresent(Int.self, forKey: .totalPending)
    }
}

struct ApprovalActionResponse: Decodable {
    let ok: Bool?
    let warning: String?

    private enum Keys: String, CodingKey { case ok, data, warning }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        ok = try? root.decodeIfPresent(Bool.self, forKey: .ok)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        warning = try? c.decodeIfPresent(String.self, forKey: .warning)
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class ApprovalsVM {
    var approvals: [AlmaApproval] = []
    var totalPending = 0
    var statusFilter = "PENDING"          // PENDING | APPROVED | REJECTED
    var loading = false
    var busyIds: Set<String> = []         // per-row spinners, never a global one
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: ApprovalsListResponse = try await AlmaAPI.shared.get(
                "/api/approvals", query: ["status": statusFilter, "limit": "100"])
            approvals = resp.approvals
            totalPending = resp.totalPending ?? 0
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// APPROVE/REJECT one item; the row animates out on success (PENDING view).
    func act(_ approval: AlmaApproval, action: String, note: String? = nil) async {
        busyIds.insert(approval.id)
        defer { busyIds.remove(approval.id) }
        do {
            var body: [String: String] = ["action": action]
            if let note, !note.isEmpty { body["note"] = note }
            let resp: ApprovalActionResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/approvals/\(approval.id)", body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            if let w = resp.warning { error = w }
            withAnimation(.snappy) { approvals.removeAll { $0.id == approval.id } }
            totalPending = max(0, totalPending - 1)
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct ApprovalsScreen: View {
    @State private var vm = ApprovalsVM()
    @State private var rejecting: AlmaApproval? = nil
    @State private var rejectNote = ""
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                filterRow
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                ForEach(vm.approvals) { ap in
                    ApprovalCard(
                        approval: ap,
                        busy: vm.busyIds.contains(ap.id),
                        showActions: vm.statusFilter == "PENDING" && (ap.executable ?? true),
                        onApprove: { Task { await vm.act(ap, action: "APPROVE") } },
                        onReject: { rejecting = ap; rejectNote = "" })
                }
                if !vm.loading && vm.approvals.isEmpty && vm.error == nil && !vm.authExpired {
                    VStack(spacing: 6) {
                        Image(systemName: "checkmark.seal").font(.largeTitle).foregroundStyle(.secondary)
                        Text(vm.statusFilter == "PENDING" ? "সব অনুমোদন সম্পন্ন ✅" : "কিছু নেই")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 70)
                }
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .alert("রিজেক্টের কারণ লিখুন", isPresented: Binding(
            get: { rejecting != nil }, set: { if !$0 { rejecting = nil } })) {
            TextField("কারণ (কমপক্ষে ৫ অক্ষর)", text: $rejectNote)
            Button("Reject", role: .destructive) {
                if let ap = rejecting, rejectNote.trimmingCharacters(in: .whitespaces).count >= 5 {
                    Task { await vm.act(ap, action: "REJECT", note: rejectNote) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("সার্ভার ৫ অক্ষরের কম কারণ নেয় না")
        }
    }

    private var filterRow: some View {
        HStack(spacing: 8) {
            ForEach(["PENDING", "APPROVED", "REJECTED"], id: \.self) { s in
                let active = vm.statusFilter == s
                Button {
                    UISelectionFeedbackGenerator().selectionChanged()
                    vm.statusFilter = s
                    Task { await vm.load() }
                } label: {
                    Text(s.capitalized)
                        .font(.footnote.weight(active ? .semibold : .regular))
                        .padding(.horizontal, 14).padding(.vertical, 7)
                        .background(active ? AnyShapeStyle(.thickMaterial) : AnyShapeStyle(.thinMaterial),
                                    in: Capsule())
                        .overlay(Capsule().strokeBorder(active ? Color.accentColor.opacity(0.5) : .clear))
                }
                .buttonStyle(.plain)
            }
            Spacer()
            if vm.totalPending > 0 && vm.statusFilter == "PENDING" {
                Text("\(vm.totalPending)")
                    .font(.caption.weight(.bold))
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(Color.orange.opacity(0.2), in: Capsule())
            }
        }
        .padding(.top, 4)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    private func errorCard(_ m: String) -> some View {
        Label(m, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Card

@available(iOS 17.0, *)
private struct ApprovalCard: View {
    let approval: AlmaApproval
    let busy: Bool
    let showActions: Bool
    let onApprove: () -> Void
    let onReject: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(approval.module?.replacingOccurrences(of: "_", with: " ") ?? "—")
                    .font(.caption2.weight(.bold))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
                if let p = approval.priority, p == "HIGH" || p == "CRITICAL" {
                    Text(p).font(.caption2.weight(.bold)).foregroundStyle(.red)
                }
                Spacer()
                if let biz = approval.businessName {
                    Text(biz).font(.caption2).foregroundStyle(.secondary)
                }
            }
            Text(approval.entityLabel ?? approval.type ?? "—")
                .font(.subheadline.weight(.semibold))
            if let reason = approval.reason, !reason.isEmpty {
                Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            if let who = approval.requester?.name {
                Label(who, systemImage: "person").font(.caption).foregroundStyle(.secondary)
            }
            if showActions {
                HStack(spacing: 10) {
                    Button(action: onApprove) {
                        if busy { ProgressView().frame(maxWidth: .infinity) }
                        else { Label("Approve", systemImage: "checkmark").frame(maxWidth: .infinity) }
                    }
                    .buttonStyle(.borderedProminent).tint(.green)
                    .disabled(busy)
                    Button(action: onReject) {
                        Label("Reject", systemImage: "xmark").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered).tint(.red)
                    .disabled(busy)
                }
                .padding(.top, 2)
            }
        }
        .padding(14)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }
}

@available(iOS 17.0, *)
#Preview("Approvals — Light") {
    ApprovalsScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
