# ALMA ERP iOS Native Polish — Master Audit and Execution Roadmap

**Status:** Audit complete; implementation not started
**Audit date:** 2026-07-16 (Asia/Dhaka)
**Owner:** Maruf / ALMA Lifestyle, ALMA Trading, CDIT
**Primary execution target:** iPhone 17 Pro Max Simulator
**Do not touch:** the iPhone 17 Pro Simulator used by another session
**Audit source snapshot:** local `agent-phase-15` at `3c493a64`, including owner/session worktree changes that were inspected but not modified
**Roadmap branch base:** `origin/main` at `54aadb7c`

> This is a planning and handoff document. It does not authorize a broad rewrite, production deployment, or changes outside the phase currently being executed. The repository `AGENTS.md` remains authoritative.

## Owner summary (Bangla)

ALMA ERP-এর iOS app অনেক জায়গায় native SwiftUI হলেও এখনো পুরোপুরি native নয়। Native screen-এর ভিতরের অনেক action WKWebView-এ force হয়, কিছু deep link native router চিনতে পারে না, তিনটি independent overlay window-এর কারণে content/composer/tab bar ঢেকে যায়, এবং একাধিক polling loop + hidden Capacitor runtime + অতিরিক্ত blur/animation slow feel তৈরি করে। বর্তমান Xcode 26.6 / iOS 26.5 SDK দিয়ে iOS 27 API সত্যিকারভাবে adopt বা verify করা হয়নি।

এই roadmap-এর লক্ষ্য হলো:

1. accidental web fallback বন্ধ করা;
2. overlay ও safe-area overlap শূন্য করা;
3. idle polling, duplicate load এবং rendering cost কমানো;
4. Agent ও core ERP flow-গুলো সত্যিকারের native করা;
5. Xcode 27-এর relevant system UI/API ব্যবহার করা;
6. Claude/ChatGPT-এর মতো calm, fast, predictable polish অর্জন করা;
7. প্রতিটি phase শেষে Claude Code নিজে iPhone 17 Pro Max Simulator-এ verify করে screenshot/video proof রাখবে;
8. final approval-এর আগে production বা App Store release হবে না।

## 1. Scope and audit method

The audit covered:

- all Swift sources under `ios/App/App/` (approximately 90 files and 100,981 lines at the audited snapshot);
- the UIKit/SwiftUI/Capacitor shell and root-tab construction;
- the native route table and web route inventory;
- agent chat, voice, background-task, office, notification, and floating overlay surfaces;
- static searches for polling, animation, material/blur, accessibility, fixed-size typography, screen-bound assumptions, and deprecated APIs;
- an iPhone 17 Pro Max live visual pass on representative high-risk states;
- a target-specific Xcode build for the iPhone 17 Pro Max Simulator;
- comparison against official Apple iOS 27, SwiftUI, Liquid Glass, and HIG guidance.

This was not a claim that every possible role, permission, dataset, error state, sheet, keyboard state, and deep link was manually tapped. Phase 0 converts this audit into a reproducible baseline and machine-checkable inventory before implementation.

## 2. Executive verdict

### 2.1 Current product state

The app is a **hybrid native shell**, not a fully native ERP:

- UIKit owns the application shell and navigation controllers.
- SwiftUI implements many page shells and a substantial set of actions.
- Capacitor/WKWebView remains alive behind the native dashboard for plugin/session compatibility.
- unknown or explicitly forced routes open WKWebView.
- several screens are native for presentation but incomplete for mutation workflows.

The app is functional and visually ambitious, but it is not yet at Claude/ChatGPT polish because navigation, layering, state retention, motion, typography, accessibility, and perceived latency are not governed by one coherent system.

### 2.2 Severity summary

| Area | Severity | Evidence-backed conclusion |
|---|---:|---|
| Overlay/safe-area collisions | P0 UX | Confirmed on iPhone 17 Pro Max; independent windows do not share exclusion zones. |
| Accidental web fallback | P0 architecture | Root-tab callbacks can bypass the smart router and call `pushWeb` directly. |
| Partial native parity | P1 product | Many native screens expose web escape hatches for critical mutations. |
| Idle/background polling | P1 performance/battery | Multiple 2–30 second loops coexist; one 3-second intercom check is app-wide. |
| Hidden web runtime | P1 performance | Capacitor dashboard is retained behind the native dashboard. |
| Rendering/animation cost | P1 performance | Large use of custom blur/material plus numerous perpetual animations. |
| Accessibility/adaptive layout | P1 quality | Heavy fixed typography; very limited explicit accessibility coverage. |
| iOS 27 adoption | P1 platform | Current build uses Xcode 26.6 and iOS 26.5 SDK; iOS 27 APIs cannot be verified. |
| Swift 6 readiness | P2 maintainability | Build succeeds in Swift 5 mode but emits actor-isolation warnings that become Swift 6 errors. |

## 3. Evidence ledger

All counts are snapshot indicators, not permanent truths. Phase 0 must regenerate and store the commands/results against the exact implementation base.

### 3.1 Codebase scale and concentration

- Approximately **90 Swift files** and **100,981 Swift lines**.
- Largest audited files included:
  - `AssistantSwiftUI.swift`: ~8,570 lines
  - `CreativeStudioSwiftUI.swift`: ~3,898 lines
  - `AssistantVoiceSwiftUI.swift`: ~3,353 lines
  - `EmployeesSwiftUI.swift`: ~3,069 lines
  - `PortalOfficeSwiftUI.swift`: ~3,025 lines
  - `PortalSwiftUI.swift`: ~2,805 lines
  - `PayrollSwiftUI.swift`: ~2,671 lines
  - `DashboardSwiftUI.swift`: ~2,345 lines
  - `ApprovalsSwiftUI.swift`: ~2,227 lines
  - `AttendanceSwiftUI.swift`: ~2,160 lines
  - `SpikeNativeShell.swift`: ~2,022 lines

Large files are not inherently slow. Here they correlate with broad observable state, many conditional layers, polling tasks, and animation surfaces, so they increase invalidation and regression risk.

### 3.2 Navigation evidence

Key locations in the audited snapshot:

- `ios/App/App/SwiftUIShell.swift`
  - `pushWeb(...)` around line 218
  - `pushSmart(...)` around line 228
  - Dashboard root callback around line 259
  - Orders root callback around line 280
  - Approvals root callback around line 295
- `ios/App/App/AlmaNativeRouter.swift`
  - exact-match route switch around lines 44–108
- `ios/App/App/AppDelegate.swift`
  - global overlay installation around lines 56–61

The structural defect is not simply “some pages are web.” The defect is that there is no single navigation contract. Some paths go through the native-aware router, while root-tab callbacks can force the same path directly into WKWebView.

### 3.3 Overlay evidence

Three independent app-level layers are installed:

1. Floating Chat Head
2. Connectivity Beacon
3. Alma Island notification/banner layer

Observed failure modes on iPhone 17 Pro Max:

- chat head covers approval content and metadata;
- bottom cards/actions continue beneath the custom tab bar;
- Agent composer and chat head compete for the same lower trailing space;
- task sheet, stop confirmation, chat head, and island/banner can form three or more simultaneous layers;
- fixed clamping does not account for keyboard, tab bar, sheet detents, composer height, or screen-specific controls.

Relevant audited locations:

- `ios/App/App/FloatingChatHead.swift` — install and 3-second incoming-call polling around lines 50–93
- `ios/App/App/AlmaIslandBanner.swift` — independent watcher/window around lines 58–81
- `ios/App/App/AppDelegate.swift` — global installation around lines 56–61

### 3.4 Performance evidence

Observed or statically identified refresh behaviour included:

| Surface | Approximate cadence | Scope/risk |
|---|---:|---|
| Floating intercom incoming-call check | 3 s | Global; runs outside the Agent page. |
| Agent background-task detail | 2 s for selected feeds | Very high while sheet is open. |
| Agent message/status recovery | 12 s | Active chat; multiple related calls can occur. |
| Agent plan/todo/presence-related refresh | ~24–30 s | Active Agent surfaces. |
| WhatsApp inbox | 5 s | Active page. |
| Trading Telegram | 8 s | Active page. |
| Staff Monitor | 10 s | Active page. |
| Office chat | 15 s | Active page. |
| Alma Island notification watch | 30 s | App-level. |
| Approvals badge | ~90 s + foreground | App shell. |

Additional static indicators:

- approximately **175** `repeatForever` animation uses;
- approximately **11** `TimelineView(.animation...)` uses;
- approximately **226** custom material/glass/blur-related uses;
- no general API response cache or single-flight request deduplication layer was found;
- many pushed screens create a fresh view model and reload on appearance;
- standard `AsyncImage` is widely used without a consistent app image cache/prefetch policy;
- the hidden Capacitor dashboard remains mounted for plugin/session continuity.

These are root-cause candidates, not fabricated profiler results. Phase 0 and Phase 3 must establish Instruments/MetricKit evidence before claiming a percentage improvement.

### 3.5 Accessibility and adaptive-layout evidence

Snapshot search indicators:

- approximately **1,071** hard-coded `.font(.system(size: ...))` uses;
- approximately **317** `.lineLimit(1)` uses;
- approximately **137** `.minimumScaleFactor(...)` uses;
- approximately **15** explicit accessibility label/hint/value/element declarations;
- approximately **95** Reduce Motion references;
- **0** explicit Reduce Transparency references found;
- **0** explicit Differentiate Without Color references found;
- **0** explicit `dynamicTypeSize` constraints/tests found;
- approximately **5** `UIScreen.main.bounds` assumptions;
- numerous custom icon-only controls and low-contrast metadata styles.

System `Text`, `Button`, and `Label` provide some semantics automatically, so the explicit count is not a total VoiceOver score. It is still a strong signal that custom controls and overlays need a deliberate accessibility pass.

### 3.6 Toolchain and build evidence

Audit environment:

- Xcode 26.6
- iOS/iPhone Simulator SDK 26.5
- app deployment target iOS 16.0
- native SwiftUI feature gate iOS 17+
- Swift language mode 5

Targeted build command:

```bash
xcodebuild \
  -workspace ios/App/App.xcworkspace \
  -scheme App \
  -configuration Debug \
  -destination 'platform=iOS Simulator,id=94E0186B-5CDA-4708-9368-53B4FF7274E7' \
  -derivedDataPath build/ios-audit-promax \
  CODE_SIGNING_ALLOWED=NO \
  ONLY_ACTIVE_ARCH=YES \
  build
```

Result: **BUILD SUCCEEDED**.

Warnings included:

- actor-isolation expressions that require `await` and become errors in Swift 6 mode;
- deprecated `WKProcessPool` usage;
- deprecated `.allowBluetooth` audio-session option;
- CocoaPods copy/embed script phases without declared outputs;
- smaller correctness/cleanup warnings such as never-mutated variables and unreachable nil-coalescing fallbacks.

A successful Swift 5 build proves compilation, not performance, native parity, iOS 27 adoption, or visual correctness.

## 4. Native coverage and web-fallback audit

### 4.1 Native route shells found

The exact-match native router contains substantial coverage:

**Core/business**

- `/`, `/dashboard`, `/login`
- `/orders`, `/orders/new`, `/approvals`
- `/finance`, `/invoice`, `/expenses`, `/payroll`, `/finance/office-fund`

**Operations**

- `/activity`, `/inventory`, `/employees`, `/attendance`, `/crm`
- `/audit`, `/analytics`, `/insights`, `/briefing`
- `/operations/task-spotlight`
- `/operations/business-archive`
- `/operations/system-diagnostics`
- `/inventory/supplier-import`

**Portal/settings**

- `/portal`, `/portal/office`, `/portal/expense`, `/portal/payment-accounts`
- `/settings/notifications`, `/settings/users`, `/settings/database`
- `/settings/sms`, `/settings/branding`, `/settings/session`, `/settings/telegram-ops`

**Agent**

- `/agent/costs`, `/agent/credit-usage`, `/agent/subscriptions`
- `/agent/whatsapp`, `/agent/catalog-images`, `/agent/creative-studio`
- `/agent/trading-staff`, `/agent/known-people`, `/agent/growth`, `/agent/staff-monitor`

**Trading/CDIT**

- `/trading`, `/trading/accounts`, `/trading/analytics`
- `/trading/hr`, `/trading/target-control`, `/trading/telegram`
- `/digital`, `/digital/clients`, `/digital/invoices`, `/digital/projects`, `/digital/finance`

### 4.2 Definite route-level gaps

| Route/pattern | Current outcome/risk | Required decision |
|---|---|---|
| `/agent` deep link | Not represented in the exact route switch; Agent tab is built separately. | Map to the native Agent root consistently. |
| `/agent/live-watch` | More menu/page can reach it, but router coverage was absent. | Build/map native screen or explicitly document web-only status. |
| `/portal/wallet` | Router coverage absent. | Native wallet screen or explicit exception. |
| `/employees/[id]` | Exact router cannot match arbitrary IDs. | Add typed dynamic route. |
| `/digital/clients/[id]` | Same dynamic-route gap. | Add typed dynamic route. |
| `/trading/accounts/[id]` | Same dynamic-route gap. | Add typed dynamic route. |
| `/forgot-password` | Web flow. | Prefer native shell plus secure system/browser handoff as required. |
| `/reset-password` | Web flow/deep-link sensitivity. | Native reset completion with secure token handling. |
| `/invoice/share/[slug]` | Public/share web page. | Keep web unless a business requirement justifies native. |
| `/privacy-policy`, `/app/download` | Public informational pages. | Web is appropriate. |
| `/agent/creative-studio-demo` | Development/demo route. | Exclude from production navigation or remove separately. |

### 4.3 Feature-level forced-web gaps

A route returning a SwiftUI controller does not prove the workflow is native. High-value gaps found in native screens include:

| Area | Examples of actions still routed to web |
|---|---|
| Users/settings | Create/edit user, password/role/permission work, SMS testing/toggles. |
| Orders | Full order drawer and some secondary workflows. |
| Inventory | Bulk/collection/image upload and supplier-import execution. |
| Attendance | Selfie/camera flow. |
| Portal | Task updates, PDF-related actions, some account/wallet operations. |
| Finance | Several quick links and deeper mutation workflows. |
| Trading | Account create/edit/settlement/details and export workflows. |
| Digital/CDIT | Client/project/invoice secondary actions and dynamic detail links. |
| Archive | Archive/restore mutations. |
| Growth | OAuth connection/disconnection flows. |
| Agent costs | Budget configuration, logs, and CSV/export work. |

OAuth or a public share page opening a system browser is not a native failure. A full internal ERP workflow opening an embedded WKWebView because its SwiftUI action is missing is a parity failure.

### 4.4 Required navigation contract

Every destination must be classified as exactly one of:

1. **Native required** — internal ALMA workflow; web fallback is a test failure.
2. **System handoff** — OAuth, phone, mail, files, share sheet, external link.
3. **Public web allowed** — privacy policy, public invoice share, download/help.
4. **Temporarily web with owner-approved expiry** — documented debt with telemetry and a removal phase.

Unknown paths must never silently become embedded web content. They must log a structured routing failure and show a safe owner-facing error or an explicit, allowlisted handoff.

## 5. Visual and interaction audit

### 5.1 Why the UI does not yet feel like Claude/ChatGPT

The gap is not a lack of visual effects. It is an excess of competing effects and independent behaviours:

- custom glass is used in content cards rather than being reserved mainly for controls/navigation;
- several aurora/gradient layers reduce text contrast and visual hierarchy;
- many small labels and single-line constraints compress business information;
- custom tab/navigation treatments behave differently across screens;
- repeated perpetual animation makes the app feel busy and consumes frame budget;
- loading/error/empty states are not governed by one interaction pattern;
- navigation can change from native to embedded web without a clear mental model;
- global floating controls can obscure local actions.

Claude/ChatGPT-like polish should be interpreted as:

- immediate touch response;
- calm motion with a clear purpose;
- one obvious primary action;
- stable composer/navigation geometry;
- readable typography at all Dynamic Type sizes;
- predictable back/deep-link behaviour;
- progressive loading that preserves prior content;
- no surprise web context switches;
- no hidden controls under overlays or the keyboard.

### 5.2 Apple platform guidance

Official references to re-check when implementation begins:

- iOS 27 overview: <https://developer.apple.com/ios/whats-new/>
- SwiftUI updates: <https://developer.apple.com/documentation/updates/swiftui>
- SwiftUI Glass APIs: <https://developer.apple.com/documentation/swiftui/glass>
- HIG Materials: <https://developer.apple.com/design/human-interface-guidelines/materials>
- Designing for iOS: <https://developer.apple.com/design/human-interface-guidelines/designing-for-ios/>
- WWDC26 “What’s new in SwiftUI”: <https://developer.apple.com/videos/play/wwdc2026/269/>

Important principle: use relevant iOS 27 capabilities, not every available framework. Adding unrelated kits increases binary size, complexity, privacy declarations, battery use, and regression surface without improving polish.

## 6. Target architecture

```text
App Scene
├── Native Navigation Coordinator
│   ├── Typed route registry
│   ├── Native-required destinations
│   ├── System/external handoffs
│   └── Explicit temporary web allowlist + telemetry
├── Overlay Coordinator
│   ├── Dynamic Island / banner presentation state
│   ├── Floating Agent affordance
│   ├── Keyboard, tab bar, sheet and composer exclusion zones
│   └── Accessibility/reduced-motion policy
├── Shared Data Layer
│   ├── authenticated API client
│   ├── TTL cache + request single-flight
│   ├── scene-aware refresh scheduler
│   ├── realtime/push event bridge
│   └── image cache/prefetch
├── Persistent Root Features
│   ├── Dashboard
│   ├── Orders
│   ├── Agent
│   ├── Approvals
│   └── More
└── Legacy Web Compatibility Boundary
    ├── Capacitor plugin/session bridge only
    └── approved public/temporary web destinations only
```

No ERP feature may import from `src/agent/`; the existing one-way agent dependency rule remains unchanged.

## 7. Programme rules and gates

### 7.1 One roadmap phase per Claude Code session

Repository rules require one phase per session. Therefore the full roadmap is a multi-session programme even if the owner refers to it as one project.

For every phase Claude Code must:

1. read `AGENTS.md` and this roadmap completely;
2. identify the exact allowed file list for the phase;
3. run pre-flight checks before editing;
4. create the required `agent-phase-N` branch and `pre-agent-phase-N` tag using the next owner-approved/available phase number;
5. preserve unrelated dirty changes and other worktrees;
6. implement only that phase;
7. run targeted tests, lint/typecheck/build as applicable;
8. build/install/launch only on the iPhone 17 Pro Max Simulator;
9. manually exercise all phase acceptance scenarios;
10. save screenshot/video proof with descriptive filenames;
11. if web/API code changed, push a preview and perform the mandatory owner-Chrome Vercel proof;
12. inspect `git diff --stat` and the exact diff for scope;
13. write a phase report and next-session handoff;
14. stop. The next phase begins in a new session.

### 7.2 Simulator isolation

Approved audit target:

- **iPhone 17 Pro Max Simulator UDID:** `94E0186B-5CDA-4708-9368-53B4FF7274E7`

Do not boot, install, launch, erase, focus-control, or otherwise manipulate the separate iPhone 17 Pro Simulator used by another session. Before every `simctl` command, print and verify the destination UDID.

### 7.3 Proof is a gate, not decoration

A phase cannot be marked complete with only a successful build. Required proof bundle:

- command log/result summary;
- before/after metric where the phase is performance-related;
- iPhone 17 Pro Max screenshot(s) showing the changed state;
- a short video for keyboard, scrolling, animation, overlay collision, voice, or background transition work;
- accessibility proof when controls/layout are changed;
- Vercel preview + Chrome screenshot when web/API behaviour is changed;
- `git diff --stat` and explicit confirmation that no out-of-scope files changed.

If proof fails, Claude fixes the issue within the same phase scope and repeats verification before moving on.

## 8. Phased execution roadmap

### Phase IOSP-0 — Reproducible baseline and route contract

**Goal:** Convert the July 16 audit into repeatable evidence on the exact implementation base. No production behaviour change.

**Work:**

- regenerate Swift LOC/hot-file counts;
- export web route list and native route registry;
- create a machine-readable route classification fixture;
- record forced-web call sites and owners;
- add OSLog signposts for launch, route-to-content, API request, Agent stream first token, and heavy sheet presentation;
- capture Instruments baselines: Time Profiler, Network, Core Animation, Allocations/Leaks;
- record five-minute idle request counts on Dashboard, Orders, Agent, Approvals, and More;
- record warm/cold navigation timings and scrolling hitch baseline;
- document current Xcode/SDK/Swift version and warning inventory.

**Exit criteria:**

- baseline report committed;
- route inventory covers every web path and deep-link pattern;
- each route has one of the four classifications from section 4.4;
- all measurements are reproducible from documented commands;
- no functional code change beyond instrumentation approved for this phase;
- Pro Max proof bundle complete.

### Phase IOSP-1 — Single native navigation coordinator

**Goal:** Eliminate accidental embedded-web transitions.

**Work:**

- make all root tabs and native screens use one typed navigation coordinator;
- replace direct `pushWeb` callbacks for internal routes;
- add typed dynamic routes for employee, CDIT client, and trading account details;
- map `/agent` consistently to the native Agent root;
- classify `/agent/live-watch` and `/portal/wallet` explicitly;
- introduce structured telemetry for unknown and temporary-web routes;
- add navigation contract tests.

**Exit criteria:**

- every internal test route resolves native or fails explicitly;
- no internal route silently falls into WKWebView;
- Dashboard, Orders, Agent, Approvals, and More cross-navigation passes;
- deep links and back-stack behaviour pass on Pro Max;
- public/system handoffs still work;
- no feature parity work beyond routing.

### Phase IOSP-2 — Overlay and safe-area coordinator

**Goal:** Guarantee that global UI never hides local UI.

**Work:**

- introduce one overlay presentation model/coordinator;
- define tab-bar, keyboard, composer, sheet, island, banner, and toast exclusion zones;
- make floating Agent affordance dock/relocate predictably;
- use `safeAreaInset`/layout guides instead of fixed screen bounds;
- coordinate z-order and simultaneous presentation policy;
- support Reduce Motion, Reduce Transparency, VoiceOver focus, and larger text;
- remove fragile private-view hierarchy tint stripping where feasible within scope.

**Required test matrix:**

- all five root tabs;
- keyboard closed/open/interactively dismissing;
- Agent composer empty/multiline/attachment/voice states;
- background-task sheet collapsed/expanded;
- approval confirmation and error alert;
- incoming call/banner while another sheet is visible;
- portrait and supported rotation states;
- default text and accessibility text sizes.

**Exit criteria:** zero occluded actionable controls in the matrix; screenshot/video proof for every collision-prone state.

### Phase IOSP-3 — Shared data/cache and view-lifetime foundation

**Goal:** Stop avoidable reloads without changing business data semantics.

**Work:**

- add request single-flight/deduplication;
- add conservative per-resource TTL/stale-while-revalidate rules;
- preserve root and high-frequency pushed view models appropriately;
- retain previous content during refresh;
- add image memory/disk cache and safe prefetch policy;
- centralize loading/error/empty-state presentation;
- never cache sensitive mutations or approval decisions as if confirmed;
- preserve whole-taka money rules and authorization boundaries.

**Exit criteria:**

- repeated warm navigation does not refetch unchanged data unnecessarily;
- concurrent identical GETs coalesce;
- mutation success invalidates only the correct resources;
- offline/stale content is visibly labelled and never mistaken for fresh approval state;
- baseline comparison shows reduced request count and route-to-content time.

### Phase IOSP-4 — Polling, realtime, and hidden web-runtime reduction

**Goal:** Remove global high-frequency work and reduce duplicate native/web runtime cost.

**Work:**

- replace global 3-second incoming-call polling with push/realtime/CallKit-compatible signalling;
- centralize scene-aware refresh scheduling;
- pause nonessential refresh when inactive/backgrounded;
- prefer event-driven invalidation over independent timers;
- consolidate Agent/office notification feeds where server contracts allow;
- audit why the hidden Capacitor dashboard must remain alive;
- extract only required plugin/session bridges or suspend web rendering safely;
- do not break Hermes `/api/agent/*`, existing push, Face ID, shortcuts, widgets, Live Activities, voice, or background work.

**Exit criteria:**

- no 2–3 second polling when the related UI is not active;
- five-minute idle request count is reduced by at least 80% from Phase 0 unless an evidence-backed exception is approved;
- background/foreground, incoming call, push, Live Activity, and authentication continuity pass;
- memory and CPU baselines improve or remain within documented limits;
- technical TestFlight checkpoint decision executed per section 9.

### Phase IOSP-5 — Agent rendering and interaction polish

**Goal:** Make Agent conversation behaviour calm, fast, and stable like a first-class AI app.

**Work:**

- split oversized Agent state/rendering into focused modules without changing server semantics;
- isolate message-list updates from composer, drawer, artifacts, voice, and background-task state;
- virtualize/paginate long histories and preserve scroll anchor;
- prevent polling/merge updates from yanking the user’s scroll position;
- reduce 30 fps perpetual decorative timelines and redundant repeat animations;
- establish one streaming/activity indicator grammar;
- stabilize keyboard, multiline composer, attachment tray, voice mode, side drawer, and task sheet transitions;
- ensure reduced-motion and VoiceOver behaviour;
- maintain full conversation history and current agent architecture rules.

**Exit criteria:**

- long-history scroll remains stable while new messages arrive;
- first-token/activity feedback appears without a blank/frozen state;
- keyboard/composer never jumps or overlaps;
- background-task detail remains live without 2-second full refreshes;
- Instruments shows no regression in hitching/memory;
- visual proof covers text, image, approval card, tool activity, error/retry, voice, and background-task states.

### Phase IOSP-6 — Core ERP native action parity

**Goal:** Complete the highest-value internal business workflows natively.

**Priority order:**

1. Orders
2. Approvals
3. Finance/expenses/payroll/office fund
4. Portal/payment accounts/wallet/task actions
5. Attendance and employee detail

**Work:**

- replace internal web drawers/forms/actions with native sheets/screens;
- share existing API contracts and authorization; do not create duplicate business rules;
- preserve whole-taka arithmetic via project money helpers;
- preserve salary/wallet debit semantics;
- add idempotency and self-verification where mutations require it;
- retain web only for explicitly approved public/system flows.

**Exit criteria:**

- the priority workflows have zero unapproved WKWebView transitions;
- success/error/partial-failure states are verified against real preview data;
- financial mutations include before/action/verified-after evidence;
- role/permission matrix passes;
- Vercel preview and Chrome proof completed for API/web changes.

### Phase IOSP-7 — Remaining native parity and deep workflows

**Goal:** Close the remaining internal web debt.

**Scope candidates:**

- inventory bulk/image/collection work;
- supplier import execution;
- users/roles/password/permissions;
- SMS and other settings mutations;
- business archive/restore;
- trading accounts, settlement, detail, and exports;
- Digital/CDIT client/project/invoice details;
- Agent cost/budget/log/export workflows;
- Live Watch;
- secure password reset completion.

**System handoff exception:** OAuth should use the appropriate system authentication session/browser boundary rather than recreating provider login inside SwiftUI or an embedded ERP WKWebView.

**Exit criteria:** route contract reports zero unapproved internal web transitions; every approved exception has an owner, reason, telemetry, and expiry/review date.

### Phase IOSP-8 — Xcode 27 and system-native visual modernization

**Goal:** Adopt relevant iOS 27 platform behaviour using the actual Xcode 27 SDK.

**Prerequisite:** Xcode 27 and an iOS 27 Simulator runtime must be installed and selected. Do not fake iOS 27 support with custom tokens.

**Work:**

- rebuild with Xcode 27 and inventory new warnings/behaviour changes;
- use standard navigation/tab/toolbar components where they provide the refreshed system appearance;
- use Liquid Glass primarily for controls/navigation, not every content card;
- evaluate relevant new SwiftUI state, content-building, toolbar, list/action, and model-provider APIs;
- maintain availability gates for supported older OS versions;
- remove deprecated `WKProcessPool` assumptions and audio-session APIs;
- begin Swift 6 readiness cleanup without a risky all-at-once migration;
- remove private implementation-class introspection from visual effect handling.

**Exit criteria:**

- Xcode 27 build passes on iOS 27 Simulator;
- iOS 26/older supported deployment behaviour is regression-tested where available;
- no claim of “iOS 27 native” relies only on manually drawn glass;
- visual hierarchy follows Apple HIG materials guidance;
- only relevant kits are adopted and each adoption has a user benefit.

### Phase IOSP-9 — Accessibility, visual consistency, final regression, and TestFlight

**Goal:** Produce a release candidate with evidence.

**Work:**

- complete semantic typography/Dynamic Type migration for critical screens;
- VoiceOver labels, order, focus restoration, rotor/grouping, and custom-action support;
- contrast, Reduce Motion, Reduce Transparency, Differentiate Without Color;
- unify spacing, corner radii, control heights, iconography, haptics, copy tone, Bangla/English rules;
- verify light/dark appearance if both are supported;
- run full route/native-parity contract;
- repeat Phase 0 Instruments/network/memory measurements;
- run simulator regression and required real-device/TestFlight checks;
- produce final evidence index and owner checklist.

**Exit criteria:**

- no P0/P1 issue remains open;
- all phase reports and proof artifacts are linked;
- performance comparison is honest and reproducible;
- all internal routes meet their classification;
- final TestFlight build passes the owner checklist;
- release/merge still requires explicit owner approval.

## 9. TestFlight strategy

### 9.1 Recommendation: two TestFlight builds across the programme

Do **not** create a TestFlight build after every phase. Simulator proof is mandatory after every phase.

Recommended total:

1. **Technical checkpoint TestFlight after IOSP-4** — validates APNs/push, CallKit/incoming-call signalling, background/foreground transitions, Live Activities, real-device memory/thermal behaviour, permissions, and hidden-web-runtime changes that the Simulator cannot prove reliably.
2. **Final owner acceptance TestFlight after IOSP-9** — the complete native/polish release candidate.

This keeps build noise low while protecting device-only functionality.

### 9.2 When one TestFlight build is acceptable

One final TestFlight build is acceptable only if IOSP-4 does **not** change device-only behaviour such as APNs, PushKit/CallKit, background modes, entitlements, Live Activities, camera/microphone permissions, biometric flows, or signed-extension behaviour. That restriction would reduce the performance improvement available in the roadmap.

Therefore the default recommendation is **two total TestFlight builds**, not one and not one per phase.

No TestFlight upload may be called successful until CI/archive signing, build metadata, and the resulting build’s availability in App Store Connect are verified.

## 10. Performance acceptance framework

Phase 0 sets the exact baseline. Final targets should include:

- warm root-tab switch feels immediate and does not refetch stable content;
- cached native route displays useful content within a target of 250 ms where no fresh authorization decision is required;
- idle request volume reduced by at least 80% from baseline;
- no app-wide 2–3 second polling loops;
- scrolling/keyboard/overlay transitions have no visible hitch on iPhone 17 Pro Max;
- memory stabilizes after repeated tab/route cycles and returns close to baseline after heavy sheets close;
- Agent long-history scrolling does not drift or jump during message merges;
- every network and mutation error produces a recoverable, truthful state;
- launch, first useful content, first Agent activity, and route-to-content timings are signposted and compared before/after.

Do not invent a 120 fps claim from visual inspection. Use Core Animation/Instruments and MetricKit evidence, and report actual measurements.

## 11. Regression matrix

At minimum, the final programme must cover:

| Dimension | Required states |
|---|---|
| Device | iPhone 17 Pro Max primary; a smaller iPhone; supported iPad size class if still targeted. |
| OS | iOS 27 current; oldest supported native SwiftUI OS; current production-relevant OS. |
| Appearance | Dark; light if supported; increased contrast; transparency reduction. |
| Text | Default, XL, accessibility sizes. |
| Input | Hardware/software keyboard, dictation/voice, camera/photo attachment. |
| Connectivity | Good, slow, offline, reconnect, request timeout. |
| Lifecycle | Cold launch, warm launch, background, foreground, terminated push/deep link. |
| Auth | Valid session, expired session, biometric lock, password reset/deep link. |
| Roles | Owner and representative restricted staff roles. |
| Agent | Text, image, approval, tool activity, background task, voice/call, retry/error. |
| Overlay | Banner/island/chat head/toast/sheet/alert/keyboard combinations. |
| Finance | Whole-taka display/mutations, debit direction, retry/idempotency. |

## 12. Risk and rollback rules

- Never modify `/api/agent/*` or its auth.
- New agent routes remain under `/api/assistant/*` and retain `AGENT_ENABLED` checks.
- No secret enters git.
- Database migrations are additive only unless a phase explicitly authorizes otherwise.
- Financial code is not refactored opportunistically.
- Every phase has a pre-phase tag and a narrow branch.
- Every mutation path must verify server result before displaying success.
- Preserve old native/web behaviour behind a short-lived rollback flag only when the phase risk justifies it; record removal date.
- If a phase requires broader architecture than its allowed file list, stop and request a new phase instead of expanding scope silently.
- Never merge to main, deploy production, or upload TestFlight without owner authorization.

## 13. Required phase report template

Each phase report must include:

```markdown
# IOSP-N Phase Report

## Scope
- Allowed files:
- Actual files changed:
- Explicitly out of scope:

## Root cause addressed

## Implementation summary

## Verification
- Unit/integration tests:
- Typecheck/lint/build:
- iPhone 17 Pro Max scenarios:
- Instruments/metrics:
- Vercel preview/Chrome proof, if applicable:

## Proof artifacts
- Screenshot/video paths:
- Preview URL:
- Build log summary:

## Regression and safety
- `git diff --stat`:
- Unrelated worktree changes preserved:
- AGENT_ENABLED/API/auth/money checks:

## PASS/FAIL checklist

## Remaining risks and next-phase handoff
```

## 14. Definition of programme completion

The programme is complete only when:

- every internal route is native or explicitly approved as a system/public exception;
- overlay occlusion is zero across the regression matrix;
- performance improvements are measured against Phase 0;
- Agent and core ERP workflows pass native parity scenarios;
- actual Xcode 27/iOS 27 builds and platform behaviour are verified;
- accessibility and adaptive text pass;
- Swift build warnings are triaged, with Swift 6 blockers resolved or scheduled explicitly;
- the final TestFlight passes owner testing;
- the owner explicitly approves merge/release.

Until then, “build succeeded” or “looks good in one screenshot” is not completion.
