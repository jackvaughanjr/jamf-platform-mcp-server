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

/** Timestamp fields that can evidence a device having reported in, freshest wins. */
export const SEEN_FIELDS = [
  'lastCheckInTime',
  'lastContactTime',
  'lastInventoryUpdateTime',
] as const;

export type SeenSource = (typeof SEEN_FIELDS)[number];

/**
 * Most recent evidence that a device reported in, across all three timestamps.
 *
 * Do NOT use `lastCheckInTime` alone. Observed on a live tenant: it is populated
 * for Macs and **null for every mobile device**, while `lastInventoryUpdateTime`
 * is populated for both. `lastContactTime` was null on every record sampled.
 * Keying staleness on check-in alone reported every iPad as never having reported
 * in, which is a false alarm rather than a finding.
 */
export function lastSeen(device: DeviceRecord): { at: number | null; source: SeenSource | null } {
  let at: number | null = null;
  let source: SeenSource | null = null;
  for (const field of SEEN_FIELDS) {
    const raw = device[field];
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) continue;
    if (at === null || parsed > at) {
      at = parsed;
      source = field;
    }
  }
  return { at, source };
}

export interface DeviceSummary {
  total: number;
  byPlatform: Array<{ key: string; count: number }>;
  byOsMajor: Array<{ key: string; count: number }>;
  byEnrollmentType: Array<{ key: string; count: number }>;
  managed: number;
  unmanaged: number;
  /**
   * Staleness against the freshest of the three timestamps.
   * `unreadable` covers a device carrying a timestamp none of which parses — it is
   * counted stale rather than assumed healthy.
   */
  staleness: {
    thresholdDays: number;
    stale: number;
    neverSeen: number;
    unreadable: number;
    /** Which field supplied the freshest value, so a platform gap is visible. */
    bySource: Array<{ key: string; count: number }>;
  };
  /**
   * How many records populate each timestamp field at all. Makes the Mac-only
   * nature of `lastCheckInTime` explicit rather than hidden behind a total.
   */
  signalAvailability: Array<{ key: string; count: number }>;
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
  let neverSeen = 0;
  let unreadable = 0;
  const sources: string[] = [];

  for (const d of devices) {
    const { at, source } = lastSeen(d);
    if (at === null) {
      // Distinguish "no timestamp at all" from "a timestamp we cannot read".
      const carriesSomething = SEEN_FIELDS.some((f) => Boolean(d[f]));
      if (carriesSomething) {
        unreadable += 1;
        stale += 1;
      } else {
        neverSeen += 1;
      }
      continue;
    }
    sources.push(source ?? 'unknown');
    if (at < cutoff) stale += 1;
  }

  return {
    total: devices.length,
    byPlatform: ranked(tally(devices.map((d) => platformOf(d.modelIdentifier)))),
    byOsMajor: ranked(tally(devices.map((d) => majorVersion(d.operatingSystemVersion)))),
    byEnrollmentType: ranked(tally(devices.map((d) => d.enrollmentType ?? 'unknown'))),
    managed: devices.filter((d) => d.managed === true).length,
    unmanaged: devices.filter((d) => d.managed === false).length,
    staleness: {
      thresholdDays: staleThresholdDays,
      stale,
      neverSeen,
      unreadable,
      bySource: ranked(tally(sources)),
    },
    signalAvailability: SEEN_FIELDS.map((field) => ({
      key: field,
      count: devices.filter((d) => Boolean(d[field])).length,
    })),
  };
}

export interface GroupSummary {
  total: number;
  byDeviceType: Array<{ key: string; count: number }>;
  byGroupType: Array<{ key: string; count: number }>;
  emptyGroups: number;
  largest: Array<{ name: string; memberCount: number; deviceType: string }>;
  /**
   * How many groups sit at the maximum member count.
   *
   * A fleet's biggest groups are usually catch-alls — an all-managed-clients
   * group, per-application "installed" groups — all holding the same total. When
   * this count reaches the requested topN, the `largest` list is saturated with
   * them and is telling you nothing differentiating; raise topN to see past them.
   */
  saturation: { maxMemberCount: number; groupsAtMax: number; largestIsSaturated: boolean };
}

export function summarizeGroups(groups: DeviceGroupRecord[], topN = 10): GroupSummary {
  const sized = groups.filter((g) => typeof g.memberCount === 'number');
  const maxMemberCount = sized.reduce((m, g) => Math.max(m, g.memberCount ?? 0), 0);
  const groupsAtMax = sized.filter((g) => (g.memberCount ?? 0) === maxMemberCount).length;

  return {
    total: groups.length,
    byDeviceType: ranked(tally(groups.map((g) => g.deviceType ?? 'unknown'))),
    byGroupType: ranked(tally(groups.map((g) => g.groupType ?? 'unknown'))),
    emptyGroups: groups.filter((g) => (g.memberCount ?? 0) === 0).length,
    largest: sized
      .slice()
      .sort(
        (a, b) =>
          (b.memberCount ?? 0) - (a.memberCount ?? 0) ||
          (a.name ?? '').localeCompare(b.name ?? ''),
      )
      .slice(0, topN)
      .map((g) => ({
        name: g.name ?? '(unnamed)',
        memberCount: g.memberCount ?? 0,
        deviceType: g.deviceType ?? 'unknown',
      })),
    saturation: {
      maxMemberCount,
      groupsAtMax,
      // Only meaningful when there is more than one group at the top.
      largestIsSaturated: groupsAtMax > 1 && groupsAtMax >= topN,
    },
  };
}

export interface OutdatedDevice {
  id?: string;
  name?: string;
  serialNumber?: string | null;
  platform: Platform;
  operatingSystemVersion: string | null;
  majorVersion: string;
  lastSeenIso: string | null;
  lastSeenSource: SeenSource | null;
}

/**
 * Devices whose OS major version is below `belowMajor`.
 *
 * Devices with an unreadable or absent version are returned separately rather than
 * folded in: "version unknown" is not the same finding as "version is old", and
 * silently treating one as the other either hides a reporting problem or invents
 * an upgrade task.
 */
export function selectOutdatedDevices(
  devices: DeviceRecord[],
  belowMajor: number,
): { outdated: OutdatedDevice[]; unknownVersion: OutdatedDevice[] } {
  const project = (d: DeviceRecord): OutdatedDevice => {
    const { at, source } = lastSeen(d);
    return {
      id: d.id,
      name: d.name,
      serialNumber: d.serialNumber,
      platform: platformOf(d.modelIdentifier),
      // Normalise "" to null. The gateway returns an empty string (not null) for
      // devices that never completed setup, and `??` passes "" through — which
      // would report operatingSystemVersion: "" beside majorVersion: "unknown"
      // and invite a consumer to treat "" as a version.
      operatingSystemVersion: d.operatingSystemVersion ? d.operatingSystemVersion : null,
      majorVersion: majorVersion(d.operatingSystemVersion),
      lastSeenIso: at === null ? null : new Date(at).toISOString(),
      lastSeenSource: source,
    };
  };

  const outdated: OutdatedDevice[] = [];
  const unknownVersion: OutdatedDevice[] = [];

  for (const d of devices) {
    const major = majorVersion(d.operatingSystemVersion);
    if (major === 'unknown') {
      unknownVersion.push(project(d));
    } else if (Number(major) < belowMajor) {
      outdated.push(project(d));
    }
  }

  // Oldest first — that is the order someone works through them in.
  outdated.sort((a, b) => Number(a.majorVersion) - Number(b.majorVersion));
  return { outdated, unknownVersion };
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a string is a bare UUID, so it can be used as an id without a lookup. */
export function looksLikeUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/** Case-insensitive substring match on a group's name or description. */
export function matchesGroupQuery(group: DeviceGroupRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return [group.name, group.description].some(
    (field) => typeof field === 'string' && field.toLowerCase().includes(q),
  );
}

export interface EnrichedMember {
  id: string;
  name?: string;
  serialNumber?: string | null;
  platform: Platform;
  operatingSystemVersion: string | null;
  lastSeenIso: string | null;
}

/**
 * Joins a group's member ids against the device list.
 *
 * The members endpoint returns **bare device UUIDs**, not records, so on its own it
 * answers "how many" but never "which". Ids with no matching device are returned
 * separately rather than dropped: a membership pointing at a device absent from the
 * device list is itself a finding, not noise to hide.
 */
export function enrichGroupMembers(
  memberIds: string[],
  devices: DeviceRecord[],
): { members: EnrichedMember[]; unresolvedIds: string[] } {
  const byId = new Map<string, DeviceRecord>();
  for (const d of devices) if (d.id) byId.set(d.id, d);

  const members: EnrichedMember[] = [];
  const unresolvedIds: string[] = [];

  for (const id of memberIds) {
    const device = byId.get(id);
    if (!device) {
      unresolvedIds.push(id);
      continue;
    }
    const { at } = lastSeen(device);
    members.push({
      id,
      name: device.name,
      serialNumber: device.serialNumber,
      platform: platformOf(device.modelIdentifier),
      operatingSystemVersion: device.operatingSystemVersion ? device.operatingSystemVersion : null,
      lastSeenIso: at === null ? null : new Date(at).toISOString(),
    });
  }

  members.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  return { members, unresolvedIds };
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

/**
 * One declaration's reported state on one device, from
 * `ddm/report` → `devices/{id}/declarations`.
 *
 * Field names and enum members are taken from the operation's own reference page
 * (`getdevicereportbyfilter`). Every enum carries `UNKNOWN` upstream, so none of
 * these is treated as a closed set here — a value Jamf adds later must not become a
 * silent miscount.
 */
export interface DeclarationRecord {
  declarationIdentifier?: string;
  deviceId?: string;
  channel?: string;
  type?: string;
  status?: string;
  active?: boolean;
  validityState?: string;
  serverToken?: string;
  dateUpdated?: string | null;
  lastReportTime?: string | null;
  reasons?: Array<{
    code?: string;
    description?: string;
    details?: Array<{ key?: string; description?: string }>;
  }>;
}

/**
 * One declaration named, so the answer can be acted on or chained.
 *
 * `declarationIdentifier` is the handle every other Declaration Reporting route
 * takes — notably `getDeclarationScope`, which needs one to ask the fleet-wide
 * question. A summary of counts alone cannot be fed anywhere.
 */
export interface DeclarationListing {
  declarationIdentifier: string;
  type?: string;
  status?: string;
  active?: boolean;
  channel?: string;
}

/** A declaration that did not land, with the reasons flattened for reading. */
export interface FailedDeclaration {
  declarationIdentifier: string;
  channel?: string;
  type?: string;
  status?: string;
  validityState?: string;
  lastReportTime?: string | null;
  /** `code: description` per reason, plus any detail lines. */
  reasons: string[];
}

/**
 * Summarises per-device declaration state, leading with what is wrong.
 *
 * A count by status answers "is this device healthy"; it does not answer "why is it
 * not", which is the only question worth asking next. `reasons` is the one field that
 * carries that, so failures are pulled out with their reasons flattened rather than
 * left for the caller to dig out of a nested array.
 *
 * Counting is by observed value, not against a hardcoded enum list, because every
 * enum in this API already includes `UNKNOWN` — so Jamf clearly expects to add
 * members, and a fixed switch would drop a new one into no bucket at all.
 *
 * `INVALID` validity is treated as a failure alongside an unsuccessful status: a
 * declaration can report SUCCESSFUL delivery while being invalid on the device, and
 * reporting that as healthy is the same class of false all-clear this project keeps
 * finding.
 */
export function summarizeDeclarations(records: DeclarationRecord[]): {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  byChannel: Record<string, number>;
  inactive: number;
  declarations: DeclarationListing[];
  failed: FailedDeclaration[];
} {
  const tally = (values: Array<string | undefined>) =>
    values.reduce<Record<string, number>>((acc, value) => {
      const key = value ?? '(absent)';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

  const failed: FailedDeclaration[] = [];
  for (const record of records) {
    const badStatus = record.status === 'UNSUCCESSFUL';
    const badValidity = record.validityState === 'INVALID';
    if (!badStatus && !badValidity) continue;

    const reasons: string[] = [];
    for (const reason of record.reasons ?? []) {
      const head = [reason.code, reason.description].filter(Boolean).join(': ');
      if (head) reasons.push(head);
      for (const detail of reason.details ?? []) {
        const line = [detail.key, detail.description].filter(Boolean).join(': ');
        if (line) reasons.push(`  ${line}`);
      }
    }
    // Say so rather than returning an empty array that reads as "no reason given
    // because nothing is wrong".
    if (reasons.length === 0) {
      reasons.push(badValidity && !badStatus ? 'validityState INVALID, no reason reported' : 'no reason reported');
    }

    failed.push({
      declarationIdentifier: record.declarationIdentifier ?? '(unnamed)',
      channel: record.channel,
      type: record.type,
      status: record.status,
      validityState: record.validityState,
      lastReportTime: record.lastReportTime ?? null,
      reasons,
    });
  }

  // Counts answer "is this device healthy" and never "which declarations are on it",
  // so a healthy device produced a summary with no identifier in it anywhere — nothing
  // to act on, and nothing to hand to getDeclarationScope. Naming them is the point:
  // an identifier is the only handle the rest of the API takes.
  const declarations: DeclarationListing[] = records
    .map((r) => ({
      declarationIdentifier: r.declarationIdentifier ?? '(unnamed)',
      type: r.type,
      status: r.status,
      active: r.active,
      channel: r.channel,
    }))
    .sort(
      (a, b) =>
        a.declarationIdentifier.localeCompare(b.declarationIdentifier) ||
        (a.type ?? '').localeCompare(b.type ?? ''),
    );

  return {
    total: records.length,
    byStatus: tally(records.map((r) => r.status)),
    byType: tally(records.map((r) => r.type)),
    byChannel: tally(records.map((r) => r.channel)),
    inactive: records.filter((r) => r.active === false).length,
    declarations,
    failed,
  };
}
