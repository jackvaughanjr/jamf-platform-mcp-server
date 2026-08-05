# JPM-0002: Start a new repository rather than fork the prior art

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

`dbankscard/jamf-mcp-server` (MIT) is a mature community MCP server for Jamf Pro —
roughly 110 registered tools, a sandboxed "Code Mode", and a tool taxonomy built
from real fleet experience. This project began by evaluating it.

Its durable value is not the HTTP plumbing. It is knowing which questions matter:
compound tools like `getFleetOverview` and `getDeviceFullProfile` that fan out
internally instead of making a model loop over per-device calls. That shape took
someone genuine operational experience to arrive at.

Two facts pushed against building inside it. Its auth model is user-account based,
which [JPM-0001](JPM-0001-target-platform-api-gateway.md) replaces wholesale — the
change touches the client and every tool. And upstream review had stalled: PR #12
closed unmerged, #10 and #11 open with no movement for roughly three weeks.

## Decision

Start a new repository. Port the **tool design** — the taxonomy and the
compound-tool idea — and write fresh code against the gateway.

Retain the original MIT copyright notice in `LICENSE` alongside ours, and state
the lineage in `README.md`.

## Alternatives considered

### Fork it

The honest representation if we were contributing back. Rejected because the
trajectory is divergent, not contributory: a fork is permanently badged as a
derivative, its PRs default to targeting upstream, and its issues live in the
parent's shadow. The path back upstream also looks closed.

### Take the ideas without attribution

Legally defensible — API shapes and design decisions are not copyrightable, and
no code was copied. Rejected because it is the wrong norm. Specific, unprompted
attribution costs nothing; vagueness about provenance is what irritates people.

### Build with no reference to prior art

Rejected as waste. The tool taxonomy is the expensive part to get right, and it is
freely available under a permissive licence.

## Consequences

### Positive

- Own history, own identity, no fork badge, and a clean slate for a different
  auth model.
- Attribution is unambiguous, and `LICENSE` is already correct should actual files
  be lifted later.

### Negative

- None of upstream's testing or operational hardening carries over. This repo
  starts with no test suite.
- Divergence means upstream fixes must be ported by hand, if at all.

### Neutral

- The original copyright line sits above ours in `LICENSE` rather than replacing
  it. Replacing it would have turned a compliant port into a licence violation.

## References

- [dbankscard/jamf-mcp-server](https://github.com/dbankscard/jamf-mcp-server) (MIT)
- `LICENSE`, `README.md` — attribution as shipped
