import { describe, expect, it } from 'vitest';

import { judgeAdrModification, splitStatus } from './adr-guard.js';

const record = (status: string) =>
  ['# JPM-0001: Something', '', status, '- **Date:** 2026-08-05', '', '## Context', '', 'Body.', ''].join('\n');

const before = record('- **Status:** Accepted');
const pointer = record(
  '- **Status:** Accepted; part 1 superseded by\n  [JPM-0002](JPM-0002-successor.md). Parts 2 and 3 stand.',
);
const existing = new Set(['JPM-0001-something.md', 'JPM-0002-successor.md']);
const judge = (after: string) => judgeAdrModification('decisions/JPM-0001-something.md', before, after, existing);

describe('splitStatus', () => {
  it('takes the Status bullet together with its wrapped continuation lines', () => {
    expect(splitStatus(pointer).status).toBe(
      '- **Status:** Accepted; part 1 superseded by\n  [JPM-0002](JPM-0002-successor.md). Parts 2 and 3 stand.',
    );
    expect(splitStatus(pointer).rest).toBe(splitStatus(before).rest);
  });
});

describe('judgeAdrModification', () => {
  // The edit decisions/README.md sanctions, which CI used to block outright.
  it('allows a Status-only edit that points at an existing successor', () => {
    expect(judge(pointer)).toEqual({ allowed: true });
  });

  it('refuses any change outside the Status line', () => {
    expect(judge(pointer.replace('Body.', 'Rewritten body.'))).toMatchObject({ allowed: false, reason: /outside/ });
  });

  it('refuses a Status change that does not say superseded', () => {
    expect(judge(record('- **Status:** Rejected'))).toMatchObject({ allowed: false, reason: /superseded/ });
  });

  it('refuses a pointer to a successor that does not exist', () => {
    expect(judge(pointer.replace('JPM-0002-successor.md', 'JPM-0009-imaginary.md'))).toMatchObject({
      allowed: false,
      reason: /does not exist/,
    });
  });

  it('refuses a Status that names no successor, or only itself', () => {
    expect(judge(record('- **Status:** Superseded'))).toMatchObject({ allowed: false, reason: /no successor/ });
    expect(judge(record('- **Status:** Superseded by [self](JPM-0001-something.md)'))).toMatchObject({
      allowed: false,
      reason: /no successor/,
    });
  });

  it('refuses removing the Status line', () => {
    expect(judge(record(''))).toMatchObject({ allowed: false });
  });
});
