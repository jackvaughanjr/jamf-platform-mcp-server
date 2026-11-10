# JPM-0017: `flushPolicyLogs`, one exception to "no delete", held by a route guard

- **Status:** Accepted (operator decision 2026-11-10). Takes effect when the PR carrying it
  merges.
- **Date:** 2026-11-10
- **Supersedes, in part:** [JPM-0013](JPM-0013-write-surface-and-permissions.md), by exception
  and only as stated in "What this supersedes": decision 5 (no delete) for the policy-log
  flush; decision 6's "Log flushing" and "any `*:execute`" exclusions, for the write
  integration and the one permission `flush-policy-logs:execute`; decision 4's sweep for the
  `DELETE` verb; decision 1's tool list and decision 8's permission set, each by one entry.
  Everything else in JPM-0013 stands, including that no tool deletes any object.
- **Numbering:** JPM-0015 and JPM-0016 are held by records on unmerged branches.

## Context

A rollout that changes the package in a "Once per computer" policy has to flush that policy's
log, or the Macs that already ran it never run it again. It is often staged: one test Mac
first, then the rest. Today that flush is a console action, and the governing repo's change log
records it afterwards with only a bounded time, because Jamf's API offers no history read for a
log flush.

JPM-0013 excluded it twice. Decision 5 says there is no delete anywhere, and decision 6 lists
"Log flushing (it deletes Jamf's logs, which are audit evidence)" among the rows neither
integration may hold, and "any `*:execute`" among the permissions never held.

On 2026-11-10 the operator decided: "While I agree that you shouldn't have destructive actions,
flushing a log is not that to me. Let's go ahead and add that permission." This record carries
that decision out and sets its boundary. Decision 1 of JPM-0013 says a tool off its list, and an
exclusion of decision 6, need a record that supersedes it; this is that record, for this one
tool.

### What Jamf publishes (operation pages read 2026-11-10, not yet called live)

Classic `logflush` group, all under `https://{region}.api.jamfcloud.com/proclassic`, each
requiring **`flush-policy-logs:execute`**:

| Operation page | Method and path | What it flushes |
|---|---|---|
| `logflush-2` | `DELETE /logflush`, body `application/xml`, schema `logflush` | one policy's log, for the computers listed in the body |
| `createlogflushwithidandinterval-1` | `DELETE /logflush/{log}/id/{id}/interval/{interval}` | one policy's log, every computer |
| `createlogflushforinterval-1` | `DELETE /logflush/{log}/interval/{interval}` | **every** policy's log, every computer |

- `{log}` is an enum with one value, `policy`. The path pages' own example text says
  `logflush/policies/...`; the enum is followed.
- The body schema is `{ log: "policy", log_id: integer, interval: enum, computers: { computer:
  { id: integer } } }`, with `log`, `log_id` and `interval` required and `computers` optional.
  It has no mobile devices.
- `interval` is one of 20 values: `Zero`, `One`, `Two`, `Three` or `Six`, then `Days`, `Weeks`,
  `Months` or `Years` (as published, so "One Days"). The path pages give the form
  `Three+Months`.
- Each page documents only `200 OK`.

So **per-computer flushing is supported**, by the XML body only. Every-computer flushing of one
policy has its own path. Nothing in the Jamf Pro API flushes one policy's log: its
`/v1/log-flushing` routes are the tenant-wide retention settings and tasks, under a different
permission (`retention-policy:{r,u}`).

**The permission.** Jamf's permissions map lists the console row "Log flushing" as
`flush-policy-logs:{x}`, owning Classic `/logflush` and nothing else. It also says "`/logflush`
takes `flush-policy-logs:{x}` **or** `policies:{d}`", because Jamf Pro enforced both. That is the
trap: `policies:delete` would authorise the flush **and** `DELETE /policies/id/{id}` for every
policy in the tenant.

**Reading the result.** A computer's policy log is computer history:
`GET /proclassic/computerhistory/id/{id}/subset/PolicyLogs`, whose `policy_log` items carry
`policy_id`, `status` and the date. It needs `device-history:read`, which JPM-0013 decision 8
keeps off the write integration. The read server reaches it through `platformRequest` when its
own integration holds `device-history:read`.

## Decision

**1. One new tool, `flushPolicyLogs`, in `src/write-server.ts`, implemented in
`src/flush-policy-logs.ts`.** Its input is a strict object; nothing defaults:

```
{ policyId: positive integer,
  computers: { computerIds: [1 to 100 distinct positive integers] }
           | { allComputers: true },
  interval: one of the 20 published values,
  dryRun?: boolean (default true),
  planHash?: string (required when dryRun is false) }
```

`allComputers` accepts only `true`; `false`, an empty list, both forms at once, or neither is a
schema error. Listed computers send `DELETE /proclassic/logflush` with the body
`<logflush><log>policy</log><log_id>N</log_id><interval>…</interval><computers><computer><id>N</id></computer>…</computers></logflush>`.
All computers send `DELETE /proclassic/logflush/policy/id/{id}/interval/{interval}`, no body.
The all-policies route is never built.

**2. The route guard: the write server sends DELETE to those two shapes and nowhere else.**
`src/write-route-guard.ts` defines `WriteRouteGuardClient`, the gateway client with a check in
front of every request, and `src/write-server.ts` constructs it instead of the plain client. The
check runs before a token is fetched or anything is sent:

- GET, POST and PUT pass, as before; their routes are fixed in each tool's code.
- DELETE passes only for service `proclassic`, style `classic`, no `rawPath`, no query, and
  either resource `logflush` with an XML body matching exactly the shape above (log `policy`, a
  positive `log_id`, a published interval, at least one computer) or resource
  `logflush/policy/id/{positive id}/interval/{published interval with +}` with no body.
- Every other DELETE is refused: any object (policy, script, group, profile, package, Restricted
  Software, by id or by name), the all-policies flush, the Jamf Pro API's log-flushing tasks.
  Every other method is refused.

This is the same mechanism JPM-0013 decision 6 relies on, a fixed list held in code and swept by
`src/conventions.test.ts`, moved from a source sweep alone to a runtime check as well, because
the verb now has to exist in the write path. The conventions test asserts: the write server is
built on the guarded client; the `DELETE` verb appears only in the flush module and the guard;
the flush module's two DELETE requests are both in its one request builder and both name a
`logflush` route; and the all-policies route is not in it. Unit tests drive the guard with a
policy, script, group, profile and package delete, the all-policies flush, malformed bodies, a
`rawPath`, another service and another method, and confirm a refused request never reaches
`fetch`.

**3. The permission is `flush-policy-logs:execute`, added to the write integration, and never
`policies:delete`.** The operator grants it in the Jamf console and the governing repo logs it.

- **What it unlocks beyond this tool:** flushing any policy's log, for any computers or all of
  them, including the all-policies route. The guard refuses the all-policies route; the rest is
  what the tool does, under a plan hash. It unlocks no object delete and no read.
- **`policies:delete` is never granted,** to either integration. It would also reach `/logflush`,
  but it authorises deleting every policy. If it were ever granted by mistake, the guard would
  still refuse every policy delete from this server, but the credential would then allow it to any
  other caller holding the secret. The operator's grant is checked against this sentence.
- **The read integration still never holds** `flush-policy-logs:execute` or any other non-read
  permission (JPM-0013 decision 6). Its passthrough is GET-only, so it could not use it.
- Any future startup check (JPM-0013 decision 8) refuses every `:execute` on the write server's
  token except this one.

**4. The tool keeps every write rule it can, and says plainly where it cannot.**

- **Dry run by default.** It reads the policy (`policies:read`) and shows its name, enabled
  state, frequency and scope counts, the exact request (method, path, body), warnings, the
  read-server calls that list the policy's entries for the named Macs, and a `planHash`.
- **Plan hash on the live call,** as JPM-0013 decision 3 requires wherever a write can change what
  runs on Macs: a flush lets a policy run again. The hash covers the policy id, the computers, the
  interval and a fingerprint of the whole policy as read; a live call re-reads it and refuses on
  any difference.
- **A rejected request is not a flush.** A non-2xx answer is an error that says "NOT flushed",
  and nothing is read back (JPM-0014 decision 4). A request with no HTTP response is reported as
  possibly applied.
- **Read-back, honestly bounded.** After a 2xx the tool reads the policy back and reports whether
  it still exists and is unchanged; that catches a request that reached the wrong route. It cannot
  read the log itself, so **it never reports the flush as verified** (`flushVerified: false`) and
  returns the read-server `platformRequest` calls that confirm it: no `policy_log` with that
  `policy_id` left on each listed Mac. For `allComputers` there is no list of which Macs had
  entries, so the check is a sample.
- **Warnings, not refusals,** for: a frequency other than "Once per computer", a disabled policy,
  an enabled one (the named Macs will run it again at their next trigger), an interval other than
  "Zero Days" (newer entries survive), `allComputers`, and unchecked computer ids (no device read,
  as JPM-0014 decision 6).
- **Rollback: none, and the result says so.** A flush cannot be undone. What follows from it is
  that a policy limited by frequency may run again on those Macs, if enabled and in scope. To stop
  that, disable the policy or take the Macs out of its scope (`applyScopeChanges`); neither
  restores the entries.
- **The result carries `writtenAt`,** the only exact time of the flush this server can give, for
  the change log.

## What this supersedes

- **JPM-0013 decision 5, "No delete, anywhere".** Amended by exception: HTTP DELETE is sent to the
  two policy-log flush shapes in decision 1, and to nothing else. "There are no delete tools" and
  "no `:delete` permission on the integration" stand: no tool deletes an object, and no `:delete`
  is granted. The conditions in decision 5 for revisiting object deletes are unchanged.
- **JPM-0013 decision 6.** The bullet "Log flushing (it deletes Jamf's logs, which are audit
  evidence)" no longer applies to the **write** integration; it still applies to the read
  integration. "Any `*:execute`" and "Permissions never held ... any `*:execute`" gain one
  exception, `flush-policy-logs:execute` on the write integration. Every other exclusion stands,
  including `device-actions:execute` and `destructive-device-actions:execute`.
- **JPM-0013 decision 4,** the sweep "for `DELETE` and `PATCH`": `PATCH` is still swept from every
  write module; `DELETE` is swept from every write module except the flush module and the guard,
  which are bound by the narrower assertions in decision 2.
- **JPM-0013 decision 1 and decision 8.** The tool list gains `flushPolicyLogs`, and the
  permission set gains `flush-policy-logs:execute` (27 core, 20 granted ahead, and this one).
- On the audit-evidence reason in decision 6: the operator's judgement is that a policy's
  execution log is operational state, not the evidence that matters. What changes for the
  evidence: each flush made through this tool is a reviewed call with an exact time, logged in the
  governing repo, where today's console flush is logged after the fact with a bounded time.

## Alternatives considered

### Grant `policies:delete`, the other permission Jamf accepts on `/logflush`

Rejected. It authorises deleting every policy. The guard would stop this server sending one, but
the credential is the boundary for anything else that holds it, and JPM-0013 decision 5's reasons
for withholding object deletes all stand.

### Use the XML body for all computers too, by leaving out `<computers>`

Rejected. The schema makes `computers` optional but does not say what its absence means; the
one-policy path says it in its name. A body with no computers is refused by the guard, so a
mistake in the listed case cannot widen into every computer.

### Grant `device-history:read` to the write integration so the tool can verify the flush itself

Not taken. JPM-0013 operator decision 4 keeps device and user data with the read server. That
needs its own operator decision; this record does not change it. The read server can confirm the
flush, and the tool says so instead of claiming it.

### Refuse a policy whose frequency is not "Once per computer"

Rejected. Flushing an "Once per user per computer" or "Once every day" policy can be deliberate,
and the operator decides that per call. It is a warning in the dry run.

## Consequences

### Positive

- A staged re-run (one Mac, then the rest) is two reviewed calls with exact times, not console
  clicks logged afterwards with bounded times.
- The guard makes "no object delete" a runtime property of the write server, not only a property
  of the source, and covers every existing tool as well as this one.

### Negative

- **The credential can flush any policy's log, including every policy's at once.** The guard
  refuses the all-policies route; only the code holds that.
- **The flush is not verified by the tool.** Confirmation needs the read server and a person to
  run it.
- **Unverified live:** that the gateway passes a DELETE with a body; that Jamf accepts the body
  element `log`, which is taken from the published schema and nowhere else; whether Jamf honours `<computers>` or flushes more than listed if it does not; the `+`
  spelling of the interval in the path; the success status; what `Zero Days` flushes exactly; and
  whether a flush changes the policy object as read. The first live call settles these, on a Mac
  and policy where flushing every computer's entry would also be acceptable.
- Computer ids are not checked before the flush, as for scope changes (JPM-0014 decision 6).

### Neutral

- `src/conventions.test.ts` holds JPM-0015 and JPM-0016 as reserved numbers, so this record can
  land before them.
- JPM-0013 is not edited; `decisions/README.md` notes the amendment against it.

## References

- [JPM-0007](JPM-0007-write-path-posture.md), [JPM-0008](JPM-0008-reversible-writes-as-a-separate-server.md),
  [JPM-0013](JPM-0013-write-surface-and-permissions.md),
  [JPM-0014](JPM-0014-computers-and-exclusions-in-scope-changes.md)
- `developer.jamf.com/platform-api/reference/` pages read 2026-11-10: `logflush-2`,
  `createlogflushwithidandinterval-1`, `createlogflushforinterval-1`, `deletepolicybyid-1`,
  `findcomputerhistorybyidsubset-1`, `jamf-pro-permissions-map`, and the `reference/llms.txt`
  index (the `logflush` and `log-flushing` groups).
- `docs/gateway-reference.md`, "Policy log flush"
