# ANDROID NATIVE MIGRATION — HANDOFF (single source of truth)

> Android twin of the iOS native program (`NATIVE_MIGRATION_HANDOFF.md`). Goal: the ALMA
> Lifestyle module looks and works EXACTLY like the native iOS app — same design, same
> colours, same blocks — implemented in Kotlin + Jetpack Compose. The iOS SwiftUI page
> files are the **design source of truth**: port each `ios/App/App/<Name>SwiftUI.swift`
> 1:1 to `android/app/src/main/java/com/almatraders/erp/pages/<Name>Screen.kt`.

## 0. Architecture (locked — mirrors iOS)

- **Shell:** `MainActivity` stays a Capacitor `BridgeActivity`. `NativeShell.install()`
  (called after `super.onCreate`) lifts the Capacitor view out, keeps it MOUNTED at 1dp
  (plugins/OneSignal/login keep running — the iOS DashboardHostController reason), and
  wraps everything in a Compose shell: aurora background + 5-tab bottom bar
  (Dashboard / Orders / Assistant / Approvals / More) + per-tab push stacks.
- **Flag:** `alma-native-screens` (SharedPreferences, default ON). More → "Native স্ক্রিন"
  OFF → `activity.recreate()` → the plain Capacitor app, exactly as before (escape hatch).
- **Networking:** `shell/AlmaApi.kt` — HttpURLConnection + the app-global WebView
  `CookieManager` session (Android needs no cookie copy dance), redirect-blocking
  (307→/login = notAuthenticated), org.json + `flexInt/str/mapObjects` defensive readers.
- **Theme:** `shell/AlmaTheme.kt` — the iOS `AlmaSwiftTheme` tokens verbatim (coral
  #E07A5F, violet #a78bfa, sage #81B29A, cream #F2F0F8 / dark #0b0a12, card #171521,
  radii 26/14/34, `takaShort`). Dark state in SharedPreferences `alma-theme-mode`,
  pushed one-way native→web (cookie `alma-theme` + `applyJs()` on every live WebView).
- **Aurora + glass:** `shell/Aurora.kt` — `AuroraBackground` (exact iOS gradient stops)
  + `Modifier.almaGlass(dark, corner)` + `plainClick`. Android has no cheap backdrop
  blur, so glass = translucent white wash + hairline ring (the iOS fallback look).
- **Web fallback:** `shell/WebTab.kt` — `buildErpWebView()` injects the SAME embed flags
  the iOS shell does (`window.__almaNative`, `__almaNativeHeader`, hide-chrome CSS,
  `?native=1&nativehdr=1` belt-and-suspenders) so unmigrated pages render web-embedded
  with native chrome. External links (tel:, wa.me) go to the system.
- **Router:** `shell/AlmaNativeRouter.kt` — bare route path → native Compose screen; one
  additive `when` case per migrated page; everything else = WebView. `PushCtx.openWebForced`
  NEVER consults the router (recursion guard, same as iOS).
- **Build:** Kotlin 1.9.22 + Compose BOM 2024.02.02 (compiler ext 1.5.8) on AGP 8.2.1,
  jvmTarget 21. `google-services.json` is gitignored — copy it from the main worktree
  into `android/app/` in every fresh worktree, and run `npx cap sync android` once
  (generates `android/capacitor-cordova-android-plugins/`).

## 1. PAGE REGISTRY (Android) — status per page

Design source = the iOS Swift file. Endpoints/fields are already discovered there — do
NOT re-derive from the web.

| Page | Route | iOS source (design truth) | Android file | Status |
|---|---|---|---|---|
| Shell (tabs/theme/api/aurora/router/webtab) | — | SpikeNativeShell.swift + SwiftUIShell.swift | shell/*.kt | DONE (this session) |
| Dashboard | `/` | DashboardSwiftUI.swift | pages/DashboardScreen.kt | DONE v1 (no assistive dock; todo panel ported) |
| Orders list + detail + status actions | `/orders` | OrdersSwiftUI.swift | pages/OrdersScreen.kt | DONE v1 (create form = web escape) |
| Order create (native form) | `/orders/new` | OrderCreateSwiftUI.swift | pages/OrderCreateScreen.kt | NOT_STARTED |
| Approvals (business + agent + integrity) | `/approvals` | ApprovalsSwiftUI.swift | pages/ApprovalsScreen.kt | DONE v1 |
| More menu | (native) | MoreMenuSwiftUI.swift | pages/MoreMenuScreen.kt | DONE v1 (Face ID lock row deferred — Android biometric later) |
| Assistant | `/agent` | AssistantSwiftUI.swift | — | KEEP_WEB for now (web tab embeds; native chat is its own program) |
| Finance | `/finance` | FinanceSwiftUI.swift | pages/FinanceScreen.kt | NOT_STARTED |
| Office fund | `/finance/office-fund` | OfficeFundSwiftUI.swift | pages/OfficeFundScreen.kt | NOT_STARTED |
| Expenses | `/expenses` | ExpensesSwiftUI.swift | pages/ExpensesScreen.kt | NOT_STARTED |
| Payroll | `/payroll` | PayrollSwiftUI.swift | pages/PayrollScreen.kt | NOT_STARTED |
| Invoices | `/invoice` | InvoicesSwiftUI.swift | pages/InvoicesScreen.kt | NOT_STARTED |
| Inventory | `/inventory` | InventorySwiftUI.swift | pages/InventoryScreen.kt | NOT_STARTED |
| Supplier import | `/inventory/supplier-import` | SupplierImportSwiftUI.swift | pages/SupplierImportScreen.kt | NOT_STARTED |
| Activity | `/activity` | ActivitySwiftUI.swift | pages/ActivityScreen.kt | NOT_STARTED |
| Task Spotlight | `/operations/task-spotlight` | TaskSpotlightSwiftUI.swift | pages/TaskSpotlightScreen.kt | NOT_STARTED |
| Business archive | `/operations/business-archive` | BusinessArchiveSwiftUI.swift | pages/BusinessArchiveScreen.kt | NOT_STARTED |
| System diagnostics | `/operations/system-diagnostics` | SystemDiagnosticsSwiftUI.swift | pages/SystemDiagnosticsScreen.kt | NOT_STARTED |
| Employees (+detail) | `/employees` | EmployeesSwiftUI.swift | pages/EmployeesScreen.kt | NOT_STARTED |
| Attendance | `/attendance` | AttendanceSwiftUI.swift | pages/AttendanceScreen.kt | NOT_STARTED |
| CRM | `/crm` | CrmSwiftUI.swift | pages/CrmScreen.kt | NOT_STARTED |
| Analytics | `/analytics` | AnalyticsSwiftUI.swift | pages/AnalyticsScreen.kt | NOT_STARTED |
| Insights | `/insights` | InsightsSwiftUI.swift | pages/InsightsScreen.kt | NOT_STARTED |
| Briefing | `/briefing` | BriefingSwiftUI.swift | pages/BriefingScreen.kt | NOT_STARTED |
| Audit | `/audit` | AuditSwiftUI.swift | pages/AuditScreen.kt | NOT_STARTED |
| My Desk | `/portal` | PortalSwiftUI.swift | pages/PortalScreen.kt | NOT_STARTED |
| Portal expense | `/portal/expense` | PortalExpenseSwiftUI.swift | pages/PortalExpenseScreen.kt | NOT_STARTED |
| Office | `/portal/office` | PortalOfficeSwiftUI.swift | pages/PortalOfficeScreen.kt | NOT_STARTED |
| Payment accounts | `/portal/payment-accounts` | PaymentAccountsSwiftUI.swift | pages/PaymentAccountsScreen.kt | NOT_STARTED |
| Settings pages | `/settings/*` | Settings*SwiftUI.swift | pages/Settings*Screen.kt | NOT_STARTED |

Trading / CDIT: out of scope for this program (owner asked Lifestyle first).

## 2. Porting recipe (per page)

1. Read the iOS `<Name>SwiftUI.swift` — models (field names + wrapped/flat response
   shape), VM logic, blocks, exact hexes. Copy its lessons (they cost real time on iOS).
2. Write `pages/<Name>Screen.kt`: `@Composable fun <Name>Screen(ctx: PushCtx)` + a
   plain state-holder class with `mutableStateOf` fields + suspend `load()`.
   Parse JSON with `AlmaApi.getObject/send` + `flexInt/str/mapObjects`.
3. Surfaces: `Modifier.almaGlass(dark, AlmaTheme.R_CARD)` cards on the shared aurora,
   chips as capsules, sheets = `ModalBottomSheet(containerColor = AlmaTheme.rootBg(dark))`.
4. Register the route in `AlmaNativeRouter.screen()` (one `when` case).
5. Update this registry row, build `./gradlew assembleDebug` (JAVA_HOME = Android
   Studio JBR), verify on the emulator, screenshot.

## 3. Emulator self-test recipe

- AVD `alma_test` (Pixel-class, `system-images;android-35;google_apis;arm64-v8a`).
- Build: `cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ANDROID_HOME=~/Library/Android/sdk ./gradlew assembleDebug`
- Run: `~/Library/Android/sdk/emulator/emulator -avd alma_test -no-snapshot &`,
  `adb install -r app/build/outputs/apk/debug/app-debug.apk`,
  `adb shell am start -n com.almatraders.erp/.MainActivity`,
  screenshot: `adb exec-out screencap -p > /tmp/android-ss.png`.
- Login: open any screen → "লগইন খুলুন" opens the web /login inside the shell; the owner
  types credentials (never Claude). Cookies are app-global — native API calls work after.

## 4. Known gaps / next steps

- Native order-create form (OrderCreateSwiftUI port) — FAB currently opens the web form.
- Assistive shortcut dock on Dashboard (iOS AgentAssistiveNav) — not ported yet.
- Custom date range on Orders uses two sequential DatePicker picks — replace with a
  proper range picker (Material3 DateRangePicker) in a polish pass.
- Biometric app-lock row (More) — needs androidx.biometric, deferred.
- Push-open deep links land on the Capacitor webview (1dp) — route notification taps
  into the native shell in a later pass.
