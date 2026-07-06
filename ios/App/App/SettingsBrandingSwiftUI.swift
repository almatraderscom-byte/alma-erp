//
//  SettingsBrandingSwiftUI.swift
//  ALMA ERP — Settings · Branding as a native SwiftUI screen (read-only).
//
//  Mirrors the web /settings/branding page:
//    GET /api/branding?all=1 → { ok, branding_by_business: { <businessId>: {…} } }
//  One call returns all three businesses (ALMA_LIFESTYLE / CREATIVE_DIGITAL_IT /
//  ALMA_TRADING), each rendered as a per-business branding card: logo + favicon
//  (via /api/branding/image-proxy?raw=1&url=… — URLSession.shared shares the
//  WKWebView cookies AlmaAPI bridges, so AsyncImage is authenticated), brand
//  colour swatches, company details, invoice branding (prefix / watermark /
//  footer lines). Read-only by design: ALL edits — logo/favicon uploads, colour
//  and name changes — stay on the web escape hatch (uploads are web-only).
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum SettingsBrandingPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Models (same snake_case field names /api/branding returns)

struct SettingsBrandingInfo: Decodable, Identifiable, Equatable {
    let businessId: String
    let companyName: String?
    let tagline: String?
    let phone: String?
    let email: String?
    let website: String?
    let address: String?
    let facebook: String?
    let logoUrl: String?
    let faviconUrl: String?
    let colorPrimary: String?
    let colorSecondary: String?
    let colorAccent: String?
    let invoiceFooterThanks: String?
    let invoiceFooterPolicy: String?
    let invoiceFooterNote: String?
    let invoicePrefix: String?
    let invoiceWatermarkEnabled: Bool?
    /// Server stores this as a string ("0.08") but be lenient about numbers too.
    let invoiceWatermarkOpacity: Double?
    let updatedAt: String?

    var id: String { businessId }

    private enum Keys: String, CodingKey {
        case businessId = "business_id"
        case companyName = "company_name"
        case tagline, phone, email, website, address, facebook
        case logoUrl = "logo_url"
        case faviconUrl = "favicon_url"
        case colorPrimary = "color_primary"
        case colorSecondary = "color_secondary"
        case colorAccent = "color_accent"
        case invoiceFooterThanks = "invoice_footer_thanks"
        case invoiceFooterPolicy = "invoice_footer_policy"
        case invoiceFooterNote = "invoice_footer_note"
        case invoicePrefix = "invoice_prefix"
        case invoiceWatermarkEnabled = "invoice_watermark_enabled"
        case invoiceWatermarkOpacity = "invoice_watermark_opacity"
        case updatedAt = "updated_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        businessId = (try? c.decode(String.self, forKey: .businessId)) ?? ""
        companyName = try? c.decodeIfPresent(String.self, forKey: .companyName)
        tagline = try? c.decodeIfPresent(String.self, forKey: .tagline)
        phone = try? c.decodeIfPresent(String.self, forKey: .phone)
        email = try? c.decodeIfPresent(String.self, forKey: .email)
        website = try? c.decodeIfPresent(String.self, forKey: .website)
        address = try? c.decodeIfPresent(String.self, forKey: .address)
        facebook = try? c.decodeIfPresent(String.self, forKey: .facebook)
        logoUrl = try? c.decodeIfPresent(String.self, forKey: .logoUrl)
        faviconUrl = try? c.decodeIfPresent(String.self, forKey: .faviconUrl)
        colorPrimary = try? c.decodeIfPresent(String.self, forKey: .colorPrimary)
        colorSecondary = try? c.decodeIfPresent(String.self, forKey: .colorSecondary)
        colorAccent = try? c.decodeIfPresent(String.self, forKey: .colorAccent)
        invoiceFooterThanks = try? c.decodeIfPresent(String.self, forKey: .invoiceFooterThanks)
        invoiceFooterPolicy = try? c.decodeIfPresent(String.self, forKey: .invoiceFooterPolicy)
        invoiceFooterNote = try? c.decodeIfPresent(String.self, forKey: .invoiceFooterNote)
        invoicePrefix = try? c.decodeIfPresent(String.self, forKey: .invoicePrefix)
        invoiceWatermarkEnabled = Self.flexBool(c, .invoiceWatermarkEnabled)
        invoiceWatermarkOpacity = Self.flexDouble(c, .invoiceWatermarkOpacity)
        updatedAt = try? c.decodeIfPresent(String.self, forKey: .updatedAt)
    }

    private static func flexDouble(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Double? {
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
        return nil
    }
    private static func flexBool(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Bool? {
        if let b = try? c.decodeIfPresent(Bool.self, forKey: k) { return b }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i != 0 }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return s == "true" || s == "1" }
        return nil
    }

    static func == (a: SettingsBrandingInfo, b: SettingsBrandingInfo) -> Bool {
        a.businessId == b.businessId && a.updatedAt == b.updatedAt && a.logoUrl == b.logoUrl
    }
}

/// GET /api/branding?all=1 → { ok, fallback?, branding_by_business: {…} } — the route
/// returns flat, but decode a possible { data: {…} } wrapper too, like the other screens.
struct SettingsBrandingResponse: Decodable {
    let brandings: [SettingsBrandingInfo]
    let fallback: Bool?

    private enum Keys: String, CodingKey { case ok, data, fallback
        case byBusiness = "branding_by_business"
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        let map = (try? c.decode([String: SettingsBrandingInfo].self, forKey: .byBusiness)) ?? [:]
        fallback = try? c.decodeIfPresent(Bool.self, forKey: .fallback)
        // Stable web order: Lifestyle → CDIT → Trading, unknown tenants appended.
        let order = ["ALMA_LIFESTYLE", "CREATIVE_DIGITAL_IT", "ALMA_TRADING"]
        var sorted = order.compactMap { map[$0] }
        sorted += map.values
            .filter { !order.contains($0.businessId) }
            .sorted { $0.businessId < $1.businessId }
        brandings = sorted
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class SettingsBrandingVM {
    var brandings: [SettingsBrandingInfo] = []
    var fallback = false
    var loading = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: SettingsBrandingResponse = try await AlmaAPI.shared.get(
                "/api/branding", query: ["all": "1"])
            brandings = resp.brandings
            fallback = resp.fallback == true
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
}

// MARK: - Screen

@available(iOS 17.0, *)
struct SettingsBrandingScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = SettingsBrandingVM()
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                if vm.fallback {
                    noticeCard("সার্ভার থেকে সেভ করা ব্র্যান্ডিং আনা যায়নি — ডিফল্ট দেখানো হচ্ছে।", tone: .info)
                }
                assetGuideCard
                if vm.loading && vm.brandings.isEmpty { loadingRows }
                ForEach(vm.brandings) { branding in
                    SettingsBrandingCard(branding: branding)
                }
                if !vm.loading && vm.brandings.isEmpty && vm.error == nil && !vm.authExpired {
                    emptyState
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(SettingsBrandingAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }

    /// The web's gold recommendations box ("Brand assets") — plus the iOS-only
    /// read-only note: uploads/edits live on the web.
    private var assetGuideCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("BRAND ASSETS")
                .font(.caption2.weight(.heavy))
                .foregroundStyle(SettingsBrandingPalette.accentText(colorScheme))
            Text("Logo: 1200x400 PNG (3:1) · Favicon/PWA: 512x512 square")
                .font(.caption).foregroundStyle(.secondary)
            Text("এখানে শুধু দেখা যায় — লোগো আপলোড, রং বা নাম বদলাতে হলে ওয়েবে করুন।")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(SettingsBrandingPalette.coral.opacity(0.05),
                    in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12)
            .strokeBorder(SettingsBrandingPalette.coral.opacity(0.25), lineWidth: 1))
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "paintpalette").font(.largeTitle).foregroundStyle(.secondary)
            Text("কিছু নেই").foregroundStyle(.secondary)
        }
        .padding(.top, 70)
        .padding(.bottom, 30)
    }

    private enum NoticeTone { case error, info }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", SettingsBrandingPalette.red500)
        case .info: ("info.circle", Color.secondary)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).settingsBrandingGlass(colorScheme, corner: 12)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .settingsBrandingGlass(colorScheme, corner: 16)
    }

    private var loadingRows: some View {
        ForEach(0..<3, id: \.self) { _ in
            Color.clear.frame(height: 220)
                .settingsBrandingGlass(colorScheme, corner: 18)
                .settingsBrandingShimmer()
        }
    }

    /// Web escape hatch — every edit (uploads included) happens on the web page.
    private var webEscape: some View {
        Button {
            openWeb("/settings/branding", "Branding")
        } label: {
            Label("লোগো আপলোড ও এডিট — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Per-business branding card (web page sections, one glass card per tenant)

@available(iOS 17.0, *)
private struct SettingsBrandingCard: View {
    let branding: SettingsBrandingInfo
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            logoRow
            colorSwatches
            companyDetails
            invoiceBranding
            if let updated = SettingsBrandingFormat.dateTime(branding.updatedAt) {
                Text("Updated \(updated)")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .settingsBrandingGlass(colorScheme, corner: 18)
    }

    // ── Header: brand initial badge + company name + tagline ──

    private var header: some View {
        HStack(spacing: 10) {
            Text(SettingsBrandingFormat.initials(displayName))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 38, height: 38)
                .background(
                    LinearGradient(
                        colors: [primaryColor ?? SettingsBrandingPalette.coral,
                                 secondaryColor ?? AlmaSwiftTheme.violet],
                        startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                .shadow(color: (primaryColor ?? SettingsBrandingPalette.coral).opacity(0.35),
                        radius: 5, y: 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(displayName).font(.subheadline.weight(.bold))
                if let tag = branding.tagline, !tag.isEmpty {
                    Text(tag).font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary).textCase(.uppercase)
                }
            }
            Spacer()
            Text(branding.businessId.replacingOccurrences(of: "_", with: " "))
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(SettingsBrandingPalette.accentText(colorScheme))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(SettingsBrandingPalette.coral.opacity(0.14), in: Capsule())
                .overlay(Capsule().strokeBorder(SettingsBrandingPalette.coral.opacity(0.35), lineWidth: 1))
        }
    }

    private var displayName: String {
        if let n = branding.companyName, !n.isEmpty { return n }
        switch branding.businessId {
        case "ALMA_LIFESTYLE": return "Alma Lifestyle"
        case "CREATIVE_DIGITAL_IT": return "Creative Digital IT"
        case "ALMA_TRADING": return "Alma Trading"
        default: return branding.businessId.replacingOccurrences(of: "_", with: " ")
        }
    }

    // ── Logo + favicon (web preview boxes; images through the auth image-proxy) ──

    private var logoRow: some View {
        HStack(alignment: .top, spacing: 10) {
            assetBox(title: "LOGO", url: proxyURL(branding.logoUrl),
                     emptyText: "No logo", width: nil, height: 72)
                .frame(maxWidth: .infinity)
            assetBox(title: "FAVICON", url: proxyURL(branding.faviconUrl),
                     emptyText: "No favicon", width: 88, height: 72)
        }
    }

    private func assetBox(title: String, url: URL?, emptyText: String,
                          width: CGFloat?, height: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.white.opacity(colorScheme == .dark ? 0.06 : 0.55))
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.10 : 0.45), lineWidth: 1)
                if let url {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFit().padding(8)
                        case .failure:
                            Text(emptyText).font(.caption2).foregroundStyle(.secondary)
                        default:
                            ProgressView().controlSize(.small)
                        }
                    }
                } else {
                    Text(emptyText).font(.caption2).foregroundStyle(.secondary)
                }
            }
            .frame(width: width, height: height)
        }
    }

    /// The web loads brand images through its authenticated proxy — same here.
    private func proxyURL(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty else { return nil }
        var components = URLComponents(url: AlmaAPI.baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/api/branding/image-proxy"
        components.queryItems = [
            URLQueryItem(name: "raw", value: "1"),
            URLQueryItem(name: "url", value: raw),
        ]
        return components.url
    }

    // ── Brand colours (web "Brand colors" card → swatch chips) ──

    private var colorSwatches: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("BRAND COLORS").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                swatch("Primary", branding.colorPrimary)
                swatch("Secondary", branding.colorSecondary)
                swatch("Accent", branding.colorAccent)
            }
        }
    }

    private func swatch(_ label: String, _ hex: String?) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(SettingsBrandingFormat.color(hex) ?? Color.secondary.opacity(0.25))
                .frame(width: 18, height: 18)
                .overlay(Circle().strokeBorder(Color.white.opacity(0.5), lineWidth: 1))
            VStack(alignment: .leading, spacing: 0) {
                Text(label).font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                Text((hex ?? "—").uppercased())
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(Color.white.opacity(colorScheme == .dark ? 0.05 : 0.40),
                    in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10)
            .strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.09 : 0.40), lineWidth: 1))
    }

    // ── Company details (web "Company details" grid → compact rows) ──

    @ViewBuilder private var companyDetails: some View {
        let rows: [(String, String?)] = [
            ("phone.fill", branding.phone),
            ("envelope.fill", branding.email),
            ("globe", branding.website),
            ("mappin.and.ellipse", branding.address),
            ("hand.thumbsup.fill", branding.facebook),
        ]
        let filled = rows.filter { !($0.1 ?? "").isEmpty }
        if !filled.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("COMPANY DETAILS").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                ForEach(filled, id: \.0) { icon, value in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: icon)
                            .font(.caption2)
                            .foregroundStyle(SettingsBrandingPalette.accentText(colorScheme))
                            .frame(width: 16)
                        Text(value ?? "").font(.caption).foregroundStyle(.primary.opacity(0.85))
                    }
                }
            }
        }
    }

    // ── Invoice branding (web "Invoice watermark" + "Invoice footer" cards) ──

    private var invoiceBranding: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("INVOICE").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                if let prefix = branding.invoicePrefix, !prefix.isEmpty {
                    Text(prefix)
                        .font(.caption2.weight(.bold).monospaced())
                        .foregroundStyle(SettingsBrandingPalette.accentText(colorScheme))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(SettingsBrandingPalette.coral.opacity(0.12), in: Capsule())
                        .overlay(Capsule().strokeBorder(SettingsBrandingPalette.coral.opacity(0.30), lineWidth: 1))
                }
                Text(watermarkLine)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(branding.invoiceWatermarkEnabled == false
                                     ? Color.secondary : SettingsBrandingPalette.emerald600)
            }
            ForEach(footerLines, id: \.0) { label, value in
                VStack(alignment: .leading, spacing: 1) {
                    Text(label).font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                    Text(value).font(.caption).foregroundStyle(.primary.opacity(0.85))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(SettingsBrandingPalette.coral.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10)
            .strokeBorder(SettingsBrandingPalette.goldDim.opacity(0.25), lineWidth: 1))
    }

    private var watermarkLine: String {
        if branding.invoiceWatermarkEnabled == false { return "Watermark off" }
        let pct = Int(((branding.invoiceWatermarkOpacity ?? 0.08) * 100).rounded())
        return "Watermark on · \(pct)%"
    }

    private var footerLines: [(String, String)] {
        [("Thank you line", branding.invoiceFooterThanks),
         ("Policy / terms", branding.invoiceFooterPolicy),
         ("Legal note", branding.invoiceFooterNote)]
            .compactMap { label, value in
                guard let value, !value.isEmpty else { return nil }
                return (label, value)
            }
    }

    private var primaryColor: Color? { SettingsBrandingFormat.color(branding.colorPrimary) }
    private var secondaryColor: Color? { SettingsBrandingFormat.color(branding.colorSecondary) }
}

// MARK: - Formatting helpers (web util parity)

private enum SettingsBrandingFormat {
    /// "#E07A5F" / "E07A5F" → Color (the web renders these via <input type=color>).
    static func color(_ hex: String?) -> Color? {
        guard var s = hex?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let value = UInt64(s, radix: 16) else { return nil }
        return Color(
            red: Double((value >> 16) & 0xFF) / 255.0,
            green: Double((value >> 8) & 0xFF) / 255.0,
            blue: Double(value & 0xFF) / 255.0)
    }

    /// updated_at → "5/7/2026, 8:50 PM" style (web: new Date(...).toLocaleString()).
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

    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}

// MARK: - Aurora background + glass (SettingsBranding-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct SettingsBrandingAurora: View {
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
    func settingsBrandingGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct SettingsBrandingShimmer: ViewModifier {
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
    func settingsBrandingShimmer() -> some View { modifier(SettingsBrandingShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Settings · Branding — Light") {
    SettingsBrandingScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
