# ALMA Agent — Autonomy Roadmap

> Goal (owner's words): the agent runs my whole life — business + personal — easily and
> autonomously. Top priority: **marketing + design that the AI does end-to-end by itself.**
> One clean phase per session. Nothing here touches live ERP order/finance code without a
> gate. Build on a branch → owner tests preview → merge.

---

## 0. Honest diagnosis — why "marketing/design does it all" isn't happening yet

This is **not** a failure of effort. The code shows two real, separate reasons:

1. **It's gated by design — it never auto-publishes.**
   `content-engine-run` literally says *"runs pipeline to Gate 1 (never publishes)."*
   There is **no auto-publish path anywhere** in the content engine. So the AI prepares
   the post and **stops to ask you** — every time. That's a safety choice, not a bug. The
   "let it post by itself" dial simply hasn't been built.

2. **The genuinely hard part: design quality.**
   There's already a Designer QC gate (vision rubric, pass/fail, bounded regenerate,
   `qc-gate.ts`). When the image model (gemini-3 image / Nano Banana) can't hit the bar,
   it regenerates up to a limit, then keeps the **"best effort, flagged"** result — and you
   step in to fix it. Getting an image model to produce **consistently on-brand,
   publish-ready** creatives with **Bangla text** and no human is the unsolved frontier
   problem the entire industry is stuck on. You hit the real wall, not a wall you made.

**So the fix is not "build more generation." It's two things:**
- **Shrink the surface where the AI can go wrong** (template-locked design, not free design).
- **Add a graduated autonomy dial** so the safest things publish themselves and only the
  risky ones wait for you.

---

## Phase M1 — Design quality you can trust (HIGHEST PRIORITY)

**Problem:** free-form AI poster design fails too often; Bangla text + brand consistency break.
**Idea:** stop asking the AI to *design*. Ask it to *fill brand-locked templates*.

- Build a small set of **brand-locked templates** (product card, price drop, new arrival,
  festival/Eid post) using the available **Canva/Express brand-template tools**
  (`create-design-from-brand-template`, `search-brand-templates`, `export_html_to_express`).
- AI only fills slots: product photo, headline, price, CTA — fonts/layout/colours are locked.
- Standardise the **input photo** first (`image_remove_background` → clean white/brand bg)
  so QC stops failing on messy product shots.
- Keep Bangla headline text as **real text in the template**, not baked into the AI image
  (this kills the garbled-Bangla-in-image problem).
- **Result:** QC pass-rate jumps, regenerate loops drop, output is publish-ready.

**Acceptance:** 8/10 generated posts pass QC on first attempt with no owner edit.

---

## Phase M2 — The autonomy dial + graduated auto-publish

**Problem:** everything waits at Gate 1 for your tap.
**Idea:** a per-format **trust level** setting (no redeploy — store in `agent_kv_settings`).

- Levels per content type: `ask` → `propose` → `auto`.
- Start by letting only the **safest format auto-publish** (e.g. a brand-template product+price
  card to Facebook) **after** it clears a high QC bar — everything else stays gated.
- Hard caps: max posts/day, no auto-publish of festival/sensitive themes, Islamic guardrails
  stay enforced, every auto-post logged + a Telegram "I posted this" notice (reversible).
- Marketing *decisions* (you already have `pause_campaign`, `update_campaign_budget`,
  `recommend_ad_actions`, ads-optimizer): auto-pause clearly-failing ads; **ask** before
  scaling spend. Money-up = always gated.

**Acceptance:** owner can flip one product type to `auto` and posts go live safely, logged,
with an undo.

---

## Phase M3 — Taste learning loop (compounding quality)

- Every approve / edit / reject feeds back into `taste-distill` + `learning/`.
- Over weeks the generator learns *your* taste → fewer rejects → more can move to `auto`.
- This is what turns M2's dial from "one safe format" into "most formats."

---

## Phase L1 — Email + Calendar (personal-life base)

- Connect Gmail (`almatraders.com@gmail.com`) + Google Calendar (read/triage/draft/propose).
- Agent maps every email/event to a task; drafts replies, books/blocks time, protects
  prayer + family slots. Sending/accepting stays **approval-gated** at first.
- This is the "ambient chief-of-staff" base — your ~90 background triggers already form the
  skeleton; this gives them eyes on your real comms.

---

## Phase B1 — Computer-use for the no-API world (Bangladesh moat)

- Courier portals (Pathao/Steadfast), bKash/Nagad merchant, Daraz Seller Center have **no
  clean API** but have web dashboards.
- Give the agent **computer-use / browser control** to operate them: book courier, check
  payout, update a listing. Every action gated + logged at first.
- Highest-value capability unique to a BD business — worth more than 50 read-only tools.

---

## Phase O1 — Order write-actions + procedural memory

- Add gated order actions: update status, attach tracking, edit, cancel, refund
  (each = propose → confirm card → act → self-verify; money/irreversible stay on Claude + owner).
- **Procedural memory:** after the agent does a multi-step job well, save the *workflow* as a
  reusable SOP (`plan-driver` + `playbook-tools`) and replay it — gets faster and more
  independent over time.

---

## External tools worth adding (cherry-picked, not the whole "mega-list")

The api-mega-list repo is mostly an Apify affiliate funnel — skip 90%. Genuinely useful,
added directly as MCP servers (no affiliate needed):

- **Firecrawl / Exa** — stronger web research than current `web_research`.
- **Doc-to-Markdown MCP** — ingest supplier PDFs/invoices into the agent.
- **Financial Datasets MCP** — real stock data for ALMA Trading / CDIT.
- (Optional) Apify ecommerce scraper — competitor price/trend data that has no BD API.

---

## Build order (recommended)

**M1 (design quality) → M2 (autonomy dial) → M3 (taste loop) → L1 (email/calendar) →
B1 (courier/bKash/Daraz computer-use) → O1 (order actions + procedural memory).**

Rationale: M1+M2+M3 directly fix the owner's #1 pain (marketing/design self-running). L1
unlocks personal-life autonomy. B1 is the BD moat. O1 closes the business loop.

**Safety rule for every phase:** confirm-gated + audit-logged + spend-capped, Opus escalation
for big-money calls, Islamic guardrails enforced, owner approves merge after preview.
