# iOS Build 77 — Handoff (2026-07-17)

**Branch: `ios-build-77`** (main থেকে কাটা, `a3f38251`-এর 160pt-fix সহ)। Build 76 TestFlight-এ আছে — owner এখনো device-test করছেন। **Owner rule: তোমার নিজের কাজ এই ব্রাঞ্চে যোগ করো → নিচের 160pt-fix-টা আগে সিমে নিজে verify করো → তারপর তোমার কাজ + এই fix একসাথে conflict-ছাড়া verify করে owner-কে দেখাও → owner-এর confirm পেলে তবেই build 77** (bump + pipeline, recipe নিচে)।

## Build 76-এ যে ভুলটা ধরা পড়েছে (owner device-hit) + তার fix (main-এ merged, PR #430)

আগের এজেন্ট (এই সেশন) island/লক-কার্ড demo-parity বানানোর সময় **Apple-এর 160pt সীমা মাপেনি**:

- **আসল সীমা (authoritative):** লক-স্ক্রিন Live Activity কার্ড এবং expanded Dynamic Island — দুটোরই hard cap **160pt**। প্রমাণ: Apple-এর renderer metrics `height=Dynamic<64.00, 160.00>` (sim log-এ ২১৯ নমুনা)। Island-এর bottom region-এর কার্যকর বাজেট ≈ 160 − header(~44) − insets → **≤92pt টার্গেট**।
- **Build 76-এ ছিল:** লক-কার্ড 176/172pt (ওপরের হেডার কাটা), island bottom ~121pt (অনুমোদন/বাতিল বাটন অর্ধেক কাটা)।
- **Fix (`ios/App/AlmaWidget/PulseLiveActivity.swift` only):** লক-কার্ড = হেডার + ৩ টাইল + **একটাই** প্রাসঙ্গিক রো (callout থাকলে সেটা, নাহলে প্রথম feed row — কখনো স্তূপ না); A-tile 42→32, ফন্ট/প্যাডিং টাইট। Island = বাটন-পেজে ফুটার নেই, tasks-পেজ এক-কার্ড + এক-লাইন, slim কার্ড/বাটন।
- **After (মাপা):** lock 156/157, bottom 83/89/83 ✅ — `docs/proofs/island-160pt/MEASUREMENTS.txt` + PNGs।

## তোমার প্রথম কাজ: fix-টা সিমে verify (মাপক-প্রোব recipe)

সিম `9E51818A-AA25-4C9F-9C1F-9EE2D99E2998` (iPhone 17 Pro Max IOSP0; অন্য সেশনের `5F79315F-…`/`94E0186B-…` ছুঁয়ো না)। GUI-drive লাগে না — ImageRenderer প্রোব প্রতিটা লেআউটের **আসল উচ্চতা pt-তে প্রিন্ট করে**:

```bash
# 1) প্রোব-সোর্স: /tmp/islandprobe/{pmain.swift,fixture.json,P.app/Info.plist}
#    (না থাকলে docs/proofs/island-160pt/MEASUREMENTS.txt-এর বর্ণনা থেকে বানাও —
#     pmain.swift = PulseExpandedBody + PulseLockScreenView কে ImageRenderer-এ
#     রেন্ডার করে height প্রিন্ট, fixture = erp: id সহ approval ডেটা)
SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
xcrun swiftc -sdk "$SDK" -target arm64-apple-ios17.0-simulator \
  /tmp/islandprobe/pmain.swift ios/App/App/PulseActivityAttributes.swift \
  ios/App/AlmaWidget/PulseLiveActivity.swift ios/App/App/AlmaPulseIntents.swift \
  -o /tmp/islandprobe/P.app/P
xcrun simctl install $UDID /tmp/islandprobe/P.app
xcrun simctl launch --console-pty $UDID com.almatraders.islandprobe | grep MEASURE
# PASS মানদণ্ড: lock ≤160, bottom ≤92 — এর বাইরে গেলে FAIL, ছাঁটো
```

তারপর আসল অ্যাপ build → install → `ALMA_PULSE_RESET=1` launch → অ্যাপ background → island compact screenshot; expanded-এর ভিজ্যুয়াল = প্রোবের PNG (long-press headless হয় না)।

## Build 77-এ আরো যা ঢুকবে বলে ঠিক আছে (এই ব্রাঞ্চে already আছে)

Main-current সব — build 76-এর পরে merge হওয়া PR #427-433 (creative-studio garment-prep ইত্যাদি) + 160pt fix + **PR #446-এর bKash send-flow (নিচের section)**। তোমার নিজের কাজ এর ওপরে।

## bKash send-flow (PR #446, main-এ merged 2026-07-17 — এই ব্রাঞ্চে merge করা আছে, conflict ছিল না)

Owner-এর payout workflow: Approvals (বা Payroll) → Approve → **এক tap-এ প্রাপকের বিকাশ নম্বর copy + bkash:// দিয়ে bKash app খোলা** → টাকা পাঠিয়ে ফিরলে sheet **নিজে আবার খোলে** "TrxID পেস্ট করুন" mode-এ (app kill হলেও UserDefaults `alma.bkashSendPending.v1` থেকে ফেরে, TTL 12h, surface-scoped `payroll`/`approvals`) → পেস্ট বাটন clipboard থেকে **শুধু TrxID-আকৃতির token** নেয় (10 alnum + অন্তত ১টা digit — ফোন নম্বর/amount reject)।

- **ফাইল:** `ios/App/App/ApprovalsSwiftUI.swift` (WithdrawTxnSheet + restore), `ios/App/App/PayrollSwiftUI.swift` (PayrollReviewSheet + restore + `BkashSendPendingStore` + `payrollExtractTrxId` — store/extractor দুই ফাইলেই শেয়ার্ড, PayrollSwiftUI-তে সংজ্ঞা)। Server-side কিছু বদলায়নি এই ব্রাঞ্চে যা আগে থেকে main-এ নেই।
- **Owner-gate:** server payoutSummary-র খোলা নম্বর শুধু SUPER_ADMIN-কে দেয় — নম্বর নেই/masked (`*`) হলে UI ব্লকটা আসেই না। ADMIN-এ regression-চেক করার দরকার নেই, gate server-এ।
- **নতুন Swift ফাইল নেই** — pbxproj অপরিবর্তিত, plist অপরিবর্তিত (bkash:// scheme খোলা Capacitor/`UIApplication.open` দিয়েই হয়, `LSApplicationQueriesSchemes` লাগে না)।

### সিম-verify recipe (আগের সেশনে একবার পুরোটা PASS করা — তুমি আবার করবে তোমার কাজের সাথে)

সিম `9E51818A-…` (IOSP0), unlock: passcode `Maruf@123` (memory `reference_ios_sim_access`)। Prod-এ একটা আসল pending WALLET_WITHDRAWAL থাকা লাগবে (2026-07-17-এ Mohammad Eyafi ৳7,400 ছিল; না থাকলে ভিজ্যুয়াল অংশটুকু স্কিপ করে শুধু build+screenshot দাও, **টেস্টের জন্য নিজে withdrawal request বানিয়ো না**)।

1. Build+install+launch → Approvals tab → withdrawal কার্ডের **Approve** → sheet-এ দেখো: প্রাপকের বিকাশ নম্বর + "নম্বর কপি করে বিকাশ খুলুন" + TrxID ঘরের পাশে "পেস্ট" ✅
2. কপি-বাটন tap → `xcrun simctl pbpaste $UDID` = নম্বর ✅; pending সংরক্ষিত কি না:
   `C=$(xcrun simctl get_app_container $UDID com.almatraders.erp data)` → `$C/Library/Preferences/com.almatraders.erp.plist`-এ `alma.bkashSendPending.v1` আছে (⚠️ `simctl spawn defaults read` container prefs **দেখে না** — plist-টা plutil/python দিয়ে পড়ো) ✅
3. `simctl terminate` + relaunch + unlock → Approvals tab → sheet **নিজে খোলে** "বিকাশ থেকে ফিরেছেন…" mode-এ ✅
4. Sheet swipe-down → plist থেকে entry মুছে গেছে ✅
5. **কখনোই "Confirm approval" চেপো না** — আসল টাকার record; sheet খোলা-বন্ধই যথেষ্ট।

### ⚠️ bKash খোলার URL — PR #449 (main-এ merged 2026-07-17), এখনো device-প্রমাণ বাকি

PR #446 `bkash://` দিয়ে অ্যাপ খুলত। **ওটা ছিল নিছক অনুমান, কোথাও যাচাই করা হয়নি** — owner prod-এ Safari থেকে পেলেন *"cannot open the page because the address is invalid"*। PR #449 দুটো ত্রুটি সারায়:

1. **URL:** `bkash://` → `https://bka.sh/next` (`BKASH_APP_URL`, `src/lib/bkash-send-flow.ts` + `BkashApp` enum, `PayrollSwiftUI.swift`)। প্রমাণ bKash-এর নিজের সার্ভার থেকে — `https://bka.sh/.well-known/apple-app-site-association` → `{"applinks":{"details":[{"appID":"4XPYVR2AGK.com.bKash.customerapp","paths":["/next"]}]}}`। অ্যাপ থাকলে iOS tap-টা bKash-কে দেয় (পেজ লোডই হয় না); না থাকলে পেজটা App Store-এ পাঠায় — error dialog নয়।
2. **Gesture:** navigation হতো `setTimeout(…, 350)`-এর ভেতর, `await`-এর পরে — ততক্ষণে iOS-এর user-gesture flag চলে গেছে, আর Universal Link ওটা ছাড়া চলে না। এখন web-এ বাটনটা আসল `<a href>` (UL-এর সবচেয়ে নির্ভরযোগ্য trigger) আর copy সম্পূর্ণ synchronous (execCommand; async Clipboard API ব্যাকআপ) যাতে tap-এর ভেতরেই শেষ হয়। Native-এ `.universalLinksOnly` + পেজ fallback।

**যা প্রমাণিত নয় (পরের এজেন্ট সাবধান):** owner-এর error দুটোর কোনটার জন্য হয়েছিল, তা জানা যায়নি — bKash-installed একটা আসল ফোনই কেবল বলতে পারে।

**🚫 সিমুলেটর এই প্রশ্নের উত্তর কোনোদিন দিতে পারবে না** — সিমে App Store নেই, তাই bKash কখনো ইনস্টল হবে না, তাই কোনো URL দাবি করার মতো অ্যাপও থাকবে না। এই দুটো ভুল-প্রমাণে পা দিয়ো না (আমি দিয়েছিলাম):
- `simctl openurl bkash://` সিমে fail করে (`LSApplicationWorkspaceErrorDomain code=115`) — এতে scheme ভুল প্রমাণ **হয় না**, শুধু bKash সিমে নেই সেটাই বলে।
- `simctl openurl https://bka.sh/next` সিমে ওই একই "address is invalid" দেখায় — এটাও ব্যর্থতা **নয়**: ওটা *not-installed* পথ, পেজটা ১০ms-এ `itunes.apple.com/...id1351183172`-তে পাঠায়, আর সিমে App Store নেই। Control: একই Safari-তে `https://example.com` দিব্যি লোড হয় (২০২৬-০৭-১৭ যাচাই) — সিম সুস্থ।
- সিমে আটকে থাকা alert পরের openurl-এর load ব্লক করে রাখে → বাসি screenshot-কে প্রমাণ ভেবো না; `simctl shutdown` + `boot` + `bootstatus -b` দিয়ে পরিষ্কার করে নিয়ো (boot শেষ হওয়ার আগে openurl দিলে `NSPOSIXErrorDomain code=60`)।

**একমাত্র আসল পরীক্ষা (build লাগে না):** bKash-installed আইফোনের Safari-তে `https://bka.sh/next` খোলা → bKash অ্যাপ খুললে UL কাজ করে, web + native দুই পথই ঠিক। Owner-এর এই যাচাই বাকি — build 77 করার আগে ফলটা জেনে নিয়ো।

### Gotchas (এই কাজ verify করতে গিয়ে শেখা)

- Sheet-এর ভেতরের বাটনে tap করার আগে **fresh screenshot** — detent animation-এর সাথে race করলে tap পেছনের কার্ডে লাগে (একবার detail sheet খুলে গিয়েছিল)
- সিমে bKash-লিংক tap করলে অ্যাপ খুলবে না (bKash নেই) — প্রত্যাশিত; sheet resumed-mode-এ যায় না যতক্ষণ scenePhase না বদলায়; আসল যাচাই device-এ (উপরের ⚠️ section দেখো)
- Sheet খোলা রেখে bKash ঘুরে এলে (app kill ছাড়া) `onChange(of: scenePhase)`-ই mode flip করে — দুটো পথই টেস্টেড

## Owner-এর কাছে দেখানোর সময় (confirm-এর আগে)

1. প্রোবের MEASURE লাইনগুলো (সংখ্যাসহ) + লক/island PNG
2. bKash sheet-এর ৪-ধাপ recipe-র screenshot (উপরের section)
3. তোমার নিজের কাজের প্রমাণ
4. `git log origin/main..HEAD` — কী কী যাচ্ছে তার তালিকা, **conflict-ছাড়া** merge-প্রমাণ

## Build 77 recipe (owner-এর confirm-এর পরে, আগে নয়)

1. এই ব্রাঞ্চ → PR → main (সব চেক সবুজ দেখে merge)
2. main checkout-এ: `sed -i '' 's/CURRENT_PROJECT_VERSION = 76;/CURRENT_PROJECT_VERSION = 77;/g' ios/App/App.xcodeproj/project.pbxproj` → commit `chore(ios): bump build to 77` → push → `bash scripts/ios-build-preflight.sh` (stamp-commit চাইলে সেটাও commit+push)
3. `gh workflow run ios-testflight.yml --ref main` → `gh run watch` (নীরব অপেক্ষা নিষেধ — owner-কে জানাও)

## জানা বাকি জিনিস (device-only, owner-এর হাতে)

- Island expanded বাটনে আসল ট্যাপ → server-এ approve পৌঁছানো (LiveActivityIntent headless চলে না)
- Pull-to-refresh-এর টান-অনুভূতি + haptics (build 76-এর awakening/pull ফিচার — `docs/proofs/agent-anim/`)
- Owner-এর build 76 device-test থেকে আরো feedback আসতে পারে — সেগুলোও এই ব্রাঞ্চে জমা করো

## Gotchas (আগের সেশনগুলোর রক্ত-ঘামে শেখা)

- **Widget লেআউট বদলালেই প্রোবে উচ্চতা মাপো** — build-এ warning আসে না, ডিভাইসে গিয়ে কাটা পড়ে
- সিম island snapshot update-এ repaint হয় না — fresh activity লাগে (`ALMA_PULSE_RESET=1`)
- BiometricKit enrollment নিজে নিজে 0 হয়ে যায় — প্রতি আনলক-লুপের আগে `notifyutil -s com.apple.BiometricKit.enrollmentChanged 1` + `-p` করে তারপর `pearl.match`
- `simctl launch` এ `KEY=val` = argv; আসল env লাগলে `SIMCTL_CHILD_KEY=val`
- নতুন Swift ফাইল = pbxproj-এ ৪ এন্ট্রি (AlmaPerfLog-এর প্যাটার্ন); widget+app দুই টার্গেটে লাগলে ৬
- Vercel: iOS/docs-only push-এ preview build skip হয় (`scripts/vercel-skip-ios-only.sh`) — প্রোডাকশন সবসময় build হয়
