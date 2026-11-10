import { z } from 'zod';

import { listClassicNames, sameName } from './create-script.js';
import type { NormalizedByJamf } from './payload-normalization.js';
import { JamfPlatformApiError } from './platform-client.js';
import type { WriteContext } from './restricted-software.js';
import {
  KINDS,
  SERVICE,
  buildScopeOnlyXml,
  canonical,
  fetchGroup,
  fetchLive,
  fingerprintNonScope,
  judgeNonScope,
  scopeMismatches,
  sha256,
  type Fingerprint,
  type GroupInfo,
  type LiveScopedObject,
  type MembershipScope,
  type ScopeAction,
  type ScopeKind,
} from './scope-membership.js';

/**
 * The scope-change engine (JPM-0010, generalised by JPM-0014 as JPM-0013 decision 2 planned):
 * add or remove a computer group or a computer, as a target (the inclusion lists) or an
 * exclusion, in the scope of macOS configuration profiles and policies, reviewed and approved
 * once.
 *
 * - Operations are grouped by object; each object gets ONE scope-only PUT carrying its final
 *   scope, so no intermediate scope is ever live.
 * - A dry run reads everything, applies every refusal, and returns a plan hash. A live run
 *   re-reads, recomputes the hash and writes nothing if anything changed.
 * - Each PUT is read back: the stored scope must equal the intended one and the non-scope
 *   fingerprint must be unchanged (or exactly Jamf's normalisation, JPM-0011).
 * - A PUT that Jamf answers with an HTTP error is NOT a write, whatever a read shows
 *   afterwards (JPM-0014): it is not read back, it does not count as written, and it is kept
 *   out of the rollback.
 * - Stop on the first failure; the rollback is an inverse batch that must itself be dry-run.
 *
 * `applyScopeChanges` (this module) and `applyScopeMembershipBatch`
 * (`scope-membership-batch.ts`, computer-group inclusions only) are two input formats over this
 * one engine. Hashes only are ever returned or logged, never payload content.
 */

export const MAX_SCOPE_OPERATIONS = 150;

export type ScopeMember = 'computerGroup' | 'computer';
export type ScopeList = 'include' | 'exclude';

/** One operation, in the engine's own normalised form. */
export interface ScopeChange {
  kind: ScopeKind;
  id: number;
  action: ScopeAction;
  member: ScopeMember;
  list: ScopeList;
  memberId: number;
}

const FIELD = { computerGroup: 'computerGroupIds', computer: 'computerIds' } as const;
const MEMBER_NOUN: Record<ScopeMember, string> = { computerGroup: 'Computer group', computer: 'Computer' };
const LIST_NOUN: Record<ScopeList, string> = { include: 'scope', exclude: 'exclusions' };
const MEMBERS: ScopeMember[] = ['computerGroup', 'computer'];
const LISTS: ScopeList[] = ['include', 'exclude'];

/** The result path of one list, as `scopeMismatches` names it. */
export const listPath = (member: ScopeMember, list: ScopeList) =>
  list === 'include' ? `scope.${FIELD[member]}` : `scope.exclusions.${FIELD[member]}`;

/** Every list this engine can change, in a fixed order. */
export const LIST_PATHS = LISTS.flatMap((list) => MEMBERS.map((member) => listPath(member, list)));

export function listOf(scope: MembershipScope, member: ScopeMember, list: ScopeList): number[] {
  return (list === 'include' ? scope : scope.exclusions)[FIELD[member]];
}

function withList(scope: MembershipScope, member: ScopeMember, list: ScopeList, ids: number[]): MembershipScope {
  if (list === 'include') return { ...scope, [FIELD[member]]: ids };
  return { ...scope, exclusions: { ...scope.exclusions, [FIELD[member]]: ids } };
}

// ---------------------------------------------------------------------------
// applyScopeChanges input. Every field is stated; nothing defaults (JPM-0013 decision 2).
// ---------------------------------------------------------------------------

const common = {
  kind: z.enum(['profile', 'policy']).describe('"profile" (macOS configuration profile) or "policy"'),
  id: z.number().int().positive().describe('Classic id of the configuration profile or policy'),
  action: z.enum(['add', 'remove']),
  list: z
    .enum(['include', 'exclude'])
    .describe('"include": the scope\'s targets. "exclude": scope.exclusions, which win over targets.'),
};

export const scopeChangeOperationSchema = z.discriminatedUnion('member', [
  z.strictObject({
    ...common,
    member: z.literal('computerGroup'),
    computerGroupId: z.number().int().positive().describe('Classic id of the computer group (static or smart)'),
  }),
  z.strictObject({
    ...common,
    member: z.literal('computer'),
    computerId: z
      .number()
      .int()
      .positive()
      .describe('Jamf Pro id of the computer. Not checked before the write: confirm it with the read server first.'),
  }),
]);

/** Strict: no other fields are accepted. */
export const scopeChangesInputSchema = z.strictObject({
  operations: z
    .array(scopeChangeOperationSchema)
    .min(1)
    .max(MAX_SCOPE_OPERATIONS)
    .describe(`1 to ${MAX_SCOPE_OPERATIONS} operations. Operations on one object land in one PUT.`),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'Defaults to TRUE. A dry run reads, validates every operation and returns the plan and its planHash; ' +
        'it writes nothing. Pass false only with the planHash from a reviewed dry run.',
    ),
  planHash: z
    .string()
    .optional()
    .describe('Required when dryRun is false: the planHash returned by the dry run you reviewed.'),
});

export type ScopeChangeOperation = z.infer<typeof scopeChangeOperationSchema>;
export type ScopeChangesInput = z.infer<typeof scopeChangesInputSchema>;

export const fromOperation = (op: ScopeChangeOperation): ScopeChange => ({
  kind: op.kind,
  id: op.id,
  action: op.action,
  member: op.member,
  list: op.list,
  memberId: op.member === 'computerGroup' ? op.computerGroupId : op.computerId,
});

export const toOperation = (c: ScopeChange): ScopeChangeOperation =>
  c.member === 'computerGroup'
    ? { kind: c.kind, id: c.id, action: c.action, member: 'computerGroup', list: c.list, computerGroupId: c.memberId }
    : { kind: c.kind, id: c.id, action: c.action, member: 'computer', list: c.list, computerId: c.memberId };

/** The operation as listed under its object: everything but kind and id. */
function describeChange(c: ScopeChange) {
  const { kind: _kind, id: _id, ...rest } = toOperation(c);
  return rest;
}

export const inverseChange = (c: ScopeChange): ScopeChange => ({
  ...c,
  action: c.action === 'add' ? 'remove' : 'add',
});

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface ScopeRefusal {
  kind: ScopeKind;
  id: number;
  change: ScopeChange | null;
  reason: string;
}

export interface PlannedObject {
  kind: ScopeKind;
  id: number;
  live: LiveScopedObject;
  changes: ScopeChange[];
  intended: MembershipScope;
  /** The lists this object's operations touch, in LIST_PATHS order. */
  affected: string[];
  warnings: string[];
  fingerprint: Fingerprint;
}

export interface ScopePlan {
  refusals: ScopeRefusal[];
  objects: PlannedObject[];
  groups: GroupInfo[];
  computerIds: number[];
  planHash?: string;
}

const objectKey = (kind: ScopeKind, id: number) => `${kind}:${id}`;
const memberKey = (c: ScopeChange) => `${c.member}:${c.list}:${c.memberId}`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sortIds = (ids: Iterable<number>) => [...new Set(ids)].sort((x, y) => x - y);

/**
 * True when the scope has inclusions but provably reaches no computer: every inclusion is a
 * computer or a computer group, and every one of them is also excluded. Buildings and
 * departments cannot be compared with computers without reading inventory, so a scope that
 * includes any is never called empty. Group membership is not read either: a computer that is
 * excluded only through a group is not detected (JPM-0014).
 */
export function targetsNothingProvably(scope: MembershipScope): boolean {
  const included = [...scope.computerIds, ...scope.computerGroupIds];
  if (included.length === 0) return false;
  if (scope.buildingIds.length > 0 || scope.departmentIds.length > 0) return false;
  return (
    scope.computerIds.every((id) => scope.exclusions.computerIds.includes(id)) &&
    scope.computerGroupIds.every((id) => scope.exclusions.computerGroupIds.includes(id))
  );
}

const hasNoInclusions = (scope: MembershipScope) =>
  scope.computerIds.length + scope.computerGroupIds.length + scope.buildingIds.length + scope.departmentIds.length === 0;

/**
 * Policies whose name another policy shares, by policy id, or the reason the list could not be
 * read. Jamf's Classic API has been seen to answer a scope PUT to such a policy with HTTP 409
 * and not save it, while reads went on showing the rejected scope for several minutes
 * (JPM-0014). So the engine refuses rather than send a PUT expected to fail misleadingly.
 */
async function sharedPolicyNames(ctx: WriteContext): Promise<Array<{ id: number; name: string }> | string> {
  try {
    return await listClassicNames(ctx.client, 'policies', 'policies');
  } catch (error) {
    return message(error);
  }
}

/** Read every distinct object and group once, validate every operation, hash the plan. */
export async function buildScopePlan(ctx: WriteContext, changes: ScopeChange[]): Promise<ScopePlan> {
  const refusals: ScopeRefusal[] = [];

  // Group by object, first-appearance order of objects, operation order within an object.
  const byObject = new Map<string, ScopeChange[]>();
  for (const c of changes) {
    const key = objectKey(c.kind, c.id);
    const list = byObject.get(key);
    if (list) list.push(c);
    else byObject.set(key, [c]);
  }

  // Each distinct group, read once, in first-appearance order. Computers are not read: the
  // write integration holds no device read permission (JPM-0013 operator decision 4).
  const groups = new Map<number, GroupInfo | string>();
  for (const c of changes) {
    if (c.member !== 'computerGroup' || groups.has(c.memberId)) continue;
    try {
      groups.set(c.memberId, await fetchGroup(ctx.client, c.memberId));
    } catch (error) {
      groups.set(c.memberId, message(error));
    }
  }

  // The policy list, read once, only if a policy is in the batch.
  const policyNames = changes.some((c) => c.kind === 'policy') ? await sharedPolicyNames(ctx) : [];

  const objects: PlannedObject[] = [];
  for (const ops of byObject.values()) {
    const { kind, id } = ops[0] as ScopeChange;
    const spec = KINDS[kind];
    const refuse = (c: ScopeChange | null, reason: string) => refusals.push({ kind, id, change: c, reason });

    let live: LiveScopedObject;
    try {
      live = await fetchLive(ctx.client, kind, id);
    } catch (error) {
      for (const c of ops) refuse(c, `${spec.noun} ${id} could not be read: ${message(error)}`);
      continue;
    }

    let objectOk = true;
    if (live.scope.allComputers) {
      refuse(null, `${spec.noun} ${id} is scoped to All Computers. Changing its scope lists is meaningless there.`);
      objectOk = false;
    }
    if (live.unmodelledScope.length > 0) {
      refuse(
        null,
        `${spec.noun} ${id}'s live scope uses ${live.unmodelledScope.join(', ')}, which this tool does not model. ` +
          'Sending the scope would silently drop it. Make this change in the Jamf UI.',
      );
      objectOk = false;
    }
    if (kind === 'profile' && live.redeployOnUpdate !== 'Newly Assigned') {
      refuse(
        null,
        `Configuration profile ${id} has redeploy_on_update ${JSON.stringify(live.redeployOnUpdate)}, not exactly ` +
          '"Newly Assigned". Whether a scope update would redeploy it to every scoped Mac is unverified (JPM-0009).',
      );
      objectOk = false;
    }
    if (kind === 'policy') {
      if (typeof policyNames === 'string') {
        refuse(null, `The policy list could not be read to check policy ${id}'s name is unique: ${policyNames}`);
        objectOk = false;
      } else if (live.name === undefined) {
        refuse(null, `Policy ${id} has no readable name, so it cannot be checked for a duplicate name.`);
        objectOk = false;
      } else {
        const name = live.name;
        const others = policyNames.filter((p) => p.id !== id && sameName(p.name, name)).map((p) => p.id);
        if (others.length > 0) {
          refuse(
            null,
            `Policy ${id} shares its name "${name}" with polic${others.length === 1 ? 'y' : 'ies'} ${others.join(', ')}. ` +
              'Jamf has been seen to reject a scope PUT to such a policy with HTTP 409 while reads went on showing ' +
              'the rejected change (JPM-0014). Rename one of them in the Jamf console, then dry-run again.',
          );
          objectOk = false;
        }
      }
    }

    // Each list's ids after this object's operations, evaluated against the live scope.
    // Duplicates of (member, list, id) are refused, so this equals applying them in order.
    const seen = new Set<string>();
    let intended = live.scope;
    for (const c of ops) {
      const label = `${MEMBER_NOUN[c.member]} ${c.memberId}`;
      if (c.member === 'computerGroup') {
        const group = groups.get(c.memberId);
        if (typeof group === 'string') {
          refuse(c, group);
          objectOk = false;
          continue;
        }
      }
      if (seen.has(memberKey(c))) {
        refuse(c, `${label} appears more than once for ${spec.noun} ${id}'s ${LIST_NOUN[c.list]} in this batch.`);
        objectOk = false;
        continue;
      }
      seen.add(memberKey(c));
      const group = c.member === 'computerGroup' ? (groups.get(c.memberId) as GroupInfo) : undefined;
      const named = group ? `${label} ("${group.name}")` : label;
      const present = listOf(live.scope, c.member, c.list).includes(c.memberId);
      if (c.action === 'add' && present) {
        refuse(c, `${named} is already in ${spec.noun} ${id}'s ${LIST_NOUN[c.list]}.`);
        objectOk = false;
        continue;
      }
      if (c.action === 'remove' && !present) {
        refuse(c, `${named} is not in ${spec.noun} ${id}'s ${LIST_NOUN[c.list]}.`);
        objectOk = false;
        continue;
      }
      const current = listOf(intended, c.member, c.list);
      intended = withList(
        intended,
        c.member,
        c.list,
        c.action === 'add' ? sortIds([...current, c.memberId]) : current.filter((m) => m !== c.memberId),
      );
    }

    // The same member added to the target list and the exclusion list in one plan.
    for (const member of MEMBERS) {
      const addedTo = (list: ScopeList) =>
        ops.filter((c) => c.member === member && c.list === list && c.action === 'add').map((c) => c.memberId);
      const included = addedTo('include');
      for (const c of ops) {
        if (c.member === member && c.list === 'exclude' && c.action === 'add' && included.includes(c.memberId)) {
          refuse(
            c,
            `${MEMBER_NOUN[member]} ${c.memberId} is added to both ${spec.noun} ${id}'s scope and its exclusions in ` +
              'this batch. Exclusions win, so the add to the scope does nothing. Keep one of the two.',
          );
          objectOk = false;
        }
      }
    }
    if (!objectOk) continue;

    // Provably targets nothing after the change, when it did not before.
    if (targetsNothingProvably(intended) && !targetsNothingProvably(live.scope)) {
      refuse(
        null,
        `After this change every computer and computer group in ${spec.noun} ${id}'s scope would also be excluded, ` +
          'so it would reach no computer. To switch it off, remove the targets instead of excluding them all.',
      );
      continue;
    }

    const warnings: string[] = [];
    if (kind === 'profile') {
      warnings.push(`Live redeploy_on_update is "${live.redeployOnUpdate}".`);
      if (live.distributionMethod && /self service/i.test(live.distributionMethod)) {
        warnings.push(
          `Distribution method is "${live.distributionMethod}": a scope change changes who can see and install it in Self Service.`,
        );
      }
      if (ops.some((c) => (c.list === 'include') === (c.action === 'remove'))) {
        warnings.push(
          'Jamf removes a configuration profile from a Mac that leaves its scope, so a Mac this change takes out of ' +
            'scope (a target removed or an exclusion added) loses the profile.',
        );
      }
    } else {
      warnings.push('Changing a policy scope changes which Macs run it at their next matching trigger and frequency.');
    }
    for (const c of ops) {
      if (c.action !== 'add') continue;
      const other: ScopeList = c.list === 'include' ? 'exclude' : 'include';
      if (!listOf(intended, c.member, other).includes(c.memberId)) continue;
      const noun = c.member === 'computerGroup' ? 'Group' : 'Computer';
      warnings.push(
        c.list === 'include'
          ? `${noun} ${c.memberId} is also in this ${spec.noun}'s exclusions; exclusions win, and this change does not touch them.`
          : `${noun} ${c.memberId} is also in this ${spec.noun}'s scope; exclusions win, so it will not be targeted.`,
      );
    }
    const addedComputers = sortIds(ops.filter((c) => c.member === 'computer' && c.action === 'add').map((c) => c.memberId));
    if (addedComputers.length > 0) {
      warnings.push(
        `Computer id${addedComputers.length === 1 ? '' : 's'} ${addedComputers.join(', ')} ${addedComputers.length === 1 ? 'is' : 'are'} ` +
          'not checked before the write: this server holds no device read permission (JPM-0013). Confirm each id ' +
          'with the read server first. An id that does not exist is caught on read-back; the id of the wrong Mac is not.',
      );
    }
    if (hasNoInclusions(intended) && !hasNoInclusions(live.scope)) {
      warnings.push(`After this change the ${spec.noun} has no targets, so it reaches no computer.`);
    }

    objects.push({
      kind,
      id,
      live,
      changes: ops,
      intended,
      affected: LIST_PATHS.filter((p) => ops.some((c) => listPath(c.member, c.list) === p)),
      warnings,
      fingerprint: fingerprintNonScope(live.nonScope),
    });
  }

  const groupList = [...groups.values()].filter((g): g is GroupInfo => typeof g !== 'string');
  const computerIds = sortIds(changes.filter((c) => c.member === 'computer').map((c) => c.memberId));
  if (refusals.length > 0) return { refusals, objects, groups: groupList, computerIds };

  // Binds the live run to the reviewed dry run: the operations as given (member and list
  // included), each object's whole modelled live scope (targets and exclusions, groups and
  // computers) and its non-scope fingerprint, and each group's id, name and kind.
  const planHash = sha256(
    canonical({
      operations: changes.map((c) => ({
        kind: c.kind,
        id: c.id,
        action: c.action,
        member: c.member,
        list: c.list,
        memberId: c.memberId,
      })),
      objects: objects.map((o) => ({
        kind: o.kind,
        id: o.id,
        scope: o.live.scope,
        nonScopeOverall: o.fingerprint.overall,
      })),
      groups: [...groupList]
        .sort((a, b) => a.id - b.id)
        .map((g) => ({ id: g.id, name: g.name, isSmart: g.isSmart })),
    }),
  );
  return { refusals, objects, groups: groupList, computerIds, planHash };
}

/** Before or after, for the lists an object's operations touch. */
export const listsOf = (scope: MembershipScope, paths: string[]) => {
  const out: Record<string, number[]> = {};
  for (const member of MEMBERS) {
    for (const list of LISTS) {
      const path = listPath(member, list);
      if (paths.includes(path)) out[path] = listOf(scope, member, list);
    }
  }
  return Object.fromEntries(LIST_PATHS.filter((p) => p in out).map((p) => [p, out[p] as number[]]));
};

// ---------------------------------------------------------------------------
// Live run
// ---------------------------------------------------------------------------

export type ObjectStatus = 'written' | 'failed' | 'notAttempted';

export interface ObjectResult {
  kind: ScopeKind;
  id: number;
  status: ObjectStatus;
  writtenAt: string | null;
  verified: boolean | null;
  otherFieldsUnchanged: boolean | null;
  differingSections: string[];
  /** Present only when the non-scope difference is exactly Jamf's identifier normalisation (JPM-0011). */
  normalizedByJamf?: NormalizedByJamf;
  otherFieldsSemanticallyUnchanged?: true;
  /** The HTTP status Jamf answered the PUT with, when it was an error: the object was not written (JPM-0014). */
  rejectedWithHttpStatus: number | null;
  error: string | null;
}

export interface ScopeRunResult {
  results: ObjectResult[];
  stopped: boolean;
  /** Objects whose PUT was accepted (2xx) or got no HTTP response at all, in write order. */
  rollbackObjects: PlannedObject[];
  /** Objects whose PUT Jamf answered with an HTTP error, with that status. */
  rejected: Array<{ object: PlannedObject; httpStatus: number }>;
}

export function assertLiveAllowed(ctx: WriteContext, plan: ScopePlan, planHash: string | undefined) {
  if (planHash !== plan.planHash) {
    throw new Error('live state changed since the dry run; dry-run again. Nothing was written.');
  }
  if (!ctx.writesEnabled) {
    throw new Error(
      'Writes are disabled: JAMF_READ_ONLY is not "false" for this server. The dry run is still available. ' +
        'The write server is meant to run under its own integration with JAMF_READ_ONLY=false (JPM-0008).',
    );
  }
}

/** Writes each object in order, one PUT each, verifying as it goes; stops on the first failure. */
export async function runScopePlan(ctx: WriteContext, plan: ScopePlan): Promise<ScopeRunResult> {
  const results: ObjectResult[] = [];
  const rollbackObjects: PlannedObject[] = [];
  const rejected: ScopeRunResult['rejected'] = [];
  let stopped = false;

  for (const obj of plan.objects) {
    const base = { kind: obj.kind, id: obj.id, rejectedWithHttpStatus: null };
    if (stopped) {
      results.push({
        ...base,
        status: 'notAttempted',
        writtenAt: null,
        verified: null,
        otherFieldsUnchanged: null,
        differingSections: [],
        error: null,
      });
      continue;
    }
    const spec = KINDS[obj.kind];
    const writtenAt = (ctx.now?.() ?? new Date()).toISOString();
    const n = obj.changes.length;
    console.error(
      `[jamf-platform-write] ${writtenAt} batch: set scope of ${spec.noun} ${obj.id} ` +
        `(${n} operation${n === 1 ? '' : 's'} on ${obj.affected.join(', ')}, one PUT)`,
    );
    try {
      await ctx.client.request({
        service: SERVICE,
        style: 'classic',
        resource: `${spec.resource}/id/${obj.id}`,
        method: 'PUT',
        body: buildScopeOnlyXml(obj.kind, obj.intended),
        bodyFormat: 'xml',
      });
    } catch (error) {
      stopped = true;
      if (error instanceof JamfPlatformApiError) {
        // Jamf answered, and the answer was no. Not a write, and not read back: a read can show
        // the rejected scope for minutes afterwards (JPM-0014), so it would prove nothing.
        rejected.push({ object: obj, httpStatus: error.status });
        results.push({
          ...base,
          status: 'failed',
          writtenAt: null,
          verified: false,
          otherFieldsUnchanged: null,
          differingSections: [],
          rejectedWithHttpStatus: error.status,
          error:
            `PUT failed: Jamf answered HTTP ${error.status}, so the ${spec.noun} was NOT written. It was not read back: ` +
            'reads can go on showing a rejected change for several minutes, so do not take one as proof it landed.',
        });
      } else {
        // No HTTP answer at all: the PUT may or may not have been applied.
        rollbackObjects.push(obj);
        results.push({
          ...base,
          status: 'failed',
          writtenAt,
          verified: false,
          otherFieldsUnchanged: null,
          differingSections: [],
          error: `PUT failed with no HTTP response, so it may or may not have been applied: ${message(error)}`,
        });
      }
      continue;
    }
    rollbackObjects.push(obj);

    try {
      const stored = await fetchLive(ctx.client, obj.kind, obj.id);
      const mismatches = scopeMismatches(obj.intended, stored);
      const verdict = judgeNonScope(obj.kind, obj.live.nonScope, obj.fingerprint, stored.nonScope);
      const verified = mismatches.length === 0;
      const ok = verified && verdict.acceptable;
      if (!ok) stopped = true;
      results.push({
        ...base,
        status: ok ? 'written' : 'failed',
        writtenAt,
        verified,
        otherFieldsUnchanged: verdict.otherFieldsUnchanged,
        differingSections: verdict.differingSections,
        ...(verdict.normalizedByJamf
          ? {
              normalizedByJamf: verdict.normalizedByJamf,
              otherFieldsSemanticallyUnchanged: verdict.otherFieldsSemanticallyUnchanged,
            }
          : {}),
        error: ok
          ? null
          : [
              verified ? '' : `scope mismatch: ${mismatches.map((m) => m.field).join(', ')}`,
              verdict.acceptable ? '' : 'non-scope sections changed',
            ]
              .filter(Boolean)
              .join('; '),
      });
    } catch (error) {
      stopped = true;
      results.push({
        ...base,
        status: 'failed',
        writtenAt,
        verified: false,
        otherFieldsUnchanged: false,
        differingSections: ['unknown: read-back failed'],
        error:
          `The write returned success but reading it back failed: ${message(error)}. ` +
          `Check the ${spec.noun} in Jamf before relying on it.`,
      });
    }
  }

  return { results, stopped, rollbackObjects, rejected };
}

/** The inverse changes for these objects: reverse object order, reverse operation order. */
export const inverseChanges = (objects: PlannedObject[]) =>
  [...objects].reverse().flatMap((o) => [...o.changes].reverse().map(inverseChange));

export const ROLLBACK_NOTE =
  'Covers every object whose PUT Jamf accepted, including one whose verification failed, and any whose PUT got no ' +
  'HTTP response, in reverse order. The rollback must itself be dry-run to obtain its planHash, then applied with ' +
  'that planHash. An object whose PUT got no response may not have changed; its inverse operations will then be ' +
  'refused at dry run: drop them. An object Jamf answered with an HTTP error was not written and is listed under ' +
  'notWritten instead: re-read it after several minutes, and only if the change is still there, dry-run its inverse.';

export function runTotals(results: ObjectResult[]) {
  const count = (s: ObjectStatus) => results.filter((r) => r.status === s).length;
  return {
    written: count('written'),
    failed: count('failed'),
    notAttempted: count('notAttempted'),
    rejectedByJamf: results.filter((r) => r.rejectedWithHttpStatus !== null).length,
  };
}

// ---------------------------------------------------------------------------
// applyScopeChanges
// ---------------------------------------------------------------------------

export async function applyScopeChanges(ctx: WriteContext, rawInput: ScopeChangesInput) {
  const input = scopeChangesInputSchema.parse(rawInput);
  const isDryRun = input.dryRun !== false;
  if (!isDryRun && !input.planHash) {
    throw new Error(
      'A live run requires planHash: the planHash returned by a reviewed dry run of exactly these ' +
        'operations. Run it with dryRun true first. Nothing was changed.',
    );
  }

  const changes = input.operations.map(fromOperation);
  const plan = await buildScopePlan(ctx, changes);

  if (plan.refusals.length > 0) {
    return {
      ok: false as const,
      dryRun: isDryRun,
      refusals: plan.refusals.map((r) => ({
        kind: r.kind,
        id: r.id,
        operation: r.change ? describeChange(r.change) : null,
        reason: r.reason,
      })),
      next: 'Nothing was written and no planHash is issued. Fix or remove the refused operations and dry-run again.',
    };
  }
  const planHash = plan.planHash as string;

  const objectsTable = plan.objects.map((o) => ({
    kind: o.kind,
    id: o.id,
    before: listsOf(o.live.scope, o.affected),
    after: listsOf(o.intended, o.affected),
    operations: o.changes.map(describeChange),
    warnings: o.warnings,
  }));
  const totals = {
    objects: plan.objects.length,
    operations: changes.length,
    adds: changes.filter((c) => c.action === 'add').length,
    removes: changes.filter((c) => c.action === 'remove').length,
    targetChanges: changes.filter((c) => c.list === 'include').length,
    exclusionChanges: changes.filter((c) => c.list === 'exclude').length,
    groups: plan.groups.length,
    computers: plan.computerIds.length,
  };

  if (isDryRun) {
    return {
      ok: true as const,
      dryRun: true,
      objects: objectsTable,
      totals,
      planHash,
      next:
        'Nothing was written. To apply exactly this plan, call again with the same operations, ' +
        'dryRun false and this planHash. Any change to a listed object or group in the meantime refuses the live call.',
    };
  }

  assertLiveAllowed(ctx, plan, input.planHash);
  const run = await runScopePlan(ctx, plan);

  return {
    ok: !run.stopped,
    dryRun: false,
    objects: run.results,
    totals: { objects: plan.objects.length, operations: changes.length, ...runTotals(run.results) },
    stoppedOnFailure: run.stopped,
    rollback: {
      tool: 'applyScopeChanges' as const,
      operations: inverseChanges(run.rollbackObjects).map(toOperation),
      dryRun: true,
      note: ROLLBACK_NOTE,
      notWritten: run.rejected.map((r) => ({
        kind: r.object.kind,
        id: r.object.id,
        httpStatus: r.httpStatus,
        inverseOperationsIfItLanded: inverseChanges([r.object]).map(toOperation),
      })),
    },
  };
}
