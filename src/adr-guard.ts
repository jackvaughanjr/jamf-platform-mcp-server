#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * CI's guard on committed ADRs.
 *
 * Committed ADRs are immutable, with one exception decisions/README.md sanctions:
 * pointing a record's Status at the ADR that supersedes it. The local hook allows
 * that through `ADR_ALLOW_EDIT=1`, a human's assertion. CI has nobody to assert it,
 * so it had no exception at all, and the pointer the rules require could never
 * merge. This checks the exception mechanically instead: a change that touches
 * nothing but the Status bullet, and leaves it naming an existing successor.
 *
 * The other override, editing a record that has no external readers yet, cannot be
 * checked by a machine and stays local-only. Deletes and renames are never allowed.
 */

const STATUS_LINE = /^- \*\*Status:\*\*/;

/** Splits a record into its Status bullet (with continuation lines) and everything else. */
export function splitStatus(text: string): { status: string; rest: string } {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => STATUS_LINE.test(l));
  if (start === -1) return { status: '', rest: text };
  let end = start + 1;
  // A wrapped bullet continues on lines indented by two spaces.
  while (end < lines.length && /^ {2}\S/.test(lines[end] ?? '')) end += 1;
  return {
    status: lines.slice(start, end).join('\n'),
    rest: [...lines.slice(0, start), ...lines.slice(end)].join('\n'),
  };
}

export type AdrChangeVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether a modification to a committed ADR is the sanctioned superseded-by pointer.
 *
 * `existingRecords` is the set of record filenames on the head commit, so the
 * successor must actually exist rather than merely be spelled like one.
 */
export function judgeAdrModification(
  file: string,
  before: string,
  after: string,
  existingRecords: ReadonlySet<string>,
): AdrChangeVerdict {
  const b = splitStatus(before);
  const a = splitStatus(after);
  if (!a.status) return { allowed: false, reason: 'the edit removed the Status line' };
  if (b.rest !== a.rest) return { allowed: false, reason: 'text outside the Status line changed' };
  if (b.status === a.status) return { allowed: false, reason: 'no change to the Status line' };
  if (!/superseded/i.test(a.status)) {
    return { allowed: false, reason: 'the new Status does not say the record is superseded' };
  }
  const self = file.split('/').pop() ?? file;
  const successors = [...a.status.matchAll(/([A-Z]+-\d{4}-[a-z0-9-]+\.md)/g)]
    .map((m) => m[1] ?? '')
    .filter((f) => f !== '' && f !== self);
  if (successors.length === 0) return { allowed: false, reason: 'the new Status links no successor record' };
  const missing = successors.filter((f) => !existingRecords.has(f));
  if (missing.length > 0) return { allowed: false, reason: `the linked successor does not exist: ${missing.join(', ')}` };
  return { allowed: true };
}

const ADR_PATHSPEC = 'decisions/[A-Z]*-[0-9][0-9][0-9][0-9]-*.md';

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/** CLI: `node dist/adr-guard.js <base-ref>`. Exits 1 on any change it cannot sanction. */
export function main(base: string): number {
  const mergeBase = git('merge-base', base, 'HEAD').trim();
  const changes = git('diff', '--name-status', `${mergeBase}...HEAD`, '--diff-filter=MDR', '--', ADR_PATHSPEC)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status = '', path = ''] = l.split('\t');
      return [status, path] as const;
    });
  const existing = new Set(
    git('ls-tree', '--name-only', 'HEAD', 'decisions/')
      .split('\n')
      .filter(Boolean)
      .map((p) => p.split('/').pop() as string),
  );

  let failed = false;
  for (const [status, path] of changes) {
    if (!status.startsWith('M')) {
      console.error(`::error::${path}: a committed ADR was ${status.startsWith('D') ? 'deleted' : 'renamed'}.`);
      failed = true;
      continue;
    }
    const verdict = judgeAdrModification(path, git('show', `${mergeBase}:${path}`), git('show', `HEAD:${path}`), existing);
    if (verdict.allowed) {
      console.log(`${path}: Status-only superseded-by pointer, allowed.`);
    } else {
      console.error(`::error::${path}: a committed ADR was modified (${verdict.reason}).`);
      failed = true;
    }
  }
  if (failed) {
    console.error(
      'Committed ADRs are immutable. Supersede with a new record instead; the only edit CI allows is a ' +
        'Status line pointing at an existing successor. See decisions/README.md.',
    );
  }
  return failed ? 1 : 0;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const base = process.argv[2];
  if (!base) {
    console.error('usage: adr-guard <base-ref>');
    process.exit(2);
  }
  process.exit(main(base));
}
