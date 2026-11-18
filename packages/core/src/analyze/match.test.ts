import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../extract/response.ts';
import { mutate } from '../testing.ts';
import { matchRows, type KnownRows } from './match.ts';

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

const priced = {
  id: 'id',
  rows: [
    { id: 'A', price: 1999.9 },
    { id: 'B', price: 450 },
    { id: 'C', price: 75.5 },
  ],
};

/** An item whose price is a decimal string: the sale price, else the list price. */
const card = (id: string, sale: string | null, list: string) => ({
  id,
  price: { salePrice: sale, listPrice: list, currency: 'TRY' },
});

/** The fields matchRows found in the one collection of a document. */
function fieldsOf(document: JsonValue, known: KnownRows = priced) {
  const found = matchRows(document, known);
  expect(found).toHaveLength(1);
  return found[0]?.fields;
}

describe('matchRows reads a value as the profile would (ADR-0067)', () => {
  const discounted = {
    products: [card('A', '1999.90', '2499.90'), card('B', '450.00', '500.00')],
  };
  const withFallback = {
    products: [
      card('A', '1999.90', '2499.90'),
      card('B', null, '450'),
      card('C', '75.50', '99.00'),
    ],
  };

  it('reads a decimal string as a number, and says so', () => {
    expect(fieldsOf(discounted)).toEqual({
      id: 'id',
      price: { from: 'price.salePrice', as: 'number' },
    });
  });

  it("doesn't read a string that isn't a decimal number", () => {
    const comma = mutate(discounted, (document) => ({
      products: [card('A', '1.999,90', '2499.90'), ...document.products.slice(1)],
    }));
    expect(fieldsOf(comma)).toEqual({ id: 'id' });
  });

  it("doesn't read as a number a path that holds no string", () => {
    // The price is absent from the second item, whose row has none: read
    // back, it would fit, but nothing in it needs reading as a number.
    const known = {
      id: 'id',
      rows: [
        { id: 'A', price: 10 },
        { id: 'B', price: null },
      ],
    };
    const items: JsonValue = { list: [{ id: 'A', cost: 10 }, { id: 'B' }] };
    expect(fieldsOf(items, known)).toEqual({ id: 'id' });
    const asText = mutate(items, () => ({ list: [{ id: 'A', cost: '10' }, { id: 'B' }] }));
    expect(fieldsOf(asText, known)).toEqual({ id: 'id', price: { from: 'cost', as: 'number' } });
  });

  it("doesn't take a value that can't be read as a number for a row's null", () => {
    const known = {
      id: 'id',
      rows: [
        { id: 'A', price: 10 },
        { id: 'B', price: null },
      ],
    };
    const items: JsonValue = {
      list: [
        { id: 'A', cost: '10' },
        { id: 'B', cost: 'n/a' },
      ],
    };
    expect(fieldsOf(items, known)).toEqual({ id: 'id' });
    const readable = mutate(items, () => ({
      list: [
        { id: 'A', cost: '10' },
        { id: 'B', cost: null },
      ],
    }));
    expect(fieldsOf(readable, known)).toEqual({ id: 'id', price: { from: 'cost', as: 'number' } });
  });

  it('proposes no fallback whose second path holds nothing where the first is absent', () => {
    // Where the price is absent the row has none: a path null in every item
    // "falls back" to nothing, and is no fallback.
    const known = {
      id: 'id',
      rows: [
        { id: 'A', price: 10 },
        { id: 'B', price: null },
      ],
    };
    const items: JsonValue = {
      list: [
        { id: 'A', cost: 10, note: null },
        { id: 'B', note: null },
      ],
    };
    expect(fieldsOf(items, known)).toEqual({ id: 'id' });
  });

  it('keeps a value equal as it is a plain path', () => {
    const numbers = {
      list: [
        { id: 'A', cost: 1999.9 },
        { id: 'B', cost: 450 },
      ],
    };
    expect(fieldsOf(numbers)).toEqual({ id: 'id', price: 'cost' });
  });

  it('proposes a fallback when an item shown has its first path null', () => {
    expect(fieldsOf(withFallback)).toEqual({
      id: 'id',
      price: { from: ['price.salePrice', 'price.listPrice'], as: 'number' },
    });
  });

  it('proposes a fallback of numbers without as, and one whose first path is absent', () => {
    // The first item lacks the first path: the paths of every item are tried.
    const numbers = {
      list: [
        { id: 'B', list: 450 },
        { id: 'A', sale: 1999.9, list: 2499.9 },
        { id: 'C', sale: null, list: 75.5 },
      ],
    };
    expect(fieldsOf(numbers)).toEqual({ id: 'id', price: { from: ['sale', 'list'] } });
    // Only ever missing, never null, the first path still falls back.
    const missing = mutate(numbers, (document) => ({
      list: document.list.map((item) => (item.id === 'C' ? { id: 'C', list: 75.5 } : item)),
    }));
    expect(fieldsOf(missing)).toEqual({ id: 'id', price: { from: ['sale', 'list'] } });
  });

  it('proposes no fallback when no item shown has its first path null', () => {
    const allOnSale = mutate(withFallback, (document) => ({
      products: document.products.map((item) =>
        item.id === 'B' ? card('B', '450.00', '500.00') : item,
      ),
    }));
    // Read as a number, the sale price alone fits.
    expect(fieldsOf(allOnSale)).toEqual({
      id: 'id',
      price: { from: 'price.salePrice', as: 'number' },
    });
  });

  it('reads every fallback back: a wrong value in any item gives none', () => {
    const wrong = mutate(withFallback, (document) => ({
      products: document.products.map((item) =>
        item.id === 'C' ? card('C', '74.50', '99.00') : item,
      ),
    }));
    expect(fieldsOf(wrong)).toEqual({ id: 'id' });
    const wrongList = mutate(withFallback, (document) => ({
      products: document.products.map((item) => (item.id === 'B' ? card('B', null, '451') : item)),
    }));
    expect(fieldsOf(wrongList)).toEqual({ id: 'id' });
  });

  it('gives no path when two paths read as a number fit', () => {
    const twice = {
      list: [
        { id: 'A', cost: '1999.90', shown: '1999.9' },
        { id: 'B', cost: '450', shown: '450.0' },
      ],
    };
    expect(fieldsOf(twice)).toEqual({ id: 'id' });
  });

  it('gives no path when two fallbacks fit', () => {
    const twice = {
      list: [
        { id: 'A', sale: '1999.90', list: '2499.90', was: '2999' },
        { id: 'B', sale: null, list: '450', was: '450' },
      ],
    };
    expect(fieldsOf(twice)).toEqual({ id: 'id' });
    const once = mutate(twice, (document) => ({
      list: document.list.map((item) => (item.id === 'B' ? { ...item, was: '600' } : item)),
    }));
    expect(fieldsOf(once)).toEqual({
      id: 'id',
      price: { from: ['sale', 'list'], as: 'number' },
    });
  });

  it("doesn't fall back from a rule with two answers to the next", () => {
    // Two plain paths fit; a third that fits only read as a number isn't taken.
    const items = {
      list: [
        { id: 'A', cost: 1999.9, shown: 1999.9, text: '1999.90' },
        { id: 'B', cost: 450, shown: 450, text: '450' },
      ],
    };
    expect(fieldsOf(items)).toEqual({ id: 'id' });
  });
});
