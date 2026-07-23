# Phase 69 — Accurate Subscription & Provider Billing Hub

**Status:** Preview-ready; web verified; final iOS re-verification awaiting owner login
**Branch:** `agent-phase-69`
**Safety tag:** `pre-agent-phase-69`
**Implementation commit:** `7eb589c8`
**Preview:** `https://alma-erp-git-agent-phase-69-maruf-s-projects2.vercel.app`

## Outcome

The old mixed balance/subscription presentation is now one truthful provider billing
hub on web and native iOS. Cash wallet, usage cost, provider-reported cost, quota,
plan, invoice, due date, local estimate, and manual value are separate fields with
separate source/authority/freshness metadata.

The UI no longer calls a manual opening amount or a quota a provider-verified cash
balance. A provider with no public wallet or invoice API says so directly.

## Delivered

- Fixed OpenAI organization-cost amount parsing, UTC boundaries, and cursor pagination.
- Added provider-authoritative cost reconciliation using only local usage after the
  provider report boundary.
- Added live/provider fields for:
  - Anthropic organization cost report
  - Twilio account balance when Preview/Production has the Twilio credentials
  - OpenRouter cash wallet and account activity
  - fal.ai prepaid cash and Admin usage/cost
  - Oxylabs usage statistics
  - ElevenLabs quota, plan, and provider-published invoice fields
  - FASHN subscription/on-demand credits
  - xAI prepaid balance, cost, and invoice preview
  - Vercel FOCUS billing charges
  - Supabase organization plan
  - Optional Google Cloud Billing export for Gemini, Google TTS, and Veo
- Added last-known-good preservation and stale/error states for transient sync failures.
- Prevented a manual estimate from hiding a provider sync error.
- Replaced blanket “Partial” labels with field-level truth states:
  `Live`, `Provider delayed`, `Local estimate`, `Needs credential`,
  `Sync error`, `None reported`, and `Not exposed`.
- Added provider snapshots and sync-run health through one additive migration.
- Added due-now, due-within-7-days, and due-within-30-days summaries without
  double-counting provider invoices and manual subscriptions.
- Enriched manual subscription records with provider, invoice, source, and sync metadata.
- Added manual full refresh and a 15-minute VPS worker refresh schedule.
- Added equivalent web and native iOS cards, summaries, source labels, status badges,
  provider dashboard links, and CSV fields.

## Live preview evidence

Chrome full refresh completed at **24 July 2026, 1:25 AM (Asia/Dhaka)**:

- Sync health: `3 attention` and `3 optional connections`
- Verified prepaid USD cash: `$19.49`
- Provider-confirmed month-to-date cost: `$30.23`
- Due within 7 days: `0`
- OpenRouter: `$12.17` provider-verified cash wallet; provider activity plus only the
  post-boundary local delta.
- fal.ai: `$7.32` provider-verified cash wallet.
- FASHN: `0 credits`, correctly presented as quota rather than USD cash.
- Anthropic: official cost-report base plus the post-boundary local delta; the old
  `$8.25` opening value remains visibly labelled a manual estimate, not a wallet.
- Twilio: `Local only`; wallet is `Needs credential`.
- OpenAI: local values remain visible; official cost is `Needs credential`.
- Oxylabs: usage is `Needs credential`.
- ElevenLabs: quota, plan, usage, and invoice are `Needs credential`; no false
  provider-confirmed invoice state is shown.
- xAI: wallet, cost, and invoice are `Needs credential`.
- Vercel: cost is `Needs credential`; wallet is `Not exposed`.
- Supabase: plan is `Needs credential`; wallet, cost, and invoice are `Not exposed`.
- Gemini, Google TTS, and Veo: `Error`; provider cost is `Sync error`.
- Google error is explicit:
  `GOOGLE_BILLING_SERVICE_ACCOUNT_JSON contains a local file path; paste the JSON file contents into Vercel instead`.

Web proof was captured from the owner's logged-in Chrome at
`/tmp/alma-phase69-web-final.png` and
`/tmp/alma-phase69-google-error-final.png`.

Native iOS verification uses the isolated simulator **ALMA Phase69 Billing**:

- Clean simulator build, install, and launch passed.
- Final app build:
  `/tmp/alma-phase69-final-derived/Build/Products/Debug-iphonesimulator/App.app`.
- Reinstall cleared the preview login session, so final native render/refresh proof is
  pending the owner's one-time login. Codex will not enter owner credentials.

## Migration

`prisma/migrations/20260723230000_agent_provider_billing_hub/migration.sql`

Additive only:

- provider metadata fields on `agent_subscriptions`
- `agent_provider_billing_snapshots`
- `agent_provider_sync_runs`
- supporting indexes and constraints

Vercel preview build logs confirm the migration was applied successfully.

## Verification

| Check | Result |
| --- | --- |
| Locked-file scope diff | PASS |
| Additive migration only | PASS |
| Provider billing unit tests | PASS — 13/13 |
| Prisma schema validation | PASS |
| Clean-source TypeScript check | PASS |
| Local production build | PASS |
| Vercel preview build/deployment | PASS |
| iOS workspace simulator build | PASS |
| Owner Chrome live preview + refresh | PASS |
| Isolated iOS simulator render + refresh | PENDING — owner login required after reinstall |
| Production deployment/merge | NOT DONE — intentionally owner-gated |

After Next regenerates `.next/types`, the repository's pre-existing generated route
check still reports the unrelated exported `VOICE_INSTRUCTION_PREFIX` in
`voice-call/submit-instruction/route.ts`. The clean source check and both production
builds pass; Phase 69 did not touch that route.

## Remaining configuration

The feature is complete, but every provider cannot become authoritative until its
read-only billing credential/export exists in the target environment:

- Google Billing JSON/project/table, Twilio, ElevenLabs, OpenRouter, xAI Management,
  OpenAI Admin, and Vercel Billing are configured for both Production and Preview as
  of the final environment audit.
- `FAL_ADMIN_KEY` is intentionally deferred by the owner; fal.ai wallet stays live
  through `FAL_KEY`, while official Admin usage/cost remains unavailable.
- `OXYLABS_USERNAME` plus `OXYLABS_PASSWORD` are intentionally deferred by the owner;
  the existing `OXYLABS_API_KEY` continues to power scraping, while official monthly
  usage statistics remain unavailable.
- Supabase billing remains manual by owner decision.

These are server-side secrets and were not copied, invented, or committed.

## Official API basis

- OpenAI organization costs:
  `https://platform.openai.com/docs/api-reference/usage/costs`
- ElevenLabs subscription/quota:
  `https://elevenlabs.io/docs/api-reference/user/subscription/get`
- Vercel billing charges:
  `https://vercel.com/docs/rest-api/reference/endpoints/billing/retrieve-billing-charges`
- Supabase Management API:
  `https://api.supabase.com/api/v1`
