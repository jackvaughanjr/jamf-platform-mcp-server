import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from './config.js';
import { JamfPlatformClient } from './platform-client.js';
import type { WriteContext } from './restricted-software.js';
import {
  addComputerGroupToPolicyScope,
  addComputerGroupToProfileScope,
  buildScopeOnlyXml,
  differingSections,
  fingerprintNonScope,
  parseLiveScoped,
  removeComputerGroupFromPolicyScope,
  removeComputerGroupFromProfileScope,
  scopeMembershipInputSchema,
} from './scope-membership.js';

// Type-only fixtures with invented ids (JPM-0004): shapes mirror Classic JSON, values are made up.
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
    statusText: status === 404 ? 'Not Found' : 'OK',
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

function stub(...responses: Response[]) {
  fetchMock.mockResolvedValueOnce(res({ access_token: 'tok', expires_in: 900, token_type: 'Bearer' }));
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
}
const gatewayCalls = () =>
  fetchMock.mock.calls
    .filter((c) => !String(c[0]).endsWith('/auth/token'))
    .map((c) => ({ url: String(c[0]), init: c[1] as RequestInit }));
const puts = () => gatewayCalls().filter((c) => c.init.method === 'PUT');

const ctx = (writesEnabled = true): WriteContext => ({
  client: new JamfPlatformClient(config),
  writesEnabled,
  now: () => new Date('2026-11-04T12:00:00.000Z'),
});

const SECRET_MARKER = 'PAYLOAD-CONTENT-MARKER-XYZ';

function scopeBody(over: Record<string, unknown> = {}, exclusions: Record<string, unknown> = {}) {
  return {
    all_computers: false,
    computers: [],
    computer_groups: [{ id: 901, name: 'Existing group' }],
    buildings: [],
    departments: [],
    limitations: {
      users: [],
      user_groups: [],
      network_segments: [],
      ibeacons: [],
    },
    exclusions: {
      computers: [{ id: 801, name: 'Excluded Mac' }],
      computer_groups: [],
      buildings: [],
      departments: [],
      users: [],
      user_groups: [],
      network_segments: [],
      ibeacons: [],
      ...exclusions,
    },
    ...over,
  };
}

function profileBody(
  opts: {
    scope?: Record<string, unknown>;
    general?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  } = {},
) {
  return {
    os_x_configuration_profile: {
      general: {
        id: 501,
        name: 'Fixture profile',
        distribution_method: 'Install Automatically',
        redeploy_on_update: 'Newly Assigned',
        payloads: SECRET_MARKER,
        ...opts.general,
      },
      scope: opts.scope ?? scopeBody({ all_jss_users: false, jss_users: [], jss_user_groups: [] }),
      self_service: { use_for_self_service: false },
      ...opts.extra,
    },
  };
}

function policyBody(
  opts: {
    scope?: Record<string, unknown>;
    general?: Record<string, unknown>;
  } = {},
) {
  return {
    policy: {
      general: {
        id: 601,
        name: 'Fixture policy',
        enabled: true,
        ...opts.general,
      },
      scope: opts.scope ?? scopeBody({ limit_to_users: { user_groups: [] } }),
      scripts: [{ id: 1, name: 'script' }],
    },
  };
}

const groupBody = (name = 'New group', isSmart = true) => ({
  computer_group: { id: 902, name, is_smart: isSmart },
});
const input = { id: 501, computerGroupId: 902 };

describe('input schema', () => {
  it('is strict: rejects other fields, non-positive and non-integer ids', () => {
    expect(scopeMembershipInputSchema.safeParse({ ...input, extra: 1 }).success).toBe(false);
    expect(scopeMembershipInputSchema.safeParse({ id: 0, computerGroupId: 1 }).success).toBe(false);
    expect(scopeMembershipInputSchema.safeParse({ id: 1, computerGroupId: 1.5 }).success).toBe(false);
    expect(scopeMembershipInputSchema.safeParse({ ...input }).success).toBe(true);
  });
});

describe('parseLiveScoped', () => {
  it('reads profile scope inclusions and exclusions', () => {
    const live = parseLiveScoped(profileBody(), 'profile', 501);
    expect(live.scope.computerGroupIds).toEqual([901]);
    expect(live.scope.exclusions.computerIds).toEqual([801]);
    expect(live.unmodelledScope).toEqual([]);
    expect(live.redeployOnUpdate).toBe('Newly Assigned');
    expect(live.nonScope).not.toHaveProperty('scope');
  });

  it('reads policy scope, including buildings and departments', () => {
    const live = parseLiveScoped(
      policyBody({
        scope: scopeBody({
          buildings: [{ id: 701, name: 'b' }],
          departments: [{ id: 702, name: 'd' }],
        }),
      }),
      'policy',
      601,
    );
    expect(live.scope.buildingIds).toEqual([701]);
    expect(live.scope.departmentIds).toEqual([702]);
    expect(live.redeployOnUpdate).toBeUndefined();
  });

  it('throws on a scope or all_computers it cannot read', () => {
    expect(() => parseLiveScoped({ policy: { general: {} } }, 'policy', 1)).toThrow(/no scope/);
    expect(() => parseLiveScoped(policyBody({ scope: { computers: [] } }), 'policy', 1)).toThrow(/all_computers/);
  });

  it('flags every non-empty unmodelled scope member by name', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['all_jss_users', { all_jss_users: true }, 'scope.all_jss_users'],
      ['jss_users', { jss_users: [{ id: 1 }] }, 'scope.jss_users'],
      ['jss_user_groups', { jss_user_groups: [{ id: 1 }] }, 'scope.jss_user_groups'],
      ['limit_to_users', { limit_to_users: { user_groups: [{ id: 1 }] } }, 'scope.limit_to_users'],
      ['limitations', { limitations: { users: [{ id: 1 }] } }, 'scope.limitations'],
      ['unrecognised', { mystery_member: ['x'] }, 'scope.mystery_member'],
    ];
    for (const [name, over, path] of cases) {
      const live = parseLiveScoped(profileBody({ scope: scopeBody(over) }), 'profile', 501);
      expect(live.unmodelledScope, name).toContain(path);
    }
  });

  it('flags every non-empty unmodelled exclusion by name', () => {
    for (const key of ['users', 'user_groups', 'network_segments', 'ibeacons', 'jss_users', 'jss_user_groups']) {
      const live = parseLiveScoped(profileBody({ scope: scopeBody({}, { [key]: [{ id: 1 }] }) }), 'profile', 501);
      expect(live.unmodelledScope).toContain(`scope.exclusions.${key}`);
    }
  });
});

describe('buildScopeOnlyXml', () => {
  const live = parseLiveScoped(profileBody(), 'profile', 501);
  const scope = { ...live.scope, computerGroupIds: [901, 902] };

  it('matches the golden body', () => {
    expect(buildScopeOnlyXml('profile', scope)).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<os_x_configuration_profile>',
        '  <scope>',
        '    <all_computers>false</all_computers>',
        '    <computers/>',
        '    <computer_groups><computer_group><id>901</id></computer_group><computer_group><id>902</id></computer_group></computer_groups>',
        '    <buildings/>',
        '    <departments/>',
        '    <exclusions>',
        '      <computers><computer><id>801</id></computer></computers>',
        '      <computer_groups/>',
        '      <buildings/>',
        '      <departments/>',
        '    </exclusions>',
        '  </scope>',
        '</os_x_configuration_profile>',
      ].join('\n'),
    );
  });

  it('has exactly one top-level child and no payloads or general, for both kinds', () => {
    for (const kind of ['profile', 'policy'] as const) {
      const xml = buildScopeOnlyXml(kind, scope);
      expect(xml).not.toContain('payloads');
      expect(xml).not.toContain('<general');
      expect(xml).not.toContain('self_service');
      const root = kind === 'profile' ? 'os_x_configuration_profile' : 'policy';
      const inner = xml.split(`<${root}>`)[1].split(`</${root}>`)[0].trim();
      expect(inner.startsWith('<scope>') && inner.endsWith('</scope>')).toBe(true);
      expect(inner.match(/<scope>/g)).toHaveLength(1);
      // Everything between the single scope's tags is nested; nothing sits beside it.
      expect(inner.slice('<scope>'.length, -'</scope>'.length)).not.toContain('</scope>');
    }
  });

  it('round-trips exclusions of every modelled kind', () => {
    const rich = parseLiveScoped(
      profileBody({
        scope: scopeBody(
          { buildings: [{ id: 701, name: 'b' }] },
          {
            computer_groups: [{ id: 902, name: 'g' }],
            buildings: [{ id: 703, name: 'b' }],
            departments: [{ id: 704, name: 'd' }],
          },
        ),
      }),
      'profile',
      501,
    );
    const xml = buildScopeOnlyXml('profile', rich.scope);
    expect(xml).toContain('<buildings><building><id>701</id></building></buildings>');
    expect(xml).toMatch(
      /<exclusions>[\s\S]*<computer_groups><computer_group><id>902<\/id>[\s\S]*<departments><department><id>704</,
    );
  });
});

describe('refusals', () => {
  it('refuses a missing group (404) and writes nothing', async () => {
    stub(res(profileBody()), res('not found', 404));
    await expect(addComputerGroupToProfileScope(ctx(), { ...input, dryRun: false })).rejects.toThrow(/does not exist/);
    expect(puts()).toHaveLength(0);
  });

  it('refuses All Computers', async () => {
    stub(res(profileBody({ scope: scopeBody({ all_computers: true }) })), res(groupBody()));
    await expect(addComputerGroupToProfileScope(ctx(), input)).rejects.toThrow(/All Computers/);
  });

  it('refuses an unmodelled member, naming it', async () => {
    stub(
      res(
        policyBody({
          scope: scopeBody({ limitations: { network_segments: [{ id: 1 }] } }),
        }),
      ),
      res(groupBody()),
    );
    await expect(addComputerGroupToPolicyScope(ctx(), { id: 601, computerGroupId: 902 })).rejects.toThrow(
      /scope\.limitations/,
    );
  });

  it('refuses a duplicate add and an absent remove, for both kinds', async () => {
    stub(res(profileBody()), res(groupBody()));
    await expect(addComputerGroupToProfileScope(ctx(), { id: 501, computerGroupId: 901 })).rejects.toThrow(
      /already in/,
    );
    stub(res(policyBody()), res(groupBody()));
    await expect(
      removeComputerGroupFromPolicyScope(ctx(), {
        id: 601,
        computerGroupId: 902,
      }),
    ).rejects.toThrow(/not in/);
    expect(puts()).toHaveLength(0);
  });

  it('refuses a profile whose redeploy_on_update is anything but Newly Assigned', async () => {
    for (const value of ['Always', 'Newly Assigned and Updated', undefined]) {
      stub(res(profileBody({ general: { redeploy_on_update: value } })), res(groupBody()));
      await expect(addComputerGroupToProfileScope(ctx(), input)).rejects.toThrow(/Newly Assigned/);
    }
    expect(puts()).toHaveLength(0);
  });

  it('does not apply the redeploy rule to policies', async () => {
    stub(res(policyBody()), res(groupBody()));
    await expect(addComputerGroupToPolicyScope(ctx(), { id: 601, computerGroupId: 902 })).resolves.toMatchObject({
      dryRun: true,
    });
  });

  it('refuses a real write when writes are disabled, but still dry-runs', async () => {
    stub(res(profileBody()), res(groupBody()));
    await expect(addComputerGroupToProfileScope(ctx(false), { ...input, dryRun: false })).rejects.toThrow(
      /Writes are disabled/,
    );
    expect(puts()).toHaveLength(0);
    stub(res(profileBody()), res(groupBody()));
    await expect(addComputerGroupToProfileScope(ctx(false), input)).resolves.toMatchObject({ dryRun: true });
  });
});

describe('dry run', () => {
  it('reads only, and reports group, diff, warnings and XML', async () => {
    stub(
      res(
        profileBody({
          general: { distribution_method: 'Make Available in Self Service' },
          scope: scopeBody({}, { computer_groups: [{ id: 902, name: 'g' }] }),
        }),
      ),
      res(groupBody('Sample group', false)),
    );
    const r = await addComputerGroupToProfileScope(ctx(), input);

    expect(r).toMatchObject({
      dryRun: true,
      action: 'addComputerGroup',
      resource: 'osxconfigurationprofiles/id/501',
      id: 501,
      group: { id: 902, name: 'Sample group', isSmart: false },
      changes: [{ field: 'scope.computerGroupIds', before: [901], after: [901, 902] }],
    });
    expect(r.warnings.join(' ')).toMatch(/redeploy_on_update is "Newly Assigned"/);
    expect(r.warnings.join(' ')).toMatch(/Self Service/);
    expect(r.warnings.join(' ')).toMatch(/exclusions/);
    expect(r.xml).toContain('<computer_group><id>902</id></computer_group>');
    expect(gatewayCalls().map((c) => c.url)).toEqual([
      'https://us.api.jamfcloud.com/proclassic/osxconfigurationprofiles/id/501',
      'https://us.api.jamfcloud.com/proclassic/computergroups/id/902',
    ]);
    expect(puts()).toHaveLength(0);
  });
});

describe('live write', () => {
  it('PUTs the scope-only body, verifies by read-back, and reports other fields unchanged', async () => {
    const after = profileBody({
      scope: scopeBody({
        computer_groups: [
          { id: 901, name: 'a' },
          { id: 902, name: 'b' },
        ],
        all_jss_users: false,
      }),
    });
    stub(
      res(profileBody()),
      res(groupBody()),
      res('<os_x_configuration_profile><id>501</id></os_x_configuration_profile>', 201),
      res(after),
    );
    const r = await addComputerGroupToProfileScope(ctx(), {
      ...input,
      dryRun: false,
    });

    const put = puts()[0];
    expect(put.url).toBe('https://us.api.jamfcloud.com/proclassic/osxconfigurationprofiles/id/501');
    expect((put.init.headers as Record<string, string>)['Content-Type']).toBe('application/xml');
    expect(String(put.init.body)).not.toContain('payloads');
    if (r.dryRun) throw new Error('expected a live result');
    expect(r.verification).toMatchObject({ verified: true, mismatches: [] });
    expect(r.otherFieldsUnchanged).toBe(true);
    expect(r.differingSections).toEqual([]);
    expect(r.writtenAt).toBe('2026-11-04T12:00:00.000Z');
  });

  it('policies PUT to the policies route', async () => {
    const after = policyBody({
      scope: scopeBody({
        computer_groups: [
          { id: 901, name: 'a' },
          { id: 902, name: 'b' },
        ],
        limit_to_users: { user_groups: [] },
      }),
    });
    stub(res(policyBody()), res(groupBody()), res('', 201), res(after));
    const r = await addComputerGroupToPolicyScope(ctx(), {
      id: 601,
      computerGroupId: 902,
      dryRun: false,
    });
    expect(puts()[0].url).toBe('https://us.api.jamfcloud.com/proclassic/policies/id/601');
    expect(String(puts()[0].init.body)).toMatch(/^<\?xml[^>]*>\n<policy>\n {2}<scope>/);
    expect(r).toMatchObject({ otherFieldsUnchanged: true });
  });

  it('detects a scope mismatch on read-back', async () => {
    stub(res(profileBody()), res(groupBody()), res('', 201), res(profileBody())); // read-back still has only 901
    const r = await addComputerGroupToProfileScope(ctx(), {
      ...input,
      dryRun: false,
    });
    if (r.dryRun) throw new Error('expected a live result');
    expect(r.verification).toMatchObject({
      verified: false,
      mismatches: [{ field: 'scope.computerGroupIds', sent: [901, 902], stored: [901] }],
    });
  });

  it('detects a non-scope change and names the section, without leaking payload content', async () => {
    const changed = profileBody({
      general: { payloads: 'CHANGED-' + SECRET_MARKER },
      scope: scopeBody({
        computer_groups: [
          { id: 901, name: 'a' },
          { id: 902, name: 'b' },
        ],
        all_jss_users: false,
      }),
    });
    stub(res(profileBody()), res(groupBody()), res('', 201), res(changed));
    const r = await addComputerGroupToProfileScope(ctx(), {
      ...input,
      dryRun: false,
    });
    if (r.dryRun) throw new Error('expected a live result');
    expect(r.otherFieldsUnchanged).toBe(false);
    expect(r.differingSections).toEqual(['general']);
    const everything =
      JSON.stringify(r) +
      fetchMock.mock.calls.map((c) => String((c[1] as RequestInit | undefined)?.body ?? '')).join('') +
      vi.mocked(console.error).mock.calls.join('');
    expect(everything).not.toContain(SECRET_MARKER);
  });

  it('reports an unreadable read-back as unverified, not as success', async () => {
    stub(res(profileBody()), res(groupBody()), res('', 201), res('boom', 500));
    const r = await addComputerGroupToProfileScope(ctx(), {
      ...input,
      dryRun: false,
    });
    if (r.dryRun) throw new Error('expected a live result');
    expect(r.verification).toMatchObject({ verified: false });
    expect(r.otherFieldsUnchanged).toBe(false);
  });

  it('surfaces a PUT rejection as an error', async () => {
    stub(res(profileBody()), res(groupBody()), res('signed profile', 409));
    await expect(addComputerGroupToProfileScope(ctx(), { ...input, dryRun: false })).rejects.toThrow(/409/);
  });
});

describe('rollback is the inverse', () => {
  it('add returns remove, and remove returns add, for profiles and policies', async () => {
    const afterAdd = (b: ReturnType<typeof profileBody>) => b;
    stub(
      res(profileBody()),
      res(groupBody()),
      res('', 201),
      res(
        afterAdd(
          profileBody({
            scope: scopeBody({
              computer_groups: [{ id: 901 }, { id: 902 }],
              all_jss_users: false,
            }),
          }),
        ),
      ),
    );
    const a = await addComputerGroupToProfileScope(ctx(), {
      ...input,
      dryRun: false,
    });
    expect(a).toMatchObject({
      rollback: {
        tool: 'removeComputerGroupFromProfileScope',
        arguments: { id: 501, computerGroupId: 902, dryRun: false },
      },
    });

    stub(
      res(
        profileBody({
          scope: scopeBody({
            computer_groups: [{ id: 901 }, { id: 902 }],
            all_jss_users: false,
          }),
        }),
      ),
      res(groupBody()),
      res('', 201),
      res(profileBody()),
    );
    const r = await removeComputerGroupFromProfileScope(ctx(), {
      ...input,
      dryRun: false,
    });
    expect(r).toMatchObject({
      changes: [{ before: [901, 902], after: [901] }],
      rollback: {
        tool: 'addComputerGroupToProfileScope',
        arguments: { id: 501, computerGroupId: 902, dryRun: false },
      },
    });

    stub(
      res(policyBody()),
      res(groupBody()),
      res('', 201),
      res(
        policyBody({
          scope: scopeBody({
            computer_groups: [{ id: 901 }, { id: 902 }],
            limit_to_users: { user_groups: [] },
          }),
        }),
      ),
    );
    const p = await addComputerGroupToPolicyScope(ctx(), {
      id: 601,
      computerGroupId: 902,
      dryRun: false,
    });
    expect(p).toMatchObject({
      rollback: { tool: 'removeComputerGroupFromPolicyScope' },
    });
  });
});

describe('fingerprint', () => {
  it('is stable across key order and sensitive to any non-scope change', () => {
    const a = fingerprintNonScope({
      general: { a: 1, b: [1, 2] },
      self_service: { x: true },
    });
    const b = fingerprintNonScope({
      self_service: { x: true },
      general: { b: [1, 2], a: 1 },
    });
    expect(a).toEqual(b);
    const c = fingerprintNonScope({
      general: { a: 1, b: [1, 3] },
      self_service: { x: true },
    });
    expect(differingSections(a, c)).toEqual(['general']);
    expect(differingSections(a, fingerprintNonScope({ general: { a: 1, b: [1, 2] } }))).toEqual(['self_service']);
  });
});
