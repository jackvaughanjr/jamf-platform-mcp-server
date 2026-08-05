import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from './config.js';
import { JamfPlatformApiError, JamfPlatformClient } from './platform-client.js';

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

  it('omits the tenant segment for flat style', () => {
    expect(client.buildUrl({ service: 'pro', resource: 'device-declarations', style: 'flat' })).toBe(
      'https://us.apigw.jamf.com/api/pro/v1/device-declarations',
    );
  });

  it('uses rawPath verbatim, with no version or tenant inserted', () => {
    expect(client.buildUrl({ service: 'pro', rawPath: '/JSSResource/computers' })).toBe(
      'https://us.apigw.jamf.com/api/pro/JSSResource/computers',
    );
  });

  it('accepts a rawPath without a leading slash', () => {
    expect(client.buildUrl({ service: 'pro', rawPath: 'JSSResource/computers' })).toBe(
      'https://us.apigw.jamf.com/api/pro/JSSResource/computers',
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
