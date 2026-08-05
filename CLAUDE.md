# Working in this repo

## Never force-add ignored files

`git add -f` / `git add --force` is not permitted in this repo, and neither is
`git update-index --add` on an ignored path. A `.githooks/pre-commit` hook
rejects any staged file that `.gitignore` covers, so a force-add fails at commit
time rather than silently landing.

The ignore list is a data-handling boundary, not tidiness. It guards:

- the OAuth client secret (`.env`) — shown exactly once at integration creation
- raw gateway responses (`fixtures/raw/`, `blueprints.json`) containing live
  device serials, usernames, email addresses, IPs, and per-device application
  inventory

If something currently ignored genuinely belongs in version control, change
`.gitignore` in its own commit so the decision is reviewable.

## Credentials

Never write the client secret to disk. Credentials live in 1Password; inject
them at runtime:

```bash
cp .env.op.example .env.op   # then edit to match your vault/item
op run --env-file=.env.op -- ./scripts/discover-gateway.sh
```

Only `.env.op.example` is tracked. A real `.env.op` holds no secrets — just
`op://` references — but those references name a local 1Password vault and item,
which is org-internal detail that does not belong in a repo shared outside the
company. Keep it untracked.

If `OP_SERVICE_ACCOUNT_TOKEN` is exported globally, `op` authenticates as that
service account rather than prompting for biometrics, and sees only the vaults
granted to it — which surfaces as a confusing "X isn't a vault in this account".
The committed `.envrc` unsets it for this repo (`direnv allow` once).

## Gateway path shape

```
{base}/api/{service}/{version}/tenant/{tenantId}/{resource}
```

**The service segment is not the scope prefix.** Blueprints needs the scope
`read:pro:blueprints` but lives at `/api/blueprints/...`. Deriving the segment
from the scope name yields `/api/pro/...` and a 404 that reads like a
permissions error. Confirm each segment empirically before adding a tool —
`scripts/discover-gateway.sh` resolves them, and `fixtures/shapes/` records what
came back.

Diagnostic shorthand when a call fails:

- **404** — wrong service segment or resource
- **403** — right path, missing scope

### Confirmed service segments

Resolved against a live tenant on 2026-08-04 (`fixtures/discovery-report.md`):

| group | segment | style | status |
|---|---|---|---|
| Blueprints | `blueprints` | `tenant` | confirmed 200 |
| Devices | `devices` | `tenant` | confirmed 200 |
| Device Groups | `device-groups` | `tenant` | confirmed 200 |
| **Jamf Pro API** | **`pro`** | `tenant` | confirmed 200 |
| Compliance Benchmarks | `compliance-benchmarks` | **`flat`** | 403 — path OK, scope missing |
| Declaration Reporting | unresolved | — | no collection endpoint; needs a device ID |
| Jamf Pro Classic | unresolved | — | 404 on bare `/JSSResource/...` |

Two things this table exists to stop you assuming:

**The segment is not always the group name.** Jamf Pro API is `pro`, not
`jamf-pro`. Four of five resolved segments match the group name; one does not.

**The style is not uniform.** Compliance Benchmarks is `flat` — no tenant
segment — while everything else confirmed so far is `tenant`. Probe both before
concluding a segment is wrong; the first discovery pass reported
compliance-benchmarks as a 404 purely because it only tried `tenant`.

`pro` + `tenant` makes the whole 300+ endpoint Jamf Pro API surface reachable
through `platformRequest`, remembering that versions are per-resource.

### Pagination envelopes are not uniform

Devices and Device Groups return a full envelope:
`page`, `pageSize`, `totalCount`, `totalPages`, `hasNext`, `hasPrevious`.

Blueprints returns **only** `results` and `totalCount` — no `hasNext`. Any
generic pagination helper must handle both, and must not assume `hasNext` exists.

## Stdout is the MCP transport

Only JSON-RPC may go to stdout. Logs go to stderr. `dotenv` is loaded with
`quiet: true` because v17 prints a banner to stdout that breaks the handshake.
