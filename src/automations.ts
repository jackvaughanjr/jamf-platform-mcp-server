/**
 * Finding automations that burn CPU or battery.
 *
 * Pure functions only — no client, no clock — so the scanning and cadence logic is
 * testable without a tenant.
 *
 * The motivating case: an end user reported `du` under `JamfDaemon` with a huge
 * energy impact. Something Jamf runs was walking the filesystem repeatedly. The
 * three things that can do that are a script attached to a frequently-triggered
 * policy, a computer extension attribute (which runs at **every inventory
 * collection**, so it is the most common cause and the easiest to overlook), and
 * Jamf's own inventory collection.
 */

/** A shell command worth flagging, with why it is expensive. */
export interface ExpensivePattern {
  /** Case-insensitive regex source matched against each line. */
  pattern: string;
  label: string;
  why: string;
}

/**
 * Depth at or below which a `find` from a high-level path counts as bounded, and
 * so is not worth flagging.
 *
 * `find / -maxdepth 1` reads the ~20 entries at the root and exits. Reporting that
 * as an expensive command is a false positive, and false positives are how an audit
 * tool gets ignored — once someone dismisses two findings they dismiss the third,
 * which is the real one.
 *
 * 3 is the cut. Depth 1-3 from `/` reaches `/Users/<user>/<dir>` and
 * `/System/Library/<dir>` — thousands of entries, read in well under a second, and
 * bounded no matter how much data the volume holds. Past that each extra level
 * multiplies by the average directory fan-out, and by depth 5-6 the walk is inside
 * per-user Library trees and `/System/Volumes`, where the entry count is driven by
 * how much the user has installed rather than by the depth limit. A nominally
 * bounded walk that deep costs what an unbounded one costs, so it still gets
 * flagged.
 *
 * Exported because a threshold buried in a regex is not reviewable.
 */
export const BOUNDED_FIND_MAX_DEPTH = 3;

/**
 * Builds the `find` pattern: a walk from an absolute path, unless the same command
 * bounds itself to a shallow `-maxdepth`.
 *
 * Two negative lookaheads, both deliberate:
 *
 * - `(?!\S*\bnull\b)` is pre-existing and stays, but it does less than it was once
 *   described as doing. `\S*` cannot cross whitespace, so it only suppresses a match
 *   when `null` is inside the token immediately after `find /` — i.e. `find /dev/null`.
 *   A redirect like `find / -type f > /dev/null` is still flagged, which is correct:
 *   the walk is real regardless of where its output goes. The earlier rationale
 *   ("so `> /dev/null` does not match") described behaviour this regex never had.
 * - the `-maxdepth` lookahead is scoped to `[^;|&\n]*` rather than the whole line,
 *   so a bound belonging to a *different* command cannot excuse this one. On
 *   `find / -type f; find /Users -maxdepth 1` the first walk is still flagged.
 *
 * Depths are enumerated rather than compared numerically, since matching happens in
 * a regex. `\b` after the alternation stops `-maxdepth 12` from matching the `1`.
 */
function unboundedFindPattern(maxBoundedDepth: number): string {
  const depths = Array.from({ length: maxBoundedDepth + 1 }, (_, i) => i).join('|');
  return `find\\s+/(?!\\S*\\bnull\\b)(?![^;|&\\n]*-maxdepth\\s+(?:${depths})\\b)`;
}

/**
 * Commands that are expensive enough to matter when run repeatedly.
 *
 * Deliberately not exhaustive — a long list produces noise. These are the ones
 * that walk the filesystem, spin the disk, or take seconds of CPU per run.
 */
export const DEFAULT_EXPENSIVE_PATTERNS: ExpensivePattern[] = [
  { pattern: '\\bdu\\b', label: 'du', why: 'recursively walks and stats every file under a path' },
  {
    pattern: unboundedFindPattern(BOUNDED_FIND_MAX_DEPTH),
    label: 'find /',
    why: `filesystem walk from a high-level path with no shallow bound (no -maxdepth of ${BOUNDED_FIND_MAX_DEPTH} or less on the same command)`,
  },
  { pattern: '\\bmdfind\\b', label: 'mdfind', why: 'Spotlight query; can force index work' },
  { pattern: 'system_profiler', label: 'system_profiler', why: 'takes seconds of CPU and spins hardware probes' },
  { pattern: 'softwareupdate\\s+(--list|-l)', label: 'softwareupdate --list', why: 'network round trip to Apple, often slow' },
  { pattern: '\\bcodesign\\b.*-{1,2}(deep|verify|v)\\b', label: 'codesign --deep', why: 'hashes every file in a bundle' },
  { pattern: 'spctl\\s+--assess', label: 'spctl --assess', why: 'Gatekeeper assessment, disk and CPU heavy' },
  { pattern: '\\bmdutil\\b', label: 'mdutil', why: 'can trigger a Spotlight reindex' },
  { pattern: '\\bfs_usage\\b|\\bfsck\\b', label: 'fs_usage / fsck', why: 'filesystem tracing or checking' },
  { pattern: '\\bioreg\\b', label: 'ioreg', why: 'full IORegistry dump; moderate but adds up at high frequency' },
];

export interface PatternMatch {
  label: string;
  why: string;
  line: number;
  /** The matching line, trimmed and truncated. */
  excerpt: string;
}

const MAX_EXCERPT = 160;

/**
 * Scans script text for expensive commands.
 *
 * Comment lines are skipped: a commented-out `du` is not running, and reporting it
 * sends someone chasing a line that does nothing. Only the matching line is
 * returned, truncated — enough to judge the finding without dumping a whole script,
 * which may contain credentials.
 */
export function scanForExpensiveCommands(
  contents: string | null | undefined,
  patterns: ExpensivePattern[] = DEFAULT_EXPENSIVE_PATTERNS,
): PatternMatch[] {
  if (!contents) return [];
  const matches: PatternMatch[] = [];
  const lines = contents.split('\n');

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    for (const p of patterns) {
      if (new RegExp(p.pattern, 'i').test(line)) {
        matches.push({
          label: p.label,
          why: p.why,
          line: index + 1,
          excerpt: line.length > MAX_EXCERPT ? `${line.slice(0, MAX_EXCERPT)}…` : line,
        });
      }
    }
  });

  return matches;
}

/** Jamf policy `general` block, as returned by the Classic detail endpoint. */
export interface PolicyGeneral {
  id?: number;
  name?: string;
  enabled?: boolean;
  frequency?: string;
  trigger?: string;
  trigger_checkin?: boolean;
  trigger_enrollment_complete?: boolean;
  trigger_login?: boolean;
  trigger_logout?: boolean;
  trigger_network_state_changed?: boolean;
  trigger_startup?: boolean;
  trigger_other?: string;
}

export interface PolicyCadence {
  /** Fires on every recurring check-in — roughly every 15 minutes by default. */
  runsEveryCheckIn: boolean;
  /** Fires on an event that can repeat many times a day. */
  runsOnFrequentEvent: boolean;
  triggers: string[];
  frequency: string;
  /** Combined judgement: could this run many times per day per device? */
  highFrequency: boolean;
}

/**
 * Classifies how often a policy can run.
 *
 * The combination that matters is `trigger_checkin` with a frequency of "Ongoing":
 * that fires at every recurring check-in, roughly every 15 minutes, forever. A
 * check-in trigger with a once-per-computer frequency runs once and stops, so it is
 * not a battery problem however expensive its script.
 */
export function classifyPolicyCadence(general: PolicyGeneral | null | undefined): PolicyCadence {
  const frequency = general?.frequency ?? 'unknown';
  const ongoing = /ongoing/i.test(frequency);

  const triggers: string[] = [];
  if (general?.trigger_checkin) triggers.push('checkin');
  if (general?.trigger_login) triggers.push('login');
  if (general?.trigger_logout) triggers.push('logout');
  if (general?.trigger_network_state_changed) triggers.push('network-state-changed');
  if (general?.trigger_startup) triggers.push('startup');
  if (general?.trigger_enrollment_complete) triggers.push('enrollment-complete');
  if (general?.trigger_other) triggers.push(`custom:${general.trigger_other}`);

  const runsEveryCheckIn = Boolean(general?.trigger_checkin) && ongoing;
  // Login/logout and network-state changes can fire many times a day on a laptop.
  const runsOnFrequentEvent =
    ongoing &&
    (Boolean(general?.trigger_login) ||
      Boolean(general?.trigger_logout) ||
      Boolean(general?.trigger_network_state_changed));

  return {
    runsEveryCheckIn,
    runsOnFrequentEvent,
    triggers,
    frequency,
    highFrequency: runsEveryCheckIn || runsOnFrequentEvent,
  };
}

/**
 * Computer inventory collection settings, from Classic.
 *
 * Note `inclue_applications` / `inclue_fonts` / `inclue_plugins` — the misspelling
 * is Jamf's, in the live API. Both spellings are accepted here so a future
 * correction upstream does not silently turn every lookup into `undefined`, which
 * would read as "not enabled".
 */
export interface InventoryCollectionSettings {
  local_user_accounts?: boolean;
  home_directory_sizes?: boolean;
  hidden_accounts?: boolean;
  printers?: boolean;
  active_services?: boolean;
  package_receipts?: boolean;
  available_software_updates?: boolean;
  inclue_applications?: boolean;
  include_applications?: boolean;
  inclue_fonts?: boolean;
  include_fonts?: boolean;
  inclue_plugins?: boolean;
  include_plugins?: boolean;
  applications?: unknown[];
  fonts?: unknown[];
  plugins?: unknown[];
}

export interface InventoryCostFinding {
  setting: string;
  enabled: boolean;
  cost: 'high' | 'medium' | 'low';
  why: string;
}

/** The three collection options whose cost depends on configured search paths. */
type SearchPathCategory = 'applications' | 'fonts' | 'plugins';

/** A cost rating that custom search paths raised, and by how much. */
export interface CustomSearchPathEscalation {
  setting: string;
  category: SearchPathCategory;
  /** How many custom search paths that category has — each one is an extra walk. */
  customSearchPaths: number;
  /**
   * The configured paths themselves.
   *
   * The escalation to `high` is inferred from the COUNT, not from measuring any walk,
   * so it can be a false alarm: three paths pointing at small directories are cheap,
   * while one pointing at a data volume is not. Reporting the values makes the rating
   * checkable instead of something to take on trust. An entry whose shape cannot be
   * read is named as such rather than dropped, so the list length always matches
   * `customSearchPaths`.
   */
  paths: string[];
  from: InventoryCostFinding['cost'];
  to: InventoryCostFinding['cost'];
  /** Whether the option is actually on; a rating applies to the option either way. */
  enabled: boolean;
}

/**
 * Pulls displayable path strings out of a custom-search-path array.
 *
 * The gateway types these as `unknown[]` because the shape was never pinned down:
 * Classic returns objects carrying a `path`, but a bare string is plausible too. This
 * is supplementary evidence for a rating rather than the rating itself, so an
 * unreadable entry is labelled rather than thrown on — unlike `extractClassicList`,
 * where an unreadable shape means the whole answer is untrustworthy.
 */
function searchPathValues(entries: unknown[] | undefined): string[] {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
      const path = (entry as { path?: unknown }).path;
      if (typeof path === 'string' && path !== '') return path;
    }
    return '(unreadable entry)';
  });
}

/**
 * Raises a rating to high because the category has custom search paths, and says so
 * with the count.
 *
 * Jamf's default application, font and plug-in search paths are shallow and known
 * (`/Applications`, the Library font and plug-in directories). A *custom* search
 * path can be any directory — a whole user home, a data volume, a mounted share —
 * and Jamf walks each one recursively on every collection. So the work is no longer
 * bounded by Jamf's defaults, which is the same property that makes
 * `home_directory_sizes` high cost, and it multiplies by the number of paths.
 */
function escalatedWhy(base: string, category: SearchPathCategory, count: number): string {
  const noun = { applications: 'application', fonts: 'font', plugins: 'plug-in' }[category];
  return (
    `${base}. ${count} custom ${noun} search path${count === 1 ? '' : 's'} configured, so ` +
    `this is ${count} additional recursive directory walk${count === 1 ? '' : 's'} per collection. ` +
    'A custom path can point at an entire volume, so the added work is not bounded by ' +
    "Jamf's own defaults."
  );
}

/**
 * Rates inventory collection options by how much work each adds per collection.
 *
 * This matters far more than it looks, because these run on **every** inventory
 * collection. If inventory is triggered at every check-in rather than daily, each
 * enabled option below runs roughly every 15 minutes on every machine.
 *
 * `home_directory_sizes` is called out as high cost specifically: Jamf computes it
 * by running `du` across every user home directory, which is the classic cause of a
 * `du` process appearing under JamfDaemon with a large energy impact.
 *
 * **Custom search paths escalate the rating.** Application, font and plug-in
 * collection are cheap only while they use Jamf's own shallow default paths. Each
 * custom path adds a recursive walk of a directory the administrator chose, which
 * can be arbitrarily large — so any category with at least one custom path is rated
 * high and its `why` states the count. A live tenant had three custom application
 * search paths while application collection was still rated low, which is what this
 * rule fixes: the rating contradicted its own explanation.
 *
 * `cost` describes the option, not the current configuration, so a category with
 * custom paths is rated high whether or not collection is switched on — exactly as
 * `home_directory_sizes` is rated high when disabled. `enabledHighCost` is what
 * narrows that to what is actually running, so a caller keying an all-clear message
 * off `enabledHighCost` cannot contradict the findings list.
 */
export function assessInventoryCollection(settings: InventoryCollectionSettings | null | undefined): {
  findings: InventoryCostFinding[];
  enabledHighCost: string[];
  escalatedForCustomSearchPaths: CustomSearchPathEscalation[];
  customSearchPaths: { applications: number; fonts: number; plugins: number };
} {
  const on = (...keys: Array<keyof InventoryCollectionSettings>) =>
    keys.some((k) => settings?.[k] === true);
  const pathCount = (key: SearchPathCategory) =>
    Array.isArray(settings?.[key]) ? (settings[key] as unknown[]).length : 0;

  const customSearchPaths = {
    applications: pathCount('applications'),
    fonts: pathCount('fonts'),
    plugins: pathCount('plugins'),
  };

  const base: Array<InventoryCostFinding & { category?: SearchPathCategory }> = [
    {
      setting: 'home_directory_sizes',
      enabled: on('home_directory_sizes'),
      cost: 'high',
      why: 'Jamf runs `du` across every user home directory to compute this. The usual cause of a du process under JamfDaemon burning CPU and battery.',
    },
    {
      setting: 'package_receipts',
      enabled: on('package_receipts'),
      cost: 'medium',
      why: 'reads the installer receipt database and enumerates every receipt',
    },
    {
      setting: 'available_software_updates',
      enabled: on('available_software_updates'),
      cost: 'medium',
      why: 'network round trip to Apple per collection; slow and can stall',
    },
    {
      setting: 'inclue_fonts / include_fonts',
      enabled: on('inclue_fonts', 'include_fonts'),
      cost: 'medium',
      why: 'walks font directories on every collection',
      category: 'fonts',
    },
    {
      setting: 'inclue_plugins / include_plugins',
      enabled: on('inclue_plugins', 'include_plugins'),
      cost: 'medium',
      why: 'walks plug-in directories on every collection',
      category: 'plugins',
    },
    {
      setting: 'inclue_applications / include_applications',
      enabled: on('inclue_applications', 'include_applications'),
      cost: 'low',
      why: 'application inventory; acceptable while it uses only the default search path',
      category: 'applications',
    },
    {
      setting: 'active_services',
      enabled: on('active_services'),
      cost: 'low',
      why: 'enumerates running services',
    },
    { setting: 'printers', enabled: on('printers'), cost: 'low', why: 'enumerates printers' },
    {
      setting: 'local_user_accounts',
      enabled: on('local_user_accounts'),
      cost: 'low',
      why: 'enumerates local accounts',
    },
  ];

  const escalatedForCustomSearchPaths: CustomSearchPathEscalation[] = [];

  const findings: InventoryCostFinding[] = base.map(({ category, ...finding }) => {
    const count = category ? customSearchPaths[category] : 0;
    if (!category || count === 0) return finding;
    escalatedForCustomSearchPaths.push({
      setting: finding.setting,
      category,
      customSearchPaths: count,
      paths: searchPathValues(settings?.[category]),
      from: finding.cost,
      to: 'high',
      enabled: finding.enabled,
    });
    return { ...finding, cost: 'high', why: escalatedWhy(finding.why, category, count) };
  });

  return {
    findings,
    // Derived after escalation, so an escalated option shows up here too — the
    // summary cannot say "nothing high-cost is enabled" while a finding says high.
    enabledHighCost: findings.filter((f) => f.enabled && f.cost === 'high').map((f) => f.setting),
    escalatedForCustomSearchPaths,
    customSearchPaths,
  };
}

/**
 * Pulls the array out of a Jamf Pro Classic list response.
 *
 * Classic's **JSON** wraps a collection in the PLURAL key — `{"scripts": [...]}` —
 * while the reference pages describe the XML schema, which names the repeated
 * singular element (`script`) plus a `size` count. Reading the docs literally and
 * looking for the singular key finds nothing.
 *
 * Throws when no candidate key matches, listing the keys actually present. An
 * earlier version returned an empty array instead, which turned a shape mismatch
 * into "scanned 0 items, found no problems" — a false all-clear from a tool whose
 * entire job is finding problems. An audit that cannot read the response must say
 * so, not report a clean bill of health.
 */
export function extractClassicList<T>(
  body: Record<string, unknown> | null | undefined,
  candidateKeys: string[],
): { items: T[]; matchedKey: string } {
  for (const key of candidateKeys) {
    const value = body?.[key];
    if (Array.isArray(value)) return { items: value as T[], matchedKey: key };
  }
  const present = body && typeof body === 'object' ? Object.keys(body) : [];
  throw new Error(
    `unexpected Classic list shape: no array found under ${candidateKeys.join(' / ')}. ` +
      `Top-level keys present: ${present.length > 0 ? present.join(', ') : '(none)'}.`,
  );
}

/**
 * Same problem for a Classic detail response, which wraps in the singular key.
 * Returns undefined rather than throwing — a detail body may legitimately lack the
 * wrapper on some resources, and the caller reports per-item failures anyway.
 */
export function extractClassicDetail<T>(
  body: Record<string, unknown> | null | undefined,
  candidateKeys: string[],
): T | undefined {
  for (const key of candidateKeys) {
    const value = body?.[key];
    if (value !== undefined && value !== null) return value as T;
  }
  return undefined;
}

/**
 * One term to sweep for, and how much the term is actually trusted.
 *
 * The distinction is the whole point of the type. An alias presented as Jamf's real
 * criterion label when nobody has checked is worse than no alias at all: it makes a
 * zero-result answer look thoroughly searched.
 */
export interface CriterionAlias {
  /** Substring matched against criterion names, criterion values and display fields. */
  term: string;
  /**
   * `confirmed` — this exact string was observed as a criterion name in a live Jamf
   * tenant.
   *
   * `broad-substring` — Jamf's exact label is NOT known. The term is deliberately
   * the widest fragment every plausible label would contain ("Home Directory", not a
   * guessed "Home Directory Size"), which over-matches. That is the safe direction:
   * an extra object to review costs a glance, a missed reference costs a smart group
   * silently emptying and every policy scoped to it stopping.
   */
  confidence: 'confirmed' | 'broad-substring';
}

/**
 * Inventory-collection setting key → the criterion name(s) Jamf exposes for that data.
 *
 * Why this exists: **Jamf's inventory-collection setting keys are not its
 * smart-group criterion names.** `package_receipts` is the setting, but criteria
 * query it as "Packages Installed" and "Cached Packages" — not one character of
 * overlap. Searching the setting key therefore returns zero references whether or
 * not consumers exist, and a false zero here is acted on by disabling collection,
 * which empties the groups that depend on it.
 *
 * THIS MAP IS NECESSARILY INCOMPLETE AND PARTLY UNVERIFIED. Jamf's criterion labels
 * are not published as a machine-readable list and vary by Jamf Pro version, so only
 * `package_receipts` is confirmed against a live tenant. Every other entry is a
 * `broad-substring` fallback — see `CriterionAlias`. Adding an entry means either
 * confirming the label against a real tenant or marking it `broad-substring`;
 * upgrading a guess to `confirmed` without checking defeats the purpose of the field.
 *
 * The misspelled keys are Jamf's own (`inclue_*`), and map to the same aliases as the
 * corrected spellings so either spelling of a query works.
 */
export const INVENTORY_SETTING_CRITERION_ALIASES: Readonly<Record<string, readonly CriterionAlias[]>> = {
  // Confirmed against a live tenant: both labels observed as criterion names.
  package_receipts: [
    { term: 'Packages Installed', confidence: 'confirmed' },
    { term: 'Cached Packages', confidence: 'confirmed' },
  ],
  // Unconfirmed below. Each term is the broadest fragment any plausible label for
  // that data would have to contain.
  home_directory_sizes: [{ term: 'Home Directory', confidence: 'broad-substring' }],
  available_software_updates: [
    { term: 'Software Update', confidence: 'broad-substring' },
    // A label counting them ("Number of Available Updates") contains neither
    // "Software Update" nor "Available Software", so it needs its own fragment.
    { term: 'Available Update', confidence: 'broad-substring' },
  ],
  include_applications: [{ term: 'Application', confidence: 'broad-substring' }],
  inclue_applications: [{ term: 'Application', confidence: 'broad-substring' }],
  include_fonts: [{ term: 'Font', confidence: 'broad-substring' }],
  inclue_fonts: [{ term: 'Font', confidence: 'broad-substring' }],
  // "Plug" rather than "Plugin", because Jamf writes it both ways ("Plug-in Title",
  // "Plugin") and the hyphen would split a narrower fragment.
  include_plugins: [{ term: 'Plug', confidence: 'broad-substring' }],
  inclue_plugins: [{ term: 'Plug', confidence: 'broad-substring' }],
  active_services: [{ term: 'Service', confidence: 'broad-substring' }],
  printers: [{ term: 'Printer', confidence: 'broad-substring' }],
  local_user_accounts: [
    { term: 'Local User', confidence: 'broad-substring' },
    // Covers labels that drop "Local" ("Accounts", "Hidden Accounts").
    { term: 'Account', confidence: 'broad-substring' },
  ],
};

export interface InventoryQueryExpansion {
  /** The query as given, trimmed. */
  query: string;
  /** Terms to sweep: the query first, then aliases, de-duplicated case-insensitively. */
  terms: string[];
  /** The setting key the query resolved to, if any. Absent for a free-text query. */
  matchedSettingKey?: string;
  /** Aliases added beyond the query itself, with their confidence. */
  aliases: CriterionAlias[];
  /**
   * True when at least one added alias is a `broad-substring` fallback. A caller
   * reporting "no references found" should say this, because the sweep used a guessed
   * label rather than a confirmed one.
   */
  hasUnconfirmedAliases: boolean;
}

/**
 * Expands a query into every term worth sweeping.
 *
 * The query itself is always first and always kept, even when it matches a setting
 * key: the key can legitimately appear in an extension-attribute name or a criterion
 * value, and dropping it would trade one blind spot for another.
 *
 * Lookup normalises case and treats spaces and hyphens as underscores, so
 * `package_receipts`, `Package Receipts` and `package-receipts` all resolve. That
 * only ever *adds* terms, so a normalisation surprise cannot silence a search.
 */
export function expandInventoryQuery(query: string | null | undefined): InventoryQueryExpansion {
  const trimmed = (query ?? '').trim();
  if (trimmed === '') {
    return { query: '', terms: [], aliases: [], hasUnconfirmedAliases: false };
  }

  const key = trimmed.toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = [...(INVENTORY_SETTING_CRITERION_ALIASES[key] ?? [])];

  const terms: string[] = [];
  const seen = new Set<string>();
  for (const term of [trimmed, ...aliases.map((a) => a.term)]) {
    const dedupeKey = term.toLowerCase();
    if (term === '' || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    terms.push(term);
  }

  return {
    query: trimmed,
    terms,
    ...(aliases.length > 0 ? { matchedSettingKey: key } : {}),
    aliases,
    hasUnconfirmedAliases: aliases.some((a) => a.confidence === 'broad-substring'),
  };
}

/** A criterion inside a smart group or advanced search. */
export interface JamfCriterion {
  name?: string;
  search_type?: string;
  value?: string | number | boolean | null;
  priority?: number;
  and_or?: string;
  opening_paren?: boolean;
  closing_paren?: boolean;
}

/** One criterion rendered as a line a human can read in order. */
export interface ReadableCriterion {
  order: number;
  /** `and` / `or` joining this to the previous line. Absent on the first. */
  join?: string;
  field: string;
  operator: string;
  value?: string;
  openParen: boolean;
  closeParen: boolean;
  /** One line, e.g. `and (Computer Group member of "CMMC: Compliance Required")`. */
  line: string;
}

/** Something about a criterion that will surprise whoever reads the group. */
export interface CriterionWarning {
  order: number;
  field: string;
  issue: string;
  why: string;
}

/**
 * Renders a smart group's criteria in evaluation order, and flags the ones that do
 * not mean what they look like.
 *
 * Reading a group in the Jamf UI shows the rules; it does not tell you that an
 * unanchored regex is a *search*, so `(\b[a-z0-9_\-]+\n?\b)+` succeeds on any value
 * holding one qualifying token. A criterion written to mean "has failures" then means
 * "is not blank", and values like `Not in scope` or `No Baseline Set` satisfy it. That
 * was found in a live tenant, where it made every device with any value at all count
 * as non-compliant.
 *
 * Warnings describe what the criterion will actually do. They are never assertions
 * that it is wrong — an unanchored regex is sometimes exactly what was wanted.
 */
export function summarizeGroupCriteria(criteria: JamfCriterion[] | null | undefined): {
  criteria: ReadableCriterion[];
  warnings: CriterionWarning[];
} {
  if (!Array.isArray(criteria)) return { criteria: [], warnings: [] };

  const readable: ReadableCriterion[] = [];
  const warnings: CriterionWarning[] = [];

  criteria.forEach((c, index) => {
    const field = c.name ?? '(unnamed)';
    const operator = c.search_type ?? '(no operator)';
    const value = valueToString(c.value);
    const openParen = c.opening_paren === true;
    const closeParen = c.closing_paren === true;
    const join = index === 0 ? undefined : (c.and_or ?? 'and');

    const rendered = [
      join,
      openParen ? '(' : undefined,
      field,
      operator,
      value === undefined ? undefined : JSON.stringify(value),
      closeParen ? ')' : undefined,
    ]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' ');

    readable.push({ order: index, join, field, operator, value, openParen, closeParen, line: rendered });

    if (operator.toLowerCase() === 'matches regex' && value !== undefined) {
      if (!value.startsWith('^')) {
        warnings.push({
          order: index,
          field,
          issue: 'unanchored regex — this matches any value CONTAINING a match, not the whole value',
          why:
            'A criterion meant as "has failures" becomes "is not blank": placeholder values such ' +
            'as "Not in scope" or "No Baseline Set" satisfy it, and so does anything else with a ' +
            'qualifying token. Anchor with ^ and $ if the whole value was meant to be tested.',
        });
      }
      // Plain string tests, not a regex about a regex — the first attempt at this
      // matched the wrong escaping and silently never fired.
      const lowercaseOnlyClass =
        value.includes('[a-z') && !value.includes('[a-zA-Z') && !value.includes('A-Z');
      if (lowercaseOnlyClass) {
        warnings.push({
          order: index,
          field,
          issue: 'lowercase-only character class, but Jamf Pro matches case-insensitively by default',
          why:
            "MySQL's default collation is case-insensitive, so an uppercase value like EMPTY can " +
            'match a class written as [a-z0-9_-]. A group meant to exclude a sentinel value may ' +
            'include it, putting a device in both the compliant and non-compliant group at once.',
        });
      }
    }
  });

  return { criteria: readable, warnings };
}

export interface CriterionMatch {
  criterion: string;
  searchType?: string;
  value?: string;
  matchedOn: 'name' | 'value' | 'name+value';
}

/** Renders a criterion value for display without asserting it is a string. */
function valueToString(value: JamfCriterion['value']): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}

/**
 * Finds criteria whose field name or value mentions `query`.
 *
 * Both are checked because either can be the reference you care about: a criterion
 * on "Home Directory Size" names the field, while a criterion on an extension
 * attribute might carry the interesting term in its value instead.
 */
export function findCriterionMatches(
  criteria: JamfCriterion[] | null | undefined,
  query: string,
): CriterionMatch[] {
  const q = query.trim().toLowerCase();
  if (!q || !Array.isArray(criteria)) return [];

  const matches: CriterionMatch[] = [];
  for (const c of criteria) {
    const name = c.name ?? '';
    const value = valueToString(c.value) ?? '';
    const inName = name.toLowerCase().includes(q);
    const inValue = value.toLowerCase().includes(q);
    if (!inName && !inValue) continue;
    matches.push({
      criterion: name || '(unnamed)',
      searchType: c.search_type,
      value: valueToString(c.value),
      matchedOn: inName && inValue ? 'name+value' : inName ? 'name' : 'value',
    });
  }
  return matches;
}

/**
 * Runs `findCriterionMatches` across every term and de-duplicates the result.
 *
 * Sweeping an alias set means one criterion can match more than one term — a
 * "Packages Installed" criterion matches both that and the broader "Application" —
 * and counting it twice would inflate the reference count that decides whether an
 * inventory field is load-bearing. Identity is the criterion, its value and what it
 * matched on; the term that found it is deliberately not part of the key, since the
 * same finding reached by two routes is still one finding.
 *
 * Lives here rather than in the tool handler because it is pure and therefore
 * testable without a tenant.
 */
export function sweepCriterionMatches(
  criteria: JamfCriterion[] | null | undefined,
  terms: readonly string[],
): CriterionMatch[] {
  const seen = new Set<string>();
  const out: CriterionMatch[] = [];
  for (const term of terms) {
    for (const match of findCriterionMatches(criteria, term)) {
      const key = `${match.criterion}|${match.value ?? ''}|${match.matchedOn}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(match);
    }
  }
  return out;
}

/** Sweeps display fields across every term, de-duplicated by field name. */
export function sweepDisplayFieldMatches(
  displayFields: Array<{ name?: string }> | null | undefined,
  terms: readonly string[],
): string[] {
  const seen = new Set<string>();
  for (const term of terms) {
    for (const name of findDisplayFieldMatches(displayFields, term)) seen.add(name);
  }
  return [...seen];
}

/**
 * Finds display fields mentioning `query`.
 *
 * An advanced search that merely *displays* a field is still consuming it, even
 * though it does not filter on it — so checking criteria alone would wrongly
 * report a field as unused.
 */
export function findDisplayFieldMatches(
  displayFields: Array<{ name?: string }> | null | undefined,
  query: string,
): string[] {
  const q = query.trim().toLowerCase();
  if (!q || !Array.isArray(displayFields)) return [];
  return displayFields
    .map((f) => f.name)
    .filter((n): n is string => typeof n === 'string' && n.toLowerCase().includes(q));
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight.
 *
 * Auditing every script, extension attribute and policy means one detail request
 * each — potentially hundreds. Unbounded `Promise.all` would open all of them at
 * once against a beta gateway; serial would take minutes.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}
