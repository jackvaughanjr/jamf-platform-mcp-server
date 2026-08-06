#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  assessInventoryCollection,
  classifyPolicyCadence,
  expandInventoryQuery,
  extractClassicDetail,
  extractClassicList,
  findCriterionMatches,
  findDisplayFieldMatches,
  mapWithConcurrency,
  scanForExpensiveCommands,
  sweepCriterionMatches,
  sweepDisplayFieldMatches,
  type InventoryCollectionSettings,
  type JamfCriterion,
  type PolicyGeneral,
} from './automations.js';
import { loadConfig } from './config.js';
import { summarizeDeclarationScope } from './declaration-scope.js';
import {
  enrichGroupMembers,
  looksLikeUuid,
  matchesDeviceQuery,
  matchesGroupQuery,
  selectOutdatedDevices,
  summarizeBlueprints,
  summarizeDeclarations,
  summarizeDevices,
  summarizeGroups,
  type DeclarationRecord,
  type BlueprintRecord,
  type DeviceGroupRecord,
  type DeviceRecord,
} from './fleet.js';
import { JamfPlatformApiError, JamfPlatformClient } from './platform-client.js';
import {
  buildGroupDependencyGraph,
  findGroupBlastRadius,
  findGroupDependencyCycles,
  findObjectReferences,
} from './references.js';

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
      'style "flat" omits the tenant segment and has never returned 200; rawPath is used ' +
      'verbatim after /api/{service} and is required for Classic. ' +
      'Classic is service "proclassic" with rawPath "/tenant/{tenantId}/{resource}" — no ' +
      'version segment, and no /JSSResource/ prefix, which does not exist on the gateway. ' +
      'The service segment may be more than one segment: Declaration Reporting is "ddm/report". ' +
      'Jamf Pro versions are per-resource (account-groups v1, enrollment v3, ' +
      'computers-inventory v4) — do not assume v1. ' +
      'READ-ONLY BY DESIGN: this tool issues GET and nothing else, and offers no method or ' +
      'body parameter. Writes go through named typed tools with narrow schemas, never through ' +
      'the passthrough, because a passthrough write is unreviewable — method, path and body ' +
      'would all be composed by the caller with nothing to constrain them. See JPM-0007.',
    inputSchema: {
      service: z.string().describe('Gateway service segment, e.g. "blueprints", "devices"'),
      resource: z.string().optional().describe('Resource path, e.g. "blueprints". Omit if using rawPath.'),
      rawPath: z
        .string()
        .optional()
        .describe(
          'Path after /api/{service}, used verbatim. Required for Classic, where it is ' +
            '"/tenant/{tenantId}/{resource}" — e.g. "/tenant/{tenantId}/scripts". Nothing is ' +
            'inserted, so the tenant segment must be included; a path without it answers 400.',
        ),
      style: z.enum(['tenant', 'flat']).optional().describe('Path layout; defaults to "tenant"'),
      version: z.string().optional().describe('Version segment, defaults to "v1". Per-resource on Jamf Pro.'),
      query: z.record(z.string(), z.string()).optional().describe('Query string parameters'),
    },
  },
  // No `method` or `body` parameter, deliberately. JAMF_READ_ONLY would refuse a write
  // today, but it is one env-var check away from permitting one, and a write deployment
  // has cleared that var by definition — so the flag cannot be what makes the passthrough
  // safe. Omitting the parameters means the tool has no way to express a mutation at all,
  // which is the guarantee JPM-0007 wanted. `method` is pinned rather than left to default
  // so this stays true if the client's default ever changes.
  async ({ service, resource, rawPath, style, version, query }) => {
    try {
      return asContent(
        await client.request({ service, resource, rawPath, style, version, query, method: 'GET' }),
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

/**
 * Fetches a Jamf Pro Classic collection and unwraps its named-key envelope.
 *
 * Module-level because three tools now need it and each had grown its own copy —
 * `classicList` and `classicList2` differed only in scope, and a third would have
 * become `classicList3`.
 *
 * Classic wraps a collection in the PLURAL key in JSON (`{"scripts": [...]}`) while
 * the reference pages document the singular XML element plus a `size` count. Both
 * spellings are tried, and a shape that matches neither throws rather than yielding
 * an empty list — a false all-clear from an auditing tool is worse than an error.
 */
async function classicList<T>(resource: string, keys: string[]): Promise<T[]> {
  const body = await client.request<Record<string, unknown>>({
    service: 'proclassic',
    rawPath: `/tenant/${config.tenantId}/${resource}`,
  });
  return extractClassicList<T>(body, keys).items;
}

/** Fetches one Classic record by id and unwraps its singular named key. */
async function classicDetail<T>(
  resource: string,
  id: number | string,
  keys: string[],
): Promise<T | undefined> {
  const body = await client.request<Record<string, unknown>>({
    service: 'proclassic',
    rawPath: `/tenant/${config.tenantId}/${resource}/id/${id}`,
  });
  return extractClassicDetail<T>(body, keys);
}

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

    /**
     * Classic list endpoints are not paginated and wrap results in the PLURAL key
     * in JSON, though the reference pages document the singular XML element. Both
     * are tried, and an unreadable shape throws rather than yielding an empty
     * list — see extractClassicList.
     */
    try {
      const [scriptStubs, eaStubs, policyStubs] = await Promise.all([
        classicList<{ id: number; name: string }>('scripts', ['scripts', 'script']).catch((e) => {
          errors.scripts = legError(e);
          return [];
        }),
        classicList<{ id: number; name: string; enabled?: boolean }>(
          'computerextensionattributes',
          ['computer_extension_attributes', 'computer_extension_attribute'],
        ).catch((e) => {
          errors.extensionAttributes = legError(e);
          return [];
        }),
        classicList<{ id: number; name: string }>('policies', ['policies', 'policy']).catch((e) => {
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
          }>('policies', stub.id, ['policy']);
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
            ['script'],
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
          }>('computerextensionattributes', stub.id, ['computer_extension_attribute']);
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

/**
 * Reads inventory collection settings and rates them by cost.
 *
 * The companion to findExpensiveAutomations: that tool audits scripts, policies and
 * extension attributes, but `du` is often not in any script at all — Jamf computes
 * home directory sizes itself, as a tenant setting, by running `du` across every
 * user home. Nothing in the policy list reveals it.
 *
 * These options run on EVERY inventory collection, so their cost multiplies by
 * however often inventory is triggered. A policy that updates inventory at every
 * check-in turns each one into roughly every-15-minutes work.
 */
server.registerTool(
  'getInventoryCollectionSettings',
  {
    title: 'Inventory collection settings',
    description:
      'Read the tenant computer inventory collection settings and rate each option by ' +
      'how much work it adds per collection. Flags home_directory_sizes as high cost ' +
      'because Jamf computes it by running `du` across every user home directory — the ' +
      'usual cause of a du process under JamfDaemon burning battery. Pair with ' +
      'findExpensiveAutomations, which shows how often inventory is actually triggered.',
    inputSchema: {},
  },
  async () => {
    try {
      const body = await client.request<Record<string, unknown>>({
        service: 'proclassic',
        rawPath: `/tenant/${config.tenantId}/computerinventorycollection`,
      });
      const settings = extractClassicDetail<InventoryCollectionSettings>(body, [
        'computer_inventory_collection',
        'computer_inventory_collection_preferences',
      ]);
      if (!settings) {
        // Say what came back rather than reporting an empty assessment, which would
        // read as "nothing enabled".
        return asError(
          new Error(
            'could not find inventory collection settings in the response. Top-level keys: ' +
              (body && typeof body === 'object' ? Object.keys(body).join(', ') : '(none)'),
          ),
        );
      }
      const assessment = assessInventoryCollection(settings);
      // Escalations are called out separately from settings that are high by nature.
      // "High" for a custom search path is inferred from the path COUNT, not from
      // measuring the walk, so it can be a false alarm — a path pointing at one small
      // directory is cheap. `paths` carries the actual values so the rating can be
      // checked rather than taken on trust.
      const escalated = assessment.escalatedForCustomSearchPaths;
      return asContent({
        ...assessment,
        note:
          assessment.enabledHighCost.length > 0
            ? 'A high-cost option is enabled. Multiply its cost by how often inventory runs — ' +
              'check for a policy that updates inventory on every check-in.' +
              (escalated.length > 0
                ? ` ${escalated.length} of these was rated high because it has custom search ` +
                  'paths, which is inferred from the path count rather than measured — see ' +
                  'escalatedForCustomSearchPaths.paths and judge whether those directories are ' +
                  'actually large before acting on it.'
                : '')
            : 'No high-cost collection option is enabled; look at extension attributes and ' +
              'policy cadence instead.',
      });
    } catch (error) {
      return asError(error);
    }
  },
);

/**
 * Finds what actually consumes an inventory field.
 *
 * Answers "can I turn this collection setting off" — the question that decides
 * whether an expensive setting is load-bearing. Smart group criteria live in
 * Classic's `computergroups`, not the newer `device-groups` segment, which returns
 * membership without criteria.
 *
 * Advanced searches are checked on BOTH criteria and `display_fields`: a saved
 * search that merely displays a column is still a consumer, so checking filters
 * alone would report a field as unused when a report shows it every week.
 */
server.registerTool(
  'findCriteriaReferences',
  {
    title: 'Find criteria references',
    description:
      'Search smart computer group criteria, advanced computer search criteria, and ' +
      'advanced search display fields for a term — e.g. "Home Directory" to find out ' +
      'whether anything consumes that inventory field before disabling its collection. ' +
      'Matches field names and criterion values, case-insensitively. Reports what it ' +
      'did NOT check, because "no references found" is a weaker claim than a hit.',
    inputSchema: {
      query: z
        .string()
        .min(2)
        .describe('Term to look for in criterion names, criterion values and display fields'),
      concurrency: z.number().int().positive().max(16).optional().describe('Parallel detail requests. Defaults to 6.'),
    },
  },
  async ({ query, concurrency }) => {
    const parallel = concurrency ?? 6;
    const errors: Record<string, string> = {};

    // The literal query is not enough. Jamf's inventory-collection setting keys are
    // not its criterion names — `package_receipts` is queried as "Packages Installed"
    // and "Cached Packages", which share no substring with the key — so searching the
    // key alone returns zero whether or not consumers exist. That zero reads as
    // permission to disable a field something depends on.
    const expansion = expandInventoryQuery(query);

    try {
      const [groupStubs, searchStubs] = await Promise.all([
        classicList<{ id: number; name: string }>('computergroups', ['computer_groups', 'computer_group']).catch(
          (e) => {
            errors.computerGroups = legError(e);
            return [];
          },
        ),
        classicList<{ id: number; name: string }>('advancedcomputersearches', [
          'advanced_computer_searches',
          'advanced_computer_search',
        ]).catch((e) => {
          errors.advancedSearches = legError(e);
          return [];
        }),
      ]);

      let smartGroupCount = 0;

      const groupHits = await mapWithConcurrency(groupStubs, parallel, async (stub) => {
        try {
          const group = await client
            .request<Record<string, unknown>>({
              service: 'proclassic',
              rawPath: `/tenant/${config.tenantId}/computergroups/id/${stub.id}`,
            })
            .then((b) =>
              extractClassicDetail<{ name?: string; is_smart?: boolean; criteria?: JamfCriterion[] }>(b, [
                'computer_group',
              ]),
            );
          // Static groups have no criteria; counting them as scanned would overstate
          // the coverage of this search.
          if (!group?.is_smart) return null;
          smartGroupCount += 1;
          const matches = sweepCriterionMatches(group.criteria, expansion.terms);
          return matches.length > 0 ? { id: stub.id, name: group.name ?? stub.name, matches } : null;
        } catch (error) {
          errors[`computerGroup:${stub.id}`] = legError(error);
          return null;
        }
      });

      const searchHits = await mapWithConcurrency(searchStubs, parallel, async (stub) => {
        try {
          const search = await client
            .request<Record<string, unknown>>({
              service: 'proclassic',
              rawPath: `/tenant/${config.tenantId}/advancedcomputersearches/id/${stub.id}`,
            })
            .then((b) =>
              extractClassicDetail<{
                name?: string;
                criteria?: JamfCriterion[];
                display_fields?: Array<{ name?: string }>;
              }>(b, ['advanced_computer_search']),
            );
          const criteriaMatches = sweepCriterionMatches(search?.criteria, expansion.terms);
          const displayFieldMatches = sweepDisplayFieldMatches(search?.display_fields, expansion.terms);
          if (criteriaMatches.length === 0 && displayFieldMatches.length === 0) return null;
          return { id: stub.id, name: search?.name ?? stub.name, criteriaMatches, displayFieldMatches };
        } catch (error) {
          errors[`advancedSearch:${stub.id}`] = legError(error);
          return null;
        }
      });

      const smartGroups = groupHits.filter((g): g is NonNullable<typeof g> => g !== null);
      const advancedSearches = searchHits.filter((s): s is NonNullable<typeof s> => s !== null);
      const total = smartGroups.length + advancedSearches.length;

      const swept =
        expansion.terms.length > 1
          ? expansion.terms.map((t) => `"${t}"`).join(', ')
          : `"${query}"`;

      return asContent({
        query,
        // What was actually swept, not just what was asked for — a zero result is
        // only as strong as the terms behind it, so they belong in the answer.
        termsSwept: expansion.terms,
        ...(expansion.matchedSettingKey ? { matchedSettingKey: expansion.matchedSettingKey } : {}),
        ...(expansion.aliases.length > 0 ? { aliasesUsed: expansion.aliases } : {}),
        scanned: {
          computerGroups: groupStubs.length,
          ofWhichSmart: smartGroupCount,
          advancedComputerSearches: searchStubs.length,
        },
        smartGroupsReferencing: smartGroups,
        advancedSearchesReferencing: advancedSearches,
        totalReferences: total,
        // A null result here is evidence, but not proof — say what is out of scope
        // rather than letting "0 references" read as "definitely unused".
        notChecked: [
          'Jamf Pro built-in dashboards and canned reports',
          'anything querying the API directly from outside Jamf',
          'mobile device groups and searches (irrelevant for computer inventory fields)',
          'static group membership, which has no criteria to search',
          'exports or spreadsheets maintained outside Jamf',
          'Jamf criterion labels this alias map does not know about',
        ],
        verdict:
          total === 0
            ? `No smart group or advanced search references ${swept}. That is good evidence it is unused, but see notChecked before treating it as proof.` +
              (expansion.hasUnconfirmedAliases
                ? ' Weaker than usual here: some terms swept are broad-substring fallbacks whose exact Jamf criterion labels are unverified, so a miss could mean the label differs rather than that nothing consumes the field.'
                : '')
            : `${total} object(s) reference ${swept} — review them before disabling the underlying collection.`,
        ...(Object.keys(errors).length > 0 ? { partialFailures: errors } : {}),
      });
    } catch (error) {
      return asError(error);
    }
  },
);

/**
 * Declaration Reporting: what a Blueprint actually did on one device.
 *
 * Blueprints deploy declarations; this is the only route that says whether they
 * landed, and `reasons` is the only field that says why one did not. That makes it
 * the natural companion to `listBlueprints` rather than another inventory read.
 *
 * Two things about this endpoint are worth knowing before trusting its answer, and
 * both are surfaced in the response rather than left in a doc:
 *
 * 1. `filter` is REQUIRED, and Jamf documents that filters "only apply to
 *    declarations already on the device (excludes PENDING status)". So a filtered
 *    read cannot see pending declarations at all — a device mid-deployment looks
 *    emptier than it is. The tool says so instead of implying completeness.
 * 2. This group pages with `page` + `size`, not `page-size`. `requestAll` infers
 *    that from the `ddm/report` segment (see `inferPagingFamily`); getting it wrong
 *    silently caps the answer at 20 records.
 *
 * The `channels` leg is the route confirmed live against a tenant; `declarations` is
 * published and its path shape matches, but had never been called when this was
 * written — the discovery script stops at its first 200. So the legs settle
 * independently and a failure names itself, rather than one unproven route taking
 * down an answer the other could still give.
 */
server.registerTool(
  'getDeviceDeclarationState',
  {
    title: 'Get device declaration state',
    description:
      'Report the declarative device management (DDM) state for one device: which ' +
      'declarations are applied, their status and validity, and — for anything that ' +
      'failed — the reasons Jamf gives. The companion to listBlueprints, since a ' +
      'Blueprint deploys declarations and this says whether they landed. Accepts a ' +
      'device UUID, or a substring of a name, serial, model or user; an ambiguous ' +
      'substring returns candidates rather than guessing. NOTE: Jamf excludes PENDING ' +
      'declarations from any filtered read, so a device mid-deployment will look ' +
      'emptier than it is — see excludedFromThisAnswer in the result.',
    inputSchema: {
      device: z
        .string()
        .min(1)
        .describe('Device UUID, or a substring of the device name, serial, model or user id'),
      filter: z
        .string()
        .optional()
        .describe(
          'RSQL filter. Jamf requires one, so this defaults to "declarationIdentifier==*" ' +
            '(match all). Filter fields: declarationIdentifier, active, declarationType, ' +
            'validityState, dateUpdated, channel. Wildcards on declarationIdentifier are ' +
            'case-insensitive, e.g. "declarationIdentifier==Blueprint_*".',
        ),
      includeChannels: z
        .boolean()
        .optional()
        .describe('Also list the device\'s available DDM channels. Defaults to true.'),
    },
  },
  async ({ device, filter, includeChannels }) => {
    try {
      let deviceId = looksLikeUuid(device) ? device.trim() : undefined;
      let deviceName: string | undefined;
      let deviceSerial: string | null | undefined;

      if (!deviceId) {
        const all = await client.requestAll<DeviceRecord>({ service: 'devices', resource: 'devices' });
        const matches = all.filter((d) => matchesDeviceQuery(d, device));
        if (matches.length === 0) {
          return asContent({ query: device, matched: 0, hint: 'No device matched. Try findDevices.' });
        }
        if (matches.length > 1) {
          // Declaration state is per-device and the answer differs between them, so
          // guessing would confidently describe the wrong Mac.
          return asContent({
            query: device,
            matched: matches.length,
            hint: 'Ambiguous — re-run with one of these ids or a more specific substring.',
            candidates: matches.slice(0, 25).map((d) => ({
              id: d.id,
              name: d.name,
              serialNumber: d.serialNumber,
              model: d.model,
            })),
            ...(matches.length > 25 ? { candidatesTruncated: matches.length - 25 } : {}),
          });
        }
        deviceId = matches[0]?.id;
        deviceName = matches[0]?.name;
        deviceSerial = matches[0]?.serialNumber;
        if (!deviceId) return asError(new Error('matched device has no id'));
      }

      const rsql = filter ?? 'declarationIdentifier==*';
      const errors: Record<string, string> = {};

      const [declarationsLeg, channelsLeg] = await Promise.allSettled([
        // requestAll infers the `size` paging family from the ddm/report segment.
        client.requestAll<DeclarationRecord>({
          service: 'ddm/report',
          resource: `devices/${deviceId}/declarations`,
          query: { filter: rsql },
        }),
        includeChannels === false
          ? Promise.resolve<string[]>([])
          : client
              .request<{ deviceId?: string; channels?: string[] }>({
                service: 'ddm/report',
                resource: `devices/${deviceId}/channels`,
              })
              .then((b) => b?.channels ?? []),
      ]);

      if (declarationsLeg.status === 'rejected') errors.declarations = legError(declarationsLeg.reason);
      if (channelsLeg.status === 'rejected') errors.channels = legError(channelsLeg.reason);

      // An audit that cannot read its input must not report a clean bill of health.
      if (declarationsLeg.status === 'rejected' && channelsLeg.status === 'rejected') {
        return asError(
          new Error(
            'both Declaration Reporting legs failed, so nothing is known about this ' +
              `device's declaration state: ${JSON.stringify(errors)}`,
          ),
        );
      }

      const declarations = declarationsLeg.status === 'fulfilled' ? declarationsLeg.value : [];
      const summary = summarizeDeclarations(declarations);

      return asContent({
        device: {
          id: deviceId,
          ...(deviceName ? { name: deviceName } : {}),
          ...(deviceSerial ? { serialNumber: deviceSerial } : {}),
        },
        filter: rsql,
        ...(declarationsLeg.status === 'fulfilled' ? summary : { declarationsUnavailable: true }),
        ...(channelsLeg.status === 'fulfilled' && channelsLeg.value.length > 0
          ? { channels: channelsLeg.value }
          : {}),
        // Stated in the answer, not just the docs: a filtered read cannot see PENDING,
        // so "no failures" here does not mean "fully deployed".
        excludedFromThisAnswer: [
          'PENDING declarations — Jamf applies filters only to declarations already on ' +
            'the device, and a filter is required, so anything still awaiting delivery is ' +
            'invisible here. A quiet result does not mean deployment finished.',
          ...(includeChannels === false ? ['channels, not requested'] : []),
        ],
        verdict:
          declarationsLeg.status !== 'fulfilled'
            ? 'Declaration state could not be read; see partialFailures.'
            : summary.failed.length > 0
              ? `${summary.failed.length} of ${summary.total} declaration(s) failed or are invalid — see failed[].reasons.`
              : summary.total === 0
                ? 'No declarations matched. Either none are deployed to this device, or all of them are still PENDING and therefore excluded by the filter.'
                : `All ${summary.total} matched declaration(s) report healthy, excluding anything PENDING.`,
        ...(Object.keys(errors).length > 0 ? { partialFailures: errors } : {}),
      });
    } catch (error) {
      return asError(error);
    }
  },
);

/**
 * Declaration Reporting, the other direction: one declaration across the fleet.
 *
 * `getDeviceDeclarationState` answers "is this Mac healthy". This answers "this
 * declaration — which Macs did it fail on, and why" — the question Jamf Nation
 * reports the UI cannot answer at all ("there doesn't seem to be any way in the Jamf
 * Pro UI to see which devices are in different statuses").
 *
 * The records carry bare `deviceId` UUIDs, so on their own they answer "how many"
 * and never "which". The device list is joined in to make the answer actionable, and
 * a failing leg there degrades identification rather than the whole answer.
 */
server.registerTool(
  'getDeclarationScope',
  {
    title: 'Get declaration scope',
    description:
      'Report every device reporting a given DDM declaration, with its status, ' +
      'validity and — for failures — the reasons Jamf gives, grouped so one cause ' +
      'affecting forty Macs reads as one problem rather than forty. Devices are ' +
      'resolved to names and serials, since the API returns bare UUIDs. The inverse of ' +
      'getDeviceDeclarationState. NOTE: Jamf excludes PENDING declarations from any ' +
      'filtered read and a filter is required, so devices still awaiting delivery are ' +
      'invisible — an all-healthy answer is NOT proof of full deployment. See ' +
      'excludedFromThisAnswer in the result.',
    inputSchema: {
      declaration: z
        .string()
        .min(1)
        .describe('The declarationIdentifier, e.g. "Blueprint_FileVault". Exact, not a substring.'),
      filter: z
        .string()
        .optional()
        .describe(
          'RSQL filter. Jamf requires one, so this defaults to "active==true,active==false" — ' +
            'an OR across both boolean values, which is the nearest thing to a match-all this ' +
            'route has. Do NOT use a wildcard like "deviceId==*": wildcards are supported only ' +
            'on declarationIdentifier, which is not filterable here, so that matches nothing ' +
            'and still returns 200. ' +
            'Allowed fields on THIS route: deviceId, channel, lastReportTime, active, ' +
            'validityState, declarationType, dateUpdated. Note declarationIdentifier is NOT ' +
            'among them — it lives in the path here, unlike on getDeviceDeclarationState.',
        ),
    },
  },
  async ({ declaration, filter }) => {
    try {
      // `active==true,active==false` is an RSQL OR across every value a boolean can
      // hold, which is the closest thing to a match-all this route has. It was found
      // by experiment, not documentation.
      //
      // It replaces `deviceId==*`, which returned 200 with ZERO rows for a declaration
      // a device was simultaneously confirmed to be reporting as SUCCESSFUL. Jamf
      // documents wildcard support for `declarationIdentifier` only — a field that is a
      // path segment here rather than a filterable one — so a wildcard on `deviceId`
      // compares UUIDs against a literal "*" and matches nothing, without erroring.
      //
      // `channel==SYSTEM` returns the same rows on a tenant with no user-channel
      // records, and was rejected as the default precisely because it would silently
      // hide them on a tenant that has them.
      //
      // Caveat: if `active` is ever absent rather than true or false, those rows fall
      // outside both arms of the OR. Unobserved so far, and no filter that avoids the
      // problem is known.
      const rsql = filter ?? 'active==true,active==false';
      const errors: Record<string, string> = {};

      const [declLeg, deviceLeg] = await Promise.allSettled([
        // requestAll infers the `size` paging family from the ddm/report segment;
        // passing page-size here would be ignored and silently cap this at 20.
        // encodeURIComponent because buildUrl does not escape `resource` — a
        // declaration identifier containing a slash would otherwise change the route.
        client.requestAll<DeclarationRecord>({
          service: 'ddm/report',
          resource: `declarations/${encodeURIComponent(declaration)}/devices`,
          query: { filter: rsql },
        }),
        client.requestAll<DeviceRecord>({ service: 'devices', resource: 'devices' }),
      ]);

      if (declLeg.status === 'rejected') {
        // Same posture as getDeviceDeclarationState: an audit that cannot read its
        // input must not report a clean bill of health.
        return asError(
          new Error(
            `could not read declaration state for "${declaration}": ${legError(declLeg.reason)}`,
          ),
        );
      }
      if (deviceLeg.status === 'rejected') errors.devices = legError(deviceLeg.reason);

      const report = summarizeDeclarationScope(
        declLeg.value,
        deviceLeg.status === 'fulfilled' ? deviceLeg.value : [],
        { declarationIdentifier: declaration, filter: rsql },
      );

      return asContent({
        ...report,
        ...(Object.keys(errors).length > 0 ? { partialFailures: errors } : {}),
      });
    } catch (error) {
      return asError(error);
    }
  },
);

/**
 * "What breaks if I delete this?" — the question Jamf has no built-in answer to.
 *
 * Jamf Nation, on finding dependants before a delete: "There is no built-in feature
 * for this, which is why there have been feature requests." Two community tools grew
 * to fill it — Prune, which deletes, and Spruce, archived in 2023. This project can
 * never delete anything (JPM-0007), so it builds the read-only half, which is also
 * the half nobody maintains.
 *
 * Prune's published caveat is the bar to clear: it "may identify some items as unused
 * that are actually in use due to API limitations." So coverage is a typed field here,
 * not prose. `strength` reaches `'clear'` only when every source kind in the matrix
 * was supplied AND every object read had a container this code could parse; anything
 * less is `'partial-clear'`, and reading nothing is `'unchecked'` — explicitly not a
 * shade of "no references found".
 *
 * Only three source kinds are wired to live routes, because only three are confirmed
 * reachable on this gateway. `osxconfigurationprofiles` is wired on the strength of
 * its own reference page (path shape confirmed, envelope key unverified) and settles
 * on first call. The rest are declared unavailable with a reason rather than probed
 * blind — CLAUDE.md requires reading an endpoint's page before probing it, and
 * guessing four resource paths is exactly what produced JPM-0005.
 */
server.registerTool(
  'findObjectReferences',
  {
    title: 'Find what references an object',
    description:
      'Find everything that references a package, computer group or script — the ' +
      'check to run before deleting or changing one. Reports where each reference ' +
      'sits (scope, exclusion, script slot, group criterion) and distinguishes an ' +
      'EXCLUSION from an inclusion, since those mean opposite things. Names are ' +
      'matched exactly and case-insensitively, never as substrings. Critically, it ' +
      'reports which source kinds it could NOT check and what that means: a "clear" ' +
      'verdict requires full coverage, so most answers are partial-clear and must not ' +
      'be read as permission to delete. Coverage is in the `strength` field.',
    inputSchema: {
      kind: z.enum(['package', 'computerGroup', 'script']).describe('What kind of object to look for references to'),
      id: z.string().optional().describe('The object id. Supply this, or name, or both.'),
      name: z.string().optional().describe('The object name, matched exactly (case-insensitively)'),
      concurrency: z.number().int().positive().max(16).optional().describe('Parallel detail requests. Defaults to 6.'),
    },
  },
  async ({ kind, id, name, concurrency }) => {
    const parallel = concurrency ?? 6;
    const errors: Record<string, string> = {};

    /** Fetches a Classic collection's details, or describes why it could not. */
    async function classicSource(
      label: string,
      resource: string,
      listKeys: string[],
      detailKeys: string[],
    ): Promise<unknown[] | { unavailable: true; reason: string }> {
      try {
        const stubs = await classicList<{ id: number; name: string }>(resource, listKeys);
        const details = await mapWithConcurrency(stubs, parallel, async (stub) => {
          try {
            return await classicDetail<unknown>(resource, stub.id, detailKeys);
          } catch (error) {
            // One unreadable record must not fail the sweep, but it must not read as
            // "no reference here" either — it lands in the unreadable count.
            errors[`${label}:${stub.id}`] = legError(error);
            return undefined;
          }
        });
        return details.filter((d): d is unknown => d !== undefined);
      } catch (error) {
        const reason = legError(error);
        errors[label] = reason;
        // Never [] on failure: an empty collection reads as "checked, nothing found".
        return { unavailable: true, reason };
      }
    }

    try {
      const [policies, groups, searches, profiles] = await Promise.all([
        classicSource('policies', 'policies', ['policies', 'policy'], ['policy']),
        classicSource('computergroups', 'computergroups', ['computer_groups', 'computer_group'], ['computer_group']),
        classicSource(
          'advancedcomputersearches',
          'advancedcomputersearches',
          ['advanced_computer_searches', 'advanced_computer_search'],
          ['advanced_computer_search'],
        ),
        // Path shape confirmed from its own reference page; the envelope key is the
        // documented XML singular, so both spellings are offered and the first live
        // call settles which one Classic actually returns in JSON.
        classicSource(
          'osxconfigurationprofiles',
          'osxconfigurationprofiles',
          ['os_x_configuration_profiles', 'os_x_configuration_profile'],
          ['os_x_configuration_profile'],
        ),
      ]);

      const unverified = (what: string) => ({
        unavailable: true as const,
        reason:
          `not checked: the ${what} route has not been confirmed reachable on this gateway, ` +
          'and its reference page has not been read. Probing without reading the page is what ' +
          'produced JPM-0005, so it is left unchecked rather than guessed.',
      });

      const report = findObjectReferences(
        { kind, id, name },
        {
          policies,
          computerGroups: groups,
          advancedComputerSearches: searches,
          configurationProfiles: profiles,
          restrictedSoftware: unverified('restrictedsoftware'),
          patchPolicies: unverified('patchpolicies'),
          eBooks: unverified('ebooks'),
          appInstallers: unverified('app-installers'),
          computerPrestages: unverified('Jamf Pro API computer-prestages'),
          blueprints: unverified("blueprints group-scope container shape"),
          // Both are readable — findExpensiveAutomations already pulls script_contents
          // and input_type.script — but finding a script invoked from another script's
          // body means substring-searching contents, which produces false positives on
          // any common word. Declared unchecked so a script target cannot reach
          // 'clear', rather than answered with a bad heuristic.
          scriptBodies: {
            unavailable: true as const,
            reason:
              'not checked: detecting a script invoked from inside another script means ' +
              'substring-searching script contents, which this module refuses to do for names. ' +
              'Scan script bodies with findExpensiveAutomations if a script reports no policy ' +
              'reference but you suspect a wrapper calls it.',
          },
          computerExtensionAttributeScripts: {
            unavailable: true as const,
            reason:
              'not checked: extension attribute scripts are readable (input_type.script) but ' +
              'are not yet scanned for invocations of another script.',
          },
        },
      );

      return asContent({
        ...report,
        ...(Object.keys(errors).length > 0 ? { partialFailures: errors } : {}),
      });
    } catch (error) {
      return asError(error);
    }
  },
);

/**
 * Smart-group dependency graph: cycles, dangling references, and blast radius.
 *
 * A Jamf Nation audit turned up "over 20 smart groups that include other smart groups
 * that are dependent on the first." The UI cannot show this shape at all, and the data
 * is right there — a criterion named `Computer Group` carries the referenced group's
 * NAME in its value.
 *
 * Both routes here are confirmed reachable, which makes this the safer of the two
 * reference tools. `is_smart` and `criteria` come only from the detail record, never
 * the list, so every group costs a request.
 */
server.registerTool(
  'findGroupDependencies',
  {
    title: 'Find smart group dependencies',
    description:
      'Map which computer groups depend on which others, via "Computer Group" ' +
      'membership criteria. Reports dependency cycles as their actual node paths, ' +
      'references to group names that do not exist, and — given a group — its blast ' +
      'radius: everything that transitively changes when that group\'s membership ' +
      'changes, with depth. A "not member of" criterion is reported distinctly from ' +
      '"member of", since treating one as the other inverts the meaning. Groups whose ' +
      'detail could not be fetched are named, because a group absent from the graph ' +
      'must not read as independent.',
    inputSchema: {
      group: z
        .string()
        .optional()
        .describe('Optional: a group name to compute a blast radius for. Omit for the whole graph.'),
      concurrency: z.number().int().positive().max(16).optional().describe('Parallel detail requests. Defaults to 6.'),
    },
  },
  async ({ group, concurrency }) => {
    const parallel = concurrency ?? 6;
    const errors: Record<string, string> = {};

    try {
      const stubs = await classicList<{ id: number; name: string }>('computergroups', [
        'computer_groups',
        'computer_group',
      ]);

      const details = (
        await mapWithConcurrency(stubs, parallel, async (stub) => {
          try {
            return await classicDetail<unknown>('computergroups', stub.id, ['computer_group']);
          } catch (error) {
            errors[`computerGroup:${stub.id}`] = legError(error);
            return undefined;
          }
        })
      ).filter((d): d is unknown => d !== undefined);

      const graph = buildGroupDependencyGraph(details);
      const cycles = findGroupDependencyCycles(graph);
      const radius = group ? findGroupBlastRadius(graph, group) : undefined;

      return asContent({
        scanned: { groupsListed: stubs.length, detailsRead: details.length },
        graph: { nodes: graph.nodes, edges: graph.edges },
        dangling: graph.dangling,
        unreadable: graph.unreadable,
        duplicateNames: graph.duplicateNames,
        cycles,
        ...(radius ? { blastRadius: radius } : {}),
        // A group whose detail failed is missing from the graph entirely, and its
        // absence would otherwise read as "depends on nothing".
        ...(details.length < stubs.length
          ? {
              incomplete:
                `${stubs.length - details.length} group(s) could not be read and are ABSENT from ` +
                'this graph. Their dependencies are unknown, not empty — see partialFailures.',
            }
          : {}),
        ...(Object.keys(errors).length > 0 ? { partialFailures: errors } : {}),
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
