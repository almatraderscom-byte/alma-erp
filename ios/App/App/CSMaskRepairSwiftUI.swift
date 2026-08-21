//
//  CSMaskRepairSwiftUI.swift
//  ALMA — native Production V4 precision mask repair (FLUX Fill).
//
//  White marks the area to edit; black preserves the source. The preparation
//  upload is free. A signed server estimate and a separate owner confirmation
//  are required before the provider can be called. Presets, brush/erase, undo,
//  clear, invert, size and feather mirror the web MaskEditor exactly
//  (mask-contract.ts ids; feather radius = max(2, maxSide / 256|96)).
//

import SwiftUI
import UIKit
import CoreImage
import CoreImage.CIFilterBuiltins

@available(iOS 17.0, *)
struct CSMaskRepairSheet: View {
    let item: CSGalleryItem
    let vm: CreativeStudioVM

    private struct Stroke { var points: [CGPoint]; var erase: Bool; var width: Double }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var sourceImage: UIImage?
    @State private var strokes: [Stroke] = []
    @State private var currentStroke: [CGPoint] = []
    @State private var canvasSize: CGSize = .zero
    @State private var brush: Double = 0.045
    @State private var erasing = false
    @State private var inverted = false
    @State private var feather = "soft"          // none | soft | wide (web default soft)
    @State private var preset = "repair_hand"
    @State private var detail = ""
    @State private var busy = false
    @State private var error: String?
    @State private var estimate: CSRunResponse?
    @State private var pendingPayload: CSRunPayload?
    @State private var confirmRun = false

    private var presetMeta: (id: String, bn: String, hint: String) {
        CS.maskPresets.first { $0.id == preset } ?? CS.maskPresets[2]
    }
    private var detailRequired: Bool { preset == "custom" || preset == "replace_background" }
    private var canEstimate: Bool {
        sourceImage != nil && (!strokes.isEmpty || inverted)
            && (!detailRequired || !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) && !busy
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AgentPalette(scheme).bg0.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        instruction
                        editor
                        tools
                        presetsCard
                        if let error {
                            Label(error, systemImage: "exclamationmark.triangle.fill")
                                .font(.caption).foregroundStyle(.orange)
                                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
                        }
                    }.padding(16)
                }
            }
            .navigationTitle("Precision repair")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("বন্ধ") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Undo") { if !strokes.isEmpty { strokes.removeLast() } }
                        .disabled(strokes.isEmpty || busy)
                }
            }
        }
        .task { await loadSource() }
        .alert("Signed estimate নিশ্চিত করবেন?", isPresented: $confirmRun) {
            Button("বাতিল", role: .cancel) { estimate = nil; pendingPayload = nil }
            Button("Confirm & Queue") {
                guard let payload = pendingPayload, let estimate else { return }
                Task {
                    if await vm.confirmRepair(payload, estimate: estimate) { dismiss() }
                    else { error = vm.toast ?? "Repair queue হয়নি" }
                }
            }
        } message: {
            Text(estimate?.confirmationBody ?? "")
        }
    }

    private var instruction: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label("শুধু যেটা বদলাবে সেটা আঁকুন", systemImage: "paintbrush.pointed.fill")
                .font(.system(size: 14, weight: .bold)).foregroundStyle(AgentPalette.coralLt)
            Text("সাদা brush = edit, বাকি অংশ অপরিবর্তিত। Source image কখনো overwrite হবে না; output নতুন version হিসেবে Gallery-তে আসবে। Mask upload $0 · provider call শুধু confirmation-এর পরে।")
                .font(.caption).foregroundStyle(AgentPalette(scheme).muted)
        }.padding(13).v4MaskGlass(scheme)
    }

    @ViewBuilder private var editor: some View {
        if let sourceImage {
            GeometryReader { proxy in
                let available = proxy.size.width
                let ratio = sourceImage.size.width / max(1, sourceImage.size.height)
                // Draw on the image's actual aspect-fit rectangle. Using the
                // full container would turn letterbox padding into source
                // coordinates and shift portrait-image repairs.
                let fittedHeight = min(proxy.size.height, available / max(0.01, ratio))
                let fittedWidth = min(available, fittedHeight * ratio)
                ZStack {
                    Image(uiImage: sourceImage).resizable().scaledToFit()
                    Canvas { context, size in
                        if inverted {
                            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.white.opacity(0.55)))
                        }
                        for stroke in strokes + (currentStroke.isEmpty ? [] : [Stroke(points: currentStroke, erase: erasing, width: brush)]) {
                            guard let first = stroke.points.first else { continue }
                            var path = Path()
                            path.move(to: CGPoint(x: first.x * size.width, y: first.y * size.height))
                            for point in stroke.points.dropFirst() {
                                path.addLine(to: CGPoint(x: point.x * size.width, y: point.y * size.height))
                            }
                            // Paint = white (edit), Erase = dark (keep) — always, like the web.
                            // Invert only flips the base bitmap under the strokes.
                            let paintsWhite = !stroke.erase
                            context.stroke(path, with: .color(paintsWhite ? .white.opacity(0.82) : .black.opacity(0.7)),
                                           style: StrokeStyle(lineWidth: stroke.width * min(size.width, size.height), lineCap: .round, lineJoin: .round))
                        }
                    }
                    .background(Color.black.opacity(0.13))
                    .contentShape(Rectangle())
                    .gesture(drawGesture)
                }
                .frame(width: fittedWidth, height: fittedHeight)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.white.opacity(0.15)))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                .onAppear { canvasSize = CGSize(width: fittedWidth, height: fittedHeight) }
                .onChange(of: proxy.size) { _, _ in canvasSize = CGSize(width: fittedWidth, height: fittedHeight) }
            }.frame(height: min(UIScreen.main.bounds.width * 1.3, 500))
        } else {
            VStack(spacing: 10) {
                ProgressView().tint(AgentPalette.coral)
                Text("Source image লোড হচ্ছে…").font(.caption).foregroundStyle(AgentPalette(scheme).muted)
            }.frame(maxWidth: .infinity, minHeight: 300).v4MaskGlass(scheme)
        }
    }

    /// Web toolbar: Brush · Erase · Undo (toolbar) · Clear · Invert · size · feather.
    private var tools: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                toolChip("Brush", "paintbrush.fill", on: !erasing) { erasing = false }
                toolChip("Erase", "eraser.fill", on: erasing) { erasing = true }
                toolChip("Invert", "arrow.triangle.2.circlepath", on: inverted) { inverted.toggle() }
                Spacer()
                Button("Clear") { strokes = []; currentStroke = []; inverted = false }
                    .font(.caption.weight(.bold)).foregroundStyle(.red).disabled(strokes.isEmpty && !inverted)
            }
            HStack {
                Label("Size", systemImage: "circle.fill").font(.caption.weight(.bold)).frame(width: 64, alignment: .leading)
                Slider(value: $brush, in: 0.015...0.12).tint(AgentPalette.coral)
                Text("\(Int((brush * 100).rounded()))").font(.caption2.monospacedDigit()).frame(width: 24)
            }
            HStack(spacing: 8) {
                Text("Feather").font(.caption.weight(.bold)).frame(width: 64, alignment: .leading)
                ForEach([("none", "None"), ("soft", "Soft"), ("wide", "Wide")], id: \.0) { id, label in
                    Button(label) { feather = id; CSHaptic.tap() }
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(feather == id ? .white : AgentPalette(scheme).muted)
                        .padding(.horizontal, 11).padding(.vertical, 7)
                        .background(feather == id ? AgentPalette.coral : Color.white.opacity(0.06), in: Capsule())
                }
                Spacer()
            }
            Text("Feather = mask-এর কিনারা নরম করে (web: max(2, side/256) soft · side/96 wide) — upload-এর আগেই apply হয়।")
                .font(.caption2).foregroundStyle(AgentPalette(scheme).muted)
        }.padding(14).v4MaskGlass(scheme)
    }

    private var presetsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Preset (mask-contract)").font(.caption.weight(.bold)).foregroundStyle(AgentPalette(scheme).muted)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], alignment: .leading, spacing: 8) {
                ForEach(CS.maskPresets, id: \.id) { value in
                    Button(value.bn) { preset = value.id; CSHaptic.tap() }
                        .font(.system(size: 11.5, weight: .bold)).lineLimit(1)
                        .foregroundStyle(preset == value.id ? .white : AgentPalette(scheme).muted)
                        .frame(maxWidth: .infinity).padding(.horizontal, 11).padding(.vertical, 9)
                        .background(preset == value.id ? AgentPalette.coral : Color.white.opacity(0.06), in: Capsule())
                }
            }
            TextField(presetMeta.hint + (detailRequired ? " *" : ""), text: $detail, axis: .vertical)
                .lineLimit(2...5).font(.caption)
                .padding(11).background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
            Button { Task { await prepareEstimate() } } label: {
                HStack {
                    if busy { ProgressView().tint(.white) }
                    Label(busy ? "Mask যাচাই হচ্ছে…" : "Upload mask & get exact estimate", systemImage: "checkmark.shield.fill")
                        .font(.system(size: 13.5, weight: .bold))
                }.frame(maxWidth: .infinity).padding(13)
            }
            .buttonStyle(.borderedProminent).tint(AgentPalette.coral)
            .disabled(!canEstimate)
            Text("FLUX Fill (fal) · source pixel অপরিবর্তিত · coverage/cost server যাচাই করে · তারপর আলাদা confirmation")
                .font(.caption2).foregroundStyle(AgentPalette(scheme).muted)
                .frame(maxWidth: .infinity, alignment: .center)
        }.padding(14).v4MaskGlass(scheme)
    }

    private func toolChip(_ label: String, _ icon: String, on: Bool, _ tap: @escaping () -> Void) -> some View {
        Button { tap(); CSHaptic.tap() } label: {
            Label(label, systemImage: icon).font(.system(size: 11, weight: .bold))
                .foregroundStyle(on ? .white : AgentPalette(scheme).muted)
                .padding(.horizontal, 11).padding(.vertical, 8)
                .background(on ? AgentPalette.coral : Color.white.opacity(0.06), in: Capsule())
        }.buttonStyle(.plain)
    }

    private var drawGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                currentStroke.append(CGPoint(
                    x: min(1, max(0, value.location.x / max(1, canvasSize.width))),
                    y: min(1, max(0, value.location.y / max(1, canvasSize.height)))))
            }
            .onEnded { _ in
                if !currentStroke.isEmpty { strokes.append(Stroke(points: currentStroke, erase: erasing, width: brush)) }
                currentStroke = []
            }
    }

    private func loadSource() async {
        guard let url = item.previewURL ?? item.imageURL else { error = "Source image URL নেই"; return }
        do {
            let data = try await CSMediaSaver.fetch(url)
            guard let image = UIImage(data: data) else { throw URLError(.cannotDecodeContentData) }
            sourceImage = image
        } catch { self.error = "Source image লোড হয়নি" }
    }

    private func prepareEstimate() async {
        guard let image = sourceImage, canEstimate else { return }
        busy = true; error = nil
        defer { busy = false }
        guard let png = renderMask(for: image) else { error = "Mask তৈরি হয়নি"; return }
        do {
            let uploaded = try await vm.uploadRepairMask(png, for: item)
            guard let payload = vm.repairPayload(for: item, mask: uploaded, preset: preset,
                                                 detail: detail.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
            guard let result = await vm.estimateRepair(payload) else { error = vm.toast ?? "Estimate পাওয়া যায়নি"; return }
            pendingPayload = payload
            estimate = result
            confirmRun = true
        } catch {
            if case let AlmaAPIError.http(_, body) = error {
                self.error = CS.serverMessage(body) ?? body
            } else { self.error = "Mask upload হয়নি" }
        }
    }

    /// Export: black background + painted strokes as white (erase = black, invert flips),
    /// feathered with a Gaussian blur, at the source's natural size — same as the web.
    private func renderMask(for image: UIImage) -> Data? {
        let size = CGSize(width: max(1, image.size.width), height: max(1, image.size.height))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let rendered = renderer.image { context in
            (inverted ? UIColor.white : UIColor.black).setFill()
            context.fill(CGRect(origin: .zero, size: size))
            let cg = context.cgContext
            cg.setLineCap(.round)
            cg.setLineJoin(.round)
            for stroke in strokes {
                guard let first = stroke.points.first else { continue }
                let white = !stroke.erase
                cg.setStrokeColor((white ? UIColor.white : UIColor.black).cgColor)
                cg.setFillColor((white ? UIColor.white : UIColor.black).cgColor)
                let brushWidth = CGFloat(stroke.width) * min(size.width, size.height)
                cg.setLineWidth(brushWidth)
                let start = CGPoint(x: first.x * size.width, y: first.y * size.height)
                if stroke.points.count == 1 {
                    let radius = brushWidth / 2
                    cg.fillEllipse(in: CGRect(x: start.x - radius, y: start.y - radius,
                                              width: brushWidth, height: brushWidth))
                    continue
                }
                cg.beginPath()
                cg.move(to: start)
                for point in stroke.points.dropFirst() {
                    cg.addLine(to: CGPoint(x: point.x * size.width, y: point.y * size.height))
                }
                cg.strokePath()
            }
        }
        return feathered(rendered)?.pngData() ?? rendered.pngData()
    }

    /// Web `featherRadiusPx`: none → 0; soft → max(2, side/256); wide → max(2, side/96).
    private func feathered(_ mask: UIImage) -> UIImage? {
        guard feather != "none", let cg = mask.cgImage else { return mask }
        let maxSide = max(mask.size.width, mask.size.height)
        let radius = max(2, (maxSide / (feather == "soft" ? 256 : 96)).rounded())
        let input = CIImage(cgImage: cg)
        let blur = CIFilter.gaussianBlur()
        blur.inputImage = input.clampedToExtent()
        blur.radius = Float(radius)
        guard let output = blur.outputImage?.cropped(to: input.extent) else { return mask }
        let ctx = CIContext(options: nil)
        guard let out = ctx.createCGImage(output, from: input.extent) else { return mask }
        return UIImage(cgImage: out)
    }
}

@available(iOS 17.0, *)
private extension View {
    func v4MaskGlass(_ scheme: ColorScheme) -> some View {
        background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.035 : 0.28),
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.12)))
    }
}
