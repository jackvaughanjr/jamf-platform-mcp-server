import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from './config.js';
import { JamfPlatformApiError, JamfPlatformClient, inferPagingFamily } from './platform-client.js';

const config: Config = {
  clientId: 'id',
  clientSecret: 'secret',
  tenantId: 'TENANT',
  gatewayBaseUrl: 'https://us.apigw.jamf.com',
  tokenUrl: 'https://us.apigw.jamf.com/auth/token',
  readOnly: false,
};

/** Minimal Response stand-in; the client only uses ok/status/statusText/text(). */
function res(body: unknown, init: { status?: number; statusText?: string } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? 'OK',
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const tokenBody = { access_token: 'tok', expires_in: 900, token_type: 'Bearer' };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Answers the token request, then each subsequent call from `pages` in order. */
function stubTokenThen(...pages: Response[]) {
  fetchMock.mockResolvedValueOnce(res(tokenBody));
  for (const p of pages) fetchMock.mockResolvedValueOnce(p);
}

/**
 * Query parameters of the nth *gateway* request, token requests excluded.
 *
 * Every test here stubs fetch, so the URL actually requested is the only evidence
 * of what was sent. Parsed rather than substring-matched because `page-size=2`
 * contains `size=2` — the exact confusion these tests exist to catch.
 */
function paramsOf(nth: number): URLSearchParams {
  const calls = fetchMock.mock.calls.filter((c) => !String(c[0]).endsWith('/auth/token'));
  return new URL(String(calls[nth]?.[0])).searchParams;
}

describe('buildUrl', () => {
  const client = new JamfPlatformClient(config);

  it('builds the tenant style, which is the only shape observed to work', () => {
    expect(client.buildUrl({ service: 'blueprints', resource: 'blueprints' })).toBe(
      'https://us.apigw.jamf.com/api/blueprints/v1/tenant/TENANT/blueprints',
    );
  });

  // Jamf Pro versions are per-resource: account-groups v1, enrollment v3,
  // computers-inventory v4. Defaulting to v1 silently is a 404 waiting to happen.
  it('uses the version given, not v1', () => {
    expect(
      client.buildUrl({ service: 'pro', resource: 'computers-inventory', version: 'v4' }),
    ).toBe('https://us.apigw.jamf.com/api/pro/v4/tenant/TENANT/computers-inventory');
  });

  // Classic has no version segment, and expressing that through rawPath means the
  // caller interpolating the tenant id by hand. A caller without it produces
  // `/tenant//resource` and a 400 REQUEST_CONTEXT_NOT_PROVIDED that says nothing about
  // an empty variable — which is exactly how this was found.
  it('builds classic style with the tenant filled in and no version segment', () => {
    expect(
      client.buildUrl({ service: 'proclassic', resource: 'computergroups/id/41', style: 'classic' }),
    ).toBe('https://us.apigw.jamf.com/api/proclassic/tenant/TENANT/computergroups/id/41');
  });

  it('ignores an explicit version on classic style, which has no version segment', () => {
    expect(
      client.buildUrl({ service: 'proclassic', resource: 'scripts', style: 'classic', version: 'v3' }),
    ).toBe('https://us.apigw.jamf.com/api/proclassic/tenant/TENANT/scripts');
  });

  it('omits the tenant segment for flat style', () => {
    expect(client.buildUrl({ service: 'pro', resource: 'device-declarations', style: 'flat' })).toBe(
      'https://us.apigw.jamf.com/api/pro/v1/device-declarations',
    );
  });

  // The example is Classic's real shape on purpose. An earlier revision used
  // `/JSSResource/computers`, which is mechanically fine for a verbatim-passthrough
  // assertion but teaches a path that does not exist on the gateway.
  it('uses rawPath verbatim, with no version or tenant inserted', () => {
    expect(client.buildUrl({ service: 'proclassic', rawPath: '/tenant/TENANT/scripts' })).toBe(
      'https://us.apigw.jamf.com/api/proclassic/tenant/TENANT/scripts',
    );
  });

  it('accepts a rawPath without a leading slash', () => {
    expect(client.buildUrl({ service: 'proclassic', rawPath: 'tenant/TENANT/scripts' })).toBe(
      'https://us.apigw.jamf.com/api/proclassic/tenant/TENANT/scripts',
    );
  });

  it('tolerates a leading slash on resource', () => {
    expect(client.buildUrl({ service: 'devices', resource: '/devices' })).toBe(
      'https://us.apigw.jamf.com/api/devices/v1/tenant/TENANT/devices',
    );
  });

  it('appends query parameters and drops undefined ones', () => {
    expect(
      client.buildUrl({
        service: 'devices',
        resource: 'devices',
        query: { page: 0, 'page-size': 5, section: undefined },
      }),
    ).toBe('https://us.apigw.jamf.com/api/devices/v1/tenant/TENANT/devices?page=0&page-size=5');
  });

  it('throws when neither resource nor rawPath is given', () => {
    expect(() => client.buildUrl({ service: 'devices' })).toThrow(/resource.*rawPath/);
  });
});

describe('authentication', () => {
  it('caches the token across requests rather than re-fetching per call', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res({ ok: 1 }), res({ ok: 2 }));

    await client.request({ service: 'devices', resource: 'devices' });
    await client.request({ service: 'devices', resource: 'devices' });

    const tokenCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/auth/token'));
    expect(tokenCalls).toHaveLength(1);
  });

  // MCP servers fan out tool calls; without de-duplication a cold start fires one
  // token request per concurrent call.
  it('de-duplicates concurrent refreshes into a single token request', async () => {
    const client = new JamfPlatformClient(config);
    fetchMock.mockImplementation(async (url: unknown) =>
      String(url).endsWith('/auth/token') ? res(tokenBody) : res({ ok: true }),
    );

    await Promise.all([
      client.request({ service: 'devices', resource: 'devices' }),
      client.request({ service: 'devices', resource: 'devices' }),
      client.request({ service: 'devices', resource: 'devices' }),
    ]);

    const tokenCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/auth/token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('sends the token as a bearer header', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res({ ok: true }));
    await client.request({ service: 'devices', resource: 'devices' });

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('posts client credentials form-encoded to the token endpoint', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res({ ok: true }));
    await client.request({ service: 'devices', resource: 'devices' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(config.tokenUrl);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(String(init.body)).toContain('grant_type=client_credentials');
  });

  it('raises a token error without echoing the request body, which holds the secret', async () => {
    const client = new JamfPlatformClient(config);
    fetchMock.mockResolvedValueOnce(res({ error: 'invalid_client' }, { status: 401 }));

    await expect(client.request({ service: 'devices', resource: 'devices' })).rejects.toThrow(
      /Token request failed/,
    );
    // The thrown error must not carry the secret anywhere.
    await expect(
      new JamfPlatformClient(config).getAccessToken().catch((e: Error) => {
        throw new Error(e.message + String((e as JamfPlatformApiError).responseBody ?? ''));
      }),
    ).rejects.not.toThrow(/test-client-secret|secret/);
  });

  it('rejects a 200 token response that carries no access_token', async () => {
    const client = new JamfPlatformClient(config);
    fetchMock.mockResolvedValueOnce(res({ token_type: 'Bearer' }));
    await expect(client.getAccessToken()).rejects.toThrow(/no access_token/);
  });
});

describe('read-only enforcement', () => {
  it('refuses non-GET when readOnly is set, before any network call', async () => {
    const client = new JamfPlatformClient({ ...config, readOnly: true });
    await expect(
      client.request({ service: 'devices', resource: 'devices/1/erase', method: 'POST' }),
    ).rejects.toThrow(/JAMF_READ_ONLY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still permits GET when readOnly is set', async () => {
    const client = new JamfPlatformClient({ ...config, readOnly: true });
    stubTokenThen(res({ ok: true }));
    await expect(client.request({ service: 'devices', resource: 'devices' })).resolves.toEqual({
      ok: true,
    });
  });
});

describe('error handling', () => {
  it('surfaces status, url and body on a failed request', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(
      res({ errors: [{ code: 'BAD_PERMISSIONS' }] }, { status: 403, statusText: 'Forbidden' }),
    );

    const error = await client
      .request({ service: 'blueprints', resource: 'components' })
      .catch((e: unknown) => e as JamfPlatformApiError);

    expect(error).toBeInstanceOf(JamfPlatformApiError);
    expect(error.status).toBe(403);
    expect(error.url).toContain('/api/blueprints/v1/tenant/TENANT/components');
    expect(error.responseBody).toContain('BAD_PERMISSIONS');
  });

  it('returns undefined for an empty body and raw text for non-JSON', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res(''), res('not json'));
    await expect(client.request({ service: 'devices', resource: 'devices' })).resolves.toBeUndefined();
    await expect(client.request({ service: 'devices', resource: 'devices' })).resolves.toBe('not json');
  });
});

describe('requestAll', () => {
  // devices / device-groups expose hasNext.
  it('follows hasNext until it is false', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(
      res({ results: [1, 2], hasNext: true, totalCount: 5 }),
      res({ results: [3, 4], hasNext: true, totalCount: 5 }),
      res({ results: [5], hasNext: false, totalCount: 5 }),
    );

    await expect(
      client.requestAll({ service: 'devices', resource: 'devices', pageSize: 2 }),
    ).resolves.toEqual([1, 2, 3, 4, 5]);
  });

  // blueprints / blueprint-components / pro return totalCount and NO hasNext. A
  // helper keyed on hasNext would return only the first page here, forever.
  it('falls back to totalCount when hasNext is absent', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(
      res({ results: ['a', 'b'], totalCount: 3 }),
      res({ results: ['c'], totalCount: 3 }),
    );

    await expect(
      client.requestAll({ service: 'blueprints', resource: 'blueprints', pageSize: 2 }),
    ).resolves.toEqual(['a', 'b', 'c']);
  });

  it('stops on an empty page when neither hasNext nor totalCount is usable', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res({ results: ['x'] }), res({ results: [] }));

    await expect(
      client.requestAll({ service: 'pro', resource: 'buildings' }),
    ).resolves.toEqual(['x']);
  });

  it('requests 0-based pages using page and page-size', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(
      res({ results: [1], hasNext: true }),
      res({ results: [2], hasNext: false }),
    );

    await client.requestAll({ service: 'devices', resource: 'devices', pageSize: 1 });

    const urls = fetchMock.mock.calls.slice(1).map((c) => String(c[0]));
    expect(urls[0]).toContain('page=0');
    expect(urls[0]).toContain('page-size=1');
    expect(urls[1]).toContain('page=1');
  });

  it('handles the items[] envelope as well as results[]', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res({ items: ['i'], totalCount: 1 }));
    await expect(client.requestAll({ service: 'devices', resource: 'devices' })).resolves.toEqual(['i']);
  });

  // A contract change must surface as an error, not an endless loop.
  it('throws rather than looping past maxPages', async () => {
    const client = new JamfPlatformClient(config);
    fetchMock.mockImplementation(async (url: unknown) =>
      String(url).endsWith('/auth/token') ? res(tokenBody) : res({ results: [1], hasNext: true }),
    );

    await expect(
      client.requestAll({ service: 'devices', resource: 'devices', maxPages: 3 }),
    ).rejects.toThrow(/exceeded maxPages \(3\)/);
  });

  it('returns an empty array when the first page is empty', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res({ results: [], totalCount: 0 }));
    await expect(client.requestAll({ service: 'devices', resource: 'devices' })).resolves.toEqual([]);
  });
});

describe('inferPagingFamily', () => {
  it('treats every uncharacterised segment as page + page-size', () => {
    for (const service of ['devices', 'device-groups', 'blueprints', 'blueprint-components', 'pro']) {
      expect(inferPagingFamily(service), service).toBe('page-size');
    }
  });

  it('knows the two segments that deviate', () => {
    expect(inferPagingFamily('proclassic')).toBe('none');
    expect(inferPagingFamily('ddm/report')).toBe('size');
  });

  // The service may be more than one segment, and matching only the first would
  // claim bare `ddm` is characterised. It is not — `ddm` enumerates as not hosted.
  it('does not let ddm/report characterise bare ddm', () => {
    expect(inferPagingFamily('ddm')).toBe('page-size');
  });

  // A near-miss spelling must not fall through to the generic family, because
  // falling through is exactly how the silent empty result happens.
  it('normalises surrounding slashes and case before matching', () => {
    for (const spelling of ['/proclassic', 'proclassic/', '/proclassic/', 'ProClassic', ' proclassic ']) {
      expect(inferPagingFamily(spelling), spelling).toBe('none');
    }
    expect(inferPagingFamily('/ddm/report/')).toBe('size');
  });
});

describe('requestAll paging families', () => {
  // Classic has no results[], so the old pager saw an empty batch, took the
  // empty-page early exit and returned [] with no error — a false all-clear.
  it('refuses to page proclassic at all, before any network call', async () => {
    const client = new JamfPlatformClient(config);

    await expect(
      client.requestAll({ service: 'proclassic', rawPath: `/tenant/${config.tenantId}/scripts` }),
    ).rejects.toThrow(/no paging envelope/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('points the caller at extractClassicList rather than just refusing', async () => {
    const client = new JamfPlatformClient(config);

    const error = await client
      .requestAll({ service: 'proclassic', rawPath: `/tenant/${config.tenantId}/scripts` })
      .catch((e: unknown) => e as Error);

    expect(error.message).toContain('extractClassicList');
    expect(error.message).toContain('proclassic');
  });

  // Declaration Reporting ignores page-size and applies its default of 20, so
  // sending page-size silently truncates to 20 and reports success.
  it('pages ddm/report with size, and never sends page-size', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(
      res({ results: [1, 2], hasNext: true }),
      res({ results: [3], hasNext: false }),
    );

    // The resource is arbitrary here; only the query string is under test.
    await expect(
      client.requestAll({ service: 'ddm/report', resource: 'declarations', pageSize: 2 }),
    ).resolves.toEqual([1, 2, 3]);

    expect(paramsOf(0).get('size')).toBe('2');
    expect(paramsOf(0).get('page')).toBe('0');
    expect(paramsOf(0).has('page-size')).toBe(false);
    expect(paramsOf(1).get('size')).toBe('2');
    expect(paramsOf(1).get('page')).toBe('1');
    expect(paramsOf(1).has('page-size')).toBe(false);
  });

  it('drops a caller-supplied page-size on the size family instead of sending both', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res({ results: ['a'], hasNext: false }));

    await client.requestAll({
      service: 'ddm/report',
      resource: 'declarations',
      pageSize: 5,
      query: { 'page-size': 999 },
    });

    expect(paramsOf(0).has('page-size')).toBe(false);
    expect(paramsOf(0).get('size')).toBe('5');
  });

  it('keeps page-size and sends no size for the common family', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res({ results: [1], hasNext: false }));

    await client.requestAll({ service: 'devices', resource: 'devices', pageSize: 7 });

    expect(paramsOf(0).get('page-size')).toBe('7');
    expect(paramsOf(0).has('size')).toBe(false);
  });

  // The override exists so a newly discovered size-family segment needs no code
  // change here. It must not leak into the query string as a gateway parameter.
  it('lets pagingFamily override the inferred family without becoming a query parameter', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res({ results: ['x'], hasNext: false }));

    await client.requestAll({
      service: 'devices',
      resource: 'devices',
      pageSize: 3,
      pagingFamily: 'size',
    });

    expect(paramsOf(0).get('size')).toBe('3');
    expect(paramsOf(0).has('page-size')).toBe(false);
    expect(paramsOf(0).has('pagingFamily')).toBe(false);
  });

  it('lets an explicit family opt a non-paging segment back into paging', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res({ results: ['s'], totalCount: 1 }));

    await expect(
      client.requestAll({
        service: 'proclassic',
        rawPath: `/tenant/${config.tenantId}/scripts`,
        pagingFamily: 'page-size',
      }),
    ).resolves.toEqual(['s']);
  });

  it('honours an explicit none for a segment that would otherwise page', async () => {
    const client = new JamfPlatformClient(config);

    await expect(
      client.requestAll({ service: 'devices', resource: 'devices', pagingFamily: 'none' }),
    ).rejects.toThrow(/no paging envelope/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('requestAllWithCount surfaces what the gateway reported', () => {
  it('returns the gateway totalCount alongside the items requestAll would give', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(
      res({ results: ['a', 'b'], totalCount: 3 }),
      res({ results: ['c'], totalCount: 3 }),
    );

    const walk = await client.requestAllWithCount<string>({
      service: 'blueprints',
      resource: 'blueprints',
      pageSize: 2,
    });

    expect(walk.items).toEqual(['a', 'b', 'c']);
    expect(walk.collectedCount).toBe(3);
    expect(walk.reportedTotalCount).toBe(3);
    expect(walk.pagesFetched).toBe(2);
    expect(walk.stoppedBecause).toBe('totalCount');
    expect(walk.complete).toBe(true);
    expect(walk.shortfall).toBeUndefined();
  });

  // The gap this exists for: a walk that ends early for a reason other than
  // maxPages. Exceeding maxPages already throws, so the runaway case is loud; this
  // one currently returns two records with no hint that the gateway said forty.
  it('reports a shortfall rather than throwing when a walk ends short', async () => {
    const client = new JamfPlatformClient(config);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockImplementation(async (url: unknown) => {
      const s = String(url);
      if (s.endsWith('/auth/token')) return res(tokenBody);
      const page = Number(new URL(s).searchParams.get('page'));
      // Claims forty, hands back one short page and then nothing.
      return res(page === 0 ? { results: [1, 2], totalCount: 40 } : { results: [], totalCount: 40 });
    });

    const walk = await client.requestAllWithCount<number>({
      service: 'blueprints',
      resource: 'blueprints',
      pageSize: 2,
    });

    expect(walk.items).toEqual([1, 2]);
    expect(walk.reportedTotalCount).toBe(40);
    expect(walk.shortfall).toBe(38);
    expect(walk.complete).toBe(false);
    expect(walk.stoppedBecause).toBe('emptyPage');

    // A partial answer is still an answer. Throwing here would cost ten existing
    // call sites — several of them allSettled legs — the records they did get.
    await expect(
      client.requestAll({ service: 'blueprints', resource: 'blueprints', pageSize: 2 }),
    ).resolves.toEqual([1, 2]);
  });

  // The array-only callers have no other way to learn the walk came up short, so
  // quiet is acceptable and silent is not.
  it('logs a short walk to stderr, naming both counts, and writes nothing to stdout', async () => {
    const client = new JamfPlatformClient(config);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stubTokenThen(
      res({ results: [1, 2], totalCount: 40 }),
      res({ results: [], totalCount: 40 }),
    );

    await client.requestAll({ service: 'blueprints', resource: 'blueprints', pageSize: 2 });

    expect(stdout).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('collected 2');
    expect(message).toContain('40');
    expect(message).toContain('blueprints/blueprints');
  });

  // "The gateway told me nothing" must not read the same as "the gateway confirmed
  // it was everything" — the false all-clear, in type form.
  it('leaves completeness undefined when no page carried a totalCount', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res({ results: ['x'] }), res({ results: [] }));

    const walk = await client.requestAllWithCount<string>({ service: 'pro', resource: 'buildings' });

    expect(walk.items).toEqual(['x']);
    expect(walk.reportedTotalCount).toBeUndefined();
    expect(walk.stoppedBecause).toBe('emptyPage');
    expect(walk.complete).toBeUndefined();
    // Present-and-undefined, not absent: a caller must handle the unknown case.
    expect('complete' in walk).toBe(true);
  });

  it('treats hasNext:false as known-complete even with no totalCount to corroborate it', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res({ results: [1, 2], hasNext: false }));

    const walk = await client.requestAllWithCount<number>({ service: 'devices', resource: 'devices' });

    expect(walk.complete).toBe(true);
    expect(walk.stoppedBecause).toBe('hasNext');
    expect(walk.reportedTotalCount).toBeUndefined();
    expect(walk.shortfall).toBeUndefined();
  });

  // The gateway contradicting itself is exactly the case worth surfacing: the
  // walk was told to stop, and told the collection was twelve times bigger.
  it('reports the disagreement when hasNext says done but totalCount says more', async () => {
    const client = new JamfPlatformClient(config);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubTokenThen(res({ results: [1, 2], hasNext: false, totalCount: 24 }));

    const walk = await client.requestAllWithCount<number>({ service: 'devices', resource: 'devices' });

    expect(walk.stoppedBecause).toBe('hasNext');
    expect(walk.complete).toBe(false);
    expect(walk.shortfall).toBe(22);
  });

  // Collecting more than promised means the count was stale or the collection
  // grew mid-walk. Nobody is at risk of acting on records that are not there, so
  // it is not a shortfall and must not warn.
  it('does not call a walk short when it collected more than the gateway reported', async () => {
    const client = new JamfPlatformClient(config);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubTokenThen(
      res({ results: [1, 2], totalCount: 3 }),
      res({ results: [3, 4], totalCount: 3 }),
    );

    const walk = await client.requestAllWithCount<number>({
      service: 'blueprints',
      resource: 'blueprints',
      pageSize: 2,
    });

    expect(walk.collectedCount).toBe(4);
    expect(walk.reportedTotalCount).toBe(3);
    expect(walk.shortfall).toBeUndefined();
    expect(walk.complete).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  // A finished walk is judged against the freshest number the gateway gave. Taking
  // the first would report a 6-record shortfall against a count the gateway had
  // already revised away.
  it('reports the last totalCount seen, not the first, when the gateway revises it', async () => {
    const client = new JamfPlatformClient(config);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubTokenThen(
      res({ results: [1, 2], totalCount: 10 }),
      res({ results: [3, 4], totalCount: 4 }),
    );

    const walk = await client.requestAllWithCount<number>({
      service: 'blueprints',
      resource: 'blueprints',
      pageSize: 2,
    });

    expect(walk.reportedTotalCount).toBe(4);
    expect(walk.complete).toBe(true);
    expect(walk.shortfall).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  // The whole point of a second method: the existing call sites keep their array.
  it('gives requestAll callers the identical array, unwrapped', async () => {
    const client = new JamfPlatformClient(config);
    fetchMock.mockImplementation(async (url: unknown) => {
      const s = String(url);
      if (s.endsWith('/auth/token')) return res(tokenBody);
      const page = Number(new URL(s).searchParams.get('page'));
      return res({ results: page === 0 ? ['a', 'b'] : ['c'], totalCount: 3 });
    });

    const walk = await client.requestAllWithCount<string>({
      service: 'blueprints',
      resource: 'blueprints',
      pageSize: 2,
    });
    const array = await client.requestAll<string>({
      service: 'blueprints',
      resource: 'blueprints',
      pageSize: 2,
    });

    expect(Array.isArray(array)).toBe(true);
    expect(array).toEqual(walk.items);
  });
});

describe('pageSize reaches the wire on every paging family', () => {
  /** Serves `total` records from a stub that reads the size parameter it is told to. */
  function serveCollection(total: number, sizeParam: 'page-size' | 'size') {
    const all = Array.from({ length: total }, (_, i) => i);
    fetchMock.mockImplementation(async (url: unknown) => {
      const s = String(url);
      if (s.endsWith('/auth/token')) return res(tokenBody);
      const params = new URL(s).searchParams;
      // Reads ONLY the parameter this family is supposed to send, so a walk that
      // sends the other one slices with NaN and comes back empty.
      const size = Number(params.get(sizeParam));
      const page = Number(params.get('page'));
      return res({ results: all.slice(page * size, page * size + size), totalCount: total });
    });
    return all;
  }

  // Multi-page traversal has never been proven against the real gateway: every live
  // collection so far fit inside one page of 100. `pageSize: 2` against 35 records
  // is the one-command version of that test, so it has to actually work.
  it('walks 35 records in pages of 2 on the page-size family', async () => {
    const client = new JamfPlatformClient(config);
    const all = serveCollection(35, 'page-size');

    const walk = await client.requestAllWithCount<number>({
      service: 'devices',
      resource: 'devices',
      pageSize: 2,
    });

    expect(walk.items).toEqual(all);
    expect(walk.pagesFetched).toBe(18);
    expect(walk.complete).toBe(true);

    // The SECOND request is what proves the walk advanced carrying the caller's
    // page size, rather than only honouring it once.
    expect(paramsOf(1).get('page')).toBe('1');
    expect(paramsOf(1).get('page-size')).toBe('2');
    expect(paramsOf(1).has('size')).toBe(false);

    // And every request after it, not just the second.
    const requested = Array.from({ length: 18 }, (_, n) => paramsOf(n));
    expect(requested.map((p) => p.get('page'))).toEqual(
      Array.from({ length: 18 }, (_, n) => String(n)),
    );
    expect(requested.map((p) => p.get('page-size'))).toEqual(Array(18).fill('2'));
    expect(requested.some((p) => p.has('size'))).toBe(false);
  });

  // Same walk on Declaration Reporting, which ignores page-size and would silently
  // serve its default of 20 if the walk sent the wrong spelling.
  it('walks 35 records in pages of 2 on the size family, never sending page-size', async () => {
    const client = new JamfPlatformClient(config);
    const all = serveCollection(35, 'size');

    const walk = await client.requestAllWithCount<number>({
      service: 'ddm/report',
      resource: 'declarations',
      pageSize: 2,
    });

    expect(walk.items).toEqual(all);
    expect(walk.pagesFetched).toBe(18);

    expect(paramsOf(1).get('page')).toBe('1');
    expect(paramsOf(1).get('size')).toBe('2');
    expect(paramsOf(1).has('page-size')).toBe(false);

    const requested = Array.from({ length: 18 }, (_, n) => paramsOf(n));
    expect(requested.map((p) => p.get('size'))).toEqual(Array(18).fill('2'));
    expect(requested.some((p) => p.has('page-size'))).toBe(false);
  });

  // The third family refuses to page at all, so the only way pageSize can reach the
  // wire for it is through an explicit override — which must carry it just the same.
  it('carries pageSize into a family the caller forced onto a non-paging segment', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(
      res({ results: ['a', 'b'], totalCount: 3 }),
      res({ results: ['c'], totalCount: 3 }),
    );

    await client.requestAll({
      service: 'proclassic',
      rawPath: `/tenant/${config.tenantId}/scripts`,
      pagingFamily: 'page-size',
      pageSize: 2,
    });

    expect(paramsOf(0).get('page-size')).toBe('2');
    expect(paramsOf(1).get('page')).toBe('1');
    expect(paramsOf(1).get('page-size')).toBe('2');
  });

  // The mirror of dropping page-size on the size family. A stray `size` honoured by
  // an uncharacterised segment would override the walk's own page size and cap the
  // answer — the same silent truncation from the other direction.
  it('drops a caller-supplied size on the page-size family instead of sending both', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res({ results: [1], hasNext: false }));

    await client.requestAll({
      service: 'devices',
      resource: 'devices',
      pageSize: 4,
      query: { size: 999 },
    });

    expect(paramsOf(0).has('size')).toBe(false);
    expect(paramsOf(0).get('page-size')).toBe('4');
  });
});

describe('requestAll refuses to report an unreadable page as empty', () => {
  // Classic's named-key shape reached through some other service segment. An
  // empty batch is indistinguishable from "last page", so this must throw.
  it('throws on a body with no results[] or items[], naming the keys it did find', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res({ scripts: [{ id: 1 }], size: 1 }));

    const error = await client
      .requestAll({ service: 'pro', resource: 'scripts' })
      .catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/could not read a page/);
    expect(error.message).toContain('scripts, size');
  });

  it('throws rather than resolving empty when the response body is empty', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res(''));

    await expect(client.requestAll({ service: 'devices', resource: 'devices' })).rejects.toThrow(
      /empty body/,
    );
  });

  it('accepts a bare array page, which carries no envelope to misread', async () => {
    const client = new JamfPlatformClient(config);
    stubTokenThen(res([1, 2]), res([]));

    await expect(client.requestAll({ service: 'devices', resource: 'devices' })).resolves.toEqual([
      1, 2,
    ]);
  });
});
