import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// quiet: true is load-bearing, not cosmetic. dotenv v17 prints a banner to
// STDOUT, which is the MCP transport — the stray bytes corrupt the JSON-RPC
// stream and the client fails to handshake.
loadDotenv({ quiet: true });

const ConfigSchema = z.object({
  clientId: z.string().min(1, 'JAMF_CLIENT_ID is required'),
  clientSecret: z.string().min(1, 'JAMF_CLIENT_SECRET is required'),
  tenantId: z.string().min(1, 'JAMF_TENANT_ID is required'),
  gatewayBaseUrl: z.string().url(),
  tokenUrl: z.string().url(),
  readOnly: z.boolean(),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Reads configuration from the environment.
 *
 * Throws with every problem listed at once rather than one per run — a
 * half-configured integration is the most likely first-run failure, so it is
 * worth surfacing all of it in a single message.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const gatewayBaseUrl = (env.JAMF_GATEWAY_BASE_URL ?? 'https://us.apigw.jamf.com').replace(/\/+$/, '');

  const parsed = ConfigSchema.safeParse({
    clientId: env.JAMF_CLIENT_ID ?? '',
    clientSecret: env.JAMF_CLIENT_SECRET ?? '',
    tenantId: env.JAMF_TENANT_ID ?? '',
    gatewayBaseUrl,
    tokenUrl: env.JAMF_TOKEN_URL ?? `${gatewayBaseUrl}/auth/token`,
    readOnly: env.JAMF_READ_ONLY !== 'false',
  });

  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${problems.join('\n')}\n\nSee .env.example.`);
  }

  return parsed.data;
}
