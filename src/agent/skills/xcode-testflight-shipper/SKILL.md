---
name: xcode-testflight-shipper
description: Ships the iPhone app to TestFlight the one safe way: preflight on Boss's Mac, bump the committed build number, push, start the GitHub upload pipeline, watch it to the end. Use when Boss asks for a new TestFlight build, or where the last upload stands.
version: 1.0.0
keywords: testflight, টেস্টফ্লাইট, test flight, build dao, নতুন build, ios build, iphone app build, app build koro, upload build, build number
---

# TestFlight-এ নতুন build

**Boss স্পষ্ট করে "হ্যাঁ, build দাও" না বললে pipeline চালু করবে না।** এটাই সবচেয়ে
বড় নিয়ম — তিনি নিজে একবার দেখে নিশ্চিত করার পরই build হয়। তার আগে তোমার কাজ:
কী কী যাচ্ছে, git-এর অবস্থা কী, কোন নম্বর হবে — এইটুকু দেখিয়ে **অপেক্ষা করা**।

## ধাপ

```
- [ ] ১. Mac ও git-এর অবস্থা পড়ো (কোনো কার্ড লাগে না)
- [ ] ২. preflight চালাও
- [ ] ৩. build নম্বর ঠিক করো, bump + commit + push
- [ ] ৪. Boss-এর "হ্যাঁ" নিয়ে pipeline চালু করো
- [ ] ৫. শেষ পর্যন্ত দেখো, ফল বলো
```

১. **অবস্থা** — `run_mac_command` দিয়ে (সব কটাই সঙ্গে সঙ্গে চলে, কার্ড লাগে না):
   `git status`, `git log --oneline -5`, `git branch`, আর বর্তমান নম্বরের জন্য
   `grep CURRENT_PROJECT_VERSION ios/App/App.xcodeproj/project.pbxproj`।
   cwd ডিফল্ট `~/alma-erp` — বদলানোর দরকার নেই।
   **main ছাড়া অন্য branch হলে বা কিছু uncommitted থাকলে সেখানেই থামো** এবং
   Boss-কে বলো কী অবস্থা; নিজে branch বদলাবে না।

২. **preflight** — `bash scripts/ios-build-preflight.sh`। এটা কার্ড হয়ে যাবে
   (স্ক্রিপ্ট চালানো), তাই Boss-কে বলো কার্ড পাঠিয়েছি; approve-এর পর ফল
   `check_mac_command` দিয়ে নাও। এটা আটকায়: নোংরা tree, un-pushed commit,
   origin/main-এর কাজ অনুপস্থিত, ভুল branch। **ব্যর্থ হলে git-এর অবস্থা ঠিক করো,
   preflight-কে পাশ কাটিয়ে কখনো এগোবে না** — ৬৩–৬৯ নম্বর build ঠিক এই কারণে
   আগের ফিচার হারিয়েছিল।

৩. **নম্বর** — git-ই সত্য। এখনকার `CURRENT_PROJECT_VERSION`-এর পরের সংখ্যা।
   project.pbxproj-এ **সব জায়গায় একই নম্বর** থাকতে হবে (pipeline নিজে মিলিয়ে
   দেখে; না মিললে থামে)। বদলে commit: `chore(ios): bump build to N`, তারপর
   `git push`। দুইটাই কার্ড। **push শেষ না হওয়া পর্যন্ত pipeline নয়** — TestFlight-এ
   ওঠা নম্বর আর git-এর নম্বর সবসময় এক থাকতে হবে।

৪. **চালু** — Boss-এর "হ্যাঁ" পাওয়ার পর:
   `gh workflow run ios-testflight.yml -f expected_build=N`। কার্ড হয়ে যাবে।
   pipeline নিজেও পাহারা দেয়: শুধু main, HEAD = origin/main, committed নম্বর =
   `expected_build`, tree পরিষ্কার। কোনোটা না মিললে সে **থেমে যায়** — সেটা
   ঠিক আচরণ, ওটাকে পাশ কাটানোর চেষ্টা কোরো না।

৫. **দেখা** — `gh run list --workflow=ios-testflight.yml -L 3` (সঙ্গে সঙ্গে চলে)।
   চলতে থাকলে অপেক্ষা করে আবার দেখো; শেষ হলে `gh run view <id>` দিয়ে ফল।
   ব্যর্থ হলে **আসল ব্যর্থ ধাপের নাম আর লাইনটা** দেখাও, "কিছু একটা সমস্যা" নয়।

## এই skill-এর নিজের নিষেধ

- **Boss-এর স্পষ্ট অনুমতি ছাড়া pipeline চালু নয়** — এমনকি সবকিছু তৈরি থাকলেও।
- **Mac-এ নিজে archive করবে না।** upload-এর একমাত্র পথ GitHub pipeline; Mac-এ
  archive করা মানেই সেই পুরনো "লোকাল অবস্থা থেকে build" — যেটা ফিচার খায়।
- **নম্বর নিয়ে কারিকুরি নয়** — pipeline যে নম্বর চায়, git-এ সেই নম্বরই commit করা
  থাকতে হবে। App Store Connect-এ আগে ব্যবহৃত নম্বর দিলে সে না বলবে; সেটাই ঠিক।
- **force push কখনো নয়** (কোডেই নিষিদ্ধ), branch delete নয়, main-এ সরাসরি
  ফিচার commit নয় — শুধু bump commit।
- **"upload হয়ে গেছে" নিজে থেকে বলবে না** — pipeline সবুজ হওয়ার প্রমাণ ছাড়া নয়।
  আর সবুজ হওয়ার পরেও ফোনে দেখাতে Apple-এর নিজের দেরি হয়; সেটা আলাদা করে বলো।

## Boss-কে কী বলবে

শেষে চার লাইন: **কোন build নম্বর · কোন commit · pipeline-এর লিংক/অবস্থা · এখন কী
করতে হবে**। ব্যর্থ হলে একই চারটা, তার সাথে থেমে যাওয়ার আসল কারণ।
