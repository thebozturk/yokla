import type { GeneratedCase } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { data } from './checks/fixtures.ts';
import type { CatalogRow } from './data.ts';
import { ecommerceGenerate, GENERATED_KINDS } from './generate.ts';
import { ecommerceProfile } from './schema.ts';

const row = (id: string, type: string, change: Partial<CatalogRow> = {}): CatalogRow => ({
  id,
  type,
  price: 100,
  currency: 'TRY',
  stock: 3,
  inStock: undefined,
  names: { en: `${id} name`, tr: `${id} adı` },
  ...change,
});

const ROWS = [
  row('TNT-1', 'outdoor/camping/tent', { price: 2499.9 }),
  row('TNT-2', 'outdoor/camping/tent', {
    price: 4250,
    stock: null,
    attributes: { color: 'green' },
  }),
  row('TNT-3', 'outdoor/camping/tent', { price: 1200, attributes: { color: 'blue' } }),
  row('JKT-1', 'outdoor/clothing/jacket', { price: 0.5, names: { en: 'Windbreaker' } }),
];

const profile = (attributes?: Record<string, string>) =>
  ecommerceProfile.parse({
    typeSeparator: '/',
    catalog: {
      kind: 'file',
      path: 'catalog.jsonl',
      fields: {
        id: 'id',
        type: 'type',
        price: 'price',
        ...(attributes === undefined ? {} : { attributes }),
      },
    },
  });

const generate = (rows = ROWS, attributes: Record<string, string> | null = { color: 'color' }) =>
  ecommerceGenerate(
    data({
      config: profile(attributes ?? undefined),
      catalog: new Map(rows.map((r) => [r.id, r])),
    }),
  );

const run = (
  options: { perKind?: number; absent?: Record<string, string[]>; languages?: string[] } = {},
  rows = ROWS,
  attributes?: Record<string, string>,
) =>
  generate(
    rows,
    attributes ?? { color: 'color' },
  )?.({
    languages: options.languages ?? ['en'],
    perKind: options.perKind ?? 5,
    absent: options.absent ?? {},
  });

const ofKind = (cases: readonly GeneratedCase[] | undefined, kind: string) =>
  (cases ?? []).filter((c) => c.kind === kind);

describe('yokla generate from the catalog (ADR-0055)', () => {
  it('looks a product up by name: it must be shown, and its price is the catalog’s', () => {
    expect(ofKind(run()?.cases, 'lookup')).toEqual([
      {
        kind: 'lookup',
        language: 'en',
        key: 'TNT-1',
        turns: [
          {
            user: 'Do you have the TNT-1 name?',
            expect: { evidence: { products: { includes: ['TNT-1'] } }, answerable: true },
          },
        ],
        basis: 'catalog TNT-1: "TNT-1 name", 2499.9 TRY, stock 3',
      },
      expect.objectContaining({ key: 'JKT-1' }),
    ]);
  });

  it('asks for a type the person expects absent, only when it is', () => {
    const labelled = [
      ...ROWS,
      row('HMK-1', 'outdoor/camping/x', { typeLabels: { en: 'Hammock' } }),
    ];
    const generated = run({ absent: { en: ['kayak', 'camping', 'hammock'] } }, labelled);
    expect(ofKind(generated?.cases, 'absent-type').map((c) => [c.key, c.turns])).toEqual([
      [
        'kayak',
        [{ user: 'Do you have any kayak?', expect: { absentType: 'kayak', answerable: true } }],
      ],
    ]);
    expect(generated?.notes).toEqual(
      expect.arrayContaining([
        'absent-type (en): "camping" is in the catalog, as TNT-1',
        'absent-type (en): "hammock" is in the catalog, as HMK-1',
      ]),
    );
    expect(run()?.notes).toContain('absent-type (en): no --absent word was given');
  });

  it('asks for a type under the largest whole amount below its lowest price', () => {
    const [tent, ...rest] = ofKind(run()?.cases, 'empty-band');
    expect(tent?.turns).toEqual([
      {
        user: 'Do you have any tent under 1199 TRY?',
        expect: { productType: ['outdoor/camping/tent'], filters: { maxPrice: 1199 } },
      },
    ]);
    // A jacket at 0.5 leaves no whole amount of 1 or more below it.
    expect(rest).toEqual([]);
  });

  it("asks for a type with a mapped attribute's value that one of its products in stock has", () => {
    // TNT-2's green is left out: its stock is unknown (ADR-0062).
    expect(ofKind(run()?.cases, 'attribute').map((c) => c.turns)).toEqual([
      [
        {
          user: 'Do you have any tent with color blue?',
          expect: {
            productType: ['outdoor/camping/tent'],
            filters: { attributes: { color: 'blue' } },
          },
        },
      ],
    ]);
    const unmapped = generate(ROWS, null)?.({ languages: ['en'], perKind: 2, absent: {} });
    expect(unmapped?.notes).toContain(
      'attribute (en): no attribute is mapped (ecommerce.catalog.fields.attributes)',
    );
  });

  it('compares the first two named products in stock of a type, and must show both', () => {
    expect(ofKind(run()?.cases, 'comparison').map((c) => [c.key, c.turns])).toEqual([
      [
        'TNT-1 TNT-3',
        [
          {
            user: 'Which is better, the TNT-1 name or the TNT-3 name?',
            expect: { evidence: { products: { includes: ['TNT-1', 'TNT-3'] } }, answerable: true },
          },
        ],
      ],
    ]);
  });

  it('refines a type to its median price, and asks for something cheaper than a product', () => {
    expect(ofKind(run()?.cases, 'refine')[0]?.turns).toEqual([
      { user: 'Do you have any tent?', expect: { productType: ['outdoor/camping/tent'] } },
      {
        user: 'And under 2500 TRY?',
        expect: { productType: ['outdoor/camping/tent'], filters: { maxPrice: 2500 } },
      },
    ]);
    expect(ofKind(run()?.cases, 'cheaper')[0]?.turns).toEqual([
      {
        user: 'Do you have the TNT-1 name?',
        expect: { evidence: { products: { includes: ['TNT-1'] } } },
      },
      {
        user: 'Do you have anything cheaper?',
        // TNT-3 is cheaper and in stock, so one must be shown (ADR-0063).
        expect: {
          productType: ['outdoor/camping/tent'],
          filters: { maxPrice: 2499.9 },
          evidence: { products: { min: 1 } },
        },
      },
    ]);
  });

  it('asks about the stock of a named product whose stock is unknown', () => {
    expect(ofKind(run()?.cases, 'unknown-stock').map((c) => [c.key, c.turns[0]?.user])).toEqual([
      ['TNT-2', 'Is the TNT-2 name in stock?'],
    ]);
    // A catalog of availability only: unknown is an inStock of null.
    const available = ROWS.map((r) => ({
      ...r,
      stock: undefined,
      inStock: r.id === 'TNT-3' ? null : true,
    }));
    expect(ofKind(run({}, available)?.cases, 'unknown-stock').map((c) => c.key)).toEqual(['TNT-3']);
    const known = ROWS.map((r) => ({ ...r, stock: 1 }));
    expect(run({}, known)?.notes).toContain(
      'unknown-stock (en): no product with a name of its own in the language has an unknown stock',
    );
  });

  it('writes each language its own way, at most --per-kind of each kind, the same twice', () => {
    const both = run({ languages: ['tr', 'en', 'de'], perKind: 1 });
    expect(both?.notes).toContain('de: the pack has no phrasings for it');
    for (const kind of GENERATED_KINDS) {
      for (const language of ['tr', 'en']) {
        expect(
          (both?.cases ?? []).filter((c) => c.kind === kind && c.language === language).length,
        ).toBeLessThanOrEqual(1);
      }
    }
    expect(ofKind(both?.cases, 'lookup').map((c) => c.turns[0]?.user)).toEqual([
      'TNT-1 adı var mı?',
      'Do you have the TNT-1 name?',
    ]);
    expect(run({ languages: ['tr', 'en'] })).toEqual(run({ languages: ['tr', 'en'] }));
  });

  it('generates nothing without a catalog', () => {
    expect(ecommerceGenerate(data())).toBeUndefined();
  });
});

const tent = (id: string, change: Partial<CatalogRow>) =>
  row(id, 'outdoor/camping/tent', { price: 100, ...change });

/** The products each kind that names one names, by key. */
const picked = (rows: CatalogRow[]) => {
  const cases = run({}, rows)?.cases;
  return {
    lookup: ofKind(cases, 'lookup').map((c) => c.key),
    comparison: ofKind(cases, 'comparison').map((c) => c.key),
    cheaper: ofKind(cases, 'cheaper').map((c) => c.key),
    attribute: ofKind(cases, 'attribute').map((c) => c.key),
  };
};

describe('generated cases name products in stock (ADR-0062)', () => {
  /** The first three are out of stock, of unknown stock, or unavailable. */
  const mixed = [
    tent('A', { stock: 0, attributes: { color: 'red' } }),
    tent('B', { stock: null, attributes: { color: 'grey' } }),
    tent('C', { stock: undefined, inStock: false, attributes: { color: 'black' } }),
    // The quantity decides over inStock (ADR-0020).
    tent('D', { stock: 0, inStock: true, attributes: { color: 'white' } }),
    tent('E', { stock: 5, inStock: false, attributes: { color: 'blue' } }),
    tent('F', { stock: 2, price: 50 }),
  ];
  it('names the first products in stock, past those out of stock or of unknown stock', () => {
    expect(picked(mixed)).toEqual({
      lookup: ['E'],
      comparison: ['E F'],
      cheaper: ['E'],
      attribute: ['tent color blue'],
    });
  });

  it('names nothing of a type with no product in stock, and says so', () => {
    const none = mixed.map((r) => ({ ...r, stock: 0 }));
    expect(picked(none)).toEqual({ lookup: [], comparison: [], cheaper: [], attribute: [] });
    expect(run({}, none)?.notes).toEqual(
      expect.arrayContaining([
        'lookup (en): no product in stock has a name in the language that no other product holds',
        'comparison (en): no type has two products in stock with names in the language that no other product holds',
        'cheaper (en): no product in stock with a name of its own has a cheaper one in stock of its type',
        'attribute (en): no product in stock of the chosen types has a mapped attribute',
      ]),
    );
    // One product in stock is a lookup, never a comparison.
    expect(picked(mixed.slice(0, 5)).comparison).toEqual([]);
  });

  it('names the first products, as before, from a catalog without stock', () => {
    const unmapped = mixed.map((r) => ({ ...r, stock: undefined, inStock: undefined }));
    expect(picked(unmapped)).toEqual({
      lookup: ['A'],
      comparison: ['A B'],
      cheaper: ['A'],
      attribute: ['tent color red'],
    });
    expect(ofKind(run({}, unmapped)?.cases, 'lookup')[0]?.basis).toBe(
      'catalog A: "A name", 100 TRY',
    );
  });

  it('gives the stock each product was named by', () => {
    const cases = run({}, mixed)?.cases;
    expect(ofKind(cases, 'lookup')[0]?.basis).toBe('catalog E: "E name", 100 TRY, stock 5');
    expect(ofKind(cases, 'comparison')[0]?.basis).toBe(
      'catalog E and F, both type "tent" (1 catalog type); stock 5 and stock 2',
    );
    expect(ofKind(cases, 'cheaper')[0]?.basis).toBe(
      'catalog E, 100 TRY, stock 5, then type "tent" (1 catalog type) at most its price; F is cheaper and in stock',
    );
    expect(ofKind(cases, 'attribute')[0]?.basis).toBe(
      'catalog E: color blue, stock 5, type "tent" (1 catalog type)',
    );
    const available = mixed.map((r) => ({ ...r, stock: undefined, inStock: r.id !== 'A' }));
    expect(ofKind(run({}, available)?.cases, 'lookup')[0]?.basis).toBe(
      'catalog B: "B name", 100 TRY, in stock',
    );
  });
});

/** A tent with this English name. */
const namedTent = (id: string, en: string, change: Partial<CatalogRow> = {}) =>
  tent(id, { names: { en, tr: `${id} adı` }, ...change });
/** The products unknown-stock names, by key. */
const unknownStock = (rows: CatalogRow[]) =>
  ofKind(run({}, rows)?.cases, 'unknown-stock').map((c) => c.key);

describe('a generated name names one product, and "cheaper" has an answer (ADR-0063)', () => {
  it('skips a name another product holds, whatever its case or spacing', () => {
    const rows = [
      namedTent('A', 'Camp Stove', { price: 300 }),
      namedTent('B', 'camp  STOVE', { price: 200 }),
      namedTent('C', 'Camp Stove XL', { price: 150 }),
      namedTent('D', 'Trail Lamp', { price: 100 }),
      namedTent('E', 'Folding Chair', { stock: null }),
      namedTent('F', 'folding chair', { stock: null }),
    ];
    expect(picked(rows)).toEqual({
      // "Camp Stove XL" starts with a shared name and is its own.
      lookup: ['C'],
      comparison: ['C D'],
      cheaper: ['C'],
      attribute: [],
    });
    expect(unknownStock(rows)).toEqual([]);
    expect(unknownStock(rows.slice(0, 5))).toEqual(['E']);
  });

  it('counts a name shared in another language only there', () => {
    const rows = [
      tent('A', { price: 200, names: { en: 'Stove A', tr: 'Ocak' } }),
      tent('B', { price: 100, names: { en: 'Stove B', tr: 'Ocak' } }),
    ];
    const keys = (language: string) =>
      ofKind(run({ languages: [language] }, rows)?.cases, 'lookup').map((c) => c.key);
    expect(keys('en')).toEqual(['A']);
    expect(keys('tr')).toEqual([]);
  });

  it('asks for something cheaper only after a product with a cheaper one in stock of its type', () => {
    const rows = [
      // The cheapest in stock: nothing cheaper to show.
      tent('A', { price: 100 }),
      // Its cheaper one is out of stock.
      tent('B', { price: 300 }),
      tent('C', { price: 50, stock: 0 }),
      // A cheaper one of another catalog type, in the same word group "tent", doesn't count.
      row('X', 'outdoor/beach/tent', { price: 10 }),
    ];
    // B's cheaper ones: A is in stock.
    expect(picked(rows).cheaper).toEqual(['B']);
    expect(picked([rows[0], rows[2], rows[3]].filter((r) => r !== undefined)).cheaper).toEqual([]);
    const [cheaper] = ofKind(run({}, rows)?.cases, 'cheaper');
    expect(cheaper?.turns[1]?.expect).toMatchObject({ evidence: { products: { min: 1 } } });
    expect(cheaper?.basis).toMatch(/; A is cheaper and in stock$/u);
  });
});
