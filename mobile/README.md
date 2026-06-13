# Alma ERP — Android App (Capacitor)

Native Android **shell** that loads production from Vercel.  
**No API / database / Prisma changes** — same server as the website.

## How it works

```
APK (install once) → WebView → https://alma-erp-six.vercel.app
```

- Vercel deploy = instant app update (no new APK each time)
- New APK only when icon, permissions, or native plugins change

## Requirements (build machine)

- Node 20+
- **Android Studio** or Android SDK + JDK 17
- `ANDROID_HOME` set (Android Studio default)

## Build debug APK (testing)

```bash
npm run mobile:apk:debug
```

Output: `mobile/dist/alma-erp-debug.apk`

## Build release APK (staff distribution)

1. Create keystore (once):

```bash
keytool -genkey -v -keystore mobile/alma-erp-release.keystore -alias alma -keyalg RSA -keysize 2048 -validity 10000
```

2. Export env and build:

```bash
export ALMA_ANDROID_KEYSTORE_PATH="$PWD/mobile/alma-erp-release.keystore"
export ALMA_ANDROID_KEYSTORE_PASSWORD='your-store-password'
export ALMA_ANDROID_KEY_ALIAS='alma'
export ALMA_ANDROID_KEY_PASSWORD='your-key-password'
npm run mobile:apk:release
```

Output: `mobile/dist/alma-erp-release.apk`

## Notifications (important)

- **Downloaded APK:** ERP works, but **lock-screen push alerts do not** yet (Android WebView limitation).
- **For lock-screen alerts:** open Alma in **Chrome** on the phone → login → allow notifications.
- **Permanent APK push** needs Firebase + OneSignal Android setup (`google-services.json`) and a new APK build.

## Distribute to staff

1. Upload APK to `public/releases/alma-erp.apk` **or** Google Drive
2. Set Vercel env: `NEXT_PUBLIC_ANDROID_APK_URL=https://...`
3. Share link: `https://alma-erp-six.vercel.app/app/download`

## Point to staging (optional)

```bash
CAPACITOR_SERVER_URL=https://your-preview.vercel.app npm run mobile:sync
```

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run mobile:icons` | Regenerate launcher icons from `public/icon.svg` |
| `npm run mobile:sync` | Icons + `cap sync android` |
| `npm run mobile:apk:debug` | Build debug APK |
| `npm run mobile:apk:release` | Build signed release APK |
