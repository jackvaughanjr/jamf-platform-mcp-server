# JPM-0013: The write server's whole reversible surface, and its complete permission set, decided once

- **Status:** Proposed. The operator decided all seven open questions (see "Operator
  decisions"). It becomes Accepted when the PR carrying it merges.
- **Date:** 2026-11-05 (amended 2026-11-06)
- **Supersedes, in part:** [JPM-0008](JPM-0008-reversible-writes-as-a-separate-server.md)
  (part 2's last two sentences and part 4's first sentence),
  [JPM-0009](JPM-0009-computer-group-scope-membership-tools.md) (the permission and
  held-but-unused paragraphs of its Decision), and
  [JPM-0012](JPM-0012-create-script-and-policy-tools.md) (decisions 1 and 3, and the
  "no `scripts:update`" clause of decision 7). Exactly what is superseded, and what
  stands, is in "What this supersedes".

## Context

Each write the server gained so far came from a separate need, and each paid for it
separately: an ADR, a permission change in the Jamf console, and a wait.
[JPM-0008](JPM-0008-reversible-writes-as-a-separate-server.md) shipped Restricted
Software and said it was "the first and only resource". [JPM-0009](JPM-0009-computer-group-scope-membership-tools.md)
and [JPM-0010](JPM-0010-scope-membership-batch-tool.md) added computer group scope
changes on profiles and policies. [JPM-0012](JPM-0012-create-script-and-policy-tools.md)
(PR #19, unmerged) adds `createScript` and `createPolicy` and says in terms that there is
no update tool and that enabling a policy is a console act.

On 2026-11-05 the operator migrated a third-party agent across the fleet in Jamf. The work, all of it in the
console because the write server could do almost none of it:

- one script edited four times;
- policies created, enabled and disabled;
- computers and groups added to and removed from policy scope, as targets and as
  exclusions;
- smart groups created;
- one computer extension attribute edited and then disabled;
- a clean-up the next night, also all in the console: about fourteen objects deleted
  across policies, scripts, packages, groups, extension attributes and a profile, plus a
  patch title, an advanced search and two scopes edited.

The server covers one of those verbs (creating a script and a policy, once PR #19 merges)
and the group-level scope changes. It cannot update a script, enable or disable a policy,
touch a computer target or an exclusion, create or edit a smart group, or edit an
extension attribute. Every one of those was a console edit with no diff and no rollback,
described by hand in the change log afterwards. That is exactly the workflow JPM-0008 gave
as its reason for existing, and it will recur: the same object types, the same verbs.

Going object by object is the wrong shape. A permission set is decided against what the
server is allowed to do, not against the next request, and the operator has already
granted `:create` on three resources "so a create can be built later without
re-provisioning" (JPM-0009). The honest comparison is between a fixed, reviewed ceiling
and a ceiling that moves every time a session needs something.

What does not change is the reason for caution. Every defect JPM-0008 found in the prior
art came from a request builder that inferred what it was not told, and none of them would
have been stopped by approving the call. The tools stay narrow and typed for the same
reason. And one fact about the permission set is worth stating plainly before the
decision: `scripts:update`, `policies:update` and `extension-attributes:update`, with
`policies:create`, together let a caller run code as root on managed Macs. A policy runs
its scripts as root; an extension attribute script runs as root on **every** managed Mac at
its next inventory, scope not applying. JPM-0012 already accepted this for create. This
record extends it to update, and says where the control actually lies: in the code's
refusals and in the operator's approval of each live write, not in the credential.

## Decision

**1. The write server's complete intended surface is the tool list in this record, and
its complete permission set is the list in decision 8. Both are decided here, once.** Building a
tool on the list needs no new ADR and no new permission. Adding a tool that is not on the
list needs a new record, **even where its permission is already granted** (decision 8,
"Granted ahead of any tool"). The exclusions in decision 6 cannot be added by any record
short of one that supersedes this one.

Object types in scope: scripts, policies, computer groups (smart and static),
configuration profiles (macOS), computer extension attributes, packages (metadata and
policy attachment), Restricted Software, categories, and, as a bonus because it is nearly
free, advanced computer searches. For each, the operations are create, update, enable or
disable where the type has it, and scope changes. **There is no delete** (decision 5).

### 2. The tools

Phases refer to the build plan (`docs/BACKLOG.md` carries it once this is accepted).
Tools marked "existing" are on main or in PR #19 and are unchanged except where noted.

| Object type | Tool | Operation | Phase |
|---|---|---|---|
| Scripts | `createScript` | create (PR #19) | 0 |
| | `updateScript` | update any field including the script body | 1 |
| Policies | `createPolicy` | create, disabled, with explicit scope (PR #19) | 0 |
| | `setPolicyEnabled` | enable or disable; enabling needs a plan hash | 1 |
| | `updatePolicy` | update `general`, `scripts`, `selfService`, `maintenance.recon`, `packages` as separate optional sections | 2 (packages: 3) |
| Scope, all scoped types | `applyScopeChanges` | add or remove a computer or a computer group, as a target or an exclusion, on a policy, a configuration profile or a Restricted Software entry; the JPM-0010 plan-hash engine, generalised | 1 (profile and policy), 2 (Restricted Software) |
| | the four single scope tools and `applyScopeMembershipBatch` | existing, unchanged, kept (see decision 4) | n/a |
| Computer groups | `createSmartComputerGroup`, `updateSmartComputerGroup` | create; update name, description, criteria | 1 |
| | `createStaticComputerGroup`, `updateStaticComputerGroupMembership` | create; add or remove computers | 2 |
| Extension attributes | `createComputerExtensionAttribute`, `updateComputerExtensionAttribute` | create (a script type is created disabled); update any field including the script body | 1 |
| | `setComputerExtensionAttributeEnabled` | enable or disable a script type; enabling needs a plan hash; disabling always retains collected data | 1 |
| Categories | `createCategory`, `updateCategory` | create; rename or change priority | 2 |
| Restricted Software | `createRestrictedSoftware`, `updateRestrictedSoftware` | existing (JPM-0008). There is no enabled flag: an empty scope is "off" | n/a |
| Packages | `createPackage`, `updatePackage` | create or update the package **record** (metadata). No binary upload | 3 |
| Advanced searches | `createAdvancedComputerSearch`, `updateAdvancedComputerSearch` | create; update name, criteria, display fields | 3 |
| Configuration profiles | `createConfigurationProfile` | create, empty scope, allowlisted payload types only | 4 |
| | `updateConfigurationProfile` | update general fields and the payload (allowlisted types only); plan hash required | 4 |

Twenty-eight tools in all: the nine on main or in PR #19 and nineteen new ones. The exact
list is asserted in `src/conventions.test.ts`, which grows phase by phase.

Notes on specific cells:

- **Enable and disable exist only where Jamf has the concept.** A policy has `enabled`. A
  script-type extension attribute has `enabled`. A configuration profile has none: it is
  live when it has a scope and a distribution method, so a profile is created with an empty
  scope and scoped with `applyScopeChanges`, and "disabled" means empty scope. Restricted
  Software has none either, which is why JPM-0008 made an empty scope "off". Groups,
  scripts, categories, packages and searches have none.
- **Scope changes are one engine.** The JPM-0010 batch (operations grouped by object, one
  scope-only PUT per object, a plan hash binding the live run to the reviewed dry run,
  stop on first failure, an inverse batch as the rollback) becomes `applyScopeChanges`. Its
  operation gains two stated fields, `member` (`computerGroup` or `computer`) and `list`
  (`include` or `exclude`), and its `kind` gains `restrictedSoftware`. Nothing defaults.
  Every refusal in JPM-0009 stands: All Computers is refused, unmodelled scope members are
  refused, a profile's `redeploy_on_update` must be exactly "Newly Assigned", an add of a
  member already present and a remove of one that is not are refused. The group-only tools
  call the same engine, so there is one implementation, not two.
- **`updatePolicy` is sections, not one blob.** `general` (name, category, triggers,
  frequency, retry), `scripts` (the ordered list with every parameter stated), `selfService`,
  `maintenance.recon`. A call names the sections it changes and the tool sends only those
  (decision 3). `enabled` is not an input: `setPolicyEnabled` is the only way to change it.
  `scope` is not an input: `applyScopeChanges` is.
- **Packages: metadata and attachment only, and why.** The Jamf Pro API publishes
  `POST /v1/packages` and `PUT /v1/packages/{id}` as JSON, and a separate
  `POST /v1/packages/{id}/upload` as `multipart/form-data` with a `file` part. A tool could
  call it. This record decides it will not: the file would have to come from a local path
  the caller names (the same local-file read JPM-0012 rejected for script bodies), or travel
  as a base64 string through the model's context, and a package is an installer that runs as
  root. Packages reach Jamf through Jamf Admin, the console, or the cloud distribution point,
  attributed to a person. `createPackage` writes the record for a file that is already there
  or about to be uploaded by hand, `updatePackage` edits its metadata, and
  `updatePolicy`'s `packages` section attaches a package to a policy with an explicit
  `action` from `Install`, `Cache` or `Install Cached` and nothing else. The Classic write
  shape of `package_configuration` is unverified (JPM-0012 refused packages for that reason),
  so the `packages` section ships last and behind its own live confirmation.
- **Advanced searches are in because they are nearly free.** A saved search reads
  inventory; it changes no Mac. It shares the criteria model with smart groups, which Phase 1
  builds anyway.
- **`allComputers` is never sent as true by any tool in this record.** See decision 6.

### 3. How updates avoid JPM-0008's defects

JPM-0008's builder clobbered fields it was not told about. Two ways to avoid that were
weighed: full replacement from caller-supplied values, and read-modify-write with an
explicit list of changes. **Every update tool uses read-modify-write**, in one of two forms
depending on what the API does with a PUT.

- **Jamf Pro API JSON resources** (scripts, extension attributes, smart groups, categories,
  packages, and the other types on `/pro`) replace the whole object on PUT. The tool reads
  the live object, parses it into a **complete typed model that fails closed**: a live field
  the model does not know is a refusal that names the field, never a field dropped. It
  applies the caller's `changes`, sends the complete merged object, reads it back and
  compares every field.
- **Classic XML resources** (policies, configuration profiles, Restricted Software, static
  groups, advanced searches) accept a partial root: JPM-0009's canary on 2026-11-05 showed
  a PUT whose only child is `<scope>` is accepted and leaves everything else untouched. The
  tool sends only the sections it changes, each rebuilt from the live section plus the
  caller's changes, and **fingerprints every section it did not send** before and after
  (the JPM-0009 mechanism, including JPM-0011's semantic comparison for profile payloads).
  A live section holding anything the tool does not model is refused, not re-emitted.
  Whether a Classic PUT of a few elements inside `general` leaves its siblings alone is not
  known, and Phase 1 settles it live before anything depends on it (see Consequences). If it
  does not, `general` is sent complete, rebuilt from the live GET, and the tool refuses any
  policy whose `general` it cannot model whole.

Rules common to every update tool:

- `changes` is a strict object of optional fields. At least one must be present, `null` is
  not a value, and a field equal to its live value is reported and, if it is all of them,
  the call writes nothing. Unknown fields are rejected.
- Fields the tool cannot change are not in the schema, so they cannot be named: `enabled`
  on a policy, `scope` on a policy, profile or Restricted Software entry, `manageExistingData`
  other than retain on an extension attribute.
- **A plan hash is required on a live call** wherever the write can change what runs on
  Macs: enabling a policy or extension attribute, changing a script or extension attribute
  body, changing a policy's scripts or packages, changing smart-group criteria, changing a
  profile payload, and every `applyScopeChanges`. It is JPM-0010's mechanism: the dry run
  returns SHA-256 over the canonical operation and the live state it read; the live run
  recomputes and refuses if anything differs. Metadata edits, disabling, and creates do not
  need one.
- Every result carries a rollback. Where the rollback needs prior text the tool never
  returned (a script body, a profile payload), it gives the prior SHA-256 and length, and the
  rollback is "re-apply the version whose hash matches from the pre-write export in
  the governing repo" (JPM-0008 part 3).

### 4. Guardrails that every tool keeps

These hold for all 19 new tools, as for the existing ones and PR #19. Each is a
`conventions.test.ts` assertion or a named test where it can be.

- **Typed tools only.** `platformRequest` stays GET-only (JPM-0007 part 3). No passthrough
  write, no tool that takes a path, a method or a body.
- **Strict schemas, no defaults, no inference.** Every field is stated or fixed by this
  record; unknown fields are rejected, not dropped.
- **`dryRun` defaults to true.** It performs the reads, returns the exact request with
  hidden values shown as digests, and writes nothing. It works under a read-only credential.
- **Read back after every write and compare.** A 2xx is not success. The result says
  `verified: true` or lists mismatches, with stored text values reported by digest.
- **Hidden values are SHA-256 and length, never text:** script bodies, extension attribute
  script bodies, profile payloads, and script parameter values, in dry runs, results, errors
  and log lines. A failed write is rethrown as a sanitised error (PR #19's
  `sanitizedWriteError`). Names, labels and other descriptive fields are shown. A test for
  each tool feeds a marker string through every hidden field and asserts it appears nowhere
  in the output, the error or stderr.
- **A policy or a script extension attribute is created disabled, and enabling is a
  separate explicit call** (`setPolicyEnabled`, `setComputerExtensionAttributeEnabled`),
  with a plan hash. A review of what a thing does and the decision to let it run stay two
  steps. Disabling needs neither flag nor hash.
- **Disabling an extension attribute never deletes data.** Jamf's `manageExistingData` is
  `RETAIN` or `DELETE` when a script type is disabled. The schema has no such field and the
  tool always sends `RETAIN`. `DELETE` is a deletion by another route and is excluded as one.
- **Counts and sizes are bounded** as in JPM-0010 (a batch of at most 150 operations), and a
  policy's script list at 20.
- **The write server registers no read tool and the read server no write tool**
  (JPM-0008 part 1, unchanged). The conventions test also sweeps every write module for
  `DELETE` and `PATCH` and, new in this record, for the paths in decision 6.

### 5. No delete, anywhere

**There are no delete tools and no `:delete` permission on the integration.** This applies
to every object type above and to `delete-multiple` and by-name delete routes, which carry
the same permissions. Decommissioning stays a console action. The migration's clean-up was
done in the console, each delete checked first with the read server's `findObjectReferences`
and `findCriteriaReferences`. That check found a reference the written plan had missed: two
packages attached to a patch title. That is the kind of dependency decision 5 wants a person
to see.

Why:

- **Everything on the list has a reversible "off" that the tools can express,** which is the
  argument JPM-0008 made for Restricted Software and still holds. A policy disabled and
  emptied does nothing. A script-type extension attribute disabled with `RETAIN` stops
  collecting and keeps its data. A profile with an empty scope is on no Mac. A Restricted
  Software entry with an empty scope blocks nothing. A script nothing references is inert.
  The only thing a delete adds is tidiness.
- **A delete cannot be rolled back by this server,** and several are not rollbacks by
  anyone: a deleted extension attribute loses its collected values, a deleted policy loses
  its execution log, and a deleted profile removes the profile from every Mac it was on.
- **Deletes cascade through references.** Deleting a group, a category, an extension
  attribute or a script changes what every object that names it does, or fails 409/422
  depending on type. The read server's `findObjectReferences` and `findGroupDependencies`
  exist to check that before a console delete; the console shows the dependency prompts
  and attributes the action to a named person in Jamf's own audit log (JPM-0007).
- **Reversibility is the whole basis for granting this much.** With delete the write
  integration could remove a profile fleet-wide or a smart group out from under compliance
  scope. Without it, every tool's worst case is "put it back", and the credential does not
  need to be trusted to do otherwise.

What would have to be true to revisit, all of it:

1. Jamf offers a restorable delete (a trash with restore, or a documented export and
   re-import round trip), or this repository can snapshot an object before deleting it in a
   form its own create tool restores byte-for-byte.
2. A delete cannot run against an object with any reference: the check is in the tool and
   fails closed, not left to the operator.
3. The permission can be limited to a subset of objects (a prefix, a site, or a type), so
   that it cannot touch the compliance baseline.
4. Deletion is two-step: disable, wait a stated period, then delete, with a plan hash.
5. The console clean-ups have become frequent enough, in the change log's own count, that
   their cost outweighs the above.

Until then this record is the answer to "why can't it delete".

### 6. Permanently excluded: console only, never built

These are not deferred. No tool will be built for them, no permission for them will be
granted to the write integration or to the read integration, and a test sweeps the source
for the routes.

- **Device-destructive and device-control commands:** erase and wipe, lock, unmanage and
  remove the MDM profile, restart and shutdown, check-in and every other `device-actions`
  route, remote command execution and MDM command queuing of any kind (including "deploy
  package using MDM"), managed software update plans that push installs. Permissions never
  held: `device-actions:execute`, `destructive-device-actions:execute`,
  `change-password:execute`, and any `*:execute`.
- **Activation Lock and recovery material:** bypass codes, recovery keys, recovery lock and
  FileVault key retrieval or rotation, LAPS and local admin password retrieval or rotation.
- **Anything that shows a secret in plaintext:** no tool reads or returns a credential, a
  payload secret, a script embedded secret or a key; hidden values are digests (decision 4).
  The read server's redaction covers what it returns; this server never needs to return it.
- **All Computers as a scope.** No tool in this record sends `all_computers: true`, and none
  offers a flag to. A deliberate "everything" is a console decision, attributed to a person;
  the one place it would be wanted (a baseline) is also the one place it does the most
  damage. **The one existing exception is `createRestrictedSoftware` and
  `updateRestrictedSoftware`, whose scope input accepts `allComputers: true` (JPM-0008).**
  Phase 2 tightens both to refuse it. That changes how existing tools behave, and the
  operator decided it (decision 3 under "Operator decisions").
- **Deleting**, per decision 5.

Tier 2 in JPM-0007 is unchanged and this list is its fuller statement.

**The read integration is bound by these exclusions too.** A Platform integration can be
created holding every read permission in the catalogue, which includes Device secrets (device
lock PIN, Recovery lock password, FileVault recovery key, LAPS). The read server registers no
secret-fetching tool, but its `platformRequest` passthrough issues arbitrary GETs, so under
such a grant a GET on those endpoints would succeed. **Neither integration holds** any of the
following, read or otherwise:

- Device secrets: device lock PIN, Recovery lock password, FileVault recovery key, LAPS.
- Enrollment invitations (the codes are enrollment credentials).
- Device actions: Execute or Delete.
- Webhooks, any verb (a webhook can send every tenant event to an outside URL, and reading
  one can expose its auth headers).
- Log flushing (it deletes Jamf's logs, which are audit evidence).
- Credential and certificate-trust rows: JSON web token configuration, GSX, SMTP, the AD
  Certificate Services connector, DigiCert Trust Lifecycle Manager.
- Writes to the server or the licence: Tomcat, Cache, Software update servers,
  Infrastructure Manager, Activation code, M2M tenant ID.
- Allowed file upload extensions, and the inventory custom file path.
- AI policies.

The read server's passthrough is why this matters more there than on the write server. A
typed tool can't reach an endpoint it wasn't built for, but a passthrough GET reaches
anything the credential allows. **The credential is the read server's only boundary for
secrets,** and the governing repo logs it like any other Jamf change. The
startup check in decision 8 applies to both servers: if the token response lists scopes, the read server refuses to
start when any Device secrets, Enrollment invitations or Webhooks scope is present, or any
scope other than read, and the write server refuses to start when any `:delete` or
`:execute` is present.

### 7. Configuration profiles: payloads and secrets

Profiles are the hardest type on the list because the thing being written is a payload, and
payloads hold secrets and run on every Mac in scope. The decision:

- **No raw XML, and no signed profile.** The tool takes a structured JSON description of
  each payload and renders the plist itself. A caller cannot supply a plist, a `<data>` blob
  or a signed profile, so the tool never writes a byte it did not construct. A signed profile
  also cannot be edited, so Jamf rejects it anyway.
- **An allowlist of payload types, in code.** Each entry is a payload type with a strict
  schema: its keys, their types, and their legal values. The first allowlist covers types
  that carry configuration and no credentials: Custom Settings (a preference domain with
  scalar, array and dictionary values), Privacy Preferences Policy Control, Login Items,
  Software Update, Restrictions, Dock, Notifications, and Gatekeeper and security
  preferences. Types that hold or reference secrets or certificates are **not** on it:
  Wi-Fi, VPN, SCEP, certificates and PKCS#12, Exchange and mail accounts, directory binding,
  single sign-on and Kerberos extensions with registration tokens, FileVault escrow, MDM
  payloads. Those stay console edits. Adding a type means a pull request that extends the
  allowlist and its tests, reviewed as code; it does not need an ADR, and it cannot add a
  type with a `<data>` field.
- **Secrets inside an allowed payload are refused, not scrubbed.** Input is rejected if any
  key at any depth matches the secret key-name list (the list in the read server's
  redaction work, aligned to one module once it merges), if any value is binary, or if a
  string value looks like a credential. A refusal names the key path, never the value.
- **Review shows structure, not values.** A dry run lists payload types, key paths and
  value types, with the SHA-256 and length of the canonical plist, and never a value, not even
  booleans or enumerations (operator decision 2). The cost is that a reviewer can't see what a
  setting is set to. To check one, read the profile in the console or in the governing repo's
  export after the write.
- **Update uses the allowlist too.** The live payload must parse and fully fit the allowlist,
  or the update is refused, because a payload the tool cannot model whole cannot be rebuilt
  without dropping something. The payload comparison is JPM-0011's semantic comparison, so
  Jamf's identifier regeneration is not a false failure.
- **Redeployment.** `redeploy_on_update` must be exactly "Newly Assigned" as in JPM-0009; the
  tool never changes it. Whether a changed payload reaches Macs that already hold the profile
  under that setting is not documented. The update therefore requires a plan hash, shows the
  live scope and the live `redeploy_on_update` in the dry run, and ships with a live canary on
  a throwaway profile before any real one.

### 8. The permission set

One Platform environment integration, the existing write integration (JPM-0008 part 2). It
holds the **27 core permissions** below, which the tools in decision 2 use, plus the **20
granted ahead of any tool** listed after them, and **no others**. Every one was granted by
the operator in the Jamf Platform console and logged in the governing repo's change log.
Names are as published on the operation pages and the `llms.txt` index, read 2026-11-05.
"Page" means the operation page was read in full for that verb; "index" means the verb
appears in the group's index with that permission string and the page was not separately
read. "Live" means the permission has been exercised on the tenant.

**Core: used by this record's tools (all held)**

| Resource | `:read` | `:create` | `:update` | Used by | Source |
|---|---|---|---|---|---|
| `restricted-software` | held | held | held | existing tools | page, live |
| `configuration-profiles` | held | held (unused until Phase 4) | held | scope tools; profile tools | page (update, create), live (read, update) |
| `policies` | held | held | held | policy tools | page (update), live (read, update); create: page, not yet live |
| `scripts` | held | held | held | script tools, policy checks | page (update, `put_v1-scripts-id-1`; create), not yet live |
| `device-groups` | held | held | held | group tools; scope tools | page (Classic update, v3 smart and static), read live |
| `extension-attributes` | held | held | held | EA tools | page (Pro update, Classic update), not yet live |
| `categories` | held | held | held | category tools; checks | page (Pro create and update), read in PR #19 |
| `packages` | held | held | held | package tools | page (Pro create, update, upload), not yet live |
| `advanced-device-searches` | held | held | held | search tools | index (Classic create, update), page (update) |

That is nine resources by three verbs, 27 permissions.

**Granted ahead of any tool (no tool in this record uses them)**

The operator granted these in the same console session so that later tools would not need
another permission change. They are listed here by their console row names. Their permission
strings have not been checked against the operation pages.

| Console section | Row | Granted | Possible future use |
|---|---|---|---|
| App lifecycle | Patch policies | read, create, update | patch policy tools |
| App lifecycle | Patch titles | read, create, update | patch title definitions and package links |
| App lifecycle | Apps | read, create, update | Jamf App Installers |
| App lifecycle | App package information | read | |
| App lifecycle | Internal patch sources | read | |
| Inventory | Advanced user searches | read, create, update | |
| Inventory | User extension attributes | read, create, update | |
| Inventory | User groups | read, create, update | |

That is 20 permissions. **Holding a permission is not permission to build a tool.** No tool may use these until a new
record adds it (decision 1). Until then they are credential headroom, and the boundary is the
code and the conventions test, as for the core permissions a phase has not yet built. A tool
for patch titles or patch policies would change what Macs install, so it would need the same
plan-hash and created-disabled rules as policies.

Notes:

- **Not granted, by decision:** every `:delete` (decision 5), every `*:execute` and the
  Deploy column (decision 6), and Devices, Users and Device history read (`devices:read` and
  the rest). The Jamf Pro API's computer inventory list needs `devices:read`. It is not needed:
  computer ids in a scope are checked by read-back, as JPM-0012 decided, and `devices:read`
  would put every serial and username in reach of a write server. Personal data stays with the
  read server (operator decision 4). Also not granted, in the console's own sections: Compliance (benchmarks
  deploy whole compliance baselines), Device actions, Device secrets, Enrollment, Secure enterprise
  access, Infrastructure, Global settings; in Deployment, directory bindings, Jamf Protect and
  Jamf Connect deployment, software updates, blueprints and disk encryption; in App lifecycle,
  external patch sources (a supply-chain risk), volume purchasing, licensed software,
  provisioning profiles and eBooks; in Organizational context, everything except categories.
  Printers and Dock items were offered as optional and not granted.
- **Unconfirmed:** whether `device-groups:update` is also what Jamf asks for on the smart
  group recalculate endpoint (`post_v1-smart-computer-groups-id-recalculate-1`); the index
  says it is. No tool in this record calls recalculate, so it is noted, not relied on.
- **`device-groups:update` and `device-groups:create` have been held and unused** since
  JPM-0009. They are used from Phase 1.
- **Grant is an operator console action.** The integration's permissions change in the Jamf
  account's integrations page, by the operator, and the change is logged in the governing repo's
  change log like any Jamf change. The client secret is unaffected and never passes
  through a session.
- **Granted once, before Phase 1,** but a phase's tools remain unbuilt
  until their PR. Until a tool exists, its permission is credential headroom with no code to
  use it; the code, not the credential, is the boundary for those verbs, as JPM-0009 said of
  the permissions it held unused, and the conventions test is what holds it.
- **The granted set is re-read at each review.** The Platform integration's permissions are
  not in the governing repo's export, and its audit trail is not readable from a session. So
  the only record of what the integration holds is the change-log entries, and drift shows up
  only when someone looks at the console. The operator re-reads both integrations' permission
  screens against this decision when any record changes the surface, and whenever either
  integration's grant is reviewed.
- **A startup check is worth trying and unverified.** If the gateway's token response lists
  granted scopes, each server refuses to start on a scope it must not hold (decision 6 gives
  both lists). Whether the token response carries that is unknown; Phase 0's live step finds
  out.

### 9. Registration and governance, unchanged

- **Per project, the governing repo only** (JPM-0008 part 3). The write server's tools appear
  only in sessions that carry that repository's change-log and pre-write-export discipline,
  so every write runs under it. A different project does not register it.
- **The read server stays write-free** and keeps its read-only integration, now bound by the
  exclusions at the end of decision 6.
- **The harness approval stays.** A live call is a prompt, and with a plan hash the prompt is
  for a reviewed plan, not for a call (JPM-0010). This record does not move approval into the
  server and does not rely on it as the boundary.

## Operator decisions (2026-11-06)

The draft put seven questions to the operator, who accepted the recommendation on each:

1. **The credential can express "run code as root on Macs"** through `scripts:update`,
   `policies:create`/`:update` and `extension-attributes:update`. **Accepted.** Policy create
   alone already allows it (JPM-0012). The controls are: registration in the governing repo only,
   dry run first, the plan hash, policies and script EAs created disabled, and every write
   logged. A separate integration for that capability was not chosen.
2. **Profile dry runs stay structure-only:** key paths, types and hashes, with no booleans
   or enumeration values (decision 7).
3. **The Restricted Software tools stop accepting `allComputers: true`** in Phase 2, matching
   every other tool (decision 6).
4. **No `devices:read` on the write integration,** so computer ids are not checked before a
   write. The read-back catches a wrong id (decision 8).
5. **`updatePolicy`'s `packages` section allows `Install`,** as well as `Cache` and
   `Install Cached`. Policies are created disabled and enabling needs a plan hash (decision 2).
6. **The first profile allowlist** is the one in decision 7: Custom Settings, PPPC, Login
   Items, Software Update, Restrictions, Dock, Notifications, Gatekeeper and security
   preferences.
7. **The live check for the extension attribute tools stops at creating one disabled.** It
   never enables one, because an enabled script EA runs on every managed Mac at its next
   inventory, and scope doesn't apply.

## What this supersedes

Part by part, so a reader of the older records knows what to ignore:

- **JPM-0008 part 2, final two sentences.** "Its permissions track its tools exactly: today
  `restricted-software:read`, `:create` and `:update`, and nothing else" and "A new write tool
  adds the permissions it needs to this same integration, in the same change as the ADR that
  introduces it, rather than prompting a new integration per resource." Replaced by decision
  8: the permission set is the fixed 27 in advance. The rest of part 2 stands: a second server,
  its own credential, named for its role, `restricted-software:delete` not granted.
- **JPM-0008 part 4, first sentence.** "Restricted Software is the first and only resource."
  Replaced by decision 1. The rest of part 4 (the Restricted Software tools and each rule in
  its list) stands, except `allComputers: true`, addressed in decision 6. Parts 1, 3 and 5 of
  JPM-0008 stand, and part 5 (deletion stays in the console) is extended to every type here.
- **JPM-0009, the permission paragraphs of its Decision.** The enumeration of five permissions
  it adds, and the paragraph beginning "The integration also holds `:create`…", including its
  sentence that no tool may POST until "a new ADR adds a typed tool for it". This record is
  that ADR for the types on the list. Every rule and tool in JPM-0009 stands, including its
  refusal list and the canary.
- **JPM-0010.** Nothing is superseded. Its engine becomes `applyScopeChanges` (decision 2) and
  its tool stays.
- **JPM-0012 decision 1** ("no update, enable, rename or delete tool for either resource"),
  **decision 3's last sentence** ("Enabling a created policy is a separate act, in the Jamf
  console"), and **decision 7's "No `scripts:update`"**. Replaced by `updateScript`,
  `setPolicyEnabled` and `updatePolicy`. The rest of JPM-0012 stands: no defaults, policies
  created disabled with an explicit scope, hidden values as digests, packages rejected by
  `createPolicy` (until `updatePolicy` carries them, Phase 3), read-back with the inert-value
  table, manual rollback. Its test that "has no update or enable path" is replaced.
- **JPM-0007** is unchanged: its tier table, part 2 and part 3 stand. This record is the
  workflow evidence JPM-0007 asked for before any tier 1 write beyond the first.
- **BACKLOG item 7** ("Add typed create tools for profiles, policies and computer groups") is
  absorbed here and closed by Phases 1, 2 and 4.

## Alternatives considered

### Keep deciding one resource at a time

Rejected. It is what this record replaces, and the evidence is the migration: five object
types, ten verbs, one ADR and a permission change each.

### Grant the permissions and let each tool arrive without an ADR

Rejected as stated, accepted in part. A tool inside this record needs no new ADR because this
record is the review; a tool outside it does, and the conventions test fails until it is
listed.

### Allow delete behind a plan hash

Rejected. A plan hash binds a run to a reviewed plan; it does nothing for a delete that cannot
be undone. The conditions in decision 5 are the ones under which that would change.

### Send full replacements from the caller

Rejected. The caller would have to hold the live object, and a stale copy overwrites anything
changed since. It is JPM-0009's rejected alternative, for the same reason.

### Accept raw plist XML for profiles

Rejected. A reviewer cannot read a payload from a hash, and a model can put anything in a
plist, including a certificate, a token or a payload type that does something the allowlist
would never permit. Structured input, rendered by the tool, is what makes "the set of
possible mutations enumerable" true for profiles.

### Support package binary upload

Rejected for the reasons in decision 2. It would also need a local-file read or a large
base64 string through the model, for something that runs as root.

### Permit `allComputers: true` behind an explicit flag

Rejected. JPM-0007 judged a flag in the caller's hands friction and not a boundary; for a
setting whose misuse is the whole fleet, friction is not enough, and the cost of the
exclusion is one console click on the rare occasion it is wanted.

### Split the write server by object type, each with its own credential

Considered, because scripts-plus-policies is the dangerous pair. Rejected for now: two to
nine integrations to provision and rotate, and the pair is dangerous together and would need
to be in one server to be useful. The operator accepted one integration holding the
root-execution capability (operator decision 1).

## Consequences

### Positive

- The migration's verbs become reviewed calls with a diff, a read-back and a rollback,
  rather than console edits described afterwards.
- The permission question is answered once. A session that needs a listed tool does not
  trigger a console change or an ADR.
- "What can this server do" has a single, bounded, testable answer, and "what can it never
  do" has one too.

### Negative

- **The credential is broader than any single tool needs on the day it is granted.** With
  `scripts:update`, `policies:update`, `policies:create` and `extension-attributes:update`,
  the integration can express "run this as root on these Macs". The refusals that keep that
  inert are code: disabled on create, plan hash on enable and on a script change, no
  All Computers, no delete. JPM-0007 tier 2 and the exclusions in decision 6 are the only
  things the credential itself withholds. That is accepted, and the operator should accept it
  knowingly.
- **An extension attribute script is fleet-wide when enabled,** and scope does not apply to
  it. `setComputerExtensionAttributeEnabled` cannot make it narrower; it can only make the
  enable a reviewed, hashed, separate call.
- **The updates are unverified live.** Specifically: that a Classic PUT of a few elements in
  `general` leaves its siblings alone; that Jamf accepts the whole-object Pro JSON PUT for
  each type (including the `categoryId` string form); the Classic body for
  `computer_additions` and `computer_deletions`; the `package_configuration` write shape;
  `manageExistingData` `RETAIN` behaviour; and the profile payload redeployment under "Newly
  Assigned". Each phase has a live confirmation step, and none of this is presented as
  verified.
- **The tool count rises from nine to twenty-eight,** and the surface to review rises with it.
  Phasing it into four more pull requests is how that stays reviewable.
- **Computer ids in scope are not checked before a write,** as in JPM-0012. A wrong id is
  caught by the read-back, not before.
- **Profile payload review is by structure.** The cost of never showing a value.
- **An allowlist is maintenance.** A payload type the operator needs that is not on it is a
  console edit until a pull request adds it.

### Neutral

- JPM-0008, JPM-0009 and JPM-0012 are left unedited apart from a `Status:` pointer where CI
  permits one. JPM-0012 is not on main, so it can be edited in the PR that carries it.
- The permission grants are logged in the governing repo's change log.
- Backlog item 4 (check the write server's tool list on the wire in CI) becomes more valuable
  with 28 tools.

## References

- [JPM-0001](JPM-0001-target-platform-api-gateway.md), [JPM-0003](JPM-0003-passthrough-plus-selective-typed-tools.md),
  [JPM-0007](JPM-0007-write-path-posture.md), [JPM-0008](JPM-0008-reversible-writes-as-a-separate-server.md),
  [JPM-0009](JPM-0009-computer-group-scope-membership-tools.md),
  [JPM-0010](JPM-0010-scope-membership-batch-tool.md),
  [JPM-0011](JPM-0011-accept-jamf-payload-identifier-normalization.md),
  [JPM-0012](JPM-0012-create-script-and-policy-tools.md)
- `developer.jamf.com/platform-api/reference/` pages read 2026-11-05:
  `put_v1-scripts-id-1`, `post_v1-packages-1`, `put_v1-packages-id-1`,
  `post_v1-packages-id-upload-1`, `put_v1-categories-id-1`, `post_v1-categories-1`,
  `put_v1-computer-extension-attributes-id-1`, `post_v1-computer-extension-attributes-1`,
  `updatecomputerextensionattributebyid-1`, `put_v3-computer-groups-smart-groups-id-1`,
  `post_v3-computer-groups-smart-groups-1`, `put_v3-computer-groups-static-groups-id-1`,
  `updatecomputergroupbyid-1`, `updatepolicybyid-1`, `updaterestrictedsoftwarebyid-1`,
  `updateosxconfigurationprofilebyid-1`, `createosxconfigurationprofilebyid-1`,
  `updateadvancedcomputersearchbyid-1`; and the full `reference/llms.txt` index for every
  other permission string.
- `docs/gateway-reference.md`, "Scope-membership writes" and "Script and policy creates"
