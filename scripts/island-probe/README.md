# Live Activity height probe (160pt cap verification)

Renders PulseExpandedBody (3 pages) + PulseLockScreenView offscreen with
ImageRenderer and PRINTS measured heights. PASS: lock ≤160pt, island bottom ≤92pt.
Recipe (sim udid in docs/ios-build-77-handoff.md):

    mkdir -p /tmp/islandprobe/P.app && cp scripts/island-probe/fixture.json /tmp/islandprobe/
    cp scripts/island-probe/Probe-Info.plist /tmp/islandprobe/P.app/Info.plist
    SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
    xcrun swiftc -sdk "$SDK" -target arm64-apple-ios17.0-simulator \
      scripts/island-probe/pmain.swift ios/App/App/PulseActivityAttributes.swift \
      ios/App/AlmaWidget/PulseLiveActivity.swift ios/App/App/AlmaPulseIntents.swift \
      -o /tmp/islandprobe/P.app/P
    xcrun simctl install $UDID /tmp/islandprobe/P.app
    xcrun simctl launch --console-pty $UDID com.almatraders.islandprobe | grep MEASURE

Run this after ANY widget layout change — the build never warns, the device clips.
