# JPM-0007: The write path is a credential decision, and this server never gets erase

- **Status:** Accepted
- **Date:** 2026-08-05

## Context

Publishing the repository changes the threat model without changing a line of code.

Today the project cannot write. The development integration holds read scopes only,
so `POST`, `PUT`, `PATCH` and `DELETE` fail at the gateway regardless of what this
server does — which is the guarantee
[JPM-0001](JPM-0001-target-platform-api-gateway.md) was built to obtain. The
`device-actions` segment (`erase`, `restart`, `shutdown`, `unmanage`, `check-in`) is
hosted and has never been called, precisely because calling it would mean granting
`execute:pro:device-actions`.

A public repository invites the other configuration. Nothing in the code, the README
or the tooling stops a reader from provisioning a read-write integration, setting
`JAMF_READ_ONLY=false`, and pointing this server at their tenant. At that moment:

- `platformRequest` accepts `method: 'DELETE'` alongside an arbitrary `rawPath` and
  `body` (`src/index.ts:125`). The model composes the verb, the path and the payload.
- The only remaining gate is `src/platform-client.ts:212`, a single `method !== 'GET'`
  check — defeated by the same environment variable the deployment already had to
  set in order to get there.
- Nothing logs the attempt, nothing distinguishes `unmanage` from `buildings`, and no
  human is asked.

That is a **weaker** posture than the prior art JPM-0001 criticised. A `confirm: true`
parameter is a poor control, but this project currently has less than one: once the
credential can write, there is no per-call gate at all. JPM-0001's argument was never
"application gates are unnecessary" — it was "credential scoping is a stronger
boundary than application logic." Its corollary went unrecorded: **that boundary
exists only while the credential lacks the scope.** Grant
`execute:pro:device-actions` and the project's entire safety story evaporates, leaving
behind code that was designed on the assumption it would never need one.

Host-side tool approval does not fill the gap. An MCP client prompting before each
call is a property of that client's configuration, not of this server, and clients
commonly offer a mode that auto-approves everything. A control the operator can switch
off in a settings pane is not a control for `erase`.

## Decision

Three answers, to the three questions.

**1. No read-write integration is provisioned, and none is planned.** Read-only is not
this project's current phase; it is its supported configuration. Enabling writes is a
separate deployment decision made by a person with tenant authority, not a feature to
be unlocked.

**2. This server never holds a credential that can destroy a device or its management
state.** Not gated — not granted. Scopes are sorted by consequence rather than by HTTP
verb:

| tier | examples | scope posture |
|---|---|---|
| **0 — read** | everything the 10 current tools do | the only tier this project's documented deployment receives |
| **1 — reversible write** | create or update a policy, group or extension attribute; trigger an inventory update | permitted only under a separately provisioned integration, only when a real workflow justifies it, and only through a typed tool |
| **2 — destructive** | `device-actions` (`erase`, `unmanage`, `shutdown`); any `DELETE` of a policy, profile or group | **never granted to this server, in any configuration** |

Tier 2 work happens in Jamf Pro's own interface, where the action is attributed to a
named person, carries Jamf's own confirmation, and lands in Jamf's audit log. A machine
identity wiping a laptop on a model's initiative is not a workflow this project intends
to make convenient, and the record of who did it is worth more than the automation.

**3. If tier 1 is ever enabled, the gate is a typed tool — never the passthrough.**
`platformRequest` must refuse non-`GET` unconditionally, independently of
`JAMF_READ_ONLY`. A passthrough write is unreviewable: method, path and body are all
model-composed, so there is nothing for a schema to constrain or for a reader to check.
Every write must be a named tool with a narrow input schema, so that the set of
possible mutations is enumerable by reading `src/index.ts`.

`JAMF_READ_ONLY` keeps its current semantics — on unless the value is the literal
string `false`, so a typo fails closed — and keeps its current billing as a backstop
rather than the guarantee.

## Alternatives considered

### Gate destructive calls behind a `confirm: true` parameter

The prior art's approach, and what a reviewer will expect to find. Rejected as the
control for tier 2. A parameter the caller supplies is satisfied by the caller
supplying it: the model that decided to erase the device also fills in the flag. It
raises the cost of an accident slightly and the cost of a persuaded model not at all.
Adopting it as the boundary would also re-site safety in application logic, which is
the decision JPM-0001 explicitly rejected.

Worth having within tier 1 as friction. Not worth mistaking for a boundary.

### Require MCP elicitation / human-in-the-loop confirmation before a destructive call

Genuinely stronger than a parameter, because the approval originates outside the
model's context. Rejected as insufficient alone: elicitation is an optional client
capability and unevenly implemented, a client may decline to prompt, and the fallback
when one cannot elicit is either to fail closed — so the tool never works — or to
proceed, so the gate is decorative. Revisit if a deployment ever needs tier 1
interactively, as a supplement to a narrow typed tool and never as a substitute for
withholding the scope.

### Provision a read-write integration and rely on `JAMF_READ_ONLY`

Rejected. The flag lives in the same `.env` as the credential, so anyone able to supply
the credential can clear the flag — and a write deployment has cleared it by
definition. It defends against a typo, not against a decision.

### Say nothing and let each operator decide

Tempting, since the code cannot write today and every deployment is somebody else's
tenant. Rejected because the repository's *shape* is itself an argument: a passthrough
advertising 500+ Classic endpoints and accepting `DELETE`, shipped with no stated
position on writes, reads as an invitation. An unstated posture becomes whatever the
first fork assumes it was.

## Consequences

### Positive

- "What stops this from erasing a Mac?" has an answer that does not depend on any code
  being correct: the credential cannot express the request.
- The tier table gives a fork something to disagree with explicitly, rather than a
  silence to fill in.
- Withholding tier 2 costs nothing today. No workflow in the project needs it, and
  `device-actions` went unverified for exactly this reason.

### Negative

- `device-actions` stays permanently unverified, so its path shape and payloads remain
  documentation rather than observation. Its segment already differs from its
  documented group name (`device-actions`, not `device-management-actions`) — precisely
  the class of discrepancy only a live call settles. Accepted.
- Removing non-`GET` from `platformRequest` removes the escape hatch that would let a
  tier 1 write happen without first writing a tool. That is the intent, and it means
  tier 1 always costs a code change.
- The stance is unenforceable off this machine. Nothing prevents a fork from granting
  every scope; this record buys a documented position and a safe default, not a
  guarantee about anyone else's deployment.

### Neutral

- No code changes accompany this record, because no credential can write today. The
  `platformRequest` narrowing in part 3 is a follow-up to land before any write scope
  is ever granted; until then the permissive schema is the reminder that it is owed.
- `README.md` and `CONTRIBUTING.md` need a short operator-facing statement of this
  posture. This record is the reasoning, not the instruction.

## References

- [JPM-0001](JPM-0001-target-platform-api-gateway.md) — credential scoping as the
  safety boundary; this record supplies the corollary it left implicit
- [JPM-0003](JPM-0003-passthrough-plus-selective-typed-tools.md) — why a passthrough
  exists, including the note that it is safe only because scopes bound it
- `src/platform-client.ts` — the `JAMF_READ_ONLY` backstop, and the two `fetch` call
  sites (token acquisition and `request`), so every tenant-bound call passes the check
- `docs/gateway-reference.md` — `device-actions` recorded as hosted, all-write,
  deliberately unverified
