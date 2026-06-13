# Alma ERP — Firebase + OneSignal (Android APK push)

**আপনার কাজ:** নিচের ২টা file আমাকে দিন। বাকি code ready আছে।

---

## আপনি যা দেবেন (২টা জিনিস)

### 1) `google-services.json` (Firebase থেকে)

### 2) OneSignal-এ Firebase connect (dashboard থেকে)

আপনার existing OneSignal app (`NEXT_PUBLIC_ONESIGNAL_APP_ID`) — **নতুন app লাগবে না**। শুধু Android platform যোগ করুন।

---

## Step-by-step (Firebase)

1. যান: https://console.firebase.google.com
2. **Create a project** (নাম: `Alma ERP` বা যেকোনো)
3. Project খুলে **Add app → Android** (Android icon)
4. **Android package name** — **ঠিক এটা লিখুন, ভুল হলে push কাজ করবে না:**

```
com.almatraders.erp
```

5. App nickname: `Alma ERP`
6. Debug signing SHA-1: **এখন skip করতে পারেন** (পরে লাগলে দেব)
7. **Register app**
8. **Download `google-services.json`**
9. Mac-এ file টা রাখুন:

```
~/alma-erp/android/app/google-services.json
```

10. আমাকে বলুন — আমি APK rebuild করে upload করব।

---

## Step-by-step (OneSignal dashboard)

1. Login: https://onesignal.com
2. আপনার **existing Alma ERP app** খুলুন (Vercel-এ যে App ID আছে)
3. **Settings → Platforms → Google Android (FCM)**
4. **Activate** করুন
5. Firebase থেকে **Service Account JSON** দিন:
   - Firebase Console → Project Settings (⚙️)
   - **Service accounts** tab
   - **Generate new private key** → JSON download
   - সেই JSON OneSignal-এ upload করুন
6. Save করুন

> OneSignal App ID আগের মতোই থাকবে — Vercel env change লাগবে না।

---

## APK rebuild (আমি করব / আপনি Mac-এ করলে)

`google-services.json` রাখার পর:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"

cd ~/alma-erp
npm run mobile:apk:debug
git add public/releases/alma-erp.apk
git commit -m "Update staff APK with native push"
git push origin main
```

Staff-দের **নতুন APK** install করতে হবে (পুরনো uninstall না করলেও overwrite install হয়)।

---

## Staff phone-এ test

1. নতুন APK install
2. Alma app খুলে login
3. **Allow notifications** prompt → Allow
4. যদি block দেখায়: **Settings → Apps → Alma ERP → Notifications → Allow all**
5. Settings → Notifications → **Send test** (admin panel থেকে) — lock-screen-এ আসা উচিত

---

## Troubleshooting

| সমস্যা | সমাধান |
|--------|--------|
| "All notifications blocked" | Settings → Apps → Alma ERP → Notifications ON |
| Permission দিলেও alert নেই | `google-services.json` আছে কিনা + OneSignal Android FCM connected কিনা |
| পুরনো APK | নতুন APK download করুন `/download.html` থেকে |

---

## Security

- `google-services.json` এবং Firebase service account JSON **git-এ commit করবেন না**
- শুধু Mac-এ `android/app/google-services.json` রাখুন
