# jamf-platform-mcp-server: MCP server for the Jamf Platform API Gateway

![Tier](https://img.shields.io/badge/tier-Prototype-yellow)
![Upstream](https://img.shields.io/badge/upstream-Jamf%20Platform%20API%20(Beta)-orange)
![pre-commit](https://img.shields.io/badge/pre--commit-enabled-brightgreen)
![Tests](https://img.shields.io/badge/tests-257%20passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![SemVer](https://img.shields.io/badge/SemVer-2.0.0-blue)
![Keep a Changelog](https://img.shields.io/badge/changelog-Keep%20a%20Changelog-orange)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933)

An MCP server that gives AI assistants read access to a Jamf fleet through the
**Jamf Platform API Gateway**, authenticating with OAuth 2.0 client credentials
rather than user-account tokens. That choice is the point of the project: scoped
machine credentials mean the permission boundary is enforced by Jamf, so a
read-only integration cannot mutate a fleet no matter what this code does — see
[JPM-0001](decisions/JPM-0001-target-platform-api-gateway.md).
Canonical location: `github.com/jackvaughanjr/jamf-platform-mcp-server`.

**Tier:** Prototype — no production dependants, upstream API in public beta, minor
versions may break.

> **The upstream API is a public beta.** The Platform API Gateway has no published
> breaking-change protocol and no announced GA date. Pin dependencies and expect
> churn. One documented API group (Compliance Benchmarks) currently returns a
> gateway-side 500 ([JPM-0006](decisions/JPM-0006-classic-and-declaration-reporting-are-supported.md)).

## Provenance

**This is an independent project, not a fork or a derivative.** No shared git
history, no upstream remote, and no copied code.

It is worth naming an influence, though: evaluating
[dbankscard/jamf-mcp-server](https://github.com/dbankscard/jamf-mcp-server) (MIT)
is what surfaced the compound-tool idea used here — answering a whole fleet
question in one call rather than making a model loop over per-device requests.
That is a design idea, freely reusable and not subject to any licence term, so
this credit is courtesy rather than obligation and carries no requirement onward
to anyone using this project. Reasoning:
[JPM-0002](decisions/JPM-0002-new-repo-not-a-fork.md).

Related work worth knowing about:

- [Jamf-Concepts/mcp-hub](https://github.com/Jamf-Concepts/mcp-hub) — Jamf's own
  open-source MCP server (Python, Beta) for Jamf Pro, Protect and Security Cloud
- [`developer.jamf.com/mcp`](https://developer.jamf.com/developer-guide/docs/mcp) —
  Jamf-hosted MCP server for documentation search, not tenant management

## Structure

```
src/
  index.ts              MCP server: tool registration, stdio transport
  platform-client.ts    every gateway concern — auth, token cache, URL shapes, paging
  config.ts             environment validation (zod)
  fleet.ts              pure fleet aggregation — no client, no clock, no I/O
  automations.ts        script/policy auditing: expensive-command scan, policy cadence
  declaration-scope.ts  pure DDM rollup: one declaration across many devices
  *.test.ts             unit tests (vitest)
decisions/              architectural decision records, JPM- prefix, immutable
docs/
  gateway-reference.md  observed gateway behaviour: paths, status semantics, paging
  endpoint-inventory.md documented endpoint surface, compiled from Jamf's llms.txt
fixtures/
  shapes/               type-only response schemas — committed
  raw/                  captured responses — GITIGNORED, live fleet data
  discovery-report.md   empirical record of what resolves
scripts/
  discover-gateway.sh   resolves service segments, enumerates hosting, derives shapes
  fetch-blueprints.sh   standalone Blueprints smoke test
  jamf                  cwd-independent wrapper: scripts/jamf <tool> ['<json>']
  call-tool.mjs         calls one MCP tool live; inherits env so `op run` works
  check-adr-immutability.sh
.githooks/pre-commit    rejects force-added ignored files; enforces ADR immutability
```

## Current state (as of 2026-08-05)

Working and confirmed against a live tenant:

| segment | style | resource | notes |
|---|---|---|---|
| `blueprints` | tenant | `blueprints` | `totalCount`-only envelope |
| `blueprints` | tenant | `blueprint-components` | records keyed `identifier`, not `id` |
| `devices` | tenant | `devices` | full paging envelope; spans macOS **and** iOS |
| `device-groups` | tenant | `device-groups` | full envelope; exposes `memberCount` |
| `pro` | tenant | 300+ resources | the Jamf Pro API in full |
| `proclassic` | raw | `/tenant/{t}/{resource}` | Jamf Pro Classic — no version segment |
| `ddm/report` | tenant | `devices/{id}/channels` | Declaration Reporting |

**Compliance Benchmarks** has a correct, documented path but returns 500
`{"error":"Upstream host lookup failed"}` — the gateway routes it and cannot reach
its own backend. A fault on Jamf's side, not something a client can work around.

An earlier revision of this file claimed Classic, Declaration Reporting and
Compliance Benchmarks were simply not exposed. That was wrong; see
[JPM-0006](decisions/JPM-0006-classic-and-declaration-reporting-are-supported.md),
which supersedes JPM-0005 and explains how the error happened.

Tools: `getFleetOverview`, `findDevices`, `findOutdatedDevices`, `findDeviceGroups`,
`getDeviceGroupMembers`, `findExpensiveAutomations`, `getInventoryCollectionSettings`
and `findCriteriaReferences` (compound), `listBlueprints` and
`getDeviceDeclarationState` and `getDeclarationScope` (typed), and
`platformRequest` (authenticated **GET-only** passthrough to any gateway route). Tool
count stays deliberately small
([JPM-0003](decisions/JPM-0003-passthrough-plus-selective-typed-tools.md)).

Pagination is confirmed live: a real page-1 request returned different records with
`hasPrevious: true` and `totalPages: 13`, so `page` is 0-based as assumed and query
parameters survive the passthrough.

`device-actions` remains unverified, because every route in it is a write and no
write scopes have been granted.

## Setup

```bash
npm install                    # also points core.hooksPath at .githooks
cp .env.op.example .env.op     # edit to match your 1Password vault/item
npm run build
```

Create an integration in **Jamf Account → Integrations**. A read-only integration
is sufficient and strongly preferred. The client secret is shown exactly once.

| Variable | Required | Notes |
|---|---|---|
| `JAMF_CLIENT_ID` | yes | from the integration |
| `JAMF_CLIENT_SECRET` | yes | shown once at creation |
| `JAMF_TENANT_ID` | yes | appears in every gateway path |
| `JAMF_GATEWAY_BASE_URL` | no | defaults to `https://us.apigw.jamf.com` |
| `JAMF_TOKEN_URL` | no | defaults to `<base>/auth/token` |
| `JAMF_READ_ONLY` | no | defaults to `true`; a backstop, **not** the guarantee |

### Write posture

A read-only integration (above) is this project's supported configuration, not a
starter mode to graduate from
([JPM-0007](decisions/JPM-0007-write-path-posture.md)). Scopes that can erase or
unmanage a device are never granted to this server — not gated, not granted, in
any configuration. That work belongs in Jamf Pro's own interface, where it is
attributed to a named person and lands in Jamf's audit log.

`JAMF_READ_ONLY` above is a backstop, not the guarantee: it is on unless the value
is the literal string `false`, so a typo fails closed. The real boundary is what
the credential's scopes permit, which Jamf enforces — not this code. A fork that
grants write scopes is making that decision, and owns what follows from it.

`platformRequest` offers no `method` or `body` parameter, so the passthrough cannot
express a mutation at all — not even with write scopes granted. A passthrough write
is unreviewable in a way a typed tool's write is not, since method, path and body
would all be caller-composed with no schema constraining any of them. Any future
write is a named tool with a narrow schema, so the set of possible mutations stays
enumerable by reading `src/index.ts`.

Credentials are injected at runtime so the secret never lands on disk:

```bash
op run --env-file=.env.op -- npm run dev
```

### Register with Claude Code

```bash
claude mcp add jamf-platform -- node /absolute/path/to/dist/index.js
```

## Conventions

- **ISO dates** (`YYYY-MM-DD`) everywhere, including in dated snapshots above.
- **ADRs are immutable** once committed. Correct one by superseding it, never by
  editing. Enforced by `scripts/check-adr-immutability.sh` via the pre-commit
  hook; `ADR_ALLOW_EDIT=1` covers the sanctioned exceptions. Prefix: **`JPM-`**.
- **Decisions vs findings.** `decisions/` holds decisions and is immutable.
  `docs/gateway-reference.md` holds observations about a beta API and is expected
  to change. Do not mix them.
- **Never `git add -f`.** The ignore list is a data-handling boundary guarding the
  client secret and captured fleet data; a pre-commit hook enforces it.
- **Never commit a captured API response.** Only type-only shapes
  ([JPM-0004](decisions/JPM-0004-type-only-fixtures.md)).
- **Confirm routes empirically.** A Jamf docs section is not evidence a route
  exists — the documentation has been wrong three times about this gateway.
- **Commit messages** explain *why*, and state explicitly when they retract an
  earlier conclusion. Descriptive imperative subjects; not Conventional Commits,
  which is why there is no badge claiming otherwise.

## Versioning

[SemVer 2.0.0](https://semver.org/spec/v2.0.0.html). `package.json` is the single
source of the version. Changes are recorded in
[CHANGELOG.md](CHANGELOG.md) per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Releases are tagged `vX.Y.Z`.

While the gateway remains in public beta, **minor versions may carry breaking
changes** — the upstream contract offers no stability guarantee, so strict SemVer
against it would be a false promise.

## Testing

```bash
npm test              # vitest, 119 tests
npm run typecheck
DRY_RUN=1 ./scripts/discover-gateway.sh    # probe matrix, no credentials needed
```

To exercise a tool against a live tenant — works from any directory:

```bash
scripts/jamf tools/list
scripts/jamf getFleetOverview
scripts/jamf findDevices '{"query":"MacBook"}'
```

`scripts/jamf` wraps `op run` with an absolute `--env-file` path, because `op`
resolves that against the caller's cwd and fails with a bare "open .env.op: no such
file or directory" otherwise. It also unsets `OP_SERVICE_ACCOUNT_TOKEN`, which the
committed `.envrc` handles inside the repo but cannot outside it, and resolves
symlinks so it can be linked onto `PATH` for a shorter handle:

```bash
ln -s "$PWD/scripts/jamf" ~/.local/bin/jamf-mcp
jamf-mcp getFleetOverview
```

**Not `npm run inspector` under `op run`.** The MCP Inspector spawns the server as
a child process without forwarding the parent environment, so injected credentials
never reach it and the server exits on config validation. Its `-e` flag would work
but puts the client secret on a command line where `ps` can read it.
`scripts/call-tool.mjs` spawns the server with the environment inherited, so
credentials go straight to the process that needs them. Its output can contain live
fleet data — redirect to a gitignored path if you keep it.

Tests never reach the gateway: `fetch` is stubbed per test and credentials are
fixtures. The suite is mutation-checked rather than assumed useful — each of these
deliberate breakages causes failures: removing the `totalCount` pagination
fallback, making paging 1-based, disabling the read-only guard, misclassifying
iPads as Macs, treating an unparseable timestamp as a recent check-in, letting an
empty search query match every device, and counting an absent `managed` flag as
unmanaged.

## The contribution contract

[CONTRIBUTING.md](CONTRIBUTING.md) is written as a contract, separating what a guard
will stop you doing from what a human reviews. Three rules are mechanically enforced
by a pre-commit hook and by CI:

| Rule | Enforced by |
|---|---|
| No live identifiers in tracked files — including test fixtures | `scripts/check-no-identifiers.sh` |
| No captured API responses committed; never `git add -f` | `.githooks/pre-commit` |
| Committed ADRs are immutable — supersede, never edit | `scripts/check-adr-immutability.sh` + CI base-branch diff |

`src/conventions.test.ts` additionally asserts the conventions that drifted during
early development: the test-count badge matches reality, ADR numbering is sequential
and fully indexed, every superseded record names its successor, and the README does
not cite a superseded ADR as guidance.

Test UUIDs use the reserved `deadbeef-` prefix, so an identifier copied out of live
output is visible rather than plausible. That rule exists because a real device id
reached a test file exactly that way.

## Pull request and review policy

Single maintainer at present, so changes land directly on `main`. On a second
contributor: branch protection on `main`, one non-author approval, and
`decisions/` changes reviewed by someone other than the author.

Every change should pass `npm test`, `npm run typecheck`, and `npm run build`.
Anything touching `src/platform-client.ts` should also be exercised against a live
tenant, since no test can confirm the gateway's actual behaviour.

## Cross-reference

- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, enforced rules, how to add an endpoint
- [CLAUDE.md](CLAUDE.md) — working rules for AI assistants in this repo
- [decisions/](decisions/) — why the project is built this way
- [docs/gateway-reference.md](docs/gateway-reference.md) — observed gateway behaviour
- [docs/endpoint-inventory.md](docs/endpoint-inventory.md) — documented endpoint surface
- [fixtures/discovery-report.md](fixtures/discovery-report.md) — empirical results

## License

MIT — see [LICENSE](LICENSE).
