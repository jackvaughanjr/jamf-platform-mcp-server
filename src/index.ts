#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadConfig } from './config.js';
import { JamfPlatformApiError, JamfPlatformClient } from './platform-client.js';

function requireConfig() {
  try {
    return loadConfig();
  } catch (error) {
    // A misconfigured integration is the likeliest first-run failure; report it
    // as a plain message on stderr rather than a module-load stack trace.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const config = requireConfig();
const client = new JamfPlatformClient(config);

const server = new McpServer({
  name: 'jamf-platform-mcp-server',
  version: '0.1.0',
});

/** Renders a result or an error as MCP tool content. */
function asContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function asError(error: unknown) {
  if (error instanceof JamfPlatformApiError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `${error.message}\nURL: ${error.url}\nResponse: ${error.responseBody.slice(0, 2000)}`,
        },
      ],
    };
  }
  return {
    isError: true,
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
  };
}

/**
 * Generic passthrough. While the gateway is in beta and its surface is still
 * growing, an escape hatch that can reach any documented endpoint is more
 * useful than a fixed set of wrappers — it lets you explore the API
 * conversationally before committing to typed tools.
 */
server.registerTool(
  'platformRequest',
  {
    title: 'Jamf Platform API request',
    description:
      'Make an authenticated request against any Jamf Platform API Gateway endpoint. ' +
      'The gateway also fronts the Jamf Pro API (300+ endpoints) and Jamf Pro Classic API ' +
      '(500+), so this reaches essentially the whole Jamf surface. ' +
      'Shapes: style "tenant" (default) builds /{version}/tenant/{tenantId}/{resource}; ' +
      'style "flat" omits the tenant segment; rawPath is used verbatim after /api/{service} ' +
      'and is required for Classic, which is /JSSResource/{resource} with no version. ' +
      'Jamf Pro versions are per-resource (account-groups v1, enrollment v3, ' +
      'computers-inventory v4) — do not assume v1.',
    inputSchema: {
      service: z.string().describe('Gateway service segment, e.g. "blueprints", "devices"'),
      resource: z.string().optional().describe('Resource path, e.g. "blueprints". Omit if using rawPath.'),
      rawPath: z
        .string()
        .optional()
        .describe('Path after /api/{service}, used verbatim, e.g. "/JSSResource/computers"'),
      style: z.enum(['tenant', 'flat']).optional().describe('Path layout; defaults to "tenant"'),
      version: z.string().optional().describe('Version segment, defaults to "v1". Per-resource on Jamf Pro.'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('Defaults to GET'),
      query: z.record(z.string(), z.string()).optional().describe('Query string parameters'),
      body: z.unknown().optional().describe('JSON request body for write methods'),
    },
  },
  async ({ service, resource, rawPath, style, version, method, query, body }) => {
    try {
      return asContent(
        await client.request({ service, resource, rawPath, style, version, method, query, body }),
      );
    } catch (error) {
      return asError(error);
    }
  },
);

/**
 * Typed example. Blueprints is the endpoint the beta getting-started guide
 * documents concretely, so it is the safest first real call — and the pattern
 * to copy as you add coverage.
 */
server.registerTool(
  'listBlueprints',
  {
    title: 'List blueprints',
    description:
      'List Blueprints for the configured tenant. Requires the read:pro:blueprints scope — ' +
      'note the scope prefix is "pro" while the URL service segment is "blueprints".',
    inputSchema: {},
  },
  async () => {
    try {
      return asContent(await client.request({ service: 'blueprints', resource: 'blueprints' }));
    } catch (error) {
      return asError(error);
    }
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
  // stderr only: stdout is the MCP transport and must carry protocol traffic alone.
  console.error(
    `jamf-platform-mcp-server ready (gateway ${config.gatewayBaseUrl}, ` +
      `tenant ${config.tenantId}, ${config.readOnly ? 'read-only' : 'writes enabled'})`,
  );
}

main().catch((error) => {
  console.error('Fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});
