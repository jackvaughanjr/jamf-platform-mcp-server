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
  /**
   * Gateway service segment, e.g. "blueprints".
   *
   * Do NOT derive this from the permission scope. Blueprints requires the scope
   * `read:pro:blueprints` but lives at /api/blueprints/... — the "pro" is a
   * scope prefix, not a URL segment. Getting this wrong yields a 404 that reads
   * like a permissions failure and costs an hour. Confirm each service segment
   * against the reference (or scripts/fetch-blueprints.sh) before adding a tool.
   */
  service: string;
  /** Resource path below the tenant segment, e.g. "blueprints". */
  resource?: string;
  /**
   * Everything after `/api/{service}`, used verbatim. The escape hatch for
   * shapes the templates cannot express — notably Jamf Pro Classic, which is
   * `/JSSResource/{resource}` with no version segment at all.
   * Takes precedence over `resource` / `version` / `style`.
   */
  rawPath?: string;
  /**
   * Path layout. `tenant` (default) is `/{version}/tenant/{tenantId}/{resource}`
   * and is the ONLY layout ever observed to return 200.
   *
   * `flat` omits the tenant segment because some documented paths show none
   * (Declaration Reporting is published as `/v1/devices/{deviceId}/declarations`).
   * It has never worked. Every flat request — including one to a route that
   * cannot exist — returns 400 REQUEST_CONTEXT_NOT_PROVIDED, so the gateway
   * resolves tenant context before routing and rejects any path lacking it.
   * Ten candidate tenant-header spellings were all ignored. Retained only
   * because the error text says context may come "in token or headers", which
   * hints the token could be bound to a tenant at issue time — untested.
   * Prefer `tenant`.
   */
  style?: 'tenant' | 'flat';
  /**
   * API version segment, defaults to "v1".
   *
   * Versions are PER-RESOURCE on Jamf Pro, not global: `account-groups` is v1,
   * `enrollment` v3, `computers-inventory` v4. Never assume v1 carries over
   * from one resource to the next.
   */
  version?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /**
   * Query string parameters. Gateway list endpoints page with `page` and
   * `page-size`, and `page` is 0-based — the first page is `page=0`, not 1.
   * List responses carry `totalCount` and `results[]`.
   */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/**
 * A gateway list response. Both known envelope variants are optional because the
 * gateway is not consistent between segments: `devices` and `device-groups`
 * return the full set, while `blueprints`, `blueprint-components` and `pro`
 * return only `results` + `totalCount`.
 */
export interface PagedResponse<T> {
  results?: T[];
  items?: T[];
  totalCount?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  hasNext?: boolean;
  hasPrevious?: boolean;
}

export interface RequestAllOptions extends RequestOptions {
  /** Items per request. Defaults to 100. */
  pageSize?: number;
  /** Hard stop, so a contract change cannot become an infinite loop. Defaults to 100. */
  maxPages?: number;
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

  /**
   * Builds a gateway URL. Three shapes are reachable:
   *
   *   style 'tenant' (default)  /api/{service}/{version}/tenant/{tenantId}/{resource}
   *   style 'flat'              /api/{service}/{version}/{resource}
   *   rawPath                   /api/{service}{rawPath}          (verbatim)
   *
   * rawPath exists because Jamf Pro Classic is `/JSSResource/{resource}` with no
   * version segment, which neither template can produce.
   */
  buildUrl(options: RequestOptions): string {
    let suffix: string;

    if (options.rawPath !== undefined) {
      suffix = options.rawPath.startsWith('/') ? options.rawPath : `/${options.rawPath}`;
    } else {
      if (options.resource === undefined) {
        throw new Error('buildUrl requires either `resource` or `rawPath`');
      }
      const version = options.version ?? 'v1';
      const resource = options.resource.replace(/^\/+/, '');
      suffix =
        options.style === 'flat'
          ? `/${version}/${resource}`
          : `/${version}/tenant/${this.config.tenantId}/${resource}`;
    }

    const url = new URL(`${this.config.gatewayBaseUrl}/api/${options.service}${suffix}`);
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
    const label = options.rawPath ?? options.resource ?? '(unknown)';
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
        `${method} ${options.service}/${label} failed (${response.status} ${response.statusText})`,
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

  /**
   * Follows pagination and returns every item.
   *
   * Termination cannot rely on `hasNext`: only `devices` and `device-groups`
   * return it, while `blueprints`, `blueprint-components` and `pro` return just
   * `totalCount`. A helper keyed on `hasNext` would silently return one page
   * forever for the latter — so `hasNext` is used when present, `totalCount`
   * otherwise, and an empty page is the backstop for a response carrying
   * neither.
   *
   * `page` is 0-based; the gateway's parameters are `page` and `page-size`.
   */
  async requestAll<T = unknown>(options: RequestAllOptions): Promise<T[]> {
    const pageSize = options.pageSize ?? 100;
    const maxPages = options.maxPages ?? 100;
    const collected: T[] = [];

    for (let page = 0; page < maxPages; page += 1) {
      const body = await this.request<PagedResponse<T>>({
        ...options,
        method: options.method ?? 'GET',
        query: { ...options.query, page, 'page-size': pageSize },
      });

      const batch = body?.results ?? body?.items ?? [];
      collected.push(...batch);

      // Explicit signal wins when the segment provides it.
      if (typeof body?.hasNext === 'boolean') {
        if (!body.hasNext) return collected;
      } else if (typeof body?.totalCount === 'number') {
        if (collected.length >= body.totalCount) return collected;
      }

      // No progress and no usable signal — stop rather than loop forever.
      if (batch.length === 0) return collected;
    }

    throw new Error(
      `requestAll exceeded maxPages (${maxPages}) for ${options.service}/${options.rawPath ?? options.resource}. ` +
        'Raise maxPages deliberately, or check whether the pagination contract changed.',
    );
  }
}
