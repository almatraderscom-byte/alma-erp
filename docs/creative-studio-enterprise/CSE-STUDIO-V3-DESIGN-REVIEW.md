# Creative Studio Enterprise V3 — correction log and Aura audit

Date: 2026-07-26

Scope: isolated owner-reviewable prototype; no production implementation approval
Branch: `codex/cs-enterprise-studio-demo`

## Decision

V2 is rejected as the owner’s implementation baseline. V3 keeps the useful V2 Home and deterministic Editor operation model, but replaces the incorrect creation entry, restores the omitted production surfaces, and makes the demo reviewable as a complete Studio product.

The ElevenLabs references were inspected at original detail only for interaction principles: creation begins in an Explore surface with sources around a configuration composer, while a timeline editor is a later level. No branding, copy, artwork, or layout was copied.

## V2 failure postmortem

| V2 failure | Concrete problem | V3 correction |
| --- | --- | --- |
| Creation and editing were conflated | Image and Video/Reel opened a shallow “starting point” dialog and then the populated timeline Editor. The owner could not evaluate the real creation workflow. | Image and Video/Reel now open full Image Lab and Video Lab workspaces. The Project Editor remains a later path from an existing project, long-form entry, or Agent orchestration. |
| The dialog was not a usable product surface | It exposed a few labels but no Explore/History, source browsing, saved identities, templates, provider truth, or mode-aware configuration. | Each Lab has Explore/History, an identity rail, approved recipes/templates, eligible gallery sources, and a persistent capability-aware composer. |
| Current Auto/Advanced behavior disappeared | V2 did not make Generate, Product → Model, Try-On, Swap, Face, Edit, Reel, family, product, model, reference, background, aspect, provider, resolution, quality, count, or cost choices usable. | Image Lab restores the two production architectures and all seven real submodes. Requirements and provider/resolution options recalculate when the mode changes. |
| Video was reduced to an editor entry | There was no source-first creation contract, model/duration/resolution compatibility, start/end frames, audio choice, count, or source-to-video story. | Video Lab starts with Gallery/Avatar/template selection and then constrains model, duration, delivered resolution, aspect, frames, prompt, audio, candidate count, and estimate. |
| Identity models were absent from the product hierarchy | Existing `ModelLibraryView` avatars and saved models were only mentioned in parity copy. | Brand-isolated avatars/saved models are prominent on Home and both Labs, with New/View all and selection into Image or Video configuration. |
| Gallery was an entry label, not an organized library | The owner could not inspect all media types, provenance, workflow state, or a dense alternative to production’s oversized cards. | Gallery now supports Image, Video, Audio, Voice, Avatar, and Project; Recent/Approved/Review/Archived views; search, filters, sort, metadata, selection actions; and Large/Comfortable/Compact/List density. |
| Finishing was missing | V2 omitted the owner’s current image finishing, mask repair, Timeline Lite, transcript, and motion-template tools. | Finishing is a complete workspace with source versioning, non-destructive image layout preview, the exact mask presets, the exact Timeline Lite edit families, and the exact five video overlay templates. |
| Enterprise parity was often a toast or status card | Reviews, campaigns, projects, recipes/models, distribution, attribution, retention, workers, owner policy, Voice, and Audio were visible but not meaningfully inspectable. | Every primary Home/sidebar entry now opens a dedicated owner-reviewable desk or complete workspace. No primary card ends in a “represented” toast. |
| Gallery density and mobile composition were not solved | V2 did not address the owner’s production pain of seeing too few assets. Some responsive layouts merely stacked content. | Compact Gallery shows materially more assets while preserving aspect and metadata. Desktop, 1024px tablet, and 390×844 mobile have distinct navigation and composition rules with zero document overflow. |

## Fresh production inventory evidence

V3 was based on a new authenticated read-only inspection of `/agent/creative-studio` plus the current source, not on V1/V2 memory. The inventory included:

- `CreativeStudioShell` navigation: Studio, Gallery, Video, Audio, and Library;
- `StudioWorkspaceView`: Auto and Advanced, seven exact modes, products, saved models, family presets, templates, engines, backgrounds, aspects, requested resolution, quality/count, masked edit, and optional Reel;
- `GalleryView`, `FinishPanel`, `LifestyleEditor`, and `MaskEditor`;
- `VideoStudioView`, `VideoFinishPanel`, `TimelineLite`, and `TranscriptEditor`;
- `AudioLabView`, `VoiceLibrary`, and `ModelLibraryView` including `AvatarSheet`, model creation, and Finishing;
- `ProjectBar`, `ProjectLibraryView`, `BrandRecipeEditor`, `CampaignPackPanel`, `ReviewPanel`, `PublishPanel`, `PerformanceView`, `StudioSettingsView`, and `StudioRoleSettings`;
- the corresponding CSE1–CSE7 contracts, APIs, policy, provider registry, workers, job/retry, cost, archive, and evaluation tests.

The exact source-to-V3 mapping is in `CSE-STUDIO-V3-PARITY-MATRIX.md`.

## Aura design-system audit

### Exact tokens reused

| Aura source | Exact repository token/pattern | V3 use |
| --- | --- | --- |
| `src/app/globals.css` | `--c-accent: 224 122 95`, `--c-accent-lt: 244 162 140`, `--c-accent-dim: 196 90 60` | Coral active navigation, primary actions, selection, focus, and restrained status emphasis |
| `src/app/globals.css` | light `--bg-0: #FAF9F6`, `--bg-1: #FFFFFF`, `--bg-2: #F8F7F4`, `--bg-3: #F3F2EF` | Page, raised surface, inset control, and workspace-layer hierarchy |
| `src/app/globals.css` | dark `--bg-0: #141418`, `--bg-1: #1C1C22`, `--bg-2: #232329`, `--bg-3: #2A2A31` | Token-driven dark compatibility; no unrelated dark palette |
| `src/app/globals.css` | `--c-ink`, `--c-muted`, `--c-muted-hi` | Theme-aware primary, secondary, and tertiary type |
| `src/app/globals.css` | `--border`, `--border-subtle`, `--border-strong` | One-pixel surface/selection hierarchy rather than decorative outlines |
| `src/app/globals.css` | `--radius-sm: 10px`, `--radius-md: 14px`, `--radius-lg: 20px`, `--radius-card-feel: 18px`, `--radius-composer: 24px`, `--radius-pill` | Controls, cards, high-value composers, and compact pods |
| `src/app/globals.css` | `--frost-surface`, `--frost-blur: 20px`, `--shadow-float: 0 4px 24px …` | Header/navigation pods and only the few surfaces that require elevation |
| `src/app/globals.css` | `--font-sans` = Inter + Noto Sans Bengali + Hind Siliguri; `--font-mono-nums` = JetBrains Mono | Product copy/Bengali and technical timecode, versions, fingerprints, cost |
| `src/app/globals.css` | `--motion-enter: 180ms`, `--motion-exit: 120ms`; reduced-motion rules | Short opacity/translate feedback with all nonessential motion disabled under `prefers-reduced-motion` |
| `src/app/globals.css` | 16px mobile form controls | No iOS focus zoom in the 390px layout |
| `StudioUi.tsx` | state badges, loading/empty/error hierarchy, confirmations, repository SVG conventions | Calm status language, skeleton/empty/error treatments, semantic vector controls |

### Composition rules derived from ALMA

- A small coral active state sits inside warm neutral surfaces; coral is not used as a large decorative gradient.
- Borders establish most hierarchy. Shadows are reserved for the composer, top pod, and owner-critical elevated surfaces.
- The type scale is compact but deliberate: workspace title, section title, item title, metadata, technical label.
- Status colors communicate success, warning, failure, information, and lock states; they do not become a multi-color dashboard theme.
- Buttons use primary, secondary, text, icon, and blocked/disabled levels with the same radii and focus ring.
- Artwork in the prototype is abstract fixture media built from neutral/coral tokens. It does not simulate successful provider output.
- Every interactive element has a semantic button/input role, visible `:focus-visible` treatment, and a readable disabled reason at the decision point.

## V3 information architecture

### Level 1 — Studio Home

- active brand and strict-isolation context;
- global search;
- direct Create entries for Image, Video/Reel, Voice, Audio, Campaign Pack, and Long-form;
- asset/catalog/identity lane and Gallery entry;
- recent projects with lifecycle, collaborator, review, and activity state;
- recipes, templates, saved models, and campaign workflows;
- Creative Agent plan-only entry;
- review, dry-run/publish gates, attribution, retention/archive, worker, security, and cost signals.

### Level 2A — Create / Explore workspaces

- **Image Lab:** Explore/History → avatars/saved models → approved recipes/gallery → Auto or seven-mode Advanced composer.
- **Video Lab:** Explore/History → avatars/saved models → source/template gallery → model/duration/resolution/aspect/frame/audio composer.
- **Gallery:** media/view/filter/sort/density → asset detail → Create, Finish, or Edit handoff.
- **Finishing:** source version → image layout/mask repair or video Timeline Lite/motion-template tools.
- **Capability desks:** Projects, Recipes & Models, Review, Operations, Voice, Audio, and Campaign.

### Level 2B — Project Editor

- lifecycle/version/history/share/export boundary;
- left media rail and contextual assets;
- central stage/player;
- bottom video/captions/voice/music/SFX timeline;
- integrated Inspector/Creative Agent/Review panel;
- plan → fingerprint → acknowledgement → reversible ৳0 apply → audit → rollback;
- paid generation and external publish stay in separate blocked operation groups.

## Responsive and accessibility contract

- **1440 desktop:** persistent Home sidebar; two-column Lab with a readable fixed composer; dense Gallery; three-zone Finishing; full editor.
- **1024 tablet:** compact top navigation, adaptable Lab grid, and balanced content/composer widths.
- **390×844 mobile:** identity/search/navigation become compact horizontal task controls; Create uses a two-column tap grid; Labs preserve source/identity context before the composer; Editor uses explicit Media/Inspector/Agent panels.
- The document itself never scrolls horizontally; only intentional internal lanes may scroll.
- Landmarks, heading order, labels, tab/pressed/selected state, skip links, keyboard focus, 16px inputs, reduced motion, and safe-area spacing are explicit.

## Prototype truth boundary

The V3 may change only local fixture state. It does not upload, call providers, create jobs, generate, finish/render, export, write reviews, publish, or mutate production data. Unsupported resolution/model/duration combinations are disabled or explained. “4K” is never presented as a global supported result. Provider and publishing controls remain visibly disconnected.
