#!/bin/bash
# Generate a privacy-minimal, fail-closed iOS build provenance resource.
#
# The five generated Capacitor inputs are intentionally gitignored. A tracked,
# canonical sha256sum manifest therefore binds them to a clean Git revision,
# while the optional product check proves that Xcode copied those exact bytes
# into the app bundle. Unverified local builds still receive a valid plist, but
# never a commit claim. Archive/preflight callers add --require-verified.

set -u
set -o pipefail

readonly VERIFIED_STATUS="verified-clean-source-and-bundled-inputs"
readonly STATUS_REPOSITORY="unavailable-repository"
readonly STATUS_DIRTY="unavailable-dirty-worktree"
readonly STATUS_UNTRUSTED="unavailable-untrusted-input-path"
readonly STATUS_BUNDLED_MISMATCH="unavailable-bundled-input-mismatch"
readonly STATUS_PRODUCT_MISMATCH="unavailable-product-copy-mismatch"

repository_root=""
repository_root_argument=""
manifest_path=""
product_root=""
output_path=""
source_only=0
require_verified=0
temporary_output=""
temporary_listing=""

usage() {
  cat >&2 <<'USAGE'
Usage: ios-build-provenance.sh \
  --repository-root PATH \
  --manifest PATH \
  --output PATH \
  [--product-root PATH | --source-only] \
  [--require-verified]
USAGE
}

die_usage() {
  echo "ios-build-provenance: $1" >&2
  usage
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repository-root|--manifest|--product-root|--output)
      [[ $# -ge 2 && -n "$2" ]] || die_usage "$1 requires a non-empty path"
      case "$1" in
        --repository-root) repository_root="$2" ;;
        --manifest) manifest_path="$2" ;;
        --product-root) product_root="$2" ;;
        --output) output_path="$2" ;;
      esac
      shift 2
      ;;
    --source-only)
      source_only=1
      shift
      ;;
    --require-verified)
      require_verified=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die_usage "unknown argument: $1"
      ;;
  esac
done

[[ -n "$repository_root" ]] || die_usage "--repository-root is required"
[[ -n "$manifest_path" ]] || die_usage "--manifest is required"
[[ -n "$output_path" ]] || die_usage "--output is required"
if [[ "$source_only" -eq 1 && -n "$product_root" ]]; then
  die_usage "--source-only and --product-root are mutually exclusive"
fi
if [[ "$source_only" -eq 0 && -z "$product_root" ]]; then
  die_usage "--product-root is required unless --source-only is used"
fi

cleanup() {
  if [[ -n "$temporary_output" && -e "$temporary_output" ]]; then
    rm -f -- "$temporary_output"
  fi
  if [[ -n "$temporary_listing" && -e "$temporary_listing" ]]; then
    rm -f -- "$temporary_listing"
  fi
}

handle_signal() {
  local signal_exit="$1"
  trap - EXIT HUP INT TERM
  cleanup
  exit "$signal_exit"
}

trap cleanup EXIT
trap 'handle_signal 129' HUP
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM

write_plist() {
  local revision_status="$1"
  local commit_value="${2:-}"
  local output_directory

  output_directory=$(dirname -- "$output_path") || return 1
  mkdir -p -- "$output_directory" || return 1

  # `mv source existing-directory` succeeds by moving source *inside* that
  # directory. Reject every non-regular exact destination (including dangling
  # symlinks) before creating a temporary file so provenance can never be
  # reported as written at a path where no plist exists.
  if [[ -L "$output_path" ]]; then
    return 1
  fi
  if [[ -e "$output_path" && ! -f "$output_path" ]]; then
    return 1
  fi
  temporary_output=$(mktemp "${output_path}.tmp.XXXXXX") || return 1

  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0">'
    printf '%s\n' '<dict>'
    printf '%s\n' '  <key>schemaVersion</key>'
    printf '%s\n' '  <integer>1</integer>'
    printf '%s\n' '  <key>revisionStatus</key>'
    printf '  <string>%s</string>\n' "$revision_status"
    if [[ "$revision_status" == "$VERIFIED_STATUS" && -n "$commit_value" ]]; then
      printf '%s\n' '  <key>commit</key>'
      printf '  <string>%s</string>\n' "$commit_value"
    fi
    printf '%s\n' '</dict>'
    printf '%s\n' '</plist>'
  } > "$temporary_output" || return 1

  chmod 0644 "$temporary_output" || return 1

  # Repeat the exact-path type check immediately before the atomic rename.
  if [[ -L "$output_path" ]]; then
    return 1
  fi
  if [[ -e "$output_path" && ! -f "$output_path" ]]; then
    return 1
  fi
  mv -f -- "$temporary_output" "$output_path" || return 1

  # A successful command is not sufficient evidence: assert the requested
  # destination itself is now a regular, non-symlink plist before claiming it.
  [[ -f "$output_path" && ! -L "$output_path" ]] || return 1
  temporary_output=""
  return 0
}

finish() {
  local final_status="$1"
  local final_commit="${2:-}"

  if ! write_plist "$final_status" "$final_commit"; then
    echo "ios-build-provenance: could not write provenance plist" >&2
    exit 1
  fi

  printf 'ALMA build provenance: %s\n' "$final_status"
  if [[ "$require_verified" -eq 1 && "$final_status" != "$VERIFIED_STATUS" ]]; then
    exit 1
  fi
  exit 0
}

is_full_commit() {
  local candidate="$1"
  [[ "$candidate" =~ ^[0-9a-f]{40}$ || "$candidate" =~ ^[0-9a-f]{64}$ ]]
}

canonical_directory() {
  local directory="$1"
  [[ -d "$directory" ]] || return 1
  (cd "$directory" 2>/dev/null && pwd -P)
}

logical_directory() {
  local directory="$1"
  [[ -d "$directory" ]] || return 1
  (cd "$directory" 2>/dev/null && pwd -L)
}

canonical_file() {
  local file_path="$1"
  local file_directory
  local file_name

  [[ -e "$file_path" || -L "$file_path" ]] || return 1
  file_directory=$(dirname -- "$file_path") || return 1
  file_name=$(basename -- "$file_path") || return 1
  file_directory=$(canonical_directory "$file_directory") || return 1
  printf '%s/%s\n' "$file_directory" "$file_name"
}

is_within_repository() {
  local candidate="$1"
  case "$candidate" in
    "$repository_root"/*) return 0 ;;
    *) return 1 ;;
  esac
}

has_symlink_component() {
  local relative_path="$1"
  local current="$repository_root"
  local component
  local previous_ifs="$IFS"

  case "$relative_path" in
    /*|*//*|../*|*/../*|*/..|.|..|*'/./'*) return 0 ;;
  esac

  IFS='/'
  for component in $relative_path; do
    [[ -n "$component" ]] || { IFS="$previous_ifs"; return 0; }
    current="$current/$component"
    if [[ -L "$current" ]]; then
      IFS="$previous_ifs"
      return 0
    fi
  done
  IFS="$previous_ifs"
  return 1
}

sha256_file() {
  local file_path="$1"
  local digest_output
  local digest

  digest_output=$(shasum -a 256 "$file_path" 2>/dev/null) || return 1
  digest="${digest_output%% *}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$digest"
}

declare -a manifest_hashes
declare -a manifest_paths
readonly EXPECTED_MANIFEST_COUNT=5
readonly -a EXPECTED_MANIFEST_PATHS=(
  "ios/App/App/capacitor.config.json"
  "ios/App/App/config.xml"
  "ios/App/App/public/cordova.js"
  "ios/App/App/public/cordova_plugins.js"
  "ios/App/App/public/index.html"
)
readonly MANIFEST_REPOSITORY_PATH="ios/App/BuildSupport/alma-bundled-inputs.sha256"

load_manifest() {
  local line
  local line_pattern='^([0-9a-f]{64})  ([^[:space:]]+)$'
  local index=0

  manifest_hashes=()
  manifest_paths=()
  [[ -f "$manifest_path" && ! -L "$manifest_path" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ $line_pattern ]] || return 1
    manifest_hashes+=("${BASH_REMATCH[1]}")
    manifest_paths+=("${BASH_REMATCH[2]}")
  done < "$manifest_path"

  [[ "${#manifest_paths[@]}" -eq "$EXPECTED_MANIFEST_COUNT" ]] || return 1
  for ((index = 0; index < EXPECTED_MANIFEST_COUNT; index++)); do
    [[ "${manifest_paths[$index]}" == "${EXPECTED_MANIFEST_PATHS[$index]}" ]] || return 1
  done
  return 0
}

public_set_is_exact() {
  local public_directory="$1"
  local entry
  local entry_count=0
  local set_is_exact=1

  [[ -d "$public_directory" && ! -L "$public_directory" ]] || return 1

  temporary_listing=$(mktemp "${TMPDIR:-/tmp}/alma-public-inputs.XXXXXX") || return 1
  if ! find "$public_directory" -mindepth 1 -print > "$temporary_listing" 2>/dev/null; then
    rm -f -- "$temporary_listing"
    temporary_listing=""
    return 1
  fi

  while IFS= read -r entry; do
    entry_count=$((entry_count + 1))
    if [[ "$entry" != "$public_directory/cordova.js" &&
          "$entry" != "$public_directory/cordova_plugins.js" &&
          "$entry" != "$public_directory/index.html" ]]; then
      set_is_exact=0
      break
    fi
    if [[ ! -f "$entry" || -L "$entry" ]]; then
      set_is_exact=0
      break
    fi
  done < "$temporary_listing"

  rm -f -- "$temporary_listing"
  temporary_listing=""
  [[ "$set_is_exact" -eq 1 && "$entry_count" -eq 3 ]]
}

# Return 0 for verified source inputs, 2 for an untrusted path, and 1 for a
# content/set mismatch. This lets the caller preserve the closed status reason.
verify_source_inputs() {
  local manifest_canonical
  local expected_manifest_canonical
  local manifest_directory
  local manifest_directory_logical
  local manifest_directory_physical
  local manifest_tree_entry
  local manifest_tree_mode
  local manifest_tree_type
  local -a manifest_compare_status
  local source_path
  local bootstrap_path="mobile/www/index.html"
  local digest
  local index

  if [[ -L "$manifest_path" ]]; then
    return 2
  fi
  manifest_directory=$(dirname -- "$manifest_path") || return 1
  manifest_directory_logical=$(logical_directory "$manifest_directory") || return 1
  manifest_directory_physical=$(canonical_directory "$manifest_directory") || return 1
  [[ "$manifest_directory_logical" == "$manifest_directory_physical" ]] || return 2
  manifest_canonical=$(canonical_file "$manifest_path") || return 1
  expected_manifest_canonical="$repository_root/$MANIFEST_REPOSITORY_PATH"
  [[ "$manifest_canonical" == "$expected_manifest_canonical" ]] || return 2
  is_within_repository "$manifest_canonical" || return 2
  [[ -f "$manifest_canonical" && ! -L "$manifest_canonical" ]] || return 2
  has_symlink_component "$MANIFEST_REPOSITORY_PATH" && return 2

  manifest_tree_entry=$(git -C "$repository_root" ls-tree "$initial_head" -- \
    "$MANIFEST_REPOSITORY_PATH" 2>/dev/null) || return 2
  [[ -n "$manifest_tree_entry" ]] || return 2
  manifest_tree_mode="${manifest_tree_entry%% *}"
  [[ "$manifest_tree_mode" == "100644" || "$manifest_tree_mode" == "100755" ]] || return 2
  manifest_tree_type=$(git -C "$repository_root" cat-file -t \
    "$initial_head:$MANIFEST_REPOSITORY_PATH" 2>/dev/null) || return 2
  [[ "$manifest_tree_type" == "blob" ]] || return 2

  # Do not trust index stat shortcuts for this binding. Compare the canonical
  # worktree manifest bytes directly with the blob in the revision we may stamp.
  git -C "$repository_root" cat-file blob \
    "$initial_head:$MANIFEST_REPOSITORY_PATH" 2>/dev/null \
    | cmp -s "$manifest_canonical" -
  manifest_compare_status=("${PIPESTATUS[@]}")
  [[ "${manifest_compare_status[0]}" -eq 0 && "${manifest_compare_status[1]}" -eq 0 ]] \
    || return 1

  load_manifest || return 1
  command -v shasum >/dev/null 2>&1 || return 1
  command -v cmp >/dev/null 2>&1 || return 1

  for ((index = 0; index < EXPECTED_MANIFEST_COUNT; index++)); do
    has_symlink_component "${manifest_paths[$index]}" && return 2
    source_path="$repository_root/${manifest_paths[$index]}"
    [[ -f "$source_path" && ! -L "$source_path" ]] || return 1
    digest=$(sha256_file "$source_path") || return 1
    [[ "$digest" == "${manifest_hashes[$index]}" ]] || return 1
  done

  has_symlink_component "$bootstrap_path" && return 2
  [[ -f "$repository_root/$bootstrap_path" && ! -L "$repository_root/$bootstrap_path" ]] || return 1
  public_set_is_exact "$repository_root/ios/App/App/public" || return 1
  cmp -s "$repository_root/ios/App/App/public/index.html" \
    "$repository_root/$bootstrap_path" || return 1
  return 0
}

product_has_symlink_component() {
  local relative_path="$1"
  local current="$product_root"
  local component
  local previous_ifs="$IFS"

  IFS='/'
  for component in $relative_path; do
    [[ -n "$component" ]] || { IFS="$previous_ifs"; return 0; }
    current="$current/$component"
    if [[ -L "$current" ]]; then
      IFS="$previous_ifs"
      return 0
    fi
  done
  IFS="$previous_ifs"
  return 1
}

verify_product_inputs() {
  local relative_path
  local product_path
  local digest
  local index

  [[ -d "$product_root" && ! -L "$product_root" ]] || return 1
  public_set_is_exact "$product_root/public" || return 1

  for ((index = 0; index < EXPECTED_MANIFEST_COUNT; index++)); do
    relative_path="${manifest_paths[$index]#ios/App/App/}"
    [[ "$relative_path" != "${manifest_paths[$index]}" ]] || return 1
    product_has_symlink_component "$relative_path" && return 1
    product_path="$product_root/$relative_path"
    [[ -f "$product_path" && ! -L "$product_path" ]] || return 1
    digest=$(sha256_file "$product_path") || return 1
    [[ "$digest" == "${manifest_hashes[$index]}" ]] || return 1
  done
  return 0
}

validate_product_output_contract() {
  local product_root_logical
  local product_root_physical
  local output_parent
  local output_parent_logical
  local output_parent_physical
  local output_name

  [[ -d "$product_root" && ! -L "$product_root" ]] || return 1
  product_root_logical=$(logical_directory "$product_root") || return 1
  product_root_physical=$(canonical_directory "$product_root") || return 1
  [[ "$product_root_logical" == "$product_root_physical" ]] || return 1

  output_parent=$(dirname -- "$output_path") || return 1
  output_name=$(basename -- "$output_path") || return 1
  [[ "$output_name" == "alma-build-provenance.plist" ]] || return 1
  output_parent_logical=$(logical_directory "$output_parent") || return 1
  output_parent_physical=$(canonical_directory "$output_parent") || return 1
  [[ "$output_parent_logical" == "$output_parent_physical" ]] || return 1
  [[ "$output_parent_physical" == "$product_root_physical" ]] || return 1

  product_root="$product_root_physical"
  output_path="$product_root_physical/alma-build-provenance.plist"
  return 0
}

snapshot_head=""
snapshot_clean=0
verify_index_visibility() {
  local -a visibility_status

  # `git status` intentionally honors assume-unchanged/skip-worktree. A clean
  # claim therefore requires proving that no tracked path in the entire index
  # carries either flag. With `ls-files -v`, lowercase tags are
  # assume-unchanged and `S` is skip-worktree. awk consumes the full listing so
  # Git cannot be mistaken for failing because a short-reading grep closed it.
  git -C "$repository_root" ls-files -v 2>/dev/null \
    | LC_ALL=C awk '
        /^[a-zS] / { hidden = 1 }
        END { exit hidden ? 0 : 1 }
      '
  visibility_status=("${PIPESTATUS[@]}")
  [[ "${visibility_status[0]}" -eq 0 ]] || return 1
  if [[ "${visibility_status[1]}" -eq 0 ]]; then
    return 2
  fi
  [[ "${visibility_status[1]}" -eq 1 ]] || return 1
  return 0
}

capture_repository_snapshot() {
  local candidate_head
  local porcelain
  local visibility_result

  candidate_head=$(git -C "$repository_root" rev-parse --verify HEAD 2>/dev/null) || return 1
  is_full_commit "$candidate_head" || return 1
  porcelain=$(git -C "$repository_root" status --porcelain=v1 \
    --untracked-files=all --ignore-submodules=none 2>/dev/null) || return 1
  # The TestFlight workflow stamps ALMAGitCommit into Info.plist before the
  # archive (forensics parity with the Mac path; shipped since build 94). That
  # sanctioned single-file stamp is the ONLY tracked modification the guard
  # tolerates, and only when the file's sole diff is the ALMAGitCommit value —
  # anything else in Info.plist, or any other path, still fails closed.
  if [[ -n "$porcelain" ]]; then
    # Two sanctioned CI writes, each tolerated only when its diff is exactly
    # the known benign shape: the workflow's ALMAGitCommit stamp in Info.plist,
    # and CocoaPods rewriting its own "COCOAPODS: x.y.z" version line in
    # Podfile.lock (the runner's gem version differs from the committing Mac's;
    # named by the dirty diagnostics on the build-103 archive, 2026-08-13).
    # Any other line in either file, or any other path, still fails closed.
    local unexplained
    unexplained=$(printf '%s\n' "$porcelain" \
      | grep -cvE '^ M ios/App/(App/Info\.plist|Podfile\.lock)$' || true)
    if [[ "$unexplained" -eq 0 ]]; then
      local benign=1
      local plist_diff
      plist_diff=$(git -C "$repository_root" diff -- ios/App/App/Info.plist 2>/dev/null)
      if [[ -n "$plist_diff" ]] \
        && printf '%s\n' "$plist_diff" | grep -E '^[+-]' \
          | grep -vE '^(\+\+\+|---)' | grep -vE 'ALMAGitCommit|^[+-][[:space:]]*<string>[0-9a-f]{40}</string>$' \
          | grep -q .; then
        benign=0
      fi
      local pods_diff
      pods_diff=$(git -C "$repository_root" diff -- ios/App/Podfile.lock 2>/dev/null)
      if [[ -n "$pods_diff" ]] \
        && printf '%s\n' "$pods_diff" | grep -E '^[+-]' \
          | grep -vE '^(\+\+\+|---)' | grep -vE '^[+-]COCOAPODS: [0-9][0-9.]*$' \
          | grep -q .; then
        benign=0
      fi
      [[ "$benign" -eq 1 ]] && porcelain=""
    fi
  fi
  verify_index_visibility
  visibility_result=$?
  [[ "$visibility_result" -ne 1 ]] || return 1
  snapshot_head="$candidate_head"
  if [[ -z "$porcelain" && "$visibility_result" -eq 0 ]]; then
    snapshot_clean=1
  else
    snapshot_clean=0
  fi
  return 0
}

if [[ "$source_only" -eq 0 ]]; then
  if ! validate_product_output_contract; then
    echo "ios-build-provenance: invalid product/output path contract" >&2
    exit 2
  fi
fi

# Repository availability and exact-root identity are resolved before any
# content checks so a path cannot borrow another checkout's HEAD. Keep the
# logical spelling long enough to reject a repository reached through a
# symlink; the canonical path is used for every subsequent operation.
repository_root_argument="$repository_root"
repository_root_logical=$(logical_directory "$repository_root_argument") \
  || finish "$STATUS_REPOSITORY"
repository_root=$(canonical_directory "$repository_root_argument") \
  || finish "$STATUS_REPOSITORY"
git_top=$(git -C "$repository_root" rev-parse --show-toplevel 2>/dev/null) \
  || finish "$STATUS_REPOSITORY"
git_top=$(canonical_directory "$git_top") || finish "$STATUS_REPOSITORY"
[[ "$git_top" == "$repository_root" ]] || finish "$STATUS_REPOSITORY"

capture_repository_snapshot || finish "$STATUS_REPOSITORY"
initial_head="$snapshot_head"
initial_clean="$snapshot_clean"
[[ "$repository_root_logical" == "$repository_root" ]] || finish "$STATUS_UNTRUSTED"

verify_source_inputs
source_result=$?
if [[ "$source_result" -eq 2 ]]; then
  finish "$STATUS_UNTRUSTED"
elif [[ "$source_result" -ne 0 ]]; then
  finish "$STATUS_BUNDLED_MISMATCH"
fi

if [[ "$initial_clean" -ne 1 ]]; then
  # Name the dirt: a bare "dirty-worktree" cost a full CI archive cycle to
  # diagnose (build 103, 2026-08-13). Paths only — file contents never leak.
  git -C "$repository_root" status --porcelain=v1 --untracked-files=all \
    | head -40 | sed 's/^/ALMA build provenance dirty: /' >&2 || true
  finish "$STATUS_DIRTY"
fi

if [[ "$source_only" -eq 0 ]]; then
  verify_product_inputs || finish "$STATUS_PRODUCT_MISMATCH"
fi

# Re-read every ignored/generated input after each Git observation. The status
# precedence remains source trust/content before dirty Git, and dirty Git before
# copied-product mismatch.
capture_repository_snapshot || finish "$STATUS_REPOSITORY"

verify_source_inputs
source_result=$?
if [[ "$source_result" -eq 2 ]]; then
  finish "$STATUS_UNTRUSTED"
elif [[ "$source_result" -ne 0 ]]; then
  finish "$STATUS_BUNDLED_MISMATCH"
fi

if [[ "$snapshot_clean" -ne 1 || "$snapshot_head" != "$initial_head" ]]; then
  git -C "$repository_root" status --porcelain=v1 --untracked-files=all \
    | head -40 | sed 's/^/ALMA build provenance dirty: /' >&2 || true
  finish "$STATUS_DIRTY"
fi

if [[ "$source_only" -eq 0 ]]; then
  verify_product_inputs || finish "$STATUS_PRODUCT_MISMATCH"
fi

capture_repository_snapshot || finish "$STATUS_REPOSITORY"

verify_source_inputs
source_result=$?
if [[ "$source_result" -eq 2 ]]; then
  finish "$STATUS_UNTRUSTED"
elif [[ "$source_result" -ne 0 ]]; then
  finish "$STATUS_BUNDLED_MISMATCH"
fi

[[ "$snapshot_clean" -eq 1 && "$snapshot_head" == "$initial_head" ]] \
  || finish "$STATUS_DIRTY"

if [[ "$source_only" -eq 0 ]]; then
  verify_product_inputs || finish "$STATUS_PRODUCT_MISMATCH"
fi

# This is the final immediate ignored-source/product verification. There is no
# test-only bypass or hook in the production generator.
finish "$VERIFIED_STATUS" "$initial_head"
