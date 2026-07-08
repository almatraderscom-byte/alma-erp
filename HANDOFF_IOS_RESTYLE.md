# iOS Bento-Restyle Program — HANDOFF (START HERE)

**Owner:** Maruf (non-engineer). **Reply in Bangla, concise.** Address as "Boss" only in runtime agent output; normal session replies stay plain.
**How the owner resumes:** he pastes *"HANDOFF_IOS_RESTYLE.md porho, ekhan theke continue koro"* into a NEW session. This file must let you continue with ZERO re-discovery.

---

## 0. THE BRANCH (everything lives here — do not fork)

- **Branch: `claude/ios-swiftui-design-build-dw04ik`** — develop, commit, push HERE only.
- Base = `main` + **`native/aurora-motion` merged at build 63** (commit b1fb239). All native shell work is inside.
- ⚠️ **Before ANY new work:** `git fetch origin native/aurora-motion` and check if it moved past `b1fb239`. If yes, MERGE it into this branch first (web conflicts → keep `main`-side if main is newer by date; iOS conflicts → integrate, never drop either side). The owner's Mac sessions ship TestFlight builds from that line.
- Everything pushed so far is **CI-verified green** (real macOS runner compile). Working tree clean at handoff.

## 1. OWNER'S PROCESS RULES (set 2026-07-08 — override CLAUDE.md where they differ)

1. **NO writer sub-agents.** Sub-agents are for READ/RESEARCH ONLY. All code edits are made by the main session, serially, one file at a time. (The older "fan out parallel workers" rule in CLAUDE.md is suspended by the owner for code-writing.)
2. **Agent section is OFF-LIMITS:** do not touch AssistantSwiftUI, AssistantVoiceSwiftUI, AgentCostsSwiftUI, AgentGrowthSwiftUI, AgentWhatsappSwiftUI, CreativeStudioSwiftUI, CatalogImagesSwiftUI, CompanionSwiftUI, FloatingChatHead, AgoraIntercom/IntercomUI, KnownPeopleSwiftUI, TradingStaffSwiftUI.
3. **CI workflow stays manual-only** (`.github/workflows/ios-simulator.yml`, workflow_dispatch). For ONE verification run per batch you may temporarily add the push trigger (`branches: ['claude/ios-swiftui-design-build-dw04ik']`, `paths: ['ios/**']`), get green, then REVERT it immediately (this pattern is owner-sanctioned; macOS minutes bill 10x, concurrency auto-cancels stale runs).
4. Per-file verify before commit: `swiftc -parse` (§2). Web changes: `npm run type-check` + `npx vitest run`.
5. Batch commits with clear messages; push after each commit (sandbox is ephemeral).

## 2. LINUX SANDBOX TOOLING (new container = re-setup)

```bash
# Swift toolchain for syntax checks (SwiftUI can't typecheck on Linux — parse only):
cd <scratchpad-dir>   # your session's scratchpad
curl -sL https://download.swift.org/swift-6.0.3-release/ubuntu2404/swift-6.0.3-RELEASE/swift-6.0.3-RELEASE-ubuntu24.04.tar.gz -o swift.tar.gz && tar -xzf swift.tar.gz
# then: <scratchpad>/swift-6.0.3-RELEASE-ubuntu24.04/usr/bin/swiftc -parse <file>
```
- Real compile proof = the CI simulator workflow (§1.3). GitHub API can't dispatch it until it lands on `main` — hence the temp-push-trigger pattern.
- CI status poll (public repo, no auth): `curl -s "https://api.github.com/repos/almatraderscom-byte/alma-erp/actions/runs?branch=claude/ios-swiftui-design-build-dw04ik&per_page=3"`.
- Web checks need `npm ci --ignore-scripts` first.

## 3. DONE THIS SESSION (all committed + pushed + CI green)

1. **CI/TestFlight infra:** `.github/workflows/ios-simulator.yml` (manual sim compile check) + `ios-testflight.yml` (manual, cloud signing via App Store Connect API key — needs repo secrets `ASC_KEY_ID`/`ASC_ISSUER_ID`/`ASC_PRIVATE_KEY`; build number auto-managed). Shared scheme `App.xcscheme` committed; stray `.github/workflows/` line removed from .gitignore.
2. **More tab — Apple-Watch-app layout** (`MoreMenuSwiftUI.swift`, `SwiftUIShell.swift`): large title = user's name; glossy **Business pill** (top-left bar button) → switcher sheet filtered by `businessAccess`; **TODAY hero row** (live clock/date/timezone card · rotating alerts card · weekly/monthly progress card); ALL nav groups collapsible (spring chevron, persisted in `alma-more-expanded-groups`).
3. **Web feed `GET /api/assistant/more-pulse`** (`src/app/api/assistant/more-pulse/route.ts` + `src/agent/lib/more-pulse.ts`): owner+staff branched payloads — attendance fines, penalty proposals, unplayed intercom, unread office notifications, unacked AgentOutbox, weekly scorecard + Dhaka-month 60/40 blend. Contract: `{user:{name,isOwner,businessAccess,email,phone,profileImageUrl}, alerts:[{id,kind,title,detail,amount,at}], progress:{weeklyPct,monthlyPct,weeklyLabel,monthlyLabel}}`. Native falls back to `/api/users/me` when agent flag off.
4. **Profile section** (top-right round avatar bar button → sheet): photo upload (PhotosPicker → square-crop/downscale → base64 `POST /api/users/me/profile-image`), Dark Mode + Native স্ক্রিন toggles (moved out of More list), **5 web accent presets** (writes `alma-accent` cookie into shared WKWebsiteDataStore — web restyles on next page load), Face ID row, password change (`POST /api/users/me/password`), name/phone editor (`PATCH /api/users/me`), **email read-only BY DESIGN** (no self-service backend; admin-only via `/api/users/[id]` — do not fake it), sign out (csrf → signout POST → purge `next-auth.session-token` from BOTH cookie jars → `/login`), version footer.
5. **Credit Usage + Logs (OpenRouter-style)** (`CreditUsageSwiftUI.swift` + `GET /api/assistant/usage-logs` + `src/agent/lib/usage-logs.ts`): range presets 15m…1mo + Today/Yesterday/This Week/This Month + custom range + **Live** (10s, pulsing dot); default **Past 1h**; activity histogram + exact whole-window totals (SQL, not page-limited); rows: time/model/role/in/out/**cache tokens only where recorded**/USD cost; tap → full raw-field sheet; keyset load-more. **Latency/TTFT deliberately absent — not stored in `agent_cost_events`.** Cache tokens only on Anthropic-path rows; absence ≠ no cache.
6. **Dashboard bento board** (`DashboardSwiftUI.swift`): dark hero KPI card (revenue count-up + MoM chips + area chart), ring tiles, 2×2 stat tiles, gradient bar chart, dual donuts, sparkline trends, channel bars, product share bars. All previous metrics/actions preserved; motion gated (`dashMotionOK` = !reduceMotion && !LowPower).
7. **PERF PASS (the "slow transitions" fix):** all 42 per-screen auroras: `Circle().blur(radius:70)` → **RadialGradient falloff** (zero blur passes), frame ×1.35, `.onDisappear` pauses drift, drift starts 0.4s AFTER appear. Assistant history drawer prefetches conversations/projects BEFORE the cover mounts. **NEVER reintroduce `.blur` on aurora blobs.** Remaining known (unfixed, optional): WKWebView created synchronously during web pushes (pre-warm pool idea), `ordersGlass` material per-row in long lists.
8. **Bento restyles landed:** **Approvals** (dark pending hero + priority tiles, `Apv*` components), **Expenses**, **Payroll**, **Office Fund** (all reviewed: zero logic-line changes, parse+CI green).

## 4. REMAINING WORK QUEUE (do serially, in this order)

The bento recipe = copy the pattern from `DashboardSwiftUI.swift` (~line 1556-2040: `dashMotionOK`, `DashCountUp(+Text)`, `DashMiniBar`, `DashRing`, `BentoRingTile`, `BentoStatTile`, `bentoWash`, `BentoHeroCard`) or the compact version in `ApprovalsSwiftUI.swift` (`Apv*`, end of file). Per-file PRIVATE copies with a file prefix (repo convention, no cross-file imports). Hero = dark in both schemes (indigo 0.094/0.082/0.157 + violet .32 topLeading + coral .30 bottomTrailing + sage radial hint, white .16 stroke, `.environment(\.colorScheme,.dark)`). Rules per file: keep EVERY metric/field/action/VM/API/`.claudeTopFade()` identical; money via the file's own helpers; LazyVStack/Grid; motion gated; **no new blur/repeatForever/Timers**; forms/chat-like screens get a LIGHT glass pass only, never forced bento.

1. `OrdersSwiftUI.swift` ⚠️ contains the SHARED `OrdersAurora`/`ordersGlass`/`OrdersGlassCard` — restyle the screen, do NOT alter those shared primitives
2. `FinanceSwiftUI.swift` (money-sensitive: presentation only)
3. `InvoicesSwiftUI.swift` (a prior verified attempt was lost to a revert race — its design: dark hero from `totals.amount/count/paid/unpaid` + paid-share mini bar + 2-col tiles + payment-tone row washes)
4. `PaymentAccountsSwiftUI.swift` (counts only — screen has no balances; don't invent)
5. `InventorySwiftUI.swift`, 6. `ActivitySwiftUI.swift` (timeline: tinted icon chips + hairline connectors), 7. `AnalyticsSwiftUI.swift`, 8. `InsightsSwiftUI.swift`, 9. `BriefingSwiftUI.swift` (narrative — light pass), 10. `AuditSwiftUI.swift`, 11. `AttendanceSwiftUI.swift` ⚠️ check-in/face/GPS flows untouched, 12. `EmployeesSwiftUI.swift`, 13. `CrmSwiftUI.swift`, 14. `PortalSwiftUI.swift`, 15. `PortalExpenseSwiftUI.swift`, 16. `BusinessArchiveSwiftUI.swift`, 17. `SupplierImportSwiftUI.swift`, 18. `OrderCreateSwiftUI.swift` (form — light pass), 19-25. `Settings*SwiftUI.swift` ×7 (light pass: stat strip only where counts exist, MoreMenu-style icon-chip rows; Database/Session are sensitive)

Batch rhythm: restyle 2-4 files → parse each → commit+push → after a few batches run ONE CI verification (temp trigger, revert after green).

## 5. MAC SESSION PROTOCOL (owner pastes this file there too)

**Everything ships as ONE TestFlight build — batch, never drip (CLAUDE.md hard rule).**

1. `git fetch origin && git checkout claude/ios-swiftui-design-build-dw04ik && git pull`
2. Check `native/aurora-motion` for post-b1fb239 commits → merge into THIS branch if any (§0), resolve, re-push.
3. **Simulator self-test EVERYTHING before the owner sees it** (iPhone 17 Pro Max, udid in memory `reference_ios_sim_access`): build, install, then walk §6's checklist yourself — screenshot each item (`xcrun simctl io <udid> screenshot`), both light+dark for restyled pages. Fix everything found; batch fixes.
4. Web side is additive-only (`more-pulse`, `usage-logs` routes) — merged to main it deploys automatically; the native screens degrade gracefully until then (More falls back to `/api/users/me`; Logs pane shows an error/empty state — check both states once).
5. Bump build number, upload ONE TestFlight build (Mac xcodebuild path or the `ios-testflight.yml` Action once secrets exist).
6. Real-device-only checks for the owner: Face ID hardware, push, keyboard feel, transition smoothness (the perf pass targets exactly this — owner should feel page pushes lighter).

## 6. OWNER'S DEVICE-TEST CHECKLIST (বাসায় এক এক করে টিক দিন)

**More ট্যাব:** □ বড় টাইটেলে নিজের নাম □ বাঁ-উপরে Business পিল → শীট → বিজনেস সুইচ □ TODAY কার্ড ৩টা: ঘড়ি/তারিখ/টাইমজোন · Alerts (ফাইন/মিসড কল/নোটিফিকেশন ঘুরে ঘুরে) · Weekly-Monthly প্রগ্রেস বার □ গ্রুপ ট্যাপে খোলে/বন্ধ হয়, অ্যাপ রিস্টার্টে মনে থাকে
**Profile (ডান-উপরের গোল ছবি):** □ ছবি আপলোড/চেঞ্জ (ক্যামেরা ব্যাজ) □ Dark Mode + Native স্ক্রিন টগল এখানে □ ৫টা Accent রং — সিলেক্ট করে যেকোনো ওয়েব পেজ খুলে দেখুন (পরের লোডে রং বদলায়) □ Face ID টগল □ Password চেঞ্জ (ভুল current দিলে বাংলা এরর) □ নাম/ফোন এডিট □ Email lock-করা (ইচ্ছাকৃত) □ সাইন আউট → লগইন পেজ
**Credit Usage → Logs:** □ ডিফল্ট Past 1 hour □ রেঞ্জ মেনু + কাস্টম রেঞ্জ □ Live চিপ (সবুজ ডট, ১০ সেকেন্ডে রিফ্রেশ) □ রো-তে টোকেন/ক্যাশ/কস্ট, ট্যাপে ফুল ডিটেইল □ "আরো দেখুন"
**Dashboard:** □ ডার্ক হিরো কার্ডে নাম্বার কাউন্ট-আপ □ রিং/টাইল/ডোনাট/স্পার্কলাইন □ আগের সব সংখ্যা আছে কিনা মিলিয়ে দেখুন
**Approvals / Expenses / Payroll / Office Fund:** □ ডার্ক হিরো + টাইলে আগের সংখ্যাগুলোই □ Payroll-এর টাকার অঙ্ক আগের সাথে হুবহু মিলছে (গুরুত্বপূর্ণ!)
**পারফরম্যান্স:** □ পেজ পুশ/ব্যাক আগের চেয়ে হালকা □ Assistant-এর হিস্ট্রি ড্রয়ার স্মুথ □ Low Power Mode-এ অ্যানিমেশন বন্ধ থাকে
**(নতুন সেশন আরো পেজ করলে):** □ সেই পেজগুলোও একই ভাবে — সংখ্যা মিলিয়ে + লাইট/ডার্ক দুটোতেই

## 7. DECISIONS / CAVEATS LOG (don't re-litigate)

- Email self-change: intentionally read-only (no backend; security). Future: additive owner-approved route if asked.
- Logs: latency/TTFT not shown because never stored; cache tokens shown only where recorded — accuracy over completeness (owner demanded accuracy).
- Accent colors: native writes the cookie; live pages restyle on next load (same one-way native→web model as dark mode). Instant-all-tabs would need a webview JS broadcast — not built yet.
- Aurora perf recipe (§3.7) is the law for any new screen background.
- `/api/agent/*` untouched; `AGENT_ENABLED` gate respected on both new assistant routes.
- TestFlight quota: both workflows manual — sim checks never touch TestFlight; upload only via explicit run.
