# Parallel Group Execution Plan

## Core rule

Run one coding session per group. A group session executes its ten specs sequentially. Run groups in the same wave in parallel only when every prerequisite group has already been merged and certified.

Official Claude Code documentation supports isolated parallel sessions with Git worktrees and task-specific subagents; Codex likewise provides multi-agent workflows with built-in worktrees. Worktree isolation reduces Git-state collisions, but it does not remove logical contract conflicts, so this dependency plan remains mandatory.

## Wave 1

- `RUN GROUP G01` — Architecture Freeze and Repository Governance — prerequisites: none

After Wave 1: run a dedicated integration session and merge only certified groups.

## Wave 2

- `RUN GROUP G02` — Request Admission Control Plane — prerequisites: G01
- `RUN GROUP G03` — Provider Pricing and Cost Accounting — prerequisites: G01
- `RUN GROUP G08` — Tool Registry Decomposition — prerequisites: G01

After Wave 2: run a dedicated integration session and merge only certified groups.

## Wave 3

- `RUN GROUP G04` — Hard Cost Governor — prerequisites: G02, G03
- `RUN GROUP G06` — Conversation State and Memory — prerequisites: G01, G05
- `RUN GROUP G09` — Capability Control Plane — prerequisites: G02, G08
- `RUN GROUP G11` — Identity Authorization and Policy Engine — prerequisites: G01, G02, G09
- `RUN GROUP G16` — Model Fabric and Provider Adapters — prerequisites: G03, G05

After Wave 3: run a dedicated integration session and merge only certified groups.

## Wave 4

- `RUN GROUP G05` — Prompt and Context Compiler — prerequisites: G01, G02, G04
- `RUN GROUP G12` — Autonomy and Approval Governance — prerequisites: G04, G11
- `RUN GROUP G14` — Durable Workflow Runtime — prerequisites: G01, G09, G13

After Wave 4: run a dedicated integration session and merge only certified groups.

## Wave 5

- `RUN GROUP G07` — Prompt Caching and Response Caching — prerequisites: G03, G05, G06
- `RUN GROUP G10` — Tool Selection and Tool Result Firewall — prerequisites: G05, G08, G09
- `RUN GROUP G15` — Queue Scheduling and Browser Runtime — prerequisites: G04, G14
- `RUN GROUP G17` — Measured Routing and Head Model Isolation — prerequisites: G04, G09, G16

After Wave 5: run a dedicated integration session and merge only certified groups.

## Wave 6

- `RUN GROUP G13` — Central Secure Tool Gateway — prerequisites: G04, G10, G11, G12
- `RUN GROUP G18` — Specialist Agents and Known Workflows — prerequisites: G09, G14, G17

After Wave 6: run a dedicated integration session and merge only certified groups.

## Wave 7

- `RUN GROUP G19` — Verification Security and Evaluation — prerequisites: G10, G11, G13, G17, G18

After Wave 7: run a dedicated integration session and merge only certified groups.

## Wave 8

- `RUN GROUP G20` — Observability Release and Continuous Optimization — prerequisites: G07, G14, G19

After Wave 8: run a dedicated integration session and merge only certified groups.
