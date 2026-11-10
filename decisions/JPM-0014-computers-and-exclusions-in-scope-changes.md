# JPM-0014: `applyScopeChanges` for computers and exclusions, and a PUT Jamf rejects is never a write

- **Status:** Accepted
- **Date:** 2026-11-09
- **Builds:** the `applyScopeChanges` row of
  [JPM-0013](JPM-0013-write-surface-and-permissions.md) decision 2, for configuration
  profiles and policies (its Phase 1). Restricted Software, the same row's Phase 2, is not
  built here.
- **Amends:** [JPM-0010](JPM-0010-scope-membership-batch-tool.md), in one consequence: a PUT
  that errors was put in the rollback "because the PUT was sent". For a PUT that Jamf answers
  with an HTTP error, that is replaced by decision 4 below. Every other rule in JPM-0010
  stands, and its tool keeps its input and output shape.

## Context

The scope tools of [JPM-0009](JPM-0009-computer-group-scope-membership-tools.md) and
[JPM-0010](JPM-0010-scope-membership-batch-tool.md) change one kind of member in one list: a
computer group, in a profile's or policy's targets. Two recurring jobs fall outside that:

- **One Mac as an exception.** Exclude one Mac from a profile or policy for the length of an
  upgrade, or target one Mac for a test. Without a tool, such a change is made in the console,
  with no diff, no read-back and no rollback.
- **Exclusions of any kind.** A group excluded during a rollout, then removed.

JPM-0013 already decided the shape: `applyScopeChanges`, the JPM-0010 engine generalised, its
operation gaining `member` (`computerGroup` or `computer`) and `list` (`include` or `exclude`),
nothing defaulting, every JPM-0009 refusal standing, and the group-only tools calling the same
engine. JPM-0013 says a tool on its list needs no new record. This one exists because building
it settled questions JPM-0013 left open, and one of them changes how an existing tool behaves.

The question that changes existing behaviour came from a live write the same day. A Classic
`PUT` of a policy's scope was answered **HTTP 409** and was **not saved**. Yet reads of that
policy for about ten minutes afterwards **showed the new scope**, as though it had been. The
most likely cause of the 409 is that another policy had exactly the same name: Jamf allows
duplicate policy names when a policy is created, but the Classic API appears to reject an
update to one. Two things follow:

- A read-back is not proof of a write. If the engine had read back after that 409, it would
  have found the intended scope and could have called the object verified.
- JPM-0010 put an errored object in the rollback because the PUT had been sent. Run during
  that window, the rollback's own dry run would have seen the phantom change and planned an
  inverse for a write that never happened.

## Decision

**1. One new tool, `applyScopeChanges`, in `src/write-server.ts`, implemented in
`src/scope-changes.ts`.** It takes `{ operations, dryRun?, planHash? }` with 1 to 150
operations. Each operation is a strict object:

```
{ kind: 'profile' | 'policy', id, action: 'add' | 'remove',
  member: 'computerGroup', list: 'include' | 'exclude', computerGroupId }
{ kind: 'profile' | 'policy', id, action: 'add' | 'remove',
  member: 'computer',      list: 'include' | 'exclude', computerId }
```

`member` selects which id field is required, and the other is rejected, so an id cannot be
read as the wrong kind. `list: 'include'` is the scope's targets (`scope.computers`,
`scope.computer_groups`); `'exclude'` is `scope.exclusions`. Nothing defaults: `member` and
`list` are required on every operation. No single-operation tools are added for computers or
exclusions: a batch of one is the single tool, and JPM-0013's tool list has no such tools.

**2. One engine, two input formats.** `applyScopeMembershipBatch` keeps its schema, its dry-run
table, its refusal entries and its rollback format, so existing callers are unaffected. Each of
its operations is now passed to the engine as a computer-group change to `include`. The engine
is JPM-0010's, unchanged in shape: group by object in first-appearance order, read each object
and group once, one scope-only PUT per object carrying its final scope, a plan hash, re-read
and recompute on the live run, verify each object by reading it back (scope, then the non-scope
fingerprint, with JPM-0011's normalisation rule), stop on the first failure, an inverse batch
as the rollback. The four single tools of JPM-0009 are not moved onto the engine by this
change. They already treat a PUT error as an error and never read back after one.

**3. The dry run and the plan hash cover the new fields.** Per object, the dry run gives
`before` and `after` for every list its operations touch, keyed by the same paths the
verification reports (`scope.computerIds`, `scope.exclusions.computerGroupIds` and so on).
The plan hash is SHA-256 over a canonical JSON of each operation with its `member` and `list`,
each object's whole modelled live scope (targets and exclusions, computers, groups, buildings
and departments) with its non-scope fingerprint, and each group's id, name and kind. Changing
only an operation's list or only its member changes the hash, and so does any change to any
list of a listed object.

**4. A PUT Jamf answers with an HTTP error is not a write.** If the PUT's response is non-2xx,
the object is marked `failed` with `rejectedWithHttpStatus` and an error saying it was **not
written**. It is **not read back**, because a read can show a rejected change, so nothing a
read returned could prove the write. The batch stops. The object is **kept out of the
rollback's operations** and listed under `rollback.notWritten` with its status and the inverse
operations to use only if a later read, after several minutes, still shows the change. A PUT
with **no HTTP response** (a network failure) may or may not have landed, so it stays in the
rollback as JPM-0010 decided. Totals gain `rejectedByJamf`. This applies to both batch tools.

**5. New refusals.** Each is evaluated against the live scope, and any refusal withholds the
whole plan as in JPM-0010.

- **A policy whose name another policy shares** (compared ignoring case and surrounding
  space, as the create tools compare names). The policy list is read once per batch, only when
  the batch has a policy, and a failure to read it refuses every policy in the batch. This is a
  refusal, not a warning, because the expected result of the PUT is a rejection that reads as a
  success. The remedy is a rename in the console. Profiles are not checked: no such rejection
  has been seen for them.
- **The same member added to the targets and the exclusions in one plan.** Exclusions win, so
  the target add would do nothing. A move (remove from one list, add to the other) is allowed.
- **A change that provably leaves the object reaching no computer:** after it, the targets are
  not empty, are only computers and computer groups, and every one is also excluded, when that
  was not already so before. A target that is a building or a department is never called
  empty, because it cannot be compared with computers without reading inventory, and group
  membership is not read either. Switching an object off is done by removing its targets,
  which is allowed.
- **Add of a member already in that list, remove of one not in it, and the same member, list
  and id twice for one object.** The JPM-0009 rule, per list.
- **Kept:** All Computers, unmodelled scope members, a profile's `redeploy_on_update` other
  than exactly "Newly Assigned", a group that does not exist, an object that cannot be read.

**6. Computer ids are not checked before the write.** The write integration holds no device
read permission, by operator decision 4 of JPM-0013, so the engine cannot read a computer. A
dry run that adds a computer warns that its id is unchecked, that a non-existent id is caught
only on read-back, and that the id of the wrong Mac is not caught at all, and says to confirm
the id with the read server first. A remove is checked against the live list like any other.
No computer name is returned, by the same decision's rule that personal data stays with the
read server.

**7. New warnings.** For a profile, when a change takes Macs out of scope (a target removed or
an exclusion added): Jamf removes a profile from a Mac that leaves its scope. When an added
member is also in the other list (exclusions win). When an object is left with no targets.

No new permissions: the reads and the PUT are those JPM-0009 already uses, plus the policy
list, under `policies:read`.

## Alternatives considered

### Extend `applyScopeMembershipBatch` with optional `member` and `list` that default to group and include

The obvious backwards-compatible change. Rejected. JPM-0013 decided that nothing defaults on
`applyScopeChanges` and that `applyScopeMembershipBatch` stays as it is. A defaulted `list`
makes an exclusion a caller forgot to mark into a target, and that mistake widens what a
profile or policy reaches. Two input formats over one engine give the same compatibility with
no defaults.

### Treat a non-2xx response as unknown, as JPM-0010 did

Rejected. "Unknown" put the object in the rollback and left it to the rollback's dry run to
drop it. During the window in which reads show the rejected change, that dry run would not
drop it. Jamf's answer is the better evidence: it said no.

### Read back after a non-2xx anyway, and report what the read shows

Rejected. A read that shows the intended scope is exactly what was seen after the 409, and is
exactly what must not be reported as a result. A field that could say "verified" next to
"rejected" invites the wrong one to be believed.

### Warn about a shared policy name instead of refusing

Rejected. The warning would precede a PUT expected to fail in the one way that reads as a
success. The cause of the 409 is inferred, not confirmed. If it proves wrong, a later record
can relax this refusal; until then a rename is a small price.

### Check computer ids before the write

Asked for, and rejected here because JPM-0013 operator decision 4 decided against the device
read permission it needs, to keep serials and usernames out of the write server's reach.
Changing that needs a record that supersedes that decision, not a tool. The warning and the
read server are the mitigation.

### Refuse any computer or group that ends up in both the targets and the exclusions

Rejected. A member already in one list and added to the other can be deliberate: excluding a
targeted group for the length of an upgrade, then removing the exclusion, is a common way to
pause something reversibly. It is warned. Only adding the same member to both lists in one
plan, which can only be a mistake, is refused.

## Consequences

### Positive

- Excluding one Mac, or targeting one, is a reviewed call with a diff, a read-back and a
  rollback, instead of a console edit described afterwards.
- A rejected PUT can no longer be reported as written by either batch tool, and its object no
  longer enters a rollback that could act on a phantom change.
- One engine serves both batch tools, so a rule added to one reaches the other.

### Negative

- **Existing behaviour changes for `applyScopeMembershipBatch`.** A policy whose name is shared
  is now refused, the policy list is read when a batch has a policy, a non-2xx PUT now leaves
  its object out of `rollback.operations`, and the stderr line is reworded. The input, the
  dry-run table and the refusal format are unchanged.
- **Unverified live.** The scope-only PUT itself is verified (JPM-0009's canary, whose objects
  were scoped to one computer, so a computer target round-tripped). A computer or group in a
  profile's or policy's exclusions has not been written by this engine yet, and nor has a
  computer target added rather than round-tripped. Whether Jamf drops a non-existent computer
  id silently or rejects the PUT is unknown; either way the object fails. The duplicate-name
  cause of the 409 is inferred.
- A computer excluded only through a group is not detected by the "reaches no computer"
  refusal, because group membership is not read.
- The single JPM-0009 tools are still a separate implementation, and do not check for a shared
  policy name.

### Neutral

- The rollback's `notWritten` entries are advice, not operations: nothing applies them unless a
  person dry-runs them after re-reading the object.
- No response body from a rejected PUT is returned, because for a profile it could quote the
  payload. The HTTP status is returned.

## References

- [JPM-0009](JPM-0009-computer-group-scope-membership-tools.md),
  [JPM-0010](JPM-0010-scope-membership-batch-tool.md),
  [JPM-0011](JPM-0011-accept-jamf-payload-identifier-normalization.md),
  [JPM-0013](JPM-0013-write-surface-and-permissions.md)
- `docs/gateway-reference.md`, "A rejected Classic PUT can read back as applied"
