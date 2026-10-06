import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// quiet: true is load-bearing, not cosmetic. dotenv v17 prints a banner to
// STDOUT, which is the MCP transport — the stray bytes corrupt the JSON-RPC
// stream and the client fails to handshake.
loadDotenv({ quiet: true });

const ConfigSchema = z.object({
  clientId: z.string().min(1, 'JAMF_CLIENT_ID is required'),
  clientSecret: z.string().min(1, 'JAMF_CLIENT_SECRET is required'),
  tenantId: z.string().min(1).optional(),
  environmentId: z.string().min(1).optional(),
  gatewayBaseUrl: z.string().url(),
  tokenUrl: z.string().url(),
  readOnly: z.boolean(),
}).refine((c) => c.tenantId || c.environmentId, {
  message: 'set JAMF_ENVIRONMENT_ID (a Platform environment integration) or JAMF_TENANT_ID (a legacy Tenant integration)',
  path: ['environmentId'],
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
  const gatewayBaseUrl = (env.JAMF_GATEWAY_BASE_URL ?? 'https://us.api.jamfcloud.com').replace(/\/+$/, '');

  const parsed = ConfigSchema.safeParse({
    clientId: env.JAMF_CLIENT_ID ?? '',
    clientSecret: env.JAMF_CLIENT_SECRET ?? '',
    // One of the two. A Platform environment integration (the current kind) uses the
    // environment id for everything; a legacy Tenant integration uses the tenant id
    // and cannot reach environment-only services such as Blueprints.
    tenantId: env.JAMF_TENANT_ID || undefined,
    environmentId: env.JAMF_ENVIRONMENT_ID || undefined,
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
