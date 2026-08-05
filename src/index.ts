#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  classifyPolicyCadence,
  mapWithConcurrency,
  scanForExpensiveCommands,
  type PolicyGeneral,
} from './automations.js';
import { loadConfig } from './config.js';
import {
  enrichGroupMembers,
  looksLikeUuid,
  matchesDeviceQuery,
  matchesGroupQuery,
  selectOutdatedDevices,
  summarizeBlueprints,
  summarizeDevices,
  summarizeGroups,
  type BlueprintRecord,
  type DeviceGroupRecord,
  type DeviceRecord,
} from './fleet.js';
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

/**
 * Read the version from package.json rather than duplicating it here.
 *
 * README states package.json is the single source of the version, and a hardcoded
 * literal made that false — the two would drift at the first release, and the
 * version an MCP client sees is the one that matters. Resolved relative to this
 * module, so it works from dist/ regardless of the caller's cwd.
 */
function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    // Never fail startup over version metadata.
    return '0.0.0';
  }
}

const server = new McpServer({
  name: 'jamf-platform-mcp-server',
  version: packageVersion(),
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

/** Describes a rejected fan-out leg without pretending it succeeded. */
function legError(error: unknown): string {
  if (error instanceof JamfPlatformApiError) return `${error.message} — ${error.responseBody.slice(0, 300)}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Compound tool: answers "how is the fleet doing" in one call.
 *
 * The point of a compound tool is that the model asks once instead of looping —
 * the three collections are fetched concurrently here rather than in the model's
 * turn loop.
 *
 * Uses allSettled, not all: a single failing segment must degrade that one
 * section rather than lose the whole answer. Only the four confirmed-working
 * routes are touched.
 */
server.registerTool(
  'getFleetOverview',
  {
    title: 'Fleet overview',
    description:
      'One-call fleet summary: device counts by platform and OS major, managed vs unmanaged, ' +
      'stale check-ins, device-group breakdown, and blueprint deployment states. ' +
      'Fetches devices, device groups and blueprints concurrently. NOTE the device total spans ' +
      'macOS AND iOS/iPadOS — it is not a Mac count. Sections that fail are reported ' +
      'individually rather than failing the whole call.',
    inputSchema: {
      staleThresholdDays: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Days without any reported activity before a device counts as stale. Defaults to 30.'),
      topGroups: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe(
          'How many largest device groups to list. Defaults to 10. The biggest groups are ' +
            'usually catch-alls holding the entire fleet, so check saturation.largestIsSaturated ' +
            'and raise this to see differentiating groups.',
        ),
    },
  },
  async ({ staleThresholdDays, topGroups }) => {
    const [devices, groups, blueprints] = await Promise.allSettled([
      client.requestAll<DeviceRecord>({ service: 'devices', resource: 'devices' }),
      client.requestAll<DeviceGroupRecord>({ service: 'device-groups', resource: 'device-groups' }),
      client.requestAll<BlueprintRecord>({ service: 'blueprints', resource: 'blueprints' }),
    ]);

    const errors: Record<string, string> = {};
    const overview: Record<string, unknown> = {};

    if (devices.status === 'fulfilled') {
      overview.devices = summarizeDevices(devices.value, new Date(), staleThresholdDays ?? 30);
    } else {
      errors.devices = legError(devices.reason);
    }

    if (groups.status === 'fulfilled') {
      overview.deviceGroups = summarizeGroups(groups.value, topGroups ?? 10);
    } else {
      errors.deviceGroups = legError(groups.reason);
    }

    if (blueprints.status === 'fulfilled') {
      overview.blueprints = summarizeBlueprints(blueprints.value);
    } else {
      errors.blueprints = legError(blueprints.reason);
    }

    if (Object.keys(overview).length === 0) {
      return asError(new Error(`every section failed: ${JSON.stringify(errors)}`));
    }
    if (Object.keys(errors).length > 0) overview.partialFailures = errors;
    return asContent(overview);
  },
);

/**
 * Compound tool: find devices by serial, name, model, id or user.
 *
 * Filtering is client-side over the confirmed list route. The gateway's
 * server-side filter parameters are undocumented, and the documented per-device
 * detail route (`/devices/{id}`) has never returned 200 in testing — so a
 * lookup built on it would be resting on an unverified route.
 */
server.registerTool(
  'findDevices',
  {
    title: 'Find devices',
    description:
      'Search the fleet by serial number, device name, model, device id, or user id ' +
      '(case-insensitive substring). Spans macOS and iOS/iPadOS. Paginates the full ' +
      'device list and filters client-side, because the gateway has no confirmed ' +
      'server-side filter.',
    inputSchema: {
      query: z.string().min(1).describe('Substring to match against serial, name, model, id or user'),
      limit: z.number().int().positive().max(200).optional().describe('Max matches to return. Defaults to 25.'),
    },
  },
  async ({ query, limit }) => {
    try {
      const all = await client.requestAll<DeviceRecord>({ service: 'devices', resource: 'devices' });
      const matches = all.filter((d) => matchesDeviceQuery(d, query));
      const cap = limit ?? 25;
      return asContent({
        query,
        scanned: all.length,
        matched: matches.length,
        // Say so when results are cut, rather than implying this is everything.
        truncated: matches.length > cap,
        devices: matches.slice(0, cap),
      });
    } catch (error) {
      return asError(error);
    }
  },
);

/**
 * Compound tool: which devices are behind on OS.
 *
 * `getFleetOverview` buckets by OS major, which shows *that* some devices are
 * behind but not *which* — so answering the obvious follow-up previously meant
 * dropping to `platformRequest` and filtering by hand.
 */
server.registerTool(
  'findOutdatedDevices',
  {
    title: 'Find outdated devices',
    description:
      'List devices whose OS major version is below a threshold, oldest first, with the ' +
      'freshest activity timestamp for each. Devices whose version is missing or ' +
      'unparseable are returned separately, because "unknown version" is a different ' +
      'finding from "old version". Spans macOS and iOS/iPadOS/tvOS.',
    inputSchema: {
      belowMajor: z
        .number()
        .int()
        .positive()
        .describe('Report devices whose OS major version is below this (e.g. 26 to find pre-26)'),
      limit: z.number().int().positive().max(500).optional().describe('Max devices per list. Defaults to 50.'),
    },
  },
  async ({ belowMajor, limit }) => {
    try {
      const all = await client.requestAll<DeviceRecord>({ service: 'devices', resource: 'devices' });
      const { outdated, unknownVersion } = selectOutdatedDevices(all, belowMajor);
      const cap = limit ?? 50;
      return asContent({
        belowMajor,
        scanned: all.length,
        outdatedCount: outdated.length,
        unknownVersionCount: unknownVersion.length,
        truncated: outdated.length > cap || unknownVersion.length > cap,
        outdated: outdated.slice(0, cap),
        unknownVersion: unknownVersion.slice(0, cap),
      });
    } catch (error) {
      return asError(error);
    }
  },
);

/** Compound tool: search device groups by name or description. */
server.registerTool(
  'findDeviceGroups',
  {
    title: 'Find device groups',
    description:
      'Search device groups by name or description (case-insensitive substring), ' +
      'returning id, member count, deviceType and groupType. Covers both computer ' +
      'and mobile groups, smart and static, since the gateway returns them in one list.',
    inputSchema: {
      query: z.string().min(1).describe('Substring to match against group name or description'),
      limit: z.number().int().positive().max(200).optional().describe('Max matches. Defaults to 50.'),
    },
  },
  async ({ query, limit }) => {
    try {
      const all = await client.requestAll<DeviceGroupRecord>({
        service: 'device-groups',
        resource: 'device-groups',
      });
      const matches = all.filter((g) => matchesGroupQuery(g, query));
      const cap = limit ?? 50;
      return asContent({
        query,
        scanned: all.length,
        matched: matches.length,
        truncated: matches.length > cap,
        groups: matches
          .slice(0, cap)
          .map((g) => ({
            id: g.id,
            name: g.name,
            memberCount: g.memberCount,
            deviceType: g.deviceType,
            groupType: g.groupType,
          })),
      });
    } catch (error) {
      return asError(error);
    }
  },
);

/**
 * Compound tool: which devices are actually in a group.
 *
 * The members endpoint returns bare device UUIDs, so it answers "how many" but not
 * "which". This resolves the group by name or id, fetches its members, and joins
 * them against the device list to give names, serials, platform and last-seen.
 *
 * No paging parameters are documented for the members route, so it is a single
 * request rather than a `requestAll` — sending ignored parameters would only invite
 * a wrong assumption about completeness.
 */
server.registerTool(
  'getDeviceGroupMembers',
  {
    title: 'Get device group members',
    description:
      'List the devices in a device group, resolved to names, serials, platform and ' +
      'last-seen time. Accepts a group UUID or a name substring; an ambiguous name ' +
      'returns the candidate groups rather than guessing. Member ids with no matching ' +
      'device are reported separately, since a membership pointing at an absent device ' +
      'is itself worth knowing.',
    inputSchema: {
      group: z.string().min(1).describe('Group UUID, or a substring of the group name'),
      limit: z.number().int().positive().max(1000).optional().describe('Max members to return. Defaults to 200.'),
    },
  },
  async ({ group, limit }) => {
    try {
      let groupId = looksLikeUuid(group) ? group.trim() : undefined;
      let groupName: string | undefined;

      if (!groupId) {
        const all = await client.requestAll<DeviceGroupRecord>({
          service: 'device-groups',
          resource: 'device-groups',
        });
        const matches = all.filter((g) => matchesGroupQuery(g, group));
        if (matches.length === 0) {
          return asContent({ query: group, matched: 0, hint: 'No group matched. Try findDeviceGroups.' });
        }
        if (matches.length > 1) {
          // Guessing between similarly-named compliance groups would be worse than
          // asking — the wrong one silently answers a different question.
          return asContent({
            query: group,
            matched: matches.length,
            hint: 'Ambiguous — re-run with one of these ids or a more specific substring.',
            candidates: matches.map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount })),
          });
        }
        groupId = matches[0]?.id;
        groupName = matches[0]?.name;
        if (!groupId) return asError(new Error('matched group has no id'));
      }

      const [memberBody, devices] = await Promise.all([
        client.request<{ totalCount?: number; results?: string[] }>({
          service: 'device-groups',
          resource: `device-groups/${groupId}/members`,
        }),
        client.requestAll<DeviceRecord>({ service: 'devices', resource: 'devices' }),
      ]);

      const memberIds = memberBody?.results ?? [];
      const { members, unresolvedIds } = enrichGroupMembers(memberIds, devices);
      const cap = limit ?? 200;

      return asContent({
        groupId,
        groupName,
        reportedTotalCount: memberBody?.totalCount,
        memberIdsReturned: memberIds.length,
        resolved: members.length,
        unresolvedIds,
        truncated: members.length > cap,
        members: members.slice(0, cap),
      });
    } catch (error) {
      return asError(error);
    }
  },
);

/**
 * Compound tool: find automations that could be burning CPU or battery.
 *
 * Motivated by a real report — `du` under `JamfDaemon` with a huge energy impact.
 * Three things in Jamf can do that, and this checks all of them in one pass:
 * scripts run by frequently-triggered policies, computer extension attributes
 * (which run at **every inventory collection**, making them the most-overlooked
 * cause), and policy cadence itself.
 *
 * Auditing everything means one detail request per script, extension attribute and
 * policy, so requests are bounded by `mapWithConcurrency` and each item's failure is
 * reported rather than failing the run.
 */
server.registerTool(
  'findExpensiveAutomations',
  {
    title: 'Find expensive automations',
    description:
      'Audit Jamf scripts, computer extension attributes and policies for commands that ' +
      'burn CPU or battery when run repeatedly (du, find /, mdfind, system_profiler and ' +
      'similar), and report which policies run them and how often. Extension attributes ' +
      'are called out separately because they execute at EVERY inventory collection. ' +
      'Answers "what is cooking this laptop\'s battery". Read-only.',
    inputSchema: {
      includeDisabledPolicies: z
        .boolean()
        .optional()
        .describe('Include policies that are disabled. Defaults to false.'),
      maxItemsPerKind: z
        .number()
        .int()
        .positive()
        .max(2000)
        .optional()
        .describe('Cap detail fetches per kind (scripts / EAs / policies). Defaults to 500.'),
      concurrency: z.number().int().positive().max(16).optional().describe('Parallel detail requests. Defaults to 6.'),
    },
  },
  async ({ includeDisabledPolicies, maxItemsPerKind, concurrency }) => {
    const cap = maxItemsPerKind ?? 500;
    const parallel = concurrency ?? 6;
    const errors: Record<string, string> = {};

    /** Classic list endpoints wrap results in a named key and are not paginated. */
    async function classicList<T>(resource: string, key: string): Promise<T[]> {
      const body = await client.request<Record<string, unknown>>({
        service: 'proclassic',
        rawPath: `/tenant/${config.tenantId}/${resource}`,
      });
      const value = body?.[key];
      return Array.isArray(value) ? (value as T[]) : [];
    }

    async function classicDetail<T>(resource: string, id: number | string, key: string): Promise<T | undefined> {
      const body = await client.request<Record<string, unknown>>({
        service: 'proclassic',
        rawPath: `/tenant/${config.tenantId}/${resource}/id/${id}`,
      });
      return body?.[key] as T | undefined;
    }

    try {
      const [scriptStubs, eaStubs, policyStubs] = await Promise.all([
        classicList<{ id: number; name: string }>('scripts', 'script').catch((e) => {
          errors.scripts = legError(e);
          return [];
        }),
        classicList<{ id: number; name: string; enabled?: boolean }>(
          'computerextensionattributes',
          'computer_extension_attribute',
        ).catch((e) => {
          errors.extensionAttributes = legError(e);
          return [];
        }),
        classicList<{ id: number; name: string }>('policies', 'policy').catch((e) => {
          errors.policies = legError(e);
          return [];
        }),
      ]);

      // ── policies: cadence, and which scripts they run ────────────────────────
      const policyDetails = await mapWithConcurrency(policyStubs.slice(0, cap), parallel, async (stub) => {
        try {
          const policy = await classicDetail<{
            general?: PolicyGeneral;
            scripts?: Array<{ id?: number; name?: string }>;
          }>('policies', stub.id, 'policy');
          return { stub, general: policy?.general, scripts: policy?.scripts ?? [] };
        } catch (error) {
          errors[`policy:${stub.id}`] = legError(error);
          return null;
        }
      });

      const policies = policyDetails
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .filter((p) => (includeDisabledPolicies ? true : p.general?.enabled !== false))
        .map((p) => ({
          id: p.stub.id,
          name: p.general?.name ?? p.stub.name,
          enabled: p.general?.enabled,
          cadence: classifyPolicyCadence(p.general),
          scriptIds: p.scripts.map((s) => s.id).filter((id): id is number => typeof id === 'number'),
          scriptNames: p.scripts.map((s) => s.name).filter((n): n is string => typeof n === 'string'),
        }));

      // ── scripts: scan contents, then attribute to the policies that run them ──
      const scriptFindings = await mapWithConcurrency(scriptStubs.slice(0, cap), parallel, async (stub) => {
        try {
          const script = await classicDetail<{ name?: string; script_contents?: string }>(
            'scripts',
            stub.id,
            'script',
          );
          const matches = scanForExpensiveCommands(script?.script_contents);
          if (matches.length === 0) return null;
          const runBy = policies
            .filter((p) => p.scriptIds.includes(stub.id))
            .map((p) => ({ id: p.id, name: p.name, cadence: p.cadence }));
          return {
            id: stub.id,
            name: script?.name ?? stub.name,
            matches,
            runByPolicies: runBy,
            // The finding that matters: expensive AND running constantly.
            runsAtHighFrequency: runBy.some((p) => p.cadence.highFrequency),
          };
        } catch (error) {
          errors[`script:${stub.id}`] = legError(error);
          return null;
        }
      });

      // ── extension attributes: run at EVERY inventory collection ──────────────
      // The detail path follows the same Classic convention as scripts and policies.
      // It is not itself documented, so a failure here is reported rather than
      // assumed impossible.
      const eaFindings = await mapWithConcurrency(eaStubs.slice(0, cap), parallel, async (stub) => {
        try {
          const ea = await classicDetail<{
            name?: string;
            enabled?: boolean;
            input_type?: { type?: string; script?: string };
          }>('computerextensionattributes', stub.id, 'computer_extension_attribute');
          const matches = scanForExpensiveCommands(ea?.input_type?.script);
          if (matches.length === 0) return null;
          return {
            id: stub.id,
            name: ea?.name ?? stub.name,
            enabled: ea?.enabled ?? stub.enabled,
            inputType: ea?.input_type?.type,
            matches,
          };
        } catch (error) {
          errors[`extensionAttribute:${stub.id}`] = legError(error);
          return null;
        }
      });

      const scripts = scriptFindings.filter((s): s is NonNullable<typeof s> => s !== null);
      const extensionAttributes = eaFindings.filter((e): e is NonNullable<typeof e> => e !== null);
      const highFrequencyPolicies = policies.filter((p) => p.cadence.highFrequency);

      return asContent({
        scanned: {
          scripts: Math.min(scriptStubs.length, cap),
          extensionAttributes: Math.min(eaStubs.length, cap),
          policies: Math.min(policyStubs.length, cap),
          truncated:
            scriptStubs.length > cap || eaStubs.length > cap || policyStubs.length > cap,
        },
        // Ordered most-suspicious first.
        extensionAttributesWithExpensiveCommands: extensionAttributes,
        expensiveScriptsRunFrequently: scripts.filter((s) => s.runsAtHighFrequency),
        expensiveScriptsOther: scripts.filter((s) => !s.runsAtHighFrequency),
        highFrequencyPolicies,
        ...(Object.keys(errors).length > 0 ? { partialFailures: errors } : {}),
        note:
          'Extension attributes run at every inventory collection, so an expensive one is ' +
          'the most likely cause of constant background CPU. Jamf inventory collection itself ' +
          'can also compute disk usage — check the tenant inventory settings if nothing here ' +
          'explains the load.',
      });
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
