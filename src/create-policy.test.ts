import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from './config.js';
import {
  buildPolicyXml,
  comparePolicy,
  createPolicy,
  createPolicyInputSchema,
  parsePolicyCreatedId,
  realParameter,
  shownParameter,
  validatePolicyInput,
  type CreatePolicyInput,
} from './create-policy.js';
import { JamfPlatformApiError, JamfPlatformClient } from './platform-client.js';
import type { WriteContext } from './restricted-software.js';
import { digest } from './secret-material.js';

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
    statusText: status === 201 ? 'Created' : status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'OK',
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

const SECRET = 'api-key-deadbeef-0000-4000-8000-000000000001';
const empty = { parameter5: '', parameter6: '', parameter7: '', parameter8: '', parameter9: '', parameter10: '', parameter11: '' };

const input: CreatePolicyInput = {
  general: {
    name: 'Example: Migrate [installomator]',
    categoryId: 2,
    triggers: { checkin: true, enrollmentComplete: false, login: false, networkStateChanged: false, startup: false, other: '' },
    frequency: 'Once per computer',
    retry: { event: 'check-in', attempts: 10, notifyOnEachFailedRetry: false },
  },
  scope: { computerIds: [900], computerGroupIds: [], exclusions: { computerIds: [], computerGroupIds: [] } },
  scripts: [
    { id: 901, priority: 'Before', parameter4: SECRET, ...empty },
    { id: 1, priority: 'After', ...empty, parameter4: 'examplelabel', parameter5: 'DEBUG=0', parameter6: 'NOTIFY=silent' },
  ],
  maintenance: { recon: true },
  selfService: { useForSelfService: false },
};

const EXPECTED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<policy>
  <general>
    <name>Example: Migrate [installomator]</name>
    <enabled>false</enabled>
    <trigger_checkin>true</trigger_checkin>
    <trigger_enrollment_complete>false</trigger_enrollment_complete>
    <trigger_login>false</trigger_login>
    <trigger_network_state_changed>false</trigger_network_state_changed>
    <trigger_startup>false</trigger_startup>
    <trigger_other></trigger_other>
    <frequency>Once per computer</frequency>
    <retry_event>check-in</retry_event>
    <retry_attempts>10</retry_attempts>
    <notify_on_each_failed_retry>false</notify_on_each_failed_retry>
    <category><id>2</id></category>
  </general>
  <scope>
    <all_computers>false</all_computers>
    <computers><computer><id>900</id></computer></computers>
    <computer_groups/>
    <buildings/>
    <departments/>
    <exclusions>
      <computers/>
      <computer_groups/>
      <buildings/>
      <departments/>
    </exclusions>
  </scope>
  <self_service>
    <use_for_self_service>false</use_for_self_service>
  </self_service>
  <scripts>
    <size>2</size>
    <script>
      <id>901</id>
      <priority>Before</priority>
      <parameter4>${SECRET}</parameter4>
      <parameter5></parameter5>
      <parameter6></parameter6>
      <parameter7></parameter7>
      <parameter8></parameter8>
      <parameter9></parameter9>
      <parameter10></parameter10>
      <parameter11></parameter11>
    </script>
    <script>
      <id>1</id>
      <priority>After</priority>
      <parameter4>examplelabel</parameter4>
      <parameter5>DEBUG=0</parameter5>
      <parameter6>NOTIFY=silent</parameter6>
      <parameter7></parameter7>
      <parameter8></parameter8>
      <parameter9></parameter9>
      <parameter10></parameter10>
      <parameter11></parameter11>
    </script>
  </scripts>
  <maintenance>
    <recon>true</recon>
    <reset_name>false</reset_name>
    <install_all_cached_packages>false</install_all_cached_packages>
    <heal>false</heal>
    <prebindings>false</prebindings>
    <permissions>false</permissions>
    <byhost>false</byhost>
    <system_cache>false</system_cache>
    <user_cache>false</user_cache>
    <verify>false</verify>
  </maintenance>
</policy>`;

/** A stored policy in Classic JSON's shape, matching `input`, with Jamf's inert defaults. */
function storedPolicy(overrides: (p: Record<string, any>) => void = () => {}) {
  const policy: Record<string, any> = {
    general: {
      id: 101,
      name: input.general.name,
      enabled: false,
      trigger: 'CHECKIN',
      trigger_checkin: true,
      trigger_enrollment_complete: false,
      trigger_login: false,
      trigger_network_state_changed: false,
      trigger_startup: false,
      trigger_other: '',
      frequency: 'Once per computer',
      retry_event: 'check-in',
      retry_attempts: 10,
      notify_on_each_failed_retry: false,
      location_user_only: false,
      target_drive: '/',
      offline: false,
      category: { id: 2, name: 'Security' },
      date_time_limitations: {
        activation_date: '',
        activation_date_epoch: 0,
        activation_date_utc: '',
        expiration_date: '',
        expiration_date_epoch: 0,
        expiration_date_utc: '',
        no_execute_on: {},
        no_execute_start: '',
        no_execute_end: '',
      },
      network_limitations: { minimum_network_connection: 'No Minimum', any_ip_address: true, network_segments: [] },
      override_default_settings: { target_drive: '/', distribution_point: 'default', force_afp_smb: false, sus: 'default' },
      network_requirements: 'Any',
      site: { id: -1, name: 'NONE' },
    },
    scope: {
      all_computers: false,
      all_jss_users: false,
      computers: [{ id: 900, name: 'Mac', udid: 'deadbeef-0000-4000-8000-000000000001' }],
      computer_groups: [],
      buildings: [],
      departments: [],
      limit_to_users: { user_groups: [] },
      limitations: { users: [], user_groups: [], network_segments: [], ibeacons: [] },
      exclusions: {
        computers: [],
        computer_groups: [],
        buildings: [],
        departments: [],
        users: [],
        user_groups: [],
        network_segments: [],
        ibeacons: [],
        jss_users: {},
        jss_user_groups: {},
      },
      jss_users: {},
      jss_user_groups: {},
    },
    self_service: { use_for_self_service: false, self_service_display_name: '', self_service_description: '' },
    package_configuration: { packages: [], distribution_point: 'default' },
    scripts: input.scripts.map((s) => ({ ...s, name: `script ${s.id}` })),
    printers: [''],
    dock_items: [],
    account_maintenance: {
      accounts: [],
      directory_bindings: [],
      management_account: { action: 'doNotChange' },
      open_firmware_efi_password: { of_mode: 'none', of_password_sha256: '' },
    },
    reboot: {
      message: 'This computer will restart in 5 minutes.',
      startup_disk: 'Current Startup Disk',
      specify_startup: '',
      no_user_logged_in: 'Do not restart',
      user_logged_in: 'Do not restart',
      minutes_until_reboot: 5,
      start_reboot_timer_immediately: false,
      file_vault_2_reboot: false,
    },
    maintenance: {
      recon: true,
      reset_name: false,
      install_all_cached_packages: false,
      heal: false,
      prebindings: false,
      permissions: false,
      byhost: false,
      system_cache: false,
      user_cache: false,
      verify: false,
    },
    files_processes: {
      search_by_path: '',
      delete_file: false,
      locate_file: '',
      update_locate_database: false,
      spotlight_search: '',
      search_for_process: '',
      kill_process: false,
      run_command: '',
    },
    user_interaction: { message_start: '', allow_users_to_defer: false, allow_deferral_until_utc: '', allow_deferral_minutes: 0, message_finish: '' },
    disk_encryption: { action: 'none' },
  };
  overrides(policy);
  return { policy };
}

const policiesList = res({ policies: [{ id: 16, name: 'Some other policy' }] });
const category = res({ category: { id: 2, name: 'Security', priority: 9 } });
const scriptsList = res({ scripts: [{ id: 1, name: 'Installer' }, { id: 901, name: 'Example: Migrate' }] });

describe('createPolicyInputSchema', () => {
  it('rejects enabled, packages, allComputers and any unknown field', () => {
    expect(createPolicyInputSchema.safeParse({ ...input, enabled: true }).success).toBe(false);
    expect(createPolicyInputSchema.safeParse({ ...input, enabled: false }).success).toBe(false);
    expect(createPolicyInputSchema.safeParse({ ...input, packages: [{ id: 1 }] }).success).toBe(false);
    expect(createPolicyInputSchema.safeParse({ ...input, scope: { ...input.scope, allComputers: true } }).success).toBe(false);
    expect(createPolicyInputSchema.safeParse({ ...input, general: { ...input.general, site: 1 } }).success).toBe(false);
    expect(createPolicyInputSchema.safeParse({ ...input, notes: 'x' }).success).toBe(false);
  });

  it('requires every trigger, every parameter, recon and the self service flag', () => {
    const { startup: _s, ...triggers } = input.general.triggers;
    expect(createPolicyInputSchema.safeParse({ ...input, general: { ...input.general, triggers } }).success).toBe(false);
    const { parameter11: _p, ...script } = input.scripts[1]!;
    expect(createPolicyInputSchema.safeParse({ ...input, scripts: [script] }).success).toBe(false);
    expect(createPolicyInputSchema.safeParse({ ...input, maintenance: {} }).success).toBe(false);
    expect(createPolicyInputSchema.safeParse({ ...input, selfService: {} }).success).toBe(false);
    expect(createPolicyInputSchema.safeParse({ ...input, scope: { computerIds: [900] } }).success).toBe(false);
  });

  it('requires a display name and description when the policy is in Self Service', () => {
    expect(createPolicyInputSchema.safeParse({ ...input, selfService: { useForSelfService: true } }).success).toBe(false);
    expect(
      createPolicyInputSchema.safeParse({
        ...input,
        selfService: { useForSelfService: true, displayName: 'X', description: 'Y', featureOnMainPage: false, forceUsersToViewDescription: false },
      }).success,
    ).toBe(true);
  });

  it('accepts only the published frequencies, retry events and script priorities', () => {
    expect(createPolicyInputSchema.safeParse({ ...input, general: { ...input.general, frequency: 'Once' } }).success).toBe(false);
    expect(
      createPolicyInputSchema.safeParse({ ...input, general: { ...input.general, retry: { ...input.general.retry, event: 'checkin' } } }).success,
    ).toBe(false);
    expect(createPolicyInputSchema.safeParse({ ...input, scripts: [{ ...input.scripts[0], priority: 'BEFORE' }] }).success).toBe(false);
  });
});

describe('validatePolicyInput', () => {
  const withScope = (scope: Partial<CreatePolicyInput['scope']>) => ({ ...input, scope: { ...input.scope, ...scope } });

  it('refuses an empty scope unless it is declared intended', () => {
    expect(() => validatePolicyInput(withScope({ computerIds: [] }))).toThrow(/emptyScopeIntended/);
    expect(() => validatePolicyInput(withScope({ computerIds: [], emptyScopeIntended: true }))).not.toThrow();
    expect(() => validatePolicyInput(withScope({ emptyScopeIntended: true }))).toThrow(/includes targets/);
  });

  it('refuses duplicates and a target both included and excluded', () => {
    expect(() => validatePolicyInput(withScope({ computerIds: [900, 900] }))).toThrow(/more than once/);
    expect(() => validatePolicyInput(withScope({ exclusions: { computerIds: [900], computerGroupIds: [] } }))).toThrow(/Included and excluded/);
    expect(() => validatePolicyInput({ ...input, scripts: [input.scripts[0]!, input.scripts[0]!] })).toThrow(/more than once/);
  });

  it('holds retry settings to what Jamf offers', () => {
    const retry = (r: Partial<CreatePolicyInput['general']['retry']>, frequency = input.general.frequency) => ({
      ...input,
      general: { ...input.general, frequency, retry: { ...input.general.retry, ...r } },
    });
    expect(() => validatePolicyInput(retry({ attempts: 11 }))).toThrow(/1 to 10/);
    expect(() => validatePolicyInput(retry({ attempts: 0 }))).toThrow(/1 to 10/);
    expect(() => validatePolicyInput(retry({}, 'Ongoing'))).toThrow(/Once per computer/);
    expect(() => validatePolicyInput(retry({ event: 'none', attempts: 10 }))).toThrow(/must be -1/);
    expect(() => validatePolicyInput(retry({ event: 'none', attempts: -1, notifyOnEachFailedRetry: true }))).toThrow(/must be false/);
    expect(() => validatePolicyInput(retry({ event: 'none', attempts: -1 }, 'Ongoing'))).not.toThrow();
  });
});

describe('buildPolicyXml', () => {
  it('builds the exact body: disabled, explicit scope, every slot and maintenance flag', () => {
    expect(buildPolicyXml(input, realParameter)).toBe(EXPECTED_XML);
  });

  it('differs from the dry-run rendering only in the hidden parameter values', () => {
    const shown = buildPolicyXml(input, shownParameter);
    const marker = (v: string) => `[sha256:${digest(v).sha256} length:${v.length}]`;
    let expected = EXPECTED_XML;
    for (const v of [SECRET, 'examplelabel', 'DEBUG=0', 'NOTIFY=silent']) expected = expected.replace(`>${v}<`, `>${marker(v)}<`);
    expect(shown).toBe(expected);
    expect(shown).not.toContain(SECRET);
  });

  it('escapes names and values, and sends self service fields only when used', () => {
    const xml = buildPolicyXml(
      {
        ...input,
        general: { ...input.general, name: 'A & <B>', triggers: { ...input.general.triggers, other: 'run-me' } },
        scope: { computerIds: [], computerGroupIds: [7, 3], exclusions: { computerIds: [5], computerGroupIds: [] } },
        scripts: [],
        selfService: { useForSelfService: true, displayName: 'Do <it>', description: 'D', featureOnMainPage: true, forceUsersToViewDescription: false },
      },
      realParameter,
    );
    expect(xml).toContain('<name>A &amp; &lt;B&gt;</name>');
    expect(xml).toContain('<trigger_other>run-me</trigger_other>');
    expect(xml).toContain('<computer_groups><computer_group><id>3</id></computer_group><computer_group><id>7</id></computer_group></computer_groups>');
    expect(xml).toContain('<exclusions>\n      <computers><computer><id>5</id></computer></computers>');
    expect(xml).toContain('<self_service_display_name>Do &lt;it&gt;</self_service_display_name>');
    expect(xml).toContain('<feature_on_main_page>true</feature_on_main_page>');
    expect(xml).toContain('<scripts>\n    <size>0</size>\n  </scripts>');
    expect(buildPolicyXml(input, realParameter)).not.toContain('self_service_display_name');
  });
});

describe('comparePolicy', () => {
  it('passes a stored policy that matches, with Jamf inert defaults', () => {
    expect(comparePolicy(input, storedPolicy(), 101)).toEqual([]);
  });

  it('flags a policy stored enabled, or scoped to all computers', () => {
    const mismatches = comparePolicy(
      input,
      storedPolicy((p) => {
        p.general.enabled = true;
        p.scope.all_computers = true;
      }),
      101,
    );
    expect(mismatches.map((m) => m.field)).toEqual(expect.arrayContaining(['general.enabled', 'scope.all_computers']));
  });

  it('compares parameters by digest and never shows a value', () => {
    const mismatches = comparePolicy(
      input,
      storedPolicy((p) => {
        p.scripts[0].parameter4 = '';
      }),
      101,
    );
    expect(mismatches).toEqual([{ field: 'scripts[0].parameter4', sent: digest(SECRET), stored: digest('') }]);
    expect(JSON.stringify(mismatches)).not.toContain(SECRET);
  });

  it('flags script order, a missing script, and changed triggers, retry and recon', () => {
    const mismatches = comparePolicy(
      input,
      storedPolicy((p) => {
        p.scripts = [p.scripts[1]];
        p.general.trigger_login = true;
        p.general.retry_attempts = -1;
        p.maintenance.recon = false;
        p.maintenance.heal = true;
      }),
      101,
    );
    expect(mismatches.map((m) => m.field)).toEqual(
      expect.arrayContaining([
        'scripts.length',
        'scripts[0].id',
        'general.trigger_login',
        'general.retry_attempts',
        'maintenance.recon',
        'maintenance.heal',
      ]),
    );
  });

  it('flags an unsent section Jamf filled with something that acts, showing text by digest', () => {
    const mismatches = comparePolicy(
      input,
      storedPolicy((p) => {
        p.files_processes.run_command = 'rm -rf /tmp/x';
        p.reboot.user_logged_in = 'Restart immediately';
        p.package_configuration.packages = [{ id: 4, name: 'pkg', action: 'Install' }];
      }),
      101,
    );
    expect(mismatches.map((m) => m.field)).toEqual([
      'package_configuration.packages',
      'reboot.user_logged_in',
      'files_processes.run_command',
    ]);
    expect(JSON.stringify(mismatches)).not.toContain('rm -rf');
  });

  it('flags a scope member it does not model, and an unreadable scripts section', () => {
    const mismatches = comparePolicy(
      input,
      storedPolicy((p) => {
        p.scope.limitations.users = [{ id: 1, name: 'u' }];
        p.scripts = 'garbage';
      }),
      101,
    );
    expect(mismatches.map((m) => m.field)).toEqual(expect.arrayContaining(['scope.limitations', 'scripts']));
  });

  it('reads the XML-derived {size, script} wrapper too', () => {
    const body = storedPolicy((p) => {
      p.scripts = { size: 2, script: p.scripts };
    });
    expect(comparePolicy(input, body, 101)).toEqual([]);
  });
});

describe('parsePolicyCreatedId', () => {
  it('reads the id from Classic XML or JSON', () => {
    expect(parsePolicyCreatedId('<?xml version="1.0"?><policy><id>101</id></policy>')).toBe(101);
    expect(parsePolicyCreatedId({ policy: { id: 101 } })).toBe(101);
    expect(parsePolicyCreatedId(undefined)).toBeUndefined();
  });
});

describe('createPolicy', () => {
  it('defaults to a dry run: only GETs, the XML shows hashes, never the value', async () => {
    stub(policiesList, category, scriptsList);
    const result = await createPolicy(ctx(), input);
    expect(result.dryRun).toBe(true);
    expect(gatewayCalls().every((c) => (c.init.method ?? 'GET') === 'GET')).toBe(true);
    expect(result.request).toMatchObject({ method: 'POST', path: '/proclassic/policies/id/0', contentType: 'application/xml' });
    expect(result.request.body).toBe(buildPolicyXml(input, shownParameter));
    expect(result.scripts[0]).toMatchObject({ order: 1, id: 901, name: 'Example: Migrate', parameters: { parameter4: digest(SECRET) } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.warnings.join(' ')).toMatch(/DISABLED/);
    expect(result.warnings.join(' ')).toMatch(/non-empty script parameter/);
  });

  it('refuses a name that already exists, a script that does not, and a group that does not', async () => {
    stub(res({ policies: [{ id: 100, name: input.general.name.toUpperCase() }] }));
    await expect(createPolicy(ctx(), input)).rejects.toThrow(/already exists \(id 100\)/);

    stub(policiesList, category, res({ scripts: [{ id: 1, name: 'Installer' }] }));
    await expect(createPolicy(ctx(), input)).rejects.toThrow(/Script id\(s\) 901 do not exist/);

    stub(policiesList, category, scriptsList, res('Not Found', 404));
    await expect(
      createPolicy(ctx(), { ...input, scope: { ...input.scope, computerGroupIds: [5] } }),
    ).rejects.toThrow(/Computer group 5 does not exist/);
  });

  it('refuses a live write when writes are disabled, before any POST', async () => {
    stub(policiesList, category, scriptsList);
    await expect(createPolicy(ctx(false), { ...input, dryRun: false })).rejects.toThrow(/Writes are disabled/);
    expect(gatewayCalls().some((c) => c.init.method === 'POST')).toBe(false);
  });

  it('POSTs the exact XML, reads back, verifies, and gives the rollback', async () => {
    stub(
      policiesList,
      category,
      scriptsList,
      res('<?xml version="1.0" encoding="UTF-8"?><policy><id>101</id></policy>', 201),
      res(storedPolicy()),
    );
    const result = await createPolicy(ctx(), { ...input, dryRun: false });
    const post = gatewayCalls().find((c) => c.init.method === 'POST');
    expect(post?.url).toBe('https://us.api.jamfcloud.com/proclassic/policies/id/0');
    expect((post?.init.headers as Record<string, string>)['Content-Type']).toBe('application/xml');
    expect(post?.init.body).toBe(EXPECTED_XML);
    expect(gatewayCalls().at(-1)?.url).toBe('https://us.api.jamfcloud.com/proclassic/policies/id/101');
    expect(result).toMatchObject({ dryRun: false, id: 101, verification: { verified: true, mismatches: [] } });
    expect(result.rollback?.effect).toMatch(/disabled/);
    expect(result.rollback?.effect).toMatch(/900/);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    for (const call of stderr.mock.calls) expect(String(call[0])).not.toContain(SECRET);
  });

  it('gives group rollback calls for group targets', async () => {
    const grouped = { ...input, scope: { computerIds: [], computerGroupIds: [5], exclusions: { computerIds: [], computerGroupIds: [] } } };
    stub(
      policiesList,
      category,
      scriptsList,
      res({ computer_group: { id: 5, name: 'Test group', is_smart: false } }),
      res('<policy><id>101</id></policy>', 201),
      res(
        storedPolicy((p) => {
          p.scope.computers = [];
          p.scope.computer_groups = [{ id: 5, name: 'Test group' }];
        }),
      ),
    );
    const result = await createPolicy(ctx(), { ...grouped, dryRun: false });
    expect(result.verification).toMatchObject({ verified: true });
    expect(result.rollback?.emptyScope).toEqual([
      { tool: 'removeComputerGroupFromPolicyScope', arguments: { id: 101, computerGroupId: 5, dryRun: true } },
    ]);
  });

  it('scrubs parameter values out of a failed create error', async () => {
    stub(policiesList, category, scriptsList, res(`<html><body>Conflict: <parameter4>${SECRET}</parameter4></body></html>`, 409));
    const error = await createPolicy(ctx(), { ...input, dryRun: false }).catch((e: Error) => e);
    expect(error).not.toBeInstanceOf(JamfPlatformApiError);
    expect((error as Error).message).toMatch(/409/);
    expect((error as Error).message).not.toContain(SECRET);
  });
});
