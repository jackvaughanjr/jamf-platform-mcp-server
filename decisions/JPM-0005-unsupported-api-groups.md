# JPM-0005: Ship v1 without Classic, Declaration Reporting, or Compliance Benchmarks

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

Jamf's documentation presents the Platform API Gateway as fronting the Jamf Pro
API, the Classic API, Blueprints, Declaration Reporting, Compliance Benchmarks,
Devices, Device Groups, and Device Management Actions. The beta announcement
describes Pro and Classic together as "the same APIs many of you are familiar
with, now brought into the fold."

Three of those groups could not be reached against a live tenant, using an
integration granted **every available `read:pro:*` scope**.

The finding is well-supported rather than a gap in searching, because the gateway's
own error behaviour is diagnosable. Two negative controls established it:

```
route that cannot exist, under a working service  -> 403 BAD_PERMISSIONS
service that cannot exist                          -> 404
flat route that cannot exist, working service      -> 400 REQUEST_CONTEXT_NOT_PROVIDED
```

So 403 `BAD_PERMISSIONS` marks an unknown *route*, 404 an unknown *service*, and a
400 says nothing at all about existence. That turns service segments into something
enumerable rather than guessable.

Against that: **Classic** has no hosted segment (`classic`, `jamf-pro-classic`,
`jssresource` all 404), and four path strategies under `pro` failed — including
Classic-only resource names with no Jamf Pro API twin, so a hit could not have been
misread. **Declaration Reporting** has no hosted segment either, and 16 route
candidates under `devices` and `pro` failed. **Compliance Benchmarks** is hosted
but refuses a nonsense route with the same gateway-level 403 as a real one, so the
whole segment is blocked rather than any particular path.

The documentation was also wrong three separate times: Declaration Reporting's
published paths omit a tenant segment the gateway requires, the Device Management
Actions segment is `device-actions` rather than the documented group name
`device-management-actions`, and Classic's path shape does not match its own slugs.

## Decision

Ship v1 supporting only what was confirmed: `blueprints`, `devices`,
`device-groups`, and `pro` (the Jamf Pro API in full). Treat the three unreachable
groups as external blockers and stop probing them.

Retain one `compliance-benchmarks` probe as a canary, so a change in the gateway's
posture is noticed rather than assumed.

## Alternatives considered

### Keep probing

Rejected on evidence. Classic alone consumed four distinct strategies across
several runs; Declaration Reporting 16 route candidates. Further name-guessing has
no reason to succeed where segment enumeration already showed no hosting.

### Fall back to the Classic API directly, outside the gateway

Technically available and would deliver Classic coverage. Rejected because it
reintroduces user-account authentication for that path, defeating
[JPM-0001](JPM-0001-target-platform-api-gateway.md) — the very boundary the
gateway was chosen for — and leaves the project maintaining two auth models.

### Block v1 until Jamf exposes them

Rejected. The confirmed surface includes the entire Jamf Pro API, which is more
than enough to be useful.

## Consequences

### Positive

- Scope is bounded by evidence, and the absence is explained rather than looking
  like an oversight.
- No second auth model.

### Negative

- No Classic-only functionality in v1. Some Jamf Pro capabilities exist *only* in
  Classic, so those are simply unavailable.
- Compliance Benchmarks was the most promising route to replacing hand-rolled
  compliance logic, and it stays hand-rolled.

### Neutral

- `device-actions` is hosted but unverified: every route in it is a write gated on
  `execute:pro:device-actions`, which a read-only integration cannot confirm. That
  is the correct outcome; write scopes should not be granted to satisfy discovery.
- Jamf Protect and Security Cloud are also absent, consistent with Jamf's published
  roadmap listing both as still to come.

## References

- `fixtures/discovery-report.md` — service enumeration and per-route results
- `docs/gateway-reference.md` — status semantics and the controls behind them
- `scripts/discover-gateway.sh` — retired probes, with the reasoning retained
