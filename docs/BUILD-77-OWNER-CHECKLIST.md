# Build 77 — Owner Verify Checklist (এক বিল্ডে সব)

**Boss, এই এক বিল্ডেই (77) সব যাচ্ছে — কোনো আলাদা বিল্ড নেই, কোনো conflict নেই।**

কী একসাথে গেল:
1. **NP native-parity roadmap** (NP-0 → NP-8) — web-এর ১০০% native
2. **bKash send-flow** (PR #446 + UL fix #449) — main থেকে merge, conflict ০
3. **Live Activity 160pt fix** (#430) — merge-এর পরও মাপা, ঠিক আছে
4. আপনার আগের ৩টা feedback-এর পুরো সমাধান

Merge সম্পূর্ণ **conflict-free** (আমার ৬১ ফাইল আর main-এর ২৬১ ফাইল একটাও একই ফাইল ছোঁয়নি)।
Build **SUCCEEDED**, দুই gate সবুজ (route 70/66, feature 0 open), island probe **PASS**।

---

## ক) আপনার আগের ৩ feedback — সমাধান (সিমে verified, screenshot দিলাম)

- [ ] **১. LIVE Business আর "web-এর মতো hijibiji" নয়** — পুরো iOS-এ সাজানো: sticky status strip (LIVE/Agent/ব্রাউজার/💓/⚠️), iOS ট্যাব (Overview/Agents/Staff/Feed/System), date selector, ৬-KPI grid, dismissible alert, Quick Actions।
  → `docs/proofs/build-77-parity/01-live-business.png`

- [ ] **২. "Agents" section আর বিশাল বড় page নয়** — এখন পরিষ্কার iOS control-room rows: কন্ট্রোল সেন্টার (inline toggle) · AI মডেল · হার্টবিট · লাইভ ব্রাউজার · Opus রাউটিং · SLO। প্রতিটা row → sheet (উপরে "বন্ধ" বোতাম)।
  → `docs/proofs/build-77-parity/02-agents-controlroom.png`

- [ ] **৩. "System" section-ও একই control-room** — Agent ডিউটি · সালাহ · ভয়েস · ট্রাস্ট ইঞ্জিন · এজেন্ট ব্রেইন · System Health · Background Services · VPS Worker। প্রতিটা row → sheet।
  → `docs/proofs/build-77-parity/03-system-controlroom.png`

- [ ] **৪. Live Watch আর LIVE Business আলাদা** — Live Watch এখন নিজস্ব screen: বড় LIVE ব্রাউজার screenshot + device dots + "সব থামাও" kill switch + লাইভ স্টেপ feed। LIVE Business = KPI ড্যাশবোর্ড। দুটো দেখতে সম্পূর্ণ ভিন্ন।
  → `docs/proofs/build-77-parity/04-live-watch.png`

- [ ] **৫. Agent Hub duplicate সরানো** — More মেনুর Agent অংশ এখন শুধু [Agent Hub, Phone Companion]; বাকি সব একটাই জায়গায় (Agent Hub-এর ১২ কার্ড grid)। আর double নেই।
  → `docs/proofs/build-77-parity/05-agent-hub.png`

- [ ] **৬. "back button নেই" — এখন প্রতিটা pushed screen-এ ঠিক একটাই glass back বোতাম** (আগের double/missing দুটোই সারানো)। উপরের ৫টা screenshot-এই বাম-উপরে একটাই back circle।

---

## খ) NP native-parity — web-এর সব function native (strict gate: 0 বাকি)

- [ ] Agent Hub-এ ১২টা agent surface (Chat, Monitor, Live Watch, Creative Studio, WhatsApp, Costs, Growth, Known People, Product Images, Trading Staff, Subscriptions, Phone Companion)
- [ ] LIVE Business ৫ ট্যাবে সব owner-control (deploy, retrigger, NTFY, approve/reject, duty toggle, model tune, SLO, trust tier, auto-fix)
- [ ] Native পাসওয়ার্ড রিকভারি (forgot/reset) + wallet deep link
- [ ] Admin/Settings native: Users, Supplier import, Payment accounts (Face ID gate), Branding, Telegram, Notifications, Session, Diagnostics, Business archive
- [ ] Trading: account admin, partnership settle, Telegram admin, analytics filter + CSV/PDF export
- [ ] Portal/HR/Inventory/Document: camera/upload/PDF সব native (আর web-এ লাফায় না)

> এই তালিকা `scripts/ios-feature-parity-check.mjs --strict` দিয়ে গ্যারান্টিড — ১০৪টা action-ই native বা owner-approved, **০টা web-এ খোলা**।

---

## গ) bKash send-flow (main merge — নতুন)

- [ ] Approvals ট্যাবে আসল pending withdrawal দেখা যায়: Mohammad Eyafi · ৳7,400 · bKash **01316429909** (নম্বর দেখাচ্ছে = SUPER_ADMIN gate ঠিক)
  → `docs/proofs/build-77-parity/06-approvals-bkash.png`
- [ ] (সিম-এ চাইলে) **Approve** চাপুন → sheet খোলে: প্রাপকের নম্বর + "নম্বর কপি করে বিকাশ খুলুন" + TrxID পেস্ট ঘর।
  **⚠️ কখনো "Confirm approval" চাপবেন না — ওটা আসল টাকার record। sheet খোলা-বন্ধই যথেষ্ট।**

---

## ঘ) শুধু আসল ফোনে দেখতে হবে (সিম পারে না — build 77-এর পর device-এ)

- [ ] **bKash অ্যাপ খোলা** — Approve → "বিকাশ খুলুন" চাপলে bKash অ্যাপ খোলে (Universal Link `https://bka.sh/next`)।
  *(আপনি ২০২৬-০৭-১৭-এ Safari-তে এটা device-এ confirm করেছেন — build 77-এ sheet-এর ভেতর থেকেও একবার দেখে নেবেন।)*
  **সিমে কেন হয় না:** সিমে App Store নেই → bKash কখনো ইনস্টল হয় না → লিংক প্রমাণ করা অসম্ভব।
- [ ] **Live Activity (Dynamic Island)** — island লম্বা-চাপ দিলে expanded কার্ড + approve/বাতিল বোতাম **কাটা পড়ে না** (probe মেপেছে lock 156/157pt, island 83/89/83pt — Apple-এর 160pt সীমার ভেতরে; আসল চোখে একবার মিলিয়ে নেবেন)।
  → মাপ: `docs/proofs/build-77-parity/00-island-160pt-measured.txt`
- [ ] Face ID (আসল hardware), push notification, keyboard feel — এগুলোও device-এর জিনিস।

---

## ঙ) আপনি confirm করলে পরের ধাপ (আমি করব)

1. এই branch → PR → **main** (সব চেক সবুজ দেখে merge; creative-studio-demo demo-page টাও তখন ডিলিট হবে)
2. `CURRENT_PROJECT_VERSION 76 → 77` bump → commit → `bash scripts/ios-build-preflight.sh` (git-clean + main-current গেট + commit-stamp)
3. `gh workflow run ios-testflight.yml --ref main` → পাইপলাইন থেকে **build 77** — আপনাকে জানিয়ে monitor করব, নীরবে অপেক্ষা করব না।

> **এখন push করিনি ইচ্ছে করেই** — merge-এ main-এর web-ফাইল এসেছে, এখন push করলে Vercel অকারণে preview build চালু করে আপনার queue জ্যাম করত (আপনার "vercel deploy jeno na hoy" নিয়ম)। কাজটা locally commit করা + নিরাপদ; push হবে শুধু main-এ merge-এর সময় (তখন production build-ই কাম্য)।

---

### আপনার কাছে অনুরোধ
স্ক্রিনশট ৬টা (`docs/proofs/build-77-parity/`) দেখে ক-খ-গ মিলিয়ে নিন। "aro onk kichu missing" বলেছিলেন — নির্দিষ্ট করে কোন page/function এখনো missing মনে হয়, বললে build 77-এর আগেই একই branch-এ ঢুকিয়ে দিই। সব ঠিক থাকলে শুধু **"confirm, build 77 koro"** বললেই যথেষ্ট।
