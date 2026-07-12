# ALMA Agent — Next-Level Roadmap (plan.md)

> **উদ্দেশ্য (owner, 2026-07-13):** agent যেন Claude-এর নিজের Chrome-টুলকিটের সমান ক্ষমতায় সব ওয়েব-কাজ করতে পারে, কোথাও আটকে না যায়, আর best result দেয়।
> **ব্যবহার:** প্রতি নতুন session-এ এই ফাইল খুলে **একটা phase** ধরবেন — implement → verify checklist পাস → পরের phase। এক session-এ একটাই phase (CLAUDE.md-র নিয়ম মেনে)।
> **অবস্থা ট্র্যাকিং:** প্রতিটা phase-এর `Status:` লাইনটা আপডেট করে commit করবেন (TODO → DONE + তারিখ)।

---

## এখন পর্যন্ত যা হয়ে গেছে (context — নতুন session-এর জন্য)

2026-07-12/13-এ PR #295–#321 (extension v0.7.1→v0.9.5) দিয়ে বড় ভিত তৈরি:

- **Perception/act:** viewport-first read_dom + stable `ref`, React-safe typing, atomic `pick_option` (self-healing + not_a_dropdown fast-fail), iframe/hover/tabs, `find:` element filter, CDP screenshots (background tab)
- **Reliability:** per-script (15s) + per-command (35s) hard timeout — এক ধাপ পুরো companion আর জ্যাম করতে পারে না; server-side transient auto-retry; oscillation guard (একই ধাপ ৩ বার → change-approach nudge)
- **Long-task:** 280s serverless deadline salvage (never-empty reply, 📌 progress footer replayed history-তে, auto-checkpoint), client auto-continue (max 8), resume-not-restart, ask-card answers framed
- **Adapters:** abort signal provider fetch পর্যন্ত যায় (hung turn শেষ); empty-head-turn → cheap-head fallback
- **Files:** `upload_file` action — agent নিজেই ছবি/ভিডিও/PDF file-input-এ বসায় (multiple accumulate)
- **Safety:** final-submit code-ban (compose-mode exempt), site trust tiers/lockdown, webmail drafts-only
- **Knowledge:** agent_playbook rules (ads recipes: 322b487b, 971175d2), checkpoint/resume infra, learned recipes

**জানা দুর্বলতা এখনো:** লম্বা কাজ ৫-মিনিট টুকরোয় চলে (auto-continue জোড়া দেয়); DOM-only targeting (vision-click নেই); পেজের console/network error agent দেখে না; drag-drop নেই; দুর্বল মডেল আটকালে নিজে escalate করে না।

---

## Phase 1 — VPS Worker-এ uncapped browser turns ⭐ (সবচেয়ে বড় জয়)
**Status: TODO**

**কী/কেন:** এখন প্রতিটা টার্ন Vercel-এর 280s-এ কাটা পড়ে; auto-continue টুকরো জোড়া দেয় কিন্তু প্রতি টুকরোয় পুরো context আবার পাঠাতে হয় (টোকেন খরচ) আর জোড়ার ফাঁকে ভুলের সুযোগ। VPS worker-এ (pm2: `alma-agent-worker`, Redis queue আছে) টার্ন চালালে **এক টানে ৩০+ মিনিট** চলবে — deadline-ই নেই।

**যা আছে already:** `/api/assistant/turn` enqueue route + `/api/assistant/turn/<id>/stream` + client-এর `runWorkerFallback` (AgentApp.tsx ~line 1160) — অর্থাৎ pipeline অর্ধেক তৈরি।

**Steps:**
1. Worker-এ `runOwnerTurn` চালানোর job type আছে কিনা দেখো (`worker/src/`); না থাকলে turn-runner job যোগ করো — `deadlineAt: null` দিয়ে
2. Route decision: browser-heavy টার্ন (live_browser tool selected + কাজ চলমান checkpoint) হলে সরাসরি worker-এ enqueue, নাহলে আগের মতো serverless
3. Client: worker টার্নের stream tail করা (`runWorkerFallback`-এর path পুনর্ব্যবহার), auto-continue তখন লাগবেই না
4. Worker-এ AGENT env secrets sync নিশ্চিত করো (worker-env-sync route আছে)

**Verify:** একটা লম্বা browser কাজ দাও → SQL-এ দেখো এক টার্ন >600s চলছে, মাঝে কোনো auto-continue user-message নেই, শেষে সম্পূর্ণ reply। Vercel logs-এ ওই টার্নের কোনো invocation নেই।

**Risk:** worker down হলে fallback serverless path অক্ষত রাখতে হবে (feature-flag: `BROWSER_TURNS_ON_WORKER=on/off` kv)।

---

## Phase 2 — Vision-click: স্ক্রিনশট দেখে coordinate-এ ক্লিক ⭐
**Status: TODO**

**কী/কেন:** Claude-এর নিজের টুলে screenshot-এ যা দেখা যায় সেখানেই ক্লিক করা যায়। agent এখন শুধু DOM (text/ref/selector) দিয়ে টার্গেট করে — canvas-UI, অদ্ভুত widget, বা DOM-এ নাম-না-থাকা জিনিসে আটকে যায়। Gemini/Qwen head-গুলো vision পায়ই — শুধু ক্লিকের রাস্তা নেই।

**Steps:**
1. Extension: `click_at {x,y}` action — chrome.debugger already attached (screenshots-এ ব্যবহার হয়); `Input.dispatchMouseEvent` (pressed+released) পাঠাও; device-pixel-ratio scale মেলাও (screenshot px ↔ CSS px)
2. `double_click`, `right_click` variants একই পথে
3. Server: actions enum + description: "স্ক্রিনশটে element দেখছ কিন্তু DOM-এ পাচ্ছ না? স্ক্রিনশটের x,y দিয়ে click_at"
4. Final-submit guard: click_at-এ label জানা যায় না — তাই ক্লিকের আগে ওই বিন্দুতে `document.elementFromPoint` চালিয়ে resolved label-টা একই finalSubmitRe দিয়ে চেক করো (extension-side)

**Verify:** এমন পেজে টেস্ট যেখানে DOM-click ব্যর্থ (যেমন FB-র কিছু icon-only বাটন); guard টেস্ট: Publish বাটনের coordinate-এ click_at → blocked।

---

## Phase 3 — Debugging senses: console + network পড়া
**Status: TODO**

**কী/কেন:** পেজ ভাঙলে/form submit চুপচাপ fail করলে agent এখন অন্ধ। Claude নিজে console error আর network call পড়ে root cause বের করে।

**Steps:**
1. Extension: debugger attach থাকা অবস্থায় `Runtime.consoleAPICalled` + `Log.entryAdded` + `Network.responseReceived` listener → প্রতি ট্যাবে শেষ ~50 entry-র ring buffer (memory-only)
2. Actions: `read_console {onlyErrors?}` / `read_network {urlFilter?}` — read-only, lockdown-এও allowed
3. Server: tool description — "কিছু কাজ করছে না মনে হলে read_console দেখো — error-টাই বলে দেবে কেন"

**Verify:** JS-error-ওয়ালা টেস্ট পেজে agent-কে বলো "পেজটা কাজ করছে না কেন" → সে console পড়ে সঠিক error জানায়।

---

## Phase 4 — Escalation ladder: আটকালে নিজে বড় মডেল ডাকা
**Status: TODO**

**কী/কেন:** DeepSeek/Flash সস্তা কিন্তু জটিল UI-তে দিশা হারায়। এখন আটকে গেলে মানুষ (আপনি) টের পাওয়া পর্যন্ত ঘুরতে থাকে। নিয়ম: **সস্তা মডেল চেষ্টা করবে, ব্যর্থতা জমলে সিস্টেম নিজেই এক ধাপ উপরের মডেলে টার্নটা দেবে।**

**Steps:**
1. Signal গোনা (turn-লেভেলে আছেই): oscillation warnings, consecutive tool-failures, auto-continue count
2. Rule (run-owner-turn.ts): একই কাজে ≥2 auto-continue + ≥3 failed act হলে পরের continuation টার্নে head override → `HEAVY_HEAD_MODEL_ID` (Gemini 3.1 Pro), reply-তে জানাও "কঠিন লাগছিল, বড় মাথা ডেকেছি" — টার্ন শেষে আবার আগের মডেলে ফেরত
3. Owner-tunable: `escalation_ladder` kv (off/on + threshold); দৈনিক cap যেন খরচ না বাড়ে (opus-gate.ts-এর pattern)

**Verify:** কঠিন টাস্ক Flash-এ দাও, ইচ্ছা করে ব্যর্থ হতে দাও → ৩য় continuation-এ model_info event-এ Gemini 3.1 Pro দেখাবে, কাজ শেষ হবে।

---

## Phase 5 — Gated JS execution (`run_page_js`) — owner-approval সহ
**Status: TODO (owner-এর সিদ্ধান্তের পর)**

**ভালো-মন্দ আলাদা করে chat-এ দেওয়া হয়েছে; সিদ্ধান্ত: প্রতি-রান approval card সহ চালু করা যায়।**

**Design (নিরাপত্তা স্তরগুলো সব একসাথে):**
1. Approval-card flow: agent JS চালাতে চাইলে কোডটা **confirm card-এ** আসবে (existing pendingAction infra) — আপনি Approve চাপলে তবেই চলবে; approve-না-হলে টার্ন এগোবে অন্যভাবে
2. Trusted-tier-only: শুধু আপনার trust-marked ডোমেইনে; lockdown/unknown-এ কখনোই না
3. Static screen (হার্ড-ব্লক regex): `document.cookie`, `localStorage`, `sessionStorage`, `fetch(`/`XMLHttpRequest` (বহিঃ-অরিজিন), `.submit()`, `password` — ধরা পড়লে block + কারণ
4. Result serialization cap (10KB), timeout 5s, chat-এ চালানো কোড + ফলাফল সবসময় দৃশ্যমান (audit)
5. প্রথম সংস্করণ **read-only উদ্দেশ্যে** বিজ্ঞাপিত (computed style/state পড়া, hidden value বের করা) — টুল description-এ লেখা থাকবে "DOM বদলাতে আগে সাধারণ act টুল, JS একদম শেষ অস্ত্র"

**Verify:** benign JS → card → approve → ফল; blocked pattern → refuse; lockdown site → refuse; card reject → agent বিকল্প পথে যায়।

---

## Phase 6 — Interaction completeness (ছোট কিন্তু দরকারি)
**Status: TODO**

- `drag_and_drop` — দুই ধরন: HTML5 DnD (dragstart/drop DataTransfer) + pointer-drag (CDP mouse move ধারায়) — file-drop zone আর sortable list দুটোই কভার
- `resize_window` — chrome.windows.update; খুব চওড়া/সরু পেজে screenshot timeout ঠেকায় (1440 sweet spot)
- `zoom` screenshot — CDP captureScreenshot `clip` দিয়ে অঞ্চল-ভিত্তিক বড় করে দেখা (ছোট icon/লেখা পড়তে)
- `press` key-combo সাপোর্ট (Ctrl+A, Cmd+Enter)

**Verify:** প্রতিটা action-এর জন্য একটা করে টেস্ট পেজ; drag: jqueryui.com/droppable demo; zoom: ছোট লেখা পড়ে দেখাও।

---

## Phase 7 — Domain-quirks memory (সাইট-ভিত্তিক শেখা)
**Status: TODO**

**কী/কেন:** FB-র quirks এখন global playbook-এ; সাইট বাড়লে prompt ফুলে যাবে। ডোমেইন-স্কোপড রাখলে যেই সাইটে কাজ, শুধু সেই সাইটের শিক্ষা inject হবে।

**Steps:**
1. Table: `agent_site_quirks (domain, quirk, evidence, confidence)` — additive migration
2. live_browser_look-এর currentUrl থেকে ডোমেইন → সেই ডোমেইনের top-quirks টুল-result-এ পিগিব্যাক (`siteHints` field)
3. কাজ সফল শেষ হলে head-কে nudge: নতুন শেখা quirk save করো (save_learned_recipe-এর মতো, কিন্তু ছোট প্রতি-সাইট টিপস)

**Verify:** FB-র বিদ্যমান শিক্ষাগুলো migrate করো → Ads Manager-এ look দিলে siteHints আসে, অন্য সাইটে আসে না।

---

## Phase 8 — Task Success Gate (কাজ "শেষ" বলার আগে প্রমাণ-চেক)
**Status: TODO**

**কী/কেন:** claim-verifier টুল-ledger দেখে; কিন্তু browser কাজে "শেষ" মানে হওয়া উচিত: শেষ screenshot-এ কাঙ্ক্ষিত অবস্থা + (যেখানে প্রযোজ্য) "All edits saved"-type নিশ্চিতকরণ। skill-pack gate-এর pattern browser টাস্কেও আনো।

**Steps:**
1. Checkpoint-এ `successCriteria` field (task শুরুতে head নিজে লেখে: "Format=Carousel দেখাবে, All edits saved থাকবে")
2. Head "কাজ শেষ" দাবি করলে run-owner-turn এক অতিরিক্ত cheap-model verify pass চালায়: শেষ screenshot + criteria → pass/fail; fail হলে reply-এ সততার সংশোধন
3. পাস হলে resolve_open_task auto

**Verify:** ইচ্ছা করে অসম্পূর্ণ কাজে "done" বলাও → gate ধরবে; সম্পূর্ণ কাজে → auto-resolve + প্রমাণসহ reply।

---

## পরিমাপ (প্রতি phase-এর পর একই টেস্ট চালাও)

Benchmark task-সেট (সবগুলো vague, owner-style):
1. "ad e whatsapp number vul, thik koro" (প্রমাণিত ✅ baseline)
2. "carousel campaign ready koro, ami publish korbo" — ছবি-সহ, শূন্য হাত-ধরায়
3. "amar website er contact form kaj korche kina dekho" (console/network লাগবে — Phase 3-এর পর)
4. "competitor X er page theke last 5 post er reach note koro"

সফলতার মানদণ্ড: মানুষের poke ০টা (auto-continue ছাড়া), ভুল claim ০টা, প্রতিটা শেষে প্রমাণ-screenshot।

---

*তৈরি: 2026-07-13, Claude (Fable 5) — PR #295–#321-এর অভিজ্ঞতা + Claude-in-Chrome টুলকিট gap-analysis থেকে। প্রতিটা phase self-contained; ক্রম বদলানো যায়, তবে Phase 1-2 আগে করলে বাকি সব সহজ হয়।*
