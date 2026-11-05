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
import { applyScopeMembershipBatch, scopeMembershipBatchInputSchema } from './scope-membership-batch.js';
import { createScript, createScriptInputSchema } from './create-script.js';
import { createPolicy, createPolicyInputSchema } from './create-policy.js';

/**
 * The write server (JPM-0008). Registers write tools and nothing else: no
 * passthrough, no read tools. Every mutation this project can make is a
 * `registerTool` call in this file, and `src/conventions.test.ts` holds the list.
 *
 * Tools: createRestrictedSoftware, updateRestrictedSoftware (JPM-0008), and
 * addComputerGroupToProfileScope, removeComputerGroupFromProfileScope, addComputerGroupToPolicyScope, removeComputerGroupFromPolicyScope (JPM-0009, src/scope-membership.ts),
 * applyScopeMembershipBatch (JPM-0010, src/scope-membership-batch.ts): many of those
 * operations as one reviewed plan, bound to a live run by a plan hash, and
 * createScript and createPolicy (JPM-0012, src/create-script.ts, src/create-policy.ts):
 * create only, every field explicit, policies always disabled, script contents and
 * parameter values shown as hashes only.
 *
 * Runs under its own Jamf integration — restricted-software read/create/update,
 * configuration-profiles read/update, policies read/create/update, device-groups read,
 * scripts read/create, categories read; never delete — and is registered per project,
 * not globally, so its tools appear only where the Jamf change log lives.
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

server.registerTool(
  'applyScopeMembershipBatch',
  {
    title: 'Apply a reviewed batch of computer group scope changes',
    description:
      'WRITES TO JAMF PRO when dryRun is false. Applies 1 to 150 operations, each adding or removing one computer group ' +
      'in the scope of one macOS configuration profile or policy, as ONE reviewed plan. Operations are grouped by object ' +
      'and each object gets a single PUT carrying its final scope. Same refusal rules as the single tools; if any operation ' +
      'is refused, the dry run returns every refusal and no planHash. A dry run (the default) returns the per-object ' +
      'before/after table, totals and a planHash. A live call requires that planHash: it re-reads everything and writes ' +
      'nothing if any listed object or group changed since the dry run. Objects are written in order, each read back and ' +
      'verified (scope and a non-scope fingerprint); the first failure stops the batch and later objects are notAttempted. ' +
      'The result carries a rollback: the inverse operations for every object written, as a dry run to be reviewed first.',
    inputSchema: scopeMembershipBatchInputSchema,
  },
  async (input) => {
    try {
      return asContent(await applyScopeMembershipBatch(ctx, input));
    } catch (error) {
      return asError(error);
    }
  },
);

server.registerTool(
  'createScript',
  {
    title: 'Create a Jamf Pro script',
    description:
      'WRITES TO JAMF PRO when dryRun is false. Creates one script through the Jamf Pro API (POST /pro/v1/scripts). ' +
      'Every field must be stated: name, categoryId (-1 for none), priority, info, notes, all eight parameter labels, ' +
      'osRequirements and scriptContents; unknown fields are rejected. Refuses a name that already exists, a missing ' +
      'category, and contents without a "#!" line, with CRLF line endings or a NUL. The contents are NEVER echoed: the ' +
      'dry run (the default) and the result show their SHA-256 and length. A live call reads the script back and ' +
      'compares every field, contents by hash. This server cannot update or delete a script; the rollback is manual.',
    inputSchema: createScriptInputSchema,
  },
  async (input) => {
    try {
      return asContent(await createScript(ctx, input));
    } catch (error) {
      return asError(error);
    }
  },
);

server.registerTool(
  'createPolicy',
  {
    title: 'Create a Jamf Pro policy, disabled',
    description:
      'WRITES TO JAMF PRO when dryRun is false. Creates one policy through Classic (POST /proclassic/policies/id/0, XML). ' +
      'ALWAYS created DISABLED; there is no enabled input. Every trigger, the frequency, retry settings, the explicit scope ' +
      '(computer ids and computer group ids, with optional exclusions; never all computers; empty only with ' +
      'emptyScopeIntended true), each script with all eight parameters, recon and Self Service must be stated; unknown ' +
      'fields are rejected. Packages are not supported. Script parameter VALUES are never echoed: the dry run (the default) ' +
      'shows the exact XML with each value replaced by its SHA-256 and length. A live call reads the policy back and ' +
      'compares every field sent, and checks that what was not sent is inert. The rollback is: keep it disabled, empty its ' +
      'scope, delete it in the console.',
    inputSchema: createPolicyInputSchema,
  },
  async (input) => {
    try {
      return asContent(await createPolicy(ctx, input));
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
