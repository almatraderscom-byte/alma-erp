# Alma ERP — iOS App (Capacitor + APNs push)

Android-এর মতোই একটা thin native **shell** — production Vercel site টা load করে।  
**No API / database / Prisma changes** — same server as website + Android app.

## How it works

```
iOS app (install once) → WKWebView → https://alma-erp-six.vercel.app
```

- Vercel deploy = instant app update (নতুন build লাগে না)
- নতুন build **শুধু** তখন — icon, permission, বা native plugin change হলে
- Push platform DB-তে `ios-native` হিসেবে যায় (Android = `android-native`)

---

## যা যা already done (আপনার নতুন কিছু কিনতে/করতে হবে না)

### Apple push key (APNs)

| জিনিস | মান |
|-------|-----|
| Key name | `ALMA Push` |
| Key ID | `54SRUT66SS` |
| Team ID | `5D9FLR3MMA` |
| তৈরি | 2026-07-03 |
| Backup | `~/Documents/ALMA-secrets/` |

> ⚠️ `.p8` file টা Apple থেকে **আর download করা যাবে না** (একবারই দেয়)। তাই backup folder থেকে কখনো মুছবেন না, আর **git-এ commit করবেন না**।

### OneSignal

- **Apple iOS (APNs)** platform = **ACTIVE** (Alma ERP OneSignal app-এ)
- OneSignal App ID: `db2c4411-612e-4705-beb3-dfe71a3fd5d8`
- Auth: `.p8` (উপরের key), Bundle ID: `com.almatraders.erp`

### App Store Connect

| জিনিস | মান |
|-------|-----|
| App name | Alma ERP |
| Apple App ID | `6786929629` |
| SKU | `alma-erp-001` |
| Primary language | Bangla |
| তৈরি | 2026-07-03 |

---

## Repo-তে যা wired আছে (code ready)

- `ios/App/App/App.entitlements` — `aps-environment` (push capability)
- `ios/App/App/Info.plist` — `UIBackgroundModes: remote-notification` + camera / mic / location / photo permission string
- Deployment target: **iOS 16.0**
- `package.json` scripts: `mobile:sync:ios`, `mobile:open:ios`
- `src/lib/native-push.ts` — iOS-এ platform `ios-native` পাঠায়

---

## Requirements (build machine)

- Node 20+
- **Xcode** (Mac only) + CocoaPods
- Apple Developer account (Team `5D9FLR3MMA`)

---

## Build runbook (Mac-এ)

**1. Sync (web → iOS native project):**

```bash
export LANG=en_US.UTF-8   # ⚠️ এই Mac-এ CocoaPods-এর জন্য দরকার (Unicode error এড়াতে)
npm run mobile:sync:ios
```

**2. Xcode খুলুন:**

```bash
npm run mobile:open:ios
```

**3. Xcode-এ:**

- Signing team select করুন: **`5D9FLR3MMA`**
- iPhone device connect করে **build to device** (test করার জন্য)

**4. TestFlight-এ পাঠাতে:**

- Xcode → **Product → Archive**
- **Distribute App → App Store Connect**
- upload হলে App Store Connect → TestFlight-এ tester-দের add করুন

---

## Push test (iPhone-এ)

1. App install করে login
2. **Allow notifications** prompt → Allow
3. Admin panel → Send test → lock-screen-এ আসা উচিত

---

## Troubleshooting

| সমস্যা | সমাধান |
|--------|--------|
| `pod install` Unicode error | `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` দিয়ে আবার sync করুন |
| Sync-এর পর OneSignal plugin missing | আগে `npm install` চালান, তারপর `npm run mobile:sync:ios` |
| Permission দিলেও push আসছে না | নিচের checklist দেখুন |

**Push না আসলে checklist:**

1. iPhone-এ notification permission **granted** কিনা (Settings → Alma ERP → Notifications → Allow)
2. `/api/notifications/subscriptions`-এ ওই device-এর row আছে কিনা, platform = `ios-native`
3. OneSignal dashboard → **Audience**-এ iOS subscriber দেখাচ্ছে কিনা

---

## Security

- `.p8` push key **git-এ commit করবেন না** — শুধু `~/Documents/ALMA-secrets/`-এ backup
- Apple থেকে `.p8` re-download হয় না — backup হারালে নতুন key বানাতে হবে

---

## Face ID App Lock (iOS)

iOS app খুললে **Face ID / Touch ID** দিয়ে unlock — যাতে ফোন হারালেও কেউ ERP-তে ঢুকতে না পারে।  
Native iOS shell-এই কাজ করে (Android-এ নয়) এবং **fail-open** ডিজাইন — কখনো owner-কে lock-out করে না।

### Plugin

| জিনিস | মান |
|-------|-----|
| Plugin | `@aparajita/capacitor-biometric-auth@9.0.0` |
| Platform | **শুধু iOS native** (Android / web-এ কিছুই হয় না) |
| Fallback | Face ID fail করলে device **passcode** (`allowDeviceCredential`) |

### Design — কখনো lock-out হবে না (fail-open)

- হার্ডওয়্যার নেই / Face ID enroll করা নেই / passcode set নেই → app **normally খুলে যায়** (lock skip)।
- Plugin error বা অজানা কোনো error → app খুলে যায় (never trapped)।
- শুধু user নিজে **cancel** করলে বা face **fail** করলে lock ধরে রাখে ও আবার try করতে দেয়।
- The whole point: একটা failed face scan যেন owner-কে কখনো ভেতরে আটকে না ফেলে।

### Default ON + কীভাবে বন্ধ করবেন

- Default: iOS native-এ **ON** (এটাই feature-এর মূল উদ্দেশ্য)।
- বন্ধ করতে: **Settings → Notifications → "অ্যাপ লক (Face ID)"** toggle off করুন।
- Preference থাকে `localStorage` key `alma_biometric_lock_enabled`-এ (`0` = off) — নতুন build লাগে না।

### কখন আবার lock চায়

- **Cold start** — app পুরোপুরি নতুন করে খুললে।
- **Resume** — background-এ **৬০ সেকেন্ডের বেশি** থাকার পর আবার foreground-এ এলে।
- অল্প সময়ের জন্য অন্য app-এ গেলে (৬০s-এর কম) আবার Face ID চাইবে না।

### Files (code)

- `src/lib/biometric-lock.ts` — platform detect, enable-state, unlock logic (fail-open mapping)
- `src/components/layout/BiometricLockGate.tsx` — cold-start + resume-after-60s gate
- `src/components/settings/BiometricLockToggle.tsx` — Settings-এর on/off toggle

---

## Home-Screen Quick Actions (iOS)

App icon-এ **long-press** করলে একটা quick-action menu আসে — সরাসরি গুরুত্বপূর্ণ page-এ ঢুকে যাওয়ার শর্টকাট। Home screen থেকে দুই ট্যাপে অর্ডার/স্টক/বেতন/অ্যাসিস্ট্যান্ট।
Long-press the app icon to jump straight into a key page.

### Plugin

| জিনিস | মান |
|-------|-----|
| Plugin | `@capawesome/capacitor-app-shortcuts@7.5.0` |
| Platform | **শুধু iOS native** (web / non-native-এ কিছুই হয় না) |
| Type | **Static** shortcuts — app চালু হওয়ার সময় একবার register হয় |

### 4টি shortcut (deep-link)

| Shortcut | Route | iOS icon (SF Symbol) |
|----------|-------|----------------------|
| অর্ডার (Orders) | `/orders` | `bag.fill` |
| ইনভেন্টরি (Inventory) | `/inventory` | `archivebox.fill` |
| পেরোল (Payroll) | `/payroll` | `creditcard.fill` |
| অ্যাসিস্ট্যান্ট (Assistant) | `/agent` | `sparkles` |

- Icon-গুলো Apple-এর **SF Symbol** নাম — iOS নিজেই render করে, আলাদা image লাগে না।
- Shortcut ট্যাপ করলে shell-এর WebView same-origin route-এ navigate করে (নতুন window নয়)।

### Design — fail-open, native-only

- **Native-only:** `isCapacitorNative()` false হলে (browser / Android) register-ই হয় না — কোনো side-effect নেই।
- **Fail-open:** plugin error হলে চুপচাপ swallow করে — শর্টকাট একটা nice-to-have, app startup-কে কখনো ভাঙতে পারে না।

### Files (code)

- `src/lib/app-shortcuts.ts` — shortcut definition (`QUICK_ACTIONS`), register (`registerAppShortcuts`), id→route (`shortcutPath`)
- `src/components/layout/AppShortcutsManager.tsx` — mount-এ shortcut register করে; `GlobalPlatformChrome`-এ mounted

---

## Offline Reminders (iOS)

Push/network বন্ধ থাকলেও owner-এর আসন্ন agent reminder-গুলো যাতে মিস না হয় — native app **LOCAL notification** schedule করে রাখে, যা lock-screen-এ **অফলাইনেও** নিজে থেকে fire করে।
The native app pre-schedules local notifications for upcoming agent reminders, so they fire on the lock screen even when push or network is down.

### Plugin

| জিনিস | মান |
|-------|-----|
| Plugin | `@capacitor/local-notifications@7.0.6` |
| Platform | **শুধু iOS native** (web / non-native-এ কিছুই হয় না) |
| Build gate | **build ≥ 5** — পুরনো binary-তে pod নেই, তাই plugin **কখনো ছোঁয়া হয় না** (Face ID build-2 crash-এর মতো safety) |

### কীভাবে কাজ করে

- **Permission:** প্রথমবার notification permission চায় (একবারই); না দিলে চুপচাপ কিছুই করে না।
- **Feed:** `GET /api/assistant/device-reminders` — owner-only (chat route-এর মতোই auth)। শুধু **status = pending**, **এখন → পরের ৭ দিন**-এর মধ্যে due, `dueAt asc`, সর্বোচ্চ **৩২টি** (iOS-এর ৬৪ pending-limit-এর নিচে headroom রাখতে)।
- **Schedule:** প্রতিটি reminder-এর uuid থেকে stable numeric id বানিয়ে future-due-গুলো schedule করে; আগের sync-এ schedule করা id-গুলো (localStorage `alma_local_reminder_ids`) আগে cancel করে — তাই duplicate হয় না।
- **কখন sync হয়:** app **খোলার সময়** + প্রতিবার **resume** (foreground-এ ফেরার সময়) — কিন্তু **১০ মিনিটে সর্বোচ্চ একবার** (throttle, localStorage timestamp)।
- **Tap:** notification-এ ট্যাপ করলে app-এর **`/agent`** page-এ (reminder-এর `actionUrl`) নিয়ে যায়।

### Design — fail-open, native-only

- **Native-only:** `isCapacitorNative()` false হলে register-ই হয় না — কোনো side-effect নেই।
- **Fail-open:** যেকোনো error (permission, fetch, plugin) চুপচাপ swallow — offline reminder একটা nice-to-have, app-কে কখনো ভাঙতে পারে না।

### Files (code)

- `src/app/api/assistant/device-reminders/route.ts` — owner-only feed (upcoming pending reminders, ৭-দিন window, ৩২ cap)
- `src/lib/local-reminders.ts` — `syncLocalReminders()` (build-gate, permission, cancel-old + schedule-new, id-hash)
- `src/components/layout/LocalRemindersManager.tsx` — mount + resume-এ sync (১০-মিনিট throttle) + tap→`/agent`; `GlobalPlatformChrome`-এ mounted
