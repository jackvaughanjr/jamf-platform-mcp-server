import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const base = {
  JAMF_CLIENT_ID: 'id',
  JAMF_CLIENT_SECRET: 'secret',
  JAMF_TENANT_ID: 'tenant',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('defaults to the US gateway and derives the token URL from it', () => {
    const config = loadConfig({ ...base });
    expect(config.gatewayBaseUrl).toBe('https://us.apigw.jamf.com');
    expect(config.tokenUrl).toBe('https://us.apigw.jamf.com/auth/token');
  });

  it('strips trailing slashes so the derived token URL has no double slash', () => {
    const config = loadConfig({ ...base, JAMF_GATEWAY_BASE_URL: 'https://eu.apigw.jamf.com///' });
    expect(config.gatewayBaseUrl).toBe('https://eu.apigw.jamf.com');
    expect(config.tokenUrl).toBe('https://eu.apigw.jamf.com/auth/token');
  });

  it('honours an explicit token URL override', () => {
    const config = loadConfig({ ...base, JAMF_TOKEN_URL: 'https://example.test/oauth' });
    expect(config.tokenUrl).toBe('https://example.test/oauth');
  });

  // Read-only is the safe default: an operator who forgets the variable entirely
  // gets the restrictive behaviour, not the permissive one.
  it('defaults readOnly to true and only "false" disables it', () => {
    expect(loadConfig({ ...base }).readOnly).toBe(true);
    expect(loadConfig({ ...base, JAMF_READ_ONLY: 'true' }).readOnly).toBe(true);
    expect(loadConfig({ ...base, JAMF_READ_ONLY: 'yes' }).readOnly).toBe(true);
    expect(loadConfig({ ...base, JAMF_READ_ONLY: '' }).readOnly).toBe(true);
    expect(loadConfig({ ...base, JAMF_READ_ONLY: 'false' }).readOnly).toBe(false);
  });

  // A half-configured integration is the likeliest first-run failure, so all
  // problems should surface at once rather than one per run.
  it('reports every missing variable in a single error', () => {
    let message = '';
    try {
      loadConfig({});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('JAMF_CLIENT_ID');
    expect(message).toContain('JAMF_CLIENT_SECRET');
    expect(message).toContain('JAMF_TENANT_ID');
    expect(message).toContain('.env.example');
  });

  it('rejects a non-URL gateway base', () => {
    expect(() => loadConfig({ ...base, JAMF_GATEWAY_BASE_URL: 'not-a-url' })).toThrow();
  });
});
