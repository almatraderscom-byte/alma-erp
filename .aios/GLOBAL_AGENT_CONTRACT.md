# Global Agent Contract

This file is mandatory for every coding session.

## Frozen architecture rule

The 200 specifications derive from one target architecture:

```text
Request
 -> Admission Control Plane
 -> Cost Governor
 -> Context Compiler
 -> Capability Broker
 -> Policy/Approval
 -> Durable Workflow
 -> Secure Tool Gateway
 -> Evidence Verification
 -> Response Gate
 -> Audit + Cost + Evaluation
```

Individual sessions may refine implementation details but may not reverse these boundaries without a new architecture decision and regenerated dependency plan.

## Session types

### Group Runner session

Receives `RUN GROUP Gxx`. It executes ten specs sequentially on one isolated worktree.

### Parallelism

Parallelism occurs between groups listed in the same approved wave. The ten specs inside one group are sequential.

### Integration session

After a wave, a separate integration session merges group branches in dependency order and runs repository-wide gates.

## Hard rules

- No task may claim that future work will be completed later.
- No hidden model calls.
- No direct side-effect bypass around Tool Gateway after G13.
- No authorization bypass around Policy Engine after G11.
- No provider call bypass around Cost Governor after G04.
- No raw full conversation dependency after G06.
- No frontier head model as default after G17.
- No merge without executable proof.
- No destructive migration without a reversible migration plan.
- No concurrent edits to the same ownership zone.

## Branch naming

```text
aios/G01-architecture-freeze
aios/G02-admission
...
```

## Commit policy

One spec = at least one dedicated commit:

```text
SPEC-001: Architecture inventory and request-path map
```

Group certification is a separate commit:

```text
G01: certify architecture freeze group
```

## PASS semantics

PASS means:

- required implementation exists
- required tests executed successfully
- cost impact measured where relevant
- security and tenant isolation verified
- rollback executed successfully
- bypass scans pass
- unresolved critical risks are zero

Narrative confidence is not proof.
