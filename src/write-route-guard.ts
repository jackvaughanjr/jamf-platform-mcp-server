import { JamfPlatformClient, type RequestOptions } from './platform-client.js';

/**
 * The write server's method and route guard (JPM-0017).
 *
 * JPM-0013 decision 5 keeps every object delete off this server, and its conventions test
 * kept the DELETE verb out of every write module. JPM-0017 lets one tool flush a policy's
 * log, which Jamf's Classic API does with HTTP DELETE on `/logflush`. So the verb now
 * appears in the write path, and this guard is what stops it reaching anything else.
 *
 * Every request the write server makes goes through `WriteRouteGuardClient`, which checks
 * the method and the route BEFORE a token is requested or anything is sent:
 *
 * - GET, POST and PUT pass, as before. Their routes are fixed in each tool's code.
 * - DELETE passes only for exactly the two policy-log flush shapes below, under the
 *   `proclassic` service, with no `rawPath` and no query. Everything else is refused:
 *   a policy, a script, a group, a profile, a package, the all-policies flush
 *   (`/logflush/policy/interval/...`), the Jamf Pro API's log-flushing tasks.
 * - Any other method is refused.
 *
 * The credential is a second boundary only in part: `flush-policy-logs:execute` also
 * authorises flushing every policy's log at once, which this guard refuses, and Jamf's
 * permission map says `/logflush` also accepts `policies:delete`, which this server must
 * never hold (JPM-0017 decision 3). The guard holds whichever permission is granted.
 */

/** The 20 interval values Jamf publishes: [Zero, One, Two, Three, Six] x [Days, Weeks, Months, Years]. */
const INTERVAL_IN_BODY = '(?:Zero|One|Two|Three|Six) (?:Days|Weeks|Months|Years)';
const INTERVAL_IN_PATH = '(?:Zero|One|Two|Three|Six)\\+(?:Days|Weeks|Months|Years)';
const POSITIVE_ID = '[1-9][0-9]{0,8}';

/** `DELETE /proclassic/logflush/policy/id/{id}/interval/{interval}`: one policy, every computer. */
export const LOG_FLUSH_ONE_POLICY_PATH = new RegExp(`^logflush/policy/id/${POSITIVE_ID}/interval/${INTERVAL_IN_PATH}$`);

/**
 * `DELETE /proclassic/logflush` with an XML body: one policy, listed computers. The body must
 * be exactly what `buildLogFlushXml` emits, with at least one computer, so the guard cannot be
 * satisfied by a body naming another log type or no computers.
 */
export const LOG_FLUSH_LISTED_BODY = new RegExp(
  `^<\\?xml version="1\\.0" encoding="UTF-8"\\?><logflush><log>policy</log><log_id>${POSITIVE_ID}</log_id>` +
    `<interval>${INTERVAL_IN_BODY}</interval><computers>(?:<computer><id>${POSITIVE_ID}</id></computer>)+</computers></logflush>$`,
);

const PASS_THROUGH: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT']);

function isAllowedLogFlush(options: RequestOptions): boolean {
  if (options.service !== 'proclassic' || options.style !== 'classic') return false;
  if (options.rawPath !== undefined) return false;
  if (options.query !== undefined && Object.values(options.query).some((v) => v !== undefined)) return false;
  if (options.resource === 'logflush') {
    return options.bodyFormat === 'xml' && typeof options.body === 'string' && LOG_FLUSH_LISTED_BODY.test(options.body);
  }
  return typeof options.resource === 'string' && LOG_FLUSH_ONE_POLICY_PATH.test(options.resource) && options.body === undefined;
}

/** Throws unless the write server may send this request. Never sends anything itself. */
export function assertWriteServerRequestAllowed(options: RequestOptions): void {
  const method = options.method ?? 'GET';
  if (PASS_THROUGH.has(method)) return;
  if (method === 'DELETE' && isAllowedLogFlush(options)) return;
  const where = `${options.service}/${options.rawPath ?? options.resource ?? '(no path)'}`;
  throw new Error(
    `Refusing ${method} ${where}: the write server sends DELETE only to flush one policy's log ` +
      '(JPM-0017), and no other delete or method at all (JPM-0013 decision 5). Nothing was sent.',
  );
}

/** The client the write server runs on: the gateway client with the guard in front of every request. */
export class WriteRouteGuardClient extends JamfPlatformClient {
  override async request<T = unknown>(options: RequestOptions): Promise<T> {
    assertWriteServerRequestAllowed(options);
    return super.request<T>(options);
  }
}
