import { describe, expect, it } from 'vitest';

import {
  classifyPolicyCadence,
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
