import { describe, expect, it } from 'vitest';
import { ecommerceExpectations, ecommerceProfile, FACT_KINDS } from './schema.ts';

describe('ecommerce profile section', () => {
  it('defaults to never fabricating any fact kind', () => {
    expect(ecommerceProfile.parse({})).toEqual({
      neverFabricate: [...FACT_KINDS],
      policies: {},
      campaigns: [],
      restrictions: [],
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

const parseRule = (rule: unknown) => ecommerceProfile.safeParse({ restrictions: [rule] });

describe('restrictions (ADR-0082)', () => {
  it('needs what a rule covers and what it limits, and takes places by language', () => {
    expect(parseRule({ types: ['a'], minAge: 18, source: 's' }).success).toBe(true);
    expect(
      parseRule({
        products: ['P1'],
        notSoldIn: ['X', { tr: 'Almanya', en: 'Germany' }],
        source: 's',
      }).success,
    ).toBe(true);
    expect(parseRule({ minAge: 18, source: 's' }).error?.issues[0]?.message).toBe(
      'a restriction needs products or types',
    );
    expect(parseRule({ types: ['a'], source: 's' }).error?.issues[0]?.message).toBe(
      'a restriction needs minAge, notSoldIn or maxQuantity',
    );
    expect(parseRule({ types: ['a'], minAge: 18 }).success).toBe(false);
  });

  it('takes a quantity limit alone, and where the cart call holds its quantity (ADR-0086)', () => {
    expect(parseRule({ types: ['a'], maxQuantity: 2, source: 's' }).success).toBe(true);
    expect(parseRule({ types: ['a'], maxQuantity: 0, source: 's' }).success).toBe(false);
    expect(
      ecommerceProfile.safeParse({ cartQuantity: { tool: 'add_to_cart', path: 'quantity' } })
        .success,
    ).toBe(true);
    expect(ecommerceProfile.safeParse({ cartQuantity: { tool: 'add_to_cart' } }).success).toBe(
      false,
    );
  });
});
