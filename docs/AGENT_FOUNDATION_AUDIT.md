# Agent Foundation Audit — 2026-08-02

মালিকের নির্দেশে (২০২৬-০৮-০২): **আগে audit, তারপর plan, তারপরে implementation।**
প্রতিটি finding-এর সাথে code path / বাস্তব প্রমাণ আছে। অনুমান-ভিত্তিক কিছু নেই;
যেখানে প্রমাণ অসম্পূর্ণ, সেখানে স্পষ্ট করে "unverified" লেখা আছে।

---

## A. Current Architecture Summary (যেভাবে আজ কাজ করে)

**Chat turn pipeline (web/app):**
`/api/assistant/chat` → **প্রতি message-এ** head model নির্বাচন
(`src/agent/lib/models/head-router.ts`) → agent tool-loop → reply। App UI reply
পায় polling-এ।

**Head নির্বাচন (Auto mode):** প্রতিটি message আলাদাভাবে triage হয়:
- routine/light → **cheap head (DeepSeek V4 Flash)** নিজেই পুরো agent loop চালায়
  (`head-router.ts:8`, `cheapHeadDecision()` line ~485)
- heavy/sensitive → **GPT-5.6 Luna** (`HEAVY_HEAD_MODEL_ID`)
- আংশিক thread-affinity শুধু কিছু cheap flow-এ আছে (line ~329: "follow-ups
  inherit the thread's current cheap head") — সাধারণ task-লক **নেই**।

**Mac control:** server tool (`mac-tools.ts`, `mac-ui-tools.ts`) →
`mac_agent_commands` টেবিলে row → daemon ১–২ সেকেন্ড অন্তর poll
(`mac-agent/agent.mjs`) → AX helper (Swift, `ui-driver.mjs`-এ embedded) → ফলাফল
result route হয়ে ফেরত।

**Approval flow:** card (`agent_pending_actions`) → owner tap →
`actions/[id]/approve/route.ts` → (১) তাৎক্ষণিক progress note ("⏳ অনুমোদন
পেলাম…", `beginApprovalProgress`, line ~3226) + command enqueue → (২)
`enqueueApprovalContinuation` (line ~3270) → **BullMQ `agent-turn` queue → VPS
worker** (`worker/src/index.mjs:1553`) → continuation টার্ন **পুরো chat route
দিয়ে আবার চলে** (full context + model + tool loop)।

**App driving (L8):** allowlist ২টা app; server-side classifier
(`ui-policy.ts`) + daemon twin (`ui-policy.mjs`); element-স্তরে verify আছে
(exact-label match, `--expect-focused`, `typed_not_landed`, `field_not_empty`,
window diff)। **Task/screen-স্তরের state machine নেই।**

---

## B. Root Cause Analysis (issue ধরে ধরে)

### ইস্যু ১ + ৬ — নতুন ChatGPT session তৈরি না করা / current session পড়তে না পারা

Root cause গুলো stack করা — একটার নয়, চারটার যোগফল:

1. **Session identity বলে কোনো ধারণা system-এ নেই।**
   `ui-driver.mjs`-এর `hintsFor()` শুধু `{windowTitle, composerDesc, manual}`
   জানে। Conversation title, active-chat id, "এটা পুরোনো না নতুন chat" — কোনো
   field কোথাও নেই: tool params-এ নেই (`mac-ui-tools.ts` `params`), command
   payload-এ নেই, task state-এ নেই (task state object-ই নেই — দেখুন D)।
2. **"New chat" বলে কোনো semantic action নেই।** Head-কে tree থেকে "New chat"
   বোতাম নিজে খুঁজে click plan করতে হয়। Helper-এ verb আছে ৭টা (`info, tree,
   bounds, focused, click, type, key, scroll, convo`) — `new_chat` নেই।
3. **Action-এর পরে task-স্তরের verify নেই।** Element-স্তরে verify শক্ত (উপরে A),
   কিন্তু "এখন কি সত্যিই নতুন খালি conversation খোলা?" — এই postcondition কেউ
   চেক করে না। তাই ভুল session-এ লেখা আটকানোর কোনো __deterministic__ গার্ড নেই।
4. **Correction plan-এ ঢোকে না, শুধু transcript-এ থাকে।** Plan/goal-এর কোনো
   durable object নেই যেটাতে "current session না, নতুন session" ঢুকবে এবং পরের
   প্রতিটি action ওটার against verify হবে। তার উপর পরের message ভিন্ন model-এ
   যেতে পারে (ইস্যু ২) — আচরণ reset।

**পড়তে কি আসলেই পারে না?** — আংশিক পারে: mirror-এর `convo` verb visible
messages পড়ে (`settleNewMessages` proven live), tree-তে conversation title-ও
থাকে। অর্থাৎ **capability আছে, কিন্তু head-এর task state-এ wired নেই** — তাই
সে "পড়তে পারে না"-র মতোই আচরণ করে।

আমার নিজের checklist-run-এও একই শ্রেণির প্রমাণ: head প্রথমে ভুল tool
(`mac_desk_control`) নিয়েছিল, আর test 9-এ মিথ্যা দাবি করেছিল ("Desktop-এ সেভ
হয়েছে") — উভয়ই "action-পরে verify নেই + model-স্মৃতি transcript-নির্ভর"।

### ইস্যু ২ — একই কাজের মাঝখানে model বদল

**Confirmed, এবং এটা bug নয় — বর্তমান DESIGN-ই এমন:** routing হয়
**message-level** (`head-router.ts` প্রতি turn-এ triage)। আপনার screenshot-এই
প্রমাণ: একই conversation-এ পরপর turn-এ "ALMA · DeepSeek V4 Flash" এবং
"ALMA · GPT-5.6 Luna" ব্যাজ।

- Task-level model lock: **নেই** (আংশিক affinity শুধু বিশেষ cheap flow-এ)।
- Model change-এ state handoff: **transcript-ই একমাত্র handoff** — plan,
  চলমান tool-চিন্তা, correction-এর গুরুত্ব transfer হয় না।
- Router decision trace: decision-এ `via` string আছে (code-এ), কিন্তু owner-কে
  দেখানো হয় না।
- খরচ-চালিত trigger: হ্যাঁ — triage-এর উদ্দেশ্যই সস্তা turn সস্তা model-এ পাঠানো।

ফলাফল-চেইন আপনি যা লিখেছেন হুবহু তাই: এক model plan করে, পরের model নতুন করে
ভাবে, স্বর বদলায়, correction-এর ওজন হারায়।

### ইস্যু ৩ — Approval-এর পর ১–১.৫ মিনিট delay

পথটা মেপে দেখা root cause তিনটা:

1. **Resume মানে checkpoint-resume নয় — সম্পূর্ণ নতুন agent turn।**
   `enqueueApprovalContinuation` → BullMQ → VPS worker → **পুরো chat route
   আবার**: সম্পূর্ণ history দিয়ে prompt rebuild + model inference + tool loop।
   এইটাই সময়ের সিংহভাগ (Luna-তে লম্বা history মানে ৩০–৬০+ সেকেন্ড শুধু টার্নেই)।
2. **Queue hop:** Vercel → Redis (Upstash) → VPS worker pickup। worker
   `agent-turn` অন্য queue-র (image/video/cs) সাথে একই process-এ
   (`worker/src/index.mjs`) — busy থাকলে অপেক্ষা। (ঠিক কত দেরি হচ্ছে — trace
   করা হয়নি এখনো; log-এ timestamp আছে, test plan-এ ধরা হবে। **unverified
   অংশ শুধু এই ভাগটার ভাগফল।**)
3. **UI-তে অগ্রগতি polling-নির্ভর** — তাৎক্ষণিক note টা যায় (ওটা কাজ করে), কিন্তু
   এর পরের ৬০+ সেকেন্ড app-এ নীরবতা, কারণ continuation টার্নের streaming
   এই surface-এ নেই।

উল্লেখ্য: Mac daemon-এর ১–২ সেকেন্ড poll delay-র উৎস **নয়** (মাপা: approve →
delivered ৩ সেকেন্ড, আজকের test 6)।

### ইস্যু ৪ — Human-level app operation

যা আছে / যা নেই — সৎ তালিকা:

| স্তর | অবস্থা |
|---|---|
| Element observe (AX tree, labels) | ✅ আছে, live-proven |
| Element act-verify (exact label, focus-bind, typed_not_landed, diff) | ✅ আছে |
| Screen/state observe ("কোন screen, কোন session") | ❌ representation নেই |
| Task-স্তরের observe→plan→act→verify loop | ❌ নেই — model-এর সদিচ্ছা-নির্ভর |
| Vision in the loop (screenshot model-এর চোখে) | ❌ screenshot এখন শুধু OWNER-কে দেখানো হয় (imageUrl); head ছবিটা দেখে না |
| Action history task-এ বাঁধা | ❌ transcript-এ ছড়ানো |
| Wrong-screen guard | ❌ (কেবল app-allowlist + focus-bind আছে) |
| Intelligent retry / correction-priority | ❌ model-নির্ভর, deterministic নয় |

---

## C. Confirmed Bugs (code/flow-প্রমাণিত)

1. Message-level model routing, task lock নেই — `head-router.ts` (design)।
2. Approval continuation = full turn re-run via VPS queue — `approve/route.ts`
   `enqueueApprovalContinuation` + `worker/src/index.mjs:1553`।
3. Session identity কোনো স্তরে সংরক্ষিত হয় না — `hintsFor()`/tool params।
4. `new_chat` semantic verb নেই — helper verb list।
5. Screenshot head-এর vision-এ ফেরে না — `ui_screenshot` → imageUrl only
   (deferred P2, #679-এ নথিভুক্ত)।
6. Head-এর মিথ্যা সাফল্য-বর্ণনা সম্ভব (test 9-এ "Desktop-এ সেভ" — হয়নি) —
   interceptor result-এ `redirected` থাকা সত্ত্বেও head বানিয়ে বলেছে; claim-verifier
   এই পথ cover করে না।
7. Mirror (live text feed) daemon-এ আছে কিন্তু head tool হিসেবে wired নয়
   (আজকের test 14) — "tool আছে অথচ অদৃশ্য" শ্রেণির পুনরাবৃত্তি।

## D. Architecture Gaps (bug নয় — foundation)

1. **AgentTask object নেই।** Goal, plan-step, target app+session, action log,
   corrections, pending approvals — সব transcript-এ implicit। এক জায়গার durable
   source of truth নেই বলে model বদল/resume/correction সবখানে ভাঙে।
2. **Checkpoint নেই** — resume = re-run।
3. **Session identity নেই** (উপরে)।
4. **Vision loop নেই** (উপরে)।
5. **Router decision log owner-invisible।**
6. **App adapter স্তর embryo-only** — `hintsFor()` = ২টা field; per-app semantic
   action map (new_chat, open_project, switch_session) নেই।

---

## E–I. Recommended Target Architecture

### E. মূল কাঠামো — "Durable Task Runtime"

নতুন Prisma মডেল `AgentTask`:

```
AgentTask {
  id, conversationId, goal (owner-ভাষায়), status,
  pinnedHeadModelId,            // F দেখুন
  plan: Json (steps + done/pending),
  target: Json { app, windowTitle, sessionTitle, sessionFirstText, sessionType },
  actionLog: Json[] (প্রতি act: pre-state, action, post-state, verdict),
  corrections: Json[] (owner-এর প্রতিটি সংশোধন, timestamp),
  checkpoint: Json (tool-loop অবস্থান)
}
```

প্রতি টার্নে **context compiler** এই object থেকে head-এর prompt-এর মাথায় একটি
কম্প্যাক্ট "task card" বসায় (goal + সর্বশেষ correction সবার উপরে) — model যেই
হোক, একই সত্য পায়। বিদ্যমান **LangGraph adoption** (LG-0..8 shipped, gates OFF)
এটার স্বাভাবিক বাহন — নতুন framework লাগবে না।

### F. Model Strategy — task-level pinning

- Task শুরুতে একবার triage → `pinnedHeadModelId` সেট → **task শেষ না হওয়া
  পর্যন্ত head বদলাবে না**। Sub-agent/specialist আগের মতোই tier-router দিয়ে।
- বদল শুধু ৩ কারণে: provider outage fallback, owner-এর explicit নির্দেশ, task
  সমাপ্তি। প্রতিটি বদলে: কারণ log + task card handoff (E-র object-টাই handoff)।
- Approval continuation **pinned model-ই ব্যবহার করবে** — re-triage নয়।
- Router decision log: প্রতি টার্নের `via` + কারণ costs-line-এ owner-দৃশ্যমান।

### G. Session Management — Session Guard

Owner-এর sketch-টাই সঠিক নকশা; বসবে **daemon-এ** (enforcement twin):

1. প্রতিটি `ui_*` act command বহন করবে `expect: { app, windowTitle,
   sessionTitle?, sessionFirstText?, sessionType? }` (server task.target থেকে)।
2. Helper act-এর আগে বর্তমান conversation title + first visible message resolve
   করে মেলাবে; mismatch → `session_mismatch` refuse (card আবার হবে)।
3. নতুন verb **`ui_new_chat`**: New-chat বোতাম click → verify: composer খালি +
   visible message ০ → task.target-এ নতুন session identity লিখে ফেরত।
4. প্রতিটি act-এর পরে postcondition (যেমন type → fieldValue; new_chat → empty
   convo) task.actionLog-এ verdict সহ।

### H. Approval Latency Fix

1. **Checkpoint resume:** continuation টার্ন full re-run না করে task.checkpoint
   থেকে চলবে (LangGraph state এখানেই কাজে লাগে)। Interim pragmatic ধাপ:
   continuation-এ history-window ছোট (task card + শেষ N turn) — খরচও কমবে।
2. **Fast lane:** sync ছোট continuation Vercel background function-এ সরাসরি;
   VPS queue শুধু >৩০s কাজে। + `agent-turn` queue-কে আলাদা priority।
3. **No re-triage** (F)।
4. **Streaming progress:** turn-status event app-এ push (dock pipe আছেই)।
5. Trace: approve→queue→pickup→first-token per-stage timestamp log — কোন ভাগ
   কত খাচ্ছে প্রথম সপ্তাহেই মাপা।

### I. Human-Level App Control Plan

প্রতি act-এর বাধ্যতামূলক deterministic loop (model-এর ইচ্ছার উপর নয়):

```
observe  → interactive tree + session identity + (দ্বিধায়) screenshot AS VISION
verify-pre → Session Guard match
act      → helper verb
verify-post → expected diff / postcondition → actionLog
```

- **Vision in loop:** `look_mac_app` screenshot result head-এর কাছে image হিসেবে
  যাবে (Luna/Gemini multimodal) — শুধু owner-এর চোখে নয়।
- Correction এলে task.corrections-এ append + plan invalidate → পরের act-এর আগে
  re-observe বাধ্যতামূলক। একই ভুল দ্বিতীয়বার = actionLog-এ আগের identical
  failed action থাকলে সেই action **block** (deterministic repeat-guard)।
- App adapter map: per-app semantic actions (`new_chat`, `open_session(title)`,
  `read_reply`) — ChatGPT + Claude দিয়ে শুরু।

---

## J. Implementation Phases

**P0 (এক sprint):**
1. Task-level model pinning + no-re-triage on continuation (F)
2. Approval fast-lane + per-stage latency trace (H.2, H.5)
3. `ui_new_chat` verb + Session Guard v1 (expect/verify title+firstText) (G)
4. Correction-priority: task card-এ correction সবার উপরে + repeat-guard (I)
5. Post-action task-verify: new_chat/type postcondition (G.4)

**P1:**
6. AgentTask object + context compiler (E) — LangGraph state-এ বসিয়ে
7. Checkpoint resume (H.1)
8. Vision-in-loop (I)
9. Router decision log owner-দৃশ্যমান (F)
10. Mirror head-tool wiring + test-9 wording fix (C.6, C.7)

**P2:**
11. App adapter framework + multi-app expansion
12. Crash/network/restart recovery state machine
13. Full remote desktop workflow orchestration + audit-log surface

## K. Test Plan (প্রতিটি reproduce + verify)

| Issue | Reproduce | Pass criterion |
|---|---|---|
| New session | "chatgpt e NOTUN chat khule X pathaw" | নতুন খালি chat-এ X; পুরোনো chat অপরিবর্তিত (AX title+count proof) |
| Session guard | Card approve-এর আগে হাতে অন্য chat খুলে দিন | `session_mismatch` refuse, ভুল chat-এ কিছু লেখা হয়নি |
| Model pin | একই task-এ ৫ message | সব টার্নে এক head badge; decision log-এ pin entry |
| Approval delay | approve → প্রথম দৃশ্যমান কাজ | ack <১s (আছে), resume-কাজ <১০s, per-stage trace log |
| Correction | ভুলের পর সংশোধন দিন | পরের act-এর আগে re-observe log + আগের ভুল action repeat-guard-এ block |
| Vision | অচেনা UI অবস্থা | head-এর টার্নে image attach হওয়ার log |

## L. Proof Checklist (প্রতিটি fix-এর জন্য)

- Live Chrome screenshot (owner-এর ভাষার এক-লাইন নির্দেশে)
- AX/DB read-back (আজকের মতো: fieldValue, convo title, command rows)
- Per-stage latency log excerpt (approval path)
- Router decision log excerpt (model pin)
- Negative test proof (guard-গুলো ইচ্ছা করে ভেঙে দেখানো)

---

## M. Session Handoff — ২০২৬-০৮-০২ পর্যন্ত সম্পূর্ণ অবস্থা (নতুন session এখান থেকে ধরবে)

**Main-এ merged ও LIVE (এই session-এর সব কাজ):**
- L8 পুরো program: #676, #677, #679, #680, #681–#683, #684, #685, #686, #687, #688
- Daemon (`~/.alma-mac-agent`) সর্বশেষ main থেকে deploy + restart ✅; VPS worker
  (`agent-turn.mjs` Telegram photo) deploy + pm2 restart ✅; KV
  `mac_ui_driving_enabled=true` ✅; capability report DB-তে proven ✅
- এই audit doc নিজে (#689) — merge হলে আর কিছু unmerged থাকবে না

**Owner checklist self-run ফলাফল (সব আমার নিজের চালানো, live proof সহ):**
1✅ 2✅ 3✅ 4/5✅ 6✅ (replace-flow পুরো chain, AX proof `"test 123"`) 7✅ 8✅
9✅ (interceptor absorb) 10-12✅ (sim) · **13⏳ Telegram photo — শুধু owner-এর
এক message বাকি** · **14⚠️ mirror head-tool wired নয়** (daemon-এ proven)

**জানা ছোট বাকি (এই doc-এর plan-এই আছে):**
- Mirror head-tool wiring + test-9 মিথ্যা-বর্ণনা fix → P1 item 10
- ChatGPT composer-এ harmless `"test 123"` বসে আছে (replace-type demo-র)
- iOS: dock build sim-proven; **TestFlight পাঠানো হয়নি** — owner-এর explicit
  "go" লাগবে (নিয়ম: proof → go → preflight script → build-bump commit → Archive)
- Telegram multi-photo ordering (cosmetic, deferred #687)

**নতুন session-এর প্রথম কাজ:** এই doc পড়া → memory
`project_l8_head_protocol` + `project_agent_foundation_audit` পড়া → owner-কে
জিজ্ঞেস: **"P0 শুরু করব?"** (P0 তালিকা section J)। Implementation-এর আগে owner-এর
অনুমোদন লাগবে — এই নিয়ম বহাল।

**কাজের ধরন যা owner প্রত্যাশা করে (এই session-এ প্রতিষ্ঠিত):**
- প্রতিটি claim-এর আগে নিজে live-verify (Chrome/AX/DB read-back), তারপর বলা
- Codex review: P0/P1 fix-then-merge, fresh P2/P3 defer-log; loop terminate
  করতে ladder ঘোষণা করা
- Deploy recipe: daemon = cp 5×.mjs + `launchctl kickstart`; worker = per-file
  checkout + pm2; KV = Supabase REST (pooler unreachable)
- Owner-কে Bangla, সৎ PASS/FAIL টেবিল, ভুল হলে সরাসরি স্বীকার
