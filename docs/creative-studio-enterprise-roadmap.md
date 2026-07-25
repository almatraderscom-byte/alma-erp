# Creative Studio Enterprise Roadmap (Web)

**Date:** 2026-07-24  
**Baseline:** `origin/main` at `7932eb2f`  
**Scope:** Web Creative Studio only. Native iOS parity is explicitly out of scope.  
**Goal:** turn the existing owner-grade production beta into a reliable, cost-controlled ALMA Content OS without replacing the proven image, video, audio, queue, or Drive engines.

## Outcome and product position

The current Studio already has unusually strong generation depth: deterministic family chains, saved models, multiple try-on/edit engines, image finishing, Veo reels, owner-shot video recipes, Audio Lab, durable VPS jobs, Drive archive, QC, feedback, and engine controls.

The enterprise gap is the operational shell around those engines:

1. trustworthy asset states and complete asset discovery;
2. projects, campaigns, brand recipes, versions, and lineage;
3. deterministic multi-format campaign packs with stage-level retry;
4. practical timeline/transcript/audio editing;
5. review, approval, roles, and audit history;
6. publishing and performance attribution;
7. automated regression, observability, retention, and recovery.

This roadmap intentionally does **not** add a generic 50-model flow canvas, an After Effects clone, a public template marketplace, SSO/SCIM, or more provider selectors. Those would add cost and complexity before they improve ALMA's output.

## Non-negotiable execution contract

- One phase per session/task.
- Before every implementation phase: branch `agent-phase-cseN` and tag `pre-agent-phase-cseN`.
- CSE1 starts from fresh `origin/main`. Each later phase is stacked from the previous live-verified phase, so the final branch contains the full program.
- Never modify a file outside the current phase prompt's allowlist.
- New APIs stay under `/api/assistant/*`; every route checks `requireAgentEnabled()` and owner/role authorization.
- Long or expensive work stays on the durable VPS worker queue.
- Migrations are additive only.
- No production deployment or merge. Push feature branches for Vercel Preview only.
- Every phase gate is: scoped diff → tests → typecheck/build → preview deploy → Chrome live exercise → screenshot proof.
- If a gate fails, diagnose honestly and stop that phase. Do not advance.
- Paid generation is not required when an equivalent deterministic fixture can prove the feature. Any necessary paid live run must show its estimate first and stay under the phase cost ceiling.
- Owner-facing runtime text is pure Bangla; money is whole-taka via `roundMoney`; Islamic guardrails remain active.

## Cost-effective quality ladder

All campaign work follows this order:

1. low-cost preview;
2. QC identifies the failing stage;
3. rerun only that stage;
4. create free/cheap local crops, captions, frames, and variants;
5. generate a 6-second reel only for the selected still;
6. generate 16/24-second Veo only for a proven campaign;
7. feed real owner feedback and post performance into deterministic recipe weights.

## Phase order

| Phase | Outcome | Primary proof | Paid ceiling |
|---|---|---|---:|
| [CSE1](creative-studio-enterprise/CSE1-trust-and-reliability.md) | Trustworthy Gallery, errors, cost confirmation, worker status | pagination/filter/QC-state/error/cost/health live | $0 |
| [CSE2](creative-studio-enterprise/CSE2-modular-studio-shell.md) | Maintainable Studio shell with behavior parity | all existing views and actions still work | $0 |
| [CSE3](creative-studio-enterprise/CSE3-content-os.md) | Projects, product picker, locked recipes, folders/tags/version lineage | create project and trace an asset version | $0 |
| [CSE4](creative-studio-enterprise/CSE4-campaign-packs.md) | One-product deterministic campaign pack | preview manifest, partial rerun, two-draft compare | $1 |
| [CSE5](creative-studio-enterprise/CSE5-editing-and-voice.md) | Transcript/timeline-lite, dubbing, voice lifecycle | edit a fixture video/audio and verify consent/version controls | $1 |
| [CSE6](creative-studio-enterprise/CSE6-review-and-multibrand.md) | Creator/reviewer workflow, comments, approval, audit, multi-brand | role-bound draft → approval → publish-ready | $0 |
| [CSE7](creative-studio-enterprise/CSE7-distribution-and-hardening.md) | Meta scheduling, performance loop, E2E/load/retention/recovery | scheduled dry run + performance attribution + final regression | $1 |
| [CSE8](creative-studio-enterprise/CSE8-resolution-integrity.md) | Truthful provider-aware 2K/4K output and verified artifact variants | exact payload + decoded-byte + persistence + download proof | $0 |

## Final integration rule

After CSE7 passes its final preview and Chrome proof, the latest stacked branch is the integration candidate. The owner checks it. Only after the owner explicitly confirms may it be merged or promoted to `main`; until then production remains untouched.

## Enterprise benchmark coverage

| Benchmark capability | ALMA phase |
|---|---|
| Studio-style assets, timeline, captions, narration, music, export | existing + CSE5 |
| Reusable Templates with up-front cost | existing recipes + CSE1/CSE3 |
| Flow-style partial reruns without a costly generic node canvas | CSE4 |
| Asset search, folders/tags, versions, lineage | CSE1/CSE3 |
| Workspace roles, review, approval, audit logs | CSE6 |
| Multi-brand controls | CSE6 |
| Distribution and measurable winner feedback | CSE7 |
| Operational health, retention, recovery, regression | CSE1/CSE7 |
| Truthful provider output size and original/derivative integrity | CSE8 |
