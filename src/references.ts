/**
 * What references a Jamf object — and, given equal weight, what could NOT be
 * checked.
 *
 * Pure functions only — no client, no clock, no I/O — so the reference logic is
 * testable without a tenant. Something else fetches; this reads what arrived.
 *
 * Jamf has no built-in answer to "what depends on this before I change or delete
 * it". Two community tools filled the gap: Prune, which finds unused objects and
 * then deletes them, and Spruce, archived in 2023. This project can never delete
 * anything ([JPM-0007](../decisions/JPM-0007-write-path-posture.md)), so it builds
 * the read-only half.
 *
 * Prune's own published caveat is the standard to beat: it "may identify some items
 * as unused that are actually in use due to API limitations". That caveat is a
 * footnote in a README, which means it is absent at the moment someone reads a
 * report and decides to delete. Here it is a field. `notChecked`,
 * `objectsWithNoReadableContainer` and `strength` exist so a caller physically
 * cannot render an all-clear that the data does not support — the same failure mode
 * `findExpensiveAutomations` once shipped, where an unmatched response key produced
 * "scanned 0, found no problems".
 *
 * Two things are deliberately NOT inferred here:
 *
 * - **Route reachability.** Whether a Classic resource can be fetched from this
 *   gateway is the caller's problem and varies by tenant. This module is told what
 *   arrived; a resource the caller could not reach is passed as
 *   `{ unavailable: true, reason }` and lands in `notChecked` with the reason
 *   intact.
 * - **Shape correctness.** Only `policies`, `computergroups` and
 *   `advancedcomputersearches` shapes are confirmed against a live tenant. Every
 *   other extractor reads candidate paths and reports how many objects yielded no
 *   readable container at all, rather than quietly returning nothing.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Reading untyped JSON without throwing
//
// Every field of every shape below is treated as possibly absent or the wrong
// type. Jamf's Classic responses are hand-shaped per resource, several of them are
// unconfirmed here, and a `TypeError` in the middle of an audit loses the findings
// already collected. The one thing that DOES throw is input this cannot read at
// all — see `findObjectReferences` and `buildGroupDependencyGraph`.
// ─────────────────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Walks a dotted path, giving up quietly the moment the shape stops matching. */
function at(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    const record = asRecord(cursor);
    if (!record) return undefined;
    cursor = record[key];
  }
  return cursor;
}

/**
 * Renders a scalar as a trimmed string, or undefined.
 *
 * Classic returns ids as JSON numbers, the Jamf Pro API returns them as strings,
 * and the same field can be either across resources — so an id comparison has to
 * be done on strings or half the matches are lost to `12 !== '12'`. Empty strings
 * become undefined: an empty name must never match anything.
 */
function scalarString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Case-insensitive exact key for name comparison. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirmed Classic detail shapes
//
// Declared for callers to type their fetches against, and as the record of what
// has actually been seen. Nothing in this module trusts them at runtime.
// ─────────────────────────────────────────────────────────────────────────────

/** A `{id, name}` pair as Classic writes scope and slot members. */
export interface ClassicRef {
  id?: number | string;
  name?: string;
}

/** Classic `scope` block. Confirmed on policies. */
export interface ClassicScope {
  all_computers?: boolean;
  computers?: ClassicRef[];
  computer_groups?: ClassicRef[];
  buildings?: ClassicRef[];
  departments?: ClassicRef[];
  exclusions?: {
    computers?: ClassicRef[];
    computer_groups?: ClassicRef[];
    buildings?: ClassicRef[];
    departments?: ClassicRef[];
  };
}

/** A criterion inside a smart group or advanced search. */
export interface ReferenceCriterion {
  name?: string;
  search_type?: string;
  value?: string | number | boolean | null;
  priority?: number;
  and_or?: string;
}

/** `policies/id/{id}`. Confirmed live. */
export interface PolicyDetail {
  general?: { id?: number | string; name?: string; enabled?: boolean };
  scope?: ClassicScope;
  scripts?: Array<ClassicRef & { priority?: string | number }>;
  package_configuration?: { packages?: Array<ClassicRef & { display_name?: string }> };
}

/** `computergroups/id/{id}`. Confirmed live. */
export interface ComputerGroupDetail {
  id?: number | string;
  name?: string;
  is_smart?: boolean;
  criteria?: ReferenceCriterion[];
}

/** `advancedcomputersearches/id/{id}`. Confirmed live. */
export interface AdvancedComputerSearchDetail {
  id?: number | string;
  name?: string;
  criteria?: ReferenceCriterion[];
  display_fields?: Array<{ name?: string }>;
}

/**
 * A Classic object whose only relevant reference surface is its scope —
 * configuration profiles, restricted software, eBooks.
 *
 * Identity sits under `general` on some of these and at the top level on others,
 * which is why `objectIdentity` checks both.
 */
export interface ScopedObjectDetail {
  id?: number | string;
  name?: string;
  general?: { id?: number | string; name?: string; enabled?: boolean };
  scope?: ClassicScope;
}

// ─────────────────────────────────────────────────────────────────────────────
// Group-membership criteria — shared by both halves of this module
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Criterion names that express "this group's membership depends on that group".
 *
 * Only `Computer Group` is confirmed. It is the single readable link Jamf gives for
 * group-to-group dependency: the criterion's `value` holds the referenced group's
 * **name**, never its id. Matched case-insensitively but exactly — a criterion
 * called "Computer Group Name" would be a different field, and a substring rule
 * would swallow it.
 *
 * A tenant on a Jamf Pro version that labels this differently would go unseen. That
 * is why the graph reports what it could not read rather than returning a tidy
 * empty result.
 */
export const GROUP_MEMBERSHIP_CRITERION_NAMES: readonly string[] = ['Computer Group'];

/**
 * A membership criterion whose sense is inverted.
 *
 * Jamf writes these as "member of" / "not member of". Detected by the presence of
 * the word "not" rather than by an enumerated list, because the list is not
 * published and a search type this misses would be reported as its own opposite —
 * which is the one error in this file that would produce actively harmful advice.
 */
export function isNegatedMembershipSearchType(searchType: string | undefined): boolean {
  return searchType !== undefined && /\bnot\b/i.test(searchType);
}

/** One group-membership criterion, resolved to the group name it points at. */
export interface GroupMembershipCriterion {
  /** Referenced group name, from the criterion `value`. */
  groupName: string;
  searchType?: string;
  /** True for "not member of" — the dependency exists, its sense is inverted. */
  negated: boolean;
  /** Position in the `criteria` array, so the finding can be located. */
  index: number;
}

/**
 * Pulls group-membership criteria out of a `criteria` array.
 *
 * `readable` is the field that matters. A group with no `criteria` array is not the
 * same as a group with an empty one: the first means nothing was examined, the
 * second means nothing is there. Collapsing them is how a dependency audit reports
 * a clean bill of health for an object it never opened.
 *
 * `unreadableValues` counts criteria that ARE group-membership criteria but whose
 * value could not be read as a name — a real blind spot, since each one is a
 * dependency that exists and cannot be resolved.
 */
export function readGroupMembershipCriteria(criteria: unknown): {
  found: GroupMembershipCriterion[];
  readable: boolean;
  unreadableValues: number;
} {
  if (!Array.isArray(criteria)) return { found: [], readable: false, unreadableValues: 0 };

  const wanted = new Set(GROUP_MEMBERSHIP_CRITERION_NAMES.map(nameKey));
  const found: GroupMembershipCriterion[] = [];
  let unreadableValues = 0;

  criteria.forEach((raw, index) => {
    const criterion = asRecord(raw);
    if (!criterion) return;
    const name = scalarString(criterion.name);
    if (name === undefined || !wanted.has(nameKey(name))) return;

    const searchType = scalarString(criterion.search_type);
    const groupName = scalarString(criterion.value);
    if (groupName === undefined) {
      unreadableValues += 1;
      return;
    }
    found.push({
      groupName,
      ...(searchType !== undefined ? { searchType } : {}),
      negated: isNegatedMembershipSearchType(searchType),
      index,
    });
  });

  return { found, readable: true, unreadableValues };
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 1 — generalized reference finding
// ─────────────────────────────────────────────────────────────────────────────

/** The kinds of object this can answer "what references it" for. */
export type ReferenceTargetKind = 'package' | 'computerGroup' | 'script';

/**
 * The object being asked about.
 *
 * Both `id` and `name` are optional individually and required together — at least
 * one must be usable, because Jamf writes references either way and a target with
 * neither can be matched against nothing. `normalizeTarget` throws in that case
 * rather than returning an empty reference list.
 */
export interface ReferenceTarget {
  kind: ReferenceTargetKind;
  id?: number | string | null;
  name?: string | null;
}

/** The kinds of object that can do the referencing. */
export type SourceKind =
  | 'policy'
  | 'patchPolicy'
  | 'computerPrestage'
  | 'blueprint'
  | 'configurationProfile'
  | 'computerGroup'
  | 'eBook'
  | 'restrictedSoftware'
  | 'advancedComputerSearch'
  | 'appInstaller';

/**
 * Which source kinds can reference which target kind.
 *
 * Taken from Prune's usage matrix, which is the only version of this that has been
 * validated against real tenants at scale. Exported because a matrix hidden inside
 * a switch statement cannot be reviewed against Prune's, and because it is the
 * definition of complete coverage: a source kind listed here and not supplied is a
 * hole in the answer, and that is exactly what `notChecked` reports.
 */
export const REFERENCE_MATRIX: Readonly<Record<ReferenceTargetKind, readonly SourceKind[]>> = {
  package: ['policy', 'patchPolicy', 'computerPrestage'],
  computerGroup: [
    'blueprint',
    'policy',
    'configurationProfile',
    'computerGroup',
    'eBook',
    'restrictedSoftware',
    'advancedComputerSearch',
    'appInstaller',
  ],
  script: ['policy'],
};

/**
 * What a reference *means*, which is not the same as that it exists.
 *
 * A scope inclusion and a scope exclusion are opposite statements about the same
 * pair of objects, and a report that flattened both to "referenced" would tell an
 * admin that deleting a group narrows a policy's reach when it actually widens it.
 * Membership criteria get their own two members for the same reason: "not member
 * of" is a real dependency with inverted sense, and calling it an inclusion would
 * be the most damaging single error this module could make.
 */
export type ReferenceSense =
  | 'scope-inclusion'
  | 'scope-exclusion'
  /** A script or package slot: the source runs or installs the target. */
  | 'attachment'
  | 'criterion-member-of'
  | 'criterion-not-member-of';

/** One place one source object refers to the target. */
export interface ReferenceHit {
  sourceKind: SourceKind;
  sourceId?: string;
  /** `(unnamed)` when the shape carries no readable name. */
  sourceName: string;
  /** From `general.enabled` / `enabled`, where the shape has one. */
  sourceEnabled?: boolean;
  sense: ReferenceSense;
  /** Dotted path into the source JSON, e.g. `scope.exclusions.computer_groups[1]`. */
  path: string;
  /** The path in words, for a reader who does not know Classic's schema. */
  label: string;
  /**
   * Jamf is inconsistent about whether a reference carries an id or a name, so both
   * are matched and the winner is reported. An id match is the stronger evidence;
   * a name match is only as stable as the name.
   */
  matchedOn: 'id' | 'name';
  /** The literal value that matched, so the finding can be verified by eye. */
  matchedValue: string;
  /** Criterion search type, script priority — whatever the slot carries. */
  detail?: string;
}

/** A source kind that WAS read, and how thoroughly. */
export interface CheckedSource {
  sourceKind: SourceKind;
  objectsRead: number;
  /**
   * Objects in which no container this module knows how to read was present at all.
   *
   * The difference between "looked and found nothing" and "did not manage to look".
   * Non-zero here means the shape drifted or was never confirmed, and it downgrades
   * the report's `strength` — a shape mismatch must not read as an absence of
   * references, which is the bug class this repo has already shipped once.
   */
  objectsWithNoReadableContainer: number;
  /**
   * Objects that cannot hold this kind of reference at all, so their lack of one is
   * not a blind spot — a static computer group has no criteria to search.
   */
  objectsNotApplicable: number;
  /** Why those objects were not applicable, de-duplicated. */
  notApplicableReasons: string[];
  /** Container paths actually found and read, e.g. `scope.computer_groups`. */
  containersRead: string[];
}

/** A source kind in the matrix that was NOT read, and what that costs. */
export interface UncheckedSource {
  sourceKind: SourceKind;
  /** Why: not supplied, or the caller's own fetch failure passed through. */
  reason: string;
  /**
   * The dependency that stays invisible because of it.
   *
   * A bare list of skipped names invites a caller to render "checked everything
   * except appInstallers", which reads as a technicality. Saying what breaks makes
   * the gap the same size on the page as it is in reality.
   */
  consequence: string;
}

/**
 * The strongest claim the report supports.
 *
 * A caller keying an all-clear message off `'clear'` cannot produce a false
 * all-clear, because `'clear'` is only reachable when every source kind in the
 * matrix was read and every object in them yielded a readable container.
 * `'unchecked'` — nothing was read at all — is deliberately not a shade of
 * "no references found"; it is the absence of an answer.
 */
export type ReferenceStrength = 'referenced' | 'clear' | 'partial-clear' | 'unchecked';

export interface ReferenceReport {
  target: { kind: ReferenceTargetKind; id?: string; name?: string };
  checked: CheckedSource[];
  notChecked: UncheckedSource[];
  /**
   * Source kinds read that held zero objects.
   *
   * Legitimate on a small tenant, and also exactly the shape a fetch that failed
   * silently takes — so it is named rather than folded into full coverage.
   */
  checkedButEmpty: SourceKind[];
  references: ReferenceHit[];
  totals: {
    references: number;
    bySense: Record<string, number>;
    bySourceKind: Record<string, number>;
  };
  strength: ReferenceStrength;
  verdict: string;
}

/** A collection the caller fetched, or an explicit statement that it could not. */
export type SourceCollection = readonly unknown[] | SourceUnavailable | null | undefined;

/**
 * Why a source kind could not be supplied.
 *
 * Passing this instead of omitting the key, or worse passing `[]`, is what keeps a
 * failed fetch from masquerading as an empty tenant. The reason travels into
 * `notChecked` verbatim so the report says "403 on restrictedsoftware" rather than
 * the uninformative "not supplied".
 */
export interface SourceUnavailable {
  unavailable: true;
  reason: string;
}

/**
 * Everything the caller managed to fetch. Omit what you did not fetch; pass
 * `{ unavailable: true, reason }` for what you tried and failed to fetch.
 */
export interface ReferenceSources {
  policies?: SourceCollection;
  patchPolicies?: SourceCollection;
  computerPrestages?: SourceCollection;
  blueprints?: SourceCollection;
  configurationProfiles?: SourceCollection;
  computerGroups?: SourceCollection;
  eBooks?: SourceCollection;
  restrictedSoftware?: SourceCollection;
  advancedComputerSearches?: SourceCollection;
  appInstallers?: SourceCollection;
}

const SOURCE_INPUT_KEY: Readonly<Record<SourceKind, keyof ReferenceSources>> = {
  policy: 'policies',
  patchPolicy: 'patchPolicies',
  computerPrestage: 'computerPrestages',
  blueprint: 'blueprints',
  configurationProfile: 'configurationProfiles',
  computerGroup: 'computerGroups',
  eBook: 'eBooks',
  restrictedSoftware: 'restrictedSoftware',
  advancedComputerSearch: 'advancedComputerSearches',
  appInstaller: 'appInstallers',
};

/** What goes unseen when a source kind is not read. One line per kind. */
const UNCHECKED_CONSEQUENCE: Readonly<Record<SourceKind, string>> = {
  policy:
    'a policy that scopes to, installs or runs this object. The most common kind of ' +
    'reference and the most consequential to miss.',
  patchPolicy:
    'a patch policy distributing this package. Patch policies are managed separately ' +
    'from ordinary policies, so a package can look unused while patching depends on it.',
  computerPrestage:
    'a prestage installing this package during enrolment. Nothing in the policy list ' +
    'reveals it, and breaking it breaks new-machine setup rather than anything visible today.',
  blueprint:
    'a Blueprint scoped to this group. Blueprints deploy declaratively, so the failure ' +
    'shows up as declarations no longer applying rather than as an error against the group.',
  configurationProfile:
    'a configuration profile scoped to this group — settings would silently stop applying, ' +
    'or start applying to machines an exclusion was keeping them off.',
  computerGroup:
    'another smart group whose criteria reference this group. This is the reference Jamf\'s ' +
    'own UI cannot show, and the one that cascades.',
  eBook: 'an eBook scoped to this group.',
  restrictedSoftware:
    'a restricted-software record scoped to this group — deleting the group would stop the ' +
    'restriction applying without anything reporting that it had.',
  advancedComputerSearch:
    'a saved advanced search filtering on this group. Someone\'s recurring report would ' +
    'quietly start returning different rows.',
  appInstaller: 'an App Installer deployment targeting this group.',
};

/** A candidate reference slot found in a source object, before matching. */
interface Slot {
  sense: ReferenceSense;
  path: string;
  label: string;
  ref: { id?: string; name?: string };
  detail?: string;
}

interface Extraction {
  slots: Slot[];
  /** Container paths present and readable, even when empty. */
  containers: string[];
  /** Set when the object cannot hold this reference kind at all. */
  notApplicable?: string;
}

/**
 * Reads an id and a name out of a list member.
 *
 * A bare string member is offered as BOTH a candidate id and a candidate name,
 * because the shapes that use one are not all confirmed — `customPackageIds` holds
 * ids, a scope array might hold names. Offering both cannot manufacture a false
 * positive: matching is exact on each, so a UUID cannot collide with a group name.
 * `display_name` is a name fallback for patch-policy packages, which carry it
 * instead of `name`.
 */
function entryRef(entry: unknown): { id?: string; name?: string } {
  if (typeof entry === 'string' || typeof entry === 'number') {
    const value = scalarString(entry);
    return value === undefined ? {} : { id: value, name: value };
  }
  const record = asRecord(entry);
  if (!record) return {};
  const id = scalarString(record.id);
  const name = scalarString(record.name) ?? scalarString(record.display_name);
  return { ...(id !== undefined ? { id } : {}), ...(name !== undefined ? { name } : {}) };
}

/** Identity of a source object, checking both Classic conventions. */
function objectIdentity(detail: unknown): { id?: string; name?: string; enabled?: boolean } {
  const record = asRecord(detail);
  const general = asRecord(record?.general);
  const id = scalarString(record?.id) ?? scalarString(general?.id);
  const name =
    scalarString(record?.name) ??
    scalarString(general?.name) ??
    scalarString(record?.displayName) ??
    scalarString(general?.display_name);
  const enabled = readBoolean(record?.enabled) ?? readBoolean(general?.enabled);
  return {
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };
}

function emptyExtraction(): Extraction {
  return { slots: [], containers: [] };
}

/**
 * Collects every member of an array container into slots.
 *
 * Returns whether the container was readable, which is tracked separately from how
 * many slots it produced — an empty array is an answer, a missing key is not.
 */
function collectList(
  detail: unknown,
  path: readonly string[],
  sense: ReferenceSense,
  label: string,
  out: Extraction,
  detailOf?: (entry: Record<string, unknown>) => string | undefined,
): boolean {
  const container = at(detail, path);
  if (!Array.isArray(container)) return false;
  const basePath = path.join('.');
  out.containers.push(basePath);
  container.forEach((entry, index) => {
    const ref = entryRef(entry);
    if (ref.id === undefined && ref.name === undefined) return;
    const record = asRecord(entry);
    const extra = record && detailOf ? detailOf(record) : undefined;
    out.slots.push({
      sense,
      path: `${basePath}[${index}]`,
      label,
      ref,
      ...(extra !== undefined ? { detail: extra } : {}),
    });
  });
  return true;
}

/** Same, for a container holding a single reference rather than a list. */
function collectScalar(
  detail: unknown,
  path: readonly string[],
  sense: ReferenceSense,
  label: string,
  out: Extraction,
): boolean {
  const value = at(detail, path);
  if (value === undefined || value === null) return false;
  const joined = path.join('.');
  out.containers.push(joined);
  const ref = entryRef(value);
  if (ref.id === undefined && ref.name === undefined) return true;
  out.slots.push({ sense, path: joined, label, ref });
  return true;
}

/** Classic scope: an inclusion list and an exclusion list of the same member kind. */
function collectClassicScope(detail: unknown, member: string, out: Extraction): boolean {
  const included = collectList(
    detail,
    ['scope', member],
    'scope-inclusion',
    `scope inclusion (${member})`,
    out,
  );
  const excluded = collectList(
    detail,
    ['scope', 'exclusions', member],
    'scope-exclusion',
    `scope EXCLUSION (${member})`,
    out,
  );
  return included || excluded;
}

/** Membership criteria, as reference slots. */
function collectMembershipCriteria(detail: unknown, out: Extraction): boolean {
  const criteria = asRecord(detail)?.criteria;
  const read = readGroupMembershipCriteria(criteria);
  if (!read.readable) return false;
  out.containers.push('criteria');
  for (const criterion of read.found) {
    out.slots.push({
      sense: criterion.negated ? 'criterion-not-member-of' : 'criterion-member-of',
      path: `criteria[${criterion.index}]`,
      label: `membership criterion (${criterion.searchType ?? 'search type absent'})`,
      // Criteria reference a group by NAME only — Jamf stores the name in `value`
      // and never an id, so offering an id candidate here would invent a semantic.
      ref: { name: criterion.groupName },
      detail: `criterion "Computer Group" ${criterion.searchType ?? '(search type absent)'} "${criterion.groupName}"`,
    });
  }
  if (read.unreadableValues > 0) {
    // A membership criterion whose value cannot be read is a dependency that
    // exists and cannot be resolved, so the object counts as not fully read.
    out.containers.push(`criteria (${read.unreadableValues} membership criteria with unreadable values)`);
  }
  return true;
}

/**
 * Candidate paths for the newer, unconfirmed shapes.
 *
 * These resources are not Classic and their group/package containers have not been
 * seen on this gateway. Enumerating candidates rather than guessing one means a
 * shape that matches none of them produces `objectsWithNoReadableContainer`, which
 * downgrades the verdict — the alternative is a confident zero.
 */
const BLUEPRINT_GROUP_PATHS: ReadonlyArray<{ path: readonly string[]; sense: ReferenceSense }> = [
  { path: ['scope', 'computer_groups'], sense: 'scope-inclusion' },
  { path: ['scope', 'deviceGroups'], sense: 'scope-inclusion' },
  { path: ['scope', 'deviceGroupIds'], sense: 'scope-inclusion' },
  { path: ['deviceGroups'], sense: 'scope-inclusion' },
  { path: ['deviceGroupIds'], sense: 'scope-inclusion' },
  { path: ['groups'], sense: 'scope-inclusion' },
  { path: ['scope', 'exclusions', 'computer_groups'], sense: 'scope-exclusion' },
  { path: ['scope', 'excludedDeviceGroups'], sense: 'scope-exclusion' },
  { path: ['excludedDeviceGroups'], sense: 'scope-exclusion' },
];

const APP_INSTALLER_GROUP_LIST_PATHS: ReadonlyArray<{ path: readonly string[]; sense: ReferenceSense }> = [
  { path: ['scope', 'computer_groups'], sense: 'scope-inclusion' },
  { path: ['deployment', 'smartGroupIds'], sense: 'scope-inclusion' },
  { path: ['scope', 'exclusions', 'computer_groups'], sense: 'scope-exclusion' },
  { path: ['deployment', 'excludedSmartGroupIds'], sense: 'scope-exclusion' },
];

const APP_INSTALLER_GROUP_SCALAR_PATHS: ReadonlyArray<{ path: readonly string[]; sense: ReferenceSense }> = [
  { path: ['deployment', 'smartGroupId'], sense: 'scope-inclusion' },
  { path: ['smartGroupId'], sense: 'scope-inclusion' },
];

const PRESTAGE_PACKAGE_PATHS: readonly (readonly string[])[] = [
  ['customPackageIds'],
  ['customPackages'],
  ['packages'],
];

const PATCH_POLICY_PACKAGE_PATHS: readonly (readonly string[])[] = [
  ['package_configuration', 'packages'],
  ['packages'],
];

/**
 * Picks the extractor for a (target, source) pair.
 *
 * Returns undefined for a pair the matrix does not contain, so an unsupported
 * combination is a programming error caught at the call site rather than a silent
 * zero.
 */
function extract(target: ReferenceTargetKind, source: SourceKind, detail: unknown): Extraction {
  const out = emptyExtraction();

  if (target === 'computerGroup') {
    switch (source) {
      case 'policy':
      case 'configurationProfile':
      case 'restrictedSoftware':
      case 'eBook':
        collectClassicScope(detail, 'computer_groups', out);
        return out;
      case 'computerGroup': {
        // A static group holds explicit computers and has no criteria, so its lack
        // of a group reference is a fact rather than a gap.
        if (readBoolean(asRecord(detail)?.is_smart) === false) {
          return { ...out, notApplicable: 'static computer group: no criteria to search' };
        }
        collectMembershipCriteria(detail, out);
        return out;
      }
      case 'advancedComputerSearch':
        collectMembershipCriteria(detail, out);
        return out;
      case 'blueprint':
        for (const candidate of BLUEPRINT_GROUP_PATHS) {
          collectList(detail, candidate.path, candidate.sense, `blueprint ${candidate.path.join('.')}`, out);
        }
        return out;
      case 'appInstaller':
        for (const candidate of APP_INSTALLER_GROUP_LIST_PATHS) {
          collectList(detail, candidate.path, candidate.sense, `app installer ${candidate.path.join('.')}`, out);
        }
        for (const candidate of APP_INSTALLER_GROUP_SCALAR_PATHS) {
          collectScalar(detail, candidate.path, candidate.sense, `app installer ${candidate.path.join('.')}`, out);
        }
        return out;
      default:
        return out;
    }
  }

  if (target === 'package') {
    switch (source) {
      case 'policy':
        collectList(
          detail,
          ['package_configuration', 'packages'],
          'attachment',
          'package slot',
          out,
        );
        return out;
      case 'patchPolicy':
        for (const path of PATCH_POLICY_PACKAGE_PATHS) {
          collectList(detail, path, 'attachment', `patch policy ${path.join('.')}`, out);
        }
        return out;
      case 'computerPrestage':
        for (const path of PRESTAGE_PACKAGE_PATHS) {
          collectList(detail, path, 'attachment', `prestage ${path.join('.')}`, out);
        }
        return out;
      default:
        return out;
    }
  }

  // target === 'script'
  if (source === 'policy') {
    collectList(detail, ['scripts'], 'attachment', 'script slot', out, (entry) => {
      const priority = scalarString(entry.priority);
      return priority === undefined ? undefined : `priority ${priority}`;
    });
  }
  return out;
}

interface NormalizedTarget {
  kind: ReferenceTargetKind;
  id?: string;
  name?: string;
  nameKey?: string;
}

/**
 * Exact id match, or exact-but-case-insensitive name match.
 *
 * Name matching is deliberately NOT a substring test. A policy scoped to
 * "All Laptops — Contractors" would match a target group named "All Laptops" under
 * a substring rule, and a delete-safety tool that reports references which are not
 * there is worse than useless: every finding then needs manual confirmation, which
 * is the work the tool was supposed to remove.
 */
function matchTarget(
  target: NormalizedTarget,
  ref: { id?: string; name?: string },
): { matchedOn: 'id' | 'name'; matchedValue: string } | undefined {
  if (target.id !== undefined && ref.id !== undefined && ref.id === target.id) {
    return { matchedOn: 'id', matchedValue: ref.id };
  }
  if (target.nameKey !== undefined && ref.name !== undefined && nameKey(ref.name) === target.nameKey) {
    return { matchedOn: 'name', matchedValue: ref.name };
  }
  return undefined;
}

function normalizeTarget(target: ReferenceTarget): NormalizedTarget {
  if (asRecord(target) === undefined) {
    throw new Error('findObjectReferences: target must be an object with a kind and an id or name.');
  }
  const kinds = Object.keys(REFERENCE_MATRIX) as ReferenceTargetKind[];
  if (!kinds.includes(target.kind)) {
    throw new Error(
      `findObjectReferences: unknown target kind ${JSON.stringify(target.kind)}. ` +
        `Known kinds: ${kinds.join(', ')}.`,
    );
  }
  const id = scalarString(target.id);
  const name = scalarString(target.name);
  if (id === undefined && name === undefined) {
    // Nothing to compare against, so every comparison would be false and the
    // result would be an empty reference list that means nothing. An audit that
    // cannot read its input must say so rather than return a clean report.
    throw new Error(
      `findObjectReferences: target ${target.kind} has neither a usable id nor a name, so ` +
        'nothing can be matched against it. Refusing to return an empty reference list, ' +
        'which would read as "no references found".',
    );
  }
  return {
    kind: target.kind,
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name, nameKey: nameKey(name) } : {}),
  };
}

function isUnavailable(value: SourceCollection): value is SourceUnavailable {
  const record = asRecord(value);
  return record !== undefined && record.unavailable === true;
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

/**
 * Answers "what references this object" over already-fetched detail records.
 *
 * The interesting half of the return value is the negative space. `checked` says
 * what was read and how thoroughly, `notChecked` says which source kinds from
 * `REFERENCE_MATRIX` were missing and what each omission hides, and `strength`
 * collapses both into the strongest claim the data supports. `'clear'` requires
 * full matrix coverage AND a readable container in every object read — anything
 * less is `'partial-clear'`, and reading nothing at all is `'unchecked'` rather
 * than a quiet zero.
 *
 * Throws only when the target cannot be matched against anything (no id, no name)
 * or `sources` is not an object. Every other unreadable shape is reported as a
 * count, because a single malformed policy must not lose the findings from the
 * other four hundred.
 */
export function findObjectReferences(
  target: ReferenceTarget,
  sources: ReferenceSources,
): ReferenceReport {
  const normalized = normalizeTarget(target);
  if (asRecord(sources) === undefined) {
    throw new Error(
      'findObjectReferences: sources must be an object of already-fetched collections. ' +
        'Refusing to treat an unreadable input as "nothing references this object".',
    );
  }

  const checked: CheckedSource[] = [];
  const notChecked: UncheckedSource[] = [];
  const checkedButEmpty: SourceKind[] = [];
  const references: ReferenceHit[] = [];

  for (const sourceKind of REFERENCE_MATRIX[normalized.kind]) {
    const supplied = sources[SOURCE_INPUT_KEY[sourceKind]];

    if (isUnavailable(supplied)) {
      notChecked.push({
        sourceKind,
        reason: scalarString(supplied.reason) ?? 'caller reported it unavailable, without a reason',
        consequence: UNCHECKED_CONSEQUENCE[sourceKind],
      });
      continue;
    }
    if (!Array.isArray(supplied)) {
      notChecked.push({
        sourceKind,
        reason:
          supplied === undefined || supplied === null
            ? `not supplied (sources.${SOURCE_INPUT_KEY[sourceKind]} absent)`
            : `sources.${SOURCE_INPUT_KEY[sourceKind]} was not an array, so it could not be read`,
        consequence: UNCHECKED_CONSEQUENCE[sourceKind],
      });
      continue;
    }

    const containers = new Set<string>();
    const notApplicableReasons = new Set<string>();
    let objectsWithNoReadableContainer = 0;
    let objectsNotApplicable = 0;

    for (const detail of supplied) {
      const extraction = extract(normalized.kind, sourceKind, detail);
      if (extraction.notApplicable !== undefined) {
        objectsNotApplicable += 1;
        notApplicableReasons.add(extraction.notApplicable);
        continue;
      }
      for (const container of extraction.containers) containers.add(container);
      if (extraction.containers.length === 0) {
        objectsWithNoReadableContainer += 1;
        continue;
      }

      const identity = objectIdentity(detail);
      for (const slot of extraction.slots) {
        const match = matchTarget(normalized, slot.ref);
        if (match === undefined) continue;
        references.push({
          sourceKind,
          ...(identity.id !== undefined ? { sourceId: identity.id } : {}),
          sourceName: identity.name ?? '(unnamed)',
          ...(identity.enabled !== undefined ? { sourceEnabled: identity.enabled } : {}),
          sense: slot.sense,
          path: slot.path,
          label: slot.label,
          matchedOn: match.matchedOn,
          matchedValue: match.matchedValue,
          ...(slot.detail !== undefined ? { detail: slot.detail } : {}),
        });
      }
    }

    checked.push({
      sourceKind,
      objectsRead: supplied.length,
      objectsWithNoReadableContainer,
      objectsNotApplicable,
      notApplicableReasons: [...notApplicableReasons],
      containersRead: [...containers].sort(),
    });
    if (supplied.length === 0) checkedButEmpty.push(sourceKind);
  }

  // Stable order: by source kind, then by name, then by where in the object.
  references.sort(
    (a, b) =>
      a.sourceKind.localeCompare(b.sourceKind) ||
      a.sourceName.localeCompare(b.sourceName) ||
      a.path.localeCompare(b.path),
  );

  const unreadable = checked.filter((c) => c.objectsWithNoReadableContainer > 0);
  const strength: ReferenceStrength =
    references.length > 0
      ? 'referenced'
      : checked.length === 0
        ? 'unchecked'
        : notChecked.length === 0 && unreadable.length === 0
          ? 'clear'
          : 'partial-clear';

  return {
    target: {
      kind: normalized.kind,
      ...(normalized.id !== undefined ? { id: normalized.id } : {}),
      ...(normalized.name !== undefined ? { name: normalized.name } : {}),
    },
    checked,
    notChecked,
    checkedButEmpty,
    references,
    totals: {
      references: references.length,
      bySense: tally(references.map((r) => r.sense)),
      bySourceKind: tally(references.map((r) => r.sourceKind)),
    },
    strength,
    verdict: verdictFor(normalized, strength, references, checked, notChecked, checkedButEmpty, unreadable),
  };
}

/** Puts the verdict in words, sized to the coverage actually achieved. */
function verdictFor(
  target: NormalizedTarget,
  strength: ReferenceStrength,
  references: ReferenceHit[],
  checked: CheckedSource[],
  notChecked: UncheckedSource[],
  checkedButEmpty: SourceKind[],
  unreadable: CheckedSource[],
): string {
  const label = `${target.kind} ${target.name ?? target.id ?? ''}`.trim();
  const exclusions = references.filter(
    (r) => r.sense === 'scope-exclusion' || r.sense === 'criterion-not-member-of',
  ).length;

  if (strength === 'referenced') {
    const parts = [
      `${references.length} reference(s) to ${label} across ` +
        `${new Set(references.map((r) => r.sourceKind)).size} source kind(s).`,
    ];
    if (exclusions > 0) {
      parts.push(
        `${exclusions} of them EXCLUDE it rather than include it — removing the object widens ` +
          'what those objects reach instead of narrowing it, so do not read them as ordinary usage.',
      );
    }
    if (notChecked.length > 0) {
      parts.push(`${notChecked.length} source kind(s) were not checked, so there may be more.`);
    }
    return parts.join(' ');
  }

  if (strength === 'unchecked') {
    return (
      `Nothing was checked for ${label}: no source collection was supplied. This is NOT evidence ` +
      'that the object is unreferenced — it is the absence of an answer.'
    );
  }

  const parts = [`No reference to ${label} was found in what was checked.`];
  if (notChecked.length > 0) {
    parts.push(
      `${notChecked.length} of ${checked.length + notChecked.length} source kind(s) in the ` +
        `usage matrix were not checked (${notChecked.map((n) => n.sourceKind).join(', ')}) — ` +
        'see notChecked for what each omission hides.',
    );
  }
  if (unreadable.length > 0) {
    parts.push(
      `${unreadable.reduce((sum, c) => sum + c.objectsWithNoReadableContainer, 0)} object(s) had no ` +
        'container this tool knows how to read, so they were not actually examined ' +
        '(see checked[].objectsWithNoReadableContainer).',
    );
  }
  if (checkedButEmpty.length > 0) {
    parts.push(
      `${checkedButEmpty.join(', ')} held zero objects — confirm the tenant really has none ` +
        'rather than a fetch having returned empty.',
    );
  }
  parts.push(
    strength === 'clear'
      ? 'Every source kind in the matrix was read and every object yielded a readable container, ' +
        'so this is the strongest negative result this tool can give. It still does not cover ' +
        'anything outside Jamf.'
      : 'Do not treat this as proof the object is unused.',
  );
  return parts.join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 2 — the smart-group dependency graph
//
// A Jamf Nation audit turned up "over 20 smart groups that include other smart
// groups that are dependent on the first". The Jamf UI cannot show that, and the
// only readable link is a criterion named "Computer Group" whose value is the other
// group's NAME. So the graph is name-keyed, which is why duplicate names and names
// matching no group are findings in their own right rather than parse noise.
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupNode {
  /** Display name, as the group spells it. */
  name: string;
  id?: string;
  /** Undefined when the shape did not say. */
  isSmart?: boolean;
}

export interface GroupEdge {
  /** The group whose criteria hold the reference — it depends on `to`. */
  fromName: string;
  fromId?: string;
  /** The group named in the criterion value. */
  toName: string;
  toId?: string;
  searchType?: string;
  /** True for "not member of": a real dependency with inverted sense. */
  negated: boolean;
  /** Position in the source group's `criteria` array. */
  criterionIndex: number;
}

/**
 * A criterion pointing at a group name that no group in the input has.
 *
 * Reported separately because it is a finding, not a failure to parse: Jamf lets a
 * group be renamed or deleted while criteria still name the old string, and the
 * dependent group then silently evaluates against nothing. Folding these into the
 * edge list would hide them; dropping them would hide them worse.
 */
export interface DanglingGroupEdge {
  fromName: string;
  fromId?: string;
  /** The unmatched name, verbatim. */
  toName: string;
  searchType?: string;
  negated: boolean;
  criterionIndex: number;
}

/** A group whose criteria could not be read at all. */
export interface UnreadableGroup {
  name: string;
  id?: string;
  why: string;
}

export interface GroupDependencyGraph {
  nodes: GroupNode[];
  edges: GroupEdge[];
  dangling: DanglingGroupEdge[];
  /**
   * Groups nothing was learned from.
   *
   * Distinct from a group with no group-membership criteria. An unreadable group
   * could be the hub of the whole dependency web, so its absence from the edge list
   * must not read as independence.
   */
  unreadable: UnreadableGroup[];
  /**
   * Names shared by more than one group, case-insensitively.
   *
   * Criteria reference groups by name, so a duplicate makes every edge into that
   * name ambiguous. Jamf normally prevents this; it is checked because the graph
   * would otherwise quietly attribute a dependency to the wrong group.
   */
  duplicateNames: Array<{ name: string; ids: string[] }>;
}

/**
 * Builds the group-to-group dependency graph.
 *
 * Throws when `groups` is not an array — that is input this cannot read, and
 * returning an empty graph would report a fleet with no group dependencies at all.
 * An individual entry that cannot be read lands in `unreadable` instead, so one bad
 * record does not cost the other four hundred.
 */
export function buildGroupDependencyGraph(groups: readonly unknown[]): GroupDependencyGraph {
  if (!Array.isArray(groups)) {
    throw new Error(
      'buildGroupDependencyGraph: expected an array of computer group detail records. ' +
        'Refusing to return an empty graph, which would read as "no group depends on another".',
    );
  }

  const nodes: GroupNode[] = [];
  const unreadable: UnreadableGroup[] = [];
  const byName = new Map<string, GroupNode>();
  const idsByName = new Map<string, string[]>();
  /** Parsed criteria kept aside so names resolve after every node is known. */
  const pending: Array<{ node: GroupNode; criteria: GroupMembershipCriterion[] }> = [];

  groups.forEach((raw, index) => {
    const record = asRecord(raw);
    const identity = objectIdentity(raw);
    if (!record || identity.name === undefined) {
      unreadable.push({
        name: identity.name ?? `(unnamed, input index ${index})`,
        ...(identity.id !== undefined ? { id: identity.id } : {}),
        why:
          record === undefined
            ? 'entry is not an object'
            : 'entry has no readable name, and criteria reference groups by name',
      });
      return;
    }

    const isSmart = readBoolean(record.is_smart);
    const node: GroupNode = {
      name: identity.name,
      ...(identity.id !== undefined ? { id: identity.id } : {}),
      ...(isSmart !== undefined ? { isSmart } : {}),
    };
    nodes.push(node);

    const key = nameKey(identity.name);
    if (!byName.has(key)) byName.set(key, node);
    idsByName.set(key, [...(idsByName.get(key) ?? []), identity.id ?? '(no id)']);

    const read = readGroupMembershipCriteria(record.criteria);
    if (!read.readable) {
      // A static group legitimately has no criteria; anything else is a blind spot.
      if (isSmart === false) return;
      unreadable.push({
        name: identity.name,
        ...(identity.id !== undefined ? { id: identity.id } : {}),
        why: 'no readable `criteria` array, so its dependencies were never examined',
      });
      return;
    }
    if (read.unreadableValues > 0) {
      unreadable.push({
        name: identity.name,
        ...(identity.id !== undefined ? { id: identity.id } : {}),
        why: `${read.unreadableValues} group-membership criteria whose value could not be read as a group name`,
      });
    }
    pending.push({ node, criteria: read.found });
  });

  const edges: GroupEdge[] = [];
  const dangling: DanglingGroupEdge[] = [];

  for (const { node, criteria } of pending) {
    for (const criterion of criteria) {
      const targetNode = byName.get(nameKey(criterion.groupName));
      const common = {
        fromName: node.name,
        ...(node.id !== undefined ? { fromId: node.id } : {}),
        ...(criterion.searchType !== undefined ? { searchType: criterion.searchType } : {}),
        negated: criterion.negated,
        criterionIndex: criterion.index,
      };
      if (!targetNode) {
        dangling.push({ ...common, toName: criterion.groupName });
        continue;
      }
      edges.push({
        ...common,
        toName: targetNode.name,
        ...(targetNode.id !== undefined ? { toId: targetNode.id } : {}),
      });
    }
  }

  const duplicateNames = [...idsByName.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ name: byName.get(key)?.name ?? key, ids }));

  return { nodes, edges, dangling, unreadable, duplicateNames };
}

/** Forward and reverse adjacency, keyed by normalised name. */
function adjacency(graph: GroupDependencyGraph): {
  forward: Map<string, GroupEdge[]>;
  reverse: Map<string, GroupEdge[]>;
} {
  const forward = new Map<string, GroupEdge[]>();
  const reverse = new Map<string, GroupEdge[]>();
  for (const edge of graph.edges) {
    const from = nameKey(edge.fromName);
    const to = nameKey(edge.toName);
    forward.set(from, [...(forward.get(from) ?? []), edge]);
    reverse.set(to, [...(reverse.get(to) ?? []), edge]);
  }
  return { forward, reverse };
}

export interface GroupCycle {
  /**
   * Node names in traversal order with the first repeated at the end, so the loop
   * closes on the page: `["A", "B", "A"]`. A boolean would tell an admin a cycle
   * exists without telling them which groups to break, which is the only actionable
   * part.
   */
  path: string[];
  /** A group whose own criteria reference itself. */
  selfReference: boolean;
}

export interface GroupCycleReport {
  cycles: GroupCycle[];
  /**
   * Whether a cycle exists at all.
   *
   * Decided by a linear colour-marking pass that is never truncated, so this stays
   * correct even when enumeration gives up. `hasCycle: true` with `cycles: []` is a
   * meaningful state: there is a loop and it was not enumerated.
   */
  hasCycle: boolean;
  /** True when enumeration hit a limit, so `cycles` may be incomplete. */
  truncated: boolean;
  note: string;
}

/**
 * Enumerates every elementary cycle in the dependency graph.
 *
 * Jamf permits group criteria that never converge, and the UI shows nothing. Each
 * cycle is found exactly once, from its lowest-indexed member, by restricting the
 * search to nodes at or after the starting index — the standard trick for not
 * reporting `A→B→A` and `B→A→B` as two findings.
 *
 * Cycle enumeration is exponential in the worst case, so both the number of cycles
 * and the number of search steps are capped. Hitting either sets `truncated`; it
 * never silently shortens the list. `hasCycle` is computed separately and is always
 * complete.
 */
export function findGroupDependencyCycles(
  graph: GroupDependencyGraph,
  options: { maxCycles?: number; maxSteps?: number } = {},
): GroupCycleReport {
  const maxCycles = options.maxCycles ?? 200;
  const maxSteps = options.maxSteps ?? 200_000;
  const { forward } = adjacency(graph);

  const order = graph.nodes.map((n) => nameKey(n.name));
  const display = new Map<string, string>();
  for (const node of graph.nodes) if (!display.has(nameKey(node.name))) display.set(nameKey(node.name), node.name);
  const indexOf = new Map<string, number>();
  order.forEach((key, index) => {
    if (!indexOf.has(key)) indexOf.set(key, index);
  });

  const successors = (key: string): string[] => (forward.get(key) ?? []).map((e) => nameKey(e.toName));

  // ── does a cycle exist at all: white/grey/black DFS, never truncated ──
  const state = new Map<string, 0 | 1 | 2>();
  let hasCycle = false;
  const visit = (start: string) => {
    const stack: Array<{ key: string; next: number }> = [{ key: start, next: 0 }];
    state.set(start, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const kids = successors(frame.key);
      if (frame.next >= kids.length) {
        state.set(frame.key, 2);
        stack.pop();
        continue;
      }
      const child = kids[frame.next] as string;
      frame.next += 1;
      const seen = state.get(child) ?? 0;
      if (seen === 1) {
        hasCycle = true;
      } else if (seen === 0) {
        state.set(child, 1);
        stack.push({ key: child, next: 0 });
      }
    }
  };
  for (const key of new Set(order)) if ((state.get(key) ?? 0) === 0) visit(key);

  // ── enumerate ──
  const cycles: GroupCycle[] = [];
  let steps = 0;
  let truncated = false;

  const walk = (startIndex: number, start: string, current: string, path: string[], onPath: Set<string>) => {
    if (truncated) return;
    for (const next of successors(current)) {
      steps += 1;
      if (steps > maxSteps) {
        truncated = true;
        return;
      }
      if (next === start) {
        if (cycles.length >= maxCycles) {
          truncated = true;
          return;
        }
        const names = [...path, start].map((k) => display.get(k) ?? k);
        cycles.push({ path: names, selfReference: path.length === 1 });
        continue;
      }
      const nextIndex = indexOf.get(next);
      if (nextIndex === undefined || nextIndex < startIndex || onPath.has(next)) continue;
      onPath.add(next);
      walk(startIndex, start, next, [...path, next], onPath);
      onPath.delete(next);
      if (truncated) return;
    }
  };

  const started = new Set<string>();
  order.forEach((key, index) => {
    if (truncated || started.has(key)) return;
    started.add(key);
    walk(index, key, key, [key], new Set([key]));
  });

  return {
    cycles,
    hasCycle,
    truncated,
    note: truncated
      ? 'Cycle enumeration stopped at a limit, so `cycles` is incomplete. `hasCycle` is still ' +
        'authoritative — it comes from a separate pass that is never truncated.'
      : hasCycle
        ? 'Every cycle below is a set of smart groups whose criteria depend on each other. Break ' +
          'one criterion in each to make the membership converge.'
        : 'No cycle among the groups supplied. Groups that could not be read are listed on the ' +
          'graph as `unreadable` and were not part of this check.',
  };
}

export interface BlastRadiusEntry {
  name: string;
  id?: string;
  /** Shortest number of criterion hops from the changed group to this dependant. */
  depth: number;
  /** One shortest chain, starting at the changed group. */
  via: string[];
  /**
   * True when a hop on that chain is a "not member of" criterion, so the dependant
   * moves in the opposite direction to the change.
   */
  throughNegatedCriterion: boolean;
}

export interface BlastRadius {
  group: string;
  /**
   * False when no group in the graph has that name or id.
   *
   * An empty `dependants` list would otherwise read as "nothing depends on it",
   * which is the same false all-clear this module exists to prevent — here it means
   * the question was never asked of any real group.
   */
  groupFound: boolean;
  dependants: BlastRadiusEntry[];
  maxDepth: number;
  /**
   * Dependants that the group also transitively depends on, i.e. a cycle runs
   * through them. The traversal terminates regardless; this says why the chain
   * looked like it should not have.
   */
  inCycleWith: string[];
  note: string;
}

/**
 * Everything that transitively depends on a group — what changes when its
 * membership changes.
 *
 * Direction matters and is easy to invert: an edge means "A's criteria reference
 * B", so A depends on B, and the blast radius of B is found by walking edges
 * BACKWARDS. Breadth-first, so `depth` is the shortest chain rather than whatever
 * a depth-first walk happened to find, and a visited set makes cyclic input
 * terminate instead of recursing forever.
 *
 * Throws on an unusable group argument rather than returning an empty radius.
 */
export function findGroupBlastRadius(graph: GroupDependencyGraph, group: string): BlastRadius {
  const wanted = scalarString(group);
  if (wanted === undefined) {
    throw new Error(
      'findGroupBlastRadius: a group name or id is required. Refusing to return an empty ' +
        'blast radius, which would read as "nothing depends on this group".',
    );
  }

  const key = nameKey(wanted);
  const start =
    graph.nodes.find((n) => nameKey(n.name) === key) ??
    graph.nodes.find((n) => n.id !== undefined && n.id === wanted);

  if (!start) {
    return {
      group: wanted,
      groupFound: false,
      dependants: [],
      maxDepth: 0,
      inCycleWith: [],
      note:
        `No group named or numbered ${JSON.stringify(wanted)} is in this graph, so nothing was ` +
        'traversed. The empty dependants list is not a finding — check the name, and check the ' +
        "graph's `unreadable` list.",
    };
  }

  const { forward, reverse } = adjacency(graph);
  const startKey = nameKey(start.name);
  const nodeByKey = new Map<string, GroupNode>();
  for (const node of graph.nodes) if (!nodeByKey.has(nameKey(node.name))) nodeByKey.set(nameKey(node.name), node);

  const dependants: BlastRadiusEntry[] = [];
  const visited = new Set<string>([startKey]);
  let frontier: Array<{ key: string; via: string[]; negated: boolean }> = [
    { key: startKey, via: [start.name], negated: false },
  ];
  let depth = 0;

  while (frontier.length > 0) {
    depth += 1;
    const next: typeof frontier = [];
    for (const current of frontier) {
      for (const edge of reverse.get(current.key) ?? []) {
        const dependantKey = nameKey(edge.fromName);
        // The visited set is what makes a cycle terminate: a group already reached
        // at an equal or shorter depth is never expanded again.
        if (visited.has(dependantKey)) continue;
        visited.add(dependantKey);
        const node = nodeByKey.get(dependantKey);
        const via = [...current.via, edge.fromName];
        const negated = current.negated || edge.negated;
        dependants.push({
          name: node?.name ?? edge.fromName,
          ...(node?.id !== undefined ? { id: node.id } : {}),
          depth,
          via,
          throughNegatedCriterion: negated,
        });
        next.push({ key: dependantKey, via, negated });
      }
    }
    frontier = next;
  }

  // Forward-reachable from the start AND a dependant of it means a cycle runs
  // through that group.
  const forwardReachable = new Set<string>();
  const stack = [startKey];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const edge of forward.get(current) ?? []) {
      const to = nameKey(edge.toName);
      if (forwardReachable.has(to)) continue;
      forwardReachable.add(to);
      stack.push(to);
    }
  }
  const inCycleWith = dependants.filter((d) => forwardReachable.has(nameKey(d.name))).map((d) => d.name);

  const maxDepth = dependants.reduce((max, d) => Math.max(max, d.depth), 0);
  const negatedCount = dependants.filter((d) => d.throughNegatedCriterion).length;

  const parts: string[] = [];
  parts.push(
    dependants.length === 0
      ? `No other group's criteria depend on ${start.name} in this graph.`
      : `${dependants.length} group(s) change when ${start.name}'s membership changes, up to ${maxDepth} criterion hop(s) away.`,
  );
  if (negatedCount > 0) {
    parts.push(
      `${negatedCount} of them reach it through a "not member of" criterion, so they move the ` +
        'opposite way to the change.',
    );
  }
  if (inCycleWith.length > 0) {
    parts.push(
      `A cycle runs through ${inCycleWith.join(', ')} — the walk terminated on the visited set ` +
        'rather than converging, so treat the depths as shortest chains, not settling order.',
    );
  }
  if (graph.unreadable.length > 0) {
    parts.push(
      `${graph.unreadable.length} group(s) in the input could not be read and are absent from this ` +
        'graph, so the radius may be larger than shown.',
    );
  }
  if (graph.duplicateNames.length > 0) {
    parts.push(
      'Duplicate group names exist in this graph, and criteria reference groups by name, so some ' +
        'edges may be attributed to the wrong group.',
    );
  }

  return {
    group: start.name,
    groupFound: true,
    dependants,
    maxDepth,
    inCycleWith,
    note: parts.join(' '),
  };
}
