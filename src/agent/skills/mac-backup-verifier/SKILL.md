---
name: mac-backup-verifier
description: Checks that Boss's Mac is actually backed up — when Time Machine last finished, whether the disk is still attached, whether iCloud Drive is syncing — and says plainly how many days of work would be lost right now. Use when Boss asks about backup, or whether his files are safe.
version: 1.0.0
keywords: backup ache kina, time machine, backup koto din age, file safe to, data harale, icloud sync, backup obostha
---

# ব্যাকআপ আছে কিনা দেখা

এই skill-এর একটাই প্রশ্নের উত্তর দেয়: **আজ যদি Mac-টা হারিয়ে যায়, কতটুকু কাজ
হারাবে?** শুধু পড়ার কাজ — ব্যাকআপ চালু/বন্ধ করে না।

## ধাপ

```
- [ ] ১. Time Machine সেট করা আছে কিনা
- [ ] ২. শেষ ব্যাকআপ কবে
- [ ] ৩. এখন চলছে কিনা
- [ ] ৪. কত দিনের ঝুঁকি — এক লাইনে
```

- **সেট করা আছে?** `tmutil destinationinfo`
- **শেষ কবে?** `tmutil latestbackup` — তারিখটাই আসল উত্তর
- **এখন কী করছে?** `tmutil status`
- **iCloud Drive?** ফোল্ডারটা **থাকা মানেই সিঙ্ক হওয়া নয়** — iCloud বন্ধ, থেমে
  থাকা বা আটকে থাকা অবস্থায়ও `~/Library/Mobile Documents` থেকেই যায়। তাই
  ফোল্ডারের অস্তিত্ব দেখে "ব্যাকআপ আছে" কখনো বলবে না। যা দেখতে হবে:
  `brctl status` (সিঙ্ক আসলে কী করছে) আর
  `defaults read MobileMeAccounts Accounts` (আদৌ লগইন আছে কিনা)।
  দুইটার কোনোটাই ফল না দিলে **"iCloud-এর অবস্থা যাচাই করতে পারিনি" বলো** —
  "আছে" বলা নয়। ব্যাকআপের ব্যাপারে ভুল আশ্বাস দেওয়াই সবচেয়ে বড় ক্ষতি।

## যেভাবে বলবে

**তারিখ নয়, দিন গোনো।** "শেষ ব্যাকআপ ৩১ জুলাই" নয় — **"শেষ ব্যাকআপ ৩ দিন আগে,
মানে ৩ দিনের কাজ ঝুঁকিতে"**। এটাই Boss-এর কাজে লাগে।

আর **কী ব্যাকআপে নেই সেটাও বলো**: Time Machine-এর ডিস্ক খোলা না থাকলে নতুন কিছুই
যাচ্ছে না, আর iCloud-এ শুধু Desktop/Documents থাকে (সেটিং অনুযায়ী), পুরো Mac নয়।

## এই skill-এর নিজের নিষেধ

- **ব্যাকআপ শুরু/বন্ধ করা নয়, ডিস্ক ফরম্যাট নয়, সেটিং বদল নয়** — শুধু দেখা।
- **কোনো তারিখ আন্দাজে বলা নয়** — টুলের আউটপুট না পেলে সেটাই বলো।
- **"সব ঠিক আছে" বলার আগে শেষ ব্যাকআপের তারিখটা হাতে থাকতে হবে।**
- **ফোল্ডার আছে ≠ ব্যাকআপ আছে।** সিঙ্কের অবস্থা না দেখে কভারেজ দাবি করা নিষিদ্ধ।

## Boss-কে কী বলবে

দুই লাইন: **শেষ ব্যাকআপ কত দিন আগে · এখন কী ঝুঁকি**। খারাপ অবস্থা হলে এক লাইনে
কী করলে ঠিক হয় (ডিস্ক লাগানো/Time Machine চালু) — কিন্তু নিজে করবে না।
