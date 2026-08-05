# Architectural Decision Records

Decisions specific to this project — why it targets the Jamf Platform API Gateway,
how tools are exposed, how captured API data is handled, and what is deliberately
out of scope.

## What belongs here, and what does not

An ADR records a **decision** and the reasoning a future reader would otherwise
have to reconstruct. It is not a place for **findings** about someone else's API.

- Gateway path shapes, status-code semantics, which service segments are hosted →
  `CLAUDE.md` and `docs/gateway-reference.md`. These are observations about a
  product in public beta and will change when Jamf ships more of it.
- Why we build against that gateway at all, why tools are shaped the way they
  are, why three API groups are unsupported → here.

The distinction matters because ADRs are immutable and findings are not.

## Conventions

- Each record states its context, the decision, alternatives considered, and
  consequences.
- Numbered sequentially. Never deleted — only superseded by a later record.
- Identifiers are namespaced by repo. This repository's prefix is **`JPM-`**
  (Jamf Platform MCP). Always reference the prefixed form.
- **Immutable once committed.** Corrections go by a new superseding ADR, not by
  rewriting a published one. `scripts/check-adr-immutability.sh`, wired into
  `.githooks/pre-commit`, enforces this. Before external readers exist — nobody
  else has reviewed it, nothing downstream depends on it — an in-place edit is
  acceptable via `ADR_ALLOW_EDIT=1 git commit`.
- A superseded record is edited only to mark its status and point at the
  successor.

## Index

- [JPM-0001](JPM-0001-target-platform-api-gateway.md): Build against the Jamf
  Platform API Gateway rather than the Jamf Pro and Classic APIs directly, so the
  safety boundary can live in scoped credentials instead of application logic.
- [JPM-0002](JPM-0002-new-repo-not-a-fork.md): Start a new repository rather than
  fork `dbankscard/jamf-mcp-server`, retaining MIT attribution for the ported
  design.
- [JPM-0003](JPM-0003-passthrough-plus-selective-typed-tools.md): Expose one
  authenticated passthrough tool plus selectively-added typed tools, rather than
  one tool per endpoint.
- [JPM-0004](JPM-0004-type-only-fixtures.md): Commit type-only schemas derived
  from gateway responses; never commit the responses themselves.
- [JPM-0005](JPM-0005-unsupported-api-groups.md): Ship v1 without Jamf Pro
  Classic, Declaration Reporting, or Compliance Benchmarks, because the gateway
  does not expose them.
