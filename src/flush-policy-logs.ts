import { z } from 'zod';

import { extractClassicDetail } from './automations.js';
import { JamfPlatformApiError, type JamfPlatformClient, type RequestOptions } from './platform-client.js';
import type { WriteContext } from './restricted-software.js';
import { canonical, sha256 } from './scope-membership.js';
import { assertWriteServerRequestAllowed } from './write-route-guard.js';

/**
 * `flushPolicyLogs` (JPM-0017): flush one policy's log, for listed computers or for every
 * computer, so that a policy whose frequency limits it ("Once per computer") can run again
 * on those Macs. This is the only tool on the write server that sends HTTP DELETE, and it
 * sends it only to the two Classic routes below. `src/write-route-guard.ts` refuses every
 * other DELETE in front of the client, whatever any module asks for.
 *
 * Routes, read from Jamf's operation pages on 2026-11-10 (not yet called live):
 *
 * - listed computers: `DELETE /proclassic/logflush`, XML body (`logflush-2`):
 *   `<logflush><log>policy</log><log_id>N</log_id><interval>Zero Days</interval>
 *   <computers><computer><id>N</id></computer>...</computers></logflush>`
 * - every computer: `DELETE /proclassic/logflush/policy/id/{id}/interval/{interval}`
 *   (`createlogflushwithidandinterval-1`), interval spelled with `+`, e.g. `Zero+Days`.
 *
 * Both need `flush-policy-logs:execute`. The all-policies route
 * (the logflush route with an interval and no policy id) is never built, and the guard refuses it.
 *
 * A flush cannot be read back by this server: a computer's policy log is computer history
 * (`/computerhistory/id/{id}/subset/PolicyLogs`), which needs `device-history:read`, and
 * JPM-0013 keeps device reads off the write integration. So the tool reads back what it can
 * (the policy still exists and is unchanged), never reports the flush itself as verified,
 * and returns the exact read-server calls that confirm it.
 */

export const LOG_FLUSH_INTERVALS = [
  'Zero Days',
  'Zero Weeks',
  'Zero Months',
  'Zero Years',
  'One Days',
  'One Weeks',
  'One Months',
  'One Years',
  'Two Days',
  'Two Weeks',
  'Two Months',
  'Two Years',
  'Three Days',
  'Three Weeks',
  'Three Months',
  'Three Years',
  'Six Days',
  'Six Weeks',
  'Six Months',
  'Six Years',
] as const;
export type LogFlushInterval = (typeof LOG_FLUSH_INTERVALS)[number];

/** Computers named in one call. Each is one `<computer>` in the body and one read-server check. */
export const MAX_FLUSH_COMPUTERS = 100;

const SERVICE = 'proclassic';

const computerIdsSchema = z
  .array(z.number().int().positive())
  .min(1)
  .max(MAX_FLUSH_COMPUTERS)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'computerIds lists a computer more than once' })
  .describe(
    `1 to ${MAX_FLUSH_COMPUTERS} Jamf Pro computer ids whose log entries for this policy are flushed. ` +
      'Not checked before the write (the write integration cannot read computers): confirm them with the read server first.',
  );

/** Strict: no other fields are accepted, and none has a default. */
export const flushPolicyLogsInputSchema = z.strictObject({
  policyId: z.number().int().positive().describe('Classic id of the policy whose log is flushed'),
  computers: z
    .union([
      z.strictObject({ computerIds: computerIdsSchema }),
      z.strictObject({
        allComputers: z
          .literal(true)
          .describe('Flush this policy\'s log for EVERY computer. Must be stated as true; it is never inferred.'),
      }),
    ])
    .describe('Exactly one of {"computerIds": [...]} or {"allComputers": true}. Nothing defaults.'),
  interval: z
    .enum(LOG_FLUSH_INTERVALS)
    .describe(
      'Jamf\'s interval, one of [Zero, One, Two, Three, Six] x [Days, Weeks, Months, Years]. Jamf flushes entries ' +
        'older than the interval, so "Zero Days" flushes every entry, which is what makes a "Once per computer" ' +
        'policy run again. No default.',
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'Defaults to TRUE. A dry run reads the policy, returns the exact request and a planHash, and flushes nothing. ' +
        'Pass false only with the planHash from a reviewed dry run.',
    ),
  planHash: z
    .string()
    .optional()
    .describe('Required when dryRun is false: the planHash returned by the dry run you reviewed.'),
});

export type FlushPolicyLogsInput = z.infer<typeof flushPolicyLogsInputSchema>;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export function buildLogFlushXml(policyId: number, interval: LogFlushInterval, computerIds: number[]): string {
  const computers = computerIds.map((id) => `<computer><id>${id}</id></computer>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<logflush><log>policy</log><log_id>${policyId}</log_id><interval>${interval}</interval>` +
    `<computers>${computers}</computers></logflush>`
  );
}

/** The interval as a path segment, in the form Jamf's page gives (`Three+Months`). */
export const intervalPathSegment = (interval: LogFlushInterval) => interval.replace(' ', '+');

/** The exact request for this input. The guard is applied here too, so a dry run shows only what could be sent. */
export function buildFlushRequest(input: FlushPolicyLogsInput): RequestOptions {
  const request: RequestOptions =
    'computerIds' in input.computers
      ? {
          service: SERVICE,
          style: 'classic',
          resource: 'logflush',
          method: 'DELETE',
          bodyFormat: 'xml',
          body: buildLogFlushXml(input.policyId, input.interval, input.computers.computerIds),
        }
      : {
          service: SERVICE,
          style: 'classic',
          resource: `logflush/policy/id/${input.policyId}/interval/${intervalPathSegment(input.interval)}`,
          method: 'DELETE',
        };
  assertWriteServerRequestAllowed(request);
  return request;
}

export function renderFlushRequest(request: RequestOptions) {
  return {
    method: request.method,
    path: `/${request.service}/${request.resource}`,
    ...(request.body === undefined ? {} : { contentType: 'application/xml', body: request.body }),
  };
}

// ---------------------------------------------------------------------------
// The policy: read, summarise, fingerprint
// ---------------------------------------------------------------------------

export interface PolicySummary {
  id: number;
  name: string;
  enabled: boolean | 'unknown';
  frequency: string;
  scope: {
    allComputers: boolean | 'unknown';
    computers: number;
    computerGroups: number;
    excludedComputers: number;
    excludedComputerGroups: number;
  };
}

export interface LivePolicy {
  summary: PolicySummary;
  /** SHA-256 over the whole policy as read, canonicalised. */
  fingerprint: string;
}

const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);

export function parsePolicy(body: unknown, id: number): LivePolicy {
  const policy = extractClassicDetail<Record<string, unknown>>(body as Record<string, unknown>, ['policy']);
  const general = policy?.general as Record<string, unknown> | undefined;
  if (!policy || !general || typeof general.name !== 'string') {
    throw new Error(`Policy ${id}: unexpected response shape (no policy.general.name).`);
  }
  const scope = (policy.scope ?? {}) as Record<string, unknown>;
  const exclusions = (scope.exclusions ?? {}) as Record<string, unknown>;
  return {
    summary: {
      id,
      name: general.name,
      enabled: typeof general.enabled === 'boolean' ? general.enabled : 'unknown',
      frequency: typeof general.frequency === 'string' ? general.frequency : '(not readable)',
      scope: {
        allComputers: typeof scope.all_computers === 'boolean' ? scope.all_computers : 'unknown',
        computers: count(scope.computers),
        computerGroups: count(scope.computer_groups),
        excludedComputers: count(exclusions.computers),
        excludedComputerGroups: count(exclusions.computer_groups),
      },
    },
    fingerprint: sha256(canonical(policy)),
  };
}

async function readPolicy(client: JamfPlatformClient, id: number, afterFlush = false): Promise<LivePolicy> {
  let body: unknown;
  try {
    body = await client.request({ service: SERVICE, style: 'classic', resource: `policies/id/${id}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof JamfPlatformApiError && error.status === 404) {
      throw new Error(
        afterFlush
          ? `Policy ${id} no longer reads after the flush (${message}).`
          : `Policy ${id} does not exist (${message}). Nothing was flushed.`,
      );
    }
    throw error;
  }
  if (afterFlush) return parsePolicy(body, id);
  try {
    return parsePolicy(body, id);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} Nothing was flushed.`);
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export function planHashFor(input: FlushPolicyLogsInput, policy: LivePolicy): string {
  return sha256(
    canonical({
      action: 'flushPolicyLogs',
      policyId: input.policyId,
      computers: 'computerIds' in input.computers ? { computerIds: input.computers.computerIds } : { allComputers: true },
      interval: input.interval,
      policyFingerprint: policy.fingerprint,
    }),
  );
}

function warningsFor(input: FlushPolicyLogsInput, policy: PolicySummary): string[] {
  const warnings: string[] = [];
  if (policy.frequency !== 'Once per computer') {
    warnings.push(
      `The policy's frequency is "${policy.frequency}", not "Once per computer". A flush deletes its history either way, ` +
        'but whether it changes when the policy runs depends on that frequency.',
    );
  }
  if (policy.enabled === false) {
    warnings.push('The policy is disabled: it runs on no Mac until it is enabled, whatever its log says.');
  }
  if (policy.enabled === true) {
    warnings.push(
      'The policy is enabled. A Mac in its scope whose entry is flushed runs it again at its next matching trigger.',
    );
  }
  if ('allComputers' in input.computers) {
    warnings.push(
      'allComputers: every computer\'s entry for this policy older than the interval is flushed, not only the Macs ' +
        'now in its scope.',
    );
  } else {
    warnings.push(
      'Computer ids are NOT checked before the flush: this server cannot read computers. A wrong id flushes the ' +
        'wrong Mac\'s entry or nothing. Confirm each id with the read server first.',
    );
  }
  if (input.interval !== 'Zero Days') {
    warnings.push(
      `Interval "${input.interval}" keeps entries newer than that, so a Mac that ran the policy more recently keeps ` +
        'its entry and will not run a "Once per computer" policy again. "Zero Days" flushes every entry.',
    );
  }
  return warnings;
}

/** The read-server calls that show whether the flush took. The write server cannot make them. */
export function readServerChecks(input: FlushPolicyLogsInput) {
  const expect =
    `No policy_logs entry with policy_id ${input.policyId}` +
    (input.interval === 'Zero Days' ? '' : ` older than ${input.interval}`) +
    ' remains. Needs device-history:read on the read integration.';
  if ('allComputers' in input.computers) {
    return {
      server: 'jamf-platform (read)',
      tool: 'platformRequest',
      note:
        'allComputers: there is no list of which Macs had entries. Check a sample of Macs known to have run the ' +
        'policy, with the call below per computer id.',
      template: { service: SERVICE, style: 'classic', resource: 'computerhistory/id/{computerId}/subset/PolicyLogs' },
      expect,
    };
  }
  return {
    server: 'jamf-platform (read)',
    tool: 'platformRequest',
    calls: input.computers.computerIds.map((id) => ({
      service: SERVICE,
      style: 'classic',
      resource: `computerhistory/id/${id}/subset/PolicyLogs`,
    })),
    expect,
  };
}

const ROLLBACK = {
  possible: false,
  effect:
    'A flush cannot be undone. The flushed entries were this policy\'s execution history for those Macs, and Jamf ' +
    'does not restore them. What follows from it: a policy whose frequency limits it (such as "Once per computer") ' +
    'may run again on those Macs at its next matching trigger, if it is enabled and they are in its scope.',
  toStopReruns:
    'Disable the policy in the Jamf console, or remove those Macs from its scope with applyScopeChanges (as a target ' +
    'removed, or an exclusion added). Neither brings back the flushed entries.',
};

function requireWrites(ctx: WriteContext): void {
  if (!ctx.writesEnabled) {
    throw new Error(
      'Writes are disabled: JAMF_READ_ONLY is not "false" for this server. The dry run is still available. ' +
        'The write server is meant to run under its own integration with JAMF_READ_ONLY=false (JPM-0008).',
    );
  }
}

/** Longest response body quoted from a rejected flush. The body holds no hidden value; this only keeps it short. */
const MAX_ERROR_BODY = 1000;

function rejectedError(error: JamfPlatformApiError, writtenAt: string): Error {
  const body = error.responseBody
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_BODY);
  return new Error(
    `${error.message}\nURL: ${error.url}\nResponse (truncated): ${body}\n` +
      `Jamf answered HTTP ${error.status} at ${writtenAt}: the log was NOT flushed. Nothing is reported as flushed, ` +
      'and nothing was read back (JPM-0014: a rejected request is not a write).',
  );
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

export async function flushPolicyLogs(ctx: WriteContext, rawInput: FlushPolicyLogsInput) {
  const input = flushPolicyLogsInputSchema.parse(rawInput);
  const isDryRun = input.dryRun !== false;
  if (!isDryRun && !input.planHash) {
    throw new Error(
      'A live flush requires planHash: the planHash returned by a reviewed dry run of exactly this policy, these ' +
        'computers and this interval. Nothing was flushed.',
    );
  }

  const request = buildFlushRequest(input);
  const policy = await readPolicy(ctx.client, input.policyId);
  const planHash = planHashFor(input, policy);
  const plan = {
    action: 'flushPolicyLogs' as const,
    policy: policy.summary,
    computers: 'computerIds' in input.computers ? { computerIds: input.computers.computerIds } : { allComputers: true },
    interval: input.interval,
    request: renderFlushRequest(request),
    warnings: warningsFor(input, policy.summary),
    whatWouldBeFlushed:
      'This server cannot read which computers have entries for this policy (computer history needs ' +
      'device-history:read, which the write integration does not hold). Run checkBeforeAndAfter on the read server ' +
      'before the live call to see them, and again after it.',
    checkBeforeAndAfter: readServerChecks(input),
    rollback: ROLLBACK,
  };

  if (isDryRun) {
    return {
      dryRun: true,
      ...plan,
      planHash,
      next: 'Nothing was flushed. To flush, call again with exactly these arguments, dryRun false and this planHash.',
    };
  }

  if (input.planHash !== planHash) {
    throw new Error(
      'planHash does not match: the policy changed since the dry run, or the arguments differ from the ones dry-run. ' +
        'Nothing was flushed. Dry-run again and review.',
    );
  }
  requireWrites(ctx);

  const writtenAt = (ctx.now?.() ?? new Date()).toISOString();
  const target = 'computerIds' in input.computers ? `${input.computers.computerIds.length} computer(s)` : 'all computers';
  console.error(
    `[jamf-platform-write] ${writtenAt} flush policy ${input.policyId} log, ${target}, interval "${input.interval}"`,
  );
  try {
    await ctx.client.request(request);
  } catch (error) {
    if (error instanceof JamfPlatformApiError) throw rejectedError(error, writtenAt);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\nThe flush request got no HTTP response at ${writtenAt}. It may or may not have been applied: ` +
        'check with the read server (checkBeforeAndAfter in the dry run) before retrying.',
    );
  }
  console.error(`[jamf-platform-write] ${writtenAt} flush of policy ${input.policyId} log accepted`);

  let policyReadBack: Record<string, unknown>;
  try {
    const after = await readPolicy(ctx.client, input.policyId, true);
    policyReadBack = {
      present: true,
      unchanged: after.fingerprint === policy.fingerprint,
      ...(after.fingerprint === policy.fingerprint
        ? {}
        : { note: 'The policy reads differently after the flush. A flush should not change it: check it in Jamf.' }),
    };
  } catch (error) {
    policyReadBack = {
      present: false,
      error: `${error instanceof Error ? error.message : String(error)} Reading the policy back after the flush failed. Check it in Jamf now.`,
    };
  }

  return {
    dryRun: false,
    ...plan,
    planHash,
    writtenAt,
    accepted: true,
    verification: {
      flushVerified: false,
      reason:
        'Jamf accepted the request (HTTP 2xx), which is not proof of the flush. This server cannot read computer ' +
        'history; run checkBeforeAndAfter on the read server to confirm it.',
      policyReadBack,
    },
    log:
      'Jamf\'s API offers no history read for a flush, so writtenAt is the only exact time this server can give. Record it in the ' +
      'change log with the policy, the computers and the interval.',
  };
}
