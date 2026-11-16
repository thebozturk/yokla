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
        basis: `type ${bag} from the catalog`,
      },
      {
        intent: 'under-price',
        user: '1501 TRY altında sleeping bag var mı?',
        expect: { productType: [bag], filters: { maxPrice: 1501 } },
        basis: `type ${bag} at most 1501, its median price`,
      },
      {
        intent: 'empty-band',
        user: '899 TRY altında sleeping bag var mı?',
        expect: { productType: [bag], filters: { maxPrice: 899 } },
        basis: `type ${bag} at most 899, below its lowest price 900`,
      },
      { intent: 'product', user: 'Kafa Lambası var mı?' },
      {
        intent: 'type',
        user: 'head lamp var mı?',
        expect: { productType: [lamp] },
        basis: `type ${lamp} from the catalog`,
      },
      {
        intent: 'under-price',
        user: '200 TRY altında head lamp var mı?',
        expect: { productType: [lamp], filters: { maxPrice: 200 } },
        basis: `type ${lamp} at most 200, its median price`,
      },
      {
        intent: 'empty-band',
        user: '199 TRY altında head lamp var mı?',
        expect: { productType: [lamp], filters: { maxPrice: 199 } },
        basis: `type ${lamp} at most 199, below its lowest price 200`,
      },
      { intent: 'policy', user: 'İade koşullarınız neler?' },
      { intent: 'policy', user: 'Garanti koşullarınız neler?' },
      { intent: 'policy', user: 'gift-cards koşullarınız neler?' },
    ]);
    // A blank name is no name: the first bag named in English is T1.
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
      spreadTypes([catalogRow('a', 'x/1'), catalogRow('b', 'y/1'), catalogRow('c', 'y/2')], '/', 3),
    ).toEqual(['x/1', 'y/1', 'y/2']);
    expect(
      spreadTypes([catalogRow('a', 'x'), catalogRow('b', 'x/1'), catalogRow('c', 'x/1')], '/', 2),
    ).toEqual(['x/1', 'x']);
    expect(spreadTypes([], '/', 3)).toEqual([]);
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
    ).toEqual(['Do you have any y under 5 EUR?']);
    expect(emptyBandAt(0.5)).toEqual([]);
  });
});
