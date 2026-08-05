# JPM-0001: Build against the Jamf Platform API Gateway

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

An MCP server for Jamf Pro can reach the tenant three ways: the Jamf Pro API, the
Classic API, or the Platform API Gateway (public beta). Existing community servers
use the first two directly — typically the Jamf Pro API with a Classic fallback —
and authenticate with credentials derived from a **user account**.

That matters because an MCP server for an MDM is not a read-only reporting tool.
Its natural tool surface includes executing policies, deploying scripts, and
sending MDM commands up to and including `erase`. With user-account auth, the only
thing standing between a model and a wiped fleet is application logic: the prior
art gates destruction behind a `confirm: true` parameter on each tool.

The gateway authenticates with OAuth 2.0 client credentials — a machine identity
with fine-grained, per-product scopes (`read:pro:blueprints` and similar), issued
per integration in Jamf Account.

## Decision

Build against the Platform API Gateway, and treat **credential scoping as the
safety boundary** rather than application logic.

A read-only integration is provisioned for development. The server's own
`JAMF_READ_ONLY` flag exists as a convenience backstop and is documented as *not*
the guarantee.

## Alternatives considered

### Jamf Pro API + Classic directly

The established path, and the one with working examples. Rejected because the
safety boundary would live in our code. A logic bug in a `confirm: true` check is
the difference between a refused call and a wiped device. Under scoped
credentials, a read-only integration *cannot* wipe a device regardless of what the
server does, because the gateway refuses the call.

### Contribute to `Jamf-Concepts/mcp-hub`

Jamf's own open-source MCP server, covering Jamf Pro, Protect, and Security Cloud.
Rejected for stack reasons rather than quality: it is Python, Beta, with no tagged
release, while this project is TypeScript. Worth revisiting if it matures.

### Wait for the gateway to reach GA

Rejected. The gateway carries the full Jamf Pro API surface, so targeting it costs
no endpoint coverage today, and the beta risk is contained by isolating every
gateway concern in `src/platform-client.ts`.

## Consequences

### Positive

- The permission boundary is enforced by Jamf, not by our code. A compromised or
  buggy read-only deployment cannot mutate the fleet.
- Two credentials give two server modes (read-only, read-write) with no code path
  distinguishing them.
- The secret is a client secret rather than user credentials, so it is rotatable
  and revocable without touching a person's account.

### Negative

- Public beta with no published breaking-change protocol and no announced GA date.
- Tokens live 900 seconds, so caching and refresh are mandatory rather than
  optional.
- Three documented API groups turned out not to be reachable at all — see
  [JPM-0005](JPM-0005-unsupported-api-groups.md).

### Neutral

- The gateway injects a `tenant/{tenantId}` path segment that standalone Jamf Pro
  API paths lack, so porting existing calls is a uniform transformation rather
  than a copy.

## References

- `docs/gateway-reference.md` — confirmed path shapes and status semantics
- `fixtures/discovery-report.md` — the empirical record
- [Platform API Gateway public beta announcement](https://community.jamf.com/from-jamf-179/the-new-platform-api-gateway-for-all-jamf-apis-public-beta-now-open-58089)
