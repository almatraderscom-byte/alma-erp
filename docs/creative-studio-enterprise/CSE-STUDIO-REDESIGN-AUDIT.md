# Creative Studio Enterprise — Studio redesign audit

**Status:** owner-review package; production implementation is not approved
**Audit date:** 2026-07-25
**Base:** `agent-phase-cse7` at `b399ba9b47433a5d0dcfd0d5e862b21a600456d1`
**Demo branch:** `codex/cs-enterprise-studio-demo`
**Evidence policy:** no uploads, generations, exports, account changes, credit spend, cookie/storage inspection, or production mutations were made.

## Executive finding

ALMA already has the harder half of an enterprise creative system: deterministic generation paths, product and brand context, version lineage, role-scoped review, explicit spend controls, guarded distribution, performance attribution, worker health, and retention. Its weakness is that these capabilities are distributed across five destinations and a collection of modal or card workflows. The user must continually reconstruct which project, source, asset version, recipe, review, and delivery state they are operating on.

The redesign should make **one project document** the organizing unit. Its workspace should keep the asset tree on the left, the selected composition at the center, the synchronized multi-track timeline below, and the selected object plus Creative Agent on the right. Enterprise state should remain visible at the point of action: cost before generation, QC on clips, review on versions, and publish eligibility on the current composition.

ElevenLabs Studio is a useful interaction reference because it presents media creation and editing in a coherent spatial model. ALMA should derive the principles—persistent project context, local tools, canvas/timeline synchronization, and an adjacent assistant—without copying its brand, copy, visual tokens, or proprietary behaviors.

## Method and evidence boundary

### Directly inspected

- The supplied current-ALMA screenshot:
  `/var/folders/d4/7298bhm578d5m404gssfmyb00000gn/T/codex-clipboard-13d4ecf3-1ab4-46ab-b61c-383fe111787f.png`
- The supplied ElevenLabs editor/Studio Agent screenshot:
  `/var/folders/d4/7298bhm578d5m404gssfmyb00000gn/T/codex-clipboard-cbff58ba-56e0-4399-b3cc-f18019f51f7b.png`
- Authenticated, read-only Chrome views of:
  - `https://elevenlabs.io/app/studio?tab=architect`
  - an existing owner Studio project/editor
  - ALMA’s CSE7 preview at `/agent/creative-studio`
- Visible DOM and accessibility snapshots, desktop screenshots, and 390 × 844 responsive screenshots.
- CSE1–CSE7 implementation documents, the enterprise roadmap, certification report, current pages, components, API routes, Prisma models/migrations, agent tools, and creative workers.

### Not exercised

- ElevenLabs upload, generation, export, share mutation, project creation, or paid workflows.
- Account settings, browser storage, cookies, passwords, or credentials.
- Destructive edit, live ALMA generation, real external publishing, or production deployment.

Consequently, behavior below is explicitly marked **observed** when the visible UI or ALMA code establishes it, and **inferred** when it is an interaction expectation that was not safely executable.

## ElevenLabs Studio competitive audit

### Workspace, project, and file hierarchy

| Finding | Evidence status | Product implication for ALMA |
| --- | --- | --- |
| Studio opens with a creation prompt, template-like starting points, recent projects, search, filters, upload, and new-project controls. | Observed | ALMA should open on a project home that supports recent work, folders, templates/recipes, and safe asset ingestion before entering the editor. |
| New project exposes separate Video project and Audio project choices. | Observed; menu opened without creating | ALMA may offer task-oriented entry points, but both should resolve to the same project document and media graph. |
| The editor’s Files panel can switch between “this project” and workspace-level material, with search and media grouping. | Observed | Separate project assets from the reusable business library while making both reachable from one panel. |
| A project title is editable in the top bar and the project remains the persistent editor context. | Observed | Keep brand, project, ERP product, recipe version, and folder visible without a separate modal. |
| Exact folder nesting, bulk move, permission inheritance, and cross-project copy behavior were not safely exercised. | Inferred | ALMA’s implementation must define these semantics explicitly instead of assuming parity. |

### Asset ingestion and creative tools

| Area | Direct observations | Unobserved/inferred behavior | Derived ALMA principle |
| --- | --- | --- | --- |
| Files | Search, project/workspace scopes, and a video asset collection were visible. | Upload progress, validation failures, duplicate handling, and storage limits were not exercised. | One ingestion tray with truthful validation, provenance, upload progress, deduplication, and retry. |
| Speech | Voice selection, model selection, script input, and Generate were visible. | Consent, lifecycle, revocation, and cost confirmation were not exposed in the inspected state. | Preserve ALMA’s owner-only voice consent/version/revoke controls beside the speech tool. |
| Video | Image, Video, and Lip sync modes; history; starting/ending frame; references; prompt; model; aspect; resolution; duration; audio; count; remaining quota; Generate. | Generation outcomes and reference-strength behavior were not exercised. | Present provider/model fidelity settings in an advanced drawer, with estimate and approval before any paid queue. |
| SFX | Search/explore/categories, prompt, loop, duration, influence, and per-generation credit cost. | Failure/retry and output insertion behavior were not exercised. | Show expected cost and destination track before generation. |
| Music | Marketplace/search/categories/history, prompt, model, candidate count, length, lyric and fine-tune controls; a loading state appeared. | License semantics, marketplace acquisition, generation, and edit behavior were not exercised. | ALMA should retain the owner-approved music library and make license/approval state explicit. |
| Text | Multiple typography style presets were visible. | Fine-grained type animation and font-rights behavior were not exercised. | Text and caption styling should be reusable brand tokens, not free-form drift. |
| Image | Image creation is reachable from the Studio home and Video panel references. | A full image editing panel was not directly inspected. | ALMA’s image generation, finishing, repair, masks, templates, and QC must remain first-class. |

### Reels, short-form, and long-form workflows

- **Observed:** the Studio home offered quick starts for faceless video, captions, dubbing, voiceover, video-to-music, generated audio, and long-form audio.
- **Observed:** the existing project used a vertical composition and timeline, demonstrating a short-form video layout.
- **Observed:** project creation distinguishes audio and video while the editor combines media tools.
- **Inferred:** templates probably preconfigure tracks and generation steps; creation, publish, and completion behavior were not exercised.
- **ALMA implication:** project presets should configure aspect, safe zones, target length, caption style, recipe, and deliverables, while leaving one coherent editor. The existing 6/16/24-second reels and 15/30/60-second owned-video recipes should become named composition presets rather than separate islands.

### Canvas, player, and multi-track timeline

- **Observed:** the center contains a vertical player/canvas, aspect selection, caption control, time display, transport, speed, skip controls, split clip, zoom, collapse, and mute.
- **Observed:** the bottom timeline showed video thumbnails and an audio waveform synchronized to a playhead.
- **Observed:** a player state indicated playback could continue while clips ahead were generated.
- **Observed on mobile:** canvas, transport, and timeline remain available; tool panels collapse into compact controls and bottom tabs, while the timeline becomes horizontally dense.
- **Inferred:** snapping, ripple edits, magnetic alignment, transitions, multi-select, grouped edits, and frame-accurate keyboard trimming were not established.
- **ALMA implication:** the demo and production design should expose a shared playhead across video, overlay/image, captions, voice, music, and SFX tracks. ALMA-specific status chips—source version, QC, render state, and cost—belong on clips or their inspector.

### Captions and transcript

- **Observed:** Captions is a direct editor control.
- **Observed:** speech, voice, and text tools are adjacent to video editing.
- **Inferred:** transcript search, word-level timing, style application, speaker detection, and partial rerender behavior were not safely exercised.
- **ALMA implication:** preserve CSE5’s timed transcript, caption/voice lines, partial rerender, position, and cover controls, but place them on a caption track and transcript panel synchronized with the canvas.

### Clip operations, history, undo, and rollback

- **Observed:** split clip is exposed in the player; global undo and redo buttons are present.
- **Observed:** the inspected Agent conversation described a retimed clip and then an undo that restored the full 1:43 footage.
- **Observed:** undo/redo were disabled in the current visible state.
- **Not observed:** a structured operation list, before/after diff, durable rollback point, or explicit approval checkpoint for Agent-applied edits.
- **ALMA implication:** all human and Agent edits should use the same deterministic operation schema. Every operation needs an ID, actor, target version, before/after payload, timestamp, cost/external-effect classification, and inverse operation.

### Export and share

- **Observed:** comments, Share, and Export controls are prominent in the top bar; remaining credits are visible near them.
- **Inferred:** permissions, render presets, watermark rules, export queues, and link expiration were not exercised.
- **ALMA implication:** Review, Share preview, and Export should be separate actions. Export is a render job with truthful state; external publish is a separate owner-gated delivery with dry-run and pinned asset version.

### Studio Agent / Architect

| Pattern | Evidence | ALMA response |
| --- | --- | --- |
| The Agent is adjacent to the editor, not a detached chatbot. | Observed right panel and mobile Agent entry | Keep selection, playhead, project, brand recipe, and review context available to the Agent. |
| Agent mode can switch between Create and Plan. | Observed | Default ALMA to Plan. Paid generation and external effects may never be silently executed. |
| Agent asks project and audience questions before proposing a reel direction. | Observed conversation | Ask only missing, outcome-changing questions; otherwise create a reviewable plan. |
| Conversation referenced a retime and an undo restoring full footage. | Observed conversation | Translate natural language into deterministic edit operations, not opaque chat claims. |
| Agent credits used were displayed. | Observed | Show estimate before paid work and actual cost after a provider result, linked to its operation and asset version. |
| Analysis repeatedly failed and the Agent described the persistent error instead of asserting success. | Observed | Preserve truthful failure states, safe retry, and a non-destructive manual fallback. |
| Structured diff, plan approval, operation-level permission, and rollback artifacts were not visible. | Not observed | Make these mandatory ALMA differentiators. |

#### Required ALMA Agent protocol

1. **Interpret:** bind the owner’s instruction to a project, selection, playhead range, brand recipe version, and current document version.
2. **Plan:** emit a typed list of deterministic operations. Separate local `$0`, paid generation, destructive, and external-publish effects.
3. **Review:** show before/after fields, affected tracks/assets, estimated cost, required role, and validation warnings.
4. **Confirm:** owner approves the exact plan; any changed cost or target invalidates approval.
5. **Apply:** execute only approved local operations. Paid jobs and external effects require their own explicit confirmation and server-side capability gate.
6. **Verify:** compare resulting document version/artifact to the operation contract. Never claim completion from a queued status.
7. **Audit and rollback:** store operations and inverses, surface undo/redo, and create a durable rollback point for multi-operation plans.

### Loading, error, and credit states

- **Observed:** remaining credits in the editor header, per-action credit cost in SFX, Agent credits used, a Music loading state, disabled controls, and repeated Agent analysis errors.
- **Inferred:** offline recovery, insufficient-credit checkout, provider throttling, and export/render retry were not exercised.
- **ALMA implication:** keep CSE1’s truthful state vocabulary. A job is queued, running, failed, needs review, or has a verified artifact; “done” is only allowed with an artifact. Cost caps and provider kill switches remain server-enforced.

### Keyboard, responsive behavior, and accessibility

- **Observed:** Architect exposes “Skip to content,” semantic navigation, links, lists, and a visible Command-K search hint.
- **Observed:** editor controls were generally semantic buttons/tabs and remained available at 390 × 844.
- **Observed limitation:** several editor buttons and comboboxes had no useful accessible name in the inspected accessibility snapshot.
- **Observed limitation:** no `aria-keyshortcuts` or explicit keyboard shortcut inventory appeared in inspected DOM.
- **Observed limitation:** the mobile timeline was usable but visually compressed and horizontally dense.
- **ALMA requirements:** labelled controls, focus-visible styling, logical landmarks, live regions for plan/render state, keyboard transport/split/undo/redo, reduced-motion support, color-independent status, minimum touch targets, and a mobile “focus mode” that shows canvas, timeline, or inspector rather than squeezing all three.

### Visual system

ElevenLabs uses a quiet neutral shell, strong whitespace, thin dividers, compact controls, and one clear active surface. Its hierarchy comes primarily from layout and proximity, not decoration. ALMA should adopt that discipline while using an original system:

- graphite workspace and warm ivory canvas;
- ALMA coral for creation/selection, teal for verified/safe, amber for review/cost, and red only for blocked/failed;
- Bengali-capable interface type with mono numerals for timecodes, IDs, costs, versions, and worker state;
- small radii and controlled elevation rather than floating-card saturation;
- persistent provenance and status without exposing raw implementation noise by default.

## Current ALMA inventory and IA mapping

The following matrix is the parity contract. “New home” describes where each existing capability belongs; it does not authorize implementation or removal of the current UI.

| Current capability | CSE source | New enterprise Studio home | Preservation rule |
| --- | --- | --- | --- |
| Brand switcher, brand notes, spend threshold | CSE6 | Top project context; Brand settings in left panel | Role-scoped; owner manages thresholds |
| Project create/select, folders, tags, search, legacy attach | CSE3 | Project home + left Projects panel | Existing ownership and legacy-read-only semantics |
| ERP product selection and source linkage | CSE3 | Project context + Assets/Product drawer | Product code and source provenance remain immutable |
| Locked, versioned brand recipes | CSE3 | Top recipe selector + inspector Recipe tab | Jobs pin recipe version; lock remains explicit |
| Project/workspace assets and catalog | CSE2/3 | Left Assets/Library panel | Project scope and reusable library are distinct |
| Saved models, default model, family roles | existing/CSE3 | Library > Models; generation inspector | Role/preset meaning preserved |
| Multi-angle avatar and AI brand model | existing | Library > Models/Avatars | Provider cost and canonical-source provenance visible |
| Advanced image workflows | existing/CSE1 | Image tool + inspector | Product-to-model, try-on, model swap, face-to-model, edit, masked repair, image-to-video, text-to-image |
| Auto product workflow | existing/CSE3 | Quick action + Agent plan template | Uses saved default model and pinned recipe |
| Campaign Pack preview/manifest | CSE4 | Project deliverables panel + Agent plan | Deterministic manifest before queue |
| Campaign Pack drafts, selection, stages, retry | CSE4 | Timeline versions + Jobs drawer | Two drafts, isolated lineage, stage-only retry |
| Image engine/provider selection | CSE1 | Inspector > Engine (advanced) | Health, research-only labels, direct/Fal distinction |
| Background/aspect/resolution/count/mask/prompt | existing/CSE1 | Image inspector | Validation and cost remain truthful |
| Gallery filters, paging, Drive state, QC | CSE1 | Left Assets panel + filter drawer | Tests hidden by default; failed QC unmistakable |
| Asset viewer provenance, request/seed/latency/cost | CSE1/3 | Inspector > Provenance | Read-only audit facts |
| Finishing, branded/original, lifestyle layout, cover | existing/CSE3/5 | Canvas layers + inspector + timeline | Derived versions preserve lineage |
| Feedback weights and generation retry | existing/CSE7 | Review/Inspector + Agent plan | Deterministic signals; no silent provider switch |
| Reels 6/16/24 seconds | existing/CSE5 | Video preset + timeline composition | Multi-clip lineage and provider cost gate |
| Owned-video edit 15/30/60 seconds | CSE5 | Video project presets | Upload ownership/provenance and hard recipes |
| Captions, safe zones, crop/focus, cover | CSE5 | Canvas guides + caption/video tracks + inspector | Partial rerender by domain |
| Original/music/voice volumes and stings | CSE5 | Audio tracks + mixer inspector | Owner-approved music only |
| Timed transcript and dubbing | CSE5 | Transcript panel + captions/voice tracks | Segment timing and partial rerender |
| AI highlight suggestions | CSE5 | Agent suggestion plan | Suggestion only until owner applies |
| Music, wish song, owner voice, dubbing, changer, clean voice, SFX | CSE5 | Voice/Music/SFX tools and tracks | Estimate + explicit confirmation + hard cap |
| Voice consent, immutable versions, activate/revoke/provider delete | CSE5 | Library > Voices + Voice inspector | Owner-only, audited, never autonomous/customer-facing |
| Roles owner/creator/reviewer and assignments | CSE6 | Workspace settings + contextual capability labels | Server-side capability checks remain authoritative |
| Draft/changes requested/revised/approved | CSE6 | Review rail + version header | Approval pins exact version; new version invalidates |
| Review comments and immutable events | CSE6 | Comment pins + Activity/Audit panel | Append-only |
| Distribution dry run, schedule, publish controls | CSE7 | Share/Export/Publish flow | Dry run `$0`; Meta live switch off by default; explicit owner confirmation |
| Pinned asset/review/pack/idempotency/fingerprint | CSE7 | Publish review sheet | Server validates immediately before dispatch |
| Delivery receipt, cancel, safe retry, ambiguous outcome | CSE7 | Deliveries panel | Ambiguous external effects become `NEEDS_REVIEW` |
| Performance and exact-version attribution | CSE7 | Performance panel linked from project/version | Metrics append-only; deterministic weights |
| Retention, archive, fetch-back | CSE7 | Project lifecycle + Admin observability | Archive preserves provenance and restores safely |
| Worker heartbeat, provider health/balance, kill switches | CSE1/7 | Jobs drawer + Admin/Owner settings | Never hidden behind optimistic UI |
| Golden evaluations and child-garment cache | CSE1/3 | Admin quality panel | Owner-only operational control |
| Existing chat tools `run_creative_studio` / `check_studio_job` | existing | Creative Agent adapter | Queue is not completion; verified artifact required |

## Current ALMA strengths to preserve

- Server-side authentication and brand-scoped role checks on Studio APIs.
- Deterministic recipes and hard presets instead of unconstrained model taste.
- Immutable or version-pinned provenance from ERP product through asset, finish, review, delivery, and metrics.
- Explicit spend estimate/confirmation and hard caps for Audio Lab and campaign generation.
- Research-only/provider-health/kill-switch visibility.
- QC failure that blocks promotion while retaining diagnostic access.
- Dry-run-first distribution, live publishing off by default, idempotency, receipts, safe retry, and ambiguous-effect quarantine.
- Owner-only voice lifecycle and role administration.
- Append-only review, audit, and performance evidence.

## Current information-architecture and workflow problems

1. **Five destinations behave like separate products.** Studio, Gallery, Video, Audio, and Library each establish a new local hierarchy and action vocabulary.
2. **Asset and composition are separated.** A user selects or creates media in one place, then opens another panel or flow to finish, sequence, review, or distribute it.
3. **Project context consumes header space but does not organize the entire workspace.** Brand/project/product/recipe/folder controls read as an administrative form rather than a navigational model.
4. **The gallery is powerful but visually flat.** Operational details, filters, status, creation actions, and asset content compete at the same level.
5. **Timeline editing is a downstream feature.** It should be the synchronized editing surface whenever time-based media, captions, voice, music, or SFX are present.
6. **Enterprise controls are discoverable late.** Cost, QC, review, publish eligibility, and version lineage should appear before the user commits an action.
7. **The current Agent tool queues creative jobs but does not expose a document-edit command protocol.** Its self-verification contract is strong; its interaction model needs plan/diff/apply/rollback.

## Original ALMA enterprise Studio concept

### Workspace anatomy

1. **Global project bar:** back to projects, brand/project path, product and recipe pins, current version/review state, undo/redo, collaborators/comments, Share, Export.
2. **Tool rail:** Select, Image, Video, Voice, Music, SFX, Text/Captions, Agent.
3. **Left contextual panel:** project tree, folders, assets, ERP catalog, saved models/voices/music, templates/recipes, uploads, job state.
4. **Central stage:** canvas/player, aspect and safe-zone controls, selection overlays, truthful preview quality, transport.
5. **Bottom timeline:** Video, Image/Overlay, Captions, Voice, Music, and SFX tracks; shared playhead; clip status and version indicators.
6. **Right workbench:** Inspector, Agent, Review, Activity. The same selection drives all four.
7. **Enterprise drawers:** Jobs, Deliverables, Performance, Audit, Workspace settings.

### Selection and command model

Every visible object maps to a stable document node. Clicking an asset, canvas layer, timeline clip, caption, or Agent operation selects the same node and opens the same inspector. Human controls and Agent plans emit commands through one command bus. Commands validate project version, role, cost, provider health, QC, and external-effect class before execution.

### Responsive model

- **≥ 1280 px:** simultaneous left panel, stage/timeline, and right workbench.
- **768–1279 px:** left and right panels become mutually exclusive drawers; stage and timeline remain primary.
- **< 768 px:** focus modes for Stage, Timeline, Assets, and Agent; persistent transport and current selection; no miniature four-pane layout.

## Observed gaps and risks

| Risk | Why it matters | Mitigation required before production |
| --- | --- | --- |
| Existing UI actions and Agent tool paths do not share a single operation schema. | Undo, diff, and audit can diverge. | Introduce versioned document commands and adapters before migrating screens. |
| Several current flows create their own pending-action payloads. | Parallel work can produce inconsistent cost/permission gates. | Central command validation and effect classification. |
| Provider workstreams will touch image dimensions, model selection, payloads, gallery metadata, and workers. | High merge and contract-conflict risk. | Provider-neutral document/operation contracts; integrate by adapter and capability manifest. |
| Timeline-lite stores domain-specific edits rather than a general composition graph. | Multi-track editing and Agent targeting need stable nodes and time ranges. | Add a composition document beside the legacy timeline; dual-read during migration. |
| Production publishing already exists behind strong gates. | A visually prominent Export/Share redesign could accidentally blur export and publish. | Separate local render, share preview, schedule, and external publish at API and UI levels. |
| Voice cloning is especially sensitive. | Agent convenience cannot weaken consent/revocation. | Keep existing owner-only lifecycle; Agent can only reference active approved versions. |
| Mobile density can obscure cost and approval context. | A hidden warning becomes a security defect. | Cost/permission summary is a mandatory step, not a dismissible side panel. |

## Audit conclusion

The redesign is viable without discarding CSE1–CSE7. The safe path is to add a new composition/command layer and editor shell behind a feature boundary, adapt existing generation, review, publish, and performance services to it, and keep the current Studio available until parity certification. The live demo on this branch is deliberately a `$0`, fixture-driven interaction prototype; it is not evidence that generation, rendering, or external publishing has been reimplemented.
