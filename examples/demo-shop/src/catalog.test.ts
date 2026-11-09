import { describe, expect, it } from 'vitest';
import { loadShopData, parseCatalog, parseFaq } from './catalog.ts';
import { ABSENT_TYPES, PRODUCT_TYPES } from './vocabulary.ts';

const valid = {
  id: 'X-1',
  category_path: 'outdoor/camping/tent',
  name_tr: 'Çadır',
  name_en: 'Tent',
  price: 10,
  currency: 'TRY',
  stock: null,
};
const line = (row: object): string => JSON.stringify(row);

describe('parseCatalog', () => {
  it('parses a valid row', () => {
    expect(parseCatalog(line(valid))).toEqual([
      {
        id: 'X-1',
        categoryPath: 'outdoor/camping/tent',
        type: 'tent',
        name: { tr: 'Çadır', en: 'Tent' },
        price: 10,
        currency: 'TRY',
        stock: null,
      },
    ]);
  });

  it.each([
    [{ ...valid, id: 'X-2', price: -1 }, /catalog\.jsonl:2: "price"/u],
    [{ ...valid, id: 'X-2', stock: 1.5 }, /catalog\.jsonl:2: "stock"/u],
    [{ ...valid, id: 'X-2', color: 'purple' }, /catalog\.jsonl:2: "color" must be one of/u],
    [{ ...valid, id: 'X-1' }, /catalog\.jsonl:2: duplicate id X-1/u],
  ])('reports invalid rows with their line number (%#)', (row, message) => {
    expect(() => parseCatalog(`${line(valid)}\n${line(row)}`)).toThrow(message);
  });

  it('rejects a FAQ entry in an unsupported language', () => {
    expect(() =>
      parseFaq(line({ id: 'f', topic: 'returns', lang: 'de', question: 'q', answer: 'a' })),
    ).toThrow(/faq\.jsonl:1: "lang"/u);
  });
});

describe('the bundled data', () => {
  const { catalog, faq } = loadShopData();

  it('has products for every known type and none for the absent types', () => {
    for (const type of PRODUCT_TYPES)
      expect(
        catalog.some((p) => p.type === type.key),
        type.key,
      ).toBe(true);
    for (const type of ABSENT_TYPES)
      expect(
        catalog.some((p) => p.type === type.key),
        type.key,
      ).toBe(false);
    for (const type of ABSENT_TYPES) {
      expect(
        PRODUCT_TYPES.some((known) => known.key === type.substitute),
        type.substitute,
      ).toBe(true);
    }
  });

  it('only contains types the model understands', () => {
    const known = new Set(PRODUCT_TYPES.map((type) => type.key));
    expect(catalog.filter((p) => !known.has(p.type)).map((p) => p.id)).toEqual([]);
  });

  it('mixes known, zero and unknown stock', () => {
    expect(catalog.some((p) => p.stock === null)).toBe(true);
    expect(catalog.some((p) => p.stock === 0)).toBe(true);
    expect(catalog.some((p) => p.stock !== null && p.stock > 0)).toBe(true);
  });

  it('has a returns answer in both languages', () => {
    expect(
      faq
        .filter((e) => e.topic === 'returns')
        .map((e) => e.lang)
        .toSorted(),
    ).toEqual(['en', 'tr']);
  });
});
