# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the Jamf Platform API Gateway remains in public beta, minor versions may
carry breaking changes — the upstream contract has no published stability
guarantee.

## [Unreleased]

### Added

- `findDeviceGroups` — search device groups by name or description across computer
  and mobile, smart and static groups.
- `getDeviceGroupMembers` — resolves a group by UUID or name substring, then joins
  its members against the device list to give names, serials, platform and
  last-seen. The members endpoint returns bare device UUIDs, so on its own it
  answers "how many" but never "which". Member ids with no matching device are
  reported separately rather than dropped. An ambiguous name returns candidates
  instead of guessing.
- `findExpensiveAutomations` — audits scripts, computer extension attributes and
  policies for commands that burn CPU when run repeatedly (`du`, `find /`,
  `mdfind`, `system_profiler` and similar), and reports which policies run them
  and how often. Extension attributes are reported separately because they execute
  at every inventory collection. Detail requests are bounded by a concurrency limit
  and per-item failures are reported rather than failing the run.
- `src/automations.ts` — pure scanning and policy-cadence helpers, mutation-checked.

### Fixed

- **`findExpensiveAutomations` reported a false all-clear on its first live run.**
  Jamf Pro Classic's JSON wraps a collection in the plural key (`{"scripts": […]}`)
  while the reference pages document the singular XML element (`script`), so the
  lookup missed and every list came back empty — reported as "scanned 0, found no
  problems" with no error. An audit that cannot read the response now throws and
  names the keys actually present, rather than returning a clean bill of health.

## [0.1.0] — 2026-08-05

First release.

### Added

- MCP server targeting the Jamf Platform API Gateway with OAuth 2.0
  client-credentials authentication, token caching around the 900-second lifetime,
  and de-duplicated concurrent refreshes.
- `platformRequest` — authenticated passthrough reaching any gateway route, in all
  three path layouts (`tenant`, `flat`, verbatim `rawPath`).
- `getFleetOverview` — compound tool fetching devices, device groups and blueprints
  concurrently and summarising them. A failing section degrades that section only,
  rather than losing the whole answer. Takes `staleThresholdDays` and `topGroups`,
  and reports `deviceGroups.saturation` to flag when the largest-groups list is
  filled by catch-alls holding the entire fleet and is therefore uninformative.
- `findDevices` — search by serial, name, model, id or user across the paginated
  device list.
- `findOutdatedDevices` — devices below an OS major version, oldest first, with the
  freshest activity timestamp for each. Unknown-version devices are reported
  separately, since that is a reporting problem rather than an upgrade task.
- `listBlueprints` — minimal typed tool, and the pattern to copy.
- `requestAll()` — follows pagination across both envelope variants, using
  `hasNext` where a segment provides it and `totalCount` where it does not, with
  `maxPages` turning a contract change into an error rather than a loop.
- `src/fleet.ts` — pure aggregation helpers taking no client and no clock, so the
  logic is deterministic and testable without a tenant.
- Confirmed working routes across six gateway segments — `blueprints`, `devices`,
  `device-groups`, `pro`, `proclassic` (Jamf Pro Classic) and `ddm/report`
  (Declaration Reporting). Two further segments are hosted without a confirmed
  route: `device-actions` (write-only, deliberately untested) and
  `compliance-benchmarks` (500 upstream).
- `scripts/discover-gateway.sh` — resolves service segments empirically, enumerates
  hosted segments via the 403/404 oracle, captures type-only response schemas, and
  masks identifiers out of its committed report. `DRY_RUN=1` needs no credentials.
- `scripts/call-tool.mjs` — calls one MCP tool against a live tenant, inheriting the
  environment so `op run` can inject credentials the MCP Inspector cannot.
- `scripts/fetch-blueprints.sh` — standalone Blueprints smoke test.
- Test suite: vitest, 64 tests, mutation-checked.
- Architectural decision records under `decisions/` with an immutability guard.
- `.githooks/pre-commit` — rejects force-added gitignored files, guarding the OAuth
  client secret and captured fleet data.

### Known limitations

- **Compliance Benchmarks is unusable.** The documented path routes but the gateway
  returns 500 `{"error":"Upstream host lookup failed"}` — it cannot reach its own
  backend. A fault on Jamf's side
  ([JPM-0006](decisions/JPM-0006-classic-and-declaration-reporting-are-supported.md)).
- **`requestAll` does not work for Jamf Pro Classic.** Classic wraps responses in a
  named key with `snake_case` fields and has no `results[]`, `totalCount` or paging
  envelope.
- **`requestAll` is wrong for Declaration Reporting as written.** That group
  paginates with `page` and `size`, not `page-size`, so the parameter is ignored and
  the default page size of 20 applies silently.
- No typed tools for Classic or Declaration Reporting yet; both are reachable
  through `platformRequest`.
- `device-actions` is hosted but unverified — every route in it is a write, and no
  write scopes have been granted. See task in `decisions/` backlog before adding
  any write tool.
- The `flat` path style has never returned 200. Every tenant-less request answers
  400 `REQUEST_CONTEXT_NOT_PROVIDED`, and ten candidate tenant-header spellings
  were ignored.

### Fixed

*Corrections made during development, recorded because the reasoning matters more
than a clean history.*

- **Device staleness no longer derives from `lastCheckInTime` alone.** That field is
  populated for macOS devices and null for every mobile device, so the original
  rule reported the non-Mac portion of a fleet as never having reported in while
  their inventory timestamps were days old. Staleness now takes the freshest of
  `lastCheckInTime`, `lastContactTime` and `lastInventoryUpdateTime` and reports
  which field supplied it.
- **`buildUrl` could only emit one path shape**, which cannot express Jamf Pro
  Classic (no version segment) or any tenant-less path.
- **The Blueprints service segment was derived from its permission scope**, giving
  `/api/pro/...` instead of `/api/blueprints/...`.
- **`operatingSystemVersion` is an empty string, not null**, for devices that never
  completed setup; `?? null` passed `""` through beside a major version of
  `unknown`.
- **The version is read from `package.json`** rather than duplicated in
  `src/index.ts`, where it would have drifted at this first release.
