# Claude Code Handoff — ALMA ERP iOS Native Polish Programme

Copy the prompt below into a fresh Claude Code session. This handoff authorizes **IOSP-0 only**. Repository rules require one roadmap phase per session.

---

You are taking over the ALMA ERP iOS Native Polish programme.

## Required reading

Read completely before taking any action:

1. `AGENTS.md`
2. `docs/IOS_NATIVE_POLISH_MASTER_ROADMAP_2026-07.md`
3. the current branch status, worktrees, recent iOS phase reports, and relevant source files

The master roadmap is the product/technical contract. `AGENTS.md` has higher authority if anything conflicts.

## Your authorization for this session

Execute **IOSP-0 — Reproducible baseline and route contract only**.

Do not begin IOSP-1 in this session. At the end, write an IOSP-0 phase report and a fresh handoff prompt for IOSP-1, then stop.

## Safety and branch rules

- The repository is live production ERP.
- Preserve every unrelated dirty change and existing worktree.
- Do not use `git add -A`.
- Before editing, run the full pre-flight required by `AGENTS.md`.
- Determine the next valid numeric `agent-phase-N` branch/tag pair without colliding with existing phases; create the branch and `pre-agent-phase-N` tag exactly as required by `AGENTS.md`.
- Do not merge to main, deploy production, or upload TestFlight.
- Never modify `/api/agent/*` or its authentication.
- Do not change business/financial semantics.
- No secrets in git.

## Simulator isolation — mandatory

Use only:

- iPhone 17 Pro Max Simulator
- UDID `94E0186B-5CDA-4708-9368-53B4FF7274E7`

Another session uses an iPhone 17 Pro Simulator. Do not boot, install, launch, erase, focus, or control that simulator. Print and verify the destination UDID before every `simctl` or `xcodebuild` destination command.

## IOSP-0 outcome

Produce a reproducible baseline without changing production behaviour:

1. regenerate Swift LOC and large-file inventory;
2. export every Next.js app route and every iOS native route;
3. classify each destination as native-required, system handoff, public-web allowed, or temporary-web debt;
4. inventory every forced-web call site and its owning screen/action;
5. add only the minimal approved instrumentation required to measure:
   - app launch to useful content;
   - route request to useful content;
   - API request duration/count;
   - Agent send to first visible activity/first token;
   - heavy sheet presentation;
6. capture Time Profiler, Network, Core Animation, and memory baselines;
7. record five-minute idle request counts on Dashboard, Orders, Agent, Approvals, and More;
8. record current Xcode, SDK, Swift mode, deployment target, build warnings, and deprecated APIs;
9. create a machine-readable route contract/test fixture for later phases;
10. write `docs/IOSP-0-BASELINE-REPORT.md` and proof index.

If adding signposts would exceed the narrow IOSP-0 scope or conflict with another session’s modified file, document the collision and gather the non-invasive baseline first. Do not overwrite or absorb unrelated changes.

## Verification gate

Before saying IOSP-0 is complete, you must personally:

1. build for the exact iPhone 17 Pro Max UDID;
2. install/launch only on that simulator;
3. exercise all five root tabs;
4. capture screenshots of the baseline overlap/native-web behaviours and save them with descriptive filenames;
5. capture a short video for at least one keyboard/composer/overlay transition;
6. store measurement commands and results so another session can reproduce them;
7. run relevant tests/build checks;
8. inspect `git diff --stat` and exact diff for scope;
9. confirm no protected route/auth/financial code changed;
10. mark each roadmap IOSP-0 exit criterion PASS or FAIL.

A successful build is not proof. If any mandatory gate fails, IOSP-0 is not complete.

If IOSP-0 touches web/API code, push a Vercel preview and follow the repository’s mandatory owner-Chrome browser-proof rule. If login is needed, ask the owner to type credentials; never type them yourself.

## Deliverables at the end of this session

- files created/changed;
- route/native/web classification report;
- baseline performance table;
- screenshot/video proof paths;
- exact verification checklist with PASS/FAIL;
- branch and commit information;
- unresolved risks;
- a new handoff prompt authorizing IOSP-1 only.

Stop after IOSP-0. Wait for the owner/new session before implementation of IOSP-1.

## TestFlight policy for the full programme

Do not upload TestFlight in IOSP-0.

The recommended programme policy is two TestFlight builds total:

1. a technical real-device checkpoint after IOSP-4, because APNs/CallKit/background/Live Activity/permissions and thermal behaviour cannot be proven fully in Simulator;
2. the final owner-acceptance build after IOSP-9.

Every phase still requires iPhone 17 Pro Max Simulator proof. Never create a TestFlight build merely because a phase ended.

---
