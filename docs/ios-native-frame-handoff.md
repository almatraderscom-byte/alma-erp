# iOS Native-Frame Program — Handoff (START HERE)

**Owner:** Maruf (non-engineer). **Reply in Bangla, concise, plain language.**
**Goal:** make the ALMA ERP iOS app *feel like the Claude iOS app* — a fully native iOS feel.
**Approach (owner-approved, locked):** "Option 1 / native frame" — native chrome (tab bar, headers, nav, gestures, haptics, floating buttons in Swift) wrapping the existing web ERP as content ("embed mode"). We do NOT rebuild every screen. Owner loves this direction.

> **How the owner resumes:** he pastes *"docs/ios-native-frame-handoff.md poড়e ekhan theke continue koro"*. This file must let you continue with zero re-discovery and finish every remaining phase.

---

## 1. CURRENT STATE — 2026-07-05 (read first)

- **Native branch (all iOS shell work): `claude/ios-s0-native-shell-spike`.** Native file = `ios/App/App/SpikeNativeShell.swift` (worktree `.claude/worktrees/sweet-torvalds-5ea6c4/`).
- **Web is on `main`, LIVE on prod** (`alma-erp-six.vercel.app`). The native app loads live prod in WebViews, so **a web merge to main changes the app instantly** (no build needed) — BUT only after the WebView's **service worker updates** (see Rule #1).
- **TestFlight builds shipped this program: 14 → 28.** Latest = **build 28** (uploaded 2026-07-05). Last few:
  - **24** business switcher · Dashboard native header · tab-swap fix · S3 first-paint fade · white-flash removal · offline screen · scroll-to-top
  - **25** soft-haptic native bridge
  - **26** AssistiveTouch floating agent nav · long-press context menu
  - **27** keyboard-riding composer (agent)
  - **28** agent **dark-glass header** + **frosted circular bar/back buttons** + **AssistiveTouch momentum physics** + staggered menu
- **Roadmap: S0–S4 = 100%. S5 (Claude surface) ≈ 95%. S6 (SwiftUI screens) = 0% (deferred — see §4).** So we are at the tail of S5.

### ⏭️ IMMEDIATE NEXT TASKS (owner's live feedback, 2026-07-05, in priority order)
The owner is comparing against the **Claude app top bar** (dark translucent header, content scrolling UNDER it blurred, frosted circular buttons). Do these next:

1. **[BIGGEST] Real glass motion — content scrolls UNDER the header, blurred.** The dark-glass header + frosted buttons (build 28) match the *style*, but content does NOT pass under the bar yet. Cause: the agent's `.safe-top` (`padding-top: env(safe-area-inset-top)` in globals.css) pushes the WHOLE column below the bar, so the scroll area never goes under it. Fix = make the agent chat SCROLL AREA extend full-height under the nav bar with the safe-area inset as **scroll content padding** (not container padding), gated on native. The Swift side already paints the agent root dark; you can pin the agent webView to `root.topAnchor` (there is a commented approach) once the web reserves the inset. **Verify against the Claude reference the owner sent.**
2. **Dashboard 'top layer overlaps text'** — the Capacitor Dashboard webview runs full-screen UNDER the native nav bar, so its top content collides with the bar. Fix the Dashboard's top inset. Then **audit every page** (More modules, Orders, etc.) for the same overlap.
3. **Page-transition white flash → theme colour + a "next-level wow" loading animation.** Current native first-paint placeholder is light `#F2F0F8` + a plain `UIActivityIndicator` — owner finds the transition "white" and the spinner "too normal, everyone uses it; I want a different wow level." Design a premium custom native loader (e.g. a breathing violet gradient orb / staggered morphing dots) + a themed transition backdrop.
4. **Full RADIAL AssistiveTouch menu.** Build 28 has momentum + overshoot + STAGGERED list menu + haptics. Owner's spec wants a true **radial/arc** menu (icons fanned around the FAB), not a vertical list. Rewrite `AgentAssistiveNav.buildPanel/open` to an arc layout with staggered spring. (His full spec is in memory `full-native-ios-frame-program-option-1` and the session transcript.)
5. **Glassy back button on the order-detail drawer + every sub-page.** Native pushes already get a frosted `chevron.backward` (build 28). But tapping an order opens a **web drawer** (not a native push) → no native back. Add a glassy back/close in the web drawer (web-side) and make sure every sub-page (web or native) has a consistent Claude-style back.

---

## 2. RULES / LESSONS learned this session — internalise these

1. **⚠️ SERVICE-WORKER CACHE is the #1 trap.** The WebViews (and the owner's Chrome) run a service worker that serves the OLD JS/CSS until it updates. So a web deploy to main does NOT take effect immediately. To VERIFY web logic reliably in Chrome: run `navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.unregister()))` + clear `caches` + reload — THEN test. `?native=1` alone loads the SW-cached bundle. In the sim, a web fix needs the SW to update (relaunch, or the in-app "নতুন আপডেট" banner). Half the "my fix isn't working" moments this session were stale SW, not bad code.
2. **Gate every web-triggered NATIVE behaviour on a native-injected flag** so a web deploy can't break OLDER builds. Pattern: native injects `window.__almaX = true` at documentStart; web reads it and only then changes behaviour. Live flags: `__almaNative`, `__almaNativeHeader` (→ `html.alma-native` / `html.alma-native-hdr`), `__almaAgentNative` (hide web agent sub-nav), `__almaKbNative` (native owns `--kb-inset`). Older builds don't inject the new flag → unchanged.
3. **KEYBOARD: never resize the WebView on focus.** Pinning the webView to `keyboardLayoutGuide` made iOS resign first-responder → keyboard dismissed on the first keystroke. Keep the webView a STABLE full height; the keyboard overlaps. For the agent composer to ride the keyboard, the plain WKWebView's `visualViewport` does NOT shrink, so the SHELL injects the exact keyboard height into `--kb-inset` + `body.kb-open` from `keyboardWillShow/Change/Hide` (`setAgentKbInset`), and the web skips its own path when `__almaKbNative` is set. Also: a typing HAPTIC that clicks a hidden `<input switch>` (`iosSwitchTick`) stole focus and dismissed the keyboard — it now no-ops when an editable element is focused.
4. **Light content + a dark-glass header:** the agent page is LIGHT, but a translucent DARK blur over light content reads WHITE. Fix = paint the area BEHIND the bar dark (the agent VC's root = `#0e0c14`) so the blur reads dark. (Claude looks dark because Claude's *content* is dark; ours isn't — so we darken behind the bar instead.)
5. **`computer-use type` does NOT reach a sim WKWebView `<textarea>`** — it's a tooling limit, not an app bug. Native fields (the passcode lock) DO receive it. So typing INTO web inputs can't be verified in the sim; verify layout/keyboard-riding visually and trust device for real typing.
6. **Verify native-header-mode CSS in Chrome by injecting the class:** `?native=1` only sets `alma-native`, NOT `alma-native-hdr`. Add it manually (`document.documentElement.classList.add('alma-native','alma-native-hdr')`) to preview what native-header pages look like without a build.
7. **Deploy a web change to main via a fast-forward branch off origin/main:** `git fetch origin`, `git branch -f tmp origin/main && git switch tmp`, `git cherry-pick <commit>`, `git push origin tmp:main`, switch back. (`gh` isn't authed non-interactively.) It's gated → zero effect on web/desktop users.
8. **Environment friction (owner is often on the Mac):** the Mac auto-locks (screensaver + password — you CANNOT type the Mac password, it's the owner's), and **Universal Control / Screenshot grab focus** mid-drive. Re-`open_application "Simulator"` before each computer-use batch. **Ask the owner to disable auto-lock + Universal Control during work sessions.** `xcrun simctl io <udid> screenshot /tmp/x.png` + Read gives a full-res, flake-proof capture even when the GUI is busy.
9. **`/tmp` gets cleared mid-session** — re-derive the udid (`xcrun simctl list devices | grep "iPhone 17 Pro Max"`), bundle (`com.almatraders.erp`), and the export-options plist when a simctl/upload step says "no such file / Invalid device".
10. **Batch fixes; verify on the sim BEFORE uploading; only hardware-feel goes to the owner.** But motion/haptics/keyboard-feel are device-only — verify what you can in the sim, ship, and let the owner feel the rest. Don't ship an un-sim-verified *visual/layout* change.
11. **Owner mandate:** decide as owner (pick the best option, don't block on him for non-safety choices), work non-stop, batch into as few uploads as possible, verify hard on the sim, and give a Bangla summary at the end noting where you decided as owner. Safety/physical steps (Mac password, real-device tests, login) stay his.

---

## 3. ARCHITECTURE

### Native (`ios/App/App/SpikeNativeShell.swift`)
- Root = **`AlmaTabBarController`** (5 tabs: Dashboard · Orders · Assistant · Approvals · More), dark tab-bar appearance, selection haptic on switch, **scroll-to-top on active-tab re-tap** (`shouldSelect`).
- **Tab 0 Dashboard** = the storyboard's Capacitor **`AlmaBridgeViewController`**, reparented into the tab bar by `AppDelegate`. **MUST stay Capacitor** — push / Live Pulse / local reminders / on-device AI (N1–N5) run ONLY where `isCapacitorNative()` is true. Wrapped in `darkNav` for its native "Dashboard" header; `AlmaEmbed.install(hideWebHeader:true)`.
- **Orders / Approvals** = `AlmaWebTabViewController` in a `darkNav` (native header, title synced via the `almaShell` bridge, frosted glass back button when `canGoBack`). `hideWebHeader:true`.
- **Assistant** = `AlmaWebTabViewController` with `agentSegments` + `hideWebHeader:true`, wrapped in `darkNav`. Native "ALMA AI" title (fixed — route title-sync skipped for the agent) + frosted **history**/**new-chat** bar buttons (`glassBarButton`) that `evaluateJavaScript`-click the web controls by aria-label (সাইডবার / নতুন চ্যাট). The agent's VC root is painted DARK so the glass header reads dark. Agent sections are reached via **`AgentAssistiveNav`** (the floating AssistiveTouch button), not a bar.
- **More** = native `MoreMenuViewController` (grouped list): a **"Switch business"** section (Alma Lifestyle `/` · Alma Trading `/trading` · Creative Digital IT `/digital` — route-navigation, zero web-logic risk) + Workspace / Money / Operations / People / Insights / Settings groups; each row pushes a web screen with a native slide + frosted back.
- **`AlmaWebTabViewController`** (the workhorse) holds: the WKWebView (shared `WKProcessPool` + default `WKWebsiteDataStore` = shared login), S3 light placeholder + fade-in, **offline screen** (`showContextMenu`? no — `handleLoadFailure`/`showOffline`, native retry), **keyboard inset** (`setAgentKbInset` for the agent, `contentInset` for others), the `almaShell` (route/title), **`almaHaptic`** (soft native haptics — bridge for the plain webviews), and **`almaContextMenu`** (native long-press action sheet) message handlers.
- **`AgentAssistiveNav`** = the iOS-AssistiveTouch-style floating button: drag + **momentum/overshoot** edge-snap, idle-fade to 42%, tap → blurred menu (currently a vertical LIST — owner wants a RADIAL arc), staggered row springs, haptics on grab/snap/open/select, touch pass-through when closed.
- **`glassBarButton(icon:target:action:)`** = the Claude-style frosted DARK circular bar button.
- **Keyboard bridges / flags:** see Rules #2, #3.

### Web (embed mode, all on `main`, gated → zero effect on web/desktop)
- `src/lib/native-shell.ts` (`isNativeShell()`, `isNativeHeaderMode()`), `src/components/layout/NativeShellBridge.tsx` (adds `alma-native`/`alma-native-hdr`/`alma-agent-native` classes, posts route events, installs the long-press bridge), embed CSS in `src/app/globals.css` (all `html.alma-native…` rules), `src/lib/haptics.ts` (haptic bridge + focus-safe iosSwitchTick), `src/lib/native-context-menu.ts` (long-press → native), `src/agent/hooks/useKeyboardInset.ts` (skips its path when `__almaKbNative`), `src/agent/components/AgentApp.tsx` (`.alma-agent-topbar` class + agent header buttons), `src/components/ui/index.tsx` (`PageHeader` keeps its actions in native-hdr mode; title row `[data-ph-titlerow]` hidden), `src/components/mobile/RobotRefreshMascot.tsx` + `MobilePullToRefresh.tsx` (robot PTR).

---

## 4. ROADMAP (updated 2026-07-05)

| Phase | What | Status |
|---|---|---|
| S0 | Native tab-bar spike | ✅ 100% |
| S1 | Real shell + Capacitor bridge (login, push, N1–N5 intact) | ✅ 100% |
| S2 | Native header + nav + title-sync + back | ✅ 100% |
| S3 | Layout/render fidelity (first-paint fade, white-flash removal, light placeholder) | ✅ 100% |
| S4 | Micro-interactions (soft haptics + bridge, robot PTR, offline screen, scroll-to-top, long-press context menu) | ✅ 100% |
| **S5** | **Assistant = the "Claude" surface** | 🟡 **~95%** |
| S6 | Dashboard/Orders fully in SwiftUI ("pure native" last ~10%) | 🔴 0% (deferred) |

**S5 done:** AssistiveTouch floating agent nav, keyboard-riding composer, native dark-glass header + frosted buttons, agent sub-nav removed, streaming + voice orb already existed.
**S5 remaining (= the immediate next tasks §1):** content-scrolls-under glass motion, full RADIAL menu, and the cross-cutting glass/back-button/transition polish the owner flagged.

**S6 is DEFERRED / needs its own program — do NOT rush it:** the Dashboard tab MUST stay Capacitor (push/reminders/N1–N5), so it can't just become SwiftUI. A full SwiftUI Orders needs a native auth-cookie bridge (WKWebsiteDataStore → URLSession), every data endpoint, and every action (create/cancel/status) rebuilt — a large standalone build. Only start it as a dedicated phase, and never at the cost of the live Capacitor features.

---

## 5. RECIPES

**Sim self-test:** device = **iPhone 17 Pro Max** (udid via `xcrun simctl list devices | grep "iPhone 17 Pro Max"`), bundle `com.almatraders.erp`, app passcode `Maruf@123` (in memory `reference_ios_sim_access`, NOT git). Build for sim: `xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' -derivedDataPath /tmp/alma-sim-dd build` → `xcrun simctl install/launch` → drive with computer-use (re-`open_application "Simulator"` when Universal Control/Screenshot steals focus) → `xcrun simctl io <udid> screenshot /tmp/x.png` for full-res. Software keyboard: ⌘K.

**TestFlight upload (cloud-signing, ASC key `T875C2865Y`, issuer `4ea79058-88d0-4dbc-9010-78cf543b1790`, key in `~/.appstoreconnect/private_keys/`):** bump `CURRENT_PROJECT_VERSION` in all **4** places in `project.pbxproj`; `xcodebuild ... -configuration Release -destination 'generic/platform=iOS' -archivePath /tmp/a.xcarchive -allowProvisioningUpdates -authenticationKeyPath … archive`; then `-exportArchive` with `/tmp/alma-export-opts.plist` (`method=app-store-connect, destination=upload, signingStyle=automatic, manageAppVersionAndBuildNumber=true, teamID=5D9FLR3MMA`). Confirm VALID via the `asc-builds.mjs` ES256-JWT poll (App id `6786929629`). **Upload limit is a rolling 24h window.** Full recipe + secrets: memory `project_apple_developer_enroll`.

**Web deploy:** FF branch off origin/main → push to main (Rule #7). Verify via Chrome after unregistering the SW (Rule #1).

---

## 6. GOTCHAS
- Mac reboot clears git identity → `git config user.name/email` before committing.
- `CURRENT_PROJECT_VERSION` lives in **4** places in `project.pbxproj` — bump all four.
- Sim WebViews share the owner's live-prod session (be careful: an accidental tap opened a real order's "Cancel?" dialog — backed out via "Keep order"). Avoid destructive taps.
- Never merge to main / deploy without cause; the embed-mode web changes are gated + owner-approved, which is why they merge.
- Memory of record: **`full-native-ios-frame-program-option-1`** (the blow-by-blow), `reference_ios_sim_access`, `project_apple_developer_enroll`, `feedback_*`.
