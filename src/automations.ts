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
 * Commands that are expensive enough to matter when run repeatedly.
 *
 * Deliberately not exhaustive — a long list produces noise. These are the ones
 * that walk the filesystem, spin the disk, or take seconds of CPU per run.
 */
export const DEFAULT_EXPENSIVE_PATTERNS: ExpensivePattern[] = [
  { pattern: '\\bdu\\b', label: 'du', why: 'recursively walks and stats every file under a path' },
  { pattern: 'find\\s+/(?!\\S*\\bnull\\b)', label: 'find /', why: 'filesystem walk from a high-level path' },
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
