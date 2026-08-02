/**
 * L9-B — Mac screen → Agora VIDEO broadcaster.
 *
 * The owner's ask (2026-08-02): watching the agent drive the Mac must feel
 * like live video — cursor motion, clicks, window changes — not a frame
 * slideshow. This executable is the daemon's video engine:
 *
 *   ScreenCaptureKit (cursor ON) → CVPixelBuffer → Agora external video source
 *
 * The daemon spawns it when a video stream starts and SIGTERMs it on stop —
 * process lifetime IS stream lifetime, so a daemon crash can never leave the
 * screen silently broadcasting. It prints one heartbeat line per second
 * (frames pushed) for the daemon log, and exits non-zero on any setup
 * failure so the daemon can fall back to the JPEG frame pipe.
 *
 * Args: --appid A --token T --channel C --uid N [--fps 15] [--maxdim 1600]
 */
import AgoraRtcKit
import ScreenCaptureKit
import CoreMedia
import Foundation

// ---- args -------------------------------------------------------------------
var opts: [String: String] = [:]
var argv = Array(CommandLine.arguments.dropFirst())
var i = 0
while i < argv.count {
    if argv[i].hasPrefix("--"), i + 1 < argv.count {
        opts[String(argv[i].dropFirst(2))] = argv[i + 1]
        i += 2
    } else { i += 1 }
}
guard let appId = opts["appid"], let token = opts["token"],
      let channel = opts["channel"], let uidStr = opts["uid"], let uid = UInt(uidStr) else {
    FileHandle.standardError.write("usage: --appid --token --channel --uid [--fps] [--maxdim]\n".data(using: .utf8)!)
    exit(2)
}
let fps = Int(opts["fps"] ?? "") ?? 15
let maxDim = Int(opts["maxdim"] ?? "") ?? 1600

// ---- agora ------------------------------------------------------------------
final class EngineDelegate: NSObject, AgoraRtcEngineDelegate {
    func rtcEngine(_ engine: AgoraRtcEngineKit, didOccurError errorCode: AgoraErrorCode) {
        print("agora_error \(errorCode.rawValue)")
    }
    func rtcEngine(_ engine: AgoraRtcEngineKit, didJoinChannel channel: String, withUid uid: UInt, elapsed: Int) {
        print("joined \(channel) uid=\(uid)")
    }
}
let delegate = EngineDelegate()
let config = AgoraRtcEngineConfig()
config.appId = appId
let engine = AgoraRtcEngineKit.sharedEngine(with: config, delegate: delegate)
engine.setChannelProfile(.liveBroadcasting)
engine.setClientRole(.broadcaster)
// The screen is our OWN video source — Agora must not open the camera.
engine.enableVideo()
engine.setExternalVideoSource(true, useTexture: false, sourceType: .videoFrame)
let joinResult = engine.joinChannel(byToken: token, channelId: channel, info: nil, uid: uid)
if joinResult != 0 {
    FileHandle.standardError.write("join_failed \(joinResult)\n".data(using: .utf8)!)
    exit(3)
}

// ---- capture ----------------------------------------------------------------
var pushed = 0
// Retained for the PROCESS lifetime — locals in the setup Task would be
// released by ARC once it finishes, silently ending capture while heartbeats
// kept printing (Codex P1).
var gStream: SCStream?
var gOutput: Output?

final class Output: NSObject, SCStreamOutput {
    let engine: AgoraRtcEngineKit
    init(engine: AgoraRtcEngineKit) { self.engine = engine }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let frame = AgoraVideoFrame()
        frame.format = 12 // CVPixelBuffer passthrough
        frame.textureBuf = pixelBuffer
        frame.time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        engine.pushExternalVideoFrame(frame)
        pushed += 1
    }
}

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    engine.leaveChannel(nil)
    AgoraRtcEngineKit.destroy()
    exit(4)
}

Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else { fail("no_display") }
        // Scale to maxDim on the long edge — phone screens do not need 5K.
        let w = display.width, h = display.height
        let scale = Double(maxDim) / Double(max(w, h))
        let cfg = SCStreamConfiguration()
        cfg.width = scale < 1 ? Int(Double(w) * scale) : w
        cfg.height = scale < 1 ? Int(Double(h) * scale) : h
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        cfg.showsCursor = true // the whole point — the owner watches the pointer
        // Agora external-frame format 12 expects an NV12 CVPixelBuffer — capture
        // in NV12 so the plane layout matches (Codex P1: BGRA in an NV12-declared
        // frame renders as garbage).
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        cfg.queueDepth = 5
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let stream = SCStream(filter: filter, configuration: cfg, delegate: nil)
        let output = Output(engine: engine)
        gStream = stream
        gOutput = output
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "cap"))
        try await stream.startCapture()
        print("capturing \(cfg.width)x\(cfg.height)@\(fps)")
    } catch {
        fail("capture_failed \(error)")
    }
}

// ---- lifetime ---------------------------------------------------------------
signal(SIGTERM) { _ in
    print("sigterm — leaving")
    AgoraRtcEngineKit.destroy()
    exit(0)
}
signal(SIGINT) { _ in
    AgoraRtcEngineKit.destroy()
    exit(0)
}
// Heartbeat: the daemon reads these to know frames are really flowing.
let beat = DispatchSource.makeTimerSource()
beat.schedule(deadline: .now() + 1, repeating: 1)
beat.setEventHandler {
    print("beat frames=\(pushed)")
    fflush(stdout)
}
beat.resume()
RunLoop.main.run()
