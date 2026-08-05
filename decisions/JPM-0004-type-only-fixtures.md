# JPM-0004: Commit type-only schemas, never captured responses

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

Writing typed tools requires knowing response shapes, and the gateway publishes no
OpenAPI document. The only reliable source of shape is a real response from a real
tenant.

Those responses contain live fleet data: device serial numbers, usernames, email
addresses, IP addresses, per-device application inventory, building and department
assignments, and full MDM configuration in the case of blueprint detail. This
repository is intended to be shared outside the organisation that owns the tenant.

What a typed tool actually needs from a response is its **shape**. The values are
pure liability.

## Decision

Capture raw responses to a gitignored `fixtures/raw/`, and commit only
`fixtures/shapes/` — the same documents with every scalar replaced by its type
name. Object keys survive, because keys *are* the schema; values never do.

Enforce it rather than documenting it:

- `.gitignore` covers `fixtures/raw/` and the root blueprint dump
- `.githooks/pre-commit` rejects any staged file that `.gitignore` covers, so
  `git add -f` cannot defeat the boundary
- the discovery script masks tenant and device identifiers out of the committed
  report, with a catch-all that rewrites anything UUID-shaped and a post-write
  assertion as a backstop

## Alternatives considered

### Commit real sample responses

Standard practice in many projects and the most convenient for testing. Rejected:
the repository is shared externally, and a sample response from a production MDM
is a fleet inventory.

### Commit hand-redacted samples

Rejected as unreliable. Redaction by hand fails silently and asymmetrically — the
fields someone forgets are precisely the unusual ones. A mechanical
value-to-type transformation cannot miss a field.

### Keep no fixtures at all

Rejected. Shapes are the artefact that makes typed tools possible without a live
tenant, and they are also usable as test fixtures with no data-handling question
attached.

## Consequences

### Positive

- Shapes are safe to commit, safe to share, and directly usable for typed tools
  and tests.
- The data boundary is enforced mechanically at three layers rather than trusted.
- Contributors without tenant access can still see every response shape.

### Negative

- Arrays collapse to the shape of their first element, so a field that happened to
  be `null` in the first record is recorded as `"null"` rather than its real
  nullable type. Known instances: `devices.lastContactTime`,
  `blueprints.description`. Do not generate types from those without checking.
- Enum-ish string values are lost, so shapes cannot tell you the legal values of a
  field such as `deploymentState.state`.
- Regenerating shapes requires live credentials.

### Neutral

- The `git add -f` prohibition is repo-wide, not fixtures-specific, and applies to
  the client secret in `.env` for the same reason.

## References

- `scripts/discover-gateway.sh` — the shape filter and identifier masking
- `.githooks/pre-commit` — the force-add guard
- `CLAUDE.md` — the working rule for contributors
