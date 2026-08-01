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

## 1. Where it stands (verified 2026-08-01, all merged to main and live in production)

| | State | Proof |
|---|---|---|
| **M1 Terminal** | ✅ DONE | GREEN `git status` ran by itself · AMBER `echo hello > /tmp/…` produced a card and only ran after Approve (file confirmed absent before, present after) · RED `sudo rm -rf ~/Documents` refused with no card and never reached the daemon |
| **M2 Claude/Codex sessions** | ✅ DONE | Session opened in `~/alma-erp`, task delivered, Claude's own reply `ALMA-OK` came back |
| **M3 Mac app** | ⚠️ BUILDS | Compiles, launches, holds a window + menu bar. Not distributed — owner runs `mac-app/build.sh` locally |
| **M4 Screen + power** | ⚠️ PARTIAL | keep-awake works. Screenshot needs Screen Recording permission, never granted |
| **`/agent/mac` page** | ✅ DONE | Switch, pairing, STOP, full audit trail |
| **Live dock (web)** | ✅ SHIPPED, ❌ UNVERIFIED | API verified; idle-hiding verified. Never seen with work in flight — browser automation could not drive the composer |
| **Live dock (iOS app)** | ✅ DONE (PR #671, 2026-08-01) | `AgentLiveDockView.swift`, three states sim-screenshotted; real prod poll decoded from the sim |
| **L4 transcript + reply + push** | ✅ BUILT (PR #671) | Session events stream daemon→server→both docks; tap-to-reply (pinned target, queued state, Claude-only); push on error/ended/question. Live round-trip needs the daemon files copied to `~/.alma-mac-agent` + restart after merge |
| **L5 resume + multi-session + cost** | ✅ BUILT (PR #672, stacked) | Detached sessions resume via `--resume` on next send; per-session cards with cost in both docks; 5 new daemon tests |

**Key files.** Server: `src/agent/lib/mac-agent/{policy,bus}.ts`, `src/app/api/assistant/mac-agent/{pair,poll,result,status}`, `src/app/api/assistant/live-activity`, `src/agent/tools/{mac-tools,cli-session-tools}.ts`, `src/agent/components/AgentLiveDock.tsx`, `src/app/agent/mac/page.tsx`. Daemon: `mac-agent/{agent,policy,sessions}.mjs`. Mac app: `mac-app/`.

**Owner setup:** `docs/MAC_CONTROL_SETUP_BN.md`.

---

## 2. Why the iOS app shows nothing (the finding that drives the next phase)

`AgentLiveDock` is a React component. **The iOS chat is not React** — it is 15,670 lines of native SwiftUI (`ios/App/App/AssistantSwiftUI.swift`) that talks to the API directly and renders its own messages, composer and tool pills.

So the web dock appears in his browser and PWA, and **cannot** appear in the native app. The API it needs already exists and is deployed; what is missing is the SwiftUI half.

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

## Phase L4 — make the watching real-time and useful

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

## Phase L7 — the full-Mac view (owner's ask, 2026-08-01, in his words)

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

## Phase L6 — finish the loose ends

- **Screen Recording permission** for the daemon, or screenshots stay broken. One-time owner grant.
- **Codex CLI** — `npm i -g @openai/codex`. The driver treats it as one-shot (`codex exec`), which is what it is; `session_send` refuses honestly rather than hanging.
- **Ship the Mac app** — notarize and put it somewhere he can install without a terminal.
- **Wake a sleeping Mac** — the daemon cannot poll while asleep. Wake-on-LAN is possible on the same network; document the limits honestly rather than pretending.

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

## 4. Owner-pending (only he can do these)

1. Look at the web dock once and say whether it feels right — it has never been seen with work in flight.
2. Grant Screen Recording to the Mac agent if he wants screenshots.
3. `npm i -g @openai/codex` if he wants Codex sessions.
