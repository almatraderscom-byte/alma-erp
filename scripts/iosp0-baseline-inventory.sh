#!/usr/bin/env bash
# IOSP-0 reproducible static baseline inventory.
# Usage: bash scripts/iosp0-baseline-inventory.sh
# Run from the repo root. Pure read-only: greps + counts, no build required.
set -euo pipefail

IOS_SRC="ios/App/App"

echo "== IOSP-0 static inventory =="
echo "commit: $(git rev-parse HEAD)"
echo "branch: $(git rev-parse --abbrev-ref HEAD)"
echo

echo "-- Swift scale --"
echo "swift files: $(find "$IOS_SRC" ../AlmaWidget -name '*.swift' 2>/dev/null | grep -c . || true)"
find "$IOS_SRC" -name '*.swift' | xargs wc -l | tail -1 | awk '{print "total swift LOC (App target): " $1}'
echo
echo "-- top 15 files by LOC --"
find "$IOS_SRC" -name '*.swift' | xargs wc -l | sort -rn | head -16 | grep -v total || true
echo

count() { # count <label> <pattern>
  local n
  n=$( (grep -rE "$2" "$IOS_SRC" --include='*.swift' || true) | wc -l | tr -d ' ')
  printf "%-55s %s\n" "$1" "$n"
}

echo "-- static risk indicators (grep occurrence counts) --"
count "repeatForever animations" '\.repeatForever'
count "TimelineView(.animation)" 'TimelineView\(\.animation'
count "material/glass/blur uses" '(\.ultraThinMaterial|\.thinMaterial|\.regularMaterial|\.thickMaterial|UIBlurEffect|VisualEffect|\.blur\()'
count "hard-coded .font(.system(size:))" '\.font\(\.system\(size:'
count ".lineLimit(1)" '\.lineLimit\(1\)'
count ".minimumScaleFactor" '\.minimumScaleFactor'
count "explicit accessibility decls" 'accessibility(Label|Hint|Value|Element|AddTraits)'
count "Reduce Motion references" '(accessibilityReduceMotion|UIAccessibility\.isReduceMotionEnabled)'
count "Reduce Transparency references" '(accessibilityReduceTransparency|isReduceTransparencyEnabled)'
count "Differentiate Without Color refs" '(differentiateWithoutColor|shouldDifferentiateWithoutColor)'
count "dynamicTypeSize constraints" 'dynamicTypeSize'
count "UIScreen.main.bounds assumptions" 'UIScreen\.main\.bounds'
count "Timer.publish / scheduledTimer" '(Timer\.publish|Timer\.scheduledTimer)'
count "Task.sleep polling loops" 'Task\.sleep'
count "pushWeb call sites" 'pushWeb\('
count "WKWebView references" 'WKWebView'
count "deprecated WKProcessPool" 'WKProcessPool'
count "deprecated .allowBluetooth" 'allowBluetooth'
echo

echo "-- forced-web call sites (pushWeb) --"
grep -rn 'pushWeb(' "$IOS_SRC" --include='*.swift' | sed 's/^/  /'
echo

echo "-- polling cadence sites (seconds literals in sleep/timer) --"
grep -rnE '(Task\.sleep\(for: \.seconds\([0-9]+|Task\.sleep\(nanoseconds:|Timer\.publish\(every: [0-9.]+|scheduledTimer\(withTimeInterval: [0-9.]+)' "$IOS_SRC" --include='*.swift' | sed 's/^/  /'
