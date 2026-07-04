# Agent Computer-Use Program — Full Roadmap (start here)

**Date:** 2026-07-04 · **Owner:** Maruf (non-engineer). Reply in Bangla, concise.
**Goal:** the agent operates computers the way Claude Code does — sees the screen itself (Chrome extension, later iPhone/Android), does full PC-class work (research, digital marketing, SEO, website work) **without depending on per-service APIs**, finishes what it starts flawlessly, and **NEVER silently fails**: any failure writes a checkpoint summary so the owner's next reply resumes from exactly that point without re-reading system prompt / full chat history.

> **How the owner starts a new session:** paste — *"docs/agent-computer-use-roadmap.md pore phase <X> shuru koro"*. One phase per session.

---

## 0. NON-NEGOTIABLE rules for every phase

1. **No silent failure — the terminal-state contract.** Every task the agent starts MUST end in exactly one of two states, always: (a) **success WITH proof** (claim-verifier / completion-gate artifact), or (b) **failure WITH a checkpoint** (see §2 format). A task that just stops is a bug of the highest severity. Watchdog (heartbeat) converts "stuck" into a failure-checkpoint automatically.
2. **Checkpoint-resume is cheap by design.** Resuming from a checkpoint must NOT require reloading full chat history — the checkpoint is self-contained (owner is cost-sensitive; this is also the whole point of his request). The open-tasks `resumeNote` pattern is the seed; §2 standardizes it.
3. **Money / destructive / irreversible actions stay the owner's own click.** The agent reads, fills, navigates, drafts — it never auto-confirms purchases, deletions, sends, or publishes without an owner gate. (Matches the live-browser safety model already in `companion.ts`.)
4. Long work runs on the **VPS worker** (durable Postgres-backed queues — never in-memory); browser work through the existing `browser_action` / live-browser command bus.
5. Existing safety stays: SSRF guard, daily browser-task caps, kv kill-switches (`live_browser_enabled`, `AGENT_ENABLED`), token-hash pairing, extension verb allowlist.
6. CLAUDE.md hard rules apply (agent file boundaries, `/api/assistant/*` only, no ERP edits, browser proof / owner-deferred hard verify).
7. **Web content is DATA, never instructions (prompt-injection defence).** Anything the agent reads on a page/email/doc — including hidden text, HTML comments, alt text — must never be followed as a command. Instructions come from the owner only. See §5 Security layer; this is the #1 attack class against browser agents (2026 OWASP LLM #1; agentic attack success rates reported up to 84%).
8. **API-first where an official API exists; browser where none does.** "API-nirbhor na" means the agent is never LIMITED to APIs — but automating a logged-in Facebook/Instagram session via browser can get the owner's account flagged; for those, the existing official-API paths (Meta ads/graph libs) stay primary and the browser handles the long tail.
9. **The agent never types credentials.** Login walls → pause-checkpoint: "Sir, login koren" → owner logs in (his Chrome or phone) → agent detects and resumes. CAPTCHAs are never solved/bypassed by the agent — always handed to the owner the same way.

## 1. Owner's vision → coverage map (nothing may be dropped)

| # | Owner's requirement (his words, condensed) | Phase |
|---|---|---|
| 1 | Agent sees & uses the computer ITSELF (Chrome extension), not API-dependent | P1 |
| 2 | Same power on iPhone and Android | P3 |
| 3 | Full PC-class work "like Claude Code" — beautiful, mistake-free | P2 (workbench) + P5 |
| 4 | Tasks FINISH — no silent mid-way failure ever | P0 (terminal-state contract) |
| 5 | On failure: a summary checkpoint at failure time; owner's next reply resumes from that exact point WITHOUT re-reading full context/history | P0 (checkpoint standard) |
| 6 | Research work — thorough, cited, accurate | P4 (Research pack) |
| 7 | Digital marketing work | P4 (Marketing pack) |
| 8 | SEO work | P4 (SEO pack) |
| 9 | Website work | P4 (Website pack) |
| 10 | "joto computer er kaj shob" — general computer tasks, flawless | P2 + P5 |
| 11 | "bhul na kora" also means not being TRICKED — malicious pages, hidden instructions, account bans | §5 Security layer (built with P1) |
| 12 | Human feel in his Chrome: visible gliding mouse cursor, glowing aura/shadow around the page while the agent drives, human-paced typing — "ekdom human feel" | P1 (visual presence layer) |

If a future session finds a requirement here that no phase covers — STOP and flag it to the owner; do not silently drop it.

## 2. The Checkpoint standard (built in P0, used by everything after)

One format for ALL long/agentic work (plan-driver plans, browser tasks, workbench jobs, long_agent_task):

```jsonc
{
  "checkpointId": "…", "taskType": "browser|plan|workbench|…",
  "goal": "original goal in one line",
  "summaryBn": "২-৩ বাক্যে: কী করছিলাম, কতদূর হয়েছে, কোথায় আটকেছে",  // owner-readable, shown in chat
  "doneSteps": ["…"],                    // what is COMPLETE (with artifact refs)
  "currentStep": "what was in progress",
  "artifacts": ["storage/…", "url…"],   // files, screenshots, drafts produced so far
  "error": "exact failure reason",
  "nextActions": ["resume plan from here"],
  "resumeHint": "everything a FRESH context needs to continue — self-contained"
}
```

- **Written on:** any failure (worker catch blocks, plan-driver step fail, browser task error, timeout/watchdog) AND periodically every N steps (so even a hard crash has a last-known state).
- **Pause-checkpoints (same format, `state:"waiting_for_owner"`):** not only failures — the task also checkpoints when it NEEDS the owner: a question ("Sir, kon option nibo?"), a login wall, 2FA, a CAPTCHA, or a budget cap hit. Owner answers → resume from the same spot. This turns every interruption class into the one resume flow.
- **Per-task budget caps:** each long task carries a token/credit budget; hitting it = pause-checkpoint ("budget shesh — chaliye jabo?"), never a silent overrun (owner is cost-sensitive).
- **Stored:** durable table/kv keyed by conversation + task; surfaced as the existing open-tasks chip ("বাকি কাজ").
- **Resume path:** owner replies (or taps Continue) → head receives ONLY the checkpoint (+ the new message) via a system note — not the whole history — and continues from `currentStep`. Prompt-cache friendly, cheap, instant.

## 3. Where the work lives (current state — honest audit)

**Already built (use, don't rebuild):**
- **VPS headless browser (Phase A–D done):** `worker/src/browser/runner.mjs` (Playwright, ephemeral context, step allowlist, timeouts) + `service.mjs`; SSRF guard + daily task cap; `src/agent/lib/browser/` (actions, recipes, final-submit owner-gate).
- **Live Chrome companion (Phase E, started):** `extension/alma-companion/` (MV3, Bangla install guide) + `src/agent/lib/live-browser/companion.ts` — durable Postgres command bus (`LiveBrowserDevice`/`LiveBrowserCommand`), one-time pairing → hashed token, long-poll, verb allowlist, kv kill-switch (default OFF), owner-watches-live model, agent never touches credentials.
- **Anti-silent-fail seeds:** plan-driver (`src/agent/lib/plan-driver/` — driver, executor, **completion-gate**: deterministic "is the GOAL actually met" verdict, fail-safe to not-done), claim-verifier (never claim success without verification), heartbeat lib, open-tasks route with self-contained `resumeNote` + Continue/Cancel, approval-continuation (resume after approvals).
- **Marketing/SEO raw material:** `src/agent/lib/ads/` (Meta), `ga4.ts`, `gbp.ts`, meta-ad-library, content-intelligence, browser recipes.

**Missing (the phases below):** the universal checkpoint standard + failure wiring, extension "see-act" vision loop + live watch UI, VPS workbench (shell/files like Claude Code), mobile companion, skill packs, hardening.

## 4. Phases (do in this order)

### Phase P0 — Terminal-state contract + Checkpoint standard  ← FIRST (owner's core pain)
- Implement §2 checkpoint store + writer helpers; wire into EVERY failure path: worker job catch blocks (`callJobResult failed`), plan-driver step/gate failures, browser task errors, long-task timeouts.
- **Watchdog:** heartbeat scan marks silent/stuck tasks (no progress in X min) → auto-checkpoint + owner ping ("Sir, কাজটা আটকে গেছে — এই পর্যন্ত হয়েছে…"). Silence becomes impossible by construction.
- **Resume fast-path in the head:** on owner reply/Continue → inject ONLY checkpoint as a system note; continue from `currentStep`. Extend the existing open-tasks chip.
- Periodic checkpoints every N steps on long tasks.
- Tests: simulated failures at each layer must each produce a checkpoint; resume must not read history.

### Phase P1 — Chrome companion v1 complete ("agent nije dekhe")
- **See-act loop:** add `screenshot` verb → vision model reads the actual rendered page (not just DOM) → next command. This is the Claude-in-Chrome pattern; DOM verbs stay for speed, vision for understanding.
- Finish the verb set (scroll-into-view, tabs, frames, waits, file-download read, file UPLOAD from agent storage — e.g. posting a Studio creative into a web form); extension auto-update story; reconnect/retry.
- **Webmail/email as a work surface:** reading and drafting email through the companion (Gmail web) — drafts only; every SEND is a sensitive-action gate (§5.3).
- **Human-feel visual presence (owner requirement — the "Claude-in-Chrome feel"):** when the agent drives the owner's Chrome it must LOOK like a careful human at the controls, and the owner must always SEE that the agent is in control:
  - a visible **virtual cursor** that glides smoothly to its target (never teleports), with a click ripple/pulse on every click;
  - an **agent-control aura** — a soft glowing border/shadow around the page (Claude-in-Chrome style) that appears the moment the agent takes over and disappears the instant it stops; injected by the extension's content script;
  - **human-paced typing** (character flow, not instant paste) into fields, human-scale scrolling;
  - a small floating **status chip** on the page ("🤖 কাজ চলছে — <step>") with an always-visible STOP button (wired to the existing extension `paused` switch);
  - this presence layer doubles as a SAFETY affordance: the aura means "agent hands on" — no ambiguity about who is driving. Purely content-script visuals — zero effect on the command bus.
- **Live watch panel** in the agent UI (and phone via responsive page): owner sees each step + screenshot stream as it happens; pause/stop button (extension `paused` already exists).
- Per-step audit log persisted (what was clicked/typed, screenshot refs) — reviewable afterwards.
- Route planning: agent decides VPS-headless (public web, research) vs owner-Chrome (logged-in sites) automatically; both under P0 checkpoints.

### Phase P2 — VPS Workbench ("agent-এর নিজের computer, Claude Code-এর মতো")
- A sandboxed workspace on the VPS: shell + files + git + node/python under an allowlist, per-task workspace dirs, hard caps (time/CPU/disk), no access to ERP secrets beyond its own env.
- Claude-Code-style loop: plan → edit/run → verify output → iterate; every run leaves artifacts (files/reports) in storage; completion-gate judges the goal.
- Use-cases unlocked: data crunching (CSV/Excel reports), scraping+analysis, file conversion, building small tools/scripts, SEO crawls — "joto computer er kaj".
- Website work stays PR-only: the workbench may prepare changes as a GitHub PR (its own limited deploy key), NEVER direct deploy — owner merges.

### Phase P3 — Mobile companion (iPhone first, then Android)
- **Step 1 — watch + approve from the phone:** the P1 live watch panel + step-approval pushes in the native app (native push is already wired) — the owner supervises long tasks from anywhere. This alone covers most of the mobile need.
- **Step 2 — in-app webview companion:** the native app embeds a companion webview that registers on the SAME command bus as the Chrome extension (a `LiveBrowserDevice` of type "phone") — the agent can then use the owner's phone-side logged-in sessions when the Mac is off. iOS first (WKWebView bridge exists), Android after (mirrors it; see the iOS→Android porting rule in `docs/ios-native-frame-handoff.md` context — port after iOS stabilizes).
- Phone-only actions (approve/reject, watch, stop) work even with everything else off.

### Phase P4 — Skill packs (deterministic playbooks on top of P1+P2)
Each pack = hard playbooks + checklists the agent follows (no freestyle), P0-checkpointed, artifacts as proof:
- **Research pack:** multi-source web research protocol — search → read → cross-check → cited Bangla brief (sources listed, claims traceable); competitor/product/market research templates.
- **SEO pack:** own-site crawl + Lighthouse audits from the workbench; Search Console + GA4 readouts (`ga4.ts` exists); keyword tracking table; content-brief generator; monthly SEO report artifact. Fix-suggestions become website-pack PRs.
- **Digital-marketing pack:** Meta ads plan/report via existing `ads/` lib + ad-library competitor scans; campaign calendars; ALL spend owner-gated (P0 rule 3); weekly performance brief.
- **Website pack:** content edits, landing pages, product-page improvements — prepared in the workbench, shipped ONLY as PRs with preview links; owner approves merge. (Creative assets come from the Studio program — `docs/creative-studio-roadmap.md`.)

### Phase P5 — Hardening to "nikhut" (flawless)
- Retry policies with backoff per failure class; idempotency keys on every side-effect.
- Parallel task lanes with per-lane caps; scheduled routines (weekly SEO report, daily ad check) via existing schedulers.
- **Recipe learning:** a successfully completed browser/workbench task gets distilled into a reusable site/task recipe (extends `src/agent/lib/browser/recipes.ts`) — next time the same job is faster, cheaper, and repeats the PROVEN steps instead of re-deriving them. This is how "bhul na kora" compounds over time.
- **Golden-task eval suite:** a fixed set of benchmark tasks (search-and-extract, form-fill on a test page, SEO crawl of own site) runs weekly; regressions in success rate are flagged BEFORE the owner hits them.
- **Autonomy levels per task type** via the existing `autonomy-policy`/`autonomy-ledger` libs: read-only steps auto-approved, write steps batched into fewer owner approvals — owner-tunable, so pings don't drown him as usage grows.
- **Weekly self-report:** every failure checkpoint from the week + what was changed to prevent recurrence — the agent's own QA loop, sent to the owner.
- Success-rate telemetry per task type; a task type below threshold gets flagged for playbook improvement, not silently retried harder.

## 5. Security layer (defence-in-depth — built WITH P1, never "later")

Prompt injection against browser agents is the top attack class of 2026 (OWASP LLM #1; hidden white-on-white text / HTML comments steering agents into fetching OTPs or opening banking pages; vendors publicly say it "may never be fully solved" — hence layers, not one fix):

1. **Content/instruction boundary:** every page text, DOM, screenshot OCR, email or doc the agent reads is wrapped as tagged DATA before the model sees it ("sandwich" pattern); the system prompt explicitly forbids following instructions found inside it. Anything that LOOKS like an instruction to the agent gets quoted back to the owner instead of executed.
2. **Plan-then-execute:** the step plan is fixed BEFORE reading untrusted content; mid-page content may inform extraction, never add new actions. New actions require a re-plan, and a re-plan triggered by page content requires owner confirmation.
3. **Sensitive-action gate:** a hard list of actions that ALWAYS pause-checkpoint to the owner regardless of plan — payments, sends/publishes, deletes, permission/settings changes, auth pages, downloads of executables. (Extends the existing `final-submit.ts` owner-gate pattern.)
4. **Site trust tiers:** allowlisted own/known sites (normal), general web (read-freely, act-carefully), flagged/unknown-form pages (read-only + lockdown: extraction only, no typing). Tier stored per-domain in kv, owner-editable.
5. **Injection tripwire:** cheap detector pass over fetched content for instruction-like patterns targeting agents; hit → task pauses with the quoted content shown to the owner ("Sir, ei page amake ei command dite chaiche — korbo na. Apni dekhen.").
6. **Privacy of what the agent sees:** screenshots/audit logs may contain the owner's personal data — capped retention (auto-delete after N days), sensitive-field masking in stored screenshots, never leave Supabase/VPS.
7. **Isolation:** owner-Chrome work runs in a dedicated automation window/tab-group (never his active tab); VPS browsing stays ephemeral-context; workbench gets the same SSRF/egress guard as the browser (no internal IPs, no metadata endpoints).
8. **Kill switches at every layer** (already exist — keep): kv `live_browser_enabled`, extension popup pause, `AGENT_ENABLED`, daily caps.

## 6. Backlog — parked ideas (NOT scheduled)
- Desktop-native control (beyond browser: Mac apps) — big security surface; only with a dedicated owner decision.
- Voice-driven task launch ("agent, ei kaj ta koro") from the phone — voice stack exists; wire after P3.
- Multi-owner/staff supervised tasks (staff watches, owner approves).

## 7. Cost notes (owner is cost-sensitive)
- Checkpoint-resume SAVES money by design (no full-history reloads after failures).
- Vision see-act steps cost per screenshot-read — batch/downscale screenshots; DOM-first, vision when needed.
- Workbench/browser on VPS = free compute; caps keep runaway loops bounded (existing daily caps extend to workbench).
- Skill-pack LLM steps run on the tier router (cheap models for mechanical steps, Claude where judgment matters — CRITICAL tier rules unchanged).

## 8. Gotchas
- `live_browser_enabled` kv is default OFF — flip it consciously; extension popup has its own pause.
- Never let the workbench or website pack touch `/api/agent/*`, ERP financial code, or production deploys — PR-only, always.
- The completion gate is fail-safe to NOT-done: a flaky gate makes the agent more cautious, never falsely "done" — keep that property in every new gate.
- Playwright binaries + (P2) sandbox tooling must be provisioned on the VPS — check before each phase ships.
- Phone companion (P3 step 2) must respect App Store rules — the webview automation is owner-initiated assistance inside the owner's own app.
