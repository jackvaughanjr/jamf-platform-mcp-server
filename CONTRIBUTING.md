# Contributing

This document is a contract. It separates what is **mechanically enforced** — a
guard will stop you — from what is **expected** and reviewed by a human. Nothing
here relies on you remembering it.

## Setup

```bash
npm install                  # also points core.hooksPath at .githooks
cp .env.op.example .env.op   # edit to match your 1Password vault/item
npm run build
```

`npm install` is what installs the git hooks. If you skip it and commit anyway, CI
will catch what the hooks would have.

A Jamf Platform API Gateway integration (Jamf Account → Integrations) is needed to
run anything against a live tenant. **A read-only integration is sufficient and
strongly preferred** — the gateway's scopes are the safety boundary, not this code
([JPM-0001](decisions/JPM-0001-target-platform-api-gateway.md)).

**Adding a write tool is not an ordinary contribution.** JPM-0007 decided that no
read-write integration is provisioned and none is planned — read-only is this
project's supported configuration, not a phase to graduate from. Reversing that
decision needs a superseding ADR, the same as correcting any other committed
decision; a PR that adds a write-capable tool without one is changing what this
project decided against
([JPM-0007](decisions/JPM-0007-write-path-posture.md)).

```bash
scripts/jamf tools/list          # works from any directory
scripts/jamf getFleetOverview
```

## Enforced: three rules a guard will stop you breaking

### 1. No live identifiers in tracked files

No tenant ids, device ids, serials, usernames, group names or hostnames — **including
in test fixtures**, which is where the one real leak in this repo's history came
from: a genuine device UUID copied out of live output because it looked realistic.

Test UUIDs must use a reserved synthetic prefix so a real one stands out:

```
deadbeef-0000-4000-8000-000000000001    ✅
00000000-0000-0000-0000-000000000000    ✅
8dce9404-4779-49cc-825b-428ac74eddc9    ❌ indistinguishable from real
```

Enforced by `scripts/check-no-identifiers.sh` in the pre-commit hook (staged files)
and in CI (all files). For site-specific strings, create a gitignored
`.identifier-patterns.local` with one `grep -E` pattern per line — deliberately not
committed, because a guard that enumerates what must not leak, leaks it.

### 2. No captured API responses committed

Raw gateway responses are a fleet inventory. Only **type-only shapes** under
`fixtures/shapes/` are committed — every scalar replaced by its type name, keys kept
because keys are the schema. `scripts/discover-gateway.sh` produces both and writes
raw output to gitignored `fixtures/raw/`
([JPM-0004](decisions/JPM-0004-type-only-fixtures.md)).

**Never `git add -f`.** The pre-commit hook rejects any staged file that
`.gitignore` covers. If something ignored genuinely belongs in git, change
`.gitignore` in its own commit so the decision is reviewable.

### 3. Committed ADRs are immutable

Correct a decision by **superseding** it with a new record, never by editing the old
one. A wrong ADR left standing is bad; a wrong ADR silently rewritten is worse,
because the reasoning that produced it disappears.

Enforced by `scripts/check-adr-immutability.sh` locally and a base-branch diff in CI.
Two sanctioned exceptions, both via `ADR_ALLOW_EDIT=1 git commit`: adding a
superseded-by pointer, and editing a record that has no external readers yet.

## Enforced: conventions checked by tests

`src/conventions.test.ts` asserts what drifted repeatedly during early development:

- the README test-count badge matches the number of tests actually defined
- ADR numbering is sequential with no gaps, and every record is indexed in
  `decisions/README.md`
- every superseded record names its successor
- the README does not cite a superseded ADR as current guidance
- `.gitignore` still covers `fixtures/raw/` and `.env`, and the hook still wires both
  guards

If you add tests, the badge must be updated — the test will tell you the number.

## Expected: how to add support for an endpoint

**Read the endpoint's own reference page on `developer.jamf.com` before writing
anything.** Each operation page publishes its exact base URL and path. Skipping that
and probing candidates instead led this project to declare three API groups
unreachable when their paths were published the whole time
([JPM-0006](decisions/JPM-0006-classic-and-declaration-reporting-are-supported.md)).
The slugs in a group's `llms.txt` are URLs.

Then verify it live. A documented path is not a working path here — the
documentation has been wrong about path shape more than once. Add a probe to
`scripts/discover-gateway.sh` and run it.

Read [`docs/gateway-reference.md`](docs/gateway-reference.md) first for the traps:
per-resource versions, Classic's plural-key JSON, the status-code semantics where a
403 means a wrong route rather than a permission problem.

Prefer extending `platformRequest` usage over adding a typed tool until a real
workflow justifies one
([JPM-0003](decisions/JPM-0003-passthrough-plus-selective-typed-tools.md)).

## Expected: how to write it

**Pure logic goes in a module with no client and no clock**, like `src/fleet.ts` and
`src/automations.ts` — injected `now`, no I/O — so it is testable without a tenant
and deterministic.

**Tests must fail when the logic is wrong**, not merely run. Break your own code
deliberately and confirm a test catches it; several bugs here were caught that way
and one was missed because the fixtures encoded the same wrong assumption as the
code.

**A tool that cannot read its input must say so**, never return an empty result.
`findExpensiveAutomations` once reported "scanned 0, found no problems" because a
response key did not match — a false all-clear from an auditing tool, which is worse
than an error.

**Report partial failure rather than losing the answer.** Use `allSettled` for
fan-out and name the section that failed.

**Only JSON-RPC on stdout.** Logs go to stderr.

## Verification before you open a PR

```bash
npm run typecheck
npm test
npm run build
./scripts/check-no-identifiers.sh
DRY_RUN=1 ./scripts/discover-gateway.sh      # no credentials needed
scripts/jamf tools/list                      # live handshake
```

Anything touching `src/platform-client.ts` or adding a tool should also be exercised
against a live tenant. No test in this repo can confirm the gateway's real behaviour
— every one of them stubs `fetch`.

## Commit messages and PRs

Explain **why**; the diff shows what. Where a change corrects an earlier conclusion,
say so explicitly rather than quietly replacing it — this project's history contains
several retractions and the reasoning is worth more than a tidy log.

Flagging something you did not verify is fine. Presenting it as verified is not.

Subjects are descriptive imperatives. This repo does not use Conventional Commits,
which is why no badge claims it does.
