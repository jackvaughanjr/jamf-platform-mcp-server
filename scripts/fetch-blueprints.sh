#!/usr/bin/env bash
#
# fetch-blueprints.sh — reference implementation and smoke test for the
# Jamf Platform API Gateway Blueprints endpoints.
#
# This is NOT part of the MCP server. It exists to prove the gateway contract
# independently of the TypeScript, so that when a tool call misbehaves you can
# tell "the gateway changed" apart from "our client is wrong" in one command.
#
# ── Gateway path shape ───────────────────────────────────────────────────────
#   /api/{service}/{version}/tenant/{tenantId}/{resource}
#
# For Blueprints the service segment is "blueprints", NOT "pro":
#   https://us.apigw.jamf.com/api/blueprints/v1/tenant/{tenantId}/blueprints
#
# The "pro" in the required permission `read:pro:blueprints` is a *scope*
# prefix, not a URL segment. Conflating the two yields /api/pro/v1/... and a
# 404 that looks like a permissions problem. See src/platform-client.ts, whose
# RequestOptions.service doc comment currently gives "pro" as its example.
#
# ── Auth ─────────────────────────────────────────────────────────────────────
#   POST {base}/auth/token, application/x-www-form-urlencoded,
#   grant_type=client_credentials. Tokens are ~900s; this script refreshes at
#   700s so a long detail loop cannot expire mid-run.
#
# ── Required env (matches .env.example) ──────────────────────────────────────
#   JAMF_CLIENT_ID  JAMF_CLIENT_SECRET  JAMF_TENANT_ID
# ── Optional ─────────────────────────────────────────────────────────────────
#   JAMF_GATEWAY_BASE_URL   default https://us.apigw.jamf.com
#   JAMF_TOKEN_URL          default {base}/auth/token
#   OUT                     default ./blueprints.json (gitignored)
#
# Reads .env from the repo root if present.
#
# Usage:  ./scripts/fetch-blueprints.sh
#
set -euo pipefail

die()  { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
note() { printf '\033[36m▸\033[0m %s\n' "$1" >&2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load .env without exporting the secret into any child process that doesn't need it.
if [ -f "$REPO_ROOT/.env" ]; then
  set -a; . "$REPO_ROOT/.env"; set +a
  note "loaded $REPO_ROOT/.env"
fi

for cmd in curl jq; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required but not on PATH"
done
for var in JAMF_CLIENT_ID JAMF_CLIENT_SECRET JAMF_TENANT_ID; do
  [ -n "${!var:-}" ] || die "$var is not set (see .env.example)"
done

BASE="${JAMF_GATEWAY_BASE_URL:-https://us.apigw.jamf.com}"
TOKEN_URL="${JAMF_TOKEN_URL:-${BASE}/auth/token}"
BLUEPRINTS="${BASE}/api/blueprints/v1/tenant/${JAMF_TENANT_ID}/blueprints"
OUT="${OUT:-$REPO_ROOT/blueprints.json}"

# ── token, refreshed proactively ─────────────────────────────────────────────
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
    printf '%s\n' "$resp" | jq -r '"  gateway: \(.error // "?") — \(.error_description // .message // "no detail")"' >&2 || true
    die "no access_token returned. Check the integration exists, the secret is current, and the account is enrolled in the Platform API Gateway Beta."
  fi
  TOKEN_AT="$(date +%s)"
  note "token acquired (expires_in $(printf '%s' "$resp" | jq -r '.expires_in // "?"')s)"
}

auth() {
  local now; now="$(date +%s)"
  { [ -z "$TOKEN" ] || [ $(( now - TOKEN_AT )) -ge "$REFRESH_AFTER" ]; } && get_token
  printf 'Authorization: Bearer %s' "$TOKEN"
}

api() { curl -sS --fail-with-body -H "$(auth)" -H 'Accept: application/json' "$1"; }

# ── list (page is 0-based; page-size default 100) ────────────────────────────
note "gateway ${BASE}  tenant ${JAMF_TENANT_ID:0:8}…"
get_token

IDS="$(mktemp)"; RAW="$(mktemp)"
trap 'rm -f "$IDS" "$RAW"' EXIT
PAGE=0; TOTAL=""

while :; do
  page_json="$(api "${BLUEPRINTS}?page=${PAGE}&page-size=100")" \
    || die "list failed — confirm the integration holds read:pro:blueprints"
  [ -z "$TOTAL" ] && TOTAL="$(printf '%s' "$page_json" | jq -r '.totalCount // 0')"
  printf '%s' "$page_json" | jq -r '.results[]?.id' >> "$IDS"
  got="$(wc -l < "$IDS" | tr -d ' ')"
  note "listed ${got}/${TOTAL}"
  [ "$got" -ge "${TOTAL:-0}" ] && break
  [ "$(printf '%s' "$page_json" | jq -r '.results | length')" -eq 0 ] && break
  PAGE=$(( PAGE + 1 ))
done

COUNT="$(wc -l < "$IDS" | tr -d ' ')"
if [ "$COUNT" -eq 0 ]; then
  note "no blueprints returned — tenant has none, or the permission is missing"
  printf '[]\n' > "$OUT"; exit 0
fi

# ── detail per blueprint ─────────────────────────────────────────────────────
i=0
while IFS= read -r id; do
  i=$(( i + 1 )); note "detail ${i}/${COUNT}"
  api "${BLUEPRINTS}/${id}" >> "$RAW" || die "detail failed for ${id}"
  printf '\n' >> "$RAW"
done < "$IDS"

jq -s '.' < "$RAW" > "$OUT"
note "wrote $OUT"

# ── summary ──────────────────────────────────────────────────────────────────
printf '\n'
jq -r '
  "BLUEPRINTS: \(length)\n",
  (["NAME","DEPLOYMENT","SCOPE(GROUPS)","STEPS","COMPONENTS"] | @tsv),
  (.[] | [
      (.name // "-")[0:44],
      (.deploymentState.state // "-"),
      ((.scope.deviceGroups // .scope.deviceGroupIds // []) | length),
      ((.steps // []) | length),
      ([(.steps // [])[]?.components[]?] | length)
    ] | @tsv)
' "$OUT" | column -t -s "$(printf '\t')"

printf '\n'
jq -r '"COMPONENT IDENTIFIERS IN USE:",
  ([ (.[]?.steps // [])[]?.components[]?.identifier // "unknown" ]
    | group_by(.) | map({t: .[0], n: length}) | sort_by(-.n)[] | "  \(.n)  \(.t)")' "$OUT"

printf '\n\033[33m!\033[0m %s\n' "blueprints.json holds full device configuration payloads — it is gitignored; keep it that way."
