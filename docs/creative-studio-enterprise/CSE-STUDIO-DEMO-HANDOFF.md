# Creative Studio Enterprise V3 — owner demo handoff

**Gate:** owner live-demo approval required; production redesign is not approved

**Branch:** `codex/cs-enterprise-studio-demo`

**Original base:** `b399ba9b47433a5d0dcfd0d5e862b21a600456d1`

**Pre-work tag:** `pre-codex-cs-enterprise-studio-demo`

**Demo route:** `/agent/creative-studio-demo`

**Access:** ALMA Agent kill switch + authenticated system-owner session
**Provider/external spend:** ৳0; all provider, upload, render/export, review-write, and publish actions are disconnected

## Owner decision package

- V2 failure correction and exact Aura audit: `CSE-STUDIO-V3-DESIGN-REVIEW.md`
- Fresh named production-to-V3 feature matrix: `CSE-STUDIO-V3-PARITY-MATRIX.md`
- Competitive audit, observed vs inferred: `CSE-STUDIO-REDESIGN-AUDIT.md`
- Four large outcome phases, dependencies, migrations/APIs/workers, rollout/rollback, and A/B integration: `CSE-STUDIO-REDESIGN-ROADMAP.md`
- This implementation/evidence handoff: `CSE-STUDIO-DEMO-HANDOFF.md`

## What V3 corrects

1. **No shallow creation modal.** Home → Image opens Image Lab; Home → Video/Reel opens Video Lab.
2. **Create and edit are separate levels.** Labs handle source/template/model/provider configuration. The Project Editor handles an existing or long-form composition.
3. **Current production behavior is usable in the demo.** Auto, all seven Advanced image modes, video source/model/duration/resolution controls, avatars, Gallery density, and exact Finishing actions are interactive.
4. **Primary navigation is complete.** Projects, Gallery, Finishing, Recipes & Models, Review, Operations, Voice, Audio, and Campaign all open meaningful review surfaces.
5. **Provider truth is explicit.** Mode-aware references, commercial/research status, no silent fallback, disabled unsupported values, requested-versus-delivered resolution, and no global 4K claim.
6. **V3 remains an original ALMA product.** It uses Aura tokens, warm surfaces, coral active states, ALMA typography, vector controls, restrained elevation, and an original command-center/Create-Lab/Editor hierarchy.

## Information architecture

### 1. Creative Studio Home

Default route and operational command center:

- active brand, strict isolation, owner controls, search;
- Image, Video/Reel, Voice, Audio, Campaign Pack, Long-form;
- Assets/Catalog/Identity and Gallery;
- recent projects, collaborators, review/activity state;
- recipes, templates, saved models, campaign workflows;
- Creative Agent plan-only entry;
- review, distribution, attribution, retention, worker, security, and cost signals.

### 2. Create / Explore

- **Image Lab:** Explore/History, avatars, recipes, gallery, Auto/Advanced, Generate/Product → Model/Try-On/Swap/Face/Edit/Reel, mode-aware product/model/source/reference, family, background, aspect, provider, truthful resolution, quality/safety, count, estimate/readiness.
- **Video Lab:** Explore/History, avatars, gallery source, templates, model/recipe, duration, truthful resolution, aspect, start/end/image reference, prompt, audio/mute, count, estimate/capability.
- **Gallery:** six media categories plus Project, four lifecycle views, search/filter/sort, selected-asset handoffs, Large/Comfortable/Compact/List.
- **Finishing:** source-preserved image Brand layout and Mask repair; Video Timeline Lite/transcript and exact motion templates.
- **Desks:** Projects, Recipes & Models, Review, Operations, Voice, Audio, Campaign.

### 3. Project Editor

- lifecycle/version/history/share/export boundary;
- left media rail and contextual source panel;
- central stage/player;
- video/captions/voice/music/SFX timeline;
- integrated Inspector/Creative Agent/Review;
- deterministic plan → fingerprint `8F2C` → owner acknowledgement → three reversible ৳0 operations → version-derived audit `AUD-{new-version}-8F2C` → rollback;
- paid generation and external publish remain separately locked.

## Exact Finishing parity

| Production action family | Exact V3 surface |
| --- | --- |
| Image text fields | Eyebrow, headline/hook, offer, product code |
| Image layouts | Lifestyle poster, Model overlay, Product card |
| Themes | Default, Eid, Puja, Boishakh, Winter |
| Preview/source rules | Original vs branded preview, cover/contain, optional model-overlay footer, original preserved |
| Mask presets | Replace background, Remove object/mark, Repair hand/detail, Add contact shadow, Extend canvas, Custom prompt |
| Mask concepts | Brush/erase, undo, clear, invert, size, feather, preview; fixture-only canvas |
| Timeline Lite | Trim, crop, volume, captions, cover, selected-track partial rerender, source preserved, ৳0 local edit boundary |
| Transcript | Caption/transcript timing and editable text |
| Video templates | Price pop; Lower third code/name; Logo watermark; End card CTA/code/price; Countdown days |

## Changed-file boundary

### Demo UI

- `src/agent/components/creative-studio-demo/CreativeStudioEnterpriseDemo.tsx`
- `src/agent/components/creative-studio-demo/CreativeStudioHome.tsx`
- `src/agent/components/creative-studio-demo/CreativeStudioWorkspaceShell.tsx`
- `src/agent/components/creative-studio-demo/CreativeStudioCreateLab.tsx`
- `src/agent/components/creative-studio-demo/CreativeStudioGallery.tsx`
- `src/agent/components/creative-studio-demo/CreativeStudioFinishing.tsx`
- `src/agent/components/creative-studio-demo/CreativeStudioCapabilityDesk.tsx`
- `src/agent/components/creative-studio-demo/CreativeStudioEditor.tsx`
- `src/agent/components/creative-studio-demo/StudioV2Icon.tsx`
- `src/agent/components/creative-studio-demo/studio-v2-fixtures.ts`
- `src/agent/components/creative-studio-demo/studio-v3-fixtures.ts`
- `src/agent/components/creative-studio-demo/studio-v3-navigation.ts`
- `src/agent/components/creative-studio-demo/CreativeStudioEnterpriseDemo.module.css`

### Demo tests

- `src/agent/components/creative-studio-demo/__tests__/studio-v3-fixtures.test.ts`
- existing `src/lib/creative-studio/__tests__/demo-operations.test.ts`

### Owner docs

- `docs/creative-studio-enterprise/CSE-STUDIO-V2-DESIGN-REVIEW.md` (historical pointer)
- `docs/creative-studio-enterprise/CSE-STUDIO-V3-DESIGN-REVIEW.md`
- `docs/creative-studio-enterprise/CSE-STUDIO-V3-PARITY-MATRIX.md`
- `docs/creative-studio-enterprise/CSE-STUDIO-REDESIGN-ROADMAP.md`
- `docs/creative-studio-enterprise/CSE-STUDIO-DEMO-HANDOFF.md`

Existing production Creative Studio routes, components, APIs, Prisma schema/migrations, workers, provider adapters, and data are unchanged.

## Visual evidence

Local exact-viewport captures:

- Home desktop 1440×1000: `/private/tmp/alma-studio-v3-evidence/home-1440.png`
- Home tablet 1024×900: `/private/tmp/alma-studio-v3-evidence/home-1024.png`
- Home mobile 390×844: `/private/tmp/alma-studio-v3-evidence/home-390-clean.png`
- Image Lab desktop: `/private/tmp/alma-studio-v3-evidence/image-lab-1440.png`
- Image Lab tablet: `/private/tmp/alma-studio-v3-evidence/image-lab-1024.png`
- Image Lab mobile: `/private/tmp/alma-studio-v3-evidence/image-lab-390.png`
- Video Lab desktop: `/private/tmp/alma-studio-v3-evidence/video-lab-1440.png`
- Video Lab mobile: `/private/tmp/alma-studio-v3-evidence/video-lab-390.png`
- Compact Gallery desktop: `/private/tmp/alma-studio-v3-evidence/gallery-compact-1440.png`
- Finishing desktop: `/private/tmp/alma-studio-v3-evidence/finishing-1440.png`
- Editor Agent plan desktop: `/private/tmp/alma-studio-v3-evidence/editor-agent-1440.png`

Final live-preview captures and exact deployment identity are added after the final SHA reaches READY.

## Validation record

| Check | Status |
| --- | --- |
| Correct branch/base/pre-work tag and preserved V2 state | PASS |
| Applicable `AGENTS.md` | None found; rechecked |
| Five owner references at original detail | PASS |
| Fresh authenticated production/code inventory | PASS; no provider or paid action |
| Aura token/pattern audit | PASS |
| Home → Image Lab / Video Lab, no modal | PASS |
| Gallery Compact materially denser | PASS |
| Finishing exact action families | PASS |
| Desktop/tablet/mobile document overflow | PASS — 1440/1024/390 `scrollWidth === clientWidth` |
| V3 fixture/capability tests | PASS — 5/5 |
| Deterministic Agent operation tests | PASS — plan/fingerprint/apply/audit/rollback verified |
| Full relevant Creative Studio suite | PASS — 28 files / 178 tests |
| React/Next review | PASS — split client boundaries, stable keys/state, effect cleanup, semantic/accessibility review |
| TypeScript | PASS — `npm run type-check` |
| ESLint | PASS — targeted demo lint clean; full lint exits 0 with the repository's pre-existing warning baseline |
| Production build | PASS — Next.js 14.2.35, 389/389 static pages; demo route 47.1 kB / 136 kB first load |
| Temporary build validation override | Removed after the successful build; `next.config.js` has no final diff |
| `git diff --check` and exact scope | PASS — 19 files, limited to demo components/tests and Creative Studio review docs |
| Final commit/push | pending |
| Exact-SHA READY Vercel preview/branch alias | pending |
| Owner Chrome end-to-end live verification | pending |
| Spend/upload/generation/export/publish | ৳0 / none |

## Prototype limitations

- All V3 media, people, metrics, costs, jobs, projects, reviews, and audit records are safe fixtures.
- State is in-memory except demo-local Gallery density; it resets and is not collaborative.
- Explore/History and capability desks are review surfaces, not persisted production records.
- Gallery artwork and the stage are abstract CSS fixture previews, not generated output.
- No source upload/decode, provider request, render, asset write, project write, review write, Drive operation, export, schedule, or publish exists.
- Image/video estimates demonstrate the confirmation contract; they are not charged.
- Resolution options model the current/parallel-stream contracts but do not claim an adapter result.
- Timeline playback/editing demonstrates selection and deterministic operation semantics, not a render graph.
- Creative Agent is a deterministic fixture compiler, not an LLM.

## Integration risks

| Risk | Integration rule |
| --- | --- |
| Workstream A changes product/model/reference fidelity and engine payloads | Its provider-neutral capability manifest is authoritative; V3/production redesign owns presentation and never duplicates adapters. |
| Workstream B changes requested/delivered dimensions and QC | Its normalized result is authoritative; Gallery and Inspector consume it and never infer success from a request. |
| Shared `StudioWorkspaceView`/`studio-api.ts` overlap | Split new composition/generation clients by domain during integration. |
| Provider-specific fields leaking into editor state | Core composition references capability/result contracts; adapter details stay outside the document. |
| Prisma migration order across three workstreams | Reserve additive migration order during consolidation; never rewrite an applied migration. |
| Review/export/publish conflation | Preview, render, export, dry run, schedule, and live publish remain separate commands/gates. |
| Agent plans becoming an execution bypass | Every effect uses shared auth, brand, version, cost, permission, fingerprint, and verification checks. |

## Short owner checklist

1. Confirm Home is the default and Image/Video enter complete Labs, not the Editor or a modal.
2. In Image Lab, try Auto/Advanced modes, product, avatar, source/reference, provider, and disabled resolution combinations.
3. In Video Lab, choose a gallery source/avatar/template and inspect model, duration, resolution, aspect, frame, audio, and estimate constraints.
4. In Gallery, switch categories/views and all four density modes; select an asset and follow Create/Finish/Edit.
5. In Finishing, review Brand layout, Mask repair, Timeline, and all exact video templates.
6. Open Projects, Recipes & Models, Review, Operations, Voice, Audio, and Campaign.
7. Open the Editor, edit/restore a caption, run Agent plan `8F2C`, acknowledge, apply only three ৳0 edits, inspect audit, rollback, and return Home.
8. Confirm every paid/provider/export/publish action remains blocked.

## Explicit approval gate

STOP after this V3 live preview. Do not begin the production redesign, integrate Workstreams A/B, merge main, deploy production, upload owner data, run a provider, export media, or exercise external publishing without explicit owner approval of this V3 demo and roadmap.
