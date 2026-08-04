import type { Config } from './config.js';

/**
 * Client for the Jamf Platform API Gateway (Beta).
 *
 * Every gateway concern lives behind this one class on purpose: the gateway is
 * in public beta with no published breaking-change protocol, so when the
 * contract shifts there should be exactly one file to fix.
 */

/** Refresh this many seconds before nominal expiry, to cover clock skew and flight time. */
const REFRESH_SKEW_SECONDS = 60;

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface CachedToken {
  accessToken: string;
  /** Epoch millis after which the token should be treated as expired. */
  expiresAtMs: number;
}

export interface RequestOptions {
  /** Gateway service segment, e.g. "pro". */
  service: string;
  /** Resource path below the tenant segment, e.g. "blueprints". */
  resource: string;
  /** API version segment. Defaults to "v1". */
  version?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export class JamfPlatformApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly responseBody: string,
  ) {
    super(message);
    this.name = 'JamfPlatformApiError';
  }
}

export class JamfPlatformClient {
  private cachedToken: CachedToken | null = null;

  /**
   * De-duplicates concurrent refreshes. MCP servers routinely fan out several
   * tool calls at once; without this, a cold start fires N token requests.
   */
  private inFlightRefresh: Promise<string> | null = null;

  constructor(private readonly config: Config) {}

  /** Returns a valid bearer token, refreshing if absent or near expiry. */
  async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAtMs) {
      return this.cachedToken.accessToken;
    }
    this.inFlightRefresh ??= this.refreshAccessToken().finally(() => {
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  private async refreshAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const text = await response.text();
    if (!response.ok) {
      // Deliberately does not echo the request body — it contains the secret.
      throw new JamfPlatformApiError(
        `Token request failed (${response.status} ${response.statusText})`,
        response.status,
        this.config.tokenUrl,
        text,
      );
    }

    const token = JSON.parse(text) as TokenResponse;
    if (!token.access_token) {
      throw new JamfPlatformApiError('Token response contained no access_token', 200, this.config.tokenUrl, text);
    }

    // Beta documents 900s; trust the response rather than hardcoding it.
    const lifetime = Number.isFinite(token.expires_in) ? token.expires_in : 900;
    this.cachedToken = {
      accessToken: token.access_token,
      expiresAtMs: Date.now() + Math.max(lifetime - REFRESH_SKEW_SECONDS, 30) * 1000,
    };
    return token.access_token;
  }

  /** Builds a gateway URL: /api/{service}/{version}/tenant/{tenantId}/{resource} */
  buildUrl(options: RequestOptions): string {
    const version = options.version ?? 'v1';
    const resource = options.resource.replace(/^\/+/, '');
    const url = new URL(
      `${this.config.gatewayBaseUrl}/api/${options.service}/${version}/tenant/${this.config.tenantId}/${resource}`,
    );
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const method = options.method ?? 'GET';

    if (this.config.readOnly && method !== 'GET') {
      throw new Error(
        `Refusing ${method} because JAMF_READ_ONLY is enabled. ` +
          'Unset it to allow writes, and prefer an integration whose scopes permit only what you intend.',
      );
    }

    const url = this.buildUrl(options);
    const token = await this.getAccessToken();

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new JamfPlatformApiError(
        `${method} ${options.service}/${options.resource} failed (${response.status} ${response.statusText})`,
        response.status,
        url,
        text,
      );
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}
