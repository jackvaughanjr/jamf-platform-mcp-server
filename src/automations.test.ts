import { describe, expect, it } from 'vitest';

import {
  assessInventoryCollection,
  classifyPolicyCadence,
  extractClassicDetail,
  extractClassicList,
  mapWithConcurrency,
  scanForExpensiveCommands,
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
});
