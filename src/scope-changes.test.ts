import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from './config.js';
import { JamfPlatformClient } from './platform-client.js';
import type { WriteContext } from './restricted-software.js';
import { applyScopeChanges, scopeChangesInputSchema, targetsNothingProvably } from './scope-changes.js';
import { applyScopeMembershipBatch } from './scope-membership-batch.js';

// Type-only fixtures with invented ids (JPM-0004). An in-memory fake of the Classic endpoints
// that models every list the engine can change: targets and exclusions, computers and groups.
const config: Config = {
  clientId: 'id',
  clientSecret: 'secret',
  tenantId: 'TENANT',
  gatewayBaseUrl: 'https://us.api.jamfcloud.com',
  tokenUrl: 'https://us.api.jamfcloud.com/auth/token',
  readOnly: false,
};

const SECRET_MARKER = 'PAYLOAD-CONTENT-MARKER-XYZ';

type Kind = 'profile' | 'policy';
interface Lists {
  computers: number[];
  groups: number[];
  buildings: number[];
  departments: number[];
}
interface Stored {
  kind: Kind;
  name?: string;
  include: Lists;
  exclude: Lists;
  allComputers?: boolean;
  extraExclusions?: Record<string, unknown>;
  redeploy?: string;
  payload?: string;
}

const lists = (o: Partial<Lists> = {}): Lists => ({ computers: [], groups: [], buildings: [], departments: [], ...o });

let store: Map<string, Stored>;
let groupStore: Map<number, { name: string; isSmart: boolean }>;
let putAnswer: Map<string, number>; // PUT answered with this non-2xx status
let putAppliesDespiteError: Set<string>; // ...and yet a read shows the change (a stale read)
let putThrows: Set<string>; // no HTTP response at all
let putDropsComputer: Map<string, number>; // Jamf silently drops this computer id on store
let putLog: Array<{ url: string; body: string }>;
let policyListFails: boolean;

const res = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : status >= 500 ? 'Server Error' : 'OK',
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as unknown as Response;

const refs = (ids: number[]) => ids.map((id) => ({ id, name: `n${id}` }));
const renderLists = (l: Lists) => ({
  computers: refs(l.computers),
  computer_groups: refs(l.groups),
  buildings: refs(l.buildings),
  departments: refs(l.departments),
});

function render(key: string, s: Stored) {
  const scope = {
    all_computers: s.allComputers ?? false,
    ...renderLists(s.include),
    exclusions: { ...renderLists(s.exclude), users: [], ...s.extraExclusions },
  };
  const name = s.name ?? key;
  if (s.kind === 'profile') {
    return {
      os_x_configuration_profile: {
        general: { id: 1, name, redeploy_on_update: s.redeploy ?? 'Newly Assigned', payloads: s.payload ?? SECRET_MARKER },
        scope,
      },
    };
  }
  return { policy: { general: { id: 1, name, enabled: true, note: s.payload ?? 'x' }, scope } };
}

const idsIn = (block: string, plural: string) =>
  [...((block.match(new RegExp(`<${plural}>([\\s\\S]*?)</${plural}>`)) ?? [])[1] ?? '').matchAll(/<id>(\d+)<\/id>/g)].map(
    (m) => Number(m[1]),
  );
function listsFromXml(xml: string): { include: Lists; exclude: Lists } {
  const scope = (xml.match(/<scope>([\s\S]*)<\/scope>/) ?? [])[1] ?? '';
  const [targets = '', rest = ''] = scope.split('<exclusions>');
  const parse = (b: string) => ({
    computers: idsIn(b, 'computers'),
    groups: idsIn(b, 'computer_groups'),
    buildings: idsIn(b, 'buildings'),
    departments: idsIn(b, 'departments'),
  });
  return { include: parse(targets), exclude: parse(rest) };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  store = new Map();
  groupStore = new Map([
    [901, { name: 'Group Z', isSmart: true }],
    [902, { name: 'Group A', isSmart: true }],
    [903, { name: 'Group B', isSmart: false }],
  ]);
  putAnswer = new Map();
  putAppliesDespiteError = new Set();
  putThrows = new Set();
  putDropsComputer = new Map();
  putLog = [];
  policyListFails = false;
  fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/auth/token')) return res({ access_token: 'tok', expires_in: 900, token_type: 'Bearer' });
    if (/\/policies$/.test(u)) {
      if (policyListFails) return res('boom', 500);
      const policies = [...store.entries()].filter(([, v]) => v.kind === 'policy');
      return res({ policies: policies.map(([k, v]) => ({ id: Number(k.split(':')[1]), name: v.name ?? k })) });
    }
    const group = u.match(/computergroups\/id\/(\d+)/);
    if (group) {
      const g = groupStore.get(Number(group[1]));
      if (!g) return res('not found', 404);
      return res({ computer_group: { id: Number(group[1]), name: g.name, is_smart: g.isSmart } });
    }
    const obj = u.match(/(osxconfigurationprofiles|policies)\/id\/(\d+)/);
    if (!obj) return res('unexpected', 500);
    const key = `${obj[1] === 'policies' ? 'policy' : 'profile'}:${obj[2]}`;
    const s = store.get(key);
    if (init?.method === 'PUT') {
      const body = String(init.body);
      putLog.push({ url: u, body });
      if (putThrows.has(key)) throw new TypeError('fetch failed');
      const status = putAnswer.get(key);
      const apply = () => {
        if (!s) return;
        const parsed = listsFromXml(body);
        const dropped = putDropsComputer.get(key);
        if (dropped !== undefined) {
          parsed.include.computers = parsed.include.computers.filter((c) => c !== dropped);
          parsed.exclude.computers = parsed.exclude.computers.filter((c) => c !== dropped);
        }
        s.include = parsed.include;
        s.exclude = parsed.exclude;
      };
      if (status !== undefined) {
        if (putAppliesDespiteError.has(key)) apply();
        return res('<html><body>Conflict</body></html>', status);
      }
      apply();
      return res('<id>1</id>', 201);
    }
    if (!s) return res('not found', 404);
    return res(render(key, s));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ctx = (writesEnabled = true): WriteContext => ({
  client: new JamfPlatformClient(config),
  writesEnabled,
  now: () => new Date('2026-11-09T12:00:00.000Z'),
});
const puts = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
const getsOf = (fragment: string) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes(fragment) && (c[1] as RequestInit | undefined)?.method !== 'PUT');

type Action = 'add' | 'remove';
type List = 'include' | 'exclude';
const comp = (kind: Kind, id: number, action: Action, list: List, computerId: number) =>
  ({ kind, id, action, member: 'computer', list, computerId }) as const;
const grp = (kind: Kind, id: number, action: Action, list: List, computerGroupId: number) =>
  ({ kind, id, action, member: 'computerGroup', list, computerGroupId }) as const;
type Op = ReturnType<typeof comp> | ReturnType<typeof grp>;

const dry = async (operations: Op[]) => (await applyScopeChanges(ctx(), { operations })) as Record<string, any>;
const live = async (operations: Op[], planHash: string | undefined, c = ctx()) =>
  (await applyScopeChanges(c, { operations, dryRun: false, planHash })) as Record<string, any>;

function seed() {
  store.set('profile:501', { kind: 'profile', include: lists({ groups: [901] }), exclude: lists() });
  store.set('policy:601', { kind: 'policy', include: lists({ groups: [901], computers: [11] }), exclude: lists({ computers: [12] }) });
  store.set('policy:602', { kind: 'policy', include: lists({ groups: [902] }), exclude: lists() });
}
const standardOps = (): Op[] => [
  comp('profile', 501, 'add', 'exclude', 21),
  grp('policy', 601, 'add', 'exclude', 903),
  comp('policy', 601, 'remove', 'exclude', 12),
  comp('policy', 601, 'add', 'include', 13),
];

describe('input schema', () => {
  const one = comp('profile', 1, 'add', 'exclude', 2);
  const parse = (v: unknown) => scopeChangesInputSchema.safeParse(v).success;

  it('is strict, states member and list on every operation, and bounds the count to 1..150', () => {
    expect(parse({ operations: [one] })).toBe(true);
    expect(parse({ operations: [grp('policy', 1, 'remove', 'include', 2)] })).toBe(true);
    expect(parse({ operations: [] })).toBe(false);
    expect(parse({ operations: Array(150).fill(one) })).toBe(true);
    expect(parse({ operations: Array(151).fill(one) })).toBe(false);
    expect(parse({ operations: [one], extra: 1 })).toBe(false);
    expect(parse({ operations: [{ ...one, extra: 1 }] })).toBe(false);
    // Nothing defaults: member and list must be stated.
    const { member: _m, ...noMember } = one;
    const { list: _l, ...noList } = one;
    expect(parse({ operations: [noMember] })).toBe(false);
    expect(parse({ operations: [noList] })).toBe(false);
    expect(parse({ operations: [{ ...one, list: 'limit' }] })).toBe(false);
    expect(parse({ operations: [{ ...one, member: 'building' }] })).toBe(false);
  });

  it('requires the id field that matches the member, and only that one', () => {
    const { computerId: _c, ...bare } = one;
    expect(parse({ operations: [{ ...bare, computerGroupId: 2 }] })).toBe(false);
    expect(parse({ operations: [{ ...one, computerGroupId: 2 }] })).toBe(false);
    expect(parse({ operations: [{ ...grp('policy', 1, 'add', 'include', 2), computerId: 3 }] })).toBe(false);
    expect(parse({ operations: [{ ...one, computerId: 0 }] })).toBe(false);
  });

  it('rejects more than 150 operations when called directly, before any request', async () => {
    const many = Array.from({ length: 151 }, (_, i) => comp('profile', i + 1, 'add', 'exclude', 1));
    await expect(applyScopeChanges(ctx(), { operations: many })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('dry run', () => {
  it('reports before and after for every affected list, never reads a computer, and never PUTs', async () => {
    seed();
    const out = await dry(standardOps());
    expect(out.ok).toBe(true);
    expect(out.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.objects.map((o: any) => `${o.kind}:${o.id}`)).toEqual(['profile:501', 'policy:601']);
    expect(out.objects[0].before).toEqual({ 'scope.exclusions.computerIds': [] });
    expect(out.objects[0].after).toEqual({ 'scope.exclusions.computerIds': [21] });
    expect(out.objects[1].before).toEqual({
      'scope.computerIds': [11],
      'scope.exclusions.computerGroupIds': [],
      'scope.exclusions.computerIds': [12],
    });
    expect(out.objects[1].after).toEqual({
      'scope.computerIds': [11, 13],
      'scope.exclusions.computerGroupIds': [903],
      'scope.exclusions.computerIds': [],
    });
    expect(out.objects[1].operations).toEqual([
      { action: 'add', member: 'computerGroup', list: 'exclude', computerGroupId: 903 },
      { action: 'remove', member: 'computer', list: 'exclude', computerId: 12 },
      { action: 'add', member: 'computer', list: 'include', computerId: 13 },
    ]);
    expect(out.totals).toMatchObject({
      objects: 2,
      operations: 4,
      adds: 3,
      removes: 1,
      targetChanges: 1,
      exclusionChanges: 3,
      groups: 1,
      computers: 3,
    });
    expect(puts()).toHaveLength(0);
    expect(fetchMock.mock.calls.some((c) => /\/computers\b/.test(String(c[0])))).toBe(false);
    expect(getsOf('computergroups/id/903')).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain(SECRET_MARKER);
  });

  it('warns that an added computer id is not checked, and that a profile leaves Macs it stops targeting', async () => {
    seed();
    const out = await dry([comp('profile', 501, 'add', 'exclude', 21)]);
    const warnings = out.objects[0].warnings.join(' ');
    expect(warnings).toMatch(/Computer id 21 is not checked before the write/);
    expect(warnings).toMatch(/the id of the wrong Mac is not/);
    expect(warnings).toMatch(/loses the profile/);
  });

  it('warns when an excluded computer is also a target, and when the last target is removed', async () => {
    seed();
    const a = await dry([comp('policy', 601, 'add', 'exclude', 11)]);
    expect(a.ok).toBe(true);
    expect(a.objects[0].warnings.join(' ')).toMatch(/Computer 11 is also in this policy's scope; exclusions win/);
    const b = await dry([grp('policy', 602, 'remove', 'include', 902)]);
    expect(b.ok).toBe(true);
    expect(b.objects[0].warnings.join(' ')).toMatch(/has no targets, so it reaches no computer/);
  });

  it('accepts moving a computer from the targets to the exclusions in one plan', async () => {
    seed();
    const out = await dry([comp('policy', 601, 'remove', 'include', 11), comp('policy', 601, 'add', 'exclude', 11)]);
    expect(out.ok).toBe(true);
    expect(out.objects[0].after).toEqual({ 'scope.computerIds': [], 'scope.exclusions.computerIds': [11, 12] });
  });
});

describe('planHash covers the new fields', () => {
  it('differs when only the list differs, or only the member kind', async () => {
    seed();
    const base = await dry([comp('policy', 602, 'add', 'include', 903)]);
    const otherList = await dry([comp('policy', 602, 'add', 'exclude', 903)]);
    const otherMember = await dry([grp('policy', 602, 'add', 'include', 903)]);
    expect(base.ok && otherList.ok && otherMember.ok).toBe(true);
    expect(new Set([base.planHash, otherList.planHash, otherMember.planHash]).size).toBe(3);
    expect((await dry([comp('policy', 602, 'add', 'include', 903)])).planHash).toBe(base.planHash);
  });

  it('refuses the live run when an exclusion list changed after the dry run', async () => {
    seed();
    const { planHash } = await dry(standardOps());
    (store.get('policy:601') as Stored).exclude.computers = [12, 99];
    await expect(live(standardOps(), planHash)).rejects.toThrow(/live state changed since the dry run/);
    expect(puts()).toHaveLength(0);
  });

  it('refuses the live run when a computer target changed on an object the plan touches only in exclusions', async () => {
    seed();
    const ops = [comp('profile', 501, 'add', 'exclude', 21)];
    const { planHash } = await dry(ops);
    (store.get('profile:501') as Stored).include.computers = [5];
    await expect(live(ops, planHash)).rejects.toThrow(/live state changed/);
    expect(puts()).toHaveLength(0);
  });

  it('a hash from applyScopeMembershipBatch binds the same engine state as applyScopeChanges', async () => {
    seed();
    const legacy = (await applyScopeMembershipBatch(ctx(), {
      operations: [{ kind: 'policy', id: 602, action: 'add', computerGroupId: 903 }],
    })) as Record<string, any>;
    const general = await dry([grp('policy', 602, 'add', 'include', 903)]);
    expect(legacy.planHash).toBe(general.planHash);
  });
});

describe('refusals', () => {
  async function expectRefused(operations: Op[], reason: RegExp) {
    const out = await dry(operations);
    expect(out.ok).toBe(false);
    expect(out).not.toHaveProperty('planHash');
    expect(out.refusals.some((r: any) => reason.test(r.reason)), JSON.stringify(out.refusals)).toBe(true);
    expect(puts()).toHaveLength(0);
    return out;
  }

  it('refuses adding the same member to the targets and the exclusions in one plan', async () => {
    seed();
    const out = await expectRefused(
      [comp('policy', 602, 'add', 'include', 31), comp('policy', 602, 'add', 'exclude', 31)],
      /added to both policy 602's scope and its exclusions/,
    );
    expect(out.refusals[0].operation).toEqual({ action: 'add', member: 'computer', list: 'exclude', computerId: 31 });
    await expectRefused(
      [grp('policy', 602, 'add', 'exclude', 903), grp('policy', 602, 'add', 'include', 903)],
      /added to both/,
    );
  });

  it('refuses an add of a computer already in that list, and a remove of one that is not', async () => {
    seed();
    await expectRefused([comp('policy', 601, 'add', 'exclude', 12)], /Computer 12 is already in policy 601's exclusions/);
    await expectRefused([comp('policy', 601, 'remove', 'exclude', 11)], /Computer 11 is not in policy 601's exclusions/);
    await expectRefused([comp('policy', 601, 'remove', 'include', 12)], /Computer 12 is not in policy 601's scope/);
  });

  it('refuses the same member, list and id twice for one object, but not the same id in another list or member', async () => {
    seed();
    await expectRefused(
      [comp('policy', 602, 'add', 'exclude', 31), comp('policy', 602, 'add', 'exclude', 31)],
      /appears more than once/,
    );
    const out = await dry([comp('policy', 602, 'add', 'exclude', 903), grp('policy', 602, 'add', 'exclude', 903)]);
    expect(out.ok).toBe(true);
  });

  it('refuses an exclusion that provably leaves the object reaching no computer', async () => {
    store.set('policy:601', { kind: 'policy', include: lists({ computers: [11] }), exclude: lists() });
    await expectRefused([comp('policy', 601, 'add', 'exclude', 11)], /would reach no computer/);
    store.set('policy:602', { kind: 'policy', include: lists({ groups: [902], computers: [11] }), exclude: lists({ groups: [902] }) });
    await expectRefused([comp('policy', 602, 'add', 'exclude', 11)], /would reach no computer/);
  });

  it('does not call a scope empty when it includes a building or department, or was already empty', async () => {
    store.set('policy:601', { kind: 'policy', include: lists({ computers: [11], buildings: [1] }), exclude: lists() });
    expect((await dry([comp('policy', 601, 'add', 'exclude', 11)])).ok).toBe(true);
    store.set('policy:602', { kind: 'policy', include: lists({ groups: [902] }), exclude: lists({ groups: [902] }) });
    expect((await dry([comp('policy', 602, 'add', 'exclude', 31)])).ok).toBe(true);
    const none = { computerIds: [], computerGroupIds: [], buildingIds: [], departmentIds: [] };
    // No targets at all is "off", not a mistake: warned (above), never refused.
    expect(targetsNothingProvably({ ...none, allComputers: false, exclusions: { ...none, computerIds: [11] } })).toBe(false);
  });

  it('refuses a policy whose name another policy shares, ignoring case and surrounding space', async () => {
    seed();
    (store.get('policy:601') as Stored).name = 'Install Agent';
    (store.get('policy:602') as Stored).name = ' install agent ';
    const out = await expectRefused([comp('policy', 601, 'add', 'exclude', 31)], /shares its name "Install Agent" with policy 602/);
    expect(out.refusals[0].reason).toMatch(/HTTP 409/);
    expect(out.refusals[0].operation).toBeNull();
  });

  it('refuses every policy when the policy list cannot be read, and reads it only when a policy is in the batch', async () => {
    seed();
    policyListFails = true;
    await expectRefused([comp('policy', 601, 'add', 'exclude', 31)], /policy list could not be read/);
    expect((await dry([comp('profile', 501, 'add', 'exclude', 21)])).ok).toBe(true);
    const listCalls = fetchMock.mock.calls.filter((c) => /\/policies$/.test(String(c[0])));
    expect(listCalls).toHaveLength(1);
  });

  it('keeps the existing refusals: All Computers, unmodelled members, redeploy, missing group or object', async () => {
    seed();
    store.set('policy:603', { kind: 'policy', include: lists(), exclude: lists(), allComputers: true });
    await expectRefused([comp('policy', 603, 'add', 'exclude', 31)], /All Computers/);
    store.set('policy:604', { kind: 'policy', include: lists({ groups: [901] }), exclude: lists(), extraExclusions: { users: [{ id: 1 }] } });
    await expectRefused([comp('policy', 604, 'add', 'exclude', 31)], /scope\.exclusions\.users/);
    store.set('profile:502', { kind: 'profile', include: lists({ groups: [901] }), exclude: lists(), redeploy: 'All' });
    await expectRefused([comp('profile', 502, 'add', 'exclude', 31)], /Newly Assigned/);
    await expectRefused([grp('policy', 602, 'add', 'exclude', 999)], /does not exist/);
    await expectRefused([comp('profile', 598, 'add', 'exclude', 31)], /could not be read/);
  });
});

describe('live run', () => {
  it('sends one PUT per object with the final targets and exclusions, verifies, and returns an inverse rollback', async () => {
    seed();
    const { planHash } = await dry(standardOps());
    const out = await live(standardOps(), planHash);
    expect(out.ok).toBe(true);
    expect(puts()).toHaveLength(2);
    expect(listsFromXml(putLog[0]?.body ?? '').exclude.computers).toEqual([21]);
    expect(listsFromXml(putLog[1]?.body ?? '')).toEqual({
      include: lists({ groups: [901], computers: [11, 13] }),
      exclude: lists({ groups: [903] }),
    });
    for (const p of putLog) {
      expect(p.body).not.toContain('<general');
      expect(p.body).not.toContain('all_computers>true');
    }
    expect(out.objects.map((o: any) => o.status)).toEqual(['written', 'written']);
    expect(out.objects[1]).toMatchObject({ verified: true, otherFieldsUnchanged: true, rejectedWithHttpStatus: null });
    expect(out.totals).toMatchObject({ written: 2, failed: 0, notAttempted: 0, rejectedByJamf: 0 });
    expect(out.rollback.tool).toBe('applyScopeChanges');
    expect(out.rollback.dryRun).toBe(true);
    expect(out.rollback.notWritten).toEqual([]);
    expect(out.rollback.operations).toEqual([
      comp('policy', 601, 'remove', 'include', 13),
      comp('policy', 601, 'add', 'exclude', 12),
      grp('policy', 601, 'remove', 'exclude', 903),
      comp('profile', 501, 'remove', 'exclude', 21),
    ]);
    expect(JSON.stringify(out)).not.toContain(SECRET_MARKER);
  });

  it('the rollback, dry-run and applied, restores the original targets and exclusions', async () => {
    seed();
    const original = JSON.stringify([...store.entries()]);
    const { planHash } = await dry(standardOps());
    const out = await live(standardOps(), planHash);
    const rb = await dry(out.rollback.operations);
    expect(rb.ok).toBe(true);
    expect((await live(out.rollback.operations, rb.planHash)).ok).toBe(true);
    expect(JSON.stringify([...store.entries()])).toBe(original);
  });

  it('a computer Jamf drops on store is a scope mismatch on the exclusion list, and stops the batch', async () => {
    seed();
    const { planHash } = await dry(standardOps());
    putDropsComputer.set('profile:501', 21);
    const out = await live(standardOps(), planHash);
    expect(out.objects.map((o: any) => o.status)).toEqual(['failed', 'notAttempted']);
    expect(out.objects[0].error).toMatch(/scope mismatch: scope\.exclusions\.computerIds/);
    expect(out.rollback.operations).toEqual([comp('profile', 501, 'remove', 'exclude', 21)]);
  });

  describe('a non-2xx PUT is not a write (JPM-0014)', () => {
    it('a 409 is reported not written and not read back, even when a read would show the change', async () => {
      seed();
      const ops = [comp('policy', 602, 'add', 'exclude', 31), comp('profile', 501, 'add', 'exclude', 21)];
      const { planHash } = await dry(ops);
      putAnswer.set('policy:602', 409);
      putAppliesDespiteError.add('policy:602'); // a read now shows the rejected change
      const out = await live(ops, planHash);
      expect(out.ok).toBe(false);
      expect(out.stoppedOnFailure).toBe(true);
      expect(out.objects[0]).toMatchObject({
        kind: 'policy',
        id: 602,
        status: 'failed',
        writtenAt: null,
        verified: false,
        rejectedWithHttpStatus: 409,
      });
      expect(out.objects[0].error).toMatch(/HTTP 409, so the policy was NOT written/);
      expect(out.objects[1].status).toBe('notAttempted');
      // Not read back after the PUT: one GET in the dry run, one in the live re-plan.
      expect(getsOf('policies/id/602')).toHaveLength(2);
      expect(out.totals).toMatchObject({ written: 0, failed: 1, notAttempted: 1, rejectedByJamf: 1 });
      expect(out.rollback.operations).toEqual([]);
      expect(out.rollback.notWritten).toEqual([
        {
          kind: 'policy',
          id: 602,
          httpStatus: 409,
          inverseOperationsIfItLanded: [comp('policy', 602, 'remove', 'exclude', 31)],
        },
      ]);
      expect(out.rollback.note).toMatch(/re-read it after several minutes/);
    });

    it('a PUT with no HTTP response may have landed, so it stays in the rollback', async () => {
      seed();
      const ops = [comp('profile', 501, 'add', 'exclude', 21)];
      const { planHash } = await dry(ops);
      putThrows.add('profile:501');
      const out = await live(ops, planHash);
      expect(out.objects[0]).toMatchObject({ status: 'failed', rejectedWithHttpStatus: null });
      expect(out.objects[0].error).toMatch(/no HTTP response, so it may or may not have been applied/);
      expect(out.rollback.operations).toEqual([comp('profile', 501, 'remove', 'exclude', 21)]);
      expect(out.rollback.notWritten).toEqual([]);
    });
  });

  it('the guards stand: no planHash, wrong planHash, writes disabled', async () => {
    seed();
    await expect(live(standardOps(), undefined)).rejects.toThrow(/requires planHash/);
    await expect(live(standardOps(), 'f'.repeat(64))).rejects.toThrow(/live state changed/);
    const { planHash } = await dry(standardOps());
    await expect(live(standardOps(), planHash, ctx(false))).rejects.toThrow(/Writes are disabled/);
    expect(puts()).toHaveLength(0);
  });
});
