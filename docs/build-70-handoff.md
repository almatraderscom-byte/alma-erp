# Build 70 handoff — branch `claude/ios-build-69-missing-features-p9ahy8`

For the Mac Claude session: this branch batches ALL build-69 fixes. **Self-verify
everything below in the simulator / Chrome first (CLAUDE.md rules), fix what you
find on THIS branch, then get the owner's explicit confirmation before any
TestFlight upload.** Run `bash scripts/ios-build-preflight.sh` before archiving.

## What this branch contains (verify each)

Server (deploys with the Vercel preview; VPS worker needs `git pull` + pm2 restart):

1. **Turn survives app close** — `src/app/api/assistant/chat/route.ts`: enqueue
   guarded against canceled streams. Verify: start a long agent task in the sim,
   kill the app, reopen after ~1 min → work continued/finished, NO restart.
2. **No double-runs** — `turn-queue.ts` attempts:1; `worker/src/index.mjs`
   lockDuration 30m + maxStalledCount:0 + terminal-status pre-check;
   `/api/assistant/turn` cancels any running turn on the conversation first.
   Verify: a finished long task never re-runs the research by itself.
3. **Ghost turns self-heal** — `turn-status.ts`: 'running' >30 min → 'error'
   (resume spinner can't hang forever).

Native (`ios/App/App/AssistantSwiftUI.swift` — needs sim build):

4. **Scroll-down arrow** — visibility uses measured viewport, not UIScreen.
   Verify: scroll up a bit in a long chat → frosted arrow appears above composer.
5. **Live token line** — pinned "কাজ করছি… · ~N টোকেন · N ধাপ" while streaming;
   settles into the real ↑/↓ counts row.
6. **Per-step thought headlines** — each step's row = latest thought step,
   advancing live; no repeated first-thought text across steps.
7. **Glyph-only shimmer** (approved demo) — on the LIVE process row the icon +
   headline + chevron shimmer inside the glyphs only; no rectangle/card/glow
   behind the row; settled rows static; Reduce Motion → static.
8. **Long-press copy** — agent prose, full reply, and user bubbles →
   context menu "কপি করুন" + haptic.

Round 2 (2026-07-12, commit d188323):

9. **Opinion on cron approval cards** — on a pending "Dispatch tasks" card
   (evening cron, no chat behind it), submit an opinion → NO "ইতিমধ্যে সম্পন্ন"
   error; the head revises the same card (stays pending) and replies what
   changed. Server-side — verify on the Vercel preview.
10. **Ask-card answer binding** — tap a card option mid-long-conversation →
    the head's next turn acts on THAT option (thought should reference it),
    never the other one. Server-side.
11. **Dashboard "আমার টুডু" scope** — native widget + web bar show ONLY the
    owner's own todos + today's owner_action items; agent duties (ব্রিফিং,
    স্ট্র্যাটেজি পাস, কস্ট রিকনসাইল…) gone; count drops accordingly. Native
    part needs the sim build; web part visible on the preview.

## Ship gate

- `swiftc -typecheck` / sim build green, screenshots of 4–8 captured.
- `npx tsc --noEmit` + `npm run build` green (already verified once on 2026-07-12).
- `bash scripts/ios-build-preflight.sh` passes (merge to main first — TestFlight
  ships from main; bump CURRENT_PROJECT_VERSION to 70 as a COMMIT).
- Owner's explicit "go" AFTER seeing the verification screenshots. No exceptions.
