//
//  CSLifestyleEditorSwiftUI.swift
//  ALMA ERP — native Creative Studio finishing EDITOR (build 67).
//
//  Native twin of the web `LifestyleEditor.tsx` + `FinishPanel` combo: the owner
//  edits THIS image's texts (hook / eyebrow / offer / code), theme and — for the
//  lifestyle poster layout — drags/resizes every block (logo, headline, offer,
//  code ring, rule, monogram) exactly like the web drag-editor. Geometry is a
//  1:1 port of `src/lib/content-engine/lifestyle-layout.ts` (same 1080×1080
//  design space, same auto positions), and Apply calls the SAME
//  `/api/assistant/creative-studio/finish` route with `layout` overrides — the
//  server renders the final crisp image, so what is dragged here is what ships.
//
//  Also home of CSMediaSaver: real image/video download (Photos) + share of the
//  actual file — replaces the old ShareLink(URL) that only shared a supabase link.
//

import SwiftUI
import Photos
import UIKit

// MARK: - Geometry port (lifestyle-layout.ts)

/// Design-space constants + helpers, mirrored from the web module.
enum CSE {
    static let size: CGFloat = 1080
    static let pad: CGFloat = 64
    static let cream = Color(red: 0.961, green: 0.922, blue: 0.867)     // #F5EBDD
    static let charcoal = Color(red: 0.165, green: 0.149, blue: 0.133)  // #2A2622
    static let defaultOffer = "অফার প্রাইস জানতে ইনবক্স করুন"
    static let estLine = "EST. 2019 · DHAKA"

    /// Mirrors LIFESTYLE_THEME_TOKENS (accent + default eyebrow per theme).
    static let themeTokens: [String: (accent: Color, eyebrow: String)] = [
        "default": (Color(red: 0.784, green: 0.608, blue: 0.235), "নতুন এসেছে"),          // #C89B3C
        "eid": (Color(red: 0.420, green: 0.153, blue: 0.216), "ঈদ স্পেশাল"),               // #6B2737
        "puja": (Color(red: 0.788, green: 0.490, blue: 0.365), "উৎসব কালেকশন"),           // #C97D5D
        "boishakh": (Color(red: 0.176, green: 0.373, blue: 0.310), "বৈশাখী কালেকশন"),      // #2D5F4F
        "winter": (Color(red: 0.176, green: 0.373, blue: 0.310), "শীত কালেকশন"),           // #2D5F4F
    ]
    static func accent(_ theme: String) -> Color { themeTokens[theme]?.accent ?? themeTokens["default"]!.accent }
    static func eyebrowDefault(_ theme: String) -> String { themeTokens[theme]?.eyebrow ?? "নতুন এসেছে" }

    /// Greedy word-wrap — exact port of `wrapText` so line breaks match the server.
    static func wrap(_ text: String, maxChars: Int, maxLines: Int) -> [String] {
        let words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard !words.isEmpty else { return [] }
        var lines: [String] = []
        var cur = ""
        for wd in words {
            let tentative = cur.isEmpty ? wd : "\(cur) \(wd)"
            if tentative.count > maxChars && !cur.isEmpty && lines.count < maxLines - 1 {
                lines.append(cur); cur = wd
            } else { cur = tentative }
        }
        if !cur.isEmpty { lines.append(cur) }
        return Array(lines.prefix(maxLines))
    }

    /// Code-ring text size rule (Bangla glyphs are wide) — port of computeAutoLayout.
    static func codeSize(_ code: String) -> CGFloat { code.count > 9 ? 14 : code.count > 6 ? 17 : 22 }
}

/// Working layout — mutable twin of `LifestyleLayout` (only the fields the editor moves).
struct CSELayout: Equatable {
    struct TextEl: Equatable {
        var lines: [String]
        var x: CGFloat; var y: CGFloat          // x = anchored edge, y = first baseline
        var size: CGFloat; var leading: CGFloat
        var justify: String                      // start | middle | end
        var accent: Bool                         // accent colour vs cream
        var display: Bool                        // display vs serif family
        var weight: Font.Weight
        var letterSpacing: CGFloat
    }
    struct Ring: Equatable { var cx: CGFloat; var cy: CGFloat; var r: CGFloat; var size: CGFloat }
    struct Rule: Equatable { var x: CGFloat; var y: CGFloat; var w: CGFloat; var h: CGFloat }
    struct Logo: Equatable { var x: CGFloat; var y: CGFloat; var w: CGFloat }

    var eyebrow: TextEl
    var headline: TextEl
    var offer: TextEl
    var est: TextEl
    var codeBadge: Ring
    var code: String
    var codeLabelSize: CGFloat = 17
    var codeLabelDy: CGFloat = -66
    var rule: Rule
    var monogram: Ring
    var logo: Logo

    /// Port of `computeAutoLayout` — identical numbers to the server/web.
    static func auto(eyebrow: String, headline: String, offer: String, code: String) -> CSELayout {
        let S = CSE.size, pad = CSE.pad
        let headlineLines = CSE.wrap(headline, maxChars: 15, maxLines: 2)
        let offerLines = CSE.wrap(offer, maxChars: 18, maxLines: 2)
        let codeTrim = String(code.prefix(16))

        let circleR: CGFloat = 46
        let ruleY: CGFloat = 1018
        let hlLeading: CGFloat = 62
        let nHl = CGFloat(max(1, headlineLines.count))
        let lastHlBaseline = ruleY - 16
        let firstHlBaseline = lastHlBaseline - (nHl - 1) * hlLeading
        let eyebrowBaseline = firstHlBaseline - 46
        let nOf = CGFloat(max(1, offerLines.count))
        let offerFirstBaseline = 998 - (nOf - 1) * 40

        return CSELayout(
            eyebrow: .init(lines: eyebrow.isEmpty ? [] : [eyebrow], x: pad, y: eyebrowBaseline,
                           size: 27, leading: 34, justify: "start", accent: true, display: false,
                           weight: .regular, letterSpacing: 0),
            headline: .init(lines: headlineLines, x: pad, y: firstHlBaseline,
                            size: 54, leading: hlLeading, justify: "start", accent: false, display: false,
                            weight: .bold, letterSpacing: 0),
            offer: .init(lines: offerLines, x: S - pad, y: offerFirstBaseline,
                         size: 30, leading: 40, justify: "end", accent: false, display: false,
                         weight: .regular, letterSpacing: 0),
            est: .init(lines: [CSE.estLine], x: (S / 2).rounded(), y: 1048,
                       size: 16, leading: 20, justify: "middle", accent: true, display: true,
                       weight: .regular, letterSpacing: 2),
            codeBadge: .init(cx: S - pad - circleR, cy: 124, r: circleR, size: CSE.codeSize(codeTrim)),
            code: codeTrim,
            rule: .init(x: pad, y: ruleY, w: 74, h: 3),
            monogram: .init(cx: S - pad + 4, cy: 1034, r: 18, size: 18),
            logo: .init(x: 60, y: 54, w: 280)
        )
    }
}

/// Geometry overrides for the finish API — Codable both ways: encoded into the
/// finish payload, and decoded back from `finishParams` to reopen an old edit.
struct CSLayoutOverridesData: Codable, Equatable {
    struct TextOv: Codable, Equatable { var x: Double?; var y: Double?; var size: Double?; var leading: Double? }
    struct RingOv: Codable, Equatable { var cx: Double?; var cy: Double?; var r: Double?; var size: Double? }
    struct RuleOv: Codable, Equatable { var x: Double?; var y: Double?; var w: Double? }
    struct LogoOv: Codable, Equatable { var x: Double?; var y: Double?; var w: Double? }
    var eyebrow: TextOv?
    var headline: TextOv?
    var offer: TextOv?
    var est: TextOv?
    var codeBadge: RingOv?
    var rule: RuleOv?
    var monogram: RingOv?
    var logo: LogoOv?

    init(from l: CSELayout) {
        func t(_ e: CSELayout.TextEl, leading: Bool) -> TextOv {
            TextOv(x: Double(e.x.rounded()), y: Double(e.y.rounded()), size: Double(e.size.rounded()),
                   leading: leading ? Double(e.leading.rounded()) : nil)
        }
        eyebrow = t(l.eyebrow, leading: false)
        headline = t(l.headline, leading: true)
        offer = t(l.offer, leading: true)
        est = t(l.est, leading: false)
        codeBadge = RingOv(cx: Double(l.codeBadge.cx.rounded()), cy: Double(l.codeBadge.cy.rounded()),
                           r: Double(l.codeBadge.r.rounded()), size: Double(l.codeBadge.size.rounded()))
        rule = RuleOv(x: Double(l.rule.x.rounded()), y: Double(l.rule.y.rounded()), w: Double(l.rule.w.rounded()))
        monogram = RingOv(cx: Double(l.monogram.cx.rounded()), cy: Double(l.monogram.cy.rounded()),
                          r: Double(l.monogram.r.rounded()), size: Double(l.monogram.size.rounded()))
        logo = LogoOv(x: Double(l.logo.x.rounded()), y: Double(l.logo.y.rounded()), w: Double(l.logo.w.rounded()))
    }

    /// Re-apply saved geometry onto an auto layout (mirror of applyLayoutOverrides —
    /// the server clamps again, so no clamping needed here).
    func applied(to base: CSELayout) -> CSELayout {
        var l = base
        func t(_ e: inout CSELayout.TextEl, _ o: TextOv?) {
            guard let o else { return }
            if let x = o.x { e.x = x }; if let y = o.y { e.y = y }
            if let s = o.size { e.size = s }; if let ld = o.leading { e.leading = ld }
        }
        t(&l.eyebrow, eyebrow); t(&l.headline, headline); t(&l.offer, offer); t(&l.est, est)
        if let b = codeBadge {
            if let v = b.cx { l.codeBadge.cx = v }; if let v = b.cy { l.codeBadge.cy = v }
            if let v = b.r { l.codeBadge.r = v }; if let v = b.size { l.codeBadge.size = v }
        }
        if let r = rule { if let v = r.x { l.rule.x = v }; if let v = r.y { l.rule.y = v }; if let v = r.w { l.rule.w = v } }
        if let m = monogram {
            if let v = m.cx { l.monogram.cx = v }; if let v = m.cy { l.monogram.cy = v }
            if let v = m.r { l.monogram.r = v }; if let v = m.size { l.monogram.size = v }
        }
        if let lg = logo { if let v = lg.x { l.logo.x = v }; if let v = lg.y { l.logo.y = v }; if let v = lg.w { l.logo.w = v } }
        return l
    }
}

/// Last finishing inputs, persisted by the finish route → gallery response.
struct CSFinishParams: Decodable, Equatable {
    let hook: String?
    let productCode: String?
    let eyebrow: String?
    let offer: String?
    let mode: String?
    let theme: String?
    let footer: Bool?
    let fit: String?
    let layout: CSLayoutOverridesData?
}

// MARK: - Real download / share of the actual media file

enum CSMediaSaver {
    static func fetch(_ url: URL) async throws -> Data {
        let (data, _) = try await URLSession.shared.data(from: url)
        return data
    }

    /// File extension from a signed URL ("…/photo.png?token=…" → png).
    static func ext(_ url: URL, isVideo: Bool) -> String {
        let e = url.pathExtension.lowercased()
        if !e.isEmpty && e.count <= 4 { return e }
        return isVideo ? "mp4" : "jpg"
    }

    /// Save the actual bytes into the user's Photos library (add-only permission).
    static func saveToPhotos(_ data: Data, ext: String, isVideo: Bool) async -> Bool {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { return false }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("alma-save-\(UUID().uuidString).\(ext)")
        do { try data.write(to: tmp) } catch { return false }
        defer { try? FileManager.default.removeItem(at: tmp) }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                if isVideo {
                    PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: tmp)
                } else {
                    PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: tmp)
                }
            }
            return true
        } catch { return false }
    }

    /// Share the actual file (not the link) via the system share sheet.
    @MainActor
    static func share(_ data: Data, filename: String) {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        try? FileManager.default.removeItem(at: tmp)
        do { try data.write(to: tmp) } catch { return }
        guard let top = topViewController() else { return }
        let av = UIActivityViewController(activityItems: [tmp], applicationActivities: nil)
        av.popoverPresentationController?.sourceView = top.view
        av.popoverPresentationController?.sourceRect = CGRect(
            x: top.view.bounds.midX, y: top.view.bounds.midY, width: 1, height: 1)
        top.present(av, animated: true)
    }

    @MainActor
    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        var vc = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController
        while let presented = vc?.presentedViewController { vc = presented }
        return vc
    }
}

// MARK: - The editor sheet

@available(iOS 17.0, *)
struct CSFinishEditorSheet: View {
    let item: CSGalleryItem
    let vm: CreativeStudioVM
    /// Called with the fresh framedUrl once a render succeeds (sheet stays open on the preview).
    let onFinished: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    // text + style state (seeded from the last finish when available)
    @State private var eyebrow: String
    @State private var headline: String
    @State private var offer: String
    @State private var code: String
    @State private var themeId: String
    @State private var fitContain: Bool
    private let savedLayout: CSLayoutOverridesData?

    @State private var layout: CSELayout
    @State private var selected: Element?
    @State private var dragStart: CSELayout?
    @State private var textWidths: [Element: CGFloat] = [:]
    @State private var logoAspect: CGFloat = 0.32
    @State private var showText = false
    @State private var busy = false
    @State private var framed: URL?
    @State private var saveState = ""   // transient "সেভ হয়েছে ✅" under the result

    enum Element: Hashable { case eyebrow, headline, offer, est, codeBadge, rule, monogram, logo }

    init(item: CSGalleryItem, vm: CreativeStudioVM, onFinished: @escaping (String) -> Void) {
        self.item = item
        self.vm = vm
        self.onFinished = onFinished
        let p = item.finishParams
        let theme = p?.theme ?? "default"
        let eb = p?.eyebrow ?? ""
        let hl = p?.hook ?? ""
        let of = p?.offer ?? ""
        let cd = p?.productCode ?? ""
        _eyebrow = State(initialValue: eb)
        _headline = State(initialValue: hl)
        _offer = State(initialValue: of)
        _code = State(initialValue: cd)
        _themeId = State(initialValue: theme)
        _fitContain = State(initialValue: p?.fit == "contain")
        savedLayout = p?.layout
        let auto = CSELayout.auto(
            eyebrow: eb.isEmpty ? CSE.eyebrowDefault(theme) : eb,
            headline: hl.isEmpty ? " " : hl,
            offer: of.isEmpty ? CSE.defaultOffer : of,
            code: cd)
        _layout = State(initialValue: p?.layout?.applied(to: auto) ?? auto)
    }

    private var accent: Color { CSE.accent(themeId) }
    private var sourceURL: URL? { item.previewURL ?? item.imageURL }

    var body: some View {
        ZStack {
            Color.black.opacity(0.95).ignoresSafeArea()
            if let framed {
                resultView(framed)
            } else {
                editorView
            }
        }
        .overlay(alignment: .top) { CSToastView(message: vm.toast) }
        .statusBarHidden(false)
        // Brand logo + theme list come from the library status — load if not yet
        // fetched (the editor can open before the Library tab ever did).
        .task { if vm.brandStatus == nil { await vm.loadLibraryExtras() } }
    }

    // ── Result (the "preview" the owner asked for) ─────────────────────────
    private func resultView(_ url: URL) -> some View {
        VStack(spacing: 14) {
            HStack {
                Button { framed = nil } label: {
                    Label("আরও বদলান", systemImage: "slider.horizontal.3")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white.opacity(0.85))
                }
                Spacer()
                Button { dismiss() } label: {
                    Text("বন্ধ করুন").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                        .padding(.vertical, 8).padding(.horizontal, 16)
                        .background(.white.opacity(0.14), in: Capsule())
                }
            }
            .padding(.horizontal, 18).padding(.top, 12)

            Text("ফিনিশিং হয়ে গেছে ✅").font(.system(size: 17, weight: .heavy)).foregroundStyle(.white)

            AsyncImage(url: url) { phase in
                if let img = phase.image {
                    img.resizable().scaledToFit()
                } else {
                    ZStack { Color.white.opacity(0.06); ProgressView().tint(.white) }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .padding(.horizontal, 18)

            if !saveState.isEmpty {
                Text(saveState).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.green)
            }

            HStack(spacing: 10) {
                resultBtn("ফটোজে সেভ", "arrow.down.to.line", primary: true) {
                    Task {
                        guard let data = try? await CSMediaSaver.fetch(url) else { saveState = "ডাউনলোড হয়নি"; return }
                        let ok = await CSMediaSaver.saveToPhotos(data, ext: CSMediaSaver.ext(url, isVideo: false), isVideo: false)
                        saveState = ok ? "ফটো অ্যাপে সেভ হয়েছে ✅" : "Photos-এ সেভের অনুমতি নেই"
                    }
                }
                resultBtn("শেয়ার", "square.and.arrow.up", primary: false) {
                    Task {
                        guard let data = try? await CSMediaSaver.fetch(url) else { saveState = "ডাউনলোড হয়নি"; return }
                        await MainActor.run { CSMediaSaver.share(data, filename: "alma-finished.\(CSMediaSaver.ext(url, isVideo: false))") }
                    }
                }
            }
            .padding(.horizontal, 18)
            Spacer(minLength: 8)
        }
    }

    private func resultBtn(_ label: String, _ icon: String, primary: Bool, _ tap: @escaping () -> Void) -> some View {
        Button { tap(); CSHaptic.tap() } label: {
            Label(label, systemImage: icon)
                .font(.system(size: 13.5, weight: .bold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity).padding(13)
                .background(primary ? AnyShapeStyle(CS.cta) : AnyShapeStyle(Color.white.opacity(0.12)),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }.buttonStyle(.plain)
    }

    // ── Editor ──────────────────────────────────────────────────────────────
    private var editorView: some View {
        VStack(spacing: 0) {
            HStack {
                Button { dismiss() } label: {
                    Text("✕ বাতিল").font(.system(size: 13)).foregroundStyle(.white.opacity(0.7))
                }
                Spacer()
                Text("টেনে সরান · কোণার দানা টেনে ছোট-বড়")
                    .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.6))
                Spacer()
                Button { resetLayout() } label: {
                    Text("↺ আগের মতো").font(.system(size: 13)).foregroundStyle(.white.opacity(0.7))
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)

            GeometryReader { geo in
                let side = min(geo.size.width - 16, geo.size.height)
                canvas(side: side)
                    .frame(width: side, height: side)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            controls
        }
    }

    /// The 1:1 canvas — everything positioned in design space × scale.
    private func canvas(side: CGFloat) -> some View {
        let scale = side / CSE.size
        func px(_ v: CGFloat) -> CGFloat { v * scale }

        return ZStack(alignment: .topLeading) {
            // photo (cover crops to square, contain shows all over a blurred fill)
            Group {
                if fitContain {
                    AsyncImage(url: sourceURL) { ph in
                        (ph.image ?? Image(systemName: "photo")).resizable().scaledToFill()
                    }
                    .frame(width: side, height: side).clipped()
                    .blur(radius: 18).brightness(-0.18)
                }
                AsyncImage(url: sourceURL) { ph in
                    if let img = ph.image {
                        img.resizable().aspectRatio(contentMode: fitContain ? .fit : .fill)
                    } else {
                        // Full-size originals can take a few seconds — show progress
                        // so the canvas never looks like a dead black box.
                        ZStack {
                            Color.white.opacity(0.05)
                            VStack(spacing: 8) {
                                ProgressView().tint(.white)
                                Text("ছবি লোড হচ্ছে…").font(.system(size: 11)).foregroundStyle(.white.opacity(0.55))
                            }
                        }
                    }
                }
                .frame(width: side, height: side)
                .clipped()
            }
            // scrims (match the server render)
            LinearGradient(colors: [CSE.charcoal.opacity(0.34), .clear], startPoint: .top, endPoint: .bottom)
                .frame(width: side, height: px(240))
            LinearGradient(stops: [.init(color: .clear, location: 0),
                                   .init(color: CSE.charcoal.opacity(0.45), location: 0.52),
                                   .init(color: CSE.charcoal.opacity(0.9), location: 1)],
                           startPoint: .top, endPoint: .bottom)
                .frame(width: side, height: px(520)).offset(y: px(560))

            // logo
            if let logoUrl = vm.brandStatus?.logoUrl, let url = CS.url(logoUrl) {
                AsyncImage(url: url) { ph in
                    (ph.image ?? Image(systemName: "photo")).resizable().scaledToFit()
                }
                .frame(width: px(layout.logo.w), height: px(layout.logo.w * logoAspect))
                .overlay(selectionBorder(.logo))
                .overlay(alignment: .bottomTrailing) { resizeHandle(.logo, scale: scale) }
                .offset(x: px(layout.logo.x), y: px(layout.logo.y))
                .gesture(moveGesture(.logo, scale: scale))
            }

            // CODE ring
            ZStack {
                Circle().fill(CSE.charcoal.opacity(0.26))
                Circle().strokeBorder(CSE.cream.opacity(0.8), lineWidth: max(1, px(1.5)))
                if !layout.code.isEmpty {
                    Text(layout.code)
                        .font(.system(size: px(layout.codeBadge.size), weight: .bold, design: .serif))
                        .foregroundStyle(CSE.cream)
                        .lineLimit(1).minimumScaleFactor(0.4)
                }
            }
            .frame(width: px(layout.codeBadge.r * 2), height: px(layout.codeBadge.r * 2))
            .overlay(alignment: .top) {
                Text("CODE")
                    .font(.system(size: px(layout.codeLabelSize), design: .serif))
                    .kerning(px(3))
                    .foregroundStyle(CSE.cream.opacity(0.72))
                    .offset(y: px(layout.codeLabelDy + layout.codeBadge.r) - px(layout.codeLabelSize))
            }
            .overlay(selectionBorder(.codeBadge))
            .overlay(alignment: .bottomTrailing) { resizeHandle(.codeBadge, scale: scale) }
            .offset(x: px(layout.codeBadge.cx - layout.codeBadge.r), y: px(layout.codeBadge.cy - layout.codeBadge.r))
            .gesture(moveGesture(.codeBadge, scale: scale))

            // text blocks
            textBlock(.eyebrow, layout.eyebrow, scale: scale)
            textBlock(.headline, layout.headline, scale: scale)
            textBlock(.offer, layout.offer, scale: scale)
            textBlock(.est, layout.est, scale: scale)

            // mustard rule
            Rectangle().fill(accent)
                .frame(width: px(layout.rule.w), height: max(2, px(layout.rule.h)))
                .overlay(selectionBorder(.rule))
                .overlay(alignment: .bottomTrailing) { resizeHandle(.rule, scale: scale) }
                .offset(x: px(layout.rule.x), y: px(layout.rule.y))
                .gesture(moveGesture(.rule, scale: scale))

            // monogram
            ZStack {
                Circle().strokeBorder(CSE.cream.opacity(0.85), lineWidth: max(1, px(1.5)))
                Text("A").font(.system(size: px(layout.monogram.size), design: .serif))
                    .foregroundStyle(CSE.cream.opacity(0.9))
            }
            .frame(width: px(layout.monogram.r * 2), height: px(layout.monogram.r * 2))
            .overlay(selectionBorder(.monogram))
            .overlay(alignment: .bottomTrailing) { resizeHandle(.monogram, scale: scale) }
            .offset(x: px(layout.monogram.cx - layout.monogram.r), y: px(layout.monogram.cy - layout.monogram.r))
            .gesture(moveGesture(.monogram, scale: scale))
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { selected = nil }
    }

    /// One draggable text block (anchor math mirrors the web editor).
    private func textBlock(_ el: Element, _ t: CSELayout.TextEl, scale: CGFloat) -> some View {
        func px(_ v: CGFloat) -> CGFloat { v * scale }
        let width = textWidths[el] ?? 0
        let anchorShift: CGFloat = t.justify == "middle" ? -width / 2 : t.justify == "end" ? -width : 0
        return Group {
            if !t.lines.isEmpty {
                VStack(alignment: t.justify == "middle" ? .center : t.justify == "end" ? .trailing : .leading,
                       spacing: max(0, px(t.leading - t.size * 1.2))) {
                    ForEach(Array(t.lines.enumerated()), id: \.offset) { _, ln in
                        Text(ln)
                            .font(.system(size: px(t.size), weight: t.weight, design: t.display ? .serif : .serif))
                            .kerning(px(t.letterSpacing))
                            .foregroundStyle(t.accent ? accent : CSE.cream)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                .background(GeometryReader { g in
                    Color.clear.onAppear { textWidths[el] = g.size.width }
                        .onChange(of: g.size.width) { _, w in textWidths[el] = w }
                })
                .overlay(selectionBorder(el))
                .overlay(alignment: .bottomTrailing) { resizeHandle(el, scale: scale) }
                .offset(x: px(t.x) + anchorShift, y: px(t.y - t.size * 0.8))
                .gesture(moveGesture(el, scale: scale))
            }
        }
    }

    @ViewBuilder private func selectionBorder(_ el: Element) -> some View {
        if selected == el {
            RoundedRectangle(cornerRadius: 3)
                .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [5]))
                .foregroundStyle(.white.opacity(0.85))
                .padding(-4)
        }
    }

    @ViewBuilder private func resizeHandle(_ el: Element, scale: CGFloat) -> some View {
        if selected == el {
            Circle().fill(AgentPalette.coral)
                .overlay(Circle().strokeBorder(.white, lineWidth: 2))
                .frame(width: 22, height: 22)
                .offset(x: 12, y: 12)
                .gesture(resizeGesture(el, scale: scale))
        }
    }

    // ── Gestures ────────────────────────────────────────────────────────────
    private func moveGesture(_ el: Element, scale: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 2)
            .onChanged { v in
                if dragStart == nil { dragStart = layout; selected = el }
                guard let base = dragStart, scale > 0 else { return }
                let dx = v.translation.width / scale
                let dy = v.translation.height / scale
                layout = moved(base, el, dx: dx, dy: dy)
            }
            .onEnded { _ in dragStart = nil }
    }

    private func resizeGesture(_ el: Element, scale: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { v in
                if dragStart == nil { dragStart = layout }
                guard let base = dragStart, scale > 0 else { return }
                let delta = (v.translation.width + v.translation.height) / (2 * scale)
                layout = resized(base, el, delta: delta)
            }
            .onEnded { _ in dragStart = nil }
    }

    private func moved(_ base: CSELayout, _ el: Element, dx: CGFloat, dy: CGFloat) -> CSELayout {
        var l = base
        switch el {
        case .eyebrow: l.eyebrow.x += dx; l.eyebrow.y += dy
        case .headline: l.headline.x += dx; l.headline.y += dy
        case .offer: l.offer.x += dx; l.offer.y += dy
        case .est: l.est.x += dx; l.est.y += dy
        case .codeBadge: l.codeBadge.cx += dx; l.codeBadge.cy += dy
        case .rule: l.rule.x += dx; l.rule.y += dy
        case .monogram: l.monogram.cx += dx; l.monogram.cy += dy
        case .logo: l.logo.x += dx; l.logo.y += dy
        }
        return l
    }

    private func resized(_ base: CSELayout, _ el: Element, delta: CGFloat) -> CSELayout {
        var l = base
        func clampf(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat { min(hi, max(lo, v)) }
        func scaleText(_ t: inout CSELayout.TextEl) {
            let ratio = clampf((t.size + delta * 0.5) / t.size, 0.3, 3)
            t.size = clampf(t.size * ratio, 10, 160)
            t.leading = clampf(t.leading * ratio, 14, 200)
        }
        switch el {
        case .eyebrow: scaleText(&l.eyebrow)
        case .headline: scaleText(&l.headline)
        case .offer: scaleText(&l.offer)
        case .est: scaleText(&l.est)
        case .codeBadge:
            let ratio = clampf((base.codeBadge.r + delta * 0.5) / base.codeBadge.r, 0.4, 3)
            l.codeBadge.r = clampf(base.codeBadge.r * ratio, 20, 160)
            l.codeBadge.size = clampf(base.codeBadge.size * ratio, 8, 80)
            l.codeLabelSize = clampf(base.codeLabelSize * ratio, 8, 60)
            l.codeLabelDy = base.codeLabelDy * ratio
        case .rule: l.rule.w = clampf(base.rule.w + delta, 10, 600)
        case .monogram:
            let ratio = clampf((base.monogram.r + delta * 0.5) / base.monogram.r, 0.4, 3)
            l.monogram.r = clampf(base.monogram.r * ratio, 8, 80)
            l.monogram.size = clampf(base.monogram.size * ratio, 8, 80)
        case .logo: l.logo.w = clampf(base.logo.w + delta, 60, 700)
        }
        return l
    }

    // ── Bottom controls: text edit, theme, apply ────────────────────────────
    private var controls: some View {
        VStack(spacing: 10) {
            if showText { textPanel }
            HStack(spacing: 8) {
                Button { withAnimation { showText.toggle() }; CSHaptic.tap() } label: {
                    Label(showText ? "লেখা লুকান" : "লেখা বদলান", systemImage: "character.cursor.ibeam")
                        .font(.system(size: 12.5, weight: .bold)).foregroundStyle(.white)
                        .padding(.vertical, 10).padding(.horizontal, 14)
                        .background(.white.opacity(0.12), in: Capsule())
                }.buttonStyle(.plain)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(CS.finishThemes, id: \.id) { t in
                            Button {
                                themeId = t.id
                                if eyebrow.isEmpty { relayoutText() }
                                CSHaptic.tap()
                            } label: {
                                Text(t.bn).font(.system(size: 12, weight: .bold))
                                    .foregroundStyle(themeId == t.id ? .white : .white.opacity(0.6))
                                    .padding(.vertical, 9).padding(.horizontal, 13)
                                    .background(themeId == t.id ? AnyShapeStyle(AgentPalette.coral) : AnyShapeStyle(Color.white.opacity(0.08)), in: Capsule())
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(.horizontal, 16)

            HStack(spacing: 10) {
                Button { fitContain.toggle(); CSHaptic.tap() } label: {
                    Label(fitContain ? "পুরো ছবি ✓" : "পুরো ছবি", systemImage: "rectangle.compress.vertical")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(fitContain ? .white : .white.opacity(0.6))
                        .padding(.vertical, 12).padding(.horizontal, 12)
                        .background(.white.opacity(fitContain ? 0.16 : 0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }.buttonStyle(.plain)
                Button { Task { await apply() } } label: {
                    HStack(spacing: 8) {
                        if busy { ProgressView().tint(.white) }
                        Text(busy ? "রেন্ডার হচ্ছে…" : "এভাবেই Final করুন ✅").font(.system(size: 14, weight: .bold))
                    }
                    .foregroundStyle(.white).frame(maxWidth: .infinity).padding(13)
                    .background(AgentPalette.coral, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }.buttonStyle(.plain).disabled(busy)
            }
            .padding(.horizontal, 16)

            Text("প্রিভিউ আনুমানিক — ফাইনাল ছবি সার্ভারে ব্র্যান্ড ফন্টে ঝকঝকে রেন্ডার হয়")
                .font(.system(size: 10)).foregroundStyle(.white.opacity(0.4))
                .padding(.bottom, 10)
        }
        .padding(.top, 8)
        .background(Color.black.opacity(0.5))
    }

    private var textPanel: some View {
        VStack(spacing: 8) {
            editorField("ছোট লাইন (খালি = থিম অনুযায়ী)", text: $eyebrow)
            editorField("মূল লেখা (headline)", text: $headline)
            editorField("অফার লাইন (খালি = ডিফল্ট)", text: $offer)
            editorField("Product code (যেমন ALM-315)", text: $code)
        }
        .padding(.horizontal, 16)
        .onChange(of: eyebrow) { _, _ in relayoutText() }
        .onChange(of: headline) { _, _ in relayoutText() }
        .onChange(of: offer) { _, _ in relayoutText() }
        .onChange(of: code) { _, _ in relayoutText() }
    }

    private func editorField(_ placeholder: String, text: Binding<String>) -> some View {
        TextField("", text: text, prompt: Text(placeholder).foregroundStyle(.white.opacity(0.35)))
            .font(.system(size: 13)).foregroundStyle(.white)
            .padding(10).background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    }

    /// Text changed → recompute the LINES (wrap) while keeping current geometry.
    private func relayoutText() {
        let eb = eyebrow.isEmpty ? CSE.eyebrowDefault(themeId) : eyebrow
        layout.eyebrow.lines = eb.isEmpty ? [] : [eb]
        layout.headline.lines = CSE.wrap(headline.isEmpty ? " " : headline, maxChars: 15, maxLines: 2)
        layout.offer.lines = CSE.wrap(offer.isEmpty ? CSE.defaultOffer : offer, maxChars: 18, maxLines: 2)
        layout.code = String(code.prefix(16))
        layout.codeBadge.size = CSE.codeSize(layout.code)
    }

    private func resetLayout() {
        let auto = CSELayout.auto(
            eyebrow: eyebrow.isEmpty ? CSE.eyebrowDefault(themeId) : eyebrow,
            headline: headline.isEmpty ? " " : headline,
            offer: offer.isEmpty ? CSE.defaultOffer : offer,
            code: code)
        layout = auto
        selected = nil
        CSHaptic.tap()
    }

    private func apply() async {
        let hl = headline.trimmingCharacters(in: .whitespaces)
        guard !hl.isEmpty else { vm.flash("মূল লেখাটা (headline) দিন"); return }
        guard let path = item.storagePath else { return }
        busy = true
        let framedUrl = await vm.finishImage(CSFinishPayload(
            storagePath: path,
            hook: hl,
            productCode: code.isEmpty ? nil : code,
            eyebrow: eyebrow.isEmpty ? nil : eyebrow,
            offer: offer.isEmpty ? nil : offer,
            mode: "lifestyle",
            theme: themeId,
            footer: false,
            fit: fitContain ? "contain" : "cover",
            pendingActionId: item.id.hasPrefix("sample-") ? nil : item.id,
            layout: CSLayoutOverridesData(from: layout)))
        busy = false
        if let framedUrl {
            framed = CS.url(framedUrl)
            onFinished(framedUrl)
            CSHaptic.tap()
        }
    }
}
