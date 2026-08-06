# Platform API Gateway endpoint inventory

Compiled from the per-group `llms.txt` files under
`https://developer.jamf.com/platform-api/reference/`. No OpenAPI or Swagger
specification is published for the gateway, so this is the closest thing to a
machine-readable index.

**This document is the *documented* surface, not the confirmed one.**
[`gateway-reference.md`](gateway-reference.md) is the authority for what the
gateway actually does — path shapes, status semantics, per-group response
conventions. Where the two disagree, the live tenant wins and this file is wrong.

**Path shapes:** two have returned 200, and both put the tenant in the path.

```
{base}/api/{service}/{version}/tenant/{tenantId}/{resource}    most groups
{base}/api/proclassic/tenant/{tenantId}/{resource}             Classic — NO version
```

`{service}` may be **more than one segment** — Declaration Reporting is served at
`/api/ddm/report/`.

**The docs omit `/api/{service}`.** Every path below is reproduced as documented,
starting at `/v1/...`. The service segment must be prepended and is *not* the
scope prefix — Blueprints needs `read:pro:blueprints` but lives at
`/api/blueprints/...`. Run `scripts/discover-gateway.sh` to resolve segments
empirically; results land in `fixtures/discovery-report.md`.

Legend: **R** = reachable with read-only scopes · **W** = write. No write has ever
been attempted, and per
[JPM-0007](../decisions/JPM-0007-write-path-posture.md) the destructive ones never
will be from this server.

## Resolved segments (corrected 2026-08-05)

| group | segment | style | outcome |
|---|---|---|---|
| Blueprints | `blueprints` | `tenant` | **200 confirmed** |
| Blueprint components | `blueprints` | `tenant` | **200 confirmed** — resource is `blueprint-components` |
| Devices | `devices` | `tenant` | **200 confirmed** |
| Device Groups | `device-groups` | `tenant` | **200 confirmed** |
| Jamf Pro API | `pro` | `tenant` | **200 confirmed** — the Jamf Pro API only |
| Jamf Pro Classic | `proclassic` | `raw` | **200 confirmed** — no version segment |
| Declaration Reporting | `ddm/report` | `tenant` | **200 confirmed** |
| Device Management Actions | `device-actions` | `tenant` | hosted; all-write, never called |
| Compliance Benchmarks | `compliance-benchmarks` | `tenant` | routes, then **500 `Upstream host lookup failed`** |

**Seven groups reachable across seven segments, plus one broken upstream.** Two
earlier revisions of this table were wrong in opposite directions — first claiming
all eight resolved by reading 403 as "path correct, scope missing", then declaring
Classic, Declaration Reporting and Compliance Benchmarks unreachable. Both errors
came from probing candidate paths while reading only the index `llms.txt` files.
The individual endpoint reference pages publish the exact path for every operation
and had the answers throughout. Recorded as
[JPM-0006](../decisions/JPM-0006-classic-and-declaration-reporting-are-supported.md),
which supersedes [JPM-0005](../decisions/JPM-0005-unsupported-api-groups.md).

Specifically retracted:

- ~~`pro` is an umbrella serving the Jamf Pro API, Classic and Declaration
  Reporting~~ — it serves the Jamf Pro API alone.
- ~~Classic is `/api/pro/JSSResource/tenant/{tenantId}/{resource}`~~ — **no
  `/JSSResource/` prefix exists on the gateway at all.** Classic is
  `/api/proclassic/tenant/{tenantId}/{resource}`. 500+ endpoints reachable through
  `rawPath`.
- ~~Compliance Benchmarks is the only `flat` group~~ — it takes a tenant segment
  like everything else. No `flat` request has ever returned 200; every one answers
  400 `REQUEST_CONTEXT_NOT_PROVIDED`.

**Declaration Reporting** does take a tenant segment even though its published
paths omit one, and it is ID-only with no collection endpoint. It paginates with
`page` and **`size`** — not `page-size`, which is silently ignored.

**Classic response conventions differ from every other group:** a named-key
envelope (`{"scripts": [...]}` for lists, `{"script": {...}}` for details) with
`snake_case` fields, no `results[]`, no `totalCount` and no paging envelope. The
reference pages document the singular XML element, so reading them literally and
looking for `script` in JSON finds nothing.

## Devices — segment **confirmed**: `devices`

| | Method | Path |
|---|---|---|
| R | GET | `/v1/tenant/{tenantid}/devices` |
| R | GET | `/v1/tenant/{tenantid}/devices/{id}` |
| R | GET | `/v1/tenant/{tenantid}/devices/{id}/applications` |
| R | GET | `/v1/tenant/{tenantid}/users/{id}/devices` |
| W | PATCH | `/v1/tenant/{tenantid}/devices/{id}` |
| W | DELETE | `/v1/tenant/{tenantid}/devices/{id}` |

## Device Groups — segment **confirmed**: `device-groups`

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

## Compliance Benchmarks — segment **confirmed**: `compliance-benchmarks`

The documented path is correct — `/v1/tenant/{tenantId}/benchmarks`, `tenant` style
— but the gateway returns **500 `{"error":"Upstream host lookup failed"}`**: it
routes the request and cannot reach its own backend. The licence is confirmed, so
this is a genuine fault on Jamf's side, not a scope or path problem. Nothing below
is callable today. A canary probe stays in `scripts/discover-gateway.sh` so a fix
gets noticed; trace IDs are in `fixtures/raw/errors/` (gitignored).

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

## Declaration Reporting — segment **confirmed**: `ddm/report`

| | Method | Path |
|---|---|---|
| R | GET | `/v1/devices/{deviceId}/declarations` |
| R | GET | `/v1/declarations/{declarationIdentifier}/devices` |
| R | GET | Get filtered device report declarations *(path not published)* |
| R | GET | Get device channels *(path not published)* |
| R | GET | Get filtered declaration report devices *(path not published)* |

The published paths above have **no `tenant/{tenantId}` segment**, unlike every
other group — the docs were abbreviating. Confirmed live: the gateway requires the
tenant segment here too, at
`/api/ddm/report/v1/tenant/{tenantId}/devices/{id}/channels`. The response envelope
is `deviceId` + `channels`.

## Device Management Actions — segment **confirmed**: `device-actions`

Note the segment is `device-actions`, **not** the documented group name
`device-management-actions`, which is not hosted.

All write, all gated on `execute:pro:device-actions`. **No route here has ever been
called**, so the paths below are documentation rather than observation — and
[JPM-0007](../decisions/JPM-0007-write-path-posture.md) decides that stays true:
this server is never granted a scope that can erase or unmanage a device. What a
read-only integration receives for these was never tested and should not be
assumed.

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
These are the large legacy surfaces (hundreds of endpoints), reached through
separate segments: the Jamf Pro API at `pro` (`tenant` style, per-resource
versions) and Classic at `proclassic` (`raw` style, no version). Both are confirmed
200; neither is individually enumerated here. Routes confirmed under `proclassic`
are listed in [`gateway-reference.md`](gateway-reference.md). Reference indexes:

- `https://developer.jamf.com/platform-api/reference/jamf-pro-api/llms.txt`
- `https://developer.jamf.com/platform-api/reference/jamf-pro-classic/llms.txt`

## Read-surface totals

Documented GET endpoints, which is not the same as usable ones:

| Group | GET endpoints | usable |
|---|---|---|
| Compliance Benchmarks | 7 | **no** — 500 upstream |
| Blueprints | 5 | yes |
| Declaration Reporting | 5 | yes |
| Devices | 4 | yes |
| Device Groups | 4 | yes |
| Device Management Actions | 0 | n/a — all write |
| **Total (new APIs)** | **25** | **18** |

Excludes the Jamf Pro API's 300+ and Classic's 500+, both reachable through
`platformRequest`.
