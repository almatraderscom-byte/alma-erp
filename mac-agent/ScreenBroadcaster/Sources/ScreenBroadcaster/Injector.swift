/**
 * RC-1 — turning an admitted control message into a real macOS event, and the
 * AX-snap that makes a phone-sized tap land on the thing the owner meant.
 *
 * The owner's requirement (2026-08-03) is the design driver: his Mac screen is
 * big, his phone is small, and a wrong click is worse than a slow one. Two
 * mechanisms answer that, and both live here:
 *
 *   1. Everything is RELATIVE by default (trackpad semantics). The finger
 *      moves the Mac's own cursor and the click lands where the CURSOR is —
 *      never under the finger, which would be covered by the finger anyway.
 *   2. Before a click, we ask the Accessibility tree what is actually under
 *      (or beside) the cursor and snap onto the nearest clickable element.
 *      Generic remote desktops cannot do this; we can, because the daemon
 *      family already reads the AX tree. Pixel-perfect aim stops being a
 *      requirement — being within ~30 points of the button is enough.
 *
 * The snap deliberately refuses to grab huge elements (a window, a scroll
 * area): snapping to a container would move the cursor somewhere the owner did
 * not point, which is the exact failure we are preventing.
 */
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

enum Injector {
    /// Bounds of the captured display in global (top-left origin) points.
    static var displayBounds: CGRect = CGDisplayBounds(CGMainDisplayID())
    /// Snap looks this far from the cursor for something clickable.
    static let snapRadius: CGFloat = 34
    private static var dragging = false
    private static let source = CGEventSource(stateID: .combinedSessionState)
    /// Our own idea of where the pointer is. Measured on the owner's Mac
    /// 2026-08-03: reading the system cursor immediately after posting a move
    /// still returns the OLD location, so a stream of relative moves computed
    /// from that read would each start from a stale base and swallow most of
    /// the motion. We own the position while we are driving, and re-sync from
    /// the real cursor whenever we have been idle — otherwise a human (or the
    /// agent) moving the mouse would be ignored.
    private static var virtualPoint: CGPoint = .zero
    private static var lastPostAt: TimeInterval = 0
    private static let resyncAfter: TimeInterval = 0.4
    /// When the last keyboard event went out — chords need a settle gap after
    /// a burst of typing (measured; see pressKey).
    private static var lastKeyAt: TimeInterval = 0

    /// The live system cursor, unfiltered.
    static func systemCursor() -> CGPoint {
        CGEvent(source: nil)?.location ?? CGPoint(x: displayBounds.midX, y: displayBounds.midY)
    }

    /// Where the next relative move / click starts from.
    static func cursor() -> CGPoint {
        let now = Date().timeIntervalSince1970
        if now - lastPostAt > resyncAfter || virtualPoint == .zero {
            virtualPoint = systemCursor()
        }
        return virtualPoint
    }

    static func clamp(_ p: CGPoint) -> CGPoint {
        CGPoint(
            x: min(max(p.x, displayBounds.minX + 1), displayBounds.maxX - 1),
            y: min(max(p.y, displayBounds.minY + 1), displayBounds.maxY - 1),
        )
    }

    // MARK: - Pointer

    @discardableResult
    static func move(dxFraction: Double, dyFraction: Double) -> CGPoint {
        let from = cursor()
        let p = clamp(CGPoint(
            x: from.x + CGFloat(dxFraction) * displayBounds.width,
            y: from.y + CGFloat(dyFraction) * displayBounds.height,
        ))
        post(p)
        return p
    }

    @discardableResult
    static func moveTo(xFraction: Double, yFraction: Double) -> CGPoint {
        let p = clamp(CGPoint(
            x: displayBounds.minX + CGFloat(xFraction) * displayBounds.width,
            y: displayBounds.minY + CGFloat(yFraction) * displayBounds.height,
        ))
        post(p)
        return p
    }

    private static func post(_ p: CGPoint) {
        // A moving mouse with the button held must send DRAGGED, not MOVED, or
        // the app under the cursor never sees the drag.
        let type: CGEventType = dragging ? .leftMouseDragged : .mouseMoved
        CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?
            .post(tap: .cghidEventTap)
        virtualPoint = p
        lastPostAt = Date().timeIntervalSince1970
    }

    /// RC-2.5 two-step confirm: which target has been AIMED at but not yet
    /// clicked, and when. A second tap on the same target within the window
    /// commits; anything else re-aims.
    private static var pendingTarget: CGRect?
    private static var pendingSince: TimeInterval = 0
    private static let confirmWindow: TimeInterval = 4

    /// The target currently AIMED at and still awaiting its second tap, if the
    /// window has not lapsed. The hover refresh reads this so its 90ms tick
    /// cannot quietly revert the ring to the ordinary style (Codex P2).
    static var pendingAim: CGRect? {
        guard let pendingTarget, Date().timeIntervalSince1970 - pendingSince < confirmWindow
        else { return nil }
        return pendingTarget
    }

    enum ClickOutcome { case clicked, aimed }

    /// Click at the cursor, snapping onto the nearest clickable element first.
    /// Returns the point clicked and the snapped element's frame (for the ring).
    @discardableResult
    static func click(
        button: ControlMessage.Button, count: Int, confirm: Bool = false, at: CGPoint? = nil,
    ) -> (point: CGPoint, frame: CGRect?, outcome: ClickOutcome) {
        // A direct tap names its own point; trackpad clicks use the cursor.
        if let at {
            moveTo(xFraction: Double(at.x), yFraction: Double(at.y))
        }
        var p = cursor()
        var frame: CGRect?
        if let target = AXSnap.target(near: p, radius: snapRadius) {
            frame = target.frame
            if !target.frame.insetBy(dx: 2, dy: 2).contains(p) {
                p = clamp(target.center)
                post(p)
            }
        }
        if confirm {
            let now = Date().timeIntervalSince1970
            // Without an AX frame the aim is the cursor point itself, so the
            // second tap has to be compared against the stored point — else a
            // plain desktop target could never be committed at all (Codex P2).
            let sameTarget = pendingTarget.map { previous in
                if let frame {
                    return abs(previous.midX - frame.midX) < 4 && abs(previous.midY - frame.midY) < 4
                }
                return hypot(previous.midX - p.x, previous.midY - p.y) < 12
            } ?? false
            let fresh = now - pendingSince < confirmWindow
            if !(sameTarget && fresh) {
                // First tap on this target: aim only. The owner sees the ring
                // go solid in the video and taps again to commit.
                pendingTarget = frame ?? CGRect(x: p.x - 1, y: p.y - 1, width: 2, height: 2)
                pendingSince = now
                return (p, frame, .aimed)
            }
            pendingTarget = nil
            pendingSince = 0
        }
        let (down, up): (CGEventType, CGEventType) = button == .right
            ? (.rightMouseDown, .rightMouseUp)
            : (.leftMouseDown, .leftMouseUp)
        let cgButton: CGMouseButton = button == .right ? .right : .left
        // count == 2 means "this is the SECOND click of a double" — the first
        // one was already delivered by the previous tap, so emit exactly one
        // event pair with clickState 2. Emitting a 1-then-2 burst here would
        // make a double-tap fire three physical clicks (Codex P1).
        let clickState = Int64(min(max(1, count), 2))
        for type in [down, up] {
            let ev = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: cgButton)
            ev?.setIntegerValueField(.mouseEventClickState, value: clickState)
            ev?.post(tap: .cghidEventTap)
        }
        return (p, frame, .clicked)
    }

    static func dragDown() {
        guard !dragging else { return }
        dragging = true
        let p = cursor()
        CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?
            .post(tap: .cghidEventTap)
    }

    static func dragUp() {
        guard dragging else { return }
        dragging = false
        let p = cursor()
        CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?
            .post(tap: .cghidEventTap)
    }

    /// Release a held drag without the phone asking — used when control ends
    /// mid-gesture, so a dropped connection can never leave the button stuck.
    static func releaseHeldButtons() {
        if dragging { dragUp() }
    }

    static func scroll(dxFraction: Double, dyFraction: Double) {
        let dy = Int32((dyFraction * Double(displayBounds.height)).rounded())
        let dx = Int32((dxFraction * Double(displayBounds.width)).rounded())
        guard dx != 0 || dy != 0 else { return }
        CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)?
            .post(tap: .cghidEventTap)
    }

    // MARK: - Keyboard (RC-2)

    private static let namedKeys: [String: CGKeyCode] = [
        "enter": 36, "return": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
        "esc": 53, "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
        "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34,
        "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15,
        "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
    ]

    static func typeText(_ text: String) {
        // Unicode injection, not keycodes: the owner types Bangla.
        for chunk in Array(text.utf16).chunked(into: 16) {
            for down in [true, false] {
                guard let ev = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
                var buf = chunk
                ev.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: &buf)
                ev.post(tap: .cghidEventTap)
            }
            usleep(6_000)
        }
        lastKeyAt = Date().timeIntervalSince1970
    }

    @discardableResult
    static func pressKey(name: String, mods: [String]) -> Bool {
        guard let code = namedKeys[name.lowercased()] else { return false }
        var flags: CGEventFlags = []
        for m in mods.map({ $0.lowercased() }) {
            switch m {
            case "cmd", "command", "meta": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt", "option": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            default: break
            }
        }
        // Measured on the owner's Mac 2026-08-03: a ⌘-chord fired immediately
        // after a burst of unicode typing was swallowed — the app was still
        // digesting the previous events. A few milliseconds of settle before
        // the chord, and between its own down and up, made it reliable. Real
        // fingers cannot press and release in zero time either.
        let sinceKey = Date().timeIntervalSince1970 - lastKeyAt
        if sinceKey < 0.04 { usleep(UInt32((0.04 - sinceKey) * 1_000_000)) }
        for down in [true, false] {
            guard let ev = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
            ev.flags = flags
            ev.post(tap: .cghidEventTap)
            usleep(12_000)
        }
        lastKeyAt = Date().timeIntervalSince1970
        return true
    }
}

extension Array {
    func chunked(into size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}

// MARK: - AX snap

enum AXSnap {
    private static let system: AXUIElement = {
        let el = AXUIElementCreateSystemWide()
        // A slow app must never stall the injector — a late snap is worse than
        // no snap, because the click has already been asked for.
        AXUIElementSetMessagingTimeout(el, 0.2)
        return el
    }()

    private static let clickableRoles: Set<String> = [
        "AXButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXCheckBox", "AXRadioButton",
        "AXPopUpButton", "AXTextField", "AXSearchField", "AXTextArea", "AXComboBox",
        "AXTabGroup", "AXDisclosureTriangle", "AXIncrementor", "AXSlider", "AXCell",
    ]

    static func isTrusted() -> Bool { AXIsProcessTrusted() }

    private static func attribute(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
    }

    private static func frame(of el: AXUIElement) -> CGRect? {
        guard let posValue = attribute(el, kAXPositionAttribute as String),
              let sizeValue = attribute(el, kAXSizeAttribute as String)
        else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        // swiftlint:disable:next force_cast
        guard AXValueGetValue(posValue as! AXValue, .cgPoint, &origin),
              // swiftlint:disable:next force_cast
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
        else { return nil }
        return CGRect(origin: origin, size: size)
    }

    private static func isClickable(_ el: AXUIElement) -> Bool {
        var actions: CFArray?
        if AXUIElementCopyActionNames(el, &actions) == .success,
           let names = actions as? [String], names.contains(kAXPressAction as String) {
            return true
        }
        guard let role = attribute(el, kAXRoleAttribute as String) as? String else { return false }
        return clickableRoles.contains(role)
    }

    /// A container is not a target: snapping to a window or a scroll area would
    /// move the cursor somewhere the owner never pointed.
    private static func isReasonableSize(_ r: CGRect) -> Bool {
        let d = Injector.displayBounds
        guard r.width > 3, r.height > 3 else { return false }
        if r.width > d.width * 0.6 && r.height > d.height * 0.4 { return false }
        return r.width * r.height < d.width * d.height * 0.25
    }

    private static func candidate(at p: CGPoint) -> (center: CGPoint, frame: CGRect)? {
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(p.x), Float(p.y), &element) == .success,
              let el = element else { return nil }
        // Walk up a couple of levels: the hit is often an AXStaticText INSIDE
        // the button the owner is aiming at.
        var current: AXUIElement? = el
        for _ in 0..<3 {
            guard let node = current else { break }
            if isClickable(node), let f = frame(of: node), isReasonableSize(f) {
                return (CGPoint(x: f.midX, y: f.midY), f)
            }
            current = attribute(node, kAXParentAttribute as String).map { $0 as! AXUIElement }
        }
        return nil
    }

    /// Nearest clickable element to `p`, or nil to click exactly where told.
    static func target(near p: CGPoint, radius: CGFloat) -> (center: CGPoint, frame: CGRect)? {
        guard isTrusted() else { return nil }
        if let direct = candidate(at: p) { return direct }
        var best: (center: CGPoint, frame: CGRect, distance: CGFloat)?
        for ring in [radius * 0.4, radius * 0.7, radius] {
            for angle in stride(from: 0.0, to: 2 * Double.pi, by: Double.pi / 4) {
                let probe = CGPoint(x: p.x + ring * CGFloat(cos(angle)), y: p.y + ring * CGFloat(sin(angle)))
                guard let hit = candidate(at: probe) else { continue }
                let d = hypot(hit.center.x - p.x, hit.center.y - p.y)
                if best == nil || d < best!.distance { best = (hit.center, hit.frame, d) }
            }
            if let found = best { return (found.center, found.frame) }
        }
        return nil
    }
}
