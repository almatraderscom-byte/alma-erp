# G10 Group Runner — Tool Selection and Tool Result Firewall

## Invocation

Use exactly:

```text
RUN GROUP G10
```

Attach or make available this folder, the repository, and `../GLOBAL_AGENT_CONTRACT.md`.

## Group objective

Execute the following ten specs sequentially:

1. `SPEC-091` — Domain-first tool retrieval
2. `SPEC-092` — Exact tool shortlist selection
3. `SPEC-093` — Tool schema token minimization
4. `SPEC-094` — Tool argument validation
5. `SPEC-095` — Full evidence payload storage
6. `SPEC-096` — Compact model-view contract
7. `SPEC-097` — Large result summarization without LLM
8. `SPEC-098` — Search and browser result normalization
9. `SPEC-099` — Tool result provenance
10. `SPEC-100` — Tool-selection and result-size regression gate

## Prerequisites

- `G05` must have a merged PASS certification.
- `G08` must have a merged PASS certification.
- `G09` must have a merged PASS certification.

## Owned zones

- `src/agent/tools/selection`
- `src/agent/tools/results`

## Automatic sequential protocol

For each spec in order:

1. Read the spec.
2. Check the previous spec's `final-verdict.md`.
3. Create a clean checkpoint commit.
4. Produce baseline evidence before editing.
5. Implement only the current spec.
6. Run the spec's tests and proof scans.
7. Execute rollback proof.
8. Write `final-verdict.md`.
9. If verdict is `PASS`, commit and proceed.
10. If verdict is `PARTIAL` or `FAIL`, stop the group immediately.

The session must not compress several specs into one implementation. Each spec retains separate code diff, proof and commit identity.

## Group integration checkpoint

After all ten PASS:

- run full repository typecheck
- run full relevant test suite
- run database migration validation
- run architecture bypass scans
- run tenant-isolation tests
- run policy/security tests applicable to this group
- compare group-level cost and latency against baseline
- validate rollback from the final group state
- create `artifacts/G10/GROUP_CERTIFICATION.md`

## Required group certification

```text
Group: G10
Specs: SPEC-091..SPEC-100
Individual PASS count: 10/10
Repository integration tests: PASS
Architecture scan: PASS
Cost regression: PASS
Security regression: PASS
Rollback drill: PASS
Unresolved critical risks: 0
Verdict: PASS
```

## Stop conditions

Stop without continuing when:

- another active branch edits the same ownership zones
- a prerequisite contract changed after the group started
- tests cannot run
- cost usage cannot be measured for cost-sensitive changes
- a bypass remains
- a schema migration is destructive without approved migration plan
- rollback fails
- any individual spec is not PASS

## Group coding-agent prompt

```text
RUN GROUP G10

You are the sequential Group Runner for Tool Selection and Tool Result Firewall.
Read GLOBAL_AGENT_CONTRACT.md, this RUNNER.md, and all ten specs.
Use one clean branch/worktree dedicated to G10.
Implement the specs strictly in numeric order.
After each spec, require complete proof artifacts and a PASS verdict, then commit.
Stop immediately on PARTIAL/FAIL or an ownership conflict.
After ten PASS results, run the group integration checkpoint and produce GROUP_CERTIFICATION.md.
Do not start another group.
```
