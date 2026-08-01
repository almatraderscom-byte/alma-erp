/**
 * L8 (W3) — the daemon's UI driver: the agent's hands on the owner's Mac apps.
 *
 * W1 (docs/L8_AX_SPIKE.md) proved the macOS Accessibility tree is a full
 * control surface for both desktop apps (Claude, ChatGPT) — read the elements,
 * press the buttons, type into the composer, read the reply back as text. This
 * file turns that proof into daemon verbs:
 *
 *   ui_tree    read the app's element tree            (GREEN — read only)
 *   ui_scroll  scroll inside a window                 (GREEN — read only)
 *   ui_click   press one labelled element             (AMBER — owner approves)
 *   ui_type    type into one labelled field           (AMBER — owner approves)
 *   ui_key     press one key/shortcut                 (AMBER — owner approves)
 *   app_mirror start/stop mirroring the app's chat into the live dock (read)
 *
 * Every action is re-judged HERE with the daemon's own policy twin
 * (`./ui-policy.mjs` — W2). The server saying "approved" is necessary for
 * amber but never sufficient for red: a compromised server must not be able
 * to click "Delete" or type into Keychain, same rule as shell commands.
 *
 * W1's four lessons are load-bearing and deliberately baked in:
 *   1. `AXManualAccessibility` is set for Claude (Electron hides the tree
 *      without it) and skipped for ChatGPT (returns -25205, already full).
 *   2. Every search is scoped to ONE window resolved by title — both apps keep
 *      several windows (Codex panel, pet overlays) and an app-wide search can
 *      press a button in one window and type into a composer in another.
 *   3. The Swift helper is compiled ONCE with `swiftc -O` and cached; the
 *      interpreter's 8–15s startup is unusable at per-action cadence.
 *   4. Never drive while the owner is at the keyboard: real input within the
 *      policy's window means DEFER AND RETRY, not fail — his keystrokes and
 *      ours must never interleave.
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  classifyUiAction,
  normalizeKey,
  ALLOWED_APPS,
  OWNER_ACTIVE_WINDOW_SECONDS,
  POLICY_RULE_DIGEST,
  capTree,
} from './ui-policy.mjs'

const HOME = homedir()
const CONFIG_DIR = join(HOME, '.alma-mac-agent')

/** Rebuilt from the policy digest so the driver can never disagree with the
 *  classifier about which keys activate the focused element. */
const ACTIVATION_KEYS = new RegExp(
  POLICY_RULE_DIGEST.activationKeys.source,
  POLICY_RULE_DIGEST.activationKeys.flags,
)

// ---------------------------------------------------------------------------
// App registry — W1's per-app knowledge, keyed by bundle id. The ALLOWLIST
// lives in the policy (ui-policy.mjs); these are driving hints only, and an
// app the policy refuses stays refused whether or not it has hints here.
// ---------------------------------------------------------------------------

const APP_HINTS = {
  'com.anthropic.claudefordesktop': {
    key: 'claude',
    // Electron: the renderer tree is empty AXGroups until the flag is set.
    manual: true,
    windowTitle: 'Claude',
    composerDesc: 'Prompt',
    placeholders: ['Describe a task or ask a question', 'Type / for commands'],
    mirror: true, // structured AXDocumentArticle conversation — mirrorable
  },
  // The ChatGPT desktop app. Seen in the wild under BOTH bundle ids (the
  // 2026 builds on the owner's Mac report com.openai.codex); the policy
  // allowlist decides which of these is actually driveable.
  'com.openai.chat': {
    key: 'chatgpt',
    manual: false, // full tree by default; the flag returns -25205 (ignorable)
    windowTitle: 'ChatGPT',
    composerDesc: 'Do anything',
    placeholders: ['Do anything'],
    mirror: false, // no per-message structure yet (W1 §2) — refuse honestly
  },
  'com.openai.codex': {
    key: 'chatgpt',
    manual: false,
    windowTitle: 'ChatGPT',
    composerDesc: 'Do anything',
    placeholders: ['Do anything'],
    mirror: false,
  },
}

/**
 * `app` may arrive as a short name ("claude" / "chatgpt") or a bundle id.
 * Short names resolve ONLY through the policy's own allowlist, so a name the
 * policy does not know cannot smuggle in a bundle id the policy never sees.
 */
export /**
 * The wire contract, settled after W3 and W4 met on main: the SERVER sends the
 * already-resolved `bundleId` (it resolved it once, when the approval card was
 * written, so the card and the action name the same app). `app` stays accepted
 * as a friendly alias for hand-run probes and older callers. The daemon still
 * re-judges whatever id it ends up with against its own policy twin, so
 * accepting a resolved id concedes nothing.
 */
function resolveBundleId(app) {
  const raw = String(app ?? '').trim().toLowerCase()
  if (!raw) return null
  if (raw.includes('.')) return raw // already a bundle id — policy judges it
  for (const [bundleId, name] of Object.entries(ALLOWED_APPS)) {
    if (name.toLowerCase() === raw) return bundleId
    if (APP_HINTS[bundleId]?.key === raw) return bundleId
  }
  return raw // unknown name — the policy will refuse it by name, honestly
}

function hintsFor(bundleId) {
  return (
    APP_HINTS[bundleId] ?? {
      key: bundleId,
      manual: false,
      windowTitle: null,
      composerDesc: null,
      placeholders: [],
      mirror: false,
    }
  )
}

// ---------------------------------------------------------------------------
// The Swift helper — all AX work happens here (the AX C API is not reachable
// from Node). Compiled once with `swiftc -O` and cached by source hash;
// recompiles itself only when this file's embedded source changes.
// ---------------------------------------------------------------------------

const SWIFT_HELPER = String.raw`
import ApplicationServices
import AppKit

// ---- AX conveniences --------------------------------------------------------
func attr(_ el: AXUIElement, _ n: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, n as CFString, &v) == .success ? v : nil
}
func str(_ el: AXUIElement, _ n: String) -> String? { attr(el, n) as? String }
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func role(_ el: AXUIElement) -> String { str(el, kAXRoleAttribute) ?? "?" }
func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

func emit(_ obj: [String: Any]) {
    let d = try! JSONSerialization.data(withJSONObject: obj)
    print(String(data: d, encoding: .utf8)!)
}
func fail(_ code: String, _ detail: String = "") -> Never {
    emit(["ok": false, "code": code, "detail": detail])
    exit(1)
}

// ---- args -------------------------------------------------------------------
// helper <verb> [bundleId] [--manual] [--window T] [--label L] [--field D]
//        [--text T] [--key K] [--dir up|down] [--amount N] [--depth N]
//        [--require-empty p1|p2|…]
var argv = Array(CommandLine.arguments.dropFirst())
guard let verb = argv.first else { fail("usage") }
argv.removeFirst()
var flags: [String: String] = [:]
var positional: [String] = []
var i = 0
while i < argv.count {
    let a = argv[i]
    if a == "--manual" { flags["manual"] = "1"; i += 1 }
    else if a.hasPrefix("--") {
        guard i + 1 < argv.count else { fail("bad_args", a) }
        flags[String(a.dropFirst(2))] = argv[i + 1]
        i += 2
    } else { positional.append(a); i += 1 }
}

// ---- idle needs no AX, no app ----------------------------------------------
if verb == "idle" {
    let types: [CGEventType] = [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown,
                                .otherMouseDown, .mouseMoved, .leftMouseDragged, .scrollWheel]
    let idle = types.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
    emit(["ok": true, "idleSeconds": idle])
    exit(0)
}

guard AXIsProcessTrusted() else { fail("not_ax_trusted") }
guard let bundleId = positional.first else { fail("bundle_id_required") }
guard let runningApp = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
    fail("app_not_running", bundleId)
}
let pid = runningApp.processIdentifier
let app = AXUIElementCreateApplication(pid)

/// Electron hides the renderer tree until VoiceOver asks; the flag forces it
/// open. Idempotent; ChatGPT answers -25205 (unsupported) which is fine — its
/// tree is already full (W1). The tree builds ASYNCHRONOUSLY after the flag
/// flips, so wait only when it was genuinely closed.
if flags["manual"] != nil {
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    func treeOpen() -> Bool {
        var found = false
        func probe(_ el: AXUIElement, _ depth: Int) {
            if found || depth > 12 { return }
            if role(el) == "AXWebArea", !children(el).isEmpty { found = true; return }
            for c in children(el) { probe(c, depth + 1) }
        }
        for w in (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] { probe(w, 0) }
        return found
    }
    var waited = 0
    while !treeOpen() && waited < 4000 { usleep(250_000); waited += 250 }
}

// ---- walkers ----------------------------------------------------------------
func walk(_ el: AXUIElement, _ depth: Int, _ maxDepth: Int, _ visit: (AXUIElement, Int) -> Bool) {
    if depth > maxDepth { return }
    if !visit(el, depth) { return }
    for c in children(el) { walk(c, depth + 1, maxDepth, visit) }
}
func findFirst(_ el: AXUIElement, _ maxDepth: Int, _ pred: (AXUIElement) -> Bool) -> AXUIElement? {
    var found: AXUIElement?
    walk(el, 0, maxDepth) { e, _ in
        if found != nil { return false }
        if pred(e) { found = e; return false }
        return true
    }
    return found
}

/// ONE window, resolved by title — W1 lesson #2. "-" or absent = the app's
/// main/front window; a named title that is missing is an error listing what
/// exists, never a silent fallback to a different window.
func resolveWindow() -> AXUIElement {
    let wins = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    if wins.isEmpty { fail("no_windows") }
    let want = flags["window"] ?? "-"
    if want == "-" {
        if let main = wins.first(where: { (attr($0, kAXMainAttribute) as? Bool) == true }) { return main }
        return wins[0]
    }
    if let w = wins.first(where: { str($0, kAXTitleAttribute) == want }) { return w }
    fail("window_not_found", wins.compactMap { str($0, kAXTitleAttribute) }.joined(separator: " | "))
}

func lineFor(_ el: AXUIElement, values: Bool) -> String {
    var line = role(el)
    if let s = str(el, kAXSubroleAttribute) { line += "/\(s)" }
    if let t = str(el, kAXTitleAttribute), !t.isEmpty { line += " T=\"\(t.prefix(80))\"" }
    if let d = str(el, kAXDescriptionAttribute), !d.isEmpty { line += " D=\"\(d.prefix(80))\"" }
    if values, let v = attr(el, kAXValueAttribute) as? String, !v.isEmpty { line += " V=\"\(v.prefix(60))\"" }
    return line
}

func snapshot(_ scope: AXUIElement) -> [String] {
    var lines: [String] = []
    var count = 0
    walk(scope, 0, 40) { el, _ in
        count += 1
        if count > 15000 { return false }
        lines.append(lineFor(el, values: true))
        return true
    }
    return lines
}

/// The diff every action returns — "did my click work?" answerable without a
/// screenshot round trip (W1 / macos-use).
func diffLines(_ before: [String], _ after: [String]) -> [String: Any] {
    var b: [String: Int] = [:]; for l in before { b[l, default: 0] += 1 }
    var a: [String: Int] = [:]; for l in after { a[l, default: 0] += 1 }
    var added: [String] = [], removed: [String] = []
    for (l, c) in a where c > (b[l] ?? 0) { for _ in 0..<min(c - (b[l] ?? 0), 3) { added.append(l) } }
    for (l, c) in b where c > (a[l] ?? 0) { for _ in 0..<min(c - (a[l] ?? 0), 3) { removed.append(l) } }
    return ["added": Array(added.prefix(25)), "removed": Array(removed.prefix(25)),
            "addedCount": added.count, "removedCount": removed.count]
}

func labelOf(_ el: AXUIElement) -> String {
    if let t = str(el, kAXTitleAttribute), !t.isEmpty { return t }
    if let d = str(el, kAXDescriptionAttribute), !d.isEmpty { return d }
    return role(el)
}

// ---- input synthesis (proven in W1: postToPid after activate) ---------------
func activate() {
    runningApp.activate(options: [])
    usleep(600_000)
}

/// Key events posted to a pid land in the app's KEY window — which, with the
/// Codex pet overlays and helper windows around, is not reliably the window
/// we resolved by title (W1 lesson #2, resurfaced by Codex on the W3 PR).
/// Make the resolved window the focused/frontmost one before synthesising.
func frontWindow(_ win: AXUIElement) {
    AXUIElementSetAttributeValue(app, kAXFocusedWindowAttribute as CFString, win)
    AXUIElementPerformAction(win, kAXRaiseAction as CFString)
    usleep(250_000)
}
/// REAL input only — .hidSystemState sees the hardware, not our postToPid
/// synthesis, so this can run DURING typing without seeing our own keystrokes.
func hardwareIdleSeconds() -> Double {
    let types: [CGEventType] = [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown,
                                .otherMouseDown, .mouseMoved, .leftMouseDragged, .scrollWheel]
    return types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? 0
}

/// The policy's owner-active window, passed in by the driver so there is ONE
/// threshold with ONE meaning (W2's OWNER_ACTIVE_WINDOW_SECONDS = 25). A
/// second, looser literal here let a request the policy would defer — he
/// typed 3s ago and paused — slip through the last-instant guard (Codex P2,
/// head-confirmed).
let idleWindow = Double(flags["idle-window"] ?? "") ?? 25.0

/// The LAST gate before any synthesis reaches the app. classifyDeferring()
/// sampled idle on the driver side, but opening the Electron tree, activating
/// the app and fronting the window take seconds — the owner can touch the
/// machine inside exactly that gap. Same doctrine as the mid-type abort, at
/// the tightest possible window (Codex round 3, head-confirmed).
func guardOwnerStill() {
    if hardwareIdleSeconds() < idleWindow { fail("owner_interrupted", "input at synthesis time") }
}

func typeUnicode(_ text: String) {
    guardOwnerStill()
    let src = CGEventSource(stateID: .combinedSessionState)
    var count = 0
    for scalar in text {
        // A 4,000-char message is ~48s of synthesis after ONE idle check — the
        // owner can come back mid-type and his keystrokes would interleave
        // with ours (the exact failure W1's draft guard caught live). Watch
        // the hardware while typing and abort the moment he touches anything.
        // (hid idle is >= idleWindow at start thanks to the gate, and only a
        // real touch can pull it back under it.)
        if count > 0 && count % 20 == 0 && hardwareIdleSeconds() < idleWindow {
            fail("owner_interrupted", "typed \(count) of \(text.count) chars")
        }
        count += 1
        var units = Array(String(scalar).utf16)
        for down in [true, false] {
            let ev = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)!
            ev.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
            ev.postToPid(pid)
        }
        usleep(12_000)
    }
}
/// Every base key the driver's canSynthesizeKey() promises — the two tables
/// MUST stay in step, or a combo classifies AMBER, gets approved, and then
/// dies at synthesis ("he approved and nothing happened" — Codex P2).
let BASE_KEYS: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "escape": 53,
    "delete": 51, "forwarddelete": 117,
    "up": 126, "down": 125, "left": 123, "right": 124,
    "pageup": 116, "pagedown": 121, "home": 115, "end": 119,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
    "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
    "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
    "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26,
    "8": 28, "9": 25,
    "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41, "'": 39,
    ",": 43, ".": 47, "/": 44, "\u{60}": 50, // \u{60} = backtick (a literal one would end the JS template string)
]
let MODIFIER_FLAGS: [String: CGEventFlags] = [
    "cmd": .maskCommand, "ctrl": .maskControl, "opt": .maskAlternate, "shift": .maskShift,
]
/// Combos arrive already normalized by the policy (cmd/ctrl/opt/shift + base).
func pressKey(_ combo: String) {
    guardOwnerStill()
    let parts = combo.lowercased().split(separator: "+").map(String.init)
    guard let baseName = parts.last, let code = BASE_KEYS[baseName] else { fail("unknown_key", combo) }
    var mods: CGEventFlags = []
    for m in parts.dropLast() {
        guard let f = MODIFIER_FLAGS[m] else { fail("unknown_key", combo) }
        mods.insert(f)
    }
    let src = CGEventSource(stateID: .combinedSessionState)
    for down in [true, false] {
        let ev = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)!
        ev.flags = mods
        ev.postToPid(pid)
    }
}

// ---- verbs ------------------------------------------------------------------
switch verb {

case "info":
    let wins = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    emit(["ok": true, "pid": Int(pid),
          "windows": wins.compactMap { str($0, kAXTitleAttribute) }])

case "tree":
    let win = resolveWindow()
    let maxDepth = Int(flags["depth"] ?? "") ?? 25
    var lines: [String] = []
    var count = 0
    walk(win, 0, maxDepth) { el, depth in
        count += 1
        if count > 15000 { return false }
        lines.append(String(repeating: " ", count: depth) + lineFor(el, values: true))
        return true
    }
    emit(["ok": true, "elements": count, "tree": lines.joined(separator: "\n")])

case "focused":
    // What would an activation key (Return/Space) actually hit? The policy
    // refuses to judge a blind Enter — this is where focusedLabel comes from.
    guard let el = attr(app, kAXFocusedUIElementAttribute) else { fail("no_focus") }
    let f = el as! AXUIElement
    emit(["ok": true, "role": role(f), "label": labelOf(f)])

case "click":
    guard let label = flags["label"], !label.isEmpty else { fail("label_required") }
    let win = resolveWindow()
    let pressableRoles: Set<String> = ["AXButton", "AXMenuItem", "AXCheckBox", "AXRadioButton",
                                       "AXPopUpButton", "AXLink", "AXMenuButton", "AXDisclosureTriangle"]
    // EXACT equality only — the policy judged this literal label, so the label
    // of the element we press must BE that string. A substring/nearest match
    // is how a judged "Send" lands on "Send feedback" (Codex P1).
    guard let target = findFirst(win, 40, { el in
        pressableRoles.contains(role(el)) &&
            (str(el, kAXTitleAttribute) == label || str(el, kAXDescriptionAttribute) == label)
    }) else { fail("element_not_found", label) }
    let resolved = labelOf(target)
    if resolved != label { fail("label_mismatch", resolved) }
    let before = snapshot(win)
    guardOwnerStill()
    guard AXUIElementPerformAction(target, kAXPressAction as CFString) == .success else {
        fail("press_failed", label)
    }
    usleep(900_000) // give the UI a beat to react before diffing
    emit(["ok": true, "clicked": label, "resolvedLabel": resolved,
          "diff": diffLines(before, snapshot(win))])

case "type":
    guard let field = flags["field"], !field.isEmpty else { fail("field_required") }
    guard let text = flags["text"], !text.isEmpty else { fail("text_required") }
    let win = resolveWindow()
    // EXACT equality only — same contract as click: the policy judged this
    // literal field label (including its secret-field rules), so a substring
    // match ("word" finding "Password") would act on an element the policy
    // never saw (Codex P1).
    guard let composer = findFirst(win, 40, { el in
        (role(el) == "AXTextArea" || role(el) == "AXTextField") &&
            (str(el, kAXDescriptionAttribute) == field || str(el, kAXTitleAttribute) == field)
    }) else { fail("field_not_found", field) }
    let resolvedField = labelOf(composer)
    if resolvedField != field { fail("label_mismatch", resolvedField) }

    // Hard guard from W1 (it FIRED live): refuse to type unless the field
    // holds nothing but its known placeholder — a draft the owner left, or a
    // character he just typed, must never be swept into our message.
    let placeholders = (flags["require-empty"] ?? "").split(separator: "|").map(String.init)
    let before = (attr(composer, kAXValueAttribute) as? String) ?? ""
    let trimmed = before.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty && !placeholders.isEmpty && !placeholders.contains(trimmed) {
        fail("field_not_empty", String(trimmed.prefix(120)))
    }

    let winBefore = snapshot(win)
    activate()
    frontWindow(win) // keystrokes land in the KEY window — make it the resolved one
    AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(300_000)
    typeUnicode(text)
    usleep(500_000)
    // W1's deferred P2, now mandatory: assert the field actually changed —
    // "I typed" without proof is exactly the claim-without-verification the
    // whole program bans.
    let after = (attr(composer, kAXValueAttribute) as? String) ?? ""
    if !after.contains(text) { fail("typed_not_landed", String(after.prefix(120))) }
    emit(["ok": true, "typed": text.count, "resolvedLabel": resolvedField,
          "fieldValue": String(after.prefix(200)),
          "diff": diffLines(winBefore, snapshot(win))])

case "key":
    guard let key = flags["key"], !key.isEmpty else { fail("key_required") }
    let win = resolveWindow()
    let before = snapshot(win)
    activate()
    frontWindow(win) // the key event goes to the KEY window — make it the resolved one
    // The policy judged an activation key against a FOCUSED label resolved
    // moments ago in the driver — focus can move (the owner-idle wait can be
    // minutes). Re-verify at the last instant, AFTER fronting the window and
    // atomically with the press; mismatch is a refusal, never a guess
    // (Codex P1 TOCTOU).
    if let expect = flags["expect-focused"], !expect.isEmpty {
        guard let f = attr(app, kAXFocusedUIElementAttribute) else { fail("focus_changed", "nothing focused") }
        let now = labelOf(f as! AXUIElement)
        if now != expect { fail("focus_changed", now) }
    }
    pressKey(key)
    usleep(900_000)
    emit(["ok": true, "key": key, "diff": diffLines(before, snapshot(win))])

case "scroll":
    let win = resolveWindow()
    let dir = flags["dir"] ?? "down"
    let amount = Int32(flags["amount"] ?? "") ?? 5
    let wheel = dir == "up" ? amount : -amount
    activate()
    frontWindow(win) // scroll routes through the key window too — front the resolved one
    guardOwnerStill()
    let ev = CGEvent(scrollWheelEvent2Source: CGEventSource(stateID: .combinedSessionState),
                     units: .line, wheelCount: 1, wheel1: wheel, wheel2: 0, wheel3: 0)!
    ev.postToPid(pid)
    emit(["ok": true, "scrolled": dir, "amount": Int(amount)])

case "convo":
    // The chat-mirroring read (W1 §2): Claude's messages are AXDocumentArticle
    // groups whose headings say who spoke. Skippable chrome by description.
    let skip: Set<String> = ["Message actions", "Notifications (F8)"]
    func collectText(_ el: AXUIElement, into out: inout [String]) {
        if let d = str(el, kAXDescriptionAttribute), skip.contains(d) { return }
        if role(el) == "AXStaticText", let v = attr(el, kAXValueAttribute) as? String, !v.isEmpty {
            out.append(v)
        }
        for c in children(el) { collectText(c, into: &out) }
    }
    let win = resolveWindow()
    var articles: [AXUIElement] = []
    walk(win, 0, 40) { el, _ in
        if role(el) == "AXGroup", str(el, kAXSubroleAttribute) == "AXDocumentArticle" {
            articles.append(el)
            return false
        }
        return true
    }
    var messages: [[String: String]] = []
    for a in articles {
        let isUser = findFirst(a, 10) { el in
            role(el) == "AXHeading" && (str(el, kAXTitleAttribute) ?? "").hasPrefix("You said")
        } != nil
        var texts: [String] = []
        collectText(a, into: &texts)
        // Both headings duplicate the message body ("You said: …" /
        // "Claude responded: …" appear as static text too) — drop the copies.
        let body = texts.filter { !$0.hasPrefix("You said:") && !$0.hasPrefix("Claude responded:") }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !body.isEmpty { messages.append(["who": isUser ? "owner" : "assistant", "text": String(body.prefix(4000))]) }
    }
    emit(["ok": true, "messages": messages])

default:
    fail("unknown_verb", verb)
}
`

let compiledHelperPath = null
let compileInFlight = null

/** Compile once, cache by source hash — W1 lesson #3. */
function helperBinary() {
  if (compiledHelperPath) return Promise.resolve(compiledHelperPath)
  if (compileInFlight) return compileInFlight
  compileInFlight = (async () => {
    const hash = createHash('sha256').update(SWIFT_HELPER).digest('hex').slice(0, 12)
    const bin = join(CONFIG_DIR, `ax-helper-${hash}`)
    if (!existsSync(bin)) {
      if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
      const src = join(CONFIG_DIR, `ax-helper-${hash}.swift`)
      writeFileSync(src, SWIFT_HELPER)
      await new Promise((resolve, reject) => {
        execFile('swiftc', ['-O', '-o', `${bin}.tmp`, src], { timeout: 120_000 }, (error, _stdout, stderr) => {
          if (error) reject(new Error(`swiftc failed: ${String(stderr).slice(0, 400)}`))
          else resolve()
        })
      })
      renameSync(`${bin}.tmp`, bin) // atomic: never leave a half-written binary
    }
    compiledHelperPath = bin
    return bin
  })()
  compileInFlight.catch(() => {
    compileInFlight = null // a failed compile must not poison every later call
  })
  return compileInFlight
}

/**
 * Run one helper verb; the helper always answers with one JSON line.
 *
 * `abortCheck` (optional, async → truthy = abort) is polled every 2s while
 * the child runs. STOP must mean *stopped now*: flipping state while a helper
 * keeps typing to completion breaks the one promise §0 makes about the red
 * button (Codex round 4). Kill shape borrowed from sessions.mjs — SIGTERM,
 * then SIGKILL on a short timer for a child mid-syscall.
 */
async function helper(args, { timeoutMs = 30_000, abortCheck = null } = {}) {
  const bin = await helperBinary()
  if (abortCheck && (await Promise.resolve(abortCheck()).catch(() => false))) {
    return { ok: false, code: 'stopped_by_owner', detail: 'aborted before start' }
  }
  return new Promise((resolve) => {
    let aborted = false
    let watcher = null
    const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (watcher) clearInterval(watcher)
      if (aborted) return resolve({ ok: false, code: 'stopped_by_owner', detail: 'killed mid-action' })
      const line = String(stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? ''
      let json = null
      try {
        json = JSON.parse(line)
      } catch {
        /* fell over before emitting */
      }
      if (json) return resolve(json)
      resolve({
        ok: false,
        code: error ? 'helper_failed' : 'no_output',
        detail: String(stderr ?? '').slice(0, 300) || String(error?.message ?? ''),
      })
    })
    if (abortCheck) {
      watcher = setInterval(async () => {
        if (aborted) return
        let stop = false
        try {
          stop = Boolean(await abortCheck())
        } catch {
          stop = false // a failed check is not evidence of a STOP
        }
        if (!stop) return
        aborted = true
        clearInterval(watcher)
        watcher = null
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }, 3_000)
      }, 2_000)
    }
  })
}

const HELPER_FAIL_BN = {
  not_ax_trusted:
    'Accessibility অনুমতি নেই — System Settings → Privacy & Security → Accessibility-তে daemon-এর node-কে অনুমতি দিন।',
  app_not_running: 'অ্যাপটা চালু নেই।',
  window_not_found: 'অ্যাপের সেই উইন্ডোটা পাওয়া যায়নি।',
  element_not_found: 'ওই নামের বোতাম/এলিমেন্ট পাওয়া যায়নি।',
  field_not_found: 'ওই নামের লেখার ঘর পাওয়া যায়নি।',
  field_not_empty: 'ঘরটায় আগে থেকেই লেখা আছে (আপনার draft?) — মুছে না দিয়ে টাইপ করা হবে না।',
  typed_not_landed: 'টাইপ করা লেখা ঘরে পৌঁছায়নি — পাঠানো হয়নি।',
  press_failed: 'ক্লিকটা কাজ করেনি।',
  no_focus: 'কোনো এলিমেন্ট ফোকাসে নেই।',
  unknown_key: 'এই কী-টা চেনা নেই।',
  label_mismatch: 'এলিমেন্টের আসল নাম যাচাই-করা নামের সাথে মেলে না — কিছু করা হয়নি।',
  focus_changed: 'ফোকাস অন্য জায়গায় সরে গেছে — কী চাপা হয়নি, আবার চেষ্টা করুন।',
  owner_interrupted:
    'আপনি কীবোর্ড/মাউসে হাত দিয়েছেন — টাইপ মাঝপথে থামিয়ে দেওয়া হয়েছে, ঘরে আংশিক লেখা থাকতে পারে।',
}

function helperError(res, fallback = 'ui_helper_failed') {
  const code = res?.code ?? fallback
  const bn = HELPER_FAIL_BN[code] ?? ''
  const detail = res?.detail ? ` (${String(res.detail).slice(0, 160)})` : ''
  return { ok: false, exitCode: null, error: `${code}${bn ? ` — ${bn}` : ''}${detail}` }
}

// ---------------------------------------------------------------------------
// Owner-at-the-keyboard gate — W1 lesson #4, enforced by W2's classifier.
// The daemon MEASURES idle time (CGEventSource, via the helper) and passes it
// in; `owner_active` from the classifier means wait and retry, not fail.
// ---------------------------------------------------------------------------

const OWNER_DEFER_MAX_MS = Number(process.env.ALMA_UI_DEFER_MAX_MS) || 180_000
const OWNER_DEFER_POLL_MS = 5_000

async function ownerIdleSeconds() {
  const res = await helper(['idle'], { timeoutMs: 10_000 })
  return res.ok ? Number(res.idleSeconds) : NaN // NaN classifies as owner_active — fail closed
}

let captureScreenFn = null
let isPausedFn = () => false
/** Injected by agent.mjs: asks the server whether this command was STOPped or
 *  the kill-switch went off. Best-effort — a network blip must not fail the
 *  wait, the deadline still bounds it. */
let checkCancelledFn = async () => null

const STOPPED_VERDICT = {
  level: 'red',
  code: 'stopped_by_owner',
  reasonBn: 'আপনি STOP চেপেছেন — কাজটা বাতিল হলো, কিছু করা হয়নি।',
}
const KILL_SWITCH_VERDICT = {
  level: 'red',
  code: 'kill_switch',
  reasonBn: 'Mac control বন্ধ — কিছু করা হয়নি।',
}

/** One server round-trip: is this command still wanted? */
async function abortState(cmd) {
  try {
    return await checkCancelledFn(cmd?.id)
  } catch {
    return null
  }
}

/**
 * Classify with a live idle measurement, deferring while the owner is at the
 * keyboard. `resolveExtra` (optional) re-resolves volatile inputs — the
 * focused element's label — on EVERY attempt, because the wait can run for
 * minutes and focus moves (Codex P1: classifying a stale focus is judging an
 * element we will not press). Each defer tick also asks the server whether
 * the owner pressed STOP — a red STOP must abort a waiting action, not let
 * it fire minutes later (Codex P1).
 */
async function classifyDeferring(reqBase, cmd, resolveExtra) {
  const deadline = Date.now() + OWNER_DEFER_MAX_MS
  for (;;) {
    const idle = await ownerIdleSeconds()
    let extraFields = {}
    if (resolveExtra && Number.isFinite(idle) && idle >= OWNER_ACTIVE_WINDOW_SECONDS) {
      const extra = await resolveExtra()
      if (extra.error) return { error: extra.error }
      extraFields = extra.fields ?? {}
    }
    const verdict = classifyUiAction({ ...reqBase, ...extraFields, ownerIdleSeconds: idle })
    if (verdict.code !== 'owner_active') return { verdict, fields: extraFields }
    if (isPausedFn()) return { verdict: KILL_SWITCH_VERDICT, fields: {} }
    if (Date.now() > deadline) return { verdict, fields: {} }
    const abort = await abortState(cmd)
    if (abort?.cancelled) return { verdict: STOPPED_VERDICT, fields: {} }
    if (abort?.disabled) return { verdict: KILL_SWITCH_VERDICT, fields: {} }
    await new Promise((r) => setTimeout(r, OWNER_DEFER_POLL_MS))
  }
}

/**
 * Last gate before synthesising anything: even an action that never had to
 * defer must not fire after the owner's STOP landed while it sat in the
 * queue. One cheap read; fail open on network error (the daemon-side policy
 * verdict and kill-switch checks still stand).
 */
async function stoppedBeforeActing(cmd) {
  if (isPausedFn()) return KILL_SWITCH_VERDICT
  const abort = await abortState(cmd)
  if (abort?.cancelled) return STOPPED_VERDICT
  if (abort?.disabled) return KILL_SWITCH_VERDICT
  return null
}

/** The live abort line for a RUNNING helper: kill it the moment STOP lands. */
function actAbortCheck(cmd) {
  return async () => {
    if (isPausedFn()) return true
    const abort = await abortState(cmd)
    return Boolean(abort?.cancelled || abort?.disabled)
  }
}

// ---------------------------------------------------------------------------
// The ui_* verbs
// ---------------------------------------------------------------------------

function refusal(verdict) {
  return {
    ok: false,
    exitCode: null,
    error: `refused_by_daemon:${verdict.code} — ${verdict.reasonBn}`,
  }
}

function ok(payload) {
  return { ok: true, exitCode: 0, stdout: JSON.stringify(payload) }
}

async function uiTree(params) {
  const bundleId = resolveBundleId(params.bundleId ?? params.app)
  const verdict = classifyUiAction({ action: 'ui_tree', bundleId })
  if (verdict.level === 'red') return refusal(verdict)
  const h = hintsFor(bundleId)
  const args = ['tree', bundleId]
  if (h.manual) args.push('--manual')
  args.push('--window', String(params.window ?? h.windowTitle ?? '-'))
  // Default deep: at depth 25 the Electron webarea's composer and chat are
  // still out of reach (measured: 295 elements vs the real 669 at 40).
  args.push('--depth', String(Math.min(Number(params.depth) || 40, 45)))
  const res = await helper(args, { timeoutMs: 45_000 })
  if (!res.ok) return helperError(res)
  return ok({ elements: res.elements, tree: capTree(String(res.tree ?? '')) })
}

async function uiScroll(params, cmd) {
  const bundleId = resolveBundleId(params.bundleId ?? params.app)
  // Through the defer loop although scroll is green today: it synthesises
  // real input, and W2 is extending the owner-idle gate to it — when that
  // lands, a scroll while the owner types must WAIT like every other
  // synthesis, not refuse. (For a plain green verdict the loop returns on
  // its first pass.)
  const { verdict } = await classifyDeferring({ action: 'ui_scroll', bundleId }, cmd)
  if (verdict.level === 'red') return refusal(verdict)
  const h = hintsFor(bundleId)
  // Contract: the server tool sends ONE signed `scrollAmount` (negative = up);
  // direction/amount stay for hand-run probes. Without this translation every
  // server scroll fell back to "down by 5" (Codex P2 on the W4 PR).
  const signed = Number(params.scrollAmount)
  const direction = params.direction === 'up' || params.direction === 'down'
    ? params.direction
    : Number.isFinite(signed) && signed < 0 ? 'up' : 'down'
  // Default of 5 applies only when NO amount was given at all — an explicit 0
  // (a computed boundary) means "don't move", not "scroll down 5" (Codex P2).
  const hasExplicit = Number.isFinite(Number(params.amount)) || Number.isFinite(signed)
  const magnitude = Number(params.amount) || (Number.isFinite(signed) ? Math.abs(signed) : 0)
  const amount = hasExplicit ? Math.min(magnitude, 40) : 5
  if (amount === 0) return ok({ scrolled: 0, policy: verdict.level })
  const args = ['scroll', bundleId, '--dir', direction,
    '--amount', String(amount),
    '--window', String(params.window ?? h.windowTitle ?? '-'),
    '--idle-window', String(OWNER_ACTIVE_WINDOW_SECONDS)]
  if (h.manual) args.push('--manual')
  const res = await helper(args, { abortCheck: actAbortCheck(cmd) })
  if (res.code === 'stopped_by_owner') return refusal(STOPPED_VERDICT)
  if (!res.ok) return helperError(res)
  return ok(res)
}

/**
 * The base keys and modifiers the Swift helper can actually synthesise. MUST
 * mirror the helper's BASE_KEYS/MODIFIER_FLAGS tables: a combo the policy
 * would card as AMBER but the helper cannot press has to be refused BEFORE
 * classification, or the owner approves a no-op (Codex P2).
 */
const SYNTH_MODIFIERS = new Set(['cmd', 'ctrl', 'opt', 'shift'])
const SYNTH_BASE_KEYS = new Set([
  'return', 'enter', 'tab', 'space', 'escape', 'delete', 'forwarddelete',
  'up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  ...'abcdefghijklmnopqrstuvwxyz', ...'0123456789',
  '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`',
])

export function canSynthesizeKey(normalizedCombo) {
  const parts = String(normalizedCombo ?? '').split('+')
  if (parts.length === 0 || parts.some((p) => !p)) return false
  if (!SYNTH_BASE_KEYS.has(parts[parts.length - 1])) return false
  return parts.slice(0, -1).every((m) => SYNTH_MODIFIERS.has(m))
}

function needsApproval(verdict, params, cmd) {
  return verdict.level === 'amber' && !params.approved && !cmd?.approved
}

async function uiClick(params, cmd) {
  const bundleId = resolveBundleId(params.bundleId ?? params.app)
  const label = String(params.elementLabel ?? '').trim()
  const { verdict } = await classifyDeferring({ action: 'ui_click', bundleId, elementLabel: label }, cmd)
  if (verdict.level === 'red') return refusal(verdict)
  if (needsApproval(verdict, params, cmd)) {
    return { ok: false, exitCode: null, error: 'refused_by_daemon:missing_approval' }
  }
  const stopped = await stoppedBeforeActing(cmd)
  if (stopped) return refusal(stopped)
  const h = hintsFor(bundleId)
  const args = ['click', bundleId, '--label', label, '--window', String(params.window ?? h.windowTitle ?? '-'),
    '--idle-window', String(OWNER_ACTIVE_WINDOW_SECONDS)]
  if (h.manual) args.push('--manual')
  const res = await helper(args, { timeoutMs: 45_000, abortCheck: actAbortCheck(cmd) })
  if (res.code === 'stopped_by_owner') return refusal(STOPPED_VERDICT)
  if (!res.ok) return helperError(res)
  // The helper resolves by exact equality, so the pressed element's own label
  // IS the judged one; this assertion is the belt to that suspender.
  if (res.resolvedLabel !== label) {
    return refusal({ code: 'label_mismatch', reasonBn: `বোতামের আসল নাম "${res.resolvedLabel}" — যেটা যাচাই হয়েছিল তার সাথে মেলে না, তাই কিছু করা হয়নি।` })
  }
  return ok({ clicked: res.clicked, diff: res.diff, policy: verdict.level })
}

async function uiType(params, cmd) {
  const bundleId = resolveBundleId(params.bundleId ?? params.app)
  const h = hintsFor(bundleId)
  const field = String(params.elementLabel ?? h.composerDesc ?? '').trim()
  const text = String(params.text ?? '')
  const { verdict } = await classifyDeferring({ action: 'ui_type', bundleId, elementLabel: field, text }, cmd)
  if (verdict.level === 'red') return refusal(verdict)
  if (needsApproval(verdict, params, cmd)) {
    return { ok: false, exitCode: null, error: 'refused_by_daemon:missing_approval' }
  }
  const stopped = await stoppedBeforeActing(cmd)
  if (stopped) return refusal(stopped)
  const args = ['type', bundleId, '--field', field, '--text', text,
    '--window', String(params.window ?? h.windowTitle ?? '-'),
    '--idle-window', String(OWNER_ACTIVE_WINDOW_SECONDS)]
  if (h.manual) args.push('--manual')
  // The empty-field guard is ON unless the caller explicitly says it expects
  // existing content (e.g. appending to its own earlier draft).
  if (!params.allowNonEmpty && h.placeholders?.length) {
    args.push('--require-empty', h.placeholders.join('|'))
  }
  const res = await helper(args, { timeoutMs: 90_000, abortCheck: actAbortCheck(cmd) })
  if (res.code === 'stopped_by_owner') return refusal(STOPPED_VERDICT)
  if (!res.ok) return helperError(res)
  if (res.resolvedLabel !== field) {
    return refusal({ code: 'label_mismatch', reasonBn: `ঘরের আসল নাম "${res.resolvedLabel}" — যেটা যাচাই হয়েছিল তার সাথে মেলে না, তাই লেখা হয়নি।` })
  }
  return ok({ typed: res.typed, fieldValue: res.fieldValue, diff: res.diff, policy: verdict.level })
}

async function uiKey(params, cmd) {
  const bundleId = resolveBundleId(params.bundleId ?? params.app)
  const key = normalizeKey(params.key)
  const h = hintsFor(bundleId)

  // Refuse un-synthesisable combos BEFORE the policy ever cards them.
  if (key && !canSynthesizeKey(key)) {
    return {
      ok: false,
      exitCode: null,
      error: `unknown_key — "${key}" চাপা সম্ভব নয় (সমর্থিত নয়)।`,
    }
  }

  // An activation key presses whatever has focus. The focused label is
  // resolved INSIDE the defer loop — freshly on every attempt, once the
  // owner-idle gate passes — because focus moves during a minutes-long wait
  // and the classified label must be the one that is focused NOW (Codex P1).
  const isActivation = ACTIVATION_KEYS.test(key)
  const resolveFocused = async () => {
    const fArgs = ['focused', bundleId]
    if (h.manual) fArgs.push('--manual')
    const f = await helper(fArgs)
    if (!f.ok) return { error: helperError(f) }
    return { fields: { focusedLabel: String(f.label ?? '') } }
  }
  const out = await classifyDeferring(
    { action: 'ui_key', bundleId, key },
    cmd,
    isActivation ? resolveFocused : null,
  )
  if (out.error) return out.error
  const { verdict, fields } = out
  if (verdict.level === 'red') return refusal(verdict)
  // An approval names an element. The card the owner read said "Enter on
  // <focusedLabel>", so the press is bound to THAT label: if focus moved to a
  // different (even AMBER) control between approval and execution, the
  // approval does not transfer — refuse and make the server card it again
  // (Codex P1 on the W4 PR). Without this, `approved: true` rode along to
  // whatever grabbed focus during the owner-idle wait.
  const approvedFocused = typeof params.focusedLabel === 'string' && params.focusedLabel.trim()
    ? params.focusedLabel.trim()
    : null
  if (isActivation && approvedFocused && fields.focusedLabel !== approvedFocused) {
    return {
      ok: false,
      exitCode: null,
      error: `refused_by_daemon:focus_changed — অনুমতি ছিল "${approvedFocused}"-এ, এখন ফোকাসে "${fields.focusedLabel || '(কিছু না)'}" — নতুন অনুমতি লাগবে।`,
    }
  }
  if (needsApproval(verdict, params, cmd)) {
    return { ok: false, exitCode: null, error: 'refused_by_daemon:missing_approval' }
  }
  const stopped = await stoppedBeforeActing(cmd)
  if (stopped) return refusal(stopped)
  const args = ['key', bundleId, '--key', key, '--window', String(params.window ?? h.windowTitle ?? '-'),
    '--idle-window', String(OWNER_ACTIVE_WINDOW_SECONDS)]
  // The helper re-verifies the focused element at the last instant, atomically
  // with the press — a changed focus is a refusal, not a guess. When the press
  // was card-approved the expectation is the APPROVED label, not whatever is
  // focused now, so the helper enforces the same binding at press time.
  const expectFocused = approvedFocused ?? fields.focusedLabel
  if (isActivation && expectFocused) args.push('--expect-focused', expectFocused)
  if (h.manual) args.push('--manual')
  const res = await helper(args, { timeoutMs: 45_000, abortCheck: actAbortCheck(cmd) })
  if (res.code === 'stopped_by_owner') return refusal(STOPPED_VERDICT)
  if (!res.ok) return helperError(res)
  return ok({ key: res.key, focused: fields.focusedLabel || null, diff: res.diff, policy: verdict.level })
}

// ---------------------------------------------------------------------------
// Chat mirroring — the owner's "watch the CHAT as live text" ask (roadmap
// §"What watching must feel like"). A read-only watcher re-reads the driven
// app's conversation and emits each NEW message as a session event on the
// same pipe the CLI transcripts ride; both docks render it with zero changes.
// ---------------------------------------------------------------------------

const MIRROR_POLL_MS = Number(process.env.ALMA_MIRROR_POLL_MS) || 3_000
const MIRROR_DEFAULT_SECONDS = 600
const MIRROR_MAX_SECONDS = 3_600

/** Active mirrors, keyed by bundleId — one watcher per app. */
const mirrors = new Map()
/**
 * Stopped mirrors whose events have not all reached the server yet. A fast
 * stop→restart used to REPLACE the map entry and drop the buffered `ended`
 * with it — the dock then showed a session that never finished, i.e. it lied
 * about state (Codex round 3, head-confirmed). Entries leave this list the
 * moment their last event is acknowledged.
 */
const retiredMirrors = []
const RETIRED_MAX = 10

/**
 * Which of the freshly-read messages are NEW and SETTLED?
 *
 * Three problems hide here. (1) Dedupe: never re-emit what was already sent —
 * emission advances a count, and a shrunken read (virtualized list) must not
 * reset it. (2) A STREAMING message grows between reads; emitting it on every
 * poll would spam the feed with part-copies — so the LAST message is held
 * back until one poll sees it unchanged; anything with a message after it is
 * settled by definition. (3) The conversation can be SWITCHED under the
 * watcher (the owner, or the driver itself pressing "New") — detected by the
 * first visible message changing; everything then on screen is history, not
 * news. The one exception: a fresh EMPTY chat resets the state so its first
 * messages can flow, and a big jump straight from empty means an old
 * conversation was reopened (history again). Measured live: the count-only
 * model went permanently mute after a "New" click (baseline 3 > new chat's
 * 0/1/2 messages).
 *
 * Pure function, exported for tests.
 */
const FROM_EMPTY_HISTORY_THRESHOLD = 3

export function settleNewMessages(state, messages) {
  const out = []
  if (!Array.isArray(messages) || messages.length === 0) {
    return { emit: out, state: { emittedCount: 0, pendingLast: null, firstText: null } }
  }
  const first = messages[0]
  const last = messages[messages.length - 1]

  const switched = state.firstText != null && state.firstText !== first.text
  const emptyToHistory =
    state.firstText == null && messages.length >= FROM_EMPTY_HISTORY_THRESHOLD
  if (switched || emptyToHistory) {
    // Another conversation is on screen — baseline it silently.
    return {
      emit: out,
      state: {
        emittedCount: messages.length,
        pendingLast: { who: last.who, text: last.text },
        firstText: first.text,
      },
    }
  }
  if (messages.length < state.emittedCount) {
    // Same conversation, fewer messages visible (virtualized scroll): keep
    // the counter — silence beats duplicates.
    return { emit: out, state: { ...state, firstText: state.firstText ?? first.text } }
  }

  for (let i = state.emittedCount; i < messages.length; i += 1) {
    const isLast = i === messages.length - 1
    if (!isLast) {
      out.push(messages[i])
      continue
    }
    const settled =
      state.pendingLast != null &&
      state.pendingLast.who === last.who &&
      state.pendingLast.text === last.text
    if (settled) out.push(messages[i])
  }
  return {
    emit: out,
    state: {
      emittedCount: state.emittedCount + out.length,
      pendingLast:
        out.length > 0 && out[out.length - 1] === last ? null : { who: last.who, text: last.text },
      firstText: first.text,
    },
  }
}

function pushMirrorEvent(m, event) {
  m.seq += 1
  m.events.push({ seq: m.seq, at: new Date().toISOString(), ...event })
  if (m.events.length > 400) m.events.splice(0, m.events.length - 400)
}

function stopMirror(bundleId, reason) {
  const m = mirrors.get(bundleId)
  if (!m) return false
  clearInterval(m.timer)
  m.timer = null
  m.stopped = true
  pushMirrorEvent(m, { kind: 'ended', exitCode: 0 })
  m.stopReason = reason
  return true
}

async function mirrorTick(m) {
  if (m.busy) return
  if (isPausedFn() || Date.now() > m.deadline) {
    stopMirror(m.bundleId, isPausedFn() ? 'paused' : 'deadline')
    return
  }
  m.busy = true
  try {
    const h = hintsFor(m.bundleId)
    const args = ['convo', m.bundleId, '--window', h.windowTitle ?? '-']
    if (h.manual) args.push('--manual')
    // The read is killable by the stop, and its RESULT is void after one: a
    // 30s tree walk that resumes after stopMirror() must not emit into a
    // session the owner already ended (Codex round 4).
    const res = await helper(args, { timeoutMs: 30_000, abortCheck: () => m.stopped || isPausedFn() })
    if (m.stopped) return
    if (!res.ok) {
      if (res.code === 'stopped_by_owner') return
      m.failures += 1
      if (m.failures >= 5) stopMirror(m.bundleId, `read_failed:${res.code}`)
      return
    }
    m.failures = 0
    const { emit, state } = settleNewMessages(
      { emittedCount: m.emittedCount, pendingLast: m.pendingLast, firstText: m.firstText },
      res.messages ?? [],
    )
    m.emittedCount = state.emittedCount
    m.pendingLast = state.pendingLast
    m.firstText = state.firstText
    for (const msg of emit) {
      // Same kinds the CLI transcript uses — 'sent' is the owner's side,
      // 'text' the assistant's — so the docks need zero render changes.
      pushMirrorEvent(m, {
        kind: msg.who === 'owner' ? 'sent' : 'text',
        text: String(msg.text).slice(0, 4_000),
      })
    }
  } finally {
    m.busy = false
  }
}

async function appMirror(params) {
  const bundleId = resolveBundleId(params.bundleId ?? params.app)
  const mode = String(params.mode ?? 'start')

  // The red STOP broadcast — no app named, everything watching stops.
  if (mode === 'stop_all') {
    return ok({ mirroring: false, stopped: stopAllMirrors('owner_stop') })
  }
  if (mode === 'stop') {
    const had = stopMirror(bundleId, 'owner')
    return ok({ mirroring: false, stopped: had })
  }

  // Mirroring is a read — judged like one. A non-allowlisted app cannot be
  // watched any more than it can be driven.
  const verdict = classifyUiAction({ action: 'ui_tree', bundleId })
  if (verdict.level === 'red') return refusal(verdict)

  const h = hintsFor(bundleId)
  if (!h.mirror) {
    return {
      ok: false,
      exitCode: null,
      error:
        'mirror_unsupported — এই অ্যাপের চ্যাট এখনো টেক্সট হিসেবে পড়া যায় না (Claude অ্যাপ দিয়ে দেখুন)।',
    }
  }

  const seconds = Math.min(Math.max(Number(params.maxSeconds) || MIRROR_DEFAULT_SECONDS, 30), MIRROR_MAX_SECONDS)
  const existing = mirrors.get(bundleId)
  if (existing && !existing.stopped) {
    existing.deadline = Date.now() + seconds * 1_000
    return ok({ mirroring: true, extended: true, seconds, sessionId: existing.sessionId })
  }
  // A stopped predecessor may still hold events the server has not
  // acknowledged (typically its `ended`) — retire it so the push loop can
  // finish delivering them instead of losing them with the map entry.
  if (existing && existing.seq > existing.pushedSeq) {
    retiredMirrors.push(existing)
    if (retiredMirrors.length > RETIRED_MAX) retiredMirrors.shift()
  }

  const m = {
    bundleId,
    sessionId: `app-${h.key}-${randomUUID().slice(0, 8)}`,
    tool: 'claude', // the feed's tool enum; the Claude APP mirrors as claude
    seq: 0,
    pushedSeq: 0,
    events: [],
    emittedCount: 0,
    pendingLast: null,
    firstText: null,
    failures: 0,
    busy: false,
    stopped: false,
    deadline: Date.now() + seconds * 1_000,
    timer: null,
  }
  // Baseline read FIRST: everything already on screen is history, not news —
  // dumping a whole old conversation into the feed would bury the live part.
  const args = ['convo', bundleId, '--window', h.windowTitle ?? '-']
  if (h.manual) args.push('--manual')
  const first = await helper(args, { timeoutMs: 45_000 })
  if (!first.ok) return helperError(first)
  m.emittedCount = (first.messages ?? []).length
  const lastMsg = (first.messages ?? [])[m.emittedCount - 1] ?? null
  m.pendingLast = lastMsg ? { who: lastMsg.who, text: lastMsg.text } : null
  m.firstText = (first.messages ?? [])[0]?.text ?? null

  pushMirrorEvent(m, { kind: 'started', model: null, cliSessionId: null })
  m.timer = setInterval(() => void mirrorTick(m), MIRROR_POLL_MS)
  mirrors.set(bundleId, m)
  return ok({ mirroring: true, seconds, sessionId: m.sessionId, alreadyOnScreen: m.emittedCount })
}

// ---------------------------------------------------------------------------
// Event collection — same contract as sessions.mjs, merged by agent.mjs into
// the one push pipe (mac_agent_session_events → both docks).
// ---------------------------------------------------------------------------

const PUSH_BATCH_MAX = 50

export function collectUnpushedUiEvents() {
  const batches = []
  for (const m of [...mirrors.values(), ...retiredMirrors]) {
    const fresh = m.events.filter((e) => e.seq > m.pushedSeq).slice(0, PUSH_BATCH_MAX)
    if (fresh.length === 0) continue
    batches.push({ sessionId: m.sessionId, tool: m.tool, events: fresh, lastSeq: fresh[fresh.length - 1].seq })
  }
  return batches
}

export function markUiEventsPushed(sessionId, lastSeq) {
  for (const m of [...mirrors.values(), ...retiredMirrors]) {
    if (m.sessionId === sessionId && Number(lastSeq) > m.pushedSeq) m.pushedSeq = Number(lastSeq)
  }
  // Fully-delivered retirees have nothing left to say — let them go.
  for (let i = retiredMirrors.length - 1; i >= 0; i -= 1) {
    if (retiredMirrors[i].pushedSeq >= retiredMirrors[i].seq) retiredMirrors.splice(i, 1)
  }
}

/** Is this sessionId one of ours? (for the dock-reply wrap below) */
export function isMirrorSession(sessionId) {
  for (const m of [...mirrors.values(), ...retiredMirrors]) if (m.sessionId === sessionId) return true
  return false
}

/** The owner's STOP — kill every watcher immediately, mid-sequence. */
export function stopAllMirrors(reason = 'stop') {
  let n = 0
  for (const bundleId of [...mirrors.keys()]) {
    if (stopMirror(bundleId, reason)) n += 1
  }
  return n
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function registerUiHandlers(extraHandlers, { isPaused, checkCancelled, captureScreen } = {}) {
  if (typeof isPaused === 'function') isPausedFn = isPaused
  if (typeof checkCancelled === 'function') checkCancelledFn = checkCancelled
  if (typeof captureScreen === 'function') captureScreenFn = captureScreen

  extraHandlers.set('ui_tree', (p) => uiTree(p))
  // `look_mac_app` advertises a screenshot action, so the verb must exist here
  // or the model's most natural "show me" request dies as unknown_action. The
  // capture itself is the daemon's existing screencapture path (injected), so
  // there is one downscale/limit story, not two — this wrapper only adds the
  // policy judgement, which for a screenshot is GREEN and needs no app.
  extraHandlers.set('ui_screenshot', async (p) => {
    const bundleId = resolveBundleId(p.bundleId ?? p.app)
    const verdict = classifyUiAction({ action: 'ui_screenshot', bundleId })
    if (verdict.level === 'red') return refusal(verdict)
    if (typeof captureScreenFn !== 'function') {
      return { ok: false, exitCode: null, error: 'screenshot_unavailable: daemon did not provide a capture path.' }
    }
    return await captureScreenFn()
  })
  extraHandlers.set('ui_scroll', (p, cmd) => uiScroll(p, cmd))
  extraHandlers.set('ui_click', (p, cmd) => uiClick(p, cmd))
  extraHandlers.set('ui_type', (p, cmd) => uiType(p, cmd))
  extraHandlers.set('ui_key', (p, cmd) => uiKey(p, cmd))
  extraHandlers.set('app_mirror', (p) => appMirror(p))

  // A mirror LOOKS like a session in the dock, so the dock may offer its reply
  // composer for it. Typing an owner reply into the app is W4/W5's approval-
  // carded flow; until then the reply must fail honestly, not as a confusing
  // session_not_found from the CLI driver.
  const cliSend = extraHandlers.get('session_send')
  if (cliSend) {
    extraHandlers.set('session_send', async (p, cmd) => {
      if (isMirrorSession(String(p.sessionId ?? ''))) {
        return {
          ok: false,
          exitCode: null,
          error:
            'app_mirror_readonly — এটা অ্যাপের লাইভ চ্যাটের আয়না, এখান থেকে উত্তর পাঠানো এখনো চালু হয়নি।',
        }
      }
      return cliSend(p, cmd)
    })
  }
}
