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
import AppKit
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

// ---- control (RC-1) ----------------------------------------------------------
// The phone's touches arrive as Agora data-stream messages on the SAME channel
// that carries the video — no second connection, no server hop, so a tap costs
// what a video frame costs. Everything they can do is bounded by ControlGate.
let controlGate = ControlGate()

// ---- agora ------------------------------------------------------------------
final class EngineDelegate: NSObject, AgoraRtcEngineDelegate {
    func rtcEngine(_ engine: AgoraRtcEngineKit, didOccurError errorCode: AgoraErrorCode) {
        print("agora_error \(errorCode.rawValue)")
    }
    func rtcEngine(_ engine: AgoraRtcEngineKit, didJoinChannel channel: String, withUid uid: UInt, elapsed: Int) {
        print("joined \(channel) uid=\(uid)")
    }

    func rtcEngine(_ engine: AgoraRtcEngineKit, receiveStreamMessageFromUid uid: UInt, streamId: Int, data: Data) {
        switch controlGate.admit(uid: uid, data: data) {
        case .drop(let why):
            // Never log per-tap; log the KINDS that mean something is wrong.
            if why != "rate_limited" && why != "stale_seq" {
                print("ctl error \(why) uid=\(uid)")
                fflush(stdout)
            }
            if why == "idle_timeout" { ControlInput.disarm() }
        case .accept(let msg):
            ControlInput.apply(msg)
        }
    }
}

/// Applies an ADMITTED message. Everything here runs on the main thread: the
/// overlay is AppKit, and serialising injection also keeps the drag state and
/// the cursor's own position consistent.
enum ControlInput {
    static func apply(_ msg: ControlMessage) {
        DispatchQueue.main.async {
            switch msg.action {
            case .move(let dx, let dy):
                Injector.move(dxFraction: dx, dyFraction: dy)
                HoverRing.refreshSoon()
            case .position(let x, let y):
                Injector.moveTo(xFraction: x, yFraction: y)
                HoverRing.refreshSoon()
            case .click(let button, let count):
                let result = Injector.click(button: button, count: count)
                ControlOverlay.shared.showRing(globalFrame: result.frame)
                ControlOverlay.shared.ripple(atGlobal: result.point, ok: true)
            case .dragDown:
                Injector.dragDown()
            case .dragUp:
                Injector.dragUp()
            case .scroll(let dx, let dy):
                Injector.scroll(dxFraction: dx, dyFraction: dy)
            case .text(let text):
                Injector.typeText(text)
            case .key(let name, let mods):
                if !Injector.pressKey(name: name, mods: mods) {
                    print("ctl error unknown_key \(name)")
                    fflush(stdout)
                }
            }
        }
    }

    static func arm(uid: UInt, expiresAt: TimeInterval, sessionId: String) {
        controlGate.arm(uid: uid, expiresAt: expiresAt, sessionId: sessionId)
        ControlOverlay.shared.setArmed(true)
        HoverRing.start()
        if !AXSnap.isTrusted() {
            // Injection itself needs this too — say so once, loudly, instead of
            // letting every tap silently do nothing.
            print("ctl error ax_untrusted")
            fflush(stdout)
        }
    }

    static func disarm() {
        controlGate.disarm()
        HoverRing.stop()
        DispatchQueue.main.async { Injector.releaseHeldButtons() }
        ControlOverlay.shared.setArmed(false)
    }
}

/// Keeps the highlight ring under the cursor while control is armed, so the
/// owner always sees WHAT a tap would hit before he taps. Throttled — AX
/// hit-testing a slow app 60 times a second would cost more than it is worth.
enum HoverRing {
    private static var timer: DispatchSourceTimer?
    private static let queue = DispatchQueue(label: "hover-ring")

    static func start() {
        queue.async {
            guard timer == nil else { return }
            let t = DispatchSource.makeTimerSource(queue: queue)
            t.schedule(deadline: .now() + 0.1, repeating: 0.09)
            t.setEventHandler { refresh() }
            t.resume()
            timer = t
        }
    }

    static func stop() {
        queue.async {
            timer?.cancel()
            timer = nil
        }
        ControlOverlay.shared.showRing(globalFrame: nil)
    }

    static func refreshSoon() { queue.async { refresh() } }

    private static func refresh() {
        guard controlGate.isArmed else { return }
        let target = AXSnap.target(near: Injector.cursor(), radius: Injector.snapRadius)
        ControlOverlay.shared.showRing(globalFrame: target?.frame)
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
        // Count only frames Agora ACCEPTED — rejected pushes (failed join,
        // wrong state) must not produce a live-looking heartbeat (Codex P2).
        if engine.pushExternalVideoFrame(frame) { pushed += 1 }
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
        // RC-1: injection maps the phone's 0…1 fractions onto exactly the
        // display we are capturing, so what the owner sees and what he touches
        // are the same rectangle — the mapping is right by construction.
        let bounds = CGDisplayBounds(display.displayID)
        Injector.displayBounds = bounds
        ControlOverlay.shared.configure(displayBounds: bounds)
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

// ---- control pipe (stdin) ----------------------------------------------------
// The daemon writes grants here. stdin — not a respawn: `start` on a running
// stream only extends it (the L9 trap), and respawning would black out the
// video every time the owner armed control.
//
//   control on uid=<n> exp=<epoch-seconds> sid=<session>
//   control off
let stdinHandle = FileHandle.standardInput
var stdinBuffer = ""
stdinHandle.readabilityHandler = { handle in
    let chunk = handle.availableData
    if chunk.isEmpty { // daemon closed the pipe — control can no longer be renewed
        ControlInput.disarm()
        stdinHandle.readabilityHandler = nil
        return
    }
    stdinBuffer += String(decoding: chunk, as: UTF8.self)
    while let nl = stdinBuffer.firstIndex(of: "\n") {
        let line = String(stdinBuffer[stdinBuffer.startIndex..<nl]).trimmingCharacters(in: .whitespaces)
        stdinBuffer = String(stdinBuffer[stdinBuffer.index(after: nl)...])
        guard line.hasPrefix("control ") else { continue }
        if line == "control off" {
            ControlInput.disarm()
            print("ctl off")
            fflush(stdout)
            continue
        }
        var uid: UInt = 0
        var exp: TimeInterval = 0
        var sid = ""
        for field in line.split(separator: " ").dropFirst(2) {
            let parts = field.split(separator: "=", maxSplits: 1)
            guard parts.count == 2 else { continue }
            switch parts[0] {
            case "uid": uid = UInt(parts[1]) ?? 0
            case "exp": exp = TimeInterval(parts[1]) ?? 0
            case "sid": sid = String(parts[1])
            default: break
            }
        }
        guard uid > 0, exp > Date().timeIntervalSince1970 else {
            print("ctl error bad_grant")
            fflush(stdout)
            continue
        }
        ControlInput.arm(uid: uid, expiresAt: exp, sessionId: sid)
        print("ctl on uid=\(uid)")
        fflush(stdout)
    }
}

// ---- lifetime ---------------------------------------------------------------
signal(SIGTERM) { _ in
    print("sigterm — leaving")
    // A held mouse button must never outlive the process that pressed it.
    Injector.releaseHeldButtons()
    AgoraRtcEngineKit.destroy()
    exit(0)
}
signal(SIGINT) { _ in
    Injector.releaseHeldButtons()
    AgoraRtcEngineKit.destroy()
    exit(0)
}
// Heartbeat: the daemon reads these to know frames are really flowing, and
// (RC-1) how many control events were injected vs dropped — the audit numbers.
let beat = DispatchSource.makeTimerSource()
beat.schedule(deadline: .now() + 1, repeating: 1)
beat.setEventHandler {
    print("beat frames=\(pushed)")
    let counters = controlGate.counters
    if counters.events > 0 || counters.drops > 0 {
        print("ctl events=\(counters.events) drops=\(counters.drops)")
    }
    fflush(stdout)
}
beat.resume()

// AppKit, not RunLoop.main.run(): the highlight ring and the "control is
// armed" badge are real windows on the Mac's screen (that is how they reach
// the owner's phone — down the video pipe that is already running). Accessory
// policy keeps the broadcaster out of the Dock and the app switcher.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.run()
