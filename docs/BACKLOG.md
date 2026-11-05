# Backlog

Open work on this repository, newest first. Each entry says why it exists and what
done looks like, so a session starting cold can pick it up.

**This file is public, like the rest of the repo.** Anything tied to a specific tenant
(group ids, serials, Blueprint ids, the operator's own config repositories) is kept
out of it. The operator keeps those items in Claude Code's project memory for this
directory, which a new session loads automatically.

Last reviewed 2026-11-05, after JPM-0011.

---

## 8. Clear the npm audit findings in the runtime dependencies

**Done 2026-11-05.** `npm audit fix` (no `--force`) cleared 9 of the 10 runtime advisories,
lockfile only; tests, build and both servers' handshakes pass. **Remaining, accepted:** one
moderate in `fast-xml-parser` 4.5.7's `XMLBuilder`, which this code never calls (it only
parses); its fix is the 5.x line, a major version with a larger dependency set, so it moves
with a reviewed Dependabot major PR rather than here. Going forward: CI fails on any high or
critical runtime advisory, and Dependabot raises weekly grouped update PRs.

**Why:** on 2026-11-05 `npm audit --omit=dev` reported 10 advisories in the runtime
tree (1 critical, 4 high, 5 moderate; 15 including dev dependencies). They predate
JPM-0011 and come mostly through the MCP SDK's HTTP stack: `proxy-addr` (critical),
`body-parser`, `fast-uri`, `hono`, `@hono/node-server`, `qs`, `ip-address`
(transitive), plus `@modelcontextprotocol/sdk` and `zod` directly. This server runs
over stdio, so most are not reachable as published, but it holds a credential that can
change profiles and policies, and a clean tree is cheaper to defend than an argument
about reachability. `fast-xml-parser` 4.5.7's moderate advisory is in `XMLBuilder`,
which this code does not use; its fix is the 5.x line (a major version).

**How:** bump `@modelcontextprotocol/sdk` and `zod` to fixed versions and let the
transitive fixes follow (`npm audit fix`, no `--force`), then re-run the full suite and
a live read handshake on both servers. Decide separately whether to move
`fast-xml-parser` to 5.x, reviewing its larger dependency set first. Pin what changes.

**Done when:** `npm audit --omit=dev` is clean (or each remaining advisory is recorded
here as not reachable, with the reason), tests pass, both servers start and list their
tools, and the CHANGELOG notes the bumps.

## 7. Add typed create tools for profiles, policies and computer groups

**Why:** the write server can change scope but cannot create anything, so the
JPM-0009 canary gate (item 6) needs the operator to make its throwaway profile and
policy by hand in the console. The write integration already holds `:create` on
configuration profiles, policies and device groups, unused by operator decision
(JPM-0009), so the credential is not the blocker; a reviewed tool is.

**How:** a new ADR first, then typed tools in `src/write-server.ts` only, copying the
existing write shape: no defaults, `dryRun` true by default, verify by read-back, and a
rollback. Delete is not granted, so a create's rollback is an empty scope (and, for a
policy, disabled) rather than a delete. A profile create sends a payload, unlike the
scope tools: payloads can hold secrets, so the tool must never return or log payload
content (hashes only, as the scope tools do), and the dry run should show structure, not
values. Decide whether profile payloads come from a vetted allowlist of payload types
rather than arbitrary XML.

**Done when:** the ADR is accepted, the tools and their tests are merged,
`src/conventions.test.ts` lists them, and a first live create (an empty-scope object) is
verified and recorded in `docs/gateway-reference.md`.

## 1. Confirm the write server's request body on its first real write

**Update confirmed live 2026-11-04** (see gateway-reference.md); what remains is the
first real **create**.

**Why:** Jamf's operation pages for Restricted Software create and update publish no
request body at all. `src/restricted-software.ts` sends XML shaped like the GET schema
(`<restricted_software><general>…</general><scope>…</scope>`), because Classic has
always taken XML on writes. Everything else on the write path has been confirmed
live: auth, the narrow permission set, the read-back, the parser against real entries,
and a no-op update dry run. A real write never has. See
[JPM-0008](../decisions/JPM-0008-reversible-writes-as-a-separate-server.md) and
[gateway-reference.md](gateway-reference.md).

**How:** never write *to test*. Verify on the first change that is actually needed:
run a dry run, review the XML and diff, then make the real call and check that the
result's `verification.verified` is `true` with no `mismatches`. A 4xx with a body
naming the format is the other likely outcome.

**Done when:** the outcome is recorded in `docs/gateway-reference.md` (Restricted
Software writes), the README's current-state "not yet verified" line and the
CHANGELOG are updated, and, if the format was wrong, the builder and its tests are
fixed first.

## 6. Run the scope-membership canary gate before any production object

**Done 2026-11-05.** Passed: scope-only PUT accepted, other fields untouched, no
redistribution. Outcome in `docs/gateway-reference.md` (Scope-membership writes).

**Why:** [JPM-0009](../decisions/JPM-0009-computer-group-scope-membership-tools.md)'s
four tools, and the batch tool of [JPM-0010](../decisions/JPM-0010-scope-membership-batch-tool.md),
send a scope-only PUT. That Jamf accepts that body, leaves the rest of the
object alone, and does not redistribute a profile to Macs already in scope, are all
unverified, as is the XML body format (item 1). A wrong answer on a compliance profile
reaches the whole fleet.

**How:** the operator creates a throwaway profile and a throwaway policy, each scoped
to one test Mac. Dry run, then run an add on each. In Jamf, check the profile and the
MDM command history for any redistribution to other Macs, and check the result's
`otherFieldsUnchanged` is `true`. Then one production object, then the rest.

**Done when:** the outcome, including how Jamf treated the body, is recorded in
`docs/gateway-reference.md` (Scope-membership writes) and here, and item 1 is updated if
the body format was settled.

## 2. Rewrite `scripts/discover-gateway.sh` for the current gateway

**Why:** Jamf moved the Platform API between 2026-08-10 and 2026-10-06. The script
still probes the old host (`{region}.apigw.jamf.com`), the old paths
(`/api/{service}/{version}/tenant/{id}/…`), and tests tenant *headers* as a curiosity,
where they are now the required mechanism. Its header says so. CI's dry-run step
still passes, because a dry run checks only the probe table.

**Done when:** it targets `{region}.api.jamfcloud.com`, builds
`/{service}/{version}/{resource}` (Classic: `/proclassic/{resource}`), sends
`X-Environment-Id` (or `X-Tenant-Id` for a Tenant-level integration), and a live run
regenerates `fixtures/discovery-report.md`. Then re-check the gateway-reference
sections marked as pre-move (*Hosted service segments*, *Status code semantics*) and
update or retire them.

## 3. Re-verify, then report, the two gateway-side faults

**Why:** two faults on Jamf's side were found before the move and never reported:

- `ddm/report` `declarations/{id}/devices` returned **504** at small page sizes
  (`size=2`, `size=20`) and succeeded at `size=100`, back to back on 2026-08-07. The 504
  body is nginx HTML with no `traceId`.
- Compliance Benchmarks returned **500** `Upstream host lookup failed`.

Both may have changed with the move.

**Done when:** each is re-tested on the current gateway. Anything still failing is
reported to Jamf with URL, timestamps and any trace id, and
`docs/gateway-reference.md` records the result either way.

## 4. Check the write server's tool list on the wire in CI

**Why:** CI's MCP handshake step starts only the read server and checks that its
passthrough offers no write verbs. The write server's tool list is pinned only by
`src/conventions.test.ts`, which reads source, not by what a client actually sees.

**Done when:** CI also starts `dist/write-server.js` with fixture credentials and fails
unless `tools/list` returns exactly the seven reviewed write tools (see
`src/conventions.test.ts`). Low priority: the source-level test already holds the
list.

## 5. Let the local ADR hook accept a Status-only pointer without an override

**Why:** CI (`src/adr-guard.ts`) now allows the superseded-by pointer mechanically.
The local hook (`scripts/check-adr-immutability.sh`) still needs
`ADR_ALLOW_EDIT=1` for the same edit, so local and CI differ on the one sanctioned case.

**Done when:** the hook runs the same judgement, for example by calling
`dist/adr-guard.js` on the staged change, and keeps the override for the
no-external-readers case only. Optional: the override already works.
