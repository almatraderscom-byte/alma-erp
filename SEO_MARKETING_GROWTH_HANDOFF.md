# SEO + Digital Marketing Growth — Handoff for Next Session

**Written:** 2026-07-01 · **For:** the next session's agent (Claude), to implement features **1→8** one at a time.
**Owner:** Maruf (Sir/Boss) — non-engineer, communicate in **Bangla**.

> Boss, এই ফাইলটা পরের সেশনের এজেন্টের জন্য। ওকে বলবেন *"SEO_MARKETING_GROWTH_HANDOFF.md পড়ে ১ থেকে শুরু করো"* — ও এখান থেকেই ধাপে ধাপে কাজ করবে, প্রতিটা ধাপ শেষে নিজে লাইভ verify করে proof এনে তবেই পরেরটায় যাবে।

---

## 0. Where we are now (context — do not redo)

- This session **merged `agent-growth-autopilot` → `main`** (PR #168) and **production deployed green**. Two fixes shipped: (a) card-detection rule in `src/agent/lib/claim-verifier.ts` + `core.ts` verify loop; (b) native liquid-glass approval card + tool-I/O sheet in `src/app/globals.css` / `AgentConfirmCard.tsx` / `AgentThread.tsx`.
- Growth Autopilot **G1–G7** already exist (SEO keyword/rank tracking, content calendar, ads, competitor intel, autopilot master switch). 3 additive migrations (`agent_content_calendar`, `agent_growth_metric`, `agent_tracked_keyword`/`agent_keyword_rank`) are live.
- A **5-sub-agent audit** produced the gap list below. These 8 items are the agreed next work.

**The app model (important):** the iPhone/Android app loads the **live production site** (`alma-erp-six.vercel.app`) inside a WKWebView (`capacitor.config.ts` — no bundle embedded). So **web changes need NO app rebuild** — reopening the app shows them. Rebuild only for native-shell changes (`mobile/www`, `capacitor.config.ts`, iOS/Android native).

---

## 1. HARD RULES (read before writing any code)

These come from `CLAUDE.md` + owner memory. Follow exactly.

1. **ONE STEP AT A TIME.** Finish feature N *completely* (code → build → migrate → live proof) before starting N+1. Never batch multiple features into one push.
2. **LIVE PROOF BEFORE "DONE" (never skip).** After each feature: typecheck + build pass, then push the branch, then **exercise the feature live in the owner's Chrome (Chrome MCP) on the Vercel preview** and capture a **screenshot — light AND dark theme**. Build passing is NOT proof. No screenshot of the working feature = not done. Only after proof, move to the next feature.
3. **Never touch live ERP code** outside agent scope. Agent code lives ONLY in `src/agent/`, `src/app/agent/`, `src/app/api/assistant/`. Never touch `/api/agent/*` (Hermes bot depends on it). ERP must never import from `src/agent/`.
4. **Every write/spend action is approval-gated.** New tools that change the website, post, spend money, or submit forms MUST create a pending action → confirm card (mirror `draft_seo_fixes` → `seo_fix_batch` and the ads tools). Nothing auto-executes.
5. **Additive migrations only.** New `agent_*` tables/columns; never ALTER/DROP existing ERP tables. The Vercel build auto-applies migrations via `scripts/migrate-on-deploy.mjs` over `DIRECT_URL` — no manual pre-apply, no old deploy-gate (see `docs`/memory `project_migration_deploy`).
6. **No secrets in git.** `.env.example` placeholders only. New integrations → add the key name to `.env.example`, tell the owner to set the real value in Vercel.
7. **Branch + tag per feature** (e.g. `growth-seo-1-gsc`). Owner has authorized Claude to **merge agent work to main after a green Vercel build** and to **act as owner on decisions** (pick the best option, don't block). But: **OAuth consent, entering any credentials, installing anything, and physical device steps are the owner's** — the agent sets up the integration and asks the owner to authorize.
8. **Bangla, plain language, address owner as Sir/Boss.** Islamic guardrails (no haram products/imagery). Money = whole-taka via `roundMoney` (`src/lib/money.ts`), never raw floats.

**Per-feature Definition of Done checklist:**
- [ ] Code in agent scope only; write/spend actions approval-gated
- [ ] `npx tsc --noEmit` = 0 and `npm run build` = 0
- [ ] Additive migration (if any) written; env keys added to `.env.example`
- [ ] Branch pushed; Vercel preview deploy green
- [ ] **Live Chrome-MCP screenshot proof on the preview — light + dark**
- [ ] Short Bangla report to owner; then (only then) next feature

---

## 2. THE 8 FEATURES (build in this order)

Ordered by impact-for-effort. Items 1–5 are mostly free + easy; 6–8 are medium.

### Feature 1 — Google Search Console (GSC) integration  *(HIGH · easy · FREE)*
- **Goal:** Pull *real* search data for almatraders.com — impressions, clicks, avg position, top queries, indexing/coverage — instead of scraped Oxylabs guesses. Feeds the SEO specialist sub-agent for closed-loop audits and cuts Oxylabs credit spend.
- **How:** Google Search Console API (Webmasters). Needs **Google OAuth** — the **owner** does the consent screen (agent cannot enter Google credentials). Store refresh token like other integrations.
- **New tools (suggest):** `get_search_console_performance` (query/page/position over date range), `get_indexing_status`.
- **Env:** `GSC_CLIENT_ID`, `GSC_CLIENT_SECRET`, `GSC_REFRESH_TOKEN` (add to `.env.example`). Reuse the existing Google OAuth pattern if one exists (`GOOGLE_DRIVE_CLIENT_ID/SECRET` are already in `.env.example` — check `src/lib/` for a reusable Google auth helper first).
- **Read-only** → no confirm card needed. **Verify:** run the tool live, show real GSC numbers in a screenshot.

### Feature 2 — Product Schema / JSON-LD generation + write  *(HIGH · easy)*
- **Goal:** Generate valid `Product` schema.org JSON-LD (name, image, description, offers/price, availability, brand) and write it to each product page — the single biggest e-commerce SERP win (rich results).
- **Where:** website Supabase write path already exists — `src/lib/website/write.service.ts:107` (`updateWebsiteProductFields`) + approval route `src/app/api/assistant/actions/[id]/approve/route.ts:424`. Extend the writable field set to include a `structured_data`/`json_ld` field (confirm the storefront `products` schema can hold it; if not, coordinate with owner on the storefront side).
- **New tool:** `draft_product_schema` → pending action → on approve, writes JSON-LD.
- **Approval-gated** (it changes the live site). **Verify:** approve a draft, then load the product page live and show the JSON-LD present (view-source or Rich Results check).

### Feature 3 — Expand writable on-page SEO fields  *(HIGH · easy)*
- **Goal:** Today only `shortDescription` (meta) + `description` are writable (`seo-tools.ts:203` excludes the rest). `audit_product_seo` already *detects* alt-text/title/slug problems but can't fix them. Add **image alt-text**, **title/name**, and **slug** to the writable SEO batch.
- **Where:** `src/agent/tools/seo-tools.ts` (`draft_seo_fixes`), `src/lib/website/write.service.ts`, approval route (same as Feature 2).
- **Caution:** slug changes need a **redirect** (301 old→new) to avoid breaking links/SEO — coordinate the redirect mechanism with the owner before enabling slug writes.
- **Approval-gated.** **Verify:** approve an alt-text + title fix, load the product live, show the updated alt/title.

### Feature 4 — sitemap.xml + robots.txt + IndexNow  *(HIGH · easy)*
- **Goal:** Auto-generated `sitemap.xml` and `robots.txt`, plus **IndexNow** ping so new/updated products get indexed by Google/Bing fast.
- **Where:** these are storefront concerns (almatraders.com), NOT the ERP app. Decide with owner: add `sitemap.xml`/`robots.txt` routes on the storefront, and an agent tool `submit_to_indexnow` that pings the IndexNow API when products change. If the storefront is a separate codebase, the agent may only be able to do the IndexNow ping + verify the sitemap exists.
- **Env:** `INDEXNOW_KEY` (add to `.env.example`).
- **Verify:** hit the live sitemap URL and show it lists products; show a successful IndexNow submission response.

### Feature 5 — Google Analytics 4 (GA4)  *(HIGH · easy · FREE)*
- **Goal:** Read traffic, conversions, and source/attribution so the agent can tell *which* marketing actually drives sales (marketing ROI is blind today).
- **How:** GA4 Data API. Same **Google OAuth** the owner authorizes (reuse Feature 1's Google auth).
- **New tool:** `get_ga4_report` (sessions, source/medium, conversions, revenue over a date range).
- **Env:** `GA4_PROPERTY_ID` (+ shared Google OAuth). **Read-only** → no confirm card. **Verify:** live tool run showing real GA4 numbers in a screenshot.

### Feature 6 — Email / SMS marketing campaign channel  *(MED)*
- **Goal:** Owned-audience retention — send campaigns to the customer list. None exists today (Resend is transactional only, Twilio is escalation calls only).
- **How:** pick a provider with owner — Email (Mailchimp/Resend broadcast) and/or a **BD SMS gateway** (e.g. the SMS provider already used in ERP — check `src/app/settings/sms`). Build audience segmentation from ERP customer data (read-only from ERP shared libs, do not modify ERP).
- **New tools:** `draft_marketing_campaign` (segment + message) → pending action → on approve, sends. **Strictly approval-gated** (sends to real customers).
- **Env:** provider keys (add to `.env.example`). **Verify:** send a test campaign to the owner's own number/email only, show it arrived.

### Feature 7 — Google Business Profile (GBP)  *(MED)*
- **Goal:** Local Dhaka discovery — manage the Business Profile, read/reply to reviews, post updates. High value for a BD retail brand.
- **How:** Google Business Profile API (same Google OAuth). Review-reply and posts are **approval-gated** (public-facing).
- **New tools:** `get_gbp_reviews`, `draft_gbp_reply`, `draft_gbp_post`. **Verify:** show reviews pulled live; approve a reply and show it posted (on the owner's own profile).

### Feature 8 — Enforce extension final-submit ban IN CODE  *(MED · safety)*
- **Goal:** Today the extension's "don't press the final Send/Post/Pay/Publish/Confirm/Delete button" rule is **prompt-instruction only** (`INSTALL-bn.md` L52-54) — NOT enforced in code. `live_browser_act` executes all write verbs directly.
- **Where:** `extension/alma-companion/background.js` (the `click` action / `ALLOWED_ACTIONS`) and `src/agent/tools/live-browser-tools.ts`. Detect final-submit buttons (text match on Send/Post/Pay/Buy/Confirm/Delete/Publish + submit-type) and **require an explicit owner confirm** (or hard-block) before that click — mirror the Playwright `run_browser_task` pending-action gate (`src/agent/lib/browser/actions.ts:131-156`).
- **Note:** changing `extension/` files means the owner must **reload the unpacked extension** in `chrome://extensions` (a physical step). Flag this to the owner.
- **Verify:** live-drive the extension to a form with a Send button, show the agent stops and asks for confirm instead of clicking.

---

## 3. Key files & facts the audit already found (so you don't re-discover)

**SEO / website:**
- On-page audit: `src/agent/tools/seo-tools.ts` — `audit_product_seo` (~L14-48), `draft_seo_fixes` (~L195, excludes non-meta fields at ~L203), `research_seo_keywords` (~L119).
- Website write path (LIVE site): `src/lib/website/write.service.ts:107` (`updateWebsiteProductFields`) ← `src/app/api/assistant/actions/[id]/approve/route.ts:424-442`. Gated by `websiteSupabaseConfigured()`; separate **website Supabase** project (`WEBSITE_SUPABASE_URL` / `WEBSITE_SUPABASE_SERVICE_ROLE_KEY`), NOT the ERP Postgres.
- Rank tracking: cron `src/app/api/cron/growth-rank-tracker/route.ts` (weekly, `vercel.json` `0 5 * * 6`), storage `agent_tracked_keyword` / `agent_keyword_rank`, max 15 keywords (`src/agent/lib/growth/settings.ts:16`), toggle via `configure_growth_autopilot` (`growth-tools.ts:380`, default OFF).
- SERP data source: `src/lib/oxylabs/client.ts:125` (`oxylabsSerpSearch`), key `OXYLABS_API_KEY` (`.env.example:53`), spend-gated via `confirm_oxylabs_spend`.

**Marketing:**
- Facebook: `src/agent/lib/meta.ts` (`createPagePost`, messenger, comments). Tokens `FB_PAGE_TOKEN_LIFESTYLE` / `FB_PAGE_TOKEN_ONLINESHOP`.
- Ads (real management, all created PAUSED, approval-gated): `src/agent/lib/meta-ads.ts` + `src/agent/tools/ads-tools.ts` (`launch_campaign`, `update_campaign_budget`, `pause_campaign`, `duplicate_campaign`); audiences `meta-audiences.ts`. Env `META_ADS_TOKEN`, `META_AD_ACCOUNT_ID`, scope `ads_management`.
- Ad Library (competitor creatives): `meta-ad-library.ts` (`research_competitor_creatives`), scope `ads_read`.
- Instagram (publish-only): `meta-instagram.ts` (`publishInstagramImage`).
- Content: `content-engine-tools.ts` (Nano Banana image gen, `GEMINI_API_KEY`), calendar publish `src/agent/lib/growth/publish.ts` + cron `/api/cron/growth-publish`.
- Competitor: `src/agent/tools/research-tools.ts` (`research_competitor`, `read_competitor_poster`, `manage_competitor_watchlist`).

**Live-browser extension:**
- Extension: `extension/alma-companion/background.js` (`ALLOWED_ACTIONS` ~L31-48: navigate/read_text/read_dom/click/type/press/select_option/hover/scroll/screenshot/go_back/switch_tab/close_tab), `manifest.json` (`<all_urls>`). v0.3.3.
- Tools: `src/agent/tools/live-browser-tools.ts` (`live_browser_pair/look/act/status`, free-form, uses **vision + DOM**). Pairing/token: `src/agent/lib/live-browser/companion.ts` (`PAIRING_CODE_TTL_MS=10min` for the one-time code; the resulting **token is lifetime until unpaired**).
- Separate Playwright VPS path (approval-gated, blind): `src/agent/lib/browser/actions.ts:131-156`, recipes `src/agent/lib/browser/recipes.ts:63-144` (only 6 read-only recipes, none marketing).

**Integration status (what's MISSING — these 8 close it):** Google Search Console, GA4, Google Business Profile, sitemap/IndexNow, product JSON-LD, email/SMS campaigns, extra writable SEO fields, code-level extension submit-gate. Present already: Oxylabs, Meta Graph (FB/IG/Ads/Ad-Library), website Supabase, Gemini, Telegram, Twilio, Whisper/TTS.

---

## 4. Environment keys to add (owner sets real values in Vercel)

Add these NAMES to `.env.example` as you build each feature; ask the owner to fill them in Vercel:
- Feature 1/5/7 (shared Google OAuth): `GSC_CLIENT_ID`, `GSC_CLIENT_SECRET`, `GSC_REFRESH_TOKEN`, `GA4_PROPERTY_ID`, (GBP uses the same OAuth). Check for a reusable Google auth helper first (`GOOGLE_DRIVE_CLIENT_ID/SECRET` already exist).
- Feature 4: `INDEXNOW_KEY`.
- Feature 6: chosen email/SMS provider keys.

**OAuth caveat:** GSC/GA4/GBP all need a one-time Google consent the **owner** performs — the agent builds the flow and hands the owner the authorize link; the agent never types Google credentials.

---

## 5. How to start the next session

1. Read this file + `CLAUDE.md` + memory (`~/.claude/.../memory/MEMORY.md`).
2. Confirm `main` is green and current; branch `growth-seo-1-gsc` off main.
3. Build **Feature 1** only → typecheck + build → push → **live Chrome-MCP proof (light+dark) on the preview** → short Bangla report → owner ok → merge (green build) → next feature.
4. Repeat for 2→8, strictly one at a time, proof each.

Boss-এর জন্য: প্রতিটা ধাপ শেষে এজেন্ট নিজে লাইভ দেখিয়ে (screenshot) তবেই পরেরটায় যাবে — একসাথে গাদা করে করবে না।
