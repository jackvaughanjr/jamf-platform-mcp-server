# Jamf Platform API Gateway — observed behaviour

Empirical findings about a product in public beta, established against a live
tenant on 2026-08-04. These are **observations, not decisions** — they will change
as Jamf ships more of the gateway. Decisions live in [`decisions/`](../decisions/).

Source of truth for the raw results: [`fixtures/discovery-report.md`](../fixtures/discovery-report.md).

## Path shape

Every route confirmed working has one shape, and it is the only shape ever
observed to return 200:

```
{base}/api/{service}/{version}/tenant/{tenantId}/{resource}
```

## Confirmed routes

| group | segment | resource | notes |
|---|---|---|---|
| Blueprints | `blueprints` | `blueprints` | envelope: `totalCount` only |
| Blueprint components | `blueprints` | `blueprint-components` | records keyed `identifier`, not `id` |
| Devices | `devices` | `devices` | full paging envelope |
| Device Groups | `device-groups` | `device-groups` | full paging envelope; exposes `memberCount` |
| Jamf Pro API | `pro` | *(300+ resources)* | confirmed with `account-groups`, `buildings` |

Three traps, each of which cost real time:

**The service segment is not the scope prefix.** Blueprints requires the scope
`read:pro:blueprints` but lives at `/api/blueprints/...`. Deriving the segment from
the scope name yields `/api/pro/...` and a 404 that reads like a permissions error.

**Resource names are fully qualified, not relative to their service.** Blueprint
components is `blueprint-components`, not `components`, despite sitting under the
`blueprints` service.

**Jamf Pro versions are per-resource.** `account-groups` is v1, `enrollment` v3,
`computers-inventory` v4. Never carry a version from one resource to the next.

## Hosted service segments

Enumerable, because a route that cannot exist returns 403 under a hosted segment
and 404 under one the gateway does not serve — so no valid route need be known.

**Hosted:** `blueprints`, `devices`, `device-groups`, `pro`, `device-actions`

**Refused wholesale:** `compliance-benchmarks` — a nonsense route gets the same
gateway-level 403 as a real one, so the entire segment is blocked.

**Not hosted:** `classic`, `jamf-pro-classic`, `jssresource`, `jamf-pro`,
`jamf-pro-api`, `declarations`, `declaration-reporting`,
`device-management-actions`, `ddm`, `declarative`, `device-declarations`,
`declaration-reports`, `reporting`, `protect`, `jamf-protect`, `security-cloud`,
`jamf-security-cloud`, `benchmarks`, `compliance`, `mscp`, `users`, `computers`,
`mobile-devices`, `inventory`, `patch`, `policies`, `settings`, `self-service`.

`device-actions` is hosted but **unverified**: every route in it is a write
(`erase`, `restart`, `shutdown`, `unmanage`, `check-in`) gated on
`execute:pro:device-actions`, which a read-only integration cannot confirm. Do not
grant write scopes to satisfy discovery.

Note the segment is `device-actions`, not the documented group name
`device-management-actions`, which is not hosted.

## Status code semantics

Settled by negative control, not inference:

```
route that cannot exist, under a working service  -> 403 BAD_PERMISSIONS
service that cannot exist                          -> 404
flat route that cannot exist, working service      -> 400 REQUEST_CONTEXT_NOT_PROVIDED
```

| status | meaning |
|---|---|
| **404** | unknown *service* segment |
| **403 `BAD_PERMISSIONS`** | unknown *route* inside a reachable service. A wrong path, **not** a permission problem — keep sweeping candidates |
| **403 other body** | the gateway recognises the route and refuses it, e.g. `{"error":"Requested endpoint is forbidden"}`. A real signal about that path |
| **400 `REQUEST_CONTEXT_NOT_PROVIDED`** | no tenant in the path. Says **nothing** about whether the route exists |
| **401** | token rejected — a credential problem, not a path problem |

**Tell the two 403s apart by envelope.** `BAD_PERMISSIONS` arrives in Jamf Pro's
own format (`httpStatus`, `traceId`, `errors[].code`), meaning the request reached
Jamf Pro. A bare `{"error":"…"}` is the gateway refusing before routing.

**Scopes do not explain any of it.** An integration granted *every* available
`read:pro:*` scope still receives these 403s, while `blueprints` list returns 200
under the same `read:pro:blueprints` that 403s elsewhere.

`scripts/discover-gateway.sh` saves every 4xx body to `fixtures/raw/errors/`
(gitignored) and puts a scrubbed message in the report. **Read the bodies before
theorising** — three passes were spent inferring from bare status codes, and the
status alone was actively misleading.

## Pagination

Envelopes are not uniform, so a generic helper must not assume `hasNext` exists:

| segment | envelope |
|---|---|
| `devices`, `device-groups` | `page`, `pageSize`, `totalCount`, `totalPages`, `hasNext`, `hasPrevious` |
| `blueprints`, `blueprint-components`, `pro` | `results` + `totalCount` only |

`page` is **0-based**. Query parameters are `page` and `page-size`.

## `flat` style does not work

No confirmed route omits the tenant segment. Every flat request returns 400
`REQUEST_CONTEXT_NOT_PROVIDED`, including one to a route that cannot exist, so the
gateway resolves tenant context before routing. Ten header spellings
(`X-Jamf-Tenant-Id`, `X-Tenant-Id`, `Jamf-Tenant`, …) were all ignored.

The error text mentions context "in token or headers", hinting a token could be
bound to a tenant at issue time. Untested, and not worth chasing while `tenant`
style works.

## Cross-platform endpoints

`devices` and `device-groups` span macOS and iOS/iPadOS in a single list —
`device-groups` mixes `COMPUTER` and `MOBILE` `deviceType`, smart and static. They
are **not** equivalent to the Jamf Pro API's separate computer and mobile-device
endpoints, so anything ported from `listComputers` semantics will silently include
mobile devices.

## Claims previously recorded here that turned out to be wrong

Kept so nobody re-derives them:

- ~~403 means the path is correct and the scope is missing~~ — it marks an unknown
  route; scopes were granted throughout.
- ~~All eight documented groups are reachable~~ — five routes across four
  segments are.
- ~~`pro` is an umbrella serving the Jamf Pro API, Classic, and Declaration
  Reporting~~ — it serves the Jamf Pro API. The other two are unreachable.
- ~~Classic lives at `/api/pro/JSSResource/tenant/{tenantId}/{resource}`~~ — that
  returns BAD_PERMISSIONS. A 200 on `/api/pro/v1/tenant/{t}/buildings` was
  misattributed to Classic; its `{totalCount, results[]}` envelope and
  `streetAddress1`/`stateProvince` fields are the Jamf Pro API's schema, whereas
  Classic wraps as `{"buildings":[...]}`.
- ~~Declaration Reporting takes a tenant segment~~ — unproven; no route was found.
- ~~Compliance Benchmarks works via `flat` style~~ — it never returned 200.

The documentation itself was wrong three times: Declaration Reporting's published
paths omit a tenant segment the gateway requires, Device Management Actions is
`device-actions` rather than its documented group name, and Classic's path shape
does not match its own doc slugs. **A docs section is not evidence a route
exists.**
