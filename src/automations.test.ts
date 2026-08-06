import { describe, expect, it } from 'vitest';

import {
  assessInventoryCollection,
  BOUNDED_FIND_MAX_DEPTH,
  classifyPolicyCadence,
  expandInventoryQuery,
  extractClassicDetail,
  extractClassicList,
  findCriterionMatches,
  findDisplayFieldMatches,
  INVENTORY_SETTING_CRITERION_ALIASES,
  mapWithConcurrency,
  scanForExpensiveCommands,
  summarizeGroupCriteria,
  sweepCriterionMatches,
  sweepDisplayFieldMatches,
} from './automations.js';

describe('scanForExpensiveCommands', () => {
  it('finds du, which is the reported real-world culprit', () => {
    const matches = scanForExpensiveCommands('#!/bin/sh\nSIZE=$(du -sh /Users/Shared)\necho "$SIZE"');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.label).toBe('du');
    expect(matches[0]?.line).toBe(2);
    expect(matches[0]?.excerpt).toContain('du -sh');
  });

  // A commented-out command is not running; reporting it sends someone chasing a
  // line that does nothing.
  it('ignores comments and blank lines', () => {
    expect(scanForExpensiveCommands('# du -sh /\n\n   # find / -name x')).toEqual([]);
  });

  it('finds a filesystem walk but not an unrelated find', () => {
    expect(scanForExpensiveCommands('find / -name "*.log"')).toHaveLength(1);
    expect(scanForExpensiveCommands('find "$HOME/Library" -name x')).toHaveLength(0);
  });

  it('does not fire on words that merely contain a pattern', () => {
    // "sudo" contains "du" — a substring match would flag every sudo line in the
    // fleet, which would bury the real finding.
    expect(scanForExpensiveCommands('sudo /usr/local/bin/thing')).toEqual([]);
    expect(scanForExpensiveCommands('echo "production"')).toEqual([]);
    expect(scanForExpensiveCommands('DURATION=5')).toEqual([]);
  });

  it('reports multiple distinct patterns on one line', () => {
    const labels = scanForExpensiveCommands('system_profiler SPHardwareDataType; mdfind foo').map((m) => m.label);
    expect(labels).toContain('system_profiler');
    expect(labels).toContain('mdfind');
  });

  it('truncates a long line rather than dumping it', () => {
    const long = `du -sh ${'/very/long/path'.repeat(40)}`;
    const [match] = scanForExpensiveCommands(long);
    expect(match?.excerpt.length).toBeLessThanOrEqual(161);
    expect(match?.excerpt.endsWith('…')).toBe(true);
  });

  it('handles null, undefined and empty contents', () => {
    expect(scanForExpensiveCommands(null)).toEqual([]);
    expect(scanForExpensiveCommands(undefined)).toEqual([]);
    expect(scanForExpensiveCommands('')).toEqual([]);
  });

  // A bounded walk is cheap, and flagging it is how an audit tool trains people to
  // dismiss its output.
  it('does not flag a shallow bounded walk from /', () => {
    expect(scanForExpensiveCommands('find / -maxdepth 1 -name foo')).toEqual([]);
    expect(scanForExpensiveCommands('find / -maxdepth 1 -name foo | head -1')).toEqual([]);
  });

  it('still flags an unbounded walk, and a nominally bounded but deep one', () => {
    expect(scanForExpensiveCommands('find / -name "*.log"')).toHaveLength(1);
    expect(scanForExpensiveCommands('find / -maxdepth 6 -name "*.log"')).toHaveLength(1);
    // The digit is compared as a whole number, not a leading character.
    expect(scanForExpensiveCommands('find / -maxdepth 12 -name "*.log"')).toHaveLength(1);
  });

  it('draws the bounded/unbounded line at the exported depth threshold', () => {
    expect(scanForExpensiveCommands(`find / -maxdepth ${BOUNDED_FIND_MAX_DEPTH} -type f`)).toEqual([]);
    expect(scanForExpensiveCommands(`find / -maxdepth ${BOUNDED_FIND_MAX_DEPTH + 1} -type f`)).toHaveLength(1);
  });

  // The (?!\S*\bnull\b) lookahead is deliberate; a redirect must not be read as a
  // walk, but a redirect also must not excuse the walk in front of it.
  it('keeps the /dev/null exclusion without excusing a real walk', () => {
    expect(scanForExpensiveCommands('find /dev/null -name x')).toEqual([]);
    expect(scanForExpensiveCommands('find / -type f 2> /dev/null')).toHaveLength(1);
  });

  it('does not let one command’s depth bound excuse another on the same line', () => {
    const matches = scanForExpensiveCommands('find / -type f; find /Users -maxdepth 1 -name x');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.label).toBe('find /');
  });

  it('accepts custom patterns', () => {
    const matches = scanForExpensiveCommands('curl https://example.test', [
      { pattern: 'curl', label: 'curl', why: 'network' },
    ]);
    expect(matches[0]?.label).toBe('curl');
  });
});

describe('classifyPolicyCadence', () => {
  // The combination that actually burns battery.
  it('flags check-in trigger with Ongoing frequency as every-check-in', () => {
    const c = classifyPolicyCadence({ trigger_checkin: true, frequency: 'Ongoing' });
    expect(c.runsEveryCheckIn).toBe(true);
    expect(c.highFrequency).toBe(true);
    expect(c.triggers).toContain('checkin');
  });

  // Runs once and stops, however expensive the script — not a battery problem.
  it('does not flag a check-in trigger that runs once per computer', () => {
    const c = classifyPolicyCadence({ trigger_checkin: true, frequency: 'Once per computer' });
    expect(c.runsEveryCheckIn).toBe(false);
    expect(c.highFrequency).toBe(false);
  });

  it('flags ongoing login/logout/network triggers as frequent events', () => {
    expect(classifyPolicyCadence({ trigger_login: true, frequency: 'Ongoing' }).highFrequency).toBe(true);
    expect(
      classifyPolicyCadence({ trigger_network_state_changed: true, frequency: 'Ongoing' }).highFrequency,
    ).toBe(true);
  });

  it('does not flag a once-per-computer startup policy', () => {
    const c = classifyPolicyCadence({ trigger_startup: true, frequency: 'Once per computer' });
    expect(c.highFrequency).toBe(false);
    expect(c.triggers).toEqual(['startup']);
  });

  it('records a custom trigger by name', () => {
    expect(classifyPolicyCadence({ trigger_other: 'nightly', frequency: 'Ongoing' }).triggers).toEqual([
      'custom:nightly',
    ]);
  });

  it('handles a missing general block', () => {
    const c = classifyPolicyCadence(undefined);
    expect(c.frequency).toBe('unknown');
    expect(c.triggers).toEqual([]);
    expect(c.highFrequency).toBe(false);
  });
});

describe('extractClassicList', () => {
  // Classic JSON wraps in the PLURAL key; the reference pages document the
  // singular XML element. Reading the docs literally finds nothing.
  it('prefers the plural JSON key', () => {
    const { items, matchedKey } = extractClassicList<{ id: number }>(
      { size: 2, scripts: [{ id: 1 }, { id: 2 }] },
      ['scripts', 'script'],
    );
    expect(items).toHaveLength(2);
    expect(matchedKey).toBe('scripts');
  });

  it('falls back to the singular key', () => {
    expect(extractClassicList({ script: [{ id: 1 }] }, ['scripts', 'script']).matchedKey).toBe('script');
  });

  it('returns an empty list for a genuinely empty collection', () => {
    expect(extractClassicList({ scripts: [] }, ['scripts', 'script']).items).toEqual([]);
  });

  // The bug this function exists to prevent: an unreadable shape reported as
  // "scanned 0, found nothing" is a false all-clear from an auditing tool.
  it('throws on an unrecognised shape and names the keys actually present', () => {
    expect(() => extractClassicList({ unexpected: [1], other: 2 }, ['scripts', 'script'])).toThrow(
      /unexpected Classic list shape.*unexpected, other/s,
    );
  });

  it('throws rather than returning empty for null or a non-array value', () => {
    expect(() => extractClassicList(null, ['scripts'])).toThrow(/no array found/);
    expect(() => extractClassicList({ scripts: 'not-an-array' }, ['scripts'])).toThrow(/no array found/);
  });
});

describe('extractClassicDetail', () => {
  it('unwraps the singular detail key', () => {
    expect(extractClassicDetail<{ id: number }>({ script: { id: 7 } }, ['script'])).toEqual({ id: 7 });
  });

  it('returns undefined when no key matches, leaving the caller to report it', () => {
    expect(extractClassicDetail({ other: 1 }, ['script'])).toBeUndefined();
    expect(extractClassicDetail(null, ['script'])).toBeUndefined();
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms / 10));
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('handles an empty list without hanging', async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([]);
  });

  it('processes every item when concurrency exceeds the list length', async () => {
    const out = await mapWithConcurrency([1, 2], 10, async (n) => n * 2);
    expect(out).toEqual([2, 4]);
  });
});

describe('assessInventoryCollection', () => {
  it('flags home_directory_sizes as the high-cost option that runs du', () => {
    const a = assessInventoryCollection({ home_directory_sizes: true });
    expect(a.enabledHighCost).toEqual(['home_directory_sizes']);
    const finding = a.findings.find((f) => f.setting === 'home_directory_sizes');
    expect(finding?.cost).toBe('high');
    expect(finding?.why).toMatch(/du/);
  });

  it('reports nothing high-cost when it is off', () => {
    expect(assessInventoryCollection({ home_directory_sizes: false }).enabledHighCost).toEqual([]);
  });

  // The misspelling is Jamf's, in the live API. Accepting only the corrected
  // spelling would silently read as "not enabled".
  it('accepts both the misspelled and corrected include_* keys', () => {
    const typo = assessInventoryCollection({ inclue_fonts: true });
    const fixed = assessInventoryCollection({ include_fonts: true });
    const enabled = (a: ReturnType<typeof assessInventoryCollection>) =>
      a.findings.filter((f) => f.enabled).map((f) => f.setting);
    expect(enabled(typo)).toEqual(['inclue_fonts / include_fonts']);
    expect(enabled(fixed)).toEqual(['inclue_fonts / include_fonts']);
  });

  it('counts custom search paths, which each add a walk', () => {
    const a = assessInventoryCollection({ applications: [{}, {}], fonts: [{}], plugins: [] });
    expect(a.customSearchPaths).toEqual({ applications: 2, fonts: 1, plugins: 0 });
  });

  it('treats a missing settings object as nothing enabled without throwing', () => {
    const a = assessInventoryCollection(undefined);
    expect(a.enabledHighCost).toEqual([]);
    expect(a.findings.every((f) => f.enabled === false)).toBe(true);
  });

  // The live-tenant case: 3 custom application search paths, still rated low, with a
  // `why` that named the very thing it was ignoring.
  it('escalates application collection above low when custom search paths exist, and states the count', () => {
    const a = assessInventoryCollection({
      include_applications: true,
      applications: [{ path: '/opt/tools' }, { path: '/srv/apps' }, { path: '/data/vol' }],
    });
    const finding = a.findings.find((f) => f.setting.includes('include_applications'));
    expect(finding?.cost).not.toBe('low');
    expect(finding?.cost).toBe('high');
    expect(finding?.why).toContain('3 custom application search paths');
    expect(a.escalatedForCustomSearchPaths).toEqual([
      {
        setting: 'inclue_applications / include_applications',
        category: 'applications',
        customSearchPaths: 3,
        paths: ['/opt/tools', '/srv/apps', '/data/vol'],
        from: 'low',
        to: 'high',
        enabled: true,
      },
    ]);
  });

  // The escalation to high is inferred from the path COUNT, never from measuring a
  // walk, so the paths themselves are what makes the rating checkable rather than
  // something to take on trust.
  it('reports the configured paths alongside the count that triggered the escalation', () => {
    const a = assessInventoryCollection({
      include_fonts: true,
      fonts: ['/Library/Fonts/Vendor', { path: '/srv/fonts' }],
    });
    expect(a.escalatedForCustomSearchPaths[0]?.paths).toEqual(['/Library/Fonts/Vendor', '/srv/fonts']);
  });

  // Supplementary evidence, not the answer — so an unreadable entry is labelled
  // rather than dropped, keeping paths.length equal to the count it explains.
  it('labels an unreadable path entry rather than dropping it', () => {
    const a = assessInventoryCollection({
      include_plugins: true,
      plugins: [{ path: '/srv/plugins' }, { nope: 1 }, 42],
    });
    const escalation = a.escalatedForCustomSearchPaths[0];
    expect(escalation?.paths).toEqual(['/srv/plugins', '(unreadable entry)', '(unreadable entry)']);
    expect(escalation?.paths).toHaveLength(escalation?.customSearchPaths ?? -1);
  });

  it('leaves application collection at low when it uses only the default path', () => {
    const a = assessInventoryCollection({ include_applications: true, applications: [] });
    expect(a.findings.find((f) => f.setting.includes('include_applications'))?.cost).toBe('low');
    expect(a.escalatedForCustomSearchPaths).toEqual([]);
    expect(a.enabledHighCost).toEqual([]);
  });

  it('applies the same reasoning to fonts and plugins', () => {
    const a = assessInventoryCollection({
      include_fonts: true,
      include_plugins: true,
      fonts: [{}],
      plugins: [{}, {}],
    });
    expect(a.findings.find((f) => f.setting.includes('include_fonts'))?.cost).toBe('high');
    expect(a.findings.find((f) => f.setting.includes('include_fonts'))?.why).toContain(
      '1 custom font search path ',
    );
    expect(a.findings.find((f) => f.setting.includes('include_plugins'))?.why).toContain(
      '2 custom plug-in search paths',
    );
    expect(a.escalatedForCustomSearchPaths.map((e) => e.category)).toEqual(['fonts', 'plugins']);
  });

  // The escalation has to work through Jamf's misspelling too, or the tenant that
  // still returns `inclue_*` gets the old under-rating.
  it('escalates through the misspelled key as well', () => {
    const a = assessInventoryCollection({ inclue_applications: true, applications: [{}, {}] });
    expect(a.enabledHighCost).toContain('inclue_applications / include_applications');
  });

  // The summary must not contradict the findings list in either direction: an
  // escalated finding is high cost, but only an ENABLED one is high cost *now*.
  it('keeps an escalated but disabled option out of enabledHighCost', () => {
    const a = assessInventoryCollection({ include_applications: false, applications: [{}] });
    expect(a.findings.find((f) => f.setting.includes('include_applications'))?.cost).toBe('high');
    expect(a.enabledHighCost).toEqual([]);
    expect(a.escalatedForCustomSearchPaths[0]?.enabled).toBe(false);
  });

  it('reports every enabled high-cost finding in enabledHighCost', () => {
    const a = assessInventoryCollection({
      home_directory_sizes: true,
      include_applications: true,
      applications: [{}, {}, {}],
    });
    const highAndEnabled = a.findings.filter((f) => f.enabled && f.cost === 'high').map((f) => f.setting);
    expect(a.enabledHighCost).toEqual(highAndEnabled);
    expect(a.enabledHighCost).toHaveLength(2);
  });
});

// Sweeping an alias set is what makes findCriteriaReferences trustworthy, and
// double-counting is what would make it lie in the other direction — an inflated
// reference count reads as "this field is load-bearing" when it may not be.
describe('sweepCriterionMatches', () => {
  const criteria = [
    { name: 'Packages Installed', search_type: 'has', value: 'Xcode' },
    { name: 'Application Title', search_type: 'is', value: 'Safari' },
  ];

  it('counts a criterion once even when several terms match it', () => {
    // "Packages Installed" contains both "Package" and "Installed".
    const swept = sweepCriterionMatches(criteria, ['Package', 'Installed', 'Packages Installed']);
    expect(swept).toHaveLength(1);
    expect(swept[0]?.criterion).toBe('Packages Installed');
  });

  it('still returns distinct criteria found by different terms', () => {
    const swept = sweepCriterionMatches(criteria, ['Package', 'Application']);
    expect(swept.map((m) => m.criterion)).toEqual(['Packages Installed', 'Application Title']);
  });

  it('finds a criterion no single-term search would have found', () => {
    // The whole point of the alias map: the setting key matches nothing.
    expect(sweepCriterionMatches(criteria, ['package_receipts'])).toHaveLength(0);
    expect(sweepCriterionMatches(criteria, ['package_receipts', 'Packages Installed'])).toHaveLength(1);
  });

  it('returns nothing for no terms, rather than everything', () => {
    expect(sweepCriterionMatches(criteria, [])).toEqual([]);
  });
});

describe('sweepDisplayFieldMatches', () => {
  const fields = [{ name: 'Packages Installed' }, { name: 'Application Title' }];

  it('de-duplicates a field matched by more than one term', () => {
    expect(sweepDisplayFieldMatches(fields, ['Package', 'Installed'])).toEqual(['Packages Installed']);
  });

  it('accumulates fields across terms', () => {
    expect(sweepDisplayFieldMatches(fields, ['Package', 'Application'])).toEqual([
      'Packages Installed',
      'Application Title',
    ]);
  });
});

describe('findCriterionMatches', () => {
  const criteria = [
    { name: 'Home Directory Size (MB)', search_type: 'more than', value: 200000, priority: 0 },
    { name: 'Operating System Version', search_type: 'like', value: '26', priority: 1 },
    { name: 'Extension Attribute', search_type: 'is', value: 'home directory audit', priority: 2 },
  ];

  it('matches on the criterion field name', () => {
    const m = findCriterionMatches(criteria, 'Home Directory');
    expect(m.map((x) => x.criterion)).toContain('Home Directory Size (MB)');
    expect(m.find((x) => x.criterion.startsWith('Home'))?.matchedOn).toBe('name');
  });

  // The interesting term can live in the value instead of the field name.
  it('matches on the criterion value too', () => {
    const m = findCriterionMatches(criteria, 'home directory audit');
    expect(m).toHaveLength(1);
    expect(m[0]?.matchedOn).toBe('value');
  });

  it('reports name+value when both match', () => {
    const m = findCriterionMatches([{ name: 'Home', value: 'home' }], 'home');
    expect(m[0]?.matchedOn).toBe('name+value');
  });

  it('stringifies non-string values rather than dropping them', () => {
    const m = findCriterionMatches([{ name: 'Size', value: 200000 }], '200000');
    expect(m[0]?.value).toBe('200000');
  });

  it('returns nothing for an empty query, missing criteria, or no match', () => {
    expect(findCriterionMatches(criteria, '')).toEqual([]);
    expect(findCriterionMatches(criteria, '   ')).toEqual([]);
    expect(findCriterionMatches(null, 'home')).toEqual([]);
    expect(findCriterionMatches(criteria, 'bluetooth')).toEqual([]);
  });

  it('tolerates criteria with null values and missing names', () => {
    expect(findCriterionMatches([{ value: null }, {}], 'x')).toEqual([]);
    expect(findCriterionMatches([{ value: 'x' }], 'x')[0]?.criterion).toBe('(unnamed)');
  });
});

describe('findDisplayFieldMatches', () => {
  // A search that only DISPLAYS a field still consumes it; checking criteria alone
  // would report the field as unused.
  it('finds a displayed field', () => {
    expect(
      findDisplayFieldMatches([{ name: 'IP Address' }, { name: 'Home Directory Size (MB)' }], 'home directory'),
    ).toEqual(['Home Directory Size (MB)']);
  });

  it('returns nothing for an empty query or absent display fields', () => {
    expect(findDisplayFieldMatches([{ name: 'x' }], '')).toEqual([]);
    expect(findDisplayFieldMatches(undefined, 'home')).toEqual([]);
    expect(findDisplayFieldMatches([{}], 'home')).toEqual([]);
  });
});

describe('expandInventoryQuery', () => {
  // The bug this exists for: `package_receipts` is the setting key, but criteria
  // query the data as "Packages Installed" / "Cached Packages" — no substring
  // overlap, so searching the key alone returns zero whether or not consumers exist.
  it('adds the criterion names Jamf actually exposes for a setting key', () => {
    const e = expandInventoryQuery('package_receipts');
    expect(e.matchedSettingKey).toBe('package_receipts');
    expect(e.terms).toEqual(['package_receipts', 'Packages Installed', 'Cached Packages']);
    // Searching the key alone would have found nothing.
    expect(findCriterionMatches([{ name: 'Packages Installed', value: 'Widget' }], e.query)).toEqual([]);
    expect(
      e.terms.flatMap((t) => findCriterionMatches([{ name: 'Packages Installed', value: 'Widget' }], t)),
    ).toHaveLength(1);
  });

  it('keeps the query itself first, and normalises spacing and case to find the key', () => {
    for (const q of ['Package Receipts', 'package-receipts', '  PACKAGE_RECEIPTS  ']) {
      const e = expandInventoryQuery(q);
      expect(e.terms[0], q).toBe(q.trim());
      expect(e.terms, q).toContain('Cached Packages');
    }
  });

  it('returns only the query for free text that is not a setting key', () => {
    const e = expandInventoryQuery('Home Directory');
    expect(e.terms).toEqual(['Home Directory']);
    expect(e.aliases).toEqual([]);
    expect(e.matchedSettingKey).toBeUndefined();
    expect(e.hasUnconfirmedAliases).toBe(false);
  });

  it('expands the misspelled Jamf keys the same as the corrected spelling', () => {
    for (const pair of [
      ['inclue_applications', 'include_applications'],
      ['inclue_fonts', 'include_fonts'],
      ['inclue_plugins', 'include_plugins'],
    ]) {
      const [typo, fixed] = pair as [string, string];
      expect(expandInventoryQuery(typo).aliases, typo).toEqual(expandInventoryQuery(fixed).aliases);
      expect(expandInventoryQuery(typo).aliases.length, typo).toBeGreaterThan(0);
    }
  });

  it('flags a sweep that relied on a broad-substring guess', () => {
    expect(expandInventoryQuery('package_receipts').hasUnconfirmedAliases).toBe(false);
    expect(expandInventoryQuery('home_directory_sizes').hasUnconfirmedAliases).toBe(true);
  });

  it('returns no terms for an empty query rather than inventing one', () => {
    expect(expandInventoryQuery('   ').terms).toEqual([]);
    expect(expandInventoryQuery(null).terms).toEqual([]);
  });
});

describe('INVENTORY_SETTING_CRITERION_ALIASES', () => {
  // Presenting a guessed label as verified is the defect this guards. Only the
  // package_receipts pair has been seen in a live tenant; anything else claiming
  // `confirmed` was upgraded without checking.
  it('marks only the live-verified pair as confirmed', () => {
    const confirmed = Object.entries(INVENTORY_SETTING_CRITERION_ALIASES).flatMap(([key, aliases]) =>
      aliases.filter((a) => a.confidence === 'confirmed').map((a) => `${key}:${a.term}`),
    );
    expect(confirmed.sort()).toEqual(['package_receipts:Cached Packages', 'package_receipts:Packages Installed']);
  });

  // A setting the cost report names but the alias map omits is exactly the false-zero
  // case: the user reads the finding, searches the key, and gets "no references".
  it('covers every setting named by assessInventoryCollection', () => {
    const settingKeys = assessInventoryCollection({}).findings.flatMap((f) => f.setting.split(' / '));
    for (const key of settingKeys) {
      expect(INVENTORY_SETTING_CRITERION_ALIASES[key], `no criterion alias for ${key}`).toBeDefined();
    }
  });

  it('gives every alias a non-empty term and a stated confidence', () => {
    for (const [key, aliases] of Object.entries(INVENTORY_SETTING_CRITERION_ALIASES)) {
      expect(aliases.length, key).toBeGreaterThan(0);
      for (const alias of aliases) {
        expect(alias.term.trim(), key).not.toBe('');
        expect(['confirmed', 'broad-substring'], key).toContain(alias.confidence);
      }
    }
  });
});

describe('summarizeGroupCriteria', () => {
  it('renders criteria in order with joins, parentheses and quoted values', () => {
    const { criteria } = summarizeGroupCriteria([
      { name: 'Computer Group', search_type: 'member of', value: 'Compliance Required' },
      { name: 'Operating System Version', search_type: 'like', value: '26.', and_or: 'and', opening_paren: true },
      { name: 'Building', search_type: 'is', value: 'HQ', and_or: 'or', closing_paren: true },
    ]);
    expect(criteria.map((c) => c.line)).toEqual([
      'Computer Group member of "Compliance Required"',
      'and ( Operating System Version like "26."',
      'or Building is "HQ" )',
    ]);
    // The first line must carry no join — rendering one implies a rule above it.
    expect(criteria[0]?.join).toBeUndefined();
    expect(criteria[1]?.join).toBe('and');
  });

  // Found in a live tenant: a criterion written to mean "has failures" meant "is not
  // blank", so values like "Not in scope" satisfied it and every device with any value
  // counted as non-compliant.
  it('flags an unanchored regex, because it tests CONTAINS rather than EQUALS', () => {
    const { warnings } = summarizeGroupCriteria([
      { name: 'Failed Result List', search_type: 'matches regex', value: '(\\b[a-z0-9_\\-]+\\n?\\b)+' },
    ]);
    expect(warnings.map((w) => w.issue)).toContain(
      'unanchored regex — this matches any value CONTAINING a match, not the whole value',
    );
  });

  it('flags a lowercase-only class, since Jamf matches case-insensitively', () => {
    const { warnings } = summarizeGroupCriteria([
      { name: 'Failed Result List', search_type: 'matches regex', value: '^[a-z0-9_-]+$' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.issue).toContain('lowercase-only character class');
    // Phrased as something to verify, not as settled behaviour: a live tenant's member
    // counts implied case-SENSITIVE matching, contradicting the MySQL-default reasoning
    // this warning was originally written from.
    expect(warnings[0]?.issue).toContain('verify whether');
    expect(warnings[0]?.why).toContain('NOT settled');
  });

  it('stays silent on a regex that is anchored and case-explicit', () => {
    expect(
      summarizeGroupCriteria([{ name: 'x', search_type: 'matches regex', value: '^[a-zA-Z0-9]+$' }]).warnings,
    ).toEqual([]);
  });

  it('does not flag operators other than matches regex', () => {
    expect(
      summarizeGroupCriteria([{ name: 'x', search_type: 'like', value: 'EMPTY' }]).warnings,
    ).toEqual([]);
  });

  it('names an unnamed field and a missing operator rather than dropping the criterion', () => {
    const { criteria } = summarizeGroupCriteria([{ value: 'x' }]);
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.field).toBe('(unnamed)');
    expect(criteria[0]?.operator).toBe('(no operator)');
  });

  it('returns nothing for absent criteria rather than throwing', () => {
    expect(summarizeGroupCriteria(undefined)).toEqual({ criteria: [], warnings: [] });
    expect(summarizeGroupCriteria(null)).toEqual({ criteria: [], warnings: [] });
  });
});
