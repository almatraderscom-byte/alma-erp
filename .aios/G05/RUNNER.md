# G05 Group Runner — Prompt and Context Compiler

## Invocation

Use exactly:

```text
RUN GROUP G05
```

Attach or make available this folder, the repository, and `../GLOBAL_AGENT_CONTRACT.md`.

## Group objective

Execute the following ten specs sequentially:

1. `SPEC-041` — Versioned context compiler contract
2. `SPEC-042` — Stable constitution bundle
3. `SPEC-043` — Domain skill bundle
4. `SPEC-044` — Policy bundle insertion
5. `SPEC-045` — Structured workflow state insertion
6. `SPEC-046` — Relevant memory insertion
7. `SPEC-047` — Exact tool-schema insertion
8. `SPEC-048` — Dynamic request suffix
9. `SPEC-049` — Context token allocator
10. `SPEC-050` — Context provenance and replay record

## Prerequisites

- `G01` must have a merged PASS certification.
- `G02` must have a merged PASS certification.
- `G04` must have a merged PASS certification.

## Owned zones

- `src/agent/context`
- `src/agent/prompts`

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
- create `artifacts/G05/GROUP_CERTIFICATION.md`

## Required group certification

```text
Group: G05
Specs: SPEC-041..SPEC-050
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
RUN GROUP G05

You are the sequential Group Runner for Prompt and Context Compiler.
Read GLOBAL_AGENT_CONTRACT.md, this RUNNER.md, and all ten specs.
Use one clean branch/worktree dedicated to G05.
Implement the specs strictly in numeric order.
After each spec, require complete proof artifacts and a PASS verdict, then commit.
Stop immediately on PARTIAL/FAIL or an ownership conflict.
After ten PASS results, run the group integration checkpoint and produce GROUP_CERTIFICATION.md.
Do not start another group.
```
