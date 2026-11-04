#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { asContent, asError, packageVersion, requireConfig } from './mcp-common.js';
import { JamfPlatformClient } from './platform-client.js';
import {
  createRestrictedSoftware,
  generalCreateSchema,
  generalUpdateSchema,
  scopeInputSchema,
  updateRestrictedSoftware,
  type WriteContext,
} from './restricted-software.js';
import {
  addComputerGroupToPolicyScope,
  addComputerGroupToProfileScope,
  removeComputerGroupFromPolicyScope,
  removeComputerGroupFromProfileScope,
  scopeMembershipInputSchema,
} from './scope-membership.js';

/**
 * The write server (JPM-0008). Registers write tools and nothing else: no
 * passthrough, no read tools. Every mutation this project can make is a
 * `registerTool` call in this file, and `src/conventions.test.ts` holds the list.
 *
 * Tools: createRestrictedSoftware, updateRestrictedSoftware (JPM-0008), and
 * addComputerGroupToProfileScope, removeComputerGroupFromProfileScope, addComputerGroupToPolicyScope, removeComputerGroupFromPolicyScope (JPM-0009, src/scope-membership.ts).
 *
 * Runs under its own Jamf integration — restricted-software read/create/update,
 * configuration-profiles read/update, policies read/update, device-groups read;
 * never delete — and is registered per project, not globally, so its tools
 * appear only where the Jamf change log lives.
 */

const config = requireConfig();
const ctx: WriteContext = {
  client: new JamfPlatformClient(config),
  writesEnabled: !config.readOnly,
};

const server = new McpServer({
  name: 'jamf-platform-mcp-write',
  version: packageVersion(),
});

const dryRun = z
  .boolean()
  .optional()
  .describe(
    'Defaults to TRUE. A dry run performs the reads, returns the exact XML and a field-by-field ' +
      'diff, and writes nothing. Pass false only after the dry run has been reviewed.',
  );

server.registerTool(
  'createRestrictedSoftware',
  {
    title: 'Create a Jamf Restricted Software entry',
    description:
      'WRITES TO JAMF PRO when dryRun is false. Creates a Restricted Software entry, which blocks a ' +
      'process on the computers in its scope. Scope is required and is exactly what you pass: ' +
      'nothing defaults to all computers. Every general setting must be stated. Refuses a name that ' +
      'already exists. The result reports the diff, verifies the write by reading it back, and gives ' +
      'the rollback (an update that empties the scope; this server cannot delete).',
    inputSchema: {
      general: generalCreateSchema,
      scope: scopeInputSchema,
      dryRun,
    },
  },
  async (input) => {
    try {
      return asContent(await createRestrictedSoftware(ctx, input));
    } catch (error) {
      return asError(error);
    }
  },
);

server.registerTool(
  'updateRestrictedSoftware',
  {
    title: 'Update a Jamf Restricted Software entry',
    description:
      'WRITES TO JAMF PRO when dryRun is false. Reads the live entry, changes only the general fields ' +
      'you pass, and leaves scope untouched unless you pass a scope, which then REPLACES the live ' +
      'scope in full. Refuses a scope change when the live scope uses user exclusions or limitations ' +
      'this tool cannot represent. An update that changes nothing writes nothing. To disable an ' +
      'entry without deleting it, pass scope {"allComputers": false}. The result gives the prior ' +
      'values as ready-to-use rollback arguments.',
    inputSchema: {
      id: z.number().int().positive().describe('Restricted software id'),
      general: generalUpdateSchema.optional().describe('Only the fields to change'),
      scope: scopeInputSchema.optional().describe('A complete replacement scope; omit to keep the live one'),
      dryRun,
    },
  },
  async (input) => {
    try {
      return asContent(await updateRestrictedSoftware(ctx, input));
    } catch (error) {
      return asError(error);
    }
  },
);

server.registerTool(
  'addComputerGroupToProfileScope',
  {
    title: 'Add a computer group to a configuration profile scope',
    description:
      'WRITES TO JAMF PRO when dryRun is false. Adds one computer group to the scope of one macOS configuration profile, ' +
      'by reading the live object and sending back only its full <scope>. Refuses when the group does not exist, when it is ' +
      'already in the scope, when the scope is All Computers, or when the live scope holds anything this tool does not ' +
      'model (users, limitations, user exclusions, network segments). Refuses unless the profile redeploy_on_update is exactly "Newly Assigned". The result reports the diff, ' +
      'verifies by reading back, reports whether every non-scope part of the object is unchanged (hashes only), and gives the rollback.',
    inputSchema: scopeMembershipInputSchema,
  },
  async (input) => {
    try {
      return asContent(await addComputerGroupToProfileScope(ctx, input));
    } catch (error) {
      return asError(error);
    }
  },
);

server.registerTool(
  'removeComputerGroupFromProfileScope',
  {
    title: 'Remove a computer group from a configuration profile scope',
    description:
      'WRITES TO JAMF PRO when dryRun is false. Removes one computer group from the scope of one macOS configuration profile, ' +
      'by reading the live object and sending back only its full <scope>. Refuses when the group does not exist, when it is ' +
      'not in the scope, when the scope is All Computers, or when the live scope holds anything this tool does not ' +
      'model (users, limitations, user exclusions, network segments). Refuses unless the profile redeploy_on_update is exactly "Newly Assigned". The result reports the diff, ' +
      'verifies by reading back, reports whether every non-scope part of the object is unchanged (hashes only), and gives the rollback.',
    inputSchema: scopeMembershipInputSchema,
  },
  async (input) => {
    try {
      return asContent(await removeComputerGroupFromProfileScope(ctx, input));
    } catch (error) {
      return asError(error);
    }
  },
);

server.registerTool(
  'addComputerGroupToPolicyScope',
  {
    title: 'Add a computer group to a policy scope',
    description:
      'WRITES TO JAMF PRO when dryRun is false. Adds one computer group to the scope of one policy, ' +
      'by reading the live object and sending back only its full <scope>. Refuses when the group does not exist, when it is ' +
      'already in the scope, when the scope is All Computers, or when the live scope holds anything this tool does not ' +
      'model (users, limitations, user exclusions, network segments). The result reports the diff, ' +
      'verifies by reading back, reports whether every non-scope part of the object is unchanged (hashes only), and gives the rollback.',
    inputSchema: scopeMembershipInputSchema,
  },
  async (input) => {
    try {
      return asContent(await addComputerGroupToPolicyScope(ctx, input));
    } catch (error) {
      return asError(error);
    }
  },
);

server.registerTool(
  'removeComputerGroupFromPolicyScope',
  {
    title: 'Remove a computer group from a policy scope',
    description:
      'WRITES TO JAMF PRO when dryRun is false. Removes one computer group from the scope of one policy, ' +
      'by reading the live object and sending back only its full <scope>. Refuses when the group does not exist, when it is ' +
      'not in the scope, when the scope is All Computers, or when the live scope holds anything this tool does not ' +
      'model (users, limitations, user exclusions, network segments). The result reports the diff, ' +
      'verifies by reading back, reports whether every non-scope part of the object is unchanged (hashes only), and gives the rollback.',
    inputSchema: scopeMembershipInputSchema,
  },
  async (input) => {
    try {
      return asContent(await removeComputerGroupFromPolicyScope(ctx, input));
    } catch (error) {
      return asError(error);
    }
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
  // stderr only: stdout is the MCP transport and must carry protocol traffic alone.
  console.error(
    `jamf-platform-mcp-write ready (gateway ${config.gatewayBaseUrl}, ` +
      `${config.environmentId ? `environment ${config.environmentId}` : `tenant ${config.tenantId}`}, ` +
      `${ctx.writesEnabled ? 'writes enabled' : 'JAMF_READ_ONLY on: dry runs only'})`,
  );
}

main().catch((error) => {
  console.error('Fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});
