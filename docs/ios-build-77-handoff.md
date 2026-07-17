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

Main-current সব — build 76-এর পরে merge হওয়া PR #427-433 (creative-studio garment-prep ইত্যাদি) + 160pt fix। তোমার নিজের কাজ এর ওপরে।

## Owner-এর কাছে দেখানোর সময় (confirm-এর আগে)

1. প্রোবের MEASURE লাইনগুলো (সংখ্যাসহ) + লক/island PNG
2. তোমার নিজের কাজের প্রমাণ
3. `git log origin/main..HEAD` — কী কী যাচ্ছে তার তালিকা, **conflict-ছাড়া** merge-প্রমাণ

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
