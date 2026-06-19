# 🏢 অফিস + দুই-মগজ (Sonnet হেড / Haiku ম্যানেজার) — পূর্ণ নকশা

> তারিখ: ২০২৬-০৬-১৯ · মালিক: Maruf · এই কাগজটা রেখে দিন।
> **ক্রম (মালিকের সিদ্ধান্ত):** আগে খরচ কমানোর কাজ শেষ (system-prompt clean ইত্যাদি) → **তারপর** এই নতুন design build হবে।
> কোনো ধাপ সরাসরি production-এ যাবে না — branch → Vercel preview → **আপনি টেস্ট করবেন** → পছন্দ হলে merge।

---

## ০. এক প্যারায় পুরো জিনিস

Staff তাদের নিজের ERP account-এ ঢুকে একটা **Office section** দেখবে — ঠিক এখন যেমন todolist আছে, সেটাই থাকবে।
সেখানে দিনের কাজগুলো একটা **messenger-group-এর মতো** দেখাবে: কে কথা বলছে তার **নাম সহ** —
staff-দের নাম (ছোট), মালিকের নাম **"Boss"**, আর দুই মগজের নাম **Sonnet** ও **Haiku**।
সারাদিন **Haiku** ("অফিস ম্যানেজার") চলমান কাজ সামলাবে — task বোঝানো, reminder, staff দেখাশোনা।
**Sonnet** ("হেড") চুপ করে বসে থাকবে — শুধু (১) রাতে কালকের পরিকল্পনা, (২) বড় কাজ (ছবি/FB/research),
(৩) **আপনি ডাকলে** জাগবে। দিন শেষে (অফিসের পর) Sonnet সব review করে আপনাকে update দেবে — যেটা এখনো দেয়।

---

## ১. দারুণ খবর: ৭০% ভিত আপনার কোডে অলরেডি আছে

| যা দরকার | কোডে যা আছে | ফাইল/টেবিল |
|---|---|---|
| Staff-দের login | ✅ `User` টেবিল (role STAFF) | `prisma/schema.prisma`, `src/lib/auth.ts` |
| Staff ↔ agent সংযোগ | ✅ `AgentStaff.userId` লিংক আগেই আছে | `agent_staff` |
| আজকের task + details | ✅ `staff_tasks` (title, detail, status, proposed_for, proof) | `agent_phase6_schema` |
| অফিস todolist | ✅ `agent_todos` + dock UI | `AgentTodoDock.tsx`, `AgentTodoPanel.tsx`, `OfficeShiftThreadBlocks.tsx` |
| রাতে Sonnet পরিকল্পনা | ✅ `evening_proposal` ২১:০৫ (Sonnet) → আপনি approve → ০৯:০০ dispatch | `worker/src/staff/evening-proposal.mjs`, `dispatch.mjs` |
| দিনশেষে Sonnet review→update | ✅ `night-report` / `daily-summary` | `worker/src/staff/night-report.mjs` |
| বড় কাজ আলাদা মগজে | ✅ image/FB/research → VPS worker queue → subagent | `confirm-tools.ts`, `orchestrator-tools.ts`, `subagent.ts` |
| Model বদলের সুইচ (redeploy ছাড়া) | ✅ tier-router + KV setting | `models/tier-router.ts`, `models/routing-config.ts` |
| বড় মগজে escalation প্যাটার্ন | ✅ `opus-gate` (Sonnet→Opus নিজে ওঠে) | `models/opus-gate.ts` |
| হালকা/সস্তা কলের নমুনা | ✅ `morale-message.ts` (৪০ লাইন prompt, ০ tool, history নাই) | `lib/morale-message.ts` |

## ২. যা **নেই** — শুধু এই ৪টা নতুন বানাতে হবে

1. ❌ **Haiku কোথাও ব্যবহার হয় না** — registry-তে আছে (`claude-haiku-4-5`, $১/$৫), কিন্তু একটাও call site নেই।
2. ❌ **Staff-এর Office পেজ নেই** — `/agent` শুধু SUPER_ADMIN; staff ঢুকতেই পারে না। Telegram ছাড়া staff কিছু দেখে না।
3. ❌ **Staff প্রশ্ন করার থ্রেড নেই** — এখন একমুখী (task পাঠায়, staff শুধু "Done" বাটন)। প্রশ্ন-উত্তরের টেবিল নেই।
4. ❌ **messenger-group স্টাইল নাম-সহ UI নেই** — এখন dock-এ task দেখায়, কিন্তু "কে বলল" (Boss/Sonnet/Haiku/staff-নাম) সেই participant-ভিউ নেই।

---

## ৩. দুই-মগজের নকশা (আপনার কোডে যেভাবে বসবে)

### 🧠 Sonnet = "হেড" — চুপ থাকে, তিন সময়ে জাগে
1. **রাতের পরিকল্পনা** — `evening_proposal` (অলরেডি Sonnet) কালকের task বানায় → আপনি approve।
2. **দিনশেষে review + update** — অফিসের পর (যেমন রাত ৮টা/`night-report`) সব দেখে আপনাকে সারাংশ + কালকের proposal দেয়। **এটা এখনো দেয় — থাকবে।**
3. **বড় কাজ** — ছবি বানানো, FB post, full ERP research → worker queue → subagent (Sonnet)।
4. **Escalation (আপনি ডাকলে)** — Haiku ভুল বোঝালে/গন্ডগোল হলে আপনি ডাকেন → Sonnet **শুধু ওই থ্রেডের সারাংশ** পড়ে সমাধান করে। (`opus-gate` প্যাটার্ন, Haiku→Sonnet)
> Sonnet নিজে থেকে কিছু করে না। আপনি না ডাকলে / scheduled বড় কাজ না হলে → **খরচ শূন্য**।

### 👔 Haiku = "অফিস ম্যানেজার" — সারাদিনের চলমান কাজ
- reminder, presence-nudge, midday-checkin, morale, staff দেখাশোনা (এখন worker-এ, কিছু ভুলভাবে Sonnet-এ → Haiku-তে নামাব)।
- **staff-কে task বুঝিয়ে দেওয়া** (নতুন helper): ছোট prompt, ০ tool, শুধু ওই task-এর detail + থ্রেড → Haiku।
- সময়ে সময়ে "কাজ কতদূর?" ট্র্যাক করা।

**খরচ:** Haiku $১/$৫ vs Sonnet $৩/$১৫ → রুটিন কাজে **~৩ ভাগের ১ ভাগ**। staff-প্রশ্নের উত্তর (ছোট context + Haiku) ≈ **আধ পয়সা** (এখন হলে ~$০.১৩)।

---

## ৪. নতুন UI: messenger-group স্টাইল (নাম সহ)

Office section-এ আজকের কাজ একটা **group chat-এর মতো** দেখাবে — প্রতিটা মেসেজ/task-এ **কে বলছে** তার নাম:

```
┌─ আজকের অফিস · ১৯ জুন ───────────────────────┐
│ 🟦 Sonnet (হেড)   কালকের ৬টা task ঠিক করেছি, Boss approve করুন │
│ 👑 Boss           approve করে দিলাম                          │
│ 🟩 Haiku (ম্যানেজার) Rakib ভাই, আজ ৩টা product-এর ছবি... │
│   └ 🧍 rakib       এই size-টা বুঝিনি, কোনটা?               │
│   └ 👑 Boss        (approve: উত্তর দাও)                     │
│   └ 🟩 Haiku       Rakib ভাই, ৮৫০ml-এর বোতলটা...           │
│ 🟩 Haiku           Sadia আপু, লিস্ট আপডেট হয়েছে?           │
└──────────────────────────────────────────────┘
[ Sonnet-কে ডাকুন ]  ← super-admin যেকোনো সময়
```

**নিয়ম:**
- প্রতি বুদবুদে (bubble) **নাম + ছোট আইকন**: `Sonnet` (নীল, হেড), `Haiku` (সবুজ, ম্যানেজার), `Boss` (👑, আপনি), staff-রা ছোট নামে (rakib, sadia...)।
- todolist **থাকবেই** — শুধু উপরে এই participant-ভিউ যোগ হবে, যাতে বোঝা যায় কোন মেসেজ/task কে দিয়েছে।
- Haiku মেসেজ দিলে / task assign করলে → তার নামে দেখাবে।
- Staff প্রশ্ন → আপনার নামে approve বুদবুদ → তারপর Haiku উত্তর।
- **"Sonnet-কে ডাকুন" বাটন** — super-admin যেকোনো সময় Sonnet জাগাতে পারবে (escalation)।

---

## ৫. নতুন data (additive, ছোট)

1. **`staff_task_messages`** (নতুন টেবিল) — প্রতি task-এর থ্রেড। কলাম: `task_id`, `sender_type` (`haiku|sonnet|boss|staff`), `sender_name`, `body`, `created_at`। **এটাই "আজকের context" — Haiku শুধু এটা + task-detail পড়ে।**
2. **`approval_status`** — staff প্রশ্নে `question_pending → approved → answered`। (নতুন কলাম বা ছোট টেবিল)
3. বাকি সব বিদ্যমান টেবিলেই (`staff_tasks`, `agent_todos`, `AgentStaff.userId`)।

---

## ৬. নিরাপদ ধাপ-ক্রম

> **আগে: cost-কমানো (system-prompt clean ইত্যাদি) শেষ হবে। তারপর নিচের ধাপগুলো।**

| ধাপ | কী | ফাইল (মোটামুটি) | ঝুঁকি | আপনি যা পাবেন |
|---|---|---|---|---|
| **১** | রুটিন worker-কাজ + হালকা subagent → Haiku (KV setting + worker-এর ২টা model লাইন) | `routing-config.ts`, `tier-router.ts`, `worker/src/intelligence/batch-claude.mjs`, `weekly-strategic-batch.mjs` | কম | সাথে সাথে খরচ কমবে, কোনো UI/staff-এক্সপোজার ছাড়াই |
| **২** | Staff portal-এ "Office" পেজ — staff শুধু **নিজের** আজকের task দেখে (read-only) | নতুন `/portal/office` রুট, role-gate (`src/lib/roles.ts`) | কম | staff প্রথমবার নিজের task panel-এ দেখবে |
| **৩** | messenger-group UI + staff প্রশ্ন + approval-গেট + Haiku staff-helper | নতুন `staff_task_messages` টেবিল, নতুন হালকা `/api/assistant/staff-helper` রুট (`morale-message.ts` টেমপ্লেট), UI components | মাঝারি | আপনার মূল স্বপ্ন — staff প্রশ্ন, আপনি OK → Haiku বোঝায় |
| **৪** | Escalation (Haiku→Sonnet আপনি ডাকলে) + "কাজ কতদূর?" টাইমার + "Sonnet-কে ডাকুন" বাটন | `opus-gate` প্যাটার্ন, worker scheduler | মাঝারি | pause/resume চক্র সম্পূর্ণ |

**সবচেয়ে নিরাপদ ও দ্রুত লাভ: ধাপ ১।**

---

## ৭. সৎ কথা / সতর্কতা

- ⚠️ **Staff login = নতুন নিরাপত্তা-দরজা।** staff যেন **শুধু নিজের task** দেখে — `/agent` না, কোনো tool না, আপনার data না। role-gate খুব সাবধানে।
- ⚠️ **Worker-এ আলাদা hardcoded Sonnet** (`batch-claude.mjs`, `weekly-strategic-batch.mjs`) — Next.js আর worker **দুই জায়গাতেই** বদলাতে হবে, নইলে অর্ধেক কাজ Sonnet-এই থাকবে।
- ⚠️ **Haiku দুর্বল model** — সহজ বাংলা বোঝানোয় ভালো চলবে আশা করি, কিন্তু **আগে মেপে** quality নিশ্চিত হতে হবে। ভুল করলে Sonnet-escalation (ধাপ ৪) জাল হিসেবে থাকবে।
- ⚠️ আপনার **মূল ভারী chat-পথে হাত দেব না** — সব আলাদা, additive।

---

## ৮. প্রতিটা ধাপে নিরাপত্তার নিয়ম
1. একটা একটা ধাপ — কখনো সব একসাথে না।
2. প্রতিটা শেষে: `typecheck` + `build` + (থাকলে) `test` পাস।
3. সরাসরি production-এ **কখনো না** — branch → Vercel preview → আপনি টেস্ট → তারপর merge।
4. পছন্দ না হলে এক কমিট revert।

---

## ৯. সুপারিশকৃত ক্রম
**(আগে) cost-কমানো শেষ → ধাপ ১ (Haiku রুটিন) → ২ (staff read-only পেজ) → ৩ (messenger UI + Q&A) → ৪ (escalation + টাইমার)।**

> পরের ধাপ: cost-কমানোর কাজ শেষ হলে আপনি "অফিস ধাপ ১ শুরু করো" বললে শুধু সেটুকু ধরব, preview দেব, আপনি দেখবেন।
