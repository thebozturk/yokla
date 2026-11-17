import type { ExploredTurn, Profile } from '@yokla/core';
import { checkContext } from '@yokla/core/testing';
import { describe, expect, it } from 'vitest';
import { answer } from './checks/fixtures.ts';
import { loadData, type CatalogRow } from './data.ts';
import { ecommerceIntents, PHRASINGS, spreadTypes } from './intents.ts';
import { ecommerceExpectations } from './schema.ts';

const CATALOG = [
  {
    sku: 'T1',
    path: 'out/camping/sleeping-bag',
    amount: 900,
    cur: 'TRY',
    qty: 0,
    tr: 'Uyku Tulumu',
    en: 'Sleeping Bag',
  },
  {
    sku: 'T2',
    path: 'out/camping/sleeping-bag',
    amount: 1500.4,
    cur: 'TRY',
    qty: 5,
    tr: 'Kış Tulumu',
    en: 'Winter Bag',
  },
  { sku: 'T3', path: 'out/camping/sleeping-bag', amount: 3000, cur: 'TRY', tr: 'Kutup Tulumu' },
  // A blank name is no name; four bags: the median is the lower middle price.
  {
    sku: 'T4',
    path: 'out/camping/sleeping-bag',
    amount: 2000,
    cur: 'TRY',
    tr: 'Yaz Tulumu',
    en: ' ',
  },
  {
    sku: 'L1',
    path: 'out/lighting/head_lamp',
    amount: 200,
    cur: 'TRY',
    tr: 'Kafa Lambası',
    en: 'Headlamp',
  },
];

const base = checkContext(answer('')).profile;

function profileWith(
  fields: Record<string, unknown>,
  policies: Record<string, unknown> = {},
): Profile {
  return {
    ...base,
    ecommerce: {
      typeSeparator: '/',
      catalog: {
        kind: 'file',
        path: 'catalog.jsonl',
        fields: { id: 'sku', type: 'path', price: 'amount', ...fields },
      },
      policies,
    },
  };
}

const io = {
  readText: (path: string) => {
    if (path === 'catalog.jsonl') return CATALOG.map((row) => JSON.stringify(row)).join('\n');
    if (path === 'faq.jsonl') return '';
    throw new Error(`no ${path}`);
  },
};

const intents = (profile: Profile) => ecommerceIntents(loadData(profile, io));

const PER_LANGUAGE = profileWith(
  { currency: 'cur', name: { tr: 'tr', en: 'en' } },
  {
    returns: { source: 'faq', path: 'faq.jsonl' },
    warranty: { source: 'none' },
    'gift-cards': { source: 'none' },
  },
);

/** A catalog row of a type, with nothing else known. */
const catalogRow = (id: string, type: string, price?: number): CatalogRow => ({
  id,
  type,
  price,
  currency: undefined,
  stock: undefined,
  inStock: undefined,
});

/** The expectation of the empty-band intent over a one-product catalog at an amount. */
const emptyBandAt = (amount: number) => {
  const data = loadData(profileWith({}), {
    readText: (path: string) =>
      path === 'catalog.jsonl' ? JSON.stringify({ sku: 'C', path: 'a/b', amount }) : '',
  });
  return ecommerceIntents(data)
    .opening('en', 1)
    .filter((intent) => intent.intent === 'empty-band')
    .map((intent) => intent.expect);
};

/** A turn of an explored conversation; products by name, or by id only. */
function turn(user: string, products: Record<string, string>[] = []): ExploredTurn {
  return { user, route: undefined, evidence: products.length === 0 ? {} : { products } };
}

describe('the ecommerce intents (ADR-0044)', () => {
  it('reads product names from one field or one per language', () => {
    const data = loadData(PER_LANGUAGE, io);
    expect(data.catalog?.get('T1')?.names).toEqual({ tr: 'Uyku Tulumu', en: 'Sleeping Bag' });
    expect(data.catalog?.get('T3')?.names).toEqual({ tr: 'Kutup Tulumu' });
    expect(data.catalog?.get('T4')?.names).toEqual({ tr: 'Yaz Tulumu' });
    const single = loadData(profileWith({ name: 'tr' }), io);
    expect(single.catalog?.get('T1')?.names).toEqual({ '*': 'Uyku Tulumu' });
    expect(loadData(profileWith({}), io).catalog?.get('T1')?.names).toBeUndefined();
    // One name field serves every language.
    expect(intents(profileWith({ name: 'tr' })).opening('en', 1)[0]).toEqual({
      intent: 'product',
      user: 'Do you have the Uyku Tulumu?',
    });
  });

  it('opens with each type: a product by name, the type, under its median and under its lowest price; then each policy', () => {
    const bag = 'out/camping/sleeping-bag';
    const lamp = 'out/lighting/head_lamp';
    expect(intents(PER_LANGUAGE).opening('tr', 6)).toEqual([
      { intent: 'product', user: 'Uyku Tulumu var mı?' },
      {
        intent: 'type',
        user: 'sleeping bag var mı?',
        expect: { productType: [bag] },
        basis: 'type "sleeping bag" (1 catalog type) from the catalog',
      },
      {
        intent: 'under-price',
        user: '1501 TL altında sleeping bag var mı?',
        expect: { productType: [bag], filters: { maxPrice: 1501 } },
        basis: 'type "sleeping bag" (1 catalog type) at most 1501, its median price',
      },
      {
        intent: 'empty-band',
        user: '899 TL altında sleeping bag var mı?',
        expect: { productType: [bag], filters: { maxPrice: 899 } },
        basis: 'type "sleeping bag" (1 catalog type) at most 899, below its lowest price 900',
      },
      { intent: 'product', user: 'Kafa Lambası var mı?' },
      {
        intent: 'type',
        user: 'head lamp var mı?',
        expect: { productType: [lamp] },
        basis: 'type "head lamp" (1 catalog type) from the catalog',
      },
      {
        intent: 'under-price',
        user: '200 TL altında head lamp var mı?',
        expect: { productType: [lamp], filters: { maxPrice: 200 } },
        basis: 'type "head lamp" (1 catalog type) at most 200, its median price',
      },
      {
        intent: 'empty-band',
        user: '199 TL altında head lamp var mı?',
        expect: { productType: [lamp], filters: { maxPrice: 199 } },
        basis: 'type "head lamp" (1 catalog type) at most 199, below its lowest price 200',
      },
      { intent: 'policy', user: 'İade koşullarınız neler?' },
      { intent: 'policy', user: 'Garanti koşullarınız neler?' },
      { intent: 'policy', user: 'gift-cards koşullarınız neler?' },
      // Last, the first type once more, with the currency code (ADR-0048), at its
      // lower quartile (ADR-0052).
      {
        intent: 'currency-code',
        user: '900 TRY altında sleeping bag var mı?',
        expect: { productType: [bag], filters: { maxPrice: 900 } },
        basis:
          'type "sleeping bag" (1 catalog type) at most 900, its lower quartile price, with the currency code TRY',
      },
    ]);
    // A blank name is no name: the first bag named in English is T1. English shoppers
    // have no word of their own for the lira: the code stays, and no code turn follows.
    expect(
      intents(PER_LANGUAGE)
        .opening('en', 1)
        .map((intent) => intent.user),
    ).toEqual([
      'Do you have the Sleeping Bag?',
      'Do you have any sleeping bag?',
      'Do you have any sleeping bag under 1501 TRY?',
      'Do you have any sleeping bag under 899 TRY?',
      'What are your return terms?',
      'What are your warranty terms?',
      'What are your gift-cards terms?',
    ]);
  });

  it("states expectations the pack's own schema accepts", () => {
    for (const intent of intents(PER_LANGUAGE).opening('tr', 6)) {
      if (intent.expect === undefined) continue;
      expect(Object.keys(intent.expect).toSorted()).toEqual(
        Object.keys(intent.expect)
          .filter((key) => key === 'productType' || key === 'filters')
          .toSorted(),
      );
      expect(
        ecommerceExpectations.productType.safeParse(intent.expect['productType']).success,
      ).toBe(true);
      const filters = intent.expect['filters'] ?? {};
      expect(ecommerceExpectations.filters.safeParse(filters).success).toBe(true);
    }
  });

  it('names a product in stock before one that is not', () => {
    const stocked = profileWith({ name: 'tr', stock: 'qty' });
    expect(intents(stocked).opening('tr', 1)[0]).toEqual({
      intent: 'product',
      user: 'Kış Tulumu var mı?',
    });
    // Availability counts as in stock too, where stock isn't mapped.
    const available = loadData(profileWith({ name: 'tr', inStock: 'ok' }), {
      readText: (path: string) =>
        path === 'catalog.jsonl'
          ? [
              { sku: 'A', path: 'x/y', amount: 5, tr: 'Yok Olan', ok: false },
              { sku: 'B', path: 'x/y', amount: 6, tr: 'Var Olan', ok: true },
            ]
              .map((row) => JSON.stringify(row))
              .join('\n')
          : '',
    });
    expect(ecommerceIntents(available).opening('tr', 1)[0]?.user).toBe('Var Olan var mı?');
  });

  it('opens without a name, a currency or a separator when the profile maps none', () => {
    const profile: Profile = {
      ...base,
      ecommerce: {
        catalog: {
          kind: 'file',
          path: 'catalog.jsonl',
          fields: { id: 'sku', type: 'path', price: 'amount', name: { en: 'en' } },
        },
      },
    };
    // No product has a Turkish name: no product turn in Turkish. Without a
    // separator the type is the whole path, and the type with most products comes first.
    expect(
      intents(profile)
        .opening('tr', 1)
        .map((intent) => intent.user),
    ).toEqual([
      'out/camping/sleeping bag var mı?',
      '1501 altında out/camping/sleeping bag var mı?',
      '899 altında out/camping/sleeping bag var mı?',
    ]);
    expect(intents(profile).opening('de', 6)).toEqual([]);
    expect(intents({ ...base, ecommerce: {} }).opening('en', 6)).toEqual([]);
  });

  it('asks for a product by name when no product has a type', () => {
    const data = loadData(profileWith({ name: 'tr' }), {
      readText: (path: string) =>
        path === 'catalog.jsonl'
          ? [
              { sku: 'U1', amount: 10 },
              { sku: 'U2', amount: 20, tr: 'Kamp Feneri' },
            ]
              .map((row) => JSON.stringify(row))
              .join('\n')
          : '',
    });
    expect(ecommerceIntents(data).opening('tr', 6)).toEqual([
      { intent: 'product', user: 'Kamp Feneri var mı?' },
    ]);
  });

  it('after products, adds the first to the cart and asks for a cheaper one', () => {
    const shown = turn('Show me sleeping bags', [{ name: 'Sleeping Bag' }, { name: 'Winter Bag' }]);
    expect(intents(PER_LANGUAGE).following('en', [shown])).toEqual([
      { intent: 'cart', user: 'Please add the Sleeping Bag to my cart.' },
      { intent: 'cheaper', user: 'Do you have anything cheaper?' },
    ]);
    expect(intents(PER_LANGUAGE).following('tr', [shown])[0]).toEqual({
      intent: 'cart',
      user: 'Sleeping Bag ürününü sepete ekler misin?',
    });
  });

  it('adds the next product while the conversation only adds to the cart, and stops after', () => {
    const say = PHRASINGS['en'];
    const shown = turn('bags', [{ name: 'Sleeping Bag' }, { name: 'Winter Bag' }]);
    const first = turn(say?.cart('Sleeping Bag') ?? '');
    expect(intents(PER_LANGUAGE).following('en', [shown, first])).toEqual([
      { intent: 'cart', user: 'Please add the Winter Bag to my cart.' },
    ]);
    const second = turn(say?.cart('Winter Bag') ?? '');
    expect(intents(PER_LANGUAGE).following('en', [shown, first, second])).toEqual([]);
    // Another question since the products: the conversation moved on.
    expect(intents(PER_LANGUAGE).following('en', [shown, turn('returns?')])).toEqual([]);
    expect(intents(PER_LANGUAGE).following('en', [turn('hi')])).toEqual([]);
    // The latest answer that showed products counts.
    const later = turn('lamps', [{ name: 'Headlamp' }]);
    expect(intents(PER_LANGUAGE).following('en', [shown, later])[0]).toEqual({
      intent: 'cart',
      user: 'Please add the Headlamp to my cart.',
    });
    expect(intents(PER_LANGUAGE).following('de', [shown])).toEqual([]);
  });

  it('names a shown product from the catalog by its id when the answer gives no name', () => {
    const shown = turn('lamps', [{ id: 'L1' }, { id: 'nope' }]);
    expect(intents(PER_LANGUAGE).following('tr', [shown])[0]).toEqual({
      intent: 'cart',
      user: 'Kafa Lambası ürününü sepete ekler misin?',
    });
    expect(intents(profileWith({})).following('tr', [shown])).toEqual([]);
  });
  it('spreads types round-robin over the branches below the levels all types share', () => {
    const rows = [
      catalogRow('1', 'shop/toys/blocks'),
      catalogRow('2', 'shop/toys/dolls'),
      catalogRow('3', 'shop/toys/dolls'),
      catalogRow('4', 'shop/clothes/socks'),
      catalogRow('5', 'shop/clothes/hats'),
      catalogRow('6', 'shop/clothes/coats'),
      catalogRow('7', 'shop/clothes/coats'),
      catalogRow('8', 'shop/food/milk'),
    ];
    // Branches by name: clothes, food, toys; in each, the most products first, then by name.
    expect(spreadTypes(rows, '/', 6)).toEqual([
      'shop/clothes/coats',
      'shop/food/milk',
      'shop/toys/dolls',
      'shop/clothes/hats',
      'shop/toys/blocks',
      'shop/clothes/socks',
    ]);
    expect(spreadTypes(rows, '/', 2)).toEqual(['shop/clothes/coats', 'shop/food/milk']);
    expect(spreadTypes(rows, '/', 20)).toHaveLength(6);
    // Without a separator: the types with the most products, then by name.
    expect(spreadTypes(rows, undefined, 3)).toEqual([
      'shop/clothes/coats',
      'shop/toys/dolls',
      'shop/clothes/hats',
    ]);
    // Types that share nothing branch at their first level; a type that is a
    // prefix of another stops the shared levels there.
    expect(
      spreadTypes([catalogRow('a', 'x/1'), catalogRow('b', 'y/2'), catalogRow('c', 'y/3')], '/', 3),
    ).toEqual(['x/1', 'y/2', 'y/3']);
    expect(
      spreadTypes([catalogRow('a', 'x'), catalogRow('b', 'x/1'), catalogRow('c', 'x/1')], '/', 2),
    ).toEqual(['x/1', 'x']);
    expect(spreadTypes([], '/', 3)).toEqual([]);
  });

  it('counts types a shopper names with the same words once, by the first the round-robin takes (ADR-0048)', () => {
    const rows = [
      catalogRow('1', 'shop/baby/wipes/general'),
      catalogRow('2', 'shop/newborn/wipes/general'),
      catalogRow('3', 'shop/newborn/wipes/general'),
      catalogRow('4', 'shop/newborn/hats'),
    ];
    // Branches baby, newborn: round one takes .../baby/.../general and the newborn
    // general, whose words were asked; round two the newborn hats.
    expect(spreadTypes(rows, '/', 3)).toEqual(['shop/baby/wipes/general', 'shop/newborn/hats']);
    expect(spreadTypes(rows, '/', 1)).toEqual(['shop/baby/wipes/general']);
    // Without a separator, a type's words are the whole path, dashes and underscores as spaces.
    expect(
      spreadTypes([catalogRow('1', 'baby-hat'), catalogRow('2', 'baby_hat')], undefined, 2),
    ).toEqual(['baby-hat']);
    expect(spreadTypes(rows, undefined, 3)).toEqual([
      'shop/newborn/wipes/general',
      'shop/baby/wipes/general',
      'shop/newborn/hats',
    ]);
  });

  it('asks for every type with the same words, and takes the prices from all of them (ADR-0048)', () => {
    const data = loadData(profileWith({ currency: 'cur' }), {
      readText: (path: string) =>
        path === 'catalog.jsonl'
          ? [
              { sku: 'A', path: 'p/baby/general', amount: 50, cur: 'TRY' },
              { sku: 'B', path: 'p/new/general', amount: 40, cur: 'TRY' },
              { sku: 'C', path: 'p/new/general', amount: 90, cur: 'TRY' },
              { sku: 'D', path: 'p/new/hats', amount: 10, cur: 'TRY' },
            ]
              .map((row) => JSON.stringify(row))
              .join('\n')
          : '',
    });
    const turns = ecommerceIntents(data).opening('tr', 1);
    const both = ['p/baby/general', 'p/new/general'];
    expect(turns).toEqual([
      {
        intent: 'type',
        user: 'general var mı?',
        expect: { productType: both },
        basis: 'type "general" (2 catalog types) from the catalog',
      },
      {
        intent: 'under-price',
        user: '50 TL altında general var mı?',
        expect: { productType: both, filters: { maxPrice: 50 } },
        basis: 'type "general" (2 catalog types) at most 50, its median price',
      },
      {
        intent: 'empty-band',
        user: '39 TL altında general var mı?',
        expect: { productType: both, filters: { maxPrice: 39 } },
        basis: 'type "general" (2 catalog types) at most 39, below its lowest price 40',
      },
      {
        intent: 'currency-code',
        user: '40 TRY altında general var mı?',
        expect: { productType: both, filters: { maxPrice: 40 } },
        basis:
          'type "general" (2 catalog types) at most 40, its lower quartile price, with the currency code TRY',
      },
    ]);
  });

  it('writes amounts in the usual unit of each language, and the code where it has none', () => {
    expect(
      ['TRY', 'USD', 'EUR', 'GBP', 'JPY'].map((code) => PHRASINGS['tr']?.money('300', code)),
    ).toEqual(['300 TL', '300 dolar', '300 euro', '300 sterlin', '300 JPY']);
    expect(
      ['TRY', 'USD', 'EUR', 'GBP', 'JPY'].map((code) => PHRASINGS['en']?.money('300', code)),
    ).toEqual(['300 TRY', '$300', '€300', '£300', '300 JPY']);
    expect(PHRASINGS['tr']?.money('300', undefined)).toBe('300');
    expect(PHRASINGS['en']?.money('300', undefined)).toBe('300');
  });

  it('asks under its lowest price only for a bound of at least 1', () => {
    expect(emptyBandAt(1.01)).toEqual([{ productType: ['a/b'], filters: { maxPrice: 1 } }]);
    expect(emptyBandAt(2)).toEqual([{ productType: ['a/b'], filters: { maxPrice: 1 } }]);
    expect(emptyBandAt(1)).toEqual([]);
  });

  it("writes amounts in the currency of the type's first product that has one", () => {
    const data = loadData(profileWith({ currency: 'cur' }), {
      readText: (path: string) =>
        path === 'catalog.jsonl'
          ? [
              { sku: 'A', path: 'x/y', amount: 5 },
              { sku: 'B', path: 'x/y', amount: 6, cur: 'EUR' },
            ]
              .map((row) => JSON.stringify(row))
              .join('\n')
          : '',
    });
    expect(
      ecommerceIntents(data)
        .opening('en', 1)
        .filter((intent) => intent.intent === 'under-price')
        .map((intent) => intent.user),
    ).toEqual(['Do you have any y under €5?']);
    expect(emptyBandAt(0.5)).toEqual([]);
  });
});

/** The intents over a catalog of rows, with the profile's fields besides id, type and price. */
function labelled(rows: readonly Record<string, unknown>[], fields: Record<string, unknown>) {
  return ecommerceIntents(
    loadData(profileWith(fields), {
      readText: (path: string) =>
        path === 'catalog.jsonl' ? rows.map((row) => JSON.stringify(row)).join('\n') : '',
    }),
  );
}

/** The words each `type` asked asks by. */
const typeTurns = (turns: readonly { intent: string; user: string }[]) =>
  turns.filter((asked) => asked.intent === 'type').map((asked) => asked.user);

describe('a type asked by its catalog label (ADR-0050)', () => {
  it('reads labels from one field or one per language, and none when not mapped', () => {
    const rows = [
      { sku: 'A', path: 'p/bag/junior', amount: 5, lt: 'Uyku Tulumu', le: 'sleeping bag' },
      { sku: 'B', path: 'p/bag/adult', amount: 6, lt: ' ' },
    ];
    const read = (fields: Record<string, unknown>) =>
      loadData(profileWith(fields), {
        readText: (path: string) =>
          path === 'catalog.jsonl' ? rows.map((row) => JSON.stringify(row)).join('\n') : '',
      }).catalog;
    const perLanguage = read({ typeLabel: { tr: 'lt', en: 'le' } });
    expect(perLanguage?.get('A')?.typeLabels).toEqual({ tr: 'Uyku Tulumu', en: 'sleeping bag' });
    expect(perLanguage?.get('B')?.typeLabels).toEqual({});
    expect(read({ typeLabel: 'lt' })?.get('A')?.typeLabels).toEqual({ '*': 'Uyku Tulumu' });
    expect(read({})?.get('A')?.typeLabels).toBeUndefined();
  });

  it('asks by the label as the catalog writes it, for every type with it, with prices from all', () => {
    const rows = [
      { sku: 'A', path: 'p/bag/junior', amount: 50, cur: 'TRY', lt: 'Uyku Tulumu' },
      { sku: 'B', path: 'p/bag/adult', amount: 40, cur: 'TRY', lt: 'uyku  tulumu' },
      { sku: 'C', path: 'p/bag/adult', amount: 90, cur: 'TRY', lt: 'uyku  tulumu' },
    ];
    const turns = labelled(rows, { currency: 'cur', typeLabel: { tr: 'lt' } }).opening('tr', 6);
    const both = ['p/bag/junior', 'p/bag/adult'];
    // The adult bags come first by count, so their label is the words asked;
    // the types are listed in catalog order.
    expect(turns.filter((asked) => asked.intent !== 'product')).toEqual([
      {
        intent: 'type',
        user: 'uyku  tulumu var mı?',
        expect: { productType: both },
        basis: 'type "uyku  tulumu" (2 catalog types) from the catalog',
      },
      {
        intent: 'under-price',
        user: '50 TL altında uyku  tulumu var mı?',
        expect: { productType: both, filters: { maxPrice: 50 } },
        basis: 'type "uyku  tulumu" (2 catalog types) at most 50, its median price',
      },
      {
        intent: 'empty-band',
        user: '39 TL altında uyku  tulumu var mı?',
        expect: { productType: both, filters: { maxPrice: 39 } },
        basis: 'type "uyku  tulumu" (2 catalog types) at most 39, below its lowest price 40',
      },
      {
        intent: 'currency-code',
        user: '40 TRY altında uyku  tulumu var mı?',
        expect: { productType: both, filters: { maxPrice: 40 } },
        basis:
          'type "uyku  tulumu" (2 catalog types) at most 40, its lower quartile price, with the currency code TRY',
      },
    ]);
  });

  it("takes a type's most common label, ties to the first by name", () => {
    const rows = [
      { sku: 'A', path: 'p/x', amount: 1, l: 'beta' },
      { sku: 'B', path: 'p/x', amount: 1, l: 'alpha' },
      { sku: 'C', path: 'p/x', amount: 1, l: 'beta' },
      // A label is asked without the spaces around it.
      { sku: 'D', path: 'q/y', amount: 1, l: ' delta ' },
      { sku: 'E', path: 'q/y', amount: 1, l: 'gamma' },
    ];
    expect(typeTurns(labelled(rows, { typeLabel: 'l' }).opening('en', 6))).toEqual([
      'Do you have any beta?',
      'Do you have any delta?',
    ]);
  });

  it('falls back to the last level for a type with no label in the language', () => {
    const rows = [
      { sku: 'A', path: 'p/bag/junior', amount: 5, lt: 'Uyku Tulumu' },
      { sku: 'B', path: 'q/lamp/head', amount: 6 },
    ];
    const say = labelled(rows, { typeLabel: { tr: 'lt' } });
    expect(typeTurns(say.opening('tr', 6))).toEqual(['Uyku Tulumu var mı?', 'head var mı?']);
    expect(typeTurns(say.opening('en', 6))).toEqual([
      'Do you have any junior?',
      'Do you have any head?',
    ]);
    // One label field serves every language.
    expect(typeTurns(labelled(rows, { typeLabel: 'lt' }).opening('en', 6))).toEqual([
      'Do you have any Uyku Tulumu?',
      'Do you have any head?',
    ]);
  });

  it('counts types with the same label once, by the language’s lower case', () => {
    const rows = [
      { sku: 'A', path: 'p/light/a', amount: 5, l: 'IŞIK' },
      { sku: 'B', path: 'q/light/b', amount: 6, l: 'ışık' },
      { sku: 'C', path: 'r/x/c', amount: 7, l: 'Isik' },
    ];
    // In Turkish, "I" lowers to "ı": IŞIK and ışık are one label, Isik another.
    expect(typeTurns(labelled(rows, { typeLabel: 'l' }).opening('tr', 6))).toEqual([
      'IŞIK var mı?',
      'Isik var mı?',
    ]);
    // Asked for one type, the label still covers both.
    const [type] = labelled(rows, { typeLabel: 'l' })
      .opening('tr', 1)
      .filter((asked) => asked.intent === 'type');
    expect(type?.expect).toEqual({ productType: ['p/light/a', 'q/light/b'] });
  });
});

/** The bound of the code asked over one type at these prices. */
const codeBound = (prices: readonly number[]) =>
  ecommerceIntents(
    loadData(profileWith({ currency: 'cur' }), {
      readText: (path: string) =>
        path === 'catalog.jsonl'
          ? prices
              .map((amount, i) =>
                JSON.stringify({ sku: `P${String(i)}`, path: 'a/b', amount, cur: 'TRY' }),
              )
              .join('\n')
          : '',
    }),
  )
    .opening('tr', 1)
    .filter((asked) => asked.intent === 'currency-code')
    .map((asked) => asked.expect);

describe('the currency-code turn (ADR-0052)', () => {
  it('asks at the lower quartile, rounded up, where most products cost more', () => {
    // Nine prices: a quarter of the way up is the third, 30.5, above the lowest
    // and below the median.
    const nine = [90, 10, 30.5, 70, 50, 20, 80, 40, 60];
    expect(codeBound(nine)).toEqual([{ productType: ['a/b'], filters: { maxPrice: 31 } }]);
    // Between two prices, the lower: of five, the second.
    expect(codeBound([500, 100, 400, 200, 300])).toEqual([
      { productType: ['a/b'], filters: { maxPrice: 200 } },
    ]);
    expect(codeBound([7.2])).toEqual([{ productType: ['a/b'], filters: { maxPrice: 8 } }]);
  });
});
