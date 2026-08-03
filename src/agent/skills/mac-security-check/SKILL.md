---
name: mac-security-check
description: Checks the safety settings on Boss's Mac — disk encryption, firewall, screen lock, pending system updates, whether the agent's own daemon is the only thing listening — and reports what is off in plain Bangla. Use when Boss asks whether his Mac is secure, or whether anything needs updating.
version: 1.0.0
keywords: mac secure kina, security check, filevault, firewall on ache, update baki ache, mac nirapod, encryption on
---

# Mac-এর নিরাপত্তা-সেটিং দেখা

ব্যবসার দলিল এই Mac-এ। প্রশ্নটা সরল: **হারিয়ে গেলে বা চুরি হলে কী কী খোলা থাকবে?**
শুধু পড়ার কাজ — এই skill কোনো সেটিং বদলায় না, কারণ সেগুলো `sudo` চায় আর সেটা
কোডেই নিষিদ্ধ।

## যা দেখবে

- **ডিস্ক এনক্রিপশন:** `fdesetup status` — বন্ধ থাকলে Mac চুরি হলে সব পড়া যায়।
  এটাই সবচেয়ে জরুরি লাইন।
- **ফায়ারওয়াল:** `/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate`
- **স্ক্রিন লক:** `sysadminctl -screenLock status` (না চললে বাদ দাও, বানিয়ো না)
- **বাকি আপডেট:** `softwareupdate -l` — ধীর, তাই একবারই; timeout হলে
  `check_mac_command` দিয়ে পরে ফল নাও।
- **macOS সংস্করণ:** `sw_vers`

## যেভাবে বলবে

**তালিকা নয়, ঝুঁকি।** প্রতিটার পাশে এক লাইনে "এটা বন্ধ থাকলে কী হয়":
- FileVault বন্ধ → "Mac চুরি হলে সব ফাইল পড়া যাবে"
- Firewall বন্ধ → "একই wifi-তে থাকা কেউ ঢোকার চেষ্টা করতে পারে"
- আপডেট বাকি → কয়টা, আর কোনটা security update

সব ঠিক থাকলে **সংক্ষেপে "সব ঠিক আছে" বলো** — লম্বা তালিকা দিয়ে ভয় দেখিয়ো না।

## এই skill-এর নিজের নিষেধ

- **কোনো সেটিং চালু/বন্ধ করা নয়** — FileVault, firewall, আপডেট — সব `sudo`
  চায়, আর সেটা কোডেই বন্ধ। Boss-কে বলো তিনি নিজে কোথায় গিয়ে করবেন।
- **আপডেট ইনস্টল করা নয়** — মাঝপথে রিস্টার্ট হলে তাঁর কাজ যাবে।
- **কোনো ফল না পেয়ে "ঠিক আছে" বলা নয়** — কমান্ড না চললে সেটাই বলো।
- **কী/পাসওয়ার্ড-সংক্রান্ত কিছু পড়া নয়** — কোডেই নিষিদ্ধ, চেষ্টাও কোরো না।

## Boss-কে কী বলবে

দুই ভাগে: **কী কী ঠিক আছে (এক লাইনে)** আর **কী কী তাঁর হাতে করতে হবে** — প্রতিটার
পাশে কোথায় গিয়ে করবেন (System Settings-এর কোন পাতা)।
