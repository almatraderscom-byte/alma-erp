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

final class ControlOverlay {
    static let shared = ControlOverlay()

    private var window: NSWindow?
    private var view: OverlayView?
    /// Bounds of the captured display in CG global coords (top-left origin).
    private var displayBounds: CGRect = .zero

    private init() {}

    func configure(displayBounds: CGRect) {
        self.displayBounds = displayBounds
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
        // screen; CGDisplayBounds is y-down from its top-left.
        let primaryHeight = (NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.main)?.frame.height
            ?? displayBounds.height
        let frame = NSRect(
            x: displayBounds.minX,
            y: primaryHeight - displayBounds.maxY,
            width: displayBounds.width,
            height: displayBounds.height,
        )
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
            if !armed { self.view?.ringRect = nil }
            self.view?.needsDisplay = true
            if !armed { self.window?.orderOut(nil) } else { self.window?.orderFrontRegardless() }
        }
    }

    /// Highlight the element the next click would snap to (nil clears it).
    func showRing(globalFrame: CGRect?) {
        DispatchQueue.main.async {
            guard self.view?.armed == true else { return }
            self.view?.ringRect = globalFrame.map { self.toLocal($0) }
            self.view?.needsDisplay = true
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

    override var isFlipped: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        guard armed else { return }
        if let r = ringRect {
            let path = NSBezierPath(roundedRect: r.insetBy(dx: -3, dy: -3), xRadius: 7, yRadius: 7)
            path.lineWidth = 2.5
            // ALMA coral — the same accent the phone UI uses for the control
            // switch, so the ring reads as "your finger", not as an app's own UI.
            NSColor(calibratedRed: 0.878, green: 0.478, blue: 0.373, alpha: 0.95).setStroke()
            path.stroke()
            NSColor(calibratedRed: 0.878, green: 0.478, blue: 0.373, alpha: 0.14).setFill()
            path.fill()
        }
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
