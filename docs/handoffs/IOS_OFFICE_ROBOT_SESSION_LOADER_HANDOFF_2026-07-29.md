# iOS Office Robot + Agent Session Loader Handoff

Date: 2026-07-29
Source branch: `codex/ios-office-robot-session-loader`
Source base: `dcbb91d189005e85e683d14d1be2adc91d005c01` (Build 88 main)
Target device used for native proof: iPhone 17 Pro Max, iOS 26.5
Simulator UDID: `94E0186B-5CDA-4708-9368-53B4FF7274E7`

## Authority and merge intent

This branch is the isolated handoff for the iOS Agent Loader / global Office Robot work discussed in the imported “Alma ERP iOS Pet” conversation. It must be combined with the other active session's branch in a new integration session, verified as one batch, shown to the owner, and only then used for a TestFlight build after the owner explicitly approves.

Do not merge this branch directly to `main` and do not create a TestFlight build without the owner's confirmation.

At branch creation the local base was nine commits behind `origin/main`. This was intentional: the working tree already contained the approved Robot work and another Claude session was active in a separate worktree. No pull, reset, checkout of another branch, or modification of Claude's worktree was performed.

## Locked product decisions

- The Agent section's own Robot/loader remains independent from the global Office Robot.
- The global Office Robot replaces the old Office Chat bubble and keeps its Office Chat/Call behavior.
- The global Office Robot remains visible on every allowed app page, including Agent.
- The Agent screen's existing message layout, composer, thinking/tool UI, and new-session hero remain unchanged except for the specific settings/model-label/session-loading fixes described below.
- The owner-provided approve and reject SFX files are the canonical sounds.
- The pending count itself is the expand/collapse control; there is no separate expand chip.
- A pending row must route to the exact actionable approval, not merely the Approvals tab.
- No video artifact is required; the owner will inspect the prepared Simulator.

## Implemented work

### 1. Agent Loader preference

- Agent Loader is available from Agent Settings / More settings, not from the Robot long-press quick-action menu.
- The two existing loaders remain selectable:
  - Robot Pet
  - Starburst
- The selected loader is stored per device and used by Agent loading surfaces.
- Fresh/default behavior selects Robot Pet while preserving an explicit user choice.

Primary files:

- `ios/App/App/AlmaStarburstSpinner.swift`
- `ios/App/App/MoreMenuSwiftUI.swift`
- `ios/App/App/FloatingChatHead.swift`

### 2. Compact model names

- Long provider/model labels are normalized to a short display name.
- The same shortening function is used by the header/model pill and live thinking row.
- Unknown future model labels are capped so they cannot consume the phone width.

Primary file:

- `ios/App/App/AssistantSwiftUI.swift`

### 3. Meaningful pending actions on the global Robot

- The Robot badge shows actionable pending approvals instead of an unexplained global aggregate.
- Tapping the number expands the pending list.
- Tapping the number again collapses the list.
- Expanded rows show serial number, headline, summary, and disclosure indicator.
- Tapping a row routes to the correct Business or Agent approval surface.
- Agent approvals carry both conversation ID and action ID so the exact card can be scrolled into view.
- The target Agent approval card receives a temporary highlight.
- Completed fixture actions are removed and the badge count decreases immediately.
- The Agent/Business header count follows the currently selected approval category.

Primary files:

- `ios/App/App/GlobalOfficeRobotStore.swift`
- `ios/App/App/GlobalOfficeRobotView.swift`
- `ios/App/App/ApprovalsSwiftUI.swift`
- `ios/App/App/AlmaNavBridge.swift`
- `ios/App/App/AssistantSwiftUI.swift`
- `ios/App/App/AlmaAPI.swift`
- `src/app/api/assistant/actions/route.ts`
- `src/agent/lib/background-tasks/pet-status.ts`

### 4. Approve/reject Robot reactions

- The previous duplicate approval animation/banner path was removed from native approval screens.
- Business and Agent approvals feed one global Robot reaction path.
- Approve:
  - Robot grows from dock position.
  - Processing movement runs until the decision settles.
  - Success movement, haptic, and owner-supplied approve SFX play.
  - Robot returns to its prior dock position.
- Reject:
  - Robot grows from dock position.
  - Disappointed/shake/glitch movement runs.
  - Reject haptic and owner-supplied reject SFX play.
  - No extra emoji/cross eyes are drawn over the sprite's real face.
  - Robot returns to its prior dock position.

Canonical sounds:

- `ios/App/App/Sounds/RobotApproveSFX.mp3`
- `ios/App/App/Sounds/RobotRejectSFX.mp3`

Primary files:

- `ios/App/App/GlobalOfficeRobotStore.swift`
- `ios/App/App/GlobalOfficeRobotView.swift`
- `ios/App/App/ApprovalsSwiftUI.swift`
- `ios/App/App/AttendanceSwiftUI.swift`
- `ios/App/App/PayrollSwiftUI.swift`
- `ios/App/App/StaffMonitorSystemSwiftUI.swift`
- `ios/App/App.xcodeproj/project.pbxproj`

### 5. Task state, completion, and Live Activity wiring

- Owner-scoped Pet/task status is exposed through the Assistant API.
- Pending/actionable items and running work feed the global Robot store.
- Approve/reject routes publish meaningful state updates.
- Completion/checkpoint/open-task flows publish Live Activity state updates.
- The existing Pulse/Live Activity system is extended instead of creating a competing activity.
- Widget/Island Robot glyph and state revision fields are included.
- Foreground polling and restore paths remain lifecycle-aware.

Primary files:

- `src/agent/lib/background-tasks/pet-status.ts`
- `src/agent/lib/pulse-live-update.ts`
- `src/agent/lib/pulse-snapshot.ts`
- `src/agent/lib/checkpoint.ts`
- `src/agent/lib/open-task.ts`
- `src/agent/lib/turn-completion-notify.ts`
- `src/app/api/assistant/pet-status/route.ts`
- `src/app/api/assistant/actions/[id]/approve/route.ts`
- `src/app/api/assistant/actions/[id]/reject/route.ts`
- `src/app/api/cron/live-activity-push/route.ts`
- `src/lib/pulse-state.ts`
- `ios/App/App/LiveActivityBridge.swift`
- `ios/App/App/PulseNativeSync.swift`
- `ios/App/App/PulseRestore.swift`
- `ios/App/App/PulseActivityAttributes.swift`
- `ios/App/AlmaWidget/PulseLiveActivity.swift`
- `ios/App/AlmaWidget/OfficeRobotLiveGlyph.swift`

Important: Simulator verification proves layout, state transitions, build integration, and app-side activity wiring. Continuous/background Dynamic Island behavior still requires the final real-iPhone check because ActivityKit scheduling and throttling are hardware/system controlled.

### 6. Previous-session loader duplication fix

Root cause:

- `restoreTick` started the awakening overlay before the old timeline was cleared.
- The old reply footer/wordmark could remain behind the session loader.
- `AlmaPageLoader` and `AgentAwakeningOverlay` were mounted together.
- The new-session hero was gated only by `messages.isEmpty`, so a temporarily empty existing conversation could render `AL + Robot + MA`.

Fix:

- `loadingHistory` is set before clearing the prior timeline.
- The old timeline is cleared before the awakening tick.
- `AgentAwakeningOverlay` is the only existing-session loader.
- The timeline stays transparent under that loader.
- `AgentEmptyStateView` is allowed only when `conversationId == nil`.

Primary file:

- `ios/App/App/AssistantSwiftUI.swift`

## Simulator proof checklist

All native checks below used only:

`iPhone 17 Pro Max (94E0186B-5CDA-4708-9368-53B4FF7274E7), iOS 26.5`

### Pending/action routing

- PASS — collapsed Robot showed three pending approvals.
- PASS — tapping the number expanded the three serial rows.
- PASS — first row opened Agent Approvals with the exact Inventory card at the top.
- PASS — approving Inventory removed it and changed count 3 → 2.
- PASS — expanded list reindexed the remaining rows.
- PASS — Meta row opened and highlighted the exact Meta card.
- PASS — rejecting Meta removed it and changed count 2 → 1.
- PASS — Staff row opened and highlighted the exact Staff card.
- PASS — approving Staff removed it and changed count 1 → 0.
- PASS — zero pending state removed the approval count from the Robot.
- PASS — approve/reject fixture actions used the same production Robot reaction/SFX path.

### Session-loader regression

- PASS — deterministic restore state exposed one accessibility element: `এজেন্ট সেশন লোড হচ্ছে`.
- PASS — no `AL`, `MA`, or `ALMA robot` home-hero accessibility elements existed during restore.
- PASS — no second `AlmaPageLoader` was visible beneath the session Robot.
- PASS — after restore, the real saved conversation rendered.
- PASS — opening New Chat still showed the unchanged `AL + Robot + MA` hero.
- PASS — global Office Robot remained separate and visible as designed.

### Stability and compilation

- PASS — App + Widget workspace build:

```bash
xcodebuild -quiet \
  -workspace ios/App/App.xcworkspace \
  -scheme App \
  -configuration Debug \
  -destination 'platform=iOS Simulator,id=94E0186B-5CDA-4708-9368-53B4FF7274E7' \
  -derivedDataPath /tmp/alma-session-loader-dd \
  build
```

- PASS — `git diff --check`
- PASS — `npm run type-check`
- PASS — focused Vitest suite: 3 files, 39 tests

```bash
npx vitest run \
  src/agent/lib/background-tasks/__tests__/pet-status.test.ts \
  src/app/api/assistant/actions/__tests__/route.test.ts \
  src/lib/__tests__/pulse-state.test.ts
```

- PASS — no recent `App` crash report was created during Simulator exercise.
- Existing third-party/deprecation warnings remain; no new warning was introduced by the session-loader fix.

Build note: invoking the bare `.xcodeproj` against a completely new DerivedData path cannot resolve CocoaPods modules. The correct clean command uses `App.xcworkspace`, as shown above.

## Integration-session checklist

The next session must:

1. Read this handoff before changing code.
2. Record the other session's branch name and this branch name.
3. Start from a clean integration branch based on current `origin/main`.
4. Bring in the commits from both branches; do not merge either branch directly to `main`.
5. Resolve overlap carefully in these hotspots:
   - `ios/App/App/AssistantSwiftUI.swift`
   - `ios/App/App/ApprovalsSwiftUI.swift`
   - `ios/App/App/GlobalOfficeRobotStore.swift`
   - `ios/App/App.xcodeproj/project.pbxproj`
   - Live Activity / Pulse files
6. Preserve every locked product decision listed above.
7. Run `git diff --check`.
8. Run `npm run type-check`.
9. Run the focused 39-test suite.
10. Build App + Widget from `App.xcworkspace` for the exact iPhone 17 Pro Max Simulator.
11. Recheck:
    - Agent Loader settings and both choices
    - Short model name
    - Robot pending number expand/collapse
    - Exact Business and Agent approval routing
    - Approve/reject Robot movement, haptic, and supplied SFX
    - No overlaid reject eyes
    - New Chat hero unchanged
    - Previous-session load shows only one session Robot
    - Global Office Robot remains independent from Agent's own Robot
    - Dynamic Island layout/state transitions and Voice coexistence
12. Show the integrated Simulator result to the owner.
13. Ask for explicit owner approval before TestFlight.
14. Only after approval, update to a clean pushed `main`, run `bash scripts/ios-build-preflight.sh`, bump/commit/push the build number, and start one TestFlight build.

## Do not include during merge

The source worktree also contains unrelated untracked local artifacts. They are intentionally excluded from this branch commit, including:

- `.DS_Store`
- `build/`
- unrelated `.github` workflow drafts
- unrelated docs/archives/zips
- `voiceorbbundle.zip`
- local workspace instruction files
