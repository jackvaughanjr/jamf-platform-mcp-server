# JPM-0012: Create-only tools for scripts and policies, with policies always created disabled

- **Status:** Accepted
- **Date:** 2026-11-05
- **Extends:** [JPM-0008](JPM-0008-reversible-writes-as-a-separate-server.md), whose rules
  and single write integration govern these tools. Narrows backlog item 7: configuration
  profile and computer group creation stay open.

## Context

The write server can change a scope but cannot create anything. The operator's
configuration repository needs scripts and policies created with every descriptive field
filled in, and today they are clicked into the Jamf console and described by hand in a
change log afterwards. The case in hand is a migration script and a policy that runs it
and then an installer script, scoped to one Mac.

Three things set these objects apart from Restricted Software and the scope tools:

- **A script attached to an enabled, scoped policy runs as root.** Creating either object
  is inert only while the policy is disabled or unscoped. Enabling is the act that reaches
  Macs.
- **Values can be secrets.** A policy's script parameters are where vendor API keys and
  similar values are entered (a Workspace API key in `$4` is the motivating case), and a
  script body can carry one too. Anything a tool returns reaches the session transcript.
- **The two APIs differ.** Scripts have a Jamf Pro API create, `POST /pro/v1/scripts`, whose
  JSON body is published (`post_v1-scripts-1`). Policies have only Classic,
  `POST /proclassic/policies/id/0`, whose page (`createpolicybyid-1`) publishes no body and
  documents only `201 Created`, as Restricted Software's did.

JPM-0008's four defects in the prior art all came from a request builder that inferred
what it was not told. A policy document has thirteen sections; a builder that fills them
in is where that kind of mistake would hide.

An unmerged draft from 2026-10-15 proposed twelve tools across groups, scripts, policies and
profiles. This record takes only its two inert creates, changed where the operator's
workflow differs (a policy is created with its real scope and scripts, not empty).

## Decision

**1. Two tools join the write server: `createScript` and `createPolicy`.** Create only. No
update, enable, rename or delete tool for either resource, and nothing through the
passthrough. Implemented in `src/create-script.ts` and `src/create-policy.ts`, with the
value-hiding helpers in `src/secret-material.ts`.

**2. No defaults, no inference, strict schemas.** Every field either is stated by the caller
or is a fixed value documented here. Unknown fields are rejected, not dropped.

- `createScript` takes `name`, `categoryId` (`-1` for none), `priority` (`BEFORE`, `AFTER`,
  `AT_REBOOT`), `info`, `notes`, all eight `parameterLabels` (`parameter4` to
  `parameter11`, `""` for unused), `osRequirements` and `scriptContents`, and sends exactly
  those as the published `Script` JSON, `categoryId` as a string. Contents must start with
  `#!` and contain no carriage return and no NUL; nothing is repaired.
- `createPolicy` takes `general` (name, category id, all five trigger booleans and the
  custom event, frequency, and retry event, attempts and notify flag), `scope`, an ordered
  `scripts` list (id, `Before` or `After`, and all eight parameters, `""` for none),
  `maintenance.recon`, and `selfService`. Fixed values: `enabled` false, `all_computers`
  false, buildings and departments empty, and every maintenance option other than `recon`
  false. Retry is accepted only as Jamf offers it: event `none` with attempts `-1`, or
  attempts 1 to 10 with frequency "Once per computer". With `useForSelfService` true, the
  display name, description and the main-page and force-description flags are required.
- **Not sent** by `createPolicy`, and left to Jamf: date/time and network limitations,
  network requirements, site, packages, printers, dock items, account maintenance, restart
  options, files and processes, user interaction, disk encryption, and the Self Service
  icon, categories, button texts and notifications. `trigger_logout` is not sent either:
  the live GET does not return it. What Jamf stores for these is checked on read-back
  (decision 5).
- **Packages are rejected.** The input names `packages` only to refuse it, because the
  Classic write shape of `package_configuration` is unverified and a wrong package action
  installs or removes software. Packages are added in the console.

**3. Policies are always created disabled, with an explicit scope.** There is no `enabled`
input; the schema refuses one. Scope is lists of computer ids and computer group ids, with
optional exclusions of the same two kinds; nothing else is modelled. `all_computers` is
never sent true. An empty scope is refused unless `emptyScopeIntended: true` is passed, and
that flag with targets is refused too. A target both included and excluded, and a duplicate
id, are refused. Enabling a created policy is a separate act, in the Jamf console, so the
review of what a policy does and the decision to let it run are two steps.

**4. Hidden values are shown as SHA-256 and length, everywhere.** Script contents and every
policy script-parameter value never appear as text in a dry run, a result, an error or a log
line. The policy dry run returns the exact XML with each non-empty parameter value replaced
by `[sha256:… length:…]`, built by the same function as the real body, so nothing else can
differ. A failed write is rethrown as a plain error whose response body has every hidden
value, in raw, XML-escaped and JSON-escaped form, and every script line of eight characters
or more, replaced, with tags stripped and length capped. Script parameter labels, names and
every other field are not secret and are shown.

**5. Every create is verified by reading it back.** `createScript` reads
`GET /pro/v1/scripts/{id}` and compares every field sent, the contents by hash.
`createPolicy` reads `GET /proclassic/policies/id/{id}` and compares every field sent
(parameters by hash, scripts in order), confirms `enabled` false and no scope member it did
not send, and checks the sections it did not send against the inert values observed on every
policy in a production tenant (no restart, no command, no packages, no accounts, no disk
encryption, no limitations). Any difference is a mismatch and the result says
`verified: false`; a stored text value is reported by digest. Before writing, both tools
refuse a name that already exists (case-insensitive, though Jamf allows duplicate policy
names), and check the category, every script id and every computer group id. Computer ids
are not checked, because that needs a computer read permission this integration should not
hold; the read-back shows what Jamf stored.

**6. Rollback is manual, because delete is not granted.** A created policy stays disabled:
the result gives `removeComputerGroupFromPolicyScope` dry-run calls for its group targets,
names its direct computer targets (removable only in the console), and says to delete it in
the console. A created script does nothing until a policy runs it: remove it from every
policy that uses it (`findObjectReferences` on the read server), then delete it in the
console.

**7. Permissions.** `createScript` needs `scripts:create`, `scripts:read` and
`categories:read`. `createPolicy` needs `policies:create` and `policies:read` (already
held), `scripts:read`, `device-groups:read` (already held) and `categories:read`. So the
write integration gains `scripts:create`, `scripts:read` and `categories:read`.
`policies:create` stops being held-but-unused (JPM-0009). No `:delete`, no `scripts:update`.
Each name was read on the operation pages `post_v1-scripts-1`, `get_v1-scripts-id-1`,
`findscripts-1`, `findcategoriesbyid-1`, `createpolicybyid-1`, `findpolicies-1` and
`findpoliciesbyid-1` on 2026-11-05.

## Alternatives considered

### Create policies with an empty scope, and scope them with the scope tools

The 2026-10-15 draft's choice. Rejected for this workflow: the scope tools add computer
groups only, so a policy for one Mac could not be scoped by this server at all, and
"disabled" already makes the create inert. The empty-scope create stays available through
`emptyScopeIntended`.

### An `enabled` parameter, false by default

Rejected. A default is what JPM-0008 removed, and an agent that can pass `true` can enable
a root script on every Mac in scope in the same call that creates it. Enabling stays a
separate, human act.

### Classic for scripts, for one write format

Rejected. The Jamf Pro API publishes the script body and returns structured errors; writing
Classic XML blind where a documented route exists buys nothing.

### Support packages now

Rejected for this change. The workflow has none, the write shape is unverified, and an
`action` of Install, Cache or Install Cached is not something to guess.

### Show parameter values in the dry run, since the caller passed them

Rejected. The caller's arguments are already in the session, but every echo is another copy
in a transcript, a change-log draft or a pasted summary. Hashes let a reviewer confirm a
value they hold without spreading it.

### Accept a file path for script contents

Considered, so a script body would not pass through the session. Rejected for now: it gives
the server a local file read on the caller's say-so. The contents arrive as a string and
leave only as a hash.

## Consequences

### Positive

- A script and the policy that runs it become two reviewed calls, each with an exact request,
  a read-back and a rollback, instead of console clicks described afterwards.
- No create can enable a policy, scope it to every Mac, or attach a package.
- No hidden value is returned or logged by these tools.

### Negative

- **The policy request body is unverified.** The page publishes none. XML shaped like the GET
  schema is sent, as for Restricted Software (BACKLOG item 1); the first live create settles
  it. Specifically unverified: that Jamf accepts `<category><id>` alone, `<retry_event>`
  spellings other than `none`, the `<size>` element in `<scripts>`, and `-1` as "no category"
  for a script.
- **The read-back parsers are unverified against a newly created object.** The policy
  parser and the inert-value table come from exports of existing policies; a fresh policy
  could store a different default, which would show as a mismatch, not pass silently.
- **A value passed to these tools is in the session.** Hashing keeps it out of results and
  logs, not out of the tool call's own arguments. A real secret should be left empty at
  create and entered in the console. A hash of a low-entropy value can be guessed.
- **Permissions are broader than the tools.** `scripts:create` with `policies:create` and
  `policies:update` is, in effect, the ability to run root code on any managed Mac; the
  disabled-on-create rule is code, not credential. JPM-0007's tier 2 is unchanged: no erase
  or unmanage scope.
- The integration gains three permissions.

### Neutral

- `src/conventions.test.ts` lists nine write tools, sweeps the new modules for `DELETE` and
  `PATCH`, keeps them out of the read server, and asserts the policy builder can emit only
  `<enabled>false</enabled>` and `<all_computers>false</all_computers>`.

## References

- [JPM-0007](JPM-0007-write-path-posture.md), [JPM-0008](JPM-0008-reversible-writes-as-a-separate-server.md),
  [JPM-0009](JPM-0009-computer-group-scope-membership-tools.md)
- `developer.jamf.com/platform-api/reference/post_v1-scripts-1`, `get_v1-scripts-id-1`,
  `findscripts-1`, `findcategoriesbyid-1`, `createpolicybyid-1`, `findpolicies-1`,
  `findpoliciesbyid-1`: read 2026-11-05
- `docs/gateway-reference.md`, "Script and policy creates"
