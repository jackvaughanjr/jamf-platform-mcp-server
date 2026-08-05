# Contributing

## Setup

```bash
npm install          # also points core.hooksPath at .githooks
cp .env.op.example .env.op   # edit to match your 1Password vault/item
npm run build
```

You need a Jamf Platform API Gateway integration (Jamf Account → Integrations) to
run anything against a live tenant. A **read-only** integration is sufficient and
strongly preferred — the gateway's own scopes are the safety boundary, not this
code.

## Two rules that are enforced, not requested

**Never `git add -f`.** The ignore list guards the OAuth client secret and captured
fleet data — device serials, usernames, email addresses, IPs, application
inventory. A pre-commit hook rejects any staged file that `.gitignore` covers. If
something ignored genuinely belongs in git, change `.gitignore` in its own commit
so the decision is reviewable.

**Never commit a captured API response.** Only type-only shapes under
`fixtures/shapes/` are committed. `scripts/discover-gateway.sh` writes raw
responses to gitignored `fixtures/raw/` and derives the shapes.

## Verifying a change

```bash
npm run typecheck
npm run build
DRY_RUN=1 ./scripts/discover-gateway.sh          # no credentials needed
op run --env-file=.env.op -- ./scripts/discover-gateway.sh
```

There is no test suite yet. Until there is, a change that touches the client
should be exercised against a live tenant, and an MCP-facing change should be
confirmed with a real handshake:

```bash
npm run inspector
```

## Adding support for an endpoint

1. **Read the endpoint's own reference page on developer.jamf.com, then verify it
   live.** Each operation page publishes its exact base URL and path. Probing
   candidates while reading only the index `llms.txt` files led to three API groups
   being wrongly declared unreachable — their paths were published the whole time.
   The docs have also been wrong about path shape, so a documented path still needs
   a probe in `scripts/discover-gateway.sh`. Read first, then verify; do not guess
   instead of reading.
2. Read `docs/gateway-reference.md` for the status-code semantics. A 403
   `BAD_PERMISSIONS` means the *route* is wrong, not the permission; a 400 says
   nothing about existence.
3. Pass `version` explicitly — Jamf Pro versions are per-resource.
4. Prefer using `platformRequest` over adding a typed tool until a real workflow
   justifies the tool.

## Decision records

Significant decisions go in `decisions/` as `JPM-NNNN-kebab-title.md`. They are
immutable once committed — correct one by superseding it, not by editing it. See
`decisions/README.md`.

Findings about the gateway's behaviour are **not** decisions; they belong in
`docs/gateway-reference.md`, which is expected to change as the beta evolves.

## Commit messages

Explain why, not what — the diff already shows what. Where a change corrects an
earlier conclusion, say so explicitly rather than quietly replacing it; several
findings in this project's history were retracted, and the reasoning is more
valuable than a clean-looking log.
