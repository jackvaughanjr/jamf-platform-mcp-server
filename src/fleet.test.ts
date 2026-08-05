import { describe, expect, it } from 'vitest';

import {
  lastSeen,
  majorVersion,
  matchesDeviceQuery,
  platformOf,
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
