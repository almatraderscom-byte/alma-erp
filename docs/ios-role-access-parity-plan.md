# iOS Role / Permission Parity — Diagnosis + Plan

Date: 2026-08-22 · Branch: `claude/ios-user-permission-nav-97f3b3` · Status: **diagnosis done, awaiting owner go**

## 1. Owner report

"Native iOS app e user access onujayi nav button ba feature hoy na — web e jei user jei permission
ache she only segulo dekhte pay, iOS native e nai."

## 2. How the web decides what a user sees (the authority)

| Layer | File | What it does |
|---|---|---|
| Role model | `src/lib/roles.ts` | `AlmaRole` = SUPER_ADMIN / ADMIN / HR / STAFF / VIEWER; `isPathAllowedForRole(path, role, business)`; `filterNavByRole(...)`; `can(role, capability)` (CAPABILITIES table: ordersAdvanceStatus, crmWrite, inventoryWrite, expenseWrite, payrollWrite, employeeWrite, userManage, advanceApprove, cditAdminWrite, …) |
| Business model | `src/lib/businesses.ts` | `getNavForBusiness(business)` — three different nav lists (Lifestyle / CDIT / Trading); `isRouteAllowed(path, business)` |
| Business access | `src/lib/business-access.ts` | `businessAccess` column on User ("ALMA_LIFESTYLE,ALMA_TRADING,…") → which businesses the user may switch to |
| Session | `ActorContext` + `BusinessContext` | role from NextAuth session, business from sessionStorage limited to `allowedBusinessIds`; client redirects off disallowed paths |
| Server gate | `src/proxy.ts` | page redirect via `isPathAllowedForRole`; API 403 via `apiRoleDenied` + `businessAllowed` |
| Nav UI | `Sidebar.tsx` | desktop sidebar + mobile bar + Account drawer all render `filterNavByRole(getNavForBusiness(business), role, business)` |
| Home | `src/app/page.tsx` | owner/admin → P&L dashboard; STAFF / HR / VIEWER → `RoleDashboard` (no revenue) |

Net effect on web: every nav item, every page, and every write button is role × business gated.

## 3. What iOS native does today

| Surface | File | Finding |
|---|---|---|
| Tab bar | `ios/App/App/SpikeNativeShell.swift:1253` | Hard-coded `Dashboard / Orders / Assistant / Approvals / More` for **every** user. No role read. |
| More menu | `ios/App/App/MoreMenuSwiftUI.swift:45-95` (SwiftUI) and `SpikeNativeShell.swift:1028` (UIKit fallback) | Static super-admin catalog: Finance, Expenses, Payroll, Users, Branding, Database, Audit, Agent Hub, Creative Studio, Archive… shown to everyone. Only the **business switcher sheet** filters by `allowedBusinessIds`. |
| Identity | `MoreVM` (isOwner + businessAccess), `OrdIdentity` (Orders), `PortalVM`, `SettingsSession`, `SwiftUIShell` tab-name fetch | Five separate ad-hoc `/api/users/me` / `more-pulse` fetches; **no shared session object**, no `role` anywhere at shell level. |
| Route guard | `AlmaNavCoordinator.swift` / `AlmaNativeRouter.swift` | Decides native-vs-web only. **Zero access check** — deep links, notification taps, Dashboard shortcuts, Assistant link-outs all open any screen. |
| Home tab | `DashboardSwiftUI.swift` | Always the **owner P&L** (`/api/dashboard`, which has no role gate in `proxy.ts`). Web shows STAFF/HR/VIEWER a no-revenue `RoleDashboard`. → VIEWER and the all-business STAFF account can read Lifestyle revenue/profit natively. |
| Business | every native screen | `business_id` hard-coded (`ALMA_LIFESTYLE` in Crm/Expenses/Employees/Attendance/Analytics…; `CREATIVE_DIGITAL_IT` in Digital*). No "current business" concept natively; switching business just pushes a **web** page. |
| Write buttons | only `OrdersSwiftUI` ports `order-access.ts`; Trading screens none (Android has `canManage`) | CRM / Inventory / Expenses / Payroll / Employees / Users / Approvals show write UI to all roles; server returns 403 → confusing error instead of hidden button. |
| Dashboard shortcut dock | `DashboardSwiftUI.swift:121` | "owner probe" = fetch a SUPER_ADMIN-only route and see if it 403s. Hack; only knows owner vs not. |

**Android already has the fix** (`android/.../shell/AlmaAccess.kt` = 1:1 Kotlin port of `isPathAllowedForRole`; `AlmaSession.kt` = shared role/owner/businessAccess; `NativeShell.kt` filters `ALL_TABS` by `canSee(gatePath)`; `MoreMenuScreen.kt` drops items + empty groups). Its own header says: *"iOS build-66 had the same gap — only the owner ever used it."* iOS was never given the port.

Android drift warning: `AlmaAccess.kt` says `/settings/notifications` = SUPER_ADMIN/ADMIN, web now says *everyone*. Hand-ported rules rot → the iOS plan needs a machine-checked contract (§5 step 3).

## 4. Who is affected (prod `User` table, 2026-08-22)

| role | businessAccess | active | count |
|---|---|---|---|
| SUPER_ADMIN | Lifestyle, CDIT | yes | 1 |
| ADMIN | Lifestyle | yes | 1 |
| STAFF | Trading only | yes | **3** |
| STAFF | all three | yes | 1 |
| VIEWER | all three | yes | 1 |
| STAFF | Lifestyle | no | 2 |

So the three Trading staff open the app and get: Lifestyle P&L tab (403 → error card, because business not permitted), Lifestyle Orders tab, the owner's AI Assistant tab (`/agent` is SUPER_ADMIN-only on web), Approvals, and a More menu listing Finance/Payroll/Users/Branding/Audit. What web gives them: `Trading / Telegram / My desk / Office` only.

## 5. Plan — make iOS identical to web

Principle: **the web's `roles.ts` + `businesses.ts` are the single authority; iOS carries a port that is proven equal by a generated fixture, and every nav decision passes through one gate.** Server stays the real enforcer; iOS only stops OFFERING what the user can't use.

### Step 1 — `AlmaSession.swift` (shared identity)
- One `@Observable` singleton: `role: AlmaRole?`, `isOwner`, `businessAccess: [BusinessId]`, `userId`, `name`, `authed: Bool?` (tri-state like Android), `authVersion`.
- Source: `GET /api/users/me` (role, isSystemOwner) + `GET /api/assistant/more-pulse` (businessAccess). Both exist already.
- `effectiveRole`: owner → SUPER_ADMIN; loaded → normalized; **not loaded → least privilege** (nothing privileged ever flashes).
- Reload on: launch, `NativeLoginScreen.onSuccess`, `.almaAuthenticationDidRestore`, foreground after `authExpiredNotification`; clear on native sign-out (`MoreProfileSheet.signOut`). Account switch resets owner flag first.
- Replace the 5 ad-hoc identity fetches (`MoreVM`, `OrdIdentity`, `PortalVM`, `SettingsSessionVM`, More-tab title) with this one.

### Step 2 — `AlmaAccess.swift` (1:1 port of the web rules)
- `AlmaRole`, `BusinessId`, `normalizeAlmaRole`, `isRouteAllowed(path, business)`, `isPathAllowedForRole(path, role, business)` (with the `isRouteAllowed` pre-check the web does), `filterNavByRole`, `TRADING_STAFF_NAV_HIDE`, `roleHomePath`, `can(role, capability)` with the full CAPABILITIES table, `canManageCatalogImages`.
- `AlmaNav.swift`: port of `getNavForBusiness` — the three nav lists with the same hrefs/labels/order as `businesses.ts` (ALMA_NAV / CDIT_NAV / Trading), so the More menu IS the web nav, not a parallel hand-written catalog.

### Step 3 — Contract fixture + CI check (stops drift)
- `scripts/gen-access-contract.mjs` (runs via `tsx`, imports real `roles.ts`/`businesses.ts`) → writes `ios/access-contract.json`: for every role × business × every nav href + every `src/app/**/page.tsx` route → `allowed: true/false`, plus the filtered nav list per role × business, plus the CAPABILITIES table.
- Swift XCTest in `AppParityV2Tests/AccessContractTests.swift` loads the JSON and asserts `AlmaAccess` gives identical answers for every row.
- `scripts/ios-access-contract-check.mjs` (same shape as `iosp0-route-contract-check.mjs`) fails CI when the JSON is stale vs `roles.ts` (regenerate + diff), and when any More-menu `path:` literal is not a web nav href.
- Android can later consume the same fixture (not in this batch).

### Step 4 — Current business, natively
- `AlmaBusiness.current` (UserDefaults, mirrors web `alma-business-id`), always clamped to `AlmaSession.businessAccess` (web rule: stored if allowed, else first allowed). Default for a single-business user = that business (so Trading staff land on Trading).
- Business switcher sheet sets `AlmaBusiness.current` + rebuilds tabs (today it pushes a web page).
- Native screens stop hard-coding `business_id`: Finance suite (Finance / Expenses / Employees / Attendance / Payroll / Analytics / Portal / Approvals) read `AlmaBusiness.current`. Orders / CRM / Inventory are Lifestyle-only pages (web `isRouteAllowed` already says so) and stay as is.

### Step 5 — Tab bar from the filtered nav
- Tabs become a function of `(effectiveRole, currentBusiness)`; rebuilt in place via the existing `onSwiftUIFlagChanged` mechanism whenever `authVersion` or business changes; selected index falls back to tab 0 if its tab disappears (Android pattern).
- Pinned-order table (first four allowed, then More):
  - Home → owner/admin: business dashboard (Lifestyle P&L / `TradingHomeScreen` / `DigitalHomeScreen`); STAFF/HR/VIEWER: **native `RoleDashboard` port** of `page.tsx` (no revenue), HR home = Employees (web `roleHomePath`).
  - Then, in web nav order, the first allowed of: Orders · Trading · CDIT Clients · Assistant (`/agent`, SUPER_ADMIN only) · Approvals (badge only when present) · Invoice · Telegram · Attendance · Payroll · My desk.
  - Expected results: SUPER_ADMIN Lifestyle = unchanged 5 tabs; ADMIN = Dashboard / Orders / Approvals / Invoice / More; Lifestyle STAFF = Desk / Orders / Invoice / My desk / More; Trading STAFF = Trading / Telegram / My desk / Office / More; HR = Employees / Attendance / Payroll / My desk / More; VIEWER = Desk / Orders / Analytics / My desk / More.
- Approvals badge timer + `approvalsTabIndex` become index-lookups, not a constant.

### Step 6 — More menu = web nav
- Groups built from `filterNavByRole(getNavForBusiness(current), role, current)`; items not in the web nav (Phone Companion, কল হিস্টরি, Agent Loader, Live Watch, Agent Hub, Creative Studio) keep their explicit gate (`/agent` → SUPER_ADMIN). Empty groups vanish. Same change for the UIKit fallback `MoreMenuViewController`.
- Profile sheet "Owner / Staff" badge becomes the real role label (web shows `role.replace('_',' ')`).

### Step 7 — One access gate at the nav decision point
- `AlmaNavCoordinator.decide(path)`: before native/web classification, `guard AlmaSession.canSee(path, business)` else `.denied` → Bangla alert "এই পেজে আপনার অ্যাক্সেস নেই" + telemetry `route.denied`. Covers More rows, Dashboard shortcuts (delete the owner-probe hack), notification taps (`onOpenPath`), `almaerp://` intents, App Intents/Siri, Assistant link-outs, and the `PortalStaffOffice` links.
- Root-tab selection via deep link is also gated (a Trading staff tapping a `/orders` push must not land on Orders).

### Step 8 — Screen-level capability gates (web `can()` parity)
Replace per-screen role hacks with `AlmaSession.can(.x)`:
- Orders / OrderCreate: already ported → switch to shared session.
- CRM (`crmWrite`), Inventory + Supplier import (`inventoryWrite`), Expenses + Portal expense (`expenseWrite`), Payroll (`payrollWrite`), Employees (`employeeWrite`), Settings/Users (`userManage`), Approvals advance decisions (`advanceApprove`), Digital clients/projects/invoices (`cditAdminWrite`), Branding (`brandingWrite`), Trading accounts/targets/HR/telegram (`canManage` = SUPER_ADMIN/ADMIN, as Android), Settings/Notifications admin broadcast section (SUPER_ADMIN/ADMIN), Catalog images delete (SUPER_ADMIN).
- VIEWER: every write control hidden (web/proxy: VIEWER is read-only on all writes).

### Step 9 — Server-side leak hardening (web, separate tiny PR, owner approval)
- `/api/dashboard` (Lifestyle P&L) and `/api/analytics`-class reads currently have no role check in `apiRoleDenied`; web only hides them in UI. Add owner/admin gate so a native or curl caller can't read revenue. Not needed for the iOS parity itself, but it is what the owner's "only what they have access to" really guarantees.

### Step 10 — Proof before TestFlight (CLAUDE.md rule)
- Unit: `AccessContractTests` green (every role × business × route).
- Sim: one account per role. Prod has no usable non-owner credentials for Claude; use the **demo instance** (`alma-erp-demo`, fake data — `AlmaBackend` switch already in the app) with one user per role × business created there, or the owner creates preview test users on `/settings/users`. Screenshot per role: tab bar, More menu, Home, a denied deep link, a hidden write button.
- Chrome `?native=1` check not needed (all native UI).
- Then ONE TestFlight build (owner go required first).

## 6. Scope / files (iOS unless noted)

New: `AlmaSession.swift`, `AlmaAccess.swift`, `AlmaNav.swift`, `RoleDashboardSwiftUI.swift`, `AppParityV2Tests/AccessContractTests.swift`, `ios/access-contract.json`, `scripts/gen-access-contract.mjs`, `scripts/ios-access-contract-check.mjs`.
Edited: `SpikeNativeShell.swift` (tabs, UIKit More, badge index), `SwiftUIShell.swift` (tab builders, onOpenPath, tab rebuild), `MoreMenuSwiftUI.swift`, `AlmaNavCoordinator.swift`, `DashboardSwiftUI.swift`, `NativeLoginSwiftUI.swift`, the Step-4 business-id screens, the Step-8 screens, `AlmaAppIntents.swift`, `.github` workflow for the contract check. Web touch limited to Step 9 + the generator script (no ERP behaviour change).

Suggested batching: **PR-1** = Steps 1-3 + 5-7 (nav parity, the owner-visible fix). **PR-2** = Step 4 (business-aware native). **PR-3** = Step 8 (write gates). **PR-4 (web)** = Step 9. One TestFlight after PR-1..3 are sim-proven.
