---
name: ios-simulator-verifier
description: Builds the iPhone app and runs it in the Simulator on Boss's Mac, then looks at the screen and reports what it actually shows — so a UI problem is found before a TestFlight build instead of on his phone. Use when Boss asks to check the app before shipping, or whether a screen looks right.
version: 1.0.0
keywords: simulator e dekho, app ta dekho, screen thik ache kina, simulator chalao, build kore dekho, iphone app test, ui thik ache to
---

# Simulator-এ অ্যাপ দেখে নেওয়া

এটার একটাই উদ্দেশ্য: **Boss-এর ফোনে যাওয়ার আগেই সমস্যা ধরা**। তাই কাজের শেষে
"build হয়েছে" বলা যথেষ্ট নয় — **স্ক্রিনে কী দেখা যাচ্ছে সেটাই আসল ফল**।

## ধাপ

```
- [ ] ১. simulator আছে/চালু আছে কিনা
- [ ] ২. build
- [ ] ৩. install + launch
- [ ] ৪. স্ক্রিন দেখো — এবং পড়ো
- [ ] ৫. যা দেখলে, সেটাই বলো
```

১. **ডিভাইস** — `xcrun simctl list devices booted`। কিছু বুট করা না থাকলে
   `xcrun simctl boot "iPhone 17 Pro Max"`, তারপর `open -a Simulator` (জানালাটা
   সামনে না এলে স্ক্রিনশটে দেখা যাবে না)।

২. **build** — কার্ড হবে, সময় লাগবে (কয়েক মিনিট):
   `xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' -derivedDataPath /tmp/alma-sim-dd build`
   টাইমআউট হলে `check_mac_command` দিয়ে পরে ফল নাও।
   **ব্যর্থ হলে আসল `error:` লাইনটা দেখাও** — "build fail করেছে" যথেষ্ট নয়।

৩. **চালানো** —
   `xcrun simctl install booted /tmp/alma-sim-dd/Build/Products/Debug-iphonesimulator/App.app`
   তারপর `xcrun simctl launch booted com.almatraders.app`।

৪. **দেখা** — `mac_desk_control` action="screenshot"। ছবিটা চ্যাটেই আসে **আর
   ফলাফলে `screenContents`-এ লেখা থাকে স্ক্রিনে কী দেখা যাচ্ছে** — সেটাই তোমার
   চোখ। `visionNote` এলে ছবিটা পড়া যায়নি; তখন **রায় দিও না**, সেটাই বলো।
   অন্য স্ক্রিন দেখতে হলে Boss-কে বলো কোথায় ট্যাপ করতে হবে — Simulator-এর
   ভেতরে ট্যাপ করার ক্ষমতা এই skill-এর নেই, আর সেটা লুকিয়ো না।

৫. **রিপোর্ট** — build-এর ফল, স্ক্রিনে যা দেখা গেল, আর **কী কী চোখে লাগল**।

## এই skill-এর নিজের নিষেধ

- **TestFlight-এ কিছু পাঠানো নয়** — ওটা `xcode-testflight-shipper`, আর Boss-এর
  স্পষ্ট অনুমতি লাগে।
- **ছবি না দেখে "ঠিক আছে" বলা নয়।** এই skill-এর পুরো মানেই ওই ছবিটা।
- **build number বদলানো নয়, commit নয়, push নয়** — এটা শুধু দেখার কাজ।
- **ওয়েব পেজের সমস্যা এখানে খুঁজো না** — অ্যাপের ভেতরের ওয়েব অংশ Boss-এর
  Chrome-এ `?native=1` দিয়েই দেখা যায়, build ছাড়াই; সেটাই বলো।

## Boss-কে কী বলবে

তিন লাইন: **build হয়েছে কিনা · স্ক্রিনে কী দেখা গেল · কী ঠিক করতে হবে**।
কিছু না পারলে সেটাও — বিশেষ করে "ভেতরে ট্যাপ করতে পারিনি"।
