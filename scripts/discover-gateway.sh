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
# DIAGNOSTIC KEY
#   200  route works
#   403  route is known to the gateway but refuses this caller — CAUSE UNKNOWN
#   404  gateway has no such route
#   401  token rejected (credential problem, not a path problem)
#
# 403 does NOT mean "missing scope". Verified 2026-08-04 against an integration
# granted every available read:pro:* scope: blueprint components,
# compliance-benchmarks, declaration-reporting and Classic buildings all still
# returned 403 while holding read:pro:blueprints,
# read:pro:compliance-benchmarks, read:pro:declaration-reporting and
# read:pro:buildings respectively — and blueprints/list returns 200 under the
# very same read:pro:blueprints. Whatever 403 encodes, permission is not it.
#
# Because of that, 4xx bodies are now saved to fixtures/raw/errors/ (gitignored)
# and a scrubbed one-line message goes into the report. Read those before
# theorising.
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
ERR_DIR="$REPO_ROOT/fixtures/raw/errors"
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
  # ── NEGATIVE CONTROLS ──────────────────────────────────────────────────────
  # These decide what 403/BAD_PERMISSIONS actually means, which three groups'
  # results currently hinge on.
  #
  # A route that certainly does not exist, under a service confirmed to work.
  # If this returns 403 BAD_PERMISSIONS, then BAD_PERMISSIONS means "no such
  # route in a service you can reach" — and blueprint-components,
  # declaration-reporting and jamf-pro-classic are UNRESOLVED PATHS, not
  # permission problems. If it returns 404, BAD_PERMISSIONS really is about
  # authorisation and those three paths are correct.
  "_control-bogus-route|devices|zz-no-such-route-control|tenant"
  # A service that certainly does not exist. Expected 404; establishes the
  # contrast case.
  "_control-bogus-service|zz-no-such-service-control|things|tenant"

  # Decides whether a 400 REQUEST_CONTEXT_NOT_PROVIDED says anything about the
  # route. A bogus FLAT route under the working `pro` segment: if it also returns
  # 400, the gateway resolves tenant context before matching routes and 400 is
  # silent about existence — so the 400 on /api/pro/v1/device-declarations is NOT
  # evidence that route is real. If it returns 403 BAD_PERMISSIONS instead, then
  # 400 does mark a real route missing only its tenant header.
  "_control-bogus-flat-route|pro|zz-no-such-flat-route-control|flat"

  "blueprints|blueprints|blueprints|tenant"

  # `components` under blueprints is an unknown route (BAD_PERMISSIONS, same as
  # the bogus-route control). Sweep plausible names and both styles.
  "blueprint-components|blueprints|components blueprint-components available-components component-definitions|tenant flat"
  "devices|devices|devices|tenant"
  "device-groups|device-groups|device-groups|tenant"

  # CONFIRMED: segment compliance-benchmarks, style flat (no tenant segment),
  # 403 pending a compliance read scope on the integration.
  "compliance-benchmarks|compliance-benchmarks|benchmarks|flat"

  # CONFIRMED: segment pro, style tenant. Unlocks the 300+ Jamf Pro API surface.
  "jamf-pro|pro|account-groups|tenant"

  # Service enumeration proved `declarations` and `declaration-reporting` are NOT
  # hosted segments, so this lives inside `devices` or `pro`. Its doc slugs are
  # operation names — getdevicereport, getdevicechannels, getdeclarationreport —
  # so these are the resource names those imply, applying the lesson from
  # blueprint-components that names are fully qualified.
  "declaration-reporting|devices pro|device-channels declaration-reports device-reports device-declarations|tenant flat"

  # Classic: `classic`, `jamf-pro-classic` and `jssresource` are all NOT hosted,
  # so Classic must be served under `pro`. Its doc slugs settle the shape —
  # creategroupbyid_tenant_tenantid_accounts_groupname_name encodes
  # /tenant/{tenantid}/accounts/groupname/{name}, i.e. NO /JSSResource/ prefix
  # and NO version segment. Every earlier probe carried a prefix that does not
  # exist. raw style is the only one that can express this.
  # Group names must be unique — they key the raw/shape filenames, so a duplicate
  # silently overwrites the other's fixtures.
  "jamf-pro-classic-noversion|pro|/tenant/{TENANT}/buildings /tenant/{TENANT}/categories /tenant/{TENANT}/accounts|raw"

  # NOT Classic — mislabelled in an earlier run. /api/pro/v1/tenant/{t}/buildings
  # returns 200 but with the Jamf Pro API's shape ({totalCount, results[]} and
  # streetAddress1/stateProvince/zipPostalCode fields), whereas Classic wraps as
  # {"buildings":[...]}. So this probe confirms another Jamf Pro API resource and
  # says nothing about Classic. Kept as a Pro-API sample.
  "jamf-pro-api-buildings|pro|buildings|tenant"

  # Classic proper. Distinguishable ONLY by response shape: Classic wraps in a
  # named key ({"buildings":[...]}), Pro API uses {totalCount, results[]}. These
  # resources exist ONLY in Classic — there is no Jamf Pro API equivalent — so a
  # 200 here cannot be confused with a Pro API hit.
  "jamf-pro-classic|pro|activationcode allowedfileextensions diskencryptionconfigurations|tenant flat"
)

# Group names key the raw/shape/error filenames, so a duplicate silently
# overwrites another group's fixtures and produces two contradictory report rows.
# Fail loudly at startup instead.
_dupes="$(printf '%s\n' "${PROBES[@]}" | cut -d'|' -f1 | sort | uniq -d)"
[ -z "$_dupes" ] || die "duplicate probe group name(s), which would overwrite fixtures: $(printf '%s' "$_dupes" | tr '\n' ' ')"
unset _dupes

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

# Some paths embed a device ID rather than being collections — Declaration
# Reporting publishes only /v1/devices/{deviceId}/declarations, with no list
# endpoint, so probing it as a collection can only ever 404. Borrow an ID from
# the devices probe, which runs earlier in the table.
DEVICE_ID=""
# Sets the global DEVICE_ID in place and prints nothing.
#
# It must NOT be called via command substitution: `x="$(resolve_device_id)"`
# runs it in a subshell, the global assignment dies with that subshell, and the
# report-masking guard below then sees an empty DEVICE_ID and silently leaks the
# real device ID into a committed file. That bug shipped once already.
resolve_device_id() {
  [ -n "$DEVICE_ID" ] && return 0
  if [ "${DRY_RUN:-}" = "1" ]; then
    DEVICE_ID="{DEVICE}"
  elif [ -f "$RAW_DIR/devices.json" ]; then
    DEVICE_ID="$(jq -r '.results[0].id // empty' < "$RAW_DIR/devices.json" 2>/dev/null || true)"
  fi
  return 0
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

# ── service segment enumeration ──────────────────────────────────────────────
# The 403-vs-404 split makes service segments ENUMERABLE rather than guessable:
# a route that cannot exist returns 403 BAD_PERMISSIONS under a real service, and
# 404 under one the gateway does not host. So probing a deliberately bogus route
# against each candidate name tells us which segments exist, without knowing a
# single valid route inside them.
# Confirmed hosted on 2026-08-04: blueprints, devices, device-groups, pro,
# device-actions. compliance-benchmarks answers 403 even for a bogus route, so
# the gateway refuses that whole segment rather than a particular path.
# Everything else below returned 404 — including classic, jssresource,
# declarations, declaration-reporting, protect and security-cloud.
SERVICE_CANDIDATES=(
  blueprints devices device-groups pro compliance-benchmarks device-actions
  declarations declaration-reporting device-management-actions
  classic jamf-pro jamf-pro-classic jamf-pro-api jssresource
  protect security-cloud benchmarks compliance mscp
  users computers mobile-devices inventory patch policies
  # Second sweep: plausible names not yet tried.
  ddm declarative device-declarations reporting declaration-reports
  jamf-protect jamf-security-cloud settings self-service
)

SERVICE_TABLE=""
enumerate_services() {
  local svc url status body_file exists
  for svc in "${SERVICE_CANDIDATES[@]}"; do
    url="${BASE}/api/${svc}/v1/tenant/${JAMF_TENANT_ID}/zz-service-probe"
    body_file="$(mktemp)"
    status="$(curl -sS -o "$body_file" -w '%{http_code}' \
      -H "$(auth_header)" -H 'Accept: application/json' "$url" || echo "000")"
    if [ "$status" = "403" ] && grep -q 'BAD_PERMISSIONS' "$body_file" 2>/dev/null; then
      exists="yes"
    elif [ "$status" = "404" ]; then
      exists="no"
    else
      # Anything else is ambiguous — record the status so it can be read directly
      # rather than folded into a yes/no it does not support.
      exists="? ($status)"
    fi
    printf '  %-26s %s\n' "$svc" "$exists" >&2
    SERVICE_TABLE="${SERVICE_TABLE}| \`${svc}\` | ${exists} |"$'\n'
    rm -f "$body_file"
  done
}

if [ "${DRY_RUN:-}" = "1" ]; then
  note "DRY RUN — would enumerate ${#SERVICE_CANDIDATES[@]} service candidates"
else
  note "enumerating ${#SERVICE_CANDIDATES[@]} candidate service segments…"
  enumerate_services
fi

# ── tenant-context header discovery ──────────────────────────────────────────
# A flat-style route answers 400 REQUEST_CONTEXT_NOT_PROVIDED — "Request context
# not provided in token or headers." The header name is not documented anywhere
# we can reach, so try the plausible spellings against a route known to produce
# that error and see which one changes the outcome. Any status other than 400
# means the header was understood.
HEADER_CANDIDATES=(
  X-Jamf-Tenant-Id X-Jamf-TenantId X-Jamf-Tenant
  X-Tenant-Id X-TenantId Tenant-Id Jamf-Tenant-Id Jamf-Tenant
  X-Jamf-Request-Context X-Request-Context
)
HEADER_TABLE=""
discover_context_header() {
  local probe_url="${BASE}/api/pro/v1/device-declarations"
  local h status body_file verdict
  for h in "${HEADER_CANDIDATES[@]}"; do
    body_file="$(mktemp)"
    status="$(curl -sS -o "$body_file" -w '%{http_code}' \
      -H "$(auth_header)" -H 'Accept: application/json' \
      -H "${h}: ${JAMF_TENANT_ID}" "$probe_url" || echo "000")"
    if grep -q 'REQUEST_CONTEXT_NOT_PROVIDED' "$body_file" 2>/dev/null; then
      verdict="ignored (still 400)"
    else
      verdict="CHANGED OUTCOME -> $status"
    fi
    printf '  %-24s %s\n' "$h" "$verdict" >&2
    HEADER_TABLE="${HEADER_TABLE}| \`${h}\` | ${verdict} |"$'\n'
    rm -f "$body_file"
  done
}

if [ "${DRY_RUN:-}" != "1" ]; then
  note "probing ${#HEADER_CANDIDATES[@]} tenant-context header names…"
  discover_context_header
fi

{
  printf '# Gateway discovery report\n\n'
  printf 'Gateway: `%s`\n\n' "$BASE"
  printf 'Read-only integration.\n\n'
  printf '`403` does NOT mean "path correct, scope missing". An integration granted every\n'
  printf 'available `read:pro:*` scope still receives 403 on several routes, and\n'
  printf '`blueprints` list returns 200 under the same scope that 403s on\n'
  printf '`blueprints/components`. Treat a 403 row as UNCONFIRMED until the negative\n'
  printf 'controls below say otherwise:\n\n'
  # printf must not receive a leading "-" as its format string; it is parsed as
  # an option flag and the whole header generation dies.
  printf '%s\n' '- `_control-bogus-route` — a route that cannot exist, under a working service.'
  printf '%s\n' '  403 here means BAD_PERMISSIONS marks an unknown route, so every other 403 row'
  printf '%s\n' '  is a wrong path rather than a permission gap.'
  printf '%s\n' '- `_control-bogus-service` — a service that cannot exist. Expect 404.'
  printf '\n'
  printf 'Tenant identifiers and result counts are deliberately absent: this file is\n'
  printf 'committed and shared externally. The envelope column lists response *key names*,\n'
  printf 'which is the part that matters for writing a pagination helper.\n\n'
  if [ -n "$SERVICE_TABLE" ]; then
    printf '## Service segments the gateway hosts\n\n'
    printf 'Determined by probing a route that cannot exist against each candidate:\n'
    printf '403 BAD_PERMISSIONS means the segment is real, 404 means it is not.\n\n'
    printf '| candidate | hosted |\n|---|---|\n'
    printf '%s' "$SERVICE_TABLE"
    printf '\n'
  fi
  if [ -n "$HEADER_TABLE" ]; then
    printf '## Tenant-context header candidates\n\n'
    printf 'Probed against `/api/pro/v1/device-declarations`, which answers 400\n'
    printf '`REQUEST_CONTEXT_NOT_PROVIDED` without a tenant in the path. Anything other\n'
    printf 'than a repeated 400 means the header was understood.\n\n'
    printf '| header | result |\n|---|---|\n'
    printf '%s' "$HEADER_TABLE"
    printf '\n'
  fi
  printf '## Routes\n\n'
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
    # Placeholder substitution lets the probe table express paths that embed
    # identifiers — {TENANT} for the raw style (Classic has a documented
    # /JSSResource/tenant/{tenantid}/... form) and {DEVICE} for ID-only paths.
    probe_resource="$resource"
    case "$probe_resource" in
      *'{DEVICE}'*)
        # Called bare, not in $( ), so DEVICE_ID persists for report masking.
        resolve_device_id
        if [ -z "$DEVICE_ID" ]; then
          warn "${group}: skipping '${resource}' — no device id available"
          continue
        fi
        probe_resource="${probe_resource//\{DEVICE\}/$DEVICE_ID}"
        ;;
    esac
    probe_resource="${probe_resource//\{TENANT\}/$JAMF_TENANT_ID}"

    case "$style" in
      tenant) url="${BASE}/api/${service}/v1/tenant/${JAMF_TENANT_ID}/${probe_resource}" ;;
      flat)   url="${BASE}/api/${service}/v1/${probe_resource}" ;;
      raw)    url="${BASE}/api/${service}${probe_resource}" ;;
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
        mkdir -p "$ERR_DIR"
        # Two different 403s, established by the negative controls on 2026-08-04:
        #
        #   BAD_PERMISSIONS  -> the gateway has no such route inside a service you
        #                       can reach. A route that cannot possibly exist
        #                       (_control-bogus-route) returns exactly this, while
        #                       a nonexistent SERVICE returns 404. So this is a
        #                       path miss and the sweep must CONTINUE — treating
        #                       it as a stop condition previously aborted the
        #                       matrix and hid untried candidates.
        #
        #   anything else    -> a gateway-level refusal of a route it does
        #                       recognise (e.g. {"error":"Requested endpoint is
        #                       forbidden"}). That is a real signal about this
        #                       path, so stop and record it.
        if grep -q 'BAD_PERMISSIONS' "$body_file" 2>/dev/null; then
          final_status="$status"; final_url="$url"
          cp "$body_file" "$ERR_DIR/${group}.last-403-unknown-route.json" 2>/dev/null || true
          rm -f "$body_file"
          continue
        fi
        resolved="$service"; resolved_style="$style"; final_status="$status"; final_url="$url"
        cp "$body_file" "$ERR_DIR/${group}.json"
        err_msg="$(jq -r '[.errors[]?.description, .errors[]?.code, .message, .error, .error_description, .detail, .title]
                          | map(select(. != null)) | unique | join(" | ")' \
                    < "$body_file" 2>/dev/null || true)"
        [ -n "$err_msg" ] || err_msg="$(tr -d '\n' < "$body_file" | cut -c1-160)"
        [ -n "$err_msg" ] || err_msg="(empty body)"
        # Scrub identifiers before this reaches the committed report.
        err_msg="$(printf '%s' "$err_msg" \
          | sed -E 's/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/{ID}/g' \
          | sed 's/|/\\|/g')"
        note_text="style \`${style}\`, gateway refused a route it recognises: ${err_msg}"
        warn "${group}: 403 (gateway-level, not BAD_PERMISSIONS) via service='${service}' style='${style}' — ${err_msg}"
        rm -f "$body_file"; break 3 ;;
      401)
        rm -f "$body_file"
        die "401 from gateway — token rejected. Credential problem, not a path problem." ;;
      *)
        # Keep the last failing body per group — a 404 body often names the
        # reason, and guessing from a bare status code is what stalled the first
        # two passes.
        final_status="$status"; final_url="$url"
        mkdir -p "$ERR_DIR"
        cp "$body_file" "$ERR_DIR/${group}.last-${status}.json" 2>/dev/null || true
        rm -f "$body_file" ;;
    esac
    done
   done
  done

  # The report is a committed artifact, so the tenant ID — a live infrastructure
  # identifier — is masked out of it. The resolved segment is the useful part.
  report_path="${final_url#$BASE}"
  report_path="${report_path//$JAMF_TENANT_ID/\{TENANT\}}"
  # A borrowed device ID is also a live identifier — mask it too.
  if [ -n "$DEVICE_ID" ] && [ "$DEVICE_ID" != "{DEVICE}" ]; then
    report_path="${report_path//$DEVICE_ID/\{DEVICE\}}"
  fi
  # Catch-all: any surviving UUID becomes {ID}. The named masks above give nicer
  # labels, but they only cover identifiers this script knows it substituted. A
  # path could embed an ID from anywhere, so nothing UUID-shaped gets through.
  report_path="$(printf '%s' "$report_path" \
    | sed -E 's/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/{ID}/g')"

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

# Last line of defence. If any identifier survived every mask above, scrub it in
# place rather than leaving a committable file holding live data, and say so
# loudly — a silent pass here is how the device ID leaked the first time.
UUID_RE='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
if [ "$REPORT" != /dev/null ] && grep -qE "$UUID_RE" "$REPORT" 2>/dev/null; then
  sed -i '' -E "s/${UUID_RE}/{ID}/g" "$REPORT"
  warn "an identifier reached $REPORT and was scrubbed — masking logic needs a look"
fi

note "wrote $REPORT"
printf '\n'
cat "$REPORT"
printf '\n\033[33m!\033[0m %s\n' "fixtures/raw/ holds live device data — gitignored, and never 'git add -f'."
