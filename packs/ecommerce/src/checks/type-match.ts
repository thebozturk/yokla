// type-matched-or-disclosed (design §10): with `productType`, every returned
// product is of a requested type, or of a type under one (by the profile's
// typeSeparator), or the answer says it couldn't find the type or offers the
// others instead. A product whose type yokla can't learn is not judged. A
// requested type that no catalog type matches is a broken case, not a pass.

import { findPhrases, type Check, type CheckFinding } from '@yokla/core';
import type { EcommerceData } from '../data.ts';
import { ecommerceExpectations } from '../schema.ts';
import { notApplicable, productsOf, withoutStockWording } from './common.ts';

export function typeMatched(data: EcommerceData): Check {
  const separator = data.config.typeSeparator;
  const within = (type: string, wanted: string): boolean =>
    type === wanted || (separator !== undefined && type.startsWith(`${wanted}${separator}`));
  const catalogTypes =
    data.catalog === undefined
      ? undefined
      : [...new Set([...data.catalog.values()].flatMap((row) => row.type ?? []))];
  const inCatalog = new Map<string, boolean>();
  const known = (wanted: string): boolean => {
    let found = inCatalog.get(wanted);
    if (found === undefined) {
      found = catalogTypes?.some((type) => within(type, wanted)) ?? true;
      inCatalog.set(wanted, found);
    }
    return found;
  };

  return {
    id: 'type-matched-or-disclosed',
    description:
      'Returned products are of the requested type, or the answer discloses that it shows other types.',
    run(context) {
      const parsed = ecommerceExpectations.productType.safeParse(
        context.turn.expect['productType'],
      );
      if (!parsed.success) return notApplicable('the turn expects no product type');
      const wanted = typeof parsed.data === 'string' ? [parsed.data] : parsed.data;
      const unknown = wanted.filter((type) => !known(type));
      if (unknown.length > 0) {
        throw new Error(
          `productType ${unknown.map((type) => `"${type}"`).join(', ')} matches no catalog type`,
        );
      }
      if (context.turn.clarifying) return notApplicable('the target asked a clarifying question');
      const { lang } = context;
      if (lang === undefined)
        return notApplicable(`no language pack for "${context.case.language}"`);
      const products = productsOf(context.turn, data) ?? [];
      if (products.length === 0) return notApplicable('no products returned');
      const typed = products.flatMap((product) =>
        product.type === undefined ? [] : [{ id: product.id, type: product.type }],
      );
      if (typed.length === 0) return notApplicable('the type of no returned product is known');

      const untyped = products.length - typed.length;
      const note = untyped === 0 ? '' : ` (type unknown for ${String(untyped)})`;
      const others = typed.filter((product) => !wanted.some((type) => within(product.type, type)));
      if (others.length === 0) {
        return {
          applicable: true,
          findings: [
            {
              dimension: 'filter-honesty',
              verdict: 'pass',
              severity: 'high',
              message: `the returned products are of the requested type${note}`,
            },
          ],
        };
      }

      const folded = withoutStockWording(lang.fold(context.turn.response.text), lang.language);
      const says =
        findPhrases(folded, [...lang.phrases.absence, ...lang.phrases.alternative]).length > 0;
      const count = `${String(others.length)} product(s) of other types`;
      const finding: CheckFinding = {
        dimension: 'filter-honesty',
        verdict: says ? 'pass' : 'fail',
        severity: 'high',
        message: says
          ? `shows ${count} and says so${note}`
          : `presents ${count} as ${wanted.join(' or ')}${note}`,
        evidence: {
          products: others.map((product) => product.id ?? null),
          types: [...new Set(others.map((product) => product.type))],
        },
      };
      return { applicable: true, findings: [finding] };
    },
  };
}
