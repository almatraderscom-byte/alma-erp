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
    /// Resolved display name (shared phonebook → customer), when the server knows one.
    let name: String?
    var id: String { "\(at ?? "?")-\(other ?? "?")" }
}
private struct PhoneHistoryResponse: Decodable { let rows: [PhoneHistoryRow]? }

private struct PhoneColleague: Decodable, Identifiable {
    let ext: String
    let name: String?
    var id: String { ext }
}
private struct PhoneColleagueList: Decodable { let staff: [PhoneColleague]? }

private struct PhoneContactRow: Decodable, Identifiable {
    let phone: String
    let name: String
    var id: String { phone }
}
private struct PhoneContactList: Decodable { let contacts: [PhoneContactRow]? }

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
    @State private var contacts: [PhoneContactRow] = []
    @State private var savePhone: String? = nil
    @State private var saveName = ""
    /// Optimistic call card the instant the button is tapped — the server
    /// round-trip used to leave a 3-5 s dead gap before any call UI appeared.
    @State private var placingNumber: String? = nil
    @State private var caller: PhoneCallerContext? = nil
    @State private var callerFetchedFor: String? = nil
    @State private var dtmfOpen = false

    private var accent: Color { Color(uiColor: AlmaTheme.coral) }
    private var live: Bool { engine.state.status == "ringing" || engine.state.status == "in-call" }

    var body: some View {
        ZStack {
            PhoneAurora().ignoresSafeArea()
            if let native = sipCall.current {
                callScreen(
                    peer: native.peer,
                    statusLine: native.connectedAt == nil
                        ? (native.outgoing ? (native.ringing ? "রিং হচ্ছে…" : "কল যাচ্ছে…") : "সংযোগ হচ্ছে…")
                        : "কথা চলছে",
                    connectedAt: native.connectedAt,
                    muted: nativeMuted,
                    onMute: {
                        nativeMuted.toggle()
                        SipCallController.shared.setMuted(nativeMuted)
                    },
                    speakerOn: sipCall.speakerOn,
                    onSpeaker: { SipCallController.shared.setSpeaker(!sipCall.speakerOn) },
                    onDtmf: { SipCallController.shared.sendDtmf($0) },
                    onEnd: {
                        Task {
                            let accepted = await CallKitVoIP.shared.requestEnd(callId: native.callId, reason: "user_hangup")
                            if !accepted { SipCallController.shared.callKitEnded(callId: native.callId) }
                        }
                    })
            } else if let placing = placingNumber {
                callScreen(
                    peer: placing,
                    statusLine: "কল যাচ্ছে…",
                    connectedAt: nil,
                    muted: false, onMute: nil,
                    speakerOn: false, onSpeaker: nil,
                    onDtmf: nil,
                    onEnd: {
                        placingNumber = nil
                        Task {
                            for id in CallKitVoIP.shared.allCallIds() {
                                _ = await CallKitVoIP.shared.requestEnd(callId: id, reason: "user_cancel")
                            }
                        }
                    })
            } else if live {
                callScreen(
                    peer: caller?.name ?? engine.state.peer ?? "—",
                    subtitle: caller?.name != nil ? engine.state.peer : nil,
                    statusLine: engine.state.status == "in-call"
                        ? (engine.state.incoming ? "ইনকামিং কল · কথা চলছে" : "কথা চলছে")
                        : engine.state.incoming ? "কল আসছে" : "কল যাচ্ছে…",
                    connectedAt: nil,
                    seconds: engine.state.status == "in-call" ? engine.state.seconds : nil,
                    muted: engine.state.muted,
                    onMute: { engine.toggleMute() },
                    speakerOn: sipCall.speakerOn,
                    onSpeaker: { SipCallController.shared.setSpeaker(!sipCall.speakerOn) },
                    onDtmf: { engine.sendDtmf($0) },
                    onAnswer: engine.state.incoming && engine.state.status == "ringing"
                        ? { engine.answer() } : nil,
                    onEnd: { engine.hangup() },
                    callerContext: caller)
            } else {
            ScrollView {
                VStack(spacing: 14) {
                    statusCard
                    diallerCard
                    if !contacts.isEmpty { contactsCard }
                    if !recents.isEmpty { recentsCard }
                    if !colleagues.isEmpty { colleaguesCard }
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
                .padding(.bottom, 28)
            }
            }
        }
        .navigationTitle("ফোন")
        .alert("নম্বর সেভ করুন", isPresented: Binding(
            get: { savePhone != nil },
            set: { if !$0 { savePhone = nil } }
        )) {
            TextField("নাম", text: $saveName)
            Button("সেভ") {
                let phone = savePhone ?? ""
                let name = saveName.trimmingCharacters(in: .whitespaces)
                savePhone = nil
                guard !phone.isEmpty, !name.isEmpty else { return }
                Task {
                    struct Req: Encodable { let phone: String; let name: String }
                    struct Resp: Decodable { let ok: Bool? }
                    let r: Resp? = try? await AlmaAPI.shared.send(
                        "POST", "/api/assistant/phone/contacts", body: Req(phone: phone, name: name))
                    if r?.ok == true { await loadLists() }
                }
            }
            Button("বাতিল", role: .cancel) { savePhone = nil }
        } message: {
            Text(savePhone ?? "")
        }
        .onAppear {
            SipCallPillCoordinator.shared.phoneScreenVisible = true
            SipCallPillCoordinator.shared.install()
            engine.ensureLoaded()
            Task { await loadLists() }
            // A call may already be ringing when the user navigates here — the
            // .onChange below never fires for a peer set before appearance.
            Task { await fetchCaller(engine.state.peer) }
        }
        .onChange(of: engine.state.peer) { _, peer in
            Task { await fetchCaller(peer) }
        }
        .onDisappear {
            SipCallPillCoordinator.shared.phoneScreenVisible = false
        }
        .onChange(of: sipCall.current) { _, cur in
            if cur != nil { placingNumber = nil }
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

    // MARK: dialler

    private var diallerCard: some View {
        VStack(spacing: 12) {
            if let err = dialError ?? engine.state.error {
                Text(err).font(.footnote).foregroundStyle(.red.opacity(0.9))
            }
            if let notice = sipCall.lastEndNotice {
                Text(notice)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Capsule().fill(.orange.opacity(0.12)))
            }
            HStack(spacing: 8) {
                TextField("নম্বর লিখুন", text: $number)
                    .keyboardType(.phonePad)
                    .multilineTextAlignment(.center)
                    .font(.system(size: 26, weight: .medium)).monospacedDigit()
                    .foregroundStyle(.white)
                    .padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 16).fill(.white.opacity(0.05)))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.07)))
                if !number.isEmpty {
                    Button {
                        saveName = contacts.first { $0.phone == number }?.name ?? ""
                        savePhone = number
                    } label: {
                        Image(systemName: "person.crop.circle.badge.plus")
                            .foregroundStyle(.white.opacity(0.7))
                            .frame(width: 44, height: 48)
                            .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.06)))
                    }
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
                placingNumber = n
                // Native CallKit leg first (works backgrounded, real call UI); the
                // in-page WebView engine stays as the fallback when the native
                // path is not available (old server, gateway briefly down).
                Task {
                    if let err = await SipCallController.shared.placeOutbound(to: n, display: n) {
                        placingNumber = nil
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
                        placingNumber = nil
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
                ZStack {
                    Circle()
                        .fill(number.isEmpty ? Color.green.opacity(0.3) : Color.green)
                        .frame(width: 70, height: 70)
                        .shadow(color: number.isEmpty ? .clear : .green.opacity(0.4), radius: 12, y: 4)
                    Image(systemName: "phone.fill")
                        .font(.system(size: 26)).foregroundStyle(.white)
                }
            }
            .disabled(number.isEmpty)
            .frame(maxWidth: .infinity)
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
        return VStack(spacing: 12) {
            ForEach(0..<keys.count, id: \.self) { r in
                HStack(spacing: 24) {
                    ForEach(keys[r], id: \.0) { key, sub in
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            press(key)
                        } label: {
                            VStack(spacing: 1) {
                                Text(key).font(.system(size: 28, weight: .regular)).foregroundStyle(.white)
                                if !sub.isEmpty {
                                    Text(sub).font(.system(size: 9, weight: .medium)).tracking(1.5)
                                        .foregroundStyle(.white.opacity(0.45))
                                }
                            }
                            .frame(width: 74, height: 74)
                            .background(Circle().fill(.white.opacity(0.07)))
                            .overlay(Circle().stroke(.white.opacity(0.06)))
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: live call


    /// The call screen — one professional full-height view for every live state
    /// (native CallKit leg, optimistic placing, and the in-page engine): status
    /// line, glass avatar, name/number, timer, control row, big round end button.
    private func callScreen(
        peer: String,
        subtitle: String? = nil,
        statusLine: String,
        connectedAt: Date?,
        seconds: Int? = nil,
        muted: Bool,
        onMute: (() -> Void)?,
        speakerOn: Bool,
        onSpeaker: (() -> Void)?,
        onDtmf: ((String) -> Void)?,
        onAnswer: (() -> Void)? = nil,
        onEnd: @escaping () -> Void,
        callerContext: PhoneCallerContext? = nil
    ) -> some View {
        VStack(spacing: 0) {
            Spacer().frame(height: 22)
            Text(statusLine)
                .font(.footnote.weight(.medium)).tracking(2.5)
                .foregroundStyle(accent.opacity(0.95))

            Spacer().frame(height: 26)
            ZStack {
                Circle().fill(.ultraThinMaterial).frame(width: 108, height: 108)
                Circle().stroke(.white.opacity(0.14), lineWidth: 1).frame(width: 108, height: 108)
                if let first = peer.first(where: { $0.isLetter }) {
                    Text(String(first)).font(.system(size: 44, weight: .semibold))
                        .foregroundStyle(.white)
                } else {
                    Image(systemName: "person.fill")
                        .font(.system(size: 42)).foregroundStyle(.white.opacity(0.85))
                }
            }
            .padding(.bottom, 18)

            Text(peer.isEmpty ? "অজানা নম্বর" : peer)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(1).minimumScaleFactor(0.6)
                .padding(.horizontal, 24)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle).font(.subheadline)
                    .foregroundStyle(.white.opacity(0.55)).padding(.top, 2)
            }

            Group {
                if let since = connectedAt {
                    TimelineView(.periodic(from: since, by: 1)) { ctx in
                        Text(mmss(Int(ctx.date.timeIntervalSince(since))))
                    }
                } else if let seconds {
                    Text(mmss(seconds))
                } else {
                    Text(statusLine.contains("রিং") ? "রিং হচ্ছে…" : " ")
                }
            }
            .font(.title3.monospacedDigit().weight(.light))
            .foregroundStyle(connectedAt != nil || seconds != nil ? .green : .white.opacity(0.5))
            .padding(.top, 10)

            if let c = callerContext, c.found == true {
                HStack(spacing: 10) {
                    callStat("অর্ডার", "\(c.totalOrders ?? 0)")
                    callStat("বাকি", "৳\(Int(c.dueAmount ?? 0))")
                    callStat("আগের কল", "\(c.recentCalls ?? 0)")
                }
                .padding(.horizontal, 32).padding(.top, 18)
            }

            Spacer()

            if dtmfOpen, let onDtmf {
                dialpad { key in onDtmf(key) }
                    .padding(.horizontal, 40)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if onMute != nil || onDtmf != nil || onSpeaker != nil {
                HStack(spacing: 34) {
                    if let onMute {
                        callControl(muted ? "mic.slash.fill" : "mic.fill",
                                    label: "মিউট", active: muted, action: onMute)
                    }
                    if onDtmf != nil {
                        callControl("circle.grid.3x3.fill", label: "কিপ্যাড",
                                    active: dtmfOpen) {
                            withAnimation(.spring(duration: 0.35)) { dtmfOpen.toggle() }
                        }
                    }
                    if let onSpeaker {
                        callControl("speaker.wave.2.fill", label: "স্পিকার",
                                    active: speakerOn, action: onSpeaker)
                    }
                }
                .padding(.top, 14)
            }

            HStack(spacing: 44) {
                if let onAnswer {
                    Button(action: onAnswer) {
                        ZStack {
                            Circle().fill(.green).frame(width: 74, height: 74)
                                .shadow(color: .green.opacity(0.45), radius: 14, y: 5)
                            Image(systemName: "phone.fill")
                                .font(.system(size: 28)).foregroundStyle(.white)
                        }
                    }
                }
                Button(action: onEnd) {
                    ZStack {
                        Circle().fill(.red).frame(width: 74, height: 74)
                            .shadow(color: .red.opacity(0.45), radius: 14, y: 5)
                        Image(systemName: "phone.down.fill")
                            .font(.system(size: 28)).foregroundStyle(.white)
                    }
                }
            }
            .padding(.top, 26)
            .padding(.bottom, 44)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func callStat(_ label: String, _ value: String) -> some View {
        VStack(spacing: 3) {
            Text(value).font(.callout.weight(.semibold)).foregroundStyle(.white)
            Text(label).font(.system(size: 10)).foregroundStyle(.white.opacity(0.5))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(.white.opacity(0.08)))
    }

    private func callControl(_ icon: String, label: String, active: Bool,
                             action: @escaping () -> Void) -> some View {
        VStack(spacing: 7) {
            Button(action: action) {
                ZStack {
                    Circle()
                        .fill(active ? AnyShapeStyle(.white) : AnyShapeStyle(.ultraThinMaterial))
                        .frame(width: 62, height: 62)
                    Circle().stroke(.white.opacity(active ? 0 : 0.16))
                        .frame(width: 62, height: 62)
                    Image(systemName: icon)
                        .font(.system(size: 22))
                        .foregroundStyle(active ? .black : .white)
                }
            }
            Text(label).font(.system(size: 11)).foregroundStyle(.white.opacity(0.65))
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
                            VStack(alignment: .leading, spacing: 1) {
                                Text(r.name ?? r.other ?? "অজানা নম্বর")
                                    .font(.subheadline)
                                    .foregroundStyle(.white)
                                if r.name != nil, let num = r.other {
                                    Text(num).font(.system(size: 10))
                                        .foregroundStyle(.white.opacity(0.45))
                                }
                            }
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
                    .contextMenu {
                        if let num = r.other {
                            Button {
                                saveName = r.name ?? ""
                                savePhone = num
                            } label: {
                                Label("নাম দিয়ে সেভ করো", systemImage: "person.crop.circle.badge.plus")
                            }
                        }
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

    private var contactsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("সেভ করা নম্বর")
                .font(.caption.weight(.medium)).tracking(1.5)
                .foregroundStyle(.white.opacity(0.5))
            VStack(spacing: 0) {
                ForEach(Array(contacts.prefix(12).enumerated()), id: \.offset) { i, c in
                    Button {
                        number = c.phone
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "person.crop.circle")
                                .font(.footnote)
                                .foregroundStyle(accent)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(c.name).font(.subheadline).foregroundStyle(.white)
                                Text(c.phone).font(.system(size: 10))
                                    .foregroundStyle(.white.opacity(0.45))
                            }
                            Spacer()
                        }
                        .padding(.vertical, 8)
                    }
                    .contextMenu {
                        Button {
                            saveName = c.name
                            savePhone = c.phone
                        } label: {
                            Label("এডিট করো", systemImage: "pencil")
                        }
                        Button(role: .destructive) {
                            Task {
                                struct Req: Encodable { let phone: String }
                                struct Resp: Decodable { let ok: Bool? }
                                let _: Resp? = try? await AlmaAPI.shared.send(
                                    "DELETE", "/api/assistant/phone/contacts", body: Req(phone: c.phone))
                                await loadLists()
                            }
                        } label: {
                            Label("মুছে ফেলো", systemImage: "trash")
                        }
                    }
                    if i < min(contacts.count, 12) - 1 {
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
        async let book: PhoneContactList? = try? AlmaAPI.shared.get("/api/assistant/phone/contacts")
        let (h, d, b) = await (hist, dial, book)
        await MainActor.run {
            if let rows = h?.rows { recents = rows }
            if let staff = d?.staff {
                colleagues = staff.filter { $0.ext != engine.state.ext }
            }
            if let saved = b?.contacts { contacts = saved }
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
