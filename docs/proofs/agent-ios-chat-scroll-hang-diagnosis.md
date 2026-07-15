# DIAGNOSIS — Assistant chat scroll-down bounce + full app freeze (iOS 26 sim, build-73 branch)

Date: 2026-07-15 · Reporter: owner (live sim test) · Status: **diagnosis only — no code changed** (per repo rule: fix after owner approval)

## Owner-reported symptoms

1. **Scroll-down bounce:** in a conversation whose last assistant reply is very large (the 6-site live-browser report: long Bangla markdown + tool rows + an inline browser screenshot), tapping the round scroll-down arrow scrolls toward the bottom and then slides back up — repeated taps never reach the true bottom.
2. **App freeze:** shortly after, the app stopped responding entirely (taps, scrolls, send button all dead). The owner saw it; my automation clicks during the same window also did nothing (initially misread as missed clicks — the owner's correction was right).

## Evidence captured (before relaunch)

- `sample` of the hung process, 3s: **213/213 main-thread samples inside ONE SwiftUI layout commit** — `_UIHostingView.layoutSubviews → ViewGraphRootValueUpdater.render → AG::Graph::UpdateStack::update` churning (AttributeGraph frames at top-of-stack = actively computing, not waiting). File: [agent-ios73-hang-sample-1.txt](./agent-ios73-hang-sample-1.txt)
- Second sample minutes later, 2s: **1603/1603 samples, same stack** — the layout loop is sustained/permanent, not a transient stall. File: [agent-ios73-hang-sample-2.txt](./agent-ios73-hang-sample-2.txt)
- App-code frames visible inside the churn: `AgentScrollBottomKey.reduce` (AssistantSwiftUI.swift:7618), `AgentScrollViewportKey`, plus heavy `LazyVStack` / `ScrollViewLayoutComputer` / CoreText re-measure of large `Text`.
- Memory flat at ~229 MB (no leak/runaway allocation — pure CPU layout loop).
- Kill + relaunch fully recovers; the same conversation reloads fine and stays responsive until the next trigger.

## Root-cause analysis

The assistant thread (AssistantSwiftUI.swift `body`, ~7274-7440) stacks THREE per-layout-pass geometry feedback channels on one `ScrollView`+`LazyVStack`:

1. `scrollOffsetReader` — a `GeometryReader` **inside the content** publishing `AgentScrollBottomKey` (content maxY) on every layout pass (line 7341/7573).
2. A `GeometryReader` background on the ScrollView publishing `AgentScrollViewportKey` (viewport height), whose `onPreferenceChange` **writes state** `scrollViewportH` (line 7355-7360).
3. iOS 18+ `onScrollGeometryChange` (AgentNearBottomScrollModifier) writing the `nearBottom` state (line 7625+).

With a huge lazy row set (one assistant message ≈ thousands of Bangla-markdown characters + tool cards + `AgentToolScreenshotThumb`), a layout pass changes measured content height → preference values change → state writes (`scrollViewportH`, `nearBottom`) → SwiftUI invalidates → the giant `Text`/`LazyVStack` re-measures → heights differ again → repeat. On the iOS 26 scroll system this closes into a **same-frame AttributeGraph update cycle**: the main thread never finishes the layout pass — that is the freeze. The samples show exactly this loop with both custom PreferenceKeys participating.

The **scroll-down bounce is the same instability seen before it saturates**: the arrow's `proxy.scrollTo(bottomID, anchor: .bottom)` (line 7405) computes a target offset from *estimated* lazy-row heights; as target rows mount, `AgentToolScreenshotThumb` jumps from a **110 pt placeholder to up to 190 pt** on image load (lines 5168-5183) and big markdown rows resolve taller than estimated → content height grows → landed offset is no longer the bottom → visible upward slide, `nearBottom` (<120 pt) stays false, arrow persists, every retry repeats the cycle. LazyVStack unmounts the rows again on the way; `AsyncImage` re-enters its placeholder phase on remount, so the geometry never converges.

Contributing (not primary): the multi-line composer changes the bottom safe-area inset while text is being written into it, adding another viewport-height perturbation through channel 2's `>0.5 pt` guard.

## Why this appeared now

Not introduced by the continuation commit (`152298fe` touches only send/continuation logic, no layout). This is a **pre-existing latent defect** in the chat scroll machinery (present on main since the presentation-parity/scroll work) that needs an unusually TALL single message to trigger — the 6-site live-browser report is the first owner-visible message of that size. Build 72 on TestFlight has the same code shape; a device user hitting a very long reply could freeze the same way.

## Proposed fix direction (pending owner approval — not implemented)

1. Reserve stable heights for chat images (fixed-height thumb container regardless of load phase) so row heights cannot jump on mount/load.
2. Collapse the three geometry feedback channels: on iOS 18+, derive BOTH `nearBottom` and the viewport height from the single supported `onScrollGeometryChange` signal and delete the two per-layout `GeometryReader`/PreferenceKey channels (keep them only for the iOS 17 fallback path).
3. Make the arrow's scroll-to-bottom converge: after the animated `scrollTo`, one non-animated corrective `scrollTo` on the next runloop tick (standard lazy-content two-pass), or scroll to the last message id with `.bottom` anchor.

Each step is small and UI-invisible (no design change). Step 1+2 remove the freeze trigger; step 3 fixes the bounce even under residual height noise.
