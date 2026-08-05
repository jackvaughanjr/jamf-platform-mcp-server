#!/usr/bin/env bash
#
# Fails if a tracked file contains something that looks like a live identifier.
#
# WHY THIS IS MECHANICAL
# Every commit in this repo's early history was hand-swept for tenant ids, device
# ids, serials and org strings. That worked until it didn't: a genuine device UUID
# reached src/fleet.test.ts, copied from live output as a "realistic" test value,
# and the manual sweep missed it because the sweep compared against a 5-record
# sample fixture rather than the fleet. A contributor will not run the sweep at all.
#
# THE RULE
# No UUID-shaped literal may appear in a tracked file unless it uses a reserved
# synthetic prefix. Real identifiers are indistinguishable from invented ones by
# inspection, so the only workable rule is that invented ones must be *obviously*
# invented.
#
#   allowed:  deadbeef-0000-4000-8000-000000000001
#             00000000-0000-0000-0000-000000000000
#   rejected: anything else UUID-shaped
#
# Placeholders like {TENANT}, {DEVICE} and {ID} are unaffected — they are not
# UUID-shaped, which is the point of masking rather than truncating.
#
# LOCAL PATTERNS
# This script deliberately contains no organisation names, hostnames or other
# sensitive strings — a guard that enumerates what must not leak, leaks it. To
# check site-specific strings, create a gitignored `.identifier-patterns.local`
# with one grep -E pattern per line; blank lines and #comments are ignored.
#
# USAGE
#   scripts/check-no-identifiers.sh            # all tracked files
#   scripts/check-no-identifiers.sh --staged   # only staged files (pre-commit)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

UUID_RE='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
# Reserved synthetic prefixes. Keep in sync with the comment above and CONTRIBUTING.
SYNTHETIC_RE='^(deadbeef|00000000)-'

mode="${1:---all}"
violations=0

if [ "$mode" = "--staged" ]; then
  mapfile -t files < <(git diff --cached --name-only --diff-filter=ACM)
else
  mapfile -t files < <(git ls-files)
fi

[ "${#files[@]}" -gt 0 ] || exit 0

for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  # The guard's own documentation names the allowed prefixes; skip it and the docs
  # that must quote the rule.
  case "$f" in
    scripts/check-no-identifiers.sh|CONTRIBUTING.md) continue ;;
  esac

  while IFS=: read -r line_no match; do
    [ -n "$match" ] || continue
    if ! printf '%s' "$match" | grep -qE "$SYNTHETIC_RE"; then
      printf '\033[31mBLOCKED:\033[0m %s:%s contains a UUID-shaped literal: %s\n' "$f" "$line_no" "$match" >&2
      violations=1
    fi
  done < <(grep -noE "$UUID_RE" "$f" 2>/dev/null || true)
done

# Optional site-specific patterns, kept out of the repo on purpose.
LOCAL_PATTERNS="$REPO_ROOT/.identifier-patterns.local"
if [ -f "$LOCAL_PATTERNS" ]; then
  while IFS= read -r pattern; do
    case "$pattern" in ''|\#*) continue ;; esac
    for f in "${files[@]}"; do
      [ -f "$f" ] || continue
      if grep -qiE "$pattern" "$f" 2>/dev/null; then
        printf '\033[31mBLOCKED:\033[0m %s matches a local identifier pattern\n' "$f" >&2
        violations=1
      fi
    done
  done < "$LOCAL_PATTERNS"
fi

if [ "$violations" -ne 0 ]; then
  {
    printf '\n'
    printf 'Live identifiers must not enter tracked files. If this is test data, use a\n'
    printf 'synthetic id such as deadbeef-0000-4000-8000-000000000001 so a real one copied\n'
    printf 'from live output stands out. See CONTRIBUTING.md.\n'
  } >&2
  exit 1
fi

exit 0
