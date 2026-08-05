/**
 * Fleet aggregation. Pure functions only — no client, no clock, no I/O — so the
 * summarising logic is testable without a tenant and deterministic in tests.
 *
 * Field names come from real gateway responses recorded in `fixtures/shapes/`.
 * Several are nullable in practice (`lastContactTime`, `operatingSystemVersion`,
 * `description`), so every accessor here tolerates null rather than assuming the
 * happy shape.
 */

/** A record from `devices/devices`. Fields observed on a live tenant. */
export interface DeviceRecord {
  id?: string;
  name?: string;
  model?: string | null;
  modelIdentifier?: string | null;
  serialNumber?: string | null;
  operatingSystemVersion?: string | null;
  lastCheckInTime?: string | null;
  lastContactTime?: string | null;
  lastInventoryUpdateTime?: string | null;
  lastEnrollmentTime?: string | null;
  enrollmentType?: string | null;
  userId?: string | null;
  managed?: boolean;
}

/** A record from `device-groups/device-groups`. */
export interface DeviceGroupRecord {
  id?: string;
  name?: string;
  description?: string | null;
  /** Observed values: COMPUTER, MOBILE. */
  deviceType?: string | null;
  /** Observed values: SMART, STATIC. */
  groupType?: string | null;
  memberCount?: number;
}

/** A record from `blueprints/blueprints`. */
export interface BlueprintRecord {
  id?: string;
  name?: string;
  description?: string | null;
  deploymentState?: { state?: string | null } | null;
}

export type Platform = 'macOS' | 'iOS' | 'iPadOS' | 'tvOS' | 'unknown';

/**
 * Classifies a device by `modelIdentifier` (e.g. "MacBookPro18,3", "iPad13,4").
 *
 * This matters more than it looks: the gateway's `devices` endpoint is
 * cross-platform, returning Macs and iOS/iPadOS devices in one list, unlike the
 * Jamf Pro API's separate computer and mobile endpoints. Anything that treats a
 * device count as a Mac count is wrong.
 */
export function platformOf(modelIdentifier?: string | null): Platform {
  if (!modelIdentifier) return 'unknown';
  const family = modelIdentifier.replace(/[0-9].*$/, '');
  if (family.startsWith('Mac') || family.startsWith('iMac')) return 'macOS';
  if (family.startsWith('iPad')) return 'iPadOS';
  if (family.startsWith('iPhone') || family.startsWith('iPod')) return 'iOS';
  if (family.startsWith('AppleTV') || family.startsWith('TV')) return 'tvOS';
  return 'unknown';
}

/** Major version from a version string; "unknown" when absent or unparseable. */
export function majorVersion(version?: string | null): string {
  if (!version) return 'unknown';
  const major = version.split('.')[0];
  return major && /^\d+$/.test(major) ? major : 'unknown';
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Sorts a tally into descending count order for stable, readable output. */
function ranked(counts: Record<string, number>): Array<{ key: string; count: number }> {
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export interface DeviceSummary {
  total: number;
  byPlatform: Array<{ key: string; count: number }>;
  byOsMajor: Array<{ key: string; count: number }>;
  byEnrollmentType: Array<{ key: string; count: number }>;
  managed: number;
  unmanaged: number;
  /** Devices whose last check-in is older than the threshold, or absent entirely. */
  staleCheckIn: { thresholdDays: number; count: number; neverCheckedIn: number };
}

/**
 * @param now Reference instant, injected so results are deterministic in tests.
 */
export function summarizeDevices(
  devices: DeviceRecord[],
  now: Date,
  staleThresholdDays = 30,
): DeviceSummary {
  const cutoff = now.getTime() - staleThresholdDays * 24 * 60 * 60 * 1000;
  let stale = 0;
  let never = 0;

  for (const d of devices) {
    if (!d.lastCheckInTime) {
      never += 1;
      continue;
    }
    const t = Date.parse(d.lastCheckInTime);
    // An unparseable timestamp is not evidence of recency — count it as stale
    // rather than silently treating it as healthy.
    if (Number.isNaN(t) || t < cutoff) stale += 1;
  }

  return {
    total: devices.length,
    byPlatform: ranked(tally(devices.map((d) => platformOf(d.modelIdentifier)))),
    byOsMajor: ranked(tally(devices.map((d) => majorVersion(d.operatingSystemVersion)))),
    byEnrollmentType: ranked(tally(devices.map((d) => d.enrollmentType ?? 'unknown'))),
    managed: devices.filter((d) => d.managed === true).length,
    unmanaged: devices.filter((d) => d.managed === false).length,
    staleCheckIn: { thresholdDays: staleThresholdDays, count: stale, neverCheckedIn: never },
  };
}

export interface GroupSummary {
  total: number;
  byDeviceType: Array<{ key: string; count: number }>;
  byGroupType: Array<{ key: string; count: number }>;
  emptyGroups: number;
  largest: Array<{ name: string; memberCount: number; deviceType: string }>;
}

export function summarizeGroups(groups: DeviceGroupRecord[], topN = 5): GroupSummary {
  return {
    total: groups.length,
    byDeviceType: ranked(tally(groups.map((g) => g.deviceType ?? 'unknown'))),
    byGroupType: ranked(tally(groups.map((g) => g.groupType ?? 'unknown'))),
    emptyGroups: groups.filter((g) => (g.memberCount ?? 0) === 0).length,
    largest: groups
      .filter((g) => typeof g.memberCount === 'number')
      .sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0))
      .slice(0, topN)
      .map((g) => ({
        name: g.name ?? '(unnamed)',
        memberCount: g.memberCount ?? 0,
        deviceType: g.deviceType ?? 'unknown',
      })),
  };
}

export interface BlueprintSummary {
  total: number;
  byDeploymentState: Array<{ key: string; count: number }>;
}

export function summarizeBlueprints(blueprints: BlueprintRecord[]): BlueprintSummary {
  return {
    total: blueprints.length,
    byDeploymentState: ranked(
      tally(blueprints.map((b) => b.deploymentState?.state ?? 'unknown')),
    ),
  };
}

/**
 * Case-insensitive substring match across the fields someone would actually
 * search a device by.
 *
 * Client-side because the gateway's server-side filtering is undocumented and
 * unconfirmed, and the documented per-device detail route has never returned 200
 * in testing. Scanning the confirmed list endpoint is slower but is the only
 * approach resting on a verified route.
 */
export function matchesDeviceQuery(device: DeviceRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const haystack = [
    device.id,
    device.name,
    device.serialNumber,
    device.model,
    device.modelIdentifier,
    device.userId,
  ];
  return haystack.some((field) => typeof field === 'string' && field.toLowerCase().includes(q));
}
