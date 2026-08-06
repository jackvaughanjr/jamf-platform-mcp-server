# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the Jamf Platform API Gateway remains in public beta, minor versions may
carry breaking changes — the upstream contract has no published stability
guarantee.

## [Unreleased]

Slated for 0.3.0. The theme is that several tools were stating conclusions more
confidently than their evidence supported — a paging helper that returned an empty
list for a response it could not read, and an audit that reported "no references"
for a search term that could never have matched.

### Added

- **`getComputerGroup`** — a group's criteria in evaluation order, with parentheses and
  and/or joins preserved, plus a member count. Members are opt-in, because every existing
  route to this answer was wrong: `findGroupDependencies` fetches all group details and
  discards every criterion that is not a membership edge, `findCriteriaReferences` searches
  criteria but will not show a group's rules, and `platformRequest` returns the raw Classic
  envelope — a full roster of names, serials and MAC addresses to answer a two-line question.
  Flags criteria that will not do what they appear to: an **unanchored `matches regex`** tests
  whether a value CONTAINS a match rather than equals one, which silently turns "has failures"
  into "is not blank", and a **lowercase-only character class** still matches uppercase because
  Jamf Pro's MySQL collation is case-insensitive. Both were found in a live tenant, where
  together they let a sentinel value satisfy a group meant to exclude it. A static group says
  so rather than returning an empty criteria list, which would read as a smart group with no
  rules.
- **`findObjectReferences`** — what references a package, computer group or script,
  the check to run before deleting one. Jamf has no built-in answer ("There is no
  built-in feature for this, which is why there have been feature requests" —
  Jamf Nation); the two community tools that filled the gap are **Prune**, which
  deletes, and **Spruce**, archived in 2023. This project can never delete
  ([JPM-0007](decisions/JPM-0007-write-path-posture.md)), so it builds the read-only
  half. Prune's own caveat — it "may identify some items as unused that are actually
  in use due to API limitations" — is the bar: coverage is a typed `strength` field
  here, and `'clear'` is reachable only when every source kind in the matrix was
  supplied *and* every object read had a parseable container. `'unchecked'` is
  explicitly not a shade of "no references found". An **exclusion** is reported
  distinctly from an inclusion, and "not member of" from "member of", since
  conflating either inverts the meaning. Names match exactly and case-insensitively,
  never as substrings — a substring match across policy scopes would make the
  delete-safety answer useless.
  Four of ten source kinds are wired live: `policies`, `computergroups` and
  `advancedcomputersearches` are confirmed reachable, and `osxconfigurationprofiles`
  is wired from its own reference page (path confirmed, envelope key unverified). The
  other six are declared unavailable **with a reason** rather than probed blind —
  guessing resource paths is what produced JPM-0005.
- **`findGroupDependencies`** — the smart-group dependency graph the Jamf UI cannot
  show. A Jamf Nation audit found "over 20 smart groups that include other smart
  groups that are dependent on the first". Reports dependency cycles as their actual
  node paths (not a boolean), references to group names that do not exist, duplicate
  names, and a blast radius with per-dependant depth. `hasCycle` comes from a separate
  never-truncated traversal, so `hasCycle: true` with an empty `cycles` list is a
  meaningful state rather than a contradiction. Groups whose detail could not be
  fetched are named, because a group absent from the graph must not read as
  independent.
- **`getDeclarationScope`** — every device reporting a given declaration, with
  failures grouped by cause so one problem affecting forty Macs reads as one problem.
  Devices are resolved from bare UUIDs to names and serials. The default filter is
  `deviceId==*`, since `declarationIdentifier` is a path segment on this route and not
  an allowed filter field.
- **`style: 'classic'` on `platformRequest` and `buildUrl`** — builds
  `/tenant/{tenantId}/{resource}` with no version segment and fills the tenant in from
  config, so reaching Jamf Pro Classic no longer requires the caller to know the tenant
  id. Previously Classic was expressible only through `rawPath`, which meant
  interpolating the tenant by hand; supplying an empty one produces `/tenant//{resource}`
  and a 400 `REQUEST_CONTEXT_NOT_PROVIDED` whose message describes missing token context
  and gives no hint that a variable was blank.
- **`getDeviceDeclarationState`** — the first typed tool for Declaration Reporting,
  and the companion to `listBlueprints`: a Blueprint deploys declarations, and this
  reports whether they landed. Resolves a device by UUID or by a substring of name,
  serial, model or user; an ambiguous substring returns candidates. Leads with what
  failed, flattening Jamf's nested `reasons` (code, description, and per-detail
  lines), since a status count answers "is this device healthy" and never "why not".
  `INVALID` validity counts as a failure even alongside a `SUCCESSFUL` status,
  because a declaration can be delivered and still be invalid on the device.
  Status/type/channel are tallied by observed value rather than against a fixed enum
  list — every enum in this API already carries `UNKNOWN`, so a member Jamf adds
  later must not fall into no bucket.
  Two caveats are reported in the response rather than left in a doc: Jamf **requires**
  a filter and applies filters only to declarations already on the device, so
  **PENDING declarations are invisible** and a quiet result does not mean deployment
  finished; and the two legs settle independently so an unproven route cannot take
  down an answer the other can give.
  **Verified against a live tenant on 2026-08-06**, which also confirmed the
  `devices/{id}/declarations` route itself — documented but never called until now,
  since the discovery script stops at its first 200 per group. The match-all filter
  `declarationIdentifier==*` is not published anywhere and was inferred, then
  confirmed. Findings recorded in `docs/gateway-reference.md`, including that
  `active: false` co-occurs with `status: SUCCESSFUL` (so `active` is not a health
  signal) and that multi-page traversal is still unproven — the test device had 9
  declarations against a default page size of 20.
- **`requestAll` pages each segment by its own family.** `inferPagingFamily` derives
  the family from the service segment, with an explicit `pagingFamily` override.
  Inference is the default because both deviations are silent, so an opt-in parameter
  is only correct when the caller remembers it.
- **`platformRequest` is GET-only** and no longer offers `method` or `body`, so the
  passthrough cannot express a mutation at all
  ([JPM-0007](decisions/JPM-0007-write-path-posture.md) part 3). Guarded in the
  conventions test and on the wire in CI's handshake step.
- **`findCriteriaReferences` sweeps criterion-name aliases** rather than the literal
  query, and reports `termsSwept`, `matchedSettingKey` and `aliasesUsed` with each
  alias's confidence. Only `package_receipts` → "Packages Installed" / "Cached
  Packages" is verified against a live tenant; every other entry is a deliberately
  broad substring, and a test pins the confirmed set so a guess cannot be promoted
  silently.
- `sweepCriterionMatches`, `sweepDisplayFieldMatches`, `expandInventoryQuery`,
  `INVENTORY_SETTING_CRITERION_ALIASES`, `BOUNDED_FIND_MAX_DEPTH`.
- `.github/CODEOWNERS`, and an operator-facing write-posture section in `README.md`
  and `CONTRIBUTING.md`.

### Fixed

- **`findObjectReferences` could call a script "clear" without checking two knowable
  reference routes.** Prune's matrix checks scripts against policies only, and with
  policies supplied `notChecked` was empty, so `strength` reached `'clear'`. But a
  script invoked from **another script's body**, or from a **computer extension
  attribute's script**, is a real reference that no policy scope records — and both are
  readable, since `findExpensiveAutomations` already pulls `script_contents` and
  `input_type.script`. Prune's matrix is a hole there, not a specification. Both are now
  source kinds, declared unchecked with their consequence, so a script target caps at
  `partial-clear` until they are actually scanned. Detecting a body-level invocation
  means substring-searching contents, which this module refuses to do for names, so it
  is left honest rather than answered with a heuristic.
- **`getDeclarationScope`'s default filter matched nothing.** It defaulted to
  `deviceId==*`, which returned **200 with an empty result** for a declaration a device
  was simultaneously confirmed to be reporting as `SUCCESSFUL`. Jamf documents wildcard
  support for `declarationIdentifier` only — a path segment rather than a filterable
  field on that route — so a wildcard on `deviceId` compares UUIDs against a literal
  `*` and matches nothing without erroring. Settled by experiment: an exact `deviceId`
  returned its record, and `active==true,active==false` returned all 35 devices, which
  is now the default. `channel==SYSTEM` returns the same rows on a tenant with no
  user-channel records and was rejected as the default for exactly that reason. The
  empty-result verdict now names an unmatched filter as one of three indistinguishable
  causes and gives the filter to retry with.
- **`getDeviceDeclarationState` reported how many declarations a device had but never
  which.** On a healthy device the whole answer was counts — `total`, `byStatus`,
  `byType` — with identifiers appearing only inside `failed[]`, which is empty when
  nothing is wrong. So a healthy device produced nothing to act on and nothing to pass
  to `getDeclarationScope`, which needs a `declarationIdentifier`. That is the same
  "answers how many, never which" flaw `getDeviceGroupMembers` was built to fix, left
  sitting in a new tool. `summarizeDeclarations` now returns a `declarations` list
  naming each one with its type, status, active flag and channel.
- **`requestAll` returned `[]` for Jamf Pro Classic instead of failing.** Classic has
  no paging envelope, so the pager read "no items", stopped, and reported an empty
  list with no error. It now throws before the token request and names
  `extractClassicList` as the alternative.
- **`requestAll` silently truncated Declaration Reporting to 20 records.** That group
  spells the parameter `size`; the `page-size` being sent was ignored and its default
  applied. A caller-supplied `page-size` is now dropped on that family rather than
  sent knowing it is inert.
- **`requestAll` could not tell an unreadable response from an empty one.** Any body
  without `results[]` or `items[]` yielded an empty batch, which the pager treats as
  the last page. It now throws and names the keys actually present.
- **`findExpensiveAutomations` flagged bounded filesystem walks.** `find / -maxdepth 1`
  is cheap and was reported alongside genuine unbounded walks; false positives train
  people to ignore an audit. Bounds deeper than `BOUNDED_FIND_MAX_DEPTH` still flag,
  as does a bound belonging to a different command on the same line.
- **`getInventoryCollectionSettings` under-rated application collection.** A category
  with custom search paths was still rated `low` while its own explanation named the
  extra walks. Escalated categories now report the configured `paths`, because the
  rating is inferred from the count rather than measured and is therefore checkable
  rather than authoritative.
- **`DRY_RUN=1 ./scripts/discover-gateway.sh` printed a real tenant id** when one was
  exported in the caller's shell, despite being the one documented command that
  contacts nothing. Nothing reached git; the exposure was pasted terminal output.
- Corrected the `(?!\S*\bnull\b)` rationale, which described behaviour the regex
  never had: it suppresses `find /dev/null` only, not a `> /dev/null` redirect.
- `package-lock.json`'s own `version` field, left at `0.1.0` through two releases.

## [0.2.1] — 2026-08-06

Corrections only. Every change here fixes a claim the project had already
retracted elsewhere but was still publishing as fact.

### Fixed

- **`platformRequest` described Jamf Pro Classic as `/JSSResource/{resource}`** — a
  path shape that does not exist on the gateway at all, retracted by
  [JPM-0006](decisions/JPM-0006-classic-and-declaration-reporting-are-supported.md)
  the day before. A tool description is the instruction a model reads before
  reaching Classic, so the error steered callers straight into a 404. Classic is
  service `proclassic` with `rawPath` `/tenant/{tenantId}/{resource}` and no
  version segment. The same claim was corrected in two `src/platform-client.ts`
  comments and in the `buildUrl` tests, which used it as their worked example — a
  test is documentation, so a wrong example teaches.
- **`rawPath` now documents that nothing is inserted**, so the caller must supply
  the tenant segment itself. A path without one answers 400
  `REQUEST_CONTEXT_NOT_PROVIDED`.
- **`docs/endpoint-inventory.md` was a pre-JPM-0006 artefact linked from the README
  as current reference.** It still asserted that `pro` is an umbrella serving
  Classic and Declaration Reporting, that Compliance Benchmarks is the only `flat`
  group, and that three now-confirmed groups were unresolved. Corrected in place
  with the retractions kept visible, and headed with a pointer to
  `docs/gateway-reference.md` as the authority for observed behaviour. Its Device
  Management Actions section no longer claims a read-only integration receives 403
  for those routes — that was never tested, and per JPM-0007 it never will be.

### Added

- [JPM-0007](decisions/JPM-0007-write-path-posture.md) — the write-path posture. No
  read-write integration is provisioned; scopes that can erase or unmanage a device
  are never granted to this server in any configuration; reversible writes, if ever
  enabled, go through typed tools rather than the passthrough, because a passthrough
  write is unreviewable. Records the corollary JPM-0001 left implicit: credential
  scoping is only a boundary while the credential lacks the scope.

### Changed

- `actions/checkout` and `actions/setup-node` bumped to `@v5`. The `@v4` pins target
  the deprecated Node 20 and were already being forced onto Node 24 by the runner.

## [0.2.0] — 2026-08-05

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
- `getInventoryCollectionSettings` — reads the tenant inventory collection settings and
  rates each option by cost per collection, flagging `home_directory_sizes` as high
  because Jamf computes it by running `du` across every user home directory. The
  companion to `findExpensiveAutomations`, since that work lives in a tenant setting
  rather than in any script.
- `findCriteriaReferences` — searches smart computer group criteria, advanced computer
  search criteria AND advanced search display fields for a term, to establish whether
  anything consumes an inventory field before its collection is disabled. Reports what
  it did not check, because "no references found" is weaker evidence than a hit.
- `src/automations.ts` — pure scanning, policy-cadence, inventory-cost and
  criteria-matching helpers, mutation-checked.

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
