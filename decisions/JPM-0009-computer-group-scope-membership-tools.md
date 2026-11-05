# JPM-0009: Four tools to add or remove one computer group in a profile or policy scope

- **Status:** Accepted; the rejection of a batch tool superseded by
  [JPM-0010](JPM-0010-scope-membership-batch-tool.md); the whole-object non-scope
  verification rule for configuration profiles superseded in part by
  [JPM-0011](JPM-0011-accept-jamf-payload-identifier-normalization.md). Everything else
  stands.
- **Date:** 2026-11-04

## Context

When a compliance benchmark adds a smart group for a new macOS major version, that
group has to join the scope of every hand-built profile and policy that delivers the
baseline, often dozens of objects, so that Macs that upgrade keep their compliance
baseline. In the Jamf console that is one manual edit per object, each with no diff
and no rollback, on objects that carry security controls for every Mac in scope.

Classic has no "add to scope" operation. A scope changes by PUTting a `<scope>`, and a
PUT replaces what was there. That is the same trap
[JPM-0008](JPM-0008-reversible-writes-as-a-separate-server.md) found in the prior art's
restricted-software update: send less than the live scope and the difference is silently
deleted. Two further risks are specific to these objects:

- A configuration profile's `redeploy_on_update` setting decides whether a change
  redeploys it. Whether a scope-only change counts is not documented. If it does, one
  edit would reinstall a compliance profile on every scoped Mac.
- Whether Jamf honours a PUT whose root element has only `<scope>` and leaves
  `general` and the payloads untouched is also undocumented. If it does not, a scope
  edit could blank a profile.

## Decision

Four tools in `src/write-server.ts`, implemented in `src/scope-membership.ts`:

- `addComputerGroupToProfileScope`, `removeComputerGroupFromProfileScope`: Classic
  `osxconfigurationprofiles/id/{id}`, GET then PUT.
- `addComputerGroupToPolicyScope`, `removeComputerGroupFromPolicyScope`: Classic
  `policies/id/{id}`, GET then PUT.

Input is strict and has no other fields: `{ id, computerGroupId, dryRun? }`, both ids
positive integers, `dryRun` defaulting to true. One object per call.

Rules, each answering a risk above:

- **Read the object and the group first.** The group (`computergroups/id/{id}`) must
  exist; its name and `is_smart` are reported.
- **A no-op is never silent.** Add refuses if the group is already in
  `scope.computer_groups`; remove refuses if it is not.
- **Refuse All Computers.**
- **Model what is round-tripped, refuse the rest.** Inclusions and exclusions of
  computers, computer groups, buildings and departments are modelled. If any other scope
  member is non-empty (`all_jss_users`, `jss_users`, `jss_user_groups`, `limit_to_users`,
  `limitations.*`, exclusions of users, user groups, network segments, ibeacons or JSS
  users, or anything unrecognised) the call refuses and names it. The tool never
  re-emits XML it does not model.
- **Profiles only: `redeploy_on_update` must be exactly "Newly Assigned".** Any other
  value, or none, refuses.
- **The body is the scope and nothing else.** The root element has a single `<scope>`
  child holding the full modelled scope. No `general`, payloads, self service, scripts or
  packages are ever sent.
- **Dry run does the reads and writes nothing.** It returns the action, resource, id,
  group, a field-level diff on `scope.computerGroupIds`, warnings (the live
  `redeploy_on_update`, a Self Service distribution method, the group also being in
  exclusions) and the exact XML.
- **A live write is verified two ways.** The stored scope is compared to the intended
  scope. And a SHA-256 fingerprint of every non-scope part of the object (for a profile
  that includes `general` and its payloads) is taken before and after; the result reports
  `otherFieldsUnchanged` and which top-level sections differ. Only hashes are returned or
  logged, never payload content. This is how each call proves a scope-only PUT left the
  rest alone.
- **Every result carries a rollback:** the inverse tool with the same `id` and
  `computerGroupId` and `dryRun: false`.
- **Writes disabled refuses**, as the existing tools do. A signed profile that Jamf
  rejects surfaces as the API error, with no special case.

The tools run under the **existing** write integration (JPM-0008 part 2); no new
integration. Its permissions gain `configuration-profiles:read`,
`configuration-profiles:update`, `policies:read`, `policies:update` and
`device-groups:read`. Each name was read on the operation pages for
`findosxconfigurationprofilesbyid-1`, `updateosxconfigurationprofilebyid-1`,
`findpoliciesbyid-1`, `updatepolicybyid-1` and `findcomputergroupsbyid-1` on
2026-11-04. No `:delete` permission is added.

**The integration also holds `:create` on all three resources, and `device-groups:update`,
which no tool uses.** The operator granted read, create and update on configuration
profiles, policies and device groups on 2026-11-04 and chose to keep them, so that a
create can be built later without re-provisioning. This departs from JPM-0008 part 2's
"permissions track its tools exactly" for these three resources only. The credential
is not the boundary for those verbs: the code is. No tool may issue a POST to these
resources, or a PUT to a group, until a new ADR adds a typed tool for it, and every
live write from this server needs the operator's approval in the session that makes it.

## Alternatives considered

### Replace the whole scope from caller-supplied values

Rejected. The caller would need the live scope in hand, and a stale copy overwrites
anything changed since. Reading the live scope inside the tool narrows the window to one
call.

### A batch tool

Rejected for now. The first live use is unverified, and one object per call keeps each
write's diff, fingerprint and rollback separate. A batch can be added later once the
canary gate has passed.

### A separate integration

Rejected. JPM-0008 expects the write integration to grow with its tools, and a second
credential adds rotation work without narrowing anything the first does not.

### The Jamf console

Remains the way for an object this tool refuses. As the whole method it means 82 edits
with no diff and no rollback.

### The Jamf Pro API

No scope-level equivalent for these two object types was found. Not verified exhaustively.

## Consequences

### Positive

- 82 edits become 82 reviewed calls, each with a diff, a read-back, a
  non-scope fingerprint and a rollback.
- Anything the tool cannot represent is refused by name rather than dropped.

### Negative

- **First-use canary gate.** Redistribution behaviour and scope-only PUT behaviour are
  unverified, and so is the XML body format (BACKLOG-1). Before any production object is
  touched, the operator creates a throwaway profile and a throwaway policy, each scoped
  to one test Mac. Run an add on each. In Jamf, check the profile and the Mac's MDM
  command history for any redistribution to other Macs, and check the result reports
  `otherFieldsUnchanged: true`. Only then change one production object, then the rest. The
  outcome is recorded in `docs/gateway-reference.md` and `docs/BACKLOG.md`.
- A profile with any `redeploy_on_update` other than "Newly Assigned", or with user
  limitations, stays a console edit.
- The permission set of the write integration grows by five that the tools use, plus
  `:create` on configuration profiles, policies and device groups and
  `device-groups:update`, held unused by operator decision (see Decision).
- Smart-group membership is not checked: adding a group that is empty or wrong is a
  valid call.

### Neutral

- The fingerprint can show a difference Jamf itself caused (for example a regenerated
  value). It reports the section, and the operator decides.

## References

- [JPM-0007](JPM-0007-write-path-posture.md), [JPM-0008](JPM-0008-reversible-writes-as-a-separate-server.md)
- `developer.jamf.com/platform-api/reference/findosxconfigurationprofilesbyid-1`,
  `updateosxconfigurationprofilebyid-1`, `findpoliciesbyid-1`, `updatepolicybyid-1`,
  `findcomputergroupsbyid-1`: read 2026-11-04. The update pages publish no request body
  and document only 201.
