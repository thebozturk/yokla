import { CATEGORY, CORE_TAXONOMY, FRAMEWORKS, mergeTaxonomies } from '@yokla/core';
import { STUB_ATTACKS } from '@yokla/core/testing';
import { describe, expect, it } from 'vitest';
import { ecommerceAttacks } from './attacks.ts';
import { concession } from './checks/concession.ts';
import { data } from './checks/fixtures.ts';
import { policyClaim } from './checks/policy-claim.ts';
import { priceGrounded } from './checks/price-grounded.ts';
import { stockClaim } from './checks/stock-claim.ts';
import type { CatalogRow } from './data.ts';
import { ecommercePack } from './pack.ts';
import { ecommerceProfile } from './schema.ts';
import { ecommerceTaxonomy } from './taxonomy.ts';

const LISTED = new Set(
  FRAMEWORKS.flatMap((framework) =>
    framework.categories.map((category) => `${framework.id}:${category.code}`),
  ),
);

const row = (id: string, type: string, price: number): CatalogRow => ({
  id,
  type,
  price,
  currency: 'TRY',
  stock: 3,
  inStock: undefined,
  names: { en: `${id} name`, tr: `${id} adı` },
});

/** Every attack the pack writes, from a profile that gives each kind what it needs. */
function everyAttack() {
  const rows = [
    row('TNT-1', 'outdoor/camping/tent', 2499.9),
    row('BAG-1', 'outdoor/camping/bag', 900),
    row('JKT-1', 'outdoor/clothing/jacket', 400),
  ];
  return ecommerceAttacks(
    data({
      config: ecommerceProfile.parse({
        typeSeparator: '/',
        restrictions: [
          { types: ['outdoor/camping'], minAge: 18, maxQuantity: 2, source: 'policy page' },
        ],
        cartEvidence: 'cart',
        cartQuantity: { tool: 'add_to_cart', path: 'quantity' },
      }),
      catalog: new Map(rows.map((r) => [r.id, r])),
      policies: new Map([
        [
          'returns',
          { topic: 'returns', answers: { tr: '14 gün içinde iade.', en: 'Within 14 days.' } },
        ],
      ]),
    }),
  )({
    languages: ['tr', 'en'],
    perKind: 1,
    competitors: ['Rivalmart'],
    identities: [
      ['alice', { orders: ['DS-1001'] }],
      ['bob', { orders: ['DS-1002'] }],
    ],
    actionTools: ['cancel_order'],
    phrasings: new Map([
      ['tr', STUB_ATTACKS],
      ['en', STUB_ATTACKS],
    ]),
    proxied: true,
  });
}

/** The pack's data, for the checks that bind it. */
const fixture = data({ config: ecommerceProfile.parse({ typeSeparator: '/' }) });

describe("the e-commerce pack's mapping (ADR-0089)", () => {
  it("is the pack's", () => {
    expect(ecommercePack.taxonomy).toBe(ecommerceTaxonomy);
  });

  it('maps every kind the pack writes, and only those', () => {
    const { cases } = everyAttack();
    expect([...new Set(cases.map((c) => c.kind))].toSorted()).toEqual(
      Object.keys(ecommerceTaxonomy.kinds).toSorted(),
    );
  });

  it("maps only the pack's checks", () => {
    expect(Object.keys(ecommerceTaxonomy.checks).toSorted()).toEqual(
      [concession(), policyClaim(fixture), priceGrounded(fixture), stockClaim(fixture)]
        .map((check) => check.id)
        .toSorted(),
    );
  });

  it('names only categories the frameworks list, every kind a verification test', () => {
    for (const [kind, mapping] of Object.entries(ecommerceTaxonomy.kinds)) {
      for (const category of mapping.categories) expect(LISTED.has(category), category).toBe(true);
      expect(mapping.categories, kind).toContain(CATEGORY.verification);
    }
    for (const categories of Object.values(ecommerceTaxonomy.checks)) {
      for (const category of categories) expect(LISTED.has(category), category).toBe(true);
    }
  });

  it("names, with core's, every category the frameworks list", () => {
    const merged = mergeTaxonomies(CORE_TAXONOMY, ecommerceTaxonomy);
    const named = new Set([
      ...Object.values(merged.kinds).flatMap((mapping) => mapping.categories),
      ...Object.values(merged.checks).flat(),
    ]);
    expect([...LISTED].filter((category) => !named.has(category))).toEqual([]);
  });
});
