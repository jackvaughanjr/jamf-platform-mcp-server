import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Tests must never reach the gateway. Any test that needs a response stubs
    // global fetch; an unstubbed call should fail loudly rather than quietly
    // hitting a live tenant with whatever credentials happen to be in the shell.
    env: {
      JAMF_CLIENT_ID: 'test-client-id',
      JAMF_CLIENT_SECRET: 'test-client-secret',
      JAMF_TENANT_ID: 'test-tenant-id',
      JAMF_GATEWAY_BASE_URL: 'https://us.apigw.jamf.com',
      JAMF_READ_ONLY: 'false',
    },
  },
});
