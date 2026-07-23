# Phase 69 — Accurate Subscription & Provider Billing Hub

**Status:** Preview-ready; not merged or deployed to production  
**Branch:** `agent-phase-69`  
**Safety tag:** `pre-agent-phase-69`  
**Implementation commit:** `aeba1196`  
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
  - fal.ai prepaid cash
  - ElevenLabs quota, plan, and provider-published invoice fields
  - FASHN subscription/on-demand credits
  - Vercel FOCUS billing charges
  - Supabase organization plan
  - Optional Google Cloud Billing export for Gemini, Google TTS, and Veo
  - Explicit local-only xAI usage
- Added last-known-good preservation and stale/error states for transient sync failures.
- Added provider snapshots and sync-run health through one additive migration.
- Added due-now, due-within-7-days, and due-within-30-days summaries without
  double-counting provider invoices and manual subscriptions.
- Enriched manual subscription records with provider, invoice, source, and sync metadata.
- Added manual full refresh and a 15-minute VPS worker refresh schedule.
- Added equivalent web and native iOS cards, summaries, source labels, status badges,
  provider dashboard links, and CSV fields.

## Live preview evidence

Chrome full refresh completed at **23 July 2026, 11:41 PM (Asia/Dhaka)**:

- Sync health: `Healthy`
- Verified prepaid USD cash: `$19.53`
- Provider-confirmed month-to-date cost: `$30.23`
- Due within 7 days: `0`
- OpenRouter: `$12.21` provider-verified cash wallet; provider activity plus only the
  post-boundary local delta.
- fal.ai: `$7.32` provider-verified cash wallet.
- FASHN: `0 credits`, correctly presented as quota rather than USD cash.
- Anthropic: official cost-report base plus the post-boundary local delta; the old
  `$8.25` opening value remains visibly labelled a manual estimate, not a wallet.
- Vercel: `Connect` because the preview lacks the billing token/team configuration.
- Supabase: `Connect` because the preview lacks the Management token/organization slug.
- Twilio, OpenAI, Gemini/Google billing, and ElevenLabs stay explicitly
  local/manual/partial when their required Preview billing credentials or exports are
  unavailable; the hub does not invent a live value.

Web proof was captured from the owner's logged-in Chrome at
`/tmp/alma-phase69-web-proof.png`.

Native iOS proof used the isolated simulator **ALMA Phase69 Billing**:

- Build, install, launch, owner login, deep-link navigation, refresh, and full provider
  list rendering all passed.
- The native summary matched web: `$19.53` prepaid cash and `$30.23` provider MTD.
- OpenRouter, fal.ai, FASHN, Vercel, Supabase, and all manual/partial labels matched
  the web authority model.
- Proof screenshots:
  - `/tmp/alma-phase69-ios-proof.jpeg`
  - `/tmp/alma-phase69-ios-provider-status-proof.jpeg`

The simulator's initial “Network error” was diagnosed as Vercel Deployment Protection:
an unauthenticated native CSRF request received a `302` to Vercel SSO. Verification
used a temporary Vercel share cookie, then the clean preview URL. No auth or production
code was changed.

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
| Provider billing unit tests | PASS — 10/10 |
| Prisma schema validation | PASS |
| Clean-source TypeScript check | PASS |
| Local production build | PASS |
| Vercel preview build/deployment | PASS |
| iOS workspace simulator build | PASS |
| Owner Chrome live preview + refresh | PASS |
| Isolated iOS simulator render + refresh | PASS |
| Production deployment/merge | NOT DONE — intentionally owner-gated |

After Next regenerates `.next/types`, the repository's pre-existing generated route
check still reports the unrelated exported `VOICE_INSTRUCTION_PREFIX` in
`voice-call/submit-instruction/route.ts`. The clean source check and both production
builds pass; Phase 69 did not touch that route.

## Remaining configuration

The feature is complete, but every provider cannot become authoritative until its
read-only billing credential/export exists in the target environment:

- `VERCEL_BILLING_TOKEN` plus team ID/slug
- `SUPABASE_MANAGEMENT_TOKEN` plus organization slug
- `OPENAI_ADMIN_API_KEY` plus organization ID
- `GOOGLE_BILLING_*` export settings, if actual Gemini/TTS/Veo billing is required
- Provider keys in Preview for any provider that currently shows Manual/Partial

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

