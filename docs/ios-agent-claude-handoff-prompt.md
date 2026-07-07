# iOS Native Agent Chat — FULL Claude Code Handoff (Build 54)

> **Sir (Maruf) will finish ALL of this together, then ONE TestFlight upload.**  
> Copy everything below `---` into Claude Code.  
> **Worktree:** `/Users/marufbillah/alma-erp/.claude/worktrees/wt-native-voice`  
> **Branch:** `native/voice-console`  
> **Do NOT commit/push unless Sir explicitly asks.**

---

## YOUR MISSION

Rebuild native iOS **Assistant chat** to match **Claude iOS app** — premium SwiftUI glossy/glass, NOT flat web list + emoji on aurora gradient.

**Sir's bar:** simulator-এ multi-tool message পাঠালে বলবে *"eta Claude er moto"* — তারপর একসাথে TestFlight।

**No "done" without:** build succeed + iPhone 17 Pro Max simulator install + screenshot proof.

---

## BUILD NUMBER HISTORY (critical — don't confuse Sir)

| Build | Status | What's in it |
|-------|--------|--------------|
| **50** | **Last committed + shipped to TestFlight** | `1eac5eda` — product images, order size, keyboard dismiss, More aura. **NO agent Claude composition work.** |
| **51–53** | Never committed | (gap — no git tags) |
| **54** | **Current LOCAL uncommitted** | Agent UI iteration: `AlmaStarburstSpinner.swift`, massive `AssistantSwiftUI.swift` changes, build bump in `project.pbxproj`. **Sir has NOT uploaded 54 to TestFlight yet.** |

```bash
# Verify build number
grep CURRENT_PROJECT_VERSION ios/App/App.xcodeproj/project.pbxproj
# → 54 (uncommitted)
```

**Sir's plan:** fix everything in build 54 worktree → single TestFlight upload (likely build 55 bump after fixes).

---

## STARBURST LOADER — same animation? same place? NO.

### One animation engine, many placements (problem)

All spinners use **`AlmaStarburstLoader`** in `ios/App/App/AlmaStarburstSpinner.swift`:
- Organic 12-spoke terracotta `#d97757` burst
- `StarburstAnimState` — rAF-style Canvas, boil + breathe + rotate
- Modes: `thinking` | `researching` | `searching` | `writing` (different rot speed / dotMix)

**Wrapper components:**
| Component | Uses | Verb label | Haptics |
|-----------|------|------------|---------|
| `AlmaStarburstLoader` | raw canvas | no | no |
| `AlmaMiniLoader` | loader only | no | no |
| `AlmaSpinnerView` | loader + optional Bangla verb | yes (`showVerb`) | yes (`haptics`) |

### Every starburst/sparkle location in agent section (Build 54)

| # | Location | File | Component | Size | Position | Correct for Claude? |
|---|----------|------|-----------|------|----------|---------------------|
| 1 | **Streaming turn bottom** | `AssistantSwiftUI.swift` → `AgentThinkingRow` | `AlmaSpinnerView(showVerb:false)` | 28 | **Bottom-left of assistant turn** | ✅ YES — only place during stream |
| 2 | Page history load | `AssistantSwiftUI.swift` → `AlmaPageLoader()` | was centered 44px + "লোড হচ্ছে" | — | center screen | ✅ Fixed → silent `Color.clear` (verify) |
| 3 | Composer mic transcribing | `AgentComposerView` | `AlmaMiniLoader(.thinking)` | 16 | mic button | ⚠️ OK (not chat turn) |
| 4 | Composer attachment upload | `AgentComposerView` attachmentsRow | `AlmaMiniLoader` | 18 | attachment chip | ⚠️ OK |
| 5 | TTS loading on message | `AgentMessageActions` | `AlmaMiniLoader` | 14 | footer row | ⚠️ OK |
| 6 | **DEAD inline timeline** | `AgentActivityTimeline` | `AlmaMiniLoader` 10–12 | 10–12 | inline rows | ❌ Must NEVER render in chat (dead code) |
| 7 | Tool row live (dead list) | `AgentToolRow` / `AgentLiveToolList` | `AlmaMiniLoader` | 13 | inline | ❌ Not in Claude chat rows |
| 8 | **Activity interleaved rows** | `AgentInterleavedActivityRows` | none (emoji only) | — | row right was mini loader → removed | ✅ No row spinners |
| 9 | Loader preview (debug) | `SwiftUIShell.swift` → More → `AlmaSpinnerPreviewScreen` | 200/32/120 sizes | varies | More menu push | DEBUG only |
| 10 | **Floating FAB** | `SpikeNativeShell.swift` → `AgentAssistiveNav` | SF Symbol **`sparkles`** (NOT organic burst) | 56 FAB | **Bottom-right above tab bar** | ⚠️ Sir sees "floating starburst" near composer — this is AssistiveTouch nav, NOT loader. Uses `sparkles` icon, not `AlmaStarburstLoader`. |

### `liveMode` drives streaming starburst animation

`AssistantVM.liveMode` (~line 624):
- live tool running → `"searching"` (fast spin, dotMix=1)
- text streaming → `"writing"` (medium spin)
- else → `"thinking"` (slow organic boil)

**Claude rule:** ONE starburst at **bottom-left of content stack** while turn runs. **Never** on activity rows. **Never** centered on page open.

### HTML reference for starburst feel

`docs/agent-loader-live-preview.html` — mode comparison (thinking/researching/tool/writing)  
`docs/agent-claude-composition-v3.html` — starburst in turn footer only during Play demo

---

## SIR'S SCREENSHOT FEEDBACK — FULL CHECKLIST (all must be addressed)

### Session 1 — Claude iOS reference screenshots (6 images)

| ID | Sir said | Status in Build 54 |
|----|----------|-------------------|
| S1 | Starburst center na, **bam pashe** | Partial — `AgentThinkingRow` left, but FAB `sparkles` still bottom-right |
| S2 | Prose e icon deya — Claude e nai | ✅ Prose plain; `✦ ALMA` only in footer |
| S3 | Multi-tool e alada prose na — compact rows, token efficient | ❌ Still row spam (7+ Thinking rows), no block interleave |
| S4 | Ask card ashbe na | ⚠️ UI exists; agent must call `ask_user` |
| S5 | Pending "১ কাজ বাকি" last reply e | ✅ Wired `AgentOpenTasksChipView` — needs open tasks in DB to test |
| S6 | Approve/Reject + **আমার মত** always | ✅ `AgentConfirmCardView` + `submitOpinion` — polish gap possible |

### Session 2 — Broken simulator screenshots (3 images)

| ID | Sir said | Status |
|----|----------|--------|
| S7 | Agent tab → center starburst "লোড হচ্ছে" flash | ✅ `AlmaPageLoader` silent — re-verify on clean install |
| S8 | Activity rows **duplicated** (8 rows = 4×2) | ✅ Duplicate render removed — re-verify |
| S9 | Row **right e mini starburst** | ✅ Removed from interleaved rows |
| S10 | Settled e orange dot + English phase inline (`AgentActivityTimeline`) | ✅ Not inline in chat — but rows still show all tools when streaming |
| S11 | Thought process glossy sheet na | ⚠️ `AgentThoughtProcessSheet` added — Sir says still feels old/cheap |
| S12 | Floating square starburst above composer | = `AgentAssistiveNav` FAB (sparkles), not loader |

### Session 3 — Latest screenshots (3 images) — Sir very angry

| ID | Sir said | Status |
|----|----------|--------|
| S13 | **Clock emoji 🕐 cheap** — Claude premium glossy icons | ❌ Still emoji `🕐🔍⚡` in `AgentInterleavedActivityRows` |
| S14 | Proti tool er jonno alada prose — **web design feel** | ❌ Need `TurnBlock` interleaved model + glass turn card |
| S15 | Reply seshe **prose vanish** → summary starts | ❌ `loadMessages()` clobbers stream tail — **must fix** |
| S16 | Design iOS SwiftUI na — web list on gradient | ❌ Need `AgentTurnGlassCard` wrapping whole turn |
| S17 | Claude: **ekta prose e 3/4 rows** premium glossy | ❌ Not implemented |

### Google AI Studio spec (Sir provided)

- Interleaved chronological: prose ↔ activity rows grow together
- Activity rows: **44dp**, icon + label + chevron (Searching / Thinking / Tool)
- Spinner bottom of stack, **no label**
- Summary + Thought process sheets: 50%/90% detents, grabber, X
- Composer: Stop during stream, disabled input
- State machine: `SENT → PENDING → PROSE_1 → TOOL_DISCOVERY → THINKING → PROSE_2 → TOOL → DONE`

### Claude 89s video analysis (from prior session)

| ~Time | Behavior |
|-------|----------|
| 24s | Send → brief center starburst only |
| 28s | Collapsed header: clock + truncated Bengali + chevron |
| 36s | Prose starts |
| 40s | Searched available tools row |
| 52s+ | Interleaved prose ↔ Thinking ↔ Tool |
| 64s | Thought process sheet |
| 52s | Summary sheet |
| End | Starburst gone; prose + collapsed summary remain |

---

## WHAT TO BUILD (non-negotiable)

### A. Turn layout — ONE glossy glass container

```
┌─ AgentTurnGlassCard (.ultraThinMaterial, r=16) ─────────┐
│ [collapsed header: SF clock + truncated BN text … ›]      │  ← optional during stream
│ [prose block — plain, NO avatar]                        │
│ [glossy activity row: Searched available tools        ›]  │
│ [glossy activity row: get_pending_approvals         ›]  │
│ [prose block 2 if interleaved]                          │
│ [starburst 28px bottom-left ONLY while streaming]         │
│ [AskCard / ConfirmCard if emitted]                        │
└───────────────────────────────────────────────────────────┘
[✦ ALMA footer + copy + TTS + tokens when settled]
[১ কাজ বাকি chip if open tasks]
```

Rules:
- **Max ~4 visible activity rows** during heavy tool use
- **Merge consecutive Thinking** into ONE row until prose or new tool group
- **Never** separate prose block per tool
- Rows inside glass card — NOT naked on aurora

### B. SF Symbols — ZERO emoji in activity UI

Replace in `AgentInterleavedActivityRows`, `AgentSettledSummaryRow`, `AgentThoughtProcessSheet` summary items:

| Was | Use |
|-----|-----|
| 🕐 | `Image(systemName: "clock")` in 28pt material circle |
| 🔍 | `magnifyingglass` |
| ⚡ | `bolt` or `wrench.and.screwdriver` |

Thinking label italic muted; tool label `mutedHi`; chevron `›` trailing only.

### C. Fix prose vanish (P0 bug)

`AssistantVM.runTurn()` end:
```swift
await loadMessages()  // messages = wire.map(...) — WIPES streaming tail
```

Fix:
1. On `done` SSE: `messages[i].isStreaming = false` in-place
2. Merge server message into tail by id — preserve `text`, `timeline`, `blocks`
3. Debounce full reload; patch only card statuses / ids
4. **Prose must never blink/disappear** at stream end

### D. Settled state

- Hide expanded interleaved rows
- Show ONE row: `৮ সেকেন্ড ধরে ভেবেছে · ~৩৮৮ টোকেন · ২ ধাপ ›`
- Tap → **Summary** sheet (timeline)
- Tap Thinking (during stream) → **Thought process** sheet
- Prose stays visible

### E. Bottom sheets (polish existing)

`AgentThoughtProcessSheet` exists (~line 2260) — Sir wants **more glossy**:
- Dark glass `#1c1c22` + `.ultraThinMaterial`
- Grabber, circular X, centered title
- `.presentationDetents([.medium, .large])` for Summary, `.large` for Thought process
- Match `docs/agent-claude-composition-v3.html` `.sheet` CSS

### F. Ask card

- Glossy floating card, numbered 1–4, "Type your answer…"
- **"1 of 3"** pagination when multiple `askCards`
- `answerAskCard` + `send(option)` already wired
- Backend: `src/agent/tools/ask-tools.ts` — needs `ask_user` tool call

Test: *"ask_user tool use kore amake 3 option er question card pathao"*

### G. Confirm card + আমার মত

Web: `src/agent/components/AgentConfirmCard.tsx`  
Native: `AgentConfirmCardView` + `submitOpinion` — verify glossy polish

### H. Pending chip

`AgentOpenTasksChipView` at end of **last assistant message** (not scroll bottom)

### I. ALMA theme (keep)

- Aurora bg, coral `#E07A5F`, Bangla UI, token footer on settled messages

---

## REFERENCE FILES (read in order)

1. **`docs/agent-claude-composition-v3.html`** — TARGET (Play demo + sheets)  
   `cd docs && python3 -m http.server 8765`
2. `docs/agent-loader-live-preview.html` — starburst modes
3. `docs/agent-claude-composition-full-page.html` — good vs bad
4. `src/agent/components/AgentThread.tsx` — web settled timeline
5. `src/agent/components/AgentAskCard.tsx` — ask card
6. `src/agent/components/AgentConfirmCard.tsx` — confirm + opinion
7. `ios/App/App/AlmaStarburstSpinner.swift` — loader engine (keep)
8. `ios/App/App/AssistantSwiftUI.swift` — ~4460 lines, everything

---

## CURRENT CODE INVENTORY (Build 54 uncommitted)

### Done (partial — verify, don't break)

- [x] `AlmaStarburstSpinner.swift` — organic loader + silent `AlmaPageLoader`
- [x] `AgentThinkingRow` — bottom-left starburst, no verb
- [x] `AgentInterleavedActivityRows` — no row spinners (emoji still wrong)
- [x] `AgentSettledSummaryRow` — tappable → Summary sheet
- [x] `AgentActivitySheetRequest` + `AgentThoughtProcessSheet`
- [x] `AgentAskCardView`, `AgentConfirmCardView`, `submitOpinion`
- [x] `AgentOpenTasksChipView` on last assistant reply
- [x] SSE `handle()` for ask_card, confirm_card, tool_start, thinking_delta
- [x] `AgentChatMessage.from()` sets `timeline` from wire
- [x] Stream: interleaved rows only while `isStreaming`; settled → summary row

### NOT done (Sir's blockers)

- [ ] SF Symbols replace emoji
- [ ] `TurnBlock` interleaved prose + activity chronology
- [ ] `AgentTurnGlassCard` glossy container
- [ ] Merge Thinking rows (still 7+ for 3 tools)
- [ ] Fix prose vanish on `loadMessages()`
- [ ] Sticky collapsed header row during stream (Claude ~28s)
- [ ] Ask card pagination "1 of N"
- [ ] Artifact/code card (`</> spark-loader Code · HTML`) — P2
- [ ] Composer stop button during stream — verify coral stop works
- [ ] Remove or gate `AgentAssistiveNav` FAB if Sir finds confusing

### Dead code — do not render inline

- `AgentActivityTimeline` (~line 1909) — orange dots, English phases, inline mini loaders
- `AgentLiveToolList` — fallback flat tool list

---

## IMPLEMENTATION ORDER

### Phase 1 — `TurnBlock` model + SSE block append

```swift
enum TurnBlock: Equatable {
    case prose(String)
    case activity(ActivityRow)
}
var blocks: [TurnBlock] = []
```

- `text_delta` → extend last `.prose` or new block after activity
- `thinking_delta` → merge into one pending thinking activity (don't spam rows)
- `tool_start/end` → one search row + tool rows

### Phase 2 — `AgentGlossyActivityRow` + `AgentTurnGlassCard`

SF Symbol in material circle, 44pt row, chevron, parent glass card.

### Phase 3 — Fix `loadMessages` / stream finalization

Merge tail; never wholesale replace prose at stream end.

### Phase 4 — Sheet + card polish

Thought process / Summary / Ask / Confirm — unified glossy design system.

### Phase 5 — Starburst audit

Confirm ONLY `AgentThinkingRow` shows organic burst in chat turn.  
Document any other uses (composer mic, TTS) as intentional.

### Phase 6 — Build 55 + TestFlight prep

```bash
cd /Users/marufbillah/alma-erp/.claude/worktrees/wt-native-voice/ios/App
# bump CURRENT_PROJECT_VERSION to 55 in project.pbxproj when Sir approves
xcodebuild -workspace App.xcworkspace -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' \
  -derivedDataPath /tmp/alma-ios-build build
xcrun simctl install booted /tmp/alma-ios-build/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch booted com.almatraders.erp
```

---

## TEST SCENARIOS (all must pass before Sir TestFlight)

1. Open Assistant — **no** center "লোড হচ্ছে" flash
2. Multi-tool message — **≤4 glossy rows** in one glass card, **one prose stream**, starburst bottom-left only
3. Stream ends — **prose stays**, one collapsed summary row
4. Tap Thinking row → **Thought process** glossy sheet
5. Tap summary row → **Summary** sheet with timeline
6. Tap tool row → tool I/O sheet
7. `ask_user` → glossy question card with options
8. Confirm action → Approve / Reject / **আমার মত**
9. Open task pending → **১ কাজ বাকি** on last reply
10. No emoji 🕐🔍⚡ in activity UI
11. No orange-dot inline timeline in chat
12. Floating FAB (sparkles) still OK or hidden per Sir preference — document decision

---

## HARD RULES

- Native iOS only (`ios/App/App/*.swift`)
- Do NOT touch ERP `/api/agent/*`
- Do NOT commit/push without Sir
- Bangla UI strings
- Address Sir
- Compare every change to `agent-claude-composition-v3.html` Play demo
- Sir uploads **one TestFlight** after ALL items done — not incremental builds

---

## DEFINITION OF DONE

- [ ] SF Symbols — zero activity emoji
- [ ] One `AgentTurnGlassCard` per assistant turn
- [ ] Block-interleaved prose + rows (chronological)
- [ ] ≤1 Thinking row per think burst
- [ ] Prose never vanishes on stream end
- [ ] Settled = collapsed summary + visible prose
- [ ] Thought process + Summary sheets — glossy Claude parity
- [ ] Ask card + pagination
- [ ] Confirm + আমার মত
- [ ] Pending chip
- [ ] Starburst ONLY bottom-left during stream (chat turn)
- [ ] Build 55 (or Sir-approved number) + simulator screenshots
- [ ] Ready for Sir's single TestFlight upload

---

## APPENDIX: SSE events

`thinking_delta` → `tool_start` → `text_delta` → `tool_end` → `ask_card` / `confirm_card` → `done`  
Handler: `AssistantVM.handle(_:)` ~line 1132

## APPENDIX: Sir Bangla summary

Claude iOS moto agent chat · glossy shob jaigay · interleaved token-efficient · ask/confirm/amar mot · pending chip · starburst bam pashe · prose e icon na · demo v3 HTML · **ek sathe sesh kore TestFlight**

**End of handoff.**
