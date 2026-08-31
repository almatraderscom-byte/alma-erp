//
//  PhoneSwiftUI.swift
//  ALMA ERP — native browser-phone (dialler) screen.
//
//  The owner's ask (2026-08-31): the phone must be a NATIVE iOS page, not an embedded
//  web view. This screen is pure SwiftUI — dialpad, call states, screen-pop, recents,
//  colleague quick-dial — while the SIP/WebRTC audio itself runs in PhoneEngine's
//  hidden headless WebView (the live-proven sip.js stack). See PhoneEngine.swift for
//  the bridge contract.
//
//  Design: ALMA design system — dark aurora wash, glass cards, live coral accent.
//  Recents/colleague taps FILL the number field rather than dialling instantly:
//  an accidental brush must never place a real customer call.
//

import SwiftUI
import UIKit

// MARK: - API models (lenient decoding — a missing field must never kill the screen)

private struct PhoneHistoryRow: Decodable, Identifiable {
    let direction: String?
    let other: String?
    let at: String?
    let seconds: Int?
    let answered: Bool?
    var id: String { "\(at ?? "?")-\(other ?? "?")" }
}
private struct PhoneHistoryResponse: Decodable { let rows: [PhoneHistoryRow]? }

private struct PhoneColleague: Decodable, Identifiable {
    let ext: String
    let name: String?
    var id: String { ext }
}
private struct PhoneColleagueList: Decodable { let staff: [PhoneColleague]? }

private struct PhoneCallerContext: Decodable {
    let found: Bool?
    let name: String?
    let totalOrders: Int?
    let dueAmount: Double?
    let recentCalls: Int?
}

// MARK: - Screen

@available(iOS 17.0, *)
struct PhoneScreen: View {
    let openWeb: (_ path: String, _ title: String) -> Void

    @ObservedObject private var engine = PhoneEngine.shared
    @ObservedObject private var sipCall = SipCallController.shared
    @State private var number = ""
    @State private var dialError: String? = nil
    @State private var nativeMuted = false
    @State private var recents: [PhoneHistoryRow] = []
    @State private var colleagues: [PhoneColleague] = []
    @State private var caller: PhoneCallerContext? = nil
    @State private var callerFetchedFor: String? = nil
    @State private var dtmfOpen = false

    private var accent: Color { Color(uiColor: AlmaTheme.coral) }
    private var live: Bool { engine.state.status == "ringing" || engine.state.status == "in-call" }

    var body: some View {
        ZStack {
            PhoneAurora().ignoresSafeArea()
            ScrollView {
                VStack(spacing: 14) {
                    if let native = sipCall.current {
                        nativeCallCard(native)
                    } else {
                        statusCard
                        if live {
                            liveCallCard
                        } else {
                            diallerCard
                            if !recents.isEmpty { recentsCard }
                            if !colleagues.isEmpty { colleaguesCard }
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
                .padding(.bottom, 28)
            }
        }
        .navigationTitle("ফোন")
        .onAppear {
            engine.ensureLoaded()
            Task { await loadLists() }
            // A call may already be ringing when the user navigates here — the
            // .onChange below never fires for a peer set before appearance.
            Task { await fetchCaller(engine.state.peer) }
        }
        .onChange(of: engine.state.peer) { _, peer in
            Task { await fetchCaller(peer) }
        }
        .onChange(of: engine.state.status) { old, new in
            // Refresh recents when a call finishes, so the row appears like on a handset.
            if (old == "in-call" || old == "ringing") && new == "registered" {
                dtmfOpen = false
                Task { await loadLists() }
            }
        }
    }

    // MARK: status

    private var statusLabel: String {
        switch engine.state.status {
        case "connecting": return "সংযোগ হচ্ছে…"
        case "registered": return "তৈরি"
        case "ringing": return engine.state.incoming ? "কল আসছে" : "রিং হচ্ছে"
        case "in-call": return "কথা চলছে"
        case "error": return "সমস্যা"
        default: return "বন্ধ"
        }
    }
    private var statusColor: Color {
        switch engine.state.status {
        case "in-call": return .green
        case "ringing": return .orange
        case "registered": return .green.opacity(0.75)
        case "error": return .red
        default: return .gray
        }
    }

    private var statusCard: some View {
        HStack(spacing: 10) {
            Circle().fill(statusColor).frame(width: 9, height: 9)
            Text(statusLabel).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
            if let ext = engine.state.ext {
                Text("আপনার নম্বর \(ext)")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.65))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Capsule().fill(.white.opacity(0.08)))
            }
            Spacer()
            if engine.state.status == "idle" || engine.state.status == "error" {
                Button {
                    engine.connect()
                } label: {
                    Text("ফোন চালু করো")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(Capsule().fill(accent))
                }
            } else if !live {
                Button {
                    engine.disconnect()
                } label: {
                    Text("বন্ধ")
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.8))
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(Capsule().stroke(.white.opacity(0.25)))
                }
            }
        }
        .padding(14)
        .background(glass)
    }

    private var idleCard: some View {
        VStack(spacing: 10) {
            if let err = engine.state.error ?? engine.pageError {
                Text(err).font(.footnote).foregroundStyle(.red.opacity(0.9))
                    .multilineTextAlignment(.center)
            }
            Text(engine.state.status == "connecting"
                 ? "ফোনের সাথে যুক্ত হচ্ছে…"
                 : "কল ধরতে বা করতে ফোনটি চালু করুন। প্রথমবার মাইক্রোফোনের অনুমতি চাইবে — একবার দিলেই হবে।")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.6))
                .multilineTextAlignment(.center)
            Button("ওয়েবে খুলুন") { openWeb("/agent/phone", "ফোন") }
                .font(.caption)
                .foregroundStyle(.white.opacity(0.4))
        }
        .frame(maxWidth: .infinity)
        .padding(18)
        .background(glass)
    }

    // MARK: dialler

    private var diallerCard: some View {
        VStack(spacing: 12) {
            if let err = dialError ?? engine.state.error {
                Text(err).font(.footnote).foregroundStyle(.red.opacity(0.9))
            }
            HStack(spacing: 8) {
                TextField("01XXXXXXXXX", text: $number)
                    .keyboardType(.phonePad)
                    .multilineTextAlignment(.center)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.06)))
                if !number.isEmpty {
                    Button {
                        number = String(number.dropLast())
                    } label: {
                        Image(systemName: "delete.left")
                            .foregroundStyle(.white.opacity(0.7))
                            .frame(width: 44, height: 48)
                            .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.06)))
                    }
                    .simultaneousGesture(LongPressGesture(minimumDuration: 0.6).onEnded { _ in number = "" })
                }
            }

            dialpad { key in number.append(key) }

            Button {
                let n = number.trimmingCharacters(in: .whitespaces)
                guard !n.isEmpty else { return }
                dialError = nil
                // Native CallKit leg first (works backgrounded, real call UI); the
                // in-page WebView engine stays as the fallback when the native
                // path is not available (old server, gateway briefly down).
                Task {
                    if let err = await SipCallController.shared.placeOutbound(to: n, display: n) {
                        if engine.state.status == "registered" {
                            engine.dial(n)
                        } else {
                            dialError = err
                        }
                        return
                    }
                    // CallKit accepted the transaction — but if no live call
                    // materialises (Simulator quirk, or CallKit dying silently),
                    // clean the zombie up and fall back so the user still gets
                    // their call instead of a dead button.
                    try? await Task.sleep(nanoseconds: 4_000_000_000)
                    if SipCallController.shared.current == nil {
                        for id in CallKitVoIP.shared.allCallIds() {
                            _ = await CallKitVoIP.shared.requestEnd(callId: id, reason: "start_watchdog")
                        }
                        if engine.state.status == "registered" {
                            engine.dial(n)
                        } else {
                            dialError = "কল শুরু হয়নি — ফোন চালু করে আবার চেষ্টা করুন"
                        }
                    }
                }
            } label: {
                Label("কল করুন", systemImage: "phone.fill")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(RoundedRectangle(cornerRadius: 16).fill(number.isEmpty ? accent.opacity(0.35) : accent))
            }
            .disabled(number.isEmpty)
        }
        .padding(14)
        .background(glass)
    }

    private func dialpad(_ press: @escaping (String) -> Void) -> some View {
        let keys: [[(String, String)]] = [
            [("1", ""), ("2", "ABC"), ("3", "DEF")],
            [("4", "GHI"), ("5", "JKL"), ("6", "MNO")],
            [("7", "PQRS"), ("8", "TUV"), ("9", "WXYZ")],
            [("*", ""), ("0", "+"), ("#", "")],
        ]
        return VStack(spacing: 8) {
            ForEach(0..<keys.count, id: \.self) { r in
                HStack(spacing: 8) {
                    ForEach(keys[r], id: \.0) { key, sub in
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            press(key)
                        } label: {
                            VStack(spacing: 1) {
                                Text(key).font(.title2.weight(.medium)).foregroundStyle(.white)
                                if !sub.isEmpty {
                                    Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.45))
                                }
                            }
                            .frame(maxWidth: .infinity)
                            .frame(height: 56)
                            .background(RoundedRectangle(cornerRadius: 18).fill(.white.opacity(0.06)))
                        }
                    }
                }
            }
        }
    }

    // MARK: live call

    private var liveCallCard: some View {
        VStack(spacing: 12) {
            Text(engine.state.status == "in-call"
                 ? (engine.state.incoming ? "ইনকামিং কল · কথা চলছে" : "কথা চলছে")
                 : engine.state.incoming ? "ইনকামিং কল" : "কল যাচ্ছে")
                .font(.caption.weight(.medium))
                .tracking(2)
                .foregroundStyle(.white.opacity(0.55))

            Text(caller?.name ?? engine.state.peer ?? "—")
                .font(.title.weight(.semibold))
                .foregroundStyle(.white)
            if caller?.name != nil, let peer = engine.state.peer {
                Text(peer).font(.subheadline).foregroundStyle(.white.opacity(0.6))
            }
            Text(engine.state.status == "in-call" ? mmss(engine.state.seconds) : "সংযোগ হচ্ছে…")
                .font(.body.monospacedDigit())
                .foregroundStyle(engine.state.status == "in-call" ? .green : .white.opacity(0.6))

            // Screen-pop: what this caller already means to the business.
            if let c = caller, c.found == true {
                HStack(spacing: 8) {
                    popStat("অর্ডার", "\(c.totalOrders ?? 0)")
                    popStat("বাকি", "৳\(Int(c.dueAmount ?? 0))")
                    popStat("আগের কল", "\(c.recentCalls ?? 0)")
                }
            } else if let c = caller, c.found == false {
                Text("নতুন নম্বর — আগের রেকর্ড নেই")
                    .font(.footnote).foregroundStyle(.white.opacity(0.55))
            }

            if engine.state.status == "in-call" {
                HStack(spacing: 14) {
                    roundControl(engine.state.muted ? "mic.slash.fill" : "mic.fill",
                                 active: engine.state.muted, tint: .orange) {
                        engine.toggleMute()
                    }
                    roundControl("circle.grid.3x3.fill", active: dtmfOpen, tint: accent) {
                        dtmfOpen.toggle()
                    }
                }
                if dtmfOpen {
                    dialpad { key in engine.sendDtmf(key) }
                }
            }

            HStack(spacing: 10) {
                if engine.state.incoming && engine.state.status == "ringing" {
                    Button {
                        engine.answer()
                    } label: {
                        Label("ধরো", systemImage: "phone.fill")
                            .font(.headline).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(RoundedRectangle(cornerRadius: 16).fill(.green))
                    }
                }
                Button {
                    engine.hangup()
                } label: {
                    Label(engine.state.status == "in-call" ? "কল শেষ" : "কেটে দাও",
                          systemImage: "phone.down.fill")
                        .font(.headline).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(RoundedRectangle(cornerRadius: 16).fill(.red))
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(16)
        .background(glass)
    }

    /// Live card for a NATIVE CallKit call (customer leg through the gateway).
    /// CallKit's own lock-screen UI is the primary surface; this keeps the in-app
    /// screen honest and adds the mid-call keypad (bank/courier menus).
    private func nativeCallCard(_ call: SipCallController.CallState) -> some View {
        VStack(spacing: 12) {
            Text(call.connectedAt == nil
                 ? (call.outgoing ? "কল যাচ্ছে" : "সংযোগ হচ্ছে…")
                 : "কথা চলছে")
                .font(.caption.weight(.medium)).tracking(2)
                .foregroundStyle(.white.opacity(0.55))
            Text(call.peer.isEmpty ? "—" : call.peer)
                .font(.title.weight(.semibold)).foregroundStyle(.white)
            if let since = call.connectedAt {
                TimelineView(.periodic(from: since, by: 1)) { ctx in
                    Text(mmss(Int(ctx.date.timeIntervalSince(since))))
                        .font(.body.monospacedDigit()).foregroundStyle(.green)
                }
            } else {
                Text("রিং হচ্ছে…").font(.body).foregroundStyle(.white.opacity(0.6))
            }
            HStack(spacing: 14) {
                roundControl(nativeMuted ? "mic.slash.fill" : "mic.fill",
                             active: nativeMuted, tint: .orange) {
                    nativeMuted.toggle()
                    SipCallController.shared.setMuted(nativeMuted)
                }
                roundControl("circle.grid.3x3.fill", active: dtmfOpen, tint: accent) {
                    dtmfOpen.toggle()
                }
            }
            if dtmfOpen {
                dialpad { key in SipCallController.shared.sendDtmf(key) }
            }
            Button {
                Task { _ = await CallKitVoIP.shared.requestEnd(callId: call.callId, reason: "user_hangup") }
            } label: {
                Label("কল শেষ", systemImage: "phone.down.fill")
                    .font(.headline).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 14)
                    .background(RoundedRectangle(cornerRadius: 16).fill(.red))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(16)
        .background(glass)
        .onDisappear { nativeMuted = false }
    }

    private func popStat(_ label: String, _ value: String) -> some View {
        VStack(spacing: 2) {
            Text(label).font(.system(size: 10)).foregroundStyle(.white.opacity(0.5))
            Text(value).font(.callout.weight(.semibold)).foregroundStyle(.white)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 12).fill(.white.opacity(0.06)))
    }

    private func roundControl(_ icon: String, active: Bool, tint: Color,
                              _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .foregroundStyle(active ? tint : .white)
                .frame(width: 50, height: 50)
                .background(Circle().fill(active ? tint.opacity(0.18) : .white.opacity(0.08)))
                .overlay(Circle().stroke(active ? tint.opacity(0.6) : .white.opacity(0.12)))
        }
    }

    // MARK: recents & colleagues

    private var recentsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("সাম্প্রতিক কল")
                .font(.caption.weight(.medium)).tracking(1.5)
                .foregroundStyle(.white.opacity(0.5))
            VStack(spacing: 0) {
                ForEach(Array(recents.prefix(8).enumerated()), id: \.offset) { i, r in
                    Button {
                        // FILL, don't dial — one brush must never place a real call.
                        if let n = r.other { number = n }
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: r.direction == "inbound"
                                  ? "arrow.down.left" : "arrow.up.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(r.direction == "inbound" ? .green : accent)
                            Text(r.other ?? "অজানা নম্বর")
                                .font(.subheadline)
                                .foregroundStyle(.white)
                            Spacer()
                            VStack(alignment: .trailing, spacing: 1) {
                                Text(r.answered == true ? mmss(r.seconds ?? 0) : "ধরেনি")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(r.answered == true ? .white.opacity(0.7) : .orange.opacity(0.85))
                                if let at = r.at {
                                    Text(shortDate(at))
                                        .font(.system(size: 10))
                                        .foregroundStyle(.white.opacity(0.45))
                                }
                            }
                        }
                        .padding(.vertical, 9)
                    }
                    if i < min(recents.count, 8) - 1 {
                        Divider().overlay(.white.opacity(0.08))
                    }
                }
            }
        }
        .padding(14)
        .background(glass)
    }

    private var colleaguesCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("সহকর্মী — ফ্রি কল")
                .font(.caption.weight(.medium)).tracking(1.5)
                .foregroundStyle(.white.opacity(0.5))
            PhoneChipFlow(items: colleagues.map { ($0.ext, $0.name?.isEmpty == false ? $0.name! : "এক্সটেনশন \($0.ext)") }) { ext in
                number = ext
            }
        }
        .padding(14)
        .background(glass)
    }

    // MARK: helpers

    private var glass: some View {
        RoundedRectangle(cornerRadius: 22)
            .fill(.ultraThinMaterial)
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(.white.opacity(0.09)))
    }

    private func mmss(_ total: Int) -> String {
        "\(total / 60):" + String(format: "%02d", total % 60)
    }
    /// "2026-08-31T16:54:00Z" → "08-31 16:54" (matches the web page's compact form).
    private func shortDate(_ raw: String) -> String {
        let t = raw.replacingOccurrences(of: "T", with: " ")
        guard t.count >= 16 else { return raw }
        let start = t.index(t.startIndex, offsetBy: 5)
        let end = t.index(t.startIndex, offsetBy: 16)
        return String(t[start..<end])
    }

    private func loadLists() async {
        async let hist: PhoneHistoryResponse? = try? AlmaAPI.shared.get("/api/assistant/phone/history")
        async let dial: PhoneColleagueList? = try? AlmaAPI.shared.get("/api/assistant/phone/dial")
        let (h, d) = await (hist, dial)
        await MainActor.run {
            if let rows = h?.rows { recents = rows }
            if let staff = d?.staff {
                colleagues = staff.filter { $0.ext != engine.state.ext }
            }
        }
    }

    private func fetchCaller(_ peer: String?) async {
        guard let peer, engine.state.incoming, callerFetchedFor != peer else {
            if peer == nil { await MainActor.run { caller = nil; callerFetchedFor = nil } }
            return
        }
        callerFetchedFor = peer
        let c: PhoneCallerContext? = try? await AlmaAPI.shared.get(
            "/api/assistant/phone/caller", query: ["number": peer])
        await MainActor.run {
            // A slow lookup must never dress a NEW caller in the previous
            // customer's orders — assign only if this call is still the one live.
            guard engine.state.peer == peer, engine.state.incoming else { return }
            caller = c
        }
    }
}

// MARK: - Small flow-layout chips

@available(iOS 17.0, *)
private struct PhoneChipFlow: View {
    let items: [(key: String, label: String)]
    let tap: (String) -> Void
    var body: some View {
        PhoneChipWrap(spacing: 8) {
            ForEach(items, id: \.key) { item in
                Button {
                    tap(item.key)
                } label: {
                    Text(item.label)
                        .font(.footnote)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(Capsule().fill(.white.opacity(0.07)))
                        .overlay(Capsule().stroke(.white.opacity(0.12)))
                }
            }
        }
    }
}

/// Minimal wrap layout (iOS 16+ Layout protocol) — enough for a row of chips.
@available(iOS 17.0, *)
private struct PhoneChipWrap: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0, x + s.width > width { x = 0; y += rowH + spacing; rowH = 0 }
            x += s.width + spacing
            rowH = max(rowH, s.height)
        }
        return CGSize(width: width == .infinity ? x : width, height: y + rowH)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX, x + s.width > bounds.maxX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            rowH = max(rowH, s.height)
        }
    }
}

// MARK: - Private aurora (per-screen copy, app convention)

@available(iOS 17.0, *)
private struct PhoneAurora: View {
    var body: some View {
        ZStack {
            Color(red: 0.055, green: 0.05, blue: 0.09)
            Circle().fill(Color(uiColor: AlmaTheme.coral).opacity(0.16))
                .frame(width: 380, height: 380).blur(radius: 90)
                .offset(x: -120, y: -260)
            Circle().fill(Color(red: 0.35, green: 0.25, blue: 0.75).opacity(0.18))
                .frame(width: 420, height: 420).blur(radius: 100)
                .offset(x: 150, y: 120)
            Circle().fill(Color(red: 0.1, green: 0.5, blue: 0.45).opacity(0.10))
                .frame(width: 360, height: 360).blur(radius: 90)
                .offset(x: -60, y: 420)
        }
    }
}
