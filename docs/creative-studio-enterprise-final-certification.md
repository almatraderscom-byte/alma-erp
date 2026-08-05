# Creative Studio Enterprise — Final Certification

Date: 2026-07-25
Scope: CSE1–CSE7 program record; CSE7 implementation certification for parent cross-phase audit.

## Program matrix

| Phase | Capability | Migration | Phase cost ceiling | Certification source |
|---|---|---|---:|---|
| CSE1 | Gallery truth, QC guards, safe errors/cost confirmation, worker health | None | $0 | Inherited owner-browser-verified phase |
| CSE2 | Modular Studio shell and typed client contracts | None | $0 | Inherited owner-browser-verified phase |
| CSE3 | Projects, recipes, asset versions/lineage, tags, legacy collection | `20260724190000_creative_content_os` | $0 | Inherited owner-browser-verified phase |
| CSE4 | Deterministic campaign packs, stage idempotency/resume, hard cap | None | $1 maximum | Inherited owner-browser-verified phase |
| CSE5 | Timeline-lite editing, voice consent/version/audit/revocation | `20260724200000_creative_voice_lifecycle` | $1 maximum | Inherited owner-browser-verified phase; worker rollout still required |
| CSE6 | Owner/Creator/Reviewer isolation, multi-brand review audit | `20260724210000_creative_review_multibrand` | $0 | Inherited owner-browser-verified phase; worker rollout still required |
| CSE7 | Approved distribution, performance attribution, retention, hardening | `20260724220000_creative_distribution_attribution` | $1 maximum; this run $0 | This document and CSE7 gate evidence |

Prior-phase actual provider spend is not reconstructed in CSE7. The parent cross-phase audit must reconcile historical `agent_cost_events` receipts; CSE7 verification itself records `$0` and makes no paid generation or external post.

## CSE7 safety and architecture decisions

1. Only the Studio owner can dry-run, schedule, cancel, retry a confirmed-no-effect failure, or enable Meta delivery. Creator and Reviewer access remains read-only and brand-scoped.
2. Scheduling requires the asset's current state to be `APPROVED`, the latest version to equal the immutable review event's `approvedVersionId`, and a non-empty storage path.
3. `owner_id + idempotency_key` is unique and the request fingerprint prevents reuse with different content. Concurrent claims use a status compare-and-set.
4. Meta has no idempotency token in the existing direct path. Therefore a timeout, worker interruption, returned post without fetch-back verification, or other ambiguous outcome is quarantined as `NEEDS_REVIEW`; it is not automatically retried.
5. Live publishing defaults OFF per owner. The VPS distribution loop independently defaults OFF and requires `STUDIO_DISTRIBUTION_SCHEDULERS_ENABLED=true`.
6. Performance snapshots are append-only and identify delivery, exact asset version, campaign pack, external object, and source window. Generic ad spend retains its provider currency; BDT revenue uses whole-taka rounding.
7. Feedback does not inspect or judge creative content. A fixed score (`reach + 4×engagement + 8×click + 50×conversion`) needs two versions, 100 impressions per version, and a 10% lead. The winning scene gets a bounded `+5`, no more than weekly.
8. Archive deletion requires a durable Drive receipt, retention expiry, a default 24-hour receipt grace, and another Drive verification immediately before Supabase removal. Owner can disable archive or deletion separately.

## Delivery and metric receipts

- Dry-run receipt: pins approved review event, asset version, campaign pack, scene, page, caption fingerprint, schedule, and idempotency key; `externalEffect=false`, `estimatedCostUsd=0`.
- Scheduled receipt: durable `creative_publish_deliveries` row with owner confirmation and zero cost.
- Live receipt: Meta object ID, permalink when available, fetch-back verification time, attempts, provider decision, and metrics cadence.
- Attribution receipt: append-only `creative_performance_snapshots` row with a unique source fingerprint.
- Archive receipt: `creative_archive_receipts` records Drive file ID, archive/verification times, re-verification, and original deletion time.

The delegated CSE7 run explicitly forbids external publishing, so the first real Meta object receipt is a rollout dependency, not fabricated proof. Dry-run/API/browser proof must stay at `$0`.

## Observability and thresholds

The Performance surface reports:

- publish queue age;
- worker heartbeat age;
- seven-day provider error rate;
- seven-day Creative provider spend;
- seven-day QC pass rate;
- unverified archive count and archive lag;
- seven-day publish failures.

Load thresholds:

| Journey | Preview threshold | Error ceiling |
|---|---:|---:|
| Gallery/project reads, concurrency 10 | p95 ≤ 1500 ms | ≤ 1% |
| Publish dry-run admission, concurrency 5 | p95 ≤ 1000 ms | ≤ 1% |
| CI contract benchmark: 50k assets | p95 ≤ 250 ms | 0% |
| CI contract benchmark: 10k queue rows | p95 ≤ 100 ms | 0% |

The load script performs only GET and dry-run calls; it cannot publish or spend.

## Recovery runbook

### Stop distribution immediately

1. In the asset Publish panel, turn **Live delivery** OFF. This owner-scoped switch is checked before every worker claim.
2. On the VPS, unset or set `STUDIO_DISTRIBUTION_SCHEDULERS_ENABLED=false`, then restart only the preview-tested worker when operationally approved.
3. Do not requeue `PUBLISHING` or `NEEDS_REVIEW` rows. Check the Meta page first; the system intentionally quarantines stale claims after 15 minutes to prevent duplicates.

### Recover a failed delivery

1. `FAILED_RETRYABLE` means the provider confirmed no external effect; owner may use the visible safe-retry control.
2. `NEEDS_REVIEW` means the effect may exist. Reconcile the Meta page/object ID manually and record the outcome before creating any new idempotency key.
3. Metrics failure never republishes. It stores the error and retries the read after six hours.

### Stop or recover retention

1. Disable **Verified copy-এর পর original cleanup** while leaving Drive archive enabled.
2. Inspect the durable receipt and fetch the Drive file. Missing/unverified receipts are never eligible for deletion.
3. Restore a deleted original from the receipt's Drive file using the existing Drive download path, then update operational records; do not delete receipt history.

### Application rollback

1. Roll the app/worker code back to `pre-agent-phase-cse7` or the prior approved CSE6 SHA.
2. Leave the additive CSE7 tables and enums in place; older code does not reference them. Do not drop receipt/audit tables during an incident.
3. Keep both publishing switches OFF until the rollback or forward fix is browser-verified.

## Rollout dependencies and known limitations

- Production VPS may still run a pre-CSE5/CSE6/CSE7 revision. CSE7 worker code must be deliberately deployed later; this phase does not deploy production.
- The additive CSE7 migration must exist before enabling the new worker cadence.
- Meta page/ad tokens and required insights permissions must be valid. Token/permission failures surface as observability errors without publishing.
- A real Meta receipt cannot be certified under the delegated `$0`, no-external-publishing rule. Owner must explicitly authorize that separate proof.
- Historical CSE1–CSE6 evidence is inherited and will be rechecked by the parent cross-phase audit.
- No SSO/SCIM, public sharing, autonomous publishing, autonomous creative judgment, or production deployment is introduced.

## CSE7 gate record

The final branch SHA, exact Vercel deployment ID/URL, stable alias proof, owner-Chrome screenshots, console/API timings, full-suite counts, and clean-worktree result are filled in the phase handoff report after the exact-SHA preview is READY.
