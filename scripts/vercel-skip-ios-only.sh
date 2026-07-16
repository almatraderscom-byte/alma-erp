#!/usr/bin/env bash
# Vercel "Ignored Build Step" (vercel.json ignoreCommand).
# Exit 0  = SKIP the build.   Exit 1 = BUILD.
#
# Why: iOS-native phase branches (agent-phase-N) change only ios/** and docs/**,
# yet every push burned a slot in this project's concurrency-1 build queue —
# jamming real web deploys behind ~45-min container hangs (owner-hit 2026-07-14
# and 2026-07-17). A commit that cannot change the web output should never
# start a web build.
#
# Safety: production ALWAYS builds; any error/uncertainty falls through to BUILD.

set -u

# 1) Production deploys are never skipped.
if [ "${VERCEL_ENV:-}" = "production" ]; then
  echo "[skip-ios-only] production → build"
  exit 1
fi

# Paths that cannot affect the web build output.
is_web_irrelevant() {
  case "$1" in
    ios/*|docs/*|scripts/ios*|scripts/vercel-skip-ios-only.sh) return 0 ;;
    *) return 1 ;;
  esac
}

# 2) Pick the diff base: the branch's previously deployed commit if Vercel
#    gives us one, else the merge-base with main (first push of a new branch).
BASE=""
if [ -n "${VERCEL_GIT_PREVIOUS_SHA:-}" ] && git cat-file -e "${VERCEL_GIT_PREVIOUS_SHA}^{commit}" 2>/dev/null; then
  BASE="$VERCEL_GIT_PREVIOUS_SHA"
else
  # Public repo — fetch main and use the branch point as the base.
  git fetch --no-tags --depth=100 origin main >/dev/null 2>&1 || true
  BASE="$(git merge-base HEAD origin/main 2>/dev/null || true)"
fi

if [ -z "$BASE" ]; then
  echo "[skip-ios-only] no diff base found → build (fail-open)"
  exit 1
fi

CHANGED="$(git diff --name-only "$BASE" HEAD 2>/dev/null)"
if [ -z "$CHANGED" ]; then
  echo "[skip-ios-only] empty diff vs $BASE → build (fail-open)"
  exit 1
fi

while IFS= read -r f; do
  [ -z "$f" ] && continue
  if ! is_web_irrelevant "$f"; then
    echo "[skip-ios-only] web-relevant change: $f → build"
    exit 1
  fi
done <<EOF_FILES
$CHANGED
EOF_FILES

echo "[skip-ios-only] only ios/docs changes since $BASE → SKIP build"
exit 0
