# Creative Studio — Fal.ai Plan: Deep Audit & Final Recommendation

**Auditor:** Claude (senior architect pass over the live repo)
**Date:** 2026-07-16
**Scope:** Audit Google/Gemini's proposed 4-step Fal.ai integration plan against the ACTUAL code + the owner's own roadmap, then give a corrected, production-safe recommendation.
**Method:** read the real source — `provider-registry.ts`, worker Fal client + adapters (`cat-vton.mjs`, `fashn-v16.mjs`, `flux-fill.mjs`), `family-chain.ts`, `mask-contract.ts`, and the 863-line owner roadmap `docs/CREATIVE_STUDIO_FAL_IDM_VTON_FLUX_FILL_ROADMAP.md` (CS5–CS12).

---

## সংক্ষেপে (Executive summary — Bangla)

Boss, Google-এর প্ল্যানটা **আপনার কোডের পুরনো/ভুল ধারণার উপর দাঁড়ানো**। বাস্তবতা:

- **ধাপ ১ (FASHN v1.6 চালু + endpoint sync):** ✅ **আগেই করা হয়ে গেছে** (CS5/CS6-এ)। দুই জায়গার allowlist-ই already তিনটা endpoint নিয়ে sync করা, `fal_fashn_v16` runnable।
- **ধাপ ২ (`flux_fill_garment` দিয়ে ফ্যামিলির জামা বদল):** ❌ **ভুল** — এটা আপনার নিজের locked decision #7 আর #9 ভাঙে। FLUX Fill শুধু টেক্সট দিয়ে মাস্ক এলাকা আঁকে, সে **নির্দিষ্ট পণ্যের জামা হুবহু রাখতে পারে না**। ফ্যামিলির সঠিক পদ্ধতি (per-person VTON → protected composite) **CS9-তে already বানানো ও প্রোডাকশনে লাইভ**।
- **ধাপ ৩ (Bounding-box crop দিয়ে খরচ কমানো):** ✅ **ভালো ও নতুন আইডিয়া** — কিন্তু শুধু FLUX Fill-এর *harmonize/repair* ধাপে খাটে, জামা বসানোতে না। এটাই একমাত্র জিনিস যেটা এখনো করা হয়নি এবং করার মতো।
- **ধাপ ৪ (Masking source — SAM):** ⚠️ **আংশিক ঠিক, কিন্তু রিফ্রেম দরকার** — আপনি already একটা **ফ্রি লোকাল সেগমেন্টেশন** (`@imgly/background-removal-node`, VPS-এ) বেছে নিয়েছেন paid Fal SAM-এর বদলে (locked decision অনুযায়ী)। তাই paid SAM যোগ করার দরকার নেই।

**নিট:** Google-এর ৪টার মধ্যে ২টা already-done/ভুল, ১টা (bbox crop) সত্যিকারের কাজের, ১টা reframe দরকার। **আসল বাকি কাজ ফ্যামিলি নয় — CS11 (ভিডিও) + CS12 (রোলআউট), আর CS10-এর ডেটা ব্লকার (FASHN credit শেষ, ক্লিন golden ছবি, মা/মেয়ে মডেল সেভ)।**

---

## 1. Ground truth: what already exists (evidence from code)

| Capability | Status | Evidence |
|---|---|---|
| `fal-ai/fashn/tryon/v1.6` (commercial try-on) | **Live, runnable** | `provider-registry.ts` → `fal_fashn_v16 { runnable: true }`; worker `fashn-v16.mjs::processFashnV16` |
| `fal-ai/cat-vton` (IDM-VTON slot, research-only) | **Live, opt-in** | `provider-registry.ts` → `fal_idm_vton { status:'research_only', singlePersonOnly:true }`; worker `cat-vton.mjs` |
| `fal-ai/flux-pro/v1/fill` (masked edit) | **Live** | `provider-registry.ts` → `fal_flux_fill`; worker `flux-fill.mjs::processFluxFill` |
| Endpoint allowlist synced in BOTH mirrors | **Already in sync** | `ALLOWED_FAL_ENDPOINTS` in `provider-registry.ts` **and** `worker/src/fal/client.mjs` both list all 3 |
| Durable Fal queue (submit→poll→result, restart-safe) | **Live** | `worker/src/fal/client.mjs`; `request_id` persisted to `agent_kv_settings` before polling |
| Sequential family chain + `advanceFamilyChain` callback | **Live** | `src/lib/tryon/family-chain.ts` |
| Family **protected composite** (garment-faithful, per-person) | **Live in production (CS9)** | Roadmap §CS9 notes; `worker/src/family-composite.mjs` |
| Local **auto-segmentation** (free, on-VPS) | **Live (CS9)** | `@imgly/background-removal-node` ONNX; no paid seg model |
| Manual brush mask editor | **Live** | `MaskEditor.tsx` + `mask-contract.ts` (white=edit/black=keep) |
| Mode-specific hard QC gates (garment/identity/anatomy ≥4/5) | **Live (CS8/CS10)** | `single-pipeline.ts`, `qc-gate.ts` |

**Key technical fact that decides the whole audit:**
`cat-vton` and `fashn/v1.6` are **image-conditioned garment try-on** — their payloads take a **garment image** (`garment_image_url` / `garment_image`) and reproduce that exact garment on a person. `flux-pro/v1/fill` takes a **text prompt only** (`buildFluxFillInput` → `image_url`, `mask_url`, `prompt`; `enhance_prompt:false`). FLUX Fill therefore **cannot reproduce a specific product SKU's colour/embroidery/motif** — it can only invent plausible pixels from words.

---

## 2. Owner's locked decisions this plan must obey

From the roadmap §2 (these are non-negotiable and already govern the codebase):

- **#2** — "IDM-VTON is **not a family compositor**."
- **#7** — "FLUX Fill is a **precision editor, not a general replacement** for every image engine. It should **edit only the masked region**."
- **#9** — "Family outputs should be built from **individually approved people/garments, then composited** and harmonized. Do **not** ask one model to reinvent all people and garments in one call."
- Target architecture §5.1: FLUX Fill role = **"Masked background/edit/repair/outpaint."** Flow diagram node **J: "FLUX Fill: gaps, background and contact shadows only."**
- §CS9 work: "Use reviewed **local** person segmentation on the VPS if necessary; **do not add an unapproved third paid model silently.**"

---

## 3. Step-by-step audit of Google's plan

### Step 1 — "Enable FASHN v1.6, sync the two ALLOWED_FAL_ENDPOINTS lists" → ✅ **ALREADY DONE**
Both `provider-registry.ts` and `worker/src/fal/client.mjs` already list `fal-ai/fashn/tryon/v1.6`, `fal-ai/cat-vton`, and `fal-ai/flux-pro/v1/fill`. `fal_fashn_v16.runnable === true`. Single-person try-on already routes owner-selected engine → the right adapter (CS6). **Nothing to do.** Google was reading the CS5 "foundation only" comment, which CS6 superseded.

### Step 2 — "Add `flux_fill_garment` step: mask each family member, FLUX-Fill their garment sequentially" → ❌ **WRONG (violates locked decisions #7 & #9)**
Two independent reasons this fails:
1. **Garment fidelity is impossible with FLUX Fill.** It's text-prompt inpainting with no garment-image input. Feeding "father's panjabi" as a prompt cannot reproduce the actual product's embroidery/colour → it will fail the repo's own hard gate `garment_fidelity ≥ 4/5` (`single-pipeline.ts` `PRODUCTION_CORE_AXES`). The owner explicitly forbids auto-repainting garments (`repairableAxes()` excludes `garment_fidelity`).
2. **The correct pattern already ships (CS9).** Family shots are built as: per-person **garment-faithful VTON** (FASHN/CatVTON) → **local free segmentation** cuts each approved person out → **deterministic protected composite** (`base×(1−m)+fill×m`, unmasked pixels survive by construction) → **FLUX Fill harmonizes ONLY the alpha edge band + a contact-shadow ellipse**. That is exactly "sequential per-person" done the garment-safe way, and `advanceFamilyChain` already drives it. Google reinvented a worse version of a live feature.

**Verdict:** do not build `flux_fill_garment`. FLUX Fill's family role is already correct and minimal (edge/shadow only).

### Step 3 — "Bounding-box crop before FLUX Fill to cut cost ~80%" → ✅ **GENUINELY GOOD, and the one real new win**
FLUX Fill bills `$0.05 × ceil(MP)` on the image you send (`calcFluxFillCostUsd`, `estimateFluxFillCostUsd`). Today `processFluxFill` sends the **full base** (≤2048px). For the CS9 harmonize step and the CS10 owner-painted repair path, the edited region is tiny, so cropping base+mask to the mask bounding box (plus padding) before submit cuts billed megapixels hard. This is **additive, safe, and not yet implemented.** Corrections Google missed:
- **1-MP floor:** `ceil(MP)` with a `min 1` floor → any crop ≤1MP bills the same `$0.05`. Real saving is on multi-MP bases (e.g. 2048×2048 ≈ 4MP → `$0.20`; a 0.4MP crop → `$0.05`, a true 4× cut). So "80%" holds only when the base is well over 1MP.
- **Padding for blend quality:** FLUX Fill needs surrounding context; pad the bbox ~10–15% and feather, or the boundary blends worse.
- **Composite-back needs new code:** the existing `protectedComposite()` is **full-frame** (resizes fill/mask to full base WxH). A cropped fill must be pasted back **at the bbox offset** — a small offset-aware composite (or `sharp.composite` at `{left, top}`), then keep the existing pixel-diff protection assertion.

### Step 4 — "Masking source: A) manual brush per person, or B) auto `fal-ai/sam` 'person, clothing'" → ⚠️ **REFRAME (already solved, and B contradicts owner cost rule)**
- The core family feature **does not need per-person masks at all** — VTON auto-masks a single person internally, and CS9 uses **free local ONNX segmentation** (`@imgly/background-removal-node`) to isolate each approved person. Auto-masking already exists, at zero API cost.
- Manual brush (Option A) **already exists** (`MaskEditor.tsx`) and is the right tool for the *precision-edit / repair* surface only.
- Option B is **technically imprecise and against policy:** plain `fal-ai/sam` is point/box-prompted, **not** text-promptable — text prompts need Grounded-SAM / EVF-SAM. More importantly, the owner **already rejected paid segmentation** in favour of the local model (roadmap §CS9: "do not add an unapproved third paid model silently"). So don't add a paid Fal SAM.

---

## 4. Verdict table

| Google step | Verdict | Action |
|---|---|---|
| 1. Enable FASHN v1.6 + sync endpoints | ✅ Already done (CS5/CS6) | None |
| 2. `flux_fill_garment` family swap | ❌ Wrong — breaks locked #7/#9, no garment fidelity | Do **not** build; CS9 already does it right |
| 3. Bounding-box crop for FLUX Fill cost | ✅ Good, new, additive | **Implement** (harmonize + repair paths, with offset composite-back) |
| 4. Masking source SAM (paid) | ⚠️ Already solved locally + policy conflict | Keep manual brush + free local seg; skip paid SAM |

---

## 5. My recommendation (corrected, production-safe)

### 5.1 What NOT to do
- Don't touch the endpoint allowlists (already synced).
- Don't build a FLUX-Fill garment-swap chain step.
- Don't add a paid segmentation endpoint.

### 5.2 The one worthwhile piece of Google's plan — do this
**"FLUX Fill bbox-crop" cost optimization**, scoped to the two masked paths (CS9 edge/shadow harmonize + CS10 owner-painted repair), NOT garment.
- **Files:** `worker/src/fal/adapters/flux-fill.mjs` (crop base+mask to padded mask bbox before `runFalQueueJob`; composite the returned fill back at the bbox offset), `worker/src/family-composite.mjs` (harmonize call site), plus a small unit test alongside `mask-contract.test.ts`.
- **Guards:** keep base/mask dimensionally identical after crop (`assertMaskDimensionsMatch`); keep the post-composite pixel-diff assertion; respect the 1-MP floor (skip cropping when the base is already ≤~1.2MP — no benefit); pad ~12% + feather.
- **Expected:** harmonize/repair fills drop from ~`$0.20` toward `$0.05` on large bases; QC unaffected (protected pixels still copied).
- **Additive, within one worker file cluster — no schema change, no new endpoint, no ERP code touched.**

### 5.3 The actual remaining roadmap work (this is where effort belongs)
Family (CS9) and QC (CS10) are **merged and live**. Genuinely pending:
- **CS11 — Video professional hardening** (Veo 3.1 + owner-shot reels: temporal garment/identity QC, dedupe uploads, no raw ffmpeg errors to owner).
- **CS12 — Observability, rollout, canary, final certification.**
- **CS10 data blockers (owner actions, not code):**
  1. **Direct FASHN is OutOfCredits** — family chains + the FASHN golden leg are blocked until fashn.ai is topped up.
  2. **Clean garment-only product photos** needed for honest golden evaluation (today's marketing-composite photos floor every engine at 3/5 fidelity).
  3. **Save মা + মেয়ে models** in the library so live full-family runs work (the AI model-creator can generate them).

### 5.4 Optional new feature (only if there's real demand)
"Swap our products onto a **real uploaded group/family photo** in place" is a *different* feature from the saved-model composite CS9 already ships. If wanted, the **correct** design (garment-faithful, obeys #7/#9) is: per-person **bbox crop → FASHN/CatVTON try-on (garment image) → composite back** — reusing the Step-3 crop machinery — with **FLUX Fill only** for seams/shadows. It would still **not** use FLUX Fill to apply garments. Weigh against demand before building; the marketing use case is already covered.

---

## 6. What to tell the other AI (hand-back)
> The plan's Steps 1–2 are based on a stale reading: endpoints are already synced and runnable, and using FLUX Fill to apply family garments violates the project's locked architecture (FLUX Fill is masked-repair only; garments must come from image-conditioned VTON, then a protected composite — already live as "CS9"). Keep only the bounding-box-crop cost optimization, scoped to the FLUX Fill harmonize/repair paths (not garment application), and implement the composite-back at the crop offset. Real remaining scope is video hardening (CS11), rollout/observability (CS12), and three owner-side data blockers (FASHN credits, clean golden photos, saved mother/daughter models).

---

*Audit only — no code was modified. Evidence paths: `src/lib/creative-studio/provider-registry.ts`, `worker/src/fal/{client.mjs,adapters/*.mjs}`, `src/lib/tryon/family-chain.ts`, `src/lib/creative-studio/{mask-contract.ts,single-pipeline.ts}`, `docs/CREATIVE_STUDIO_FAL_IDM_VTON_FLUX_FILL_ROADMAP.md` §2/§5.1/§CS9/§CS10.*
