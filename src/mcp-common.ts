import { readFileSync } from 'node:fs';

import { loadConfig } from './config.js';
import { JamfPlatformApiError } from './platform-client.js';

/**
 * Plumbing shared by both servers — the read server (`index.ts`) and the write
 * server (`write-server.ts`, JPM-0008). Shared here rather than by one server
 * importing the other, because importing `index.ts` would register its tools.
 */

export function requireConfig() {
  try {
    return loadConfig();
  } catch (error) {
    // A misconfigured integration is the likeliest first-run failure; report it
    // as a plain message on stderr rather than a module-load stack trace.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Read the version from package.json rather than duplicating it here.
 *
 * README states package.json is the single source of the version, and a hardcoded
 * literal made that false — the two would drift at the first release, and the
 * version an MCP client sees is the one that matters. Resolved relative to this
 * module, so it works from dist/ regardless of the caller's cwd.
 */
export function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    // Never fail startup over version metadata.
    return '0.0.0';
  }
}

/** Renders a result or an error as MCP tool content. */
export function asContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function asError(error: unknown) {
  if (error instanceof JamfPlatformApiError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `${error.message}\nURL: ${error.url}\nResponse: ${error.responseBody.slice(0, 2000)}`,
        },
      ],
    };
  }
  return {
    isError: true,
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
  };
}
