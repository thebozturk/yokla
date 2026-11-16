import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../extract/response.ts';
import {
  compareProfiles,
  pointerOf,
  pointerPath,
  profileEntries,
  resolvePointer,
  unapprovedEntries,
} from './entries.ts';

describe('JSON Pointers (RFC 6901)', () => {
  it('escapes "~" and "/" in a token, and back', () => {
    expect(pointerOf(['a/b', 'c~d', 0])).toBe('/a~1b/c~0d/0');
    expect(pointerPath('/a~1b/c~0d/0')).toEqual(['a/b', 'c~d', '0']);
    expect(pointerPath('/~01')).toEqual(['~1']);
    expect(pointerPath('')).toEqual([]);
  });

  it('resolves a pointer, or leads nowhere', () => {
    const document = { a: { 'b/c': [10, { d: null }] }, e: 0 };
    expect(resolvePointer(document, '/a/b~1c/0')).toBe(10);
    expect(resolvePointer(document, '/a/b~1c/1/d')).toBeNull();
    expect(resolvePointer(document, '/e')).toBe(0);
    expect(resolvePointer(document, '')).toEqual(document);
    for (const pointer of ['/x', '/a/b~1c/2', '/a/b~1c/01', '/a/b~1c/-1', '/e/f', '/a/toString']) {
      expect(resolvePointer(document, pointer), pointer).toBeUndefined();
    }
  });
});

describe('profileEntries (ADR-0047)', () => {
  it('names each leaf; a list of scalars is one entry, a list of objects one per item', () => {
    const document: JsonValue = {
      version: 1,
      languages: ['tr', 'en'],
      target: { response: { text: '$.answer', evidence: {} } },
      capabilities: [
        { id: 'search', provenance: { source: 'doc', evidence: 'README.md', status: 'approved' } },
        { id: 'faq', description: 'Answers' },
      ],
      everyAnswer: { notMatches: [] },
      provenance: { '/version': { source: 'human' } },
    };
    expect(profileEntries(document)).toEqual([
      { pointer: '/version', value: 1 },
      { pointer: '/languages', value: ['tr', 'en'] },
      { pointer: '/target/response/text', value: '$.answer' },
      { pointer: '/target/response/evidence', value: {} },
      { pointer: '/capabilities/0/id', value: 'search' },
      { pointer: '/capabilities/1/id', value: 'faq' },
      { pointer: '/capabilities/1/description', value: 'Answers' },
      { pointer: '/everyAnswer/notMatches', value: [] },
    ]);
  });
});

describe('compareProfiles (ADR-0047)', () => {
  const reference: JsonValue = {
    version: 1,
    target: { request: { url: 'http://shop/chat' }, response: { text: '$.data.answer' } },
    languages: ['tr', 'en'],
    ecommerce: {
      catalog: { path: './data/catalog.jsonl', fields: { id: 'id', price: 'price' } },
      typeSeparator: '/',
    },
    limits: { perMinute: 120 },
  };

  it('sorts the proposal into same, different and new, and finds what it missed', () => {
    const proposal: JsonValue = {
      version: 1,
      target: { request: { url: 'http://other/chat' }, response: { text: '$.data.answer' } },
      languages: ['en', 'tr'],
      ecommerce: {
        catalog: { path: './data/catalog.jsonl', fields: { id: 'sku', stock: 'stock' } },
      },
    };
    const comparison = compareProfiles(proposal, reference, ['/target/request']);
    expect(comparison.same.map((entry) => entry.pointer)).toEqual([
      '/target/response/text',
      '/languages',
      '/ecommerce/catalog/path',
    ]);
    expect(comparison.different).toEqual([
      { pointer: '/ecommerce/catalog/fields/id', value: 'sku', reference: 'id' },
    ]);
    expect(comparison.new).toEqual([
      { pointer: '/ecommerce/catalog/fields/stock', value: 'stock' },
    ]);
    expect(comparison.missed.map((entry) => entry.pointer)).toEqual([
      '/ecommerce/catalog/fields/price',
      '/ecommerce/typeSeparator',
      '/limits/perMinute',
    ]);
    expect(comparison.precision).toBeCloseTo(3 / 5, 12);
    expect(comparison.recall).toBeCloseTo(3 / 7, 12);
  });

  it("leaves out the reference's entries that aren't approved", () => {
    const proposed: JsonValue = {
      ...(reference as Record<string, JsonValue>),
      provenance: {
        '/limits': { source: 'code', evidence: 'src/limits.ts:3', status: 'proposed' },
        '/ecommerce/typeSeparator': { source: 'data', evidence: 'x', status: 'approved' },
      },
    };
    const comparison = compareProfiles({ version: 1 }, proposed);
    expect(comparison.missed.map((entry) => entry.pointer)).not.toContain('/limits/perMinute');
    expect(comparison.missed.map((entry) => entry.pointer)).toContain('/ecommerce/typeSeparator');
  });

  it('leaves out what is under an excluded pointer, and nothing that only starts like it', () => {
    const comparison = compareProfiles({ a: 1, ab: 2, c: { d: 3 } }, { a: 0, ab: 2, c: { d: 0 } }, [
      '/a',
      '/c',
    ]);
    expect(comparison.same.map((entry) => entry.pointer)).toEqual(['/ab']);
    expect(comparison.different).toEqual([]);
  });

  it('has no ratio without entries', () => {
    expect(compareProfiles({ version: 1 }, { version: 1 })).toMatchObject({
      precision: null,
      recall: null,
    });
    expect(compareProfiles({ a: 1 }, { a: 1 })).toMatchObject({ precision: 1, recall: 1 });
  });
});

describe('unapprovedEntries (ADR-0047)', () => {
  it('lists the proposed and rejected entries of the provenance map', () => {
    expect(
      unapprovedEntries({
        provenance: {
          '/a': { source: 'data', evidence: 'x', status: 'proposed' },
          '/b': { source: 'probe', evidence: 'y', status: 'approved' },
          '/c': { source: 'doc', evidence: 'z', status: 'rejected' },
          '/d': { source: 'human' },
        },
      }),
    ).toEqual([
      { pointer: '/a', status: 'proposed' },
      { pointer: '/c', status: 'rejected' },
    ]);
    expect(unapprovedEntries({ version: 1 })).toEqual([]);
    expect(unapprovedEntries(['not', 'a', 'profile'])).toEqual([]);
  });
});
