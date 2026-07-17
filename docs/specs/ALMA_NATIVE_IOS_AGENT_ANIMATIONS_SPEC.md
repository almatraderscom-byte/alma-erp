# ALMA Native iOS Agent Animations

## Claude Code Implementation Contract

This document is the single source of truth for implementing two confirmed animations in the existing native iOS agent experience:

1. Session-opening agent loading animation
2. Hidden pull-to-refresh interaction

Implement both experiences in native SwiftUI. Preserve the existing app architecture, screen structure, data flow, navigation, content, typography, colors, composer, toolbar, safe-area behavior, background work, task restoration, and agent functionality. Only add the animation layers and their required state management.

Do not redesign unrelated UI. Do not replace the current agent screen. Do not convert the screen into a web view. Do not copy Claude branding or assets.

---

# 1. Required Technical Approach

## Platform

- Native iOS and SwiftUI
- Minimum supported iOS version must follow the existing project target
- Use Core Haptics when available
- Use UIKit feedback generators as the fallback
- Use Canvas, Shape, gradients, blur, blend modes, TimelineView, PhaseAnimator, KeyframeAnimator, matchedGeometryEffect, or Metal only when appropriate for the existing deployment target
- No GIF, video, remote animation, HTML, JavaScript, WebView, or continuously decoded raster sequence
- Animation must remain smooth on a physical iPhone

## Files and ownership

Prefer isolated components similar to:

```text
AgentAnimations/
  AgentAwakeningOverlay.swift
  AgentAwakeningState.swift
  LivingAgentCharacter.swift
  AgentParticleField.swift
  AgentHaptics.swift
  AgentPullToRefresh.swift
  PullRefreshState.swift
  RefreshActivityStage.swift
  ReduceMotionFallback.swift
```

Adapt names to the current architecture. Do not create parallel navigation or duplicate the agent screen.

## Shared visual identity

- Dark iOS-native background
- Restrained glass material
- Violet aura as the primary energy color
- Mint/cyan as the live intelligence color
- Warm gold for waiting or progress
- Green for completed or ready
- Character must feel like the same agent in both animations
- Effects must remain crisp and premium, never childish, flat, game-like, or visually noisy

Suggested semantic tokens:

```swift
enum AgentMotionColor {
    static let violet = Color(red: 0.56, green: 0.45, blue: 1.00)
    static let mint = Color(red: 0.43, green: 0.96, blue: 0.86)
    static let gold = Color(red: 0.94, green: 0.70, blue: 0.35)
    static let success = Color(red: 0.42, green: 0.93, blue: 0.68)
}
```

Use existing app color tokens if equivalent tokens already exist.

---

# 2. Confirmed Animation A: Session-Opening Agent Loading

## Purpose

Show this animation only while an existing agent conversation/session is being restored and messages or active task state are not yet ready to display.

This is not a generic spinner. It is a short character-driven performance that makes the agent feel alive while real session restoration happens.

## Placement

- Keep the existing navigation/header unchanged
- Keep the existing bottom composer unchanged
- Center the performance inside the available content area between the header and composer
- Never cover the navigation controls or composer
- Respect safe areas and Dynamic Island devices
- Remove the overlay as soon as the real session becomes render-ready

## Important data rule

Animation progress must not invent backend progress. Use deterministic presentation phases while waiting for real readiness. The final state may begin only when the app confirms that the restored session is ready to render.

If restoration finishes early, gracefully accelerate to success. If restoration takes longer, loop only the subtle focus state. Never replay the full dialogue sequence repeatedly.

## State machine

```swift
enum AgentAwakeningPhase: Equatable {
    case hidden
    case arriving
    case greeting
    case searching
    case apologetic
    case discovered
    case finalizing
    case success
    case dismissing
}
```

Recommended transitions:

```text
hidden
  -> arriving
  -> greeting
  -> searching
  -> apologetic
  -> discovered
  -> finalizing (may loop subtly while real data is still loading)
  -> success (only after real readiness)
  -> dismissing
  -> hidden
```

## Character construction

Build one small floating glass agent with:

- Rounded, slightly organic glass body
- Dark inner face panel
- Two mint luminous eyes
- Small expressive mouth
- Tiny antenna with violet light
- Two short movable arms
- Violet/cyan aura
- Two or three fine orbit paths
- A soft shadow under the character
- Small energy particles

The character must be drawn natively. Keep it compact and readable on a phone. It should not look like a human, animal, emoji, or copied Claude pixel mascot.

## Exact performance

### Phase 1: Arriving

- Start at approximately 5% scale
- Begin 36 to 46 points below the final center position
- Opacity 0
- Blur 12 to 16 points
- Slight negative rotation
- Spring into the final position
- Duration: 0.8 to 1.1 seconds
- Overshoot must be gentle
- Aura assembles slightly before the body finishes settling

### Phase 2: Greeting

Display:

```text
Shhh… boss আসছে!
```

- Character is still slightly small and shy
- It peeks sideways
- Eyes glance toward the speech bubble
- One arm moves a little
- Bubble appears with a soft spring
- Do not use a typing indicator

### Phase 3: Searching

Display:

```text
Boss! একটু wait… 👀
```

- Character grows toward normal size
- Eyes scan left and right
- Orbit speed increases slightly
- Tiny activity particles appear at different surrounding positions
- Body floats with a slow 3.0 to 3.8 second breathing cycle

### Phase 4: Apologetic reaction

Display:

```text
Oops, boss sorry! অনেক কাজ 😅
```

- Clear nervous acting
- Eyebrows or eye angle become worried
- Mouth becomes a small circle
- Arms lift briefly
- Character performs a very small rapid shake
- Nearby task chips or particles briefly appear
- Use a light warning haptic once
- Never shake the whole app screen strongly

### Phase 5: Discovery

Display:

```text
YES! সব পেয়ে গেছি!
```

- Character stops suddenly
- One eye briefly winks
- One arm points upward or raises in discovery
- Aura spins faster
- A restrained light flash occurs behind the character, not across the whole screen
- Use a crisp light impact haptic

### Phase 6: Finalizing

Display:

```text
Last touch, boss… magic চলছে ✦
```

- Character becomes focused
- Eyes narrow slightly
- A mint scan line moves through the character or its orbit field
- Fine particles converge into the core
- This state may loop gently while waiting for real readiness
- No repeated dialogue animation during the loop

### Phase 7: Success

Display:

```text
Happy boss? DONE! ✦
```

- Switch the aura toward mint/success green
- Character grows approximately 12% to 16%
- Eyes become happy arcs
- Cheeks may glow subtly
- Both arms lift
- Character makes two small celebration bounces
- Fine confetti particles emit once
- A large but soft circular success wave expands behind it
- Show a short glowing `READY` reveal and let it dissolve upward
- Use a success haptic pattern

### Phase 8: Dismissal

- Crossfade the restored real content underneath
- Character scales to 0.94 while fading
- Blur no more than 4 points during dismissal
- Total dismissal: 0.25 to 0.4 seconds
- Never leave a blank frame between overlay removal and session content

## Suggested timing

The dialogue performance may use approximately 1.4 to 1.8 seconds per phase, but real readiness controls completion.

```text
0.00s  arriving
0.85s  greeting
2.30s  searching
3.85s  apologetic
5.40s  discovered
6.75s  finalizing
ready  success
+1.10s dismissing
```

## Loading haptics

Create a shared `AgentHaptics` service. Prepare generators before playback.

Suggested mapping:

```text
arriving:       no haptic
apologetic:     UIImpactFeedbackGenerator(style: .soft), intensity 0.45
discovered:     UIImpactFeedbackGenerator(style: .light), intensity 0.75
success start:  UINotificationFeedbackGenerator.success
success bounce: optional soft follow-up 70 to 100 ms later
```

If using Core Haptics, keep the success pattern short and clean. Do not create continuous buzzing.

---

# 3. Confirmed Animation B: Hidden Pull-to-Refresh

## Non-negotiable idle behavior

This requirement is critical.

When the user is not pulling:

- Refresh layer height must be exactly `0`
- No reserved blank space
- No aura
- No portal
- No dots
- No character
- No percentage
- No `Pull down` label
- No refresh hint
- The existing content begins exactly where it begins today
- The user must not be able to tell that a custom refresh animation exists

The refresh experience is revealed only by a downward overscroll gesture while the scroll view is already at its top boundary.

## Gesture behavior

The animation must be interactive, not automatically played.

```text
scroll offset = 0 and downward drag begins
  -> reveal hidden stage according to drag distance
drag continues
  -> progress and acting update continuously
threshold crossed
  -> one haptic tick and armed state
user keeps holding
  -> character remains alive in an armed holding loop
user drags upward below threshold
  -> disarm haptic and reverse state
release below threshold
  -> cancel and collapse to exactly 0
release above threshold
  -> lock stage temporarily, execute real refresh, play completion
refresh finishes
  -> collapse to exactly 0 and restore ordinary scrolling
```

## State model

```swift
enum PullRefreshPhase: Equatable {
    case idle
    case revealing(progress: CGFloat)
    case observing(progress: CGFloat)
    case collecting(progress: CGFloat)
    case armed
    case refreshing
    case celebrating
    case collapsing
}
```

## Pull math

Use raw downward overscroll only when the scroll view is at the top.

Recommended values, tuned after testing on physical devices:

```swift
let threshold: CGFloat = 104
let maximumVisualPull: CGFloat = 128
let resistance: CGFloat = 0.58

let resistedPull = min(maximumVisualPull, max(0, rawPull * resistance))
let progress = min(1, resistedPull / threshold)
```

Do not trigger while the user is scrolling normal content. Do not fight system back gestures, navigation gestures, text selection, or horizontal gestures.

## Reveal choreography controlled by progress

### 0.00 progress: Fully hidden

- Stage height 0
- All animation elements not rendered or fully clipped
- Existing content at its original top position

### 0.01 to 0.20: Peek

- Content follows the finger downward
- A dark portal edge becomes barely visible
- Character peeks from behind the top edge
- Only the eyes and top of the glass body appear
- No instructional label until there is enough vertical room

### 0.20 to 0.52: Observe

- Character reveals more of its body
- It looks left and right
- Eyes follow pull direction subtly
- Violet aura fades in based on progress
- First two live signal dots appear

### 0.52 to 0.92: Collect

- Character becomes fully visible
- Remaining live activity signals appear
- Arms extend toward the signals
- Signals magnetically drift closer as progress increases
- Character body shows increasing energy
- The animation must remain directly scrubbed by the user's finger

### 0.92 to 1.00: Prepare

- Signals are nearly collected
- Aura tightens around the character
- Character braces itself
- The last portion has slightly stronger resistance

### 1.00: Armed

- Fire one clear threshold haptic only once
- Character catches all signals
- A compact energy bag/core becomes visibly heavy
- Character performs a small continuous wobble while the user holds
- Display `Release to refresh` only if the current design has enough room
- Do not start refresh while the user is still holding

### Dragging back below threshold

- Reverse the visual state continuously
- Fire one very light disarm tick only when crossing below the hysteresis boundary
- Use hysteresis to prevent repeated haptics:

```swift
armThreshold = 1.00
disarmThreshold = 0.94
```

### Release below threshold

- Cancel refresh
- Animate content and stage back to zero with an interactive spring
- Character retreats into the top edge
- Remove all refresh elements after collapse
- No completion haptic

### Release above threshold

- Lock visual height near the threshold while refresh is executing
- Character kicks or releases the collected energy downward into the feed
- Use a medium impact haptic at the release action
- Call the real refresh operation exactly once
- Disable duplicate refresh triggers until the operation finishes

### Real refresh completion

- Do not show success until the data refresh actually completes
- Update content first in the model
- Animate refreshed rows with a restrained staggered spring
- Character raises both arms and performs a short celebration
- Emit one small particle burst
- Use a success haptic
- Collapse stage smoothly back to 0
- Return content to its exact normal position

## Refresh haptics

Suggested mapping:

```text
threshold armed:        light impact, crisp, intensity around 0.8
threshold disarmed:     selection feedback or very soft impact
release to refresh:     medium impact
refresh success:        notification success
refresh failure:        notification error, then collapse with no celebration
```

Haptics must be edge-triggered, not emitted on every drag update.

## Scroll integration

Use the technique that best fits the current project:

- iOS 18 scroll geometry APIs when the deployment target supports them
- A named coordinate space and preference key for older SwiftUI targets
- A small UIScrollView bridge only if existing SwiftUI architecture cannot expose reliable top overscroll

Do not nest multiple vertical scroll views. Do not add a second scroll view above the existing content. Do not break lazy loading, scroll position restoration, keyboard dismissal, navigation swipe, or accessibility scrolling.

Suggested wrapper interface:

```swift
struct AgentPullToRefresh<Content: View>: View {
    let isEnabled: Bool
    let refresh: @Sendable () async throws -> Void
    @ViewBuilder let content: () -> Content
}
```

The refresh layer must be an overlay/background revealed through clipping and content translation, not permanent layout spacing.

---

# 4. Motion and Physics

## Recommended springs

Tune on a physical iPhone. Starting points:

```swift
let revealSpring = Animation.interactiveSpring(
    response: 0.30,
    dampingFraction: 0.86,
    blendDuration: 0.10
)

let characterSpring = Animation.spring(
    response: 0.42,
    dampingFraction: 0.68
)

let collapseSpring = Animation.spring(
    response: 0.36,
    dampingFraction: 0.88
)
```

Gesture-driven properties must not use delayed animation. While the finger is down, update position directly from progress. Springs apply on cancel, release, state transitions, and completion.

## Frame-rate rules

- Target 60 fps and allow 120 Hz ProMotion
- Avoid repeatedly creating blur views during drag
- Prebuild reusable particle geometry
- Keep particle count conservative
- Avoid large full-screen shadows
- Avoid animating layout-heavy view trees every frame
- Use transforms, opacity, clipping, Canvas, and drawing groups carefully
- Profile with Instruments on a physical device

---

# 5. Accessibility and System Behavior

## Reduce Motion

When `accessibilityReduceMotion` is enabled:

- Keep pull interaction functional
- Replace complex acting with opacity, scale, and a simple progress ring
- Remove shake, orbit, confetti, large shockwave, and repeated bounces
- Preserve threshold and completion haptics when haptics are enabled

## VoiceOver

- Do not expose decorative character pieces as separate accessibility elements
- Present one combined status element
- Announce `Release to refresh` when armed
- Announce `Refreshing`
- Announce `Refresh complete` or `Refresh failed`
- Keep existing content reading order unchanged

## Other requirements

- Respect Low Power Mode by reducing particle count and expensive blur
- Respect app lifecycle. Pause display-link work when backgrounded
- Do not play haptics in the background
- Cancel obsolete animation tasks safely when the view disappears
- Use structured concurrency, not unmanaged delayed callbacks scattered through views

---

# 6. Integration Rules

1. Locate the existing native iOS agent session screen and its scroll container.
2. Identify the real session restoration readiness signal.
3. Identify the real refresh async operation.
4. Add the loading overlay without changing existing content or navigation.
5. Wrap or extend the existing top-level scroll behavior for interactive pull progress.
6. Keep both animation systems independent but reuse the same character and haptic service.
7. Do not show the session-opening animation during an ordinary pull refresh.
8. Do not enable pull refresh while the opening overlay is active.
9. Prevent concurrent refresh operations.
10. Preserve background agent execution and restored-task behavior.

---

# 7. Acceptance Criteria

## Session-opening animation

- Character clearly enters from small to full size
- Every phase has visibly different body language
- Finalizing loops without restarting dialogue
- Success is tied to actual session readiness
- Composer and header never move
- No blank flash before messages render
- Haptics occur at the specified moments

## Pull-to-refresh

- At idle, absolutely no indicator or reserved space is visible
- The content's idle position matches the original screen pixel-for-pixel
- Indicator appears only during top-edge downward overscroll
- Animation progress follows the finger without lag
- Threshold haptic fires once per crossing
- Holding above threshold does not trigger refresh prematurely
- Releasing below threshold cancels
- Releasing above threshold triggers the real refresh once
- Success appears only after the real refresh finishes
- Final collapse returns the stage to exactly 0 height
- Repeated pulls do not leave stale state, gaps, dots, text, or aura

## Performance

- Smooth on a physical iPhone
- No runaway TimelineView, display link, timer, or task
- No duplicate haptics
- No duplicate API refresh
- No scroll jump after completion
- No impact on navigation, keyboard, composer, or background agent work

---

# 8. Required Tests

Add unit tests for:

- Loading state transition reducer
- Pull progress calculation
- Resistance and clamping
- Arm and disarm hysteresis
- Refresh triggers exactly once
- Cancel below threshold
- Success waits for async completion
- Failure state

Add UI tests for:

- Idle state has zero refresh height
- Short pull cancels
- Long pull and hold remains armed
- Release triggers refresh
- Repeated refresh works
- Reduce Motion path
- VoiceOver label/state changes

Test manually on:

- A Dynamic Island iPhone
- A smaller iPhone viewport
- 60 Hz and ProMotion devices when available
- Light and dark appearance if the agent screen supports both
- Slow network and immediate cached response
- Refresh failure
- App background/foreground during restoration and refresh

---

# 9. Claude Code Execution Instructions

Before editing:

1. Inspect the current iOS agent screen, scroll implementation, session restoration flow, refresh function, design tokens, and haptic utilities.
2. Reuse existing architecture and tokens where possible.
3. List the exact files that will change.
4. Confirm that no unrelated UI or functionality will be modified.

During implementation:

1. Implement the shared character and haptic layer first.
2. Implement the session-opening state machine and bind final success to real readiness.
3. Implement interactive pull progress with a completely hidden idle layer.
4. Connect release to the real async refresh.
5. Add Reduce Motion and VoiceOver behavior.
6. Add tests.
7. Build and run the native iOS target.
8. Fix all warnings or regressions introduced by this work.

After implementation, report:

- Files changed
- How real readiness and real refresh were connected
- Haptic mapping used
- Reduce Motion behavior
- Tests executed and results
- Any unavoidable platform limitation

Do not claim completion based only on code compilation. Verify both interactions on an iOS simulator and, when possible, a physical iPhone for haptics and gesture feel.

---

# Final Non-Negotiable Instruction

The objective is not to create something merely similar. Reproduce the confirmed behavior, choreography, character personality, color identity, motion hierarchy, pull thresholds, hidden idle state, and haptic moments described in this document as closely as native SwiftUI allows.

Do not simplify the character into a spinner. Do not show the pull indicator before pulling. Do not reserve refresh space at rest. Do not fake completion before real data is ready. Do not modify anything outside this feature unless technically necessary, and clearly explain any necessary supporting change.
