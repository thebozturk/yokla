import { describe, expect, it } from 'vitest';
import { data } from './checks/fixtures.ts';
import type { CatalogRow } from './data.ts';
import { catalogUnmetFacts } from './facts.ts';
import { ecommerceProfile } from './schema.ts';

const row = (id: string, type: string | undefined): CatalogRow => ({
  id,
  type,
  price: 100,
  currency: 'TRY',
  stock: 1,
  inStock: undefined,
});

const catalog = (rows: readonly CatalogRow[], separator: string | undefined = '/') =>
  data({
    config: ecommerceProfile.parse(separator === undefined ? {} : { typeSeparator: separator }),
    catalog: new Map(rows.map((entry) => [entry.id, entry])),
  });

const SHOP = [
  row('TNT-1', 'outdoor/camping/tent'),
  row('SLB-1', 'outdoor/camping/sleeping-bag/junior'),
  row('HMS-1', 'outdoor/camping/hammock-stand'),
  row('WB-1', 'outdoor/hydration/water-bottle'),
];

const unmet = (expectation: Record<string, unknown>, rows = SHOP, separator?: string) =>
  catalogUnmetFacts(catalog(rows, ...(separator === undefined ? [] : [separator])))?.(expectation);

describe('catalog facts (ADR-0053, ADR-0054)', () => {
  it('holds an absent type the catalog lacks, and names one it now holds', () => {
    expect(unmet({ absentType: 'hammock' })).toEqual([]);
    expect(
      unmet({ absentType: 'hammock' }, [...SHOP, row('HMK-1', 'outdoor/camping/hammock')]),
    ).toEqual(['the catalog now holds hammock: 1 product, such as HMK-1']);
  });

  it.each([
    ['equal', 'hammock', 'hammock'],
    ['under it', 'hammock', 'hammock/double'],
    ['a level at the end', 'hammock', 'outdoor/camping/hammock'],
    ['a level in the middle', 'camping', 'outdoor/camping/tent'],
    ['a whole path', 'outdoor/camping/tent', 'outdoor/camping/tent/dome'],
  ])('finds an absent type %s', (_, absent, type) => {
    expect(unmet({ absentType: absent }, [row('X-1', type)])).toHaveLength(1);
  });

  it('counts a level, never a part of one, and only an equal type without a separator', () => {
    // hammock-stand is another product.
    expect(unmet({ absentType: 'hammock' })).toEqual([]);
    expect(unmet({ absentType: 'camp' })).toEqual([]);
    const loose = catalogUnmetFacts(
      data({ catalog: new Map([['H', row('H', 'outdoor/camping/hammock')]]) }),
    );
    expect(loose?.({ absentType: 'hammock' })).toEqual([]);
    expect(loose?.({ absentType: 'outdoor/camping/hammock' })).toHaveLength(1);
  });

  it('counts every product that holds it, and names the first', () => {
    expect(unmet({ absentType: 'camping' })).toEqual([
      'the catalog now holds camping: 3 products, such as TNT-1',
    ]);
  });

  it('holds a product type the catalog has, or has under it, and names one it lost', () => {
    expect(unmet({ productType: 'outdoor/camping/tent' })).toEqual([]);
    expect(unmet({ productType: 'outdoor/camping/sleeping-bag' })).toEqual([]);
    expect(
      unmet({ productType: ['outdoor/kids/jacket', 'outdoor/hydration/water-bottle'] }),
    ).toEqual([]);
    expect(unmet({ productType: 'outdoor/hydration/water-bottle' }, SHOP.slice(0, 3))).toEqual([
      'the catalog holds no outdoor/hydration/water-bottle',
    ]);
    expect(unmet({ productType: ['outdoor/kids/jacket', 'outdoor/kids/boot'] })).toEqual([
      'the catalog holds no outdoor/kids/jacket or outdoor/kids/boot',
    ]);
    // Under a type means past its separator: sleeping-bag is not under sleeping.
    expect(unmet({ productType: 'outdoor/camping/sleeping' })).toEqual([
      'the catalog holds no outdoor/camping/sleeping',
    ]);
    // A type's level is not a product type: it names a catalog type (ADR-0054).
    expect(unmet({ productType: 'tent' })).toEqual(['the catalog holds no tent']);
  });

  it('states no fact for filters, answerable or a policy topic', () => {
    expect(
      unmet({
        filters: { maxPrice: 1, attributes: { color: 'pink' } },
        answerable: true,
        policyTopic: 'returns',
      }),
    ).toEqual([]);
  });

  it('knows nothing without a catalog, or without types in it', () => {
    expect(catalogUnmetFacts(data())).toBeUndefined();
    expect(catalogUnmetFacts(catalog([row('X-1', undefined)]))).toBeUndefined();
  });
});
