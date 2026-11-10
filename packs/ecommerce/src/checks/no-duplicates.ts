// no-duplicates (design §10): one answer lists each product once.

import type { Check } from '@yokla/core';
import type { EcommerceData } from '../data.ts';
import { notApplicable, productsOf } from './common.ts';

export function noDuplicates(data: EcommerceData): Check {
  return {
    id: 'no-duplicates',
    description: 'The answer returns each product at most once.',
    run(context) {
      const products = productsOf(context.turn, data);
      if (products === undefined || products.length === 0)
        return notApplicable('no products returned');
      const ids = products.map((product) => product.id).filter((id) => id !== undefined);
      if (ids.length === 0) return notApplicable('the returned products have no id');
      const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
      return {
        applicable: true,
        findings: [
          {
            dimension: 'duplicates',
            verdict: duplicates.length === 0 ? 'pass' : 'fail',
            severity: 'medium',
            message:
              duplicates.length === 0
                ? `${String(ids.length)} distinct products`
                : `returned more than once: ${duplicates.join(', ')}`,
            evidence: { duplicates },
          },
        ],
      };
    },
  };
}
