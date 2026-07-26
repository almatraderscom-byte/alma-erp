# Creative Studio V3 — Project Editor and deterministic Agent handoff

Status: implementation complete on `codex/cs-v3-editor-agent`

Date: 2026-07-26

## Ancestry and immutable references

- Required base: `887d016cd89fb3ce675bd87dd211b8b255b670e8`
- Pre-work tag: `pre-codex-cs-v3-editor-agent` at the required base
- Independent Editor/Agent core: `9e6ced5f`
- Safety and truth hardening: `cba08eff`
- Unified Editor presentation: `549cf605`
- Accepted Foundation dependency: `14b5ce17fcf746c479399657d6288cf224d84a17`
- Real merge commit: `739ae702`
- Foundation-backed production adapter: `882103fb`
- Locked interaction reference only: branch `codex/cs-enterprise-studio-demo` at
  `d346143bad100fd4cbd47b9958d50678b916b2dc`; no locked demo file was changed.

## Delivered boundary

The production Editor is a client presentation over the Foundation composition
source of truth. `CreativeProjectEditor` owns stage, synchronized tracks,
inspector, deterministic plan/diff/acknowledgement, keyboard behavior, focus
modes, and truthful pending-action presentation. It does not own authenticated
authority, persistence, provider execution, rendering, publishing, or durable
history.

`FoundationCompositionCommandPort` is the only production command adapter. It:

1. loads the authenticated Foundation composition for the exact
   brand/project/composition scope;
2. checks the returned identity, role, version, concurrency token, and document
   shape before projection;
3. compiles only reversible local operations into exported Foundation
   operation types;
4. calls Foundation validate before apply and compares the canonical server
   fingerprint with the apply receipt;
5. uses one deterministic idempotency key per exact proposal and safely replays
   it after an ambiguous/lost response;
6. delegates apply, undo, redo, and rollback to the authenticated Foundation
   transaction endpoints;
7. surfaces the Foundation operation-batch ID as the authoritative audit ID;
8. never exposes a provider, voice, render, export, or publish method.

The former in-memory adapter and rich fixture are absent from the production
barrel. Renamed command doubles and data live only under `__fixtures__` for
tests.

## Deterministic local operation mapping

| Editor proposal | Foundation operation |
|---|---|
| Caption text | `node.replace` |
| Caption timing | `clip.replace` |
| Visual trim | `clip.replace` |
| Split | `clip.remove` followed by two ordered `clip.insert` operations |
| Reorder | `track.replace` |
| Transform | `clip.replace`, preserving the existing width/height ratio |
| Video/voice/music/SFX volume | `clip.replace` with deterministic linear-gain ↔ dB mapping |

Every mapping carries node/track/clip selection and time-range audit metadata.
Variable-rate trim, shared caption-node fanout, unsupported aspect ratios,
positive gain, out-of-range transforms, ambiguous asset-version pins,
multi-canvas documents, invalid IDs, empty batches, and expanded batches over
the Foundation limit fail closed. The compiler has no paid or external action
input.

## Agent safety and truth contract

- Bengali and English instructions compile deterministically to typed
  proposals.
- The proposal fingerprint binds brand, project, composition, version/token,
  normalized instruction, targets, local operations, provider/model/payload,
  voice version, and pending cost/cap.
- Agent-originated local apply requires the authenticated owner role and exact
  owner acknowledgement of that fingerprint.
- Only `effect = local_reversible` and `estimatedCostBdt = 0` operations reach
  the command port.
- Paid generation, voice generation, render/export, and external publish remain
  separate pending actions. Blocked provider, invalid cost, exceeded cap,
  inactive/revoked/unconsented voice, and external publish states are never
  presented as confirmable local work.
- A queued, running, ambiguous, artifact-less, unverified, dimension-mismatched,
  or lineage-incomplete provider result is never reported complete.
- An executed result becomes complete only when its A+B artifact descriptor is
  verified and satisfies the required descriptor dimensions and lineage.

## CSE1–CSE7 and A+B preservation

| Contract | V3 preservation |
|---|---|
| CSE1 trust/cost | Truthful errors and unknown metadata; no queue insertion or spend from local apply |
| CSE2 modular shell | Focused Editor components and one typed command boundary |
| CSE3 Content OS | Exact brand/project scope, pinned asset versions, recipe/product projection, optional project-library enrichment |
| CSE4 campaign packs | Paid generation remains a separately confirmed pending action; no campaign job method exists |
| CSE5 editing/voice | Caption, trim, split, reorder, transform, and volume are local; voice generation/lifecycle remains outside the port |
| CSE6 review/multibrand | Server-derived role and brand authority, owner acknowledgement, read-only review, audit activity |
| CSE7 distribution | Publish is blocked/separate; local apply cannot schedule or deliver externally |
| CSE-A + CSE8 | Existing artifact descriptor and reference contract can enrich the projection unchanged; local edits never rewrite provider lineage |

## Exact parent integration hook

Create one stable port instance for the mounted composition and pass existing
CSE3/CSE6/A+B presentation data through `loadSnapshotContext`. The callback is
enrichment only; Foundation document identity/version and command authority
remain non-overridable.

```tsx
const commandPort = useMemo(
  () => createFoundationCompositionCommandPort({
    loadSnapshotContext: async () => ({
      brandName,
      assets: editorAssetReferences,
      review,
      activity: durableCompositionActivity,
      canUndo: durableHistory.canUndo,
      canRedo: durableHistory.canRedo,
    }),
  }),
  [compositionId],
)

<CreativeProjectEditor
  actor={authenticatedStudioActor}
  commandPort={commandPort}
  generationProvider={generationProviderContext}
  scope={{ brandProfileId, projectId, compositionId }}
  voice={activeVoiceContext}
/>
```

The parent shell should not copy operations into `studio-api.ts`, create another
composition cache, or send actor/role/fingerprint fields to the server.

## Rollout prerequisites and known limitations

- The additive Foundation migration
  `20260921120000_creative_composition_foundation` must be deployed by the
  authorized rollout owner.
- Foundation flags remain safely off by default. Reads/planning require
  `CREATIVE_STUDIO_V3_FOUNDATION_MODE=shadow|enforce`; writes additionally
  require `CREATIVE_STUDIO_V3_FOUNDATION_MODE=enforce` and
  `CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENABLED=true`.
- The current Foundation GET response does not expose durable history-stack
  availability or a paginated activity feed. Without authoritative enrichment,
  the adapter conservatively shows undo/redo only for commands observed in the
  mounted session. The endpoints and durable audit remain authoritative.
- CSE3/A+B asset descriptors are presentation enrichment because the provider-
  neutral Foundation document intentionally stores only pinned asset-version
  IDs. Missing enrichment renders “not hydrated” rather than invented provider,
  dimensions, verification, or cost.
- Branch-level browser rendering could not be captured because the coordinated
  localhost request was blocked by the owner environment with
  `ERR_BLOCKED_BY_CLIENT`. Per coordination, no auth bypass or Chrome workaround
  was attempted. The parent workstream owns authoritative combined exact-SHA
  Chrome verification.

## Verification evidence

- Final focused Editor/Agent/Foundation/API gate: 12 files, 77 tests passed.
  The production Foundation adapter has 11 direct contract tests covering
  load, validate/apply, stale state, idempotency, history, scope/role failures,
  offline failure, malformed responses, and the paid/external-action boundary.
- Focused Editor/Agent ESLint: zero warnings.
- Full repository Vitest gate: 512 files, 4,647 tests passed.
- TypeScript strict typecheck: passed.
- Full repository ESLint: exited successfully. Existing warnings remain outside
  this workstream; the focused Editor/Agent paths pass with zero warnings.
- Direct production Next.js build (without the repository migration wrapper):
  passed and generated 389/389 static pages. The build reported only
  pre-existing OpenTelemetry/Sentry dynamic-dependency warnings and expected
  local-environment warnings for a transient Google Font timeout, absent
  `DATABASE_URL`, and unauthenticated approval API collection.
- Source accessibility contracts cover native controls, input-scoped
  shortcuts, roving tabs, labelled tab panels, responsive focus modes,
  touch-safe controls, and reduced motion.
- Exact base/Foundation ancestry, locked-demo isolation, remote branch parity,
  diff hygiene, and the clean worktree are verified in the final branch report.

No Vercel deployment, production deployment, main merge, paid generation, voice
call, render/export, external publish, or feature-flag enablement is part of
this workstream.
