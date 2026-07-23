# Phase 69 — Accurate Subscription & Provider Billing Hub

## Owner request

Replace the current mixed/manual subscription view with one truthful billing hub on
web and native iOS. Every provider must expose only the fields its official API can
actually supply. Wallet cash, usage cost, quota, subscription renewal, invoice due,
local estimates, and manual values must never be presented as the same thing.

## Required outcomes

1. Fix OpenAI organization-cost parsing and pagination.
2. Preserve live Twilio/OpenRouter/fal wallet balances.
3. Show ElevenLabs and FASHN as quota/credits, not invented USD cash; include
   ElevenLabs' provider-published open/next invoice amount, status, and due time.
4. Add Vercel FOCUS billing-charge sync and Supabase organization-plan sync.
5. Support optional Google Cloud Billing export for Gemini/TTS/Veo actual costs.
6. Add xAI as an explicit locally measured provider when no billing API is configured.
7. Store provider snapshots and sync-run health additively.
8. Show per-field source, freshness, authority, provider-as-of time, errors, and
   dashboard deep links.
9. Keep last known good provider data on a transient sync failure and mark it stale.
10. Reconcile lagged provider totals with only the local events after the
    provider-as-of boundary; never use a blind `max()` merge.
11. Show due now / 7 days / 30 days and enrich manual subscriptions with provider,
    invoice, source, and sync metadata.
12. Deliver equivalent truthful web and native iOS presentations.
13. Refresh provider billing every 15 minutes on the VPS worker, with manual refresh.

## Locked allowed files

- `docs/PHASE-69-SUBSCRIPTION-BILLING-HUB-PROMPT.md`
- `docs/PHASE-69-REPORT.md`
- `.env.example`
- `prisma/schema.prisma`
- `prisma/migrations/20260723230000_agent_provider_billing_hub/migration.sql`
- `src/agent/lib/api-balances.ts`
- `src/agent/lib/provider-billing.ts`
- `src/agent/lib/__tests__/provider-billing.test.ts`
- `src/agent/lib/cost-dashboard.ts`
- `src/agent/components/AgentCostsDashboard.tsx`
- `src/app/api/assistant/costs/balances/route.ts`
- `src/app/api/assistant/costs/subscriptions/route.ts`
- `src/app/api/assistant/costs/subscriptions/[id]/route.ts`
- `src/app/api/assistant/costs/export/route.ts`
- `worker/src/schedulers/balance-check.mjs`
- `worker/src/schedulers/index.mjs`
- `ios/App/App/SubscriptionsSwiftUI.swift`

## Non-goals / safety

- Do not modify `/api/agent/*`.
- Do not modify unrelated ERP, payroll, wallet, auth, or finance behavior.
- Do not deploy or merge to production.
- Do not fabricate unavailable invoice due dates or wallet balances.
- Do not commit secrets.

## Completion gates

- Additive migration only.
- Focused unit tests, full typecheck, production build, and scope diff pass.
- Push `agent-phase-69` for a Vercel preview.
- Verify the live preview in the owner's Chrome and capture screenshot proof.
- Build, install, launch, and capture the Subscriptions screen on an approved isolated
  iOS simulator. Hardware-only checks must be labelled honestly.
