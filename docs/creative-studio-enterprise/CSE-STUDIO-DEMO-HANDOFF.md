# Creative Studio Enterprise — owner demo handoff

**Gate:** owner review required; production redesign is not approved
**Branch:** `codex/cs-enterprise-studio-demo`
**Base:** `b399ba9b47433a5d0dcfd0d5e862b21a600456d1`
**Pre-work tag:** `pre-codex-cs-enterprise-studio-demo`
**Demo route:** `/agent/creative-studio-demo`
**Access:** existing ALMA agent kill switch, authenticated session, and system-owner role are all required.

## Package contents

- Competitive audit and directly-observed/inferred evidence:
  `docs/creative-studio-enterprise/CSE-STUDIO-REDESIGN-AUDIT.md`
- Outcome roadmap, dependency map, migrations/APIs/workers, rollout and rollback:
  `docs/creative-studio-enterprise/CSE-STUDIO-REDESIGN-ROADMAP.md`
- Interactive demo:
  `src/agent/components/creative-studio-demo/CreativeStudioEnterpriseDemo.tsx`
- Isolated visual system:
  `src/agent/components/creative-studio-demo/CreativeStudioEnterpriseDemo.module.css`
- Deterministic demo operation contract:
  `src/lib/creative-studio/demo-operations.ts`
- Contract tests:
  `src/lib/creative-studio/__tests__/demo-operations.test.ts`

The current production Studio route and components were not changed.

## Live preview identity

- **Commit:** pending final commit
- **Vercel deployment:** pending exact-SHA preview
- **Stable branch alias:** pending READY verification
- **Production:** not deployed

These fields are completed only after the exact commit is pushed and Vercel reports READY.

## What to review

### Workspace and navigation

- Use the left rail to move among Image, Video, Voice, Audio, and Library.
- The contextual panel changes its entry point and fixture assets without calling an API.
- Project pins keep ERP product `AL-EID-042`, locked Recipe v7, and folder context visible.
- Asset selection drives the contextual state.

### Canvas and timeline

- Central 9:16 campaign canvas with safe-zone toggle and truthful prototype label.
- Player transport, playhead, duration, timeline zoom, and local split action.
- Video, Captions, Voice, Music, and SFX tracks.
- Caption, owner-voice version, music level, QC, and project provenance are represented.

### Inspector and review

- Inspector presents transform, editable fixture caption, timed words, source, engine, recipe, QC, and `$0` local cost.
- Review demonstrates a version-pinned approval becoming stale on a later document version.
- Review actions are labelled prototype and do not write events.

### Creative Agent

1. Choose **Create plan**.
2. Review five deterministic operations and their before/after values.
3. Observe that only three reversible local operations are eligible.
4. Observe that the paid AI clip (estimated ৳75) and Meta publish are separate blocked effects.
5. Check the exact-fingerprint acknowledgement.
6. Choose **Apply 3 safe edits**.
7. Verify version 12 → 13, audit `AUD-13-8F2C`, duration 24.0 → 22.8, caption timing 2.4 → 1.2, and music 18% → 12%.
8. Choose **Rollback plan** and verify a new audited version 14.

No interaction in this prototype can call a provider, create/export media, spend credits, write a review, or publish externally.

## Screenshot evidence

- Desktop editor:
  `/private/tmp/alma-cse-studio-demo-1440.png`
- Desktop Agent plan:
  `/private/tmp/alma-cse-studio-demo-desktop-plan.png`
- Desktop applied/audit state:
  `/private/tmp/alma-cse-studio-demo-agent-applied.png`
- Mobile stage and multi-track timeline, 390 × 844:
  `/private/tmp/alma-cse-studio-demo-mobile.png`
- Mobile Agent focus mode, 390 × 844:
  `/private/tmp/alma-cse-studio-demo-mobile-agent.png`

Final live-preview screenshots are added after the exact-SHA deployment is READY.

## Validation record

| Check | Result |
| --- | --- |
| Exact base preflight | PASS — `b399ba9b47433a5d0dcfd0d5e862b21a600456d1` |
| Clean starting worktree | PASS |
| Applicable `AGENTS.md` | None found; rechecked before handoff |
| Supplied ALMA and ElevenLabs screenshots | Inspected before design |
| ElevenLabs audit | Read-only authenticated Chrome; no mutations/credits |
| Demo operation tests | PASS — 3/3 |
| Creative Studio regression suite | PASS — 27 files, 173 tests |
| TypeScript | PASS — `tsc --noEmit` |
| ESLint | PASS with pre-existing repository warnings; no demo warnings |
| Production build | PASS — `/agent/creative-studio-demo` 8.53 kB, 97.2 kB first load |
| Desktop visual/DOM | PASS |
| Agent plan/apply/rollback | PASS |
| Mobile 390 × 844 stage/timeline | PASS |
| Mobile 390 × 844 Agent focus mode | PASS |
| `git diff --check` | PASS |
| Temporary auth/cache bypass | Absent |
| Paid generation/export/publish | Not executed; `$0` |

The first local build attempt was blocked by generated webpack cache disk pressure. The central monitor removed only regenerable build outputs. The subsequent normal repository build passed. A separate sandboxed attempt could not fetch existing Google fonts; the normal build was rerun with network access and passed.

## Prototype limitations

- All demo content is synthetic, non-sensitive fixture state.
- No backend composition schema, migrations, command API, render worker, or provider adapter exists yet.
- State resets on reload and is not collaborative.
- Canvas art is a CSS concept preview, not generated or exported media.
- Timeline playback is illustrative and does not decode/render source media.
- Split, caption, and inspector changes are local state demonstrations.
- Creative Agent does not call an LLM. Its typed plan is deterministic fixture data demonstrating the required protocol.
- Share, Export, review, paid generation, and external publish are intentionally disconnected.
- Undo/rollback demonstrates the proposed version semantics but is not wired to CSE production audit storage.
- Mobile uses focus-mode drawers and a horizontally scrollable timeline; later usability testing must validate touch trimming and screen-reader workflows.

## Integration conflicts and mitigations

| Risk | Likely overlap | Required resolution |
| --- | --- | --- |
| Resolution-integrity stream changes dimension/QC results | gallery, provider results, worker metadata | Consume normalized result fields through an adapter; do not duplicate them in editor state |
| Advanced-model-fidelity stream changes engine options/payloads | Advanced/Auto forms, registry, workers | Provider capability manifest owns options; editor inspector owns presentation |
| All streams may expand `studio-api.ts` | client types and request helpers | Split new composition/operation clients by domain |
| Prisma migration order | three integration branches | Reserve and rebase additive migration IDs before integration |
| Timeline-lite versus composition graph | CSE5 storage and rerender | Additive dual-read projection; no destructive conversion |
| Export versus existing Meta publish | top controls and delivery service | Keep render/share/publish as separate commands and endpoints |
| Agent chat tools queue jobs as approved pending actions | cost and permission semantics | Adapt through the new plan/confirm command validator; queue is never completion |

## Explicit approval gate

This branch stops at an owner-reviewable prototype. Do **not** begin production redesign implementation, merge either provider workstream, merge main, deploy production, enable paid generation, or exercise external publishing until the owner explicitly approves the demo and roadmap.
