# Creative Studio V4 Design Audit and Owner Handoff

## 1. Handoff status

This document is the canonical handoff for the next Creative Studio design-review session.

The current V4 demo is **not owner-approved**. The owner rejected its visual quality, spatial hierarchy, and fidelity to the supplied ElevenLabs references. Prior automated and browser checks proved only that the preview loaded and that several interactions and positioning rules worked; they did **not** prove that the design was professional or acceptable.

The next session must begin with an independent visual and interaction audit, correct the demo on the dedicated demo branch, and present the corrected live demo to the owner. Production redesign implementation must not resume until the owner explicitly approves that corrected demo.

## 2. Canonical branch truth

### Design/demo review branch

- Branch: `codex/cs-enterprise-studio-demo-v4`
- Locked V3 reference base: `d346143bad100fd4cbd47b9958d50678b916b2dc`
- Last visually verified V4 code SHA: `47bf5251cb96a1c933fbad03a04795f4703d477b`
- Remote: `origin/codex/cs-enterprise-studio-demo-v4`
- Preview branch alias:
  `https://alma-erp-git-codex-cs-enterprise-studi-ee14a1-maruf-s-projects2.vercel.app`
- Exact verified deployment for `47bf5251…`:
  `https://alma-k6zugb4c6-maruf-s-projects2.vercel.app`
- Vercel deployment ID: `dpl_Gd7StJEfBpXScQgYZ97pedMGczLC`

All design/demo changes made after the locked V3 reference are in one linear ancestry on this branch:

1. `d346143bad100fd4cbd47b9958d50678b916b2dc` — locked V3 demo reference
2. `e511b8a6af97cac5eb4ca1bd14e5f050042a3c07` — V4 creation-flow and empty-project demo
3. `61f0277b9d660108b1aa56a1e3846e596a4299c2` — compact floating-composer correction
4. `47bf5251cb96a1c933fbad03a04795f4703d477b` — scroll behavior correction

The next session must verify the branch and exact remote SHA before doing anything:

```bash
git switch codex/cs-enterprise-studio-demo-v4
git status --short --branch
git rev-parse HEAD
git rev-parse origin/codex/cs-enterprise-studio-demo-v4
git merge-base --is-ancestor d346143bad100fd4cbd47b9958d50678b916b2dc HEAD
```

Fail preflight if the worktree is dirty, the local and remote branch tips differ, or the locked reference is not an ancestor. Do not start from `main`.

### Production implementation work deliberately kept separate

The following branches contain production-oriented V3 implementation work. They are not merged into the demo-review branch because doing so would mix an owner-rejected prototype with production code and bypass the owner's demo-first approval gate.

| Workstream | Exact recorded SHA |
| --- | --- |
| CSE7 baseline | `b399ba9b47433a5d0dcfd0d5e862b21a600456d1` |
| Accepted A+B integration | `887d016cd89fb3ce675bd87dd211b8b255b670e8` |
| V3 Foundation | `14b5ce17fcf746c479399657d6288cf224d84a17` |
| Foundation-wired Editor | `8e89f2082d229b5e3f0d12c83064cf514869f2a3` |
| V3 production UI | `48f533ad88db8e82e492719c97342fe3587ff20f` |
| V3 Lifecycle/Rollout | `28c8c34d9753f022c9938ab33c964cb3d178ea0a` |
| V3 integration | `f8eb4a7684af0e187785f1e0ddfd64f896326035` |

These SHAs are inventory, not acceptance claims. Before any future production integration, the new session must independently audit current remote tips, ancestry, diffs, tests, Prisma/migrations, preview identity, browser proof, security, cost gates, and unresolved risks. No production branch is authorized for `main` merely because it appears in this table.

## 3. Files changed by the V4 demo work

Relative to the locked reference `d346143…`, the V4 demo branch changes only these application files:

- `src/agent/components/creative-studio-demo/CreativeStudioCapabilityDesk.tsx`
- `src/agent/components/creative-studio-demo/CreativeStudioCreateLab.tsx`
- `src/agent/components/creative-studio-demo/CreativeStudioEmptyProjectEditor.tsx`
- `src/agent/components/creative-studio-demo/CreativeStudioEnterpriseDemo.module.css`
- `src/agent/components/creative-studio-demo/CreativeStudioEnterpriseDemo.tsx`
- `src/agent/components/creative-studio-demo/CreativeStudioHome.tsx`
- `src/agent/components/creative-studio-demo/CreativeStudioProjectSetup.tsx`
- `src/agent/components/creative-studio-demo/studio-v3-navigation.ts`

This handoff document is the only documentation addition.

Unless a diagnosed issue proves that another demo-only file is required, the next session must keep design corrections within the eight application files above plus this handoff document. It must not modify production APIs, Prisma schema or migrations, workers, provider adapters, authentication, billing, publishing, or legacy production Creative Studio behavior during the demo correction.

## 4. What the V4 demo attempted

The V4 work attempted to demonstrate:

- an Image Lab with Auto and Advanced modes;
- side-by-side Product and Model source selection;
- Product actions for Paste, Upload, and Gallery;
- Model actions for Library, Upload, and Avatar;
- a model/avatar picker drawer;
- a compact bottom-centered composer intended to remain visible while the workspace scrolls;
- project-name-first creation;
- an empty long-form editor after project creation;
- media upload entry points, timeline concepts, and canvas aspect presets;
- back-navigation and home-to-tool handoffs;
- `$0` local/demo behavior with provider execution disconnected.

Those concepts do not constitute visual acceptance. The owner found the result unprofessional and materially different from the references.

## 5. Honest failure record

### Owner-reported failures

The owner reported that:

- the design looks beginner-level or cartoon-like rather than first-class and enterprise-grade;
- the composition does not faithfully match the supplied ElevenLabs spatial hierarchy;
- the Image composer was initially an oversized panel pushed to the right instead of a compact floating card;
- controls were expanded into a dense form instead of being progressively disclosed inside a refined composer;
- the ALMA Aura theme, color discipline, spacing, typography, density, and component treatment were not followed consistently;
- Auto did not initially communicate the existing simple Product + saved Model flow clearly enough;
- the overall Creative Studio information architecture was incomplete or visually weak;
- previous proof focused on mechanics and geometry instead of professional visual judgment.

### Diagnosed implementation failure

The first V4 floating-composer attempt had a CSS cascade defect:

- `.v4FloatingComposer { position: fixed; }` appeared before a later rule with equal specificity;
- the later `.v3Composer { position: sticky; }` rule won;
- the live card therefore rendered as a large sticky/right-side panel instead of the intended fixed floating composer.

The later commits corrected that mechanical defect and internal scrolling, but the owner still rejected the design. Therefore the remaining problem is not merely a CSS-position bug. It is a broader design-system, hierarchy, density, interaction, and reference-fidelity failure.

### Process failure

The prior session presented a build that had not passed a sufficiently rigorous side-by-side visual review against the owner's references. The next session must not use “page loads,” “element is fixed,” or “tests pass” as a substitute for expert design review.

## 6. Owner's non-negotiable product and design requirements

### Visual quality

- The result must look like a premium, world-class creative application, not a generic admin form or a cartoon mockup.
- Use the existing ALMA Aura design language: restrained warmth, refined neutrals, disciplined coral accents, professional typography, careful borders, shadows, radii, and spacing.
- ElevenLabs is a behavioral and spatial reference, not a license to copy branding or assets.
- Preserve useful whitespace without wasting the viewport.
- Use progressive disclosure. The primary surface must remain simple; detailed controls should open through compact menus, sheets, drawers, or secondary states.
- Desktop, tablet, and mobile layouts must remain deliberate and usable.

### Creative Studio home

- Provide a real Creative Studio home/dashboard.
- Include clear entry points for Image, Video/Reel, Avatar, Project/Long-form editing, Audio/Voice/Music where applicable, Gallery/Assets, Finishing, Review, and other preserved production capabilities.
- Show recent projects and useful templates without turning the home into a giant form.
- Gallery/Assets must be organized and support adjustable density so the owner can view more assets at once.
- Home back navigation returns to the Agent area.

### Navigation

- Every Creative Studio subpage needs a clear back action to the Creative Studio home.
- The Creative Studio home needs a clear back action to the Agent area.
- Back navigation must preserve reasonable user context rather than unexpectedly opening an unrelated agent panel.

### Image Lab

- The Image Lab should follow the supplied ElevenLabs Image & Video interaction pattern:
  - explore/gallery or templates remain visible in the workspace;
  - a compact composer floats near the bottom center;
  - the composer remains available while the content behind it scrolls;
  - it must not become a giant right sidebar.
- Auto and Advanced belong in the same refined composer architecture.
- Auto must expose a simple, obvious Product + Model flow:
  - Product: Paste, Upload, Gallery;
  - Model: Library, Upload, Avatar;
  - Model selection can use an existing saved model, upload a new model, or select an avatar.
- Advanced must preserve the real production modes and choices, including Generate, Product-to-Model, Try-On, Swap, Face, Edit, Reel, family variants, provider/model selection, aspect, resolution, quality, count, background/creative direction, estimate, and applicable safeguards.
- Advanced controls must not all be permanently expanded. Use compact menus and progressive disclosure.
- Product/model references must remain bound to the selected operation and provider. Do not recreate the prior fidelity bug where references were silently ignored.
- Resolution labels must remain truthful: selecting 2K or 4K must not merely upscale the preview label while returning a lower-resolution artifact.

### Video/Reel

- Provide the same professional explore + floating-composer architecture.
- Support appropriate start frame, end frame, image references, asset/model/avatar selection, prompt, model, duration, aspect ratio, resolution, and applicable audio controls.
- Show useful default templates behind the composer.
- Preserve cost estimation and explicit confirmation before any paid execution.

### Avatar

- Preserve the existing production avatar capability.
- Avatars should be discoverable from the home and selectable as a model/reference source where appropriate.

### Gallery, Assets, and Finishing

- Preserve the production asset library, filters, provenance, and role/brand isolation.
- Add a professional organized gallery with adjustable card density.
- Preserve finishing workflows and all existing capabilities; redesign must not silently remove features.

### Projects and long-form editor

- Clicking Project/Long-form must first ask for a project name and necessary setup.
- A new project opens empty; it must not pretend that sample clips are the user's project.
- The user can upload or select images, video, audio, and other supported assets.
- Provide a professional preview/canvas, media/library area, track-based timeline, playhead, transport, zoom, trim/split/reorder controls, and appropriate inspectors.
- Canvas presets should include common professional formats such as portrait/reel, square, landscape, and other justified standards.
- Include the Creative/Studio Agent concept so the owner can request edits conversationally.
- The Agent must propose/validate changes through the authoritative composition command boundary; it must not bypass authorization, versioning, audit, cost, render, provider, or publishing controls.

## 7. Existing ERP, security, and cost rules that must survive

The redesign is a presentation and workflow improvement, not permission to weaken the platform.

- Preserve CSE1–CSE7 behavior and existing ERP boundaries.
- Preserve exact brand, project, product, asset, and role isolation.
- Preserve owner-only controls.
- Preserve append-only audit identifiers and review/version durability.
- Preserve optimistic version/concurrency-token enforcement.
- Preserve server-authoritative validation and cost estimates.
- Preserve hard cost caps and exact paid confirmation.
- Never silently fall back when an explicit provider/model was selected.
- Preserve provider, voice, render, export, and publish separation.
- Preserve worker/VPS rollout dependencies and display them honestly.
- Preserve the context-aware legacy fallback and keep V3 default-off until approved rollout.
- No fake success states.
- No secrets or credentials in code, logs, screenshots, or this document.
- During demo/audit verification: `$0` only. No paid generation, voice call, real render/export, external publish, or irreversible action.
- No production deployment and no merge to `main` without the owner's explicit confirmation after the final consolidated preview.

## 8. Mandatory next-session workflow

The next session must follow this order.

### Step 1 — Read rules and pass preflight

1. Read repository `AGENTS.md` completely before any action.
2. Use an isolated worktree on `codex/cs-enterprise-studio-demo-v4`.
3. Confirm clean local state, remote parity, exact ancestry, and the current handoff SHA.
4. Inspect the changed-file list against the demo allowlist.
5. Do not start from `main` and do not merge production branches into the demo branch.

### Step 2 — Audit the locked reference and current live demo

1. Open the locked V3 reference and current V4 preview.
2. Reuse the owner's authenticated Chrome.
3. Capture full-page and focused screenshots at desktop width before editing.
4. Exercise every demo route and interaction:
   - Home;
   - Image Auto;
   - Image Advanced and every mode;
   - Video/Reel;
   - Avatar;
   - Gallery/Assets and density controls;
   - Finishing;
   - Project setup;
   - empty long-form editor;
   - back-navigation paths.
5. Record console errors, failed runtime/API requests, inaccessible controls, overflow, and state-loss defects.

### Step 3 — Perform an independent read-only ElevenLabs audit

Use the owner's already authenticated Chrome session and inspect:

- `https://elevenlabs.io/app/studio?tab=architect`
- the ElevenLabs Image & Video explore/composer experience shown in the owner's reference screenshots.

Do not trigger paid generation, upload private business data, publish, or change the owner's external account.

Compare at least:

- page information architecture;
- spatial hierarchy;
- navigation depth;
- content density;
- composer width, location, layering, and scroll behavior;
- progressive disclosure;
- typography scale and weight;
- control sizing and hit targets;
- spacing rhythm;
- surface, border, shadow, and radius treatment;
- empty/loading/error/disabled states;
- asset and avatar browsing;
- project creation;
- editor/timeline structure;
- desktop/tablet/mobile behavior;
- keyboard focus and accessibility.

### Step 4 — Write the defect ledger before editing

Create a concise defect ledger in the next session's commentary or a branch document. Each defect must include:

- severity;
- route/state;
- current evidence;
- ElevenLabs/reference evidence;
- ALMA production parity impact;
- root cause;
- proposed demo-only correction;
- acceptance proof.

The session must independently identify problems; it must not simply rephrase the owner's complaints.

### Step 5 — Correct only the demo

After the diagnosis is recorded, correct the demo within the allowlisted demo files.

- Keep the locked reference SHA in ancestry.
- Preserve all required feature representations.
- Do not connect paid providers.
- Do not modify production APIs, workers, schema, migrations, auth, billing, or publishing.
- Avoid placeholder success claims.
- Use real production data shapes only where the existing demo safely exposes them; otherwise label fixtures honestly.

This step is authorized only to produce the corrected demo for owner review. It does not authorize production redesign implementation.

### Step 6 — Run proportional engineering and visual gates

At minimum:

- targeted component/unit tests for changed behavior;
- full applicable app test suite;
- lint;
- typecheck;
- production build;
- `git diff --check`;
- exact changed-file allowlist check;
- clean-worktree and remote-parity check after push;
- Vercel exact-Git-SHA deployment identity and `READY`;
- preview runtime/API and console inspection;
- desktop, tablet, and mobile screenshots;
- keyboard focus and accessible-name checks;
- `$0` proof.

If a preview defect is found, fix it on the same demo branch, rerun proportional gates, push a new SHA, and reverify the exact deployment.

### Step 7 — Present the corrected live demo and stop

Leave the corrected Creative Studio home visible in the owner's Chrome and provide:

- exact branch and SHA;
- preview alias and exact deployment;
- screenshot set;
- before/after defect ledger;
- complete route/interaction checklist;
- tests/build/typecheck/lint status;
- console/runtime/API status;
- spend (`$0`);
- known limitations and production dependencies.

Then stop at the owner approval gate.

Do not begin or resume production implementation, merge production branches, deploy production, or merge `main` until the owner explicitly confirms the corrected demo.

## 9. Visual acceptance checklist

The corrected demo is not ready for owner review unless all items below are demonstrably true.

- [ ] Current result was compared side-by-side with the supplied ElevenLabs references.
- [ ] The result follows ALMA Aura rather than ElevenLabs branding.
- [ ] Home looks like a premium creative operating system, not an admin dashboard.
- [ ] Image explore/gallery remains useful behind the composer.
- [ ] Image composer is compact, bottom-centered, layered, and stable during scroll.
- [ ] Composer does not obscure critical content or extend beyond the viewport.
- [ ] Auto presents Product and Model clearly and side-by-side at appropriate widths.
- [ ] Product offers Paste, Upload, and Gallery.
- [ ] Model offers Library, Upload, and Avatar.
- [ ] Advanced preserves all current production modes and choices through progressive disclosure.
- [ ] Video/Reel offers the required references, model, duration, aspect, resolution, and templates.
- [ ] Avatar is visible and connected to the relevant selection flow.
- [ ] Gallery is organized and has working density controls.
- [ ] Finishing and preserved production capabilities are represented.
- [ ] Every subpage returns to Creative Studio home.
- [ ] Creative Studio home returns to Agent.
- [ ] New Project is name-first and opens an empty editor.
- [ ] Editor has professional canvas presets, asset ingestion, timeline, and Creative Agent structure.
- [ ] Typography, spacing, controls, surfaces, shadows, and color are consistent and deliberate.
- [ ] Desktop, tablet, and mobile states are coherent.
- [ ] Focus, labels, keyboard navigation, and contrast pass the accessibility review.
- [ ] No provider call, paid generation, export, publishing, or production mutation occurred.
- [ ] The owner has explicitly approved the corrected live demo.

## 10. Prior verification evidence and its limit

For V4 SHA `47bf5251…`, the prior session recorded:

- Vercel deployment `READY`;
- exact Git metadata matching `47bf5251…`;
- Prisma reported 158 migrations with no pending migration in that preview build;
- no fatal runtime logs observed during the verification window;
- fixed composer geometry at a 2752 × 889 viewport:
  - left `996px`;
  - top `572px`;
  - width `760px`;
  - height `299px`;
  - bottom offset `18px`;
- composer geometry remained unchanged after internal workspace scrolling;
- Product picker opened;
- Advanced mode opened;
- Auto mode could be restored;
- no paid/provider/publish action was triggered.

Recorded screenshot:

`/Users/marufbillah/.codex/visualizations/2026/07/25/019f9802-541a-71d2-8146-9e3f62edc0f4/creative-studio-v4-reference-corrected.png`

This evidence is useful for regression comparison only. It is **not** a visual approval, and the owner explicitly rejected the result afterward.

## 11. Final authority boundary

The owner retains the final design, production rollout, and `main` merge decision.

Routine repository-local reads, demo edits, tests, builds, branch/tag/push, Vercel preview inspection, read-only ElevenLabs audit, and `$0` Chrome verification do not require repeated owner monitoring. The session must nevertheless stop for any credentials, paid action, external publishing, destructive data change, production deployment, or `main` merge.

The next session's immediate objective is only:

> Independently audit the rejected V4 demo against the owner's ElevenLabs references and ALMA Aura requirements, correct the demo, live-verify it at `$0`, show it to the owner, and stop for explicit approval before production implementation.

## 12. 2026-07-27 live-API audit ledger

Owner direction in the active review session expanded the demo correction to
include a real, read-only Creative Studio API connection on the preview branch.
The locked review baseline for that work is
`e348faea1c0d35102ce9d134fd7975df31d3059f`, tagged
`creative-studio-demo-v4-locked-e348faea1`.

The browser audit compared the authenticated ALMA preview with ElevenLabs
Studio and Image & Video. It also exercised Image Auto, all Advanced mode
entries, Video, Gallery density controls, Finishing, project setup, the empty
editor, and back navigation.

| Severity | Route / state | Evidence and root cause | Demo-only correction | Acceptance proof |
| --- | --- | --- | --- | --- |
| P0 | Home + Image/Video composers | Home claimed “6 providers healthy” and “6 / 6 healthy” while both composers said “No API connected”. All three claims were hard-coded fixture copy. | Read the existing owner-authenticated `/config` and `/health` routes and render one shared connection snapshot. | Browser shows a live API state and truthful engine/worker telemetry with no provider run. |
| P1 | Image Advanced | Every fixture engine remained selectable regardless of its server env, owner flag, or kill switch. | Map fixture provider IDs to the production engine registry and disable unavailable choices. | Browser provider menu agrees with the live config response. |
| P1 | Global connection recovery | There was no loading, degraded, retry, or last-checked state. | Add parent-owned async state plus an explicit `$0` refresh action. | Loading → connected/degraded transition is visible and keyboard accessible. |
| P1 | Paid action boundary | “Generation disconnected” conflated API connectivity with the preview’s spend lock. | Show connectivity independently; keep paid generation disabled and label it “locked in preview”. | Config/health requests return successfully while no POST `/run` request or spend occurs. |
| P2 | Composer hierarchy | Repeated disconnected labels added visual noise compared with the compact status treatment in the ElevenLabs reference. | Use one compact ALMA live-status capsule in Auto, Advanced, and Video. | Desktop screenshots show a stable compact badge without changing composer geometry. |
| P2 | Empty editor | The editor represented the capability only as “Agent”, weakening Creative Agent discoverability. | Rename the tool label to “Creative Agent”; keep it local and plan-only. | Empty editor exposes a “Creative Agent” control without creating a job. |

This work does not authorize a paid generation, render, export, publish,
production deployment, or `main` merge. Verification spend remains exactly
`$0`.

The audit additionally changes the existing demo-only verification file
`src/agent/components/creative-studio-demo/__tests__/studio-v3-fixtures.test.ts`.
This is the diagnosed exception to the eight application-file correction
allowlist: it proves that checking, local, available, unavailable, disabled,
and killed engine states cannot regress into hard-coded “healthy” UI claims.
It does not change production runtime behavior.
