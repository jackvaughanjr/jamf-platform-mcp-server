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
   * `read:pro:blueprints` but lives at /blueprints/... — the "pro" is a
   * scope prefix, not a URL segment. Getting this wrong yields a 404 that reads
   * like a permissions failure and costs an hour. Confirm each service segment
   * against the reference (or scripts/fetch-blueprints.sh) before adding a tool.
   */
  service: string;
  /** Resource path below the version segment, e.g. "blueprints". */
  resource?: string;
  /**
   * Everything after `/{service}`, used verbatim. The escape hatch for shapes the
   * templates cannot express. Nothing is inserted. Takes precedence over
   * `resource` / `version` / `style`.
   */
  rawPath?: string;
  /**
   * Path layout. `tenant` (default) is `/{service}/{version}/{resource}`.
   *
   * `classic` is `/{service}/{resource}` with NO version segment, which is Jamf
   * Pro Classic's shape.
   *
   * `flat` builds the same path as `tenant`. Before the 2026 gateway move the
   * tenant id was a path segment and `flat` was the variant without it; the tenant
   * now travels in a header for every style, so the distinction is gone. Kept so
   * existing callers keep working.
   */
  style?: 'tenant' | 'flat' | 'classic';
  /**
   * Which scope header addresses the request. Jamf's operation pages say to send
   * exactly one: `X-Tenant-Id` or `X-Environment-Id`.
   *
   * Inferred from `service` when omitted (see `inferScopeHeader`). Blueprints is
   * published at environment scope only: with the tenant id it answers 403
   * BAD_PERMISSIONS, and with the tenant id sent as an environment id it answers
   * 404 ENVIRONMENT_NOT_FOUND. Neither message says "wrong header".
   */
  scope?: 'tenant' | 'environment';
  /**
   * API version segment, defaults to "v1".
   *
   * Versions are PER-OPERATION on Jamf Pro, not global and not even per-resource:
   * `account-groups` is v1, `enrollment` v3, `computers-inventory` v4, and
   * `computer-prestages` is v3 for CRUD while its own scope sub-resource is v2.
   * Never assume a version carries over, even within one resource.
   */
  version?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /**
   * Query string parameters. Most gateway list endpoints page with `page` and
   * `page-size`, and `page` is 0-based — the first page is `page=0`, not 1.
   * List responses carry `totalCount` and `results[]`.
   *
   * Not universal: Declaration Reporting (`ddm/report`) spells the size
   * parameter `size`, and Jamf Pro Classic (`proclassic`) does not page at all.
   * See `PagingFamily`.
   */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * How `body` is encoded. Defaults to `json`, which serialises it.
   *
   * `xml` sends a string body verbatim as `application/xml`, for Jamf Pro Classic
   * writes. Classic's create and update operation pages publish no request body
   * at all, and Classic has always taken XML on the way in, while answering in
   * JSON when asked to on the way out.
   */
  bodyFormat?: 'json' | 'xml';
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

/**
 * How a gateway segment expects to be paged.
 *
 * The gateway is not uniform here, and — this is the whole reason the concept
 * exists — both deviations are *silent*. Neither returns an error when paged the
 * common way, so a helper that assumes one family hands back a plausible-looking
 * wrong answer instead of failing.
 *
 * - `'page-size'` — `page` + `page-size`. The common case: `devices`,
 *   `device-groups`, `blueprints`, `blueprint-components`, `pro`.
 * - `'size'` — `page` + `size`. Declaration Reporting ignores `page-size` and
 *   applies its default page size of 20, so a caller asking for 500 receives 20
 *   and believes that was everything.
 * - `'none'` — no paging envelope of any kind. Classic returns a named-key
 *   object, so "page all of it" is not a meaningful operation; asking for it is
 *   a mistake to report rather than a shape to cope with.
 */
export type PagingFamily = 'page-size' | 'size' | 'none';

/**
 * Segments that are NOT `page` + `page-size`.
 *
 * Deliberately an exception list: the table stays short, and a segment nobody
 * has characterised yet gets the behaviour that is right for almost everything.
 *
 * Keys are whole service segments, not first segments — Declaration Reporting
 * really is the two-segment `ddm/report`. Matching on the first segment would
 * both miss it and wrongly claim bare `ddm` is characterised, which it is not
 * (`ddm` enumerates as not hosted).
 */
const PAGING_FAMILY_BY_SERVICE: Readonly<Record<string, PagingFamily>> = {
  proclassic: 'none',
  'ddm/report': 'size',
};

/**
 * Infers the paging family from the service segment.
 *
 * Inference is the default on purpose. An opt-in parameter is only correct when
 * the caller remembers it, and here forgetting is invisible: Classic returns a
 * body with no `results[]` (so a pager sees "no items" and stops), and
 * `ddm/report` returns a valid first page of 20. Both look like success. A
 * default that can be wrong loudly beats a parameter that is right only when
 * someone sets it.
 *
 * The key is normalised — trimmed, unslashed, lower-cased — because a near-miss
 * spelling like `'/proclassic'` would otherwise fall through to the generic
 * family and reintroduce the silent empty result this exists to prevent.
 */
export function inferPagingFamily(service: string): PagingFamily {
  const key = service.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  return PAGING_FAMILY_BY_SERVICE[key] ?? 'page-size';
}

/**
 * Segments published at environment scope only, so they need `X-Environment-Id`.
 * Everything else takes `X-Tenant-Id`. An exception list for the same reason as
 * `PAGING_FAMILY_BY_SERVICE`.
 *
 * Keyed by service segment, so `blueprint-components` (a resource under the
 * `blueprints` segment) is covered too. Confirmed 2026-10-06: with `X-Tenant-Id`
 * the blueprints list answers 403 BAD_PERMISSIONS.
 */
const ENVIRONMENT_SCOPED_SERVICES: ReadonlySet<string> = new Set(['blueprints']);

export function inferScopeHeader(service: string): 'tenant' | 'environment' {
  const key = service.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  return ENVIRONMENT_SCOPED_SERVICES.has(key) ? 'environment' : 'tenant';
}

export interface RequestAllOptions extends RequestOptions {
  /**
   * Items per request. Defaults to 100.
   *
   * Whatever the family, this is the value that reaches the wire — `page-size` on
   * the common family, `size` on Declaration Reporting. Lowering it is the only
   * way to exercise multi-page traversal against a live tenant: every collection
   * observed so far fits inside one page of 100, so `pageSize: 2` against a
   * 35-record collection is what turns "the pager presumably works" into a
   * one-command test. It is a real parameter, not a tuning knob.
   */
  pageSize?: number;
  /** Hard stop, so a contract change cannot become an infinite loop. Defaults to 100. */
  maxPages?: number;
  /**
   * Overrides the family inferred from `service`.
   *
   * The escape hatch for a segment the table has not caught up with — a new
   * `size`-family group, or a Classic route that grows a real paging envelope —
   * so nobody has to edit this file to page it. An explicit value always wins,
   * including one that opts a `'none'` segment back into paging: that is a
   * deliberate assertion by a caller who has checked, not the accident this
   * guard is aimed at.
   */
  pagingFamily?: PagingFamily;
}

/**
 * Why a page walk stopped.
 *
 * Recorded because the three reasons carry very different amounts of evidence.
 * `hasNext` is the gateway saying "that was the last page". `totalCount` is the
 * walk having collected everything the gateway claimed existed. `emptyPage` is
 * neither — it is an inference from a page that came back with nothing, which is
 * the backstop for a response carrying no completeness signal at all.
 */
export type PageWalkStop = 'hasNext' | 'totalCount' | 'emptyPage';

/**
 * What a full page walk collected, alongside what the gateway said there was.
 *
 * `requestAll` returns only the items, which means a caller holding 35 records
 * cannot tell whether the gateway said there were 35 or said there were 500 and
 * the walk stopped early. The runaway case is already loud — exceeding `maxPages`
 * throws — but a walk that ends early for any other reason is silent, and a short
 * answer that looks complete is the same class of bug as an empty result from a
 * helper that could not read its input.
 */
export interface PagedWalk<T> {
  /** Everything collected, in page order. Identical to what `requestAll` returns. */
  items: T[];
  /** `items.length`, so a caller comparing it against the reported count need not index. */
  collectedCount: number;
  /**
   * `totalCount` as most recently reported by the gateway, or undefined if no page
   * carried one (`devices` pages with `hasNext`; a bare-array page has no envelope
   * at all). Last-seen rather than first-seen: a walk is judged against the
   * freshest number the gateway gave, not a stale one from page 0.
   */
  reportedTotalCount?: number;
  /** Gateway requests issued. Token requests are not counted. */
  pagesFetched: number;
  /** Which of the three termination signals ended the walk. */
  stoppedBecause: PageWalkStop;
  /**
   * Whether the collection was exhausted.
   *
   * Deliberately tri-state, and deliberately not optional — a caller must handle
   * `undefined`, which means the gateway offered nothing to check the walk
   * against, so completeness is UNKNOWN. Collapsing unknown into `true` would be
   * the false all-clear this whole type exists to prevent.
   */
  complete: boolean | undefined;
  /**
   * How many records the gateway reported that the walk did not collect. Present
   * only when positive — this is the dangerous direction, an answer that may be
   * missing records.
   *
   * The other direction is not an error and gets no field: collecting MORE than
   * the reported count means the count was stale or the collection grew mid-walk,
   * and no caller is at risk of acting on records that are not there. Compare
   * `collectedCount` against `reportedTotalCount` if that matters.
   */
  shortfall?: number;
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
   * Builds a gateway URL:
   *
   *   style 'tenant' / 'flat'   {base}/{service}/{version}/{resource}
   *   style 'classic'           {base}/{service}/{resource}            (no version)
   *   rawPath                   {base}/{service}{rawPath}              (verbatim)
   *
   * No tenant in the path: since the 2026 gateway move it travels in a scope
   * header (`scopeHeaders`). The old shape, `/api/{service}/{version}/tenant/{id}/…`
   * on `us.apigw.jamf.com`, now answers 400 REQUEST_CONTEXT_NOT_PROVIDED.
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
      suffix = options.style === 'classic' ? `/${resource}` : `/${version}/${resource}`;
    }

    const url = new URL(`${this.config.gatewayBaseUrl}/${options.service}${suffix}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * The one scope header a request carries.
   *
   * With an environment id configured, every request sends `X-Environment-Id`:
   * confirmed 2026-10-06, a Platform environment integration reaches every route
   * the tools use that way, Blueprints included. Without one (a legacy Tenant
   * integration) requests send `X-Tenant-Id`, and environment-only services throw
   * here with a pointed message instead of a 403 that blames permissions.
   */
  scopeHeaders(options: Pick<RequestOptions, 'service' | 'scope'>): Record<string, string> {
    const scope = options.scope ?? (this.config.environmentId ? 'environment' : inferScopeHeader(options.service));
    if (scope === 'environment') {
      if (!this.config.environmentId) {
        throw new Error(
          `${options.service} is published at environment scope and needs JAMF_ENVIRONMENT_ID, which is not set. ` +
            'That takes a Platform environment integration (Jamf Account > Integrations); a Tenant-level ' +
            'integration cannot reach it. The environment id is under Platform Environments and is not the ' +
            'tenant id: sending the tenant id here answers 404 ENVIRONMENT_NOT_FOUND.',
        );
      }
      return { 'X-Environment-Id': this.config.environmentId };
    }
    if (!this.config.tenantId) {
      throw new Error('This request asked for tenant scope, but JAMF_TENANT_ID is not set.');
    }
    return { 'X-Tenant-Id': this.config.tenantId };
  }

  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const method = options.method ?? 'GET';

    if (this.config.readOnly && method !== 'GET') {
      throw new Error(
        `Refusing ${method} because JAMF_READ_ONLY is enabled. ` +
          'Unset it to allow writes, and prefer an integration whose scopes permit only what you intend.',
      );
    }

    // Before the token request: a malformed request should not cost a round trip.
    if (options.bodyFormat === 'xml' && typeof options.body !== 'string') {
      throw new Error('bodyFormat "xml" requires a string body; it is sent verbatim, never serialised.');
    }

    const url = this.buildUrl(options);
    const scopeHeaders = this.scopeHeaders(options);
    const label = options.rawPath ?? options.resource ?? '(unknown)';
    const token = await this.getAccessToken();

    const xml = options.bodyFormat === 'xml';
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...scopeHeaders,
        ...(options.body === undefined ? {} : { 'Content-Type': xml ? 'application/xml' : 'application/json' }),
      },
      body: options.body === undefined ? undefined : xml ? (options.body as string) : JSON.stringify(options.body),
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
   * Paging is per-family, not universal — see `PagingFamily`. The family is
   * inferred from `service` unless `pagingFamily` overrides it, and a segment
   * that does not page at all is rejected up front rather than paged into an
   * empty result.
   *
   * Termination cannot rely on `hasNext`: only `devices` and `device-groups`
   * return it, while `blueprints`, `blueprint-components` and `pro` return just
   * `totalCount`. A helper keyed on `hasNext` would silently return one page
   * forever for the latter — so `hasNext` is used when present, `totalCount`
   * otherwise, and an empty page is the backstop for a response carrying
   * neither.
   *
   * `page` is 0-based in every family.
   *
   * This returns the items alone, which is what nearly every caller wants. When
   * the answer's *completeness* matters — an audit, or anything that reports a
   * count back to a user — use `requestAllWithCount`, which also hands back what
   * the gateway said there was. A short walk still logs to stderr either way, so
   * this method is quiet but never silent.
   */
  async requestAll<T = unknown>(options: RequestAllOptions): Promise<T[]> {
    return (await this.requestAllWithCount<T>(options)).items;
  }

  /**
   * Follows pagination and returns every item **plus what the gateway reported**.
   *
   * Same walk as `requestAll` — this is the implementation, and `requestAll`
   * returns `.items` from it — so the two can never disagree about the records
   * themselves. A separate method rather than a changed return type because ten
   * call sites use the array directly; and a separate method rather than an
   * out-parameter because the evidence a caller needs to judge completeness
   * should be in the value it awaits, not in an object it remembered to pass.
   */
  async requestAllWithCount<T = unknown>(options: RequestAllOptions): Promise<PagedWalk<T>> {
    const family = options.pagingFamily ?? inferPagingFamily(options.service);

    // Before the token request, let alone the page request: there is nothing to
    // ask for. Returning [] here is the false all-clear this guard replaces.
    if (family === 'none') {
      throw new Error(
        `requestAll cannot page "${options.service}": it has no paging envelope. ` +
          'Jamf Pro Classic wraps a collection in a named key ({"scripts": [...]}) with ' +
          'snake_case fields, no results[], no items[], no totalCount and no page ' +
          'parameters, so paging all of Classic is not a meaningful operation and this ' +
          'call would otherwise return an empty array with no error. Issue a single ' +
          'request() and unwrap it with extractClassicList (src/automations.ts), which ' +
          'throws on a shape it cannot read instead of reporting nothing found. Pass ' +
          'pagingFamily explicitly if this segment has genuinely gained pagination.',
      );
    }

    const pageSize = options.pageSize ?? 100;
    const maxPages = options.maxPages ?? 100;
    const collected: T[] = [];

    // Last-seen rather than the current page's, so a walk that ends on a page
    // omitting `totalCount` is still judged against the number the gateway did
    // give. Termination below deliberately still reads the CURRENT page, leaving
    // that behaviour exactly as it was.
    let reportedTotalCount: number | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const query: NonNullable<RequestOptions['query']> = { ...options.query, page };
      if (family === 'size') {
        // `page-size` is inert on this family. Dropping a caller-supplied one is
        // deliberate: sending a parameter known to be ignored is what made the
        // truncation invisible in the first place.
        delete query['page-size'];
        query.size = pageSize;
      } else {
        // The mirror image, for the same reason. If a stray `size` were honoured
        // by a segment nobody has characterised, it would quietly override the
        // `page-size` this walk depends on and cap the answer — the same silent
        // truncation, arriving from the other direction.
        delete query.size;
        query['page-size'] = pageSize;
      }

      const body = await this.request<PagedResponse<T>>({
        ...options,
        method: options.method ?? 'GET',
        query,
      });

      const batch = this.extractBatch<T>(body, options);
      collected.push(...batch);
      if (typeof body?.totalCount === 'number') reportedTotalCount = body.totalCount;

      const finish = (stoppedBecause: PageWalkStop): PagedWalk<T> =>
        this.finishWalk(collected, reportedTotalCount, page + 1, stoppedBecause, pageSize, options);

      // Explicit signal wins when the segment provides it.
      if (typeof body?.hasNext === 'boolean') {
        if (!body.hasNext) return finish('hasNext');
      } else if (typeof body?.totalCount === 'number') {
        if (collected.length >= body.totalCount) return finish('totalCount');
      }

      // No progress and no usable signal — stop rather than loop forever.
      if (batch.length === 0) return finish('emptyPage');
    }

    throw new Error(
      `requestAll exceeded maxPages (${maxPages}) for ${options.service}/${options.rawPath ?? options.resource} ` +
        `at pageSize ${pageSize}, so it stopped at ${maxPages * pageSize} records. ` +
        'Raise maxPages deliberately, or check whether the pagination contract changed. ' +
        'If you lowered pageSize to force multi-page behaviour, that is what shrank the ' +
        'ceiling — maxPages bounds PAGES, not records.',
    );
  }

  /**
   * Assembles the walk result, and refuses to let a short walk pass unremarked.
   *
   * A shortfall does NOT throw. Three reasons, in order of weight:
   *
   * 1. Throwing would turn today's partial answer into no answer for ten existing
   *    call sites, several of which are `allSettled` legs — `getFleetOverview`
   *    would lose a whole section because the gateway's count was off by one.
   *    Fewer records than promised is still an answer; zero records is not.
   * 2. A disagreement is not necessarily a fault. The collection can change
   *    between page 0 and page N — a device enrols or is removed mid-walk — so a
   *    count observed early can legitimately not match a length measured late.
   *    Making an ordinary race fatal would be wrong.
   * 3. The caller is the only one who can weigh it. A search tool showing 34 of
   *    35 devices is fine; an audit asserting nothing is out of compliance is
   *    not. So the evidence is returned, not adjudicated here.
   *
   * What it must not do is stay quiet, which is why the stderr line is
   * unconditional rather than something `requestAll` opts into: the array-only
   * callers are precisely the ones with no other way to find out.
   */
  private finishWalk<T>(
    collected: T[],
    reportedTotalCount: number | undefined,
    pagesFetched: number,
    stoppedBecause: PageWalkStop,
    pageSize: number,
    options: RequestAllOptions,
  ): PagedWalk<T> {
    const collectedCount = collected.length;
    const shortfall =
      reportedTotalCount !== undefined && collectedCount < reportedTotalCount
        ? reportedTotalCount - collectedCount
        : undefined;

    // `undefined` where the gateway said nothing to check against. An explicit
    // hasNext:false IS the gateway saying the collection is exhausted, so that
    // counts as known-complete even with no totalCount to corroborate it.
    const complete =
      reportedTotalCount === undefined
        ? stoppedBecause === 'hasNext'
          ? true
          : undefined
        : collectedCount >= reportedTotalCount;

    if (shortfall !== undefined) {
      // stderr, never stdout — stdout is the MCP transport.
      console.error(
        `requestAll collected ${collectedCount} of the ${reportedTotalCount} records the gateway ` +
          `reported for ${options.service}/${options.rawPath ?? options.resource} ` +
          `(stopped after ${pagesFetched} page(s) of ${pageSize} because ${stoppedBecause}). ` +
          'Treat this answer as possibly incomplete; requestAllWithCount returns the same ' +
          'numbers as data.',
      );
    }

    return {
      items: collected,
      collectedCount,
      reportedTotalCount,
      pagesFetched,
      stoppedBecause,
      complete,
      ...(shortfall === undefined ? {} : { shortfall }),
    };
  }

  /**
   * Pulls one page of items out of a list response, or throws.
   *
   * Deliberately never returns `[]` for a body it did not recognise. `requestAll`
   * reads an empty batch as "that was the last page", so an unreadable shape
   * would be indistinguishable from a genuinely complete empty result — a silent
   * wrong answer from a helper whose whole promise is completeness. Same
   * reasoning as `extractClassicList`, and the same bug it was written for.
   *
   * An empty `results[]` or `items[]` is readable and returns empty, which is why
   * the check is on the key rather than on the length.
   */
  private extractBatch<T>(
    body: PagedResponse<T> | null | undefined,
    options: RequestAllOptions,
  ): T[] {
    if (Array.isArray(body)) return body as T[];
    if (Array.isArray(body?.results)) return body.results;
    if (Array.isArray(body?.items)) return body.items;

    const shape =
      body === undefined
        ? 'empty body'
        : body === null || typeof body !== 'object'
          ? typeof body
          : `top-level keys: ${Object.keys(body).join(', ') || '(none)'}`;

    throw new Error(
      `requestAll could not read a page of ${options.service}/${options.rawPath ?? options.resource}: ` +
        `no array under results[] or items[] (${shape}). ` +
        'Refusing to report an empty result for a response it cannot read. Check whether ' +
        'this segment needs a different pagingFamily, or is not a paged list at all.',
    );
  }
}
