# ALMA Native Agent Chat — LOCKED SPEC (Sir-approved 2026-07-07; loader revised 2026-07-12)

> **Source of truth:** composition remains `docs/agent-claude-composition-FINAL-LOCKED.html`; the revised loader source of truth is `src/agent/components/AlmaSpinner.tsx` + `ios/App/App/AlmaStarburstSpinner.swift`.
> Sir: *"lock the demo very hard… ekta single kichu jeno bad na jay."*
> Any future change to the native agent chat MUST match this file. Do not re-litigate.

## 1. Turn composition (Claude iOS)
- **NO glass card around the turn.** Prose + rows sit plain on the aurora background.
- Interleaved chronological blocks: prose ↔ compact activity rows, exact SSE order (`TurnBlock`).
- Activity row: 40pt, small outline SF icon (clock / magnifyingglass / wrench.and.screwdriver),
  muted label (thinking = italic, first line of the burst, ≤64 chars), trailing `chevron.right`.
- ONE thinking row per think-burst (new burst only after prose/tool interrupts).
- Max 4 visible rows; older ones collapse into one "আগের N ধাপ" row → Summary sheet.
- **Rows PERSIST after settle** (tap → sheets). History (no blocks) = one collapsed summary row above prose.
- Zero emoji anywhere in activity UI. Bangla digits everywhere.

## 2. Starburst loader (12 organic rays · ALMA aurora palette)
- **Understanding:** every send begins with one smooth ~2.08s inward intake; later SSE states queue during it. Rotation phase and velocity carry into the next mode, so there is no angle/speed jump.
- **Thinking:** the whole burst never globally scales. Adjacent groups of 2–3 rays retract toward the centre and reopen, then the next group continues. Rotation **2.1s/rev**, cluster cycle **270ms**.
- **Writing:** same clustered-ray language, slightly different cadence: rotation **2.2s/rev**, cluster cycle **290ms**.
- **Research + tool:** both use the Claude-style starburst ↔ 12-dot ring morph at **1.5s/rev**.
- **Idle:** no rotation; only a quiet four-frame angular boil beside the ALMA wordmark.
- Rays keep intentionally uneven lengths/widths and rounded caps. Four deterministic angular-boil frames run at ~10–11fps; there is no radial jitter and no global breathing pulse.
- Colour is a stable blue → violet → magenta → pink → coral sweep taken from the existing ALMA aurora theme; glow stays subtle at native size.
- Placement: bottom-left inside the running turn, with the existing small `ALMA` wordmark beside it. Never page-centre in production chat.

## 3. Text shimmer (streaming prose)
- Base text opacity **0.35**; white highlight gradient sweeps left→right, loop **1.8s** linear
  (gradient ~100deg, stops .35→#fff→.35, background-clip:text equivalent).
- On settle: shimmer stops, full-color markdown renders. Prose must NEVER blink at stream end
  (identity-preserving server merge in `mergeServerMessages`).

## 4. ALMA wordmark footer (Claude Lottie parity — HARD CYCLE, never breaks)
- Reply settles → footer: burst **pop-in scale 0→1 + rotate -300°→0, .85s spring** →
  **A·L·M·A letters slide out from behind the burst**, staggered .12/.19/.26/.33s, mask-clipped.
- Wordmark **STAYS** (unlike the Lottie); burst rests in **idle mode** (no rotation, gentle boil).
- Next user send → letters slide back INTO the burst (reverse stagger 0/.06/.12/.18s, ~.56s)
  → the working starburst takes over for the new turn.
- Footer right side: token count `↑in ↓out · $cost`, one line, never wraps. Copy + TTS buttons.

## 5. Haptics (shape-event synced, Claude-app smooth)
- Mode/understanding start: restrained medium tick (~0.52 intensity).
- Understanding: soft confirmation at the deepest inward intake (~940ms).
- Thinking/writing: low-intensity micro-tick at each adjacent cluster's maximum retraction (halfway through the 270/290ms cluster cycle), not at an unrelated rotation boundary.
- Research/tool: two accents per 1.5s morph—dot ring settled at 510ms, star fully reopened at 1.35s.
- Reply settle + wordmark reveal: soft success-like double thud. Idle has no recurring haptic.

## 6. Fonts
- Prose, ask-card question, thought text, copy-box body: **serif** (Claude feel) —
  bundle Bangla serif (Noto Serif Bengali) if available, else system serif design + Bangla fallback.
- UI chrome stays SF/system.

## 7. Sheets — ONE glossy glass language everywhere (model-switcher glass)
- `.ultraThinMaterial` + light tint rgba(58,58,70,.42), corner 26, grabber, circular ✕ left,
  centered title, **hair-thin coral rule** under header.
- Thought process: plain serif text, NO box. Summary: SF-icon timeline (clock/magnifier gold/wrench teal),
  thin connector line, trailing chevron, tap-to-expand Input/Output `pre` blocks.
- Tool I/O sheet: same glass, wrench header (no 🔧 emoji).

## 8. Ask card (question card)
- Same glossy glass card. Header: `‹ ১ / ৩ ›` pagination (tabular) + circular ✕.
- ✕ collapses to a small reopen chip ("প্রশ্ন কার্ড · Nটি"); tap reopens.
- Page change = iOS spring slide (direction-aware). Options: number in 26pt frosted circle
  (selected = coral fill + ✓), serif question, pencil "Type your answer…" row + inline field.
- Answered → auto-advance to next pending card.

## 9. Pending tasks ("N কাজ বাকি")
- Chat shows ONLY a small collapsed glossy chip (ping dot + "১টা কাজ বাকি ›") at the last reply.
- Tap → glossy bottom sheet: title + age, **3 actions always: অনুমোদন · বাতিল · আমার মত**
  (আমার মত → textarea + coral send; agent then self-corrects from the note).
- After action: sheet closes, chip becomes status ("✓ অনুমোদিত" / "✕ বাতিল" / "মতামত পাঠানো হয়েছে").
- **Rule (everywhere, forever): every approval ask = 3 buttons, never 2.** Confirm cards included.

## 10. Copy-to-paste box
- Whenever the agent produces post/caption/copyable text: separate glossy box —
  coral tag "কপি করার জন্য · <type>" + coral "কপি করুন" pill (→ "✓ কপি হয়েছে" 1.8s), serif body.

## 11. Scroll-to-bottom
- Frosted glossy circle (42pt, down arrow) floating centered above the composer when >140pt from bottom;
  tap = smooth scroll to bottom. (Web parity.)

## 12. Kept ALMA theme
- Aurora bg, coral #E07A5F user bubbles, Bangla UI + digits, composer glass + model pill,
  token footer, "Sir" address. P0: prose never vanishes at stream end.
