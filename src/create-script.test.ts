import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from './config.js';
import {
  buildScriptBody,
  compareScript,
  createScript,
  createScriptInputSchema,
  lineCount,
  parseHrefId,
  renderScriptRequest,
  validateScriptContents,
  type CreateScriptInput,
} from './create-script.js';
import { JamfPlatformApiError, JamfPlatformClient } from './platform-client.js';
import type { WriteContext } from './restricted-software.js';
import { digest, sanitizedWriteError, scrub } from './secret-material.js';

const config: Config = {
  clientId: 'id',
  clientSecret: 'secret',
  tenantId: 'TENANT',
  gatewayBaseUrl: 'https://us.api.jamfcloud.com',
  tokenUrl: 'https://us.api.jamfcloud.com/auth/token',
  readOnly: false,
};

function res(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 201 ? 'Created' : status === 404 ? 'Not Found' : status === 400 ? 'Bad Request' : 'OK',
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stub(...responses: Response[]) {
  fetchMock.mockResolvedValueOnce(res({ access_token: 'tok', expires_in: 900, token_type: 'Bearer' }));
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
}

function gatewayCalls() {
  return fetchMock.mock.calls
    .filter((c) => !String(c[0]).endsWith('/auth/token'))
    .map((c) => ({ url: String(c[0]), init: c[1] as RequestInit }));
}

const ctx = (writesEnabled = true): WriteContext => ({
  client: new JamfPlatformClient(config),
  writesEnabled,
  now: () => new Date('2026-11-05T12:00:00.000Z'),
});

/** A body that must never appear in any output. */
const SECRET_LINE = 'API_TOKEN="tok-deadbeef-0000-4000-8000-000000000001"';
const CONTENTS = `#!/bin/zsh --no-rcs\n# migrate a thing\n${SECRET_LINE}\nKEY="\${4}"\nexit 0\n`;

const input: CreateScriptInput = {
  name: 'Example: Migrate Something',
  categoryId: 2,
  priority: 'BEFORE',
  info: 'Moves a Mac to another workspace.',
  notes: 'Run before the installer.',
  parameterLabels: {
    parameter4: 'Workspace API key',
    parameter5: '',
    parameter6: '',
    parameter7: '',
    parameter8: '',
    parameter9: '',
    parameter10: '',
    parameter11: '',
  },
  osRequirements: '',
  scriptContents: CONTENTS,
};

const scriptsList = res({ scripts: [{ id: 1, name: 'Installer' }] });
const category = res({ category: { id: 2, name: 'Security', priority: 9 } });

function storedScript(overrides: Record<string, unknown> = {}) {
  return { id: '61', categoryName: 'Security', ...buildScriptBody(input), ...overrides };
}

describe('createScriptInputSchema', () => {
  it('rejects an unknown field rather than dropping it', () => {
    expect(createScriptInputSchema.safeParse({ ...input, enabled: true }).success).toBe(false);
  });

  it('requires every field, including each parameter label', () => {
    for (const key of ['name', 'categoryId', 'priority', 'info', 'notes', 'parameterLabels', 'osRequirements', 'scriptContents']) {
      const partial = { ...input } as Record<string, unknown>;
      delete partial[key];
      expect(createScriptInputSchema.safeParse(partial).success, key).toBe(false);
    }
    const labels = { ...input.parameterLabels } as Record<string, string>;
    delete labels.parameter11;
    expect(createScriptInputSchema.safeParse({ ...input, parameterLabels: labels }).success).toBe(false);
  });

  it('rejects parameter3 and parameter12 labels, a bad priority, and a padded name', () => {
    expect(createScriptInputSchema.safeParse({ ...input, parameterLabels: { ...input.parameterLabels, parameter3: 'x' } }).success).toBe(false);
    expect(createScriptInputSchema.safeParse({ ...input, parameterLabels: { ...input.parameterLabels, parameter12: 'x' } }).success).toBe(false);
    expect(createScriptInputSchema.safeParse({ ...input, priority: 'Before' }).success).toBe(false);
    expect(createScriptInputSchema.safeParse({ ...input, name: ' padded' }).success).toBe(false);
    expect(createScriptInputSchema.safeParse({ ...input, categoryId: 0 }).success).toBe(false);
    expect(createScriptInputSchema.safeParse({ ...input, categoryId: -1 }).success).toBe(true);
  });
});

describe('validateScriptContents', () => {
  it('refuses empty, shebang-less, CRLF and NUL contents', () => {
    expect(() => validateScriptContents('')).toThrow(/empty/);
    expect(() => validateScriptContents('echo hi\n')).toThrow(/#!/);
    expect(() => validateScriptContents('#!/bin/sh\r\necho hi\r\n')).toThrow(/carriage return/);
    expect(() => validateScriptContents('#!/bin/sh\n\u0000')).toThrow(/NUL/);
    expect(() => validateScriptContents(CONTENTS)).not.toThrow();
  });
});

describe('request body', () => {
  it('builds exactly the published Script fields, categoryId as a string', () => {
    expect(buildScriptBody(input)).toEqual({
      name: 'Example: Migrate Something',
      info: 'Moves a Mac to another workspace.',
      notes: 'Run before the installer.',
      priority: 'BEFORE',
      categoryId: '2',
      parameter4: 'Workspace API key',
      parameter5: '',
      parameter6: '',
      parameter7: '',
      parameter8: '',
      parameter9: '',
      parameter10: '',
      parameter11: '',
      osRequirements: '',
      scriptContents: CONTENTS,
    });
  });

  it('renders the contents as a digest only, never as text', () => {
    const shown = renderScriptRequest(buildScriptBody(input));
    expect(shown.body.scriptContents).toEqual({ ...digest(CONTENTS), lines: 5, shebang: '#!/bin/zsh --no-rcs' });
    expect(JSON.stringify(shown)).not.toContain(SECRET_LINE);
    expect(shown.body.parameter4).toBe('Workspace API key');
  });
});

describe('compareScript', () => {
  it('passes when every field and the contents hash match', () => {
    expect(compareScript(buildScriptBody(input), storedScript())).toEqual([]);
  });

  it('reports a contents difference by digest, never by text', () => {
    const mismatches = compareScript(buildScriptBody(input), storedScript({ scriptContents: `${CONTENTS}\n` }));
    expect(mismatches.map((m) => m.field)).toEqual(['scriptContents']);
    expect(mismatches[0]?.sent).toEqual(digest(CONTENTS));
    expect(JSON.stringify(mismatches)).not.toContain(SECRET_LINE);
  });

  it('reports a changed label or category and an absent field', () => {
    const stored = storedScript({ parameter4: 'Other', categoryId: '-1' }) as Record<string, unknown>;
    delete stored.notes;
    expect(compareScript(buildScriptBody(input), stored).map((m) => m.field).sort()).toEqual(['categoryId', 'notes', 'parameter4']);
  });

  it('accepts a numeric categoryId from Jamf', () => {
    expect(compareScript(buildScriptBody(input), storedScript({ categoryId: 2 }))).toEqual([]);
  });
});

describe('createScript', () => {
  it('defaults to a dry run: reads, writes nothing, hides the contents', async () => {
    stub(scriptsList, category);
    const result = await createScript(ctx(), input);
    expect(result.dryRun).toBe(true);
    expect(result.category).toEqual({ id: 2, name: 'Security' });
    expect(gatewayCalls().every((c) => (c.init.method ?? 'GET') === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET_LINE);
  });

  it('warns when the script reads a parameter that has no label', async () => {
    stub(scriptsList, category);
    const result = await createScript(ctx(), { ...input, parameterLabels: { ...input.parameterLabels, parameter4: '' } });
    expect(result.warnings.join(' ')).toMatch(/reads \$4 but parameter4 has no label/);
  });

  it('refuses a name that already exists, case-insensitively', async () => {
    stub(res({ scripts: [{ id: 900, name: 'example: migrate something' }] }));
    await expect(createScript(ctx(), input)).rejects.toThrow(/already exists \(id 900\)/);
  });

  it('refuses a category that does not exist', async () => {
    stub(scriptsList, res('Not Found', 404));
    await expect(createScript(ctx(), input)).rejects.toThrow(/Category 2 does not exist/);
  });

  it('refuses a live write when writes are disabled, after the reads', async () => {
    stub(scriptsList, category);
    await expect(createScript(ctx(false), { ...input, dryRun: false })).rejects.toThrow(/Writes are disabled/);
    expect(gatewayCalls()).toHaveLength(2);
  });

  it('POSTs JSON to /pro/v1/scripts, reads back, and verifies by hash', async () => {
    stub(scriptsList, category, res({ id: '61', href: 'https://example.invalid/api/v1/scripts/61' }, 201), res(storedScript()));
    const result = await createScript(ctx(), { ...input, dryRun: false });
    const calls = gatewayCalls();
    expect(calls[2]?.url).toBe('https://us.api.jamfcloud.com/pro/v1/scripts');
    expect(calls[2]?.init.method).toBe('POST');
    expect((calls[2]?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual(buildScriptBody(input));
    expect(calls[3]?.url).toBe('https://us.api.jamfcloud.com/pro/v1/scripts/61');
    expect(result).toMatchObject({ dryRun: false, id: 61, verification: { verified: true, mismatches: [] } });
    expect(JSON.stringify(result)).not.toContain(SECRET_LINE);
    for (const call of stderr.mock.calls) expect(String(call[0])).not.toContain(SECRET_LINE);
  });

  it('reports unverified when the stored contents differ', async () => {
    stub(scriptsList, category, res({ id: '61' }, 201), res(storedScript({ scriptContents: '#!/bin/sh\n' })));
    const result = await createScript(ctx(), { ...input, dryRun: false });
    expect(result.verification).toMatchObject({ verified: false });
    expect(JSON.stringify(result)).not.toContain(SECRET_LINE);
  });

  it('finds the id by name when the create response carries none', async () => {
    stub(
      scriptsList,
      category,
      res('', 201),
      res({ scripts: [{ id: 1, name: 'Installer' }, { id: 61, name: input.name }] }),
      res(storedScript()),
    );
    const result = await createScript(ctx(), { ...input, dryRun: false });
    expect(result).toMatchObject({ id: 61, verification: { verified: true } });
  });

  it('scrubs the contents out of a failed create error', async () => {
    stub(scriptsList, category, res({ httpStatus: 400, errors: [{ code: 'INVALID', description: `bad: ${SECRET_LINE}` }] }, 400));
    const error = await createScript(ctx(), { ...input, dryRun: false }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(JamfPlatformApiError);
    expect((error as Error).message).toMatch(/400/);
    expect((error as Error).message).not.toContain(SECRET_LINE);
    expect((error as Error).message).toContain('[redacted]');
  });
});

describe('lineCount', () => {
  it('counts lines as wc -l does, plus an unterminated last line', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('a\nb\n')).toBe(2);
    expect(lineCount('a\nb')).toBe(2);
  });
});

describe('parseHrefId', () => {
  it('reads the string id of an HrefResponse', () => {
    expect(parseHrefId({ id: '61', href: 'x' })).toBe(61);
    expect(parseHrefId({ href: 'x' })).toBeUndefined();
    expect(parseHrefId('')).toBeUndefined();
  });
});

describe('secret material', () => {
  it('scrubs a value as sent, XML-escaped and JSON-escaped, and its long lines', () => {
    const value = 'a<b>&"c" secret-value\nsecond line long enough';
    const xml = 'a&lt;b&gt;&amp;&quot;c&quot; secret-value';
    const text = `raw ${value} xml ${xml} json ${JSON.stringify(value)} line second line long enough`;
    const out = scrub(text, [value]);
    expect(out).not.toContain('secret-value');
    expect(out).not.toContain('second line long enough');
  });

  it('never scrubs on an empty value', () => {
    expect(scrub('unchanged', [''])).toBe('unchanged');
  });

  it('turns an API error into a plain error without the raw body', () => {
    const api = new JamfPlatformApiError('POST x failed (409 Conflict)', 409, 'https://example.invalid/x', '<p>bad value hunter2-long-secret</p>');
    const error = sanitizedWriteError(api, ['hunter2-long-secret'], 'The create failed.');
    expect(error).not.toBeInstanceOf(JamfPlatformApiError);
    expect(error.message).toContain('409');
    expect(error.message).not.toContain('hunter2-long-secret');
    expect(error.message).not.toContain('<p>');
  });
});
