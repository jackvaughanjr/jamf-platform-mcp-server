import { z } from 'zod';

import { extractClassicDetail } from './automations.js';
import {
  categoryIdSchema,
  fetchCategory,
  listClassicNames,
  objectName,
  PARAMETER_KEYS,
  sameName,
  type Mismatch,
  type ParameterKey,
} from './create-script.js';
import { escapeXml, targetsXml, type WriteContext } from './restricted-software.js';
import { canonical, fetchGroup, parseLiveScoped, type GroupInfo } from './scope-membership.js';
import { digest, digestMarker, sameDigest, sanitizedWriteError, sha256Hex } from './secret-material.js';

/**
 * `createPolicy` (JPM-0012): create one Jamf Pro policy through Classic
 * `POST /proclassic/policies/id/0`, as XML (the operation page publishes no body).
 *
 * Every rule here answers a way a create could reach Macs the caller did not intend:
 *
 * - **Always created disabled.** There is no `enabled` input; `<enabled>false</enabled>`
 *   is a fixed value. Enabling is a separate act, in the Jamf console.
 * - **Scope is explicit.** Computer ids and computer group ids, with optional exclusions
 *   of the same two kinds. `all_computers` is always sent false. An empty scope is
 *   refused unless `emptyScopeIntended: true` says so.
 * - **No defaults.** Every trigger, the frequency, the retry settings, every script slot
 *   and every parameter, `recon` and the Self Service flag are stated by the caller.
 *   Everything else this tool sends is a documented fixed value. Sections it does not
 *   send are checked on read-back against the inert values Jamf stores.
 * - **Parameter values are hidden.** Shown as SHA-256 and length only, in the dry run,
 *   the result, errors and logs, because a parameter can carry a secret.
 * - **Packages are not supported.** Their Classic write shape is not settled; add them in
 *   the console.
 */

export const FREQUENCIES = [
  'Once per computer',
  'Once per user per computer',
  'Once per user',
  'Once every day',
  'Once every week',
  'Once every month',
  'Ongoing',
] as const;

export const RETRY_EVENTS = ['none', 'check-in', 'trigger'] as const;
export const MAX_RETRY_ATTEMPTS = 10;
export const MAX_POLICY_SCRIPTS = 20;

/** Sent as `false`, always; only `recon` is the caller's. */
export const FIXED_FALSE_MAINTENANCE = [
  'reset_name',
  'install_all_cached_packages',
  'heal',
  'prebindings',
  'permissions',
  'byhost',
  'system_cache',
  'user_cache',
  'verify',
] as const;

const positiveId = z.number().int().positive();

const parameterShape = Object.fromEntries(
  PARAMETER_KEYS.map((key) => [
    key,
    z.string().describe(`Value passed as ${key.replace('parameter', '$')}; "" for none. Never echoed: shown as SHA-256 and length.`),
  ]),
) as Record<ParameterKey, z.ZodString>;

export const policyScriptSchema = z.strictObject({
  id: positiveId.describe('Classic script id'),
  priority: z.enum(['Before', 'After']).describe('Run before or after the policy\'s other actions'),
  ...parameterShape,
});

const triggerFlag = (what: string) => z.boolean().describe(`Run at ${what}`);

export const createPolicyInputSchema = z.strictObject({
  general: z.strictObject({
    name: objectName('general.name').describe('Policy name. Refused if any policy already has it (case-insensitive).'),
    categoryId: categoryIdSchema,
    triggers: z
      .strictObject({
        checkin: triggerFlag('recurring check-in'),
        enrollmentComplete: triggerFlag('enrollment complete'),
        login: triggerFlag('login'),
        networkStateChanged: triggerFlag('network state change'),
        startup: triggerFlag('startup'),
        other: z
          .string()
          .refine((v) => v === v.trim(), { message: 'triggers.other has leading or trailing whitespace' })
          .describe('Custom event name (jamf policy -event NAME); "" for none'),
      })
      .describe('Every trigger stated. A policy with none can only run through Self Service.'),
    frequency: z.enum(FREQUENCIES),
    retry: z
      .strictObject({
        event: z.enum(RETRY_EVENTS).describe('"none", or retry on the next "check-in" or the next policy "trigger"'),
        attempts: z.number().int().describe(`-1 with event "none"; 1 to ${MAX_RETRY_ATTEMPTS} otherwise`),
        notifyOnEachFailedRetry: z.boolean(),
      })
      .describe('Retry on failure. Jamf offers retry only for frequency "Once per computer".'),
  }),
  scope: z
    .strictObject({
      computerIds: z.array(positiveId).describe('Classic computer ids to include; [] for none'),
      computerGroupIds: z.array(positiveId).describe('Classic computer group ids to include; [] for none'),
      exclusions: z.strictObject({
        computerIds: z.array(positiveId).describe('Classic computer ids to exclude; [] for none'),
        computerGroupIds: z.array(positiveId).describe('Classic computer group ids to exclude; [] for none'),
      }),
      emptyScopeIntended: z
        .literal(true)
        .optional()
        .describe('Pass true only to create a policy that targets nothing. Without it an empty scope is refused.'),
    })
    .describe('Explicit targets. All computers is never sent; buildings, departments and user scoping are not supported.'),
  scripts: z
    .array(policyScriptSchema)
    .max(MAX_POLICY_SCRIPTS)
    .describe('Ordered list of scripts, each with every parameter stated; [] for none'),
  maintenance: z.strictObject({
    recon: z.boolean().describe('Update inventory after the policy runs. Every other maintenance option is sent false.'),
  }),
  selfService: z
    .discriminatedUnion('useForSelfService', [
      z.strictObject({ useForSelfService: z.literal(false) }),
      z.strictObject({
        useForSelfService: z.literal(true),
        displayName: z.string().min(1),
        description: z.string().min(1),
        featureOnMainPage: z.boolean(),
        forceUsersToViewDescription: z.boolean(),
      }),
    ])
    .describe('Self Service availability. With true, the display name, description and both flags are required.'),
  enabled: z
    .never()
    .optional()
    .describe('NOT ACCEPTED. Policies are always created disabled; enable one in the Jamf console after review.'),
  packages: z
    .never()
    .optional()
    .describe('NOT SUPPORTED. Packages must be added in the Jamf console; their Classic write shape is unverified.'),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'Defaults to TRUE. A dry run performs the reads, returns the exact request (parameter values as hashes) and ' +
        'writes nothing. Pass false only after the dry run has been reviewed.',
    ),
});

export type CreatePolicyInput = z.infer<typeof createPolicyInputSchema>;
export type PolicyScriptInput = z.infer<typeof policyScriptSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function duplicates(ids: number[]): number[] {
  const seen = new Set<number>();
  const dup = new Set<number>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

/** Rules a schema cannot express. Throws on the first; never repairs. */
export function validatePolicyInput(input: CreatePolicyInput): void {
  const { retry, frequency } = input.general;
  if (retry.event === 'none') {
    if (retry.attempts !== -1) throw new Error('retry.event is "none", so retry.attempts must be -1.');
    if (retry.notifyOnEachFailedRetry) throw new Error('retry.event is "none", so retry.notifyOnEachFailedRetry must be false.');
  } else {
    if (retry.attempts < 1 || retry.attempts > MAX_RETRY_ATTEMPTS) {
      throw new Error(`retry.attempts must be 1 to ${MAX_RETRY_ATTEMPTS} when retry.event is "${retry.event}".`);
    }
    if (frequency !== 'Once per computer') {
      throw new Error(`Retry is offered only for frequency "Once per computer"; this policy is "${frequency}".`);
    }
  }

  const { scope } = input;
  for (const [label, ids] of [
    ['scope.computerIds', scope.computerIds],
    ['scope.computerGroupIds', scope.computerGroupIds],
    ['scope.exclusions.computerIds', scope.exclusions.computerIds],
    ['scope.exclusions.computerGroupIds', scope.exclusions.computerGroupIds],
  ] as const) {
    const dup = duplicates(ids);
    if (dup.length > 0) throw new Error(`${label} lists ${dup.join(', ')} more than once.`);
  }
  const bothComputers = scope.computerIds.filter((id) => scope.exclusions.computerIds.includes(id));
  const bothGroups = scope.computerGroupIds.filter((id) => scope.exclusions.computerGroupIds.includes(id));
  if (bothComputers.length + bothGroups.length > 0) {
    throw new Error(
      `Included and excluded at once: computers [${bothComputers.join(', ')}], groups [${bothGroups.join(', ')}]. ` +
        'Exclusions win in Jamf, so this is almost certainly a mistake. Refused.',
    );
  }
  const inclusions = scope.computerIds.length + scope.computerGroupIds.length;
  if (inclusions === 0 && scope.emptyScopeIntended !== true) {
    throw new Error('The scope includes no computer and no computer group. Pass scope.emptyScopeIntended true if that is intended.');
  }
  if (inclusions > 0 && scope.emptyScopeIntended === true) {
    throw new Error('scope.emptyScopeIntended is true but the scope includes targets. Drop one or the other.');
  }

  const dupScripts = duplicates(input.scripts.map((s) => s.id));
  if (dupScripts.length > 0) throw new Error(`scripts lists script ${dupScripts.join(', ')} more than once.`);
}

const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/**
 * The request body. `renderParameter` decides how a parameter value is written:
 * escaped for the real request, a digest marker for the dry run. Nothing else
 * differs between the two, so the reviewed body is the sent body.
 */
export function buildPolicyXml(input: CreatePolicyInput, renderParameter: (value: string) => string): string {
  const { general, scope, scripts, maintenance, selfService } = input;
  const t = general.triggers;
  const empty = { buildingIds: [], departmentIds: [] };
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<policy>',
    '  <general>',
    `    <name>${escapeXml(general.name)}</name>`,
    '    <enabled>false</enabled>',
    `    <trigger_checkin>${t.checkin}</trigger_checkin>`,
    `    <trigger_enrollment_complete>${t.enrollmentComplete}</trigger_enrollment_complete>`,
    `    <trigger_login>${t.login}</trigger_login>`,
    `    <trigger_network_state_changed>${t.networkStateChanged}</trigger_network_state_changed>`,
    `    <trigger_startup>${t.startup}</trigger_startup>`,
    `    <trigger_other>${escapeXml(t.other)}</trigger_other>`,
    `    <frequency>${escapeXml(general.frequency)}</frequency>`,
    `    <retry_event>${general.retry.event}</retry_event>`,
    `    <retry_attempts>${general.retry.attempts}</retry_attempts>`,
    `    <notify_on_each_failed_retry>${general.retry.notifyOnEachFailedRetry}</notify_on_each_failed_retry>`,
    `    <category><id>${general.categoryId}</id></category>`,
    '  </general>',
    '  <scope>',
    '    <all_computers>false</all_computers>',
    ...targetsXml(
      { computerIds: sorted(scope.computerIds), computerGroupIds: sorted(scope.computerGroupIds), ...empty },
      '    ',
    ),
    '    <exclusions>',
    ...targetsXml(
      {
        computerIds: sorted(scope.exclusions.computerIds),
        computerGroupIds: sorted(scope.exclusions.computerGroupIds),
        ...empty,
      },
      '      ',
    ),
    '    </exclusions>',
    '  </scope>',
    '  <self_service>',
    `    <use_for_self_service>${selfService.useForSelfService}</use_for_self_service>`,
  ];
  if (selfService.useForSelfService) {
    lines.push(
      `    <self_service_display_name>${escapeXml(selfService.displayName)}</self_service_display_name>`,
      `    <self_service_description>${escapeXml(selfService.description)}</self_service_description>`,
      `    <feature_on_main_page>${selfService.featureOnMainPage}</feature_on_main_page>`,
      `    <force_users_to_view_description>${selfService.forceUsersToViewDescription}</force_users_to_view_description>`,
    );
  }
  lines.push('  </self_service>', '  <scripts>', `    <size>${scripts.length}</size>`);
  for (const script of scripts) {
    lines.push('    <script>', `      <id>${script.id}</id>`, `      <priority>${script.priority}</priority>`);
    for (const key of PARAMETER_KEYS) lines.push(`      <${key}>${renderParameter(script[key])}</${key}>`);
    lines.push('    </script>');
  }
  lines.push('  </scripts>', '  <maintenance>', `    <recon>${maintenance.recon}</recon>`);
  for (const key of FIXED_FALSE_MAINTENANCE) lines.push(`    <${key}>false</${key}>`);
  lines.push('  </maintenance>', '</policy>');
  return lines.join('\n');
}

export const realParameter = (value: string) => escapeXml(value);
export const shownParameter = (value: string) => (value === '' ? '' : digestMarker(value));

export const POLICY_CREATE_PATH = '/proclassic/policies/id/0';

// ---------------------------------------------------------------------------
// Read-back
// ---------------------------------------------------------------------------

/**
 * What Jamf stores for the parts of a policy this tool does not send, observed
 * identical on every one of 86 policies in a production tenant export (2026-11-05).
 * A stored value that differs means the policy does something this tool did not ask
 * for, and the create is reported unverified.
 */
export const EXPECTED_UNSENT: Array<[string, (value: unknown) => boolean, string]> = [
  ['general.date_time_limitations.activation_date', (v) => v === '' || v === undefined, '""'],
  ['general.date_time_limitations.expiration_date', (v) => v === '' || v === undefined, '""'],
  ['general.date_time_limitations.no_execute_on', (v) => isEmptyish(v), 'empty'],
  ['general.date_time_limitations.no_execute_start', (v) => v === '' || v === undefined, '""'],
  ['general.date_time_limitations.no_execute_end', (v) => v === '' || v === undefined, '""'],
  ['general.network_limitations.any_ip_address', (v) => v === true || v === 'true', 'true'],
  ['general.network_limitations.minimum_network_connection', (v) => v === 'No Minimum', '"No Minimum"'],
  ['general.network_limitations.network_segments', (v) => isEmptyish(v), 'empty'],
  ['general.network_requirements', (v) => v === 'Any', '"Any"'],
  ['general.location_user_only', (v) => v === false || v === 'false', 'false'],
  ['general.offline', (v) => v === false || v === 'false', 'false'],
  ['package_configuration.packages', (v) => isEmptyish(v), 'empty'],
  ['printers', (v) => isEmptyish(v), 'empty'],
  ['dock_items', (v) => isEmptyish(v), 'empty'],
  ['account_maintenance.accounts', (v) => isEmptyish(v), 'empty'],
  ['account_maintenance.directory_bindings', (v) => isEmptyish(v), 'empty'],
  ['account_maintenance.management_account.action', (v) => v === 'doNotChange', '"doNotChange"'],
  ['account_maintenance.open_firmware_efi_password.of_mode', (v) => v === 'none', '"none"'],
  ['reboot.user_logged_in', (v) => v === 'Do not restart', '"Do not restart"'],
  ['reboot.no_user_logged_in', (v) => v === 'Do not restart', '"Do not restart"'],
  ['reboot.file_vault_2_reboot', (v) => v === false || v === 'false', 'false'],
  ['files_processes.run_command', (v) => v === '', '""'],
  ['files_processes.search_by_path', (v) => v === '', '""'],
  ['files_processes.delete_file', (v) => v === false || v === 'false', 'false'],
  ['files_processes.search_for_process', (v) => v === '', '""'],
  ['files_processes.kill_process', (v) => v === false || v === 'false', 'false'],
  ['files_processes.locate_file', (v) => v === '', '""'],
  ['files_processes.update_locate_database', (v) => v === false || v === 'false', 'false'],
  ['files_processes.spotlight_search', (v) => v === '', '""'],
  ['disk_encryption.action', (v) => v === 'none', '"none"'],
  ['user_interaction.allow_users_to_defer', (v) => v === false || v === 'false', 'false'],
  ['user_interaction.message_start', (v) => v === '', '""'],
  ['user_interaction.message_finish', (v) => v === '', '""'],
];

/** Empty array, empty object, "", or Classic's list-of-one-empty-string (`printers: [""]`). */
function isEmptyish(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.every((item) => item === '' || isEmptyish(item));
  if (typeof value === 'object') return Object.values(value).every(isEmptyish);
  return false;
}

function at(root: Record<string, unknown>, path: string): unknown {
  let node: unknown = root;
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** A stored value as shown in a mismatch: strings by digest, since an unsent text field could hold anything. */
function describeStored(value: unknown): unknown {
  if (value === undefined) return '(absent)';
  if (typeof value === 'string') return digest(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  return { sha256: sha256Hex(canonical(value)) };
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'false') return value === 'true';
  return undefined;
}

function storedScripts(detail: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  const raw = detail.scripts;
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) return raw.filter((s) => s !== '') as Array<Record<string, unknown>>;
  if (typeof raw === 'object') {
    // The XML-derived schema wraps the list as {size, script: [...]}; a lone object is one script.
    const inner = (raw as Record<string, unknown>).script;
    if (Array.isArray(inner)) return inner as Array<Record<string, unknown>>;
    if (inner && typeof inner === 'object') return [inner as Record<string, unknown>];
    if ((raw as Record<string, unknown>).size !== undefined && Number((raw as Record<string, unknown>).size) === 0) return [];
  }
  return undefined;
}

/**
 * Compares the stored policy with everything this tool sent, plus the inert values of
 * what it did not send. Parameter values by digest only. Fails closed: a field it
 * cannot read is a mismatch, never a pass.
 */
export function comparePolicy(input: CreatePolicyInput, body: unknown, id: number): Mismatch[] {
  const detail = extractClassicDetail<Record<string, unknown>>(body as Record<string, unknown>, ['policy']);
  if (!detail || typeof detail !== 'object') return [{ field: '(policy)', sent: 'an object', stored: 'unreadable response' }];
  const out: Mismatch[] = [];
  const general = (detail.general ?? {}) as Record<string, unknown>;
  const expect = (field: string, sent: unknown, stored: unknown) => {
    if (stored !== sent) out.push({ field, sent, stored: stored === undefined ? '(absent)' : stored });
  };
  const flag = (field: string, sent: boolean, raw: unknown) => {
    const stored = asBoolean(raw);
    if (stored !== sent) out.push({ field, sent, stored: raw === undefined ? '(absent)' : raw });
  };

  const g = input.general;
  expect('general.name', g.name, general.name);
  flag('general.enabled', false, general.enabled);
  flag('general.trigger_checkin', g.triggers.checkin, general.trigger_checkin);
  flag('general.trigger_enrollment_complete', g.triggers.enrollmentComplete, general.trigger_enrollment_complete);
  flag('general.trigger_login', g.triggers.login, general.trigger_login);
  flag('general.trigger_network_state_changed', g.triggers.networkStateChanged, general.trigger_network_state_changed);
  flag('general.trigger_startup', g.triggers.startup, general.trigger_startup);
  expect('general.trigger_other', g.triggers.other, general.trigger_other);
  expect('general.frequency', g.frequency, general.frequency);
  expect('general.retry_event', g.retry.event, general.retry_event);
  expect('general.retry_attempts', g.retry.attempts, Number(general.retry_attempts));
  flag('general.notify_on_each_failed_retry', g.retry.notifyOnEachFailedRetry, general.notify_on_each_failed_retry);
  expect('general.category.id', g.categoryId, Number((general.category as Record<string, unknown> | undefined)?.id));

  // Scope, through the same fail-closed parser the scope tools use.
  try {
    const live = parseLiveScoped(body, 'policy', id);
    const ids = (label: string, sent: number[], stored: number[]) => {
      if (JSON.stringify(sorted(sent)) !== JSON.stringify(stored)) out.push({ field: label, sent: sorted(sent), stored });
    };
    if (live.scope.allComputers) out.push({ field: 'scope.all_computers', sent: false, stored: true });
    ids('scope.computerIds', input.scope.computerIds, live.scope.computerIds);
    ids('scope.computerGroupIds', input.scope.computerGroupIds, live.scope.computerGroupIds);
    ids('scope.buildingIds', [], live.scope.buildingIds);
    ids('scope.departmentIds', [], live.scope.departmentIds);
    ids('scope.exclusions.computerIds', input.scope.exclusions.computerIds, live.scope.exclusions.computerIds);
    ids('scope.exclusions.computerGroupIds', input.scope.exclusions.computerGroupIds, live.scope.exclusions.computerGroupIds);
    ids('scope.exclusions.buildingIds', [], live.scope.exclusions.buildingIds);
    ids('scope.exclusions.departmentIds', [], live.scope.exclusions.departmentIds);
    for (const path of live.unmodelledScope) out.push({ field: path, sent: 'empty', stored: 'non-empty' });
  } catch (error) {
    out.push({ field: 'scope', sent: 'readable', stored: error instanceof Error ? error.message : String(error) });
  }

  // Scripts: order, id, priority, every parameter by digest.
  const scripts = storedScripts(detail);
  if (!scripts) {
    out.push({ field: 'scripts', sent: `${input.scripts.length} scripts`, stored: 'unreadable' });
  } else {
    if (scripts.length !== input.scripts.length) {
      out.push({ field: 'scripts.length', sent: input.scripts.length, stored: scripts.length });
    }
    input.scripts.forEach((sent, i) => {
      const stored = scripts[i];
      if (!stored) return;
      expect(`scripts[${i}].id`, sent.id, Number(stored.id));
      expect(`scripts[${i}].priority`, sent.priority, stored.priority);
      for (const key of PARAMETER_KEYS) {
        const raw = stored[key];
        // Classic JSON renders an empty element as "" or omits it.
        const storedValue = raw === undefined || raw === null ? '' : raw;
        if (typeof storedValue !== 'string') {
          out.push({ field: `scripts[${i}].${key}`, sent: digest(sent[key]), stored: typeof storedValue });
        } else if (!sameDigest(digest(sent[key]), digest(storedValue))) {
          out.push({ field: `scripts[${i}].${key}`, sent: digest(sent[key]), stored: digest(storedValue) });
        }
      }
    });
  }

  const maintenance = (detail.maintenance ?? {}) as Record<string, unknown>;
  flag('maintenance.recon', input.maintenance.recon, maintenance.recon);
  for (const key of FIXED_FALSE_MAINTENANCE) flag(`maintenance.${key}`, false, maintenance[key]);

  const ss = (detail.self_service ?? {}) as Record<string, unknown>;
  flag('self_service.use_for_self_service', input.selfService.useForSelfService, ss.use_for_self_service);
  if (input.selfService.useForSelfService) {
    expect('self_service.self_service_display_name', input.selfService.displayName, ss.self_service_display_name);
    expect('self_service.self_service_description', input.selfService.description, ss.self_service_description);
    flag('self_service.feature_on_main_page', input.selfService.featureOnMainPage, ss.feature_on_main_page);
    flag('self_service.force_users_to_view_description', input.selfService.forceUsersToViewDescription, ss.force_users_to_view_description);
  }

  for (const [path, ok, expected] of EXPECTED_UNSENT) {
    const value = at(detail, path);
    if (!ok(value)) out.push({ field: path, sent: `(not sent; expected ${expected})`, stored: describeStored(value) });
  }
  return out;
}

/** The new id from a Classic create response, `<policy><id>N</id></policy>` or its JSON form. */
export function parsePolicyCreatedId(response: unknown): number | undefined {
  if (typeof response === 'string') {
    const match = response.match(/<id>(\d+)<\/id>/);
    return match ? Number(match[1]) : undefined;
  }
  if (response && typeof response === 'object') {
    const record = response as Record<string, unknown>;
    const id = Number((record.policy as Record<string, unknown> | undefined)?.id ?? record.id);
    return Number.isInteger(id) && id > 0 ? id : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

function warningsFor(input: CreatePolicyInput): string[] {
  const t = input.general.triggers;
  const warnings = ['The policy is created DISABLED. It runs nothing until it is enabled in the Jamf console.'];
  const anyTrigger = t.checkin || t.enrollmentComplete || t.login || t.networkStateChanged || t.startup || t.other !== '';
  if (!anyTrigger && !input.selfService.useForSelfService) {
    warnings.push('No trigger, no custom event and not in Self Service: nothing can ever run this policy.');
  }
  if (input.general.frequency === 'Ongoing' && t.checkin) {
    warnings.push('Ongoing at every recurring check-in runs this policy on every check-in, indefinitely.');
  }
  const passed = input.scripts.reduce((n, s) => n + PARAMETER_KEYS.filter((k) => s[k] !== '').length, 0);
  if (passed > 0) {
    warnings.push(
      `${passed} non-empty script parameter value(s) were passed. They are shown here only as SHA-256 and length, but ` +
        'they are in this session as tool arguments. A secret belongs in the Jamf console, entered after the create.',
    );
  }
  if (input.scope.computerIds.length > 0) {
    warnings.push('Computer ids are not checked before the write (this integration holds no computer read permission); the read-back shows what Jamf stored.');
  }
  return warnings;
}

function requireWrites(ctx: WriteContext): void {
  if (!ctx.writesEnabled) {
    throw new Error(
      'Writes are disabled: JAMF_READ_ONLY is not "false" for this server. The dry run is still available. ' +
        'The write server is meant to run under its own integration with JAMF_READ_ONLY=false (JPM-0008).',
    );
  }
}

export async function createPolicy(ctx: WriteContext, rawInput: CreatePolicyInput) {
  const input = createPolicyInputSchema.parse(rawInput);
  validatePolicyInput(input);

  const existing = await listClassicNames(ctx.client, 'policies', 'policies');
  const clash = existing.find((p) => sameName(p.name, input.general.name));
  if (clash) {
    throw new Error(
      `A policy named "${clash.name}" already exists (id ${clash.id}). This tool creates only, and refuses a ` +
        'duplicate name even though Jamf allows one.',
    );
  }
  const category = await fetchCategory(ctx.client, input.general.categoryId);

  const knownScripts = new Map((await listClassicNames(ctx.client, 'scripts', 'scripts')).map((s) => [s.id, s.name]));
  const missing = input.scripts.filter((s) => !knownScripts.has(s.id)).map((s) => s.id);
  if (missing.length > 0) throw new Error(`Script id(s) ${missing.join(', ')} do not exist. Nothing was written.`);

  const groups: GroupInfo[] = [];
  for (const groupId of [...input.scope.computerGroupIds, ...input.scope.exclusions.computerGroupIds]) {
    groups.push(await fetchGroup(ctx.client, groupId));
  }

  const hidden = input.scripts.flatMap((s) => PARAMETER_KEYS.map((k) => s[k]));
  const plan = {
    action: 'createPolicy' as const,
    request: {
      method: 'POST' as const,
      path: POLICY_CREATE_PATH,
      contentType: 'application/xml',
      body: buildPolicyXml(input, shownParameter),
      bodyNote:
        'Exactly the body that is sent, except that each non-empty script parameter value is shown as ' +
        '[sha256:… length:…]. enabled false and all_computers false are fixed; nothing else is added.',
    },
    category,
    scripts: input.scripts.map((s, i) => ({
      order: i + 1,
      id: s.id,
      name: knownScripts.get(s.id),
      priority: s.priority,
      parameters: Object.fromEntries(PARAMETER_KEYS.map((k) => [k, digest(s[k])])),
    })),
    groups,
    notSent:
      'Not sent, left to Jamf and checked on read-back: date/time and network limitations, network requirements, ' +
      'site, packages, printers, dock items, account maintenance, restart options, files and processes, user ' +
      'interaction, disk encryption, Self Service icon, categories, button texts and notifications.',
    warnings: warningsFor(input),
  };

  if (input.dryRun !== false) {
    return { dryRun: true, ...plan, next: 'Nothing was written. Call again with dryRun false to create this policy, disabled.' };
  }
  requireWrites(ctx);

  const xml = buildPolicyXml(input, realParameter);
  const writtenAt = (ctx.now?.() ?? new Date()).toISOString();
  console.error(`[jamf-platform-write] ${writtenAt} create policy "${input.general.name}" (disabled)`);
  let response: unknown;
  try {
    response = await ctx.client.request({
      service: 'proclassic',
      style: 'classic',
      resource: 'policies/id/0',
      method: 'POST',
      body: xml,
      bodyFormat: 'xml',
    });
  } catch (error) {
    throw sanitizedWriteError(error, hidden, 'The policy create failed.');
  }

  let id = parsePolicyCreatedId(response);
  if (id === undefined) {
    id = (await listClassicNames(ctx.client, 'policies', 'policies')).find((p) => sameName(p.name, input.general.name))?.id;
  }
  if (id === undefined) {
    return {
      dryRun: false,
      ...plan,
      writtenAt,
      verification: {
        verified: false,
        mismatches: [],
        readBackError: 'Jamf accepted the create, but its response carried no id and no policy by that name was found. Check Jamf.',
      },
    };
  }
  console.error(`[jamf-platform-write] ${writtenAt} created policy id ${id}`);

  let verification: Record<string, unknown>;
  try {
    const stored = await ctx.client.request({ service: 'proclassic', style: 'classic', resource: `policies/id/${id}` });
    const mismatches = comparePolicy(input, stored, id);
    verification = { verified: mismatches.length === 0, mismatches };
  } catch (error) {
    verification = {
      verified: false,
      mismatches: [],
      readBackError: `${sanitizedWriteError(error, hidden, 'Reading the new policy back failed.').message} Check the policy in Jamf before relying on it.`,
    };
  }

  return {
    dryRun: false,
    ...plan,
    id,
    writtenAt,
    verification,
    rollback: {
      effect:
        'The policy was created disabled. Keep it disabled, empty its scope, then delete it in the Jamf console ' +
        '(Computers > Policies); this server cannot delete.' +
        (input.scope.computerIds.length > 0
          ? ` Direct computer targets (${sorted(input.scope.computerIds).join(', ')}) can be removed only in the console.`
          : ''),
      emptyScope: input.scope.computerGroupIds.map((computerGroupId) => ({
        tool: 'removeComputerGroupFromPolicyScope',
        arguments: { id, computerGroupId, dryRun: true },
      })),
    },
  };
}
