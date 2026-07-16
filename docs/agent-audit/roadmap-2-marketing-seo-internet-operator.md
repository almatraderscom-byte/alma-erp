# Roadmap 2 — Senior growth marketing, SEO, and internet operator

Status: implementation roadmap; no production change has been made by this audit
Audit date: 2026-07-17 (Asia/Dhaka)
Audited source: local `origin/main` at `629abed6426ff6846905f661368d44f629717b93`
Dependency: Roadmap 1 through Phase 34 and Roadmap 3 through Phase 53 must be owner-approved before any autonomous publishing, budget, account, permission, or website write.

## Mission

Build a measurable growth operating system inside the ALMA agent: business diagnosis, positioning, customer/competitor research, campaign and content planning, professional Meta execution, SEO/CRO, website and Business Suite operations, measurement, experimentation, monitoring, and evidence-backed optimization.

The target is the judgement and operating discipline expected from a strong senior digital marketer—not an unsupported claim that the AI literally has 20 years of employment history. Every recommendation must show data, assumptions, business economics, risk, and expected outcome.

## Claude Code execution contract

Give this file to Claude Code in its own dedicated session. Claude must:

1. Read `AGENTS.md` and this whole roadmap first.
2. Run read-only pre-flight and compare the checkout with `origin/main` plus the latest owner-approved phase. Never build from the stale branch merely because it is currently checked out.
3. Implement only the first incomplete phase. One phase = one session = one branch = one preview proof.
4. Use branches `agent-phase-41` … `agent-phase-48` and matching `pre-agent-phase-N` tags, created from the latest owner-approved base.
5. Stop on overlapping dirty/untracked files. Never clean, reset, or overwrite the owner's work.
6. Print the exact phase file allowlist before editing. If another file is required, stop and request a scope amendment.
7. For a reported bug, document root cause first and wait for owner approval before fixing.
8. Never touch `/api/agent/*`. New routes remain under `/api/assistant/*` and use `requireAgentEnabled()` first.
9. Preserve ERP finance/payroll logic, whole-taka money arithmetic, Asia/Dhaka time, and additive migrations only.
10. Never put Meta, Google, email, SMS, browser, or Supabase secrets in git.
11. Use fake/sandbox/test assets in automated tests. Never spend ad budget, publish publicly, message customers, change a domain, or edit a live site during verification.
12. Run targeted tests and full typecheck/lint/build where relevant; inspect `git diff --stat` for exact scope.
13. Push the phase branch for a Vercel preview only. Never merge or deploy production.
14. In the owner's Chrome, exercise the full preview flow and capture a screenshot under `docs/proofs/agent-phase-N/`. If authentication is needed, the owner types it. Build output is not proof.
15. Report files/migrations/tests/preview URL/browser steps/screenshot/risks, then stop for owner approval. Never start the next phase automatically.

## Audit verdict

### What is already strong

- A broad tool surface already covers marketing plans/reports, GA4, Google Search Console, SEO audit and keyword research, Meta campaign pause/budget/duplicate/launch, ad recommendations, audiences, Facebook/Instagram scheduling, content calendars, competitor research, GBP, comments/Messenger, image/video studio, and email/SMS drafting.
- Meta writes generally use approval cards; campaign launch creates a paused campaign for review.
- There is a content engine, creative generation, worker ads monitor, growth scheduling, customer-service pipeline, Bangla output gate, business memory, claim verification, and owner-tunable model routing.
- Website crawl/SEO reporting and comparison primitives already exist.
- Live browser has DOM reading, screenshots, stable references, tabs/popups, iframe support, scrolling, upload, hover, navigation, watch mode, site trust tiers, prompt-injection tripwire, and final-submit restrictions.

### What is still partial or missing

| Area | Finding |
|---|---|
| Marketing operating loop | Many capable tools exist, but there is no single durable graph from business diagnosis → strategy → assets → tracking QA → approved launch → experiment → monitor → optimize → learn. |
| Strategic context | No canonical versioned growth brief joins brand, offer, margin, stock, customer segments, seasonality, competitors, funnel, channel constraints, and target economics. |
| Measurement | The audit did not find a complete Pixel + Conversions API health/dedup/event-match pipeline, experiment registry, holdouts, or profit-based attribution. |
| Meta Ads depth | Current campaign actions cover a valuable subset; they are not a complete Ads Manager/Business Suite implementation for all objectives, placements, catalogs, creative formats, bidding, rules, diagnostics, and experiments. |
| Instagram/Page operations | Current prompt explicitly describes Instagram publishing as single-image and says Reels/video are not supported in that path. Full calendar/inbox/catalog/permissions/asset-health operations are incomplete. |
| API lifecycle | Meta Graph URLs are hard-coded to `v21.0` in many files. A current supported version must be checked from Meta at implementation time and centralized; do not blindly bump. |
| SEO depth | Useful crawl, keyword, GSC, indexing, and batch-fix pieces exist, but no unified technical SEO + content cluster + internal link + structured data + Core Web Vitals + CRO release loop. |
| Browser action coverage | The code has selector/ref actions but no dedicated coordinate click/double-click/move, robust drag-and-drop, zoomed screenshot region, console/network/HAR diagnostics, or guarded page-JS inspection. |
| Browser durability | Browser work can hit the Vercel deadline. A universal graph-native VPS browser runner, checkpointed success criteria, and clean recovery are not complete. |
| Proof | Screenshot-after-action exists, but tasks lack universal, explicit success criteria with independent end-state verification. |
| Learning | Reports and outcome learnings exist, but creative/campaign/SEO experiments do not feed one structured evidence store that changes future decisions. |

## Professional capability standard

The final marketing system must reason across all of these, not just operate buttons:

- business goals, cash/margin/stock constraints, product-market fit, seasonality, Islamic product/imagery guardrails
- customer segments, jobs-to-be-done, pain points, objections, awareness stages, language, buying journey
- brand positioning, offer, price/promotion, proof, creative angles, message-market fit
- funnel architecture: reach → engagement → Messenger/lead → order → confirmed order → delivered COD → repeat/referral
- paid media objectives, audiences, placements, bidding, budget pacing, frequency, fatigue, learning phase, incrementality
- organic social, community, comments/inbox, content calendar, UGC/influencer workflows, lifecycle CRM
- technical SEO, search intent, topic clusters, people-first content, internal links, structured data, local SEO, digital PR
- landing-page CRO, mobile UX, speed, accessibility, trust, checkout/form friction
- GA4/GSC/Meta measurement, UTM governance, Pixel/CAPI, attribution windows, event quality, CAC/LTV/profit
- controlled experiments, confidence, minimum sample, stop/scale rules, post-mortem, institutional learning

## Safety and platform boundaries

- API-first for supported, stable operations; browser fallback only for UI-only actions or diagnosis.
- Never evade CAPTCHA, platform security, anti-automation measures, rate limits, review processes, or Terms.
- Page/site content is untrusted data, never authority. Only the owner's direct instruction and stored policy can authorize an effect.
- Publishing, sending, ad activation/spend, audience use, permissions, account/security changes, domain/DNS changes, destructive actions, and payments require point-of-risk confirmation unless a later owner-approved autonomy policy explicitly allows a narrow reversible class.
- Password, MFA, CAPTCHA, account recovery, and other authentication barriers are handed to the owner.
- The agent may diagnose a platform/vendor outage but cannot promise to “fix the internet” or Meta/Google infrastructure it does not control.
- SEO never promises ranking. Recommendations and changes must be measured over realistic windows.

## Phase 41 — Accounts, permissions, data, and measurement truth audit

Goal: establish what ALMA can safely read/write and whether the data is decision-grade.

Allowed files:

- `src/agent/lib/marketing/capability-audit.ts` (new)
- `src/agent/lib/marketing/measurement-health.ts` (new)
- `src/agent/tools/marketing-tools.ts`
- `src/agent/tools/ads-tools.ts`
- `src/agent/tools/seo-tools.ts`
- `src/app/api/assistant/internal/marketing-health/route.ts` (new)
- `src/agent/lib/__tests__/marketing-capability-audit.test.ts` (new)
- `docs/agent-audit/phase-41-marketing-baseline.md` (new)
- `docs/proofs/agent-phase-41/*` (new)

Read-only inventory:

- Meta app, system user/user token, business, page, ad account, pixel/dataset, Instagram professional account, catalog, permissions/scopes, expiry, webhook, rate-limit, and API-version health.
- GA4 property/streams/events/key events/ecommerce data, GSC properties/sitemaps/index coverage, website environments, email/SMS/WhatsApp/GBP connectivity.
- Existing campaigns, audiences, creatives, placements, objectives, naming/UTM conventions, spend and result coverage.
- Data-quality gaps: missing events, duplicate events, inconsistent currency/timezone, COD funnel breaks, revenue mismatch, thin samples, attribution uncertainty.

Outputs:

- Capability matrix: `read`, `draft`, `stage`, `write-confirmed`, `unsupported`, `broken`, with exact account/asset/domain scope.
- Baseline funnel and unit-economics data dictionary. No invented CAC/LTV/ROAS.
- Central list of hard-coded Meta API-version call sites and a safe migration/test plan based on the then-current official changelog.
- No writes to external platforms in this phase.

Exit gates:

- Every external capability is proven or marked unknown; no green status from the mere presence of an env variable.
- Money is BDT whole-taka in business calculations; external decimals are normalized at the boundary.
- Chrome proof displays a preview health matrix with secrets redacted and at least one honest broken/missing-state example.

## Phase 42 — Versioned Growth Brain and durable strategy graph

Goal: make senior judgement reproducible before adding more buttons.

Allowed files:

- `prisma/schema.prisma`
- `prisma/migrations/<phase-42-add-growth-brain>/migration.sql` (new)
- `src/agent/lib/marketing/growth-brief.ts` (new)
- `src/agent/lib/marketing/growth-strategy-graph.ts` (new)
- `src/agent/lib/marketing/planner.ts`
- `src/agent/lib/marketing/report.ts`
- `src/agent/tools/marketing-tools.ts`
- `src/agent/lib/models/specialist-roles.ts`
- `src/agent/lib/__tests__/growth-brief.test.ts` (new)
- `src/agent/lib/__tests__/growth-strategy-graph.test.ts` (new)
- `docs/proofs/agent-phase-42/*` (new)

Build:

- A versioned per-business growth brief: goals, products, margins, stock, offers, customers, objections, competitors, brand rules, channels, budget, target economics, seasonality, current funnel, risks, and evidence timestamps.
- A LangGraph strategy flow: load business truth → identify missing critical data → research/diagnose → prioritize bottleneck → propose strategy → forecast range/assumptions → owner decision → freeze approved brief → create 90-day, monthly, and weekly plans.
- Separate facts, inference, recommendation, and owner decision.
- Specialist reads may fan out; the head resolves conflicts and writes the approved strategy.
- Strategy revisions preserve history and explain why the plan changed.

Exit gates:

- No campaign/content plan without product availability, margin/profit constraint, target customer, objective, measurement plan, and owner-approved budget boundary.
- Ten historical scenarios produce evidence-backed priorities instead of generic “post more” advice.
- Chrome proof shows a preview strategy, assumptions, competing options, and an owner approval that resumes the same graph.

## Phase 43 — Tracking, event quality, and profit attribution

Goal: make optimization decisions from trustworthy business outcomes.

Allowed files:

- `prisma/schema.prisma`
- `prisma/migrations/<phase-43-add-marketing-measurement>/migration.sql` (new)
- `src/agent/lib/marketing/event-contract.ts` (new)
- `src/agent/lib/marketing/meta-capi.ts` (new)
- `src/agent/lib/marketing/utm.ts` (new)
- `src/agent/lib/marketing/attribution.ts` (new)
- `src/agent/lib/ga4.ts`
- `src/agent/lib/gsc.ts`
- `src/agent/tools/marketing-tools.ts`
- `src/agent/lib/__tests__/marketing-event-contract.test.ts` (new)
- `src/agent/lib/__tests__/attribution.test.ts` (new)
- `docs/proofs/agent-phase-43/*` (new)

Build:

- One event taxonomy from page view/product view/lead/Messenger/order draft/confirmed/delivered/refund/repeat, with BDT currency and consistent IDs.
- Browser Pixel + server Conversions API plan where appropriate, deterministic event IDs for deduplication, consent/privacy handling, diagnostics, timestamp and user-data normalization.
- GA4 ecommerce/key events, GSC dimensions, Meta outcomes, ERP orders, delivery/refund, gross margin, and ad spend joined without pretending last-click is causal truth.
- UTM naming/generation/validation and campaign→ad set→ad→creative lineage.
- Reconciliation dashboard: missing/duplicate/late events, Meta/GA4/ERP count mismatch, freshness, and confidence.

Exit gates:

- Duplicate test events do not double-count.
- PII is minimized, normalized only where permitted, protected in logs, and never enters fixtures.
- Attribution output labels observed, modelled, and unknown values separately.
- Chrome proof uses preview/test events only and shows the same event trace through browser/server, analytics, and ERP reconciliation.

## Phase 44 — Content, creative, offer, and CRO laboratory

Goal: produce senior-quality marketing assets as testable hypotheses, not volume spam.

Allowed files:

- `prisma/schema.prisma`
- `prisma/migrations/<phase-44-add-growth-experiments>/migration.sql` (new)
- `src/agent/lib/marketing/experiment-registry.ts` (new)
- `src/agent/lib/marketing/creative-strategy.ts` (new)
- `src/agent/lib/marketing/content-calendar.ts` (new)
- `src/agent/lib/marketing/cro-brief.ts` (new)
- `src/agent/tools/growth-tools.ts`
- `src/agent/tools/studio-tools.ts`
- `worker/src/content-engine/run.mjs`
- `src/agent/lib/__tests__/experiment-registry.test.ts` (new)
- `src/agent/lib/__tests__/creative-strategy.test.ts` (new)
- `docs/proofs/agent-phase-44/*` (new)

Build:

- Structured hypothesis: audience, awareness stage, pain/desire, offer, angle, hook, proof, format, destination, metric, guardrail, sample/time window, winner/loser rule.
- Brand/Islamic image and copy gates before preview; product facts and claims are grounded.
- Reusable creative matrix across static, carousel, short video/Reel, story, Messenger, landing page, email/SMS, and organic posts where APIs/assets permit.
- Fatigue tracking by creative/audience/frequency/time, not merely campaign averages.
- CRO briefs backed by analytics/session evidence, with preview diff, accessibility/mobile/performance check, and rollback.
- Owner reviews a final asset and exact destination immediately before public publish.

Exit gates:

- Every asset belongs to an approved brief/experiment and has source product facts.
- No haram product, misleading urgency, fabricated testimonial, prohibited imagery, or unsupported performance claim.
- Chrome proof shows hypothesis → generated variants → preview → owner-selected winner, without public publishing.

## Phase 45 — Professional Meta Ads execution and optimization

Goal: safely cover the business's real paid-media lifecycle.

Allowed files:

- `src/agent/lib/meta.ts`
- `src/agent/lib/meta-ads.ts`
- `src/agent/lib/ads/optimizer.ts`
- `src/agent/lib/marketing/meta-version.ts` (new)
- `src/agent/lib/marketing/meta-campaign-graph.ts` (new)
- `src/agent/tools/ads-tools.ts`
- `worker/src/ads/monitor.mjs`
- `src/agent/lib/__tests__/meta-campaign-graph.test.ts` (new)
- `src/agent/lib/__tests__/meta-version.test.ts` (new)
- `worker/src/ads/__tests__/monitor.test.mjs` (new)
- `docs/proofs/agent-phase-45/*` (new)

Build only after Phase 41 confirms the assets/permissions ALMA actually owns:

- Central versioned Meta client, permission/error classification, rate limits, token health, idempotency/dedup, and sandbox fixtures.
- Campaign graph: approved brief → objective/destination → audience → placements → optimization/bid → budget/schedule → creative → tracking QA → create paused → review diff → point-of-risk activation approval → monitor → optimize/stop/learn.
- Support only objectives/formats/features proven by the current API and ALMA assets. Mark unsupported combinations; do not fabricate parity with Ads Manager.
- Professional controls: naming, exclusions/overlap, learning/fatigue warnings, pacing, daily/lifetime cap, spend anomaly, frequency, placement/creative breakdown, CPA/ROAS and delivered-order profit.
- Experiment registry and change log for every budget/audience/creative/status mutation.
- Automated recommendation is not automated spending. Every activation or budget increase remains point-of-risk confirmed until Roadmap 3 approves a narrow cap.

Exit gates:

- Create/update requests are contract-tested against current Meta API fixtures.
- A duplicate/retried request cannot create two campaigns/ad sets/ads.
- Preview flow creates paused test/draft objects only; public activation is not part of automated proof.
- Chrome proof shows the exact campaign diff, tracking health, budget, audience, and paused status.

## Phase 46 — Facebook Page, Instagram, Business Suite, and community operations

Goal: operate the supported social lifecycle with API-first reliability and bounded browser fallback.

Allowed files:

- `src/agent/lib/meta.ts`
- `src/agent/lib/meta-instagram.ts`
- `src/agent/lib/cs/meta-messenger.ts`
- `src/agent/lib/growth/publish.ts`
- `src/agent/lib/marketing/social-ops-graph.ts` (new)
- `src/agent/tools/growth-tools.ts`
- `src/agent/tools/cs-tools.ts`
- `worker/src/messenger/scan.mjs`
- `src/agent/lib/__tests__/social-ops-graph.test.ts` (new)
- `src/agent/lib/__tests__/meta-instagram.test.ts` (new)
- `docs/proofs/agent-phase-46/*` (new)

Capability sequence:

- Page/IG asset and permission health; content calendar; drafts/previews; approved publishing; scheduling; delivery confirmation; permalink/media verification.
- Add only API-supported formats proven in Phase 41: carousel, Reel/video, story, catalog/product tags, or others. Keep explicit unsupported states.
- Comments/inbox/Messenger triage, spam/escalation, response SLA, Bangla quality, product/order grounding, and human handoff.
- Calendar conflicts, failed upload/process, expired token, permission loss, rate limit, post rejection, and asset-processing recovery.
- Business Suite UI fallback may diagnose/configure unsupported settings, but permission/security/publish actions require immediate owner confirmation.

Exit gates:

- No post/message is claimed delivered until fetched back or webhook-confirmed.
- One approval maps to one immutable content+asset+destination payload.
- Customer-facing Bangla and Islamic/business rules pass the output gate.
- Chrome proof uses a safe test/draft destination and covers schedule, failure recovery, and verified final state.

## Phase 47 — Senior SEO, local search, website quality, and release loop

Goal: diagnose and improve organic visibility and conversion with deployable, verified changes.

Allowed files:

- `src/agent/lib/seo/technical-audit.ts` (new)
- `src/agent/lib/seo/content-strategy.ts` (new)
- `src/agent/lib/seo/internal-links.ts` (new)
- `src/agent/lib/seo/release-graph.ts` (new)
- `src/agent/lib/gsc.ts`
- `src/agent/tools/seo-tools.ts`
- `worker/src/seo/audit.mjs`
- `src/agent/lib/__tests__/technical-seo-audit.test.ts` (new)
- `src/agent/lib/__tests__/seo-release-graph.test.ts` (new)
- `docs/proofs/agent-phase-47/*` (new)

Cover:

- crawl/render/indexability, robots/sitemaps, canonical/redirect/status, duplication, pagination, structured data, hreflang if relevant, image/media, mobile, accessibility, performance/Core Web Vitals, JavaScript rendering, security and broken journeys
- GSC query/page/country/device/search-appearance analysis with data freshness and API row limitations clearly labelled
- search intent, topic clusters, content gaps, product/category/local pages, E-E-A-T evidence, people-first helpful content, internal-link graph, backlink/digital-PR opportunities without spam
- GBP/local consistency, reviews, business information, and local landing pages
- CRO: analytics-backed hypothesis, preview implementation, before/after crawl and visual/browser proof, owner approval, then later production release by the owner

Exit gates:

- Every recommendation has evidence, affected URLs, expected impact, confidence, effort/risk, validation method, and rollback.
- No direct production edit/deploy by the agent; code changes go through scoped branch, preview, Chrome proof, and owner merge.
- No ranking guarantee or automated spam/link scheme.
- Chrome proof shows before/after preview crawl, rendered page, structured-data/indexability check, and no regression in the tested flow.

## Phase 48 — Internet/computer operator and closed-loop growth control room

Goal: diagnose and complete safe online tasks end-to-end, with evidence and recovery.

Allowed files:

- `src/agent/lib/browser/actions.ts`
- `src/agent/lib/live-browser/guard.ts`
- `src/agent/lib/live-browser/trust.ts`
- `src/agent/lib/browser/success-criteria.ts` (new)
- `src/agent/lib/browser/diagnostics.ts` (new)
- `src/agent/lib/graph/live-browser-graph.ts`
- `src/agent/tools/live-browser-tools.ts`
- `worker/src/browser/runner.mjs`
- `worker/src/browser/service.mjs`
- `worker/src/browser/diagnostics.mjs` (new)
- `src/agent/lib/marketing/growth-control-room.ts` (new)
- `src/agent/lib/__tests__/browser-success-criteria.test.ts` (new)
- `worker/src/__tests__/browser-diagnostics.test.mjs` (new)
- `docs/proofs/agent-phase-48/*` (new)

Add, if the extension/runtime safely supports them:

- coordinate click, double click, mouse move, robust drag/drop, screenshot region/zoom, tab/window/frame inspection, download/upload state
- guarded console errors, network request/failure summary, redirect/cookie/storage diagnostics, performance snapshot, and read-only page-script inspection
- dedicated isolated operator browser/profile or VM for autonomous tasks; the owner's logged-in Chrome is supervised mode, not an unrestricted autonomous sandbox
- explicit task success criteria before action; after every action observe; at completion independently re-read the final state and store proof
- checkpoint current URL/tab/frame/visible state/last verified step/artifact/error/next action; move long work to the VPS queue
- recovery playbooks for offline/DNS/TLS/5xx/4xx, expired auth, permission denial, API deprecation, upload/processing failure, broken UI selector, third-party outage, and prompt injection
- control room joining marketing experiments, ads, organic, SEO, funnel, alerts, actions, approvals, proof, and learned outcome

Exit gates:

- Browser action coverage passes a controlled test site for all supported primitives.
- Prompt injection, fake instruction, malicious download, cross-domain redirect, and secret-request tests fail safely.
- The operator diagnoses owner-fixable versus vendor/platform issues and never claims control it does not have.
- Chrome proof shows one website issue and one Business Suite/Meta diagnostic from problem → evidence → safe change/draft → verified outcome, with a forced disconnect/resume.

## Final quality gates

- Marketing recommendations cite fresh source data and state uncertainty.
- All campaigns/content/SEO changes are traceable to an approved strategy and experiment.
- Delivered-order profit and business constraints outrank vanity metrics.
- No external side effect without the applicable Roadmap 3 guard, idempotency, ledger, and proof.
- No unsupported “full Facebook/Instagram/Business Suite control” claim; capability health is shown live.
- Weekly learning updates future decisions only from verified outcomes, not correlation alone.

## Primary references

- [Meta Marketing API](https://developers.facebook.com/docs/marketing-api/)
- [Meta Graph/Marketing API version lifecycle](https://developers.facebook.com/docs/graph-api/changelog/versions)
- [Google SEO Starter Guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)
- [Google Search Console API](https://developers.google.com/webmaster-tools)
- [Search Analytics query reference and limitations](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
- [Google Analytics Data API](https://developers.google.com/analytics/devguides/reporting/data/v1)
- [OpenAI computer-use guide and safety model](https://developers.openai.com/api/docs/guides/tools-computer-use)
- [Anthropic computer-use guidance](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
