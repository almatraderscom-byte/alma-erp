# "আমার সব কাজ এজেন্ট করুক, আমি শুধু approve করব"

**Status: PROPOSAL. Nothing implemented. Owner approves the shape first.**

Owner, 2026-07-27: *"ami cai agent amr shob kaj koruk, ami just approve korbo"* —
starting from the storefront (title, description, tags, everything) with a hard
approval on each change, plus anything else worth adding that he has not named.

This document is written from measurements, not assumptions. Two of the starting
assumptions turned out to be wrong, and they change the plan, so they come first.

---

## 0. Two corrections before anything is planned

**The storefront is a SEPARATE repository.** He said same repo; it is not.
`almatraderscom-byte/alma-lifestyle` is its own Next.js app — its own
`src/app` (shop, admin, api, cart, checkout, products, feed, opengraph-image),
its own `supabase/migrations`, its own Vercel project. `alma-erp` contains no
storefront code at all. Same GitHub *account*, two repos.

**The databases are also separate Supabase projects**, not one:

| | project |
|---|---|
| ERP | `nrkuzcorcpcwrkckbeoq` |
| Website | `awugvcjezittjjgfysuk` |

Both reachable from the ERP (`WEBSITE_SUPABASE_URL` + service-role key), which is
why the agent can already edit products at all. But a schema change for the
website is a migration in the OTHER repo — `alma-erp`'s prisma migrations cannot
touch it.

Neither correction blocks anything he asked for. Both change WHERE the work
lands, and pretending otherwise would produce a roadmap that fails in week two.

---

## 1. What the agent can do today, measured

Counted from `capability-classification.ts` — every registered tool, by area and
by what it is allowed to do (`read` = look only, `write` = acts, `stage` = makes
an approval card):

| Area | read | write | card |
|---|---|---|---|
| **ERP (orders, inventory, customers)** | **19** | **0** | 1 |
| **Meta Ads** | **24** | **0** | 5 |
| **Trading** | **10** | **0** | 0 |
| Website / storefront | 5 | 0 | 4 |
| Finance | 5 | 0 | 6 |
| Staff | 8 | 5 | 8 |
| Marketing | 13 | 3 | 0 |
| SEO | 6 | 2 | 2 |
| Social | 3 | 0 | 4 |

**The headline: in his three biggest areas — the ERP itself, the ad account, and
Trading — the agent can only LOOK.** It reads 53 things and changes none of
them. Every "do my work" conversation runs into that wall, whatever the mode
picker says. Storefront editing is one wall of several.

### What it can already change on the storefront

`title` (product name) · `short_description` (the meta description) ·
`description` · image `alt_text` · `price_bdt` · `category` ·
publish / unpublish / featured — each through an approval card with before→after.

### What it cannot, and why

| | why |
|---|---|
| **slug** | No tool writes it, AND there is no redirect anywhere in the storefront (`grep 301\|redirect` → nothing). Changing a slug today = the old URL 404s and its Google ranking is gone. This is why `7-b` is stuck: **its slug is literally Bangla prose** — `ইসলামিক ৭টি বইয়ের কম্বো প্যাকেজ Product Code: 7-b` — which is also why the agent keeps failing to find it |
| **tags** | The `products` table has no tags column at all |
| canonical / og: tags | Same — no column, and `opengraph-image.tsx` is storefront code |
| new product, images, variants, stock | No write path from the ERP side |

---

## 2. The shape: one approval spine, many hands

Adding write tools one by one is how a system becomes unsafe by accident. The
order below is deliberate: the spine first, then the hands.

**The spine is already half-built** — the R0–R4 risk tiers, the approval cards,
the signed payload binding, the audit ledger with one-tap undo, and (from
2026-07-27) the permission modes. What is missing for "he approves everything"
is not a new mechanism; it is *coverage* and *proof*.

### The hard-approve contract every new write obeys

1. **The card shows before → after, per field.** Never "updated 6 fields".
2. **The payload is signed and bound.** An approval approves *that* payload; any
   drift invalidates it (this exists — `capability-token.ts`).
3. **Undo is armed before the write**, not after (the autonomy ledger already
   does this for R1/R2; new writes register their inverse).
4. **A write proves itself.** Re-read the row after writing and show him the
   live value — the lesson from the SEO work: the agent's own report is never
   the evidence.
5. **R4 stays his** — money movement and permissions, in every mode, forever.

---

## 3. The roadmap

### A. Storefront — what he asked for

| | Phase | Lands in | Notes |
|---|---|---|---|
| **A1** | `storefront-editing` skill: the seven writable fields, batched, one card per batch, before→after, verified after write | alma-erp | Possible today, no schema change |
| **A2** | **tags + canonical + og** — add the columns, then the tools | **alma-lifestyle** migration, then alma-erp | Column first, tool second |
| **A3** | **slug, done safely** | both | **DONE (code)** — alma-lifestyle#84 (redirects table + resolver; migration applied to the live project), alma-erp#626 (staged rename, redirect written first), alma-erp#627 (the skill manifest had to name the tool or the head could not see it). **Not yet proven on `7-b`** — that last step needs one sentence in his chat and his approval, by design |
| **A4** | Images: upload, reorder, replace, alt in one place | both | Storage bucket rules live in the storefront repo |
| **A5** | New product end-to-end: create draft → copy → images → variants → publish, as ONE approval | both | The first "full job" a storefront skill can own |

### B. The bigger walls — not asked for, but this is where "all my work" actually lives

| | Phase | Why it matters |
|---|---|---|
| **B1** | **ERP writes**: order status, dispatch, stock adjustment, customer notes — 19 reads today, 0 writes | Every "handle this order" request dies here |
| **B2** | **Meta Ads writes**: pause/resume, budget, audience — 24 reads, 0 writes | He asks about ad spend constantly; the agent can only report |
| **B3** | **Finance**: it already stages 6 card types; the gap is a **month-close routine** that reconciles and hands him ONE approval instead of many |
| **B4** | **Trading**: 10 reads, 0 writes — the whole business is read-only to the agent |
| **B5** | **Batch approvals**: one card for a whole job, not one per item. He has been asking for this all week in different words |
| **B6** | **A standing "do it" grant** per task family, time-boxed and revocable (PM-4/PM-7 of the permission plan) — the honest version of "just do it, stop asking" |

### C. Trust — what makes the above safe enough to want

| | Phase | |
|---|---|---|
| **C1** | Every write re-read and shown live after execution (proof, not claim) |
| **C2** | One screen: what the agent did today, what it changed, undo each |
| **C3** | Override rate + response time per family — if he overrides a family constantly, that family is at the wrong autonomy rung and the number says so |
| **C4** | A weekly "here is what I would have done without asking" dry-run report, so autonomy is earned on evidence rather than on hope |

---

## 4. Suggested order, and why

1. **A3 first, despite being the hardest.** The redirect table is the one piece
   that is *dangerous by absence* — and it unblocks `7-b`, which is a live SEO
   hole today.
2. **A1** — immediate value, no schema change, and it is the first real test of a
   storefront skill.
3. **B1** — the biggest wall in daily use.
4. **B5 + B6** — the answer to "stop asking me every time", done safely.
5. **A2, A4, A5** — the rest of the storefront.
6. **C** throughout, not at the end.

---

## 4b. What A3 taught, worth carrying into every later phase

1. **A tool is invisible until EVERY allowlist names it.** `change_product_slug`
   was registered, classified, tested, on the head shortlist and in the role
   prompt — and the head still never called it, because
   `seo-fixing-own-site/manifest.json` carries its own five-tool
   `requiredCapabilities`. Its visible thinking said so outright: *"I know
   draft_seo_fixes exists because it was mentioned in my context."* Every phase
   below must update the skill manifests too, and prove it by running it once.
2. **Write order is a safety property, not a detail.** The redirect is written
   before the slug, so a half-failure leaves a harmless pointer instead of a dead
   URL. Every later write phase should ask the same question: which half, if it
   lands alone, is survivable?
3. **The two-repo split is real.** A storefront schema change is a PR in
   `alma-lifestyle` and a migration run against the website Supabase project —
   the ERP cannot apply it. A2, A4 and A5 all inherit this.

## 5. What this does NOT promise

- No mode, grant or rule will ever move money or change permissions without him.
- Slug changes ship only with redirects; never before.
- Writes land in the repo that owns the data — a storefront schema change is a
  PR in `alma-lifestyle`, not a hack from the ERP.
