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
- `scripts/discover-gateway.sh` — resolves service segments empirically, enumerates
  hosted segments, and captures type-only response schemas.
- `scripts/fetch-blueprints.sh` — standalone Blueprints smoke test.
- Architectural decision records under `decisions/`, with an immutability guard.
- `.githooks/pre-commit` — rejects force-added gitignored files, guarding the
  client secret and captured fleet data.

### Known limitations

- Jamf Pro Classic, Declaration Reporting, and Compliance Benchmarks are not
  supported: the gateway does not expose them
  ([JPM-0005](decisions/JPM-0005-unsupported-api-groups.md)).
- No test suite yet.
- No pagination helper; callers drive `page` themselves, and `page` is 0-based.
