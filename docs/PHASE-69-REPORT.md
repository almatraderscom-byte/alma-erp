# Phase 69 — Accurate Subscription & Provider Billing Hub

**Status:** Preview-ready; corrected live data and native iOS redesign verified
**Branch:** `agent-phase-69`
**Safety tag:** `pre-agent-phase-69`
**Implementation commit:** `7eb589c8`
**Provider-truth correction:** `e1a9ad36`
**Final env-verification build:** `b6dc3d52`
**Preview:** `https://alma-erp-git-agent-phase-69-maruf-s-projects2.vercel.app`

## Outcome

The old mixed balance/subscription presentation is now one truthful provider billing
hub on web and native iOS. Cash wallet, usage cost, provider-reported cost, quota,
plan, invoice, due date, local estimate, and manual value are separate fields with
separate source/authority/freshness metadata.

The UI no longer calls a manual opening amount or a quota a provider-verified cash
balance. A provider with no public wallet or invoice API says so directly.

After the first live review exposed misleading presentation, the correction also
removes every legacy manual-credit-derived value from the main balance field. A
successful but empty provider response is no longer `Connected`: it is
`Waiting for provider data`, and local usage remains explicitly `Estimate only`.
Vercel FOCUS charges are labelled as whole-team billed charges rather than ALMA ERP
project due/invoice.

The native iOS screen is no longer a compressed copy of the web card grid. It now
uses a compact provider list, a four-stat native summary, and one-at-a-time
progressive disclosure so the normal view stays scannable while the complete field
truth remains available on tap.

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
- Added equivalent provider truth on web and native iOS, provider dashboard links,
  and CSV fields.
- Rebuilt the iOS provider section as a native compact list with coloured monograms,
  primary-value hierarchy, SF Symbol summary stats, and tap-to-expand billing detail.

## Corrected live preview evidence

Chrome full refresh on correction commit `e1a9ad36` completed at
**24 July 2026, 11:44 AM (Asia/Dhaka)**:

- Sync health: `3 attention` and `2 optional connections`; waiting/partial providers
  now count as attention instead of being hidden by an overall healthy state.
- Verified prepaid USD cash: `$57.58`.
- Provider-published month-to-date cost: `$161.87`.
- Due within 7 days: `0`; ElevenLabs reports the next `USD 23.10` invoice due
  16 August 2026.
- Twilio: `$18.28` provider-verified cash wallet.
- OpenAI: no wallet value is shown. The official organization report publishes
  `$2.71` MTD through 23 July, with `$1.58` post-boundary local estimate separated.
- OpenRouter: `$11.98` provider-verified cash wallet; provider activity plus only the
  post-boundary local delta.
- Google Cloud Billing export is reachable, but Gemini, Google TTS, and Veo have no
  dated billing rows yet. They show `Waiting for provider data`; their `$27.51`,
  `$1.35`, and `$0.60` figures appear only as local MTD estimates, never as provider
  balance or provider-published cost.
- ElevenLabs: `220,685` characters available, plan/usage/invoice all live, with the
  next `USD 23.10` invoice exposed separately from cash.
- fal.ai: `$7.32` provider-verified cash wallet; official Admin cost remains the
  owner-deferred optional connection.
- FASHN: `0 credits`, correctly presented as quota rather than USD cash.
- xAI: `$20.00` provider-verified cash wallet, provider-delayed cost, and a live
  `USD 12.42` current invoice preview whose due date is not published.
- Vercel: `$116.54` is explicitly `Team billed MTD`, scope `Entire team`;
  wallet and invoice/due are `Not exposed`. It is not presented as ALMA ERP
  project-only due.
- Oxylabs usage and Supabase plan remain the other two owner-deferred optional
  connections.
- Vercel runtime logs confirm the manual refresh request:
  `POST /api/assistant/costs/balances 200`.

Web proof was captured from the owner's logged-in Chrome at:

- `/tmp/alma-phase69-web-provider-truth.png`

Corrected native iOS verification uses the isolated simulator
**ALMA Phase69 Billing**:

- Clean workspace simulator build passed with the branch preview URL injected only
  into the temporary verification artifact:
  `/tmp/alma-phase69-derived-native-redesign/Build/Products/Debug-iphonesimulator/App.app`.
- The protected Vercel Preview required a simulator-only share-cookie bootstrap before
  the app's redirect-blocking API session could call the branch alias. No source or
  production behavior was changed for this verification.
- After the owner completed the one-time native login, Codex opened Subscriptions and
  triggered the provider refresh. Vercel runtime logs confirm
  `POST /api/assistant/costs/balances 200` at **12:25 PM Asia/Dhaka**, followed by
  successful native reads.
- The refreshed native summary showed `$57.40` prepaid cash, `$161.87`
  provider-published MTD, `0` due within 7 days, and `3` attention items. Small wallet
  movement versus the earlier web proof is expected because prepaid balances are live.
- The redesigned default view shows one concise native row per provider; tapping a
  row opens that provider's full source, billing metrics, wallet/cost/usage/plan/
  invoice truth, explanation, and dashboard action. Only one row expands at a time.
- OpenAI showed no cash wallet, `$2.71` Provider MTD, `$1.90` local after cutoff, and
  `$4.61` combined tracked—never the old negative manual value. The local delta moved
  since the earlier proof because usage continued during verification.
- Gemini showed `API নেই / NOT EXPOSED`, local MTD `$27.71`, `Estimate only`, and
  `Waiting for provider data`.
- Vercel showed `$116.54` as `Team billed MTD`, scope `Entire team`, and
  `Invoice / due: Not exposed`.
- The final native refresh is visible in Vercel runtime logs as
  `POST /api/assistant/costs/balances 200` at **12:57 PM Asia/Dhaka**.
- Latest native redesign screenshots:
  - `/tmp/alma-phase69-ios-native-redesign-list-latest.png`
  - `/tmp/alma-phase69-ios-native-redesign-details-latest.png`
  - `/tmp/alma-phase69-ios-native-redesign-vercel-latest.png`

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
| Provider billing unit tests | PASS — 15/15 |
| Prisma schema validation | PASS |
| Clean-source TypeScript check | PASS |
| Local production build | PASS |
| Vercel preview build/deployment | PASS |
| iOS workspace simulator build | PASS — exact redesigned source |
| Owner Chrome live preview + refresh | PASS |
| Isolated iOS native redesign + provider refresh | PASS |
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
