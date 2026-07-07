# DASHBOARD — Native Redesign Handoff (owner-directed, 2026-07-07)

**Branch:** `native/dashboard`   ·   **Do NOT merge to `main`.**
This file is the source of truth for whoever continues the ALMA Lifestyle **dashboard** work.
Everything described below is **committed on this branch** — check it out / build it as a reference.

---

## 0. Owner's decision (2026-07-07) — READ THIS FIRST

The owner reviewed the native SwiftUI dashboard built on this branch and decided:

1. **The design is NOT fully approved.** The owner did **not** like the overall layout of the
   native dashboard as built. Treat the current `DashboardSwiftUI.swift` as a *reference /
   starting point*, **not** the final design.
2. **The one thing the owner LIKED = the assistive-touch floating button** (the ✨ shortcut
   dock, like the Agent section). Keep this concept — see §3.
3. **New direction — keep ALL the web-dashboard content, redesign only the LAYOUT:**
   Keep **everything** from the **current web dashboard** (`src/app/page.tsx` `LifestyleDashboard`)
   — every KPI, chart, list, number, and piece of data. **Nothing may be lost.** Only the
   **layout / presentation** gets elevated to a **next-level iOS design**.
4. **Process (mandatory — do NOT skip):**
   - Iterate the design **FIRST as a live HTML mockup in the artifact / Claude-preview**.
   - The owner reviews it live and **CONFIRMS**.
   - **Only after the owner confirms** do you write the **SwiftUI** code.
   - ❌ Do **not** jump straight to SwiftUI. Order is: **design (artifact) → owner confirm → SwiftUI.**

---

## 1. Content source of truth = the CURRENT WEB DASHBOARD

The redesign must preserve **100% of** the web dashboard's content. Do not invent or drop anything.

- Page: **`src/app/page.tsx`** → `LifestyleDashboard`
- Server aggregation: **`src/lib/lifestyle/dashboard.ts`** (`getLifestyleDashboard` → `metricsToDashboard`)
- API the native screen calls: **`GET /api/dashboard?business_id=ALMA_LIFESTYLE&startDate&endDate`**
- Types: **`src/types/index.ts`** (`DashboardData`)

**Component checklist that MUST survive the redesign** (top → bottom of the web page):
- Header: "Dashboard" + range label + Live/connection status
- Error banner + SLA banner ("N orders need attention" + View all)
- Date-range filter (Today / Yesterday / Last 7 / Last 30 / This month / Last month)
- Hero KPIs: Revenue, Net Profit, Total Orders, Delivered (+delivery rate)
- Compact KPIs: Return Loss, Return Rate, Pending, Realized Profit
- Charts: Daily Sales, Monthly Revenue (bars+profit), Revenue & Profit Trend (dual line),
  Order Status (donut + value grid), Category Mix (donut + legend), Orders by Channel (bars)
- Top Products (rank, orders/pcs, size line, revenue+profit)
- Recent Orders (id, customer/product, status badge, price)
- SLA breach detail card

> Owner-facing runtime rule: **all numbers/amounts in pure Bangla** (৳৫৮,৪৫০ · ২৬ · ৮৫% · ৮টি বাকি),
> money via a Bangla formatter (never touch the shared `AlmaSwiftTheme.takaShort`).

---

## 2. What is ALREADY built on this branch (reference implementation)

`ios/App/App/DashboardSwiftUI.swift` (committed) currently contains a working native dashboard:

- **Hosting:** `DashboardHostController` keeps the Capacitor bridge mounted BEHIND the native
  screen (push / reminders / N1–N5 stay alive) with an opaque backing so the webview never
  bleeds through on scroll. `makeDashboardTab()` in `SwiftUIShell.swift` wires tab 0.
- **Theme:** exact app tokens — `DashAurora` = the signature aura (light lavender→cream→rose;
  dark indigo→violet→magenta→rose), `dashGlass`, `DashPalette` (coral/violet/sage + chart hexes).
- **Nav title:** centred inline UIKit "Dashboard" (no in-scroll header, no subtitle) — matches
  the other native pages.
- **`claudeTopFade(useNativeEdgeEffect: false)`** — manual masked-blur top fade (like Orders).
- **KPI bento:** big Revenue hero + sparkline, Net Profit, Delivered **ring**, Total Orders,
  Realized Profit + 3 mini chips; real month-over-month trend chips (guarded, honest data).
- **Pure-Bangla numbers** everywhere (helpers `bnD` / `bnN` / `bnTk` / `bnPct` in the file).
- **Owner To-Do** (`OwnerTodoBar` + `OwnerTodoVM`): the production `/api/assistant/todos`
  feature as a small top-right **chip → glass dropdown**; SUPER_ADMIN-gated (route 403s for
  everyone else → chip hidden); tap = mark done (stays checked), separate 🗑️ = delete; smooth
  solid-panel motion + haptics.
- Charts / Top Products / Recent Orders / SLA — full parity with the web page.
- DEBUG sim hooks (env-guarded, never fire in production): `ALMA_DASH_APPEARANCE`,
  `ALMA_DASH_ANCHOR`, `ALMA_DASH_TODO_OPEN`.

**Use this as the reference for what the data/logic layer already does. The LAYOUT above it is
what the owner wants re-imagined.**

---

## 3. The assistive-touch button (the part the owner LIKED — carry it forward)

- **Reference implementation:** `AgentAssistiveNav` (a `UIView`) in
  `ios/App/App/SpikeNativeShell.swift` (used by the Agent section): a 56pt frosted FAB pinned
  bottom-right, draggable with AssistiveTouch spring physics + idle-fade; tap → radial fan of
  frosted disc shortcuts (+ → × rotate, dimmed backdrop).
- **Owner's spec for the dashboard version** (already demoed in HTML and approved by the owner):
  - Same look/behaviour as the agent dock, PLUS an **Edit** option.
  - Owner can add **his own shortcuts, max 5**, from any ERP page.
  - **Role-based:** Super Admin / Admin / Staff each see only the pages their role can access.
- **NOT yet built in SwiftUI** — it must be added in the redesign (after the layout is confirmed).

---

## 4. Server change on this branch (additive, already committed)

`src/lib/lifestyle/dashboard.ts` + `src/types/index.ts` add `daily_trend`, `top_products`, and
keep `pending_count` in the `/api/dashboard` response (purely additive; the web page aggregates
client-side so it never read these). **Needs a production deploy** for the native Daily Sales,
Top Products, and the Revenue-hero sparkline to fill — until then they show their empty state.

---

## 5. Key files

| Purpose | Path |
|---|---|
| Native dashboard (reference) | `ios/App/App/DashboardSwiftUI.swift` |
| Tab wiring | `ios/App/App/SwiftUIShell.swift`, `ios/App/App/SpikeNativeShell.swift` |
| Route → native map | `ios/App/App/AlmaNativeRouter.swift` |
| Xcode registration | `ios/App/App.xcodeproj/project.pbxproj` |
| Assistive-touch reference | `ios/App/App/SpikeNativeShell.swift` (`AgentAssistiveNav`) |
| **Web dashboard (content source of truth)** | `src/app/page.tsx` |
| Server aggregation + fields | `src/lib/lifestyle/dashboard.ts`, `src/types/index.ts` |

---

## 6. TL;DR for the next session
1. **Do not** treat the current native layout as final — the owner wants it re-imagined.
2. Keep **every** piece of the web dashboard's content; only elevate the **layout**.
3. Keep the **assistive-touch button** (add Edit + max-5 + role-based).
4. **Design in an artifact first → owner confirms → then write SwiftUI.** Never skip the confirm.
5. All numbers in **pure Bangla**; theme/aura stays **exactly** as the app's tokens.

_Same-sim caveat: both sessions install `com.almatraders.erp` to the same simulator; the last
install wins (overwrites the other). Run one session's build on the sim at a time._
