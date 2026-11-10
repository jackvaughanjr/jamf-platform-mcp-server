import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from './config.js';
import { JamfPlatformClient } from './platform-client.js';
import type { WriteContext } from './restricted-software.js';
import { applyScopeMembershipBatch, scopeMembershipBatchInputSchema } from './scope-membership-batch.js';

// Type-only fixtures with invented ids (JPM-0004). A tiny in-memory fake of the Classic
// endpoints: GETs read the store, a PUT of a scope-only body rewrites the stored group ids.
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
interface Stored {
  kind: Kind;
  groups: number[];
  allComputers?: boolean;
  extraScope?: Record<string, unknown>;
  redeploy?: string;
  payload?: string;
}

let store: Map<string, Stored>;
let groupStore: Map<number, { name: string; isSmart: boolean }>;
let putFailsFor: Set<string>;
let putIgnoredFor: Set<string>; // PUT succeeds but nothing is stored
let putMutatesOther: Set<string>; // PUT succeeds and also changes a non-scope field
let putRewritesPayload: Map<string, string>; // PUT succeeds and Jamf stores this payload text instead
let readFailsAfterPut: Set<string>;
let putLog: Array<{ url: string; body: string }>;
let putDone: Set<string>;

const res = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : status === 500 ? 'Server Error' : 'OK',
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as unknown as Response;

const refs = (ids: number[]) => ids.map((id) => ({ id, name: `n${id}` }));

function render(key: string, s: Stored) {
  const scope = {
    all_computers: s.allComputers ?? false,
    computers: [],
    computer_groups: refs(s.groups),
    buildings: [],
    departments: [],
    exclusions: { computers: [], computer_groups: [], buildings: [], departments: [], users: [] },
    ...s.extraScope,
  };
  if (s.kind === 'profile') {
    return {
      os_x_configuration_profile: {
        general: { id: 1, name: key, redeploy_on_update: s.redeploy ?? 'Newly Assigned', payloads: s.payload ?? SECRET_MARKER },
        scope,
      },
    };
  }
  return { policy: { general: { id: 1, name: key, enabled: true, note: s.payload ?? 'x' }, scope } };
}

function idsFromXml(xml: string): number[] {
  const block = (xml.match(/<scope>[\s\S]*?<computer_groups>([\s\S]*?)<\/computer_groups>/) ?? [])[1] ?? '';
  return [...block.matchAll(/<id>(\d+)<\/id>/g)].map((m) => Number(m[1]));
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  store = new Map();
  groupStore = new Map([
    [901, { name: 'Group Z', isSmart: true }],
    [902, { name: 'Group A', isSmart: true }],
    [903, { name: 'Group B', isSmart: false }],
  ]);
  putFailsFor = new Set();
  putIgnoredFor = new Set();
  putMutatesOther = new Set();
  putRewritesPayload = new Map();
  readFailsAfterPut = new Set();
  putLog = [];
  putDone = new Set();
  fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/auth/token')) return res({ access_token: 'tok', expires_in: 900, token_type: 'Bearer' });
    const group = u.match(/computergroups\/id\/(\d+)/);
    if (group) {
      const g = groupStore.get(Number(group[1]));
      if (!g) return res('not found', 404);
      return res({ computer_group: { id: Number(group[1]), name: g.name, is_smart: g.isSmart } });
    }
    // The policy list, which the engine reads to refuse a policy whose name is shared (JPM-0014).
    if (/\/policies$/.test(u)) {
      const policies = [...store.entries()].filter(([, v]) => v.kind === 'policy');
      return res({ policies: policies.map(([k]) => ({ id: Number(k.split(':')[1]), name: k })) });
    }
    const obj = u.match(/(osxconfigurationprofiles|policies)\/id\/(\d+)/);
    if (!obj) return res('unexpected', 500);
    const key = `${obj[1] === 'policies' ? 'policy' : 'profile'}:${obj[2]}`;
    const s = store.get(key);
    if (init?.method === 'PUT') {
      const body = String(init.body);
      putLog.push({ url: u, body });
      if (putFailsFor.has(key)) return res('boom', 500);
      if (s && !putIgnoredFor.has(key)) {
        s.groups = idsFromXml(body);
        if (putMutatesOther.has(key)) s.payload = 'changed-by-jamf';
        const rewritten = putRewritesPayload.get(key);
        if (rewritten !== undefined) s.payload = rewritten;
      }
      putDone.add(key);
      return res('<id>1</id>', 201);
    }
    if (putDone.has(key) && readFailsAfterPut.has(key)) return res('boom', 500);
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
  now: () => new Date('2026-11-05T12:00:00.000Z'),
});
const puts = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
const getsOf = (fragment: string) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes(fragment) && (c[1] as RequestInit | undefined)?.method !== 'PUT');

type Op = { kind: Kind; id: number; action: 'add' | 'remove'; computerGroupId: number };
const op = (kind: Kind, id: number, action: 'add' | 'remove', computerGroupId: number): Op => ({
  kind,
  id,
  action,
  computerGroupId,
});

function seed() {
  store.set('profile:501', { kind: 'profile', groups: [901] });
  store.set('profile:502', { kind: 'profile', groups: [901, 903] });
  store.set('policy:601', { kind: 'policy', groups: [901] });
}
const standardOps = (): Op[] => [
  op('profile', 501, 'add', 902),
  op('profile', 502, 'remove', 903),
  op('profile', 501, 'remove', 901),
  op('policy', 601, 'add', 902),
];

async function dry(operations: Op[]) {
  const out = (await applyScopeMembershipBatch(ctx(), { operations })) as Record<string, any>;
  return out;
}
const live = (operations: Op[], planHash: string | undefined, c = ctx()) =>
  applyScopeMembershipBatch(c, { operations, dryRun: false, planHash });

describe('input schema', () => {
  const one = op('profile', 1, 'add', 2);
  it('is strict and bounds the operation count to 1..150', () => {
    expect(scopeMembershipBatchInputSchema.safeParse({ operations: [one] }).success).toBe(true);
    expect(scopeMembershipBatchInputSchema.safeParse({ operations: [] }).success).toBe(false);
    expect(scopeMembershipBatchInputSchema.safeParse({ operations: Array(150).fill(one) }).success).toBe(true);
    expect(scopeMembershipBatchInputSchema.safeParse({ operations: Array(151).fill(one) }).success).toBe(false);
    expect(scopeMembershipBatchInputSchema.safeParse({ operations: [one], extra: 1 }).success).toBe(false);
    expect(scopeMembershipBatchInputSchema.safeParse({ operations: [{ ...one, extra: 1 }] }).success).toBe(false);
    expect(scopeMembershipBatchInputSchema.safeParse({ operations: [{ ...one, kind: 'script' }] }).success).toBe(false);
    expect(scopeMembershipBatchInputSchema.safeParse({ operations: [{ ...one, id: 0 }] }).success).toBe(false);
    expect(scopeMembershipBatchInputSchema.safeParse({ operations: [{ ...one, computerGroupId: 1.5 }] }).success).toBe(false);
  });

  it('rejects more than 150 operations when called directly, before any request', async () => {
    const many = Array.from({ length: 151 }, (_, i) => op('profile', i + 1, 'add', 902));
    await expect(applyScopeMembershipBatch(ctx(), { operations: many })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('dry run', () => {
  it('groups by object in first-appearance order, reads each object and group once, and never PUTs', async () => {
    seed();
    const out = await dry(standardOps());
    expect(out.ok).toBe(true);
    expect(out.dryRun).toBe(true);
    expect(out.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.objects.map((o: any) => `${o.kind}:${o.id}`)).toEqual(['profile:501', 'profile:502', 'policy:601']);
    expect(out.objects[0].before.computerGroupIds).toEqual([901]);
    expect(out.objects[0].after.computerGroupIds).toEqual([902]);
    expect(out.objects[0].operations).toEqual([
      { action: 'add', computerGroupId: 902 },
      { action: 'remove', computerGroupId: 901 },
    ]);
    expect(out.objects[1].after.computerGroupIds).toEqual([901]);
    expect(out.objects[2].warnings.length).toBeGreaterThan(0);
    expect(out.totals).toMatchObject({ objects: 3, operations: 4, adds: 2, removes: 2, groups: 3 });
    expect(puts()).toHaveLength(0);
    expect(getsOf('osxconfigurationprofiles/id/501')).toHaveLength(1);
    expect(getsOf('computergroups/id/902')).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain('payloads');
    expect(JSON.stringify(out)).not.toContain(SECRET_MARKER);
  });

  it('gives the same planHash for the same state and a different one when the operations differ', async () => {
    seed();
    const a = await dry(standardOps());
    const b = await dry(standardOps());
    expect(b.planHash).toBe(a.planHash);
    const c = await dry(standardOps().slice(0, 3));
    expect(c.planHash).not.toBe(a.planHash);
  });

  it('warns when a group is also in the exclusions', async () => {
    store.set('policy:601', { kind: 'policy', groups: [901], extraScope: { exclusions: { computers: [], computer_groups: refs([902]), buildings: [], departments: [] } } });
    const out = await dry([op('policy', 601, 'add', 902)]);
    expect(out.ok).toBe(true);
    expect(out.objects[0].warnings.join(' ')).toMatch(/also in this policy's exclusions/);
  });
});

describe('refusals', () => {
  async function expectRefused(operations: Op[], reason: RegExp) {
    const out = await dry(operations);
    expect(out.ok).toBe(false);
    expect(out).not.toHaveProperty('planHash');
    expect(out).not.toHaveProperty('objects');
    expect(out.refusals.some((r: any) => reason.test(r.reason)), JSON.stringify(out.refusals)).toBe(true);
    expect(puts()).toHaveLength(0);
    return out;
  }

  it('refuses a duplicate (object, group)', async () => {
    seed();
    await expectRefused([op('profile', 501, 'add', 902), op('profile', 501, 'add', 902)], /more than once/);
  });

  it('refuses an add of a group already present', async () => {
    seed();
    await expectRefused([op('profile', 501, 'add', 903), op('profile', 502, 'add', 903)], /already in/);
  });

  it('refuses a remove of a group not present', async () => {
    seed();
    await expectRefused([op('profile', 501, 'remove', 903)], /is not in/);
  });

  it('refuses a missing group', async () => {
    seed();
    await expectRefused([op('profile', 501, 'add', 999)], /does not exist/);
  });

  it('refuses a missing object', async () => {
    await expectRefused([op('policy', 698, 'add', 902)], /could not be read/);
  });

  it('refuses an unmodelled scope member, naming it', async () => {
    store.set('policy:601', { kind: 'policy', groups: [901], extraScope: { limitations: { users: [{ id: 1 }] } } });
    await expectRefused([op('policy', 601, 'add', 902)], /scope\.limitations/);
  });

  it('refuses All Computers', async () => {
    store.set('policy:601', { kind: 'policy', groups: [], allComputers: true });
    await expectRefused([op('policy', 601, 'add', 902)], /All Computers/);
  });

  it('refuses a profile whose redeploy_on_update is not "Newly Assigned"', async () => {
    store.set('profile:501', { kind: 'profile', groups: [901], redeploy: 'All' });
    await expectRefused([op('profile', 501, 'add', 902)], /Newly Assigned/);
  });

  it('applies the profile-only redeploy rule to profiles, not policies', async () => {
    store.set('policy:601', { kind: 'policy', groups: [901], redeploy: 'All' });
    expect((await dry([op('policy', 601, 'add', 902)])).ok).toBe(true);
  });

  it('returns every refusal, and one refused operation withholds the plan for the whole batch', async () => {
    seed();
    const out = await expectRefused(
      [op('profile', 501, 'add', 902), op('profile', 502, 'add', 903), op('policy', 601, 'remove', 902)],
      /already in/,
    );
    expect(out.refusals).toHaveLength(2);
    expect(out.refusals[0]).toMatchObject({ kind: 'profile', id: 502, operation: { action: 'add', computerGroupId: 903 } });
  });

  it('a live call with a refusable plan writes nothing', async () => {
    seed();
    const out = (await live([op('profile', 501, 'add', 901)], 'a'.repeat(64))) as Record<string, any>;
    expect(out.ok).toBe(false);
    expect(puts()).toHaveLength(0);
  });
});

describe('live run guards', () => {
  it('refuses a live call without planHash, before any request', async () => {
    seed();
    await expect(live(standardOps(), undefined)).rejects.toThrow(/requires planHash/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a wrong planHash with zero PUTs', async () => {
    seed();
    await expect(live(standardOps(), 'f'.repeat(64))).rejects.toThrow(/live state changed since the dry run; dry-run again/);
    expect(puts()).toHaveLength(0);
  });

  it('refuses when a scope changed after the dry run', async () => {
    seed();
    const { planHash } = await dry(standardOps());
    store.set('policy:601', { kind: 'policy', groups: [901, 950] });
    await expect(live(standardOps(), planHash)).rejects.toThrow(/live state changed/);
    expect(puts()).toHaveLength(0);
  });

  it('refuses when a non-scope field changed after the dry run', async () => {
    seed();
    const { planHash } = await dry(standardOps());
    const s = store.get('profile:502') as Stored;
    s.payload = 'edited-elsewhere';
    await expect(live(standardOps(), planHash)).rejects.toThrow(/live state changed/);
    expect(puts()).toHaveLength(0);
  });

  it('refuses when a group changed after the dry run', async () => {
    seed();
    const { planHash } = await dry(standardOps());
    groupStore.set(902, { name: 'Group A renamed', isSmart: true });
    await expect(live(standardOps(), planHash)).rejects.toThrow(/live state changed/);
    expect(puts()).toHaveLength(0);
  });

  it('refuses when writes are disabled, after the reads and before any PUT', async () => {
    seed();
    const { planHash } = await dry(standardOps());
    fetchMock.mockClear();
    await expect(live(standardOps(), planHash, ctx(false))).rejects.toThrow(/Writes are disabled/);
    expect(puts()).toHaveLength(0);
    expect(getsOf('osxconfigurationprofiles/id/501').length).toBeGreaterThan(0);
  });
});

describe('live run', () => {
  it('sends one PUT per object carrying the final scope, verifies, and returns an inverse rollback', async () => {
    seed();
    const { planHash } = await dry(standardOps());
    const out = (await live(standardOps(), planHash)) as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(puts()).toHaveLength(3);
    expect(putLog.map((p) => p.url.match(/(osxconfigurationprofiles|policies)\/id\/\d+/)?.[0])).toEqual([
      'osxconfigurationprofiles/id/501',
      'osxconfigurationprofiles/id/502',
      'policies/id/601',
    ]);
    expect(idsFromXml(putLog[0]?.body ?? '')).toEqual([902]);
    expect(idsFromXml(putLog[1]?.body ?? '')).toEqual([901]);
    expect(idsFromXml(putLog[2]?.body ?? '')).toEqual([901, 902]);
    for (const p of putLog) {
      expect(p.body).not.toContain('payloads');
      expect(p.body).not.toContain('<general');
    }
    expect(out.objects.map((o: any) => o.status)).toEqual(['written', 'written', 'written']);
    expect(out.objects[0]).toMatchObject({
      verified: true,
      otherFieldsUnchanged: true,
      differingSections: [],
      error: null,
      writtenAt: '2026-11-05T12:00:00.000Z',
    });
    expect(out.totals).toMatchObject({ objects: 3, operations: 4, written: 3, failed: 0, notAttempted: 0 });
    expect(out.rollback.tool).toBe('applyScopeMembershipBatch');
    expect(out.rollback.dryRun).toBe(true);
    expect(out.rollback.note).toMatch(/dry-run/);
    expect(out.rollback.operations).toEqual([
      op('policy', 601, 'remove', 902),
      op('profile', 502, 'add', 903),
      op('profile', 501, 'add', 901),
      op('profile', 501, 'remove', 902),
    ]);
    // One stderr line per object written; stdout is the transport.
    const lines = (console.error as any).mock.calls.filter((c: unknown[]) => /batch: set scope of/.test(String(c[0])));
    expect(lines).toHaveLength(3);
    expect(JSON.stringify(out)).not.toContain('payloads');
    expect(JSON.stringify(out)).not.toContain(SECRET_MARKER);
    expect(JSON.stringify(lines)).not.toContain(SECRET_MARKER);
  });

  it('the rollback, dry-run and applied, restores the original scopes', async () => {
    seed();
    const { planHash } = await dry(standardOps());
    const out = (await live(standardOps(), planHash)) as Record<string, any>;
    const rb = await dry(out.rollback.operations);
    expect(rb.ok).toBe(true);
    const back = (await live(out.rollback.operations, rb.planHash)) as Record<string, any>;
    expect(back.ok).toBe(true);
    expect((store.get('profile:501') as Stored).groups).toEqual([901]);
    expect((store.get('profile:502') as Stored).groups).toEqual([901, 903]);
    expect((store.get('policy:601') as Stored).groups).toEqual([901]);
  });

  describe('stop on first failure', () => {
    async function run(prepare: () => void) {
      seed();
      const { planHash } = await dry(standardOps());
      prepare();
      return (await live(standardOps(), planHash)) as Record<string, any>;
    }

    // JPM-0014 amends JPM-0010 here: a PUT Jamf answers with an HTTP error is not a write,
    // so its object is kept out of the rollback and listed under notWritten instead.
    it('a PUT error stops the batch; later objects are notAttempted and the rejected object is not in the rollback', async () => {
      const out = await run(() => putFailsFor.add('profile:502'));
      expect(out.ok).toBe(false);
      expect(out.objects.map((o: any) => o.status)).toEqual(['written', 'failed', 'notAttempted']);
      expect(out.objects[1].error).toMatch(/PUT failed: Jamf answered HTTP 500/);
      expect(out.objects[1]).toMatchObject({ rejectedWithHttpStatus: 500, writtenAt: null });
      expect(out.objects[2]).toMatchObject({ writtenAt: null, verified: null });
      expect(puts()).toHaveLength(2);
      expect(out.totals).toMatchObject({ written: 1, failed: 1, notAttempted: 1, rejectedByJamf: 1 });
      expect(out.rollback.operations).toEqual([op('profile', 501, 'add', 901), op('profile', 501, 'remove', 902)]);
      expect(out.rollback.notWritten).toEqual([
        { kind: 'profile', id: 502, httpStatus: 500, inverseOperationsIfItLanded: [op('profile', 502, 'add', 903)] },
      ]);
      expect(out.rollback.operations.some((o: Op) => o.kind === 'policy')).toBe(false);
    });

    it('a scope mismatch on read-back stops the batch and is rolled back', async () => {
      const out = await run(() => putIgnoredFor.add('profile:501'));
      expect(out.objects.map((o: any) => o.status)).toEqual(['failed', 'notAttempted', 'notAttempted']);
      expect(out.objects[0]).toMatchObject({ verified: false, otherFieldsUnchanged: true });
      expect(out.objects[0].error).toMatch(/scope mismatch/);
      expect(puts()).toHaveLength(1);
      expect(out.rollback.operations).toEqual([op('profile', 501, 'add', 901), op('profile', 501, 'remove', 902)]);
    });

    it('a changed non-scope section stops the batch even when the scope verified', async () => {
      const out = await run(() => putMutatesOther.add('profile:501'));
      expect(out.objects.map((o: any) => o.status)).toEqual(['failed', 'notAttempted', 'notAttempted']);
      expect(out.objects[0]).toMatchObject({ verified: true, otherFieldsUnchanged: false, differingSections: ['general'] });
      expect(puts()).toHaveLength(1);
    });

    it('a read-back error stops the batch', async () => {
      const out = await run(() => readFailsAfterPut.add('profile:501'));
      expect(out.objects.map((o: any) => o.status)).toEqual(['failed', 'notAttempted', 'notAttempted']);
      expect(out.objects[0].error).toMatch(/reading it back failed/);
      expect(out.rollback.operations).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// JPM-0011: Jamf regenerates inner payload identifiers on a scope-only PUT.
// ---------------------------------------------------------------------------
describe('Jamf payload identifier normalisation (JPM-0011)', () => {
  const U = (n: number) => `deadbeef-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const SETTING = 'SETTING-VALUE-MARKER-XYZ';
  const plist = (o: { top?: number; inner?: number; setting?: string; compact?: boolean }) => {
    const nl = o.compact ? '' : '\n\t';
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<plist version="${o.compact ? '1' : '1.0'}"><dict>${nl}<key>PayloadUUID</key><string>${U(o.top ?? 1)}</string>` +
      `${nl}<key>PayloadContent</key><array><dict><key>PayloadUUID</key><string>${U(o.inner ?? 10)}</string>` +
      `<key>PayloadIdentifier</key><string>com.example.inner.${o.inner ?? 10}</string>` +
      `<key>Setting</key><string>${o.setting ?? SETTING}</string></dict></array></dict></plist>`
    );
  };
  const seedPlists = () => {
    store.set('profile:501', { kind: 'profile', groups: [901], payload: plist({}) });
    store.set('profile:502', { kind: 'profile', groups: [901, 903], payload: plist({}) });
    store.set('policy:601', { kind: 'policy', groups: [901] });
  };
  const text = (out: unknown) =>
    JSON.stringify(out) + JSON.stringify(putLog) + JSON.stringify((console.error as any).mock.calls);

  it('marks a normalised object written, reports counts only, and continues', async () => {
    seedPlists();
    const { planHash } = await dry(standardOps());
    putRewritesPayload.set('profile:501', plist({ inner: 20, compact: true }));
    putRewritesPayload.set('profile:502', plist({ inner: 30, compact: true }));
    const out = (await live(standardOps(), planHash)) as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(out.stoppedOnFailure).toBe(false);
    expect(out.objects.map((o: any) => o.status)).toEqual(['written', 'written', 'written']);
    for (const o of out.objects.slice(0, 2)) {
      expect(o).toMatchObject({
        verified: true,
        otherFieldsUnchanged: false,
        differingSections: ['general'],
        normalizedByJamf: { section: 'general', payloadIdentifiersRegenerated: 1 },
        otherFieldsSemanticallyUnchanged: true,
        error: null,
      });
    }
    expect(out.objects[2]).toMatchObject({ otherFieldsUnchanged: true });
    expect(out.objects[2]).not.toHaveProperty('normalizedByJamf');
    expect(out.totals).toMatchObject({ written: 3, failed: 0, notAttempted: 0 });
    expect(puts()).toHaveLength(3);
    for (const secret of [SETTING, 'deadbeef-', 'PayloadUUID', 'com.example.inner']) expect(text(out)).not.toContain(secret);
  });

  it.each([
    ['an inner setting change', plist({ inner: 20, setting: 'changed', compact: true })],
    ['a top-level PayloadUUID change', plist({ inner: 20, top: 2, compact: true })],
    ['an unparseable plist', 'not a plist'],
  ])('stops the batch on %s', async (_name, rewritten) => {
    seedPlists();
    const { planHash } = await dry(standardOps());
    putRewritesPayload.set('profile:501', rewritten);
    const out = (await live(standardOps(), planHash)) as Record<string, any>;
    expect(out.ok).toBe(false);
    expect(out.objects.map((o: any) => o.status)).toEqual(['failed', 'notAttempted', 'notAttempted']);
    expect(out.objects[0]).toMatchObject({ otherFieldsUnchanged: false, differingSections: ['general'] });
    expect(out.objects[0]).not.toHaveProperty('normalizedByJamf');
    expect(out.objects[0].error).toMatch(/non-scope sections changed/);
    expect(puts()).toHaveLength(1);
  });

  it('a policy is unaffected: a changed non-scope field still stops the batch', async () => {
    store.set('policy:601', { kind: 'policy', groups: [901], payload: plist({}) });
    const ops = [op('policy', 601, 'add', 902)];
    const { planHash } = await dry(ops);
    putRewritesPayload.set('policy:601', plist({ inner: 20, compact: true }));
    const out = (await live(ops, planHash)) as Record<string, any>;
    expect(out.ok).toBe(false);
    expect(out.objects[0]).toMatchObject({ status: 'failed', differingSections: ['general'] });
    expect(out.objects[0]).not.toHaveProperty('normalizedByJamf');
  });

  it('planHash still binds the raw non-scope fingerprint', async () => {
    seedPlists();
    const { planHash } = await dry(standardOps());
    (store.get('profile:501') as Stored).payload = plist({ inner: 20, compact: true });
    await expect(live(standardOps(), planHash)).rejects.toThrow(/live state changed since the dry run/);
    expect(puts()).toHaveLength(0);
  });
});
