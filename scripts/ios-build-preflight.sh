#!/usr/bin/env bash
# iOS TestFlight preflight — run BEFORE every Archive / `xcodebuild archive`.
#
#   bash scripts/ios-build-preflight.sh
#
# WHY THIS EXISTS (owner report, build 69, 2026-07-12): every new TestFlight
# build kept losing features that already worked in an earlier build. Root
# cause: builds 63–69 were archived from whatever state a Mac checkout happened
# to be in — uncommitted files, unpushed commits, or a branch missing work that
# had already been merged (or was still sitting on the OTHER Mac / an unmerged
# session branch). git history proves it: the last build number ever committed
# is 62. An archive that isn't reproducible from a pushed commit WILL silently
# drop features.
#
# This script refuses to bless an archive unless:
#   1. the working tree is clean (nothing uncommitted),
#   2. HEAD is pushed (no local-only commits),
#   3. the branch contains ALL of origin/main (nothing already-shipped missing),
#   4. you are on main — or explicitly override for a preview build.
# It then stamps the exact commit into the app (ALMAGitCommit in Info.plist,
# also shown nowhere in UI — it's for forensics via ipa inspection) so every
# TestFlight build is traceable to one commit forever.
#
# Override (preview/experimental archive only — NEVER for a real TestFlight):
#   ALMA_PREFLIGHT_ALLOW_BRANCH=1 bash scripts/ios-build-preflight.sh

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; NC=$'\033[0m'
fail() { echo "${RED}✗ PREFLIGHT FAILED:${NC} $1"; echo "  $2"; exit 1; }

echo "— iOS build preflight —"

# 0. Fresh remote truth first (the whole point is catching the OTHER Mac's work).
git fetch origin main --quiet || fail "cannot fetch origin/main" \
  "No network? Do not archive blind — the other Mac's work may be missing."

BRANCH=$(git rev-parse --abbrev-ref HEAD)
SHA=$(git rev-parse --short=10 HEAD)

# 1. Clean tree — an archive must be reproducible from a commit.
if [[ -n "$(git status --porcelain)" ]]; then
  fail "uncommitted changes in the working tree" \
    "Commit (or stash) everything first. Un-committed code in a TestFlight build can never be recovered or reasoned about later."
fi

# 2. HEAD must be pushed — otherwise the next session/Mac builds WITHOUT this work.
if ! git merge-base --is-ancestor HEAD "origin/${BRANCH}" 2>/dev/null; then
  fail "HEAD has commits that are not pushed to origin/${BRANCH}" \
    "Run: git push -u origin ${BRANCH}  — two-Mac rule: never archive unpushed work."
fi

# 3. Must contain everything already merged to main — this is the regression gate.
if ! git merge-base --is-ancestor origin/main HEAD; then
  MISSING=$(git log --oneline HEAD..origin/main | head -5)
  fail "this checkout is MISSING work that is already on origin/main" \
    "An archive from here will silently drop shipped features. Missing (top 5):
${MISSING}
  Fix: git merge origin/main (or rebase), resolve, push, then re-run."
fi

# 4. Real TestFlight builds ship from main.
if [[ "$BRANCH" != "main" && "${ALMA_PREFLIGHT_ALLOW_BRANCH:-0}" != "1" ]]; then
  fail "not on main (on: ${BRANCH})" \
    "TestFlight builds ship from main so every build = one merged, pushed commit.
  Preview archive from a branch: ALMA_PREFLIGHT_ALLOW_BRANCH=1 bash scripts/ios-build-preflight.sh"
fi

# 5. Stamp the commit into Info.plist so the .ipa is forever traceable.
PLIST="ios/App/App/Info.plist"
if [[ -f "$PLIST" ]] && command -v /usr/libexec/PlistBuddy >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Set :ALMAGitCommit ${SHA}" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :ALMAGitCommit string ${SHA}" "$PLIST"
  echo "${YLW}ℹ${NC} Stamped ALMAGitCommit=${SHA} into Info.plist — commit this with your build-number bump."
fi

# 6. Reminder: the build number itself must be a committed fact.
BUILD_NUM=$(grep -m1 'CURRENT_PROJECT_VERSION' ios/App/App.xcodeproj/project.pbxproj | grep -o '[0-9]\+' || echo '?')
echo "${GRN}✓ preflight passed${NC} — branch=${BRANCH} commit=${SHA} CURRENT_PROJECT_VERSION=${BUILD_NUM}"
echo "  Before uploading: bump CURRENT_PROJECT_VERSION in Xcode, COMMIT + PUSH the bump"
echo "  (message: 'chore(ios): bump build to N'), then archive. Build number in git = build number on TestFlight, always."
