# Working in this repo

## Never force-add ignored files

`git add -f` / `git add --force` is not permitted in this repo, and neither is
`git update-index --add` on an ignored path. A `.githooks/pre-commit` hook
rejects any staged file that `.gitignore` covers, so a force-add fails at commit
time rather than silently landing.

The ignore list is a data-handling boundary, not tidiness. It guards:

- the OAuth client secret (`.env`) — shown exactly once at integration creation
- raw gateway responses (`fixtures/raw/`, `blueprints.json`) containing live
  device serials, usernames, email addresses, IPs, and per-device application
  inventory

If something currently ignored genuinely belongs in version control, change
`.gitignore` in its own commit so the decision is reviewable.

## Credentials

Never write the client secret to disk. Credentials live in 1Password; inject
them at runtime:

```bash
op run --env-file=.env.op -- ./scripts/discover-gateway.sh
```

`.env.op` holds `op://` references, not secrets, which is why it is committed.

## Gateway path shape

```
{base}/api/{service}/{version}/tenant/{tenantId}/{resource}
```

**The service segment is not the scope prefix.** Blueprints needs the scope
`read:pro:blueprints` but lives at `/api/blueprints/...`. Deriving the segment
from the scope name yields `/api/pro/...` and a 404 that reads like a
permissions error. Confirm each segment empirically before adding a tool —
`scripts/discover-gateway.sh` resolves them, and `fixtures/shapes/` records what
came back.

Diagnostic shorthand when a call fails:

- **404** — wrong service segment or resource
- **403** — right path, missing scope

## Stdout is the MCP transport

Only JSON-RPC may go to stdout. Logs go to stderr. `dotenv` is loaded with
`quiet: true` because v17 prints a banner to stdout that breaks the handshake.
