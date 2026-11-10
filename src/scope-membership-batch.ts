import { z } from 'zod';

import {
  MAX_SCOPE_OPERATIONS,
  ROLLBACK_NOTE,
  assertLiveAllowed,
  buildScopePlan,
  inverseChanges,
  runScopePlan,
  runTotals,
  type ScopeChange,
} from './scope-changes.js';
import type { WriteContext } from './restricted-software.js';

/**
 * Batch scope membership (JPM-0010): many add/remove operations on computer-group
 * scope membership (the scope's targets only) across many profiles and policies,
 * reviewed and approved once.
 *
 * Since JPM-0014 this is an input format over the engine in `scope-changes.ts`, which
 * `applyScopeChanges` also uses: each operation here is a computer-group change to the
 * inclusion list. The input, the dry-run table, the refusal entries and the rollback keep
 * this tool's own shape, so existing callers are unaffected. The engine's rules apply
 * here too: a PUT Jamf answers with an HTTP error is not a write and is kept out of the
 * rollback, and a policy whose name another policy shares is refused (JPM-0014).
 *
 * Hashes only are ever returned or logged, never payload content.
 */

export const MAX_BATCH_OPERATIONS = MAX_SCOPE_OPERATIONS;

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

const toChange = (op: BatchOperation): ScopeChange => ({
  kind: op.kind,
  id: op.id,
  action: op.action,
  member: 'computerGroup',
  list: 'include',
  memberId: op.computerGroupId,
});

const toBatchOperation = (c: ScopeChange): BatchOperation => ({
  kind: c.kind,
  id: c.id,
  action: c.action,
  computerGroupId: c.memberId,
});

export async function applyScopeMembershipBatch(ctx: WriteContext, rawInput: ScopeMembershipBatchInput) {
  const input = scopeMembershipBatchInputSchema.parse(rawInput);
  const isDryRun = input.dryRun !== false;
  if (!isDryRun && !input.planHash) {
    throw new Error(
      'A live batch requires planHash: the planHash returned by a reviewed dry run of exactly these ' +
        'operations. Run it with dryRun true first. Nothing was changed.',
    );
  }

  const changes = input.operations.map(toChange);
  const plan = await buildScopePlan(ctx, changes);

  if (plan.refusals.length > 0) {
    return {
      ok: false as const,
      dryRun: isDryRun,
      refusals: plan.refusals.map((r) => ({
        kind: r.kind,
        id: r.id,
        operation: r.change ? { action: r.change.action, computerGroupId: r.change.memberId } : null,
        reason: r.reason,
      })),
      next: 'Nothing was written and no planHash is issued. Fix or remove the refused operations and dry-run again.',
    };
  }
  const planHash = plan.planHash as string;

  const objectsTable = plan.objects.map((o) => ({
    kind: o.kind,
    id: o.id,
    before: { computerGroupIds: o.live.scope.computerGroupIds },
    after: { computerGroupIds: o.intended.computerGroupIds },
    operations: o.changes.map((c) => ({ action: c.action, computerGroupId: c.memberId })),
    warnings: o.warnings,
  }));
  const totals = {
    objects: plan.objects.length,
    operations: changes.length,
    adds: changes.filter((c) => c.action === 'add').length,
    removes: changes.filter((c) => c.action === 'remove').length,
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

  assertLiveAllowed(ctx, plan, input.planHash);
  const run = await runScopePlan(ctx, plan);

  return {
    ok: !run.stopped,
    dryRun: false,
    objects: run.results,
    totals: { objects: plan.objects.length, operations: changes.length, ...runTotals(run.results) },
    stoppedOnFailure: run.stopped,
    rollback: {
      tool: 'applyScopeMembershipBatch' as const,
      operations: inverseChanges(run.rollbackObjects).map(toBatchOperation),
      dryRun: true,
      note: ROLLBACK_NOTE,
      notWritten: run.rejected.map((r) => ({
        kind: r.object.kind,
        id: r.object.id,
        httpStatus: r.httpStatus,
        inverseOperationsIfItLanded: inverseChanges([r.object]).map(toBatchOperation),
      })),
    },
  };
}
