#!/usr/bin/env node
/**
 * W1 SPIKE — Electron AX probe (THROWAWAY — evidence gatherer for docs/L8_AX_SPIKE.md).
 *
 * Answers one question: can we read and drive the Claude / ChatGPT desktop apps
 * through the macOS Accessibility tree (AXUIElement)? Findings live in
 * docs/L8_AX_SPIKE.md; the real driver ships in W3 as mac-agent/ui-driver.mjs.
 *
 * Zero dependencies, same as agent.mjs. All AX work happens in an embedded Swift
 * helper (the AX C API is not reachable from Node); this file only orchestrates.
 * The helper runs through the `swift` interpreter (~8-15s startup — fine for a
 * spike; W3 must compile once with `swiftc -O` and cache the binary).
 *
 * Usage:
 *   node mac-agent/ax-probe.mjs pids                      # find the app pids
 *   node mac-agent/ax-probe.mjs tree  claude|chatgpt [depth]   # dump the AX tree
 *   node mac-agent/ax-probe.mjs convo claude|chatgpt           # conversation as "who: text"
 *   node mac-agent/ax-probe.mjs send  claude "<text>"          # NEW chat, type, send, read reply
 *
 * Needs: Accessibility permission for the invoking process (System Settings →
 * Privacy & Security → Accessibility). Screen may stay locked for reads; sending
 * activates the app, so the machine must be unlocked for `send`.
 */
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// The Swift helper. One file, subcommand per verb. Kept inline so the probe is
// a single artifact you can scp to the Mac and run.
// ---------------------------------------------------------------------------
const SWIFT_HELPER = String.raw`
import ApplicationServices
import AppKit

// ---- tiny AX conveniences --------------------------------------------------
func attr(_ el: AXUIElement, _ n: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, n as CFString, &v) == .success ? v : nil
}
func str(_ el: AXUIElement, _ n: String) -> String? { attr(el, n) as? String }
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func role(_ el: AXUIElement) -> String { str(el, kAXRoleAttribute) ?? "?" }

func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

/// Electron hides the renderer's AX tree until VoiceOver asks for it. Setting
/// AXManualAccessibility=true on the app element forces it open (Claude needs
/// this; ChatGPT returns .attributeUnsupported (-25205) and is full anyway).
func forceManualAX(_ app: AXUIElement) {
    let r = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    err("AXManualAccessibility set: \(r.rawValue)")
    if r == .success { sleep(2) } // the tree builds asynchronously after the flag flips
}

// ---- generic walkers ---------------------------------------------------------
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

func collectText(_ el: AXUIElement, into out: inout [String], skipDescs: Set<String>) {
    if let d = str(el, kAXDescriptionAttribute), skipDescs.contains(d) { return }
    if role(el) == "AXStaticText", let v = attr(el, kAXValueAttribute) as? String, !v.isEmpty {
        out.append(v)
    }
    for c in children(el) { collectText(c, into: &out, skipDescs: skipDescs) }
}

// ---- verbs -------------------------------------------------------------------
func cmdTree(_ app: AXUIElement, maxDepth: Int) {
    var count = 0
    walk(app, 0, maxDepth) { el, depth in
        count += 1
        if count > 20000 { return false }
        var line = String(repeating: " ", count: depth) + role(el)
        if let s = str(el, kAXSubroleAttribute) { line += "/\(s)" }
        if let t = str(el, kAXTitleAttribute), !t.isEmpty { line += " T=\"\(t.prefix(100))\"" }
        if let d = str(el, kAXDescriptionAttribute), !d.isEmpty { line += " D=\"\(d.prefix(100))\"" }
        if let v = attr(el, kAXValueAttribute) as? String, !v.isEmpty { line += " V=\"\(v.prefix(160))\"" }
        print(line)
        return true
    }
    err("elements: \(count)")
}

/// Claude desktop: each message is an AXGroup/AXDocumentArticle inside the main
/// AXWebArea. User turns carry an AXHeading "You said: …"; everything else in an
/// article is the assistant. Toolbars/timestamps are skipped by description.
func cmdConvo(_ app: AXUIElement) {
    let skip: Set<String> = ["Message actions", "Notifications (F8)"]
    var articles: [AXUIElement] = []
    walk(app, 0, 40) { el, _ in
        if role(el) == "AXGroup", str(el, kAXSubroleAttribute) == "AXDocumentArticle" {
            articles.append(el)
            return false
        }
        return true
    }
    if articles.isEmpty {
        // Fallback (ChatGPT / unknown layout): dump every visible static text.
        err("no AXDocumentArticle found — generic text dump")
        var texts: [String] = []
        collectText(app, into: &texts, skipDescs: skip)
        for t in texts { print(t) }
        return
    }
    for a in articles {
        let isUser = findFirst(a, 10) { el in
            role(el) == "AXHeading" && (str(el, kAXTitleAttribute) ?? "").hasPrefix("You said")
        } != nil
        var texts: [String] = []
        collectText(a, into: &texts, skipDescs: skip)
        // Drop the duplicated heading copy ("You said: …" appears as text too).
        let body = texts.filter { !$0.hasPrefix("You said:") }.joined(separator: " ")
        print("\(isUser ? "OWNER" : "ASSISTANT"): \(body)")
    }
    err("articles: \(articles.count)")
}

func pressButton(_ scope: AXUIElement, titleOrDesc: String) -> Bool {
    let b = findFirst(scope, 40) { el in
        role(el) == "AXButton" &&
            (str(el, kAXTitleAttribute) == titleOrDesc || str(el, kAXDescriptionAttribute) == titleOrDesc)
    }
    guard let btn = b else { return false }
    return AXUIElementPerformAction(btn, kAXPressAction as CFString) == .success
}

func typeUnicode(_ text: String, pid: pid_t) {
    let src = CGEventSource(stateID: .combinedSessionState)
    for scalar in text {
        var units = Array(String(scalar).utf16)
        for down in [true, false] {
            let ev = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)!
            ev.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
            ev.postToPid(pid)
        }
        usleep(12_000)
    }
}

func keyPress(_ vk: CGKeyCode, pid: pid_t) {
    let src = CGEventSource(stateID: .combinedSessionState)
    CGEvent(keyboardEventSource: src, virtualKey: vk, keyDown: true)!.postToPid(pid)
    CGEvent(keyboardEventSource: src, virtualKey: vk, keyDown: false)!.postToPid(pid)
}

/// send: open a NEW chat first (never type into whatever conversation the owner
/// has open), focus the composer, keystroke the text in, then press the send
/// button (Return as fallback).
func cmdSend(_ app: AXUIElement, pid: pid_t, text: String, composerDesc: String, newChatButton: String?) {
    NSRunningApplication(processIdentifier: pid)?.activate(options: [])
    usleep(600_000)
    if let newBtn = newChatButton {
        guard pressButton(app, titleOrDesc: newBtn) else { err("FAIL: new-chat button '\(newBtn)' not found/pressable"); exit(2) }
        err("pressed new-chat: \(newBtn)")
        sleep(2)
    }
    guard let composer = findFirst(app, 40, { el in
        role(el) == "AXTextArea" && (str(el, kAXDescriptionAttribute) ?? "").contains(composerDesc)
    }) else { err("FAIL: composer AXTextArea desc~'\(composerDesc)' not found"); exit(2) }

    // Belt and braces: verify the composer is empty (placeholder only) so we can
    // never append to a draft the owner left behind.
    let before = (attr(composer, kAXValueAttribute) as? String) ?? ""
    err("composer value before: \(before.debugDescription)")

    AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(300_000)
    typeUnicode(text, pid: pid)
    usleep(500_000)
    let after = (attr(composer, kAXValueAttribute) as? String) ?? ""
    err("composer value after typing: \(after.debugDescription)")
    if !after.contains(text) { err("FAIL: typed text did not land in composer"); exit(3) }

    if pressButton(app, titleOrDesc: "Send message") {
        err("sent via AXPress on 'Send message'")
    } else {
        err("no 'Send message' button — pressing Return")
        keyPress(36, pid: pid) // kVK_Return
    }
    print("SENT")
}

// ---- main --------------------------------------------------------------------
let a = CommandLine.arguments
// helper <verb> <pid> [--manual] [args…]
guard a.count >= 3, let pid = Int32(a[2]) else { err("usage: helper <tree|convo|send> <pid> [--manual] …"); exit(1) }
guard AXIsProcessTrusted() else { err("FAIL: process not AX-trusted"); exit(4) }
let app = AXUIElementCreateApplication(pid)
if a.contains("--manual") { forceManualAX(app) }
let rest = a.dropFirst(3).filter { $0 != "--manual" }

switch a[1] {
case "tree":  cmdTree(app, maxDepth: rest.first.flatMap { Int($0) } ?? 25)
case "convo": cmdConvo(app)
case "send":
    // send <pid> [--manual] <composerDesc> <newChatButton|-> <text…>
    guard rest.count >= 3 else { err("send needs composerDesc newChatBtn text"); exit(1) }
    let newBtn = rest[rest.startIndex + 1] == "-" ? nil : rest[rest.startIndex + 1]
    cmdSend(app, pid: pid, text: rest.dropFirst(2).joined(separator: " "),
            composerDesc: rest[rest.startIndex], newChatButton: newBtn)
default: err("unknown verb \(a[1])"); exit(1)
}
`

// ---------------------------------------------------------------------------
// App registry — what W1 learned about each target.
// ---------------------------------------------------------------------------
const APPS = {
  claude: {
    match: 'Claude.app/Contents/MacOS/Claude',
    processName: 'Claude',
    manual: true, // Electron: tree is empty AXGroups until AXManualAccessibility=true
    composerDesc: 'Prompt', // AXTextArea D="Prompt"
    newChatButton: 'New', // sidebar AXButton T="New"
  },
  chatgpt: {
    match: 'ChatGPT.app/Contents/MacOS/ChatGPT',
    processName: 'ChatGPT',
    manual: false, // full tree by default; the flag returns -25205 (unsupported)
    composerDesc: 'Do anything', // Codex window composer; plain chat differs
    newChatButton: 'New chat',
  },
}

function appPid(app) {
  // System Events resolves the real main-app pid; pgrep sees only helpers for
  // some Electron layouts.
  const out = execFileSync('osascript', ['-e', `tell application "System Events" to unix id of process "${app.processName}"`], { encoding: 'utf8' }).trim()
  const pid = Number(out)
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no pid for ${app.processName} — is the app running?`)
  return pid
}

function runHelper(args, { timeoutMs = 180_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ax-probe-'))
  const file = join(dir, 'helper.swift')
  writeFileSync(file, SWIFT_HELPER)
  return new Promise((resolve, reject) => {
    execFile('swift', [file, ...args], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      process.stderr.write(stderr)
      if (error) reject(new Error(`helper failed (${error.code ?? error.signal})`))
      else resolve(stdout)
    })
  })
}

async function main() {
  const [verb, target, ...rest] = process.argv.slice(2)
  if (verb === 'pids') {
    for (const [name, app] of Object.entries(APPS)) {
      try { console.log(`${name}: ${appPid(app)}`) } catch (e) { console.log(`${name}: NOT RUNNING (${e.message})`) }
    }
    return
  }
  const app = APPS[target]
  if (!verb || !app) {
    console.error('usage: ax-probe.mjs pids | tree <claude|chatgpt> [depth] | convo <claude|chatgpt> | send <claude|chatgpt> "<text>"')
    process.exit(1)
  }
  const pid = appPid(app)
  const manual = app.manual ? ['--manual'] : []
  if (verb === 'tree') {
    process.stdout.write(await runHelper(['tree', String(pid), ...manual, rest[0] ?? '25']))
  } else if (verb === 'convo') {
    process.stdout.write(await runHelper(['convo', String(pid), ...manual]))
  } else if (verb === 'send') {
    const text = rest.join(' ').trim()
    if (!text) throw new Error('send needs text')
    process.stdout.write(await runHelper(['send', String(pid), ...manual, app.composerDesc, app.newChatButton ?? '-', text]))
  } else {
    throw new Error(`unknown verb ${verb}`)
  }
}

main().catch((e) => { console.error(e.message); process.exit(1) })
