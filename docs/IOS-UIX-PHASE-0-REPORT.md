# iOS Agent UI/UX Phase 0 — Visual Freeze and Safety Harness

Date: 20 July 2026

Baseline commit: `4886277ab7de4e3821ffeee2af36082776d1e5f3`

Device: iPhone 17 Pro Max simulator, iOS 26.5

Branch: `agent-phase-ios-uiux-0-3`

## Audit verdict

The roadmap diagnosis is substantially correct. The current ALMA visual identity is strong and must be retained, but the safety harness was incomplete:

- no XCTest/XCUITest or Assistant snapshot target;
- no deterministic Assistant light/dark golden matrix;
- no Assistant action/location inventory;
- no formal VoiceOver, Dynamic Type, Reduce Motion or Reduce Transparency baseline;
- no complete performance sequence for open, prepend, finalize and artifact preview.

Existing environment-gated fixtures are retained and reused. Phase 0 does not redesign or extract the 10,000-line Assistant surface.

## Preservation inventory

| Surface | Current source of truth | Frozen expectation |
|---|---|---|
| Aurora and ALMA palette | `AgentAuroraBackground`, `AgentPalette` | Same color language and layer order |
| Native header | `makeAssistantTab`, `AssistantBarHooks` | Hamburger, title and coral new-chat remain |
| User/assistant composition | `AgentMessageRow`, chronological blocks | Coral user bubble and current operational rows remain |
| Composer | `AgentComposerView`, `AgentNeonBorder` | Same silhouette, neon border, plus/model/mic/voice/send order |
| Cost footer | message footer rendering | Same Σ/input/cache/output/cost/step information |
| Background Tasks | anchor and `AgentBackgroundTasksSheet` | Same anchor/count/sheet behaviour |
| Project/history drawer | `AgentSideDrawer` | Chat/Memory, filters, create, rename/archive/delete retained |
| Artifact surface | badge, sheet and viewer | Existing badge remains an entry point |
| Voice console | `AlmaVoiceConsoleView` | Existing native voice experience retained |

## Action inventory baseline

The native Assistant currently contains 76 explicit `Button` sites, 30 explicit plain styles, around 66 direct haptic-generator references and fewer than 20 explicit accessibility annotations. The exact repeatable counts are produced by:

```text
bash scripts/ios-agent-uiux-baseline-audit.sh
```

The main action groups are:

- navigation: drawer, new chat, artifacts and Background Tasks;
- composer: attachment, model, microphone, voice and send/stop;
- message: copy, listen, save, feedback and tool/detail disclosure;
- cards: approve, reject, opinion and ask choices;
- drawer: open, search, project filter/create, rename, archive and delete;
- files/artifacts: open, copy, share and web handoff;
- long-running work: continue, cancel and finished-task detail.

## Fixture coverage

Phase 0 extends the existing parity fixture with deterministic approval, ask and generated-file rows. Existing stress, SSE, Background Tasks and protocol fixtures remain unchanged.

Performance breadcrumbs now cover:

- `assistant.open.begin` → `assistant.contentReady`;
- `sync.olderPage.begin` → `sync.olderPage.end` with mounted/add count and duration;
- `turn.finalize.begin` → `turn.finalize.end` with mounted count and duration;
- `artifact.preview.begin` → ready/fail with type and duration.

No message text, file content or secret is logged.

## Baseline proof

- `docs/proofs/ios-uix-phase0/baseline-assistant-mixed-dark.png`
- `docs/proofs/ios-uix-phase0/phase0-parity-action-file-baseline.png`

The reference proves the retained native header, ALMA aurora, coral user bubble, operational rows, cost footer, Background Tasks anchor, composer and tab shell on the agreed Pro Max simulator.

## Known Phase 0 limitations

- Full automated snapshot comparison remains Phase 8 work, matching the roadmap.
- Light mode, largest Dynamic Type and VoiceOver reference captures remain required in the final hardening matrix.
- The historical fixture still contains optional remote preview URLs; core preservation proof does not depend on their successful load.

## Gate result

- Baseline build: PASS after worktree-local dependency/Capacitor materialization.
- Source changes: additive diagnostics and deterministic fixture state only.
- Visual redesign: none.
- Remote mutation: none.
