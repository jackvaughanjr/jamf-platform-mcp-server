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

- **404** — the gateway has no such route: wrong segment, resource, or style
- **403** — the route exists but refuses this caller. **Cause unknown — do not
  read this as "missing scope."**

That second point is a correction, not a caveat. An integration granted *every*
available `read:pro:*` scope still receives 403 on blueprint components,
Compliance Benchmarks, Declaration Reporting, and Classic buildings, while
holding `read:pro:blueprints`, `read:pro:compliance-benchmarks`,
`read:pro:declaration-reporting`, and `read:pro:buildings` respectively — and
`blueprints` list returns **200** under that same `read:pro:blueprints`. Same
scope, same service, one route works and one does not. So 403 encodes something
other than permission.

Leading hypotheses, untested:

1. The route is registered in the gateway but not enabled for this tenant or
   this stage of the beta.
2. The path is subtly wrong and the gateway answers unmatched-but-plausible
   routes with 403 rather than 404.
3. Classic and the newer groups need an authorisation grant beyond gateway
   scopes — a Jamf Pro API role, or per-tenant enablement.

`scripts/discover-gateway.sh` now saves every 4xx body to
`fixtures/raw/errors/` (gitignored) and puts a scrubbed one-line message in the
report. **Read those bodies before theorising** — three passes were spent
inferring from bare status codes.

### Confirmed service segments

Resolved against a live tenant on 2026-08-04 (`fixtures/discovery-report.md`):

**All eight probed groups are resolved.** Every non-200 below is a missing scope
on the integration, not a wrong path.

| group | segment | style | path | status |
|---|---|---|---|---|
| Blueprints | `blueprints` | `tenant` | `/api/blueprints/v1/tenant/{t}/blueprints` | 200 |
| Blueprint components | `blueprints` | `tenant` | `…/tenant/{t}/components` | 403 scope |
| Devices | `devices` | `tenant` | `/api/devices/v1/tenant/{t}/devices` | 200 |
| Device Groups | `device-groups` | `tenant` | `/api/device-groups/v1/tenant/{t}/device-groups` | 200 |
| Compliance Benchmarks | `compliance-benchmarks` | `flat` | `/api/compliance-benchmarks/v1/benchmarks` | 403 scope |
| Jamf Pro API | `pro` | `tenant` | `/api/pro/{v}/tenant/{t}/{resource}` | 200 |
| Declaration Reporting | `pro` | `tenant` | `/api/pro/v1/tenant/{t}/devices/{id}/declarations` | 403 scope |
| Jamf Pro Classic | `pro` | `raw` | `/api/pro/JSSResource/tenant/{t}/{resource}` | 403 scope |

### Four findings that override the documentation

**`pro` is an umbrella segment, not just the Jamf Pro API.** It serves the Jamf
Pro API, the Classic API, *and* Declaration Reporting. Eight groups collapse to
five distinct segments: `blueprints`, `devices`, `device-groups`,
`compliance-benchmarks`, `pro`.

**Classic lives at `/api/pro/JSSResource/tenant/{tenantId}/{resource}`** — the
tenant-scoped `JSSResource` form, under `pro`, with no version segment. The bare
`/JSSResource/{resource}` returns 404. This makes the 500+ Classic endpoints
reachable via `rawPath`.

**Declaration Reporting does take a tenant segment**, despite its published
paths (`/v1/devices/{deviceId}/declarations`) showing none. The docs were
abbreviating. It is also ID-only — there is no collection endpoint — so any
probe needs a real device ID.

**The segment is not always the group name and the style is not uniform.** Jamf
Pro API is `pro`, not `jamf-pro`. Compliance Benchmarks is the sole `flat`
group. Sweep segment × resource × style before concluding a path is wrong — the
first pass mislabelled two groups as 404 purely by holding style fixed.

### Scopes the read-only integration is missing

Blueprint components, Compliance Benchmarks, Declaration Reporting, and Classic
all return 403. Compliance Benchmarks is the seven-endpoint group most likely to
replace hand-rolled compliance logic, so it is the highest-value scope to add.

### Pagination envelopes are not uniform

Devices and Device Groups return a full envelope:
`page`, `pageSize`, `totalCount`, `totalPages`, `hasNext`, `hasPrevious`.

Blueprints returns **only** `results` and `totalCount` — no `hasNext`. Any
generic pagination helper must handle both, and must not assume `hasNext` exists.

## Stdout is the MCP transport

Only JSON-RPC may go to stdout. Logs go to stderr. `dotenv` is loaded with
`quiet: true` because v17 prints a banner to stdout that breaks the handshake.
