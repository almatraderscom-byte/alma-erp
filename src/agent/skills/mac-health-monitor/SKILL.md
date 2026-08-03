---
name: mac-health-monitor
description: Reads the health of Boss's Mac — free disk, battery, memory pressure, what is eating space, whether the agent's own daemon is alive — and reports it in plain Bangla. Use when Boss asks whether his Mac is healthy, why it is slow or full, or what is running on it.
version: 1.0.0
keywords: mac slow, mac er obostha, disk full, jayga nei kotha, battery koto, memory beshi, mac health, storage full, mac check koro, kon jinis jayga khacche
---

# Mac-এর স্বাস্থ্য দেখা

শুধু **পড়ার** কাজ — এই skill কিছু বদলায় না, মোছে না, সরায় না। কাজ হলো সংখ্যা
এনে Boss-কে বাংলায় সহজ করে বলা।

## ধাপ

```
- [ ] ১. এজেন্ট/Mac বেঁচে আছে কিনা
- [ ] ২. ডিস্ক, ব্যাটারি, মেমরি
- [ ] ৩. কে জায়গা/CPU খাচ্ছে
- [ ] ৪. এক নজরে বাংলা রিপোর্ট
```

১. **বেঁচে আছে?** — `mac_agent_status`। অফলাইন হলে এখানেই থামো, বাকি ধাপ অর্থহীন।
   ঘুম আটকাতে হলে `mac_desk_control` action="power_status" দিয়ে অবস্থা দেখো।

২. **মূল সংখ্যা** — প্রজেক্ট ফোল্ডারের ভেতরের এই কমান্ডগুলো **সঙ্গে সঙ্গে চলে**,
   কার্ড লাগে না, তাই আলাদা আলাদা করে দাও:
   - `df -h` — কোন ডিস্কে কত খালি
   - `uname -a` আর `sw_vers` — কোন macOS
   - `date` — কতক্ষণ ধরে চালু (uptime লাগলে সেটাও)
   ব্যাটারি/মেমরির জন্য `pmset -g batt` আর `vm_stat` — এগুলো green তালিকায় নেই,
   তাই কার্ড হবে; **একবারে চাইলে এক কমান্ডে চাও**, আলাদা করে ট্যাপ বাড়িয়ো না।

৩. **কে খাচ্ছে** — বড় ফাইল/ফোল্ডার: `du -sh ~/Downloads ~/Desktop ~/Documents`
   (বাইরের পথ, তাই কার্ড)। প্রসেস: `ps aux` ভারী, তাই দরকার হলে শীর্ষ কয়েকটাই।

৪. **রিপোর্ট** — সংখ্যা দিয়ে, তুলনাসহ: "৪৬০ GB-র মধ্যে ২১ GB খালি (৫%)" — শুধু
   "কম আছে" নয়। জায়গা কম হলে **কোন তিনটা ফোল্ডার সবচেয়ে বড়** সেটাও বলো।

## এই skill-এর নিজের নিষেধ

- **কিছু মুছবে না, সরাবে না, বন্ধ করবে না** — দেখার পর কাজ করতে হলে সেটা
  `mac-file-organizer`-এর কাজ, আর Boss-কে সেটাই বলো।
- **প্রসেস kill নয়** (কোডেই নিষিদ্ধ), সেটিং বদল নয়।
- **টুল না চালিয়ে কোনো সংখ্যা বলবে না** — "মনে হয় জায়গা কম" এই skill-এ নিষিদ্ধ।

## Boss-কে কী বলবে

তিন-চার লাইন: **ডিস্ক · ব্যাটারি · মেমরি · এজেন্ট চালু কিনা**, তারপর দরকার হলে
এক লাইনে "কী করলে ভালো হয়" — কিন্তু নিজে করে ফেলবে না।
