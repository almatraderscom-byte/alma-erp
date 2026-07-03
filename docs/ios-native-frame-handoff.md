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
- TestFlight builds so far: **14 (S0 spike) → 19 (latest)**, all VALID. Build/sign/upload recipe (ASC key `T875C2865Y`, cloud signing) is in `docs/agent-ios-native-handoff.md` §5 and memory `project_apple_developer_enroll`.

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
- **build 19 (latest):** native header retinted to translucent **violet** (was reading black); agent's cream "N tasks awaiting decision" banner (`.agent-attention-banner`) hidden in native.

## 4. OPEN items — verify in sim/Chrome, batch, ONE build

1. **Agent bottom sub-nav "flickers"** (Assistant tab, sometimes visible/not) — likely native `keyboardLayoutGuide` resize fighting the agent's own `AgentKeyboardManager` (`src/agent/components/`). Reproduce in the sim; decide whether the Assistant tab should skip the native keyboard resize.
2. **Native header still not "aurora blur"** — build 19 is a violet translucent tint (safe). True aurora-showing-through needs the WebView to extend *under* the nav bar (top→`view.topAnchor` + content inset) — validate carefully in the simulator before shipping (it's a layout change).
3. **`.page-header` hides its filters/actions** on native-header pages (e.g. Finance Expenses/Office-Fund/Payroll pills). If the owner wants them, resurface natively or keep a slim sub-bar.
4. **Agent sub-nav (Chat/Studio/WhatsApp/Monitor/Costs) → native mapping** (kept visible for now to preserve access; a second bottom bar on Assistant).

## 5. Remaining roadmap (owner has the visual roadmap artifact)

- **S3:** layout/render fidelity — safe-area, skeleton/cached first-paint (kill pop-in), per-screen status bar, white-flash removal.
- **S4:** micro-interactions — haptics on taps/toggles, native pull-to-refresh, long-press menus, native offline screen.
- **S5:** Assistant tab = the "Claude" surface (keyboard-riding composer, smooth streaming, voice orb).
- **S6:** rebuild the 2–3 screens the owner lives in (Dashboard, Orders) fully in SwiftUI on the same APIs — the "pure native" last 20%.

## 6. Gotchas

- A Mac reboot clears git identity → `git config user.name "Maruf Billah"` / `user.email "marufbillah@Marufs-Mac-mini.local"` before committing.
- `gh` CLI isn't authed non-interactively; to land a gated web change on `main`, fast-forward push a branch: `git push origin <branch>:main` (main is usually a clean FF from a branch cut off origin/main).
- Simulator webviews are logged OUT (separate from the owner's Chrome). For logged-in *content* use Chrome `?native=1`; use the sim for native chrome. Passcode `Maruf@123` (in memory) unlocks the app's Face-ID gate in the sim.
- `CURRENT_PROJECT_VERSION` lives in 4 places in `ios/App/App.xcodeproj/project.pbxproj` — bump all 4 per build. Next build = **20**.
- Never merge to main / deploy production without cause; the embed-mode web changes are gated + owner-approved, which is why they were merged.
