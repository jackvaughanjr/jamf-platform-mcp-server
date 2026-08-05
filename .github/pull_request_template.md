# What and why

<!-- What changes, and why. The diff shows what; explain why. -->

# Verification

<!-- What you actually ran, and what it showed. Not "should work". -->

- [ ] `npm run typecheck && npm run build && npm test` pass locally
- [ ] Exercised against a live tenant, if this touches `src/platform-client.ts` or
      adds a tool — no test can confirm the gateway's real behaviour
- [ ] If this fixes a bug, a test fails without the fix

# The three rules CI enforces

- [ ] **No live identifiers.** No tenant ids, device ids, serials, usernames, group
      names or hostnames in tracked files — including test fixtures. Test UUIDs use
      the `deadbeef-` prefix. Run `scripts/check-no-identifiers.sh`.
- [ ] **No captured API responses committed.** Only type-only shapes under
      `fixtures/shapes/`. Never `git add -f`.
- [ ] **No edits to a committed ADR.** Supersede it with a new record instead.

# If this adds support for an endpoint

- [ ] Read the endpoint's own reference page on `developer.jamf.com` first, and the
      path in this PR matches what it publishes
- [ ] Verified live — a documented path is not a working path here
- [ ] `version` passed explicitly (Jamf Pro versions are per-resource)
- [ ] Considered whether `platformRequest` already covers the need

# If this changes a decision

- [ ] New ADR under `decisions/`, superseding rather than editing
- [ ] Superseded record's `Status` updated to point at the successor
      (`ADR_ALLOW_EDIT=1 git commit`)
- [ ] `decisions/README.md` index updated

# Anything you are unsure about

<!-- Say so here. An unverified claim flagged is fine; an unverified claim
     presented as verified is the problem. If you corrected an earlier
     conclusion, say that too — this project's history has several, and the
     reasoning is worth more than a clean-looking log. -->
