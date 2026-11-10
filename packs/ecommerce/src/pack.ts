// The ecommerce domain pack (design §17).

import type { DomainPack } from '@yokla/core';
import { noDuplicates } from './checks/no-duplicates.ts';
import { policyClaim } from './checks/policy-claim.ts';
import { priceGrounded } from './checks/price-grounded.ts';
import { overRefusal } from './checks/refusal.ts';
import { stockClaim } from './checks/stock-claim.ts';
import { loadData } from './data.ts';
import { ecommerceExpectations, ecommerceProfile } from './schema.ts';

export const ecommercePack: DomainPack = {
  id: 'ecommerce',
  profile: ecommerceProfile,
  expectations: ecommerceExpectations,
  // Design §13: one bad sample fails these dimensions.
  dimensions: {
    fabrication: 'worst-of-n',
    'over-refusal': 'worst-of-n',
    // Design §13: refusal correctness goes by the majority of samples.
    refusal: 'majority-of-n',
    'filter-honesty': 'worst-of-n',
    duplicates: 'worst-of-n',
    absence: 'worst-of-n',
  },
  prepare(profile, io) {
    const data = loadData(profile, io);
    return {
      checks: [
        priceGrounded(data),
        noDuplicates(data),
        stockClaim(data),
        policyClaim(data),
        overRefusal(),
      ],
    };
  },
};
