# L8 W1 — Electron AX spike: findings (2026-08-01)

**Question asked (roadmap §5 W1):** can we read and act on the Claude / ChatGPT
desktop UI through AXUIElement (with `AXManualAccessibility`), and if not,
which fallback works?

**Answer: YES on both apps, through the AX tree alone. No fallback needed.**
The full loop was proven live on the owner's MacBook Air with a script
([mac-agent/ax-probe.mjs](../mac-agent/ax-probe.mjs)): read both apps' trees →
open a NEW Claude chat → type a prompt via synthetic keystrokes → send →
read Claude's reply back out of the tree as text.

```
$ node mac-agent/ax-probe.mjs send claude "W1 AX spike test - reply with exactly: PONG"
pressed new-chat: New
composer value before: "Describe a task or ask a question\n"   ← empty draft, safe to type
composer value after typing: "W1 AX spike test - reply with exactly: PONG"
no 'Send message' button — pressing Return
SENT

# ~20s later, straight out of the AX tree:
AXGroup/AXApplicationGroup D="Chat messages"
  AXGroup/AXDocumentArticle
    AXHeading T="You said: W1 AX spike test - reply with exactly: PONG"
  AXGroup/AXDocumentArticle
    AXHeading T="Claude responded: PONG"
      AXStaticText V="PONG"
```

---

## 1. Per-app verdict

### Claude desktop (Electron 42, app v1.24012.9) — the mitigation ladder stops at rung 1

- **Without the flag:** the window is nothing but empty nested `AXGroup`s — the
  classic hidden Electron renderer tree. Unusable.
- **With `AXUIElementSetAttributeValue(app, "AXManualAccessibility", true)`:**
  returns `.success` (0) and the FULL web tree appears. It builds
  asynchronously — **sleep ~1-2 s after setting the flag** before walking, or
  the `AXWebArea` is still shallow. Set it on every attach (cheap, idempotent);
  it does not survive app restarts.
- What the tree gives us, all labeled: the sidebar (every session with its
  Running/Idle/Merged state as `AXApplicationStatus`/`AXImage` + title), mode
  buttons (Home/Code), `AXButton T="New"`, the composer
  (`AXTextArea D="Prompt"`), model/effort/usage popups, and the whole
  conversation (structure in §2).

### ChatGPT desktop — full tree BY DEFAULT, the "Electron limited tree" risk did not materialize

- `AXManualAccessibility` returns **-25205 (attributeUnsupported)** — and it
  does not matter: the tree is already complete without it (1381 elements
  across 9 windows on a live app). Treat -25205 as ignorable, not as failure.
- The UI is still web-rendered (`AXWebArea T="Codex"` etc.), but exposed fully.
- 9 windows on a working day: main `ChatGPT` window, `Codex` session windows,
  `Computer Use`, and several tiny "Codex Pet" overlay surfaces. **A driver
  must pick its window by title, never "the first webarea".**
- Composer found: `AXTextArea D="Do anything"` (Codex window), with
  `AXPopUpButton T="5.6 Sol High"` (model), Dictate/Stop buttons, sidebar
  projects + scheduled tasks all readable. Bangla text comes out intact.

## 2. Conversation text = the chat-mirroring read (roadmap §"what watching must feel like")

**Claude — structured, better than hoped.** Messages live under
`AXGroup/AXApplicationGroup D="Chat messages"`, one
`AXGroup/AXDocumentArticle` per message, and BOTH sides are self-labeling:

- user turn → `AXHeading T="You said: <text>"`
- assistant turn → `AXHeading T="Claude responded: <text>"`
- full body text as `AXStaticText` children; UI chrome is skippable by
  description (`Message actions` toolbar, `AXTimeGroup` timestamps).

`ax-probe.mjs convo claude` emits exactly the `OWNER:` / `ASSISTANT:` lines the
dock pipe wants. Live output from this session's own window:

```
OWNER: docs/MAC_CONTROL_LIVE_ROADMAP.md pore W1 (Electron AX spike) koro
ASSISTANT: I need to look up the roadmap document and locate the W1 … (full text)
```

**ChatGPT — readable but unstructured.** No `AXDocumentArticle`; the generic
text dump returns the conversation (Bangla included, e.g. a scheduled task's
"Build unusually slow হলেও process healthy…") but W3 needs a ChatGPT-specific
extractor to split who-said-what. Claude is the primary mirroring target; that
is fine — Claude is also the primary driving target.

## 3. Acting on the tree — what was proven, mechanism by mechanism

| Mechanism | Result |
|---|---|
| `AXUIElementPerformAction(btn, kAXPress)` | ✅ pressed sidebar `New` — a fresh chat opened |
| Focus: `AXUIElementSetAttributeValue(composer, kAXFocused, true)` | ✅ composer took focus |
| Typing: `CGEvent` + `keyboardSetUnicodeString` + **`postToPid`** (after `NSRunningApplication.activate`) | ✅ text landed verbatim; verified by reading `AXValue` back BEFORE sending |
| Submit: Return keycode 36 to pid | ✅ message sent (no `Send message` button existed while streaming UI shows Stop; Return is the reliable path) |
| Read-back | ✅ `PONG` reply extracted from the tree, no screenshot involved |

Not tested (left for W3): `AXValue` **set** on the composer (typing worked
first try; ProseMirror/React composers often ignore AX value-sets, so
keystrokes are the safe default), scrolling, and the AX **diff** after each
action (W3 requirement — the before/after composer read above is the seed of
exactly that).

## 4. Traps paid for (do not rediscover)

1. **`pgrep -x Claude` finds nothing** — only helpers match by name/path.
   Resolve the main pid via System Events:
   `osascript -e 'tell application "System Events" to unix id of process "Claude"'`.
2. **Sleep after setting `AXManualAccessibility`** — the flag returns success
   immediately but the renderer publishes the tree ~1-2 s later.
3. **Multiple webareas/windows** — Claude has a notification-overlay webarea;
   ChatGPT has 9 windows including pet overlays. Select by window/webarea
   title.
4. **The menu bar is huge noise** — `AXMenuBar` includes Apple menu +
   Recent Items (leaks filenames). Walk windows, not the app root, for UI
   work; and NEVER ship menu contents into logs/events.
5. **`swift` interpreter startup is 8-15 s per call** — fine for a spike,
   wrong for W3. Compile the helper once with `swiftc -O` at daemon start and
   cache the binary.
6. **Accessibility permission is per invoking binary** — this spike ran
   AX-trusted from the session's shell. The DAEMON's `node` needs its own
   one-time grant in System Settings → Privacy & Security → **Accessibility**
   (separate from the Screen Recording grant it already has), or every call
   dies at `AXIsProcessTrusted() == false`. Same "add the node binary
   manually" dance as Screen Recording.
7. **Never type into whatever chat is open.** The owner had a live session in
   the visible window. The probe presses `New` first and refuses to type
   unless the composer holds only placeholder text — W3 must keep both
   guards.

## 5. What this decides for W3/W4 (the shape the roadmap asked for)

- **AX tree is the control surface for BOTH apps; screenshots (L7) stay
  verification-only.** No remote-debugging-port fallback, no
  screenshot+coordinates fallback.
- W3's `ui_*` verbs are all directly implementable with what was proven:
  `ui_tree` (walk), `ui_click` (AXPress), `ui_type` (focus + CGEvent to pid),
  `ui_key` (keycode to pid), and the chat-mirroring watcher reads the
  `Chat messages` articles and dedupes on heading text.
- Claude attach sequence: pid via System Events → set `AXManualAccessibility`
  → sleep 2 s → walk. ChatGPT attach: pid → walk (ignore -25205).
- Composer registry so far: Claude `AXTextArea D="Prompt"` · ChatGPT Codex
  `AXTextArea D="Do anything"` (plain-chat composer desc still unverified —
  ChatGPT send was out of W1 scope).

## 6. Evidence inventory

- `mac-agent/ax-probe.mjs` — the throwaway probe (verbs: `pids` / `tree` /
  `convo` / `send`); embedded Swift helper, zero npm deps, same style as
  `agent.mjs`.
- Live artifacts quoted above: both apps' full trees, the OWNER/ASSISTANT
  convo dump, and the typed-sent-replied PONG round trip (the leftover
  "W1 AX spike test" chat in the owner's sidebar IS the artifact — one
  message, sent by the script, answered `PONG`).
