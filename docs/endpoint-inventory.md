# Platform API Gateway endpoint inventory

Compiled from the per-group `llms.txt` files under
`https://developer.jamf.com/platform-api/reference/`. No OpenAPI or Swagger
specification is published for the gateway, so this is the closest thing to a
machine-readable index.

**Full path shape:** `{base}/api/{service}/{version}/tenant/{tenantId}/{resource}`

**The docs omit `/api/{service}`.** Every path below is reproduced as documented,
starting at `/v1/...`. The service segment must be prepended and is *not* the
scope prefix — Blueprints needs `read:pro:blueprints` but lives at
`/api/blueprints/...`. Run `scripts/discover-gateway.sh` to resolve segments
empirically; results land in `fixtures/discovery-report.md`.

Legend: **R** = reachable with read-only scopes · **W** = write, blocked by a
read-only integration.

## Discovery results (2026-08-04)

| group | segment | outcome |
|---|---|---|
| Blueprints | `blueprints` | **200** — confirmed |
| Devices | `devices` | **200** — confirmed |
| Device Groups | `device-groups` | **200** — confirmed |
| Blueprint components | `blueprints` | **403** — path resolves, scope absent |
| Compliance Benchmarks | — | **404** on `compliance-benchmarks`, `benchmarks`, `compliance` |
| Declaration Reporting | — | **404** on `declaration-reporting`, `declarations` |

Three confirmed segments all equal the group name in kebab-case. Two open items:

**The probe varied only the service segment, not the resource.** If the resource
name is also wrong, every service candidate returns 404 and the group looks
unresolvable when only one half of the pair is off. Compliance Benchmarks was
probed as `.../{service}/v1/tenant/{id}/benchmarks`; the docs describe the
operation as "list tenant benchmarks", so the resource may differ. Next pass
should probe the service × resource matrix, not just service.

**Declaration Reporting may not take a tenant segment at all.** Its documented
paths are `/v1/devices/{deviceId}/declarations` and
`/v1/declarations/{declarationIdentifier}/devices` — no `tenant/{tenantId}`,
unlike every other group. The probe inserts the tenant segment unconditionally,
so a 404 is the expected result whether or not the segment name is right. It also
has no tenant-level list endpoint: both paths require an ID, so it needs a device
ID sourced from the Devices response.

**Blueprint components returned 403, which is a scope gap, not a path problem.**
The read-only integration holds `read:pro:blueprints` (list works) but not
whatever scope `components` requires. Worth adding if component metadata matters.

## Devices — segment candidate: `devices`

| | Method | Path |
|---|---|---|
| R | GET | `/v1/tenant/{tenantid}/devices` |
| R | GET | `/v1/tenant/{tenantid}/devices/{id}` |
| R | GET | `/v1/tenant/{tenantid}/devices/{id}/applications` |
| R | GET | `/v1/tenant/{tenantid}/users/{id}/devices` |
| W | PATCH | `/v1/tenant/{tenantid}/devices/{id}` |
| W | DELETE | `/v1/tenant/{tenantid}/devices/{id}` |

## Device Groups — segment candidates: `device-groups`, `devicegroups`

| | Method | Path |
|---|---|---|
| R | GET | `/v1/tenant/{tenantid}/device-groups` |
| R | GET | `/v1/tenant/{tenantid}/device-groups/{id}` |
| R | GET | `/v1/tenant/{tenantid}/device-groups/{id}/members` |
| R | GET | `/v1/tenant/{tenantid}/devices/{id}/device-groups` |
| W | POST | `/v1/tenant/{tenantid}/device-groups` |
| W | PATCH | `/v1/tenant/{tenantid}/device-groups/{id}` |
| W | PATCH | `/v1/tenant/{tenantid}/device-groups/{id}/members` |
| W | DELETE | `/v1/tenant/{tenantid}/device-groups/{id}` |

## Blueprints — segment **confirmed**: `blueprints`

Verified against a live tenant by `scripts/fetch-blueprints.sh`. Paging is
`page` + `page-size`, and **`page` is 0-based**. List responses carry
`totalCount` and `results[]`.

| | Method | Operation |
|---|---|---|
| R | GET | List blueprints |
| R | GET | Get a blueprint |
| R | GET | List available blueprint components |
| R | GET | Get component |
| R | GET | Get blueprint status report |
| W | POST | Create / deploy / undeploy blueprint |
| W | PATCH | Update blueprint configuration |
| W | DELETE | Delete a blueprint |

The Blueprints group's `llms.txt` publishes doc-page slugs rather than REST
paths, so operations are listed by name. Detail payloads expose `name`,
`deploymentState.state`, `scope.deviceGroups` / `scope.deviceGroupIds`, and
`steps[].components[].identifier`.

## Compliance Benchmarks — segment candidates: `compliance-benchmarks`, `benchmarks`, `compliance`

| | Method | Operation |
|---|---|---|
| R | GET | List tenant benchmarks |
| R | GET | Get benchmark by ID |
| R | GET | List mSCP baselines |
| R | GET | Get rules for a baseline |
| R | GET | Benchmark rules stats for a tenant |
| R | GET | Devices for a benchmark report rule |
| R | GET | Compliance percentage for a benchmark report |
| W | POST | Create a benchmark |
| W | DELETE | Remove a benchmark |

Seven read operations — the largest read surface of the new APIs, and the most
likely to replace hand-rolled compliance logic.

## Declaration Reporting — segment candidates: `declaration-reporting`, `declarations`

| | Method | Path |
|---|---|---|
| R | GET | `/v1/devices/{deviceId}/declarations` |
| R | GET | `/v1/declarations/{declarationIdentifier}/devices` |
| R | GET | Get filtered device report declarations *(path not published)* |
| R | GET | Get device channels *(path not published)* |
| R | GET | Get filtered declaration report devices *(path not published)* |

Note the inconsistency: these paths as documented have **no `tenant/{tenantId}`
segment**, unlike every other group. Either the docs are abbreviating or this
group genuinely differs — worth confirming before wiring a tool, since
`buildUrl` currently always inserts the tenant segment.

## Device Management Actions — segment candidate: `devices`

All write, all gated on `execute:pro:device-actions`. A read-only integration
returns 403 for every one of these, which is the intended outcome.

| | Method | Path |
|---|---|---|
| W | POST | `/v1/tenant/{tenantId}/devices/{id}/check-in` |
| W | POST | `/v1/tenant/{tenantId}/devices/{id}/erase` |
| W | POST | `/v1/tenant/{tenantId}/devices/{id}/restart` |
| W | POST | `/v1/tenant/{tenantId}/devices/{id}/shutdown` |
| W | POST | `/v1/tenant/{tenantId}/devices/{id}/unmanage` |

## Jamf Pro API / Jamf Pro Classic API

Both ride the gateway — per Jamf, "the same APIs many of you are familiar with,
now brought into the fold," where migrating means changing base URL and auth.
These are the large legacy surfaces (hundreds of endpoints) and are deliberately
out of scope for the initial discovery pass. Reference indexes:

- `https://developer.jamf.com/platform-api/reference/jamf-pro-api/llms.txt`
- `https://developer.jamf.com/platform-api/reference/jamf-pro-classic/llms.txt`

## Read-surface totals

| Group | GET endpoints |
|---|---|
| Compliance Benchmarks | 7 |
| Blueprints | 5 |
| Declaration Reporting | 5 |
| Devices | 4 |
| Device Groups | 4 |
| Device Management Actions | 0 |
| **Total (new APIs)** | **25** |
