import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../extract/response.ts';
import { matchRows } from './match.ts';

const catalog = {
  id: 'id',
  rows: [
    {
      id: 'TNT-1',
      type: 'outdoor/tent',
      name_tr: 'Kubbe Çadır',
      name_en: 'Dome Tent',
      price: 2499.9,
      currency: 'TRY',
      stock: 12,
      color: 'green',
    },
    {
      id: 'TNT-2',
      type: 'outdoor/tent',
      name_tr: 'Hafif Çadır',
      name_en: 'Light Tent',
      price: 4250,
      currency: 'TRY',
      stock: null,
      color: 'grey',
    },
    {
      id: 'JKT-1',
      type: 'outdoor/jacket',
      name_tr: 'Mont',
      name_en: 'Jacket',
      price: 999,
      currency: 'TRY',
      stock: 0,
      color: 'black',
    },
  ],
};

const product = (id: string, name: string, price: number, stock: number | null, color: string) => ({
  id,
  name,
  category: 'outdoor/tent',
  price: { amount: price, currency: 'TRY' },
  stockQuantity: stock,
  attributes: { color },
});

const answer: JsonValue = {
  data: {
    answer: 'Çadır seçeneklerimiz',
    products: [
      product('TNT-1', 'Kubbe Çadır', 2499.9, 12, 'green'),
      product('TNT-2', 'Hafif Çadır', 4250, null, 'grey'),
    ],
    metadata: { route: 'product-search' },
  },
};

describe('matchRows (ADR-0047)', () => {
  it('finds the products by their ids, and each field by its values', () => {
    expect(matchRows(answer, catalog)).toEqual([
      {
        items: '$.data.products[*]',
        fields: {
          id: 'id',
          type: 'category',
          name_tr: 'name',
          price: 'price.amount',
          currency: 'price.currency',
          stock: 'stockQuantity',
          color: 'attributes.color',
        },
        matched: 2,
        ids: ['TNT-1', 'TNT-2'],
      },
    ]);
  });

  it('leaves out a field the answer holds nowhere', () => {
    const [found] = matchRows(answer, catalog);
    expect(found?.fields).not.toHaveProperty('name_en');
  });

  it('finds nothing in an array where an item holds no known id', () => {
    const mixed = {
      products: [product('TNT-1', 'Kubbe Çadır', 2499.9, 12, 'green'), { id: 'X-9' }],
    };
    expect(matchRows(mixed, catalog)).toEqual([]);
    expect(matchRows({ products: [] }, catalog)).toEqual([]);
    expect(matchRows({ tags: ['TNT-1'] }, catalog)).toEqual([]);
    // An array of anything but objects alone names no collection.
    expect(matchRows({ mixed: [{ id: 'TNT-1' }, 'TNT-2'] }, catalog)).toEqual([]);
  });

  it('finds arrays at any depth, and keys a JSONPath must quote', () => {
    // A key with a quote is one the profile's JSONPath can't name: left out.
    expect(matchRows({ "shop's picks": [{ sku: 'JKT-1' }] }, catalog)).toEqual([]);
    const nested = { 'the cart': [{ sku: 'JKT-1', title: 'Mont' }] };
    expect(matchRows(nested, catalog)).toEqual([
      {
        items: "$['the cart'][*]",
        fields: { id: 'sku', name_tr: 'title' },
        matched: 1,
        ids: ['JKT-1'],
      },
    ]);
  });

  it('gives no path to a field matched only by null, or when two paths match it', () => {
    const rows = {
      id: 'id',
      rows: [
        { id: 'A', note: null, size: 'M' },
        { id: 'B', note: null, size: 'L' },
      ],
    };
    const items = {
      list: [
        { id: 'A', note: null, size: 'M', fit: 'M' },
        { id: 'B', note: null, size: 'L', fit: 'L' },
      ],
    };
    expect(matchRows(items, rows)).toEqual([
      { items: '$.list[*]', fields: { id: 'id' }, matched: 2, ids: ['A', 'B'] },
    ]);
  });

  it('gives no path to two fields with the same value in every item', () => {
    const rows = { id: 'id', rows: [{ id: 'A', name_tr: 'Baton', name_en: 'Baton', price: 5 }] };
    const items = { list: [{ id: 'A', name: 'Baton', price: 5 }] };
    expect(matchRows(items, rows)).toEqual([
      { items: '$.list[*]', fields: { id: 'id', price: 'price' }, matched: 1, ids: ['A'] },
    ]);
  });

  it('needs one path for the id: two paths with known ids name no collection', () => {
    const rows = { id: 'id', rows: [{ id: 'A' }, { id: 'B' }] };
    expect(matchRows({ list: [{ id: 'A', other: 'B' }] }, rows)).toEqual([]);
  });

  it('matches ids given as numbers', () => {
    const rows = { id: 'id', rows: [{ id: 7, price: 10 }] };
    expect(matchRows({ items: [{ productId: 7, cost: 10 }] }, rows)).toEqual([
      { items: '$.items[*]', fields: { id: 'productId', price: 'cost' }, matched: 1, ids: [7] },
    ]);
  });
});
