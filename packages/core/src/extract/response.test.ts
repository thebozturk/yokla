import { describe, expect, it } from 'vitest';
import type { ProfileTarget } from '../schema/profile.ts';
import { extractField, extractResponse } from './response.ts';

type Mapping = ProfileTarget['response'];

describe('extractField', () => {
  const item = {
    price: { salePrice: null, listPrice: '1299.90' },
    stock: null,
    flag: 'true',
    code: 42,
  };

  it('takes the first present, non-null path and converts it', () => {
    const issues: string[] = [];
    expect(
      extractField(
        item,
        { from: ['price.salePrice', 'price.listPrice'], as: 'number' },
        issues,
        'x',
      ),
    ).toBe(1299.9);
    expect(issues).toEqual([]);
  });

  it('keeps null as unknown', () => {
    expect(extractField(item, 'stock', [], 'x')).toBeNull();
    expect(extractField(item, 'missing.path', [], 'x')).toBeNull();
  });

  it.each([
    [{ from: 'flag', as: 'boolean' } as const, true],
    [{ from: 'code', as: 'string' } as const, '42'],
    [{ from: 'code', as: 'number' } as const, 42],
  ])('converts %o', (spec, expected) => {
    expect(extractField(item, spec, [], 'x')).toBe(expected);
  });

  it('reports a value that cannot be converted, instead of guessing', () => {
    const issues: string[] = [];
    expect(
      extractField({ price: '1.299,90' }, { from: 'price', as: 'number' }, issues, 'p'),
    ).toBeNull();
    expect(issues).toEqual(['p: value at "price" can\'t be read as number: "1.299,90"']);
  });
});

describe('extractResponse', () => {
  it('reads a response shaped like the demo-shop', () => {
    const mapping: Mapping = {
      text: '$.data.answer',
      route: '$.data.metadata.route',
      evidence: {
        products: {
          items: '$.data.products[*]',
          fields: { id: 'id', price: 'price.amount', stock: 'stockQuantity' },
        },
      },
    };
    const body = {
      data: {
        answer: 'Here are our tents:',
        metadata: { route: 'product-search' },
        products: [
          { id: 'T-1', price: { amount: 899.5 }, stockQuantity: 0 },
          { id: 'T-2', price: { amount: 4250 }, stockQuantity: null },
        ],
      },
    };
    expect(extractResponse(body, mapping)).toEqual({
      text: 'Here are our tents:',
      route: 'product-search',
      id: undefined,
      evidence: {
        products: [
          { id: 'T-1', price: 899.5, stock: 0 },
          { id: 'T-2', price: 4250, stock: null },
        ],
      },
      issues: [],
    });
  });

  it('reads a differently shaped response with fallbacks, decimal strings and a target id', () => {
    const mapping: Mapping = {
      text: '$.message',
      route: '$.metadata.path',
      id: '$.requestId',
      evidence: {
        products: {
          items: '$.products[*]',
          fields: {
            id: 'externalId',
            price: { from: ['price.salePrice', 'price.listPrice'], as: 'number' },
          },
        },
      },
    };
    const body = {
      message: 'Şu seçenekler var:',
      requestId: 'req-1',
      metadata: { path: 'retrieval' },
      products: [
        { externalId: 'P1', price: { salePrice: '999.90', listPrice: '1299.90' } },
        { externalId: 'P2', price: { salePrice: null, listPrice: '450.00' } },
        { externalId: 'P3', price: null },
      ],
    };
    const result = extractResponse(body, mapping);
    expect(result.evidence['products']).toEqual([
      { id: 'P1', price: 999.9 },
      { id: 'P2', price: 450 },
      { id: 'P3', price: null },
    ]);
    expect([result.text, result.route, result.id, result.issues]).toEqual([
      'Şu seçenekler var:',
      'retrieval',
      'req-1',
      [],
    ]);
  });

  it('reports what the mapping could not find', () => {
    const mapping: Mapping = {
      text: '$.answer',
      route: '$.route',
      id: '$.id',
      evidence: { products: { items: '$.products', fields: { id: 'id' } } },
    };
    const result = extractResponse({ answer: 42, products: [{ id: 'a' }] }, mapping);
    expect(result.text).toBeUndefined();
    expect(result.issues).toEqual([
      'answer text not found at $.answer',
      'route not found at $.route',
      'target id not found at $.id',
      'evidence "products": $.products selects an array; did you mean $.products[*]?',
    ]);
  });

  it('returns empty evidence when there are no items', () => {
    const mapping: Mapping = {
      text: '$.t',
      evidence: { products: { items: '$.p[*]', fields: { id: 'id' } } },
    };
    expect(extractResponse({ t: 'no results', p: [] }, mapping).evidence).toEqual({ products: [] });
  });
});
