# PA-4 Native (iOS) Handoff — Voice-Instruction Badge

**Branch:** `native/pa4-voice-badge`
**Written:** 2026-07-24, by the PA roadmap session. Owner instruction: park the
TestFlight-bound part on its own branch + this doc, so a later session can pick
it up, verify it TOGETHER with its own work, and ship ONE batched TestFlight
build (per the CLAUDE.md iOS build gate — no drip builds).

## What this branch contains

One file changed: `ios/App/App/AssistantSwiftUI.swift`

1. `AgentChatMessage` gains (mirrors web `src/agent/lib/voice-instruction.ts`):
   - `static let voiceInstructionPrefix = "🎙️ [ভয়েস কল থেকে নির্দেশ]"`
   - `isVoiceInstruction` — user-role message starting with that marker
   - `voiceInstructionBody` — the spoken words with the marker stripped
2. `AgentMessageRow` gets a new branch BEFORE the normal user-bubble branch:
   a voice instruction renders as
   - chip row: `🎙️ ভয়েস নির্দেশ` (coral capsule) + status chip
     (`গৃহীত — এজেন্ট নিচ্ছে…` → `চলছে…` orange pulse → `শেষ ✓` green),
     status derived in `voiceTurnStatus` from the NEXT message in `vm.messages`
     (assistant absent / `isStreaming` / settled)
   - then the normal coral gradient pill with the STRIPPED text
     (`AlmaSelectableRichText`, same styling as the plain user branch).

## Context — what already shipped (main, web side)

- PA-3 (voice → execution): live-call `submit_boss_instruction` → head turn
  with message prefix `🎙️ [ভয়েস কল থেকে নির্দেশ]` (PRs #513/#520/#527/#528/#531).
- PA-4 web: same badge + status chip in the web chat
  (`src/agent/components/AgentThread.tsx`, `VoiceInstructionBubble`,
  PR #533). The NATIVE app currently shows the raw `🎙️ […]` marker text in the
  user bubble — this branch replaces that with the proper badge UI.

## Verification the next session MUST do (nothing here was compiled yet)

⚠️ This branch was authored without an Xcode compile — treat it as unreviewed
Swift until the simulator run passes.

1. Rebase/merge onto current `main` first (`git merge origin/main`).
2. Simulator build (owner's Mac, per CLAUDE.md):
   `xcodebuild -workspace ios/App/App.xcworkspace -scheme App -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' -derivedDataPath /tmp/alma-sim-dd build`
   then `xcrun simctl install/launch` + screenshot. Sim udid/passcode: memory
   `reference_ios_sim_access`.
3. In the sim: open Assistant chat → conversation with a voice instruction.
   Test data exists in prod: conversations titled `🎙️ …` (e.g. the PA-3 verify
   runs on 2026-07-23/24) — badge + `শেষ ✓` chip must render, the raw
   `🎙️ [ভয়েস কল থেকে নির্দেশ]` marker text must NOT appear.
   For the `চলছে…` state: submit a live voice instruction (see PA-3 self-test
   recipe in memory `project_phone_agent_roadmap`) while the chat is open.
4. Batch with your own changes → `bash scripts/ios-build-preflight.sh` →
   ONE archive/TestFlight upload, build number bump committed per the gate.

## Sanity notes for the implementer

- `voiceTurnStatus` intentionally checks only the IMMEDIATELY next message —
  matches web `AgentThread` logic; if native interleaves other rows (cards)
  between user msg and assistant turn, widen to "first assistant after idx".
- Chip colors use system `Color.orange/green` + `AgentPalette` fills — if the
  design-system review prefers aurora tokens, restyle freely (owner rule:
  ALMA design system, coral #E07A5F).
- Android parity (Compose) NOT included — separate branch per the Android
  parity program if the owner asks.
