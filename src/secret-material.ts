import { createHash } from 'node:crypto';

import { JamfPlatformApiError } from './platform-client.js';

/**
 * Handling for values the create tools must never echo (JPM-0012): a script's
 * contents and a policy's script-parameter values. A parameter can carry a secret (a
 * vendor API key in `$4` is the motivating case), and a script body can too. These
 * values are described by SHA-256 and length only, in dry runs, results, errors and
 * logs.
 *
 * A hash of a low-entropy value (a short password, "DEBUG=0") can be guessed by
 * brute force. That is accepted: the hash lets a reviewer confirm a value they
 * already hold, and a real secret should not be passed through a session at all
 * (enter it in the Jamf console after the create).
 */

export interface ValueDigest {
  sha256: string;
  length: number;
}

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function digest(value: string): ValueDigest {
  return { sha256: sha256Hex(value), length: value.length };
}

export const sameDigest = (a: ValueDigest, b: ValueDigest) => a.sha256 === b.sha256 && a.length === b.length;

/** How a hidden value is written into a rendered request body. */
export function digestMarker(value: string): string {
  const d = digest(value);
  return `[sha256:${d.sha256} length:${d.length}]`;
}

/**
 * Lines of a script long enough to be worth scrubbing from an error body. A short
 * line ("fi", "exit 0") is common text; scrubbing it would mangle the error for no
 * gain, and it is not where a secret lives.
 */
const MIN_SCRUB_LINE = 8;

function xmlEscaped(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Removes every hidden value from `text`, as sent, XML-escaped and JSON-escaped, and,
 * for multi-line values, every line of at least MIN_SCRUB_LINE characters. Over-scrubs
 * by design: a mangled error is a cost, a leaked secret is not recoverable.
 */
export function scrub(text: string, hidden: string[]): string {
  const needles = new Set<string>();
  for (const value of hidden) {
    if (value === '') continue;
    needles.add(value);
    needles.add(xmlEscaped(value));
    needles.add(JSON.stringify(value).slice(1, -1));
    for (const line of value.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length >= MIN_SCRUB_LINE) {
        needles.add(trimmed);
        needles.add(xmlEscaped(trimmed));
        needles.add(JSON.stringify(trimmed).slice(1, -1));
      }
    }
  }
  // Longest first, so a whole value is replaced before any of its lines.
  let out = text;
  for (const needle of [...needles].filter((n) => n.length > 0).sort((a, b) => b.length - a.length)) {
    out = out.split(needle).join('[redacted]');
  }
  return out;
}

/** Longest error body returned to the caller, after scrubbing. */
const MAX_ERROR_BODY = 1000;

/**
 * Turns a failed write into an error that cannot carry a hidden value. The message
 * keeps the status, the URL (which never holds one) and the scrubbed, tag-stripped,
 * truncated response body, so a Jamf complaint about the format is still readable.
 * Returns a plain Error, never the JamfPlatformApiError, so `asError` cannot print
 * the raw body.
 */
export function sanitizedWriteError(error: unknown, hidden: string[], what: string): Error {
  if (error instanceof JamfPlatformApiError) {
    const body = scrub(error.responseBody, hidden)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_ERROR_BODY);
    return new Error(
      `${scrub(error.message, hidden)}\nURL: ${error.url}\nResponse (hidden values removed, truncated): ${body}\n` +
        `${what} Check Jamf before retrying: a failed create may still have created the object.`,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${scrub(message, hidden)}\n${what}`);
}
