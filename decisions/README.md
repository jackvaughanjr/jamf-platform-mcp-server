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
  successor. CI permits exactly that edit: `src/adr-guard.ts` allows a change to a
  committed record only when it touches nothing but the `Status:` bullet, says
  superseded, and links a successor that exists.

## Index

- [JPM-0001](JPM-0001-target-platform-api-gateway.md): Build against the Jamf
  Platform API Gateway rather than the Jamf Pro and Classic APIs directly, so the
  safety boundary can live in scoped credentials instead of application logic.
- [JPM-0002](JPM-0002-new-repo-not-a-fork.md): Build an independent project rather
  than fork the prior art; credit the design influence in `README.md`, with
  `LICENSE` carrying this project's copyright alone since nothing is derivative.
- [JPM-0003](JPM-0003-passthrough-plus-selective-typed-tools.md): Expose one
  authenticated passthrough tool plus selectively-added typed tools, rather than
  one tool per endpoint.
- [JPM-0004](JPM-0004-type-only-fixtures.md): Commit type-only schemas derived
  from gateway responses; never commit the responses themselves.
- [JPM-0005](JPM-0005-unsupported-api-groups.md): **Superseded by JPM-0006.** Ship
  v1 without Jamf Pro Classic, Declaration Reporting, or Compliance Benchmarks,
  because the gateway does not expose them. This conclusion was false.
- [JPM-0006](JPM-0006-classic-and-declaration-reporting-are-supported.md): Support
  Classic (`proclassic`) and Declaration Reporting (`ddm/report`), whose paths were
  published all along; treat Compliance Benchmarks as blocked by a fault on Jamf's
  side. Read the endpoint reference page before probing.
- [JPM-0007](JPM-0007-write-path-posture.md): Provision no read-write integration;
  never grant this server a scope that can erase or unmanage a device; if reversible
  writes are ever enabled, they go through typed tools and never the passthrough.
  Part 1 superseded by JPM-0008.
- [JPM-0008](JPM-0008-reversible-writes-as-a-separate-server.md): Reversible writes
  ship as a second server from this repo, under its own credential and registered per
  project, starting with Restricted Software create and update. Delete is not granted.
- [JPM-0009](JPM-0009-computer-group-scope-membership-tools.md): Four tools to add or
  remove one computer group in a configuration profile's or policy's scope, one object per
  call, refusing anything they cannot round-trip, fingerprinting every non-scope part
  around each write, under the existing write integration and gated by a first-use canary.
- [JPM-0010](JPM-0010-scope-membership-batch-tool.md): A batch tool for computer group
  scope changes, one PUT per object, approved once through a plan hash that binds the live
  run to the reviewed dry run, stopping on the first failure with an inverse batch as the
  rollback. Supersedes JPM-0009's rejection of a batch tool; the single tools stand.
- [JPM-0011](JPM-0011-accept-jamf-payload-identifier-normalization.md): Accept Jamf's
  regeneration of a configuration profile's inner payload identifiers, and its
  re-serialisation of the payload plist, as a verified-good scope write when a semantic
  comparison proves nothing else changed; any other non-scope difference still fails.
  Amends the verification rule in JPM-0009 and JPM-0010; adds `fast-xml-parser`.
- [JPM-0012](JPM-0012-create-script-and-policy-tools.md): Create-only `createScript` and
  `createPolicy` on the write server. Every field explicit, unknown fields rejected; policies
  always created disabled with an explicit scope, never all computers; script contents and
  parameter values shown only as SHA-256 and length; packages rejected; verified by
  read-back. Adds `scripts:create`, `scripts:read` and `categories:read`. Decisions 1 and 3
  (last sentence) and the no-`scripts:update` clause of 7 superseded by JPM-0013.
- [JPM-0013](JPM-0013-write-surface-and-permissions.md): The write server's whole reversible
  surface (scripts, policies, groups, profiles, extension attributes, packages, categories,
  searches; updates, enable and disable, scope changes) and its complete permission set,
  decided once and built in phases. Permanent exclusions: no delete, no all-computers scope,
  no device actions, MDM commands or device secrets, on either server's credential. Supersedes
  parts of JPM-0008, JPM-0009 and JPM-0012.
