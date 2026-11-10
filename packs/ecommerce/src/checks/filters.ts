// filter-honoured-or-disclosed (design §10): the returned products satisfy
// the filters the user asked for, or the answer discloses that it relaxed
// them. A disclosure is narrow: the answer says something wasn't found or is
// offered instead, and it names every price bound it relaxed. An unrelated
// "not found" sentence is not a disclosure.

import {
  findPhrases,
  type Check,
  type CheckFinding,
  type EvidenceItem,
  type LanguagePack,
} from '@yokla/core';
import { ecommerceExpectations } from '../schema.ts';
import type { EcommerceData } from '../data.ts';
import { notApplicable, PRODUCTS, productsOf, withoutStockWording } from './common.ts';

interface Violation {
  readonly filter: string;
  /** The price bound, which a disclosure must name. */
  readonly amount?: number;
}

function attributeOf(item: EvidenceItem, name: string): string | undefined {
  const value = item[name];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/**
 * Whether the answer names a relaxed filter. A price bound is a number, so it
 * can be found in any language. An attribute value can't: the data says
 * "black" while a Turkish answer says "siyah", so for attributes the
 * disclosure wording alone counts.
 */
function names(text: string, violation: Violation, lang: LanguagePack): boolean {
  const { amount } = violation;
  if (amount === undefined) return true;
  return lang.findMoney(text).some((m) => Math.abs(m.amount - amount) < 0.005);
}

export function filterHonoured(data: EcommerceData): Check {
  return {
    id: 'filter-honoured-or-disclosed',
    description:
      'Returned products satisfy the requested filters, or the answer discloses each relaxed filter.',
    run(context) {
      const parsed = ecommerceExpectations.filters.safeParse(context.turn.expect['filters']);
      if (!parsed.success) return notApplicable('the turn has no filters');
      const { lang } = context;
      if (lang === undefined)
        return notApplicable(`no language pack for "${context.case.language}"`);
      const items = context.turn.response.evidence[PRODUCTS] ?? [];
      const products = productsOf(context.turn, data) ?? [];
      if (products.length === 0) return notApplicable('no products returned');

      const filters = parsed.data;
      const violations = new Map<string, Violation>();
      const unchecked = new Set<string>();
      products.forEach((product, index) => {
        if (
          filters.maxPrice !== undefined &&
          product.price !== undefined &&
          product.price > filters.maxPrice
        ) {
          violations.set('maxPrice', { filter: 'maxPrice', amount: filters.maxPrice });
        }
        if (
          filters.minPrice !== undefined &&
          product.price !== undefined &&
          product.price < filters.minPrice
        ) {
          violations.set('minPrice', { filter: 'minPrice', amount: filters.minPrice });
        }
        for (const [name, wanted] of Object.entries(filters.attributes ?? {})) {
          const item = items[index];
          const actual = item === undefined ? undefined : attributeOf(item, name);
          if (actual === undefined) unchecked.add(name);
          else if (lang.fold(actual) !== lang.fold(wanted)) violations.set(name, { filter: name });
        }
      });

      const note = unchecked.size === 0 ? '' : ` (not checked: ${[...unchecked].join(', ')})`;
      if (violations.size === 0) {
        return {
          applicable: true,
          findings: [
            {
              dimension: 'filter-honesty',
              verdict: 'pass',
              severity: 'high',
              message: `the returned products satisfy the filters${note}`,
            },
          ],
        };
      }

      const text = context.turn.response.text;
      const folded = withoutStockWording(lang.fold(text), lang.language);
      const says =
        findPhrases(folded, [...lang.phrases.absence, ...lang.phrases.alternative]).length > 0;
      const unnamed = [...violations.values()]
        .filter((v) => !names(text, v, lang))
        .map((v) => v.filter);
      const disclosed = says && unnamed.length === 0;
      const finding: CheckFinding = {
        dimension: 'filter-honesty',
        verdict: disclosed ? 'pass' : 'fail',
        severity: 'high',
        message: disclosed
          ? `relaxed ${[...violations.keys()].join(', ')} and said so${note}`
          : says
            ? `relaxed ${[...violations.keys()].join(', ')} but didn't name ${unnamed.join(', ')}`
            : `returned products outside ${[...violations.keys()].join(', ')} without saying so${note}`,
        evidence: { violated: [...violations.keys()], unnamed },
      };
      return { applicable: true, findings: [finding] };
    },
  };
}
