# Creative Studio — Golden Evaluation (CS10)

Measurable, reproducible engine comparison for ALMA-র try-on engines:
Direct FASHN · Fal FASHN v1.6 · IDM-VTON (fal-ai/cat-vton, research-only)।

## কীভাবে কাজ করে

1. **গোল্ডেন কেস** = একটি পরিষ্কার product ছবি + একটি saved model role + garment type
   + fixed seed (fal ইঞ্জিনে reproducible)। kv `cs_golden_set`-এ থাকে।
2. **টেস্ট চালাও** (Settings → 🏅 গোল্ডেন টেস্ট, বা `POST /api/assistant/creative-studio/evaluations {action:'run'}`):
   worker প্রতিটি case × engine-এ **একটি** raw generation চালায়, একই QC rubric-এ
   (single_tryon surface thresholds) score করে।
3. প্রতিটি attempt kv-তে persist হয় (`cs_eval:<runId>:<case>:<engine>`) — worker restart
   হলে resume, শেষ হওয়া paid attempt আবার চলে না।
4. রিপোর্ট: `cs_eval_report:<runId>` — engine-প্রতি pass rate, গড় core axes,
   p50/p95 latency, মোট খরচ, weakest-axis histogram।
5. **তুলনা deterministic** (`model-comparison.ts`): fixed formula —
   `passRate×0.5 + গড় overall×8 + owner-feedback×4 − খরচ×40 − latency − error`।
   স্পষ্ট margin (≥5) + pass rate ≥60% না হলে সুপারিশ = "no change"।
   কোনো LLM routing policy লেখে না; Auto default বদলানো owner-এর সিদ্ধান্ত (CS12 canary)।

## Surface thresholds (production)

| Surface | overall | core (গার্মেন্ট/মুখ/দেহ) | অন্য axes |
|---|---|---|---|
| single_tryon | ≥4 | ≥4 | ≥3 |
| family | ≥4 | ≥4 (+ member count 100%) | ≥3 |
| precision_edit | ≥4 | ≥5 (pixels protected by construction) | ≥3 |
| poster | ≥4 | ≥3 | ≥4 (text/brand কড়া) |
| video_cover | ≥4 | ≥4 | ≥3 |

## Golden set গড়ার নিয়ম (roadmap §6 target)

- ৮ plain/solid পাঞ্জাবি · ৮ embroidery-heavy · ৪ koti/layered · ৪ pajama/contrast
  · ৬ family collection — **পরিষ্কার, garment-only ছবি** (marketing composite নয়)।
- case যোগ: `POST evaluations {action:'add_case', productImagePath, modelRole, garmentType}`।
- ছোট set-এও চালানো যায়; সংখ্যা বাড়লে রিপোর্ট শক্ত হয়।

## খরচ

প্রতি case: Direct FASHN ≈ $0.225 + Fal FASHN v1.6 $0.075 + IDM ≈ $0.05 ⇒ ≈ $0.35।
Run-এর আগে API estimate ফেরত দেয়; report-এ আসল logged খরচ থাকে।
