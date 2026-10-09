# Backlog

Open work on this repository, newest first. Each entry says why it exists and what
done looks like, so a session starting cold can pick it up.

**This file is public, like the rest of the repo.** Anything tied to a specific tenant
(group ids, serials, Blueprint ids, the operator's own config repositories) is kept
out of it. The operator keeps those items in Claude Code's project memory for this
directory, which a new session loads automatically.

Last reviewed 2026-10-09, at v0.4.0.

---

## 1. Confirm the write server's request body on its first real write

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
unless `tools/list` returns exactly `createRestrictedSoftware` and
`updateRestrictedSoftware`. Low priority: the source-level test already holds the
list.

## 5. Let the local ADR hook accept a Status-only pointer without an override

**Why:** CI (`src/adr-guard.ts`) now allows the superseded-by pointer mechanically.
The local hook (`scripts/check-adr-immutability.sh`) still needs
`ADR_ALLOW_EDIT=1` for the same edit, so local and CI differ on the one sanctioned case.

**Done when:** the hook runs the same judgement, for example by calling
`dist/adr-guard.js` on the staged change, and keeps the override for the
no-external-readers case only. Optional: the override already works.
