//
//  AlmaMetalOrbView.swift — SwiftUI host for the photoreal Metal glass orb.
//  Pairs with AlmaOrbMetal.metal. Drop both into the app target, then use
//  `AlmaMetalOrb(state:micLevel:ttsLevel:)` in place of `AlmaGlassOrbView(...)`
//  inside AssistantVoiceSwiftUI.swift (keep the halo/contact-shadow around it).
//
//  ⚠️ Prepared without Xcode — BUILD + SIM-VERIFY in an iOS session before ship.
//
import SwiftUI
import MetalKit
import simd

// Must match `struct Uniforms` in AlmaOrbMetal.metal (offsets: proj0 view64 model128 camPos192 time208 …).
private struct OrbUniforms {
    var proj:   matrix_float4x4
    var view:   matrix_float4x4
    var model:  matrix_float4x4
    var camPos: SIMD4<Float>
    var time:   Float
    var amp:    Float
    var detail: Float
    var irid:   Float
    var pad:    Float = 0
}

// ---- matrix helpers ----
private func perspective(_ fovy: Float, _ aspect: Float, _ near: Float, _ far: Float) -> matrix_float4x4 {
    let y = 1 / tan(fovy * 0.5)
    let x = y / aspect
    let z = far / (near - far)
    return matrix_float4x4(columns: (
        SIMD4<Float>( x, 0,  0,  0),
        SIMD4<Float>( 0, y,  0,  0),
        SIMD4<Float>( 0, 0,  z, -1),
        SIMD4<Float>( 0, 0, z*near, 0)
    ))
}
private func translation(_ x: Float, _ y: Float, _ z: Float) -> matrix_float4x4 {
    var m = matrix_identity_float4x4; m.columns.3 = SIMD4<Float>(x, y, z, 1); return m
}
private func rotationY(_ r: Float) -> matrix_float4x4 {
    let c = cos(r), s = sin(r)
    return matrix_float4x4(columns: (
        SIMD4<Float>( c, 0, -s, 0),
        SIMD4<Float>( 0, 1,  0, 0),
        SIMD4<Float>( s, 0,  c, 0),
        SIMD4<Float>( 0, 0,  0, 1)
    ))
}
private func rotationX(_ r: Float) -> matrix_float4x4 {
    let c = cos(r), s = sin(r)
    return matrix_float4x4(columns: (
        SIMD4<Float>(1, 0, 0, 0),
        SIMD4<Float>(0, c, s, 0),
        SIMD4<Float>(0,-s, c, 0),
        SIMD4<Float>(0, 0, 0, 1)
    ))
}
private func scaleM(_ s: Float) -> matrix_float4x4 {
    return matrix_float4x4(diagonal: SIMD4<Float>(s, s, s, 1))
}

// ---- renderer ----
final class OrbRenderer: NSObject, MTKViewDelegate {
    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private var pipeline: MTLRenderPipelineState!
    private var depthState: MTLDepthStencilState!
    private var posBuf: MTLBuffer!
    private var norBuf: MTLBuffer!
    private var idxBuf: MTLBuffer!
    private var idxCount = 0
    private let start = CACurrentMediaTime()

    // driven by the view
    var state = "idle"
    var micLevel: Float = 0
    var ttsLevel: Float = 0
    private var ampS: Float = 0.02
    private var iridS: Float = 1.0
    private var rot: Float = 0

    init?(_ mtkView: MTKView) {
        guard let dev = mtkView.device ?? MTLCreateSystemDefaultDevice(),
              let q = dev.makeCommandQueue() else { return nil }
        device = dev; queue = q
        super.init()
        buildMesh(segments: 96)
        buildPipeline(mtkView)
    }

    private func buildPipeline(_ view: MTKView) {
        guard let lib = device.makeDefaultLibrary() else { return }
        let desc = MTLRenderPipelineDescriptor()
        desc.vertexFunction = lib.makeFunction(name: "orb_vertex")
        desc.fragmentFunction = lib.makeFunction(name: "orb_fragment")
        desc.colorAttachments[0].pixelFormat = view.colorPixelFormat
        // premultiplied alpha over the transparent MTKView (page bg shows through)
        desc.colorAttachments[0].isBlendingEnabled = true
        desc.colorAttachments[0].sourceRGBBlendFactor = .one
        desc.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
        desc.colorAttachments[0].sourceAlphaBlendFactor = .one
        desc.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
        desc.depthAttachmentPixelFormat = .depth32Float
        pipeline = try? device.makeRenderPipelineState(descriptor: desc)

        let dd = MTLDepthStencilDescriptor()
        dd.depthCompareFunction = .less
        dd.isDepthWriteEnabled = true
        depthState = device.makeDepthStencilState(descriptor: dd)
    }

    private func buildMesh(segments seg: Int) {
        var pos = [SIMD3<Float>](); var nor = [SIMD3<Float>](); var idx = [UInt16]()
        for y in 0...seg {
            let v = Float(y) / Float(seg), th = v * .pi
            for x in 0...seg {
                let u = Float(x) / Float(seg), ph = u * 2 * .pi
                let p = SIMD3<Float>(sin(th)*cos(ph), cos(th), sin(th)*sin(ph))
                pos.append(p); nor.append(p)
            }
        }
        for y in 0..<seg { for x in 0..<seg {
            let a = UInt16(y*(seg+1)+x), b = UInt16((y+1)*(seg+1)+x)
            idx += [a, b, a+1, a+1, b, b+1]
        } }
        idxCount = idx.count
        posBuf = device.makeBuffer(bytes: pos, length: MemoryLayout<SIMD3<Float>>.stride*pos.count)
        norBuf = device.makeBuffer(bytes: nor, length: MemoryLayout<SIMD3<Float>>.stride*nor.count)
        idxBuf = device.makeBuffer(bytes: idx, length: MemoryLayout<UInt16>.stride*idx.count)
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        guard let pipeline, let rpd = view.currentRenderPassDescriptor,
              let drawable = view.currentDrawable,
              let cmd = queue.makeCommandBuffer(),
              let enc = cmd.makeRenderCommandEncoder(descriptor: rpd) else { return }

        let t = Float(CACurrentMediaTime() - start)
        let level = state == "speaking" ? ttsLevel : micLevel

        // per-state look (matches the WebGL/GLSL reference)
        let ampTarget: Float = state == "thinking" || state == "transcribing" ? 0.05
                              : state == "listening" || state == "speaking" ? 0.03 + level*0.06
                              : 0.02
        let flow: Float = state == "thinking" ? 1.6
                        : state == "listening" || state == "speaking" ? 1.0 + level*0.6 : 0.6
        ampS  += (ampTarget - ampS) * 0.1
        iridS += ((state == "thinking" ? 1.6 : 1.0) - iridS) * 0.08
        rot   += (state == "thinking" ? 0.4 : 0.12) * (1.0/60.0)

        // breathe / audio scale
        let breathe: Float = {
            switch state {
            case "idle", "error":            return 1 + 0.02*(1 - cos(2 * .pi * t / 6.0))
            case "transcribing", "thinking": return 1 + 0.02*(1 - cos(2 * .pi * t / 2.6))
            default:                         return 1 + min(1, max(0, level)) * 0.10
            }
        }()

        let dist: Float = 3.4
        let aspect = Float(view.drawableSize.width / max(1, view.drawableSize.height))
        let model = rotationY(rot) * rotationX(0.12) * scaleM(breathe)
        var u = OrbUniforms(
            proj:   perspective(42 * .pi/180, aspect, 0.1, 100),
            view:   translation(0, 0, -dist),
            model:  model,
            camPos: SIMD4<Float>(0, 0, dist, 1),
            time:   t * flow,
            amp:    ampS,
            detail: 2.0,
            irid:   iridS
        )

        enc.setRenderPipelineState(pipeline)
        enc.setDepthStencilState(depthState)
        enc.setCullMode(.back)
        enc.setVertexBuffer(posBuf, offset: 0, index: 0)
        enc.setVertexBuffer(norBuf, offset: 0, index: 1)
        enc.setVertexBytes(&u, length: MemoryLayout<OrbUniforms>.stride, index: 2)
        enc.setFragmentBytes(&u, length: MemoryLayout<OrbUniforms>.stride, index: 0)
        enc.drawIndexedPrimitives(type: .triangle, indexCount: idxCount,
                                  indexType: .uint16, indexBuffer: idxBuf, indexBufferOffset: 0)
        enc.endEncoding()
        cmd.present(drawable)
        cmd.commit()
    }
}

// ---- SwiftUI wrapper ----
struct AlmaMetalOrb: UIViewRepresentable {
    var state: String        // "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "error"
    var micLevel: Double = 0
    var ttsLevel: Double = 0

    // holds the renderer strongly — MTKView.delegate is weak
    final class Coordinator { var renderer: OrbRenderer? }
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> MTKView {
        let v = MTKView()
        v.device = MTLCreateSystemDefaultDevice()
        v.colorPixelFormat = .bgra8Unorm
        v.depthStencilPixelFormat = .depth32Float
        v.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        v.isOpaque = false
        v.backgroundColor = .clear
        v.preferredFramesPerSecond = 60
        v.enableSetNeedsDisplay = false
        v.isPaused = false
        if let r = OrbRenderer(v) { v.delegate = r; context.coordinator.renderer = r }
        return v
    }

    func updateUIView(_ v: MTKView, context: Context) {
        let r = context.coordinator.renderer
        r?.state = state
        r?.micLevel = Float(micLevel)
        r?.ttsLevel = Float(ttsLevel)
    }
}
