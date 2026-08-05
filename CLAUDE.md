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

### Which service segments the gateway hosts

Enumerated 2026-08-04 by probing a route that cannot exist against each
candidate — 403 BAD_PERMISSIONS means the segment is real, 404 means it is not.
This works without knowing any valid route inside a segment.

**Hosted:** `blueprints`, `devices`, `device-groups`, `pro`, `device-actions`

**Refused wholesale:** `compliance-benchmarks` — returns a gateway-level 403 even
for a nonsense route, so the entire segment is blocked rather than a particular
path. No route under it will work until that changes; do not spend probes there.

**Not hosted:** `classic`, `jamf-pro-classic`, `jssresource`, `jamf-pro`,
`jamf-pro-api`, `declarations`, `declaration-reporting`,
`device-management-actions`, `protect`, `security-cloud`, `benchmarks`,
`compliance`, `mscp`, `users`, `computers`, `mobile-devices`, `inventory`,
`patch`, `policies`.

Two consequences worth holding onto:

**Device Management Actions is `device-actions`**, not the group name
`device-management-actions`, which is not hosted. Segment names are shorter than
the documentation's group headings.

**Classic has no segment of its own**, so it must be served under `pro`. Its doc
slugs give the shape: `creategroupbyid_tenant_tenantid_accounts_groupname_name`
encodes `/tenant/{tenantid}/accounts/groupname/{name}` — **no `/JSSResource/`
prefix and no version segment.** `protect` and `security-cloud` not being hosted
matches Jamf's roadmap, which lists them as still to come.

### What each status actually means — settled by negative control

Two control probes, run 2026-08-04, decided this:

```
/api/devices/v1/tenant/{t}/zz-no-such-route-control   -> 403 BAD_PERMISSIONS
/api/zz-no-such-service-control/v1/tenant/{t}/things  -> 404
```

A route that *cannot exist*, inside a service that demonstrably works, returns
403 BAD_PERMISSIONS. So:

- **404** — unknown *service* segment.
- **403 `BAD_PERMISSIONS`** — unknown *route* inside a reachable service. This is
  a wrong path, NOT a permission problem. Keep sweeping candidates.
- **403 anything else** — the gateway recognises the route and refuses it, e.g.
  `{"error":"Requested endpoint is forbidden"}`. A real signal about that path.
- **400 `REQUEST_CONTEXT_NOT_PROVIDED`** — "Request context not provided in token
  or headers." The tenant must be supplied via a header when it is not in the
  path, so the `flat` style is incomplete: we have not found the header name yet.

Tell the two 403s apart by their envelope. `BAD_PERMISSIONS` arrives in Jamf
Pro's own error format (`httpStatus`, `traceId`, `errors[].code`), meaning the
request was routed through to Jamf Pro. A bare `{"error":"…"}` is the gateway
refusing before routing.

Granting scopes does not change any of this: an integration holding *every*
available `read:pro:*` scope — including `read:pro:blueprints`,
`read:pro:compliance-benchmarks`, `read:pro:declaration-reporting`, and
`read:pro:buildings` — still gets these 403s, while `blueprints` list returns 200
under that same `read:pro:blueprints`.

`scripts/discover-gateway.sh` saves every 4xx body to `fixtures/raw/errors/`
(gitignored) and puts a scrubbed message in the report. **Read the bodies before
theorising** — three passes were spent inferring from bare status codes, and the
status code alone was actively misleading.

### Confirmed service segments

Resolved against a live tenant on 2026-08-04 (`fixtures/discovery-report.md`):

**Discovery is complete enough to build on. Six routes confirmed; three groups
are dead ends with well-supported negative findings.**

Every confirmed route has the same shape, and it is the only shape ever seen to
return 200:

```
/api/{service}/{version}/tenant/{tenantId}/{resource}
```

Confirmed working (200):

| group | segment | style | path |
|---|---|---|---|
| Blueprints | `blueprints` | `tenant` | `/api/blueprints/v1/tenant/{t}/blueprints` |
| Blueprint components | `blueprints` | `tenant` | `/api/blueprints/v1/tenant/{t}/blueprint-components` |
| Devices | `devices` | `tenant` | `/api/devices/v1/tenant/{t}/devices` |
| Device Groups | `device-groups` | `tenant` | `/api/device-groups/v1/tenant/{t}/device-groups` |
| Jamf Pro API | `pro` | `tenant` | `/api/pro/{v}/tenant/{t}/{resource}` |

**Resource names are fully qualified, not relative.** Blueprint components is
`blueprint-components`, not `components`, even though it sits under the
`blueprints` service. Do not assume a sub-resource drops its domain prefix — that
assumption produced three passes of 403s. Its records are also keyed
`identifier`, not `id`, and carry `meta.supportedOs.{macOS,iOS,tvOS}[].version`.

`pro` is the Jamf Pro API in full — 300+ endpoints, confirmed with two resources
(`account-groups`, `buildings`). Versions are per-resource, so pass `version`
explicitly.

### Dead ends — stop probing these

**Jamf Pro Classic is not reachable.** Four strategies all failed: `/JSSResource/`
prefixed, tenant-scoped `/JSSResource/`, and bare Classic-only resource names
(`activationcode`, `allowedfileextensions`, `diskencryptionconfigurations`) under
`pro` both versioned and flat. No `classic`, `jamf-pro-classic`, or `jssresource`
segment is hosted. It has a docs section but appears not to be exposed yet.

**Declaration Reporting is not reachable.** No hosted segment, and 16 route
candidates under `devices` and `pro` all failed.

**Compliance Benchmarks is blocked at the segment level.** A bogus route under it
returns the same gateway-level 403 as a real one, so the whole segment is refused
rather than any particular path. Nothing under it can work until that changes.

These are questions for Jamf, not for more probing. The documentation has already
proven wrong three times — Declaration Reporting's tenant segment,
`device-management-actions` vs `device-actions`, and Classic's path shape — so a
docs section is not evidence a route exists.

### `flat` style does not work

No confirmed route uses it. Every flat request returns 400
`REQUEST_CONTEXT_NOT_PROVIDED`, **including one to a route that cannot exist** —
proven by `_control-bogus-flat-route`. So the gateway resolves tenant context
before routing and rejects any path without it, and a 400 is silent about whether
the route exists. Ten header spellings (`X-Jamf-Tenant-Id`, `X-Tenant-Id`,
`Jamf-Tenant`, …) were all ignored.

The error text says context may come "in token or headers", which hints a token
could be bound to a tenant at issue time. Untested, and not worth chasing while
`tenant` style works.

### `device-actions` is hosted but unverified

The segment exists, but every route in it is a write (`erase`, `restart`,
`shutdown`, `unmanage`, `check-in`) gated on `execute:pro:device-actions`. A
read-only integration cannot confirm any route there, which is the correct
outcome — do not add write scopes just to satisfy discovery.

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
