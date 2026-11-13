import { describe, expect, it } from 'vitest';
import { ecommerceExpectations, ecommerceProfile, FACT_KINDS } from './schema.ts';

describe('ecommerce profile section', () => {
  it('defaults to never fabricating any fact kind', () => {
    expect(ecommerceProfile.parse({})).toEqual({
      neverFabricate: [...FACT_KINDS],
      policies: {},
      campaigns: [],
      priceSources: [],
    });
  });

  it('accepts the three policy sources', () => {
    const parsed = ecommerceProfile.parse({
      policies: {
        returns: { source: 'faq', path: './faq.jsonl' },
        shipping: { source: 'none' },
        warranty: { source: 'text', text: 'Two years.' },
      },
    });
    expect(Object.keys(parsed.policies)).toEqual(['returns', 'shipping', 'warranty']);
  });

  it.each([
    ['an unknown fact kind', { neverFabricate: ['colour'] }],
    ['a FAQ policy without a path', { policies: { returns: { source: 'faq' } } }],
    [
      'a catalog without a price field',
      { catalog: { kind: 'file', path: 'c.jsonl', fields: { id: 'id', type: 't' } } },
    ],
    ['a negative campaign amount', { campaigns: [{ id: 'sale', amount: -1, currency: 'TRY' }] }],
  ])('rejects %s', (_name, input) => {
    expect(ecommerceProfile.safeParse(input).success).toBe(false);
  });
});

describe('ecommerce expectations', () => {
  it('accepts price and attribute filters', () => {
    expect(
      ecommerceExpectations.filters.parse({
        maxPrice: 1000,
        attributes: { color: 'black', size: 'M' },
      }),
    ).toEqual({ maxPrice: 1000, attributes: { color: 'black', size: 'M' } });
  });

  it('rejects unknown filter keys', () => {
    expect(ecommerceExpectations.filters.safeParse({ colour: 'black' }).success).toBe(false);
  });
});
