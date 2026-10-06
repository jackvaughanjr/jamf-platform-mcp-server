import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from './config.js';
import { JamfPlatformClient } from './platform-client.js';
import {
  buildRestrictedSoftwareXml,
  createRestrictedSoftware,
  generalCreateSchema,
  normalizeScope,
  parseCreatedId,
  parseLiveRestrictedSoftware,
  scopeInputSchema,
  updateRestrictedSoftware,
  validateGeneral,
  type RestrictedSoftwareGeneral,
  type WriteContext,
} from './restricted-software.js';

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
    statusText: status === 201 ? 'Created' : 'OK',
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Answers the token request, then each gateway call in order. */
function stub(...responses: Response[]) {
  fetchMock.mockResolvedValueOnce(res({ access_token: 'tok', expires_in: 900, token_type: 'Bearer' }));
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
}

/** Gateway calls only, token request excluded. */
function gatewayCalls() {
  return fetchMock.mock.calls
    .filter((c) => !String(c[0]).endsWith('/auth/token'))
    .map((c) => ({ url: String(c[0]), init: c[1] as RequestInit }));
}

const ctx = (writesEnabled = true): WriteContext => ({
  client: new JamfPlatformClient(config),
  writesEnabled,
  now: () => new Date('2026-10-06T12:00:00.000Z'),
});

const general: RestrictedSoftwareGeneral = {
  name: 'Block full installers',
  processName: 'Install macOS',
  matchExactProcessName: false,
  sendNotification: true,
  killProcess: true,
  deleteExecutable: true,
  displayMessage: 'Upgrades are managed by IT.',
};

/** A live entry in Classic JSON's shape: lists of {id, name}, not the schema's wrappers. */
function liveBody(overrides: { general?: Record<string, unknown>; scope?: Record<string, unknown> } = {}) {
  return {
    restricted_software: {
      general: {
        id: 7,
        name: 'Block full installers',
        process_name: 'Install macOS',
        match_exact_process_name: false,
        send_notification: true,
        kill_process: true,
        delete_executable: true,
        display_message: 'Upgrades are managed by IT.',
        site: { id: -1, name: 'None' },
        ...overrides.general,
      },
      scope: {
        all_computers: false,
        computers: [],
        computer_groups: [{ id: 12, name: 'Deferral group' }],
        buildings: [],
        departments: [],
        exclusions: { computers: [{ id: 3, name: 'IT Mac' }], computer_groups: [], buildings: [], departments: [], users: [] },
        ...overrides.scope,
      },
    },
  };
}

const listBody = (...entries: Array<{ id: number; name: string }>) => ({ restricted_software: entries });

describe('buildRestrictedSoftwareXml', () => {
  const scope = normalizeScope({ allComputers: false, computerGroupIds: [12], exclusions: { computerIds: [3] } });

  // The prior art put these at the top level and called the name display_name; Jamf answered 409.
  it('nests the settings under <general> and names the field <name>', () => {
    const xml = buildRestrictedSoftwareXml(general, scope);
    expect(xml).toMatch(/<restricted_software>\s*<general>\s*<name>Block full installers<\/name>/);
    expect(xml).not.toContain('display_name');
    expect(xml).toContain('<match_exact_process_name>false</match_exact_process_name>');
  });

  it('writes the scope it was given, and never all_computers true unless asked', () => {
    const xml = buildRestrictedSoftwareXml(general, scope);
    expect(xml).toContain('<all_computers>false</all_computers>');
    expect(xml).toContain('<computer_groups><computer_group><id>12</id></computer_group></computer_groups>');
    expect(xml).toMatch(/<exclusions>[\s\S]*<computers><computer><id>3<\/id><\/computer><\/computers>/);
  });

  // A replacement scope must clear lists the caller left empty, not leave them as they were.
  it('emits empty lists explicitly when a scope is sent', () => {
    expect(buildRestrictedSoftwareXml(general, scope)).toContain('<buildings/>');
  });

  it('omits <scope> entirely when none is given, so an update cannot touch it', () => {
    expect(buildRestrictedSoftwareXml(general)).not.toContain('<scope>');
  });

  it('escapes XML metacharacters in free text', () => {
    const xml = buildRestrictedSoftwareXml({ ...general, displayMessage: 'Ask <IT> & "wait"' });
    expect(xml).toContain('Ask &lt;IT&gt; &amp; &quot;wait&quot;');
  });
});

describe('input rules', () => {
  // The prior art defaulted scope to all computers. Here there is no default to fall back on.
  it('requires allComputers to be stated', () => {
    expect(scopeInputSchema.safeParse({ computerGroupIds: [12] }).success).toBe(false);
  });

  it('requires every general boolean to be stated on create', () => {
    const { killProcess: _omitted, ...rest } = general;
    expect(generalCreateSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an unknown key rather than ignoring it', () => {
    expect(scopeInputSchema.safeParse({ allComputers: false, groupIds: [12] }).success).toBe(false);
  });

  it('rejects allComputers combined with inclusion targets as ambiguous', () => {
    expect(() => normalizeScope({ allComputers: true, computerGroupIds: [12] })).toThrow(/ambiguous/);
  });

  it('refuses a short process name under substring matching', () => {
    expect(() => validateGeneral({ ...general, processName: 'app' })).toThrow(/shorter than/);
    expect(() => validateGeneral({ ...general, processName: 'app', matchExactProcessName: true })).not.toThrow();
  });
});

describe('parseLiveRestrictedSoftware', () => {
  it('reads Classic JSON lists of {id, name}', () => {
    const live = parseLiveRestrictedSoftware(liveBody(), 7);
    expect(live.general.processName).toBe('Install macOS');
    expect(live.scope.computerGroupIds).toEqual([12]);
    expect(live.scope.exclusions.computerIds).toEqual([3]);
    expect(live.unmodelledScope).toEqual([]);
  });

  it("also reads the published schema's wrapped {computer_group: {id}} items", () => {
    const live = parseLiveRestrictedSoftware(
      liveBody({ scope: { computer_groups: [{ computer_group: { id: 12, name: 'x' } }] } }),
      7,
    );
    expect(live.scope.computerGroupIds).toEqual([12]);
  });

  it('flags non-empty scope members it does not model, and ignores empty ones', () => {
    const live = parseLiveRestrictedSoftware(
      liveBody({
        scope: {
          limitations: { network_segments: [], users: [{ id: 1, name: 'someone' }] },
          exclusions: { computers: [], users: [{ id: 2, name: 'someone' }], user_groups: [] },
        },
      }),
      7,
    );
    expect(live.unmodelledScope).toEqual(['scope.limitations', 'scope.exclusions.users']);
  });

  // Update writes the merged result back, so a guessed value would be written as fact.
  it('throws on a setting it cannot read rather than defaulting it', () => {
    expect(() => parseLiveRestrictedSoftware(liveBody({ general: { kill_process: undefined } }), 7)).toThrow(/kill_process/);
  });

  it('throws on a scope item with no readable id', () => {
    expect(() => parseLiveRestrictedSoftware(liveBody({ scope: { computer_groups: [{ name: 'x' }] } }), 7)).toThrow(
      /cannot read an id/,
    );
  });
});

describe('parseCreatedId', () => {
  it('reads the Classic XML create response and a JSON one', () => {
    expect(parseCreatedId('<?xml version="1.0"?><restricted_software><id>42</id></restricted_software>')).toBe(42);
    expect(parseCreatedId({ restricted_software: { id: 42 } })).toBe(42);
    expect(parseCreatedId('')).toBeUndefined();
  });
});

describe('createRestrictedSoftware', () => {
  const input = {
    general,
    scope: { allComputers: false, computerGroupIds: [12], exclusions: { computerIds: [3] } },
  };

  it('is a dry run by default: reads only, and returns the XML and the diff', async () => {
    stub(res(listBody()));
    const result = await createRestrictedSoftware(ctx(), input);

    expect(result.dryRun).toBe(true);
    expect(result.xml).toContain('<computer_group><id>12</id></computer_group>');
    expect(result.changes).toContainEqual({ field: 'scope.computerGroupIds', before: undefined, after: [12] });
    expect(gatewayCalls().every((c) => (c.init.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('refuses a name that already exists', async () => {
    stub(res(listBody({ id: 7, name: 'block FULL installers ' })));
    await expect(createRestrictedSoftware(ctx(), { ...input, dryRun: false })).rejects.toThrow(/already exists \(id 7\)/);
    expect(gatewayCalls()).toHaveLength(1);
  });

  it('refuses a real write under JAMF_READ_ONLY before sending anything', async () => {
    stub(res(listBody()));
    await expect(createRestrictedSoftware(ctx(false), { ...input, dryRun: false })).rejects.toThrow(/Writes are disabled/);
    expect(gatewayCalls().some((c) => c.init.method === 'POST')).toBe(false);
  });

  it('POSTs XML to the Classic create route, then verifies by reading back', async () => {
    stub(
      res(listBody()),
      res('<?xml version="1.0"?><restricted_software><id>42</id></restricted_software>', 201),
      res(liveBody()),
    );
    const result = await createRestrictedSoftware(ctx(), { ...input, dryRun: false });

    const post = gatewayCalls()[1];
    expect(post.url).toBe('https://us.api.jamfcloud.com/proclassic/restrictedsoftware/id/0');
    expect(post.init.method).toBe('POST');
    expect((post.init.headers as Record<string, string>)['Content-Type']).toBe('application/xml');
    expect(String(post.init.body)).toContain('<all_computers>false</all_computers>');

    expect(result).toMatchObject({ dryRun: false, id: 42, writtenAt: '2026-10-06T12:00:00.000Z' });
    expect(result.verification).toMatchObject({ verified: true, mismatches: [] });
    expect(result.rollback?.arguments).toEqual({ id: 42, scope: { allComputers: false }, dryRun: false });
  });

  it('reports a field Jamf stored differently from what was sent', async () => {
    stub(
      res(listBody()),
      res('<restricted_software><id>42</id></restricted_software>', 201),
      res(liveBody({ scope: { all_computers: true, computer_groups: [] } })),
    );
    const result = await createRestrictedSoftware(ctx(), { ...input, dryRun: false });

    expect(result.verification?.verified).toBe(false);
    expect(result.verification).toMatchObject({
      mismatches: expect.arrayContaining([{ field: 'scope.allComputers', sent: false, stored: true }]),
    });
  });
});

describe('updateRestrictedSoftware', () => {
  // The prior art's update reset scope to all computers and every omitted setting to a default.
  it('sends the live settings back with only the passed field changed, and no <scope>', async () => {
    stub(res(liveBody()), res('', 201), res(liveBody({ general: { display_message: 'New text' } })));
    const result = await updateRestrictedSoftware(ctx(), { id: 7, general: { displayMessage: 'New text' }, dryRun: false });

    const put = gatewayCalls()[1];
    expect(put.url).toBe('https://us.api.jamfcloud.com/proclassic/restrictedsoftware/id/7');
    expect(put.init.method).toBe('PUT');
    const body = String(put.init.body);
    expect(body).not.toContain('<scope>');
    expect(body).toContain('<kill_process>true</kill_process>');
    expect(body).toContain('<display_message>New text</display_message>');

    expect('changes' in result && result.changes).toEqual([
      { field: 'general.displayMessage', before: 'Upgrades are managed by IT.', after: 'New text' },
    ]);
    expect('rollback' in result && result.rollback?.arguments).toEqual({
      id: 7,
      general: { displayMessage: 'Upgrades are managed by IT.' },
      dryRun: false,
    });
  });

  it('writes nothing when the requested values already match', async () => {
    stub(res(liveBody()));
    const result = await updateRestrictedSoftware(ctx(), { id: 7, general: { killProcess: true }, dryRun: false });
    expect(result).toMatchObject({ noChange: true });
    expect(gatewayCalls()).toHaveLength(1);
  });

  it('replaces the scope in full when one is passed, with the prior scope as rollback', async () => {
    stub(res(liveBody()), res('', 201), res(liveBody({ scope: { computer_groups: [], exclusions: {} } })));
    const result = await updateRestrictedSoftware(ctx(), { id: 7, scope: { allComputers: false }, dryRun: false });

    const body = String(gatewayCalls()[1].init.body);
    expect(body).toContain('<computer_groups/>');
    expect('rollback' in result && result.rollback?.arguments).toMatchObject({
      id: 7,
      scope: { allComputers: false, computerGroupIds: [12], exclusions: { computerIds: [3] } },
    });
  });

  it('refuses to replace a live scope holding members it cannot represent', async () => {
    stub(res(liveBody({ scope: { limitations: { users: [{ id: 1, name: 'someone' }] } } })));
    await expect(updateRestrictedSoftware(ctx(), { id: 7, scope: { allComputers: false }, dryRun: false })).rejects.toThrow(
      /scope\.limitations/,
    );
    expect(gatewayCalls()).toHaveLength(1);
  });

  it('still allows a general-only update on such an entry, since scope is not sent', async () => {
    stub(res(liveBody({ scope: { limitations: { users: [{ id: 1, name: 'someone' }] } } })));
    const result = await updateRestrictedSoftware(ctx(), { id: 7, general: { sendNotification: false } });
    expect(result).toMatchObject({ dryRun: true, scopeSent: false });
  });

  it('validates a changed process name, but not an untouched one', async () => {
    stub(res(liveBody()));
    await expect(updateRestrictedSoftware(ctx(), { id: 7, general: { processName: 'app' } })).rejects.toThrow(/shorter than/);

    // An entry created in the UI with a short substring can still have its message edited.
    stub(res(liveBody({ general: { process_name: 'app' } })));
    const result = await updateRestrictedSoftware(ctx(), { id: 7, general: { displayMessage: 'x' } });
    expect(result).toMatchObject({ dryRun: true });
  });
});
