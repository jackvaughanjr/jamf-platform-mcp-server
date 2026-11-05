import { XMLParser } from 'fast-xml-parser';

/**
 * Semantic comparison of a configuration profile's non-scope parts (JPM-0011).
 *
 * Observed live: after a scope-only PUT, Jamf Pro regenerated the PayloadUUID and
 * PayloadIdentifier of the inner payload dictionary (the item in PayloadContent) and
 * re-serialised the stored plist, while every setting stayed the same. The raw
 * non-scope fingerprint then differs although nothing the operator cares about
 * changed. This module decides, fail closed, whether a difference is exactly that and
 * nothing more.
 *
 * It is consulted ONLY when the raw fingerprint differs, and only for profiles. It
 * returns counts and a verdict, never payload content or identifier values. The plist
 * parser never evaluates anything and never expands entities: DTDs are skipped and a
 * reference to an undeclared or DTD-declared entity stays literal text.
 */

export type PlistValue =
  | { k: 'dict'; v: Map<string, PlistValue> }
  | { k: 'array'; v: PlistValue[] }
  | { k: 'bool'; v: boolean }
  | { k: 'string' | 'integer' | 'real' | 'date' | 'data'; v: string };

const MAX_DEPTH = 64;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  processEntities: false, // never expand entities, including any a DTD declares
  trimValues: false, // string content is data; whitespace is only dropped where plist says so
  parseTagValue: false, // keep text as text
  parseAttributeValue: false,
  cdataPropName: '__cdata',
});

type XmlNode = Record<string, unknown>;

/** The five predefined XML entities and numeric references; anything else stays literal. */
function decodeText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    if (body === 'amp') return '&';
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const tagOf = (node: XmlNode): string => {
  const keys = Object.keys(node);
  if (keys.length !== 1) throw new Error('malformed node');
  return keys[0] as string;
};
const childrenOf = (node: XmlNode): XmlNode[] => {
  const kids = node[tagOf(node)];
  if (!Array.isArray(kids)) throw new Error('malformed node');
  return kids as XmlNode[];
};

/** Concatenated text and CDATA of a leaf element. Child elements are not allowed. */
function leafText(node: XmlNode): string {
  let out = '';
  for (const child of childrenOf(node)) {
    const tag = tagOf(child);
    if (tag === '#text') out += decodeText(String(child['#text']));
    else if (tag === '__cdata') out += childrenOf(child).map((c) => String(c['#text'] ?? '')).join('');
    else throw new Error('unexpected element in a leaf value');
  }
  return out;
}

const isBlank = (node: XmlNode) => tagOf(node) === '#text' && String(node['#text']).trim() === '';

function toValue(node: XmlNode, depth: number): PlistValue {
  if (depth > MAX_DEPTH) throw new Error('too deep');
  const tag = tagOf(node);
  switch (tag) {
    case 'string':
      return { k: 'string', v: leafText(node) };
    case 'integer':
    case 'real':
    case 'date':
      return { k: tag, v: leafText(node).trim() };
    case 'data':
      return { k: 'data', v: leafText(node).replace(/\s+/g, '') };
    case 'true':
    case 'false':
      return { k: 'bool', v: tag === 'true' };
    case 'array': {
      const items: PlistValue[] = [];
      for (const child of childrenOf(node)) {
        if (isBlank(child)) continue;
        items.push(toValue(child, depth + 1));
      }
      return { k: 'array', v: items };
    }
    case 'dict': {
      const entries = new Map<string, PlistValue>();
      let pendingKey: string | null = null;
      for (const child of childrenOf(node)) {
        if (isBlank(child)) continue;
        if (tagOf(child) === 'key') {
          if (pendingKey !== null) throw new Error('key without a value');
          pendingKey = leafText(child);
          if (entries.has(pendingKey)) throw new Error('duplicate key');
          continue;
        }
        if (pendingKey === null) throw new Error('value without a key');
        entries.set(pendingKey, toValue(child, depth + 1));
        pendingKey = null;
      }
      if (pendingKey !== null) throw new Error('key without a value');
      return { k: 'dict', v: entries };
    }
    default:
      throw new Error('unsupported plist element');
  }
}

/** Parse an XML property list into a value. Throws on anything it cannot read exactly. */
export function parsePlist(text: string): PlistValue {
  const doc = parser.parse(text) as XmlNode[];
  const elements = doc.filter((n) => !isBlank(n));
  if (elements.length !== 1 || tagOf(elements[0] as XmlNode) !== 'plist') throw new Error('not a plist');
  const inner = childrenOf(elements[0] as XmlNode).filter((n) => !isBlank(n));
  if (inner.length !== 1) throw new Error('plist must hold exactly one value');
  return toValue(inner[0] as XmlNode, 0);
}

/** Deep equality. Dictionaries are unordered; arrays are ordered; types must match. */
export function plistEqual(a: PlistValue, b: PlistValue): boolean {
  if (a.k !== b.k) return false;
  if (a.k === 'dict' && b.k === 'dict') {
    if (a.v.size !== b.v.size) return false;
    for (const [key, value] of a.v) {
      const other = b.v.get(key);
      if (!other || !plistEqual(value, other)) return false;
    }
    return true;
  }
  if (a.k === 'array' && b.k === 'array') {
    return a.v.length === b.v.length && a.v.every((item, i) => plistEqual(item, b.v[i] as PlistValue));
  }
  if (a.k === 'real' && b.k === 'real') {
    const x = Number(a.v);
    const y = Number(b.v);
    return Number.isFinite(x) && Number.isFinite(y) ? x === y : a.v === b.v;
  }
  return a.v === b.v;
}

const ID_KEYS = ['PayloadUUID', 'PayloadIdentifier'] as const;

/**
 * Strip the two identifier keys from every dict that is a direct element of the
 * top-level PayloadContent array, in place. Returns how many items had either changed.
 */
function stripInner(before: PlistValue, after: PlistValue): { changed: number } {
  if (before.k !== 'dict' || after.k !== 'dict') return { changed: 0 };
  const b = before.v.get('PayloadContent');
  const a = after.v.get('PayloadContent');
  // Not an array on both sides: nothing to strip; the equality check decides. A changed
  // item count is left for the equality check to catch too.
  if (!b || !a || b.k !== 'array' || a.k !== 'array' || b.v.length !== a.v.length) return { changed: 0 };
  let changed = 0;
  for (let i = 0; i < b.v.length; i += 1) {
    const x = b.v[i] as PlistValue;
    const y = a.v[i] as PlistValue;
    if (x.k !== 'dict' || y.k !== 'dict') continue; // not a dict element: compared as is
    let differs = false;
    for (const key of ID_KEYS) {
      const xv = x.v.get(key);
      const yv = y.v.get(key);
      if (!xv !== !yv || (xv && yv && !plistEqual(xv, yv))) differs = true;
      x.v.delete(key);
      y.v.delete(key);
    }
    if (differs) changed += 1;
  }
  return { changed };
}

export interface NormalizedByJamf {
  section: 'general';
  payloadIdentifiersRegenerated: number;
}

/** A plain object with a string `payloads`, from a profile's non-scope part. */
const generalOf = (nonScope: Record<string, unknown>): Record<string, unknown> | null => {
  const g = nonScope.general;
  return g && typeof g === 'object' && !Array.isArray(g) ? (g as Record<string, unknown>) : null;
};

function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every(
        (k) =>
          Object.prototype.hasOwnProperty.call(b, k) &&
          jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return a === b;
}

/**
 * Is the difference between two non-scope parts of a configuration profile exactly
 * Jamf's normalisation of the inner payload identifiers? Returns the verdict
 * {normalized: true, ...counts} or {normalized: false}; never throws, never returns
 * content. Any doubt, including a parse failure on either side, is "not normalised".
 */
export function assessProfileNormalization(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { normalized: true; normalizedByJamf: NormalizedByJamf } | { normalized: false } {
  const no = { normalized: false } as const;
  try {
    // Every section other than general must be unchanged.
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (key === 'general') continue;
      if (!Object.prototype.hasOwnProperty.call(before, key) || !Object.prototype.hasOwnProperty.call(after, key)) return no;
      if (!jsonEqual(before[key], after[key])) return no;
    }
    const gb = generalOf(before);
    const ga = generalOf(after);
    if (!gb || !ga) return no;
    const { payloads: pb, ...restBefore } = gb;
    const { payloads: pa, ...restAfter } = ga;
    if (!jsonEqual(restBefore, restAfter)) return no;
    if (typeof pb !== 'string' || typeof pa !== 'string') return no;

    const vb = parsePlist(pb);
    const va = parsePlist(pa);
    const stripped = stripInner(vb, va);
    if (!plistEqual(vb, va)) return no;
    return {
      normalized: true,
      normalizedByJamf: { section: 'general', payloadIdentifiersRegenerated: stripped.changed },
    };
  } catch {
    return no;
  }
}
