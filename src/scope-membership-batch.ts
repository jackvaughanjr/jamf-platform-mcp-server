import { z } from 'zod';

import {
  KINDS,
  SERVICE,
  buildScopeOnlyXml,
  canonical,
  differingSections,
  fetchGroup,
  fetchLive,
  fingerprintNonScope,
  scopeMismatches,
  sha256,
  type Fingerprint,
  type GroupInfo,
  type LiveScopedObject,
  type MembershipScope,
  type ScopeAction,
  type ScopeKind,
} from './scope-membership.js';
import type { WriteContext } from './restricted-software.js';

/**
 * Batch scope membership (JPM-0010): many add/remove operations on computer-group
 * scope membership across many profiles and policies, reviewed and approved once.
 *
 * Reuses everything the single tools (JPM-0009) use: parsing, the scope-only XML
 * builder, the refusal rules, the non-scope fingerprint and read-back verification.
 * What it adds is grouping by object (ONE PUT per object, carrying that object's
 * final scope), a plan hash binding a live run to exactly the dry run that was
 * reviewed, and stop-on-first-failure with an inverse batch as the rollback.
 *
 * Hashes only are ever returned or logged, never payload content.
 */

export const MAX_BATCH_OPERATIONS = 150;

export const batchOperationSchema = z.strictObject({
  kind: z.enum(['profile', 'policy']).describe('"profile" (macOS configuration profile) or "policy"'),
  id: z.number().int().positive().describe('Classic id of the configuration profile or policy'),
  action: z.enum(['add', 'remove']),
  computerGroupId: z.number().int().positive().describe('Classic id of the computer group (static or smart)'),
});

/** Strict: no other fields are accepted. */
export const scopeMembershipBatchInputSchema = z.strictObject({
  operations: z
    .array(batchOperationSchema)
    .min(1)
    .max(MAX_BATCH_OPERATIONS)
    .describe(`1 to ${MAX_BATCH_OPERATIONS} operations. Operations on one object land in one PUT.`),
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

export type BatchOperation = z.infer<typeof batchOperationSchema>;
export type ScopeMembershipBatchInput = z.infer<typeof scopeMembershipBatchInputSchema>;

interface Refusal {
  kind: ScopeKind;
  id: number;
  operation: { action: ScopeAction; computerGroupId: number } | null;
  reason: string;
}

interface PlannedObject {
  kind: ScopeKind;
  id: number;
  live: LiveScopedObject;
  operations: BatchOperation[];
  before: number[];
  after: number[];
  intended: MembershipScope;
  warnings: string[];
  fingerprint: Fingerprint;
}

interface Plan {
  refusals: Refusal[];
  objects: PlannedObject[];
  groups: GroupInfo[];
  planHash?: string;
}

const objectKey = (kind: ScopeKind, id: number) => `${kind}:${id}`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Read every distinct object and group once, validate every operation, hash the plan. */
async function buildPlan(ctx: WriteContext, operations: BatchOperation[]): Promise<Plan> {
  const refusals: Refusal[] = [];

  // Group by object, first-appearance order of objects, operation order within an object.
  const byObject = new Map<string, BatchOperation[]>();
  for (const op of operations) {
    const key = objectKey(op.kind, op.id);
    const list = byObject.get(key);
    if (list) list.push(op);
    else byObject.set(key, [op]);
  }

  // Each distinct group, read once, in first-appearance order.
  const groups = new Map<number, GroupInfo | string>();
  for (const op of operations) {
    if (groups.has(op.computerGroupId)) continue;
    try {
      groups.set(op.computerGroupId, await fetchGroup(ctx.client, op.computerGroupId));
    } catch (error) {
      groups.set(op.computerGroupId, message(error));
    }
  }

  const objects: PlannedObject[] = [];
  for (const ops of byObject.values()) {
    const { kind, id } = ops[0] as BatchOperation;
    const spec = KINDS[kind];
    const refuse = (op: BatchOperation | null, reason: string) =>
      refusals.push({
        kind,
        id,
        operation: op ? { action: op.action, computerGroupId: op.computerGroupId } : null,
        reason,
      });

    let live: LiveScopedObject;
    try {
      live = await fetchLive(ctx.client, kind, id);
    } catch (error) {
      for (const op of ops) refuse(op, `${spec.noun} ${id} could not be read: ${message(error)}`);
      continue;
    }

    let objectOk = true;
    if (live.scope.allComputers) {
      refuse(null, `${spec.noun} ${id} is scoped to All Computers. Adding or removing a group is meaningless there.`);
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

    const seen = new Set<number>();
    const adds: number[] = [];
    const removes = new Set<number>();
    for (const op of ops) {
      const group = groups.get(op.computerGroupId);
      if (typeof group === 'string') {
        refuse(op, group);
        objectOk = false;
        continue;
      }
      if (seen.has(op.computerGroupId)) {
        refuse(op, `Computer group ${op.computerGroupId} appears more than once for ${spec.noun} ${id} in this batch.`);
        objectOk = false;
        continue;
      }
      seen.add(op.computerGroupId);
      // Evaluated against the live scope; duplicates are refused above, so this is
      // equivalent to applying the operations in order.
      const present = live.scope.computerGroupIds.includes(op.computerGroupId);
      if (op.action === 'add' && present) {
        refuse(op, `Computer group ${op.computerGroupId} ("${group?.name}") is already in ${spec.noun} ${id}'s scope.`);
        objectOk = false;
      } else if (op.action === 'remove' && !present) {
        refuse(op, `Computer group ${op.computerGroupId} ("${group?.name}") is not in ${spec.noun} ${id}'s scope.`);
        objectOk = false;
      } else if (op.action === 'add') adds.push(op.computerGroupId);
      else removes.add(op.computerGroupId);
    }
    if (!objectOk) continue;

    const before = live.scope.computerGroupIds;
    const after = [...before.filter((g) => !removes.has(g)), ...adds].sort((x, y) => x - y);
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
    for (const op of ops) {
      if (live.scope.exclusions.computerGroupIds.includes(op.computerGroupId)) {
        warnings.push(
          `Group ${op.computerGroupId} is also in this ${spec.noun}'s exclusions; exclusions win, and this change does not touch them.`,
        );
      }
    }
    objects.push({
      kind,
      id,
      live,
      operations: ops,
      before,
      after,
      intended: { ...live.scope, computerGroupIds: after },
      warnings,
      fingerprint: fingerprintNonScope(live.nonScope),
    });
  }

  const groupList = [...groups.values()].filter((g): g is GroupInfo => typeof g !== 'string');
  if (refusals.length > 0) return { refusals, objects, groups: groupList };

  // Binds the live run to the reviewed dry run: the operations as given, each object's
  // modelled live scope and its whole non-scope fingerprint, each group's id/name/kind.
  const planHash = sha256(
    canonical({
      operations: operations.map((o) => ({
        kind: o.kind,
        id: o.id,
        action: o.action,
        computerGroupId: o.computerGroupId,
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
  return { refusals, objects, groups: groupList, planHash };
}

const inverse = (op: BatchOperation): BatchOperation => ({
  ...op,
  action: op.action === 'add' ? 'remove' : 'add',
});

type ObjectStatus = 'written' | 'failed' | 'notAttempted';

export async function applyScopeMembershipBatch(ctx: WriteContext, rawInput: ScopeMembershipBatchInput) {
  const input = scopeMembershipBatchInputSchema.parse(rawInput);
  const isDryRun = input.dryRun !== false;
  if (!isDryRun && !input.planHash) {
    throw new Error(
      'A live batch requires planHash: the planHash returned by a reviewed dry run of exactly these ' +
        'operations. Run it with dryRun true first. Nothing was changed.',
    );
  }

  const plan = await buildPlan(ctx, input.operations);

  if (plan.refusals.length > 0) {
    return {
      ok: false as const,
      dryRun: isDryRun,
      refusals: plan.refusals,
      next: 'Nothing was written and no planHash is issued. Fix or remove the refused operations and dry-run again.',
    };
  }
  const planHash = plan.planHash as string;

  const objectsTable = plan.objects.map((o) => ({
    kind: o.kind,
    id: o.id,
    before: { computerGroupIds: o.before },
    after: { computerGroupIds: o.after },
    operations: o.operations.map((op) => ({ action: op.action, computerGroupId: op.computerGroupId })),
    warnings: o.warnings,
  }));
  const totals = {
    objects: plan.objects.length,
    operations: input.operations.length,
    adds: input.operations.filter((o) => o.action === 'add').length,
    removes: input.operations.filter((o) => o.action === 'remove').length,
    groups: plan.groups.length,
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

  if (input.planHash !== planHash) {
    throw new Error('live state changed since the dry run; dry-run again. Nothing was written.');
  }
  if (!ctx.writesEnabled) {
    throw new Error(
      'Writes are disabled: JAMF_READ_ONLY is not "false" for this server. The dry run is still available. ' +
        'The write server is meant to run under its own integration with JAMF_READ_ONLY=false (JPM-0008).',
    );
  }

  type ObjectResult = {
    kind: ScopeKind;
    id: number;
    status: ObjectStatus;
    writtenAt: string | null;
    verified: boolean | null;
    otherFieldsUnchanged: boolean | null;
    differingSections: string[];
    error: string | null;
  };
  const results: ObjectResult[] = [];
  const putSent: PlannedObject[] = [];
  let stopped = false;

  for (const obj of plan.objects) {
    const base = { kind: obj.kind, id: obj.id };
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
    console.error(
      `[jamf-platform-write] ${writtenAt} batch: set computer group scope of ${spec.noun} ${obj.id} ` +
        `(${obj.operations.length} operation${obj.operations.length === 1 ? '' : 's'}, one PUT)`,
    );
    putSent.push(obj);
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
      results.push({
        ...base,
        status: 'failed',
        writtenAt,
        verified: false,
        otherFieldsUnchanged: null,
        differingSections: [],
        error: `PUT failed: ${message(error)}`,
      });
      continue;
    }

    try {
      const stored = await fetchLive(ctx.client, obj.kind, obj.id);
      const mismatches = scopeMismatches(obj.intended, stored);
      const differing = differingSections(obj.fingerprint, fingerprintNonScope(stored.nonScope));
      const verified = mismatches.length === 0;
      const unchanged = differing.length === 0;
      const ok = verified && unchanged;
      if (!ok) stopped = true;
      results.push({
        ...base,
        status: ok ? 'written' : 'failed',
        writtenAt,
        verified,
        otherFieldsUnchanged: unchanged,
        differingSections: differing,
        error: ok
          ? null
          : [
              verified ? '' : `scope mismatch: ${mismatches.map((m) => m.field).join(', ')}`,
              unchanged ? '' : 'non-scope sections changed',
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

  const rollback = {
    tool: 'applyScopeMembershipBatch' as const,
    operations: [...putSent].reverse().flatMap((o) => [...o.operations].reverse().map(inverse)),
    dryRun: true,
    note:
      'Covers every object whose PUT was sent, including one whose verification failed, in reverse order. ' +
      'The rollback must itself be dry-run to obtain its planHash, then applied with that planHash. ' +
      'An object whose PUT errored may not have changed; its inverse operations will then be refused at dry run: drop them.',
  };

  const count = (s: ObjectStatus) => results.filter((r) => r.status === s).length;
  return {
    ok: !stopped,
    dryRun: false,
    objects: results,
    totals: {
      objects: plan.objects.length,
      operations: input.operations.length,
      written: count('written'),
      failed: count('failed'),
      notAttempted: count('notAttempted'),
    },
    stoppedOnFailure: stopped,
    rollback,
  };
}
