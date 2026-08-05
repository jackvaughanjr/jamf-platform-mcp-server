# JPM-0003: One passthrough tool plus selectively-added typed tools

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

The gateway fronts a very large surface. The `pro` segment alone carries the Jamf
Pro API's 300+ endpoints, and the documentation also describes 500+ Classic
endpoints. Even setting Classic aside — see
[JPM-0005](JPM-0005-unsupported-api-groups.md) — the reachable surface is far
larger than a sensible tool count.

The prior art registers roughly 110 individual tools and then ships a separate
"Code Mode" specifically to escape the cost of that: every tool definition
consumes context before the model does any work, and a 110-tool manifest is a
substantial tax on every single request.

Meanwhile the gateway is in public beta with a surface that is still growing, so
any fixed set of wrappers is guaranteed to be incomplete.

## Decision

Ship a single authenticated passthrough tool, `platformRequest`, able to express
every path shape the gateway serves. Add typed tools selectively, driven by
workflows that actually get used.

Reachability comes first; curation follows evidence of use.

## Alternatives considered

### One tool per endpoint

Rejected. It is the approach whose cost the prior art had to engineer around, and
it cannot keep pace with a growing beta surface. It also front-loads the work of
designing hundreds of tool schemas before knowing which ten matter.

### Sandboxed-SDK mode only (the "Code Mode" shape)

Two tools plus a sandboxed JavaScript SDK scales better than either alternative
and remains attractive. Deferred rather than rejected: it is more machinery than a
young project needs, and the passthrough already delivers reachability. Revisit
once the typed-tool set is large enough to feel the pressure.

### Generate tools from an OpenAPI specification

The obvious mechanical route, and it is unavailable — the gateway publishes no
OpenAPI or Swagger document. The closest machine-readable artefact is a set of
per-group `llms.txt` files, whose contents proved unreliable enough to mislead
this project three times.

## Consequences

### Positive

- The entire reachable gateway surface is usable on day one.
- During the beta, the API can be explored conversationally before any schema is
  committed to.
- Tool count stays small, so context cost stays low.

### Negative

- A passthrough puts path construction in the model's hands, which is only safe
  because the gateway's own scopes bound what any credential can do
  ([JPM-0001](JPM-0001-target-platform-api-gateway.md)).
- Callers must know per-resource API versions; the gateway's Jamf Pro versions vary
  by resource (`account-groups` v1, `enrollment` v3, `computers-inventory` v4).
- No typed tool means no schema validation, so response handling is the caller's
  problem until a typed tool exists.

## References

- `src/index.ts` — `platformRequest`, and `listBlueprints` as the typed pattern
- `docs/gateway-reference.md` — path shapes the passthrough must express
