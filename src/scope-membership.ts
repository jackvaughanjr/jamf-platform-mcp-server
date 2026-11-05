import { createHash } from 'node:crypto';

import { z } from 'zod';

import { extractClassicDetail } from './automations.js';
import type { JamfPlatformClient } from './platform-client.js';
import { TARGET_KEYS, readIds, targetsXml, type ScopeTargets, type WriteContext } from './restricted-software.js';

/**
 * Computer-group scope membership for macOS configuration profiles and policies
 * (JPM-0009): add one computer group to an object's scope, or remove it, one object
 * per call.
 *
 * Classic has no "add to scope" operation: a scope is changed by PUTting the whole
 * `<scope>`. So these tools read the live scope, change one list, and send the full
 * scope back as the ONLY child of the root element. They never send general,
 * payloads, self_service, scripts or packages. That scope-only PUT is not verified
 * to leave the rest of the object alone until the first-use canary gate in JPM-0009
 * has been run, which is why every live write fingerprints the non-scope parts
 * before and after and reports whether they changed.
 *
 * Fail closed: any scope member this module does not model and that is non-empty
 * refuses the call, because replace semantics would silently drop it.
 */

export const SERVICE = 'proclassic';

export type ScopeKind = 'profile' | 'policy';
export type ScopeAction = 'add' | 'remove';

export interface KindSpec {
  noun: string;
  resource: string;
  envelope: string;
  addTool: string;
  removeTool: string;
}

export const KINDS: Record<ScopeKind, KindSpec> = {
  profile: {
    noun: 'configuration profile',
    resource: 'osxconfigurationprofiles',
    envelope: 'os_x_configuration_profile',
    addTool: 'addComputerGroupToProfileScope',
    removeTool: 'removeComputerGroupFromProfileScope',
  },
  policy: {
    noun: 'policy',
    resource: 'policies',
    envelope: 'policy',
    addTool: 'addComputerGroupToPolicyScope',
    removeTool: 'removeComputerGroupFromPolicyScope',
  },
};

/** Strict: no other fields are accepted. */
export const scopeMembershipInputSchema = z.strictObject({
  id: z.number().int().positive().describe('Classic id of the configuration profile or policy'),
  computerGroupId: z.number().int().positive().describe('Classic id of the computer group (static or smart)'),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'Defaults to TRUE. A dry run performs the reads, returns the exact XML and the change, and ' +
        'writes nothing. Pass false only after the dry run has been reviewed.',
    ),
});

export type ScopeMembershipInput = z.infer<typeof scopeMembershipInputSchema>;

export interface MembershipScope extends ScopeTargets {
  allComputers: boolean;
  exclusions: ScopeTargets;
}

export interface LiveScopedObject {
  id: number;
  scope: MembershipScope;
  /** Non-empty scope members this module does not model, by path. */
  unmodelledScope: string[];
  redeployOnUpdate?: string;
  distributionMethod?: string;
  /** The object with `scope` removed: the part a scope-only PUT must leave alone. */
  nonScope: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** True when a scope member holds something. `false`, "", "false" and empty containers are empty. */
export function holdsValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some(holdsValue);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value !== '' && value.toLowerCase() !== 'false';
  return true; // a number or anything else: treat as present
}

function readFlag(value: unknown, path: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'false') return value === 'true';
  throw new Error(`${path} is ${JSON.stringify(value)}, not a boolean. Refusing to guess the scope.`);
}

const PLURALS = TARGET_KEYS.map(([, plural]) => plural);

function readTargets(raw: Record<string, unknown>, path: string, known: string[], unmodelled: string[]): ScopeTargets {
  const targets = {} as ScopeTargets;
  for (const [field, plural, singular] of TARGET_KEYS) {
    targets[field] = readIds(raw[plural], singular, `${path}.${plural}`);
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!known.includes(key) && holdsValue(value)) unmodelled.push(`${path}.${key}`);
  }
  return targets;
}

export function parseLiveScoped(body: unknown, kind: ScopeKind, id: number): LiveScopedObject {
  const spec = KINDS[kind];
  const detail = extractClassicDetail<Record<string, unknown>>(body as Record<string, unknown>, [spec.envelope]);
  if (!detail || typeof detail !== 'object') {
    const keys = body && typeof body === 'object' ? Object.keys(body).join(', ') : typeof body;
    throw new Error(`${spec.noun} ${id}: unexpected response shape (no ${spec.envelope}; got ${keys}).`);
  }
  const rawScope = detail.scope as Record<string, unknown> | undefined;
  if (!rawScope || typeof rawScope !== 'object') {
    throw new Error(`${spec.noun} ${id}: the response has no scope. Refusing to guess it.`);
  }

  const unmodelled: string[] = [];
  const inclusions = readTargets(rawScope, 'scope', ['all_computers', 'exclusions', ...PLURALS], unmodelled);
  const rawExclusions = rawScope.exclusions;
  const exclusions = readTargets(
    rawExclusions && typeof rawExclusions === 'object' ? (rawExclusions as Record<string, unknown>) : {},
    'scope.exclusions',
    PLURALS,
    unmodelled,
  );
  // An all_computers that cannot be read is an error, not "false": it is the field that
  // decides whether a scope edit is meaningful at all.
  const allComputers = readFlag(rawScope.all_computers, 'scope.all_computers');
  // `all_jss_users` and friends are caught by readTargets above (unknown + non-empty).

  const general = (detail.general ?? {}) as Record<string, unknown>;
  const nonScope: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) if (key !== 'scope') nonScope[key] = value;

  return {
    id,
    scope: { allComputers, ...inclusions, exclusions },
    unmodelledScope: unmodelled,
    redeployOnUpdate: typeof general.redeploy_on_update === 'string' ? general.redeploy_on_update : undefined,
    distributionMethod: typeof general.distribution_method === 'string' ? general.distribution_method : undefined,
    nonScope,
  };
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/**
 * The whole request body: the root element with ONE child, the full modelled scope.
 * `all_computers` is always false here because the operations refuse an all-computers
 * scope before reaching this point.
 */
export function buildScopeOnlyXml(kind: ScopeKind, scope: MembershipScope): string {
  const root = KINDS[kind].envelope;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<${root}>`,
    '  <scope>',
    `    <all_computers>${scope.allComputers}</all_computers>`,
    ...targetsXml(scope, '    '),
    '    <exclusions>',
    ...targetsXml(scope.exclusions, '      '),
    '    </exclusions>',
    '  </scope>',
    `</${root}>`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Fingerprint of everything except scope. Hashes only: payload content (a profile's
// general includes its payloads, which can hold secrets) is never returned or logged.
// ---------------------------------------------------------------------------

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export interface Fingerprint {
  overall: string;
  sections: Record<string, string>;
}

export function fingerprintNonScope(nonScope: Record<string, unknown>): Fingerprint {
  const sections: Record<string, string> = {};
  for (const key of Object.keys(nonScope).sort()) sections[key] = sha256(canonical(nonScope[key]));
  return { overall: sha256(canonical(sections)), sections };
}

/** Top-level sections whose hash differs, or that appeared or disappeared. */
export function differingSections(before: Fingerprint, after: Fingerprint): string[] {
  const keys = new Set([...Object.keys(before.sections), ...Object.keys(after.sections)]);
  return [...keys].filter((k) => before.sections[k] !== after.sections[k]).sort();
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

export interface GroupInfo {
  id: number;
  name: string;
  isSmart: boolean;
}

export async function fetchGroup(client: JamfPlatformClient, groupId: number): Promise<GroupInfo> {
  let body: unknown;
  try {
    body = await client.request({
      service: SERVICE,
      style: 'classic',
      resource: `computergroups/id/${groupId}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\(404\b/.test(message)) {
      throw new Error(`Computer group ${groupId} does not exist (${message}). Nothing was changed.`);
    }
    throw error;
  }
  const detail = extractClassicDetail<Record<string, unknown>>(body as Record<string, unknown>, ['computer_group']);
  if (!detail || typeof detail.name !== 'string') {
    throw new Error(
      `Computer group ${groupId}: unexpected response shape (no computer_group.name). Nothing was changed.`,
    );
  }
  return {
    id: groupId,
    name: detail.name,
    isSmart: readFlag(detail.is_smart, 'computer_group.is_smart'),
  };
}

export async function fetchLive(client: JamfPlatformClient, kind: ScopeKind, id: number): Promise<LiveScopedObject> {
  const body = await client.request({
    service: SERVICE,
    style: 'classic',
    resource: `${KINDS[kind].resource}/id/${id}`,
  });
  return parseLiveScoped(body, kind, id);
}

const ids = (scope: MembershipScope): Record<string, number[]> => {
  const out: Record<string, number[]> = {};
  for (const [field] of TARGET_KEYS) {
    out[`scope.${field}`] = scope[field];
    out[`scope.exclusions.${field}`] = scope.exclusions[field];
  }
  return out;
};

export function scopeMismatches(intended: MembershipScope, stored: LiveScopedObject) {
  const a = ids(intended);
  const b = ids(stored.scope);
  const out: Array<{ field: string; sent: unknown; stored: unknown }> = Object.keys(a)
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .map((field) => ({ field, sent: a[field], stored: b[field] }));
  if (stored.scope.allComputers !== intended.allComputers) {
    out.push({
      field: 'scope.allComputers',
      sent: intended.allComputers,
      stored: stored.scope.allComputers,
    });
  }
  for (const path of stored.unmodelledScope) out.push({ field: path, sent: 'empty', stored: 'non-empty' });
  return out;
}

export async function changeScopeMembership(
  ctx: WriteContext,
  kind: ScopeKind,
  action: ScopeAction,
  rawInput: ScopeMembershipInput,
) {
  const input = scopeMembershipInputSchema.parse(rawInput);
  const spec = KINDS[kind];
  const { id, computerGroupId } = input;

  const live = await fetchLive(ctx.client, kind, id);
  const group = await fetchGroup(ctx.client, computerGroupId);

  if (live.scope.allComputers) {
    throw new Error(
      `${spec.noun} ${id} is scoped to All Computers. Adding or removing a group is meaningless there, ` +
        'and re-emitting that scope is not something this tool does. Refused; nothing was changed.',
    );
  }
  if (live.unmodelledScope.length > 0) {
    throw new Error(
      `${spec.noun} ${id}'s live scope uses ${live.unmodelledScope.join(', ')}, which this tool does not ` +
        'model. Sending the scope would silently drop it. Refused; make this change in the Jamf UI.',
    );
  }
  if (kind === 'profile' && live.redeployOnUpdate !== 'Newly Assigned') {
    throw new Error(
      `Configuration profile ${id} has redeploy_on_update ${JSON.stringify(live.redeployOnUpdate)}, not exactly ` +
        '"Newly Assigned". Whether a scope update would redeploy the profile to every scoped Mac is ' +
        'unverified, so this tool refuses (JPM-0009). Change it in the Jamf UI.',
    );
  }

  const present = live.scope.computerGroupIds.includes(computerGroupId);
  if (action === 'add' && present) {
    throw new Error(
      `Computer group ${computerGroupId} ("${group.name}") is already in ${spec.noun} ${id}'s scope. Nothing to add.`,
    );
  }
  if (action === 'remove' && !present) {
    throw new Error(
      `Computer group ${computerGroupId} ("${group.name}") is not in ${spec.noun} ${id}'s scope. Nothing to remove.`,
    );
  }

  const afterIds =
    action === 'add'
      ? [...live.scope.computerGroupIds, computerGroupId].sort((x, y) => x - y)
      : live.scope.computerGroupIds.filter((g) => g !== computerGroupId);
  const intended: MembershipScope = {
    ...live.scope,
    computerGroupIds: afterIds,
  };
  const xml = buildScopeOnlyXml(kind, intended);

  const warnings: string[] = [];
  if (kind === 'profile') {
    warnings.push(`Live redeploy_on_update is "${live.redeployOnUpdate}".`);
    if (live.distributionMethod && /self service/i.test(live.distributionMethod)) {
      warnings.push(
        `Distribution method is "${live.distributionMethod}": a scope change changes who can see and install it in Self Service.`,
      );
    }
  } else {
    warnings.push('Changing a policy scope changes which Macs run it at their next matching trigger and frequency.');
  }
  if (live.scope.exclusions.computerGroupIds.includes(computerGroupId)) {
    warnings.push(
      `Group ${computerGroupId} is also in this ${spec.noun}'s exclusions; exclusions win, and this change does not touch them.`,
    );
  }

  const inverseTool = action === 'add' ? spec.removeTool : spec.addTool;
  const before = fingerprintNonScope(live.nonScope);
  const plan = {
    action: `${action}ComputerGroup` as const,
    resource: `${spec.resource}/id/${id}`,
    id,
    group,
    changes: [
      {
        field: 'scope.computerGroupIds',
        before: live.scope.computerGroupIds,
        after: afterIds,
      },
    ],
    warnings,
    xml,
  };

  if (input.dryRun !== false) {
    return {
      dryRun: true,
      ...plan,
      nonScopeFingerprint: before,
      next: 'Nothing was written. Call again with dryRun false to apply this change.',
    };
  }
  if (!ctx.writesEnabled) {
    throw new Error(
      'Writes are disabled: JAMF_READ_ONLY is not "false" for this server. The dry run is still available. ' +
        'The write server is meant to run under its own integration with JAMF_READ_ONLY=false (JPM-0008).',
    );
  }

  const writtenAt = (ctx.now?.() ?? new Date()).toISOString();
  console.error(
    `[jamf-platform-write] ${writtenAt} ${action} computer group ${computerGroupId} ${action === 'add' ? 'to' : 'from'} ${spec.noun} ${id} scope`,
  );
  await ctx.client.request({
    service: SERVICE,
    style: 'classic',
    resource: `${spec.resource}/id/${id}`,
    method: 'PUT',
    body: xml,
    bodyFormat: 'xml',
  });

  const rollback = {
    tool: inverseTool,
    arguments: { id, computerGroupId, dryRun: false },
    effect: `${action === 'add' ? 'Removes' : 'Re-adds'} computer group ${computerGroupId} ${action === 'add' ? 'from' : 'to'} the scope.`,
  };

  let verification: Record<string, unknown>;
  let otherFieldsUnchanged: boolean;
  let differing: string[];
  try {
    const stored = await fetchLive(ctx.client, kind, id);
    const mismatches = scopeMismatches(intended, stored);
    verification = {
      verified: mismatches.length === 0,
      mismatches,
      storedComputerGroupIds: stored.scope.computerGroupIds,
    };
    differing = differingSections(before, fingerprintNonScope(stored.nonScope));
    otherFieldsUnchanged = differing.length === 0;
  } catch (error) {
    verification = {
      verified: false,
      mismatches: [],
      readBackError:
        `The write returned success but reading it back failed: ${error instanceof Error ? error.message : String(error)}. ` +
        `Check the ${spec.noun} in Jamf before relying on it.`,
    };
    otherFieldsUnchanged = false;
    differing = ['unknown: read-back failed'];
  }

  return {
    dryRun: false,
    ...plan,
    writtenAt,
    verification,
    otherFieldsUnchanged,
    differingSections: differing,
    rollback,
  };
}

export const addComputerGroupToProfileScope = (ctx: WriteContext, i: ScopeMembershipInput) =>
  changeScopeMembership(ctx, 'profile', 'add', i);
export const removeComputerGroupFromProfileScope = (ctx: WriteContext, i: ScopeMembershipInput) =>
  changeScopeMembership(ctx, 'profile', 'remove', i);
export const addComputerGroupToPolicyScope = (ctx: WriteContext, i: ScopeMembershipInput) =>
  changeScopeMembership(ctx, 'policy', 'add', i);
export const removeComputerGroupFromPolicyScope = (ctx: WriteContext, i: ScopeMembershipInput) =>
  changeScopeMembership(ctx, 'policy', 'remove', i);
