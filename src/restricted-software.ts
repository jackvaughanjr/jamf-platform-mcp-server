import { z } from 'zod';

import { extractClassicDetail, extractClassicList } from './automations.js';
import type { JamfPlatformClient } from './platform-client.js';

/**
 * Restricted Software create and update — the first writes this project makes
 * (JPM-0008). Everything here exists because the prior art's version of these two
 * tools hard-coded an all-computers scope, reset scope and settings on update, and
 * sent a shape Jamf rejected. Each rule below answers one of those defects, so
 * "simplifying" one away reopens it.
 *
 * Classic over the gateway: `proclassic`, style `classic`, no version segment. The
 * create and update operation pages publish no request body, so the XML shape is
 * the GET schema's (`general` + `scope`) and is unverified until the first live
 * write. The list and detail envelopes are both the SINGULAR `restricted_software`
 * (docs/gateway-reference.md).
 */

const SERVICE = 'proclassic';
const ENVELOPE = 'restricted_software';

/**
 * Shortest process name accepted when exact matching is off.
 *
 * With `match_exact_process_name` false, Jamf kills any process whose name
 * CONTAINS the string, and with `delete_executable` deletes it too. "Install macOS"
 * is the intended use; "app" or "s" would kill half the fleet's software. Six is a
 * judgement, not a Jamf limit: long enough to stop a stray fragment, short enough
 * for a real product name.
 */
export const MIN_SUBSTRING_PROCESS_NAME = 6;

export interface ScopeTargets {
  computerIds: number[];
  computerGroupIds: number[];
  buildingIds: number[];
  departmentIds: number[];
}

export interface RestrictedSoftwareScope extends ScopeTargets {
  allComputers: boolean;
  exclusions: ScopeTargets;
}

export interface RestrictedSoftwareGeneral {
  name: string;
  processName: string;
  matchExactProcessName: boolean;
  sendNotification: boolean;
  killProcess: boolean;
  deleteExecutable: boolean;
  displayMessage: string;
}

export interface RestrictedSoftwareState {
  general: RestrictedSoftwareGeneral;
  scope: RestrictedSoftwareScope;
}

export interface LiveRestrictedSoftware extends RestrictedSoftwareState {
  id: number;
  /**
   * Scope members this module does not model (user exclusions, limitations), by
   * path. Non-empty means the live scope cannot be round-tripped, so replacing it
   * would silently drop them; a scope update is refused instead.
   */
  unmodelledScope: string[];
}

// ---------------------------------------------------------------------------
// Input schemas. Nothing has a default: every value that reaches Jamf was written
// down by the caller, which is the direct answer to the prior art's defaults.
// ---------------------------------------------------------------------------

const idList = z.array(z.number().int().positive()).optional();

const targetsShape = {
  computerIds: idList.describe('Classic computer ids'),
  computerGroupIds: idList.describe('Classic computer group ids (static or smart)'),
  buildingIds: idList.describe('Building ids'),
  departmentIds: idList.describe('Department ids'),
};

export const scopeInputSchema = z.strictObject({
  allComputers: z
    .boolean()
    .describe(
      'REQUIRED, never defaulted. true applies the entry to every computer in the tenant and ' +
        'cannot be combined with inclusion targets; exclusions still apply. false scopes it to ' +
        'the targets listed, and with no targets the entry applies to nothing.',
    ),
  ...targetsShape,
  exclusions: z.strictObject(targetsShape).optional().describe('Targets excluded from the scope'),
});

export type ScopeInput = z.infer<typeof scopeInputSchema>;

export const generalCreateSchema = z.strictObject({
  name: z.string().trim().min(1).describe('Display name of the entry'),
  processName: z
    .string()
    .trim()
    .min(1)
    .describe('Process to restrict, e.g. "Install macOS". Matched against running process names.'),
  matchExactProcessName: z
    .boolean()
    .describe(
      'true: only a process named exactly this. false: ANY process whose name contains it — ' +
        `requires at least ${MIN_SUBSTRING_PROCESS_NAME} characters.`,
    ),
  sendNotification: z.boolean().describe('Show the user a notification when the process is blocked'),
  killProcess: z.boolean().describe('Kill the process when it launches'),
  deleteExecutable: z.boolean().describe('Delete the application that launched the process'),
  displayMessage: z.string().optional().describe('Notification text; empty if omitted'),
});

export type GeneralCreateInput = z.infer<typeof generalCreateSchema>;

export const generalUpdateSchema = generalCreateSchema.partial();

export type GeneralUpdateInput = z.infer<typeof generalUpdateSchema>;

// ---------------------------------------------------------------------------
// Normalisation and validation
// ---------------------------------------------------------------------------

const sortedUnique = (ids: number[] | undefined): number[] => [...new Set(ids ?? [])].sort((a, b) => a - b);

function normalizeTargets(t: Partial<Record<keyof ScopeTargets, number[]>> | undefined): ScopeTargets {
  return {
    computerIds: sortedUnique(t?.computerIds),
    computerGroupIds: sortedUnique(t?.computerGroupIds),
    buildingIds: sortedUnique(t?.buildingIds),
    departmentIds: sortedUnique(t?.departmentIds),
  };
}

export function normalizeScope(input: ScopeInput): RestrictedSoftwareScope {
  const scope: RestrictedSoftwareScope = {
    allComputers: input.allComputers,
    ...normalizeTargets(input),
    exclusions: normalizeTargets(input.exclusions),
  };
  const inclusions = scope.computerIds.length + scope.computerGroupIds.length + scope.buildingIds.length + scope.departmentIds.length;
  if (scope.allComputers && inclusions > 0) {
    throw new Error(
      'allComputers is true and inclusion targets were also given. That is ambiguous — all ' +
        'computers already includes them. Pass allComputers false to scope to the targets, or drop ' +
        'the targets to mean every computer.',
    );
  }
  return scope;
}

export function validateGeneral(general: RestrictedSoftwareGeneral): void {
  if (!general.matchExactProcessName && general.processName.length < MIN_SUBSTRING_PROCESS_NAME) {
    throw new Error(
      `processName "${general.processName}" is shorter than ${MIN_SUBSTRING_PROCESS_NAME} characters ` +
        'with matchExactProcessName false. Jamf would kill every process whose name merely contains ' +
        'it. Use a longer, more specific name, or turn exact matching on.',
    );
  }
}

/** Scope as tool input, for rollback arguments. */
export function scopeToInput(scope: RestrictedSoftwareScope): ScopeInput {
  return {
    allComputers: scope.allComputers,
    computerIds: scope.computerIds,
    computerGroupIds: scope.computerGroupIds,
    buildingIds: scope.buildingIds,
    departmentIds: scope.departmentIds,
    exclusions: { ...scope.exclusions },
  };
}

// ---------------------------------------------------------------------------
// Reading a live entry. Fails closed: a field it cannot read is an error, never a
// default, because update sends the merged result back to Jamf and a guessed
// default would be written as if it were the live value.
// ---------------------------------------------------------------------------

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'false') return value === 'true';
  throw new Error(`restricted_software.general.${field} is ${JSON.stringify(value)}, not a boolean. Refusing to guess it.`);
}

function readIds(value: unknown, singular: string, path: string): number[] {
  if (value === undefined || value === null || value === '') return [];
  // Classic JSON is an array of {id, name}; the published schema (derived from XML)
  // wraps each as {computer: {id, name}}. Both are accepted. A lone object is a
  // known Classic JSON quirk for one-element lists.
  const items = Array.isArray(value) ? value : [value];
  return sortedUnique(
    items.map((item) => {
      const record = item as Record<string, unknown> | null;
      const inner = (record?.[singular] as Record<string, unknown> | undefined) ?? record;
      const id = Number(inner?.id);
      if (!Number.isInteger(id)) {
        throw new Error(`cannot read an id from ${path} item ${JSON.stringify(item)}. Refusing to guess the scope.`);
      }
      return id;
    }),
  );
}

function isNonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.values(value).some(isNonEmpty);
  return value === true || (typeof value === 'string' && value !== '') || typeof value === 'number';
}

const TARGET_KEYS: Array<[keyof ScopeTargets, string, string]> = [
  ['computerIds', 'computers', 'computer'],
  ['computerGroupIds', 'computer_groups', 'computer_group'],
  ['buildingIds', 'buildings', 'building'],
  ['departmentIds', 'departments', 'department'],
];

function readTargets(raw: Record<string, unknown> | undefined, path: string, unmodelled: string[], known: string[]) {
  const targets = {} as ScopeTargets;
  for (const [field, plural, singular] of TARGET_KEYS) {
    targets[field] = readIds(raw?.[plural], singular, `${path}.${plural}`);
  }
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!known.includes(key) && isNonEmpty(value)) unmodelled.push(`${path}.${key}`);
  }
  return targets;
}

export function parseLiveRestrictedSoftware(body: unknown, id: number): LiveRestrictedSoftware {
  const detail = extractClassicDetail<Record<string, unknown>>(body as Record<string, unknown>, [ENVELOPE]);
  const general = detail?.general as Record<string, unknown> | undefined;
  if (!general) {
    const keys = body && typeof body === 'object' ? Object.keys(body).join(', ') : typeof body;
    throw new Error(`restricted software ${id}: unexpected response shape (no ${ENVELOPE}.general; got ${keys}).`);
  }
  if (typeof general.name !== 'string' || typeof general.process_name !== 'string') {
    throw new Error(`restricted software ${id}: general.name or general.process_name is missing.`);
  }

  const rawScope = (detail?.scope ?? {}) as Record<string, unknown>;
  const unmodelled: string[] = [];
  const plurals = TARGET_KEYS.map(([, plural]) => plural);
  const inclusions = readTargets(rawScope, 'scope', unmodelled, ['all_computers', 'exclusions', ...plurals]);
  const exclusions = readTargets(
    rawScope.exclusions as Record<string, unknown> | undefined,
    'scope.exclusions',
    unmodelled,
    plurals,
  );

  return {
    id,
    general: {
      name: general.name,
      processName: general.process_name,
      matchExactProcessName: readBoolean(general.match_exact_process_name, 'match_exact_process_name'),
      sendNotification: readBoolean(general.send_notification, 'send_notification'),
      killProcess: readBoolean(general.kill_process, 'kill_process'),
      deleteExecutable: readBoolean(general.delete_executable, 'delete_executable'),
      displayMessage: typeof general.display_message === 'string' ? general.display_message : '',
    },
    scope: {
      allComputers: rawScope.all_computers === undefined ? false : readBoolean(rawScope.all_computers, 'scope.all_computers'),
      ...inclusions,
      exclusions,
    },
    unmodelledScope: unmodelled,
  };
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function targetsXml(targets: ScopeTargets, indent: string): string[] {
  // An empty list is emitted as an empty element on purpose: when a scope is sent,
  // it replaces the live one in full, and an omitted list must not be read as
  // "leave that list as it was".
  return TARGET_KEYS.map(([field, plural, singular]) => {
    const ids = targets[field];
    if (ids.length === 0) return `${indent}<${plural}/>`;
    return `${indent}<${plural}>${ids.map((id) => `<${singular}><id>${id}</id></${singular}>`).join('')}</${plural}>`;
  });
}

/**
 * Builds the request body. `general` is always sent complete; `scope` is sent only
 * when given, so an update that does not mention scope cannot touch it.
 */
export function buildRestrictedSoftwareXml(general: RestrictedSoftwareGeneral, scope?: RestrictedSoftwareScope): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<${ENVELOPE}>`,
    '  <general>',
    `    <name>${escapeXml(general.name)}</name>`,
    `    <process_name>${escapeXml(general.processName)}</process_name>`,
    `    <match_exact_process_name>${general.matchExactProcessName}</match_exact_process_name>`,
    `    <send_notification>${general.sendNotification}</send_notification>`,
    `    <kill_process>${general.killProcess}</kill_process>`,
    `    <delete_executable>${general.deleteExecutable}</delete_executable>`,
    `    <display_message>${escapeXml(general.displayMessage)}</display_message>`,
    '  </general>',
  ];
  if (scope) {
    lines.push(
      '  <scope>',
      `    <all_computers>${scope.allComputers}</all_computers>`,
      ...targetsXml(scope, '    '),
      '    <exclusions>',
      ...targetsXml(scope.exclusions, '      '),
      '    </exclusions>',
      '  </scope>',
    );
  }
  lines.push(`</${ENVELOPE}>`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

function flatten(state: RestrictedSoftwareState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state.general)) out[`general.${k}`] = v;
  out['scope.allComputers'] = state.scope.allComputers;
  for (const [field] of TARGET_KEYS) {
    out[`scope.${field}`] = state.scope[field];
    out[`scope.exclusions.${field}`] = state.scope.exclusions[field];
  }
  return out;
}

/** Field-level differences. `before` undefined means a create: every field is new. */
export function diffStates(before: RestrictedSoftwareState | undefined, after: RestrictedSoftwareState): FieldChange[] {
  const a = flatten(after);
  const b = before ? flatten(before) : {};
  return Object.keys(a)
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .map((field) => ({ field, before: b[field], after: a[field] }));
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface WriteContext {
  client: JamfPlatformClient;
  /** False when JAMF_READ_ONLY is on. Dry runs still work; real writes refuse up front. */
  writesEnabled: boolean;
  now?: () => Date;
}

async function fetchLive(client: JamfPlatformClient, id: number): Promise<LiveRestrictedSoftware> {
  const body = await client.request({ service: SERVICE, style: 'classic', resource: `restrictedsoftware/id/${id}` });
  return parseLiveRestrictedSoftware(body, id);
}

async function listEntries(client: JamfPlatformClient): Promise<Array<{ id: number; name: string }>> {
  const body = await client.request<Record<string, unknown>>({ service: SERVICE, style: 'classic', resource: 'restrictedsoftware' });
  return extractClassicList<{ id: number; name: string }>(body, [ENVELOPE]).items;
}

function requireWrites(ctx: WriteContext): void {
  if (!ctx.writesEnabled) {
    throw new Error(
      'Writes are disabled: JAMF_READ_ONLY is not "false" for this server. The dry run above ' +
        'is still available. The write server is meant to run under its own restricted-software ' +
        'integration with JAMF_READ_ONLY=false (JPM-0008).',
    );
  }
}

/** Reads the entry back and reports any field where Jamf's state differs from what was sent. */
async function verify(client: JamfPlatformClient, id: number, intended: RestrictedSoftwareState) {
  try {
    const live = await fetchLive(client, id);
    const mismatches = diffStates(intended, live).map(({ field, before, after }) => ({
      field,
      sent: before,
      stored: after,
    }));
    return { verified: mismatches.length === 0, mismatches, stored: { general: live.general, scope: live.scope } };
  } catch (error) {
    return {
      verified: false,
      mismatches: [],
      readBackError:
        `The write returned success but reading it back failed: ${error instanceof Error ? error.message : String(error)}. ` +
        'Check the entry in Jamf before relying on it.',
    };
  }
}

function warningsFor(state: RestrictedSoftwareState): string[] {
  const warnings: string[] = [];
  const { general, scope } = state;
  if (scope.allComputers) warnings.push('Scope is ALL computers in the tenant (minus any exclusions).');
  const inclusions = scope.computerIds.length + scope.computerGroupIds.length + scope.buildingIds.length + scope.departmentIds.length;
  if (!scope.allComputers && inclusions === 0) warnings.push('Scope has no targets, so this entry applies to no computer.');
  if (general.deleteExecutable && !general.matchExactProcessName) {
    warnings.push(
      `deleteExecutable is on with substring matching: any app whose process name contains "${general.processName}" will be deleted.`,
    );
  }
  if (!general.killProcess) warnings.push('killProcess is off, so the process is not stopped — only reported or notified.');
  return warnings;
}

/** Parses the new id out of a Classic create response, which is `<restricted_software><id>N</id>…`. */
export function parseCreatedId(response: unknown): number | undefined {
  if (typeof response === 'string') {
    const match = response.match(/<id>(\d+)<\/id>/);
    return match ? Number(match[1]) : undefined;
  }
  if (response && typeof response === 'object') {
    const record = response as Record<string, unknown>;
    const id = Number((record[ENVELOPE] as Record<string, unknown> | undefined)?.id ?? record.id);
    return Number.isInteger(id) && id > 0 ? id : undefined;
  }
  return undefined;
}

export interface CreateInput {
  general: GeneralCreateInput;
  scope: ScopeInput;
  dryRun?: boolean;
}

export async function createRestrictedSoftware(ctx: WriteContext, input: CreateInput) {
  const general: RestrictedSoftwareGeneral = { ...input.general, displayMessage: input.general.displayMessage ?? '' };
  validateGeneral(general);
  const intended: RestrictedSoftwareState = { general, scope: normalizeScope(input.scope) };

  const existing = await listEntries(ctx.client);
  const clash = existing.find((e) => e.name.trim().toLowerCase() === general.name.toLowerCase());
  if (clash) {
    throw new Error(
      `A restricted software entry named "${clash.name}" already exists (id ${clash.id}). ` +
        'Use updateRestrictedSoftware to change it, or choose a different name.',
    );
  }

  const xml = buildRestrictedSoftwareXml(intended.general, intended.scope);
  const plan = { action: 'create' as const, changes: diffStates(undefined, intended), warnings: warningsFor(intended), xml };

  if (input.dryRun !== false) {
    return { dryRun: true, ...plan, next: 'Nothing was written. Call again with dryRun false to create this entry.' };
  }
  requireWrites(ctx);

  const writtenAt = (ctx.now?.() ?? new Date()).toISOString();
  console.error(`[jamf-platform-write] ${writtenAt} create restricted software "${general.name}"`);
  const response = await ctx.client.request({
    service: SERVICE,
    style: 'classic',
    resource: 'restrictedsoftware/id/0',
    method: 'POST',
    body: xml,
    bodyFormat: 'xml',
  });

  let id = parseCreatedId(response);
  if (id === undefined) {
    id = (await listEntries(ctx.client)).find((e) => e.name.trim().toLowerCase() === general.name.toLowerCase())?.id;
  }
  if (id === undefined) {
    return {
      dryRun: false,
      ...plan,
      writtenAt,
      verification: {
        verified: false,
        readBackError: 'Jamf accepted the create, but its response carried no id and no entry by that name was found. Check Jamf.',
      },
    };
  }
  console.error(`[jamf-platform-write] ${writtenAt} created restricted software id ${id}`);

  return {
    dryRun: false,
    ...plan,
    id,
    writtenAt,
    verification: await verify(ctx.client, id, intended),
    rollback: {
      tool: 'updateRestrictedSoftware',
      arguments: { id, scope: { allComputers: false }, dryRun: false },
      effect:
        'Empties the scope so the entry applies to no computer, leaving it in place. To remove it ' +
        'entirely, delete it in the Jamf UI (Computers > Restricted Software); this server cannot delete.',
    },
  };
}

export interface UpdateInput {
  id: number;
  general?: GeneralUpdateInput;
  scope?: ScopeInput;
  dryRun?: boolean;
}

export async function updateRestrictedSoftware(ctx: WriteContext, input: UpdateInput) {
  const live = await fetchLive(ctx.client, input.id);
  const before: RestrictedSoftwareState = { general: live.general, scope: live.scope };

  // Only fields the caller passed. A key present with an undefined value is not a change.
  const patch = Object.fromEntries(Object.entries(input.general ?? {}).filter(([, v]) => v !== undefined));
  const general: RestrictedSoftwareGeneral = { ...live.general, ...patch };
  if ('processName' in patch || 'matchExactProcessName' in patch) validateGeneral(general);

  let scope: RestrictedSoftwareScope | undefined;
  if (input.scope) {
    if (live.unmodelledScope.length > 0) {
      throw new Error(
        `Restricted software ${input.id}'s live scope uses ${live.unmodelledScope.join(', ')}, which this ` +
          'tool does not model. Replacing the scope would silently drop them, so the scope update is ' +
          'refused. Change the scope in the Jamf UI, or update only general fields here.',
      );
    }
    scope = normalizeScope(input.scope);
  }

  const after: RestrictedSoftwareState = { general, scope: scope ?? live.scope };
  const changes = diffStates(before, after);
  if (changes.length === 0) {
    return { action: 'update' as const, id: input.id, noChange: true, note: 'The requested values match the live entry. Nothing to write.' };
  }

  const xml = buildRestrictedSoftwareXml(general, scope);
  const plan = {
    action: 'update' as const,
    id: input.id,
    changes,
    warnings: warningsFor(after),
    scopeSent: scope !== undefined,
    xml,
  };

  if (input.dryRun !== false) {
    return { dryRun: true, ...plan, next: 'Nothing was written. Call again with dryRun false to apply these changes.' };
  }
  requireWrites(ctx);

  const writtenAt = (ctx.now?.() ?? new Date()).toISOString();
  console.error(`[jamf-platform-write] ${writtenAt} update restricted software id ${input.id}: ${changes.map((c) => c.field).join(', ')}`);
  await ctx.client.request({
    service: SERVICE,
    style: 'classic',
    resource: `restrictedsoftware/id/${input.id}`,
    method: 'PUT',
    body: xml,
    bodyFormat: 'xml',
  });

  const restoreGeneral = Object.fromEntries(
    changes.filter((c) => c.field.startsWith('general.')).map((c) => [c.field.slice('general.'.length), c.before]),
  );
  const scopeChanged = changes.some((c) => c.field.startsWith('scope.'));

  return {
    dryRun: false,
    ...plan,
    writtenAt,
    before,
    verification: await verify(ctx.client, input.id, after),
    rollback: {
      tool: 'updateRestrictedSoftware',
      arguments: {
        id: input.id,
        ...(Object.keys(restoreGeneral).length > 0 ? { general: restoreGeneral } : {}),
        ...(scopeChanged ? { scope: scopeToInput(live.scope) } : {}),
        dryRun: false,
      },
      effect: 'Restores every field this update changed to its prior value.',
    },
  };
}
