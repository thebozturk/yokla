// The ecommerce domain pack (design §17). Its checks arrive one by one; until
// then the pack contributes its schemas and its aggregation policies.

import type { DomainPack } from '@yokla/core';
import { ecommerceExpectations, ecommerceProfile } from './schema.ts';

export const ecommercePack: DomainPack = {
  id: 'ecommerce',
  profile: ecommerceProfile,
  expectations: ecommerceExpectations,
  // Design §13: one bad sample fails these dimensions.
  dimensions: {
    fabrication: 'worst-of-n',
    'over-refusal': 'worst-of-n',
    'filter-honesty': 'worst-of-n',
    duplicates: 'worst-of-n',
    absence: 'worst-of-n',
  },
  prepare: () => ({ checks: [] }),
};
