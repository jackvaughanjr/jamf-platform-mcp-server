# JPM-0008: Reversible writes ship as a separate server with its own credential, starting with Restricted Software

- **Status:** Accepted
- **Date:** 2026-10-06
- **Supersedes:** part 1 of [JPM-0007](JPM-0007-write-path-posture.md) ("no read-write
  integration is provisioned, and none is planned"). Parts 2 and 3 stand unchanged.

## Context

JPM-0007 kept this project read-only and set out the terms for any future tier 1 write:
a separately provisioned integration, a real workflow to justify it, and a typed tool
rather than the passthrough. It also said no such integration was planned.

A workflow has now arrived. A macOS major-update deferral was bypassed on a Mac whose
user is a local admin and ran the full installer, and the remedy is a Restricted
Software entry that kills the installer, scoped to the deferral's group. The operator
tried to make that change through the prior-art MCP server, and reading its code after
the attempt turned up four defects in its restricted-software builder:

1. **Scope hard-coded to every computer.** `<scope><all_computers>true</all_computers>`
   was emitted on every create and every update, and the tool schema had no scope
   parameter. A successful create would have applied the block to the entire fleet at
   once, including the one Mac the deferral group deliberately excludes so IT can still
   run installers.
2. **Update clobbered scope.** The same builder served updates, so editing any field of
   an entry silently reset its scope, including one set by hand in the Jamf UI, to All
   Computers.
3. **Update reset omitted fields.** Every field had a default, so a partial update
   rewrote the settings it didn't mention.
4. **Wrong XML shape.** The fields were emitted at the top level instead of under
   `<general>`, and the name went out as `display_name`, where the Classic schema calls
   it `name`. Jamf answered 409, and that 409 is the only reason defect 1 didn't reach
   production.

None of these would have been stopped by a `confirm: true` parameter or by host-side
approval of the call, because the arguments the operator approved were correct. The bug
was in what the tool did with them. That is the strongest available case for JPM-0007's
position: the set of possible mutations has to be readable in this repository, and the
tool must refuse to infer anything it was not told.

Two structural questions follow.

**Same server behind a flag, or a separate one?** JPM-0007 already rejected
`JAMF_READ_ONLY` as a boundary: it sits in the same environment as the credential, so
any deployment that has a write credential has, by definition, also cleared the flag. A
"writes enabled" mode in the existing server would register the write tools in every
session the global read server serves, which in practice means every session.

**Same repo, or a new one?** A new repo would duplicate the auth, URL building and
Classic envelope handling, and the 297 tests that pin down the gateway's quirks.

## Decision

**1. Reversible writes ship as a second MCP server built from this repository.**
`dist/write-server.js` (bin `jamf-platform-mcp-write`) registers only write tools and
nothing else: no passthrough, no read tools. `dist/index.js` registers no write tools
in any configuration. The split is in the code, not in configuration, and
`src/conventions.test.ts` asserts it against the source.

**2. Each server runs under its own Jamf integration.** The read server keeps a
read-only integration, so it cannot write regardless of what any code does, which is
the JPM-0001 guarantee left intact. The write server gets one Platform environment
integration of its own, named for its role rather than for Restricted Software,
because more resources are expected to follow. Its permissions track its tools
exactly: today `restricted-software:read`, `restricted-software:create` and
`restricted-software:update`, and nothing else. `restricted-software:delete` is not
granted. A new write tool adds the permissions it needs to this same integration, in
the same change as the ADR that introduces it, rather than prompting a new
integration per resource.

**3. The write server is registered per project, never globally.** It belongs in the
`.mcp.json` of the repository whose change log and pre-write export govern Jamf
changes, so its tools appear only in sessions that carry that discipline. A distinct
server name also lets the operator set a permission rule for
`mcp__jamf-platform-write__*` that is independent of the reads they approve freely.

**4. Restricted Software is the first and only resource.** It gets two tools,
`createRestrictedSoftware` and `updateRestrictedSoftware`, with these rules, each one a
direct answer to a defect above:

- **Scope is required on create, and nothing has a default.** `allComputers` must be
  stated, and every boolean in `general` must be stated. Nothing is applied that the
  caller did not write down.
- **Updates read, then merge.** The tool fetches the live entry, applies only the
  fields the caller passed, and sends the complete merged `general`. `<scope>` is
  omitted unless the caller supplied a new one, in which case the new one replaces the
  old in full. If the live scope holds anything this tool does not model, the scope
  update is refused rather than silently dropping it.
- **`dryRun` defaults to `true`.** A dry run performs the reads, returns the exact XML
  that would be sent and a field-by-field before/after diff, and writes nothing. It
  works on a read-only credential, so the change can be reviewed before the write
  credential is involved. This is friction, which JPM-0007 judged worth having within
  tier 1. It is not a boundary.
- **Every write is verified by reading it back.** The result reports any field where
  Jamf's stored state differs from what was sent, rather than assuming success from a
  2xx.
- **Every result carries a rollback.** For an update, it is the exact
  `updateRestrictedSoftware` arguments that restore the prior values. For a create, it
  is an update to an empty scope, which disables the entry without deleting it.
- **A non-exact process name has a minimum length.** With exact matching off, Jamf kills
  any process whose name contains the string, and can delete its executable. A short
  substring is a fleet-wide kill switch, so it is refused.

**5. Deletion stays in the Jamf UI.** A Restricted Software delete is not in
JPM-0007's tier 2 list, but nothing needs it: an entry with an empty scope does
nothing, and is a reversible "off" that this server can express. Granting
`restricted-software:delete` would give up reversibility to save a few clicks.

## Alternatives considered

### A `JAMF_ENABLE_WRITES` flag in the existing server

Rejected for the reason JPM-0007 rejected `JAMF_READ_ONLY` as a boundary. It would
also put write tools in every session that loads the read server, which is a global
registration, and give every unrelated conversation a tool that can kill processes on
the fleet.

### A separate repository for the write server

Rejected. Its whole value would be in the shared client: the gateway's path shapes,
Classic envelope quirks and token handling. Duplicating that means fixing every future
gateway change twice, and the boundary that matters is the credential, which a separate
repo does not strengthen.

### Keep using the prior-art server's write tools

Rejected for the four defects above.

### Make the change in the Jamf UI and keep this project read-only

Still the right answer for one-off changes, and still available. Rejected as the *only*
answer because Restricted Software entries in this workflow are time-boxed: they are
created when a deferral starts, re-scoped as groups change, and disabled when it ends.
A typed tool whose every call returns a diff and a rollback produces a better change
record than a UI click that has to be described by hand afterward.

## Consequences

### Positive

- Every mutation this project can make is enumerable by reading `src/write-server.ts`
  and `src/restricted-software.ts`, and only those two.
- The global read server keeps the JPM-0001 guarantee intact: its credential cannot
  express a write.
- A dry run gives the operator, and any change log, the exact payload before the
  write happens.

### Negative

- **The request body format is unverified.** The operation pages for create and update
  publish no request body at all. XML is sent because Classic writes have always taken
  XML, and because the GET advertises `application/xml`. The first live create is the
  verification, and it should target a deliberately empty scope.
- Two integrations to provision and rotate instead of one.
- `updateRestrictedSoftware` cannot re-scope an entry whose live scope uses user
  exclusions or limitations. It refuses, so the operator has to make that change in
  the UI.

### Neutral

- JPM-0007's status line is amended to point here. Its tier table, and its rule that
  writes never go through the passthrough, are unchanged and still govern.

## References

- [JPM-0001](JPM-0001-target-platform-api-gateway.md) — credential scoping as the
  boundary
- [JPM-0003](JPM-0003-passthrough-plus-selective-typed-tools.md) — typed tools when a
  workflow justifies one
- [JPM-0007](JPM-0007-write-path-posture.md) — the tiers, and the rule that writes
  never go through the passthrough
- `developer.jamf.com/platform-api/reference/createrestrictedsoftwarebyid-1`,
  `updaterestrictedsoftwarebyid-1`, `findrestrictedsoftwarebyid-1` — read 2026-10-06
