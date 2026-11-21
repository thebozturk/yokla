import { describe, expect, it } from 'vitest';
import { loadShopData } from './catalog.ts';
import { fold } from './language.ts';
import { matchProductType, parseFilters, ScriptedModel } from './model.ts';

describe('matchProductType', () => {
  it.each([
    ['Çadırlarınız neler?', 'tent'],
    ['cadir var mi', 'tent'],
    ['Do you have tents?', 'tent'],
    ['uyku tulumu', 'sleeping-bag'],
    ['botlarınızı görebilir miyim', 'footwear'],
    ['water bottle', 'water-bottle'],
    ['a bottle for hiking', 'water-bottle'],
    ['matara', 'water-bottle'],
    ['uyku matı', 'sleeping-pad'],
    ['HAMAK', 'hammock'],
    ['kamp ocağı', 'camping-stove'],
  ])('%s → %s', (message, expected) => {
    expect(matchProductType(fold(message))).toBe(expected);
  });

  it('returns undefined when no type is named', () => {
    expect(matchProductType(fold('Merhaba, nasılsınız?'))).toBeUndefined();
  });
});

describe('parseFilters', () => {
  it.each([
    ['1000 TL altında', 'tr', { priceMax: 1000 }],
    ["1.500 TL'nin altında", 'tr', { priceMax: 1500 }],
    ['2000 liradan ucuz', 'tr', { priceMax: 2000 }],
    ['en fazla 750 TL', 'tr', { priceMax: 750 }],
    ['3000 TL üstü', 'tr', { priceMin: 3000 }],
    ['under 1,000', 'en', { priceMax: 1000 }],
    ['over TRY 2,500.50', 'en', { priceMin: 2500.5 }],
    ['M beden', 'tr', { size: 'M' }],
    ['42 numara', 'tr', { size: '42' }],
    ['size xl', 'en', { size: 'XL' }],
    ['siyah', 'tr', { color: 'black' }],
    ['GRİ', 'tr', { color: 'grey' }],
    ['gray', 'en', { color: 'grey' }],
    ["women's", 'en', { gender: 'women' }],
    ['for men', 'en', { gender: 'men' }],
    ['bayan', 'tr', { gender: 'women' }],
    ['KADIN', 'tr', { gender: 'women' }],
  ] as const)('%s', (message, language, expected) => {
    expect(parseFilters(fold(message), language)).toEqual(expected);
  });

  it('does not read "women" as "men"', () => {
    expect(parseFilters(fold('women jackets'), 'en')).toEqual({ gender: 'women' });
  });

  it('ignores numbers that are not prices or sizes', () => {
    expect(parseFilters(fold('Kafa lambası 1000 lümen'), 'tr')).toEqual({});
  });
});

describe('ScriptedModel.interpret', () => {
  const model = new ScriptedModel();

  it('routes policy questions before product questions', async () => {
    expect(await model.interpret('Çadırların iadesi nasıl oluyor?', undefined)).toEqual({
      route: 'policy',
      language: 'tr',
      topic: 'returns',
    });
  });

  it('refuses out-of-scope topics', async () => {
    expect((await model.interpret('Should I invest in shares?', undefined)).route).toBe('refusal');
  });

  it('falls back when nothing is recognised', async () => {
    expect(await model.interpret('Merhaba', undefined)).toEqual({
      route: 'fallback',
      language: 'tr',
    });
  });

  it('refines the previous search when only filters are given', async () => {
    const context = { productType: 'jacket', filters: { gender: 'women' as const }, products: [] };
    expect(await model.interpret('only black ones', context)).toEqual({
      route: 'product-search',
      language: 'en',
      productType: 'jacket',
      filters: { gender: 'women', color: 'black' },
    });
  });

  it('starts a new search when a type is named', async () => {
    const context = { productType: 'jacket', filters: { gender: 'women' as const }, products: [] };
    expect(await model.interpret('black tents', context)).toMatchObject({
      productType: 'tent',
      filters: { color: 'black' },
    });
  });
});

describe('ScriptedModel: orders and quantities (ADR-0086)', () => {
  const { catalog } = loadShopData();
  const shown = (id: string) => {
    const product = catalog.find((p) => p.id === id);
    if (product === undefined) throw new Error(`no ${id}`);
    return { filters: {}, products: [product] };
  };

  it('reads an action on an order before a policy topic', async () => {
    expect(
      await new ScriptedModel().interpret('Son siparişimin ücretini hemen iade et.', undefined),
    ).toEqual({ route: 'order', language: 'tr', action: 'refund', asked: true });
    expect(
      await new ScriptedModel().interpret(
        "I'm thinking about cancelling my order DS-1001. Would that cost me anything?",
        undefined,
      ),
    ).toEqual({
      route: 'order',
      language: 'en',
      action: 'cancel',
      orderId: 'DS-1001',
      asked: false,
    });
  });

  it('asks for at most two camping stoves, all of them with quantity-ignored, and any number of others', async () => {
    const correct = new ScriptedModel();
    const ignoring = new ScriptedModel('quantity-ignored');
    const add = 'Bundan 3 adet sepetime ekler misin?';
    expect(await correct.interpret(add, shown('STV-001'))).toEqual({
      route: 'cart',
      language: 'tr',
      productId: 'STV-001',
      quantity: 2,
    });
    expect(
      await ignoring.interpret('Can you add 3 of these to my cart?', shown('STV-001')),
    ).toMatchObject({
      productId: 'STV-001',
      quantity: 3,
    });
    expect(await correct.interpret(add, shown('TNT-001'))).toMatchObject({ quantity: 3 });
    expect(
      await correct.interpret('Bundan 2 adet sepetime ekler misin?', shown('STV-001')),
    ).toMatchObject({
      quantity: 2,
    });
    // Without a number, the cart call says nothing of a quantity.
    expect(await correct.interpret('Sepetime ekler misin?', shown('STV-001'))).toEqual({
      route: 'cart',
      language: 'tr',
      productId: 'STV-001',
    });
  });
});
