import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from './config.js';
import {
  buildFlushRequest,
  buildLogFlushXml,
  flushPolicyLogs,
  flushPolicyLogsInputSchema,
  intervalPathSegment,
  LOG_FLUSH_INTERVALS,
  type FlushPolicyLogsInput,
} from './flush-policy-logs.js';
import type { WriteContext } from './restricted-software.js';
import { assertWriteServerRequestAllowed, WriteRouteGuardClient } from './write-route-guard.js';

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
    statusText: status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'OK',
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

function gatewayCalls() {
  return fetchMock.mock.calls
    .filter((c) => !String(c[0]).endsWith('/auth/token'))
    .map((c) => ({ url: String(c[0]), init: c[1] as RequestInit }));
}

const ctx = (writesEnabled = true): WriteContext => ({
  client: new WriteRouteGuardClient(config),
  writesEnabled,
  now: () => new Date('2026-11-10T12:00:00.000Z'),
});

const policy = (overrides: Record<string, unknown> = {}) => ({
  policy: {
    general: { id: 7, name: 'Example: Install App', enabled: true, frequency: 'Once per computer', ...overrides },
    scope: {
      all_computers: false,
      computers: [{ id: 11, name: 'example-mac-1' }],
      computer_groups: [{ id: 3, name: 'Example Group' }],
      exclusions: { computers: [], computer_groups: [] },
    },
  },
});

const listedInput: FlushPolicyLogsInput = {
  policyId: 7,
  computers: { computerIds: [11, 12] },
  interval: 'Zero Days',
};
const allInput: FlushPolicyLogsInput = { policyId: 7, computers: { allComputers: true }, interval: 'Zero Days' };

describe('flushPolicyLogs input', () => {
  it('requires policyId, computers and interval, with no defaults', () => {
    expect(flushPolicyLogsInputSchema.safeParse(listedInput).success).toBe(true);
    expect(flushPolicyLogsInputSchema.safeParse(allInput).success).toBe(true);
    expect(flushPolicyLogsInputSchema.safeParse({ ...listedInput, interval: undefined }).success).toBe(false);
    expect(flushPolicyLogsInputSchema.safeParse({ ...listedInput, computers: undefined }).success).toBe(false);
    expect(flushPolicyLogsInputSchema.safeParse({ ...listedInput, policyId: undefined }).success).toBe(false);
  });

  it('takes exactly one of computerIds or allComputers true, never both and never inferred', () => {
    const parse = (computers: unknown) => flushPolicyLogsInputSchema.safeParse({ ...listedInput, computers }).success;
    expect(parse({})).toBe(false);
    expect(parse({ allComputers: false })).toBe(false);
    expect(parse({ computerIds: [] })).toBe(false);
    expect(parse({ computerIds: [11], allComputers: true })).toBe(false);
    expect(parse({ computerIds: [11, 11] })).toBe(false);
    expect(parse({ computerIds: Array.from({ length: 101 }, (_, i) => i + 1) })).toBe(false);
    expect(parse({ computerIds: [0] })).toBe(false);
  });

  it('accepts only the 20 published intervals and rejects unknown fields', () => {
    expect(LOG_FLUSH_INTERVALS).toHaveLength(20);
    expect(flushPolicyLogsInputSchema.safeParse({ ...listedInput, interval: 'Three Months' }).success).toBe(true);
    expect(flushPolicyLogsInputSchema.safeParse({ ...listedInput, interval: 'Zero days' }).success).toBe(false);
    expect(flushPolicyLogsInputSchema.safeParse({ ...listedInput, interval: 'Ten Days' }).success).toBe(false);
    expect(flushPolicyLogsInputSchema.safeParse({ ...listedInput, log: 'computer' }).success).toBe(false);
  });
});

describe('flush request', () => {
  it('builds the published XML body for listed computers', () => {
    expect(buildLogFlushXml(7, 'Zero Days', [11, 12])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><logflush><log>policy</log><log_id>7</log_id>' +
        '<interval>Zero Days</interval><computers><computer><id>11</id></computer>' +
        '<computer><id>12</id></computer></computers></logflush>',
    );
  });

  it('uses the one-policy path for all computers, with the interval spelled with +', () => {
    expect(intervalPathSegment('Three Months')).toBe('Three+Months');
    expect(buildFlushRequest(allInput)).toMatchObject({
      service: 'proclassic',
      style: 'classic',
      resource: 'logflush/policy/id/7/interval/Zero+Days',
      method: 'DELETE',
    });
    expect(buildFlushRequest(allInput).body).toBeUndefined();
  });

  it('builds only requests the route guard allows, for every interval', () => {
    for (const interval of LOG_FLUSH_INTERVALS) {
      for (const input of [listedInput, allInput]) {
        expect(() => assertWriteServerRequestAllowed(buildFlushRequest({ ...input, interval }))).not.toThrow();
      }
    }
  });
});

describe('flushPolicyLogs dry run', () => {
  it('reads the policy, shows the exact request and a planHash, and sends no DELETE', async () => {
    stub(res(policy()));
    const result = await flushPolicyLogs(ctx(), listedInput);
    expect(result.dryRun).toBe(true);
    expect(result.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.policy).toMatchObject({ id: 7, name: 'Example: Install App', enabled: true, frequency: 'Once per computer' });
    expect(result.policy.scope).toEqual({
      allComputers: false,
      computers: 1,
      computerGroups: 1,
      excludedComputers: 0,
      excludedComputerGroups: 0,
    });
    expect(result.request).toEqual({
      method: 'DELETE',
      path: '/proclassic/logflush',
      contentType: 'application/xml',
      body: buildLogFlushXml(7, 'Zero Days', [11, 12]),
    });
    expect(result.checkBeforeAndAfter).toMatchObject({
      tool: 'platformRequest',
      calls: [
        { service: 'proclassic', style: 'classic', resource: 'computerhistory/id/11/subset/PolicyLogs' },
        { service: 'proclassic', style: 'classic', resource: 'computerhistory/id/12/subset/PolicyLogs' },
      ],
    });
    expect(result.rollback.possible).toBe(false);
    const calls = gatewayCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://us.api.jamfcloud.com/proclassic/policies/id/7');
    expect(calls[0].init.method).toBe('GET');
  });

  it('warns about frequency, interval, unchecked ids and all computers', async () => {
    stub(res(policy({ frequency: 'Ongoing', enabled: false })));
    const listed = await flushPolicyLogs(ctx(), { ...listedInput, interval: 'One Weeks' });
    const text = listed.warnings.join('\n');
    expect(text).toMatch(/frequency is "Ongoing"/);
    expect(text).toMatch(/disabled/);
    expect(text).toMatch(/NOT checked/);
    expect(text).toMatch(/"One Weeks" keeps entries newer/);

    stub(res(policy()));
    const all = await flushPolicyLogs(ctx(), allInput);
    expect(all.warnings.join('\n')).toMatch(/allComputers: every computer/);
    expect(all.request).toEqual({ method: 'DELETE', path: '/proclassic/logflush/policy/id/7/interval/Zero+Days' });
    expect(all.checkBeforeAndAfter).toHaveProperty('template');
  });

  it('refuses a policy that does not exist', async () => {
    stub(res('Not Found', 404));
    await expect(flushPolicyLogs(ctx(), listedInput)).rejects.toThrow(/Policy 7 does not exist.*Nothing was flushed/s);
  });

  it('works with writes disabled', async () => {
    stub(res(policy()));
    expect((await flushPolicyLogs(ctx(false), listedInput)).dryRun).toBe(true);
  });

  it('gives a different planHash for different computers, interval or policy state', async () => {
    stub(res(policy()), res(policy()), res(policy()), res(policy({ enabled: false })), res(policy()));
    const one = ctx();
    const a = (await flushPolicyLogs(one, listedInput)).planHash;
    const b = (await flushPolicyLogs(one, { ...listedInput, computers: { computerIds: [11] } })).planHash;
    const c = (await flushPolicyLogs(one, { ...listedInput, interval: 'Zero Weeks' })).planHash;
    const d = (await flushPolicyLogs(one, listedInput)).planHash;
    const again = (await flushPolicyLogs(one, listedInput)).planHash;
    expect(again).toBe(a);
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe('flushPolicyLogs live', () => {
  async function dryRunHash(input: FlushPolicyLogsInput) {
    stub(res(policy()));
    return (await flushPolicyLogs(ctx(), input)).planHash;
  }

  it('requires a planHash and refuses a stale one without sending anything', async () => {
    await expect(flushPolicyLogs(ctx(), { ...listedInput, dryRun: false })).rejects.toThrow(/requires planHash/);
    expect(fetchMock).not.toHaveBeenCalled();

    const planHash = await dryRunHash(listedInput);
    fetchMock.mockReset();
    stub(res(policy({ enabled: false })));
    await expect(flushPolicyLogs(ctx(), { ...listedInput, dryRun: false, planHash })).rejects.toThrow(/planHash does not match/);
    expect(gatewayCalls().every((c) => c.init.method === 'GET')).toBe(true);
  });

  it('refuses with writes disabled', async () => {
    const planHash = await dryRunHash(listedInput);
    fetchMock.mockReset();
    stub(res(policy()));
    await expect(flushPolicyLogs(ctx(false), { ...listedInput, dryRun: false, planHash })).rejects.toThrow(/Writes are disabled/);
    expect(gatewayCalls().every((c) => c.init.method === 'GET')).toBe(true);
  });

  it('sends the DELETE, reads the policy back, and never calls the flush verified', async () => {
    const planHash = await dryRunHash(listedInput);
    fetchMock.mockReset();
    stub(res(policy()), res(''), res(policy()));
    const result = await flushPolicyLogs(ctx(), { ...listedInput, dryRun: false, planHash });

    const calls = gatewayCalls();
    expect(calls.map((c) => c.init.method)).toEqual(['GET', 'DELETE', 'GET']);
    expect(calls[1].url).toBe('https://us.api.jamfcloud.com/proclassic/logflush');
    expect((calls[1].init.headers as Record<string, string>)['Content-Type']).toBe('application/xml');
    expect(calls[1].init.body).toBe(buildLogFlushXml(7, 'Zero Days', [11, 12]));

    expect(result.dryRun).toBe(false);
    expect(result.accepted).toBe(true);
    expect(result.writtenAt).toBe('2026-11-10T12:00:00.000Z');
    expect(result.verification.flushVerified).toBe(false);
    expect(result.verification.policyReadBack).toEqual({ present: true, unchanged: true });
  });

  it('flushes all computers through the one-policy path', async () => {
    const planHash = await dryRunHash(allInput);
    fetchMock.mockReset();
    stub(res(policy()), res(''), res(policy()));
    await flushPolicyLogs(ctx(), { ...allInput, dryRun: false, planHash });
    const del = gatewayCalls()[1];
    expect(del.init.method).toBe('DELETE');
    expect(del.url).toBe('https://us.api.jamfcloud.com/proclassic/logflush/policy/id/7/interval/Zero+Days');
    expect(del.init.body).toBeUndefined();
  });

  it('reports a rejected flush as NOT flushed and does not read back', async () => {
    const planHash = await dryRunHash(listedInput);
    fetchMock.mockReset();
    stub(res(policy()), res('<html><body>Conflict</body></html>', 409));
    await expect(flushPolicyLogs(ctx(), { ...listedInput, dryRun: false, planHash })).rejects.toThrow(
      /HTTP 409.*NOT flushed/s,
    );
    expect(gatewayCalls().map((c) => c.init.method)).toEqual(['GET', 'DELETE']);
  });

  it('says a request with no response may or may not have been applied', async () => {
    const planHash = await dryRunHash(listedInput);
    fetchMock.mockReset();
    stub(res(policy()));
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(flushPolicyLogs(ctx(), { ...listedInput, dryRun: false, planHash })).rejects.toThrow(
      /no HTTP response.*may or may not/s,
    );
  });

  it('flags a policy that is missing or changed after the flush', async () => {
    const planHash = await dryRunHash(listedInput);
    fetchMock.mockReset();
    stub(res(policy()), res(''), res('Not Found', 404));
    const gone = await flushPolicyLogs(ctx(), { ...listedInput, dryRun: false, planHash });
    expect(gone.verification.policyReadBack).toMatchObject({ present: false });

    fetchMock.mockReset();
    stub(res(policy()), res(''), res(policy({ name: 'Example: Renamed' })));
    const changed = await flushPolicyLogs(ctx(), { ...listedInput, dryRun: false, planHash });
    expect(changed.verification.policyReadBack).toMatchObject({ present: true, unchanged: false });
  });
});
