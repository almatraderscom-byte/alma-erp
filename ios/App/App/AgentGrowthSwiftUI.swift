//
//  AgentGrowthSwiftUI.swift
//  ALMA ERP — the Growth tab (/agent/growth) as a native SwiftUI screen.
//
//  Mirrors the web Growth — Connections page 1:1 — same endpoints, same blocks:
//    GET /api/assistant/growth/gsc-status      → Google Search Console connection
//    GET /api/assistant/growth/feature-status  → live feature board (GA4 / GBP /
//                                                 IndexNow / SMS / Email / safety)
//  Read-only by design: connect/disconnect (OAuth) and every action stays on the
//  web escape hatch. Web-parity blocks: GSC card (configured / connected / sites) ·
//  গ্রোথ ফিচার স্ট্যাটাস board with tone dots (সবুজ/হলুদ/নীল) · Bangla detail strings
//  verbatim · amber/red anomaly strips. Carried lessons: lenient decoding, ONE
//  independent loading state per block (the web loads the two cards independently).
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum AgentGrowthPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    // Web StatusRow dots + Google brand blue (bg-emerald-400 / bg-sky-400 / bg-amber-400 / #4285F4)
    static let emerald400 = Color(red: 0.204, green: 0.827, blue: 0.600)     // #34D399
    static let sky400 = Color(red: 0.220, green: 0.741, blue: 0.973)         // #38BDF8
    static let amber400 = Color(red: 0.984, green: 0.749, blue: 0.141)       // #FBBF24
    static let googleBlue = Color(red: 0.259, green: 0.522, blue: 0.957)     // #4285F4

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

/// Web StatusRow tone: ok = emerald dot · pending = sky dot · warn = amber dot.
enum AgentGrowthTone {
    case ok, pending, warn

    var dot: Color {
        switch self {
        case .ok: return AgentGrowthPalette.emerald400
        case .pending: return AgentGrowthPalette.sky400
        case .warn: return AgentGrowthPalette.amber400
        }
    }
}

// MARK: - Models (same field names the web page types declare)

/// GET /api/assistant/growth/gsc-status → web GscStatus.
struct AgentGrowthGscStatus: Decodable, Equatable {
    let configured: Bool
    let connected: Bool
    let email: String?
    let connectedAt: String?
    let sites: [String]?
    let sitesError: String?

    private enum Keys: String, CodingKey {
        case configured, connected, email, connectedAt, sites, sitesError
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        configured = (try? c.decodeIfPresent(Bool.self, forKey: .configured)) ?? false
        connected = (try? c.decodeIfPresent(Bool.self, forKey: .connected)) ?? false
        email = try? c.decodeIfPresent(String.self, forKey: .email)
        connectedAt = try? c.decodeIfPresent(String.self, forKey: .connectedAt)
        sites = try? c.decodeIfPresent([String].self, forKey: .sites)
        sitesError = try? c.decodeIfPresent(String.self, forKey: .sitesError)
    }
}

/// GET /api/assistant/growth/feature-status → web FeatureStatus (features 1–8 board).
struct AgentGrowthFeatureStatus: Decodable, Equatable {
    let generatedAt: String?
    let gscConnected: Bool
    let ga4: GA4
    let gbp: GBP
    let indexnow: IndexNow
    let sms: SMS
    let email: Email
    let finalSubmitServerLayer: Bool

    struct GA4: Decodable, Equatable {
        let state: String
        let propertyId: String?
        let sessions7d: Int?
        let error: String?

        private enum Keys: String, CodingKey { case state, propertyId, sessions7d, error }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "error"
            propertyId = try? c.decodeIfPresent(String.self, forKey: .propertyId)
            sessions7d = AgentGrowthFlex.int(c, .sessions7d)
            error = try? c.decodeIfPresent(String.self, forKey: .error)
        }
        init(state: String, propertyId: String?, sessions7d: Int?, error: String?) {
            self.state = state; self.propertyId = propertyId
            self.sessions7d = sessions7d; self.error = error
        }
    }

    struct GBP: Decodable, Equatable {
        let state: String
        let location: String?
        let error: String?

        private enum Keys: String, CodingKey { case state, location, error }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "error"
            location = try? c.decodeIfPresent(String.self, forKey: .location)
            error = try? c.decodeIfPresent(String.self, forKey: .error)
        }
    }

    struct IndexNow: Decodable, Equatable {
        let state: String
        let keyFileLive: Bool

        private enum Keys: String, CodingKey { case state, keyFileLive }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "error"
            keyFileLive = (try? c.decodeIfPresent(Bool.self, forKey: .keyFileLive)) ?? false
        }
    }

    /// campaigns.sms — balance arrives as a string server-side; decode any scalar.
    struct SMS: Decodable, Equatable {
        let state: String
        let balance: String?
        let error: String?

        private enum Keys: String, CodingKey { case state, balance, error }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "error"
            balance = AgentGrowthFlex.string(c, .balance)
            error = try? c.decodeIfPresent(String.self, forKey: .error)
        }
    }

    struct Email: Decodable, Equatable {
        let state: String
        let domain: String?

        private enum Keys: String, CodingKey { case state, domain }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "error"
            domain = try? c.decodeIfPresent(String.self, forKey: .domain)
        }
    }

    private struct Campaigns: Decodable {
        let sms: SMS?
        let email: Email?
    }
    private struct FinalSubmitBan: Decodable {
        let serverLayer: Bool?
    }

    private enum Keys: String, CodingKey {
        case generatedAt, gscConnected, ga4, gbp, indexnow, campaigns, finalSubmitBan
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        generatedAt = try? c.decodeIfPresent(String.self, forKey: .generatedAt)
        gscConnected = (try? c.decodeIfPresent(Bool.self, forKey: .gscConnected)) ?? false
        ga4 = (try? c.decodeIfPresent(GA4.self, forKey: .ga4))
            ?? GA4(state: "error", propertyId: nil, sessions7d: nil, error: nil)
        gbp = (try? c.decodeIfPresent(GBP.self, forKey: .gbp)) ?? Self.emptyGBP()
        indexnow = (try? c.decodeIfPresent(IndexNow.self, forKey: .indexnow)) ?? Self.emptyIndexNow()
        let camp = try? c.decodeIfPresent(Campaigns.self, forKey: .campaigns)
        sms = camp?.sms ?? Self.emptySMS()
        email = camp?.email ?? Self.emptyEmail()
        finalSubmitServerLayer =
            ((try? c.decodeIfPresent(FinalSubmitBan.self, forKey: .finalSubmitBan))?.serverLayer) ?? true
    }

    // Lenient fallbacks when a whole sub-object is missing/misshapen.
    private static func emptyGBP() -> GBP {
        (try? JSONDecoder().decode(GBP.self, from: Data("{}".utf8)))
            ?? GBP(state: "error", location: nil, error: nil)
    }
    private static func emptyIndexNow() -> IndexNow {
        (try? JSONDecoder().decode(IndexNow.self, from: Data("{}".utf8)))
            ?? IndexNow(state: "error", keyFileLive: false)
    }
    private static func emptySMS() -> SMS {
        (try? JSONDecoder().decode(SMS.self, from: Data("{}".utf8)))
            ?? SMS(state: "error", balance: nil, error: nil)
    }
    private static func emptyEmail() -> Email {
        (try? JSONDecoder().decode(Email.self, from: Data("{}".utf8)))
            ?? Email(state: "error", domain: nil)
    }
}

// Memberwise escapes for the lenient fallbacks above.
extension AgentGrowthFeatureStatus.GBP {
    init(state: String, location: String?, error: String?) {
        self.state = state; self.location = location; self.error = error
    }
}
extension AgentGrowthFeatureStatus.IndexNow {
    init(state: String, keyFileLive: Bool) {
        self.state = state; self.keyFileLive = keyFileLive
    }
}
extension AgentGrowthFeatureStatus.SMS {
    init(state: String, balance: String?, error: String?) {
        self.state = state; self.balance = balance; self.error = error
    }
}
extension AgentGrowthFeatureStatus.Email {
    init(state: String, domain: String?) {
        self.state = state; self.domain = domain
    }
}

/// Flexible scalar decoding — API fields occasionally shift between number/string.
private enum AgentGrowthFlex {
    static func int<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
    static func string<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> String? {
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return s }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return String(i) }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) {
            return d == d.rounded() ? String(Int(d)) : String(d)
        }
        return nil
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class AgentGrowthVM {
    var gsc: AgentGrowthGscStatus? = nil
    var features: AgentGrowthFeatureStatus? = nil
    var loading = false            // GSC card (web `loading`)
    var featuresLoading = false    // feature board loads independently (web parity)
    var error: String? = nil
    var authExpired = false

    /// Same order as the web: GSC status first, then the slower live-probe board —
    /// the second fetch never holds up the first card.
    func load() async {
        loading = true
        error = nil
        do {
            let resp: AgentGrowthGscStatus = try await AlmaAPI.shared.get(
                "/api/assistant/growth/gsc-status")
            gsc = resp
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
            loading = false
            return
        } catch {
            if Self.isCancellation(error) { loading = false; return }
            self.error = "স্ট্যাটাস আনা যায়নি — পেজ রিফ্রেশ করুন।"
        }
        loading = false

        featuresLoading = true
        defer { featuresLoading = false }
        do {
            let resp: AgentGrowthFeatureStatus = try await AlmaAPI.shared.get(
                "/api/assistant/growth/feature-status")
            features = resp
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }
            // The board shows its own inline warn line when `features` stays nil.
        }
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct AgentGrowthScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = AgentGrowthVM()
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                intro
                if vm.authExpired { authCard }
                if let err = vm.error { warnCard(err) }
                summaryChips
                gscCard
                featureBoard
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(AgentGrowthAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }

    // ── Header intro (web subtitle, verbatim) ──

    private var intro: some View {
        Text("এখান থেকে Google-এর ফ্রি ডেটা সোর্সগুলো একবার যুক্ত করুন। যুক্ত হলে এজেন্ট আসল search ডেটা দিয়ে SEO সিদ্ধান্ত নিতে পারবে (Oxylabs খরচ ছাড়াই)।")
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
    }

    // ── Tone summary chips (native strip: সবুজ = চলছে · হলুদ = কাজ বাকি · নীল = অপেক্ষা) ──

    private var tones: [AgentGrowthTone] {
        guard let f = vm.features else { return [] }
        return [
            f.gscConnected ? .ok : .warn,
            f.ga4.state == "ok" ? .ok : .warn,
            f.gbp.state == "ok" ? .ok : (f.gbp.state == "pending_google" ? .pending : .warn),
            f.indexnow.state == "ok" ? .ok : .warn,
            f.sms.state == "ok" ? .ok : .warn,
            f.email.state == "ok" ? .ok : .warn,
            .ok, // Final-submit safety — always on when the route answers.
        ]
    }

    @ViewBuilder private var summaryChips: some View {
        if !tones.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    toneChip("চলছে", count: tones.filter { $0 == .ok }.count, tone: .ok)
                    toneChip("কাজ বাকি", count: tones.filter { $0 == .warn }.count, tone: .warn)
                    toneChip("অপেক্ষায়", count: tones.filter { $0 == .pending }.count, tone: .pending)
                }
                .padding(.horizontal, 2)
                .padding(.vertical, 1)
            }
        }
    }

    private func toneChip(_ label: String, count: Int, tone: AgentGrowthTone) -> some View {
        HStack(spacing: 6) {
            Circle().fill(tone.dot).frame(width: 8, height: 8)
            Text(label).font(.footnote.weight(.semibold))
            Text("\(count)")
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(tone.dot)
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45), in: Capsule())
        .overlay(Capsule().strokeBorder(
            Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4), lineWidth: 1))
    }

    // ── Google Search Console card (web card parity) ──

    private var gscCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(AgentGrowthPalette.googleBlue)
                    .frame(width: 36, height: 36)
                    .background(AgentGrowthPalette.googleBlue.opacity(0.10),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Google Search Console").font(.footnote.weight(.bold))
                    Text("আসল Google search ডেটা — impressions, clicks, position, top queries")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            gscBody
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .agentGrowthGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    @ViewBuilder private var gscBody: some View {
        if vm.loading && vm.gsc == nil {
            Text("লোড হচ্ছে…").font(.caption).foregroundStyle(.secondary)
        } else if let gsc = vm.gsc {
            if !gsc.configured {
                amberBox("OAuth client সেট করা নেই। Vercel-এ GSC_CLIENT_ID ও GSC_CLIENT_SECRET সেট করুন (অথবা বিদ্যমান GOOGLE_DRIVE_CLIENT_ID/SECRET রি-ইউজ হবে)।")
            } else if gsc.connected {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("যুক্ত আছে ✓")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(AgentGrowthPalette.emerald400)
                            if let email = gsc.email {
                                Text(email).font(.caption2)
                                    .foregroundStyle(AgentGrowthPalette.emerald400.opacity(0.7))
                                    .lineLimit(1)
                            }
                        }
                        Spacer()
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(AgentGrowthPalette.emerald400)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(AgentGrowthPalette.emerald400.opacity(0.07),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                        .strokeBorder(AgentGrowthPalette.emerald400.opacity(0.25), lineWidth: 1))

                    if let err = gsc.sitesError {
                        Text("Property তালিকা আনা যায়নি: \(err)")
                            .font(.caption2).foregroundStyle(AgentGrowthPalette.amber400)
                    } else if let sites = gsc.sites, !sites.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("PROPERTIES")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                            ForEach(sites, id: \.self) { s in
                                Text(s)
                                    .font(.caption2.monospaced())
                                    .lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 8).padding(.vertical, 5)
                                    .background(Color.white.opacity(colorScheme == .dark ? 0.06 : 0.35),
                                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                            }
                        }
                    } else {
                        Text("এই account-এ কোনো Search Console property নেই।")
                            .font(.caption2).foregroundStyle(AgentGrowthPalette.amber400)
                    }
                }
            } else {
                // Connect = Google OAuth redirect — must run in the web view.
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    openWeb("/agent/growth", "Growth")
                } label: {
                    Text("Google Search Console যুক্ত করুন")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AgentGrowthPalette.googleBlue)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(AgentGrowthPalette.googleBlue.opacity(0.08), in: Capsule())
                        .overlay(Capsule().strokeBorder(
                            AgentGrowthPalette.googleBlue.opacity(0.30), lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        } else if !vm.loading {
            Text("স্ট্যাটাস আনা যায়নি — পেজ রিফ্রেশ করুন।")
                .font(.caption).foregroundStyle(AgentGrowthPalette.amber400)
        }
    }

    // ── Growth feature status board (web Features 1–8 board, verbatim strings) ──

    private var featureBoard: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text("গ্রোথ ফিচার স্ট্যাটাস").font(.footnote.weight(.bold))
                Text("সব integration-এর এখনকার আসল অবস্থা — সবুজ = চলছে, হলুদ = আপনার একটা কাজ বাকি, নীল = অন্যের অনুমোদনের অপেক্ষা।")
                    .font(.caption2).foregroundStyle(.secondary)
            }

            if vm.featuresLoading && vm.features == nil {
                loadingRows
            } else if let f = vm.features {
                AgentGrowthStatusRow(
                    tone: f.gscConnected ? .ok : .warn, icon: "🔍",
                    title: "Search Console (SEO ডেটা)",
                    detail: f.gscConnected ? "যুক্ত আছে — আসল search ডেটা আসছে।" : "যুক্ত নেই।",
                    action: f.gscConnected ? nil : "উপরের বাটন থেকে connect করুন")
                AgentGrowthStatusRow(
                    tone: f.ga4.state == "ok" ? .ok : .warn, icon: "📊",
                    title: "Google Analytics (ট্রাফিক ও ROI)",
                    detail: ga4Detail(f.ga4),
                    critical: f.ga4.state == "error")
                AgentGrowthStatusRow(
                    tone: f.gbp.state == "ok" ? .ok : (f.gbp.state == "pending_google" ? .pending : .warn),
                    icon: "📍",
                    title: "Business Profile (Google রিভিউ)",
                    detail: gbpDetail(f.gbp),
                    action: f.gbp.state == "pending_google"
                        ? "Google-এর access form (project 207682606576)" : nil,
                    critical: f.gbp.state == "error")
                AgentGrowthStatusRow(
                    tone: f.indexnow.state == "ok" ? .ok : .warn, icon: "⚡",
                    title: "IndexNow (দ্রুত re-crawl)",
                    detail: indexnowDetail(f.indexnow))
                AgentGrowthStatusRow(
                    tone: f.sms.state == "ok" ? .ok : .warn, icon: "📱",
                    title: "SMS ক্যাম্পেইন (sms.net.bd)",
                    detail: smsDetail(f.sms),
                    critical: f.sms.state == "bad_key")
                AgentGrowthStatusRow(
                    tone: f.email.state == "ok" ? .ok : .warn, icon: "📧",
                    title: "Email ক্যাম্পেইন (Resend)",
                    detail: emailDetail(f.email),
                    action: ["sandbox", "send_only"].contains(f.email.state)
                        ? "Resend → Domains → Add almatraders.com" : nil,
                    critical: f.email.state == "bad_key")
                AgentGrowthStatusRow(
                    tone: .ok, icon: "🛡️",
                    title: "Final-submit নিরাপত্তা (ব্রাউজার)",
                    detail: "Send/Pay/Delete-জাতীয় শেষ বাটন এজেন্ট আর চাপতে পারে না — কোড-লেভেলে ব্লক (server লেয়ার চালু)। Extension লেয়ারের জন্য chrome://extensions-এ একবার Reload।")
                if let stamp = AgentGrowthFormat.dateTime(f.generatedAt) {
                    Text("লাইভ স্ট্যাটাস: \(stamp)")
                        .font(.caption2).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            } else if vm.featuresLoading {
                Text("লাইভ স্ট্যাটাস আনা হচ্ছে…").font(.caption).foregroundStyle(.secondary)
            } else if !vm.authExpired {
                Text("স্ট্যাটাস আনা যায়নি — পেজ রিফ্রেশ করুন।")
                    .font(.caption).foregroundStyle(AgentGrowthPalette.amber400)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .agentGrowthGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // Web detail strings, verbatim per state.

    private func ga4Detail(_ g: AgentGrowthFeatureStatus.GA4) -> String {
        switch g.state {
        case "ok":
            return "চলছে — গত ৭ দিনে \(g.sessions7d ?? 0)টি ভিজিট (property \(g.propertyId ?? "—"))।"
        case "needs_env": return "GA4_PROPERTY_ID সেট করা নেই।"
        case "needs_reconnect": return "Analytics permission নেই — আবার connect করুন।"
        case "needs_connect": return "Google connect করা নেই।"
        case "timeout": return "Google সাড়া দিচ্ছে না (timeout) — একটু পরে রিফ্রেশ করুন।"
        default: return "সমস্যা: \(g.error ?? "অজানা")"
        }
    }

    private func gbpDetail(_ g: AgentGrowthFeatureStatus.GBP) -> String {
        switch g.state {
        case "ok": return "চলছে — location: \(g.location?.isEmpty == false ? g.location! : "পাওয়া গেছে")।"
        case "pending_google":
            return "কোড রেডি — Google-এর API access অনুমোদনের অপেক্ষায় (form submit করলে কয়েক দিনে চালু হবে)।"
        case "needs_reconnect": return "Business Profile permission নেই — আবার connect করুন।"
        case "no_location": return "এই Google account-এ কোনো Business Profile নেই।"
        case "needs_connect": return "Google connect করা নেই।"
        case "timeout": return "Google সাড়া দিচ্ছে না (timeout) — একটু পরে রিফ্রেশ করুন।"
        default: return "সমস্যা: \(g.error ?? "অজানা")"
        }
    }

    private func indexnowDetail(_ i: AgentGrowthFeatureStatus.IndexNow) -> String {
        switch i.state {
        case "ok": return "চলছে — key file লাইভ, SEO ফিক্সের পর Bing/Yandex সাথে সাথে জানবে।"
        case "needs_env": return "INDEXNOW_KEY সেট করা নেই।"
        default: return "Key file storefront-এ পাওয়া যাচ্ছে না।"
        }
    }

    private func smsDetail(_ s: AgentGrowthFeatureStatus.SMS) -> String {
        switch s.state {
        case "ok":
            let bal = s.balance.map { ", ব্যালেন্স ৳\($0)" } ?? ""
            return "চলছে — key যাচাই হয়েছে\(bal)।"
        case "needs_env": return "SMS_API_KEY সেট করা নেই।"
        case "bad_key": return "Key কাজ করছে না: \(s.error ?? "provider error")"
        default: return "Provider সাড়া দিচ্ছে না (timeout) — একটু পরে রিফ্রেশ করুন।"
        }
    }

    private func emailDetail(_ e: AgentGrowthFeatureStatus.Email) -> String {
        switch e.state {
        case "ok": return "চলছে — domain verified (\(e.domain ?? "—")), কাস্টমারদের পাঠানো যাবে।"
        case "sandbox":
            return "Sandbox mode — শুধু নিজের ঠিকানায় যায়। কাস্টমারদের পাঠাতে Resend-এ almatraders.com verify করুন।"
        case "send_only":
            return "Key কাজ করছে (send-only) — পাঠানো যায়, তবে domain state check করা যায় না। কাস্টমারদের পাঠাতে Resend-এ almatraders.com verify করুন।"
        case "needs_env": return "RESEND_API_KEY সেট করা নেই।"
        case "bad_key": return "Resend key কাজ করছে না।"
        default: return "Resend সাড়া দিচ্ছে না (timeout) — একটু পরে রিফ্রেশ করুন।"
        }
    }

    // ── Shared bits ──

    private func amberBox(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(AgentGrowthPalette.amber600)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(AgentGrowthPalette.amber500.opacity(0.07),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                .strokeBorder(AgentGrowthPalette.amber500.opacity(0.25), lineWidth: 1))
    }

    private func warnCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(AgentGrowthPalette.amber600)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).agentGrowthGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .agentGrowthGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 62)
                .agentGrowthGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                .agentGrowthShimmer()
        }
    }

    /// Connect / disconnect (OAuth) and every write stays on the web page.
    private var webEscape: some View {
        Button {
            openWeb("/agent/growth", "Growth")
        } label: {
            Label("সংযোগ যুক্ত/বিচ্ছিন্ন করতে — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Status row (web StatusRow parity: dot + emoji + title + detail + action hint)

@available(iOS 17.0, *)
private struct AgentGrowthStatusRow: View {
    let tone: AgentGrowthTone
    let icon: String
    let title: String
    let detail: String
    var action: String? = nil
    /// bad_key / hard-error states read red instead of the muted detail colour.
    var critical: Bool = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(icon).font(.system(size: 15)).padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Circle().fill(tone.dot).frame(width: 8, height: 8)
                    Text(title).font(.caption.weight(.bold))
                }
                Text(detail)
                    .font(.caption2)
                    .lineSpacing(2)
                    .foregroundStyle(critical ? AgentGrowthPalette.red500 : Color.secondary)
                if let action {
                    Text("→ \(action)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(AgentGrowthPalette.amber400)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 9)
        .background(Color.white.opacity(colorScheme == .dark ? 0.05 : 0.30),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }
}

// MARK: - Formatting helpers

private enum AgentGrowthFormat {
    /// ISO stamp → "5/7/2026, 8:50 PM" style in Asia/Dhaka (web toLocaleString parity).
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
}

// MARK: - Aurora background + glass (Growth-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct AgentGrowthAurora: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            if scheme == .dark {
                LinearGradient(stops: [
                    .init(color: Color(red: 0.075, green: 0.063, blue: 0.196), location: 0.0),  // deep indigo
                    .init(color: Color(red: 0.216, green: 0.125, blue: 0.439), location: 0.32), // violet
                    .init(color: Color(red: 0.478, green: 0.176, blue: 0.494), location: 0.62), // purple-magenta
                    .init(color: Color(red: 0.706, green: 0.255, blue: 0.404), location: 1.0),  // pink
                ], startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [AlmaSwiftTheme.violet.opacity(0.35), .clear],
                               center: .init(x: 0.15, y: 0.18), startRadius: 10, endRadius: 420)
                RadialGradient(colors: [Color(red: 0.93, green: 0.42, blue: 0.55).opacity(0.30), .clear],
                               center: .init(x: 0.9, y: 0.85), startRadius: 20, endRadius: 480)
            } else {
                AlmaSwiftTheme.rootBg(.light)
                LinearGradient(stops: [
                    .init(color: Color(red: 0.902, green: 0.882, blue: 0.973), location: 0.0),  // pale violet
                    .init(color: Color(red: 0.949, green: 0.941, blue: 0.972), location: 0.45), // cream
                    .init(color: Color(red: 0.988, green: 0.918, blue: 0.925), location: 1.0),  // pale pink
                ], startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [AlmaSwiftTheme.violet.opacity(0.14), .clear],
                               center: .init(x: 0.12, y: 0.15), startRadius: 10, endRadius: 380)
                RadialGradient(colors: [AlmaSwiftTheme.coral.opacity(0.12), .clear],
                               center: .init(x: 0.9, y: 0.9), startRadius: 20, endRadius: 420)
            }
        }
        .ignoresSafeArea()
    }
}

@available(iOS 17.0, *)
private extension View {
    func agentGrowthGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct AgentGrowthShimmer: ViewModifier {
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
    func agentGrowthShimmer() -> some View { modifier(AgentGrowthShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Growth — Light") {
    AgentGrowthScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
