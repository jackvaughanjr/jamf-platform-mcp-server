import { z } from 'zod';

import { extractClassicDetail, extractClassicList } from './automations.js';
import type { JamfPlatformClient } from './platform-client.js';
import type { WriteContext } from './restricted-software.js';
import { digest, sameDigest, sanitizedWriteError, type ValueDigest } from './secret-material.js';

/**
 * `createScript` (JPM-0012): create one Jamf Pro script, every field stated by the
 * caller, through the Jamf Pro API's `POST /pro/v1/scripts`, whose JSON request body
 * is published (`post_v1-scripts-1`), unlike the Classic write pages.
 *
 * The script's contents are never returned or logged: dry run, result and errors
 * describe them by SHA-256 and length only. Parameter LABELS are not secret and are
 * shown. There is no update and no delete.
 */

export const SCRIPT_PRIORITIES = ['BEFORE', 'AFTER', 'AT_REBOOT'] as const;
export const PARAMETER_KEYS = [
  'parameter4',
  'parameter5',
  'parameter6',
  'parameter7',
  'parameter8',
  'parameter9',
  'parameter10',
  'parameter11',
] as const;
export type ParameterKey = (typeof PARAMETER_KEYS)[number];

/** Contents larger than this get a warning; Jamf's own limit is not published. */
export const LARGE_SCRIPT_BYTES = 200 * 1024;

export const objectName = (field: string) =>
  z
    .string()
    .min(1)
    .max(255)
    .refine((v) => v === v.trim(), { message: `${field} has leading or trailing whitespace; it is not trimmed for you` });

export const categoryIdSchema = z
  .number()
  .int()
  .refine((v) => v === -1 || v > 0, { message: 'categoryId is a positive category id, or -1 for no category' })
  .describe('Jamf category id (Settings > Computer management > Categories), or -1 for no category');

const labelShape = Object.fromEntries(
  PARAMETER_KEYS.map((key) => [key, z.string().describe(`Label shown for ${key.replace('parameter', '$')} in a policy; "" for none`)]),
) as Record<ParameterKey, z.ZodString>;

export const parameterLabelsSchema = z
  .strictObject(labelShape)
  .describe('All eight labels, parameter4 to parameter11, each stated; "" for an unused parameter. Labels are not secret.');

/** Strict: no other fields are accepted, and none has a default. */
export const createScriptInputSchema = z.strictObject({
  name: objectName('name').describe('Script name. Refused if any script already has it (case-insensitive).'),
  categoryId: categoryIdSchema,
  priority: z.enum(SCRIPT_PRIORITIES).describe('Default priority Jamf shows when the script is attached to a policy'),
  info: z.string().describe('The Info field; "" for none'),
  notes: z.string().describe('The Notes field; "" for none'),
  parameterLabels: parameterLabelsSchema,
  osRequirements: z.string().describe('OS requirements, e.g. "15.x"; "" for none'),
  scriptContents: z
    .string()
    .describe(
      'The full script. Must start with "#!", use LF line endings and contain no NUL. Never echoed: ' +
        'results show its SHA-256 and length only.',
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'Defaults to TRUE. A dry run performs the reads, returns the exact request (contents as a hash) and ' +
        'writes nothing. Pass false only after the dry run has been reviewed.',
    ),
});

export type CreateScriptInput = z.infer<typeof createScriptInputSchema>;

// ---------------------------------------------------------------------------
// Shared lookups, also used by createPolicy
// ---------------------------------------------------------------------------

export interface CategoryInfo {
  id: number;
  name: string;
}

const NO_CATEGORY: CategoryInfo = { id: -1, name: '(no category)' };

/** Classic `categories/id/{id}`; needs `categories:read`. -1 is "no category" and is not looked up. */
export async function fetchCategory(client: JamfPlatformClient, id: number): Promise<CategoryInfo> {
  if (id === -1) return NO_CATEGORY;
  let body: unknown;
  try {
    body = await client.request({ service: 'proclassic', style: 'classic', resource: `categories/id/${id}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\(404\b/.test(message)) throw new Error(`Category ${id} does not exist (${message}). Nothing was written.`);
    throw error;
  }
  const detail = extractClassicDetail<Record<string, unknown>>(body as Record<string, unknown>, ['category']);
  if (!detail || typeof detail.name !== 'string') {
    throw new Error(`Category ${id}: unexpected response shape (no category.name). Nothing was written.`);
  }
  return { id, name: detail.name };
}

/** A Classic list of `{id, name}`, read fail-closed. */
export async function listClassicNames(
  client: JamfPlatformClient,
  resource: string,
  envelope: string,
): Promise<Array<{ id: number; name: string }>> {
  const body = await client.request<Record<string, unknown>>({ service: 'proclassic', style: 'classic', resource });
  return extractClassicList<{ id: unknown; name: unknown }>(body, [envelope]).items.map((item) => {
    const id = Number(item.id);
    if (!Number.isInteger(id) || typeof item.name !== 'string') {
      throw new Error(`${resource}: a list item has no readable id and name. Refusing to guess.`);
    }
    return { id, name: item.name };
  });
}

export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Validation and request body
// ---------------------------------------------------------------------------

/** Refuses contents macOS would not run as intended. Throws; never repairs. */
export function validateScriptContents(contents: string): void {
  if (contents.length === 0) throw new Error('scriptContents is empty.');
  if (!contents.startsWith('#!')) {
    throw new Error('scriptContents does not start with "#!". Jamf runs a script by its shebang; add one.');
  }
  if (contents.includes('\r')) {
    throw new Error('scriptContents contains a carriage return (CRLF line endings), which breaks interpreters on macOS. Convert to LF.');
  }
  if (contents.includes('\u0000')) throw new Error('scriptContents contains a NUL byte.');
}

/** `$4`, `${4}`; `$10` and up only in braces, since `$10` in a shell is `${1}0`. */
function referencesParameter(contents: string, n: number): boolean {
  const braced = new RegExp(`\\$\\{${n}\\}`);
  if (n >= 10) return braced.test(contents);
  return braced.test(contents) || new RegExp(`\\$${n}(?![0-9])`).test(contents);
}

export interface ScriptBody {
  name: string;
  info: string;
  notes: string;
  priority: (typeof SCRIPT_PRIORITIES)[number];
  categoryId: string;
  parameter4: string;
  parameter5: string;
  parameter6: string;
  parameter7: string;
  parameter8: string;
  parameter9: string;
  parameter10: string;
  parameter11: string;
  osRequirements: string;
  scriptContents: string;
}

/**
 * The exact JSON body. `categoryId` is a string because the published `Script`
 * schema types it so. No `id` (read-only) and no `categoryName` (derived).
 */
export function buildScriptBody(input: CreateScriptInput): ScriptBody {
  return {
    name: input.name,
    info: input.info,
    notes: input.notes,
    priority: input.priority,
    categoryId: String(input.categoryId),
    ...input.parameterLabels,
    osRequirements: input.osRequirements,
    scriptContents: input.scriptContents,
  };
}

export const SCRIPT_CREATE_PATH = '/pro/v1/scripts';

/** Lines as `wc -l` would count them, plus a final line with no newline. */
export function lineCount(text: string): number {
  const newlines = text.split('\n').length - 1;
  return text.length === 0 ? 0 : newlines + (text.endsWith('\n') ? 0 : 1);
}

/** The request as shown to a reviewer: every field as sent, except the contents, which are a digest. */
export function renderScriptRequest(body: ScriptBody) {
  const firstLine = body.scriptContents.split('\n', 1)[0] ?? '';
  return {
    method: 'POST' as const,
    path: SCRIPT_CREATE_PATH,
    contentType: 'application/json',
    body: {
      ...body,
      scriptContents: {
        ...digest(body.scriptContents),
        lines: lineCount(body.scriptContents),
        shebang: firstLine.startsWith('#!') ? firstLine : '',
      },
    },
  };
}

function warningsFor(input: CreateScriptInput): string[] {
  const warnings: string[] = [];
  if (Buffer.byteLength(input.scriptContents, 'utf8') > LARGE_SCRIPT_BYTES) {
    warnings.push(`scriptContents is over ${LARGE_SCRIPT_BYTES / 1024} KB.`);
  }
  PARAMETER_KEYS.forEach((key, i) => {
    const n = i + 4;
    if (input.parameterLabels[key] === '' && referencesParameter(input.scriptContents, n)) {
      warnings.push(`The script reads $${n} but ${key} has no label, so a policy author will see an unlabelled field.`);
    }
  });
  if (input.priority === 'AT_REBOOT') warnings.push('priority AT_REBOOT runs the script only when a policy reboots the Mac.');
  return warnings;
}

// ---------------------------------------------------------------------------
// Read-back
// ---------------------------------------------------------------------------

export interface Mismatch {
  field: string;
  sent: unknown;
  stored: unknown;
}

/** Compares every field sent with what Jamf stored; contents by digest only. */
export function compareScript(sent: ScriptBody, stored: unknown): Mismatch[] {
  if (!stored || typeof stored !== 'object') {
    return [{ field: '(script)', sent: 'an object', stored: typeof stored }];
  }
  const record = stored as Record<string, unknown>;
  const out: Mismatch[] = [];
  for (const key of Object.keys(sent) as Array<keyof ScriptBody>) {
    if (key === 'scriptContents') continue;
    const value = record[key];
    // categoryId is a string in the schema; accept a number Jamf might return, compare as text.
    const storedText = typeof value === 'number' ? String(value) : value;
    if (storedText !== sent[key]) out.push({ field: key, sent: sent[key], stored: value === undefined ? '(absent)' : value });
  }
  const storedContents = record.scriptContents;
  const sentDigest = digest(sent.scriptContents);
  if (typeof storedContents !== 'string') {
    out.push({ field: 'scriptContents', sent: sentDigest, stored: storedContents === undefined ? '(absent)' : typeof storedContents });
  } else {
    const storedDigest: ValueDigest = digest(storedContents);
    if (!sameDigest(sentDigest, storedDigest)) out.push({ field: 'scriptContents', sent: sentDigest, stored: storedDigest });
  }
  return out;
}

/** The new id from `HrefResponse {id, href}`; ids are strings in the Jamf Pro API. */
export function parseHrefId(response: unknown): number | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const id = Number((response as Record<string, unknown>).id);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

function requireWrites(ctx: WriteContext): void {
  if (!ctx.writesEnabled) {
    throw new Error(
      'Writes are disabled: JAMF_READ_ONLY is not "false" for this server. The dry run is still available. ' +
        'The write server is meant to run under its own integration with JAMF_READ_ONLY=false (JPM-0008).',
    );
  }
}

export async function createScript(ctx: WriteContext, rawInput: CreateScriptInput) {
  const input = createScriptInputSchema.parse(rawInput);
  validateScriptContents(input.scriptContents);

  const existing = await listClassicNames(ctx.client, 'scripts', 'scripts');
  const clash = existing.find((s) => sameName(s.name, input.name));
  if (clash) {
    throw new Error(
      `A script named "${clash.name}" already exists (id ${clash.id}). This tool creates only; ` +
        'choose a different name or change the existing script in the Jamf console.',
    );
  }
  const category = await fetchCategory(ctx.client, input.categoryId);

  const body = buildScriptBody(input);
  const plan = {
    action: 'createScript' as const,
    request: renderScriptRequest(body),
    category,
    warnings: warningsFor(input),
  };

  if (input.dryRun !== false) {
    return { dryRun: true, ...plan, next: 'Nothing was written. Call again with dryRun false to create this script.' };
  }
  requireWrites(ctx);

  const hidden = [input.scriptContents];
  const writtenAt = (ctx.now?.() ?? new Date()).toISOString();
  console.error(`[jamf-platform-write] ${writtenAt} create script "${input.name}"`);
  let response: unknown;
  try {
    response = await ctx.client.request({
      service: 'pro',
      version: 'v1',
      resource: 'scripts',
      method: 'POST',
      body,
    });
  } catch (error) {
    throw sanitizedWriteError(error, hidden, 'The script create failed.');
  }

  let id = parseHrefId(response);
  if (id === undefined) {
    id = (await listClassicNames(ctx.client, 'scripts', 'scripts')).find((s) => sameName(s.name, input.name))?.id;
  }
  if (id === undefined) {
    return {
      dryRun: false,
      ...plan,
      writtenAt,
      verification: {
        verified: false,
        mismatches: [],
        readBackError: 'Jamf accepted the create, but its response carried no id and no script by that name was found. Check Jamf.',
      },
    };
  }
  console.error(`[jamf-platform-write] ${writtenAt} created script id ${id}`);

  let verification: Record<string, unknown>;
  try {
    const stored = await ctx.client.request({ service: 'pro', version: 'v1', resource: `scripts/${id}` });
    const mismatches = compareScript(body, stored);
    verification = { verified: mismatches.length === 0, mismatches };
  } catch (error) {
    verification = {
      verified: false,
      mismatches: [],
      readBackError: `${sanitizedWriteError(error, hidden, 'Reading the new script back failed.').message} Check the script in Jamf before relying on it.`,
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
        'A new script does nothing until a policy runs it. This server cannot delete, so rolling back is manual: ' +
        'remove the script from every policy that uses it, then delete it in the Jamf console ' +
        '(Settings > Computer management > Scripts).',
      findReferences: { server: 'jamf-platform (read)', tool: 'findObjectReferences', arguments: { kind: 'script', id: String(id) } },
    },
  };
}
