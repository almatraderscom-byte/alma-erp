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
parameter never grants access. The page obtains the authenticated actor,
accessible brand assignments, and any requested project relationship on the
server before calling `resolveCreativeStudioV3RouteDecision`.

- `?studio=legacy` renders the legacy Studio only for a system owner.
- An admitted owner, creator, or reviewer gets V3 with the role for the selected
  accessible brand.
- An unassigned actor, inaccessible brand/project query, or non-owner legacy
  request fails closed.
- A non-admitted owner falls back to legacy; a non-admitted collaborator fails
  closed.

The client may remember an active brand ID in local storage, but accepts it only
when the authenticated `/api/assistant/creative-studio/brands` response returns
the same ID. Brand changes remount Home, both Labs, Gallery, Finishing, and every
capability desk, causing each surface to re-request its data.

## Production adapter truth

`CreativeStudioV3ProductionPort` connects the current production clients. Its
brand argument is explicit on every applicable read, but it does not claim a
server filter where none exists.

| Resource | Current production truth |
| --- | --- |
| Accessible brands | Access-scoped for owner/creator/reviewer; authoritative |
| Projects | Legacy owner-only endpoint; successful rows are presentation-filtered by canonical `brandProfileId` |
| Recipes | Legacy owner-only endpoint; `brandProfileId` is server-enforced for the owner |
| Gallery/media | Legacy owner-only; no brand key/filter |
| Saved models/avatars | Legacy owner-only; no brand key/filter |
| Voice, owned video, music | Legacy owner-only; no brand key/filter |
| Review thread/transitions | Access-scoped when called with a canonical project asset and brand |
| Performance | Access-scoped and brand-scoped |

Creator/reviewer journeys are admitted and correctly labelled, but controls
that would call an owner-only upload, generation, finishing, audio, voice, or
campaign route remain disabled. The UI does not optimistically call those
routes and does not fabricate collaborator data.

## Exact Foundation integration hooks

No unavailable feature is simulated. The following interfaces are the intended
connection points:

### Composition commands

Implement `CreativeStudioV3FoundationPort` from
`src/agent/components/creative-studio-v3/types.ts`:

- `openComposition({ projectId, brandProfileId })`
- `planOperations({ compositionId, expectedVersion, instruction })`
- `applyLocalOperations({ compositionId, expectedVersion, planId, fingerprint })`
- `rollback({ compositionId, expectedVersion, targetVersion })`

The adapter must preserve the returned `concurrencyToken`, version, plan
fingerprint, effect class, estimated cost, and audit ID. The disabled
“Long-form” and “Open composition” affordances are the UI attachment points.

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
IDs.

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
- Editor integration must use canonical composition/project-asset versions and
  optimistic concurrency, not Gallery IDs.
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

The captures live outside the application source tree in the Codex
visualizations workspace.

## Verification performed

- V3 contracts: 6 files / 25 tests passed.
- Complete Creative Studio suite: 37 files / 237 tests passed.
- Targeted ESLint: passed without findings.
- Repository `npm run lint`: passed; existing unrelated warnings remain.
- `npm run type-check`: passed.
- Optimized `next build`: passed. Existing OpenTelemetry/Sentry dynamic-import
  warnings and missing local `DATABASE_URL` notices were non-fatal.
- Browser: desktop, tablet, and 390-pixel layouts had no document-level
  horizontal overflow, runtime overlay, or console error. Keyboard activation
  of the skip link focused `#creative-studio-v3-main`; reduced-motion overrides
  are present in the production stylesheet.
