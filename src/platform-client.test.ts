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
