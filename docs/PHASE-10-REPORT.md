# Phase 10 Report — Final Gap Closure

**Branch:** `agent-phase-10`  
**Tag:** `pre-agent-phase-10`  
**Commit message:** `feat(agent): Phase 10 — ask_user, reply-time + pattern detection, staff GPS, quick commands, ads write v1`

---

## Summary

Phase 10 closes the remaining requirements-traceability gaps from the original spec:

| Part | Deliverable |
|------|-------------|
| 1 | `ask_user` tool + web `ask_card` SSE + Telegram inline keyboard |
| 2 | `staff_reply_stats` table + messenger scan + night/weekly reply aggregates + morning pattern detection |
| 3 | `staff_locations` + Telegram live location + task-done location prompt + owner GPS tools |
| 4 | `/today`, `/khoroch`, `/ask` commands + `pause_campaign` / `update_campaign_budget` (confirm cards) |
| 5 | Build/typecheck PASS, migration clean, traceability table below |

---

## Staff GPS Onboarding Message (Bangla — forward to staff)

```
আস্সালামু আলাইকুম!

ALMA অফিসে কাজের সময় আপনার Telegram থেকে Live Location শেয়ার করুন — এটি শুধুমাত্র আপনি যা actively শেয়ার করবেন তাই ট্র্যাক হবে। কোনো গোপন ট্র্যাকিং নেই।

কীভাবে:
1. Telegram → Attachment → Location → Share Live Location
2. অফিস সময় শেষে Share বন্ধ করুন

কাজ Done করার পর bot একবার লোকেশন চাইতে পারে — দিতে না পারলে skip করতে পারবেন।

জাযাকাল্লাহ খাইর।
```

Owner can copy via Telegram: `/staff_onboard`

---

## Meta Ads `ads_management` Scope Setup (Owner)

1. [Meta Developer Console](https://developers.facebook.com/) → your app → **App Review** / **Permissions**
2. Add **`ads_management`** to the user/system token used as `META_ADS_TOKEN`
3. Regenerate token with: `ads_read`, `ads_management`, `business_management` (as needed)
4. Set on **Vercel** (`META_ADS_TOKEN`, `META_AD_ACCOUNT_ID`) and **VPS worker** `.env`
5. Verify: `cd worker && npm run check-fb` (page tokens) + agent tool `pause_campaign` will call `checkAdsManagementScope()` at runtime

**Note:** Full campaign **creation** remains out of scope (deferred — see traceability table).

---

## Files Created / Modified

### New migration
- `prisma/migrations/20260614120000_agent_phase10/migration.sql` — `agent_ask_cards`, `staff_reply_stats`, `staff_locations`

### Agent (src)
- `src/agent/tools/ask-tools.ts`
- `src/agent/tools/ads-tools.ts`
- `src/agent/tools/location-tools.ts`
- `src/agent/lib/meta-ads.ts`
- `src/agent/components/AgentAskCard.tsx`
- `src/app/api/assistant/ask-cards/[id]/answer/route.ts`
- `src/app/api/assistant/internal/ask-card/route.ts`

### Worker
- `worker/src/messenger/reply-stats.mjs`
- `worker/src/telegram/location.mjs`
- `worker/src/telegram/quick-commands.mjs`

### Updated
- `prisma/schema.prisma`, `src/agent/lib/core.ts`, `AgentApp.tsx`, `AgentThread.tsx`
- `src/agent/tools/registry.ts`, `staff-task-proposal.ts`, `system-prompt.ts`
- `chat/route.ts`, `actions/.../approve/route.ts`
- `worker/src/messenger/scan.mjs`, `night-report.mjs`, `weekly-review.mjs`, `telegram/index.mjs`
- `scripts/test-staff-safe-tools.mjs`

---

## Verification Checklist

| Test | Status |
|------|--------|
| `npm run type-check` | ✅ PASS |
| `npm run build` | ✅ PASS |
| Migration: zero `::`, zero expression indexes | ✅ PASS |
| `node scripts/test-staff-safe-tools.mjs` | ✅ PASS (location/ads/ask excluded) |
| `ask_user` → web `ask_card` SSE | ✅ Code-verified |
| `ask_user` → Telegram `askCards` + `ask_pick:` callback | ✅ Code-verified |
| Messenger scan → `staff_reply_stats` insert | ✅ Code-verified |
| Night report reply-time line | ✅ Code-verified |
| Pattern detection in morning proposal | ✅ Code-verified |
| Staff live location → `staff_locations` row | ✅ Code-verified |
| Live share stop → owner Tier-1 notify | ✅ Code-verified |
| Task Done → location prompt (skippable) | ✅ Code-verified |
| `get_staff_location` / `get_staff_location_history` | ✅ Code-verified |
| `/today`, `/khoroch`, `/ask` | ✅ Code-verified |
| `pause_campaign` / `update_campaign_budget` confirm + approve | ✅ Code-verified |

**Live tests** (owner on preview/production after migrate deploy):
1. Ambiguous message → ask card on web + Telegram → tap option → flows as user message
2. Staff shares live location → `get_staff_location` returns Maps link
3. Stop live share → owner notification
4. `/today` and `/khoroch` compact summaries
5. Seed stale product → next morning proposal includes pattern reason
6. Night report manual trigger → reply-time line

---

## FINAL TRACEABILITY TABLE

| Original requirement | Status |
|---------------------|--------|
| Personal AI agent (web + Telegram) | ✅ done |
| ERP read tools (orders, inventory, attendance) | ✅ done |
| Staff task proposal + dispatch | ✅ done |
| Salah accountability + Dhaka schedule | ✅ done |
| Personal finance (expense/ledger) | ✅ done |
| Messenger scan + owner alerts | ✅ done |
| Reminders + urgent alerts (Phase 9) | ✅ done |
| Shared brain / cross-surface memory | ✅ done |
| Cost dashboard | ✅ done |
| **ask_user clarifying buttons** | ✅ done (Phase 10) |
| **Staff response-time tracking** | ✅ done (Phase 10) |
| **Pattern detection in morning proposal** | ✅ done (Phase 10) |
| **Staff GPS (Telegram live location)** | ✅ done (Phase 10) |
| **Quick commands /today /khoroch /ask** | ✅ done (Phase 10) |
| **Ads pause + budget update (write v1)** | ✅ done (Phase 10) |
| Full Meta campaign creation | ⏸ out-of-scope / future |
| Fable voice escalation | ⏸ deferred-by-owner |
| ElevenLabs TTS | ⏸ deferred-by-owner |
| Hermes data migration / retire legacy bot | ⏸ deferred-by-owner |
| Composio / third-party integrations | ⏸ not in spec path |
| Customer-facing auto-reply (agent messages customers) | ⏸ never — alerts owner only |

---

## Deploy Notes

1. `prisma migrate deploy` on production Supabase
2. Vercel redeploy from `agent-phase-10` preview
3. VPS: `git pull`, `pm2 restart alma-worker`
4. Confirm `META_ADS_TOKEN` has `ads_management` before using pause/budget tools

## Production deployment (approved)

| Step | Status |
|------|--------|
| Merge `agent-phase-10` → `main` (`584017d`) | ✅ |
| `git push origin main` | ✅ |
| VPS `git pull` + `prisma migrate deploy` (`20260614120000_agent_phase10`) | ✅ |
| Tables `agent_ask_cards`, `staff_reply_stats`, `staff_locations` on Supabase | ✅ verified |
| `pm2 restart agent-worker` — 13 schedulers online | ✅ |
| Vercel auto-deploy from `main` push | ✅ (in progress ~2 min) |

**Production URLs:** https://alma-erp-six.vercel.app · VPS worker `31.97.237.40`
