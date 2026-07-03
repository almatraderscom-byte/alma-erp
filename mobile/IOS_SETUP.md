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
