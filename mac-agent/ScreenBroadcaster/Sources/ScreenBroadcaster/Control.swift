/**
 * RC-1 — the CONTROL gate: what the phone is allowed to do to this Mac.
 *
 * The broadcaster is already the process that captures the screen, so it is
 * also the right place to inject touch: capture and injection share one
 * coordinate space, and killing the capture kills the control with it. But
 * being in the right place is not the same as being safe, so nothing reaches
 * the injector until it has passed every check in this file:
 *
 *   • armed        — the owner flipped the control switch (daemon wrote it to
 *                    our stdin); a video stream with no grant is view-only.
 *   • uid pinning  — messages from any other participant are dropped, even
 *                    though they are in the same Agora channel.
 *   • expiry       — the grant is a 120s lease the phone renews; a phone that
 *                    goes silent loses control on its own.
 *   • monotonic seq — a replayed or reordered packet is dropped, so a captured
 *                    message cannot be re-fired later.
 *   • freshness    — a message older than 10s is stale; drop it rather than
 *                    click somewhere the owner has stopped looking.
 *   • sanity       — coordinates are fractions of the display and must be in
 *                    range; a NaN or a 12.0 never becomes a click.
 *   • rate limits  — per-kind token buckets, so a bug or a hostile sender
 *                    cannot machine-gun the desktop.
 *
 * Every rejection is COUNTED. The counts ride the frame POST into the owner's
 * audit row, because a silent drop is indistinguishable from a bug.
 */
import CoreGraphics
import Foundation

// MARK: - Wire format

struct ControlMessage {
    enum Button: String { case left = "l", right = "r" }
    enum Action {
        /// Trackpad-style relative move; deltas are fractions of the display.
        case move(dx: Double, dy: Double)
        /// Absolute move (direct/zoomed mode); 0…1 fractions of the display.
        case position(x: Double, y: Double)
        case click(button: Button, count: Int, confirm: Bool, at: CGPoint?)
        case dragDown
        case dragUp
        case scroll(dx: Double, dy: Double)
        /// RC-2: text and key chords.
        case text(String)
        case key(name: String, mods: [String])
    }
    let seq: Int64
    let sentAt: Double // epoch milliseconds, phone clock
    let action: Action
}

enum ControlDecoder {
    /// Fractions never legitimately exceed half a screen in one packet.
    private static let maxDelta = 0.5

    static func decode(_ data: Data) -> ControlMessage? {
        guard data.count <= 1024,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = obj["v"] as? Int, version == 1,
              let seq = (obj["s"] as? NSNumber)?.int64Value,
              let sentAt = (obj["t"] as? NSNumber)?.doubleValue,
              let kind = obj["a"] as? String
        else { return nil }

        func frac(_ key: String, limit: Double) -> Double? {
            guard let n = (obj[key] as? NSNumber)?.doubleValue, n.isFinite, abs(n) <= limit
            else { return nil }
            return n
        }

        let action: ControlMessage.Action
        switch kind {
        case "m":
            guard let dx = frac("dx", limit: maxDelta), let dy = frac("dy", limit: maxDelta)
            else { return nil }
            action = .move(dx: dx, dy: dy)
        case "p":
            guard let x = frac("x", limit: 1), let y = frac("y", limit: 1), x >= 0, y >= 0
            else { return nil }
            action = .position(x: x, y: y)
        case "c":
            let button = ControlMessage.Button(rawValue: (obj["b"] as? String) ?? "l") ?? .left
            let count = min(max((obj["n"] as? Int) ?? 1, 1), 2)
            // RC-2.5: "cf" means the owner has two-step confirm on — the first
            // tap on a new target only aims, the second commits.
            // A direct (zoomed) tap arrives as ONE packet carrying its own
            // position, so a click can never be separated from the move that
            // aimed it — see the ordered/unordered stream split on the phone.
            var at: CGPoint?
            if let x = frac("x", limit: 1), let y = frac("y", limit: 1), x >= 0, y >= 0 {
                at = CGPoint(x: x, y: y)
            }
            action = .click(button: button, count: count, confirm: (obj["cf"] as? Int) == 1, at: at)
        case "dd": action = .dragDown
        case "du": action = .dragUp
        case "w":
            guard let dx = frac("dx", limit: maxDelta), let dy = frac("dy", limit: maxDelta)
            else { return nil }
            action = .scroll(dx: dx, dy: dy)
        case "k":
            guard let text = obj["txt"] as? String, !text.isEmpty, text.count <= 240 else { return nil }
            action = .text(text)
        case "kc":
            guard let name = obj["key"] as? String, !name.isEmpty, name.count <= 16 else { return nil }
            let mods = (obj["mods"] as? [String])?.prefix(4).map { String($0.prefix(8)) } ?? []
            action = .key(name: name, mods: Array(mods))
        default: return nil
        }
        return ControlMessage(seq: seq, sentAt: sentAt, action: action)
    }
}

// MARK: - Rate limiting

/// Classic token bucket: `rate` events per second, bursts up to `capacity`.
struct TokenBucket {
    let capacity: Double
    let rate: Double
    private var tokens: Double
    private var last: TimeInterval

    init(capacity: Double, rate: Double) {
        self.capacity = capacity
        self.rate = rate
        self.tokens = capacity
        self.last = Date().timeIntervalSince1970
    }

    mutating func take(_ now: TimeInterval) -> Bool {
        tokens = min(capacity, tokens + (now - last) * rate)
        last = now
        if tokens < 1 { return false }
        tokens -= 1
        return true
    }
}

// MARK: - The gate

final class ControlGate {
    /// Well above the server's 120s lease — this is a backstop, not the policy.
    private static let hardIdleSeconds: TimeInterval = 180
    /// Clock skew tolerance between the phone and this Mac.
    private static let maxAgeMs: Double = 10_000

    private let lock = NSLock()
    private var armedFlag = false
    private var pinnedUid: UInt = 0
    private var expiresAt: TimeInterval = 0
    private var session = ""
    private var lastSeq: Int64 = -1
    private var lastActivity = Date.distantPast
    private var eventCount = 0
    private var dropCount = 0
    private var moves = TokenBucket(capacity: 120, rate: 90)
    private var clicks = TokenBucket(capacity: 12, rate: 10)
    private var scrolls = TokenBucket(capacity: 90, rate: 70)
    private var keys = TokenBucket(capacity: 30, rate: 20)

    var isArmed: Bool { lock.lock(); defer { lock.unlock() }; return armedFlag }
    var sessionId: String { lock.lock(); defer { lock.unlock() }; return session }
    var counters: (events: Int, drops: Int) {
        lock.lock(); defer { lock.unlock() }
        return (eventCount, dropCount)
    }

    func arm(uid: UInt, expiresAt: TimeInterval, sessionId: String) {
        lock.lock(); defer { lock.unlock() }
        let newSession = sessionId != session
        armedFlag = true
        pinnedUid = uid
        self.expiresAt = expiresAt
        session = sessionId
        lastActivity = Date()
        if newSession {
            lastSeq = -1
            eventCount = 0
            dropCount = 0
        }
    }

    func disarm() {
        lock.lock(); defer { lock.unlock() }
        armedFlag = false
        pinnedUid = 0
        expiresAt = 0
        lastSeq = -1
    }

    enum Verdict { case accept(ControlMessage), drop(String) }

    /// The single choke point. Returns the reason on every rejection so the
    /// daemon log can say WHY the owner's tap did nothing.
    func admit(uid: UInt, data: Data) -> Verdict {
        let now = Date().timeIntervalSince1970
        lock.lock(); defer { lock.unlock() }

        func reject(_ why: String) -> Verdict {
            dropCount += 1
            return .drop(why)
        }

        guard armedFlag else { return reject("not_armed") }
        guard uid == pinnedUid else { return reject("uid_mismatch") }
        guard now < expiresAt + 5 else { return reject("grant_expired") }
        guard now - lastActivity.timeIntervalSince1970 < Self.hardIdleSeconds else {
            armedFlag = false
            return reject("idle_timeout")
        }
        guard let msg = ControlDecoder.decode(data) else { return reject("malformed") }
        guard msg.seq > lastSeq else { return reject("stale_seq") }
        guard abs(now * 1000 - msg.sentAt) < Self.maxAgeMs else { return reject("stale_time") }

        let allowed: Bool
        switch msg.action {
        case .move, .position: allowed = moves.take(now)
        case .click, .dragDown, .dragUp: allowed = clicks.take(now)
        case .scroll: allowed = scrolls.take(now)
        case .text, .key: allowed = keys.take(now)
        }
        guard allowed else { return reject("rate_limited") }

        lastSeq = msg.seq
        lastActivity = Date()
        eventCount += 1
        return .accept(msg)
    }
}
