# ALMA ERP Web → Native iOS Deep Parity Audit & Execution Roadmap

> Prepared for end-to-end execution by Claude.  
> Audit date: 2026-07-17 (Asia/Dhaka)  
> Scope: current ALMA ERP web product versus the native SwiftUI iOS app, including route reachability, feature/action parity, information architecture, privileged workflows, uploads, exports, and runtime UX.

---

## 0. Executive verdict

The native app has broad **route coverage**, but it does **not** yet have full feature/action parity. The current route checker reports:

- 61 `native-required` routes
- 5 `temporary-web` routes
- 3 `public-web-allowed` routes
- 69 route fixtures covering 66 web routes

That result is technically correct at the route/screen level, but it is too optimistic for product parity. A native SwiftUI screen can exist and still expose only the read side or a small subset of the web controls. The clearest example is `/agent/staff-monitor`:

- Web: full owner control center, autonomy controls and SLOs, per-model toggles, heartbeat timeline and actions, live-browser screenshot and step feed, five monitor tabs, alerts, quick actions, staff capabilities, geo-fence controls, staff-task toggles, feed escalation, approvals, health scan, auto-fix, trust rules, brain stats, duty/Salah/voice settings, services, deploy/retrigger, and history.
- iOS: staff summaries, KPI cards, staff detail, master agent pause/resume, emergency live-browser stop/resume, and reduced read-only heartbeat/model summaries. Most of the real control room remains behind a small web escape.

The user's visual concern is also confirmed: on the tested iPhone the Monitor page spends too much vertical space on a large Control Center card and then leaves a large empty state. It does not behave like a compact mobile control room.

This roadmap therefore replaces route-only parity with **route + section + action parity**. The first three implementation phases are dedicated to rebuilding LIVE Business Monitor properly.

### Priority summary

| Priority | Outcome |
|---|---|
| P0 | Compact, complete native LIVE Business Monitor; native Live Watch integration; discoverable Agent Hub; action-level parity contract |
| P1 | Native auth recovery, privileged admin/bulk workflows, trading money/admin gaps, portal proof workflows |
| P2 | Remaining media, document, export, settings, and contextual UX gaps |
| P3 | Remove stale web escapes/comments, harden accessibility/performance, final regression and release |

---

## 1. Audit baseline and evidence

### 1.1 Source baseline

- Local `origin/main` audited at: `08893a3d1d36743e0339b13aaa01b97e4519825d`
- Commit title: merge of PR #433 (`fix/garment-prep-whiteout`)
- The latest available main worktree was on branch `ios-build-77`.
- The audit was read-only. Existing unrelated dirty worktree changes were not modified.

### 1.2 Runtime baseline

- Logged-in web preview inspected at `/agent` and `/agent/staff-monitor`.
- The preview UI exposed build badge `preview · 03cf910`.
- Native runtime inspected on the approved simulator:
  - Device: iPhone 17 Pro Max
  - Simulator UDID: `9E51818A-AA25-4C9F-9C1F-9EE2D99E2998`
  - Installed app: `com.almatraders.erp`
  - Installed build: 75
- The source baseline is newer than the installed simulator build. The current main delta after the previously audited iOS commit was worker/photo-cleanup only, but Phase 0 must still revalidate the final latest SHA, deployed web build, and installed iOS build before implementation.

### 1.3 Evidence sources

- Web routes and components under `src/app`, `src/agent/components`, and `src/components`.
- Native routing and SwiftUI implementations under `ios/App/App`.
- `ios/route-contract.json` and `scripts/iosp0-route-contract-check.mjs`.
- Existing IOSP reports and exception ledger under `docs/`.
- Logged-in web DOM and visual inspection.
- Installed iOS simulator visual inspection.

### 1.4 Important audit caveat: comments are stale

Several Swift file headers still say “read-only” even though native mutations were added later. Claude must inspect current methods and UI wiring, not trust the top-of-file description. Confirmed examples:

- `KnownPeopleSwiftUI.swift` now has native settings, add/edit/photos/toggle/delete/test.
- `CreditUsageSwiftUI.swift` now has native budget writes.
- `SettingsSmsSwiftUI.swift` now has native enable/types/test/retry/report.
- `SettingsTelegramSwiftUI.swift` now has process/test/retry/master-enable actions.
- `TargetControlSwiftUI.swift` now has create/action/delete/settings writes.
- `TradingAccountsSwiftUI.swift` now has create/edit/archive.
- `TradingHrSwiftUI.swift` now has profile/report writes.
- `TradingStaffSwiftUI.swift` now has native upsert.
- `DigitalClients`, `DigitalProjects`, and `DigitalInvoices` now have major native creation/payment/PDF actions.
- `PortalSwiftUI.swift` now has native front-camera + GPS check-in/check-out.
- `ExpensesSwiftUI.swift` now has receipt upload and PDF/CSV export.
- `PayrollSwiftUI.swift` now has PDF/CSV export.

Phase 0 must clean these comments and generate an executable action ledger so they cannot drift again.

---

## 2. Parity policy

Use these classifications for every web route, section, and action.

### N — Native required

Internal ALMA workflows must be implemented in SwiftUI and call the existing authenticated API through `AlmaAPI`. A full internal WKWebView is a failure.

### H — System handoff allowed

Only these classes may leave the app:

- OAuth consent through `ASWebAuthenticationSession`
- public invoice/share URLs
- privacy policy and app-download pages
- external phone, WhatsApp, Maps, mail, or system share destinations
- a hosted PDF may be displayed with native Quick Look/PDFKit and shared through the system sheet

An internal ALMA page is not a valid “handoff.”

### W — Public web allowed

The existing public routes remain web by design:

- `/app/download`
- `/invoice/share/[slug]`
- `/privacy-policy`

### R — Remove/retire

Developer/demo routes should not be ported merely to improve a count. Remove them from production navigation and contracts where appropriate.

---

## 3. Master open-parity ledger

Status meanings:

- **MISSING**: no native route or no native feature implementation.
- **PARTIAL**: native screen exists, but meaningful sections/actions still require web.
- **ROUTING**: native capability exists but deep link/coordinator still opens web.
- **UX**: capability exists but discoverability or mobile composition is materially below the web product.

### 3.1 Agent and authentication

| ID | Surface | Current native state | Verified missing/partial work | Priority |
|---|---|---|---|---|
| AG-01 | `/agent/staff-monitor` mobile composition | PARTIAL + UX | Current vertical page is oversized. It needs compact sticky status, five tabs, progressive disclosure, useful first fold, no large empty spacer, and safe placement around the floating Agent control. | P0 |
| AG-02 | Agent Control Center | PARTIAL | Native only changes `paused`. Add autonomy mode and capability toggles from the current web control contract; show server-echoed state and confirmations. | P0 |
| AG-03 | Autonomy SLO | MISSING | Add `/api/assistant/controls?section=slo` invariants, class rollout/stage/sample/error data, and degraded-state warnings. | P0 |
| AG-04 | Model controls | PARTIAL | Native displays only an enabled count. Add searchable/grouped per-model state and PATCH actions matching `ModelTogglePanel`. | P0 |
| AG-05 | Heartbeat | PARTIAL | Native displays reduced status only. Add full wake history, enable/pause and “test now” actions matching GET/POST `/api/assistant/heartbeat`. | P0 |
| AG-06 | Live browser | PARTIAL | Native has emergency stop/resume only. Add connected devices, latest screenshot, live step feed, timestamps/status/failures, and proper polling. | P0 |
| AG-07 | Monitor Overview/Agents/Staff/Feed/System | PARTIAL | Add all five tabs and the missing web blocks/actions listed in Section 4. | P0 |
| AG-08 | `/agent/live-watch` | MISSING route | It remains temporary web. Integrate it as Monitor → Live Browser and make the deep link select that native tab. Keep one canonical native implementation. | P0 |
| AG-09 | Agent navigation/discoverability | UX | Floating Agent menu has Chat/Studio/WhatsApp/Monitor/Costs only. More menu hides Monitor, WhatsApp, Growth, and Trading Staff in inconsistent groups. Build one native Agent Hub and keep radial navigation as a shortcut, not the only entry point. | P0 |
| AG-10 | `/agent/growth` | PARTIAL | Status is native; Google connect/disconnect is not. Use `ASWebAuthenticationSession` for connect and native DELETE for disconnect, then refresh status. | P1 |
| AG-11 | `/agent/costs` | PARTIAL | Spend, logs, balances, custom ranges, refresh, and budgets are native. Add exact CSV export/share; verify native usage log totals against the web cost ledger. | P2 |
| AG-12 | Creative Studio | PARTIAL | Most create/gallery/video/audio/library/settings/finish flows are native. Remaining true gaps: drag/resize Lifestyle Editor and any still-live Drive authorization/tool rows that open the entire web Studio. Port editor controls; OAuth may use system auth. | P2 |
| AG-13 | `/agent/creative-studio-demo` | R | Temporary dev/demo route. Remove from production navigation/route contract rather than porting it. | P2 |
| AU-01 | `/forgot-password` | MISSING | Build native email submission, neutral success state, error handling, accessibility, and anti-enumeration copy. | P1 |
| AU-02 | `/reset-password` | MISSING | Handle universal/custom deep link token securely, validate expiry, submit password, clear sensitive state, and return to native login. | P1 |

### 3.2 Privileged admin, settings, and bulk workflows

| ID | Surface | Current native state | Verified missing/partial work | Priority |
|---|---|---|---|---|
| AD-01 | `/settings/users` | PARTIAL | Native is read-only. Add create, edit name/role/business access/HR link/active state, permissions view, and admin reset-password. Preserve role gates and require confirmation for deactivation/reset. | P1 |
| AD-02 | `/inventory/supplier-import` | PARTIAL | Native only shows catalog/batch-like state. Add paste/file/clipboard input, JSON validation, preview diff, duplicate warnings, selectable commit, progress, and result summary for `/api/supplier-import/commit`. | P1 |
| AD-03 | `/operations/business-archive` | PARTIAL | Native is read-only. Add dry-run preview, typed confirmation, execute, restore batch, progress, audit result, and strict Super Admin gate. | P1 |
| AD-04 | `/operations/system-diagnostics` | PARTIAL | Native is read-only. Add Process queue, Retry failed, Retry single, per-action spinner, response counts, and reload. | P1 |
| AD-05 | `/portal/payment-accounts` | PARTIAL | Native is read-only masked cards. Add mobile/bank account creation, edit/upsert, set default, secure reveal/hide, and delete. Sensitive reveal/delete must use Face ID or device authentication plus server authorization. | P1 |
| AD-06 | `/settings/branding` | PARTIAL | Logo/favicon upload is native. Add editable company/tagline/phone/email/site/address/Facebook, primary/secondary/accent colors, invoice prefix, watermark enable/opacity, and footer fields with save validation. | P1 |
| AD-07 | `/settings/telegram-ops` | PARTIAL | Native has process/test/retry/master enable. Add owner chat IDs, full schedule values, alert toggles, and server-echoed save states. | P1 |
| AD-08 | `/settings/notifications` | PARTIAL | Broadcast composer/stats are native. Add web-equivalent device push-health surface from `/api/notifications/push-health?scope=all`. | P2 |
| AD-09 | `/settings/session` | ROUTING/UX | Name, phone, profile photo, password, Face ID lock already exist in the native More profile sheet. Replace the session page's web escape with an in-app presentation/deep link to that sheet or embed the same native controls. | P2 |

`/settings/database` is **not** an action gap: the current web page only reads status and refreshes. Do not invent destructive database controls.

### 3.3 Trading and finance

| ID | Surface | Current native state | Verified missing/partial work | Priority |
|---|---|---|---|---|
| TR-01 | Trading account detail | PARTIAL | Account create/edit/archive and global trade/expense/capital/screenshot entry are native. Detail still lacks trade audit history, trade edit, delete request, approve/reject delete, full screenshot history, daily summary editing, and contextual actions. | P1 |
| TR-02 | Partnership settlement | MISSING | Add preview, unsettled expenses, override, wallet-post option, confirm settlement, and settlement history. This is money-sensitive and requires before/after server verification. | P1 |
| TR-03 | Trading Telegram drafts | PARTIAL | Single approve/reject/reopen/delete-request exists. Add draft edit and bulk confirm/reject with selection and exact server response counts. | P1 |
| TR-04 | Trading Telegram mapping/admin | PARTIAL | Users/groups/aliases are read-only native. Add user mapping create/update/unlink, alias create/update, group register/approve/deactivate/test, webhook setup/status/register, and refresh. | P1 |
| TR-05 | Trading analytics | PARTIAL | Add custom start/end date, min/max ROI inputs, native CSV/PDF export and Excel-compatible output/share. | P2 |
| FN-01 | `/portal/wallet` deep link | ROUTING | `WalletStatementScreen` already exists and is presented inside Portal/Payroll, but the route contract still opens web. Route to Portal with wallet auto-presented or resolve the employee and push the native statement. | P1 |
| FN-02 | Invoice PDF preview | PARTIAL | Invoice generation/status/share are native; preview still opens web. Fetch/open the hosted PDF with PDFKit/Quick Look, support save/share, and keep public share URL as allowed web. | P2 |
| FN-03 | Employee/staff salary slips | PARTIAL | Payroll exports are native, but per-employee and My Desk salary-slip PDF still escape to web. Generate or fetch the branded PDF and display/share natively. | P2 |
| FN-04 | XLSX-only exports | PARTIAL | Expenses and Payroll already have native PDF/CSV. Add true XLSX only if the web's XLSX file carries material information not represented in CSV; otherwise formally mark CSV-as-Excel-compatible in the action contract and remove misleading web-only copy. | P3 |

### 3.4 Operations, people, media, and analytics

| ID | Surface | Current native state | Verified missing/partial work | Priority |
|---|---|---|---|---|
| OP-01 | Office task proof submission | PARTIAL | Native can read proof images and send chat images, but staff task photo-proof submission still opens web. Add camera/PhotosPicker, upload, preview/remove, task submit, progress, and retry. | P1 |
| OP-02 | Penalty appeal attachment | PARTIAL | Appeal create/cancel is native; optional proof screenshot is not. Add attachment picker/compression and `attachment_data_url` parity. | P2 |
| OP-03 | Task Spotlight creation | PARTIAL | Archive/resend are native. Add task creation with multi-assignee picker, priority/deadline/options, banner URL or native upload, validation, and post-create refresh. | P2 |
| OP-04 | Inventory media/bulk | PARTIAL | Single product creation and stock mutations are native. Add product photo upload, collection/grid workflows, and bulk add/edit where the web provides them. Supplier import stays in AD-02. | P2 |
| OP-05 | Employee media | PARTIAL | Employee/payroll/attendance mutations are native. Add admin employee profile-photo upload/change and native salary-slip entry point. | P2 |
| OP-06 | General analytics custom range | PARTIAL | `/analytics` has presets but leaves Custom on web. Add start/end date picker with the same API query and validation. | P2 |
| OP-07 | Portal/Office alternate entry cleanup | UX | Main Portal has native camera/GPS check-in, but older/alternate staff-office code still contains web check-in/proof links and stale comments. Route every entry to the canonical native flow. | P2 |
| OP-08 | Contextual CDIT actions | UX | Core client/project/invoice creation, payment, and PDF generation are native. Add “Create project” directly in client detail or deep-link to a prefilled native project sheet; remove the remaining internal web detail links. | P3 |
| OP-09 | Order/route stale escapes | UX | Orders have native create/detail/edit/status/cancel/return/delete-request/invoice, but “full drawer lives on web” copy remains. Remove or relabel the fallback after verifying action-contract parity. | P3 |

---

## 4. LIVE Business Monitor: required native product specification

This is the primary workstream and must not be implemented as one enormous vertical page.

### 4.1 Mobile information architecture

Use a compact navigation title `LIVE Business` with a sticky status row and five scrollable tabs:

1. **Overview**
2. **Agents**
3. **Staff**
4. **Feed**
5. **System**

The selected date/history control sits under the tabs or in the toolbar. Historical dates switch all applicable blocks into read-only mode.

### 4.2 First-fold acceptance criteria

On iPhone 17 Pro Max and a smaller 6.1-inch iPhone, without scrolling the user must see:

- navigation title/back action
- Agent, Browser, Heartbeat, and alert status chips
- all five tab labels or an obvious horizontally scrollable tab strip
- at least four KPIs
- at least one actionable alert/quick action or a meaningful empty state

Hard layout rules:

- No decorative/empty vertical spacer greater than 80 pt.
- No always-expanded model list, heartbeat history, or control explanation consuming the first fold.
- Control cards use disclosure groups/sheets for detail.
- Empty states collapse to a compact card; they do not occupy the rest of the page.
- `LazyVStack`/lazy grids for long feeds.
- The floating Agent control must not cover a switch, button, tab, or final row; use safe-area content inset or hide/minimize it on Monitor.
- Support light/dark mode, Bengali wrapping, Dynamic Type, Reduce Motion, and VoiceOver.

### 4.3 Overview tab

Native equivalents required:

- `MonitorKPIStrip`: Agent Duties, Staff Active, Pending Ack, Approvals, AI Cost, Failures.
- `MonitorAlertPanel`: actionable alerts and dismiss state.
- `MonitorQuickActions`: Deploy Worker, Retrigger Duty, NTFY/escalate all, last deploy result.
- compact top staff cards.
- today/live versus archived date state.
- refresh timestamp and polling state.

### 4.4 Agents tab

Native equivalents required:

- full Agent Control Center:
  - master pause/resume
  - autonomy mode
  - capability toggles
- Autonomy SLO invariants/classes.
- searchable/grouped model toggles.
- heartbeat:
  - enable/pause
  - test now
  - wakes today
  - timeline/status/result
- live browser:
  - devices/online count
  - emergency stop/resume
  - latest screenshot with tap-to-zoom/save/share
  - live steps with action, target, state, error, and time
- Agent panel/status cards from `MonitorAgentsPanel`.

### 4.5 Staff tab

Native equivalents required:

- full staff cards and detail.
- staff capability strengths/weaknesses.
- geo-fence state, distance, last update, Maps handoff.
- geo-fence controls.
- productivity alerts.
- staff task toggles.
- quick action to prefill/open native Agent chat for a staff-specific task.
- duty enabled/disabled controls.

### 4.6 Feed tab

Native equivalents required:

- unacknowledged messages with individual escalation.
- escalate all with progress/results.
- pending approvals with approve/reject using the existing action APIs.
- full feed, expand/collapse or paging.
- active reminders and todos.
- clear success/failure/server replay states.

### 4.7 System tab

Native equivalents required:

- duty timeline and retrigger.
- Salah timeline and Salah time settings.
- voice settings.
- trust rules and tier update.
- brain stats.
- health scan and manual re-scan.
- auto-fix request, approve, reject.
- continuous services status.
- deploy with target/running commit verification.
- build badge and last sync/deploy.

### 4.8 Data/action contract

Use the existing web contracts. Do **not** edit files below `/api/agent/*`.

Read/action surfaces include:

- `/api/assistant/controls`
- `/api/assistant/controls?section=slo`
- `/api/assistant/models`
- `/api/assistant/model-routing`
- `/api/assistant/heartbeat`
- `/api/assistant/live-browser/watch`
- `/api/assistant/costs/summary`
- `/api/assistant/staff-toggles`
- existing `/api/agent/staff-monitor*`, health, auto-fix, brain, trust, capabilities, Salah, and deploy routes — consume unchanged only
- existing `/api/assistant/actions/*` approval routes

For every mutation:

- display confirmation for dangerous/high-impact operations
- disable duplicate submission
- do not rely on optimistic state for owner controls
- reload or apply the server-echoed state
- show idempotent replay as success, not an error
- log route/action ID for parity diagnostics without sensitive payloads

### 4.9 Polling and lifecycle

- Poll live monitor at the same effective cadence as web, but coalesce requests.
- Stop polling when the app is backgrounded or a historical date is selected.
- Resume with an immediate refresh on foreground.
- Do not run independent uncontrolled timers in every card.
- One monitor data coordinator owns refresh cadence, cancellation, last-updated state, and per-section errors.

---

## 5. Execution phases

Claude should execute one phase at a time, verify it, commit it, update this roadmap's evidence/checklist, and then continue. Do not bundle all code into one unreviewable commit.

### Phase NP-0 — Freeze truth and build an action-level parity contract

**Goal:** prevent route-green/feature-red regressions.

Tasks:

- Start from a clean worktree based on the latest `origin/main`; record SHA, deployed web build info, installed app build, and API base.
- Re-run `scripts/iosp0-route-contract-check.mjs`.
- Add `ios/feature-parity-contract.json` plus schema. Each route/surface entry must include:
  - section ID
  - action ID
  - read/write/export/upload/deep-link classification
  - role gate
  - web source file
  - API method/path
  - native source/screen
  - state: `native`, `system-handoff`, `public-web`, `missing`, `retired`
  - verification fixture/test name
- Add `scripts/ios-feature-parity-check.mjs` to fail on missing native-required actions, undocumented internal web escapes, invalid exceptions, or orphaned routes.
- Add a checked-in exception ledger for only approved public/system handoffs.
- Correct stale Swift header comments based on actual current methods.
- Capture baseline screenshots for web Monitor and native Monitor.

Exit gate:

- Existing route checker passes.
- New feature checker intentionally fails only on the open ledger above, then is configured to track planned phase IDs without hiding them.
- No product behavior changes in this phase.

### Phase NP-1 — Monitor compact shell and Agent Hub

**Goal:** solve the oversized Monitor UX and make every Agent surface discoverable.

Primary files:

- `ios/App/App/StaffMonitorSwiftUI.swift`
- `ios/App/App/MoreMenuSwiftUI.swift`
- `ios/App/App/AssistantSwiftUI.swift`
- `ios/App/App/AlmaNativeRouter.swift`
- `ios/App/App/AlmaNavCoordinator.swift`

Tasks:

- Implement compact `LIVE Business` header, status strip, five-tab navigation, history/date control, and tab-specific lazy content containers.
- Move current native staff/KPI content into the correct tabs without losing functionality.
- Build a canonical Agent Hub containing Chat, Monitor, Studio, WhatsApp, Costs, Growth, Known People, Product Images, Trading Staff, Subscriptions, Live Watch, and Phone Companion.
- Keep the floating/radial menu as a shortcut to the same route coordinator.
- Fix floating control overlap/safe-area behavior.
- Route `/agent/live-watch` to the native Monitor Agents/Live Browser tab even before full live content ships.

Exit gate:

- First-fold criteria in Section 4.2 pass on 6.1-inch and Pro Max simulators.
- Every Agent route is reachable from a normal visible native menu and a deep link.
- No internal Agent item opens web except explicitly unfinished phase items.

### Phase NP-2 — Monitor owner controls, models, heartbeat, SLO, and Live Watch

**Goal:** finish the Agents tab and retire the separate web-only Live Watch flow.

Tasks:

- Full control center: pause, autonomy, capability toggles.
- Autonomy SLO surface.
- Per-model toggles with search/group/collapse.
- Full heartbeat timeline and actions.
- Live browser devices, stop/resume, screenshot viewer, step feed, status/failure details.
- Single lifecycle-aware polling coordinator.
- Confirmations and server-verified state for all writes.

Exit gate:

- Web and iOS show the same control values after every mutation.
- Stop/resume tested against a live or deterministic fixture session.
- `/agent/live-watch` never creates an internal WKWebView.
- Feature contract marks AG-02 through AG-06 native.

### Phase NP-3 — Monitor Overview, Staff, Feed, and System completion

**Goal:** make the Monitor a complete owner control room.

Tasks:

- Overview KPIs, alerts, quick actions, deploy/retrigger/escalate all.
- Staff capabilities, geo state/control, productivity alerts, duty/staff toggles, chat-prefill quick actions.
- Feed unacked/escalate, approvals, reminders, todos, full feed paging.
- System duty timeline, Salah settings, voice settings, trust, brain, health scan, auto-fix, continuous services, build/deploy verification.
- Historical date read-only mode.

Exit gate:

- Every component/action in `AgentStaffMonitor.tsx` and `src/agent/components/monitor/` has a native action-contract entry.
- Owner-only gates match web.
- Network failure in one section does not blank the entire monitor.
- Screenshot comparison and action traces are stored in phase evidence.

### Phase NP-4 — Agent remainder and native authentication recovery

**Goal:** remove remaining Agent/auth internal web dependencies.

Tasks:

- Growth GSC connect via `ASWebAuthenticationSession`; native disconnect and refresh.
- Costs CSV export/share and total reconciliation test.
- Creative Studio drag/resize Lifestyle Editor and remaining Drive/tool-row handoffs.
- Remove production Creative Studio demo route.
- Native forgot-password form.
- Native reset-password deep-link/token completion.
- Route `/portal/wallet` to the existing native statement.

Exit gate:

- Temporary-web list no longer contains Live Watch, forgot password, reset password, or wallet.
- Only approved OAuth/public destinations leave the app.
- Sensitive reset token never appears in logs or persistent plain-text storage.

### Phase NP-5 — Privileged admin, settings, and bulk workflows

**Goal:** finish common owner/admin tasks without web.

Tasks:

- Users create/edit/activate/deactivate/roles/business access/reset.
- Supplier import validate/preview/commit/result.
- Business Archive preview/execute/restore.
- System Diagnostics process/retry actions.
- Payment Accounts full secure management.
- Branding text/colors/invoice fields.
- Telegram recipients/schedule/alert configuration.
- Notification push health.
- Native Session → Profile control routing.

Safety requirements:

- Super Admin role gate in UI and server.
- Face ID/device authentication for reveal and high-risk account actions where appropriate.
- Typed phrase for archive execute/restore.
- No mutation on initial render.
- Every mutation reloads server truth and provides an audit-visible result.

Exit gate:

- AD-01 through AD-09 are native or formally accepted exceptions.
- Wrong-role fixtures cannot see or trigger privileged actions.

### Phase NP-6 — Trading account and Telegram admin completion

**Goal:** close money-sensitive contextual/action gaps.

Tasks:

- Account detail contextual trade/expense/capital/screenshot actions.
- Trade edit, audit history, delete request, approve/reject delete.
- Full screenshot history and daily summary.
- Partnership settlement preview/confirm/history.
- Trading Telegram edit and bulk operations.
- Telegram user/alias/chat/webhook admin.
- Trading analytics custom filters and exports.

Money verification for every write:

1. capture before state
2. show confirmation with account, amount, currency, and effect
3. submit once with idempotency/request ID where supported
4. fetch after state
5. assert wallet/P&L/ledger/settlement changes match the server response

Exit gate:

- TR-01 through TR-05 pass deterministic fixtures and at least one authenticated simulator flow.
- Whole-taka BDT rule is preserved wherever the backend expects whole taka.

### Phase NP-7 — Portal, people, operations, inventory, and document completion

**Goal:** close camera/upload/document workflows.

Tasks:

- Office task photo proof capture/upload/submit/retry.
- Penalty appeal optional attachment.
- Task Spotlight creation and assignee picker.
- Inventory product photos, collections, and bulk workflows.
- Employee profile photo administration.
- Per-employee/My Desk salary slip PDF.
- Native invoice PDF preview.
- Canonicalize all check-in/proof entry points.
- Contextual prefilled native CDIT project creation.

Exit gate:

- Camera/PhotosPicker denial, retry, compression, size/type validation, and offline errors are handled.
- Generated PDFs display, save, and share natively.

### Phase NP-8 — Filters, exports, stale escapes, and product polish

**Goal:** remove the final small parity leaks and misleading UI.

Tasks:

- Analytics custom date range.
- Resolve XLSX contract: native XLSX or documented CSV-compatible replacement.
- Remove/relabel obsolete Orders, Digital, Session, Expense, Payroll, Employee, and Portal web escape copy after feature checker passes.
- Remove stale “read-only” comments and dead alternate routes.
- Review every `openWeb(` call. Each must be public/system-handoff, an external destination, or a login fallback with an explicit contract ID.
- Add accessibility labels/values/hints and focus order to new controls.
- Reduce unnecessary timers, duplicate fetches, and overdraw.

Exit gate:

- `rg 'openWeb\(' ios/App/App` has no undocumented internal workflow escape.
- Route and feature parity checkers pass with only approved public/system handoffs.

### Phase NP-9 — End-to-end verification and one release

**Goal:** prove the complete roadmap and publish once.

Verification:

- clean release build
- route contract checker
- feature/action parity checker
- Swift/unit tests
- API contract tests for all new mutations
- simulator smoke across all changed routes
- light/dark mode
- smaller and Pro Max iPhones
- default and large Dynamic Type
- Reduce Motion
- VoiceOver spot check
- auth-expired, empty, error, retry, offline, and slow network states
- background/foreground polling behavior
- deep links for Agent Monitor, wallet, forgot/reset password
- real-device-only checks for camera, Face ID, push, phone/WhatsApp, and OAuth callback

Release discipline:

- Batch all completed phases into one final TestFlight build after simulator proof.
- Record build number, git SHA, route/action checker output, simulator evidence, and owner-hardware checklist.
- Do not claim completion from a successful compile alone.

---

## 6. Do-not-rebuild ledger: features already at or near parity

Claude must revalidate these but should not redo them unless the action contract finds a real regression.

- Native Agent chat: conversations, streaming/worker turns, attachments, transcription, cards, approvals, memory/project management, artifacts, background tasks, inline screenshots.
- WhatsApp inbox: web itself is read-only; native read-only behavior is parity. Do not invent a reply composer as “parity.”
- Known People: native settings, people CRUD, reference photos, active toggle, delete, and test.
- Product Images: native browse/search/filter, gallery, upload, add new, and delete.
- Subscriptions: native full CRUD.
- Credit Usage: native spend, ranges, detailed logs, balances, refresh, and budget config; only export/reconciliation remains.
- Target Control: native create, actions, delete, settings.
- Trading Home: native trade, bKash summary, expense + attachment, capital, screenshot.
- Trading Accounts list: native create/edit/archive.
- Trading HR: native profile save and daily report.
- Trading Staff: native upsert/link/edit/active state.
- Digital: client create, payment, project create, invoice create/payment/PDF generation are implemented.
- CRM: sync from orders is native; the web “Flag” button has no active mutation handler.
- Orders: native create, detail, status, edit, delete request, invoice and role gates.
- Approvals: core mutations are native.
- Attendance admin: waiver/selfie review/verification/reset are native.
- My Desk: wallet requests, leave, exception, meal, driving, appeal, native front-camera/GPS check-in/out.
- Expenses: add, receipt upload, PDF and CSV are native.
- Payroll: sensitive mutations, PDF and CSV are native.
- Office Fund and Personal Ledger core writes are native.
- SMS settings: master switch, enabled types, test, retry, report are native.
- Notification broadcast composer is native.
- Settings Database is read-only on both web and native.
- Dashboard, Finance, Activity, Audit, Insights, and Briefing are primarily read products and have no missing web mutations.

---

## 7. Required engineering rules

### 7.1 Repository and API safety

- Read and follow root `AGENTS.md` and `CLAUDE.md` before each phase.
- Never touch or refactor anything under `/api/agent/*`.
- Consume existing `/api/agent/*` endpoints unchanged where the current web product already uses them.
- Any genuinely new Agent route must live under `/api/assistant/*` and must preserve `AGENT_ENABLED` behavior.
- Avoid new APIs when an existing web endpoint already expresses the action.
- Database work must be additive and backward-compatible.
- Preserve whole-taka money rules.
- Do not modify unrelated dirty worktree files.

### 7.2 Native architecture

- Use `AlmaAPI` and the existing session/cookie bridge.
- Prefer one screen/coordinator as the source of truth; do not duplicate the same action in unrelated screens.
- Use `PhotosPicker`, camera controller, Core Location, PDFKit/Quick Look, system share sheet, LocalAuthentication, and `ASWebAuthenticationSession` where appropriate.
- No full-page WKWebView for an internal `native-required` surface.
- Use server responses as truth after mutations.
- Use per-row/per-action progress, not a global overlay.
- Long lists must be lazy and pageable.
- Polling must be cancellable and lifecycle-aware.

### 7.3 Testability

Every new action must have:

- action-contract ID
- role fixture
- success fixture
- auth-expired fixture
- server validation error fixture
- retry/idempotency behavior where relevant
- a native UI route/fixture that can be launched in the simulator

Financial/destructive actions additionally require before/after state assertions.

---

## 8. Definition of complete

The roadmap is complete only when all statements below are true:

- [ ] Every current web route is classified as native, approved system handoff, public web, or retired.
- [ ] Every meaningful web section and action has an action-contract entry.
- [ ] All `native-required` action entries are implemented in SwiftUI.
- [ ] LIVE Business Monitor passes the compact first-fold and five-tab requirements.
- [ ] `/agent/live-watch`, `/portal/wallet`, `/forgot-password`, and `/reset-password` no longer require an internal web page.
- [ ] `/agent/creative-studio-demo` is retired from production.
- [ ] All internal `openWeb` escapes are removed or have an approved exception ID.
- [ ] Privileged and money mutations match web role gates and payloads.
- [ ] Route and action parity checkers pass.
- [ ] Release build and tests pass from a clean worktree.
- [ ] Changed screens are visually verified in light/dark, small/large phone, and large text.
- [ ] Camera/Face ID/push/OAuth behaviors have owner-hardware evidence.
- [ ] One final TestFlight build contains the verified batch.
- [ ] Roadmap and exception ledger contain final git SHA/build/evidence links.

---

## 9. Claude end-to-end execution prompt

Use this prompt with Claude together with this file:

```text
You are completing ALMA ERP's Web → Native iOS parity roadmap end to end.

Source of truth:
- Read AGENTS.md and CLAUDE.md completely.
- Read IOS_NATIVE_PARITY_DEEP_AUDIT_ROADMAP.md completely.
- Do not trust old Swift header comments; verify actual current methods, UI wiring, web source, and API handlers.
- Start from a clean worktree based on the latest origin/main and record the baseline SHA/builds.

Execution mode:
1. Begin with the first incomplete NP phase.
2. Make a concrete phase plan and update the roadmap checklist/evidence.
3. Implement only that phase's coherent scope.
4. Reuse the exact existing web API methods and bodies through AlmaAPI.
5. Never edit /api/agent/*; any genuinely new Agent server route must be /api/assistant/* and AGENT_ENABLED-gated.
6. Internal native-required workflows must be SwiftUI, not a WKWebView.
7. Preserve role gates, confirmations, server-echoed truth, whole-taka money rules, idempotency, and audit behavior.
8. Add/update route and action-contract tests plus native fixtures.
9. Build and self-test on the approved iOS simulator; capture runtime evidence. Use real hardware only for camera/Face ID/push/OAuth/phone checks that the simulator cannot prove.
10. Commit the verified phase cleanly, update this roadmap with commit/test evidence, and continue to the next incomplete phase.

Do not rewrite already-complete features listed in the do-not-rebuild ledger unless current source/testing proves a regression. Do not touch unrelated dirty changes. Do not claim a phase complete from compilation alone.

The first product priority is the LIVE Business Monitor: compact five-tab mobile IA, full owner controls, live browser screenshot/steps, staff/feed/system parity, and no floating-control overlap. Follow Section 4 exactly.
```

---

## 10. Suggested evidence log template

Append one block after each completed phase:

```md
### NP-X completion evidence

- Baseline SHA:
- Commit SHA:
- iOS build:
- Web build:
- Route checker:
- Feature checker:
- Unit/API tests:
- Simulator devices:
- Screens/routes exercised:
- Light/dark/large-text evidence:
- Before/action/after evidence for money/destructive writes:
- Remaining known issues:
- Owner-hardware checks required:
```

This keeps the roadmap executable across multiple Claude sessions without losing state or repeating finished work.
