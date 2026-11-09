import { describe, expect, it } from 'vitest';
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
