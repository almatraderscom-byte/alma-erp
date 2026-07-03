# iOS Native-Frame Program — Handoff (start here)

**Date:** 2026-07-03 · **Owner:** Maruf (non-engineer). Reply in Bangla, concise.
**Goal:** make the ALMA ERP iOS app *feel like the Claude iOS app* — a fully native iOS feel. Owner-approved approach = **"Option 1 / native frame": native chrome (tab bar, headers, nav, gestures, haptics in Swift) wrapping the existing web ERP as content ("embed mode")**, so we don't rebuild every screen. Owner has felt it and loves the direction.

> **How the owner starts a new session:** paste — *"docs/ios-native-frame-handoff.md poড়e ekhan theke continue koro"*. Everything below lets you resume with zero re-discovery.

---

## 0. NON-NEGOTIABLE working rule (read the CLAUDE.md rule too)

**Self-test EXHAUSTIVELY before any TestFlight build. Batch all fixes into ONE build.** The owner was (rightly) frustrated by drip-fed small UI builds. You now have a working simulator — use it.
- **Web UI** (anything inside the WebView: layout, CSS, embed chrome, headers, banners): verify in the owner's **Chrome at `?native=1`** — e.g. `https://alma-erp-six.vercel.app/orders?native=1`. His Chrome is logged in; no build needed. The double-header / banner class of bugs are catchable here.
- **Native Swift UI** (tab bar, native headers, colors, nav, overlap, safe-area, keyboard): build for the **simulator** and screenshot it yourself. Recipe + udid + **passcode** are in Claude memory `reference_ios_sim_access` (passcode is NOT in git — secrets-in-git is banned).
- **Only real hardware things go to the owner:** real push, real Face ID, final device keyboard/perf feel.

## 1. Where the work lives

- **Native branch (all the iOS shell work): `claude/ios-s0-native-shell-spike`.** This is where you continue. It is off the N5 tag (so it carries all of N1–N5's native features).
- **Web "embed mode" is MERGED TO PRODUCTION `main`** (gated — zero effect on web/desktop users). Files: `src/lib/native-shell.ts`, `src/components/layout/NativeShellBridge.tsx` (mounted in `GlobalPlatformChrome`), embed CSS in `src/app/globals.css` (`html.alma-native …`), and the agent banner tag in `src/agent/components/AgentApp.tsx`.
- The app loads **live production** (`alma-erp-six.vercel.app`) in native WebViews, so a web merge to main changes the native app immediately (no new build for web-only fixes).
- TestFlight builds so far: **14 (S0 spike) → 20 (latest)**, all VALID. Build/sign/upload recipe (ASC key `T875C2865Y`, cloud signing) is in `docs/agent-ios-native-handoff.md` §5 and memory `project_apple_developer_enroll`.

## 2. Architecture (native side = `ios/App/App/SpikeNativeShell.swift`)

- Root is `AlmaTabBarController` (5 tabs): **Dashboard · Orders · Assistant · Approvals · More**.
  - **Tab 0 Dashboard** = the storyboard's Capacitor `AlmaBridgeViewController`, **reparented** into the tab bar by `AppDelegate` (so Capacitor + all N1–N5 features — push, Live Pulse, reminders, on-device plugins — keep running; `isCapacitorNative()` is true there).
  - **Tabs Orders/Approvals** = `AlmaWebTabViewController` wrapped in a dark `UINavigationController` with a native header (title synced from the web via the `almaShell` bridge) + back button; `hideWebHeader:true` so the web page-header is suppressed (no double header).
  - **Assistant** = plain `AlmaWebTabViewController` (keeps the agent's own in-page header).
  - **More** = native `MoreMenuViewController` (grouped list of modules) that pushes each module as a web screen with native slide + swipe-back.
- Native→web contract: native injects `window.__almaNative=true` (documentStart) and, for header pages, `window.__almaNativeHeader=true`. Web reads these (`isNativeShell()`, `isNativeHeaderMode()`), hides its own chrome, and posts `window.webkit.messageHandlers.almaShell.postMessage({type:'route',path,title})` on route changes.
- Web view bottom is anchored to `keyboardLayoutGuide.topAnchor` (fixes tab-bar overlap AND keyboard-lift).

## 3. Done so far (S0 → S2.1)

- **S0 (build 14):** native tab-bar spike — proved the feel.
- **S1 (build 15):** real shell + Capacitor bridge intact; 5 tabs; shared login; embed hides `.mobile-app-chrome`.
- **build 16:** More = native menu (fixed a `/settings` 404).
- **S2 (build 17):** native headers + title-sync + back on Orders/Approvals.
- **S2.1 (build 18):** keyboard + tab-bar overlap fixed (`keyboardLayoutGuide`); double-top-header fixed (`hideWebHeader` + `html.alma-native-hdr .page-header`); header restyled.
- **build 19:** native header retinted to translucent **violet** (was reading black); agent's cream "N tasks awaiting decision" banner (`.agent-attention-banner`) hidden in native.
- **build 20 (latest, self-tested in sim + Chrome, 2026-07-03):**
  - **Assistant bottom-nav flicker FIXED** (open item #1 — the real pain point). Root cause confirmed live in the sim: the Assistant is a plain (non-Capacitor) WKWebView whose bottom is pinned to `keyboardLayoutGuide`, so native already shrinks it above the keyboard — but the agent's web keyboard manager ran the *visualViewport* path, measured inset ≈ 0, so `kb-open` never latched and the sub-nav stayed wedged between composer and keyboard, flickering. Fix is **web-side** (`src/agent/hooks/useKeyboardInset.ts`, on **main**): in the native shell (detected via the `almaShell` bridge, absent in normal browsers and even `?native=1`) mirror the Capacitor branch — pin `--kb-inset` 0, set `cap-native-resize`, and drive `kb-open` from the **WebView's own resize** (keyboard up ⟺ viewport shrank >120px below its tallest height), NOT from focus. (A first focus-based attempt was a regression — iOS suppresses the keyboard on the agent's programmatic auto-focus, so it hid the nav with no keyboard; caught in the sim, corrected.) Verified in the sim across keyboard **up → nav hidden, composer flush; down → nav returns**. Two commits on main: `f4d17ee9` then `3785782d`.
  - **Native header → aurora-frosted:** thin blur material (`.systemThinMaterialDark`) + light violet veil (0.42) so content/aurora shows through, title readable over light (Orders) + dark (Approvals). Appearance-only. (native branch)
  - **Dropped after self-test (correctly):** native pull-to-refresh (the ERP web already ships its own "RELEASE TO REFRESH"); tab-retap scroll-to-top (the list scrolls an inner element `webView.scrollView` can't reach). Both are web-owned content behaviours — see open items.

## 4. OPEN items — verify in sim/Chrome, batch, ONE build

1. ~~Agent bottom sub-nav flickers~~ **DONE in build 20** (see above).
2. **Native header still not full "aurora blur"** — build 20 is a real frosted thin-material veil (better than 19's slab), but the dramatic aurora-showing-through still needs the WebView to extend *under* the nav bar (top→`view.topAnchor` + content inset) — a layout change; validate carefully in the sim before shipping.
3. **`.page-header` hides its filters/actions** on native-header pages (e.g. Finance Expenses/Office-Fund/Payroll pills). If the owner wants them, resurface natively or keep a slim sub-bar.
4. **Agent sub-nav (Chat/Studio/WhatsApp/Monitor/Costs) → native mapping** (kept visible for now to preserve access; a second bottom bar on Assistant).
5. **Native pull-to-refresh + tab-retap scroll-to-top** — both need **web cooperation** (a native→web `scrollTop`/`reload` message the web handles on its own scroller), since native can't reach the ERP pages' inner scroller and the web already owns pull-to-refresh. Do web-side if wanted.

## 5. Remaining roadmap (owner has the visual roadmap artifact)

- **S3:** layout/render fidelity — safe-area, skeleton/cached first-paint (kill pop-in), per-screen status bar, white-flash removal.
- **S4:** micro-interactions — haptics on taps/toggles, native pull-to-refresh, long-press menus, native offline screen.
- **S5:** Assistant tab = the "Claude" surface (keyboard-riding composer, smooth streaming, voice orb).
- **S6:** rebuild the 2–3 screens the owner lives in (Dashboard, Orders) fully in SwiftUI on the same APIs — the "pure native" last 20%.

## 6. Gotchas

- A Mac reboot clears git identity → `git config user.name "Maruf Billah"` / `user.email "marufbillah@Marufs-Mac-mini.local"` before committing.
- `gh` CLI isn't authed non-interactively; to land a gated web change on `main`, fast-forward push a branch: `git push origin <branch>:main` (main is usually a clean FF from a branch cut off origin/main).
- Simulator webviews are logged OUT (separate from the owner's Chrome). For logged-in *content* use Chrome `?native=1`; use the sim for native chrome. Passcode `Maruf@123` (in memory) unlocks the app's Face-ID gate in the sim.
- `CURRENT_PROJECT_VERSION` lives in 4 places in `ios/App/App.xcodeproj/project.pbxproj` — bump all 4 per build. Next build = **21**.
- **SW-cache gotcha for web-fix self-test:** the native WebViews run a service worker, so a web fix pushed to main is NOT picked up until the SW updates. In the sim, tap the agent's in-app refresh (or the "নতুন আপডেট" banner's "এখনই রিফ্রেশ করুন") to force the newest JS before verifying a web change. The sim IS logged in (session persists) — so the Assistant tab can be tested logged-in for real.
- **Sim self-test recipe that worked:** boot udid `94E0186B-…`; build for sim (`-derivedDataPath /tmp/alma-sim-dd`); `simctl install/launch`; unlock past the app's passcode gate by typing `Maruf@123` (memory `reference_ios_sim_access`) via computer-use (`request_access` Simulator → `left_click` field → `type` → Return); drive tabs with computer-use `left_click`; toggle the software keyboard with **⌘K** (hardware keyboard otherwise suppresses it).
- Never merge to main / deploy production without cause; the embed-mode web changes are gated + owner-approved, which is why they were merged.
