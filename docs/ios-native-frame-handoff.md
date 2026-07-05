# iOS Native-Frame Program — Handoff (START HERE)

**Owner:** Maruf (non-engineer). **Reply in Bangla, concise, plain language.**
**Goal:** make the ALMA ERP iOS app *feel like the Claude iOS app* — a fully native iOS feel.
**Approach (owner-approved, locked):** "Option 1 / native frame" — native chrome (tab bar, headers, nav, gestures, haptics, floating buttons in Swift) wrapping the existing web ERP as content ("embed mode"). We do NOT rebuild every screen.

> **Resume phrase:** the owner pastes *"docs/ios-native-frame-handoff.md poড়e ekhan theke continue koro"*. This file must let you continue with zero re-discovery.

---

## 0. 🔴 READ FIRST — the ONE thing the owner is waiting on

The **top frosted-glass bar on the Assistant tab is NOT approved.** Across the last session I built it 3 different ways and the owner still says it's not what he wants (his exact words: *"ami je top e glass frosted bar caisi, seta tmr design hoy ni"*). He wants a **new session to redo the frosted-glass top bar AFTER taking his confirmation on the design first** — do NOT just build a version and ship it. His reference = the **Claude iOS app**: a LIGHT frosted bar where the chat content is clearly visible BLURRED as it scrolls UNDER the bar, a hamburger (☰) in a frosted circle top-left, and a SOLID CORAL/orange compose button top-right, dark title. **And it must look right in BOTH light and dark mode.**

**Your first move next session:** show the owner the current sim state, put the Claude reference next to it, and ASK exactly what's still off (colour? blur strength? bar height? material? the way content shows through?) BEFORE writing code. He's frustrated by wrong-direction rebuilds — confirm the design, THEN build once.

---

## 1. CURRENT STATE — 2026-07-05 (read carefully)

- **Native branch (all iOS shell work): `claude/ios-s0-native-shell-spike`.** Native file = `ios/App/App/SpikeNativeShell.swift`. This worktree = `.claude/worktrees/exciting-chatelet-616c32` (build env already set up here — see §5).
- **⚠️ PARALLEL WORK on the same branch:** another session shipped **build 31 = "P3 mobile companion"** (`AlmaCompanionViewController`, agent drives a browser on the phone) while I was working. My theme WIP was rebased on top of it. **Expect more parallel commits — always `git fetch` + rebase before pushing.**
- **Web is on `main`, LIVE on prod** (`alma-erp-six.vercel.app`). The native app loads live prod in WebViews, so a web merge to main changes the app after the WebView's **service worker updates** (Rule §2.1).
- **TestFlight builds:** last VALID uploaded = **29** (2026-07-05). **30** (light frosted bar + hamburger/coral) is **committed but NOT uploaded**. **31** (P3 companion) shipped by the other session. The **theme WIP is committed (`5b2034f8`) but NOT uploaded and NOT owner-approved.**

### ✅ DONE + owner/sim-verified this session (the 5 "next tasks" from the prior handoff)
1. **Glass under-scroll (content passes UNDER the agent bar):** works via a **native-injected inset** — `env(safe-area-inset-top)` is unreliable in the plain WKWebView (`contentInsetAdjustmentBehavior=.never` zeroes it), so the shell injects the exact bar height into `--alma-top-inset` (like `--kb-inset`) and the web uses `padding-top: calc(1rem + var(--alma-top-inset, env(safe-area-inset-top)))` on `.agent-thread-content` (+ `.agent-main-col{padding-top:0}`), gated `alma-native-hdr`. The agent WebView is pinned to `root.topAnchor`. **Verified: a chat line clips + frosts UNDER the bar when scrolling.** ← the MECHANISM is right; the owner's complaint is the bar's LOOK, not the under-scroll.
2. **Dashboard top overlap fixed** (web): `html.alma-native-hdr .page-header{padding-top:calc(0.5rem + env(safe-area-inset-top))}`. Verified in sim.
3. **Premium loader** (native `AlmaPremiumLoader`: breathing violet orb + morphing dots, theme backdrop) replaced the plain spinner + killed the white flash. Code-verified (the sub-second flash is uncatchable in the fast sim).
4. **Full RADIAL AssistiveTouch menu** — rewrote `AgentAssistiveNav` to a fanned arc of frosted icon discs around the FAB (Chat/Studio/WhatsApp/Monitor/Costs), staggered spring. **Verified in sim — looks great.**
5. **Glassy drawer back** — order-detail drawer close moved to a top-LEFT frosted back chevron (was hidden behind the Orders page's root-level floating chips). Verified in sim.

All web changes for the above are **live on `main`** (gated `alma-native-hdr`, no-op for web/desktop; commit chain `c7095150 → 711ace56 → 1ec53dc`).

### 🟡 IN PROGRESS / NOT approved
- **Frosted top bar redesign** (see §0) — the big open item.
- **Full app light/dark theme (WIP commit `5b2034f8`, builds clean, LIGHT mode verified, DARK mode NOT yet visually verified, NOT owner-approved):** a central `AlmaTheme` manager (mirrors the web `alma-theme` cookie; UserDefaults for a no-flash launch read) restyles the WHOLE shell for light/dark: tab bar + every nav bar (clean Claude frosted, no violet slab) + roots + loaders + the agent's hamburger/coral buttons; ERP web tabs push `data-theme` into their WebView on `.almaThemeChanged`; the Capacitor Dashboard's WebView is flipped from the tab-bar controller. **More tab has a new "Appearance → Dark Mode" switch** (`AlmaTheme.set/toggle`). The More menu now uses **system colours** so it adapts. Owner asked for this ("app-e 2 theme; sim-e shudhu light; mode change korar option nei; 2 mode-ei sob same") and chose **whole-app scope + toggle in More**. **Next session must verify dark mode looks right in the sim (I got interrupted before toggling it) and get owner sign-off on both modes.**

---

## 2. RULES / LESSONS (internalise — these cost real time last session)

1. **⚠️ FRESH-WORKTREE iOS BUILD needs 3 setup steps** (a new git worktree has none of them): `npm ci` (full — the native branch's Podfile needs `@aparajita/capacitor-biometric-auth`, `@capacitor/local-notifications`, `@capawesome/capacitor-app-shortcuts`, which the main worktree's node_modules lacks, so symlinking fails) → `export LANG=en_US.UTF-8 && cd ios/App && pod install` → `npx cap copy ios` (generates `ios/App/App/{public,config.xml,capacitor.config.json}`) → then `xcodebuild`. **This worktree is already set up.** Also: `xcodebuild … | tail -N` masks the real exit code (you get `tail`'s 0) — capture to a log + `grep 'BUILD SUCCEEDED|FAILED'`.
2. **⚠️ SERVICE-WORKER / bundle cache:** each web WebView (Assistant/Orders/Dashboard separately) loads the LAST-cached bundle on launch and shows a **"নতুন আপডেট পাওয়া গেছে — এখনই রিফ্রেশ করুন"** banner ~90s later (`app-update.ts` build-id poll). To verify a web change in the sim you MUST tap that refresh **per-tab** (the SW is network-first `cache:'no-store'` for navigations but the in-memory bundle persists until reload). The owner's real fresh install loads current prod, so this is a dev-loop artifact.
3. **⚠️ UNIVERSAL CONTROL blocks sim-driving:** the owner's Mac has a linked iPad; Universal Control steals focus from `computer-use` between screenshot and click (and `osascript`/System-Events Accessibility is intermittent). Workarounds: re-`open_application "Simulator"` immediately before each click and retry on the UC error; `osascript -e 'tell application "Simulator" to activate' -e 'tell application "System Events" to click at {x,y}'` (screen POINTS, ~1.75× the computer-use screenshot px) sometimes works atomically. **Ask the owner to disable Universal Control / unlink the iPad for sim-verify sessions** — he did mid-session and it helped, but it re-enables.
4. **`xcrun simctl io <udid> screenshot /tmp/x.png` + Read** is the flake-proof capture (works even when the GUI is busy). Crop with PIL for detail.
5. **The plain WKWebView `env(safe-area-inset-top)` is UNRELIABLE** under `contentInsetAdjustmentBehavior=.never` — inject the value natively (the `--alma-top-inset` pattern, like `--kb-inset`). Don't trust env() there.
6. **UIKit bar-button gotchas** (cost 3 rebuilds): a frame-set `UIVisualEffectView` inside a constraint-sized (0×0-at-init) container gets squished to a lens + drops the glyph to the bottom → use **full Auto Layout** (pin the blur to the container edges, centre the icon in `blur.contentView`). `UIButton.setImage` re-layers the image BEHIND an added blur subview → add the icon as an explicit `UIImageView` in `blur.contentView`. Bake the icon colour with `.withTintColor(color, renderingMode:.alwaysOriginal)` (tintColor washes out over frosted material).
7. **Deploy web to main via FF/rebase branch off origin/main:** `git fetch origin main; git branch -f tmp origin/main; git switch tmp; <edit or cherry-pick>; git rebase origin/main; git push origin HEAD:main`. Gated `alma-native-hdr` → zero effect on web/desktop. Poll `curl -s https://alma-erp-six.vercel.app/api/build-info` for `commitShort` to confirm live.
8. **Owner mandate:** work non-stop, decide as owner on non-safety choices, batch into ONE TestFlight build per batch (uploads have a rolling 24h limit — sim Debug builds are free), verify hard on the sim, Bangla summary at the end. **BUT for the frosted bar specifically: confirm design with the owner FIRST (§0).** Safety/physical steps (Mac password, real-device tests, login) stay his.

---

## 3. ARCHITECTURE (native = `ios/App/App/SpikeNativeShell.swift`)

- **`AlmaTheme`** (NEW, top of file): single source of truth for light/dark. Reads/writes the web `alma-theme` cookie (+ UserDefaults `alma-theme-mode` for a synchronous no-flash launch read), `.almaThemeChanged` broadcast, palette (`rootBg`/`navTitle`/`tabBarBg`/`coral`/`violet`), `applyNav(_:)` (Claude frosted nav appearance for the current mode), `tabBarAppearance()`, `applyJS()` (forces web `data-theme`+cookie live), `set(dark:)`/`toggle()`/`loadInitial()`/`loadFromCookies()`.
- **`AlmaTabBarController`** (root, 5 tabs): reads the theme at launch, observes `.almaThemeChanged`, `applyTheme()` restyles tab bar + every nav bar + flips the Capacitor Dashboard's WebView (via `firstWebView(in:)` — avoids importing Capacitor). Tab 0 Dashboard = the storyboard's Capacitor `AlmaBridgeViewController` (MUST stay Capacitor — push/reminders/N1–N5). Has the P3 `ALMA_OPEN_COMPANION` self-test hook.
- **`AlmaWebTabViewController`** (Orders/Approvals/More-pushed + Assistant): shared `WKProcessPool`+`WKWebsiteDataStore` (shared login). Agent tab = `agentSegments` non-empty → pinned to `root.topAnchor` (glass under-scroll), injects `--alma-top-inset` (`setAgentTopInset` on didFinish + `viewSafeAreaInsetsDidChange`), native "ALMA AI" title + `applyAgentBar()` (hamburger `glassBarButton(light:!isDark)` + `coralBarButton`). Observes `.almaThemeChanged` → root bg + `applyJS()` + rebuild bar. `updateBackButton()` (ERP back chevron, theme-aware). `AlmaPremiumLoader` first-paint loader. Keyboard: native injects `--kb-inset` (do NOT resize the WebView — Rule).
- **`glassBarButton(icon:target:action:light:)`** = frosted circular button (light-frosted white / dark-frosted). **`coralBarButton`** = solid coral compose. **`AgentAssistiveNav`** = the radial AssistiveTouch FAB. **`AlmaPremiumLoader`** = orb+dots loader. **`AlmaCompanionViewController`** = P3 phone companion (other session).
- **`MoreMenuViewController`**: system-coloured (theme-adaptive) grouped list — section 0 = **Appearance / Dark Mode switch**, section 1 = business switcher, 2+ = module groups.
- **Web (embed mode, on `main`, gated):** `src/lib/native-shell.ts`, `src/components/layout/NativeShellBridge.tsx`, embed CSS in `src/app/globals.css` (`html.alma-native…`, `.agent-thread-content`/`.agent-main-col`/`.page-header` insets), `src/agent/components/AgentApp.tsx`/`AgentThread.tsx` (`agent-main-col`/`agent-thread-content` classes), order drawer in `src/app/orders/page.tsx`. Theme system: `src/lib/theme.ts` (cookie `alma-theme`), `src/components/providers/ThemeProvider.tsx` (`data-theme` on `<html>`), toggle in `src/components/layout/Sidebar.tsx` (NOT in the agent — that's why the native More-tab toggle was added).

---

## 4. RECIPES

- **Sim self-test:** device **iPhone 17 Pro Max** udid `94E0186B-5CDA-4708-9368-53B4FF7274E7`, bundle `com.almatraders.erp`, app passcode `Maruf@123` (memory `reference_ios_sim_access`, NOT git). Build: `export LANG=en_US.UTF-8; xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' -derivedDataPath /tmp/alma-sim-dd build > /tmp/b.log 2>&1` → `simctl install/launch` → drive with computer-use/osascript → `simctl io <udid> screenshot /tmp/x.png`. The passcode field is NATIVE (computer-use `type` reaches it). The Assistant tab is testable logged-in.
- **TestFlight (cloud-signing):** bump `CURRENT_PROJECT_VERSION` in **4** places in `project.pbxproj`; `xcodebuild … -configuration Release -destination 'generic/platform=iOS' -archivePath /tmp/a.xcarchive -allowProvisioningUpdates -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_T875C2865Y.p8 -authenticationKeyID T875C2865Y -authenticationKeyIssuerID 4ea79058-88d0-4dbc-9010-78cf543b1790 archive`; then `-exportArchive` with `/tmp/alma-export-opts.plist` (`method=app-store-connect, destination=upload, signingStyle=automatic, manageAppVersionAndBuildNumber=true, teamID=5D9FLR3MMA`). Confirm VALID via a small ES256-JWT script hitting `api.appstoreconnect.apple.com/v1/builds?filter[app]=6786929629` (app id). **Rolling 24h upload limit — one upload per batch.** Full: memory `project_apple_developer_enroll`.

---

## 5. IMMEDIATE NEXT STEPS (in order)
1. **Frosted top bar (§0):** show owner current sim vs the Claude reference, get his exact design confirmation, THEN rebuild once. Both light + dark.
2. **Verify the theme WIP (`5b2034f8`) in the sim in DARK mode** (More → Dark Mode switch) — check the whole app + agent bar look right dark; get owner sign-off on both modes. Fix the loader style not updating on live toggle if it looks wrong (it's created once in `loadView`).
3. Once the bar + theme are owner-approved, bump the build (currently 31 from P3 → **32**), archive + upload ONE TestFlight build.
4. Coordinate with the parallel P3 session (always fetch+rebase; the branch moves under you).

## 6. GOTCHAS
- Mac reboot clears git identity → `git config user.name "Maruf Billah"` / `user.email "marufbillah@Marufs-Mac-mini.local"` before committing.
- `CURRENT_PROJECT_VERSION` in **4** places in `project.pbxproj`.
- Sim WebViews share the owner's live-prod session — avoid destructive taps (an accidental tap once opened a real order's Cancel dialog).
- Memory of record: **`full-native-ios-frame-program-option-1`** (blow-by-blow, updated with build 29/30/theme + gotchas), `reference_ios_sim_access`, `project_apple_developer_enroll`, `feedback_*`.
