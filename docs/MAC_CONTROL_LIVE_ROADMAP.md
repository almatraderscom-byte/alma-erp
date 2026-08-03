# Mac Control + Live Watching — roadmap (start here)

**Date:** 2026-08-01 · **Owner:** Maruf (non-engineer; reply in Bangla, concise)
**Start a session with:** *"docs/MAC_CONTROL_LIVE_ROADMAP.md pore phase <X> shuru koro"* — one phase per session.

Owner's ask, in his words: his agent should work on his Mac while he is away — run terminal commands, open and drive Claude/Codex sessions — **and he should be able to watch it live from his iPhone, inside the chat, small like Codex/ChatGPT app, expandable like a YouTube mini-player.**

---

## 0. Non-negotiables (every phase)

1. **The classifier decides, never the model.** GREEN runs by itself · AMBER shows the exact command and waits for his tap · RED is refused and is NOT approvable. Widening the green list needs a code change, review and deploy — never an env var.
2. **The daemon re-judges everything.** It ships its own copy of the policy and a parity test fails the build if the two copies drift. A compromised server must not be able to run something dangerous on his Mac.
3. **Nothing listens on the Mac.** Outbound HTTPS only, initiated by the daemon. No inbound port, no tunnel, no SSH.
4. **A new tool must be wired in FIVE places** or it is invisible while everything looks correct:
   `registry` → `head prompt + shortlist` → `state-router pack` → **`HEAD_CORE_TOOL_NAMES` (head diet)** → **`ALWAYS_ALLOWED` (skill isolation)**.
   This cost most of a session to learn, one silent gate at a time.
5. **Browser/native proof before "done".** A screenshot of the working thing, not a green test run.
6. **Mac unlock is out of scope, permanently.** macOS gives no supported way; every workaround needs his password in plaintext. It is also unnecessary — the daemon works with the screen LOCKED. Only SLEEP kills it, which is what `keep_awake` is for.

---

## 1. Where it stands (updated 2026-08-01 END OF DAY — L3-L5 + L7-streaming merged, deployed, daemon updated, LIVE-proven)

| | State | Proof |
|---|---|---|
| **M1 Terminal** | ✅ DONE | GREEN `git status` ran by itself · AMBER `echo hello > /tmp/…` produced a card and only ran after Approve · RED `sudo rm -rf ~/Documents` refused with no card |
| **M2 Claude/Codex sessions** | ✅ DONE + LIVE | Real prod session ran `git status`, read `package.json` and `CLAUDE.md` from plain Bangla asks. CLI login survives reboots (proven — the old "not logged in" note was stale). Codex CLI installed (0.146.0) |
| **M3 Mac app** | ⚠️ BUILDS | Compiles + runs locally; NOT notarized/distributed |
| **M4 Screen + power** | ✅ DONE | keep-awake works; **Screen Recording GRANTED to the daemon's node** (owner, 2026-08-01) — real screenshots and streaming both proven |
| **`/agent/mac` page** | ✅ DONE | Switch, pairing, STOP, audit trail, **+ live-stream start/stop section** |
| **Live dock (web)** | ✅ LIVE-PROVEN | Seen with real work in flight: strip appeared during a live session, expanded sheet showed the transcript, a dock reply reached the session's stdin (`sent` event came back) |
| **Live dock (iOS app)** | ✅ DONE (PR #671) | `AgentLiveDockView.swift`, three states + reply row + session cards sim-screenshotted. **Not yet on TestFlight** (owner check-first rule) |
| **L4 transcript + reply + push** | ✅ LIVE (PR #671) | Events stream daemon→server→both docks; tap-to-reply; push on error/ended/question through a durable delivery ledger |
| **L5 resume + multi-session + cost** | ✅ MERGED (PR #672) | Sessions persist to `sessions.json`, restore as detached, `--resume` on next send; per-session cards + cost; daemon updated on the MacBook Air |
| **L7 live screen streaming** | ✅ LIVE-PROVEN (PR #673) | Start from `/agent/mac` or the dock → frames every ~1.5-3s → full-Mac live view in the expanded dock (frame timestamps advancing, verified) → stop broadcast froze frames in seconds |

**Key files.** Server: `src/agent/lib/mac-agent/{policy,bus}.ts`, `src/app/api/assistant/mac-agent/{pair,poll,result,status}`, `src/app/api/assistant/live-activity`, `src/agent/tools/{mac-tools,cli-session-tools}.ts`, `src/agent/components/AgentLiveDock.tsx`, `src/app/agent/mac/page.tsx`. Daemon: `mac-agent/{agent,policy,sessions}.mjs`. Mac app: `mac-app/`.

**Owner setup:** `docs/MAC_CONTROL_SETUP_BN.md`.

---

## 2. ~~Why the iOS app shows nothing~~ (HISTORICAL — solved by L3)

The iOS chat is native SwiftUI, not React, so the web `AgentLiveDock` could
never appear there. **Solved:** `AgentLiveDockView.swift` (PR #671) is the
SwiftUI half, mounted in the chat composer's `safeAreaInset`. Kept only as
the explanation of why two dock implementations exist.

---

## Phase L3 — the iOS live dock (✅ DONE 2026-08-01, PR #671 with L4; L5 in PR #672)

Traps this build paid for (do not rediscover):
- **`.task` on `Group { if … }` never fires while the condition is false** — the
  poll that would make the dock visible never started. The dock body is a
  VStack (a real installed view) for exactly this reason.
- **AlmaAPI normalizes 401/403 to `.notAuthenticated`** and posts the login
  banner; owner-only feeds polled from staff phones must use `getQuietAuth`.
- **Screenshot negotiation:** the client sends `screenshotAfter`; the server
  answers an unchanged frame with metadata only — and must STILL return
  `screenshotAt`, or the client drops its cache and re-downloads every other
  poll.
- **Reply targeting:** pin the composer's target session at the first
  keystroke; recomputing from the newest event mid-typing sends the owner's
  answer to the wrong session. Codex sessions get no composer (one-shot).
- The `ALMA_LIVE_DOCK_FIXTURE=strip|sheet` DEBUG launch flag drives all three
  states deterministically in the sim (`SIMCTL_CHILD_` env).

Original spec below, kept for reference.

**Goal:** in the native app, while the agent works, a compact live strip sits above the composer; tapping expands it to a sheet; collapsing returns without losing scroll position.

- `AgentLiveDockView.swift` — three states (hidden / strip / sheet), mirroring the web component's rules: **renders nothing when idle**, ~20s linger after work ends, dismiss remembered per step id.
- Poll `/api/assistant/live-activity` through the existing `AlmaAPI` client (the file already runs 13 timed/`.task` loops — follow that pattern, do not invent a new one). 3s while active, 15s idle.
- Mount above the composer in the chat body, not as a floating overlay — it must not fight the keyboard.
- Expanded sheet: screenshot large, step list under it, each step showing its policy badge (green = ran by itself, amber = he approved it).
- **Proof required:** simulator screenshots of all three states with real activity, per CLAUDE.md's iOS self-test rule, before any TestFlight build.

**Watch out:** the app already has an unrelated `live-activity-push.ts` + `/api/assistant/internal/live-activity/register` for the ActivityKit Dynamic Island panel. Same words, different feature — do not merge them by accident.

---

## ~~Phase L4~~ / ~~L5~~ — DONE (specs below are HISTORICAL, kept for context)

Both shipped 2026-08-01 (PRs #671, #672) and are live in production: the dock
shows the session transcript, tap-to-reply works, pushes fire through a
durable ledger, sessions survive daemon restarts via `--resume`, and per-session
cards carry cost. **Do not read the two spec blocks below as work to do.**

## Phase L4 — make the watching real-time and useful ✅ DONE

Today the dock reports *command rows*. A Claude session's actual thinking is richer than that and the owner cannot see it.

- **Stream session events into the feed.** `sessions.mjs` already keeps a per-session event buffer (`text` / `tool` / `turn_done`) with sequence numbers. Push them to the server so the dock can show what the session is *saying*, not just that a session exists.
- **Tap-to-reply from the dock.** When a session asks a question, he answers in the dock and it goes straight to `send_to_cli_session` — no need to leave the chat.
- **Screen streaming, not one screenshot.** A ~1 fps capture loop while a session is working, gated by his explicit start (cost + privacy), reusing the existing browser-live streaming shape.
- **Push when it matters.** A session that finishes, errors, or asks a question should reach his phone — the notification infrastructure is already there (`native-owner-push`).

---

## Phase L5 — sessions that survive

- **Resume across daemon restarts.** Sessions live in daemon memory; a launchd restart currently kills the children (the honest choice, but he loses the work). The CLI supports `--resume <session-id>`, and the id is already stored — persist enough state to reattach instead of killing.
- **Multiple concurrent sessions**, each visible in the dock with its own status.
- **Cost per session** surfaced (the CLI reports `total_cost_usd` per turn; it is already captured).

---

## Phase L7 — the full-Mac view (owner's ask, 2026-08-01; streaming half BUILT same day, PR #673)

Built: daemon `screen_stream` verb (owner-started ~1.5s capture loop, hard
downscale, 300s cap, kill-switch aware) → `mac_agent_frames` (one newest-frame
row per device) → served through the EXISTING screenshot channel, so both
docks render it unchanged; 🎥 start/⏹ stop button in the expanded sheets. A
fresh frame keeps the dock `active` → 3s poll ⇒ ~1.5-3s latency on the phone.
**Waiting only on the owner's one-time Screen Recording grant** (ungranted
capture fails `could not create image from display`; the loop degrades to
posting nothing). The Codex CLI is now installed (0.146.0) — L6's npm item is
done. GUI-driving remains future work; spec below.

*"terminal charaw amar mac e ar app claude e jeno try kore … tar cokhe mac ta
full dekha jabe ar ami live streaming e phone theke full mac view soho dekhte
pari agent kothay ase ki kortese."*

Two separable asks, in build order:

1. **Live screen streaming to the dock (build FIRST — it also covers the
   second ask visually).** A ~1 fps `screencapture` loop while work is live,
   gated by his explicit start (cost + privacy), frames downscaled daemon-side
   (the 4.5 MB Vercel body trap), shown in the dock's expanded sheet exactly
   where the single screenshot goes today. Reuses the browser-live streaming
   shape. **Blocked on the one-time Screen Recording grant (L6 item).** With
   this, whatever happens on the Mac — including the Claude APP — is visible
   live from the phone.
2. **Driving the Claude desktop app (GUI) itself.** Honest note (why M2 chose
   CLIs): clicking app windows breaks when a window moves and cannot be
   observed reliably; the CLI IS the same Claude with a structured event
   stream. If the owner still wants true GUI driving after seeing streaming,
   the path is macOS Accessibility APIs (AXUIElement) + screen streaming as
   the eyes — a real phase of its own, with the same GREEN/AMBER/RED policy
   judging every synthetic click/keystroke.

**Login note (asked 2026-08-01):** the Claude CLI login is in the keychain and
SURVIVES reboots — proven live today (session ran `git status` with no fresh
login). "PC off" only stops the daemon from polling; that is what
`keep_awake` and the L6 wake-on-LAN item address, not a login problem.

---

## Phase L6 — finish the loose ends (2 of 4 done)

- ~~**Screen Recording permission**~~ ✅ GRANTED 2026-08-01 (to the daemon's
  `node` binary — apps only appear in that Settings list after attempting
  capture or being added manually with `+` → `Cmd-Shift-G`).
- ~~**Codex CLI**~~ ✅ INSTALLED (0.146.0). Still one-shot (`codex exec`) by
  design; `session_send` refuses honestly rather than hanging.
- **Ship the Mac app** — notarize and put it somewhere he can install without a terminal. STILL OPEN.
- **Wake a sleeping Mac** — the daemon cannot poll while asleep. Wake-on-LAN is possible on the same network; document the limits honestly rather than pretending. STILL OPEN.

---

## Phase L8 — the agent uses the Mac apps like a human (owner's ask, 2026-08-01)

**His words:** *"sudhu Claude app na, ChatGPT app-o Mac-e … ekdom human-er moto
chalano ta beshi dorkar, jate ami na thaklw phone thekei amar shob kaj ba
develop ja kortesi segulo shara din cole, ar ami jate phone thekei shob dekhte
pai."*

So: **both desktop apps (Claude AND ChatGPT), driven like a person, running
his work all day while he is away, fully watchable from the phone.** L7's
streaming already gives the watching; L8 gives the hands.

### What the research says (2026), and what we take from it

| Finding | What we do |
|---|---|
| Two approaches exist: screenshot+coordinates, or the **Accessibility tree (AXUIElement)**. The AX tree wins — structured roles/labels/coords, survives theme, resolution and DPI changes, and costs far fewer tokens than pixels ([Fazm](https://fazm.ai/blog/macos-ai-agent-accessibility-screencapturekit), [macos-use](https://macos-use.dev/)) | **AX tree is the primary channel.** Screenshots (L7, already built) are the *verification* eye, never the control surface |
| Mature reference implementations are **Swift MCP servers over AXUIElement + CGEvent** — `macos-use`, `mac-computer-use`, Rust `computer-use-mcp` ([mcp.so](https://mcp.so/servers/mcp-server-macos-use), [zavora-ai](https://github.com/zavora-ai/computer-use-mcp)) | Same architecture, but as a **daemon verb**, not a new server — our daemon already owns pairing, policy re-judging, the audit trail and the kill-switch. Do not bolt on a second control plane |
| Every action should **return a diff** (elements added/removed/changed) so the agent knows what its click produced ([macos-use](https://macos-use.dev/)) | Adopt it. A diff is what makes "did my click work?" answerable without a screenshot round-trip |
| **Electron apps expose a limited AX tree** by default — and BOTH targets (Claude desktop, ChatGPT desktop) are Electron ([OpenCLI](https://opencli.info/docs/adapters/desktop/chatgpt-app.html)) | **The single biggest risk in this phase.** Mitigation ladder: (1) set `AXManualAccessibility=true` on the app to force the full web tree, (2) fall back to the app's remote-debugging port for READS, (3) fall back to screenshot+coordinates last. Spike this FIRST — it decides the shape of everything else |
| macOS requires **Accessibility permission** separately from Screen Recording ([Claude Computer Use setup](https://www.digitalapplied.com/blog/claude-computer-use-macos-remote-mac-control-iphone-guide)) | One more one-time owner grant, same place in Settings. Screen Recording is already granted |

### What "watching" must feel like (owner, 2026-08-01, with a screenshot of the ChatGPT Mac app)

*"visible live streaming amon hobe, ChatGPT app-e jemon ase — ami chat live
dekhte pai."* He pointed at the ChatGPT desktop app's small floating session
window, where the conversation itself streams as it happens.

Read precisely: **he wants the CHAT, not a video of a screen.** L7 frames are
a picture of a window — unreadable on a phone, expensive, and unsearchable.
Once W1 proves we can read those Electron apps' AX trees, the same read gives
us the actual message text, so:

- **Mirror the driven app's conversation into the dock as TEXT** — one entry
  per message (who said it, the text), streamed as it lands, exactly the way
  the CLI-session transcript already flows through `mac_agent_session_events`.
  Reuse that pipe; do not invent a second one.
- **Frames stay the fallback and the proof** — a thumbnail/expand for "show me
  the actual window", not the primary way he reads what is happening.
- **The mini-player shape he pointed at already exists** on both docks (strip
  above the composer → expandable sheet). The gap is the CONTENT, not the
  chrome.
- **Ownership:** W1 proves the read, **W3 emits the mirrored messages**, the
  dock renders them with no change (they arrive as session events). W5's
  all-day tasks then read as a live chat he can follow from the phone.
- Same rules as everywhere: mirroring is READ-ONLY (green), and it stops with
  the kill-switch and STOP like everything else.

**Deliberate non-goal:** we are not rebuilding what the CLI already does well.
Coding work should keep going through `claude -p` sessions (observable,
resumable, cheap). L8 exists for what the CLI *cannot* do — the owner's actual
apps, his logged-in accounts, his windows.

### Non-negotiables for L8 (extend §0, do not replace)

1. **Every synthetic click and keystroke is a policy decision.** A new
   `ui_policy` classifier: GREEN = read the tree, scroll, screenshot ·
   AMBER = click / type / submit inside an ALLOWLISTED app · RED = anything
   in a non-allowlisted app, and always: Keychain, System Settings, Mail
   send, banking/payment surfaces, anything that spends money or deletes.
2. **App allowlist, not app denylist.** L8 ships with exactly two entries:
   Claude desktop, ChatGPT desktop. Widening it is a code change + review.
3. **The daemon re-judges every action**, exactly like shell commands — a
   compromised server must not be able to type into his apps.
4. **Kill-switch and STOP kill UI driving instantly**, mid-sequence.
5. **Every action is auditable**: what was clicked, in which app, which
   element, with the AX diff it produced.

---

## §5 — HOW WE BUILD L8 IN PARALLEL (the owner asked to run several sessions)

**One session per work package.** Each package below names its OWN files, so
two sessions never edit the same file. Start each session with exactly the
line under "Session prompt". **W1 must finish before W3/W4 start** (it decides
whether the AX tree is even usable on Electron); everything else is parallel.

### W1 — Electron AX spike (BLOCKING, do this first, alone)
- **Goal:** answer one question with evidence — can we read and act on the
  Claude/ChatGPT desktop UI through AXUIElement, with `AXManualAccessibility`,
  and if not, which fallback works?
- **Writes:** `mac-agent/ax-probe.mjs` (throwaway probe), `docs/L8_AX_SPIKE.md` (the findings)
- **Reads:** this roadmap §L8, `mac-agent/agent.mjs`
- **Done when:** the doc shows a real element tree from BOTH apps, or names the
  exact fallback with evidence — and a chat message was typed and sent into
  one of them from a script. **Also required:** the spike must dump the
  conversation TEXT (who said what) out of at least one app, because chat
  mirroring (§"What watching must feel like") depends on that read.
- **Session prompt:** *"docs/MAC_CONTROL_LIVE_ROADMAP.md pore W1 (Electron AX spike) koro"*

### ✅ W1 — DONE (merged 2026-08-01, PR #677). What it proved, and what it changes

Full findings: `docs/L8_AX_SPIKE.md`. The headline: **the AX tree IS the
control surface — no fallback needed.**

| | Result |
|---|---|
| **Claude desktop** | Works, but ONLY after setting `AXManualAccessibility=true` (then wait 1-2s). Without it the tree is an empty AXGroup. 543 elements: sidebar, session list, composer, whole conversation |
| **ChatGPT desktop** | Works with NO flag at all — 1381 elements, 9 windows. `AXManualAccessibility` returns `-25205` (unsupported) and is not needed. **The Electron risk simply is not there** |
| **Reading elements** | Yes, with titles/descriptions. Composer is `AXTextArea` — Claude `D="Prompt"`, ChatGPT `D="Do anything"` |
| **Reading the chat** | Yes — OWNER/ASSISTANT split works. Claude's own headings say who spoke ("You said:" / "Claude responded:"), so **mirroring is easier than assumed** |
| **Type + send** | Proven end to end: script opened a new Claude chat, typed a prompt, pressed Return, and read Claude's reply back out of the tree |

**Four things W1 learned that W3/W4 must build in — do not rediscover them:**
1. **Set `AXManualAccessibility` for Claude, skip it for ChatGPT** (and tolerate
   `-25205` rather than treating it as failure).
2. **Scope every search to ONE window.** Both apps have several (Codex panel,
   pet overlay); an app-wide search finds the wrong composer.
3. **Never drive while the owner is at the keyboard.** W1's draft guard fired
   for real. W2 now enforces this in policy (`ownerIdleSeconds` →
   `owner_active`); **W3 must MEASURE idle time and pass it in**, and treat
   `owner_active` as *defer and retry*, not as a failure.
4. **Compile the Swift helper once with `swiftc`.** The interpreter takes
   8-15s per call, which is unusable at a per-action cadence.

Two P2s W1 deferred, now W3's to carry: **verify the ChatGPT plain-chat
composer**, and **assert the composer actually changed after typing** before
reporting success.

### W2 — the UI policy classifier (parallel with W1)
- **Goal:** the GREEN/AMBER/RED rules for UI actions, plus its daemon-side twin
  and the parity test — same shape as the shell classifier.
- **Writes:** `src/agent/lib/mac-agent/ui-policy.ts`, `mac-agent/ui-policy.mjs`,
  `src/agent/lib/mac-agent/__tests__/ui-policy{,-parity}.test.ts`
- **Reads:** `src/agent/lib/mac-agent/policy.ts` + `mac-agent/policy.mjs` (the
  pattern to copy), `__tests__/policy-parity.test.ts`
- **Done when:** parity test fails the build if the copies drift; RED cases
  (Keychain, System Settings, non-allowlisted app) are unit-tested.
- **Session prompt:** *"docs/MAC_CONTROL_LIVE_ROADMAP.md pore W2 (UI policy classifier) koro"*

### W3 — the daemon's UI driver (READY TO START — W1 merged, W2's contract below)
- **Goal:** `ui_*` verbs on the daemon — `ui_tree`, `ui_click`, `ui_type`,
  `ui_key`, `ui_scroll`, each returning the AX diff; re-judged locally.
- **Writes:** `mac-agent/ui-driver.mjs`, wiring in `mac-agent/agent.mjs`
- **Reads:** `docs/L8_AX_SPIKE.md` (W1), `mac-agent/ui-policy.mjs` (W2's twin —
  **call it, do not reimplement it**), `mac-agent/sessions.mjs` (handler pattern)
- **The W2 contract W3 must satisfy** (`classifyUiAction` refuses otherwise):
  - measure and pass **`ownerIdleSeconds`**; `owner_active` means *wait and
    retry*, not fail;
  - resolve and pass **`elementLabel`** for BOTH `ui_click` and `ui_type` —
    a missing label is a hard refusal, on purpose;
  - resolve and pass **`focusedLabel`** before any Enter/Space/cmd+Enter;
  - pass the **`bundleId`** for everything except a full-screen screenshot.
- **Carry W1's four lessons:** `AXManualAccessibility` for Claude only ·
  window-scoped searches · `swiftc`-compiled helper · assert the composer
  changed after typing (and verify ChatGPT's plain-chat composer).
- **Also W3: chat mirroring.** A watcher that re-reads the driven app's
  conversation area and emits each NEW message as a session event (same
  `mac_agent_session_events` pipe as CLI sessions), so both docks show the
  app's live chat as text with zero render changes. Dedupe by message
  index/hash; never re-emit what was already sent.
- **Done when:** a scripted sequence opens Claude desktop, types a prompt,
  submits it, reads the reply back through the tree — AND that reply appears
  as live text in the web dock.
- **Session prompt:** *"docs/MAC_CONTROL_LIVE_ROADMAP.md pore W3 (daemon UI driver) koro"*

### W4 — server tools + approval cards (READY TO START, parallel with W3)
- **Goal:** the agent-facing tools and the owner's AMBER card for a UI action.
- **Uses W2:** import `classifyUiAction` from
  `src/agent/lib/mac-agent/ui-policy.ts` and enqueue only green/amber; the card
  must show the app, the element label and the literal text (the classifier's
  `reasonBn` already reads that way).
- **Writes:** `src/agent/tools/mac-ui-tools.ts`, its registry/prompt/pack wiring
- **Reads:** `src/agent/tools/mac-tools.ts` (the pattern), §0.4's FIVE wiring places
- **Done when:** the head can call `drive_mac_app` from plain Bangla and an
  AMBER action produces a card showing the app, the element and the text.
- **Session prompt:** *"docs/MAC_CONTROL_LIVE_ROADMAP.md pore W4 (mac UI tools) koro"*

### W5 — all-day autonomy (after W3+W4)
- **Goal:** the owner's real ask — work continues all day. A durable "app task"
  queue with progress into the same live dock, so a long app-driven job
  survives restarts and is watchable from the phone.
- **Writes:** `src/agent/lib/mac-agent/app-tasks.ts`, migration, dock wiring
- **Reads:** `session-push.ts`, `live-activity/route.ts` (the feed contract)
- **Session prompt:** *"docs/MAC_CONTROL_LIVE_ROADMAP.md pore W5 (all-day app tasks) koro"*

### W6 — iOS parity + TestFlight (last)
- **Goal:** the native dock shows UI-driving steps and approval cards; ONE
  batched TestFlight build after sim proof, with the owner's explicit go.
- **Writes:** `ios/App/App/AgentLiveDockView.swift` and friends
- **Session prompt:** *"docs/MAC_CONTROL_LIVE_ROADMAP.md pore W6 (iOS parity for UI driving) koro"*

**Rules for every parallel session:** own branch `claude/l8-w<N>-*`, own PR,
Codex P0/P1 fixed before merge, `git pull` at start / `git push` at end, and
**never edit a file another package owns** — if you need something from it,
say so in the PR and let that session change it.

---

## 3. Traps already paid for (do not rediscover these)

- **Five wiring places** (§0.4). A tool can be registered, prompted, packed and STILL be invisible.
- **The state router runs in SHADOW mode in production** (`AGENT_STATE_ROUTER`) — the legacy selector is what actually ships tools. Debug there, not in the router.
- **Middleware** must list any daemon endpoint (`/api/assistant/mac-agent/{pair,poll,result}`) or auth never runs and every pairing 401s.
- **Never append to an applied migration** — it silently never runs. New column = new migration file.
- **Vercel Functions reject bodies over ~4.5 MB.** Screenshots must be downscaled daemon-side.
- **`dark:` variants follow the OS, not the app.** Agent routes always render light; a `dark:` override wins on a dark-mode Mac and paints white text on white.
- **A daemon e2e test must not touch `~/.alma-mac-agent`** — it hijacks his live daemon. Use a throwaway `HOME`.
- **The daemon is macOS-only** (`/bin/zsh`); its e2e test must skip off darwin or CI fails for a meaningless reason.
- **Short commands are invisible without a grace window.** A read-only command finishes in ~2s and the dock polls every 3s.

---

## 4. What remains (updated 2026-08-01 end of day)

Done and crossed off: ~~Screen Recording grant~~ (owner granted), ~~Codex CLI
install~~ (0.146.0), ~~web dock never seen live~~ (proven with a real session).

**Owner-pending:**
1. Look at the docks and the live stream and say whether the FEEL is right —
   everything is proven working; taste is his call.
2. **iOS app: the native dock is NOT on his phone yet** — a TestFlight build
   awaits his check-first approval (sim proof exists).

**Future build work (next phases, in rough order):**
1. **Claude-app GUI driving** (L7's second half) — Accessibility-API based,
   same GREEN/AMBER/RED policy per synthetic click; spec'd in Phase L7 below.
2. **Mac app notarization + distribution** (M3/L6) — installable without a
   terminal.
3. **Wake a sleeping Mac** (L6) — wake-on-LAN on the same network; document
   the honest limits.
4. Two-Mac polish: pairing exists for many Macs; only the MacBook Air is
   paired today. Pair the Mac mini when he wants both drivable.
