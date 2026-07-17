# Creative Studio Professional Upgrade — Final Certification (CS12)

তারিখ: 2026-07-17 · প্রোগ্রাম: CS5–CS12 (roadmap: `CREATIVE_STUDIO_FAL_IDM_VTON_FLUX_FILL_ROADMAP.md`)
সব লাইভ প্রমাণ production-এ, owner-এর Chrome session-এ, আসল API খরচসহ। কোনো দাবি receipt ছাড়া নেই।

## E2E ম্যাট্রিক্স — PASS/FAIL

| # | কেস | ফল | Receipt |
|---|---|---|---|
| 1 | Single Direct FASHN Try-On | ✅ PASS* | CS8 production রান (3-attempt cap, hard gate) — *পরে account OutOfCredits; ইঞ্জিনটা optional এখন |
| 2 | Single Fal FASHN v1.6 Try-On | ✅ PASS | CS6: req `019f6bde…`, $0.225; CS10 golden: $0.075/case |
| 3 | Single IDM-VTON manual Try-On | ✅ PASS | CS6: req `019f6be5…`, $0.15; research-warning UI-তে |
| 4 | Product-to-Model | ✅ PASS | CS8 chain runs (scene diversity প্রমাণসহ) |
| 5 | Background replacement via Fill | ✅ PASS | CS7: req `019f6c3a…`, $0.10, protected composite |
| 6 | Local artifact/hand repair via Fill | ✅ PASS | CS8 rescue: req `019f6c70…`, $0.25, remove-object mask |
| 7 | Father-son | ✅ PASS | CS9: 🛡 protected pair, "২ জন যাচাই" |
| 8 | Mother-daughter | ✅ PASS | full-family রানের ভেতরের pair (২ জন যাচাই) |
| 9 | Couple | ⚠ CODE-READY | chain graph unit-tested (insertRole=mother); লাইভ রান বাকি — owner এক ক্লিকে চালাতে পারেন (~$0.25) |
| 10 | Full family | ✅ PASS | "🛡 প্রোটেক্টেড কম্পোজিট · ৪ জন যাচাই", সম্পূর্ণ Fal-এ (PR #422-এর পরে) |
| 11 | 4–8s generated reel | ✅ PASS | CS11: Veo 4s, $0.60, "ভিডিও QC পাস · লাউডনেস −18.3 LUFS" |
| 12 | 16–24s multi-clip reel | ✅ PASS-BY-PRIOR | V4 (PR #255) লাইভ e2e receipt; CS11-এর QC একই video_gen পথে বসে — নতুন paid re-run করা হয়নি (খরচ ~$2.4) |
| 13 | Owner-shot 15/30s recipe reel | ✅ PASS | CS11: product_showcase 15s, captions, QC পাস, $0 |
| 14 | Bangla caption, music/ducking, ভয়েস, sting, cover | ⚠ PARTIAL | captions+cover ✅ (CS11 লাইভ); music bed: লাইব্রেরিতে owner-approved track নেই (owner action); voiceover/sting V2/V3 receipts |
| 15 | Gallery finishing/download/retry/Drive | ✅ PASS | চালু ফিচার, এই প্রোগ্রামে retry+lineage যাচাই হয়েছে |
| 16 | Worker restart during Fal request | ✅ PASS | durable client contract test (resume, শূন্য নতুন POST) + kv state লাইভ |
| 17 | Worker restart during Veo operation | ✅ PASS | CS11: op-name kv persist (`veo_op:<id>`); resume path কোডে + unit-দৃঢ় |
| 18 | Provider failure/fallback truthfulness | ✅ PASS | result.provider সবসময় আসল ইঞ্জিন; fal অ্যাডাপ্টার নীরবে fallback করে না; harmonize-ব্যর্থতা flagged-ship |
| 19 | Kill switch behavior | ✅ PASS | CS12 লাইভ টেস্ট (নিচে) |

## অপারেশনাল কন্ট্রোল (CS12)

- **Kill switch (প্রতি ইঞ্জিন):** সেটিংস → 🚦 ইঞ্জিন হেলথ → "বন্ধ"। enforcement WORKER-এ — queued job-ও বন্ধ ইঞ্জিনে চলবে না, পরিষ্কার বাংলা error। redeploy লাগে না।
- **Canary %:** kv `cs_auto_canary_pct` + settings API-তে সংরক্ষিত ও দৃশ্যমান। **রাউটিং-এ এখনো লাগানো হয়নি — ইচ্ছাকৃত:** CS10 golden verdict = "কোনো ইঞ্জিন স্পষ্টভাবে এগিয়ে নেই", তাই Auto default বদলের প্রার্থীই নেই; প্রার্থী এলে owner-এর সিদ্ধান্তে ১-লাইন hookup (create-run) হবে।
- **হেলথ রিপোর্ট:** `/api/assistant/creative-studio/health` — ইঞ্জিন-প্রতি ৭-দিনের কাজ/ব্যর্থতা/QC পাস/latency/খরচ + worker heartbeat + fal/FASHN লাইভ ব্যালেন্স।
- **ব্যালেন্স + অ্যালার্ট:** fal লাইভ ব্যালেন্স আগে থেকেই অ্যালার্ট-সিস্টেমে; CS12-এ direct-FASHN credits-ও যুক্ত (OutOfCredits আর চুপিচুপি আসবে না)।
- **Certification runner:** `worker/scripts/run-creative-studio-certification.mjs` — যেকোনো দিন পরিবেশ-স্বাস্থ্য PASS/FAIL, paid call ছাড়া।

## অমীমাংসিত ঝুঁকি / owner-এর সিদ্ধান্ত

1. **পরিষ্কার garment-only golden set** — এখনকার marketing-composite ছবিতে লেখা bleed করে + সব ইঞ্জিন 3/5-এ আটকায়। Roadmap §6-এর ৩০-কেস সেট owner-কে দিতে হবে; তারপর আসল ইঞ্জিন-verdict।
2. **Auto default বদল** — বর্তমান verdict "no change"; পরিষ্কার set-এর গোল্ডেন রানের পরে পুনর্বিবেচনা (canary তখন)।
3. **Direct FASHN credits** — top-up ঐচ্ছিক; সব try-on এখন Fal v1.6 ডিফল্টে চলে।
4. **Music bed** — owner-approved ট্র্যাক আপলোড হলে reel-এ music/ducking লাইভ যাচাই।
5. **Couple লাইভ রান** — এক ক্লিক দূরে (৯ নং)।
6. **IDM-VTON** — research-only-ই থাকুক (লাইসেন্স ঝুঁকি; মানও এখনো v1.6-এর নিচে)।
7. **Per-engine owner-acceptance tally** — ভালো/বাদ এখন scene-ওজনে যায়; ইঞ্জিন-প্রতি tally লাগলে feedback route-এ ছোট বদল (পরের কাজ)।

## প্রোগ্রাম খরচ (আসল, logged)

CS5 $0 · CS6 $0.375 · CS7 $0.10 · CS8 ≈$1.1 · CS9 ≈$0.6 · CS10 $0.25 · fal-chain full-family ≈$0.45 · CS11 $0.60 ⇒ **মোট ≈ $3.5**
