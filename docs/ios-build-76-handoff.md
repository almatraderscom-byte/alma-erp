# iOS Build 76 — Handoff (2026-07-17)

**Branch: `ios-build-76`** — সব কাজ এখানে pushed। Build 75 TestFlight-এ আছে; এই ব্রাঞ্চ = 75-এর পরের সব ফিক্স। **Owner rule: এই ব্রাঞ্চে তোমার কাজ যোগ করো → সিমে নিজে verify করো → owner-এর confirm নিয়ে তবেই build 76** (bump + pipeline, নিচে recipe)।

## এই ব্রাঞ্চে কী আছে (75-এর পর, সব sim-verified)

1. **PulseNativeSync.swift (নতুন, আসল ফিক্স):** Dynamic Panel-এর ডেটা এখন **নেটিভ পথে** আসে (AlmaAPI, shared-store cookies)। কারণ: owner-এর ফোনে hidden webview-র session কুকি মরে যাওয়ায় সব sync 401 (Vercel log-প্রমাণ) → island ঘণ্টার পর ঘণ্টা stale (ধূসর ঘড়ি, ভুল সংখ্যা, নাগ/রং কিছুই না)। এখন didBecomeActive-এ native fetch → cache → nag → applyCore। Webview sync-ও আছে (দুই writer, idempotent)।
2. **LiveActivityBridge:** `applyCore()` extracted (call-free) — native + webview এক pipeline। approval-nag আগের মতোই (>০ অনুমোদনে ১৫ মিনিট পরপর alert-update, cooldown শূন্যে reset)।
3. Approvals: anchor+sheet **এক উৎস** (`mergedAttention`), reject → chat-এ grounded মেসেজ, stop-after-card server guard।
4. লোডার: breathing intake, eased transitions, এক-starburst হ্যান্ডঅফ, Claude-Code status + "আবার চেষ্টা N/৫" stall-ladder (৫ বারে সত্যি-কথা-বলে থামে)।
5. Server (main-এ LIVE): pulse counts = owner-এর সত্য — অর্ডার ৩০-দিন সীমা, অনুমোদন = **ERP request টেবিলগুলো** (ApprovalRequest+Wallet+Advance+Waiver+Meal) + agent কার্ড। Curl-প্রমাণ: `mode:approval | approvals:3 | orders:1`।

## Sim-verify recipe (Pro Max udid `94E0186B-5CDA-4708-9368-53B4FF7274E7`)

```bash
cd ios/App && xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath /tmp/alma-sim-dd build
xcrun simctl install $UDID /tmp/alma-sim-dd/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch $UDID com.almatraders.erp ALMA_PULSE_RESET=1   # DEBUG-only: পুরনো activity মেরে fresh render
# breadcrumbs (container plist): alma.pulse.lastResult / lastRestore / আর cache-এ approvalCount দেখো
# island দেখতে: অ্যাপ background করো (অন্য অ্যাপ front) → screenshot
```
**Gotchas:** সিমের island snapshot **update-এ repaint হয় না** — fresh activity লাগে (তাই ALMA_PULSE_RESET)। শব্দ/হ্যাপটিক সিমে নেই। নতুন Swift ফাইল = pbxproj-এ ৪ জায়গায় register (PulseNativeSync-এর কমিট দেখো)।

## Build 76 recipe (owner confirm-এর PRে)

1. এই ব্রাঞ্চ → PR → main-এ merge (green চেক দেখে)
2. `sed -i '' 's/CURRENT_PROJECT_VERSION = 75;/CURRENT_PROJECT_VERSION = 76;/g' ios/App/App.xcodeproj/project.pbxproj` → commit `chore(ios): bump build to 76` → push
3. `gh workflow run ios-testflight.yml --ref main` → run watch (নীরব অপেক্ষা নিষেধ — owner-কে জানাও)

## জানা বাকি জিনিস

- লক-কার্ড subtitle-এ "অপেক্ষায়" দুবার (approval callout) — cosmetic, `pulse-state.ts`-এর subtitle builder
- Upstash Redis মাসিক 500k cap শেষ (14 জুলাই থেকে) — live tail degraded, owner-এর billing সিদ্ধান্ত বাকি
- OpenRouter balance -$0.16 → cheap-head 402 → Gemini rescue আছে, তবু top-up দরকার (owner)
- Owner-এর ফোনের hidden-webview session মরা — native sync এলে প্যানেল বাঁচবে; চাইলে logout/login-এ webview-ও সারে
