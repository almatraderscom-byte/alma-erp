# Alma AIOS 200-Spec System

## Start here

1. Read `GLOBAL_AGENT_CONTRACT.md`.
2. Read `PARALLEL_GROUP_PLAN.md`.
3. Start Wave 1 by giving a coding agent: `RUN GROUP G01` plus the `G01` folder and repository access.
4. After G01 certifies PASS, run the approved groups in Wave 2 in separate worktrees.
5. Use `WAVE_INTEGRATOR.md` after every wave.

## Groups

- [G01 — Architecture Freeze and Repository Governance](G01/RUNNER.md): SPEC-001–SPEC-010; prerequisites: none
- [G02 — Request Admission Control Plane](G02/RUNNER.md): SPEC-011–SPEC-020; prerequisites: G01
- [G03 — Provider Pricing and Cost Accounting](G03/RUNNER.md): SPEC-021–SPEC-030; prerequisites: G01
- [G04 — Hard Cost Governor](G04/RUNNER.md): SPEC-031–SPEC-040; prerequisites: G02, G03
- [G05 — Prompt and Context Compiler](G05/RUNNER.md): SPEC-041–SPEC-050; prerequisites: G01, G02, G04
- [G06 — Conversation State and Memory](G06/RUNNER.md): SPEC-051–SPEC-060; prerequisites: G01, G05
- [G07 — Prompt Caching and Response Caching](G07/RUNNER.md): SPEC-061–SPEC-070; prerequisites: G03, G05, G06
- [G08 — Tool Registry Decomposition](G08/RUNNER.md): SPEC-071–SPEC-080; prerequisites: G01
- [G09 — Capability Control Plane](G09/RUNNER.md): SPEC-081–SPEC-090; prerequisites: G02, G08
- [G10 — Tool Selection and Tool Result Firewall](G10/RUNNER.md): SPEC-091–SPEC-100; prerequisites: G05, G08, G09
- [G11 — Identity Authorization and Policy Engine](G11/RUNNER.md): SPEC-101–SPEC-110; prerequisites: G01, G02, G09
- [G12 — Autonomy and Approval Governance](G12/RUNNER.md): SPEC-111–SPEC-120; prerequisites: G04, G11
- [G13 — Central Secure Tool Gateway](G13/RUNNER.md): SPEC-121–SPEC-130; prerequisites: G04, G10, G11, G12
- [G14 — Durable Workflow Runtime](G14/RUNNER.md): SPEC-131–SPEC-140; prerequisites: G01, G09, G13
- [G15 — Queue Scheduling and Browser Runtime](G15/RUNNER.md): SPEC-141–SPEC-150; prerequisites: G04, G14
- [G16 — Model Fabric and Provider Adapters](G16/RUNNER.md): SPEC-151–SPEC-160; prerequisites: G03, G05
- [G17 — Measured Routing and Head Model Isolation](G17/RUNNER.md): SPEC-161–SPEC-170; prerequisites: G04, G09, G16
- [G18 — Specialist Agents and Known Workflows](G18/RUNNER.md): SPEC-171–SPEC-180; prerequisites: G09, G14, G17
- [G19 — Verification Security and Evaluation](G19/RUNNER.md): SPEC-181–SPEC-190; prerequisites: G10, G11, G13, G17, G18
- [G20 — Observability Release and Continuous Optimization](G20/RUNNER.md): SPEC-191–SPEC-200; prerequisites: G07, G14, G19