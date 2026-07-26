# Creative Studio V3 production UI handoff

## Scope

Workstream U adds the production presentation/client layer under
`src/agent/components/creative-studio-v3/` and the minimum route/middleware
integration. It does not change Prisma, migrations, workers, provider adapters,
composition services, publish/retention services, or the locked demo route.

The legacy Studio remains the immediate owner-only fallback.

## Server rollout and route admission

V3 is default-off. Admission requires:

1. `CREATIVE_STUDIO_V3_UI_ENABLED=1`; and
2. one server-side match in `CREATIVE_STUDIO_V3_OWNER_IDS`,
   `CREATIVE_STUDIO_V3_BRAND_IDS`, or `CREATIVE_STUDIO_V3_PROJECT_IDS`.

Each allowlist is comma-separated and may explicitly contain `*`. A query
parameter never grants access. The page obtains the authenticated actor, exact
Studio role for the selected brand, accessible brand assignments, and
access-sanitized projects on the server before calling
`resolveCreativeStudioV3RouteDecision`. V3 receives the server-derived actor
user ID and account label; no client body or query supplies actor or role
authority.

- `?studio=legacy` renders the legacy Studio only for a system owner.
- An admitted owner, creator, or reviewer gets V3 with the role for the selected
  accessible brand.
- An unassigned actor, inaccessible brand/project query, or non-owner legacy
  request fails closed.
- A non-admitted owner (including an owner with no V3 brand assignment) falls
  back to legacy; a non-admitted collaborator fails closed.

The client may remember an active brand ID in local storage, but accepts it only
when the authenticated `/api/assistant/creative-studio/brands` response returns
the same ID. Brand changes update the server route and clear any project query,
then remount Home, both Labs, Gallery, Finishing, and every capability desk.
The next server render supplies a newly sanitized project list and initial
project. A remembered ID cannot grant access.

## Production adapter truth

`CreativeStudioV3ProductionPort` connects the current production clients. Its
brand argument is explicit on every applicable read, but it does not claim a
server filter where none exists.

| Resource | Current production truth |
| --- | --- |
| Accessible brands | Access-scoped for owner/creator/reviewer; authoritative |
| Route project context | Loaded server-side only after accessible-brand resolution, then filtered to those canonical brand IDs |
| Owner project enrichment | Legacy owner-only endpoint; successful rows are presentation-filtered by canonical `brandProfileId` |
| Recipes | Legacy owner-only endpoint; `brandProfileId` is server-enforced for the owner |
| Gallery/media | Legacy owner-only; no brand key/filter |
| Saved models/avatars | Legacy owner-only; no brand key/filter |
| Voice, owned video, music | Legacy owner-only; no brand key/filter |
| Review thread/transitions | Access-scoped when called with a canonical project asset and brand |
| Performance | Access-scoped and brand-scoped |

Creator/reviewer journeys are admitted and correctly labelled, but controls
that would call an owner-only upload, generation, finishing, audio, voice, or
campaign route remain disabled. The UI does not optimistically call those
routes and does not fabricate collaborator data. Their Home and Projects
surfaces use only the server-supplied accessible project rows; they never call
the legacy owner-only `/projects` client endpoint and never turn a 403 into a
misleading empty project state.

## Foundation composition and Editor integration

The accepted Editor/Foundation SHA
`8e89f2082d229b5e3f0d12c83064cf514869f2a3` is a true parent of the integration
merge `ed747bb9233c8ab8667d16353833a7236719d800`.

Foundation remains separately default-off:

- `CREATIVE_STUDIO_V3_FOUNDATION_MODE=shadow|enforce` enables access-scoped
  composition reads.
- Only `CREATIVE_STUDIO_V3_FOUNDATION_MODE=enforce` together with
  `CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENABLED=true` enables writes.
- `off` and `rollback` keep composition reads disabled. The legacy owner
  fallback remains available independently.

`CreativeStudioV3CompositionClient` is the focused production client:

- `listCompositions({ brandProfileId, projectId })` calls the access-scoped
  Foundation list route.
- `createComposition(...)` sends only exact scope, title, and a deterministic
  idempotency key; actor and role are derived by the server.
- `getComposition(...)` validates exact composition/brand/project scope and
  the complete Foundation view.

Home “Long-form” prefers the initial project selected by the server. Projects
“Open composition” uses the actual selected accessible project. Both reuse the
canonical newest composition, safely recover a stale list or ambiguous create
response by re-listing, and create only when the authenticated role and
Foundation write rollout permit it. Reviewer discovery never attempts create.

`StudioV3EditorJourney` mounts `CreativeProjectEditor` with:

- one stable `createFoundationCompositionCommandPort` instance per exact
  brand/project/composition scope;
- the server-derived actor user ID and the Foundation-returned access role;
- the exact server-validated composition scope;
- `generationProvider={null}` and `voice={null}`;
- reviewer or write-off presentation read-only behavior, with Foundation
  rejection remaining authoritative;
- clean return to the originating Home or selected Projects context.

Agent plans compile only reversible, local `৳0` operations. Provider, voice,
render/export, publish, and lifecycle review methods are absent from the Studio
composition client.

### Snapshot enrichment truth

`loadCreativeStudioV3EditorSnapshotContext` enriches canonical Foundation pins
only from existing production reads:

- exact pinned project asset/version metadata when the owner-only asset
  catalog is available;
- artifact descriptor and delivered/requested resolution metadata;
- reference contract only when an exact stored contract exists;
- immutable source-lineage edges;
- recorded provider, engine, QC, and cost metadata;
- access-scoped review/activity only after canonical project asset IDs exist.

If owner-only asset enrichment rejects a collaborator, canonical Foundation
pins remain visible and project assets, review, activity, and durable history
are explicitly marked `not_hydrated`. No placeholder artwork, comments,
approval, activity, or success count is substituted. Foundation GET does not
yet expose a durable paginated history/depth feed, so prior history is always
labelled not hydrated; mounted-session receipts remain authoritative.

## Remaining exact integration hooks

### Review queue

Implement `CreativeStudioV3ReviewQueuePort.listReviewQueue` with server-enforced
brand/project access. Every row must return the canonical:

- `projectAssetId`
- `projectId`
- `brandProfileId`
- `currentVersionId`
- `expectedSequence`
- review `state`

The existing exact-asset review endpoint can then open/transition the returned
asset. Gallery job IDs must never be substituted for project asset or version
IDs. Lifecycle Review and Operations mutations remain disabled until the
corrective backend task supplies these exact ports.

### Collaborator-safe content reads and commands

Replace the corresponding `CreativeStudioV3ProductionPort` adapter methods when
Foundation exposes access-scoped contracts:

- `listProjects(brandProfileId)`
- `listRecipes(brandProfileId)`
- `listGallery(query, brandProfileId)`
- `listModels(brandProfileId)`
- `listVoices(brandProfileId)`
- `listVideoUploads(brandProfileId)`
- `listMusicTracks(brandProfileId)`
- upload, image/video queue, finishing, audio, voice, and Campaign commands

The server must derive actor/role and verify the requested brand; accepting a
client brand ID is not authorization. Once a collaborator-safe method is wired,
remove only the matching owner-only UI disablement.

### Remaining capability gaps

- Gallery archive listing needs an access-scoped cursor/lifecycle contract.
- Video end-frame and explicit mute/generated-audio controls need declared
  provider capabilities.
- Collaborator asset hydration needs an access-scoped project-asset list; the
  current owner-only read is optional enrichment only.
- Foundation GET needs durable history/depth and paginated activity contracts
  before those states can be hydrated across sessions.
- Publish/retention commands remain outside this workstream and must continue to
  use their existing server gates.

## Visual evidence

Evidence was captured with a temporary local-only harness using the exact
production V3 components, then the harness route and its development middleware
bypass were removed before commit. No fixture route ships in the branch.

- `creative-studio-v3-home-desktop.png`
- `creative-studio-v3-gallery-desktop.png`
- `creative-studio-v3-image-lab-tablet.png`
- `creative-studio-v3-image-lab-390.png`
- `creative-studio-v3-editor-desktop.png`
- `creative-studio-v3-editor-tablet.png`
- `creative-studio-v3-editor-390.png`

The captures live outside the application source tree in the Codex
visualizations workspace.

## Verification performed

- Targeted V3/Editor/Foundation contracts: 11 files / 62 tests passed.
- Complete Creative Studio suite: 51 files / 334 tests passed.
- Complete repository suite: 520 files / 4,692 tests passed.
- Targeted ESLint: passed without findings.
- Repository `npm run lint`: passed; existing unrelated warnings remain.
- `npm run type-check`: passed.
- Optimized `next build`: passed. Existing OpenTelemetry/Sentry dynamic-import
  warnings and missing local `DATABASE_URL` notices were non-fatal.
- The React checklist passed for hook stability, stable port lifetime,
  semantic controls, disabled reviewer mutations, error recovery, focus
  management, responsive layout, and reduced motion.
- Browser: 1440×1000, 1024×900, and 390×844 Editor layouts had exact
  document/viewport width parity, no runtime overlay, and no console error.
  The reviewer view exposed six disabled mutation controls; keyboard shortcut
  `4` switched to workbench focus. The only console warnings were the expected
  non-shipping local watermark notices.
