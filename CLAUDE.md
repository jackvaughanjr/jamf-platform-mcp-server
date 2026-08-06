# Working in this repo

Rules for working here. Two companion documents carry what this one deliberately
does not:

- [`docs/gateway-reference.md`](docs/gateway-reference.md) — what the Jamf Platform
  API Gateway actually does: path shapes, confirmed routes, status semantics,
  pagination. Findings about a beta product; expect them to change.
- [`decisions/`](decisions/) — why the project is built this way. Immutable.

## Never force-add ignored files

`git add -f` / `git add --force` is not permitted in this repo, and neither is
`git update-index --add` on an ignored path. A `.githooks/pre-commit` hook rejects
any staged file that `.gitignore` covers, so a force-add fails at commit time
rather than silently landing.

The ignore list is a data-handling boundary, not tidiness. It guards:

- the OAuth client secret (`.env`) — shown exactly once at integration creation
- raw gateway responses (`fixtures/raw/`, `blueprints.json`) containing live device
  serials, usernames, email addresses, IPs, and per-device application inventory

If something currently ignored genuinely belongs in version control, change
`.gitignore` in its own commit so the decision is reviewable. Rationale:
[JPM-0004](decisions/JPM-0004-type-only-fixtures.md).

## Committed ADRs are immutable

`scripts/check-adr-immutability.sh` blocks modifying, deleting, or renaming an ADR
that is already committed. Corrections go by a new superseding record. Before a
record has external readers, an in-place edit is available via
`ADR_ALLOW_EDIT=1 git commit`. See [`decisions/README.md`](decisions/README.md).

## Credentials

Never write the client secret to disk. Credentials live in 1Password; inject them
at runtime:

```bash
cp .env.op.example .env.op   # then edit to match your vault/item
op run --env-file=.env.op -- ./scripts/discover-gateway.sh
```

Only `.env.op.example` is tracked. A real `.env.op` holds no secrets — just
`op://` references — but those references name a local 1Password vault and item,
which is org-internal detail that does not belong in a repo shared outside the
company. Keep it untracked.

If `OP_SERVICE_ACCOUNT_TOKEN` is exported globally, `op` authenticates as that
service account rather than prompting for biometrics, and sees only the vaults
granted to it — which surfaces as a confusing "X isn't a vault in this account".
The committed `.envrc` unsets it for this repo (`direnv allow` once).

## Never commit captured API data

Raw gateway responses are fleet inventory. Only type-only shapes under
`fixtures/shapes/` are committed — every scalar replaced by its type name, keys
preserved because keys are the schema. `scripts/discover-gateway.sh` produces both
and masks tenant and device identifiers out of the committed report.

When adding anything that writes a committed artefact from a live response, mask
identifiers at write time and assume the masking will eventually miss something —
that is why there is a UUID catch-all and a post-write assertion.

## Stdout is the MCP transport

Only JSON-RPC may go to stdout. Logs go to stderr. `dotenv` is loaded with
`quiet: true` because v17 prints a banner to stdout that breaks the handshake.

## Before adding a tool

1. **Read the endpoint's own reference page on developer.jamf.com first** — it
   publishes the exact base URL and path. Probing candidates while consulting only
   the index `llms.txt` files led to three API groups being wrongly declared
   unreachable
   ([JPM-0006](decisions/JPM-0006-classic-and-declaration-reporting-are-supported.md)).
   Then verify it live: the docs have also been wrong about path shape.
2. Pass `version` explicitly; Jamf Pro versions are per-resource. For Jamf Pro
   Classic use `style: 'classic'`, which builds `/tenant/{tenantId}/{resource}` with
   no version and fills the tenant in — reaching Classic through `rawPath` means the
   caller supplying the tenant id, and an empty one yields `/tenant//{resource}` and a
   400 that blames token context rather than the blank value.
3. Prefer extending `platformRequest` usage over adding a typed tool until a
   workflow justifies one
   ([JPM-0003](decisions/JPM-0003-passthrough-plus-selective-typed-tools.md)).
4. `platformRequest` is **GET-only** and exposes no `method` or `body`
   ([JPM-0007](decisions/JPM-0007-write-path-posture.md)). Any write is a named typed
   tool with a narrow schema, never the passthrough — and destructive scopes are never
   granted to this server at all, so a write tool needs a superseding ADR first.
5. `requestAll` infers its paging family from the service segment. Classic throws
   rather than returning `[]`, and `ddm/report` uses `size` rather than `page-size`.
   A new segment that pages differently belongs in `PAGING_FAMILY_BY_SERVICE`.
