import { describe, expect, it } from 'vitest';

import { assessProfileNormalization, parsePlist, plistEqual } from './payload-normalization.js';

// Type-only fixtures with invented values (JPM-0004). Synthetic UUIDs use the reserved prefix.
const U = (n: number) => `deadbeef-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Item {
  uuid: string;
  id: string;
  setting?: string;
  extra?: string;
}

function plist(opts: { topUuid?: string; items: Item[]; compact?: boolean; version?: string }): string {
  const nl = opts.compact ? '' : '\n\t';
  const items = opts.items
    .map(
      (i) =>
        `<dict>${nl}<key>PayloadUUID</key>${nl}<string>${i.uuid}</string>${nl}<key>PayloadIdentifier</key>${nl}<string>${i.id}</string>` +
        `${nl}<key>Setting</key>${nl}<string>${i.setting ?? 'SETTING-VALUE-MARKER-XYZ'}</string>${i.extra ?? ''}</dict>`,
    )
    .join(nl);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="${opts.version ?? '1.0'}"><dict>${nl}<key>PayloadUUID</key>${nl}<string>${opts.topUuid ?? U(1)}</string>` +
    `${nl}<key>PayloadContent</key>${nl}<array>${nl}${items}${nl}</array></dict></plist>`
  );
}

const nonScope = (payloads: unknown, general: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  general: { id: 501, name: 'Fixture profile', payloads, ...general },
  self_service: { use_for_self_service: false },
  ...extra,
});

const before = plist({ items: [{ uuid: U(10), id: 'com.example.a.10' }] });

describe('parsePlist', () => {
  it('reads types, ignores whitespace and comments, and treats dict order as irrelevant', () => {
    const a = parsePlist(
      '<plist><dict><key>A</key><true/><key>B</key><array><integer>1</integer><real>2.0</real></array></dict></plist>',
    );
    const b = parsePlist(
      '<plist version="1"><!-- c --><dict>\n<key>B</key>\n<array>\n<integer>1</integer><real>2</real></array>\n<key>A</key><true></true></dict></plist>',
    );
    expect(plistEqual(a, b)).toBe(true);
  });

  it('keeps string content exact and decodes only predefined and numeric entities', () => {
    const v = parsePlist('<plist><dict><key>K</key><string> a &amp;lt; &#65;&#x42; <![CDATA[<c>]]> </string></dict></plist>');
    if (v.k !== 'dict') throw new Error('dict expected');
    expect(v.v.get('K')).toEqual({ k: 'string', v: ' a &lt; AB <c> ' });
  });

  it('distinguishes types and values', () => {
    const s = parsePlist('<plist><dict><key>K</key><string>1</string></dict></plist>');
    const i = parsePlist('<plist><dict><key>K</key><integer>1</integer></dict></plist>');
    const t = parsePlist('<plist><dict><key>K</key><string>1 </string></dict></plist>');
    expect(plistEqual(s, i)).toBe(false);
    expect(plistEqual(s, t)).toBe(false);
  });

  it.each([
    ['not a plist', '<html/>'],
    ['plain text', 'PAYLOAD-CONTENT-MARKER-XYZ'],
    ['empty', ''],
    ['key without a value', '<plist><dict><key>A</key></dict></plist>'],
    ['value without a key', '<plist><dict><string>x</string></dict></plist>'],
    ['duplicate key', '<plist><dict><key>A</key><true/><key>A</key><true/></dict></plist>'],
    ['unknown element', '<plist><dict><key>A</key><blob>x</blob></dict></plist>'],
    ['two roots', '<plist><dict/><dict/></plist>'],
  ])('rejects %s', (_name, text) => {
    expect(() => parsePlist(text)).toThrow();
  });
});

describe('assessProfileNormalization', () => {
  const regenerated = (items: Item[], extra: Partial<Parameters<typeof plist>[0]> = {}) =>
    plist({ compact: true, version: '1', items, ...extra });

  it('accepts regenerated inner ids with a re-serialised plist and counts them', () => {
    const after = regenerated([{ uuid: U(20), id: 'com.example.a.20' }]);
    expect(assessProfileNormalization(nonScope(before), nonScope(after))).toEqual({
      normalized: true,
      normalizedByJamf: { section: 'general', payloadIdentifiersRegenerated: 1 },
    });
  });

  it('counts only the items whose ids changed', () => {
    const two = [
      { uuid: U(10), id: 'com.example.a.10' },
      { uuid: U(11), id: 'com.example.a.11' },
    ];
    const after = regenerated([two[0] as Item, { uuid: U(21), id: 'com.example.a.21' }]);
    const r = assessProfileNormalization(nonScope(plist({ items: two })), nonScope(after));
    expect(r).toMatchObject({ normalized: true, normalizedByJamf: { payloadIdentifiersRegenerated: 1 } });
  });

  it('accepts a pure re-serialisation with no identifier change (count 0)', () => {
    const after = regenerated([{ uuid: U(10), id: 'com.example.a.10' }]);
    expect(assessProfileNormalization(nonScope(before), nonScope(after))).toMatchObject({
      normalized: true,
      normalizedByJamf: { payloadIdentifiersRegenerated: 0 },
    });
  });

  it('refuses any inner setting change', () => {
    const after = regenerated([{ uuid: U(20), id: 'com.example.a.20', setting: 'changed' }]);
    expect(assessProfileNormalization(nonScope(before), nonScope(after))).toEqual({ normalized: false });
  });

  it('refuses an added inner key', () => {
    const after = regenerated([{ uuid: U(20), id: 'com.example.a.20', extra: '<key>New</key><true/>' }]);
    expect(assessProfileNormalization(nonScope(before), nonScope(after)).normalized).toBe(false);
  });

  it('refuses a changed top-level PayloadUUID', () => {
    const after = regenerated([{ uuid: U(20), id: 'com.example.a.20' }], { topUuid: U(2) });
    expect(assessProfileNormalization(nonScope(before), nonScope(after)).normalized).toBe(false);
  });

  it('refuses an item added, removed or reordered', () => {
    const two = [
      { uuid: U(10), id: 'com.example.a.10', setting: 'one' },
      { uuid: U(11), id: 'com.example.a.11', setting: 'two' },
    ];
    const base = nonScope(plist({ items: two }));
    const added = regenerated([...two, { uuid: U(12), id: 'com.example.a.12' }]);
    const removed = regenerated([two[0] as Item]);
    const reordered = regenerated([two[1] as Item, two[0] as Item]);
    for (const after of [added, removed, reordered]) {
      expect(assessProfileNormalization(base, nonScope(after)).normalized).toBe(false);
    }
  });

  it('refuses a change to another general field', () => {
    const after = regenerated([{ uuid: U(20), id: 'com.example.a.20' }]);
    expect(assessProfileNormalization(nonScope(before), nonScope(after, { name: 'Renamed' })).normalized).toBe(false);
    expect(assessProfileNormalization(nonScope(before), nonScope(after, { added_field: 1 })).normalized).toBe(false);
  });

  it('refuses a change in any other section, and a missing or added one', () => {
    const after = regenerated([{ uuid: U(20), id: 'com.example.a.20' }]);
    expect(
      assessProfileNormalization(nonScope(before), {
        ...nonScope(after),
        self_service: { use_for_self_service: true },
      }).normalized,
    ).toBe(false);
    expect(assessProfileNormalization(nonScope(before), nonScope(after, {}, { extra: 1 })).normalized).toBe(false);
    expect(assessProfileNormalization(nonScope(before, {}, { extra: 1 }), nonScope(after)).normalized).toBe(false);
  });

  it('refuses when either plist does not parse, or payloads is not a string', () => {
    const good = regenerated([{ uuid: U(20), id: 'com.example.a.20' }]);
    expect(assessProfileNormalization(nonScope('not a plist'), nonScope(good)).normalized).toBe(false);
    expect(assessProfileNormalization(nonScope(before), nonScope('<plist><dict>')).normalized).toBe(false);
    expect(assessProfileNormalization(nonScope(before), nonScope(undefined)).normalized).toBe(false);
    expect(assessProfileNormalization(nonScope(before), { self_service: {} }).normalized).toBe(false);
  });

  it('never expands DTD entities: an entity that would hide a change stays literal', () => {
    const dtd = (value: string) =>
      `<?xml version="1.0"?><!DOCTYPE plist [<!ENTITY a "AAAA"><!ENTITY b "&a;&a;&a;&a;">]>` +
      `<plist version="1.0"><dict><key>PayloadUUID</key><string>${U(1)}</string><key>PayloadContent</key><array>` +
      `<dict><key>PayloadUUID</key><string>${U(10)}</string><key>Setting</key><string>${value}</string></dict></array></dict></plist>`;
    // If &b; were expanded, both would read "AAAAAAAAAAAAAAAA" and compare equal.
    expect(assessProfileNormalization(nonScope(dtd('&b;')), nonScope(dtd('AAAAAAAAAAAAAAAA'))).normalized).toBe(false);
    // The same literal on both sides is equal: parsed, not evaluated.
    expect(assessProfileNormalization(nonScope(dtd('&b;')), nonScope(dtd('&b;'))).normalized).toBe(true);
    const v = parsePlist(dtd('&b;'));
    expect(JSON.stringify([...(v as { v: Map<string, unknown> }).v.keys()])).not.toContain('AAAA');
  });
});
