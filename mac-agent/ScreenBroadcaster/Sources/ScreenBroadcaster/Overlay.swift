/**
 * RC-1 — what the owner SEES while he drives the Mac from his phone.
 *
 * The snap in Injector.swift is only half of "no wrong clicks": the other half
 * is showing, before the finger commits, exactly which element the click would
 * land on. So the broadcaster paints on the Mac's own screen — which means the
 * marks travel down the video pipe that is already running, with no extra
 * channel and no phone-side guesswork about where the cursor is:
 *
 *   • a highlight ring around the element the snap has picked,
 *   • a short ripple where a click actually landed (red when it was refused),
 *   • a persistent badge while control is armed — anyone standing at the Mac
 *     can see that the phone is driving, which is a safety property, not decor.
 *
 * The window is click-through (`ignoresMouseEvents`) and sits above normal
 * windows; it can never eat the click it is drawing.
 */
import AppKit
import CoreGraphics
import CoreImage
import CoreVideo

/// The newest captured frame, kept so the RC-2.5 loupe can magnify what is
/// already on the wire instead of taking a second screenshot. `CGWindowList`
/// capture is gone from current macOS, and a second ScreenCaptureKit stream
/// would double the capture cost for a magnifier.
final class FrameStore {
    static let shared = FrameStore()
    private let lock = NSLock()
    private var buffer: CVPixelBuffer?
    /// Captured pixels per display point (the stream is downscaled to ≤1600).
    private var scale: CGFloat = 1
    private let context = CIContext(options: [.useSoftwareRenderer: false])

    func update(_ pixelBuffer: CVPixelBuffer, displaySize: CGSize) {
        lock.lock()
        defer { lock.unlock() }
        buffer = pixelBuffer
        if displaySize.width > 0 {
            scale = CGFloat(CVPixelBufferGetWidth(pixelBuffer)) / displaySize.width
        }
    }

    /// `rect` is in display points, top-left origin (the CGEvent space).
    func crop(_ rect: CGRect) -> CGImage? {
        lock.lock()
        let pixels = buffer
        let s = scale
        lock.unlock()
        guard let pixels else { return nil }
        let height = CGFloat(CVPixelBufferGetHeight(pixels))
        let image = CIImage(cvPixelBuffer: pixels)
        // CoreImage is y-up; the control space is y-down.
        let inPixels = CGRect(x: rect.minX * s, y: height - rect.maxY * s,
                              width: rect.width * s, height: rect.height * s)
        return context.createCGImage(image, from: inPixels.integral)
    }
}

final class ControlOverlay {
    static let shared = ControlOverlay()

    private var window: NSWindow?
    private var view: OverlayView?
    /// Bounds of the captured display in CG global coords (top-left origin).
    private var displayBounds: CGRect = .zero
    /// The captured display itself. With more than one screen, deriving the
    /// AppKit frame arithmetically puts the overlay on the wrong monitor (seen
    /// live the moment the owner's Mac had two screens) — asking AppKit which
    /// NSScreen carries this display id is exact.
    private var displayID: CGDirectDisplayID = 0

    private init() {}

    func configure(displayBounds: CGRect, displayID: CGDirectDisplayID) {
        self.displayBounds = displayBounds
        self.displayID = displayID
    }

    private func matchingScreen() -> NSScreen? {
        NSScreen.screens.first {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?
                .uint32Value == displayID
        }
    }

    /// CG global (y-down) → this window's local coords (y-up).
    private func toLocal(_ p: CGPoint) -> CGPoint {
        CGPoint(x: p.x - displayBounds.minX, y: displayBounds.maxY - p.y)
    }

    private func toLocal(_ r: CGRect) -> CGRect {
        CGRect(x: r.minX - displayBounds.minX, y: displayBounds.maxY - r.maxY, width: r.width, height: r.height)
    }

    private func ensureWindow() {
        guard window == nil, displayBounds != .zero else { return }
        // AppKit's global space is y-up from the bottom-left of the PRIMARY
        // screen; CGDisplayBounds is y-down from its top-left. Prefer the
        // screen's own frame — it is already in AppKit coordinates.
        let frame: NSRect
        if let screen = matchingScreen() {
            frame = screen.frame
        } else {
            let primaryHeight = (NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.main)?.frame.height
                ?? displayBounds.height
            frame = NSRect(
                x: displayBounds.minX,
                y: primaryHeight - displayBounds.maxY,
                width: displayBounds.width,
                height: displayBounds.height,
            )
        }
        let win = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        win.isOpaque = false
        win.backgroundColor = .clear
        win.hasShadow = false
        win.ignoresMouseEvents = true
        win.level = NSWindow.Level(Int(CGWindowLevelForKey(.screenSaverWindow)))
        win.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        let content = OverlayView(frame: NSRect(origin: .zero, size: frame.size))
        content.wantsLayer = true
        win.contentView = content
        win.orderFrontRegardless()
        window = win
        view = content
    }

    func setArmed(_ armed: Bool) {
        DispatchQueue.main.async {
            if armed { self.ensureWindow() }
            self.view?.armed = armed
            if !armed {
                self.view?.ringRect = nil
                self.view?.loupeImage = nil
            }
            self.view?.needsDisplay = true
            if !armed { self.window?.orderOut(nil) } else { self.window?.orderFrontRegardless() }
        }
    }

    /// Highlight the element the next click would snap to (nil clears it).
    /// `pending` draws the RC-2.5 two-step state: aimed, awaiting the second tap.
    func showRing(globalFrame: CGRect?, pending: Bool = false) {
        DispatchQueue.main.async {
            guard self.view?.armed == true else { return }
            self.view?.ringRect = globalFrame.map { self.toLocal($0) }
            self.view?.ringPending = pending
            self.view?.needsDisplay = true
        }
    }

    /// RC-2.5 loupe: a magnified patch of what is under the cursor, drawn ON
    /// the Mac screen so it reaches the phone through the video already
    /// running. Doing it here rather than on the phone means no second
    /// capture path and no guessing where the cursor is.
    func showLoupe(atGlobal point: CGPoint?) {
        DispatchQueue.main.async {
            guard let view = self.view, view.armed else { return }
            guard let point else {
                if view.loupeImage != nil {
                    view.loupeImage = nil
                    view.needsDisplay = true
                }
                return
            }
            let size = CGSize(width: 150, height: 110)
            // The frame buffer covers THIS display and starts at its own
            // (0,0); the cursor arrives in global coordinates, which on a
            // secondary screen begin somewhere else entirely (Codex P2).
            let local = CGPoint(x: point.x - self.displayBounds.minX,
                                y: point.y - self.displayBounds.minY)
            let rect = CGRect(x: local.x - size.width / 2, y: local.y - size.height / 2,
                              width: size.width, height: size.height)
            view.loupeImage = FrameStore.shared.crop(rect)
            view.loupeAt = self.toLocal(point)
            view.needsDisplay = true
        }
    }

    /// Brief mark where a click landed. `ok == false` paints the refusal red.
    func ripple(atGlobal point: CGPoint, ok: Bool) {
        DispatchQueue.main.async {
            self.ensureWindow()
            self.view?.ripple(at: self.toLocal(point), ok: ok)
        }
    }
}

final class OverlayView: NSView {
    var armed = false
    var ringRect: CGRect?
    /// Aimed but not yet committed (two-step confirm): drawn solid so the
    /// owner can tell "this is where the next tap goes" from "this is armed".
    var ringPending = false
    var loupeImage: CGImage?
    var loupeAt: CGPoint = .zero

    override var isFlipped: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        guard armed else { return }
        if let r = ringRect {
            let path = NSBezierPath(roundedRect: r.insetBy(dx: -3, dy: -3), xRadius: 7, yRadius: 7)
            path.lineWidth = ringPending ? 4 : 2.5
            // ALMA coral — the same accent the phone UI uses for the control
            // switch, so the ring reads as "your finger", not as an app's own UI.
            NSColor(calibratedRed: 0.878, green: 0.478, blue: 0.373, alpha: 0.95).setStroke()
            path.stroke()
            NSColor(calibratedRed: 0.878, green: 0.478, blue: 0.373, alpha: ringPending ? 0.30 : 0.14).setFill()
            path.fill()
        }
        drawLoupe()
        drawBadge()
    }

    private func drawBadge() {
        let text = "🖐 রিমোট কন্ট্রোল চালু"
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
            .foregroundColor: NSColor.white,
        ]
        let size = (text as NSString).size(withAttributes: attrs)
        let pad: CGFloat = 9
        let box = NSRect(
            x: bounds.maxX - size.width - pad * 2 - 18,
            y: bounds.maxY - size.height - pad * 2 - 18,
            width: size.width + pad * 2,
            height: size.height + pad * 2,
        )
        let bg = NSBezierPath(roundedRect: box, xRadius: 9, yRadius: 9)
        NSColor(calibratedRed: 0.878, green: 0.478, blue: 0.373, alpha: 0.92).setFill()
        bg.fill()
        (text as NSString).draw(at: NSPoint(x: box.minX + pad, y: box.minY + pad), withAttributes: attrs)
    }

    /// Drawn above and left of the cursor, clamped inside the screen: a
    /// fingertip-sized target becomes readable while dragging.
    private func drawLoupe() {
        guard let image = loupeImage else { return }
        let scale: CGFloat = 2.2
        let size = CGSize(width: 150 * scale / 2, height: 110 * scale / 2)
        // Parked in the corner FARTHEST from the cursor, not floating beside
        // it: the loupe magnifies the live frame, so a loupe drawn over the
        // magnified region would photograph itself every frame. Far corner =
        // the patch can never contain the panel.
        let inset: CGFloat = 16
        let left = loupeAt.x > bounds.midX
        let bottom = loupeAt.y > bounds.midY
        let origin = CGPoint(
            x: left ? inset : bounds.maxX - size.width - inset,
            y: bottom ? inset : bounds.maxY - size.height - inset)
        let box = NSRect(origin: origin, size: size)
        let clip = NSBezierPath(roundedRect: box, xRadius: 12, yRadius: 12)
        NSGraphicsContext.saveGraphicsState()
        clip.addClip()
        NSGraphicsContext.current?.cgContext.draw(image, in: box)
        NSGraphicsContext.restoreGraphicsState()
        NSColor(calibratedRed: 0.878, green: 0.478, blue: 0.373, alpha: 0.95).setStroke()
        clip.lineWidth = 2
        clip.stroke()
        // Crosshair marking the exact cursor point inside the magnified patch.
        let centre = CGPoint(x: box.midX, y: box.midY)
        let cross = NSBezierPath()
        cross.move(to: CGPoint(x: centre.x - 8, y: centre.y))
        cross.line(to: CGPoint(x: centre.x + 8, y: centre.y))
        cross.move(to: CGPoint(x: centre.x, y: centre.y - 8))
        cross.line(to: CGPoint(x: centre.x, y: centre.y + 8))
        cross.lineWidth = 1.2
        NSColor(calibratedRed: 0.878, green: 0.478, blue: 0.373, alpha: 0.9).setStroke()
        cross.stroke()
    }

    func ripple(at point: CGPoint, ok: Bool) {
        guard let host = layer else { return }
        let radius: CGFloat = 26
        let circle = CAShapeLayer()
        circle.path = CGPath(
            ellipseIn: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2),
            transform: nil,
        )
        circle.fillColor = NSColor.clear.cgColor
        circle.strokeColor = ok
            ? NSColor(calibratedRed: 0.878, green: 0.478, blue: 0.373, alpha: 1).cgColor
            : NSColor.systemRed.cgColor
        circle.lineWidth = 3
        host.addSublayer(circle)

        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 0.35
        grow.toValue = 1.0
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1.0
        fade.toValue = 0.0
        let group = CAAnimationGroup()
        group.animations = [grow, fade]
        group.duration = 0.32
        group.isRemovedOnCompletion = false
        group.fillMode = .forwards
        // Scale about the ripple's own centre, not the layer origin.
        circle.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        circle.bounds = CGRect(x: 0, y: 0, width: radius * 2, height: radius * 2)
        circle.position = point
        circle.path = CGPath(ellipseIn: CGRect(x: 0, y: 0, width: radius * 2, height: radius * 2), transform: nil)
        circle.add(group, forKey: "ripple")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.34) { circle.removeFromSuperlayer() }
    }
}
