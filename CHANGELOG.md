# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the Jamf Platform API Gateway remains in public beta, minor versions may
carry breaking changes — the upstream contract has no published stability
guarantee.

## [Unreleased]

### Added

- MCP server targeting the Jamf Platform API Gateway with OAuth 2.0
  client-credentials authentication, token caching around the 900-second lifetime,
  and de-duplicated concurrent refreshes.
- `platformRequest` — authenticated passthrough reaching any gateway route, in all
  three path layouts.
- `listBlueprints` — typed tool, and the pattern to copy.
- `getFleetOverview` — compound tool fetching devices, device groups and blueprints
  concurrently and summarising them. A failing section degrades that section only,
  rather than losing the whole answer.
- `findDevices` — search by serial, name, model, id or user across the paginated
  device list.
- `findOutdatedDevices` — devices below an OS major version, oldest first, with the
  freshest activity timestamp for each. Unknown-version devices are reported
  separately, since that is a reporting problem rather than an upgrade task.
- `getFleetOverview` takes `topGroups` (default 10, raised from 5) and reports
  `deviceGroups.saturation`, which flags when the largest-groups list is filled by
  catch-all groups all holding the whole fleet and is therefore uninformative.
- `src/fleet.ts` — pure aggregation helpers, no client or clock, mutation-checked.
- `scripts/discover-gateway.sh` — resolves service segments empirically, enumerates
  hosted segments, and captures type-only response schemas.
- `scripts/fetch-blueprints.sh` — standalone Blueprints smoke test.
- `requestAll()` — follows pagination across both envelope variants, using `hasNext`
  when the segment provides it and `totalCount` when it does not.
- Test suite (vitest, 31 tests) covering URL shapes, token caching and refresh
  de-duplication, read-only enforcement, error surfacing, and pagination.
- Architectural decision records under `decisions/`, with an immutability guard.
- `.githooks/pre-commit` — rejects force-added gitignored files, guarding the
  client secret and captured fleet data.

### Known limitations

- Jamf Pro Classic, Declaration Reporting, and Compliance Benchmarks are not
  supported: the gateway does not expose them
  ([JPM-0005](decisions/JPM-0005-unsupported-api-groups.md)).
- `device-actions` is hosted but unverified — every route in it is a write, and no
  write scopes have been granted.

### Fixed

- Device staleness no longer derives from `lastCheckInTime` alone. That field is
  populated for Macs and null for every mobile device, so the original rule
  reported roughly a third of a mixed fleet as never having reported in while
  their inventory timestamps were days old. Staleness now takes the freshest of
  `lastCheckInTime`, `lastContactTime` and `lastInventoryUpdateTime`, and reports
  which field supplied it.
- `device-actions` is hosted but unverified — every route in it is a write.
