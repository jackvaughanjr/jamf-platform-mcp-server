/**
 * One declaration across many devices — the opposite direction to
 * `summarizeDeclarations`, which reports many declarations on one device.
 *
 * The gap this closes is a real one, reported on Jamf Nation: there is no way in the
 * Jamf Pro UI to see which devices sit in which state for a declaration deployed to a
 * group. `ddm/report` → `declarations/{identifier}/devices` can answer it, but only
 * in raw form: the records carry a bare `deviceId` UUID, which answers "how many" and
 * never "which".
 *
 * Pure functions only — no client, no clock, no I/O. Everything here operates on
 * records the caller has already fetched.
 *
 * Two properties of the route shape what these functions must say:
 *
 * 1. `filter` is REQUIRED, and Jamf documents that filters "only apply to
 *    declarations already on the device (excludes PENDING status)". So PENDING is
 *    unreachable through this route. A declaration still rolling out looks like it
 *    reached fewer devices than it did, and "no failures" must never be presented as
 *    "fully deployed".
 * 2. The route answers only from records that exist. A device in scope that has not
 *    reported at all is absent from the answer, which is not the same as healthy.
 *
 * Both are stated in the returned report rather than left in a doc, because the
 * report is what a caller reads.
 */
import {
  lastSeen,
  platformOf,
  summarizeDeclarations,
  type DeclarationRecord,
  type DeviceRecord,
  type Platform,
} from './fleet.js';

/**
 * The bucket key for a field the gateway omitted.
 *
 * Deliberately the same literal `summarizeDeclarations` tallies under, so a status
 * missing from a record buckets identically in both directions. That function's
 * `tally` helper is module-private, so the constant is restated rather than shared.
 */
const ABSENT = '(absent)';

/** One declaration's reported state on one device, joined to who that device is. */
export interface DeclarationDeviceOutcome {
  /** The record's `deviceId`, or `(absent)` when the record carried none. */
  deviceId: string;
  /** True when `deviceId` matched a record in the supplied device list. */
  resolved: boolean;
  /** Device detail; absent when the id resolved to nothing. */
  name?: string;
  serialNumber?: string | null;
  model?: string | null;
  platform: Platform;
  /** Freshest check-in evidence for the device — context for a stale report. */
  lastSeenIso: string | null;
  /** Declaration state, with an omitted field bucketed rather than left undefined. */
  status: string;
  type: string;
  channel: string;
  validityState: string;
  active?: boolean;
  lastReportTime: string | null;
  dateUpdated: string | null;
  /** UNSUCCESSFUL status **or** INVALID validity — see `verdictOf`. */
  failed: boolean;
  /** Flattened `code: description` lines with indented details. Empty when healthy. */
  reasons: string[];
}

/**
 * A distinct failure pattern and every device showing it.
 *
 * One declaration failing on 40 Macs for the same reason is one problem, not forty.
 */
export interface DeclarationFailureGroup {
  status: string;
  validityState: string;
  reasons: string[];
  /** Distinct devices in this group. The number that matters. */
  deviceCount: number;
  /** Records in this group; exceeds `deviceCount` when a device reports twice. */
  recordCount: number;
  devices: Array<{
    deviceId: string;
    name?: string;
    serialNumber?: string | null;
    resolved: boolean;
  }>;
}

export interface DeclarationScopeRollup {
  /** Records supplied. */
  records: number;
  /** Distinct device ids. Records with no `deviceId` are excluded and counted below. */
  devices: number;
  resolvedDevices: number;
  unresolvedDevices: number;
  /**
   * Records carrying no `deviceId` at all. Excluded from every device count here
   * rather than collapsed into one imaginary device.
   */
  recordsMissingDeviceId: number;
  failedRecords: number;
  /** Distinct devices with at least one failing record. */
  failedDevices: number;
  /** Distinct devices with no failing record. `failedDevices + healthyDevices === devices`. */
  healthyDevices: number;
  inactive: number;
  /**
   * Tallied by observed value, never against a hardcoded enum list. Every enum on
   * this route already carries `UNKNOWN`, so Jamf expects to add members and a fixed
   * switch would drop a new one into no bucket at all.
   */
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  byChannel: Record<string, number>;
  byValidity: Record<string, number>;
}

export interface DeclarationScopeReport {
  declarationIdentifier: string;
  /** The RSQL filter the caller sent, echoed so the answer states its own narrowing. */
  filter: string | null;
  rollup: DeclarationScopeRollup;
  /** Failures first, grouped by pattern, largest blast radius first. */
  failureGroups: DeclarationFailureGroup[];
  /** Per-device outcomes for ids that resolved, failures first then by name. */
  devices: DeclarationDeviceOutcome[];
  /**
   * Outcomes whose `deviceId` matched no device in the list — reported, never dropped.
   * A declaration reporting against a device absent from the fleet list is itself a
   * finding, and its reasons are worth as much as any other device's.
   */
  unmatchedDevices: DeclarationDeviceOutcome[];
  /**
   * Devices reporting this declaration more than once — expected when it applies on
   * both the device and user channel. Surfaced because counting records as devices
   * would overstate the blast radius.
   */
  devicesWithMultipleRecords: Array<{ deviceId: string; name?: string; recordCount: number }>;
  /**
   * Records naming a declaration other than the subject. The route is
   * per-declaration, so this should always be empty; if it is not, the answer is
   * mixing declarations and the counts mean less than they appear to.
   */
  foreignDeclarationIdentifiers: string[];
  /** Set when the gateway reported more records than were supplied. */
  truncated: { reportedTotalCount: number; received: number } | null;
  /**
   * True when records were supplied but the device list was empty, so nothing could
   * be identified. A missing input, not a finding about the fleet.
   */
  deviceListUnusable: boolean;
  /** What this answer does not cover. Stated, not implied. */
  excludedFromThisAnswer: string[];
  verdict: string;
}

export interface DeclarationScopeOptions {
  /**
   * The declaration the caller asked about. Falls back to the first identifier the
   * records carry, then to `(unknown)`.
   */
  declarationIdentifier?: string;
  /** The RSQL filter sent to the gateway. */
  filter?: string;
  /**
   * `totalCount` from the gateway's envelope, when the caller has it. Supplying it
   * is what makes truncation detectable; omit it and a capped page walk is
   * indistinguishable from a complete answer.
   */
  reportedTotalCount?: number;
}

/**
 * Whether one record counts as a failure, and its reasons flattened.
 *
 * Delegates to `summarizeDeclarations` on a one-record array rather than
 * reimplementing either half. That function already owns the failure predicate
 * (UNSUCCESSFUL status **or** INVALID validity, because a declaration can report
 * SUCCESSFUL delivery while being invalid on the device) and the reason flattening
 * (`code: description` plus indented detail lines, with an explicit line when no
 * reason was given). Both are exactly what is needed here, and neither its internals
 * nor its `tally` helper are exported, so a one-record call is the only way to reuse
 * them. The cost is an object per record; the benefit is that the two directions
 * cannot drift apart on what "failed" means.
 *
 * Its `failed[]` entries are otherwise unusable here: `FailedDeclaration` carries no
 * `deviceId`, which is the single field this whole module exists to preserve.
 */
function verdictOf(record: DeclarationRecord): { failed: boolean; reasons: string[] } {
  const failure = summarizeDeclarations([record]).failed[0];
  return failure ? { failed: true, reasons: failure.reasons } : { failed: false, reasons: [] };
}

/**
 * Joins declaration records against the device list so each outcome names a device a
 * human recognises.
 *
 * Follows `enrichGroupMembers`: same id-to-record map, same decision to return
 * unmatched ids separately rather than drop them. It differs in what it carries —
 * that function takes bare ids and returns device detail only, while each record here
 * has state and reasons attached that must survive the join, and `model` is needed,
 * which `EnrichedMember` does not have. So the join is rebuilt in its shape rather
 * than called.
 */
export function joinDeclarationRecordsToDevices(
  records: DeclarationRecord[],
  devices: DeviceRecord[],
): { outcomes: DeclarationDeviceOutcome[]; unmatched: DeclarationDeviceOutcome[] } {
  const byId = new Map<string, DeviceRecord>();
  for (const device of devices) if (device.id) byId.set(device.id, device);

  const outcomes: DeclarationDeviceOutcome[] = [];
  const unmatched: DeclarationDeviceOutcome[] = [];

  for (const record of records) {
    const deviceId = record.deviceId?.trim() ?? '';
    const device = deviceId ? byId.get(deviceId) : undefined;
    const { failed, reasons } = verdictOf(record);
    const { at } = device ? lastSeen(device) : { at: null };

    const outcome: DeclarationDeviceOutcome = {
      deviceId: deviceId || ABSENT,
      resolved: device !== undefined,
      name: device?.name,
      serialNumber: device ? (device.serialNumber ?? null) : undefined,
      model: device ? (device.model ?? null) : undefined,
      platform: platformOf(device?.modelIdentifier),
      lastSeenIso: at === null ? null : new Date(at).toISOString(),
      status: record.status ?? ABSENT,
      type: record.type ?? ABSENT,
      channel: record.channel ?? ABSENT,
      validityState: record.validityState ?? ABSENT,
      active: record.active,
      lastReportTime: record.lastReportTime ?? null,
      dateUpdated: record.dateUpdated ?? null,
      failed,
      reasons,
    };

    (device ? outcomes : unmatched).push(outcome);
  }

  // Failures first — that is what someone opened this for — then by name, then by id
  // so the order is total and stable regardless of input order.
  const order = (a: DeclarationDeviceOutcome, b: DeclarationDeviceOutcome) =>
    Number(b.failed) - Number(a.failed) ||
    (a.name ?? '').localeCompare(b.name ?? '') ||
    a.deviceId.localeCompare(b.deviceId);

  outcomes.sort(order);
  unmatched.sort(order);
  return { outcomes, unmatched };
}

/**
 * Groups failing outcomes by their reason signature.
 *
 * The signature is status + validity + the flattened reason lines, not the reasons
 * alone. Two devices reporting the same reason but differing on whether the
 * declaration was delivered at all are not one problem — and `reasons` is frequently
 * just "no reason reported", where status and validity are the only discriminators
 * left. Grouping on reasons alone would merge those into one meaningless bucket.
 *
 * Counts are per distinct device, because the question is how many Macs are affected,
 * not how many rows the gateway returned.
 */
export function groupFailuresByReason(
  outcomes: DeclarationDeviceOutcome[],
): DeclarationFailureGroup[] {
  const groups = new Map<string, DeclarationFailureGroup>();
  // Kept beside the groups so device de-duplication stays linear on a large fleet.
  const seen = new Map<string, Set<string>>();

  for (const outcome of outcomes) {
    if (!outcome.failed) continue;
    // Unit separator: a delimiter that cannot appear in a Jamf reason code or
    // description, so two distinct signatures cannot collide into one group.
    const key = [outcome.status, outcome.validityState, ...outcome.reasons].join('\u001F');

    let group = groups.get(key);
    if (!group) {
      group = {
        status: outcome.status,
        validityState: outcome.validityState,
        // Copied: this module hands out no references into its inputs.
        reasons: [...outcome.reasons],
        deviceCount: 0,
        recordCount: 0,
        devices: [],
      };
      groups.set(key, group);
      seen.set(key, new Set());
    }

    group.recordCount += 1;
    const ids = seen.get(key);
    if (ids && !ids.has(outcome.deviceId)) {
      ids.add(outcome.deviceId);
      group.devices.push({
        deviceId: outcome.deviceId,
        name: outcome.name,
        serialNumber: outcome.serialNumber,
        resolved: outcome.resolved,
      });
    }
  }

  for (const group of groups.values()) {
    group.devices.sort(
      (a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.deviceId.localeCompare(b.deviceId),
    );
    group.deviceCount = group.devices.length;
  }

  // Widest blast radius first; then a total order so output is reproducible.
  return [...groups.values()].sort(
    (a, b) =>
      b.deviceCount - a.deviceCount ||
      b.recordCount - a.recordCount ||
      a.status.localeCompare(b.status) ||
      a.validityState.localeCompare(b.validityState) ||
      a.reasons.join('\n').localeCompare(b.reasons.join('\n')),
  );
}

function tally(values: Array<string | undefined>): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    const key = value ?? ABSENT;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

/**
 * A filter of the form `field==*` narrows nothing beyond what the route already
 * excludes, so the report should say that instead of implying the caller lost data.
 */
function isMatchAllFilter(filter: string): boolean {
  return /^[A-Za-z]+\s*==\s*\*$/.test(filter.trim());
}

/**
 * The whole answer for one declaration across the devices reporting it.
 *
 * Leads with what is wrong, and states what it cannot see. The second half is the
 * point: this route cannot return PENDING, and it says nothing at all about a device
 * that has not reported. An empty `failureGroups` therefore means "nothing that
 * reported has failed", never "the deployment is complete", and the verdict is worded
 * so it cannot be read the other way.
 */
export function summarizeDeclarationScope(
  records: DeclarationRecord[],
  devices: DeviceRecord[],
  options: DeclarationScopeOptions = {},
): DeclarationScopeReport {
  const { outcomes, unmatched } = joinDeclarationRecordsToDevices(records, devices);
  const all = [...outcomes, ...unmatched];
  const failureGroups = groupFailuresByReason(all);

  // Whole-set tallies come from the per-device summariser so the bucket keys and the
  // inactive count match the other direction exactly. Its `failed[]` is discarded —
  // it carries no deviceId, so it cannot answer "which".
  const base = summarizeDeclarations(records);

  const realIds = (list: DeclarationDeviceOutcome[]) =>
    new Set(list.filter((o) => o.deviceId !== ABSENT).map((o) => o.deviceId));

  const resolvedIds = realIds(outcomes);
  const unresolvedIds = realIds(unmatched);
  const distinctIds = new Set([...resolvedIds, ...unresolvedIds]);
  const failedIds = realIds(all.filter((o) => o.failed));

  const recordsPerDevice = new Map<string, { name?: string; count: number }>();
  for (const outcome of all) {
    if (outcome.deviceId === ABSENT) continue;
    const entry = recordsPerDevice.get(outcome.deviceId) ?? { name: outcome.name, count: 0 };
    entry.count += 1;
    entry.name ??= outcome.name;
    recordsPerDevice.set(outcome.deviceId, entry);
  }

  const subject =
    options.declarationIdentifier?.trim() ||
    records.find((r) => r.declarationIdentifier?.trim())?.declarationIdentifier?.trim() ||
    '(unknown)';

  const foreignDeclarationIdentifiers = [
    ...new Set(
      records
        .map((r) => r.declarationIdentifier?.trim())
        .filter((id): id is string => Boolean(id) && id !== subject),
    ),
  ].sort();

  const received = records.length;
  const reported = options.reportedTotalCount;
  const truncated =
    typeof reported === 'number' && reported > received
      ? { reportedTotalCount: reported, received }
      : null;

  const deviceListUnusable = devices.length === 0 && records.length > 0;

  const rollup: DeclarationScopeRollup = {
    records: base.total,
    devices: distinctIds.size,
    resolvedDevices: resolvedIds.size,
    unresolvedDevices: unresolvedIds.size,
    recordsMissingDeviceId: records.filter((r) => !r.deviceId?.trim()).length,
    failedRecords: all.filter((o) => o.failed).length,
    failedDevices: failedIds.size,
    healthyDevices: distinctIds.size - failedIds.size,
    inactive: base.inactive,
    byStatus: base.byStatus,
    byType: base.byType,
    byChannel: base.byChannel,
    byValidity: tally(records.map((r) => r.validityState)),
  };

  const filter = options.filter ?? null;
  const excludedFromThisAnswer = [
    'PENDING declarations. Jamf applies a filter only to declarations already on the ' +
      'device, and this route requires a filter, so anything still awaiting delivery ' +
      'is invisible here. No failures does not mean fully deployed.',
    'Any device that has not reported this declaration at all. This answer is built ' +
      'only from records that exist, so a device in scope but silent is missing from ' +
      'it, not healthy.',
    ...(filter === null
      ? []
      : isMatchAllFilter(filter)
        ? [
            `Nothing further from the filter: "${filter}" matches every declaration ` +
              'already on a device, so it narrows nothing beyond the PENDING exclusion above.',
          ]
        : [`Anything the filter "${filter}" excluded — it narrowed this answer before it reached here.`]),
    ...(truncated
      ? [
          `${truncated.reportedTotalCount - truncated.received} record(s) the gateway ` +
            `reported but that were not supplied here (${truncated.received} of ` +
            `${truncated.reportedTotalCount} received).`,
        ]
      : []),
  ];

  const body = deviceListUnusable
    ? `No device can be identified: ${received} record(s) were supplied with an empty ` +
      'device list, so every one is unmatched. That is a missing input, not evidence ' +
      'that this declaration reports against devices outside the fleet.'
    : rollup.records === 0
      ? 'No device reports this declaration under this filter. THREE causes are ' +
        'indistinguishable here: (1) it is deployed nowhere; (2) every target is still ' +
        'PENDING and therefore excluded; (3) THE FILTER MATCHED NOTHING. Rule out (3) ' +
        'first — a wildcard such as "deviceId==*" matches no rows and still returns ' +
        '200, because wildcards work only on declarationIdentifier, which is not a ' +
        'filterable field on this route. A filter confirmed to match everything is ' +
        '"active==true,active==false". If that also returns nothing, the declaration ' +
        'genuinely reaches no device that has reported yet.'
      : rollup.failedDevices > 0
        ? `${rollup.failedDevices} of ${rollup.devices} device(s) report this declaration ` +
          `as failed or invalid, in ${failureGroups.length} distinct failure pattern(s) — ` +
          'see failureGroups[].reasons.'
        : `All ${rollup.devices} device(s) that report this declaration look healthy. ` +
          'That is not the same as fully deployed — see excludedFromThisAnswer.';

  const verdict = truncated
    ? `INCOMPLETE: only ${truncated.received} of ${truncated.reportedTotalCount} record(s) ` +
      `reached this summary, so no count below is the whole picture. ${body}`
    : body;

  return {
    declarationIdentifier: subject,
    filter,
    rollup,
    failureGroups,
    devices: outcomes,
    unmatchedDevices: unmatched,
    devicesWithMultipleRecords: [...recordsPerDevice.entries()]
      .filter(([, entry]) => entry.count > 1)
      .map(([deviceId, entry]) => ({ deviceId, name: entry.name, recordCount: entry.count }))
      .sort((a, b) => b.recordCount - a.recordCount || a.deviceId.localeCompare(b.deviceId)),
    foreignDeclarationIdentifiers,
    truncated,
    deviceListUnusable,
    excludedFromThisAnswer,
    verdict,
  };
}
