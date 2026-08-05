#!/usr/bin/env bash
#
# discover-gateway.sh — resolve Jamf Platform API Gateway service segments and
# record response schemas.
#
# WHY THIS EXISTS
# The published docs give endpoint paths starting at /v1/tenant/{tenantid}/...
# and omit the /api/{service} prefix entirely. That omission already cost us one
# bug: Blueprints requires the scope `read:pro:blueprints` but lives at
# /api/blueprints/..., so deriving the segment from the scope name yields a 404
# that reads like a permissions failure. Rather than guess per API group, this
# probes candidate segments and reports which one answers.
#
# DIAGNOSTIC KEY — the whole point of the run:
#   200  correct segment, scope present
#   403  correct segment, scope MISSING       <- path is right, permissions aren't
#   404  wrong segment or wrong resource      <- path is wrong
#   401  token rejected (credential problem, not a path problem)
# A 403 is therefore a *success* for path discovery.
#
# OUTPUT
#   fixtures/raw/<group>.json      full response — GITIGNORED, never commit
#   fixtures/shapes/<group>.json   every value replaced by its type — committed
#   fixtures/discovery-report.md   segment resolution + status per probe
#
# Raw responses carry live device serials, usernames, email addresses, IPs and
# per-device application inventory. Only shapes are safe to commit, and a
# pre-commit hook enforces that. Never `git add -f`.
#
# USAGE
#   op run --env-file=.env.op -- ./scripts/discover-gateway.sh
#
set -euo pipefail

die()  { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
note() { printf '\033[36m▸\033[0m %s\n' "$1" >&2; }
warn() { printf '\033[33m!\033[0m %s\n' "$1" >&2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Only load .env as a fallback; `op run` is the intended path and injects env
# directly, so the secret need never exist on disk.
if [ -f "$REPO_ROOT/.env" ]; then
  set -a; . "$REPO_ROOT/.env"; set +a
  warn "loaded .env from disk — prefer: op run --env-file=.env.op -- $0  (cp .env.op.example .env.op first)"
fi

for cmd in curl jq; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required but not on PATH"
done
# DRY_RUN only prints the probe matrix, so it needs no real credentials.
if [ "${DRY_RUN:-}" = "1" ]; then
  : "${JAMF_CLIENT_ID:=dry-run}" "${JAMF_CLIENT_SECRET:=dry-run}" "${JAMF_TENANT_ID:={TENANT\}}"
  export JAMF_CLIENT_ID JAMF_CLIENT_SECRET JAMF_TENANT_ID
fi

for var in JAMF_CLIENT_ID JAMF_CLIENT_SECRET JAMF_TENANT_ID; do
  [ -n "${!var:-}" ] || die "$var is not set (see .env.op.example)"
done
case "${JAMF_CLIENT_ID}" in
  op://*) die "env still contains op:// references — run under: op run --env-file=.env.op -- $0  (cp .env.op.example .env.op first)" ;;
esac

BASE="${JAMF_GATEWAY_BASE_URL:-https://us.apigw.jamf.com}"
TOKEN_URL="${JAMF_TOKEN_URL:-${BASE}/auth/token}"
RAW_DIR="$REPO_ROOT/fixtures/raw"
SHAPE_DIR="$REPO_ROOT/fixtures/shapes"
REPORT="$REPO_ROOT/fixtures/discovery-report.md"
mkdir -p "$RAW_DIR" "$SHAPE_DIR"

# A dry run must not touch the committed report — it has no results to record,
# and clobbering real findings with empty rows is worse than useless.
[ "${DRY_RUN:-}" = "1" ] && REPORT=/dev/null

# ── probe table ──────────────────────────────────────────────────────────────
# group | services (space-separated) | resources (space-separated) | styles
#
# The FULL service x resource matrix is swept. The first pass varied only the
# service while holding the resource fixed, so a wrong resource made every
# service candidate 404 and the group looked unresolvable when just one half of
# the pair was off — that is why compliance-benchmarks and declaration-reporting
# came back empty.
#
# styles: "tenant" -> /{version}/tenant/{tenantId}/{resource}
#         "flat"   -> /{version}/{resource}            (no tenant segment)
#         "raw"    -> resource used verbatim after /api/{service}, no version
#                     (required for Classic: /JSSResource/{resource})
#
# Blueprints is the control: known-good from scripts/fetch-blueprints.sh, so if
# it fails the credentials or gateway are wrong, not the table.
PROBES=(
  "blueprints|blueprints|blueprints|tenant"
  "blueprint-components|blueprints|components|tenant"
  "devices|devices|devices|tenant"
  "device-groups|device-groups|device-groups|tenant"

  # Docs name the operation "list tenant benchmarks" without publishing a path,
  # so resource is as uncertain as the segment. Sweep both.
  "compliance-benchmarks|compliance-benchmarks benchmarks compliance mscp|benchmarks tenant-benchmarks baselines|tenant flat"

  # Documented paths carry NO tenant segment, unlike every other group, and both
  # require an ID — so a tenant-scoped list probe was guaranteed to 404. Try flat
  # and a plain collection.
  "declaration-reporting|declaration-reporting declarations declaration|declarations device-declarations|flat tenant"

  # Jamf Pro API: 300+ endpoints. account-groups is v1 and the cheapest probe.
  # Resolving the segment once makes the whole surface reachable via rawPath.
  "jamf-pro|pro jamf-pro jamfpro jamf-pro-api|account-groups categories|tenant flat"

  # Jamf Pro Classic: 500+ endpoints, /JSSResource/{resource}, no version.
  # Only the raw style can express this.
  "jamf-pro-classic|classic jamf-pro-classic pro jamf-pro|/JSSResource/categories /JSSResource/buildings|raw"
)

# ── token, refreshed proactively (gateway tokens are ~900s) ──────────────────
TOKEN=""; TOKEN_AT=0; REFRESH_AFTER=700

get_token() {
  local resp
  resp="$(curl -sS -X POST "$TOKEN_URL" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=client_credentials' \
    --data-urlencode "client_id=${JAMF_CLIENT_ID}" \
    --data-urlencode "client_secret=${JAMF_CLIENT_SECRET}")" || die "token request failed (network)"
  TOKEN="$(printf '%s' "$resp" | jq -r '.access_token // empty')"
  if [ -z "$TOKEN" ]; then
    # Never echo the request body — it carries the secret.
    printf '%s' "$resp" | jq -r '"  gateway: \(.error // "?") — \(.error_description // .message // "no detail")"' >&2 || true
    die "no access_token returned. Check the integration exists, the secret is current, and the account is enrolled in the Platform API Gateway Beta."
  fi
  TOKEN_AT="$(date +%s)"
}

auth_header() {
  local now; now="$(date +%s)"
  { [ -z "$TOKEN" ] || [ $(( now - TOKEN_AT )) -ge "$REFRESH_AFTER" ]; } && get_token
  printf 'Authorization: Bearer %s' "$TOKEN"
}

# Replaces every scalar with its type name. Object keys survive (they are the
# schema); values never do. Arrays collapse to the shape of their first element,
# so a field that happens to be null in record one shows as "null" rather than
# its real nullable type — do not generate types from those without checking.
SHAPE_FILTER='
  def shape:
    if   type == "object" then with_entries(.value |= shape)
    elif type == "array"  then (if length == 0 then [] else [ .[0] | shape ] end)
    else type end;
  shape'

if [ "${DRY_RUN:-}" = "1" ]; then
  note "DRY RUN — printing probe matrix, no gateway calls"
else
  get_token
  note "gateway ${BASE}  tenant ${JAMF_TENANT_ID:0:8}…"
fi

{
  printf '# Gateway discovery report\n\n'
  printf 'Gateway: `%s`\n\n' "$BASE"
  printf 'Read-only integration. `403` means the path is correct and the scope is absent —\n'
  printf 'that is a successful path resolution, not a failure.\n\n'
  printf 'Tenant identifiers and result counts are deliberately absent: this file is\n'
  printf 'committed and shared externally. The envelope column lists response *key names*,\n'
  printf 'which is the part that matters for writing a pagination helper.\n\n'
  printf '| group | resolved segment | status | url | notes |\n'
  printf '|---|---|---|---|---|\n'
} > "$REPORT"

for probe in "${PROBES[@]}"; do
  IFS='|' read -r group services resources styles <<< "$probe"
  [ -n "$styles" ] || styles="tenant"
  resolved=""; resolved_style=""; final_status=""; final_url=""; note_text=""; attempts=0

  # Full matrix: every service x resource x style until something answers.
  for service in $services; do
   for resource in $resources; do
    for style in $styles; do
    case "$style" in
      tenant) url="${BASE}/api/${service}/v1/tenant/${JAMF_TENANT_ID}/${resource}" ;;
      flat)   url="${BASE}/api/${service}/v1/${resource}" ;;
      raw)    url="${BASE}/api/${service}${resource}" ;;
      *)      die "unknown style '$style' in probe table for ${group}" ;;
    esac
    attempts=$(( attempts + 1 ))

    # DRY_RUN=1 prints the matrix without calling the gateway — check the probe
    # table before spending real requests on it.
    if [ "${DRY_RUN:-}" = "1" ]; then
      printf '  %-22s %s\n' "$group" "${url#$BASE}" >&2
      continue
    fi

    body_file="$(mktemp)"
    status="$(curl -sS -o "$body_file" -w '%{http_code}' \
      -H "$(auth_header)" -H 'Accept: application/json' \
      "${url}?page=0&page-size=5" || echo "000")"

    # break 3 exits service/resource/style together — a plain break would only
    # leave the style loop and keep probing after a hit.
    case "$status" in
      200)
        resolved="$service"; resolved_style="$style"; final_status="$status"; final_url="$url"
        note "${group}: 200 via service='${service}' resource='${resource}' style='${style}'"
        cp "$body_file" "$RAW_DIR/${group}.json"
        jq "$SHAPE_FILTER" < "$body_file" > "$SHAPE_DIR/${group}.json" 2>/dev/null \
          || printf '"unparseable"\n' > "$SHAPE_DIR/${group}.json"
        # Record the envelope's KEY NAMES, never the values. Which paging fields
        # exist is the engineering signal; item counts are fleet intel and this
        # report is committed and shared externally.
        envelope="$(jq -r 'if type=="object" then [keys_unsorted[] | select(. != "results" and . != "items")] | join(", ") else "top-level " + type end' \
          < "$body_file" 2>/dev/null || echo '?')"
        note_text="style \`${style}\`, envelope: \`${envelope}\`"
        rm -f "$body_file"; break 3 ;;
      403)
        # Path is right; scope is missing. Stop — no better answer exists.
        resolved="$service"; resolved_style="$style"; final_status="$status"; final_url="$url"
        note_text="style \`${style}\`; path resolves, integration lacks the read scope"
        warn "${group}: 403 via service='${service}' style='${style}' (path OK, scope missing)"
        rm -f "$body_file"; break 3 ;;
      401)
        rm -f "$body_file"
        die "401 from gateway — token rejected. Credential problem, not a path problem." ;;
      *)
        final_status="$status"; final_url="$url"
        rm -f "$body_file" ;;
    esac
    done
   done
  done

  # The report is a committed artifact, so the tenant ID — a live infrastructure
  # identifier — is masked out of it. The resolved segment is the useful part.
  report_path="${final_url#$BASE}"
  report_path="${report_path//$JAMF_TENANT_ID/\{TENANT\}}"

  if [ -z "$resolved" ]; then
    warn "${group}: unresolved after ${attempts} attempt(s)"
    printf '| `%s` | — | %s | `%s` | %s combos tried; services: %s |\n' \
      "$group" "$final_status" "$report_path" "$attempts" "$services" >> "$REPORT"
  else
    printf '| `%s` | `%s` | %s | `%s` | %s |\n' \
      "$group" "$resolved" "$final_status" "$report_path" "$note_text" >> "$REPORT"
  fi
done

{
  printf '\nGenerated by `scripts/discover-gateway.sh`.\n'
  printf 'Raw responses are in `fixtures/raw/` and are gitignored — they contain live\n'
  printf 'device data. Committed shapes in `fixtures/shapes/` carry type names only.\n'
} >> "$REPORT"

note "wrote $REPORT"
printf '\n'
cat "$REPORT"
printf '\n\033[33m!\033[0m %s\n' "fixtures/raw/ holds live device data — gitignored, and never 'git add -f'."
