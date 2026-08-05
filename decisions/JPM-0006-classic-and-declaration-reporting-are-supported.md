# JPM-0006: Jamf Pro Classic and Declaration Reporting are supported after all

- **Status:** Accepted
- **Date:** 2026-08-05
- **Supersedes:** [JPM-0005](JPM-0005-unsupported-api-groups.md)

## Context

[JPM-0005](JPM-0005-unsupported-api-groups.md) concluded that Jamf Pro Classic,
Declaration Reporting and Compliance Benchmarks were not exposed through the
gateway, and shipped that as a scope decision. It was wrong on all three counts.

The error was one of method, not reasoning. Discovery relied on probing candidate
paths, guided only by the index `llms.txt` files. The **individual endpoint
reference pages were never read** — and those pages publish the exact base URL and
path for every operation. Reading three of them produced in minutes what several
probing passes had not:

```
GET https://{region}.apigw.jamf.com/api/proclassic            /tenant/{t}/activationcode
GET https://{region}.apigw.jamf.com/api/ddm/report            /v1/tenant/{t}/devices/{id}/channels
GET https://{region}.apigw.jamf.com/api/compliance-benchmarks /v1/tenant/{t}/benchmarks
```

All three then verified against a live tenant. Classic and Declaration Reporting
returned **200**. Compliance Benchmarks returned **500** with
`{"error":"Upstream host lookup failed"}` — the gateway routes the path and cannot
reach its own backend.

Each miss had a specific cause:

- **`proclassic` was never a candidate.** Probes tried `classic`,
  `jamf-pro-classic`, `jssresource`, `pro`.
- **`ddm/report` is a two-segment prefix.** Every probe and the service-enumeration
  oracle assumed `/api/{one-segment}/`, so `ddm` enumerated as "not hosted" while
  the group is served beneath it.
- **Compliance Benchmarks takes a tenant segment.** Probing settled on the `flat`
  variant, and its gateway-level 403 was read as the whole segment being blocked
  on one data point.

## Decision

Support Jamf Pro Classic and Declaration Reporting. Treat Compliance Benchmarks as
**blocked by a fault on Jamf's side**, with the path recorded as correct.

| group | segment | style | path |
|---|---|---|---|
| Jamf Pro Classic | `proclassic` | `raw` | `/tenant/{tenantId}/{resource}` — no version |
| Declaration Reporting | `ddm/report` | `tenant` | `/v1/tenant/{tenantId}/devices/{id}/channels` |
| Compliance Benchmarks | `compliance-benchmarks` | `tenant` | `/v1/tenant/{tenantId}/benchmarks` — 500 upstream |

Adopt a process rule with it: **read the individual endpoint reference page before
probing a group.** Probing is for verifying a documented path and for catching
documentation that lies, not for discovering paths from scratch.

## Alternatives considered

### Leave JPM-0005 standing and note the correction elsewhere

Rejected. It shipped a scope decision that is now false, and `README.md`,
`CHANGELOG.md` and `docs/gateway-reference.md` all cited it. A wrong ADR left
standing is worse than no ADR, because it carries authority.

### Edit JPM-0005 in place

Rejected. It had been acted upon — code, README and changelog all referenced its
conclusion — which is exactly the condition where the immutability convention
requires supersession rather than a rewrite. JPM-0005 gets a status pointer and
nothing else.

### Support Compliance Benchmarks anyway, since the path is right

Rejected for now. `{"error":"Upstream host lookup failed"}` is not something a
client can work around; the gateway cannot reach the service. A tool built on it
would fail every call. One canary probe stays in the discovery script so a fix on
Jamf's side is noticed.

## Consequences

### Positive

- Jamf Pro Classic's large endpoint surface is reachable, which was the single
  biggest gap in coverage.
- Declaration Reporting gives per-device declaration state, the natural companion
  to Blueprints.
- Compliance Benchmarks now has an actionable diagnosis to report to Jamf rather
  than an unexplained absence.

### Negative

- **`requestAll` does not work for Classic.** Classic wraps responses in a named
  key (`{"activation_code": {...}}`) with no `results`/`items` array, no
  `totalCount` and no paging envelope. Paging Classic needs separate handling.
- **`requestAll` is wrong for Declaration Reporting as written.** That group
  paginates with `page` and **`size`**, not `page-size`, so the helper would send an
  ignored parameter and silently get the default page size of 20.
- Response conventions now differ by group: Classic is `snake_case` under a named
  key, the newer APIs are `camelCase` with `results[]`. Anything generic must not
  assume one shape.

### Neutral

- The service-enumeration oracle keeps its value but has a documented blind spot:
  a negative result means "not hosted under this exact single segment", never "not
  reachable".

## References

- `fixtures/discovery-report.md` — the verifying run
- `docs/gateway-reference.md` — confirmed paths and per-group conventions
- `fixtures/shapes/jamf-pro-classic.json`, `fixtures/shapes/declaration-reporting.json`
