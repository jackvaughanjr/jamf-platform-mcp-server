# What this server can answer

Fifteen read tools over the Jamf Platform API Gateway, plus two write tools on a
separate server, organised by question. You rarely
know which endpoint you need when you start.

Two properties shape the rest of this page.

**It cannot change anything.** Every tool on this page is a read. `platformRequest`
offers no `method` or `body`, so the passthrough cannot express a mutation, and scopes
that could erase or unmanage a device are never granted to this server
([JPM-0007](../decisions/JPM-0007-write-path-posture.md)). The few writes this project
makes live in a separate server, covered at the end of this page.

**It reports what it did not check.** Several tools answer questions where a confident
"nothing found" is the dangerous answer, so coverage is a field: `strength`,
`notChecked`, `excludedFromThisAnswer`, `termsSwept`. Read those before acting on a
null result.

---

## Fleet: what do I have, and what is stale?

| Question | Tool |
|---|---|
| How is the fleet doing overall? | `getFleetOverview` |
| Which device is this serial / name / user? | `findDevices` |
| What is running an old OS? | `findOutdatedDevices` |

`getFleetOverview` fetches devices, groups and blueprints concurrently and summarises
them; a failing section degrades that section only. It reports
`deviceGroups.saturation` to flag when the largest-groups list is filled by catch-alls
holding the whole fleet, at which point the list has stopped telling you anything.

**Staleness is not `lastCheckInTime`.** That field is populated on macOS and null on
every mobile device, so ranking by it reports a third of a mixed fleet as never having
reported in. These tools take the freshest of `lastCheckInTime`, `lastContactTime` and
`lastInventoryUpdateTime`, and name which field supplied it.

## Groups: what is in it, what does it test, what depends on it?

| Question | Tool |
|---|---|
| Which groups exist matching…? | `findDeviceGroups` |
| Which devices are actually in this group? | `getDeviceGroupMembers` |
| What rules does this group apply? | `getComputerGroup` |
| Which groups depend on this one? | `findGroupDependencies` |

`getDeviceGroupMembers` exists because the members endpoint returns bare device UUIDs.
On its own it answers "how many" and never "which". It joins them against the device
list, and reports member ids with no matching device separately rather than dropping
them.

`getComputerGroup` renders criteria in evaluation order with parentheses and and/or
joins preserved, and flags criteria that will not do what they look like. The main one
is an unanchored `matches regex`: it tests whether a value *contains* a match rather
than equals one, which turns "has failures" into "is not blank". Members are opt-in,
since the rules are usually the question and the roster carries serials.

`findGroupDependencies` builds the dependency graph the Jamf UI cannot show: which
groups reference which others through `Computer Group` membership criteria, with cycle
detection, references to names no group has, and a blast radius giving everything that
transitively changes when one group's membership changes. A `not member of`
criterion is reported distinctly from `member of`, since conflating them inverts the
meaning.

It also reports `membershipCriterionScan`. Group dependencies are detected by matching a
criterion named `Computer Group`, so a Jamf build or locale that labels it differently
would produce an empty graph with nothing flagged. The scan catches that through the
*operator* instead: a criterion using `member of` under an unrecognised name is named, so
an empty graph reads as "could not tell" rather than "no dependencies". Nothing is ever
inferred into an edge from the operator alone.

## Deletion safety: what breaks if I remove this?

| Question | Tool |
|---|---|
| What references this package / group / script? | `findObjectReferences` |
| Is anything consuming this inventory field? | `findCriteriaReferences` |

Jamf has no built-in answer to the first. **Read `strength` before believing a null
result**: `'clear'` is reachable only when every source kind was supplied *and* every
object read had a parseable container. Anything less is `'partial-clear'`, and
`'unchecked'` means nothing was searched at all. Four of ten source kinds are wired
live today; the rest are declared unchecked with a reason, so most answers are
legitimately partial.

`findCriteriaReferences` answers "can I stop collecting this?", and sweeps an alias set
to do it, because Jamf's inventory-collection setting keys are not its criterion names.
`package_receipts` is queried as "Packages Installed" and "Cached Packages", sharing no
substring with the key, so searching the key alone returns zero whether or not
consumers exist. `termsSwept` and `aliasesUsed` show what was actually searched, and a
zero verdict says so explicitly when any term was an unverified broad substring.

## Cost: what is making inventory collection expensive?

| Question | Tool |
|---|---|
| What runs expensive commands, and how often? | `findExpensiveAutomations` |
| Which collection settings cost the most? | `getInventoryCollectionSettings` |

`findExpensiveAutomations` audits scripts, extension attributes and policies for
commands that burn CPU when repeated (`du`, unbounded `find /`, `mdfind`,
`system_profiler`), and reports which policies run them and how often. Extension
attributes are reported separately because they run at every inventory collection. A
bounded walk such as `find / -maxdepth 1` is not flagged; a deep or unbounded one is.

`getInventoryCollectionSettings` rates each option by cost per collection. A category
with custom search paths is escalated and reports the paths, because that rating is
inferred from the path count rather than measured. Three paths at small directories are
a false alarm; one pointing at a data volume is not.

## Declarative device management: did the Blueprint land?

| Question | Tool |
|---|---|
| What blueprints exist? | `listBlueprints` |
| Is this Mac's DDM healthy, and what is on it? | `getDeviceDeclarationState` |
| Which Macs did this declaration fail on, and why? | `getDeclarationScope` |

These two are inverses. Both lead with failures and flatten Jamf's nested `reasons`. A
status count answers "is this healthy" and never "why not", and `reasons` is the only
field carrying that. `getDeclarationScope` groups failures by cause, so one problem
affecting forty Macs reads as one problem.

**Neither can see `PENDING`.** Jamf requires a filter on these routes and applies
filters only to declarations already on the device, so anything still awaiting delivery
is invisible. A quiet result does not mean deployment finished, and
`excludedFromThisAnswer` says so in every response.

Two more traps. `INVALID` validity counts as a failure even beside a `SUCCESSFUL`
status, since a declaration can be delivered and still be invalid. And declarations
arrive as a triad (`CONFIGURATION` + `ACTIVATION` + `MANAGEMENT`), so a count of 9
means roughly 3 things configured.

## Everything else on the gateway

`platformRequest` reaches any route, including the Jamf Pro API's 300+ endpoints and
Classic's 500+. Use `style: 'classic'` for Classic: it builds `/proclassic/{resource}`
with no version segment. The tenant or environment travels in a header the client
adds, never in the path. It is GET-only.

## Restricted Software: block an app from running (write server)

`createRestrictedSoftware` and `updateRestrictedSoftware`, on the separate write server
([JPM-0008](../decisions/JPM-0008-reversible-writes-as-a-separate-server.md)), which
runs under its own integration and is registered per project.

- **Nothing defaults.** Scope, including `allComputers`, and every setting must be
  stated on create. A name that already exists is refused.
- **Dry run first.** Both tools default to `dryRun: true`, returning the exact XML and
  a field-by-field diff without writing.
- **Updates touch only what you pass.** Scope is left alone unless a complete
  replacement is given. A live scope using user exclusions or limitations, which the
  tool cannot represent, makes a scope change refuse rather than drop them.
- **Jamf's own rules are enforced:** `deleteExecutable` requires
  `matchExactProcessName`; substring matches under 6 characters are refused.
- **Every write is read back and checked**, and the result carries rollback
  arguments. To switch an entry off without deleting it, update its scope to
  `{"allComputers": false}`. Deletion is done in the Jamf UI.

Not yet confirmed by a live write: the XML request body, which Jamf's operation pages
do not publish.

---

## What it cannot do

- **Change anything from the read server.** No writes, by decision and by credential
  scope. The write server changes only Restricted Software, and never deletes.
- **See `PENDING` declarations**, or any device that has not reported at all.
- **Prove a negative on its own.** Every "nothing found" is bounded by what was
  checked; the tools say what that was.
- **Check Jamf's built-in dashboards, canned reports, or anything reading the API from
  outside Jamf.** A sync into an asset system is the realistic blind spot.
- **Reach Compliance Benchmarks.** The path is correct and the gateway returns 500
  `Upstream host lookup failed`, a fault on Jamf's side
  ([JPM-0006](../decisions/JPM-0006-classic-and-declaration-reporting-are-supported.md)).
- **Search script bodies or extension-attribute scripts for references to another
  script.** Both are readable but need substring matching, which produces false
  positives on any common word, so they are declared unchecked rather than guessed at.
- **Follow a group dependency whose criterion label this build does not know.** Detection
  keys on the name `Computer Group`; `membershipCriterionScan` reports the suspicion but
  will not guess an edge, and a relabelled criterion using a localised *operator* as well
  leaves no signal at all.
- **Answer mobile-device questions well.** `devices` and `device-groups` span macOS and
  iOS together, but the auditing tools are computer-oriented throughout.

## Verifying a claim on this page

Tool names and parameters here are taken from the server's own `tools/list` response,
not from source or memory:

```bash
scripts/jamf tools/list
```

Behaviour claims about the gateway itself live in
[`gateway-reference.md`](gateway-reference.md), which records what was observed against
a live tenant — including the claims that turned out to be wrong.
