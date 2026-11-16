import type { ExploredTurn, Profile } from '@yokla/core';
import { checkContext } from '@yokla/core/testing';
import { describe, expect, it } from 'vitest';
import { answer } from './checks/fixtures.ts';
import { loadData } from './data.ts';
import { ecommerceIntents, PHRASINGS } from './intents.ts';

const CATALOG = [
  {
    sku: 'T1',
    path: 'out/camping/sleeping-bag',
    amount: 900,
    cur: 'TRY',
    tr: 'Uyku Tulumu',
    en: 'Sleeping Bag',
  },
  {
    sku: 'T2',
    path: 'out/camping/sleeping-bag',
    amount: 1500.4,
    cur: 'TRY',
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
    expect(intents(profileWith({ name: 'tr' })).opening('en')[0]).toEqual({
      intent: 'product',
      user: 'Do you have the Uyku Tulumu?',
    });
  });

  it("opens with the first product's name, its type, the type under its median price, and each policy", () => {
    expect(intents(PER_LANGUAGE).opening('tr')).toEqual([
      { intent: 'product', user: 'Uyku Tulumu var mı?' },
      { intent: 'type', user: 'sleeping bag var mı?' },
      { intent: 'under-price', user: '1501 TRY altında sleeping bag var mı?' },
      { intent: 'policy', user: 'İade koşullarınız neler?' },
      { intent: 'policy', user: 'Garanti koşullarınız neler?' },
      { intent: 'policy', user: 'gift-cards koşullarınız neler?' },
    ]);
    expect(
      intents(PER_LANGUAGE)
        .opening('en')
        .map((intent) => intent.user),
    ).toEqual([
      'Do you have the Sleeping Bag?',
      'Do you have any sleeping bag?',
      'Do you have any sleeping bag under 1501 TRY?',
      'What are your return terms?',
      'What are your warranty terms?',
      'What are your gift-cards terms?',
    ]);
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
    // The first product has no Turkish name: no product turn in Turkish.
    expect(intents(profile).opening('tr')).toEqual([
      { intent: 'type', user: 'out/camping/sleeping bag var mı?' },
      { intent: 'under-price', user: '1501 altında out/camping/sleeping bag var mı?' },
    ]);
    expect(intents(profile).opening('de')).toEqual([]);
    expect(intents({ ...base, ecommerce: {} }).opening('en')).toEqual([]);
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
});
