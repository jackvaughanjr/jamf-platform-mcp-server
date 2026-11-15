import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from './config.js';
import type { RequestOptions } from './platform-client.js';
import { assertWriteServerRequestAllowed, WriteRouteGuardClient } from './write-route-guard.js';

const config: Config = {
  clientId: 'id',
  clientSecret: 'secret',
  tenantId: 'TENANT',
  gatewayBaseUrl: 'https://us.api.jamfcloud.com',
  tokenUrl: 'https://us.api.jamfcloud.com/auth/token',
  readOnly: false,
};

const LISTED_BODY =
  '<?xml version="1.0" encoding="UTF-8"?><logflush><log>policy</log><log_id>7</log_id><interval>Zero Days</interval>' +
  '<computers><computer><id>11</id></computer><computer><id>12</id></computer></computers></logflush>';

const listed: RequestOptions = {
  service: 'proclassic',
  style: 'classic',
  resource: 'logflush',
  method: 'DELETE',
  bodyFormat: 'xml',
  body: LISTED_BODY,
};
const onePolicy: RequestOptions = {
  service: 'proclassic',
  style: 'classic',
  resource: 'logflush/policy/id/7/interval/Zero+Days',
  method: 'DELETE',
};

const refused = (options: RequestOptions) => expect(() => assertWriteServerRequestAllowed(options)).toThrow(/Refusing/);

describe('assertWriteServerRequestAllowed', () => {
  it('lets GET, POST and PUT through unchanged', () => {
    for (const method of ['GET', 'POST', 'PUT'] as const) {
      expect(() =>
        assertWriteServerRequestAllowed({ service: 'proclassic', style: 'classic', resource: 'policies/id/1', method }),
      ).not.toThrow();
    }
    expect(() => assertWriteServerRequestAllowed({ service: 'pro', resource: 'scripts' })).not.toThrow();
  });

  it('allows exactly the two policy-log flush shapes', () => {
    expect(() => assertWriteServerRequestAllowed(listed)).not.toThrow();
    expect(() => assertWriteServerRequestAllowed(onePolicy)).not.toThrow();
    expect(() =>
      assertWriteServerRequestAllowed({ ...onePolicy, resource: 'logflush/policy/id/123/interval/Six+Years' }),
    ).not.toThrow();
  });

  it('refuses a DELETE of any object', () => {
    for (const resource of [
      'policies/id/7',
      'scripts/id/7',
      'computergroups/id/7',
      'osxconfigurationprofiles/id/7',
      'packages/id/7',
      'restrictedsoftware/id/7',
      'policies/name/Example',
    ]) {
      refused({ service: 'proclassic', style: 'classic', resource, method: 'DELETE' });
    }
    refused({ service: 'pro', version: 'v1', resource: 'scripts/7', method: 'DELETE' });
    refused({ service: 'pro', version: 'v1', resource: 'log-flushing/task/1', method: 'DELETE' });
  });

  it('refuses the all-policies flush and other logflush shapes', () => {
    refused({ ...onePolicy, resource: 'logflush/policy/interval/Zero+Days' });
    refused({ ...onePolicy, resource: 'logflush/policies/id/7/interval/Zero+Days' });
    refused({ ...onePolicy, resource: 'logflush/policy/id/0/interval/Zero+Days' });
    refused({ ...onePolicy, resource: 'logflush/policy/id/7/interval/Zero Days' });
    refused({ ...onePolicy, resource: 'logflush/policy/id/7/interval/Ten+Days' });
    refused({ ...onePolicy, resource: 'logflush/policy/id/7/interval/Zero+Days/../../policies/id/7' });
    refused({ ...onePolicy, body: 'x', bodyFormat: 'xml' });
  });

  it('refuses a listed flush whose body is not exactly the builder shape', () => {
    refused({ ...listed, body: LISTED_BODY.replace('<log>policy</log>', '<log>computer</log>') });
    refused({ ...listed, body: LISTED_BODY.replace(/<computers>.*<\/computers>/, '<computers></computers>') });
    refused({ ...listed, body: LISTED_BODY.replace(/<computers>.*<\/computers>/, '') });
    refused({ ...listed, body: LISTED_BODY.replace('Zero Days', 'All') });
    refused({ ...listed, body: `${LISTED_BODY}<policy/>` });
    refused({ ...listed, bodyFormat: 'json' });
    refused({ ...listed, body: undefined });
  });

  it('refuses the flush routes through rawPath, another service, a query, or without the classic style', () => {
    refused({ service: 'proclassic', rawPath: '/logflush/policy/id/7/interval/Zero+Days', method: 'DELETE' });
    refused({ ...onePolicy, service: 'pro' });
    refused({ ...onePolicy, style: undefined });
    refused({ ...onePolicy, query: { force: 'true' } });
  });

  it('refuses every method other than GET, POST, PUT and the flush DELETE', () => {
    const other = ['PA', 'TCH'].join('') as RequestOptions['method'];
    refused({ service: 'proclassic', style: 'classic', resource: 'policies/id/7', method: other });
  });
});

describe('WriteRouteGuardClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses a policy DELETE before requesting a token or sending anything', async () => {
    const client = new WriteRouteGuardClient(config);
    await expect(
      client.request({ service: 'proclassic', style: 'classic', resource: 'policies/id/7', method: 'DELETE' }),
    ).rejects.toThrow(/Refusing DELETE proclassic\/policies\/id\/7/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an allowed flush', async () => {
    const ok = (body: string) => ({ ok: true, status: 200, statusText: 'OK', text: async () => body }) as unknown as Response;
    fetchMock.mockResolvedValueOnce(ok(JSON.stringify({ access_token: 'tok', expires_in: 900, token_type: 'Bearer' })));
    fetchMock.mockResolvedValueOnce(ok(''));
    const client = new WriteRouteGuardClient(config);
    await client.request(listed);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://us.api.jamfcloud.com/proclassic/logflush');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBe(LISTED_BODY);
  });
});
