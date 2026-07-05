# NATIVE MIGRATION — PARALLEL-SESSION HANDOFF (single source of truth)

> **How to run 2–3 parallel sessions safely — the 4 rules that matter (read in 10 seconds):**
> 1. **One session = one page = one registry row.** You may edit ONLY the files in your page's
>    "Owning files" cell — nothing else, ever.
> 2. **Frozen files are untouchable** (list in §2 — includes `project.pbxproj`, the shell,
>    `AlmaAPI`, `ClaudeTopFade`, all web shared code). Need a shared change? APPEND it to
>    `SHARED_CHANGES_REQUESTED.md` and keep working — the owner applies it centrally.
> 3. **One branch per page** (`native/<page-slug>`), each in its own `git worktree`, based off
>    the integration branch. Only the owner merges, one page at a time (§3).
> 4. **Claim before you code:** set your registry row to IN_PROGRESS (your row ONLY), do the
>    §4 handshake, and verify with `swiftc -typecheck` (you cannot build the app — pbxproj is
>    frozen; the owner registers your file and sim-verifies at integration).

**Program context:** Capacitor + Next.js hybrid ERP → migrating screen-by-screen to native
SwiftUI **inside the existing UIKit shell** (tabs, glass bars, `AlmaTheme`, shared login all
stay — see `docs/ios-native-frame-handoff.md` §0-d for the S6 pattern). A "page migration" =
one new `ios/App/App/<Name>SwiftUI.swift` consuming the SAME JSON APIs the web page calls via
`AlmaAPI` (cookie bridge). Web `src/app/**` code is **read-only reference** for page sessions
(API shapes, field names, theme tokens) — page sessions do NOT edit web code at all.

---

## 1. PAGE REGISTRY (claim your row; update ONLY your row)

Status: `NOT_STARTED` / `IN_PROGRESS` / `IN_REVIEW` / `DONE` / `KEEP_WEB` (deliberately never
migrated) / `FROZEN_CAPACITOR` (must stay Capacitor — hard rule).
"Owning files" = the ONLY paths that page's session may create/edit. Reserved Swift filenames
are pre-assigned here so two sessions can never pick the same name.

### Core tabs (native shell)
| Page | Route | Owning files (writable scope) | Surface | Status | Owner |
|---|---|---|---|---|---|
| Dashboard | `/` | — (Capacitor `AlmaBridgeViewController` — push/reminders/N1–N5 live here) | mixed | FROZEN_CAPACITOR | — |
| Assistant (Claude surface) | `/agent` | `ios/App/App/AssistantSwiftUI.swift` | native | IN_REVIEW (owner instruction 2026-07-06 lifted KEEP_WEB; native chat sim-verified, see handoff §0-e; web fallback intact via flag) | assistant session |
| Orders list | `/orders` | `ios/App/App/OrdersSwiftUI.swift` | native | DONE (b36) | main session |
| Order create | `/orders/new` | `ios/App/App/OrderCreateSwiftUI.swift` | native | IN_REVIEW (b36 — owner's first live submit = e2e test) | main session |
| Approvals | `/approvals` | `ios/App/App/ApprovalsSwiftUI.swift` | native | IN_REVIEW (v2 web-parity 2026-07-06: web colours/blocks + Agent view + KPI strip + withdraw txn-id + leave/salary/payout digests; iOS-polish agent cards; sim-verified light+dark on branch `native/approvals-parity`) | approvals session |
| More menu | (native) | `ios/App/App/MoreMenuSwiftUI.swift` | native | DONE (b35) | main session |
| Phone Companion | (native) | `ios/App/App/CompanionSwiftUI.swift` (chrome only; `AlmaCompanion.swift` is FROZEN) | native | DONE (b35) | main session |

### Money
| Page | Route | Owning files | Surface | Status | Owner |
|---|---|---|---|---|---|
| Finance | `/finance` | `ios/App/App/FinanceSwiftUI.swift` | native | IN_REVIEW (marathon b1 2026-07-06, sim-build pending at marathon end) | marathon session |
| Office fund | `/finance/office-fund` | `ios/App/App/OfficeFundSwiftUI.swift` | native | IN_REVIEW (marathon b2 2026-07-06, sim-build pending at marathon end) | marathon session |
| Expenses | `/expenses` | `ios/App/App/ExpensesSwiftUI.swift` | native | IN_REVIEW (marathon b1 2026-07-06, sim-build pending at marathon end) | marathon session |
| Payroll | `/payroll` | `ios/App/App/PayrollSwiftUI.swift` | native | IN_REVIEW (marathon b1 2026-07-06, sim-build pending at marathon end) | marathon session |
| Invoices | `/invoice` | `ios/App/App/InvoicesSwiftUI.swift` | native | IN_REVIEW (marathon b1 2026-07-06, sim-build pending at marathon end) | marathon session |
| Invoice share | `/invoice/share/[slug]` | — (public link, stays web) | web | KEEP_WEB | — |

### Operations
| Page | Route | Owning files | Surface | Status | Owner |
|---|---|---|---|---|---|
| Inventory | `/inventory` | `ios/App/App/InventorySwiftUI.swift` | native | IN_REVIEW (marathon b2 2026-07-06, sim-build pending at marathon end) | marathon session |
| Supplier import | `/inventory/supplier-import` | `ios/App/App/SupplierImportSwiftUI.swift` | web | NOT_STARTED | — |
| Activity | `/activity` | `ios/App/App/ActivitySwiftUI.swift` | native | IN_REVIEW (marathon b2 2026-07-06, sim-build pending at marathon end) | marathon session |
| Task Spotlight | `/operations/task-spotlight` | `ios/App/App/TaskSpotlightSwiftUI.swift` | web | NOT_STARTED | — |
| Business archive | `/operations/business-archive` | `ios/App/App/BusinessArchiveSwiftUI.swift` | web | NOT_STARTED | — |
| System diagnostics | `/operations/system-diagnostics` | `ios/App/App/SystemDiagnosticsSwiftUI.swift` | web | NOT_STARTED | — |

### People
| Page | Route | Owning files | Surface | Status | Owner |
|---|---|---|---|---|---|
| Employees | `/employees` | `ios/App/App/EmployeesSwiftUI.swift` | native | IN_REVIEW (marathon b2 2026-07-06, sim-build pending at marathon end) | marathon session |
| Employee detail | `/employees/[id]` | (same file as Employees — one session owns both) | native | IN_REVIEW (marathon b2 2026-07-06, sim-build pending at marathon end) | marathon session |
| Attendance | `/attendance` | `ios/App/App/AttendanceSwiftUI.swift` | web | NOT_STARTED | — |
| CRM | `/crm` | `ios/App/App/CrmSwiftUI.swift` | web | NOT_STARTED | — |

### Insights
| Page | Route | Owning files | Surface | Status | Owner |
|---|---|---|---|---|---|
| Analytics | `/analytics` | `ios/App/App/AnalyticsSwiftUI.swift` | web | NOT_STARTED | — |
| Insights | `/insights` | `ios/App/App/InsightsSwiftUI.swift` | web | NOT_STARTED | — |
| Briefing | `/briefing` | `ios/App/App/BriefingSwiftUI.swift` | web | NOT_STARTED | — |
| Audit | `/audit` | `ios/App/App/AuditSwiftUI.swift` | web | NOT_STARTED | — |

### Portal (staff desk)
| Page | Route | Owning files | Surface | Status | Owner |
|---|---|---|---|---|---|
| My Desk | `/portal` | `ios/App/App/PortalSwiftUI.swift` | web | NOT_STARTED | — |
| Portal expense | `/portal/expense` | `ios/App/App/PortalExpenseSwiftUI.swift` | web | NOT_STARTED | — |
| Office | `/portal/office` | `ios/App/App/PortalOfficeSwiftUI.swift` | web | NOT_STARTED | — |
| Payment accounts | `/portal/payment-accounts` | `ios/App/App/PaymentAccountsSwiftUI.swift` | web | NOT_STARTED | — |

### Trading business
| Page | Route | Owning files | Surface | Status | Owner |
|---|---|---|---|---|---|
| Trading home | `/trading` | `ios/App/App/TradingHomeSwiftUI.swift` | web | NOT_STARTED | — |
| Trading accounts | `/trading/accounts` + `[id]` | `ios/App/App/TradingAccountsSwiftUI.swift` | web | NOT_STARTED | — |
| Trading analytics | `/trading/analytics` | `ios/App/App/TradingAnalyticsSwiftUI.swift` | web | NOT_STARTED | — |
| Trading HR | `/trading/hr` | `ios/App/App/TradingHrSwiftUI.swift` | web | NOT_STARTED | — |
| Target control | `/trading/target-control` | `ios/App/App/TargetControlSwiftUI.swift` | web | NOT_STARTED | — |
| Trading telegram | `/trading/telegram` | `ios/App/App/TradingTelegramSwiftUI.swift` | web | NOT_STARTED | — |

### Digital (CDIT) business
| Page | Route | Owning files | Surface | Status | Owner |
|---|---|---|---|---|---|
| Digital home | `/digital` | `ios/App/App/DigitalHomeSwiftUI.swift` | web | NOT_STARTED | — |
| Digital clients | `/digital/clients` + `[id]` | `ios/App/App/DigitalClientsSwiftUI.swift` | web | NOT_STARTED | — |
| Digital finance | `/digital/finance` | `ios/App/App/DigitalFinanceSwiftUI.swift` | web | NOT_STARTED | — |
| Digital invoices | `/digital/invoices` | `ios/App/App/DigitalInvoicesSwiftUI.swift` | web | NOT_STARTED | — |
| Digital projects | `/digital/projects` | `ios/App/App/DigitalProjectsSwiftUI.swift` | web | NOT_STARTED | — |

### Agent sub-pages (inside the Assistant surface — migrate LAST, owner call per page)
| Page | Route | Owning files | Surface | Status | Owner |
|---|---|---|---|---|---|
| Creative Studio | `/agent/creative-studio` | — (owner's no-LLM-judgment pipeline, heavy web UI) | web | KEEP_WEB | — |
| WhatsApp inbox | `/agent/whatsapp` | `ios/App/App/AgentWhatsappSwiftUI.swift` | web | NOT_STARTED | — |
| Costs | `/agent/costs` | `ios/App/App/AgentCostsSwiftUI.swift` | web | NOT_STARTED | — |
| Staff monitor | `/agent/staff-monitor` | `ios/App/App/StaffMonitorSwiftUI.swift` | web | NOT_STARTED | — |
| Growth | `/agent/growth` | `ios/App/App/AgentGrowthSwiftUI.swift` | web | NOT_STARTED | — |
| Known people | `/agent/known-people` | `ios/App/App/KnownPeopleSwiftUI.swift` | web | NOT_STARTED | — |
| Catalog images | `/agent/catalog-images` | `ios/App/App/CatalogImagesSwiftUI.swift` | web | NOT_STARTED | — |
| Trading staff | `/agent/trading-staff` | `ios/App/App/TradingStaffSwiftUI.swift` | web | NOT_STARTED | — |
| Live watch | `/agent/live-watch` | — (P3 companion feed, owner call) | web | KEEP_WEB | — |
| Studio demo | `/agent/creative-studio-demo` | — (demo page) | web | KEEP_WEB | — |

### Settings
| Page | Route | Owning files | Surface | Status | Owner |
|---|---|---|---|---|---|
| Users | `/settings/users` | `ios/App/App/SettingsUsersSwiftUI.swift` | web | NOT_STARTED | — |
| Notifications | `/settings/notifications` | `ios/App/App/SettingsNotificationsSwiftUI.swift` | web | NOT_STARTED | — |
| Branding | `/settings/branding` | `ios/App/App/SettingsBrandingSwiftUI.swift` | web | NOT_STARTED | — |
| SMS | `/settings/sms` | `ios/App/App/SettingsSmsSwiftUI.swift` | web | NOT_STARTED | — |
| Telegram Ops | `/settings/telegram-ops` | `ios/App/App/SettingsTelegramSwiftUI.swift` | web | NOT_STARTED | — |
| Database | `/settings/database` | `ios/App/App/SettingsDatabaseSwiftUI.swift` | web | NOT_STARTED | — |
| Session | `/settings/session` | `ios/App/App/SettingsSessionSwiftUI.swift` | web | NOT_STARTED | — |

### Never migrated (auth / legal / misc web-only)
`/login`, `/forgot-password`, `/reset-password` (auth = web, cookies feed the native session),
`/privacy-policy`, `/app/download` — all **KEEP_WEB**, no registry owner ever.

---

## 2. FILE OWNERSHIP — the anti-conflict rule

**A page session may create/edit ONLY the file(s) in its registry row. Everything below is
FROZEN for page sessions — read freely, never write:**

**Native shared (ios/App/):**
- `App/SpikeNativeShell.swift` — shell, tabs, `AlmaTheme`, glass bars, web tab VC
- `App/SwiftUIShell.swift` — `AlmaSwiftUIFlag`, `AlmaHostingController`, `AlmaSwiftTheme`, tab builders
- `App/AlmaAPI.swift` — the cookie-bridge network client (consume `AlmaAPI.shared` as-is)
- `App/ClaudeTopFade.swift` — **the shared TopScrollFade. Page sessions CONSUME `.claudeTopFade()`
  only. Any tweak = shared-change queue, so every page stays visually in sync (§7).**
- `App/AlmaCompanion.swift`, `App/AlmaBridgeViewController.swift`, `App/AppDelegate.swift`,
  every `*Bridge*.swift`, `AlmaEntities.swift`, `AlmaAppIntents.swift`, `BackgroundRefresh.swift`,
  `PulseActivityAttributes.swift`
- **`App.xcodeproj/project.pbxproj` — the #1 merge-collision file.** New Swift files are
  registered by the OWNER only (4 additive entries). Your session type-checks without it:
  `xcrun swiftc -typecheck -sdk $(xcrun --sdk iphonesimulator --show-sdk-path) -target arm64-apple-ios17.0-simulator ios/App/App/<You>.swift ios/App/App/{SwiftUIShell,AlmaAPI,ClaudeTopFade,SpikeNativeShell}.swift` (drop SpikeNativeShell if its Capacitor imports block you — then decouple like MoreMenuSwiftUI did).
- `App/App/Podfile`, `capacitor.config.*`, `Info.plist`, entitlements, storyboards

**Web shared (ALL of `src/` is read-only for page sessions; these are frozen even for the owner's casual edits):**
- `src/app/layout.tsx`, `src/app/globals.css`, `src/components/{ui,ui-mobile,layout,providers,ambient,loading,mobile}/`
- `src/lib/**` (incl. `api.ts`, `money.ts`), `src/contexts/**`, `src/agent/**`
- `/api/agent/*` routes + their auth — **hard-rule frozen for everyone** (Hermes bot)
- `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.*`, tailwind config

**Docs / coordination files:**
- This file: rows other than your own are frozen; §1–§7 text is owner-only.
- `docs/ios-native-frame-handoff.md` — owner/main sessions only.
- `SHARED_CHANGES_REQUESTED.md` — **append-only** (never rewrite others' entries).

**If your migration NEEDS a shared change** (new pbxproj registration, a tab-builder hook in
`SwiftUIShell.swift`, a `MoreMenuSwiftUI` row pointing to your screen, a ClaudeTopFade tweak, a
web CSS gate): do NOT edit it. Append to `SHARED_CHANGES_REQUESTED.md` (format inside) and
continue building what you can. The owner applies queued changes centrally, serially, between
sessions.

---

## 3. BRANCH / WORKTREE STRATEGY

- **Integration branch (= "native-main"): `claude/ios-s0-native-shell-spike`.** All native work
  integrates here (it is TestFlight's source today). If a literal `native-main` branch is ever
  cut, it will be announced in this doc — until then the spike branch IS native-main.
- **One branch per page, one worktree per session:**
  ```bash
  git fetch origin claude/ios-s0-native-shell-spike
  git worktree add ../wt-native-<page-slug> -b native/<page-slug> origin/claude/ios-s0-native-shell-spike
  # session works ONLY inside ../wt-native-<page-slug>
  ```
  Slug = kebab-case route (e.g. `native/finance`, `native/agent-costs`, `native/settings-users`).
- **Sessions push their page branch only:** `git push origin native/<page-slug>`. NEVER push to
  the integration branch, never merge another session's branch.
- **Merge policy (owner-driven, strictly serial):**
  ```bash
  git checkout claude/ios-s0-native-shell-spike && git pull
  git merge --no-ff native/<page-slug>        # one page at a time, oldest-claimed first
  # apply that page's queued shared changes (pbxproj registration etc.) NOW, then:
  xcodebuild ... build && sim-verify          # per docs/ios-native-frame-handoff.md recipes
  git push origin claude/ios-s0-native-shell-spike
  git worktree remove ../wt-native-<page-slug> && git branch -d native/<page-slug>
  ```
  Then the owner flips that page's registry row to DONE and re-bases any still-open page
  branches (`git rebase origin/claude/ios-s0-native-shell-spike` inside their worktrees).

---

## 4. SESSION SCOPE GUARDRAIL — mandatory start-of-session handshake

Before touching ANY file, a page session MUST print (in its first reply):
1. **Assignment:** "I am migrating ONLY `<page>` (`<route>`), per my registry row."
2. **Writable allow-list:** the exact file(s) from that row (+ its own branch/worktree path).
3. **The pledge:** "I will not edit any frozen/shared file (§2), any other page's files, other
   registry rows, or the integration branch. If a task needs an out-of-scope edit, I will STOP
   and append it to `SHARED_CHANGES_REQUESTED.md` instead."
4. **Claim:** set its registry row Status → IN_PROGRESS + Owner → session name, commit that
   one-line change first (`chore(native): claim <page> row`).
5. On finish: row → IN_REVIEW, push branch, list queued shared changes in the final report.

A session that cannot complete the handshake (row already IN_PROGRESS by someone else, unclear
scope) must STOP and ask the owner — never improvise.

---

## 5. PER-SESSION KICKOFF PROMPT (copy-paste, fill the blanks)

```
docs/ios-native-frame-handoff.md আর NATIVE_MIGRATION_HANDOFF.md পড়ে শুরু করো।

You are working ONLY on the '<PAGE NAME>' page (route: <ROUTE>). Your writable scope is
EXACTLY the file(s) in that page's registry row in NATIVE_MIGRATION_HANDOFF.md, inside your
own worktree on branch native/<page-slug>. Do the §4 handshake first and claim your row
(IN_PROGRESS).

Rules: do not edit any frozen/shared file (§2 — including project.pbxproj, SpikeNativeShell,
SwiftUIShell, AlmaAPI, ClaudeTopFade, anything under src/, package files), any other page, or
other registry rows. If you need a shared change, append it to SHARED_CHANGES_REQUESTED.md
and continue. Web code is read-only reference for API shapes and theme tokens.

Build the screen the S6 way: SwiftUI @available(iOS 17,*), data via AlmaAPI.shared from the
SAME endpoints the web page uses, AlmaSwiftTheme colours + the web's exact status hexes,
.claudeTopFade() on the scroll, Bangla labels where the web has them, escape hatch to the web
page for anything not yet native. Verify with swiftc -typecheck (you cannot build the app —
pbxproj is frozen). When done: registry row → IN_REVIEW, push native/<page-slug>, report files
+ queued shared changes + what the owner must sim-verify.
```

---

## 6. INTEGRATION & CONFLICT-CHECK (owner, after each page)

1. `git fetch` → rebase the finished page branch on the integration branch → expect **zero
   conflicts** (if scope was respected, its only file is new).
2. Apply that page's `SHARED_CHANGES_REQUESTED.md` entries yourself (pbxproj registration, tab/
   More-menu hook), mark them ✅ in the queue.
3. Build + sim-verify per the recipes in `docs/ios-native-frame-handoff.md` (browser/sim proof
   rule applies — a screenshot or it didn't happen).
4. Merge (§3), push, registry row → DONE, rebase remaining open branches, ship in the next
   batched TestFlight build.

**Why conflicts happen (self-check):** two sessions in one branch/worktree · anyone editing a
frozen file "just this once" (pbxproj and globals.css are the classic ones) · barrel/index or
registry edits outside your row · lockfile churn (`npm install` in a page session — never do
it) · renaming instead of creating your pre-assigned file.

---

## 7. SHARED TopScrollFade NOTE

**The effect now exists on BOTH surfaces from one design spec — these tokens must stay in
sync (change one side ⇒ change the other, via the shared-change queue):**

| Token | Value | Native (ClaudeTopFade.swift) | Web (TopScrollFade.tsx/.module.css) |
|---|---|---|---|
| FADE_HEIGHT | safe-area top + 88 | `ClaudeTopFadeTheme.fadeHeight` | `calc(env(safe-area-inset-top) + 88px)` |
| BLUR RAMP | ~8px top → 0 bottom | masked `.systemThinMaterial` | 5 masked backdrop-filter layers (0.5/1/2/4/8px) |
| SCRIM | surface's own bg | AlmaTheme.rootBg twins | `var(--bg-0)` |

Web twin: `src/components/layout/TopScrollFade.tsx` + `.module.css`, mounted once in
`app/layout.tsx`, **gated `html.alma-native`** (desktop/mobile-web see nothing). Both files
are SHARED/FROZEN exactly like the Swift one.

`ios/App/App/ClaudeTopFade.swift` (and any future web twin of the fade) is a **shared, frozen
design-system component**. Every page consumes `.claudeTopFade()` exactly as-is so the whole
app scrolls identically. Blur strength / height / scrim tweaks change EVERY screen at once —
so they go through `SHARED_CHANGES_REQUESTED.md`, owner-applied, never edited from a page
session. Same status for `AlmaSwiftTheme` (colours) — consume, never fork, never inline-copy
new hexes (ask for a token instead).
