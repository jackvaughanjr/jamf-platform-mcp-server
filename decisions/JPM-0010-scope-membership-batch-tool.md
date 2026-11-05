# JPM-0010: A batch tool for computer group scope changes, approved once through a plan hash

- **Status:** Accepted; the non-scope verification rule for configuration profiles
  superseded in part by
  [JPM-0011](JPM-0011-accept-jamf-payload-identifier-normalization.md).
- **Date:** 2026-11-05
- **Amends:** the "A batch tool" alternative in
  [JPM-0009](JPM-0009-computer-group-scope-membership-tools.md), which rejected it. The
  four single-object tools and every other rule in JPM-0009 stand.

## Context

JPM-0009 shipped four tools that each add or remove one computer group in one object's
scope, and rejected a batch tool because "the first live use is unverified, and one
object per call keeps each write's diff, fingerprint and rollback separate."

In use, a single benchmark rollout needed many dozens of scope changes across dozens of
objects. The operator's harness asks for approval on every live write, so the rollout
meant that many separate approval prompts. Approving by rote is the failure mode an
approval exists to prevent: prompt fatigue erodes the very check the one-call-per-change
design was meant to preserve, and a reviewer who has approved eighty calls in a row is
not reading the eighty-first.

What the operator wants is the opposite shape: one reviewed plan, approved once, where
"approved" means exactly that plan and nothing else.

## Decision

One new tool in `src/write-server.ts`, implemented in `src/scope-membership-batch.ts` on
top of the parsing, XML builder, refusal rules, fingerprinting and read-back
verification that JPM-0009's module exports. The four single tools are unchanged.

**`applyScopeMembershipBatch`** takes `{ operations, dryRun?, planHash? }`. `operations`
is 1 to 150 items of `{ kind: 'profile' | 'policy', id, action: 'add' | 'remove',
computerGroupId }`; the schema is strict. `dryRun` defaults to true. `planHash` is
required when `dryRun` is false, and a live call without it is refused before any
request.

- **One PUT per object.** Operations are grouped by object (kind and id), in
  first-appearance order of objects and operation order within an object. Each object
  gets a single scope-only PUT carrying its final scope after all of its operations, so
  an object's adds and removes land together and no intermediate scope is ever live.
  Each distinct object and each distinct group is read once.
- **Same refusals as the single tools, evaluated against the live scope:** the group must
  exist; All Computers is refused; unmodelled scope members are refused; a profile's
  `redeploy_on_update` must be exactly "Newly Assigned"; an add of a group already
  present, a remove of a group not present, and the same (object, group) appearing twice
  in the batch are refused.
- **A refused operation withholds the whole plan.** A dry run with any refusal returns
  `ok: false` and every refusal (object, operation, reason), and no `planHash`. There is
  no partial plan to approve.
- **The plan hash is what the single approval covers.** On success a dry run returns a
  per-object table (kind, id, before and after `computerGroupIds`, operations, warnings),
  totals and a `planHash`: the SHA-256 of a canonical JSON of the operations as given,
  each object's modelled live scope and the `overall` hash of its non-scope fingerprint,
  and each group's id, name and `isSmart`. A change to any listed object (its scope or
  anything else about it) or group between the dry run and the live run changes the hash.
- **The live run recomputes it.** It re-reads everything and, if the hash differs,
  refuses with "live state changed since the dry run; dry-run again" and writes nothing.
  Writes disabled (the same flag as the other write tools) refuses after the reads and
  before any PUT.
- **Stop on the first failure.** Objects are written in order. Each is PUT, read back, and
  checked: the stored scope must equal the intended scope and the non-scope fingerprint
  must be unchanged. A PUT error, a scope mismatch, a changed non-scope section or a
  read-back error stops the batch; later objects are reported `notAttempted`. The result
  gives, per object, `status` (`written`, `failed`, `notAttempted`), `writtenAt`,
  `verified`, `otherFieldsUnchanged`, `differingSections` and `error`, plus totals.
- **The rollback is an inverse batch.** `rollback` is `{ tool: 'applyScopeMembershipBatch',
  operations, dryRun: true }` where `operations` are the inverses for every object whose
  PUT was sent (including one that failed verification), in reverse object order. It must
  itself be dry-run to obtain its own `planHash` before it is applied, so rolling back is
  reviewed like any other change.
- **Hashes only.** No payload content is ever returned or logged. One stderr line is
  written per object PUT; stdout stays the MCP transport.

No new permissions: the tool uses the read and update permissions JPM-0009 already
granted to the write integration.

## Alternatives considered

### Keep per-call approval

Rejected. It is what produced the problem: the approval step stays, but its value falls
as the count rises.

### Client-side approval batching

A harness hook that auto-approves calls matching a pre-approved plan file. Rejected.
The approval would live outside the server, in a file an agent could itself write, so the
control would be only as strong as the agent's restraint. A plan hash is verified by the
server against live state; nothing a caller can write substitutes for it.

### One PUT per operation

Rejected. Several operations on one object would put it through intermediate scopes,
each a state a Mac could be evaluated against, and would multiply the writes the
rollback has to reason about. One PUT per object means one write and one read-back per
object, and the final scope is the only scope that is ever live.

## Consequences

### Positive

- A rollout is one reviewed plan and one approval, and that approval is bound to the exact
  operations and the exact live state the reviewer saw.
- A drift between review and apply is caught by the server, not by the reviewer's memory.
- The single tools remain for one-offs, with their own prompts and unchanged behaviour.

### Negative

- **Partial completion is possible.** A failure on object N leaves objects before it
  written. That is bounded by stop-on-first-failure and the inverse batch, not prevented.
- A PUT that errors may or may not have been applied. Its object is in the rollback
  because the PUT was sent; if the write never landed, the inverse operations for that
  object are refused at the rollback's dry run and are dropped from it.
- The harness prompt shows the full operations list, up to 150 items. The reviewer has to
  read the dry run, not the prompt, to see before and after.
- The plan hash binds to everything about each listed object. An unrelated edit to one
  of them in the meantime forces a fresh dry run, by design.
- The PUT itself is the one JPM-0009's canary verified on 2026-11-05 (scope-only body
  accepted, other fields untouched, no redistribution). The batch orchestration (grouping,
  plan hash, stop-on-first-failure) is unverified live until its first run.

### Neutral

- Smart-group membership is still not checked.

## References

- [JPM-0007](JPM-0007-write-path-posture.md), [JPM-0008](JPM-0008-reversible-writes-as-a-separate-server.md),
  [JPM-0009](JPM-0009-computer-group-scope-membership-tools.md)
