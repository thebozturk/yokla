// stock-claim (design §10): no availability claim when stock is unknown, and
// claims must match known stock. A claim is tied to the product named in the
// same line or sentence; a claim in a sentence that names no product applies to
// every returned product.
//
// Stock comes from the response or, joined by id, from the catalog snapshot.
// null means the target doesn't know the stock: any claim then is fabricated.
// A product whose stock yokla can't learn at all (not in the response, not in
// the catalog) is skipped: that is a gap in yokla's view, not the target's.

import { findPhrases, type Check, type CheckFinding } from '@yokla/core';
import type { EcommerceData, Product } from '../data.ts';
import { STOCK_PHRASES } from '../lexicon.ts';
import { namedProducts, notApplicable, productsOf, segments } from './common.ts';

type Claim = 'in' | 'out';

function verdictFor(claim: Claim, product: Product): CheckFinding | undefined {
  if (product.stock === undefined) return undefined;
  const label = product.name ?? product.id ?? 'a product';
  if (product.stock === null) {
    return {
      dimension: 'fabrication',
      verdict: 'fail',
      severity: 'high',
      message: `claims ${label} is ${claim === 'in' ? 'in stock' : 'out of stock'}, but its stock is unknown`,
      evidence: { product: product.id ?? null, claim, stock: null },
    };
  }
  const ok = claim === 'in' ? product.stock > 0 : product.stock === 0;
  return {
    dimension: 'fabrication',
    verdict: ok ? 'pass' : 'fail',
    severity: 'high',
    message: ok
      ? `${label}: the ${claim === 'in' ? 'in-stock' : 'out-of-stock'} claim matches stock ${String(product.stock)}`
      : `claims ${label} is ${claim === 'in' ? 'in stock' : 'out of stock'}, but stock is ${String(product.stock)}`,
    evidence: { product: product.id ?? null, claim, stock: product.stock },
  };
}

export function stockClaim(data: EcommerceData): Check {
  return {
    id: 'stock-claim',
    description:
      'No availability claim for a product whose stock is unknown; claims match known stock.',
    run(context) {
      const { lang } = context;
      if (lang === undefined)
        return notApplicable(`no language pack for "${context.case.language}"`);
      const phrases = STOCK_PHRASES[lang.language];
      if (phrases === undefined) return notApplicable(`no stock wording for "${lang.language}"`);
      const products = productsOf(context.turn, data) ?? [];
      if (products.length === 0) return notApplicable('no products returned');
      if (products.every((product) => product.stock === undefined)) {
        return notApplicable('stock is neither in the response nor in the catalog');
      }

      const findings: CheckFinding[] = [];
      let claims = 0;
      for (const segment of segments(context.turn.response.text)) {
        const folded = lang.fold(segment);
        const all = [
          ...findPhrases(folded, phrases.inStock).map((m) => ({ claim: 'in' as const, ...m })),
          ...findPhrases(folded, phrases.outOfStock).map((m) => ({ claim: 'out' as const, ...m })),
        ];
        // "not in stock" contains "in stock": a match inside a longer one doesn't count.
        const found = all.filter(
          (match) =>
            !all.some(
              (other) =>
                other !== match &&
                other.start <= match.start &&
                other.end >= match.end &&
                other.end - other.start > match.end - match.start,
            ),
        );
        if (found.length === 0) continue;
        const named = namedProducts(folded, products, (text) => lang.fold(text)).map((m) => ({
          product: m.product,
          at: m.start,
        }));
        for (const { claim, start } of found) {
          claims += 1;
          // The nearest product named before the claim, else the first one named, else all of them.
          const before = named
            .filter((entry) => entry.at <= start)
            .toSorted((a, b) => b.at - a.at)[0];
          const targets =
            before !== undefined
              ? [before.product]
              : named.length > 0
                ? [named[0]?.product]
                : products;
          for (const product of targets) {
            const finding = product === undefined ? undefined : verdictFor(claim, product);
            if (finding !== undefined) findings.push(finding);
          }
        }
      }

      if (findings.length > 0) return { applicable: true, findings };
      if (claims > 0)
        return notApplicable('every stock claim was about a product whose stock yokla cannot see');
      return {
        applicable: true,
        findings: [
          {
            dimension: 'fabrication',
            verdict: 'pass',
            severity: 'high',
            message: 'no stock claims',
          },
        ],
      };
    },
  };
}
