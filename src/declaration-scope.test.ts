import { describe, expect, it } from 'vitest';

import {
  groupFailuresByReason,
  joinDeclarationRecordsToDevices,
  summarizeDeclarationScope,
} from './declaration-scope.js';
import type { DeclarationRecord, DeviceRecord } from './fleet.js';

// Synthetic ids only. A real device UUID reached a test file once, which is why the
// deadbeef- prefix is reserved and enforced by scripts/check-no-identifiers.sh.
const ADA = 'deadbeef-0000-4000-8000-000000000001';
const BABBAGE = 'deadbeef-0000-4000-8000-000000000002';
const CURIE = 'deadbeef-0000-4000-8000-000000000003';
const GHOST = 'deadbeef-0000-4000-8000-000000000009';

const devices: DeviceRecord[] = [
  {
    id: ADA,
    name: 'Ada Lab Mac',
    serialNumber: 'FAKESERIAL01',
    model: 'MacBook Pro (invented)',
    modelIdentifier: 'MacBookPro18,3',
    lastCheckInTime: '2026-08-04T00:00:00Z',
  },
  {
    id: BABBAGE,
    name: 'Babbage Loaner',
    serialNumber: 'FAKESERIAL02',
    model: 'Mac mini (invented)',
    modelIdentifier: 'Macmini9,1',
    lastInventoryUpdateTime: '2026-08-03T00:00:00Z',
  },
  {
    id: CURIE,
    name: 'Curie Kiosk iPad',
    serialNumber: 'FAKESERIAL03',
    model: 'iPad (invented)',
    modelIdentifier: 'iPad13,4',
  },
];

const SUBJECT = 'Blueprint_FileVault';

/** A healthy record for Ada by default; override whatever the case is about. */
const record = (over: Partial<DeclarationRecord> = {}): DeclarationRecord => ({
  declarationIdentifier: SUBJECT,
  deviceId: ADA,
  channel: 'device',
  type: 'CONFIGURATION',
  status: 'SUCCESSFUL',
  validityState: 'VALID',
  ...over,
});

const CANNOT_APPLY = [
  {
    code: 'Error.ConfigurationCannotBeApplied',
    description: 'Configuration cannot be applied',
    details: [{ key: 'PayloadType', description: 'com.apple.fdefilevault' }],
  },
];

const CANNOT_APPLY_FLAT = [
  'Error.ConfigurationCannotBeApplied: Configuration cannot be applied',
  '  PayloadType: com.apple.fdefilevault',
];

describe('joinDeclarationRecordsToDevices', () => {
  it('resolves a bare deviceId to name, serial, model and platform', () => {
    const { outcomes, unmatched } = joinDeclarationRecordsToDevices(
      [record({ deviceId: BABBAGE })],
      devices,
    );
    expect(unmatched).toEqual([]);
    expect(outcomes[0]?.resolved).toBe(true);
    expect(outcomes[0]?.name).toBe('Babbage Loaner');
    expect(outcomes[0]?.serialNumber).toBe('FAKESERIAL02');
    expect(outcomes[0]?.model).toBe('Mac mini (invented)');
    expect(outcomes[0]?.platform).toBe('macOS');
    expect(outcomes[0]?.lastSeenIso).toBe('2026-08-03T00:00:00.000Z');
  });

  // A declaration reporting against a device absent from the fleet list is a finding.
  it('reports a deviceId matching no device separately, keeping its reasons', () => {
    const { outcomes, unmatched } = joinDeclarationRecordsToDevices(
      [
        record(),
        record({ deviceId: GHOST, status: 'UNSUCCESSFUL', reasons: CANNOT_APPLY }),
      ],
      devices,
    );
    expect(outcomes).toHaveLength(1);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]?.deviceId).toBe(GHOST);
    expect(unmatched[0]?.resolved).toBe(false);
    expect(unmatched[0]?.name).toBeUndefined();
    expect(unmatched[0]?.platform).toBe('unknown');
    // The whole point of keeping it: the reason survives the failed join.
    expect(unmatched[0]?.reasons).toEqual(CANNOT_APPLY_FLAT);
  });

  it('treats a record carrying no deviceId as unmatched rather than dropping it', () => {
    const { outcomes, unmatched } = joinDeclarationRecordsToDevices(
      [{ declarationIdentifier: SUBJECT, status: 'UNSUCCESSFUL' }],
      devices,
    );
    expect(outcomes).toEqual([]);
    expect(unmatched[0]?.deviceId).toBe('(absent)');
    expect(unmatched[0]?.failed).toBe(true);
  });

  it('leads with failures, then orders by device name', () => {
    const { outcomes } = joinDeclarationRecordsToDevices(
      [
        record({ deviceId: ADA }),
        record({ deviceId: CURIE }),
        record({ deviceId: BABBAGE, status: 'UNSUCCESSFUL' }),
      ],
      devices,
    );
    expect(outcomes.map((o) => o.name)).toEqual([
      'Babbage Loaner',
      'Ada Lab Mac',
      'Curie Kiosk iPad',
    ]);
  });

  it('buckets an omitted status, type, channel or validity instead of leaving it undefined', () => {
    const { outcomes } = joinDeclarationRecordsToDevices([{ deviceId: ADA }], devices);
    expect(outcomes[0]).toMatchObject({
      status: '(absent)',
      type: '(absent)',
      channel: '(absent)',
      validityState: '(absent)',
      failed: false,
      reasons: [],
    });
  });

  // A declaration can be delivered and still be invalid on the device. Reporting that
  // as healthy is the false all-clear this project keeps rediscovering.
  it('treats INVALID validity as failed even when the status is SUCCESSFUL', () => {
    const { outcomes } = joinDeclarationRecordsToDevices(
      [record({ validityState: 'INVALID' })],
      devices,
    );
    expect(outcomes[0]?.failed).toBe(true);
    expect(outcomes[0]?.reasons).toEqual(['validityState INVALID, no reason reported']);
  });

  it('flattens reason codes and indented details, consistent with the per-device summary', () => {
    const { outcomes } = joinDeclarationRecordsToDevices(
      [record({ status: 'UNSUCCESSFUL', reasons: CANNOT_APPLY })],
      devices,
    );
    expect(outcomes[0]?.reasons).toEqual(CANNOT_APPLY_FLAT);
  });
});

describe('groupFailuresByReason', () => {
  const failingOn = (deviceId: string, over: Partial<DeclarationRecord> = {}) =>
    record({ deviceId, status: 'UNSUCCESSFUL', reasons: CANNOT_APPLY, ...over });

  const outcomesFor = (records: DeclarationRecord[]) => {
    const { outcomes, unmatched } = joinDeclarationRecordsToDevices(records, devices);
    return [...outcomes, ...unmatched];
  };

  // One declaration failing on three Macs for one reason is one problem, not three.
  it('collapses the same failure on many devices into one group', () => {
    const groups = groupFailuresByReason(
      outcomesFor([failingOn(ADA), failingOn(BABBAGE), failingOn(CURIE)]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.deviceCount).toBe(3);
    expect(groups[0]?.recordCount).toBe(3);
    expect(groups[0]?.reasons).toEqual(CANNOT_APPLY_FLAT);
    expect(groups[0]?.devices.map((d) => d.name)).toEqual([
      'Ada Lab Mac',
      'Babbage Loaner',
      'Curie Kiosk iPad',
    ]);
  });

  // Same reason text, but one was never delivered and the other was delivered invalid.
  // Those are not the same problem to fix, so the signature includes status and validity.
  it('splits identical reasons across different status or validity', () => {
    const groups = groupFailuresByReason(
      outcomesFor([
        failingOn(ADA),
        failingOn(BABBAGE, { status: 'SUCCESSFUL', validityState: 'INVALID' }),
      ]),
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.deviceCount)).toEqual([1, 1]);
  });

  // Ordering is on devices affected, not records returned, and those disagree here:
  // the lonely group has more records but touches fewer Macs.
  it('orders groups by how many devices they affect, not how many records', () => {
    const lonely = [{ code: 'Error.Lonely', description: 'one device, three channels' }];
    const groups = groupFailuresByReason(
      outcomesFor([
        failingOn(ADA, { channel: 'device', reasons: lonely }),
        failingOn(ADA, { channel: 'user', reasons: lonely }),
        failingOn(ADA, { channel: 'system', reasons: lonely }),
        failingOn(BABBAGE),
        failingOn(CURIE),
      ]),
    );
    expect(groups.map((g) => g.deviceCount)).toEqual([2, 1]);
    expect(groups.map((g) => g.recordCount)).toEqual([2, 3]);
    expect(groups[0]?.reasons).toEqual(CANNOT_APPLY_FLAT);
  });

  // Device and user channel produce two records for one Mac. Counting records as
  // devices would overstate the blast radius.
  it('counts a device once when it reports the same failure twice', () => {
    const groups = groupFailuresByReason(
      outcomesFor([failingOn(ADA, { channel: 'device' }), failingOn(ADA, { channel: 'user' })]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.recordCount).toBe(2);
    expect(groups[0]?.deviceCount).toBe(1);
    expect(groups[0]?.devices).toHaveLength(1);
  });

  it('ignores healthy outcomes entirely', () => {
    expect(groupFailuresByReason(outcomesFor([record(), record({ deviceId: BABBAGE })]))).toEqual(
      [],
    );
  });

  it('hands out no reference into its input', () => {
    const outcomes = outcomesFor([failingOn(ADA)]);
    const groups = groupFailuresByReason(outcomes);
    groups[0]?.reasons.push('mutated by the caller');
    expect(outcomes[0]?.reasons).toEqual(CANNOT_APPLY_FLAT);
  });
});

describe('summarizeDeclarationScope', () => {
  it('tallies by observed value, so a status Jamf adds later still lands in a bucket', () => {
    const report = summarizeDeclarationScope(
      [
        record({ deviceId: ADA }),
        record({ deviceId: BABBAGE, status: 'AWAITING_SYNC' }),
        record({
          deviceId: CURIE,
          status: 'SOMETHING_JAMF_ADDED_LATER',
          type: 'ASSET',
          channel: 'user',
          validityState: 'UNKNOWN',
        }),
      ],
      devices,
    );
    expect(report.rollup.byStatus).toEqual({
      SUCCESSFUL: 1,
      AWAITING_SYNC: 1,
      SOMETHING_JAMF_ADDED_LATER: 1,
    });
    expect(report.rollup.byType).toEqual({ CONFIGURATION: 2, ASSET: 1 });
    expect(report.rollup.byChannel).toEqual({ device: 2, user: 1 });
    expect(report.rollup.byValidity).toEqual({ VALID: 2, UNKNOWN: 1 });
  });

  // Records are not devices. A caller reading outcomes.length as a device count would
  // overstate the problem.
  it('counts distinct devices, not records, and splits them into failed and healthy', () => {
    // Ada fails on both channels: two failing records, but one affected Mac. Reporting
    // two would double-count the problem.
    const report = summarizeDeclarationScope(
      [
        record({ deviceId: ADA, channel: 'device', status: 'UNSUCCESSFUL', reasons: CANNOT_APPLY }),
        record({ deviceId: ADA, channel: 'user', status: 'UNSUCCESSFUL', reasons: CANNOT_APPLY }),
        record({ deviceId: BABBAGE }),
      ],
      devices,
    );
    expect(report.rollup.records).toBe(3);
    expect(report.rollup.devices).toBe(2);
    expect(report.rollup.failedRecords).toBe(2);
    expect(report.rollup.failedDevices).toBe(1);
    expect(report.rollup.healthyDevices).toBe(1);
    expect(report.rollup.failedDevices + report.rollup.healthyDevices).toBe(
      report.rollup.devices,
    );
    expect(report.verdict).toContain('1 of 2 device(s)');
  });

  it('names devices reporting the declaration more than once', () => {
    const report = summarizeDeclarationScope(
      [
        record({ deviceId: ADA, channel: 'device' }),
        record({ deviceId: ADA, channel: 'user' }),
        record({ deviceId: BABBAGE }),
      ],
      devices,
    );
    expect(report.devicesWithMultipleRecords).toEqual([
      { deviceId: ADA, name: 'Ada Lab Mac', recordCount: 2 },
    ]);
  });

  it('counts records with no deviceId separately from device totals', () => {
    const report = summarizeDeclarationScope(
      [record({ deviceId: ADA }), { declarationIdentifier: SUBJECT, status: 'SUCCESSFUL' }],
      devices,
    );
    expect(report.rollup.records).toBe(2);
    expect(report.rollup.recordsMissingDeviceId).toBe(1);
    // The id-less record must not be counted as a device.
    expect(report.rollup.devices).toBe(1);
    expect(report.unmatchedDevices).toHaveLength(1);
  });

  it('separates unresolved device ids from resolved ones in the rollup', () => {
    const report = summarizeDeclarationScope(
      [record({ deviceId: ADA }), record({ deviceId: GHOST })],
      devices,
    );
    expect(report.rollup.resolvedDevices).toBe(1);
    expect(report.rollup.unresolvedDevices).toBe(1);
    expect(report.rollup.devices).toBe(2);
    expect(report.unmatchedDevices.map((o) => o.deviceId)).toEqual([GHOST]);
  });

  it('surfaces a record belonging to a different declaration', () => {
    const report = summarizeDeclarationScope(
      [record(), record({ deviceId: BABBAGE, declarationIdentifier: 'Blueprint_Something_Else' })],
      devices,
      { declarationIdentifier: SUBJECT },
    );
    expect(report.declarationIdentifier).toBe(SUBJECT);
    expect(report.foreignDeclarationIdentifiers).toEqual(['Blueprint_Something_Else']);
  });

  it('falls back to the identifier the records carry when the caller names none', () => {
    const report = summarizeDeclarationScope([record()], devices);
    expect(report.declarationIdentifier).toBe(SUBJECT);
    expect(report.foreignDeclarationIdentifiers).toEqual([]);
  });

  // A capped page walk that reads as complete is the false all-clear rule.
  it('calls the answer INCOMPLETE when the gateway reported more records than arrived', () => {
    const report = summarizeDeclarationScope([record()], devices, {
      declarationIdentifier: SUBJECT,
      reportedTotalCount: 40,
    });
    expect(report.truncated).toEqual({ reportedTotalCount: 40, received: 1 });
    expect(report.verdict).toContain('INCOMPLETE');
    expect(report.verdict).toContain('1 of 40');
    expect(report.excludedFromThisAnswer.join('\n')).toContain('39 record(s)');
  });

  it('does not claim truncation when every reported record arrived', () => {
    const report = summarizeDeclarationScope([record()], devices, { reportedTotalCount: 1 });
    expect(report.truncated).toBeNull();
    expect(report.verdict).not.toContain('INCOMPLETE');
  });

  // Every record unmatched because the device list is empty is a missing input, not a
  // fleet finding — and it must not be presented as one.
  it('says the device list was unusable rather than blaming the fleet', () => {
    const report = summarizeDeclarationScope([record(), record({ deviceId: BABBAGE })], []);
    expect(report.deviceListUnusable).toBe(true);
    expect(report.rollup.unresolvedDevices).toBe(2);
    expect(report.verdict).toContain('No device can be identified');
    expect(report.verdict).toContain('missing input');
  });

  it('does not flag an unusable device list when there was nothing to match', () => {
    const report = summarizeDeclarationScope([], []);
    expect(report.deviceListUnusable).toBe(false);
  });

  // An empty result was first read as "deployed nowhere" against a live tenant, for a
  // declaration a device was simultaneously confirmed to be reporting as SUCCESSFUL.
  // The cause was the filter matching nothing, which the verdict did not offer as a
  // possibility — so the tool stated the one explanation that was false.
  it('refuses to read an empty result as deployed nowhere', () => {
    const report = summarizeDeclarationScope([], devices, { declarationIdentifier: SUBJECT });
    expect(report.rollup.records).toBe(0);
    expect(report.failureGroups).toEqual([]);
    expect(report.verdict).toContain('PENDING');
  });

  it('names an unmatched filter as a cause of an empty result, not just deployment', () => {
    const report = summarizeDeclarationScope([], devices, { declarationIdentifier: SUBJECT });
    expect(report.verdict).toContain('FILTER MATCHED NOTHING');
    // The actionable next step must be in the answer, not left to the reader — and it
    // must name the filter confirmed to work, since that is what settles the ambiguity.
    expect(report.verdict).toContain('active==true,active==false');
  });

  it('never presents an all-healthy answer as fully deployed', () => {
    const report = summarizeDeclarationScope([record(), record({ deviceId: BABBAGE })], devices);
    expect(report.failureGroups).toEqual([]);
    expect(report.verdict).toContain('All 2 device(s)');
    expect(report.verdict).toContain('not the same as fully deployed');
  });

  it('always states that PENDING and silent devices are excluded', () => {
    const excludes = summarizeDeclarationScope([record()], devices).excludedFromThisAnswer.join(
      '\n',
    );
    expect(excludes).toContain('PENDING');
    expect(excludes).toContain('has not reported this declaration at all');
  });

  it('says a match-all filter narrowed nothing beyond PENDING', () => {
    const report = summarizeDeclarationScope([record()], devices, { filter: 'deviceId==*' });
    expect(report.filter).toBe('deviceId==*');
    expect(report.excludedFromThisAnswer.join('\n')).toContain('narrows nothing beyond');
  });

  it('names a narrowing filter as an exclusion', () => {
    const report = summarizeDeclarationScope([record()], devices, {
      filter: 'validityState==INVALID',
    });
    expect(report.excludedFromThisAnswer.join('\n')).toContain(
      'the filter "validityState==INVALID" excluded',
    );
  });

  it('groups failures into the report and keeps the device list with each group', () => {
    const failing = (deviceId: string) =>
      record({ deviceId, status: 'UNSUCCESSFUL', reasons: CANNOT_APPLY });
    const report = summarizeDeclarationScope(
      [failing(ADA), failing(BABBAGE), failing(GHOST), record({ deviceId: CURIE })],
      devices,
      { declarationIdentifier: SUBJECT },
    );
    expect(report.failureGroups).toHaveLength(1);
    expect(report.failureGroups[0]?.deviceCount).toBe(3);
    // The unresolved device is grouped with the rest, flagged rather than hidden.
    expect(report.failureGroups[0]?.devices.filter((d) => !d.resolved)).toEqual([
      { deviceId: GHOST, name: undefined, serialNumber: undefined, resolved: false },
    ]);
    expect(report.rollup.failedDevices).toBe(3);
    expect(report.rollup.healthyDevices).toBe(1);
  });

  it('counts inactive declarations without treating them as failures', () => {
    const report = summarizeDeclarationScope(
      [record({ active: false }), record({ deviceId: BABBAGE, active: true })],
      devices,
    );
    expect(report.rollup.inactive).toBe(1);
    expect(report.rollup.failedRecords).toBe(0);
  });
});
