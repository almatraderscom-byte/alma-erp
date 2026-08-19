//
//  CSMaskRepairSwiftUI.swift
//  ALMA — native Production V4 precision mask repair.
//
//  White marks the area to edit; black preserves the source. The preparation
//  upload is free. A signed server estimate and a separate owner confirmation
//  are required before the provider can be called.
//

import SwiftUI
import UIKit

@available(iOS 17.0, *)
struct CSMaskRepairSheet: View {
    let item: CSGalleryItem
    let vm: CreativeStudioVM

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var sourceImage: UIImage?
    @State private var strokes: [[CGPoint]] = []
    @State private var currentStroke: [CGPoint] = []
    @State private var canvasSize: CGSize = .zero
    @State private var brush: Double = 0.045
    @State private var preset = "repair"
    @State private var detail = "Repair only the painted area realistically; preserve identity, garment, lighting and perspective outside the mask."
    @State private var busy = false
    @State private var error: String?
    @State private var estimate: CSRunResponse?
    @State private var pendingPayload: CSRunPayload?
    @State private var confirmRun = false

    private let presets: [(id: String, label: String, prompt: String)] = [
        ("repair", "Repair", "Repair only the painted area realistically; preserve identity, garment, lighting and perspective outside the mask."),
        ("remove", "Remove", "Remove the painted object and reconstruct a realistic matching background. Preserve everything outside the mask."),
        ("garment_detail", "Garment detail", "Correct only the painted garment detail. Preserve fabric, print, seams, body pose, fit, lighting and perspective."),
    ]

    var body: some View {
        NavigationStack {
            ZStack {
                AgentPalette(scheme).bg0.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        instruction
                        editor
                        controls
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
            Text("Provider \(estimate?.provider ?? "—") · model \(estimate?.actualModel ?? "—") · estimate ৳\(estimate?.estimateBdt ?? 0, specifier: "%.0f") ($\(estimate?.estimateUsd ?? 0, specifier: "%.3f")) · hard cap ৳\(estimate?.maxCostBdt ?? 0, specifier: "%.0f"). এই confirmation-এর আগে কোনো paid call হয়নি।")
        }
    }

    private var instruction: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label("Paint only what should change", systemImage: "paintbrush.pointed.fill")
                .font(.system(size: 14, weight: .bold)).foregroundStyle(AgentPalette.coralLt)
            Text("সাদা brush = edit, বাকি অংশ অপরিবর্তিত। Source image কখনো overwrite হবে না; output নতুন version হিসেবে Gallery-তে আসবে।")
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
                        for stroke in strokes + (currentStroke.isEmpty ? [] : [currentStroke]) {
                            guard let first = stroke.first else { continue }
                            var path = Path()
                            path.move(to: CGPoint(x: first.x * size.width, y: first.y * size.height))
                            for point in stroke.dropFirst() {
                                path.addLine(to: CGPoint(x: point.x * size.width, y: point.y * size.height))
                            }
                            context.stroke(path, with: .color(.white.opacity(0.82)),
                                           style: StrokeStyle(lineWidth: brush * min(size.width, size.height), lineCap: .round, lineJoin: .round))
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

    private var controls: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Brush", systemImage: "circle.fill").font(.caption.weight(.bold))
                Slider(value: $brush, in: 0.015...0.12).tint(AgentPalette.coral)
                Button("Clear") { strokes = []; currentStroke = [] }
                    .font(.caption.weight(.bold)).foregroundStyle(.red)
            }
            HStack(spacing: 8) {
                ForEach(presets, id: \.id) { value in
                    Button(value.label) {
                        preset = value.id; detail = value.prompt; CSHaptic.tap()
                    }
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(preset == value.id ? .white : AgentPalette(scheme).muted)
                    .padding(.horizontal, 11).padding(.vertical, 8)
                    .background(preset == value.id ? AgentPalette.coral : Color.white.opacity(0.06), in: Capsule())
                }
            }
            TextField("Repair instruction", text: $detail, axis: .vertical)
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
            .disabled(sourceImage == nil || strokes.isEmpty || detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
            Text("Mask upload $0 · provider call only after the next confirmation")
                .font(.caption2).foregroundStyle(AgentPalette(scheme).muted)
                .frame(maxWidth: .infinity, alignment: .center)
        }.padding(14).v4MaskGlass(scheme)
    }

    private var drawGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                currentStroke.append(CGPoint(
                    x: min(1, max(0, value.location.x / max(1, canvasSize.width))),
                    y: min(1, max(0, value.location.y / max(1, canvasSize.height)))))
            }
            .onEnded { _ in
                if !currentStroke.isEmpty { strokes.append(currentStroke) }
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
        guard let image = sourceImage, !strokes.isEmpty else { return }
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

    private func renderMask(for image: UIImage) -> Data? {
        let size = CGSize(width: max(1, image.size.width), height: max(1, image.size.height))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let rendered = renderer.image { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            let cg = context.cgContext
            cg.setStrokeColor(UIColor.white.cgColor)
            cg.setLineWidth(CGFloat(brush) * min(size.width, size.height))
            cg.setLineCap(.round)
            cg.setLineJoin(.round)
            for stroke in strokes {
                guard let first = stroke.first else { continue }
                cg.beginPath()
                cg.move(to: CGPoint(x: first.x * size.width, y: first.y * size.height))
                for point in stroke.dropFirst() {
                    cg.addLine(to: CGPoint(x: point.x * size.width, y: point.y * size.height))
                }
                cg.strokePath()
            }
        }
        return rendered.pngData()
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
