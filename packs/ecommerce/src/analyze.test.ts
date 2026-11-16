import type { DataEntry, DataFile, DataRow } from '@yokla/core';
import { stubLanguagePack } from '@yokla/core/testing';
import { describe, expect, it } from 'vitest';
import { ecommerceAnalyzer } from './analyze.ts';

const languages = [stubLanguagePack('tr'), stubLanguagePack('en')];

const tent = (id: string, price: number, stock: number | null, extra: DataRow = {}): DataRow => ({
  id,
  category_path: 'outdoor/camping/tent',
  name_tr: `Çadır ${id}`,
  name_en: `Tent ${id}`,
  price,
  currency: 'TRY',
  stock,
  color: 'green',
  ...extra,
});

const catalog: DataFile = {
  path: './data/catalog.jsonl',
  rows: [
    tent('TNT-1', 2499.9, 12),
    tent('TNT-2', 4250, null),
    {
      ...tent('JKT-1', 999, 0),
      category_path: 'outdoor/clothing/jacket',
      size: 'M',
      gender: 'women',
    },
  ],
};

const faq: DataFile = {
  path: './data/faq.jsonl',
  rows: [
    { id: 'r-tr', topic: 'returns', lang: 'tr', question: 'İade?', answer: '14 gün.' },
    { id: 'r-en', topic: 'returns', lang: 'en', question: 'Returns?', answer: '14 days.' },
  ],
};

const analyze = (files: DataFile[], given: string[] = []) =>
  ecommerceAnalyzer.analyze(files, { languages, given });

const byPointer = (entries: readonly DataEntry[]) =>
  Object.fromEntries(entries.map((entry) => [entry.pointer, entry.value]));

/** The catalog field proposed when a column goes by `name`. */
function fieldFor(column: string, name: string): unknown {
  const base: DataRow = { id: 'A', price: 10, currency: 'TRY', stock: 1, type: 't', name: 'n' };
  const value = base[column] ?? null;
  const { [column]: _dropped, ...rest } = base;
  const rows = [
    { ...rest, [name]: value },
    { ...rest, id: 'B', [name]: column === 'id' ? 'B' : value },
  ];
  return byPointer(analyze([{ path: './c.jsonl', rows }], ['en']).entries)[
    `/ecommerce/catalog/fields/${column}`
  ];
}

/** Two tents, the second changed. */
function twoTents(change: DataRow): DataRow[] {
  return [tent('A', 10, 1), tent('B', 20, 2, change)];
}

const typed = (types: string[]) =>
  byPointer(
    analyze([
      {
        path: './c.jsonl',
        rows: types.map((type, index) => tent(`P${String(index)}`, 10, 1, { category_path: type })),
      },
    ]).entries,
  )['/ecommerce/typeSeparator'];

describe('the e-commerce data analyzer (ADR-0047)', () => {
  it('proposes the catalog, its separator, its languages and the policies', () => {
    const { entries } = analyze([catalog, faq]);
    expect(byPointer(entries)).toEqual({
      '/languages': ['tr', 'en'],
      '/domain': 'ecommerce',
      '/ecommerce/catalog/kind': 'file',
      '/ecommerce/catalog/path': './data/catalog.jsonl',
      '/ecommerce/catalog/fields/id': 'id',
      '/ecommerce/catalog/fields/type': 'category_path',
      '/ecommerce/catalog/fields/price': 'price',
      '/ecommerce/catalog/fields/currency': 'currency',
      '/ecommerce/catalog/fields/stock': 'stock',
      '/ecommerce/catalog/fields/name': { tr: 'name_tr', en: 'name_en' },
      '/ecommerce/typeSeparator': '/',
      '/ecommerce/policies/returns': { source: 'faq', path: './data/faq.jsonl' },
      '/ecommerce/policies/shipping': { source: 'none' },
      '/ecommerce/policies/warranty': { source: 'none' },
    });
  });

  it('says what each entry rests on', () => {
    const evidence = Object.fromEntries(
      analyze([catalog, faq]).entries.map((entry) => [entry.pointer, entry.evidence]),
    );
    expect(evidence['/ecommerce/catalog/fields/price']).toBe(
      './data/catalog.jsonl: price in 3 of 3 rows',
    );
    expect(evidence['/ecommerce/catalog/fields/name']).toBe(
      './data/catalog.jsonl: name_tr and name_en in 3 of 3 rows',
    );
    expect(evidence['/ecommerce/typeSeparator']).toBe(
      './data/catalog.jsonl: every category_path holds "/"',
    );
    expect(evidence['/ecommerce/policies/returns']).toBe(
      './data/faq.jsonl: 2 row(s) with topic returns',
    );
    expect(evidence['/ecommerce/policies/shipping']).toMatch(/^no data file speaks of it/u);
  });

  it('proposes nothing without a catalog', () => {
    expect(analyze([faq])).toEqual({ entries: [] });
    expect(analyze([])).toEqual({ entries: [] });
  });

  it('leaves the languages to the person who gave them, and probes in the first', () => {
    const { entries, probed } = analyze([catalog], ['en']);
    expect(entries.map((entry) => entry.pointer)).not.toContain('/languages');
    expect(probed?.probe).toEqual({ message: 'Do you have any tent?', collection: 'products' });
  });

  it('asks for the first named product type, then to put the first product shown in the cart', () => {
    const { probed } = analyze([catalog]);
    expect(probed?.probe).toEqual({ message: 'tent var mı?', collection: 'products' });
    expect(probed?.next([tent('TNT-2', 4250, null)])).toEqual({
      message: 'Çadır TNT-2 ürününü sepete ekler misin?',
      collection: 'cart',
    });
    expect(probed?.next([])).toBeUndefined();
    expect(probed?.id).toBe('id');
    expect(probed?.rows).toBe(catalog.rows);
    expect(probed?.evidenceFields).toEqual({
      id: 'id',
      price: 'price',
      currency: 'currency',
      stock: 'stock',
      category_path: 'category',
      name_tr: 'name',
      name_en: 'name',
      color: 'color',
      size: 'size',
      gender: 'gender',
    });
  });

  it.each([
    [
      'id',
      ['id', 'SKU', 'product_id', 'productId', 'item_id', 'urun_id', 'urun_kodu', 'stok_kodu'],
    ],
    ['price', ['price', 'Fiyat', 'unit_price', 'sale_price', 'satis_fiyati']],
    ['currency', ['currency', 'para_birimi', 'doviz']],
    ['stock', ['stock', 'stok', 'quantity', 'qty', 'stock_quantity', 'stok_adedi']],
    ['type', ['category_path', 'category', 'product_type', 'type', 'kategori', 'urun_tipi']],
    ['name', ['name', 'title', 'product_name', 'urun_adi', 'baslik']],
  ])('finds the %s column by each of its names', (column, names) => {
    for (const name of names) {
      expect(fieldFor(column, name), `${column} as ${name}`).toBe(name);
    }
  });

  it.each([
    ['id', ['ids', 'identifier', 'idx', 'product']],
    ['price', ['prices', 'price_text', 'cost', 'fiyatlar']],
    ['currency', ['currency_name', 'curr', 'para']],
    ['stock', ['stocks', 'in_stock', 'stoklar']],
    ['type', ['types', 'categories', 'tip']],
    ['name', ['names', 'label', 'adi']],
  ])('finds no %s column by a near name', (column, names) => {
    for (const name of names) {
      expect(fieldFor(column, name), `${column} as ${name}`).toBeUndefined();
    }
  });

  it('takes a column only when every row holds a value of its kind', () => {
    const fields = (change: DataRow) =>
      byPointer(analyze([{ path: './c.jsonl', rows: twoTents(change) }], ['en']).entries);
    expect(fields({ currency: 'try' })['/ecommerce/catalog/fields/currency']).toBeUndefined();
    expect(fields({ stock: 1.5 })['/ecommerce/catalog/fields/stock']).toBeUndefined();
    expect(fields({ stock: -1 })['/ecommerce/catalog/fields/stock']).toBeUndefined();
    expect(fields({ category_path: '' })['/ecommerce/catalog/fields/type']).toBeUndefined();
    // No price in every row, or no unique id: no catalog at all.
    expect(analyze([{ path: './c.jsonl', rows: twoTents({ price: 0 }) }]).entries).toEqual([]);
    expect(analyze([{ path: './c.jsonl', rows: twoTents({ price: '20' }) }]).entries).toEqual([]);
    expect(analyze([{ path: './c.jsonl', rows: twoTents({ id: 'A' }) }]).entries).toEqual([]);
  });

  it('reads catalogs and FAQs from JSON Lines only, as the pack loads them', () => {
    expect(analyze([{ ...catalog, path: './data/catalog.json' }]).entries).toEqual([]);
    const policies = byPointer(analyze([catalog, { ...faq, path: './data/faq.csv' }]).entries);
    expect(policies['/ecommerce/policies/returns']).toEqual({ source: 'none' });
  });

  it('needs every FAQ row to carry a topic and an answer', () => {
    const rows = faq.rows.map(({ answer: _answer, ...row }) => row);
    const policies = byPointer(analyze([catalog, { ...faq, rows }]).entries);
    expect(policies['/ecommerce/policies/returns']).toEqual({ source: 'none' });
  });

  it('proposes a separator only when every type holds it', () => {
    expect(typed(['a/b', 'a/c'])).toBe('/');
    expect(typed(['a > b', 'a > c'])).toBe('>');
    expect(typed(['a/b', 'c'])).toBeUndefined();
  });

  it('takes the largest catalog, and names only languages with a loaded pack', () => {
    const small: DataFile = { path: './small.jsonl', rows: [tent('S', 1, 1, { name_de: 'Zelt' })] };
    const big: DataFile = {
      path: './big.jsonl',
      rows: [1, 2].map((n) => tent(`B${String(n)}`, 5, 1, { name_de: 'Zelt' })),
    };
    const proposed = byPointer(analyze([small, big]).entries);
    expect(proposed['/ecommerce/catalog/path']).toBe('./big.jsonl');
    expect(proposed['/ecommerce/catalog/fields/name']).toEqual({ tr: 'name_tr', en: 'name_en' });
  });
});
