// The ecommerce domain pack (design §17).

import type { DomainPack } from '@yokla/core';
import { ecommerceAnalyzer } from './analyze.ts';
import { ecommerceAttacks } from './attacks.ts';
import { absenceCorrect } from './checks/absence.ts';
import { concession } from './checks/concession.ts';
import { filterHonoured } from './checks/filters.ts';
import { noDuplicates } from './checks/no-duplicates.ts';
import { policyClaim } from './checks/policy-claim.ts';
import { priceGrounded } from './checks/price-grounded.ts';
import { deflection, overRefusal } from './checks/refusal.ts';
import { stockClaim } from './checks/stock-claim.ts';
import { typeMatched } from './checks/type-match.ts';
import { loadData } from './data.ts';
import { catalogUnmetFacts } from './facts.ts';
import { ecommerceGenerate } from './generate.ts';
import { ecommerceIntents } from './intents.ts';
import { ecommerceExpectations, ecommerceProfile } from './schema.ts';

export const ecommercePack: DomainPack = {
  id: 'ecommerce',
  profile: ecommerceProfile,
  expectations: ecommerceExpectations,
  // What the pack proposes from the target's data, for yokla analyze (ADR-0047).
  analyzer: ecommerceAnalyzer,
  // Design §13: one bad sample fails these dimensions.
  dimensions: {
    fabrication: 'worst-of-n',
    'over-refusal': 'worst-of-n',
    // Design §13: refusal correctness goes by the majority of samples.
    refusal: 'majority-of-n',
    'filter-honesty': 'worst-of-n',
    duplicates: 'worst-of-n',
    absence: 'worst-of-n',
    // Reported, never decides a case: sending users to support may be intended.
    deflection: 'advisory',
    // An attack conceded once is conceded (ADR-0080).
    manipulation: 'worst-of-n',
  },
  prepare(profile, io) {
    const data = loadData(profile, io);
    const unmetFacts = catalogUnmetFacts(data);
    const generate = ecommerceGenerate(data);
    return {
      checks: [
        priceGrounded(data),
        noDuplicates(data),
        stockClaim(data),
        policyClaim(data),
        overRefusal(),
        filterHonoured(data),
        typeMatched(data),
        absenceCorrect(data),
        deflection(),
        concession(),
      ],
      intents: ecommerceIntents(data),
      // What a case states that the catalog no longer holds (ADR-0053).
      ...(unmetFacts === undefined ? {} : { unmetFacts }),
      // Cases computed from the catalog, for yokla generate (ADR-0055).
      ...(generate === undefined ? {} : { generate }),
      // The domain's attack cases, for yokla generate --redteam (ADR-0080).
      attacks: ecommerceAttacks(data),
    };
  },
};
