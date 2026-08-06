/**
 * Enforces the repo's own conventions, so contributions stay compliant without
 * anyone remembering to check.
 *
 * These are the things that drifted repeatedly during initial development: the
 * README test-count badge, the ADR index, and stale references to superseded
 * decisions. Each was fixed by hand several times, which is the signal that it
 * should be a test.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('ADR conventions', () => {
  const adrFiles = readdirSync(join(ROOT, 'decisions'))
    .filter((f) => /^[A-Z]+-\d{4}-.*\.md$/.test(f))
    .sort();

  it('has at least one decision record', () => {
    expect(adrFiles.length).toBeGreaterThan(0);
  });

  it('uses the JPM- prefix and four-digit sequential numbering with no gaps', () => {
    const numbers = adrFiles.map((f) => {
      expect(f).toMatch(/^JPM-\d{4}-/);
      return Number(f.slice(4, 8));
    });
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  // An index that silently omits a record is worse than no index — a reader
  // concludes the decision does not exist.
  it('indexes every record in decisions/README.md', () => {
    const index = read('decisions/README.md');
    for (const file of adrFiles) {
      expect(index, `decisions/README.md does not link ${file}`).toContain(file);
    }
  });

  it('gives every record a Status line', () => {
    for (const file of adrFiles) {
      expect(read(`decisions/${file}`), `${file} has no Status`).toMatch(/^- \*\*Status:\*\*/m);
    }
  });

  // A superseded record must point at its successor, or a reader acts on a
  // conclusion the project has already retracted.
  it('makes every superseded record name its successor', () => {
    for (const file of adrFiles) {
      const body = read(`decisions/${file}`);
      if (!/Superseded/i.test(body)) continue;
      expect(body, `${file} says Superseded but links no successor`).toMatch(/JPM-\d{4}-[a-z0-9-]+\.md/);
    }
  });
});

describe('README claims match reality', () => {
  const readme = read('README.md');

  // Hand-maintained six times during initial development, wrong twice.
  it('states the actual test count in the badge', () => {
    const badge = readme.match(/tests-(\d+)%20passing/);
    expect(badge, 'README has no test-count badge').not.toBeNull();
    const claimed = Number(badge?.[1]);

    const testFiles = readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.test.ts'));
    const actual = testFiles.reduce((sum, f) => {
      // Counts `it(` occurrences; close enough to catch drift, and it fails loudly
      // rather than silently tolerating a stale number.
      const matches = read(`src/${f}`).match(/^\s*it\(/gm);
      return sum + (matches?.length ?? 0);
    }, 0);

    expect(claimed, `README badge says ${claimed} tests, source defines ${actual}`).toBe(actual);
  });

  it('does not cite a superseded ADR as current guidance', () => {
    const superseded = readdirSync(join(ROOT, 'decisions'))
      .filter((f) => /^JPM-\d{4}-/.test(f))
      .filter((f) => /^- \*\*Status:\*\* Superseded/im.test(read(`decisions/${f}`)));

    for (const file of superseded) {
      const id = file.slice(0, 8);
      // Naming it is fine — the README explains the correction. Linking it as the
      // authority is not.
      const linkedAsGuidance = new RegExp(`see \\[${id}\\]`, 'i').test(readme);
      expect(linkedAsGuidance, `README cites superseded ${id} as guidance`).toBe(false);
    }
  });
});

// JPM-0007: the passthrough must not be able to express a mutation. Asserted on the
// source rather than the running server because the point is that no write verb is
// *offered* — a runtime check would only prove the current default, not the surface.
// Checks for the verb literals rather than a `method:` key, since the handler pins
// `method: 'GET'` and that must keep passing.
describe('platformRequest cannot express a write', () => {
  it('offers no write verb in the passthrough tool', () => {
    const source = read('src/index.ts');
    const start = source.indexOf("'platformRequest'");
    expect(start, 'platformRequest registration not found').toBeGreaterThan(-1);
    // The block ends where the next tool registration begins.
    const end = source.indexOf('server.registerTool(', start);
    const block = source.slice(start, end === -1 ? undefined : end);

    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(
        block,
        `platformRequest mentions ${verb}. Writes go through typed tools, never the ` +
          'passthrough — see decisions/JPM-0007-write-path-posture.md.',
      ).not.toContain(`'${verb}'`);
    }
  });
});

describe('data-handling invariants', () => {
  it('keeps captured responses and the real .env.op out of version control', () => {
    const ignore = read('.gitignore');
    for (const path of ['fixtures/raw/', '.env']) {
      expect(ignore, `.gitignore must cover ${path}`).toContain(path);
    }
    // Only the templates are tracked.
    expect(ignore).toContain('!.env.op.example');
    expect(ignore).not.toMatch(/^!\.env\.op$/m);
  });

  it('wires both guards into the pre-commit hook', () => {
    const hook = read('.githooks/pre-commit');
    expect(hook).toContain('check-adr-immutability.sh');
    expect(hook).toContain('check-no-identifiers.sh');
  });
});
