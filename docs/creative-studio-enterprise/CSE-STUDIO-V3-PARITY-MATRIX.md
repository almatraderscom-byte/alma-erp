# Creative Studio Enterprise V3 — exact production parity matrix

Date: 2026-07-26

Method: fresh authenticated read-only production inspection plus current branch source inventory
Scope: owner-reviewable demo mapping; no provider or production mutation

## Source-to-destination matrix

| Current capability | Exact current source | Exact V3 destination | V3 review behavior |
| --- | --- | --- | --- |
| Studio shell and five current views | `CreativeStudioShell.tsx`; `STUDIO_NAV_DEFINITIONS` in `studio-api.ts` | `CreativeStudioHome.tsx`; `CreativeStudioWorkspaceShell.tsx` | Home is the default command center; Image Lab, Video Lab, Gallery, Finishing, and desks are reachable without entering the Editor. |
| Brand isolation and brand selection | `BrandSwitcher.tsx`; `/api/assistant/creative-studio/brands`; `studio-access.ts` | Home brand context; every workspace header; Operations policy desk | Shows ALMA Lifestyle, strict isolation, owner scope, and pinned fixture provenance. No cross-brand fixture action. |
| Project/folder/context | `ProjectBar.tsx`; `ProjectLibraryView.tsx`; `project-contract.ts`; projects APIs | Home projects; Projects desk; Editor project context | Project state, folder, format, progress, owner/collaborators, recipe, and version are inspectable; open project enters Editor. |
| Assets and catalog | `ProductPicker.tsx`; `GalleryView.tsx`; products/gallery/project-assets APIs | Home inventory; Image Lab product/source selectors; Video Lab sources; Gallery | ERP code, source dimensions, project, provider, state, aspect, cost, and provenance are visible. |
| Gallery state and query | `GalleryView.tsx`; `gallery-query.ts`; `/gallery`; `/assets/[id]/state` | `CreativeStudioGallery.tsx` | Image/Video/Audio/Voice/Avatar/Project, Recent/Approved/Review/Archived, search, state/provider/aspect filters, sort, selection detail. |
| Gallery density pain | Production `GalleryView.tsx` fixed large cards | Gallery density control | Large, Comfortable, Compact, and List. Compact materially increases visible assets; density is demo-local only. |
| Saved recipes/templates | `BrandRecipeEditor.tsx`; recipe APIs; `brand-recipe.ts` | Home Reusable Systems; Image Lab recipe chips/templates; Recipes & Models desk | Exact current recipe names plus version/lock context; selecting a recipe configures only the fixture composer. |
| Saved models | `StudioWorkspaceView.tsx` `ModelChooserSheet`/`ModelSlot`; `ModelLibraryView.tsx` | Home avatar lane; both Labs; Gallery Avatar view; Recipes & Models desk | Identity is distinct from generic media and pinned to brand, owner, version, role, and state. |
| Avatar identity sheets | `ModelLibraryView.tsx` `AvatarSheet`; model creator API | Both Lab identity rails; Gallery Avatar detail | Five role fixtures, image/angle count, canonical state, New/View all, and selection into composers. No model build request. |
| Image Auto | `StudioWorkspaceView.tsx` `AutoPanel` | Image Lab → Auto | Required ERP product, current/default saved model, creative direction, family variant, optional six-second Reel, default FASHN path, readiness/cost boundary. |
| Image Advanced modes | `STUDIO_MODES` in `constants.ts`; `StudioWorkspaceView.tsx` | Image Lab → Advanced | Generate, Product → Model, Try-On, Swap, Face, Edit, Reel are interactive and mode-aware. |
| Product/model/source requirements | `StudioWorkspaceView.tsx` `modeDef`, `ModelSlot`, `UploadTile`, family logic | Image Lab composer | Product, avatar, source, extra reference, and family controls appear only when applicable; missing requirements block the local readiness state. |
| Family presets | `FAMILY_PRESETS` and `FAMILY_REQUIRED_ROLES`; family checklist/merge logic | Image Lab Product → Model/Try-On | Single, বাবা + ছেলে, মা + মেয়ে, মা + ছেলে, বাবা + মেয়ে, কাপল, পুরো ফ্যামিলি. |
| Image templates | current template records consumed in `StudioWorkspaceView.tsx` | Image Lab approved starting systems/chips | Product launch visual, Social media content, Product display image, Virtual try-on, Product to model, Combined listing. |
| Image provider/engine fidelity | `provider-registry.ts`; `ENGINE_LABELS_BN`; `create-run.ts` | Image Lab provider cards and mode capability copy | Grok, FASHN direct, Fal FASHN, Gemini draft fallback, IDM-VTON research-only, and FLUX Fill are offered only for fixture-compatible modes. No silent fallback. |
| Image background/aspect | `BACKGROUND_PRESETS`; current 4:5, 1:1, 9:16, 16:9 controls | Image Lab composer | Studio/Outdoor BD/Festival/Lifestyle/Custom and four aspects remain configurable. |
| Truthful image resolution | current requested 1K/2K/4K control; Workstream B result contract | Image Lab resolution group | 1K/2K depend on selected provider; 4K is disabled and explained. Requested capability is never called delivered truth. |
| Quality/safety/count/cost | `StudioWorkspaceView.tsx`; config/run policies; `studio-policy.ts` | Image Lab readiness panel | Fast/Balanced/Quality, safety/QC copy, 1–4 outputs, provider estimate, research/commercial warning, and no-API boundary. |
| Precision/masked edit | `MaskEditor.tsx`; `mask-contract.ts`; mask-upload/run APIs | Finishing → Mask repair; Image Lab Edit entry | Exact presets: Replace background, Remove object/mark, Repair hand/detail, Add contact shadow, Extend canvas, Custom prompt; brush/erase/undo/clear/invert/size/feather concepts are reviewable. |
| Image finishing fields | `GalleryView.tsx` `FinishPanel`; finish API | Finishing → Brand layout | Eyebrow, headline/hook, offer, product code, source/original vs branded preview, non-destructive status. |
| Image finishing layouts | `FinishPanel`; `LifestyleEditor.tsx`; lifestyle layout contract | Finishing → Brand layout | Lifestyle poster, Model overlay, Product card; Default/Eid/Puja/Boishakh/Winter; cover/contain; optional model-overlay footer. |
| Image source preservation | finish/lifestyle services and version handling | Finishing preview/status | Original is explicitly preserved; all changes are described as a derived preview and output is disconnected. |
| Video entry sources | `VideoStudioView.tsx`; video/upload/video-run APIs | Video Lab source gallery | Gallery image, approved avatar, owned upload/footage recipe; a selected image/avatar visibly becomes the source. |
| Video recipes | `video-recipes.ts`; `VideoStudioView.tsx` | Video Lab templates | Family Shoot, Product Showcase, Offer Promo plus image-to-video Premium fabric turn. |
| AI reel chain | `veo-chain.ts`; video-run API | Video Lab duration capability | One Veo clip is 4–8 sec; 16/24 sec are described as deterministic 2/3×8 sec chains; not falsely passed to single-clip capability. |
| Video duration/aspect | `VideoStudioView.tsx`; `video-recipes.ts` | Video Lab composer | Veo 4–8 plus 16/24 chain; owned recipe 15/30/60; Offer Promo 15/30; 9:16/1:1/16:9 constrained by selected model/recipe. |
| Truthful video resolution | current video result fields; Workstream B delivery contract | Video Lab resolution group | Veo preview exposes verified 720p only; owned footage can preserve up to 1080p; 4K disabled; requested and delivered copy are separate. |
| Video start/end/image refs | current video request/source behavior | Video Lab composer | Source-first gallery, optional end frame, image reference, prompt, and provenance are present. |
| Video audio/count/cost | `VideoStudioView.tsx`; video request contracts | Video Lab composer | Original audio/mute/Generate audio choice, 1–2 candidates, per-second estimate, and a blocked generation action. |
| Timeline Lite | `TimelineLite.tsx`; `video-edit-contract.ts` | Finishing → Video Timeline | Trim, crop, volume, captions, cover; selected-track partial rerender and source-preservation copy; local fixture edit only. |
| Transcript/captions | `TranscriptEditor.tsx`; `captions.ts` | Finishing → Video Timeline and Project Editor caption track | Transcript/caption timing, caption edit/save/recipe restore, voice/caption relationship. |
| Video finishing | `VideoStudioView.tsx` `VideoFinishPanel`; `video-finish.ts`; video-finish API | Finishing → Motion templates | Exact actions: Price pop; Lower third with code/name; Logo watermark; End card with CTA/code/price; Countdown days. |
| Voice cloning/library | `VoiceLibrary.tsx`; voice APIs; `voice-policy.ts` | Voice desk; Gallery Voice view; Editor Voice tool/track | 1–3 owner samples, consent/version, active owner-only state, synthesis/dubbing boundaries; all execution disabled. |
| Music/SFX/audio workflows | `AudioLabView.tsx`; `audio-lab.ts`; music/audio APIs | Audio desk; Gallery Audio; Editor Music/SFX tracks | Music moods (celebration/calm/nasheed; vocal-only), 30/60, wish song types, owner voice TTS, voice-note isolation/enhance, and SFX are inspectable. |
| Campaign Pack | `CampaignPackPanel.tsx`; `CampaignPackProgress.tsx`; campaign services/APIs | Home create; Campaign desk | Brief → staged variants → review, manifest, two drafts, owner selection, retry/idempotency, hard cap, cost gate. No pack run. |
| Review/revisions | `ReviewPanel.tsx`; `review-workflow.ts`; reviews API | Home queue; Review desk; Editor Review tab | Role/state matrix, pinned version, requested changes, approval invalidation, and disconnected owner-review request. |
| Deterministic Agent edit | new demo contract `demo-operations.ts` and tests | Project Editor Agent | Plan, safe-vs-gated diff, fingerprint `8F2C` bound to the current composition version, stale-plan invalidation/re-plan, acknowledgement, three reversible ৳0 edits, version-derived audit ID, rollback as a new version. |
| Export/share boundary | current Studio delivery concepts; CSE lifecycle docs | Editor top bar and Operations desk | Share and Export are distinct, visibly prototype-only, and cannot execute. |
| Distribution dry run/publish | `PublishPanel.tsx`; `publish-service.ts`; publish API | Operations desk; Editor Agent gated group | Dry-run is separate from schedule/publish; pinned brand/project/version/review/fingerprint; owner confirmation; ambiguous effect and live switch policies. |
| Performance/attribution | `PerformanceView.tsx`; `performance-attribution.ts`; performance API | Operations desk | Delivery/version linkage, seven-day attributed signal, feedback-weight boundary; fixture metric clearly labeled. |
| Retention/archive | `retention-policy.ts`; retention API | Operations desk; Gallery Archived view | Retention countdown, recoverable archive/fetch-back, lineage/checksum concepts; no archive mutation. |
| Jobs/retry/worker health | job APIs; health/config/settings APIs; CSE1 worker contracts | Operations desk; Home Studio Pulse | Queue state, retry policy, six worker fixtures, provider health, balances/kill switches, and “queued is not complete” truth rule. |
| Roles/security | `StudioRoleSettings.tsx`; `studio-access.ts`; `studio-policy.ts`; roles API | Operations policy desk and every trust bar | Owner/creator/reviewer boundaries, strict brand isolation, consent, spend/publish gates, and no client-only authority. |
| Cost governance | settings/config/run/campaign/publish policies | Home, both Labs, Operations, Editor Agent | Daily budget, estimates, hard caps, ৳0 local edits, separate confirmation, invalidation on changed payload/provider/target/cost. |
| Loading/empty/error states | `StudioUi.tsx` | Labs, Gallery, desks, and fixture refresh/history | Purpose-built skeleton, empty, failure/disabled copy; no false provider success. |
| CSE1 trust/reliability | CSE1 docs; `studio-health.ts`; errors/health tests | Home/Operations trust signals and all disconnected actions | Health, sanitized errors, retry truth, spend/policy state. |
| CSE2 modular shell | CSE2 docs; current shell/components | Home + shared V3 workspace shell | Original route-scoped IA; production shell untouched. |
| CSE3 Content OS | CSE3 docs; project/asset/recipe/model sources above | Home, Gallery, Labs, Projects/Systems desks, Editor context | Complete brand/project/folder/asset/catalog/recipe/model lineage. |
| CSE4 Campaign Orchestrator | CSE4 docs; campaign sources above | Campaign desk and Home workflow | Stages, manifest, selections, retry/idempotency/cap. |
| CSE5 Video Editor | CSE5 docs; video/timeline/transcript sources above | Video Lab, Finishing, Project Editor | Creation is separated from Timeline Lite and full composition editing. |
| CSE6 collaboration/multibrand | CSE6 docs; review/role/brand sources above | Home, Review, Projects, Editor Review | Collaborators, role state, brand isolation, pinned version. |
| CSE7 distribution/lifecycle | CSE7 docs; publish/performance/retention sources above | Operations, Gallery lifecycle views, Editor gates | Dry-run, publish, attribution, archive, workers, security, cost. |
| Workstream A — reference/model fidelity | parallel advanced-model-fidelity contract, not merged | Image Lab mode-aware product/model/avatar/reference slots and provider capability copy | UI consumes a future capability manifest; V3 does not invoke or duplicate provider adapters. |
| Workstream B — truthful resolution | parallel resolution-integrity contract, not merged | Image/Video Lab capability-disabled resolution plus Gallery requested/delivered metadata | UI consumes normalized delivered dimensions/QC; no global 4K promise. |

## V3 isolated implementation boundary

- `src/app/agent/creative-studio-demo/page.tsx` remains the only route entry and retains kill-switch, session, and system-owner checks.
- All V3 product UI is under `src/agent/components/creative-studio-demo/`.
- Deterministic Agent operations remain under `src/lib/creative-studio/demo-operations.ts` with tests.
- V3 capability fixtures are safe, non-sensitive, and disconnected.
- Existing `/agent/creative-studio`, its APIs, workers, schemas, adapters, and data are unchanged.

## Owner parity walkthrough

1. Home → Image → select Advanced mode/product/avatar/source/provider/resolution/recipe → inspect readiness and disabled 4K.
2. Image/Video → History → return to Explore.
3. Home/Image/Video → Gallery → switch types/views/filters and Large/Comfortable/Compact/List → select an asset → take it into Create or Finishing.
4. Home → Video/Reel → select gallery source/avatar/template/model/duration/resolution/aspect/frame/audio/count → inspect unsupported combinations.
5. Home → Finishing → switch Brand layout/Mask repair and Image/Video → inspect every exact production action.
6. Home/sidebar → Projects, Recipes & Models, Review, Operations, Voice, Audio, Campaign → inspect real capability contracts.
7. Open project/Long-form/Agent → Editor → change tools/assets/timeline/caption → plan `8F2C` → acknowledge → apply three reversible ৳0 edits → inspect audit → rollback → Home.

No step is wired to a provider, upload, generation, render/export, review write, external publish, or production mutation.
