# NP-1 — Monitor compact shell + Agent Hub (completion evidence)

**Date:** 2026-07-17 · **Branch:** `claude/ios-native-parity-roadmap-aab64a`

## What shipped

1. **LIVE Business Monitor compact shell** ([StaffMonitorSwiftUI.swift](../ios/App/App/StaffMonitorSwiftUI.swift))
   - Sticky (outside-the-scroll) status strip: LIVE pulse/archive badge + Agent/Browser/Heartbeat/alert chips — each chip jumps to its controlling tab.
   - Five tabs with web `MonitorTabs` parity (icons, labels, count badges, neon underline hexes #5B8CFF/#A855F7/#EC4899/#22D3A5/#E07A5F): Overview · Agents · Staff · Feed · System.
   - Date/history chips sit under the tabs (roadmap §4.1); historical dates keep the Agents tab read-only ("Agent কন্ট্রোল শুধু লাইভ ভিউতে" — web string verbatim).
   - Overview: 4-KPI strip + actionable alert summary (or compact all-clear line) + top-3 staff + refresh meta. Staff: full cards + geo + productivity. Feed: Pending-Ack list + message feed with expand (actions land NP-3). Agents: existing control panels. System: compact NP-3 note (no giant empty state).
   - 96pt bottom clearance so a floating control never covers the final row (§4.2 hard rule). Controls VM hoisted to the screen; ONE lifecycle-aware 10s poll drives staff payload + watch state (no per-card timers).
2. **Agent Hub** ([AgentHubSwiftUI.swift](../ios/App/App/AgentHubSwiftUI.swift), route `/agent/hub`) — canonical grid of ALL 12 Agent surfaces (Chat, LIVE Business, Live Watch, Studio, WhatsApp, Costs, Growth, Known People, Product Images, Trading Staff, Subscriptions, Phone Companion). Rows post `.almaOpenPath` → the SAME single nav decision path as notification taps/deep links. Companion opens the native sheet. Hub row added to More-menu Agent group + radial menu got a Hub shortcut.
3. **`/agent/live-watch` is native** (AG-08): router case → `StaffMonitorScreen(initialTab: .agents)`; removed from `temporaryWebRoutes`; route contract updated (native-required/native).
4. Router retitles `/agent/staff-monitor` host to "LIVE Business".

## Verification

- `xcodebuild … -destination 'iPhone 17 Pro Max' build` → **BUILD SUCCEEDED** (worktree first-time setup: `npm ci` + `pod install` + `npx cap copy ios`; copied bootstrap verified identical to tracked `mobile/www`).
- `node scripts/iosp0-route-contract-check.mjs` → OK: 70 fixtures / 66 routes, temporary-web now 4 (live-watch closed).
- `node scripts/ios-feature-parity-check.mjs` → OK: open actions 75 → **70** (AG-01×3, AG-08, AG-09 native), all tracked, none hidden.
- Exit-gate first-fold visual proof (6.1in + Pro Max screenshots) is batched into the NP-9 owner-approved sim session per owner instruction.

## Notes

- `pendingApprovals`/`failures` fields (web alert-count inputs) are not yet decoded in the native payload — Feed approvals + escalate actions are NP-3 scope (AG-07.feed).
- The one internal web escape left on the Monitor is the System tab's "আপাতত ওয়েবে খুলুন" — contract AG-07.system, plannedPhase NP-3.
