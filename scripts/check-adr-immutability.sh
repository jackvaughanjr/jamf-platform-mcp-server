#!/usr/bin/env bash
#
# Blocks modification, deletion, or rename of an already-committed ADR.
#
# A decision record is a historical account of what was decided and why. Editing
# one rewrites history and destroys the reason the record existed. Corrections go
# by a NEW ADR that supersedes the old one; the old one is left standing.
#
# Two sanctioned exceptions, both requiring the override:
#   - flipping Status: to point at a superseding ADR
#   - editing an ADR that has no external readers yet (nobody else has reviewed
#     it, nothing downstream depends on it, no outside party has referenced it)
#
#   ADR_ALLOW_EDIT=1 git commit ...
#
# Adding a new ADR is always allowed — only M/D/R are checked.
#
set -euo pipefail

adr_glob='decisions/[A-Z]*-[0-9][0-9][0-9][0-9]-*.md'
violations=0

while IFS=$'\t' read -r status path _rest; do
  case "$status" in
    M*|D*|R*)
      case "$path" in
        decisions/*-[0-9][0-9][0-9][0-9]-*.md)
          if [ "${ADR_ALLOW_EDIT:-0}" = "1" ]; then
            printf 'warning: ADR %s changed under ADR_ALLOW_EDIT override.\n' "$path" >&2
          else
            printf '\033[31mBLOCKED:\033[0m %s is a committed ADR (%s).\n' "$path" "$status" >&2
            printf '         Supersede it with a new ADR rather than rewriting it.\n' >&2
            printf '         If it has no external readers yet, or you are only adding a\n' >&2
            printf '         superseded-by pointer:  ADR_ALLOW_EDIT=1 git commit ...\n' >&2
            violations=1
          fi ;;
      esac ;;
  esac
done < <(git diff --cached --name-status --diff-filter=MDR -- "$adr_glob")

exit "$violations"
