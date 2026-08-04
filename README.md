# jamf-platform-mcp-server

An MCP server for the **Jamf Platform API Gateway**, authenticating with OAuth 2.0
client credentials rather than user-account tokens.

> **Status: early scaffold, and the upstream API is itself a public beta.**
> The Platform API Gateway has no published breaking-change protocol and no
> announced GA date. Pin your dependencies and expect churn.

## Why the Platform API

The gateway is a single entry point across Jamf's APIs, and it carries the
existing Jamf Pro API and Classic API through it — per Jamf, "the same APIs many
of you are familiar with, now brought into the fold," where migrating means
updating the base URL and auth. So targeting the gateway costs no endpoint
coverage while adding the newer unified APIs:

| Available in beta | On Jamf's roadmap |
| --- | --- |
| Jamf Pro API, Jamf Pro Classic API | Jamf Protect |
| Blueprints (declarative device management) | Jamf Security Cloud |
| Declaration Reporting | One-click OAuth integrations |
| Compliance Benchmarks | |
| Devices, Device Groups, Device Management Actions | |

The auth model is the real draw. Client credentials give a machine identity with
fine-grained per-product scopes (`read:pro:blueprints` and friends), so the
safety boundary can live in **credential provisioning** rather than in
application logic. A read-only integration cannot wipe a device no matter what
bug you ship, because the gateway refuses the call. `JAMF_READ_ONLY` in this
repo is a convenience backstop, not the guarantee — provision scopes narrowly.

## Setup

```bash
npm install
cp .env.example .env   # fill in credentials
npm run build
```

Create an integration under **Jamf Account → Integrations** to get a client ID
and secret. The secret is shown exactly once at creation.

| Variable | Required | Notes |
| --- | --- | --- |
| `JAMF_CLIENT_ID` | yes | From your Jamf Account integration |
| `JAMF_CLIENT_SECRET` | yes | Shown once at creation |
| `JAMF_TENANT_ID` | yes | Appears in the gateway path |
| `JAMF_GATEWAY_BASE_URL` | no | Defaults to `https://us.apigw.jamf.com`; override for other regions |
| `JAMF_TOKEN_URL` | no | Defaults to `<base>/auth/token` |
| `JAMF_READ_ONLY` | no | Defaults to `true`; set `false` to permit writes |

### Register with Claude Code

```bash
claude mcp add jamf-platform -- node /absolute/path/to/dist/index.js
```

Or in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jamf-platform": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "JAMF_CLIENT_ID": "...",
        "JAMF_CLIENT_SECRET": "...",
        "JAMF_TENANT_ID": "..."
      }
    }
  }
}
```

## Tools

| Tool | Purpose |
| --- | --- |
| `platformRequest` | Authenticated request against any gateway endpoint. Builds `/api/{service}/{version}/tenant/{tenantId}/{resource}` and attaches a bearer token. |
| `listBlueprints` | Typed example against the one endpoint the beta guide documents concretely. Copy this shape as you add coverage. |

`platformRequest` is deliberate: while the gateway surface is still growing, a
general escape hatch beats a fixed set of wrappers, because you can explore the
API conversationally before deciding which calls deserve typed tools.

## Design notes

- **All gateway concerns live in `src/platform-client.ts`.** The API is in beta;
  when the contract shifts there should be one file to fix.
- **Token caching handles the 900-second lifetime** with a 60-second refresh
  skew, and de-duplicates concurrent refreshes — MCP servers fan out tool calls,
  and a cold start would otherwise fire several token requests at once.
- **Nothing writes to stdout but MCP protocol traffic.** Logs go to stderr, and
  `dotenv` is loaded with `quiet: true` because v17 prints a banner to stdout
  that corrupts the JSON-RPC stream.

## Roadmap

- [ ] Port the compound-tool pattern (one call answering a real fleet question,
      fanning out internally) instead of one tool per endpoint
- [ ] Evaluate a sandboxed-SDK mode over one-tool-per-endpoint, which scales
      better as gateway coverage grows
- [ ] Replace hand-rolled compliance logic with the Compliance Benchmarks API
- [ ] Tests against a recorded gateway fixture

## Attribution

This project began as a port of
[dbankscard/jamf-mcp-server](https://github.com/dbankscard/jamf-mcp-server)
(MIT) to the Jamf Platform API. That project's tool taxonomy — particularly its
compound tools that answer a fleet question in one call — informed the design
here. The original copyright notice is retained in [LICENSE](LICENSE) as the MIT
License requires.

Related work worth knowing about:

- [Jamf-Concepts/mcp-hub](https://github.com/Jamf-Concepts/mcp-hub) — Jamf's own
  open-source MCP server (Python, Beta) for Jamf Pro, Protect, and Security Cloud
- [`https://developer.jamf.com/mcp`](https://developer.jamf.com/developer-guide/docs/mcp) —
  Jamf-hosted MCP server for developer documentation search, not tenant management

## License

MIT — see [LICENSE](LICENSE).
