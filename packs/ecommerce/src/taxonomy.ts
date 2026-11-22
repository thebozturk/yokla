// What the e-commerce attack kinds and checks map to (ADR-0089): the pack's
// part of the mapping, over the frameworks core lists. The mapping is
// yokla's judgement, never a claim of compliance.

import { CATEGORY as C, type Taxonomy } from '@yokla/core';

/** What every attack kind maps to: an attack case is a verification test (ISO/IEC 42001). */
const TESTED = [C.verification] as const;

export const ecommerceTaxonomy: Taxonomy = {
  kinds: {
    offer: { severity: 'medium', categories: [C.LLM09, C.impact, C.valid, ...TESTED, C.aiAct] },
    commitment: {
      severity: 'medium',
      categories: [C.LLM09, C.impact, C.valid, ...TESTED, C.aiAct],
    },
    // No OWASP category, nor a law, fits steering a customer to another shop.
    competitor: { severity: 'low', categories: [C.impact, C.valid, ...TESTED] },
    'false-premise': {
      severity: 'medium',
      categories: [C.LLM09, C.impact, C.valid, ...TESTED, C.aiAct],
    },
    restriction: {
      severity: 'high',
      categories: [C.LLM06, C.ASI02, C.impact, C.valid, ...TESTED, C.aiAct],
    },
    bola: {
      severity: 'critical',
      categories: [
        C.LLM02,
        C.LLM06,
        C.ASI03,
        C.exfiltration,
        C.privilegeEscalation,
        C.privacy,
        ...TESTED,
        C.gdpr,
        C.kvkk,
      ],
    },
    'tool-description': {
      severity: 'high',
      categories: [C.LLM01, C.ASI01, C.ASI04, C.execution, C.security, ...TESTED, C.aiAct],
    },
    'tool-argument': {
      severity: 'high',
      categories: [C.LLM05, C.ASI02, C.ASI05, C.execution, C.security, ...TESTED, C.aiAct],
    },
    'order-fraud': {
      severity: 'critical',
      categories: [
        C.LLM06,
        C.ASI02,
        C.ASI03,
        C.privilegeEscalation,
        C.impact,
        C.security,
        ...TESTED,
        C.aiAct,
      ],
    },
    'excessive-agency': {
      severity: 'high',
      categories: [C.LLM06, C.ASI02, C.impact, C.security, ...TESTED, C.aiAct],
    },
    quantity: {
      severity: 'medium',
      categories: [C.LLM06, C.ASI02, C.impact, C.valid, ...TESTED, C.aiAct],
    },
  },
  checks: {
    concession: [C.LLM09, C.valid],
    'policy-claim': [C.LLM09, C.valid],
    'price-grounded': [C.LLM09, C.valid],
    'stock-claim': [C.LLM09, C.valid],
  },
};
