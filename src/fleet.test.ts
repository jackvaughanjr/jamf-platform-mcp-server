import { describe, expect, it } from 'vitest';

import {
  enrichGroupMembers,
  lastSeen,
  looksLikeUuid,
  majorVersion,
  matchesDeviceQuery,
  matchesGroupQuery,
  platformOf,
  selectOutdatedDevices,
  summarizeBlueprints,
  summarizeDevices,
  summarizeGroups,
  type DeviceRecord,
} from './fleet.js';

const NOW = new Date('2026-08-05T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('platformOf', () => {
  it('classifies real model identifiers', () => {
    expect(platformOf('MacBookPro18,3')).toBe('macOS');
    expect(platformOf('Macmini9,1')).toBe('macOS');
    expect(platformOf('iMac21,1')).toBe('macOS');
    expect(platformOf('iPad13,4')).toBe('iPadOS');
    expect(platformOf('iPhone15,2')).toBe('iOS');
    expect(platformOf('AppleTV11,1')).toBe('tvOS');
  });

  it('returns unknown for null, empty, or unrecognised input', () => {
    expect(platformOf(null)).toBe('unknown');
    expect(platformOf(undefined)).toBe('unknown');
    expect(platformOf('')).toBe('unknown');
    expect(platformOf('Watch6,1')).toBe('unknown');
  });
});

describe('majorVersion', () => {
  it('extracts the major component', () => {
    expect(majorVersion('26.1.2')).toBe('26');
    expect(majorVersion('15')).toBe('15');
  });

  // Observed live: operatingSystemVersion is null on some records.
  it('returns unknown for null or non-numeric input', () => {
    expect(majorVersion(null)).toBe('unknown');
    expect(majorVersion(undefined)).toBe('unknown');
    expect(majorVersion('')).toBe('unknown');
    expect(majorVersion('beta.1')).toBe('unknown');
  });
});

describe('lastSeen', () => {
  it('takes the freshest of the three timestamps', () => {
    const { at, source } = lastSeen({
      lastCheckInTime: daysAgo(10),
      lastInventoryUpdateTime: daysAgo(1),
    });
    expect(source).toBe('lastInventoryUpdateTime');
    expect(at).toBe(Date.parse(daysAgo(1)));
  });

  // The real-world shape: mobile devices report inventory but never check-in.
  it('falls back to inventory time when check-in is null, as on every mobile device', () => {
    const { at, source } = lastSeen({
      lastCheckInTime: null,
      lastContactTime: null,
      lastInventoryUpdateTime: daysAgo(3),
    });
    expect(source).toBe('lastInventoryUpdateTime');
    expect(at).not.toBeNull();
  });

  it('returns null when nothing is present or nothing parses', () => {
    expect(lastSeen({}).at).toBeNull();
    expect(lastSeen({ lastCheckInTime: null }).at).toBeNull();
    expect(lastSeen({ lastCheckInTime: 'garbage' }).at).toBeNull();
  });
});

describe('summarizeDevices', () => {
  const devices: DeviceRecord[] = [
    { modelIdentifier: 'MacBookPro18,3', operatingSystemVersion: '26.1', managed: true, lastCheckInTime: daysAgo(1), lastInventoryUpdateTime: daysAgo(1), enrollmentType: 'Institutional' },
    { modelIdentifier: 'MacBookAir10,1', operatingSystemVersion: '26.0', managed: true, lastCheckInTime: daysAgo(2), lastInventoryUpdateTime: daysAgo(2), enrollmentType: 'Institutional' },
    // Mobile: no check-in, but recent inventory — must NOT count as stale or never-seen.
    { modelIdentifier: 'iPad13,4', operatingSystemVersion: '26.1', managed: true, lastCheckInTime: null, lastContactTime: null, lastInventoryUpdateTime: daysAgo(3), enrollmentType: 'Institutional' },
    { modelIdentifier: 'iPhone15,2', operatingSystemVersion: null, managed: false, lastCheckInTime: null, lastInventoryUpdateTime: null, enrollmentType: null },
  ];

  it('counts by platform, so a device total is never mistaken for a Mac total', () => {
    const s = summarizeDevices(devices, NOW);
    expect(s.total).toBe(4);
    expect(s.byPlatform).toEqual([
      { key: 'macOS', count: 2 },
      { key: 'iOS', count: 1 },
      { key: 'iPadOS', count: 1 },
    ]);
  });

  it('tallies OS majors including the unknown bucket', () => {
    const s = summarizeDevices(devices, NOW);
    expect(s.byOsMajor).toEqual([
      { key: '26', count: 3 },
      { key: 'unknown', count: 1 },
    ]);
  });

  it('separates managed, unmanaged, stale and never-seen', () => {
    const s = summarizeDevices(devices, NOW, 30);
    expect(s.managed).toBe(3);
    expect(s.unmanaged).toBe(1);
    // Only the device with no timestamp at all is never-seen. Nothing is stale:
    // the iPad reported inventory 3 days ago even though it has no check-in.
    expect(s.staleness.stale).toBe(0);
    expect(s.staleness.neverSeen).toBe(1);
    expect(s.staleness.unreadable).toBe(0);
  });

  // The regression this whole shape exists to prevent: a check-in-only rule
  // reported every mobile device as never having reported in.
  it('does not call a mobile device stale merely for lacking a check-in time', () => {
    const mobileOnly: DeviceRecord[] = [
      { modelIdentifier: 'iPad15,7', lastCheckInTime: null, lastContactTime: null, lastInventoryUpdateTime: daysAgo(2) },
      { modelIdentifier: 'iPad13,1', lastCheckInTime: null, lastContactTime: null, lastInventoryUpdateTime: daysAgo(4) },
    ];
    const s = summarizeDevices(mobileOnly, NOW, 30);
    expect(s.staleness.stale).toBe(0);
    expect(s.staleness.neverSeen).toBe(0);
    expect(s.staleness.bySource).toEqual([{ key: 'lastInventoryUpdateTime', count: 2 }]);
  });

  it('reports which fields are populated, exposing the Mac-only check-in field', () => {
    const s = summarizeDevices(devices, NOW);
    expect(s.signalAvailability).toEqual([
      { key: 'lastCheckInTime', count: 2 },
      { key: 'lastContactTime', count: 0 },
      { key: 'lastInventoryUpdateTime', count: 3 },
    ]);
  });

  it('respects a custom stale threshold', () => {
    expect(summarizeDevices(devices, NOW, 1).staleness.stale).toBe(2);
    expect(summarizeDevices(devices, NOW, 365).staleness.stale).toBe(0);
  });

  // A garbage timestamp must not read as "recently seen".
  it('counts an unreadable timestamp as stale, distinctly from never-seen', () => {
    const s = summarizeDevices([{ lastCheckInTime: 'not-a-date' }], NOW);
    expect(s.staleness.stale).toBe(1);
    expect(s.staleness.unreadable).toBe(1);
    expect(s.staleness.neverSeen).toBe(0);
  });

  it('handles an empty fleet without dividing by zero or throwing', () => {
    const s = summarizeDevices([], NOW);
    expect(s.total).toBe(0);
    expect(s.byPlatform).toEqual([]);
    expect(s.staleness.stale).toBe(0);
    expect(s.staleness.neverSeen).toBe(0);
  });

  // `managed` may be absent; absent is not the same as false.
  it('does not count a missing managed flag as unmanaged', () => {
    const s = summarizeDevices([{ name: 'x' }], NOW);
    expect(s.managed).toBe(0);
    expect(s.unmanaged).toBe(0);
  });
});

describe('summarizeGroups', () => {
  const groups = [
    { name: 'All Macs', deviceType: 'COMPUTER', groupType: 'SMART', memberCount: 40 },
    { name: 'All iPads', deviceType: 'MOBILE', groupType: 'SMART', memberCount: 20 },
    { name: 'Loaners', deviceType: 'MOBILE', groupType: 'STATIC', memberCount: 0 },
    { name: 'Unset', deviceType: null, groupType: null },
  ];

  it('splits by deviceType and groupType, which the gateway mixes in one list', () => {
    const s = summarizeGroups(groups);
    expect(s.total).toBe(4);
    expect(s.byDeviceType).toEqual([
      { key: 'MOBILE', count: 2 },
      { key: 'COMPUTER', count: 1 },
      { key: 'unknown', count: 1 },
    ]);
    expect(s.byGroupType).toEqual([
      { key: 'SMART', count: 2 },
      { key: 'STATIC', count: 1 },
      { key: 'unknown', count: 1 },
    ]);
  });

  it('counts empty groups and ranks the largest', () => {
    const s = summarizeGroups(groups, 2);
    // memberCount absent is treated as empty for the count, but excluded from
    // the ranking, where it would otherwise fabricate a zero-member entry.
    expect(s.emptyGroups).toBe(2);
    expect(s.largest).toEqual([
      { name: 'All Macs', memberCount: 40, deviceType: 'COMPUTER' },
      { name: 'All iPads', memberCount: 20, deviceType: 'MOBILE' },
    ]);
  });

  // The real-world failure: several catch-all groups all holding the whole fleet
  // fill the top-N list, so it shows nothing differentiating.
  it('flags a saturated largest list when groups tie at the maximum', () => {
    // Names are invented. Real tenant group names are operational detail and do
    // not belong in a repo shared outside the organisation that owns the fleet.
    const saturated = [
      { name: 'catch-all-a', memberCount: 56, deviceType: 'COMPUTER' },
      { name: 'catch-all-b', memberCount: 56, deviceType: 'COMPUTER' },
      { name: 'catch-all-c', memberCount: 56, deviceType: 'COMPUTER' },
      { name: 'narrow-group', memberCount: 3, deviceType: 'COMPUTER' },
    ];
    const tight = summarizeGroups(saturated, 3);
    expect(tight.saturation).toEqual({ maxMemberCount: 56, groupsAtMax: 3, largestIsSaturated: true });
    // Raising topN past the tie surfaces the differentiating group.
    const roomy = summarizeGroups(saturated, 4);
    expect(roomy.saturation.largestIsSaturated).toBe(false);
    expect(roomy.largest.map((g) => g.name)).toContain('narrow-group');
  });

  it('does not call a single largest group saturated', () => {
    const s = summarizeGroups([{ name: 'only', memberCount: 9 }], 1);
    expect(s.saturation.groupsAtMax).toBe(1);
    expect(s.saturation.largestIsSaturated).toBe(false);
  });

  it('defaults to 10 largest rather than 5', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `g${i}`, memberCount: i }));
    expect(summarizeGroups(many).largest).toHaveLength(10);
  });

  it('handles no groups', () => {
    expect(summarizeGroups([]).total).toBe(0);
    expect(summarizeGroups([]).largest).toEqual([]);
  });
});

describe('summarizeBlueprints', () => {
  it('tallies deployment state through the nested shape', () => {
    const s = summarizeBlueprints([
      { name: 'a', deploymentState: { state: 'DEPLOYED' } },
      { name: 'b', deploymentState: { state: 'DEPLOYED' } },
      { name: 'c', deploymentState: { state: 'PENDING' } },
      { name: 'd', deploymentState: null },
      { name: 'e' },
    ]);
    expect(s.total).toBe(5);
    expect(s.byDeploymentState).toEqual([
      { key: 'DEPLOYED', count: 2 },
      { key: 'unknown', count: 2 },
      { key: 'PENDING', count: 1 },
    ]);
  });
});

describe('selectOutdatedDevices', () => {
  const devices: DeviceRecord[] = [
    { name: 'current', modelIdentifier: 'MacBookPro18,3', operatingSystemVersion: '26.1', lastInventoryUpdateTime: daysAgo(1) },
    { name: 'old-mac', modelIdentifier: 'MacBookPro15,1', operatingSystemVersion: '15.7.2', lastCheckInTime: daysAgo(40) },
    { name: 'older-tv', modelIdentifier: 'AppleTV11,1', operatingSystemVersion: '14.0', lastInventoryUpdateTime: daysAgo(5) },
    { name: 'no-version', modelIdentifier: 'iPad15,7', operatingSystemVersion: null, lastInventoryUpdateTime: daysAgo(2) },
  ];

  it('returns devices below the threshold, oldest first', () => {
    const { outdated } = selectOutdatedDevices(devices, 26);
    expect(outdated.map((d) => d.name)).toEqual(['older-tv', 'old-mac']);
  });

  // "Unknown version" is a reporting problem, not an upgrade task. Folding it in
  // would either hide the former or invent the latter.
  it('separates unknown versions from outdated ones', () => {
    const { outdated, unknownVersion } = selectOutdatedDevices(devices, 26);
    expect(outdated.map((d) => d.name)).not.toContain('no-version');
    expect(unknownVersion.map((d) => d.name)).toEqual(['no-version']);
  });

  it('excludes devices at or above the threshold', () => {
    expect(selectOutdatedDevices(devices, 15).outdated.map((d) => d.name)).toEqual(['older-tv']);
    expect(selectOutdatedDevices(devices, 1).outdated).toEqual([]);
  });

  it('carries platform and freshest-activity context for each hit', () => {
    const { outdated } = selectOutdatedDevices(devices, 26);
    const mac = outdated.find((d) => d.name === 'old-mac');
    expect(mac?.platform).toBe('macOS');
    expect(mac?.majorVersion).toBe('15');
    expect(mac?.lastSeenSource).toBe('lastCheckInTime');
    const tv = outdated.find((d) => d.name === 'older-tv');
    expect(tv?.platform).toBe('tvOS');
    expect(tv?.lastSeenSource).toBe('lastInventoryUpdateTime');
  });

  // Observed live: a device that never completed setup reports "" here, not null.
  it('normalises an empty-string version to null, not ""', () => {
    const { unknownVersion } = selectOutdatedDevices(
      [{ name: 'never-setup', modelIdentifier: 'MacBookPro18,3', operatingSystemVersion: '' }],
      26,
    );
    expect(unknownVersion).toHaveLength(1);
    expect(unknownVersion[0]?.operatingSystemVersion).toBeNull();
    expect(unknownVersion[0]?.majorVersion).toBe('unknown');
  });

  it('handles an empty fleet', () => {
    expect(selectOutdatedDevices([], 26)).toEqual({ outdated: [], unknownVersion: [] });
  });
});

describe('looksLikeUuid', () => {
  it('accepts a real UUID and rejects a name', () => {
    expect(looksLikeUuid('8dce9404-4779-49cc-825b-428ac74eddc9')).toBe(true);
    expect(looksLikeUuid('  8DCE9404-4779-49CC-825B-428AC74EDDC9  ')).toBe(true);
    expect(looksLikeUuid('All Managed')).toBe(false);
    expect(looksLikeUuid('8dce9404')).toBe(false);
    // A trailing segment makes it not a bare id — must not be treated as one.
    expect(looksLikeUuid('8dce9404-4779-49cc-825b-428ac74eddc9/members')).toBe(false);
  });
});

describe('matchesGroupQuery', () => {
  const group = { name: 'Compliance Level 2', description: 'baseline scope' };

  it('matches name or description, case-insensitively', () => {
    expect(matchesGroupQuery(group, 'level 2')).toBe(true);
    expect(matchesGroupQuery(group, 'BASELINE')).toBe(true);
  });

  it('does not match on an empty query or unrelated text', () => {
    expect(matchesGroupQuery(group, '')).toBe(false);
    expect(matchesGroupQuery(group, '   ')).toBe(false);
    expect(matchesGroupQuery(group, 'level 3')).toBe(false);
  });

  it('tolerates a null description', () => {
    expect(matchesGroupQuery({ name: 'x', description: null }, 'x')).toBe(true);
  });
});

describe('enrichGroupMembers', () => {
  const devices: DeviceRecord[] = [
    { id: 'id-b', name: 'beta', serialNumber: 'SB', modelIdentifier: 'iPad13,4', operatingSystemVersion: '26.1', lastInventoryUpdateTime: daysAgo(1) },
    { id: 'id-a', name: 'alpha', serialNumber: 'SA', modelIdentifier: 'MacBookPro18,3', operatingSystemVersion: '26.0', lastCheckInTime: daysAgo(2) },
  ];

  it('resolves bare member ids to device detail, sorted by name', () => {
    const { members, unresolvedIds } = enrichGroupMembers(['id-b', 'id-a'], devices);
    expect(members.map((m) => m.name)).toEqual(['alpha', 'beta']);
    expect(members[0]?.platform).toBe('macOS');
    expect(members[0]?.serialNumber).toBe('SA');
    expect(members[1]?.lastSeenIso).not.toBeNull();
    expect(unresolvedIds).toEqual([]);
  });

  // A membership pointing at a device absent from the device list is a finding.
  it('reports member ids with no matching device instead of dropping them', () => {
    const { members, unresolvedIds } = enrichGroupMembers(['id-a', 'ghost-id'], devices);
    expect(members).toHaveLength(1);
    expect(unresolvedIds).toEqual(['ghost-id']);
  });

  it('handles an empty group and an empty device list', () => {
    expect(enrichGroupMembers([], devices)).toEqual({ members: [], unresolvedIds: [] });
    expect(enrichGroupMembers(['id-a'], []).unresolvedIds).toEqual(['id-a']);
  });

  it('normalises an empty-string OS version to null', () => {
    const { members } = enrichGroupMembers(['x'], [{ id: 'x', operatingSystemVersion: '' }]);
    expect(members[0]?.operatingSystemVersion).toBeNull();
  });
});

describe('matchesDeviceQuery', () => {
  const device: DeviceRecord = {
    id: 'abc-123',
    name: "Jack's MacBook Pro",
    serialNumber: 'C02XK1TEST',
    model: 'MacBook Pro (16-inch, 2021)',
    modelIdentifier: 'MacBookPro18,3',
    userId: 'user-42',
  };

  it('matches serial, name, model and id case-insensitively', () => {
    expect(matchesDeviceQuery(device, 'c02xk1test')).toBe(true);
    expect(matchesDeviceQuery(device, 'macbook')).toBe(true);
    expect(matchesDeviceQuery(device, 'ABC-123')).toBe(true);
    expect(matchesDeviceQuery(device, 'user-42')).toBe(true);
  });

  it('does not match unrelated input', () => {
    expect(matchesDeviceQuery(device, 'ipad')).toBe(false);
  });

  // An empty query must not match everything — that would silently dump the fleet.
  it('returns false for an empty or whitespace query', () => {
    expect(matchesDeviceQuery(device, '')).toBe(false);
    expect(matchesDeviceQuery(device, '   ')).toBe(false);
  });

  it('tolerates records with null or missing fields', () => {
    expect(matchesDeviceQuery({ name: null, serialNumber: undefined }, 'x')).toBe(false);
  });
});
